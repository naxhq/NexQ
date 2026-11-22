// Sub-PRD 9: OpenAI Whisper REST API STT
//
// Accumulates audio chunks into ~5 second segments, then sends each segment
// as a multipart form POST to {base_url}/audio/transcriptions (OpenAI by default,
// or any OpenAI-compatible server when a custom base URL is configured).
// Parses the JSON response for transcription text and emits TranscriptResults.

use async_trait::async_trait;
use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::mpsc;

use crate::audio::AudioChunk;
use crate::stt::provider::{STTProvider, STTProviderType, TranscriptResult};

/// Target segment duration in seconds before sending a batch to the API.
const SEGMENT_DURATION_SECS: f32 = 5.0;

/// Sample rate expected by the audio pipeline (16 kHz mono).
const SAMPLE_RATE: u32 = 16000;

/// Default OpenAI-style base URL (used when no custom endpoint is configured).
pub const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";

/// Default transcription model (used when no custom model is configured).
pub const DEFAULT_MODEL: &str = "whisper-1";

/// Credential-store key holding the optional custom base URL (non-secret).
pub const BASE_URL_CREDENTIAL_KEY: &str = "whisper_api_base_url";

/// Credential-store key holding the optional custom model name (non-secret).
pub const MODEL_CREDENTIAL_KEY: &str = "whisper_api_model";

/// Normalize a user-entered OpenAI-style base URL.
///
/// Trims whitespace, drops trailing slashes, strips a pasted trailing
/// `/audio/transcriptions`, and requires an `http://` or `https://` scheme.
pub fn normalize_base_url(raw: &str) -> Result<String, String> {
    let mut url = raw.trim().trim_end_matches('/').to_string();
    if let Some(stripped) = url.strip_suffix("/audio/transcriptions") {
        url = stripped.trim_end_matches('/').to_string();
    }
    let lower = url.to_ascii_lowercase();
    let host = if lower.starts_with("http://") {
        &url["http://".len()..]
    } else if lower.starts_with("https://") {
        &url["https://".len()..]
    } else {
        return Err(
            "Whisper endpoint must start with http:// or https:// (for example http://127.0.0.1:8000/v1)"
                .to_string(),
        );
    };
    if host.is_empty() {
        return Err("Whisper endpoint is missing a host name".to_string());
    }
    Ok(url)
}

/// Resolve the optional endpoint/model settings into `(base_url, model)`.
/// Empty or missing values fall back to the OpenAI defaults.
pub fn resolve_endpoint(
    base_url: Option<&str>,
    model: Option<&str>,
) -> Result<(String, String), String> {
    let base = match base_url.map(str::trim).filter(|s| !s.is_empty()) {
        Some(b) => normalize_base_url(b)?,
        None => DEFAULT_BASE_URL.to_string(),
    };
    let model = model
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_MODEL)
        .to_string();
    Ok((base, model))
}

/// `{base}/audio/transcriptions`
fn transcriptions_url(base: &str) -> String {
    format!("{}/audio/transcriptions", base)
}

/// `{base}/models`
fn models_url(base: &str) -> String {
    format!("{}/models", base)
}

/// Attach a Bearer token only when the key is non-empty.
fn with_auth(req: reqwest::RequestBuilder, api_key: &str) -> reqwest::RequestBuilder {
    if api_key.is_empty() {
        req
    } else {
        req.header("Authorization", format!("Bearer {}", api_key))
    }
}

fn refused_status(status: reqwest::StatusCode) -> bool {
    status.as_u16() == 401 || status.as_u16() == 403
}

fn refused_message(status: reqwest::StatusCode) -> String {
    format!(
        "The server refused the API key (HTTP {}). Check the key, or clear it if this server needs none.",
        status.as_u16()
    )
}

/// OpenAI Whisper transcription API response.
#[derive(Debug, Deserialize)]
struct WhisperResponse {
    text: Option<String>,
}

