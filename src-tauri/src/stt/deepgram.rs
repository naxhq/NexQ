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
// - Flux (no KeepAlive): muting a party closes its stream, so muted time isn't
//   streamed or billed; unmuting reconnects at once and replays the audio
//   captured while connecting. Nova keeps its connection while muted.
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
use crate::stt::deepgram_flux::{self, FluxMessage, FluxTurns};
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
    pub status: String, // "connecting", "connected", "error", "disconnected", "reconnecting", "paused" (muted)
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
/// to wall-clock time. Extended digital silence isn't sent, so its clock skips
/// the remainder of long pauses:
/// each point where sending resumes records the wall-clock time of the audio
/// at that offset.
struct AudioTimeline {
    /// Samples sent on this connection.
    sent_samples: u64,
    /// (audio offset ms, epoch ms of that audio) where sending resumed, ascending.
    resumes: Vec<(u64, u64)>,
    /// Whether the previous chunk was left out (or none was sent yet).
    paused: bool,
    /// Capture time the previous sent chunk ended at.
    last_end_ms: Option<u64>,
}

impl AudioTimeline {
    /// Resume points kept: results only ever refer to recent audio.
    const MAX_RESUMES: usize = 1024;

    /// A capture-time jump between two sent chunks larger than this is a gap
    /// in what Deepgram heard (audio left out of a replay, or never captured).
    const GAP_MS: u64 = 200;

    fn new() -> Self {
        Self { sent_samples: 0, resumes: Vec::new(), paused: true, last_end_ms: None }
    }

    fn sent_ms(&self) -> u64 {
        self.sent_samples * 1000 / SAMPLE_RATE
    }

