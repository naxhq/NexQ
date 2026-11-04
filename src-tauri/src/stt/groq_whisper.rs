// Sub-PRD 9: Groq Whisper REST API STT
//
// Groq provides an OpenAI-compatible transcription endpoint at:
//   https://api.groq.com/openai/v1/audio/transcriptions
//
// Accumulates audio chunks into configurable-length segments (default 5s),
// then POSTs each segment as multipart form data.
// Uses Bearer token auth.
//
// Available models (March 2026):
//   - whisper-large-v3       (highest accuracy, 189x real-time, $0.111/hr)
//   - whisper-large-v3-turbo (fast + cheap, 216x real-time, $0.04/hr)
//
// Key behaviors:
//   - Silence detection: segments with RMS below threshold are skipped (no API call)
//   - Hallucination filter: known Whisper artifacts ("Thank you", etc.) are discarded
//   - Pause-based newlines: speech batches accumulate into one line until silence
//   - Live config updates: reads shared config Arc on each API call

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Instant;
use tauri::AppHandle;
use tokio::sync::mpsc;

use crate::audio::AudioChunk;
use crate::stt::provider::{STTProvider, STTProviderType, TranscriptResult};

/// Sample rate expected by the audio pipeline (16 kHz mono).
const SAMPLE_RATE: u32 = 16000;

/// RMS threshold for i16 PCM silence detection.
/// Segments with RMS below this are considered silence and skipped.
///
/// i16 range: -32768..32767. Typical values:
///   - Digital silence: 0-10
///   - Noise floor: 10-50
///   - Quiet speech: 100-500
///   - Normal speech: 500-3000
const SILENCE_RMS_THRESHOLD: f64 = 100.0;

/// Known Whisper hallucination phrases produced on silent or near-silent audio.
/// These are filtered out regardless of RMS to catch edge cases.
const HALLUCINATION_PHRASES: &[&str] = &[
    "thank you",
    "thanks",
    "thanks for watching",
    "thank you for watching",
    "you",
    "bye",
    "goodbye",
    "the end",
    "subtitle",
    "subtitles",
    "please subscribe",
    "like and subscribe",
    "thanks for listening",
    "thank you for listening",
];

// ── Groq Configuration ──

/// Configurable settings for the Groq Whisper STT provider.
/// Mirrors the Groq API parameters and is synced from the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroqConfig {
    /// Model ID: "whisper-large-v3" or "whisper-large-v3-turbo"
    pub model: String,
    /// ISO 639-1 language code (e.g. "en", "fr"). Empty = auto-detect.
    pub language: String,
    /// Sampling temperature (0.0–1.0). 0 = deterministic.
    pub temperature: f32,
    /// Response format: "json", "verbose_json", or "text"
    pub response_format: String,
    /// Timestamp granularities: "segment", "word", or both.
    pub timestamp_granularities: Vec<String>,
    /// Optional prompt to guide style/spelling (up to 224 tokens).
    pub prompt: String,
    /// Batch segment duration in seconds (how much audio to accumulate before sending).
    pub segment_duration_secs: f32,
}

impl Default for GroqConfig {
    fn default() -> Self {
        Self {
            model: "whisper-large-v3-turbo".to_string(),
            language: "en".to_string(),
            temperature: 0.0,
            response_format: "json".to_string(),
            timestamp_granularities: vec![],
            prompt: String::new(),
            segment_duration_secs: 5.0,
        }
    }
}

/// Groq Whisper transcription API response (OpenAI-compatible).
#[derive(Debug, Deserialize)]
struct GroqWhisperResponse {
    text: Option<String>,
}

// ── Internal message types ──

/// Messages sent to the utterance accumulator task.
/// The accumulator tracks speech/silence boundaries to produce
/// pause-based newlines (like Deepgram's endpointing).
enum AccumulatorMsg {
    /// A batch returned speech text — append to current utterance.
    Speech { text: String, timestamp_ms: u64 },
    /// A batch was silent or a hallucination — may trigger utterance finalization.
    Silence,
    /// Stream ending — flush any accumulated text as final.
    Flush,
}

// ── GroqWhisperSTT provider ──