/// OpenAI Whisper REST API STT provider.
///
/// Accumulates PCM audio into ~5-second segments and POSTs them as WAV files
/// to an OpenAI-style /audio/transcriptions endpoint (OpenAI unless a custom
/// base URL is set).
pub struct WhisperApiSTT {
    api_key: String,
    /// Normalized base URL, e.g. `https://api.openai.com/v1`.
    base_url: String,
    /// Model name sent in the multipart `model` field.
    model: String,
    /// Set when the configured custom base URL is invalid; reported on start/test.
    endpoint_error: Option<String>,
    language: String,
    is_streaming: bool,
    result_tx: Option<mpsc::Sender<TranscriptResult>>,
    stop_flag: Arc<AtomicBool>,
    start_time: Option<Instant>,
    /// Accumulated PCM samples for the current segment.
    audio_buffer: Vec<i16>,
    /// Total samples needed before sending (~5 seconds at 16 kHz).
    segment_sample_threshold: usize,
}

impl WhisperApiSTT {
    pub fn new() -> Self {
        Self {
            api_key: String::new(),
            base_url: DEFAULT_BASE_URL.to_string(),
            model: DEFAULT_MODEL.to_string(),
            endpoint_error: None,
            language: "en".to_string(),
            is_streaming: false,
            result_tx: None,
            stop_flag: Arc::new(AtomicBool::new(false)),
            start_time: None,
            audio_buffer: Vec::new(),
            segment_sample_threshold: (SAMPLE_RATE as f32 * SEGMENT_DURATION_SECS) as usize,
        }
    }

    /// Create with an API key.
    pub fn with_api_key(api_key: &str) -> Self {
        Self {
            api_key: api_key.to_string(),
            ..Self::new()
        }
    }

    /// Set the API key.
    pub fn set_api_key(&mut self, api_key: &str) {
        self.api_key = api_key.to_string();
    }

    /// Set the optional custom endpoint and model. Empty/None keeps the OpenAI
    /// defaults. An invalid URL is remembered and reported by `start_stream`
    /// and `test_connection` instead of silently falling back to OpenAI.
    pub fn set_endpoint(&mut self, base_url: Option<&str>, model: Option<&str>) {
        match resolve_endpoint(base_url, model) {
            Ok((base, model)) => {
                self.base_url = base;
                self.model = model;
                self.endpoint_error = None;
            }
            Err(e) => {
                log::warn!("WhisperApiSTT: invalid endpoint configuration: {}", e);
                self.endpoint_error = Some(e);
            }
        }
    }

    /// True when a non-OpenAI base URL is configured (API key becomes optional).
    pub fn is_custom_endpoint(&self) -> bool {
        self.base_url != DEFAULT_BASE_URL
    }

    /// Multipart form for one transcription request.
    fn build_form(model: &str, language: &str, wav_data: Vec<u8>) -> reqwest::multipart::Form {
        let file_part = reqwest::multipart::Part::bytes(wav_data)
            .file_name("audio.wav")
            .mime_str("audio/wav")
            .unwrap_or_else(|_| reqwest::multipart::Part::bytes(Vec::new()));

        let mut form = reqwest::multipart::Form::new()
            .text("model", model.to_string())
            .text("response_format", "json")
            .part("file", file_part);

        // Only add language if it's not empty
        if !language.is_empty() && !language.eq_ignore_ascii_case("auto") {
            // Whisper API uses ISO 639-1 codes (e.g., "en", "es", "fr")
            let lang_code = language.split('-').next().unwrap_or(language);
            form = form.text("language", lang_code.to_string());
        }
        form
    }

    /// Encode accumulated PCM i16 samples as a WAV byte buffer (16-bit mono 16 kHz).
    fn encode_wav(samples: &[i16]) -> Vec<u8> {
        let data_len = (samples.len() * 2) as u32;
        let file_len = 36 + data_len; // RIFF header size minus 8 + data
        let mut buf = Vec::with_capacity(44 + data_len as usize);

        // RIFF header
        buf.extend_from_slice(b"RIFF");
        buf.extend_from_slice(&file_len.to_le_bytes());
        buf.extend_from_slice(b"WAVE");

        // fmt sub-chunk
        buf.extend_from_slice(b"fmt ");
        buf.extend_from_slice(&16u32.to_le_bytes()); // sub-chunk size
        buf.extend_from_slice(&1u16.to_le_bytes()); // PCM format
        buf.extend_from_slice(&1u16.to_le_bytes()); // mono
        buf.extend_from_slice(&SAMPLE_RATE.to_le_bytes()); // sample rate
        buf.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes()); // byte rate
        buf.extend_from_slice(&2u16.to_le_bytes()); // block align
        buf.extend_from_slice(&16u16.to_le_bytes()); // bits per sample

