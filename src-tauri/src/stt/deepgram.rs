// Sub-PRD 4 + PRD 1: Deepgram WebSocket streaming STT
//
// Connects to wss://api.deepgram.com/v1/listen for real-time transcription.
// Sends audio chunks as binary WebSocket frames and parses JSON responses
// for interim and final transcript results.
//
// Enhanced with:
// - Auto-reconnect in the background for the whole meeting (1, 2, 4, 8, then every 15 s);
//   audio captured while offline (up to 30 s) is replayed after reconnecting
// - Keepalive ping frames every 8s (Deepgram disconnects after 10s idle)
// - Connection status events emitted to frontend
// - Graceful close via {"type":"CloseStream"} message
// - Improved API key validation error messages

use async_trait::async_trait;
use futures::stream::SplitSink;
use futures::{FutureExt, SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::collections::VecDeque;
use std::time::{Duration, Instant};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::audio::AudioChunk;
use crate::stt::provider::{diarized_speaker_id, STTProviderType, STTProvider, TranscriptResult};

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
    /// Tell remote speakers apart (diarization; never on the "You" mic)
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
            diarize: true,
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

/// Sample rate of the audio sent to Deepgram (`sample_rate=16000`, mono).
const SAMPLE_RATE: u64 = 16_000;

/// Audio kept while Deepgram is offline, replayed after reconnecting (30 s).
const PENDING_AUDIO_MAX_SAMPLES: usize = 30 * SAMPLE_RATE as usize;

/// How long stop_stream waits for Deepgram's last results after CloseStream.
const FINAL_RESULTS_WAIT: Duration = Duration::from_secs(5);

/// Audio piled up while "connected" (writer stuck on a half-open socket):
/// treat the connection as lost and reconnect (5 s).
const STALLED_AUDIO_SAMPLES: usize = 5 * SAMPLE_RATE as usize;

type DeepgramSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Delay before reconnect attempt `attempt` (1-based): 1, 2, 4, 8, then every 15 s.
fn reconnect_backoff(attempt: u32) -> Duration {
    Duration::from_secs((1u64 << attempt.saturating_sub(1).min(4)).min(15))
}

/// Maps Deepgram's clock (how much audio it has received on this connection)
/// to wall-clock time. Silence isn't sent, so that clock skips every pause:
/// each point where sending resumes records the wall-clock time of the audio
/// at that offset.
struct AudioTimeline {
    /// Samples sent on this connection.
    sent_samples: u64,
    /// (audio offset ms, epoch ms of that audio) where sending resumed, ascending.
    resumes: Vec<(u64, u64)>,
    /// Whether the previous chunk was left out (or none was sent yet).
    paused: bool,
}

impl AudioTimeline {
    /// Resume points kept: results only ever refer to recent audio.
    const MAX_RESUMES: usize = 1024;

    fn new() -> Self {
        Self { sent_samples: 0, resumes: Vec::new(), paused: true }
    }

    fn sent_ms(&self) -> u64 {
        self.sent_samples * 1000 / SAMPLE_RATE
    }

    /// A chunk of `samples` was sent; its audio was captured ending at `captured_at_ms`.
    fn sent(&mut self, samples: u64, captured_at_ms: u64) {
        if self.paused {
            let start_ms = captured_at_ms.saturating_sub(samples * 1000 / SAMPLE_RATE);
            self.resumes.push((self.sent_ms(), start_ms));
            if self.resumes.len() > Self::MAX_RESUMES {
                self.resumes.drain(..Self::MAX_RESUMES / 2);
            }
            self.paused = false;
        }
        self.sent_samples += samples;
    }

    /// A chunk was left out (silence).
    fn skipped(&mut self) {
        self.paused = true;
    }

    /// Wall-clock time of the audio at `offset_ms` on Deepgram's clock.
    fn epoch_at(&self, offset_ms: u64) -> Option<u64> {
        let &(audio_ms, epoch_ms) = self.resumes.iter().rev().find(|(audio_ms, _)| *audio_ms <= offset_ms)?;
        Some(epoch_ms + (offset_ms - audio_ms))
    }
}

fn epoch_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
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
    /// Deepgram's clock vs wall-clock time, for the current connection.
    timeline: Arc<Mutex<AudioTimeline>>,
    /// Party label for status events ("You" or "Them")
    party: String,
    /// App handle for emitting status events
    app_handle: Option<tauri::AppHandle>,
    /// Connection state: 0=disconnected, 1=connecting, 2=connected, 3=error
    connection_state: Arc<AtomicU8>,
    /// Reader of the current connection; stop_stream waits for its last results.
    reader_task: Option<tokio::task::JoinHandle<()>>,
    /// Background reconnect attempt while the meeting goes on.
    reconnect_task: Option<tokio::task::JoinHandle<Result<DeepgramSocket, String>>>,
    reconnect_attempt: u32,
    next_reconnect_at: Option<Instant>,
    /// Audio captured while offline (or while the writer was busy), oldest first.
    pending_audio: VecDeque<AudioChunk>,
    pending_samples: usize,
    /// Tests point the provider at a local WebSocket server.
    url_override: Option<String>,
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
            timeline: Arc::new(Mutex::new(AudioTimeline::new())),
            party: "Them".to_string(),
            app_handle: None,
            connection_state: Arc::new(AtomicU8::new(0)),
            reader_task: None,
            reconnect_task: None,
            reconnect_attempt: 0,
            next_reconnect_at: None,
            pending_audio: VecDeque::new(),
            pending_samples: 0,
            url_override: None,
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

    /// Diarization runs only on the remote party / room audio: the "You" mic
    /// is one person, so diarizing it would be billed for nothing.
    fn diarize_active(&self) -> bool {
        self.config.diarize && self.party != "You"
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
        if self.diarize_active() {
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

        let base = self.url_override.as_deref().unwrap_or("wss://api.deepgram.com/v1/listen");
        format!("{}?{}", base, params.join("&"))
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
        timeline: &AudioTimeline,
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

        // Diarization: the segment's speaker tag is the most frequent speaker
        // ID across its words ("S1" for speaker 0). The speaker stays the
        // party label, so routing, filters and question detection are unchanged.
        let speaker_tag = dominant_speaker(&alt.words).map(|sid| format!("S{}", sid + 1));

        if is_final {
            log::debug!(
                "DeepgramSTT: party={} tag={:?} text={:?}",
                speaker, speaker_tag, log_preview(&text)
            );
        }

        // Epoch time the speech started (the frontend orders lines by it, and
        // the pause before it decides whether it starts a new line). `start`
        // is on Deepgram's clock, which skips the silence NexQ doesn't send;
        // without a mapping, the result arrived about when the speech ended.
        let duration_ms = response.duration.map(|d| (d.max(0.0) * 1000.0).round() as u64);
        let timestamp_ms = response
            .start
            .and_then(|s| timeline.epoch_at((s.max(0.0) * 1000.0) as u64))
            .unwrap_or_else(|| epoch_now_ms().saturating_sub(duration_ms.unwrap_or(0)));

        Some(TranscriptResult {
            text,
            is_final,
            confidence,
            timestamp_ms,
            speaker: Some(speaker.to_string()),
            language: None,
            segment_id: None,
            duration_ms,
            speaker_tag,
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
        timeline: Arc<Mutex<AudioTimeline>>,
        connection_state: Arc<AtomicU8>,
        app_handle: Option<tauri::AppHandle>,
        diarize_enabled: bool,
    ) -> tokio::task::JoinHandle<()> {
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
                        let parsed = {
                            let timeline = timeline.lock().unwrap_or_else(|e| e.into_inner());
                            Self::parse_response(&text, &speaker, &timeline)
                        };
                        if let Some(result) = parsed {
                            // Emit speaker_detected for new diarization speaker IDs
                            // (in-person mode adds them as speakers; online mode
                            // ignores the event and labels lines by tag instead).
                            if diarize_enabled {
                                if let Some(ref spk) = result.speaker_tag.as_deref().and_then(diarized_speaker_id) {
                                    if !seen_speakers.contains(spk) {
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
                        if !stop_flag.load(Ordering::SeqCst) {
                            connection_state.store(0, Ordering::SeqCst);
                        }
                        break;
                    }
                    Ok(Message::Pong(_)) => {
                        // Keepalive pong received — connection is healthy
                    }
                    Err(e) => {
                        log::error!("DeepgramSTT: WebSocket read error: {}", e);
                        if !stop_flag.load(Ordering::SeqCst) {
                            connection_state.store(3, Ordering::SeqCst);
                        }
                        break;
                    }
                    _ => {}
                }
            }

            // The stream ended without Close or an error: still a lost connection.
            if !stop_flag.load(Ordering::SeqCst) && connection_state.load(Ordering::SeqCst) == 2 {
                connection_state.store(0, Ordering::SeqCst);
            }
            log::info!("DeepgramSTT: Reader task exiting");
        })
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
                                    if !stop_flag.load(Ordering::SeqCst) {
                                        connection_state.store(3, Ordering::SeqCst);
                                        Self::emit_status(&app_handle, &party, "error", Some(format!("Write error: {}", e)));
                                    }
                                    break;
                                }
                            }
                            None => {
                                // Audio channel closed — send CloseStream for graceful shutdown
                                log::info!("DeepgramSTT: Audio channel closed, sending CloseStream");
                                let close_msg = serde_json::json!({"type": "CloseStream"});
                                let _ = write_half.send(Message::Text(close_msg.to_string().into())).await;
                                // No close frame: Deepgram sends its last results, then closes.
                                log::info!("DeepgramSTT: Writer task exiting");
                                return;
                            }
                        }
                    }
                    _ = keepalive_interval.tick() => {
                        // Send Deepgram KeepAlive protocol message (not WS ping)
                        if let Err(e) = write_half.send(Message::Text(keepalive_msg.clone().into())).await {
                            log::warn!("DeepgramSTT: KeepAlive failed: {}", e);
                            if !stop_flag.load(Ordering::SeqCst) {
                                connection_state.store(3, Ordering::SeqCst);
                                Self::emit_status(&app_handle, &party, "error", Some("KeepAlive failed".to_string()));
                            }
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
        if let Some(task) = self.reconnect_task.take() {
            task.abort();
        }
        self.pending_audio.clear();
        self.pending_samples = 0;

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

        self.install_session(ws_stream, result_tx);
        log::info!("DeepgramSTT: Stream started");
        Ok(())
    }

    async fn feed_audio(
        &mut self,
        chunk: AudioChunk,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // The connection died under us (server close, read or write error).
        if self.is_streaming && matches!(self.connection_state.load(Ordering::SeqCst), 0 | 3) {
            self.mark_disconnected();
        }

        // Offline: keep the audio and reconnect in the background, never blocking
        // the shared audio loop (the other party and the recording run on it too).
        if !self.is_streaming {
            if self.result_tx.is_none() {
                return Ok(());
            }
            self.buffer_pending(chunk);
            self.drive_reconnect();
            if self.is_streaming {
                self.flush_pending_nonblocking();
            }
            return Ok(());
        }

        // Earlier audio still waits to be sent: keep the order.
        if !self.pending_audio.is_empty() {
            self.buffer_pending(chunk);
            self.flush_pending_nonblocking();
            // The writer stopped taking audio (half-open socket): reconnect.
            if self.pending_samples > STALLED_AUDIO_SAMPLES {
                log::warn!("DeepgramSTT: writer stalled for 5 s of audio ({}), reconnecting", self.party);
                self.mark_disconnected();
            }
            return Ok(());
        }

        // Only skip digital silence (RMS < 0.5). Deepgram has server-side VAD
        // (vad_events=true), so client-side is_speech filtering is redundant and
        // drops system audio where WASAPI loopback levels are below the local
        // VAD threshold but are perfectly valid speech for Deepgram.
        if is_digital_silence(&chunk) {
            self.timeline.lock().unwrap_or_else(|e| e.into_inner()).skipped();
            return Ok(());
        }

        if let Err(chunk) = self.try_send_chunk(chunk, false) {
            self.buffer_pending(chunk);
        }
        Ok(())
    }

    async fn stop_stream(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if let Some(task) = self.reconnect_task.take() {
            task.abort();
        }
        if !self.is_streaming {
            // Offline at the end: no reconnect after the meeting stopped.
            self.pending_audio.clear();
            self.pending_samples = 0;
            self.result_tx = None;
            self.connection_state.store(0, Ordering::SeqCst);
            Self::emit_status(&self.app_handle, &self.party, "disconnected", None);
            return Ok(());
        }

        log::info!("DeepgramSTT: Stopping stream");

        // Audio still buffered (writer was busy) goes out before CloseStream.
        self.flush_pending_before_close().await;

        // Dropping the audio sender makes the writer send CloseStream; Deepgram
        // then sends the results for the last audio and closes. Wait for them.
        self.audio_tx = None;
        if let Some(reader) = self.reader_task.take() {
            if tokio::time::timeout(FINAL_RESULTS_WAIT, reader).await.is_err() {
                log::warn!("DeepgramSTT: no close from Deepgram within {:?}; last results may be missing", FINAL_RESULTS_WAIT);
            }
        }

        self.stop_flag.store(true, Ordering::SeqCst);
        self.result_tx = None;
        self.is_streaming = false;
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

impl DeepgramSTT {
    /// Start reader/writer tasks for a connected socket.
    fn install_session(&mut self, ws_stream: DeepgramSocket, result_tx: mpsc::Sender<TranscriptResult>) {
        log::info!("DeepgramSTT: WebSocket connected");
        Self::emit_status(&self.app_handle, &self.party, "connected", None);

        let (write_half, read_half) = ws_stream.split();

        // Deepgram's clock starts at zero on every connection.
        self.timeline = Arc::new(Mutex::new(AudioTimeline::new()));
        // Cancel any tasks from a previous connection before starting a new one.
        // The reader/writer tasks each capture their own Arc clone of `stop_flag`,
        // so replacing it guarantees a stale connection can no longer push results
        // into this channel — otherwise an auto-reconnect can leave two readers
        // alive and every final line gets duplicated (and keeps multiplying).
        self.stop_flag.store(true, Ordering::SeqCst);
        self.stop_flag = Arc::new(AtomicBool::new(false));

        // Create audio data channel
        let (audio_tx, audio_rx) = mpsc::channel::<Vec<u8>>(512);
        self.audio_tx = Some(audio_tx);
        self.result_tx = Some(result_tx.clone());

        self.reader_task = Some(Self::spawn_reader_task(
            read_half,
            result_tx,
            self.party.clone(),
            Arc::clone(&self.stop_flag),
            Arc::clone(&self.timeline),
            Arc::clone(&self.connection_state),
            self.app_handle.clone(),
            self.diarize_active(),
        ));

        Self::spawn_writer_task(
            write_half,
            audio_rx,
            Arc::clone(&self.stop_flag),
            self.app_handle.clone(),
            self.party.clone(),
            Arc::clone(&self.connection_state),
        );

        self.is_streaming = true;
        self.reconnect_attempt = 0;
        self.next_reconnect_at = None;
    }

    /// The connection is gone: stop its tasks and reconnect from feed_audio.
    fn mark_disconnected(&mut self) {
        if !self.is_streaming {
            return;
        }
        log::warn!("DeepgramSTT: connection lost ({}), reconnecting in the background", self.party);
        self.is_streaming = false;
        self.stop_flag.store(true, Ordering::SeqCst);
        self.audio_tx = None;
        self.reader_task = None;
        self.connection_state.store(0, Ordering::SeqCst);
        self.reconnect_attempt = 0;
        self.next_reconnect_at = None;
        Self::emit_status(&self.app_handle, &self.party, "reconnecting", Some("Connection lost — reconnecting".to_string()));
    }

    /// Advance the background reconnect without waiting: pick up a finished
    /// attempt, or start the next one when its backoff has passed.
    fn drive_reconnect(&mut self) {
        let Some(result_tx) = self.result_tx.clone() else { return };
        if let Some(task) = self.reconnect_task.as_ref() {
            if !task.is_finished() {
                return;
            }
            let outcome = self.reconnect_task.take().and_then(|t| t.now_or_never());
            match outcome {
                Some(Ok(Ok(ws))) => {
                    log::info!("DeepgramSTT: reconnected ({}) after {} attempt(s)", self.party, self.reconnect_attempt + 1);
                    self.install_session(ws, result_tx);
                    return;
                }
                Some(Ok(Err(e))) => log::warn!("DeepgramSTT: reconnect failed: {}", e),
                other => log::warn!("DeepgramSTT: reconnect task ended: {:?}", other.map(|r| r.map(|_| ()))),
            }
            self.reconnect_attempt += 1;
            let wait = reconnect_backoff(self.reconnect_attempt);
            self.next_reconnect_at = Some(Instant::now() + wait);
            self.connection_state.store(3, Ordering::SeqCst);
            Self::emit_status(&self.app_handle, &self.party, "reconnecting",
                Some(format!("Reconnect attempt {} failed, retrying in {} s", self.reconnect_attempt, wait.as_secs())));
            return;
        }
        if self.next_reconnect_at.is_some_and(|at| Instant::now() < at) {
            return;
        }
        let (key, url) = (self.api_key.clone(), self.build_ws_url());
        self.connection_state.store(1, Ordering::SeqCst);
        self.reconnect_task = Some(tokio::spawn(async move {
            match tokio::time::timeout(Duration::from_secs(10), Self::connect(&key, &url)).await {
                Ok(Ok(ws)) => Ok(ws),
                Ok(Err(e)) => Err(e.to_string()),
                Err(_) => Err("connect timed out after 10 s".to_string()),
            }
        }));
    }

    /// Keep a chunk for later; the oldest audio goes first when 30 s are exceeded.
    fn buffer_pending(&mut self, chunk: AudioChunk) {
        if is_digital_silence(&chunk) {
            return;
        }
        self.pending_samples += chunk.pcm_data.len();
        self.pending_audio.push_back(chunk);
        while self.pending_samples > PENDING_AUDIO_MAX_SAMPLES {
            match self.pending_audio.pop_front() {
                Some(old) => self.pending_samples -= old.pcm_data.len(),
                None => break,
            }
        }
    }

    /// At stop: send the buffered audio, waiting for the writer at most 2 s in total.
    async fn flush_pending_before_close(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while let Some(chunk) = self.pending_audio.pop_front() {
            self.pending_samples -= chunk.pcm_data.len();
            let Some(tx) = self.audio_tx.clone() else { break };
            let left = deadline.saturating_duration_since(Instant::now());
            let samples = chunk.pcm_data.len() as u64;
            let sent = tokio::time::timeout(left, tx.send(Self::pcm_to_bytes(&chunk.pcm_data))).await;
            if !matches!(sent, Ok(Ok(()))) {
                log::warn!("DeepgramSTT: {} buffered chunk(s) not sent at stop", self.pending_audio.len() + 1);
                break;
            }
            let mut timeline = self.timeline.lock().unwrap_or_else(|e| e.into_inner());
            timeline.skipped();
            timeline.sent(samples, chunk.timestamp_ms);
        }
        self.pending_audio.clear();
        self.pending_samples = 0;
    }

    /// Send buffered audio as far as the writer channel takes it, without waiting.
    fn flush_pending_nonblocking(&mut self) {
        while let Some(chunk) = self.pending_audio.pop_front() {
            let samples = chunk.pcm_data.len();
            match self.try_send_chunk(chunk, true) {
                Ok(()) => self.pending_samples -= samples,
                Err(chunk) => {
                    self.pending_audio.push_front(chunk);
                    break;
                }
            }
        }
    }

    /// Queue one chunk for the writer. `resume` anchors Deepgram's clock to this
    /// chunk's capture time (replayed audio arrives late but keeps its own time).
    /// Gives the chunk back if it could not be queued.
    fn try_send_chunk(&mut self, chunk: AudioChunk, resume: bool) -> Result<(), AudioChunk> {
        let Some(tx) = self.audio_tx.as_ref() else { return Err(chunk) };
        match tx.try_send(Self::pcm_to_bytes(&chunk.pcm_data)) {
            Ok(()) => {
                let mut timeline = self.timeline.lock().unwrap_or_else(|e| e.into_inner());
                if resume {
                    timeline.skipped();
                }
                timeline.sent(chunk.pcm_data.len() as u64, chunk.timestamp_ms);
                Ok(())
            }
            Err(mpsc::error::TrySendError::Full(_)) => Err(chunk),
            Err(mpsc::error::TrySendError::Closed(_)) => {
                self.mark_disconnected();
                Err(chunk)
            }
        }
    }
}

/// Digital silence (RMS < 0.5) isn't sent to Deepgram.
fn is_digital_silence(chunk: &AudioChunk) -> bool {
    if chunk.pcm_data.is_empty() {
        return false;
    }
    let rms: f64 = chunk.pcm_data.iter().map(|&s| (s as f64) * (s as f64)).sum::<f64>() / chunk.pcm_data.len() as f64;
    rms.sqrt() < 0.5
}

/// First 40 characters for debug logs. Slicing bytes would panic inside a
/// multi-byte character (Cyrillic, CJK, accented Latin).
fn log_preview(text: &str) -> String {
    text.chars().take(40).collect()
}

/// The speaker ID most words carry (ties go to the lower ID), if any word has one.
fn dominant_speaker(words: &[DeepgramWord]) -> Option<u32> {
    let mut counts: std::collections::BTreeMap<u32, usize> = std::collections::BTreeMap::new();
    for sid in words.iter().filter_map(|w| w.speaker) {
        *counts.entry(sid).or_insert(0) += 1;
    }
    let best = counts.values().copied().max()?;
    counts.into_iter().find(|&(_, count)| count == best).map(|(sid, _)| sid)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_preview_respects_char_boundaries() {
        let text = "Еще раз проверка микрофона, как слышно, прием. Да, сразу.";
        assert_eq!(log_preview(text).chars().count(), 40);
        assert_eq!(log_preview("short"), "short");
    }

    fn results_json(start: f64, duration: f64, speakers: &[u32]) -> String {
        let words: Vec<serde_json::Value> = speakers
            .iter()
            .map(|sid| serde_json::json!({"word": "w", "speaker": sid}))
            .collect();
        serde_json::json!({
            "type": "Results",
            "is_final": true,
            "start": start,
            "duration": duration,
            "channel": {"alternatives": [{"transcript": " hello world ", "confidence": 0.98, "words": words}]}
        })
        .to_string()
    }

    #[test]
    fn parse_reads_duration_and_dominant_speaker_tag() {
        let r = DeepgramSTT::parse_response(&results_json(1.5, 4.23, &[1, 0, 1]), "Them", &AudioTimeline::new()).unwrap();
        assert_eq!(r.text, "hello world");
        assert!(r.is_final);
        assert_eq!(r.duration_ms, Some(4_230));
        assert_eq!(r.speaker.as_deref(), Some("Them"), "speaker stays the party label");
        assert_eq!(r.speaker_tag.as_deref(), Some("S2"));
    }

    /// 0.1 s of 16 kHz audio.
    const CHUNK: u64 = 1_600;

    #[test]
    fn timeline_maps_deepgram_time_across_skipped_silence() {
        let t0 = 1_800_000_000_000;
        let mut tl = AudioTimeline::new();
        // 3 s of speech captured from t0, then 97 s of silence left out.
        for i in 1..=30 {
            tl.sent(CHUNK, t0 + i * 100);
        }
        for _ in 0..970 {
            tl.skipped();
        }
        // Speech resumes 100 s after t0 (Deepgram's clock only reached 3 s).
        tl.sent(CHUNK, t0 + 100_100);
        assert_eq!(tl.epoch_at(1_500), Some(t0 + 1_500));
        assert_eq!(tl.epoch_at(3_050), Some(t0 + 100_050));
    }

    #[test]
    fn a_reply_after_a_long_silence_gets_its_own_line() {
        let t0 = 1_800_000_000_000;
        let mut tl = AudioTimeline::new();
        for i in 1..=30 {
            tl.sent(CHUNK, t0 + i * 100);
        }
        tl.skipped();
        for i in 1..=30 {
            tl.sent(CHUNK, t0 + 100_000 + i * 100);
        }
        let first = DeepgramSTT::parse_response(&results_json(0.0, 2.9, &[]), "Them", &tl).unwrap();
        let late = DeepgramSTT::parse_response(&results_json(3.0, 2.5, &[]), "Them", &tl).unwrap();
        assert_eq!(first.timestamp_ms, t0);
        assert_eq!(late.timestamp_ms, t0 + 100_000);

        let mut acc = crate::stt::segment_accumulator::SegmentAccumulator::new(3_000);
        let lines: Vec<String> = [first, late]
            .into_iter()
            .flat_map(|r| acc.feed_result(r))
            .map(|o| o.id)
            .collect();
        assert_ne!(lines.first(), lines.last(), "the late reply starts a new line");
    }

    #[test]
    fn without_a_mapping_a_result_is_dated_by_its_arrival() {
        let before = epoch_now_ms();
        let r = DeepgramSTT::parse_response(&results_json(5.0, 2.0, &[]), "Them", &AudioTimeline::new()).unwrap();
        assert!(r.timestamp_ms + 2_000 >= before && r.timestamp_ms <= epoch_now_ms());
    }

    #[test]
    fn parse_without_diarization_has_no_tag() {
        let r = DeepgramSTT::parse_response(&results_json(0.0, 1.0, &[]), "Them", &AudioTimeline::new()).unwrap();
        assert_eq!(r.speaker_tag, None);
        // Tie between speakers 0 and 3: the lower id wins (stable across calls).
        let r = DeepgramSTT::parse_response(&results_json(0.0, 1.0, &[3, 0]), "Them", &AudioTimeline::new()).unwrap();
        assert_eq!(r.speaker_tag.as_deref(), Some("S1"));
    }

    #[test]
    fn diarize_is_requested_only_off_the_you_mic() {
        assert!(DeepgramConfig::default().diarize, "on by default");
        let mut them = DeepgramSTT::new();
        them.set_party("Them");
        assert!(them.build_ws_url().contains("diarize=true"));
        let mut you = DeepgramSTT::new();
        you.set_party("You");
        assert!(!you.build_ws_url().contains("diarize"));
        let mut off = DeepgramSTT::new();
        off.set_config(DeepgramConfig { diarize: false, ..DeepgramConfig::default() });
        assert!(!off.build_ws_url().contains("diarize"));
    }

    #[test]
    fn diarized_speaker_id_maps_tags() {
        assert_eq!(diarized_speaker_id("S1").as_deref(), Some("speaker_0"));
        assert_eq!(diarized_speaker_id("S12").as_deref(), Some("speaker_11"));
        assert_eq!(diarized_speaker_id("S0"), None);
        assert_eq!(diarized_speaker_id("x"), None);
    }

    fn chunk(value: i16, ts: u64) -> AudioChunk {
        AudioChunk { pcm_data: vec![value; 1600], source: crate::audio::AudioSource::System, timestamp_ms: ts, is_speech: true }
    }

    /// The server dropped the session. The provider must
    /// reconnect in the background, never block the shared audio loop, keep the
    /// result channel and replay the audio captured while offline.
    #[tokio::test]
    async fn reconnects_after_server_drop_and_replays_buffered_audio() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (got_tx, mut got_rx) = mpsc::channel::<Vec<u8>>(1024);
        let server = tokio::spawn(async move {
            // Session 1: accept, read one audio frame, then drop the transport.
            let (socket, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
            loop {
                if let Some(Ok(Message::Binary(_))) = ws.next().await { break; }
            }
            drop(ws);
            // Session 2: forward audio frames, and send one final result.
            let (socket, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
            let mut answered = false;
            while let Some(Ok(message)) = ws.next().await {
                if let Message::Binary(bytes) = message {
                    if !answered {
                        answered = true;
                        let _ = ws.send(Message::Text(results_json(0.0, 0.1, &[]).into())).await;
                    }
                    if got_tx.send(bytes.to_vec()).await.is_err() { return; }
                }
            }
        });
        let mut provider = DeepgramSTT::with_api_key("test");
        provider.url_override = Some(format!("ws://{address}/v1/listen"));
        let (result_tx, mut result_rx) = mpsc::channel(8);
        provider.start_stream(result_tx).await.unwrap();

        let started = Instant::now();
        let mut value: i16 = 100;
        let mut replayed = Vec::new();
        while started.elapsed() < Duration::from_secs(10) {
            let t = Instant::now();
            provider.feed_audio(chunk(value, 1_000 + value as u64 * 100)).await.unwrap();
            assert!(t.elapsed() < Duration::from_millis(200), "feed_audio blocked the audio loop");
            value += 1;
            tokio::time::sleep(Duration::from_millis(50)).await;
            while let Ok(frame) = got_rx.try_recv() {
                replayed.push(i16::from_le_bytes([frame[0], frame[1]]));
            }
            if replayed.len() > 5 { break; }
        }
        assert!(provider.is_streaming, "stream did not come back");
        assert!(!replayed.is_empty(), "no audio reached the new session");
        assert!(replayed[0] < value - 2, "offline audio was not replayed: first={} latest={}", replayed[0], value);
        let result = tokio::time::timeout(Duration::from_secs(2), result_rx.recv()).await;
        let Ok(Some(result)) = result else { panic!("results after reconnect must reach the same channel") };
        // The result covers the first replayed chunk: it keeps that chunk's capture
        // time (chunk start = its timestamp_ms minus 100 ms), not the reconnect time.
        assert_eq!(result.timestamp_ms, 900 + replayed[0] as u64 * 100, "replayed audio lost its capture time");
        provider.stop_stream().await.ok();
        server.abort();
    }

    /// The last words of a meeting: Deepgram answers CloseStream with the final
    /// results and then closes. stop_stream must wait for them.
    #[tokio::test]
    async fn stop_waits_for_results_sent_after_close_stream() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
            while let Some(Ok(message)) = ws.next().await {
                if let Message::Text(text) = message {
                    if text.contains("CloseStream") {
                        tokio::time::sleep(Duration::from_millis(300)).await;
                        let _ = ws.send(Message::Text(results_json(0.0, 0.5, &[]).into())).await;
                        let _ = ws.close(None).await;
                        break;
                    }
                }
            }
        });
        let mut provider = DeepgramSTT::with_api_key("test");
        provider.url_override = Some(format!("ws://{address}/v1/listen"));
        let (result_tx, mut result_rx) = mpsc::channel(8);
        provider.start_stream(result_tx).await.unwrap();
        provider.feed_audio(chunk(500, 2_000)).await.unwrap();
        provider.stop_stream().await.unwrap();
        let last = result_rx.try_recv();
        assert!(last.is_ok(), "the result sent after CloseStream was lost");
        server.abort();
    }

    /// A replaced session failing late must not tear down the new one.
    #[tokio::test]
    async fn a_stale_session_cannot_mark_the_new_one_lost() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (drop_first_tx, drop_first_rx) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            let (s1, _) = listener.accept().await.unwrap();
            let ws1 = tokio_tungstenite::accept_async(s1).await.unwrap();
            let (s2, _) = listener.accept().await.unwrap();
            let mut ws2 = tokio_tungstenite::accept_async(s2).await.unwrap();
            let _ = drop_first_rx.await;
            drop(ws1); // the old session dies after the new one is installed
            while let Some(Ok(_)) = ws2.next().await {}
        });
        let mut provider = DeepgramSTT::with_api_key("test");
        provider.url_override = Some(format!("ws://{address}/v1/listen"));
        let (result_tx, _result_rx) = mpsc::channel(8);
        provider.start_stream(result_tx.clone()).await.unwrap();
        let ws2 = DeepgramSTT::connect("test", &provider.build_ws_url()).await.unwrap();
        provider.install_session(ws2, result_tx);
        drop_first_tx.send(()).unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        provider.feed_audio(chunk(7, 1)).await.unwrap();
        assert!(provider.is_streaming, "the healthy new session was torn down");
        assert_eq!(provider.connection_state.load(Ordering::SeqCst), 2);
        server.abort();
    }

    /// A writer that stops taking audio while "connected" leads to a reconnect.
    #[tokio::test]
    async fn a_stalled_writer_triggers_a_reconnect() {
        let mut provider = DeepgramSTT::new();
        let (audio_tx, _audio_rx) = mpsc::channel::<Vec<u8>>(2); // never drained
        provider.audio_tx = Some(audio_tx);
        provider.is_streaming = true;
        provider.result_tx = Some(mpsc::channel(1).0);
        provider.connection_state.store(2, Ordering::SeqCst);
        provider.api_key = "test".into();
        provider.url_override = Some("ws://127.0.0.1:9/v1/listen".into());
        for i in 0..60 { provider.feed_audio(chunk(5, i)).await.unwrap(); } // 6 s
        assert!(!provider.is_streaming, "stalled writer was not detected");
        assert!(!provider.pending_audio.is_empty(), "audio kept for replay");
        provider.stop_stream().await.unwrap();
    }

    /// Audio buffered at End is sent before CloseStream.
    #[tokio::test]
    async fn stop_sends_buffered_audio_first() {
        let mut provider = DeepgramSTT::new();
        let (audio_tx, mut audio_rx) = mpsc::channel::<Vec<u8>>(16);
        provider.audio_tx = Some(audio_tx);
        provider.is_streaming = true;
        provider.result_tx = Some(mpsc::channel(1).0);
        for i in 0..3 { provider.buffer_pending(chunk(20 + i, i as u64)); }
        provider.stop_stream().await.unwrap();
        let mut got = 0;
        while audio_rx.try_recv().is_ok() { got += 1; }
        assert_eq!(got, 3);
        assert!(provider.pending_audio.is_empty());
    }

    #[test]
    fn backoff_keeps_trying_every_15_seconds() {
        assert_eq!(reconnect_backoff(1), Duration::from_secs(1));
        assert_eq!(reconnect_backoff(4), Duration::from_secs(8));
        assert_eq!(reconnect_backoff(5), Duration::from_secs(15));
        assert_eq!(reconnect_backoff(50), Duration::from_secs(15));
    }

    #[test]
    fn offline_buffer_keeps_the_newest_30_seconds_and_no_silence() {
        let mut provider = DeepgramSTT::new();
        for i in 0..400 { provider.buffer_pending(chunk(1, i)); }
        assert!(provider.pending_samples <= PENDING_AUDIO_MAX_SAMPLES);
        assert_eq!(provider.pending_audio.back().unwrap().timestamp_ms, 399, "newest audio must be kept");
        let before = provider.pending_audio.len();
        provider.buffer_pending(AudioChunk { pcm_data: vec![0; 1600], source: crate::audio::AudioSource::System, timestamp_ms: 1, is_speech: false });
        assert_eq!(provider.pending_audio.len(), before, "digital silence is not buffered");
    }

    #[tokio::test]
    async fn a_full_writer_channel_never_blocks_and_keeps_order() {
        let mut provider = DeepgramSTT::new();
        let (audio_tx, mut audio_rx) = mpsc::channel::<Vec<u8>>(2);
        provider.audio_tx = Some(audio_tx);
        provider.is_streaming = true;
        provider.result_tx = Some(mpsc::channel(1).0);
        provider.connection_state.store(2, Ordering::SeqCst);
        let t = Instant::now();
        for i in 0..5 { provider.feed_audio(chunk(10 + i, i as u64)).await.unwrap(); }
        assert!(t.elapsed() < Duration::from_millis(50));
        assert_eq!(provider.pending_audio.len(), 3, "leftovers stay buffered in order");
        audio_rx.recv().await.unwrap();
        audio_rx.recv().await.unwrap();
        provider.feed_audio(chunk(99, 99)).await.unwrap(); // new audio queues behind leftovers
        assert_eq!(provider.pending_audio.back().unwrap().timestamp_ms, 99);
        assert_eq!(provider.pending_audio.front().unwrap().timestamp_ms, 4);
    }
}