/// Groq Whisper REST API STT provider.
///
/// Accumulates PCM audio into configurable-length segments and POSTs them
/// as WAV files to the Groq /openai/v1/audio/transcriptions endpoint.
///
/// Uses an utterance accumulator task to produce pause-based newlines:
/// consecutive speech batches are joined into one line, and a silent batch
/// finalizes the current utterance (starts a new line).
pub struct GroqWhisperSTT {
    api_key: String,
    /// Local config (used as fallback when shared_config is unavailable).
    config: GroqConfig,
    /// Shared config Arc for live updates from settings UI.
    /// When present, the provider reads the latest config before each API call.
    shared_config: Option<Arc<RwLock<GroqConfig>>>,
    is_streaming: bool,
    result_tx: Option<mpsc::Sender<TranscriptResult>>,
    stop_flag: Arc<AtomicBool>,
    start_time: Option<Instant>,
    /// Accumulated PCM samples for the current segment.
    audio_buffer: Vec<i16>,
    /// Number of consecutive silence samples at the tail of audio_buffer.
    /// Used to split segments at pause boundaries before sending to API.
    trailing_silence_samples: usize,
    /// Segment counter for diagnostics.
    segment_counter: u64,
    /// Chunks fed since stream start (for periodic diagnostics).
    chunks_fed: u64,
    /// Tauri app handle for emitting debug events.
    app_handle: Option<AppHandle>,
    /// Party role ("You" or "Them") for event attribution.
    party: String,
    /// Channel to send results to the utterance accumulator task.
    accumulator_tx: Option<mpsc::Sender<AccumulatorMsg>>,
}