        // data sub-chunk
        buf.extend_from_slice(b"data");
        buf.extend_from_slice(&data_len.to_le_bytes());
        for &sample in samples {
            buf.extend_from_slice(&sample.to_le_bytes());
        }

        buf
    }

    /// Send accumulated audio to the Whisper API and emit the result.
    async fn send_segment(
        api_key: &str,
        base_url: &str,
        model: &str,
        language: &str,
        samples: Vec<i16>,
        timestamp_ms: u64,
        result_tx: mpsc::Sender<TranscriptResult>,
    ) {
        let wav_data = Self::encode_wav(&samples);

        let client = reqwest::Client::new();
        let form = Self::build_form(model, language, wav_data);

        let response = with_auth(client.post(transcriptions_url(base_url)), api_key)
            .multipart(form)
            .send()
            .await;

        match response {
            Ok(resp) => {
                if resp.status().is_success() {
                    match resp.json::<WhisperResponse>().await {
                        Ok(whisper_resp) => {
                            if let Some(text) = whisper_resp.text {
                                let text = text.trim().to_string();
                                if !text.is_empty() {
                                    let result = TranscriptResult {
                                        text,
                                        is_final: true,
                                        confidence: 0.95, // Whisper doesn't return confidence
                                        timestamp_ms,
                                        speaker: None,
                                        language: crate::stt::provider::reported_language(language),
                                        segment_id: None,
                                        duration_ms: None,
                                        speaker_tag: None,
                                        turn: None,
                                    };
                                    let _ = result_tx.send(result).await;
                                }
                            }
                        }
                        Err(e) => {
                            log::error!("WhisperApiSTT: Failed to parse response: {}", e);
                        }
                    }
                } else {
                    let status = resp.status();
                    let body = resp.text().await.unwrap_or_default();
                    log::error!(
                        "WhisperApiSTT: API returned status {}: {}",
                        status,
                        body
                    );
                }
            }
            Err(e) => {
                log::error!("WhisperApiSTT: Request failed: {}", e);
            }
        }
    }
}

#[async_trait]
impl STTProvider for WhisperApiSTT {
    fn provider_name(&self) -> &str {
        "Whisper API"
    }

    fn provider_type(&self) -> STTProviderType {
        STTProviderType::WhisperApi
    }

    async fn start_stream(
        &mut self,
        result_tx: mpsc::Sender<TranscriptResult>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if self.is_streaming {
            return Err("Stream already active".into());
        }

        if let Some(ref e) = self.endpoint_error {
            return Err(e.clone().into());
        }

        if self.api_key.is_empty() && !self.is_custom_endpoint() {
            return Err("OpenAI API key not configured".into());
        }

        log::info!(
            "WhisperApiSTT: Starting stream (language: {}, custom endpoint: {})",
            self.language,
            self.is_custom_endpoint()
        );

        self.result_tx = Some(result_tx);
        self.is_streaming = true;
        self.stop_flag.store(false, Ordering::SeqCst);
        self.start_time = Some(Instant::now());
        self.audio_buffer.clear();

        log::info!("WhisperApiSTT: Stream started");
        Ok(())
    }

