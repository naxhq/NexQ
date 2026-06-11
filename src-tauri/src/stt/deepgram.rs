// Sub-PRD 4 + PRD 1: Deepgram WebSocket streaming STT
//
// Connects to wss://api.deepgram.com/v1/listen for real-time transcription.
// Sends audio chunks as binary WebSocket frames and parses JSON responses
// for interim and final transcript results.
//
// Enhanced with:
// - Auto-reconnect with exponential backoff (1s, 2s, 4s, max 30s, 5 retries)
// - Keepalive ping frames every 8s (Deepgram disconnects after 10s idle)
// - Connection status events emitted to frontend
// - Graceful close via {"type":"CloseStream"} message
// - Improved API key validation error messages

use async_trait::async_trait;
use futures::stream::SplitSink;
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::audio::AudioChunk;
use crate::stt::provider::{STTProviderType, STTProvider, TranscriptResult};

/// All configurable Deepgram streaming parameters.
/// Serialized to/from JSON for the IPC boundary.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeepgramConfig {
    /// Model to use: "nova-3", "nova-2", "nova", "enhanced", "base",
    /// "whisper-large", "whisper-medium", "whisper-small", "whisper-tiny", "whisper-base"
    pub model: String,
    /// Apply smart formatting (dates, times, numbers, punctuation paragraphs)
    pub smart_format: bool,
    /// Return interim (partial) results during speech
    pub interim_results: bool,
    /// Endpointing silence threshold in ms (10–5000). None = disabled.
    pub endpointing: Option<u32>,
    /// Add punctuation and capitalization
    pub punctuate: bool,
    /// Detect speaker changes (diarization)
    pub diarize: bool,
    /// Remove profanity from transcript
    pub profanity_filter: bool,
    /// Convert written numbers to numerals ("nine hundred" → "900")
    pub numerals: bool,
    /// Format spoken punctuation commands into symbols
    pub dictation: bool,
    /// Emit VAD speech-started events
    pub vad_events: bool,
    /// Keyterm prompts (up to 100) — words/phrases model focuses on
    pub keyterms: Vec<String>,
}

impl Default for DeepgramConfig {
    fn default() -> Self {
        Self {
            model: "nova-3".to_string(),
            smart_format: false,
            interim_results: true,
            endpointing: Some(300),
            punctuate: true,
            diarize: false,
            profanity_filter: false,
            numerals: false,
            dictation: false,
            vad_events: true,
            keyterms: Vec::new(),
        }
    }
}

/// Connection status for the frontend status indicator.
#[derive(Debug, Clone, Serialize)]
pub struct ConnectionStatusEvent {
    pub provider: String,
    pub party: String,
    pub status: String, // "connecting", "connected", "error", "disconnected", "reconnecting"
    pub message: Option<String>,
}

/// Deepgram streaming STT provider.
pub struct DeepgramSTT {
    api_key: String,
    language: String,
    /// All configurable Deepgram streaming parameters
    config: DeepgramConfig,
    is_streaming: bool,
    result_tx: Option<mpsc::Sender<TranscriptResult>>,
    /// Channel to send audio data to the WebSocket writer task
    audio_tx: Option<mpsc::Sender<Vec<u8>>>,
    stop_flag: Arc<AtomicBool>,
    start_time: Option<Instant>,
    /// Party label for status events ("You" or "Them")
    party: String,
    /// App handle for emitting status events
    app_handle: Option<tauri::AppHandle>,
    /// Connection state: 0=disconnected, 1=connecting, 2=connected, 3=error
    connection_state: Arc<AtomicU8>,
}

