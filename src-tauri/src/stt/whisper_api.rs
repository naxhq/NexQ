// Sub-PRD 9: OpenAI Whisper REST API STT
//
// Accumulates audio chunks into ~5 second segments, then sends each segment
// as a multipart form POST to https://api.openai.com/v1/audio/transcriptions.
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

/// OpenAI Whisper transcription API response.
#[derive(Debug, Deserialize)]
struct WhisperResponse {
    text: Option<String>,
}

/// OpenAI Whisper REST API STT provider.
///
/// Accumulates PCM audio into ~5-second segments and POSTs them as WAV files
/// to the OpenAI /v1/audio/transcriptions endpoint.
pub struct WhisperApiSTT {
    api_key: String,
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
        language: &str,
        samples: Vec<i16>,
        timestamp_ms: u64,
        result_tx: mpsc::Sender<TranscriptResult>,
    ) {
        let wav_data = Self::encode_wav(&samples);

        let client = reqwest::Client::new();
        let file_part = reqwest::multipart::Part::bytes(wav_data)
            .file_name("audio.wav")
            .mime_str("audio/wav")
            .unwrap_or_else(|_| {
                reqwest::multipart::Part::bytes(Vec::new())
            });

        let mut form = reqwest::multipart::Form::new()
            .text("model", "whisper-1")
            .text("response_format", "json")
            .part("file", file_part);

        // Only add language if it's not empty
        if !language.is_empty() {
            // Whisper API uses ISO 639-1 codes (e.g., "en", "es", "fr")
            let lang_code = language.split('-').next().unwrap_or(language);
            form = form.text("language", lang_code.to_string());
        }

        let response = client
            .post("https://api.openai.com/v1/audio/transcriptions")
            .header("Authorization", format!("Bearer {}", api_key))
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
                                        language: Some(language.to_string()),
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

        if self.api_key.is_empty() {
            return Err("OpenAI API key not configured".into());
        }

        log::info!(
            "WhisperApiSTT: Starting stream (language: {})",
            self.language
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
                    language: Some(self.language.clone()),
                    segment_id: None,
                    duration_ms: None,
                    speaker_tag: None,
                    turn: None,
                };
                let _ = tx.send(interim).await;

                // Spawn the API call so it doesn't block audio feeding
                let api_key = self.api_key.clone();
                let language = self.language.clone();
                let result_tx = tx.clone();
                tokio::spawn(async move {
                    Self::send_segment(&api_key, &language, segment, timestamp_ms, result_tx)
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
                let language = self.language.clone();
                let result_tx = tx.clone();
                tokio::spawn(async move {
                    Self::send_segment(&api_key, &language, segment, timestamp_ms, result_tx)
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
        if self.api_key.is_empty() {
            return Err("No API key configured".into());
        }

        log::info!("WhisperApiSTT: Testing connection...");

        // Test by listing models -- a lightweight authenticated endpoint
        let client = reqwest::Client::new();
        let response = client
            .get("https://api.openai.com/v1/models")
            .header("Authorization", format!("Bearer {}", self.api_key))
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

        Ok(success)
    }

    fn set_language(&mut self, language: &str) {
        self.language = language.to_string();
        log::info!("WhisperApiSTT: Language set to {}", self.language);
    }
}