    async fn feed_audio(
        &mut self,
        chunk: AudioChunk,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if !self.is_streaming || self.stop_flag.load(Ordering::SeqCst) {
            return Ok(());
        }

        // Skip only absolute digital silence (all-zero samples).
        // System audio via WASAPI loopback can be very quiet, so use a
        // minimal threshold. The Whisper API handles silence gracefully.
        if !chunk.pcm_data.is_empty() {
            let rms: f64 = chunk
                .pcm_data
                .iter()
                .map(|&s| (s as f64) * (s as f64))
                .sum::<f64>()
                / chunk.pcm_data.len() as f64;
            if rms < 0.25 {
                return Ok(());
            }
        }

        self.audio_buffer.extend_from_slice(&chunk.pcm_data);

        // When we have ~5 seconds of audio, send it as a batch
        if self.audio_buffer.len() >= self.segment_sample_threshold {
            let segment = std::mem::take(&mut self.audio_buffer);
            let timestamp_ms = self
                .start_time
                .map(|t| t.elapsed().as_millis() as u64)
                .unwrap_or(chunk.timestamp_ms);

            if let Some(ref tx) = self.result_tx {
                // Send an interim result to indicate processing
                let interim = TranscriptResult {
                    text: "[transcribing...]".to_string(),
                    is_final: false,
                    confidence: 0.0,
                    timestamp_ms,
                    speaker: None,
                    language: crate::stt::provider::reported_language(&self.language),
                    segment_id: None,
                    duration_ms: None,
                    speaker_tag: None,
                    turn: None,
                };
                let _ = tx.send(interim).await;

                // Spawn the API call so it doesn't block audio feeding
                let api_key = self.api_key.clone();
                let base_url = self.base_url.clone();
                let model = self.model.clone();
                let language = self.language.clone();
                let result_tx = tx.clone();
                tokio::spawn(async move {
                    Self::send_segment(
                        &api_key, &base_url, &model, &language, segment, timestamp_ms, result_tx,
                    )
                    .await;
                });
            }
        }

        Ok(())
    }

    async fn stop_stream(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if !self.is_streaming {
            return Ok(());
        }

        log::info!("WhisperApiSTT: Stopping stream");

        self.stop_flag.store(true, Ordering::SeqCst);

        // Flush any remaining audio buffer
        if !self.audio_buffer.is_empty() {
            let segment = std::mem::take(&mut self.audio_buffer);
            let timestamp_ms = self
                .start_time
                .map(|t| t.elapsed().as_millis() as u64)
                .unwrap_or(0);

            if let Some(ref tx) = self.result_tx {
                let api_key = self.api_key.clone();
                let base_url = self.base_url.clone();
                let model = self.model.clone();
                let language = self.language.clone();
                let result_tx = tx.clone();
                tokio::spawn(async move {
                    Self::send_segment(
                        &api_key, &base_url, &model, &language, segment, timestamp_ms, result_tx,
                    )
                    .await;
                });
            }
        }

        self.is_streaming = false;
        self.result_tx = None;
        self.start_time = None;

        log::info!("WhisperApiSTT: Stream stopped");
        Ok(())
    }

    async fn test_connection(&self) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        if let Some(ref e) = self.endpoint_error {
            return Err(e.clone().into());
        }

        let custom = self.is_custom_endpoint();
        if self.api_key.is_empty() && !custom {
            return Err("No API key configured".into());
        }

        log::info!(
            "WhisperApiSTT: Testing connection (custom endpoint: {})...",
            custom
        );

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()?;

        // Lightweight authenticated endpoint: list models.
        let response = with_auth(client.get(models_url(&self.base_url)), &self.api_key)
            .send()
            .await?;
        let status = response.status();

        if !custom {
            let success = status.is_success();
            if success {
                log::info!("WhisperApiSTT: Connection test passed");
            } else {
                log::warn!("WhisperApiSTT: Connection test failed with status {}", status);
            }
            return Ok(success);
        }

        if status.is_success() {
            log::info!("WhisperApiSTT: Connection test passed (/models)");
            return Ok(true);
        }
        if refused_status(status) {
            return Err(refused_message(status).into());
        }
        if status.as_u16() != 404 && status.as_u16() != 405 {
            log::warn!("WhisperApiSTT: /models returned status {}", status);
            return Ok(false);
        }