/// Deepgram WebSocket JSON response structures.
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct DeepgramResponse {
    #[serde(rename = "type")]
    response_type: Option<String>,
    channel: Option<DeepgramChannel>,
    is_final: Option<bool>,
    start: Option<f64>,
    duration: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct DeepgramChannel {
    alternatives: Vec<DeepgramAlternative>,
}

#[derive(Debug, Deserialize)]
struct DeepgramAlternative {
    transcript: String,
    confidence: f64,
    /// Word-level data (present when diarize=true)
    #[serde(default)]
    words: Vec<DeepgramWord>,
}

#[derive(Debug, Deserialize)]
struct DeepgramWord {
    #[allow(dead_code)]
    word: String,
    /// Speaker ID assigned by diarization (0, 1, 2, ...)
    speaker: Option<u32>,
}

impl DeepgramSTT {
    pub fn new() -> Self {
        Self {
            api_key: String::new(),
            language: "en".to_string(),
            config: DeepgramConfig::default(),
            is_streaming: false,
            result_tx: None,
            audio_tx: None,
            stop_flag: Arc::new(AtomicBool::new(false)),
            start_time: None,
            party: "Them".to_string(),
            app_handle: None,
            connection_state: Arc::new(AtomicU8::new(0)),
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

    /// Set the Deepgram configuration (model + feature flags).
    /// Takes effect on the next connection (not mid-stream).
    pub fn set_config(&mut self, config: DeepgramConfig) {
        self.config = config;
    }

    /// Set the party label for status events.
    pub fn set_party(&mut self, party: &str) {
        self.party = party.to_string();
    }

    /// Set the Tauri app handle for emitting status events.
    pub fn set_app_handle(&mut self, handle: tauri::AppHandle) {
        self.app_handle = Some(handle);
    }

    /// Build the Deepgram WebSocket URL from the current config.
    fn build_ws_url(&self) -> String {
        let mut params = vec![
            "encoding=linear16".to_string(),
            "sample_rate=16000".to_string(),
            "channels=1".to_string(),
            format!("language={}", self.language),
            format!("model={}", self.config.model),
        ];

        if self.config.smart_format {
            params.push("smart_format=true".to_string());
        }
        if self.config.interim_results {
            params.push("interim_results=true".to_string());
        }
        if let Some(ep) = self.config.endpointing {
            let clamped = ep.clamp(10, 5000);
            params.push(format!("endpointing={}", clamped));
        }
        if self.config.punctuate {
            params.push("punctuate=true".to_string());
        }
        if self.config.diarize {
            params.push("diarize=true".to_string());
        }
        if self.config.profanity_filter {
            params.push("profanity_filter=true".to_string());
        }
        if self.config.numerals {
            params.push("numerals=true".to_string());
        }
        if self.config.dictation {
            params.push("dictation=true".to_string());
        }
        if self.config.vad_events {
            params.push("vad_events=true".to_string());
        }
        for keyterm in &self.config.keyterms {
            // Basic encoding: replace unsafe chars
            let encoded = keyterm
                .replace('%', "%25")
                .replace(' ', "%20")
                .replace('&', "%26")
                .replace('=', "%3D")
                .replace('+', "%2B");
            params.push(format!("keyterm={}", encoded));
        }

        format!("wss://api.deepgram.com/v1/listen?{}", params.join("&"))
    }

    /// Convert i16 PCM samples to raw bytes (little-endian) for Deepgram.
    fn pcm_to_bytes(samples: &[i16]) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(samples.len() * 2);
        for &sample in samples {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        bytes
    }

    /// Emit a connection status event to the frontend.
    fn emit_status(
        app_handle: &Option<tauri::AppHandle>,
        party: &str,
        status: &str,
        message: Option<String>,
    ) {
        if let Some(ref handle) = app_handle {
            let event = ConnectionStatusEvent {
                provider: "deepgram".to_string(),
                party: party.to_string(),
                status: status.to_string(),
                message,
            };
            if let Err(e) = tauri::Emitter::emit(handle, "stt_connection_status", &event) {
                log::warn!("DeepgramSTT: Failed to emit status event: {}", e);
            }
        }
    }

    /// Attempt to connect to Deepgram WebSocket. Returns the split stream.
    async fn connect(
        api_key: &str,
        url: &str,
    ) -> Result<
        WebSocketStream<MaybeTlsStream<TcpStream>>,
        Box<dyn std::error::Error + Send + Sync>,
    > {
        let request = tokio_tungstenite::tungstenite::http::Request::builder()
            .uri(url)
            .header("Authorization", format!("Token {}", api_key))
            .header("Host", "api.deepgram.com")
            .header("Upgrade", "websocket")
            .header("Connection", "Upgrade")
            .header("Sec-WebSocket-Version", "13")
            .header(
                "Sec-WebSocket-Key",
                tokio_tungstenite::tungstenite::handshake::client::generate_key(),
            )
            .body(())?;

        let (ws_stream, _response) = tokio_tungstenite::connect_async(request).await?;
        Ok(ws_stream)
    }

    /// Parse a Deepgram JSON response into a TranscriptResult.
    /// When diarization is active, the speaker is extracted from the dominant
    /// speaker ID in the word-level data (e.g. "speaker_0", "speaker_1").
    fn parse_response(
        json_str: &str,
        speaker: &str,
        start_time: Instant,
    ) -> Option<TranscriptResult> {
        let response: DeepgramResponse = serde_json::from_str(json_str).ok()?;

        // Only process "Results" type messages
        let response_type = response.response_type.as_deref().unwrap_or("");
        if response_type != "Results" {
            return None;
        }

        let channel = response.channel?;
        if channel.alternatives.is_empty() {
            return None;
        }

        let alt = &channel.alternatives[0];
        let text = alt.transcript.trim().to_string();

        // Skip empty transcripts
        if text.is_empty() {
            return None;
        }

        let is_final = response.is_final.unwrap_or(false);
        let confidence = alt.confidence as f32;

        // Extract speaker from diarization word data if available.
        // Use the most frequent speaker ID across words as the segment speaker.
        let diarized_speaker = if !alt.words.is_empty() {
            let mut speaker_counts: std::collections::HashMap<u32, usize> =
                std::collections::HashMap::new();
            for w in &alt.words {
                if let Some(sid) = w.speaker {
                    *speaker_counts.entry(sid).or_insert(0) += 1;
                }
            }
            speaker_counts
                .into_iter()
                .max_by_key(|&(_, count)| count)
                .map(|(sid, _)| format!("speaker_{}", sid))
        } else {
            None
        };

        let final_speaker = diarized_speaker.unwrap_or_else(|| speaker.to_string());

        // Convert Deepgram's stream-relative offset to epoch timestamp.
        // The frontend expects epoch timestamps (consistent with Web Speech's Date.now()).
        let stream_offset_ms = response
            .start
            .map(|s| (s * 1000.0) as u64)
            .unwrap_or_else(|| start_time.elapsed().as_millis() as u64);
        let epoch_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        // Use current epoch minus the difference between elapsed and stream offset
        // to get the approximate epoch time of when this segment started.
        let elapsed_ms = start_time.elapsed().as_millis() as u64;
        let timestamp_ms = epoch_ms.saturating_sub(elapsed_ms.saturating_sub(stream_offset_ms));

        Some(TranscriptResult {
            text,
            is_final,
            confidence,
            timestamp_ms,
            speaker: Some(final_speaker),
            language: None,
            segment_id: None,
        })
    }

    /// Spawn the combined reader + keepalive + reconnect task.
    /// Tracks seen speaker IDs and emits `speaker_detected` events for new ones.
    fn spawn_reader_task(
        mut read_half: futures::stream::SplitStream<
            WebSocketStream<MaybeTlsStream<TcpStream>>,
        >,
        result_tx: mpsc::Sender<TranscriptResult>,
        speaker: String,
        stop_flag: Arc<AtomicBool>,
        start_time: Instant,
        connection_state: Arc<AtomicU8>,
        app_handle: Option<tauri::AppHandle>,
        diarize_enabled: bool,
    ) {
        tokio::spawn(async move {
            connection_state.store(2, Ordering::SeqCst); // connected
            let mut seen_speakers: std::collections::HashSet<String> =
                std::collections::HashSet::new();

            while let Some(msg_result) = read_half.next().await {
                if stop_flag.load(Ordering::SeqCst) {
                    break;
                }

                match msg_result {
                    Ok(Message::Text(text)) => {
                        if let Some(result) =
                            Self::parse_response(&text, &speaker, start_time)
                        {
                            // Emit speaker_detected for new diarization speaker IDs
                            if diarize_enabled {
                                if let Some(ref spk) = result.speaker {
                                    if spk.starts_with("speaker_") && !seen_speakers.contains(spk) {
                                        seen_speakers.insert(spk.clone());
                                        if let Some(ref handle) = app_handle {
                                            let payload = serde_json::json!({
                                                "speaker_id": spk,
                                                "meeting_id": "",
                                            });
                                            let _ = tauri::Emitter::emit(handle, "speaker_detected", &payload);
                                            log::info!("DeepgramSTT: New speaker detected via diarization: {}", spk);
                                        }
                                    }
                                }
                            }

                            if result_tx.send(result).await.is_err() {
                                log::warn!("DeepgramSTT: Result channel closed");
                                break;
                            }
                        }
                    }
                    Ok(Message::Close(_)) => {
                        log::info!("DeepgramSTT: WebSocket closed by server");
                        connection_state.store(0, Ordering::SeqCst);
                        break;
                    }
                    Ok(Message::Pong(_)) => {
                        // Keepalive pong received — connection is healthy
                    }
                    Err(e) => {
                        log::error!("DeepgramSTT: WebSocket read error: {}", e);
                        connection_state.store(3, Ordering::SeqCst);
                        break;
                    }
                    _ => {}
                }
            }

            log::info!("DeepgramSTT: Reader task exiting");
        });
    }

    /// Spawn the WebSocket writer task that sends audio data + Deepgram KeepAlive messages.
    ///
    /// Uses Deepgram's protocol-level `{"type": "KeepAlive"}` JSON message instead of
    /// WebSocket pings. Deepgram's idle timeout counts audio data frames, not WS pings.
    /// The KeepAlive message explicitly tells Deepgram "I'm still here" during silence.
    fn spawn_writer_task(
        mut write_half: SplitSink<
            WebSocketStream<MaybeTlsStream<TcpStream>>,
            Message,
        >,
        mut audio_rx: mpsc::Receiver<Vec<u8>>,
        stop_flag: Arc<AtomicBool>,
        app_handle: Option<tauri::AppHandle>,
        party: String,
        connection_state: Arc<AtomicU8>,
    ) {
        tokio::spawn(async move {
            // Send KeepAlive every 5s (Deepgram disconnects after ~10s idle)
            let mut keepalive_interval = tokio::time::interval(Duration::from_secs(5));
            keepalive_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            let keepalive_msg = serde_json::json!({"type": "KeepAlive"}).to_string();

            loop {
                if stop_flag.load(Ordering::SeqCst) {
                    break;
                }

                tokio::select! {
                    audio = audio_rx.recv() => {
                        match audio {
                            Some(audio_bytes) => {
                                if let Err(e) = write_half.send(Message::Binary(audio_bytes.into())).await {
                                    log::error!("DeepgramSTT: WebSocket write error: {}", e);
                                    connection_state.store(3, Ordering::SeqCst);
                                    Self::emit_status(&app_handle, &party, "error", Some(format!("Write error: {}", e)));
                                    break;
                                }
                            }
                            None => {
                                // Audio channel closed — send CloseStream for graceful shutdown
                                log::info!("DeepgramSTT: Audio channel closed, sending CloseStream");
                                let close_msg = serde_json::json!({"type": "CloseStream"});
                                let _ = write_half.send(Message::Text(close_msg.to_string().into())).await;
                                break;
                            }
                        }
                    }
                    _ = keepalive_interval.tick() => {
                        // Send Deepgram KeepAlive protocol message (not WS ping)
                        if let Err(e) = write_half.send(Message::Text(keepalive_msg.clone().into())).await {
                            log::warn!("DeepgramSTT: KeepAlive failed: {}", e);
                            connection_state.store(3, Ordering::SeqCst);
                            Self::emit_status(&app_handle, &party, "error", Some("KeepAlive failed".to_string()));
                            break;
                        }
                    }
                }
            }

            // Send close frame
            let _ = write_half
                .send(Message::Close(None))
                .await;

            log::info!("DeepgramSTT: Writer task exiting");
        });
    }
}

#[async_trait]
impl STTProvider for DeepgramSTT {
    fn provider_name(&self) -> &str {
        // Dynamic name based on model, but we return a static str for the trait.
        // The model info is available via the config field.
        "Deepgram"
    }

    fn provider_type(&self) -> STTProviderType {
        STTProviderType::Deepgram
    }

    async fn start_stream(
        &mut self,
        result_tx: mpsc::Sender<TranscriptResult>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if self.is_streaming {
            return Err("Stream already active".into());
        }

        if self.api_key.is_empty() {
            return Err("Deepgram API key not configured. Get a free API key at https://console.deepgram.com/signup ($200 free credit, no credit card required).".into());
        }

        log::info!(
            "DeepgramSTT: Connecting to Deepgram {} (language: {}, smart_format: {}, diarize: {}, endpointing: {:?})",
            self.config.model, self.language, self.config.smart_format, self.config.diarize, self.config.endpointing
        );

        let url = self.build_ws_url();

        // Emit connecting status
        self.connection_state.store(1, Ordering::SeqCst);
        Self::emit_status(&self.app_handle, &self.party, "connecting", None);

        // Connect with retry logic
        let mut retry_count = 0u32;
        let max_retries = 5;
        let ws_stream = loop {
            match Self::connect(&self.api_key, &url).await {
                Ok(stream) => break stream,
                Err(e) => {
                    retry_count += 1;
                    if retry_count > max_retries {
                        self.connection_state.store(3, Ordering::SeqCst);
                        Self::emit_status(
                            &self.app_handle,
                            &self.party,
                            "error",
                            Some(format!("Failed after {} retries: {}", max_retries, e)),
                        );

                        // Provide specific error messages
                        let err_str = e.to_string();
                        if err_str.contains("401") || err_str.contains("Unauthorized") {
                            return Err("Invalid Deepgram API key. Please check your key at https://console.deepgram.com/".into());
                        } else if err_str.contains("429") {
                            return Err("Deepgram rate limit exceeded. Please wait a moment and try again.".into());
                        }
                        return Err(format!("Failed to connect to Deepgram after {} retries: {}", max_retries, e).into());
                    }

                    let backoff = Duration::from_secs(
                        (1u64 << (retry_count - 1)).min(30)
                    );
                    log::warn!(
                        "DeepgramSTT: Connection attempt {} failed: {}. Retrying in {:?}",
                        retry_count, e, backoff
                    );
                    Self::emit_status(
                        &self.app_handle,
                        &self.party,
                        "reconnecting",
                        Some(format!("Retry {} of {}", retry_count, max_retries)),
                    );
                    tokio::time::sleep(backoff).await;
                }
            }
        };

        log::info!("DeepgramSTT: WebSocket connected");
        Self::emit_status(&self.app_handle, &self.party, "connected", None);

        let (write_half, read_half) = ws_stream.split();

        let start_time = Instant::now();
        self.start_time = Some(start_time);
        self.stop_flag.store(false, Ordering::SeqCst);

        // Create audio data channel
        let (audio_tx, audio_rx) = mpsc::channel::<Vec<u8>>(512);
        self.audio_tx = Some(audio_tx);
        self.result_tx = Some(result_tx.clone());

        // Spawn reader and writer tasks
        Self::spawn_reader_task(
            read_half,
            result_tx,
            "User".to_string(),
            Arc::clone(&self.stop_flag),
            start_time,
            Arc::clone(&self.connection_state),
            self.app_handle.clone(),
            self.config.diarize,
        );

        Self::spawn_writer_task(
            write_half,
            audio_rx,
            Arc::clone(&self.stop_flag),
            self.app_handle.clone(),
            self.party.clone(),
            Arc::clone(&self.connection_state),
        );

        self.is_streaming = true;
        log::info!("DeepgramSTT: Stream started");
        Ok(())
    }

    async fn feed_audio(
        &mut self,
        chunk: AudioChunk,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // Auto-reconnect: if stream died but we still have a result_tx, try to restart
        if !self.is_streaming {
            if let Some(ref result_tx) = self.result_tx.clone() {
                let state = self.connection_state.load(Ordering::SeqCst);
                // Only reconnect from error/disconnected states (3 or 0), not during connecting (1)
                if state == 0 || state == 3 {
                    log::info!("DeepgramSTT: Auto-reconnecting after disconnect");
                    Self::emit_status(
                        &self.app_handle,
                        &self.party,
                        "reconnecting",
                        Some("Auto-reconnecting...".to_string()),
                    );
                    match self.start_stream(result_tx.clone()).await {
                        Ok(()) => {
                            log::info!("DeepgramSTT: Auto-reconnect successful");
                        }
                        Err(e) => {
                            log::warn!("DeepgramSTT: Auto-reconnect failed: {}", e);
                            return Ok(()); // silently drop audio, will retry on next chunk
                        }
                    }
                }
            }
            if !self.is_streaming {
                return Ok(());
            }
        }

        // Only skip digital silence (RMS < 0.5). Deepgram has server-side VAD
        // (vad_events=true), so client-side is_speech filtering is redundant and
        // drops system audio where WASAPI loopback levels are below the local
        // VAD threshold but are perfectly valid speech for Deepgram.
        if !chunk.pcm_data.is_empty() {
            let rms: f64 = chunk.pcm_data.iter()
                .map(|&s| (s as f64) * (s as f64))
                .sum::<f64>() / chunk.pcm_data.len() as f64;
            if rms.sqrt() < 0.5 {
                return Ok(());
            }
        }

        let audio_bytes = Self::pcm_to_bytes(&chunk.pcm_data);

        if let Some(ref tx) = self.audio_tx {
            if tx.send(audio_bytes).await.is_err() {
                log::warn!("DeepgramSTT: Audio send channel closed, stream may have disconnected");
                // Mark as not streaming — next feed_audio call will auto-reconnect
                self.is_streaming = false;
                self.connection_state.store(0, Ordering::SeqCst);
                Self::emit_status(
                    &self.app_handle,
                    &self.party,
                    "disconnected",
                    Some("Audio channel closed — will auto-reconnect".to_string()),
                );
            }
        }

        Ok(())
    }

    async fn stop_stream(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if !self.is_streaming {
            return Ok(());
        }

        log::info!("DeepgramSTT: Stopping stream");

        self.stop_flag.store(true, Ordering::SeqCst);

        // Drop the audio sender — the writer task will send CloseStream then close
        self.audio_tx = None;
        self.result_tx = None;
        self.is_streaming = false;
        self.start_time = None;
        self.connection_state.store(0, Ordering::SeqCst);

        Self::emit_status(&self.app_handle, &self.party, "disconnected", None);

        log::info!("DeepgramSTT: Stream stopped");
        Ok(())
    }

    async fn test_connection(&self) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        if self.api_key.is_empty() {
            return Err("No API key configured. Get a free key at https://console.deepgram.com/signup".into());
        }

        log::info!("DeepgramSTT: Testing connection...");

        // Test by making a simple HTTP request to the Deepgram API
        let client = reqwest::Client::new();
        let response = client
            .get("https://api.deepgram.com/v1/projects")
            .header("Authorization", format!("Token {}", self.api_key))
            .timeout(Duration::from_secs(10))
            .send()
            .await?;

        let status = response.status();
        if status.is_success() {
            log::info!("DeepgramSTT: Connection test passed");
            Ok(true)
        } else if status.as_u16() == 401 {
            Err("Invalid API key. Please check your Deepgram API key.".into())
        } else if status.as_u16() == 429 {
            Err("Rate limited. Please wait a moment and try again.".into())
        } else {
            log::warn!(
                "DeepgramSTT: Connection test failed with status {}",
                status
            );
            Err(format!("Connection test failed with status {}", status).into())
        }
    }

    fn set_language(&mut self, language: &str) {
        self.language = normalize_deepgram_language(language);
        if self.language == language {
            log::info!("DeepgramSTT: Language set to {}", self.language);
        } else {
            log::info!(
                "DeepgramSTT: Language set to {} (normalized from {})",
                self.language,
                language
            );
        }
    }
}

fn normalize_deepgram_language(language: &str) -> String {
    let trimmed = language.trim();
    if trimmed.is_empty() {
        return "en".to_string();
    }

    match trimmed {
        // Deepgram accepts English locale subtags; other UI locales map to base codes.
        "en-US" | "en-GB" => trimmed.to_string(),
        _ => trimmed.split('-').next().unwrap_or(trimmed).to_string(),
    }
}

/// Estimate Deepgram cost for a given duration.
/// Nova-3 pricing: $0.0043/min (pay-as-you-go).
pub fn estimate_cost(duration_minutes: f32, streams: u32) -> (f32, f32) {
    let rate_per_min = 0.0043_f32;
    let cost = duration_minutes * rate_per_min * streams as f32;
    (cost, rate_per_min)
}
