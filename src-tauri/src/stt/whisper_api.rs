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

/// Credential-store key of the OpenAI API key. It is only ever sent to the
/// default OpenAI URL, never to a custom endpoint.
pub const OPENAI_KEY_CREDENTIAL_KEY: &str = "whisper_api";

/// Credential-store key holding the optional API key for a custom endpoint.
pub const CUSTOM_KEY_CREDENTIAL_KEY: &str = "whisper_api_custom_key";

/// Timeout for one segment upload.
const SEGMENT_TIMEOUT_SECS: u64 = 30;

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

/// One shared HTTP client (connection reuse, bounded request time) for all segments.
fn http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(SEGMENT_TIMEOUT_SECS))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

/// Server body trimmed to at most 200 characters, for error messages.
fn trim_body(body: &str) -> String {
    let body = body.trim();
    let mut out: String = body.chars().take(200).collect();
    if body.chars().count() > 200 {
        out.push_str("...");
    }
    out
}

/// "The server answered 500: <body>" for an unexpected non-2xx status.
fn describe_http_failure(status: reqwest::StatusCode, body: &str) -> String {
    let body = trim_body(body);
    if body.is_empty() {
        format!("The server answered {}.", status.as_u16())
    } else {
        format!("The server answered {}: {}", status.as_u16(), body)
    }
}

fn unreachable_message(base_url: &str) -> String {
    format!("Couldn't reach {}. Is the server running?", base_url)
}

fn needs_key_message() -> String {
    "This server needs an API key.".to_string()
}

/// Reports mid-meeting failures to the UI once per run of failures
/// (`stt_connection_status` "error"), and clears it on the next success.
#[derive(Clone)]
struct StatusReporter {
    app_handle: Option<tauri::AppHandle>,
    party: String,
    failing: Arc<AtomicBool>,
}

impl StatusReporter {
    fn new() -> Self {
        Self {
            app_handle: None,
            party: "Them".to_string(),
            failing: Arc::new(AtomicBool::new(false)),
        }
    }

    fn emit(&self, status: &str, message: Option<String>) {
        if let Some(ref handle) = self.app_handle {
            let event = serde_json::json!({
                "provider": "whisper_api",
                "party": self.party,
                "status": status,
                "message": message,
            });
            if let Err(e) = tauri::Emitter::emit(handle, "stt_connection_status", &event) {
                log::warn!("WhisperApiSTT: Failed to emit status event: {}", e);
            }
        }
    }

    /// A segment failed: tell the UI only for the first failure of a run.
    fn failure(&self, message: &str) {
        if !self.failing.swap(true, Ordering::SeqCst) {
            self.emit("error", Some(message.to_string()));
        }
    }

    /// A segment succeeded: clear a previously reported failure.
    fn success(&self) {
        if self.failing.swap(false, Ordering::SeqCst) {
            self.emit("connected", None);
        }
    }
}