        // Many local servers have no /models route: probe the transcription
        // endpoint with ~0.5 s of silence instead.
        log::info!("WhisperApiSTT: /models not available ({}), probing transcriptions", status);
        let wav = Self::encode_wav(&vec![0i16; (SAMPLE_RATE / 2) as usize]);
        let form = Self::build_form(&self.model, "", wav);
        let probe = with_auth(client.post(transcriptions_url(&self.base_url)), &self.api_key)
            .multipart(form)
            .send()
            .await?;
        let status = probe.status();
        if refused_status(status) {
            return Err(refused_message(status).into());
        }
        let success = status.is_success();
        if success {
            log::info!("WhisperApiSTT: Connection test passed (transcription probe)");
        } else {
            log::warn!("WhisperApiSTT: Transcription probe failed with status {}", status);
        }
        Ok(success)
    }

    fn set_language(&mut self, language: &str) {
        self.language = language.to_string();
        log::info!("WhisperApiSTT: Language set to {}", self.language);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_trims_and_drops_trailing_slashes() {
        assert_eq!(
            normalize_base_url("  http://127.0.0.1:8000/v1/  ").unwrap(),
            "http://127.0.0.1:8000/v1"
        );
        assert_eq!(
            normalize_base_url("https://example.com/v1///").unwrap(),
            "https://example.com/v1"
        );
    }

    #[test]
    fn normalize_strips_pasted_transcriptions_path() {
        assert_eq!(
            normalize_base_url("http://localhost:8000/v1/audio/transcriptions").unwrap(),
            "http://localhost:8000/v1"
        );
        assert_eq!(
            normalize_base_url("http://localhost:8000/v1/audio/transcriptions/").unwrap(),
            "http://localhost:8000/v1"
        );
    }

    #[test]
    fn normalize_requires_http_scheme() {
        assert!(normalize_base_url("127.0.0.1:8000/v1").is_err());
        assert!(normalize_base_url("ftp://example.com/v1").is_err());
        assert!(normalize_base_url("").is_err());
        assert!(normalize_base_url("http://").is_err());
        assert!(normalize_base_url("HTTPS://Example.com/v1").is_ok());
    }

    #[test]
    fn resolve_defaults_when_empty() {
        let expected = (DEFAULT_BASE_URL.to_string(), DEFAULT_MODEL.to_string());
        assert_eq!(resolve_endpoint(None, None).unwrap(), expected);
        assert_eq!(resolve_endpoint(Some(""), Some("  ")).unwrap(), expected);
    }

    #[test]
    fn resolve_uses_custom_values() {
        let (base, model) = resolve_endpoint(
            Some("http://127.0.0.1:8000/v1/"),
            Some(" Systran/faster-whisper-small "),
        )
        .unwrap();
        assert_eq!(base, "http://127.0.0.1:8000/v1");
        assert_eq!(model, "Systran/faster-whisper-small");
        assert!(resolve_endpoint(Some("nope"), None).is_err());
    }

    #[test]
    fn request_urls_are_built_from_base() {
        assert_eq!(
            transcriptions_url(DEFAULT_BASE_URL),
            "https://api.openai.com/v1/audio/transcriptions"
        );
        assert_eq!(models_url("http://127.0.0.1:8000/v1"), "http://127.0.0.1:8000/v1/models");
    }

    #[test]
    fn default_provider_keeps_openai_behavior() {
        let p = WhisperApiSTT::new();
        assert_eq!(p.base_url, "https://api.openai.com/v1");
        assert_eq!(p.model, "whisper-1");
        assert!(!p.is_custom_endpoint());
    }

    #[test]
    fn set_endpoint_applies_and_reports_invalid() {
        let mut p = WhisperApiSTT::new();
        p.set_endpoint(Some("http://127.0.0.1:8000/v1"), Some("my-model"));
        assert!(p.is_custom_endpoint());
        assert_eq!(p.model, "my-model");
        assert!(p.endpoint_error.is_none());

        p.set_endpoint(Some("bogus"), None);
        assert!(p.endpoint_error.is_some());

        p.set_endpoint(None, None);
        assert!(!p.is_custom_endpoint());
        assert_eq!(p.model, "whisper-1");
        assert!(p.endpoint_error.is_none());
    }

    #[tokio::test]
    async fn start_stream_key_rules() {
        let (tx, _rx) = mpsc::channel(1);

        // Default endpoint: key required.
        let mut p = WhisperApiSTT::new();
        assert!(p.start_stream(tx.clone()).await.is_err());

        // Custom endpoint: key optional.
        let mut p = WhisperApiSTT::new();
        p.set_endpoint(Some("http://127.0.0.1:8000/v1"), None);
        assert!(p.start_stream(tx.clone()).await.is_ok());

        // Invalid endpoint is an error, never a silent OpenAI fallback.
        let mut p = WhisperApiSTT::with_api_key("sk-test");
        p.set_endpoint(Some("bogus"), None);
        assert!(p.start_stream(tx).await.is_err());
    }
}