impl GroqWhisperSTT {
    pub fn new() -> Self {
        Self {
            api_key: String::new(),
            config: GroqConfig::default(),
            shared_config: None,
            is_streaming: false,
            result_tx: None,
            stop_flag: Arc::new(AtomicBool::new(false)),
            start_time: None,
            audio_buffer: Vec::new(),
            trailing_silence_samples: 0,
            segment_counter: 0,
            chunks_fed: 0,
            app_handle: None,
            party: String::new(),
            accumulator_tx: None,
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

    /// Set the Tauri app handle for emitting debug events.
    pub fn set_app_handle(&mut self, handle: AppHandle) {
        self.app_handle = Some(handle);
    }

    /// Set the party role for event attribution.
    pub fn set_party(&mut self, party: &str) {
        self.party = party.to_string();
    }

    /// Set a shared config Arc for live updates from the settings UI.
    /// The provider reads the latest config before each API call, so
    /// settings changes take effect immediately on the next batch.
    pub fn set_shared_config(&mut self, config: Arc<RwLock<GroqConfig>>) {
        // Initialize local config from the shared one
        if let Ok(cfg) = config.read() {
            self.config = cfg.clone();
        }
        self.shared_config = Some(config);
    }

    /// Apply a GroqConfig directly (used in legacy single-provider path).
    pub fn set_config(&mut self, config: GroqConfig) {
        self.config = config;
    }

    /// Get the current config, preferring shared (live) over local.
    fn current_config(&self) -> GroqConfig {
        if let Some(ref arc) = self.shared_config {
            if let Ok(cfg) = arc.read() {
                return cfg.clone();
            }
        }
        self.config.clone()
    }

    /// Emit a debug event to both log and frontend DevLog.
    fn emit_debug(&self, level: &str, msg: &str) {
        match level {
            "error" => log::error!("GroqWhisperSTT[{}]: {}", self.party, msg),
            "warn" => log::warn!("GroqWhisperSTT[{}]: {}", self.party, msg),
            _ => log::info!("GroqWhisperSTT[{}]: {}", self.party, msg),
        }
        if let Some(ref handle) = self.app_handle {
            super::emit_stt_debug(handle, level, "groq", msg);
        }
    }

    /// Calculate RMS energy of i16 PCM samples.
    fn segment_rms(samples: &[i16]) -> f64 {
        if samples.is_empty() {
            return 0.0;
        }
        let sum_sq: f64 = samples
            .iter()
            .map(|&s| (s as f64) * (s as f64))
            .sum();
        (sum_sq / samples.len() as f64).sqrt()
    }

    /// Check if text is a known Whisper hallucination on silent audio.
    fn is_hallucination(text: &str) -> bool {
        let lower = text.to_lowercase();
        let trimmed = lower
            .trim()
            .trim_end_matches(|c: char| ".!?,…".contains(c))
            .trim();
        HALLUCINATION_PHRASES.iter().any(|&p| trimmed == p)
    }

    /// Encode accumulated PCM i16 samples as a WAV byte buffer (16-bit mono 16 kHz).
    fn encode_wav(samples: &[i16]) -> Vec<u8> {
        let data_len = (samples.len() * 2) as u32;
        let file_len = 36 + data_len;
        let mut buf = Vec::with_capacity(44 + data_len as usize);

        // RIFF header
        buf.extend_from_slice(b"RIFF");
        buf.extend_from_slice(&file_len.to_le_bytes());
        buf.extend_from_slice(b"WAVE");

        // fmt sub-chunk
        buf.extend_from_slice(b"fmt ");
        buf.extend_from_slice(&16u32.to_le_bytes());
        buf.extend_from_slice(&1u16.to_le_bytes()); // PCM
        buf.extend_from_slice(&1u16.to_le_bytes()); // mono
        buf.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
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

    /// Make the API call and return the transcribed text (or None on error/silence).
    async fn call_api(
        api_key: &str,
        config: &GroqConfig,
        samples: Vec<i16>,
        app_handle: Option<&AppHandle>,
    ) -> Option<String> {
        let duration_secs = samples.len() as f32 / SAMPLE_RATE as f32;
        let wav_data = Self::encode_wav(&samples);
        let wav_size_kb = wav_data.len() / 1024;

        if let Some(handle) = app_handle {
            super::emit_stt_debug(
                handle,
                "info",
                "groq",
                &format!(
                    "Sending {:.1}s audio ({} KB) to {} ...",
                    duration_secs, wav_size_kb, config.model
                ),
            );
        }

        let client = reqwest::Client::new();
        let file_part = reqwest::multipart::Part::bytes(wav_data)
            .file_name("audio.wav")
            .mime_str("audio/wav")
            .unwrap_or_else(|_| reqwest::multipart::Part::bytes(Vec::new()));

        let mut form = reqwest::multipart::Form::new()
            .text("model", config.model.clone())
            .text("response_format", config.response_format.clone())
            .text("temperature", config.temperature.to_string())
            .part("file", file_part);

        // Add language if not empty and not "auto"
        let lang = &config.language;
        if !lang.is_empty() && lang != "auto" {
            let lang_code = lang.split('-').next().unwrap_or(lang);
            form = form.text("language", lang_code.to_string());
        }

        // Add prompt if provided
        if !config.prompt.is_empty() {
            form = form.text("prompt", config.prompt.clone());
        }

        // Add timestamp granularities for verbose_json format
        if config.response_format == "verbose_json" {
            for gran in &config.timestamp_granularities {
                form = form.text("timestamp_granularities[]", gran.clone());
            }
        }

        let send_start = Instant::now();
        let response = client
            .post("https://api.groq.com/openai/v1/audio/transcriptions")
            .header("Authorization", format!("Bearer {}", api_key))
            .multipart(form)
            .send()
            .await;

        let latency_ms = send_start.elapsed().as_millis();

        match response {
            Ok(resp) => {
                if resp.status().is_success() {
                    match resp.json::<GroqWhisperResponse>().await {
                        Ok(groq_resp) => {
                            if let Some(text) = groq_resp.text {
                                let text = text.trim().to_string();
                                if !text.is_empty() {
                                    if let Some(handle) = app_handle {
                                        let preview = preview(&text, 80);
                                        super::emit_stt_debug(
                                            handle,
                                            "info",
                                            "groq",
                                            &format!(
                                                "Got transcript ({}ms): \"{}\"",
                                                latency_ms, preview
                                            ),
                                        );
                                    }
                                    return Some(text);
                                }
                            }
                            if let Some(handle) = app_handle {
                                super::emit_stt_debug(
                                    handle,
                                    "info",
                                    "groq",
                                    &format!("Empty transcript (silence) — {}ms", latency_ms),
                                );
                            }
                        }
                        Err(e) => {
                            log::error!("GroqWhisperSTT: Failed to parse response: {}", e);
                            if let Some(handle) = app_handle {
                                super::emit_stt_debug(
                                    handle,
                                    "error",
                                    "groq",
                                    &format!("Failed to parse API response: {}", e),
                                );
                            }
                        }
                    }
                } else {
                    let status = resp.status();
                    let body = resp.text().await.unwrap_or_default();
                    log::error!(
                        "GroqWhisperSTT: API returned status {}: {}",
                        status,
                        body
                    );
                    if let Some(handle) = app_handle {
                        let short = preview(&body, 120);
                        super::emit_stt_debug(
                            handle,
                            "error",
                            "groq",
                            &format!("API error {}: {}", status, short),
                        );
                    }
                }
            }
            Err(e) => {
                log::error!("GroqWhisperSTT: Request failed: {}", e);
                if let Some(handle) = app_handle {
                    super::emit_stt_debug(
                        handle,
                        "error",
                        "groq",
                        &format!("Request failed: {}", e),
                    );
                }
            }
        }

        None
    }
}

#[async_trait]
impl STTProvider for GroqWhisperSTT {
    fn provider_name(&self) -> &str {
        "Groq Whisper"
    }

    fn provider_type(&self) -> STTProviderType {
        STTProviderType::GroqWhisper
    }

    async fn start_stream(
        &mut self,
        result_tx: mpsc::Sender<TranscriptResult>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if self.is_streaming {
            return Err("Stream already active".into());
        }

        if self.api_key.is_empty() {
            self.emit_debug("error", "API key not configured — cannot start");
            return Err("Groq API key not configured".into());
        }

        let config = self.current_config();
        self.emit_debug(
            "info",
            &format!(
                "Starting stream: model={}, lang={}, segment={}s, temp={}",
                config.model, config.language, config.segment_duration_secs, config.temperature
            ),
        );

        // Set up the utterance accumulator — manages pause-based newlines.
        // Speech batches accumulate into one line; silence triggers finalization (new line).
        let (acc_tx, mut acc_rx) = mpsc::channel::<AccumulatorMsg>(64);
        self.accumulator_tx = Some(acc_tx);
        self.result_tx = Some(result_tx.clone());

        let app_handle = self.app_handle.clone();

        tokio::spawn(async move {
            let mut utt_counter: u64 = 0;
            let mut utt_text = String::new();
            let mut utt_id = String::new();
            let mut last_ts: u64 = 0;

            while let Some(msg) = acc_rx.recv().await {
                match msg {
                    AccumulatorMsg::Speech {
                        text,
                        timestamp_ms,
                    } => {
                        // Start a new utterance if needed
                        if utt_text.is_empty() {
                            utt_counter += 1;
                            utt_id = format!("groq_utt_{}", utt_counter);
                        }

                        // Append this batch's text to the current utterance
                        if !utt_text.is_empty() {
                            utt_text.push(' ');
                        }
                        utt_text.push_str(&text);
                        last_ts = timestamp_ms;

                        // Emit as interim — frontend updates in-place (same line)
                        let _ = result_tx
                            .send(TranscriptResult {
                                text: utt_text.clone(),
                                is_final: false,
                                confidence: 0.95,
                                timestamp_ms,
                                speaker: None,
                                language: None,
                                segment_id: Some(utt_id.clone()),
                                duration_ms: None,
                                speaker_tag: None,
                                turn: None,
                            })
                            .await;
                    }
                    AccumulatorMsg::Silence | AccumulatorMsg::Flush => {
                        if !utt_text.is_empty() {
                            // Finalize the current utterance — frontend starts new line
                            let _ = result_tx
                                .send(TranscriptResult {
                                    text: utt_text.clone(),
                                    is_final: true,
                                    confidence: 0.95,
                                    timestamp_ms: last_ts,
                                    speaker: None,
                                    language: None,
                                    segment_id: Some(utt_id.clone()),
                                    duration_ms: None,
                                    speaker_tag: None,
                                    turn: None,
                                })
                                .await;
                            utt_text.clear();

                            if let Some(ref handle) = app_handle {
                                super::emit_stt_debug(
                                    handle,
                                    "info",
                                    "groq",
                                    "Utterance finalized (pause detected)",
                                );
                            }
                        }
                    }
                }
            }

            // Flush remaining text when channel closes (stream ending)
            if !utt_text.is_empty() {
                let _ = result_tx
                    .send(TranscriptResult {
                        text: utt_text,
                        is_final: true,
                        confidence: 0.95,
                        timestamp_ms: last_ts,
                        speaker: None,
                        language: None,
                        segment_id: Some(utt_id),
                        duration_ms: None,
                        speaker_tag: None,
                        turn: None,
                    })
                    .await;
            }
        });

        self.is_streaming = true;
        self.stop_flag.store(false, Ordering::SeqCst);
        self.start_time = Some(Instant::now());
        self.audio_buffer.clear();
        self.segment_counter = 0;
        self.chunks_fed = 0;

        self.emit_debug("info", "Stream started — accumulating audio for batch send");
        Ok(())
    }

    async fn feed_audio(
        &mut self,
        chunk: AudioChunk,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if !self.is_streaming || self.stop_flag.load(Ordering::SeqCst) {
            return Ok(());
        }

        self.chunks_fed += 1;

        // Log first chunk and periodic stats
        if self.chunks_fed == 1 {
            self.emit_debug("info", "First audio chunk received");
        }
        if self.chunks_fed % 500 == 0 {
            let config = self.current_config();
            let buf_secs = self.audio_buffer.len() as f32 / SAMPLE_RATE as f32;
            self.emit_debug(
                "info",
                &format!(
                    "Buffer: {:.1}s / {:.1}s ({} chunks fed)",
                    buf_secs, config.segment_duration_secs, self.chunks_fed
                ),
            );
        }

        // Track trailing silence for pause-based splitting.
        // If this chunk is mostly silence, add its length to the counter;
        // otherwise reset to 0 (speech resumed).
        let chunk_rms = Self::segment_rms(&chunk.pcm_data);
        if chunk_rms < SILENCE_RMS_THRESHOLD {
            self.trailing_silence_samples += chunk.pcm_data.len();
        } else {
            self.trailing_silence_samples = 0;
        }

        self.audio_buffer.extend_from_slice(&chunk.pcm_data);

        // Dynamic threshold from current config (picks up live setting changes)
        let config = self.current_config();
        let threshold = (SAMPLE_RATE as f32 * config.segment_duration_secs) as usize;

        // Pause-based split: if we've accumulated at least 0.5s of speech
        // AND trailing silence exceeds 2 seconds, send the speech portion
        // now instead of waiting for the full segment_duration.
        let pause_samples = (SAMPLE_RATE as usize) * 2; // 2 seconds
        let min_speech = (SAMPLE_RATE as usize) / 2; // 0.5 seconds minimum
        let speech_len = self.audio_buffer.len().saturating_sub(self.trailing_silence_samples);

        let should_send = if self.trailing_silence_samples >= pause_samples && speech_len >= min_speech {
            true // Pause detected — send speech portion
        } else {
            self.audio_buffer.len() >= threshold // Normal: buffer full
        };

        if should_send {
            self.segment_counter += 1;
            // Trim trailing silence from the segment to send cleaner audio
            let full_buffer = std::mem::take(&mut self.audio_buffer);
            let segment = if self.trailing_silence_samples > 0 && self.trailing_silence_samples < full_buffer.len() {
                full_buffer[..full_buffer.len() - self.trailing_silence_samples].to_vec()
            } else {
                full_buffer
            };
            self.trailing_silence_samples = 0;
            let timestamp_ms = self
                .start_time
                .map(|t| t.elapsed().as_millis() as u64)
                .unwrap_or(chunk.timestamp_ms);

            // Silence detection on the full segment
            let rms = Self::segment_rms(&segment);

            if rms < SILENCE_RMS_THRESHOLD {
                self.emit_debug(
                    "info",
                    &format!(
                        "Silent segment #{} (rms={:.1}), skipping API call",
                        self.segment_counter, rms
                    ),
                );
                if let Some(ref tx) = self.accumulator_tx {
                    let _ = tx.send(AccumulatorMsg::Silence).await;
                }
                return Ok(());
            }

            self.emit_debug(
                "info",
                &format!(
                    "Speech segment #{} (rms={:.1}), sending {:.1}s to API",
                    self.segment_counter,
                    rms,
                    segment.len() as f32 / SAMPLE_RATE as f32
                ),
            );

            // Spawn the API call — result flows to the accumulator
            let api_key = self.api_key.clone();
            let acc_tx = self.accumulator_tx.as_ref().unwrap().clone();
            let app_handle = self.app_handle.clone();

            tokio::spawn(async move {
                let text =
                    Self::call_api(&api_key, &config, segment, app_handle.as_ref()).await;

                match text {
                    Some(t) if !Self::is_hallucination(&t) => {
                        let _ = acc_tx
                            .send(AccumulatorMsg::Speech {
                                text: t,
                                timestamp_ms,
                            })
                            .await;
                    }
                    Some(t) => {
                        // Hallucination detected — treat as silence
                        if let Some(ref handle) = app_handle {
                            super::emit_stt_debug(
                                handle,
                                "info",
                                "groq",
                                &format!("Filtered hallucination: \"{}\"", t),
                            );
                        }
                        let _ = acc_tx.send(AccumulatorMsg::Silence).await;
                    }
                    None => {
                        // API error or empty result
                        let _ = acc_tx.send(AccumulatorMsg::Silence).await;
                    }
                }
            });
        }

        Ok(())
    }

    async fn stop_stream(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if !self.is_streaming {
            return Ok(());
        }

        self.emit_debug(
            "info",
            &format!(
                "Stopping stream — {} chunks fed, {} segments sent",
                self.chunks_fed, self.segment_counter
            ),
        );

        self.stop_flag.store(true, Ordering::SeqCst);

        // Flush remaining audio buffer (if at least 0.5s of audio)
        let min_flush_samples = (SAMPLE_RATE as f32 * 0.5) as usize;
        if self.audio_buffer.len() >= min_flush_samples {
            let segment = std::mem::take(&mut self.audio_buffer);
            let rms = Self::segment_rms(&segment);

            if rms >= SILENCE_RMS_THRESHOLD {
                self.segment_counter += 1;
                self.emit_debug(
                    "info",
                    &format!(
                        "Flushing final {:.1}s buffer (rms={:.1})",
                        segment.len() as f32 / SAMPLE_RATE as f32,
                        rms
                    ),
                );

                let timestamp_ms = self
                    .start_time
                    .map(|t| t.elapsed().as_millis() as u64)
                    .unwrap_or(0);
                let config = self.current_config();

                // Send final segment synchronously (awaited in stop_stream)
                let text = Self::call_api(
                    &self.api_key,
                    &config,
                    segment,
                    self.app_handle.as_ref(),
                )
                .await;

                if let Some(t) = text {
                    if !Self::is_hallucination(&t) {
                        if let Some(ref tx) = self.accumulator_tx {
                            let _ = tx
                                .send(AccumulatorMsg::Speech {
                                    text: t,
                                    timestamp_ms,
                                })
                                .await;
                        }
                    }
                }
            }
        }

        // Flush the accumulator (finalize any accumulated utterance)
        if let Some(ref tx) = self.accumulator_tx {
            let _ = tx.send(AccumulatorMsg::Flush).await;
        }

        // Drop channels to let the accumulator task finish
        self.accumulator_tx = None;
        self.audio_buffer.clear();
        self.is_streaming = false;
        self.result_tx = None;
        self.start_time = None;

        self.emit_debug("info", "Stream stopped");
        Ok(())
    }

    async fn test_connection(&self) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        if self.api_key.is_empty() {
            return Err("No API key configured".into());
        }

        log::info!("GroqWhisperSTT: Testing connection...");

        // Test by listing models — a lightweight authenticated endpoint
        let client = reqwest::Client::new();
        let response = client
            .get("https://api.groq.com/openai/v1/models")
            .header("Authorization", format!("Bearer {}", self.api_key))
            .send()
            .await?;

        let success = response.status().is_success();
        if success {
            log::info!("GroqWhisperSTT: Connection test passed");
        } else {
            log::warn!(
                "GroqWhisperSTT: Connection test failed with status {}",
                response.status()
            );
        }

        Ok(success)
    }

    fn set_language(&mut self, language: &str) {
        self.config.language = language.to_string();
        log::info!("GroqWhisperSTT: Language set to {}", self.config.language);
    }
}

/// `text` cut to at most `max` characters, ending in "..." when cut. Slicing
/// bytes would panic inside a multi-byte character (Cyrillic, CJK, accented
/// Latin) and stop the transcription.
fn preview(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let kept: String = text.chars().take(max.saturating_sub(3)).collect();
    format!("{kept}...")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_cuts_on_character_boundaries() {
        // 76 ASCII bytes then 'р' (2 bytes): the old `&text[..77]` panicked here.
        let text = format!("{}раз два три четыре пять", "a".repeat(76));
        let cut = preview(&text, 80);
        assert_eq!(cut.chars().count(), 80);
        assert!(cut.ends_with("..."));
        assert_eq!(preview("short", 80), "short");
        assert_eq!(preview(&"é".repeat(80), 80), "é".repeat(80));
    }
}