/// Where and how one segment is sent.
#[derive(Clone)]
struct SegmentTarget {
    api_key: String,
    base_url: String,
    model: String,
    language: String,
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
    reporter: StatusReporter,
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
            reporter: StatusReporter::new(),
            is_streaming: false,
            result_tx: None,
            stop_flag: Arc::new(AtomicBool::new(false)),
            start_time: None,
            audio_buffer: Vec::new(),
            segment_sample_threshold: (SAMPLE_RATE as f32 * SEGMENT_DURATION_SECS) as usize,
        }
    }

    /// The single factory every build site uses. Picks the API key for the
    /// resolved endpoint: the saved OpenAI key goes ONLY to the default OpenAI
    /// URL, a custom endpoint gets only its own optional key.
    pub fn from_settings(
        openai_key: Option<&str>,
        custom_key: Option<&str>,
        base_url: Option<&str>,
        model: Option<&str>,
        language: &str,
    ) -> Self {
        let mut p = Self::new();
        p.set_endpoint(base_url, model);
        let key = if p.endpoint_error.is_some() {
            None
        } else if p.is_custom_endpoint() {
            custom_key
        } else {
            openai_key
        };
        p.api_key = key.map(str::trim).unwrap_or("").to_string();
        p.language = language.to_string();
        p
    }

    /// Like `from_settings`, reading the four credential-store slots through `lookup`.
    pub fn from_store(lookup: impl Fn(&str) -> Option<String>, language: &str) -> Self {
        let openai = lookup(OPENAI_KEY_CREDENTIAL_KEY);
        let custom = lookup(CUSTOM_KEY_CREDENTIAL_KEY);
        let base = lookup(BASE_URL_CREDENTIAL_KEY);
        let model = lookup(MODEL_CREDENTIAL_KEY);
        Self::from_settings(
            openai.as_deref(),
            custom.as_deref(),
            base.as_deref(),
            model.as_deref(),
            language,
        )
    }

    /// App handle used to report mid-meeting failures to the UI.
    pub fn set_app_handle(&mut self, handle: tauri::AppHandle) {
        self.reporter.app_handle = Some(handle);
    }

    /// Party label ("You" / "Them") for status events.
    pub fn set_party(&mut self, party: &str) {
        self.reporter.party = party.to_string();
    }

    fn target(&self) -> SegmentTarget {
        SegmentTarget {
            api_key: self.api_key.clone(),
            base_url: self.base_url.clone(),
            model: self.model.clone(),
            language: self.language.clone(),
        }
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
        target: &SegmentTarget,
        reporter: &StatusReporter,
        samples: Vec<i16>,
        timestamp_ms: u64,
        result_tx: mpsc::Sender<TranscriptResult>,
    ) {
        let wav_data = Self::encode_wav(&samples);
        let form = Self::build_form(&target.model, &target.language, wav_data);

        let response = with_auth(
            http_client().post(transcriptions_url(&target.base_url)),
            &target.api_key,
        )
        .multipart(form)
        .send()
        .await;

        match response {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    match resp.json::<WhisperResponse>().await {
                        Ok(whisper_resp) => {
                            reporter.success();
                            if let Some(text) = whisper_resp.text {
                                let text = text.trim().to_string();
                                if !text.is_empty() {
                                    let result = TranscriptResult {
                                        text,
                                        is_final: true,
                                        confidence: 0.95, // Whisper doesn't return confidence
                                        timestamp_ms,
                                        speaker: None,
                                        language: crate::stt::provider::reported_language(
                                            &target.language,
                                        ),
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
                            reporter.failure("The server's reply wasn't a transcription (expected JSON with a text field).");
                        }
                    }
                } else {
                    let body = resp.text().await.unwrap_or_default();
                    log::error!(
                        "WhisperApiSTT: API returned status {}: {}",
                        status,
                        trim_body(&body)
                    );
                    reporter.failure(&describe_http_failure(status, &body));
                }
            }
            Err(e) => {
                log::error!("WhisperApiSTT: Request failed: {}", e);
                reporter.failure(&unreachable_message(&target.base_url));
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

        self.reporter.failing.store(false, Ordering::SeqCst);
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
                let target = self.target();
                let reporter = self.reporter.clone();
                let result_tx = tx.clone();
                tokio::spawn(async move {
                    Self::send_segment(&target, &reporter, segment, timestamp_ms, result_tx).await;
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
                let target = self.target();
                let reporter = self.reporter.clone();
                let result_tx = tx.clone();
                tokio::spawn(async move {
                    Self::send_segment(&target, &reporter, segment, timestamp_ms, result_tx).await;
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

        if !custom {
            // OpenAI: list models, a lightweight authenticated endpoint.
            let response = with_auth(client.get(models_url(&self.base_url)), &self.api_key)
                .send()
                .await?;
            let success = response.status().is_success();
            if success {
                log::info!("WhisperApiSTT: Connection test passed");
            } else {
                log::warn!(
                    "WhisperApiSTT: Connection test failed with status {}",
                    response.status()
                );
            }
            return Ok(success);
        }

        // Custom endpoint: always probe the transcription route with ~0.5 s of
        // silence. A /models 200 alone would also pass servers that cannot
        // transcribe (Ollama, LM Studio), which then fail every segment.
        let wav = Self::encode_wav(&vec![0i16; (SAMPLE_RATE / 2) as usize]);
        let form = Self::build_form(&self.model, "", wav);
        let probe = match with_auth(
            client.post(transcriptions_url(&self.base_url)),
            &self.api_key,
        )
        .multipart(form)
        .send()
        .await
        {
            Ok(r) => r,
            Err(e) => {
                log::warn!("WhisperApiSTT: Probe request failed: {}", e);
                return Err(unreachable_message(&self.base_url).into());
            }
        };
        let status = probe.status();
        if status.is_success() {
            log::info!("WhisperApiSTT: Connection test passed (transcription probe)");
            return Ok(true);
        }
        if refused_status(status) {
            let msg = if self.api_key.is_empty() {
                needs_key_message()
            } else {
                refused_message(status)
            };
            return Err(msg.into());
        }
        let body = probe.text().await.unwrap_or_default();
        log::warn!("WhisperApiSTT: Transcription probe failed with status {}", status);
        Err(describe_http_failure(status, &body).into())
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
        let mut p = WhisperApiSTT::from_settings(Some("sk-test"), None, Some("bogus"), None, "en");
        assert!(p.start_stream(tx).await.is_err());
    }

    // ---- Mock HTTP server (hand-written responses, no extra crates) ----

    type Recorded = std::sync::Arc<std::sync::Mutex<Vec<String>>>;

    /// Start a one-shot-per-connection HTTP server on 127.0.0.1:0.
    /// `handler(method, path)` returns `(status line, body)`. Every raw request
    /// (headers + body, lossy UTF-8) is recorded. Returns `(base_url, recorded)`.
    async fn mock_server<F>(handler: F) -> (String, Recorded)
    where
        F: Fn(&str, &str) -> (&'static str, String) + Send + Sync + 'static,
    {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let recorded: Recorded = Default::default();
        let rec = recorded.clone();
        let handler = std::sync::Arc::new(handler);

        tokio::spawn(async move {
            loop {
                let (mut sock, _) = match listener.accept().await {
                    Ok(c) => c,
                    Err(_) => return,
                };
                let rec = rec.clone();
                let handler = handler.clone();
                tokio::spawn(async move {
                    let mut buf: Vec<u8> = Vec::new();
                    let mut tmp = [0u8; 8192];
                    let mut header_end = None;
                    loop {
                        if header_end.is_none() {
                            header_end = buf.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4);
                        }
                        if let Some(h) = header_end {
                            let head = String::from_utf8_lossy(&buf[..h]).to_ascii_lowercase();
                            if head.contains("transfer-encoding: chunked") {
                                if buf.ends_with(b"0\r\n\r\n") {
                                    break;
                                }
                            } else {
                                let len = head
                                    .lines()
                                    .find_map(|l| l.strip_prefix("content-length:"))
                                    .and_then(|v| v.trim().parse::<usize>().ok())
                                    .unwrap_or(0);
                                if buf.len() >= h + len {
                                    break;
                                }
                            }
                        }
                        match sock.read(&mut tmp).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => buf.extend_from_slice(&tmp[..n]),
                        }
                    }
                    let raw = String::from_utf8_lossy(&buf).to_string();
                    let mut first = raw.lines().next().unwrap_or("").split_whitespace();
                    let method = first.next().unwrap_or("").to_string();
                    let path = first.next().unwrap_or("").to_string();
                    let (status, body) = handler(&method, &path);
                    rec.lock().unwrap().push(raw);
                    let resp = format!(
                        "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        status,
                        body.len(),
                        body
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                    let _ = sock.shutdown().await;
                });
            }
        });

        (format!("http://{}/v1", addr), recorded)
    }

    /// Provider pointed at the mock, using the shared factory.
    fn mock_provider(base: &str, openai: Option<&str>, custom: Option<&str>) -> WhisperApiSTT {
        WhisperApiSTT::from_settings(openai, custom, Some(base), Some("faster-whisper-small"), "en")
    }

    fn lower(raw: &str) -> String {
        raw.to_ascii_lowercase()
    }

    #[test]
    fn factory_sends_openai_key_only_to_default_url() {
        let p = WhisperApiSTT::from_settings(Some("sk-openai"), Some("custom"), None, None, "en");
        assert_eq!(p.api_key, "sk-openai");
        assert!(!p.is_custom_endpoint());

        // Explicitly typing the OpenAI URL is still the default endpoint.
        let p = WhisperApiSTT::from_settings(
            Some("sk-openai"),
            Some("custom"),
            Some("https://api.openai.com/v1/"),
            None,
            "en",
        );
        assert_eq!(p.api_key, "sk-openai");

        let p = WhisperApiSTT::from_settings(
            Some("sk-openai"),
            None,
            Some("http://127.0.0.1:8000/v1"),
            None,
            "en",
        );
        assert_eq!(p.api_key, "", "OpenAI key must never reach a custom endpoint");

        let p = WhisperApiSTT::from_settings(
            Some("sk-openai"),
            Some("custom"),
            Some("http://127.0.0.1:8000/v1"),
            None,
            "en",
        );
        assert_eq!(p.api_key, "custom");

        // Invalid endpoint: no key at all, and an error on start/test.
        let p = WhisperApiSTT::from_settings(Some("sk-openai"), Some("c"), Some("bogus"), None, "en");
        assert_eq!(p.api_key, "");
        assert!(p.endpoint_error.is_some());
    }

    #[test]
    fn from_store_reads_the_four_slots() {
        let lookup = |k: &str| match k {
            "whisper_api" => Some("sk-openai".to_string()),
            "whisper_api_custom_key" => Some("custom".to_string()),
            "whisper_api_base_url" => Some("http://127.0.0.1:8000/v1".to_string()),
            "whisper_api_model" => Some("m".to_string()),
            _ => None,
        };
        let p = WhisperApiSTT::from_store(lookup, "fr");
        assert_eq!(p.api_key, "custom");
        assert_eq!(p.model, "m");
        assert_eq!(p.language, "fr");
        let p = WhisperApiSTT::from_store(|k| (k == "whisper_api").then(|| "sk".to_string()), "en");
        assert_eq!(p.api_key, "sk");
        assert_eq!(p.base_url, DEFAULT_BASE_URL);
    }

    #[test]
    fn trim_body_caps_at_200_chars() {
        assert_eq!(trim_body("  short  "), "short");
        let long = "x".repeat(500);
        let t = trim_body(&long);
        assert!(t.starts_with(&"x".repeat(200)));
        assert!(t.len() <= 203);
    }

    #[tokio::test]
    async fn mock_custom_test_always_probes_transcriptions_even_if_models_is_200() {
        // An Ollama/LM Studio style server: /models fine, no transcription route.
        let (base, rec) = mock_server(|method, _| {
            if method == "GET" {
                ("200 OK", r#"{"data":[]}"#.to_string())
            } else {
                ("404 Not Found", "page not found".to_string())
            }
        })
        .await;
        let p = mock_provider(&base, None, None);
        let err = p.test_connection().await.unwrap_err().to_string();
        assert!(err.contains("404"), "{}", err);
        assert!(err.contains("page not found"), "{}", err);
        let reqs = rec.lock().unwrap();
        assert!(reqs.iter().all(|r| r.starts_with("POST /v1/audio/transcriptions ")));
    }

    #[tokio::test]
    async fn mock_probe_200_sends_model_and_no_authorization_without_key() {
        let (base, rec) = mock_server(|_, _| ("200 OK", r#"{"text":""}"#.to_string())).await;
        let p = mock_provider(&base, None, None);
        assert!(p.test_connection().await.unwrap());

        let reqs = rec.lock().unwrap();
        assert_eq!(reqs.len(), 1);
        let post = &reqs[0];
        assert!(post.starts_with("POST /v1/audio/transcriptions "));
        assert!(post.contains("name=\"model\""));
        assert!(post.contains("faster-whisper-small"));
        assert!(!lower(post).contains("authorization:"));
    }

    #[tokio::test]
    async fn mock_openai_key_is_not_sent_to_custom_endpoint() {
        let (base, rec) = mock_server(|_, _| ("200 OK", "{}".to_string())).await;
        let p = mock_provider(&base, Some("sk-openai-secret"), None);
        assert!(p.test_connection().await.unwrap());
        let reqs = rec.lock().unwrap();
        assert!(!lower(&reqs[0]).contains("authorization:"));
        assert!(!reqs[0].contains("sk-openai-secret"));
    }

    #[tokio::test]
    async fn mock_custom_key_is_sent_as_bearer() {
        let (base, rec) = mock_server(|_, _| ("200 OK", "{}".to_string())).await;
        let p = mock_provider(&base, Some("sk-openai-secret"), Some("custom-secret"));
        assert!(p.test_connection().await.unwrap());
        let reqs = rec.lock().unwrap();
        assert!(lower(&reqs[0]).contains("authorization: bearer custom-secret"));
        assert!(!reqs[0].contains("sk-openai-secret"));
    }

    #[tokio::test]
    async fn mock_probe_401_without_key_says_server_needs_a_key() {
        let (base, _rec) = mock_server(|_, _| ("401 Unauthorized", "{}".to_string())).await;
        let p = mock_provider(&base, None, None);
        let err = p.test_connection().await.unwrap_err().to_string();
        assert_eq!(err, "This server needs an API key.");
    }

    #[tokio::test]
    async fn mock_probe_403_with_key_reports_refused_key() {
        let (base, _rec) = mock_server(|_, _| ("403 Forbidden", "{}".to_string())).await;
        let p = mock_provider(&base, None, Some("bad-key"));
        let err = p.test_connection().await.unwrap_err().to_string();
        assert!(err.contains("The server refused the API key"), "{}", err);
        assert!(!err.contains("bad-key"));
    }

    #[tokio::test]
    async fn mock_probe_405_and_500_report_status_and_trimmed_body() {
        let (base, _rec) = mock_server(|_, _| ("405 Method Not Allowed", "{}".to_string())).await;
        let err = mock_provider(&base, None, None).test_connection().await.unwrap_err().to_string();
        assert!(err.contains("405"), "{}", err);

        let long_body = "boom ".repeat(100);
        let (base, _rec) = mock_server(move |_, _| ("500 Internal Server Error", long_body.clone())).await;
        let err = mock_provider(&base, None, None).test_connection().await.unwrap_err().to_string();
        assert!(err.starts_with("The server answered 500: boom"), "{}", err);
        assert!(err.chars().count() < 260, "body must be trimmed: {}", err.len());
    }

    #[tokio::test]
    async fn mock_unreachable_server_says_so() {
        // Bind then drop to get a port nothing listens on.
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", l.local_addr().unwrap());
        drop(l);
        let err = mock_provider(&base, None, None).test_connection().await.unwrap_err().to_string();
        assert_eq!(err, format!("Couldn't reach {}. Is the server running?", base));
    }

    #[tokio::test]
    async fn mock_send_segment_emits_transcript() {
        let (base, rec) =
            mock_server(|_, _| ("200 OK", r#"{"text":" hello "}"#.to_string())).await;
        let (tx, mut rx) = mpsc::channel(4);
        let p = mock_provider(&base, None, None);
        WhisperApiSTT::send_segment(&p.target(), &p.reporter, vec![100i16; 1600], 42, tx).await;

        let result = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
            .await
            .expect("timed out waiting for transcript")
            .expect("channel closed without a result");
        assert_eq!(result.text, "hello");
        assert!(result.is_final);
        assert_eq!(result.timestamp_ms, 42);

        let reqs = rec.lock().unwrap();
        assert_eq!(reqs.len(), 1);
        assert!(reqs[0].starts_with("POST /v1/audio/transcriptions "));
        assert!(reqs[0].contains("faster-whisper-small"));
        assert!(!lower(&reqs[0]).contains("authorization:"));
    }

    #[tokio::test]
    async fn mock_segment_failures_are_reported_once_and_cleared_on_success() {
        let fail = std::sync::Arc::new(AtomicBool::new(true));
        let f = fail.clone();
        let (base, _rec) = mock_server(move |_, _| {
            if f.load(Ordering::SeqCst) {
                ("500 Internal Server Error", "nope".to_string())
            } else {
                ("200 OK", r#"{"text":"ok"}"#.to_string())
            }
        })
        .await;
        let p = mock_provider(&base, None, None);
        let (tx, mut rx) = mpsc::channel(4);

        WhisperApiSTT::send_segment(&p.target(), &p.reporter, vec![1; 160], 0, tx.clone()).await;
        assert!(p.reporter.failing.load(Ordering::SeqCst));
        WhisperApiSTT::send_segment(&p.target(), &p.reporter, vec![1; 160], 0, tx.clone()).await;
        assert!(p.reporter.failing.load(Ordering::SeqCst));
        assert!(rx.try_recv().is_err(), "failed segments emit no transcript");

        fail.store(false, Ordering::SeqCst);
        WhisperApiSTT::send_segment(&p.target(), &p.reporter, vec![1; 160], 0, tx).await;
        assert!(!p.reporter.failing.load(Ordering::SeqCst));
        assert_eq!(rx.recv().await.unwrap().text, "ok");
    }
}