    /// A chunk of `samples` was sent; its audio was captured ending at `captured_at_ms`.
    /// Contiguous audio shares one resume point, so replaying 30 s of small
    /// chunks doesn't push the older points out.
    fn sent(&mut self, samples: u64, captured_at_ms: u64) {
        let start_ms = captured_at_ms.saturating_sub(samples * 1000 / SAMPLE_RATE);
        let gap = self.last_end_ms.is_none_or(|end| start_ms.abs_diff(end) > Self::GAP_MS);
        if self.paused || gap {
            self.resumes.push((self.sent_ms(), start_ms));
            if self.resumes.len() > Self::MAX_RESUMES {
                self.resumes.drain(..Self::MAX_RESUMES / 2);
            }
            self.paused = false;
        }
        self.last_end_ms = Some(captured_at_ms);
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
    /// Background reconnect attempt while the meeting goes on (socket, when connected).
    reconnect_task: Option<tokio::task::JoinHandle<Result<(DeepgramSocket, Instant), String>>>,
    reconnect_attempt: u32,
    next_reconnect_at: Option<Instant>,
    /// Audio captured while offline (or while the writer was busy), oldest first.
    pending_audio: VecDeque<AudioChunk>,
    pending_samples: usize,
    /// Digital silence still needed after the latest non-silent chunk.
    silence_tail_samples: usize,
    /// Flux only: the party is muted, so no stream is open and nothing is sent.
    paused: bool,
    /// Set by an unmute until the new stream is ready (for the log).
    resuming_since: Option<Instant>,
    /// The stream closed by the latest mute, delivering its last turn
    /// (at most FINAL_RESULTS_WAIT). stop_stream waits for it.
    closing_reader: Option<tokio::task::JoinHandle<()>>,
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
            silence_tail_samples: 0,
            paused: false,
            resuming_since: None,
            closing_reader: None,
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

    /// Flux models (turn detection, /v2/listen) take their own URL, messages and audio handling.
    fn is_flux(&self) -> bool {
        deepgram_flux::is_flux_model(&self.config.model)
    }

    /// Build the Deepgram WebSocket URL from the current config.
    fn build_ws_url(&self) -> String {
        if self.is_flux() {
            let base = self.url_override.as_deref().unwrap_or("wss://api.deepgram.com/v2/listen");
            return deepgram_flux::ws_url(base, &self.config, &self.language);
        }
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
            turn: None,
        })
    }

    /// A Flux message as a transcript result, if it carries one. Errors and
    /// warnings are logged (codes and descriptions only, never text).
    fn on_flux_message(
        json_str: &str,
        speaker: &str,
        turns: &mut FluxTurns,
        timeline: &AudioTimeline,
    ) -> Option<TranscriptResult> {
        match FluxMessage::parse(json_str)? {
            FluxMessage::TurnInfo(info) => turns.on_turn_info(&info, |ms| timeline.epoch_at(ms), epoch_now_ms()),
            FluxMessage::Connected => {
                log::info!("DeepgramSTT: Flux session ready ({})", speaker);
                None
            }
            FluxMessage::Error { code, description } => {
                log::warn!("DeepgramSTT: Flux error ({}): {} {}", speaker, code, description);
                None
            }
            FluxMessage::Warning { code, description } => {
                log::warn!("DeepgramSTT: Flux warning ({}): {} {}", speaker, code, description);
                None
            }
            FluxMessage::Other => None,
        }
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
        flux: bool,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            connection_state.store(2, Ordering::SeqCst); // connected
            let mut seen_speakers: std::collections::HashSet<String> =
                std::collections::HashSet::new();
            let mut flux_turns = FluxTurns::new(&speaker);

            while let Some(msg_result) = read_half.next().await {
                if stop_flag.load(Ordering::SeqCst) {
                    break;
                }

                match msg_result {
                    Ok(Message::Text(text)) => {
                        let parsed = if flux {
                            let timeline = timeline.lock().unwrap_or_else(|e| e.into_inner());
                            Self::on_flux_message(&text, &speaker, &mut flux_turns, &timeline)
                        } else {
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

            // Flux sends no EndOfTurn for a turn cut off by CloseStream or a lost
            // connection: its latest text becomes the final. Not for a
            // connection already replaced, whose stop flag is set.
            if flux && !stop_flag.load(Ordering::SeqCst) {
                if let Some(last) = flux_turns.finish_open_turn() {
                    let _ = result_tx.send(last).await;
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
        flux_timeline: Option<Arc<Mutex<AudioTimeline>>>,
    ) {
        tokio::spawn(async move {
            // Send KeepAlive every 5s (Deepgram disconnects after ~10s idle)
            let mut keepalive_interval = tokio::time::interval(Duration::from_secs(5));
            keepalive_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            let keepalive_msg = serde_json::json!({"type": "KeepAlive"}).to_string();
            // Flux has no KeepAlive and finds turn ends in the audio itself:
            // gaps are filled with silence instead (Deepgram's clock keeps
            // pace with real time, and the timeline knows about it).
            let flux = flux_timeline.is_some();
            let mut gap_check = tokio::time::interval(deepgram_flux::GAP_CHECK_INTERVAL);
            gap_check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            let mut last_sent = Instant::now();
            let mut silence_samples: usize = 0;
            // Flux gets 80 ms frames; Nova gets audio as it comes.
            let mut frames = deepgram_flux::FrameBatcher::default();

            loop {
                if stop_flag.load(Ordering::SeqCst) {
                    break;
                }

                tokio::select! {
                    audio = audio_rx.recv() => {
                        match audio {
                            Some(audio_bytes) => {
                                let frame = if flux { frames.push(audio_bytes, Instant::now()) } else { Some(audio_bytes) };
                                let Some(frame) = frame else { continue };
                                if let Err(e) = write_half.send(Message::Binary(frame.into())).await {
                                    log::error!("DeepgramSTT: WebSocket write error: {}", e);
                                    if !stop_flag.load(Ordering::SeqCst) {
                                        connection_state.store(3, Ordering::SeqCst);
                                        Self::emit_status(&app_handle, &party, "error", Some(format!("Write error: {}", e)));
                                    }
                                    break;
                                }
                                last_sent = Instant::now();
                            }
                            None => {
                                // Audio channel closed — send CloseStream for graceful shutdown
                                log::info!("DeepgramSTT: Audio channel closed, sending CloseStream");
                                if let Some(last) = frames.take() {
                                    let _ = write_half.send(Message::Binary(last.into())).await;
                                }
                                let close_msg = serde_json::json!({"type": "CloseStream"});
                                let _ = write_half.send(Message::Text(close_msg.to_string().into())).await;
                                // No close frame: Deepgram sends its last results, then closes.
                                if flux {
                                    log::info!(
                                        "DeepgramSTT: Flux writer exiting ({}); {:.1} s of silence filled in gaps",
                                        party, silence_samples as f64 / SAMPLE_RATE as f64
                                    );
                                }
                                log::info!("DeepgramSTT: Writer task exiting");
                                return;
                            }
                        }
                    }
                    _ = gap_check.tick(), if flux => {
                        // Audio paused: what's held goes out first, then silence fills the gap.
                        let held = frames.take_if_paused(Instant::now());
                        let samples = if held.is_some() { 0 } else { deepgram_flux::silence_samples_for(last_sent.elapsed()) };
                        if held.is_none() && samples == 0 {
                            continue;
                        }
                        let frame = held.unwrap_or_else(|| vec![0u8; samples * 2]);
                        if let Err(e) = write_half.send(Message::Binary(frame.into())).await {
                            log::error!("DeepgramSTT: WebSocket write error: {}", e);
                            if !stop_flag.load(Ordering::SeqCst) {
                                connection_state.store(3, Ordering::SeqCst);
                                Self::emit_status(&app_handle, &party, "error", Some(format!("Write error: {}", e)));
                            }
                            break;
                        }
                        if samples > 0 {
                            if let Some(ref timeline) = flux_timeline {
                                timeline.lock().unwrap_or_else(|e| e.into_inner()).sent(samples as u64, epoch_now_ms());
                            }
                        }
                        silence_samples += samples;
                        last_sent = Instant::now();
                    }
                    _ = keepalive_interval.tick(), if !flux => {
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
        if self.paused {
            // Flux, muted from the start: connect on the first unmute, not now.
            self.result_tx = Some(result_tx);
            log::info!("DeepgramSTT: muted at start ({}); Flux connects on unmute", self.party);
            Self::emit_status(&self.app_handle, &self.party, "paused", Some("Muted: not streaming to Deepgram".to_string()));
            return Ok(());
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
        // Muted Flux: no stream is open (the audio loop doesn't feed a muted party anyway).
        if self.paused {
            return Ok(());
        }
        // Deepgram needs audio containing a pause to detect an endpoint. Send a
        // bounded tail after speech, then suppress prolonged digital silence.
        if !self.should_forward_audio(&chunk) {
            self.timeline.lock().unwrap_or_else(|e| e.into_inner()).skipped();
            return Ok(());
        }

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

        if let Err(chunk) = self.try_send_chunk(chunk) {
            self.buffer_pending(chunk);
        }
        Ok(())
    }

    async fn stop_stream(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if let Some(task) = self.reconnect_task.take() {
            task.abort();
        }
        self.resuming_since = None;
        if !self.is_streaming {
            // Muted just before the stop: the closed Flux stream still
            // delivers its last turn (its task ends within FINAL_RESULTS_WAIT).
            if let Some(closing) = self.closing_reader.take() {
                let _ = closing.await;
            }
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

    fn set_muted(&mut self, muted: bool) {
        // Flux only: it has no KeepAlive, so an open stream gets silence (billed).
        // Nova keeps its connection as before, with KeepAlive and no audio.
        if !self.is_flux() || muted == self.paused {
            return;
        }
        if muted {
            self.pause();
        } else {
            self.resume();
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
            self.diarize_active() && !self.is_flux(),
            self.is_flux(),
        ));

        Self::spawn_writer_task(
            write_half,
            audio_rx,
            Arc::clone(&self.stop_flag),
            self.app_handle.clone(),
            self.party.clone(),
            Arc::clone(&self.connection_state),
            self.is_flux().then(|| Arc::clone(&self.timeline)),
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

    /// Flux, muted: close the stream so nothing is sent or billed. The closed
    /// stream still delivers the turn in progress, and nothing reconnects
    /// until unmute.
    fn pause(&mut self) {
        self.paused = true;
        self.resuming_since = None;
        if let Some(task) = self.reconnect_task.take() {
            task.abort();
        }
        self.reconnect_attempt = 0;
        self.next_reconnect_at = None;
        if self.is_streaming {
            // Audio captured before the mute goes out first.
            self.flush_pending_nonblocking();
            // Dropping the audio sender makes the writer send CloseStream. The
            // old tasks keep their own stop flag and connection state: they
            // finish the last turn, and can't cut short or mark as lost the
            // stream an unmute opens.
            self.audio_tx = None;
            self.stop_flag = Arc::new(AtomicBool::new(false));
            self.connection_state = Arc::new(AtomicU8::new(0));
            if let Some(mut reader) = self.reader_task.take() {
                self.closing_reader = Some(tokio::spawn(async move {
                    if tokio::time::timeout(FINAL_RESULTS_WAIT, &mut reader).await.is_err() {
                        reader.abort();
                    }
                }));
            }
            self.is_streaming = false;
            log::info!("DeepgramSTT: paused ({}): Flux stream closed while muted", self.party);
        } else {
            log::info!("DeepgramSTT: paused ({}) while not connected", self.party);
        }
        self.pending_audio.clear();
        self.pending_samples = 0;
        Self::emit_status(&self.app_handle, &self.party, "paused", Some("Muted: not streaming to Deepgram".to_string()));
    }

    /// Flux, unmuted: reconnect right away. Audio fed until the stream is
    /// ready is kept and replayed first, so the first words aren't lost.
    fn resume(&mut self) {
        self.paused = false;
        // Not started yet, or already stopped.
        if self.result_tx.is_none() || self.is_streaming {
            return;
        }
        self.resuming_since = Some(Instant::now());
        self.reconnect_attempt = 0;
        self.next_reconnect_at = None;
        self.drive_reconnect();
    }

    /// Advance the background reconnect without waiting: pick up a finished
    /// attempt, or start the next one when its backoff has passed.
    fn drive_reconnect(&mut self) {
        let Some(result_tx) = self.result_tx.clone() else { return };
        if let Some(task) = self.reconnect_task.as_ref() {
            if !task.is_finished() {
                return;
            }
            // Unconstrained: with the task's coop budget used up, polling a
            // finished JoinHandle can still return Pending (and drop the socket).
            let outcome = self.reconnect_task.take().and_then(|t| tokio::task::unconstrained(t).now_or_never());
            let failed = match outcome {
                Some(Ok(Ok((_, connected_at))))
                    if self.is_flux() && connected_at.elapsed() > deepgram_flux::UNUSED_CONNECTION_MAX =>
                {
                    // No audio came for a while (idle loopback), so Deepgram
                    // may have closed it: connect again now.
                    log::info!("DeepgramSTT: Flux connection unused for {} s ({}), connecting again",
                        connected_at.elapsed().as_secs(), self.party);
                    false
                }
                Some(Ok(Ok((ws, _)))) => {
                    if let Some(since) = self.resuming_since.take() {
                        log::info!("DeepgramSTT: resumed ({}): connected {} ms after unmute, replaying {} ms of audio",
                            self.party, since.elapsed().as_millis(), self.pending_samples as u64 * 1000 / SAMPLE_RATE);
                    } else {
                        log::info!("DeepgramSTT: reconnected ({}) after {} attempt(s)", self.party, self.reconnect_attempt + 1);
                    }
                    self.install_session(ws, result_tx);
                    return;
                }
                Some(Ok(Err(e))) => {
                    log::warn!("DeepgramSTT: reconnect failed: {}", e);
                    true
                }
                other => {
                    log::warn!("DeepgramSTT: reconnect task ended: {:?}", other.map(|r| r.map(|_| ())));
                    true
                }
            };
            if failed {
                self.reconnect_attempt += 1;
                let wait = reconnect_backoff(self.reconnect_attempt);
                self.next_reconnect_at = Some(Instant::now() + wait);
                self.connection_state.store(3, Ordering::SeqCst);
                Self::emit_status(&self.app_handle, &self.party, "reconnecting",
                    Some(format!("Reconnect attempt {} failed, retrying in {} s", self.reconnect_attempt, wait.as_secs())));
                return;
            }
        }
        if self.next_reconnect_at.is_some_and(|at| Instant::now() < at) {
            return;
        }
        let (key, url) = (self.api_key.clone(), self.build_ws_url());
        self.connection_state.store(1, Ordering::SeqCst);
        self.reconnect_task = Some(tokio::spawn(async move {
            match tokio::time::timeout(Duration::from_secs(10), Self::connect(&key, &url)).await {
                Ok(Ok(ws)) => Ok((ws, Instant::now())),
                Ok(Err(e)) => Err(e.to_string()),
                Err(_) => Err("connect timed out after 10 s".to_string()),
            }
        }));
    }

    /// Forward enough silence for endpointing and smart formatting, bounded so
    /// an idle stream doesn't send digital silence indefinitely.
    fn should_forward_audio(&mut self, chunk: &AudioChunk) -> bool {
        if chunk.pcm_data.is_empty() {
            return false;
        }
        // Flux finds the end of a turn in the silence after it: send it all.
        if self.is_flux() {
            return true;
        }
        if !is_digital_silence(chunk) {
            let endpoint_ms = self.config.endpointing.unwrap_or(10).clamp(10, 5000);
            let tail_ms = endpoint_ms.max(3000) + 500;
            self.silence_tail_samples = (SAMPLE_RATE as usize * tail_ms as usize) / 1000;
            return true;
        }
        if self.silence_tail_samples == 0 {
            return false;
        }
        self.silence_tail_samples = self.silence_tail_samples.saturating_sub(chunk.pcm_data.len());
        true
    }

    /// Keep a chunk for later; the oldest audio goes first when 30 s are exceeded.
    fn buffer_pending(&mut self, chunk: AudioChunk) {
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
            self.timeline.lock().unwrap_or_else(|e| e.into_inner()).sent(samples, chunk.timestamp_ms);
        }
        self.pending_audio.clear();
        self.pending_samples = 0;
    }

    /// Send buffered audio as far as the writer channel takes it, without waiting.
    fn flush_pending_nonblocking(&mut self) {
        while let Some(chunk) = self.pending_audio.pop_front() {
            let samples = chunk.pcm_data.len();
            match self.try_send_chunk(chunk) {
                Ok(()) => self.pending_samples -= samples,
                Err(chunk) => {
                    self.pending_audio.push_front(chunk);
                    break;
                }
            }
        }
    }

    /// Queue one chunk for the writer. The timeline dates it by its own capture
    /// time (replayed audio arrives late but keeps its time).
    /// Gives the chunk back if it could not be queued.
    fn try_send_chunk(&mut self, chunk: AudioChunk) -> Result<(), AudioChunk> {
        let Some(tx) = self.audio_tx.as_ref() else { return Err(chunk) };
        match tx.try_send(Self::pcm_to_bytes(&chunk.pcm_data)) {
            Ok(()) => {
                self.timeline
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .sent(chunk.pcm_data.len() as u64, chunk.timestamp_ms);
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

/// Digital silence (RMS < 0.5); used to limit long idle periods.
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
    use crate::stt::provider::TurnSignal;

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

    /// 30 s replayed in 10 ms chunks after a reconnect, with one pause left out.
    #[test]
    fn replayed_audio_keeps_its_capture_times() {
        let t0 = 1_800_000_000_000;
        let mut tl = AudioTimeline::new();
        // 15 s of speech, a 2 s pause (not buffered), then 15 s more.
        for i in 1..=1_500 {
            tl.sent(160, t0 + i * 10);
        }
        for i in 1..=1_500 {
            tl.sent(160, t0 + 17_000 + i * 10);
        }
        assert_eq!(tl.resumes.len(), 2, "one resume point per contiguous run");
        assert_eq!(tl.epoch_at(0), Some(t0), "the start of the replay keeps its time");
        assert_eq!(tl.epoch_at(14_000), Some(t0 + 14_000));
        assert_eq!(tl.epoch_at(16_000), Some(t0 + 18_000), "after the pause");
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
    fn offline_buffer_keeps_the_newest_30_seconds() {
        let mut provider = DeepgramSTT::new();
        for i in 0..400 { provider.buffer_pending(chunk(1, i)); }
        assert!(provider.pending_samples <= PENDING_AUDIO_MAX_SAMPLES);
        assert_eq!(provider.pending_audio.back().unwrap().timestamp_ms, 399, "newest audio must be kept");
    }

    #[test]
    fn forwards_a_bounded_silence_tail_after_speech() {
        let mut provider = DeepgramSTT::new();
        let silent = chunk(0, 0); // 100 ms of digital silence
        assert!(!provider.should_forward_audio(&silent), "idle silence is skipped");
        assert!(provider.should_forward_audio(&chunk(100, 100)));
        for _ in 0..35 {
            assert!(provider.should_forward_audio(&silent), "send the full 3.5 s tail");
        }
        assert!(!provider.should_forward_audio(&silent), "skip prolonged silence");
        assert!(provider.should_forward_audio(&chunk(100, 200)));
        assert!(provider.should_forward_audio(&silent), "new speech resets the tail");
    }

    #[test]
    fn silence_tail_covers_long_endpoint_setting() {
        let mut provider = DeepgramSTT::new();
        provider.config.endpointing = Some(5000);
        assert!(provider.should_forward_audio(&chunk(100, 100)));
        let silent = chunk(0, 0);
        for _ in 0..55 { assert!(provider.should_forward_audio(&silent)); }
        assert!(!provider.should_forward_audio(&silent));
    }

    #[tokio::test]
    async fn feed_audio_sends_a_pause_after_speech() {
        let mut provider = DeepgramSTT::new();
        let (audio_tx, mut audio_rx) = mpsc::channel::<Vec<u8>>(4);
        provider.audio_tx = Some(audio_tx);
        provider.is_streaming = true;
        provider.connection_state.store(2, Ordering::SeqCst);
        provider.feed_audio(chunk(0, 100)).await.unwrap();
        assert!(audio_rx.try_recv().is_err(), "initial silence is skipped");
        provider.feed_audio(chunk(100, 200)).await.unwrap();
        provider.feed_audio(chunk(0, 300)).await.unwrap();
        assert!(audio_rx.try_recv().is_ok(), "speech reaches the writer");
        assert!(audio_rx.try_recv().is_ok(), "the following pause reaches the writer");
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

    fn flux_provider(address: std::net::SocketAddr) -> DeepgramSTT {
        let mut provider = DeepgramSTT::with_api_key("test");
        provider.config = DeepgramConfig { model: "flux-general-en".into(), ..DeepgramConfig::default() };
        provider.url_override = Some(format!("ws://{address}/v2/listen"));
        provider
    }

    /// Flux has no KeepAlive and needs audio to find a turn's end: while no
    /// audio is fed (idle loopback), silence goes out at about real-time pace.
    #[tokio::test]
    async fn flux_fills_gaps_with_silence_and_sends_no_keepalive() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (frames_tx, mut frames_rx) = mpsc::channel::<Message>(1024);
        let (uri_tx, uri_rx) = tokio::sync::oneshot::channel::<String>();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut uri_tx = Some(uri_tx);
            let callback = |req: &tokio_tungstenite::tungstenite::handshake::server::Request,
                            resp: tokio_tungstenite::tungstenite::handshake::server::Response| {
                if let Some(tx) = uri_tx.take() {
                    let _ = tx.send(req.uri().to_string());
                }
                Ok(resp)
            };
            let mut ws = tokio_tungstenite::accept_hdr_async(socket, callback).await.unwrap();
            while let Some(Ok(message)) = ws.next().await {
                if frames_tx.send(message).await.is_err() { return; }
            }
        });

        let mut provider = flux_provider(address);
        let (result_tx, _result_rx) = mpsc::channel(8);
        provider.start_stream(result_tx).await.unwrap();
        let uri = uri_rx.await.unwrap();
        assert!(uri.starts_with("/v2/listen?model=flux-general-en"), "unexpected URL {uri}");
        // Digital silence from capture isn't held back on Flux either.
        provider.feed_audio(chunk(0, 1_000)).await.unwrap();
        tokio::time::sleep(Duration::from_millis(1_200)).await;

        let (mut samples, mut texts) = (0usize, Vec::new());
        while let Ok(message) = frames_rx.try_recv() {
            match message {
                Message::Binary(bytes) => samples += bytes.len() / 2,
                Message::Text(text) => texts.push(text.to_string()),
                _ => {}
            }
        }
        assert!(texts.is_empty(), "Flux got text frames (KeepAlive?): {texts:?}");
        // 0.1 s fed, then ~1.1 s of gap filled (the first 150 ms of a gap stay empty).
        assert!((12_000..=22_000).contains(&samples), "{samples} samples in 1.2 s");
        provider.stop_stream().await.ok();
        server.abort();
    }

    /// Capture delivers 10 ms chunks, and Deepgram strongly recommends 80 ms
    /// frames for Flux. Audio left over goes out when it pauses or the stream closes.
    #[tokio::test]
    async fn flux_gets_capture_audio_in_80_ms_frames() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (frames_tx, mut frames_rx) = mpsc::channel::<Message>(1024);
        tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
            while let Some(Ok(message)) = ws.next().await {
                if frames_tx.send(message).await.is_err() { return; }
            }
        });
        let ten_ms = |value: i16| AudioChunk {
            pcm_data: vec![value; 160],
            source: crate::audio::AudioSource::Mic,
            timestamp_ms: 1_000,
            is_speech: true,
        };

        let mut provider = flux_provider(address);
        let (result_tx, _result_rx) = mpsc::channel(8);
        provider.start_stream(result_tx).await.unwrap();
        // 16 chunks: two whole frames. 3 more: a partial frame, sent once audio pauses.
        for _ in 0..19 {
            provider.feed_audio(ten_ms(500)).await.unwrap();
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
        let spoken = |frames: &mut mpsc::Receiver<Message>| -> Vec<usize> {
            std::iter::from_fn(|| frames.try_recv().ok())
                .filter_map(|m| match m {
                    Message::Binary(bytes) if bytes.iter().any(|b| *b != 0) => Some(bytes.len()),
                    _ => None,
                })
                .collect()
        };
        assert_eq!(spoken(&mut frames_rx), vec![2560, 2560, 960]);

        // Audio held when the stream closes still goes out, before CloseStream.
        for _ in 0..3 {
            provider.feed_audio(ten_ms(500)).await.unwrap();
        }
        provider.set_muted(true);
        let mut sent = Vec::new();
        while !sent.iter().any(|m| matches!(m, Message::Text(t) if t.contains("CloseStream"))) {
            sent.push(tokio::time::timeout(Duration::from_secs(2), frames_rx.recv()).await.unwrap().unwrap());
        }
        let held = sent.iter().position(|m| matches!(m, Message::Binary(b) if b.len() == 960 && b.iter().any(|x| *x != 0)));
        let close = sent.iter().position(|m| matches!(m, Message::Text(_)));
        assert!(held.is_some() && held < close, "the held audio wasn't sent before CloseStream");
        provider.stop_stream().await.unwrap();
    }

    /// Turn events come through with their signals, and on stop the turn
    /// still open (Flux sends no EndOfTurn after CloseStream) becomes a final.
    #[tokio::test]
    async fn flux_turns_carry_signals_and_stop_keeps_the_open_turn() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let turn_info = |event: &str, transcript: &str| {
            serde_json::json!({
                "type": "TurnInfo", "request_id": "r", "sequence_id": 1, "event": event, "turn_index": 0,
                "audio_window_start": 0.0, "audio_window_end": 1.0, "transcript": transcript,
                "words": [{"word": "w", "start": 0.0, "end": 0.6, "confidence": 0.95}],
                "end_of_turn_confidence": 0.5,
            })
            .to_string()
        };
        let messages = vec![
            serde_json::json!({"type": "Connected", "request_id": "r", "sequence_id": 0}).to_string(),
            turn_info("EagerEndOfTurn", "What now?"),
            turn_info("EndOfTurn", "What now?"),
            turn_info("Update", "And then"),
        ];
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
            for m in messages {
                ws.send(Message::Text(m.into())).await.unwrap();
            }
            // Close once the client asks to: like Flux, without an EndOfTurn.
            while let Some(Ok(message)) = ws.next().await {
                if let Message::Text(text) = message {
                    if text.contains("CloseStream") {
                        let _ = ws.close(None).await;
                        return;
                    }
                }
            }
        });

        let mut provider = flux_provider(address);
        let (result_tx, mut result_rx) = mpsc::channel(8);
        provider.start_stream(result_tx).await.unwrap();
        provider.feed_audio(chunk(500, 2_000)).await.unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        provider.stop_stream().await.unwrap();

        let mut got = Vec::new();
        while let Ok(r) = result_rx.try_recv() {
            got.push((r.text, r.is_final, r.turn));
        }
        assert_eq!(got, vec![
            ("What now?".to_string(), false, Some(TurnSignal::EagerEnd)),
            ("What now?".to_string(), true, Some(TurnSignal::End)),
            ("And then".to_string(), false, None),
            ("And then".to_string(), true, None),
        ]);
        server.abort();
    }

    /// A TurnInfo message as Flux sends it.
    fn flux_event(event: &str, transcript: &str) -> String {
        serde_json::json!({
            "type": "TurnInfo", "request_id": "r", "sequence_id": 1, "event": event, "turn_index": 0,
            "audio_window_start": 0.0, "audio_window_end": 1.0, "transcript": transcript,
            "words": [{"word": "w", "start": 0.0, "end": 0.6, "confidence": 0.95}],
            "end_of_turn_confidence": 0.5,
        })
        .to_string()
    }

    /// How the local stand-in for Flux behaves in each session.
    #[derive(Clone, Default)]
    struct FluxStandIn {
        /// Sent after a session's first non-silent audio: (event, transcript).
        reply: Option<(&'static str, &'static str)>,
        /// Sent 200 ms after CloseStream, before closing (Flux decoding the last audio).
        last_words: Option<&'static str>,
        /// Wait before completing each handshake.
        handshake_delay: Duration,
        /// Close a session that gets no audio for this long (Deepgram's idle timeout).
        idle_close: Option<Duration>,
    }

    struct FluxServer {
        address: std::net::SocketAddr,
        /// Sessions accepted.
        sessions: Arc<std::sync::atomic::AtomicUsize>,
        /// CloseStream messages received.
        closes: Arc<std::sync::atomic::AtomicUsize>,
        /// (session, first sample) of each non-silent audio frame.
        frames: mpsc::Receiver<(usize, i16)>,
    }

    async fn flux_server(stand_in: FluxStandIn) -> FluxServer {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let sessions = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let closes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (frames_tx, frames) = mpsc::channel(1024);
        let (counted, closed) = (Arc::clone(&sessions), Arc::clone(&closes));
        tokio::spawn(async move {
            loop {
                let (socket, _) = listener.accept().await.unwrap();
                let session = counted.fetch_add(1, Ordering::SeqCst) + 1;
                let (stand_in, frames_tx, closed) = (stand_in.clone(), frames_tx.clone(), Arc::clone(&closed));
                tokio::spawn(async move {
                    tokio::time::sleep(stand_in.handshake_delay).await;
                    let Ok(mut ws) = tokio_tungstenite::accept_async(socket).await else { return };
                    let mut replied = false;
                    loop {
                        let next = match stand_in.idle_close {
                            Some(idle) => match tokio::time::timeout(idle, ws.next()).await {
                                Ok(next) => next,
                                Err(_) => {
                                    let _ = ws.close(None).await;
                                    return;
                                }
                            },
                            None => ws.next().await,
                        };
                        match next {
                            Some(Ok(Message::Binary(bytes))) => {
                                if bytes.iter().all(|b| *b == 0) {
                                    continue;
                                }
                                let _ = frames_tx.send((session, i16::from_le_bytes([bytes[0], bytes[1]]))).await;
                                if let (false, Some((event, text))) = (replied, stand_in.reply) {
                                    replied = true;
                                    let _ = ws.send(Message::Text(flux_event(event, text).into())).await;
                                }
                            }
                            Some(Ok(Message::Text(text))) if text.contains("CloseStream") => {
                                closed.fetch_add(1, Ordering::SeqCst);
                                if let Some(text) = stand_in.last_words {
                                    tokio::time::sleep(Duration::from_millis(200)).await;
                                    let _ = ws.send(Message::Text(flux_event("Update", text).into())).await;
                                }
                                let _ = ws.close(None).await;
                                return;
                            }
                            Some(Ok(_)) => {}
                            _ => return,
                        }
                    }
                });
            }
        });
        FluxServer { address, sessions, closes, frames }
    }

    /// Results received so far: (text, is_final, turn).
    fn drain(rx: &mut mpsc::Receiver<TranscriptResult>) -> Vec<(String, bool, Option<TurnSignal>)> {
        std::iter::from_fn(|| rx.try_recv().ok()).map(|r| (r.text, r.is_final, r.turn)).collect()
    }

    /// Feeds chunks of `value` until the provider streams again (at most 5 s).
    async fn feed_until_streaming(provider: &mut DeepgramSTT, value: i16) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !provider.is_streaming && Instant::now() < deadline {
            provider.feed_audio(chunk(value, epoch_now_ms())).await.unwrap();
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(provider.is_streaming, "the stream didn't come back");
    }

    /// Muting Flux closes its stream, so no silence goes out while muted. The
    /// turn in progress still arrives as a final, and nothing reconnects.
    #[tokio::test]
    async fn muting_flux_closes_the_stream_and_keeps_the_turn_in_progress() {
        let mut server = flux_server(FluxStandIn { reply: Some(("Update", "said before mute")), ..Default::default() }).await;
        let mut provider = flux_provider(server.address);
        let (result_tx, mut result_rx) = mpsc::channel(8);
        provider.start_stream(result_tx).await.unwrap();
        provider.feed_audio(chunk(500, 1_000)).await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), server.frames.recv()).await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;

        provider.set_muted(true);
        assert!(!provider.is_streaming && provider.paused);
        for _ in 0..5 {
            provider.feed_audio(chunk(500, epoch_now_ms())).await.unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert_eq!(drain(&mut result_rx), vec![
            ("said before mute".to_string(), false, None),
            ("said before mute".to_string(), true, None),
        ]);
        assert_eq!(server.closes.load(Ordering::SeqCst), 1, "no CloseStream on mute");
        assert_eq!(server.sessions.load(Ordering::SeqCst), 1, "reconnected while muted");
        provider.stop_stream().await.unwrap();
    }

    /// Muted right before the meeting stops: the stop waits for the last words
    /// of the stream the mute closed.
    #[tokio::test]
    async fn stopping_just_after_a_flux_mute_keeps_the_last_words() {
        let server = flux_server(FluxStandIn { last_words: Some("last words"), ..Default::default() }).await;
        let mut provider = flux_provider(server.address);
        let (result_tx, mut result_rx) = mpsc::channel(8);
        provider.start_stream(result_tx).await.unwrap();
        provider.feed_audio(chunk(500, 1_000)).await.unwrap();
        provider.set_muted(true);
        provider.stop_stream().await.unwrap();
        assert_eq!(drain(&mut result_rx).last(), Some(&("last words".to_string(), true, None)));
    }

    /// Unmuting reconnects at once, and the first words, fed while Deepgram is
    /// still connecting, reach the new stream before later audio.
    #[tokio::test]
    async fn unmuting_flux_reconnects_and_sends_the_first_words_first() {
        let mut server = flux_server(FluxStandIn { handshake_delay: Duration::from_millis(150), ..Default::default() }).await;
        let mut provider = flux_provider(server.address);
        let (result_tx, _result_rx) = mpsc::channel(8);
        provider.start_stream(result_tx).await.unwrap();
        provider.set_muted(true);
        provider.set_muted(false);
        provider.feed_audio(chunk(3, 1_000)).await.unwrap();
        provider.feed_audio(chunk(4, 1_100)).await.unwrap();
        assert!(!provider.is_streaming, "connected before the handshake finished");
        feed_until_streaming(&mut provider, 5).await;

        let mut first = Vec::new();
        for _ in 0..2 {
            first.push(tokio::time::timeout(Duration::from_secs(2), server.frames.recv()).await.unwrap().unwrap());
        }
        assert_eq!(first, vec![(2, 3), (2, 4)]);
        provider.stop_stream().await.unwrap();
    }

    #[tokio::test]
    async fn flux_muted_at_start_connects_only_on_unmute() {
        let server = flux_server(FluxStandIn::default()).await;
        let mut provider = flux_provider(server.address);
        provider.set_muted(true);
        let (result_tx, _result_rx) = mpsc::channel(8);
        provider.start_stream(result_tx).await.unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(server.sessions.load(Ordering::SeqCst), 0, "connected while muted");

        provider.set_muted(false);
        feed_until_streaming(&mut provider, 7).await;
        assert_eq!(server.sessions.load(Ordering::SeqCst), 1);
        provider.stop_stream().await.unwrap();
    }

    /// Nova keeps its connection while muted, as before.
    #[tokio::test]
    async fn muting_nova_keeps_its_connection() {
        let server = flux_server(FluxStandIn::default()).await;
        let mut provider = DeepgramSTT::with_api_key("test");
        provider.url_override = Some(format!("ws://{}/v1/listen", server.address));
        let (result_tx, _result_rx) = mpsc::channel(8);
        provider.start_stream(result_tx).await.unwrap();
        provider.set_muted(true);
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(provider.is_streaming && !provider.paused);
        assert_eq!(server.closes.load(Ordering::SeqCst), 0);
        provider.set_muted(false);
        assert_eq!(server.sessions.load(Ordering::SeqCst), 1);
        provider.stop_stream().await.unwrap();
    }

    /// Fast mute/unmute toggling ends with one live stream: audio reaches
    /// only it, so a turn arrives once.
    #[tokio::test]
    async fn rapid_flux_mute_toggling_leaves_one_live_stream() {
        let mut server = flux_server(FluxStandIn { reply: Some(("EndOfTurn", "once")), ..Default::default() }).await;
        let mut provider = flux_provider(server.address);
        let (result_tx, mut result_rx) = mpsc::channel(64);
        provider.start_stream(result_tx).await.unwrap();
        for _ in 0..3 {
            provider.set_muted(true);
            provider.set_muted(false);
        }
        feed_until_streaming(&mut provider, 9).await;
        for _ in 0..20 {
            provider.feed_audio(chunk(9, epoch_now_ms())).await.unwrap();
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;

        let finals: Vec<_> = drain(&mut result_rx).into_iter().filter(|r| r.1).collect();
        assert_eq!(finals, vec![("once".to_string(), true, Some(TurnSignal::End))]);
        let streams: std::collections::HashSet<usize> =
            std::iter::from_fn(|| server.frames.try_recv().ok()).map(|(session, _)| session).collect();
        assert_eq!(streams.len(), 1, "audio reached more than one stream: {streams:?}");
        provider.stop_stream().await.unwrap();
    }

    /// Unmuted while no audio comes (idle loopback): the connection made then
    /// sits unused, and Deepgram closes it. When audio comes, a new connection
    /// is made, and it gets the first words.
    #[tokio::test]
    async fn an_unused_flux_connection_is_replaced_before_audio_goes_to_it() {
        let mut server = flux_server(FluxStandIn { idle_close: Some(Duration::from_secs(1)), ..Default::default() }).await;
        let mut provider = flux_provider(server.address);
        let (result_tx, _result_rx) = mpsc::channel(8);
        provider.start_stream(result_tx).await.unwrap();
        provider.set_muted(true);
        provider.set_muted(false);
        tokio::time::sleep(deepgram_flux::UNUSED_CONNECTION_MAX + Duration::from_millis(300)).await;
        assert_eq!(server.sessions.load(Ordering::SeqCst), 2);

        provider.feed_audio(chunk(9, epoch_now_ms())).await.unwrap();
        feed_until_streaming(&mut provider, 10).await;
        let first = tokio::time::timeout(Duration::from_secs(2), server.frames.recv()).await.unwrap().unwrap();
        assert_eq!(first, (3, 9), "the first words went to a closed connection");
        provider.stop_stream().await.unwrap();
    }

    /// Samples of a 16-bit PCM WAV file (its `data` chunk).
    fn wav_samples(wav: &[u8]) -> Vec<i16> {
        let mut pos = 12;
        while pos + 8 <= wav.len() {
            let size = u32::from_le_bytes(wav[pos + 4..pos + 8].try_into().unwrap()) as usize;
            if &wav[pos..pos + 4] == b"data" {
                let end = (pos + 8 + size).min(wav.len());
                return wav[pos + 8..end].chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect();
            }
            pos += 8 + size + (size & 1);
        }
        panic!("no data chunk in the WAV file");
    }

    /// Feeds `samples` in 100 ms chunks at real-time pace.
    async fn feed_clip(stt: &mut DeepgramSTT, samples: &[i16]) {
        for frame in samples.chunks(1600) {
            let chunk = AudioChunk {
                pcm_data: frame.to_vec(),
                source: crate::audio::AudioSource::System,
                timestamp_ms: epoch_now_ms(),
                is_speech: true,
            };
            stt.feed_audio(chunk).await.unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// Streams the test clip to the real Flux API at real-time pace, then
    /// 20 s with no audio fed (idle loopback: gap-filling silence only), then
    /// the clip again. Needs DEEPGRAM_API_KEY and DEEPGRAM_TEST_WAV (16 kHz mono
    /// 16-bit). Flux bills about 45 s of audio.
    #[tokio::test]
    #[ignore = "calls the Deepgram API; needs DEEPGRAM_API_KEY and DEEPGRAM_TEST_WAV"]
    async fn live_flux_detects_turns_and_survives_a_long_gap() {
        let key = std::env::var("DEEPGRAM_API_KEY").expect("DEEPGRAM_API_KEY");
        let wav = std::fs::read(std::env::var("DEEPGRAM_TEST_WAV").expect("DEEPGRAM_TEST_WAV")).unwrap();
        let samples = wav_samples(&wav);

        let mut stt = DeepgramSTT::with_api_key(&key);
        stt.config = DeepgramConfig { model: "flux-general-en".into(), ..DeepgramConfig::default() };
        let (tx, mut rx) = mpsc::channel(4096);
        stt.start_stream(tx).await.expect("start");
        feed_clip(&mut stt, &samples).await;
        tokio::time::sleep(Duration::from_secs(20)).await;
        assert!(stt.is_streaming, "Flux dropped the connection during the gap");
        feed_clip(&mut stt, &samples).await;
        tokio::time::sleep(Duration::from_secs(2)).await;
        stt.stop_stream().await.unwrap();

        let mut signals = std::collections::BTreeMap::new();
        let (mut interims, mut finals) = (0, Vec::new());
        while let Ok(result) = rx.try_recv() {
            if let Some(turn) = result.turn {
                *signals.entry(turn.as_str()).or_insert(0) += 1;
            }
            if result.is_final { finals.push(result) } else { interims += 1 }
        }
        println!("{} interims, {} finals, turn signals {:?}", interims, finals.len(), signals);
        for f in &finals {
            println!("final ({:?}): {:?} ms long, {} chars", f.turn, f.duration_ms, f.text.chars().count());
        }
        assert!(finals.iter().filter(|f| f.turn == Some(TurnSignal::End)).count() >= 2, "expected a turn end in each pass");
        let all = finals.iter().map(|f| f.text.to_lowercase()).collect::<Vec<_>>().join(" ");
        assert!(all.contains("meeting"), "unexpected transcript");
    }

    /// Mutes a real Flux stream 3 s into the test clip (mid-sentence): the
    /// stream closes and the sentence is kept as a final. After 5 s muted
    /// (nothing sent), unmute and stream the whole clip on a new connection.
    /// Needs DEEPGRAM_API_KEY and DEEPGRAM_TEST_WAV. Flux bills about 16 s of audio.
    #[tokio::test]
    #[ignore = "calls the Deepgram API; needs DEEPGRAM_API_KEY and DEEPGRAM_TEST_WAV"]
    async fn live_flux_mute_closes_the_stream_and_unmute_resumes() {
        let key = std::env::var("DEEPGRAM_API_KEY").expect("DEEPGRAM_API_KEY");
        let wav = std::fs::read(std::env::var("DEEPGRAM_TEST_WAV").expect("DEEPGRAM_TEST_WAV")).unwrap();
        let samples = wav_samples(&wav);

        let mut stt = DeepgramSTT::with_api_key(&key);
        stt.config = DeepgramConfig { model: "flux-general-en".into(), ..DeepgramConfig::default() };
        let (tx, mut rx) = mpsc::channel(4096);
        stt.start_stream(tx).await.expect("start");
        feed_clip(&mut stt, &samples[..3 * SAMPLE_RATE as usize]).await;
        stt.set_muted(true);
        assert!(!stt.is_streaming);
        let closed_at = Instant::now();
        let closing = stt.closing_reader.take().expect("no stream was closing");
        closing.await.unwrap();
        println!("closed stream ended {} ms after the mute", closed_at.elapsed().as_millis());
        tokio::time::sleep(Duration::from_secs(5)).await;
        let before_unmute = drain(&mut rx);

        stt.set_muted(false);
        let unmuted_at = Instant::now();
        feed_clip(&mut stt, &samples).await;
        assert!(stt.is_streaming, "no stream after the unmute");
        tokio::time::sleep(Duration::from_secs(2)).await;
        stt.stop_stream().await.unwrap();
        let after_unmute = drain(&mut rx);

        let finals = |results: &[(String, bool, Option<TurnSignal>)]| {
            results.iter().filter(|r| r.1).map(|r| (r.2, r.0.chars().count())).collect::<Vec<_>>()
        };
        println!("before unmute: {} results, finals (signal, chars) {:?}", before_unmute.len(), finals(&before_unmute));
        println!("after unmute ({} ms of clip fed): {} results, finals {:?}",
            unmuted_at.elapsed().as_millis(), after_unmute.len(), finals(&after_unmute));
        assert!(before_unmute.iter().any(|r| r.1 && r.2.is_none()), "the sentence cut by the mute wasn't kept");
        assert!(after_unmute.iter().filter(|r| r.1 && r.2 == Some(TurnSignal::End)).count() >= 2, "expected both turns after the unmute");
        let all = after_unmute.iter().filter(|r| r.1).map(|r| r.0.to_lowercase()).collect::<Vec<_>>().join(" ");
        assert!(all.contains("meeting"), "unexpected transcript");
    }
}
