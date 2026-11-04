// Cartesia Realtime STT (Auto): WebSocket streaming with built-in turn detection
//
// Connects to wss://api.cartesia.ai/stt/turns/websocket (model ink-2) and sends
// 16 kHz mono PCM as binary frames. Cartesia decides where each speaker turn
// starts and ends, and reports it as events:
// - turn.update / turn.eager_end carry the turn so far (cumulative, never
//   revised) and become interim results
// - turn.end carries the finished turn and becomes the final result
// - turn.eager_end, turn.resume and turn.end are passed on as turn signals
//   (EagerEnd, Resumed, End), so Auto-Answer can answer without waiting
// Cartesia sends no word timestamps, so a turn is stamped with the time its
// turn.start arrived.
//
// - API key in the X-API-Key handshake header, never in the URL
// - Gaps are filled with silence: Cartesia waits for audio instead of assuming
//   silence, and idle system loopback sends none
// - Muting a party closes its stream, so muted time isn't billed; unmuting
//   reconnects at once and sends the audio held meanwhile (at most 1 s) first
// - Background reconnect (1, 2, 4, 8, then every 15 s) that never blocks the
//   audio loop; audio captured while offline is dropped, since Cartesia takes
//   audio no faster than real time and a backlog could never catch up
// - Stop sends {"type":"close"}; Cartesia finishes the last turn and closes
// - A connection that ends mid-turn keeps the turn's latest text as a final
// - Status events on `stt_connection_status`, like Deepgram

use async_trait::async_trait;
use futures::stream::SplitSink;
use futures::{FutureExt, SinkExt, StreamExt};
use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::sync::mpsc::error::TrySendError;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::audio::AudioChunk;
use crate::stt::deepgram::ConnectionStatusEvent;
use crate::stt::provider::{STTProvider, STTProviderType, TranscriptResult, TurnSignal};

type CartesiaSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Cartesia model used for realtime transcription with turn detection.
const MODEL: &str = "ink-2";

/// Cartesia API version sent as the `cartesia_version` query parameter.
const API_VERSION: &str = "2026-08-14";

/// Realtime STT (Auto) endpoint, without query parameters.
const DEFAULT_WS_URL: &str = "wss://api.cartesia.ai/stt/turns/websocket";

/// Sample rate of the audio sent to Cartesia (`sample_rate=16000`, mono).
const SAMPLE_RATE: u32 = 16_000;

/// Languages ink-2 detects on its own (ISO 639-1). There is no language parameter.
pub const SUPPORTED_LANGUAGES: [&str; 5] = ["en", "fr", "hi", "ja", "es"];

/// How long a connection attempt (handshake, or waiting for `connected`) may take.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// How long stop_stream waits for Cartesia's last turn after the close command.
const FINAL_RESULTS_WAIT: Duration = Duration::from_secs(5);

/// Audio chunks queued for the writer (capture sends one per ~10 ms callback).
const AUDIO_QUEUE_CHUNKS: usize = 512;

/// Silence fills a gap once nothing has been sent for this long (150 ms).
/// Capture delivers a chunk every ~10 ms, so real audio never trips it.
const GAP_BEFORE_SILENCE: Duration = Duration::from_millis(150);

/// How often the writer looks for a gap (100 ms).
const GAP_CHECK_INTERVAL: Duration = Duration::from_millis(100);

/// The most silence sent in one frame (1 s), so a delayed writer doesn't burst.
const MAX_SILENCE_FILL: Duration = Duration::from_secs(1);

/// Audio dropped in a row for lack of queue room before the connection counts
/// as stalled and is replaced (5 s at 16 kHz).
const STALLED_SAMPLES: usize = 5 * SAMPLE_RATE as usize;

/// Cartesia error codes that a reconnect can't fix (rejected key, account).
const FATAL_STATUS_CODES: [u16; 3] = [401, 402, 403];

/// Most audio held while reconnecting after an unmute (1 s at 16 kHz).
const RESUME_HOLD_SAMPLES: usize = SAMPLE_RATE as usize;

/// Hold audio fed while reconnecting after an unmute, keeping the newest
/// RESUME_HOLD_SAMPLES.
fn hold_for_resume(held: &mut Vec<i16>, samples: &[i16]) {
    held.extend_from_slice(samples);
    if held.len() > RESUME_HOLD_SAMPLES {
        let excess = held.len() - RESUME_HOLD_SAMPLES;
        held.drain(..excess);
    }
}

/// Delay before reconnect attempt `attempt` (1-based): 1, 2, 4, 8, then every 15 s.
fn reconnect_backoff(attempt: u32) -> Duration {
    match attempt {
        0..=4 => Duration::from_secs(1 << attempt.saturating_sub(1)),
        _ => Duration::from_secs(15),
    }
}

/// Samples of silence to send after `idle` with nothing sent: none for the
/// pause between capture chunks, otherwise the time that passed (at most 1 s),
/// which keeps Cartesia's audio clock in step with real time.
fn silence_samples_for(idle: Duration) -> usize {
    if idle < GAP_BEFORE_SILENCE {
        return 0;
    }
    idle.min(MAX_SILENCE_FILL).as_millis() as usize * SAMPLE_RATE as usize / 1000
}

/// Why a connection attempt failed.
#[derive(Debug)]
enum ConnectError {
    /// Cartesia rejected the key (HTTP 401/403): retrying won't help.
    Auth(String),
    Other(String),
}

impl std::fmt::Display for ConnectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConnectError::Auth(msg) | ConnectError::Other(msg) => f.write_str(msg),
        }
    }
}

impl std::error::Error for ConnectError {}

/// A message from Cartesia. Every message also carries `request_id`.
#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "type")]
enum ServerEvent {
    #[serde(rename = "connected")]
    Connected {
        #[serde(default)]
        request_id: String,
    },
    #[serde(rename = "turn.start")]
    TurnStart {},
    #[serde(rename = "turn.update")]
    TurnUpdate { transcript: String },
    #[serde(rename = "turn.eager_end")]
    TurnEagerEnd { transcript: String },
    #[serde(rename = "turn.resume")]
    TurnResume {},
    #[serde(rename = "turn.end")]
    TurnEnd { transcript: String },
    #[serde(rename = "error")]
    Error {
        #[serde(default)]
        status_code: Option<u16>,
        #[serde(default)]
        title: String,
        #[serde(default)]
        message: String,
    },
    #[serde(other)]
    Unknown,
}

impl ServerEvent {
    /// Parse a text frame; `None` when it isn't valid JSON or lacks a `type`.
    fn parse(text: &str) -> Option<Self> {
        serde_json::from_str(text).ok()
    }
}

/// Turns Cartesia's turn events into transcript results for one party.
struct TurnTracker {
    party: String,
    /// Epoch ms when the open turn started; `None` between turns.
    turn_start_ms: Option<u64>,
    /// Latest cumulative text of the open turn.
    turn_text: String,
}

impl TurnTracker {
    fn new(party: &str) -> Self {
        Self {
            party: party.to_string(),
            turn_start_ms: None,
            turn_text: String::new(),
        }
    }

    /// The result for `event` received at `now_ms`, if it carries one.
    fn on_event(&mut self, event: &ServerEvent, now_ms: u64) -> Option<TranscriptResult> {
        match event {
            ServerEvent::TurnStart {} => {
                self.turn_start_ms = Some(now_ms);
                self.turn_text.clear();
                None
            }
            ServerEvent::TurnUpdate { transcript } | ServerEvent::TurnEagerEnd { transcript } => {
                let start = *self.turn_start_ms.get_or_insert(now_ms);
                self.turn_text = transcript.trim().to_string();
                if self.turn_text.is_empty() {
                    return None;
                }
                let turn = matches!(event, ServerEvent::TurnEagerEnd { .. }).then_some(TurnSignal::EagerEnd);
                Some(self.result(self.turn_text.clone(), false, start, None, turn))
            }
            // Carries no text: the turn's latest text goes out again, marked.
            ServerEvent::TurnResume {} => {
                if self.turn_text.is_empty() {
                    return None;
                }
                let start = *self.turn_start_ms.get_or_insert(now_ms);
                Some(self.result(self.turn_text.clone(), false, start, None, Some(TurnSignal::Resumed)))
            }
            ServerEvent::TurnEnd { transcript } => {
                let start = self.turn_start_ms.take().unwrap_or(now_ms);
                self.turn_text.clear();
                let text = transcript.trim();
                if text.is_empty() {
                    return None;
                }
                let duration = Some(now_ms.saturating_sub(start));
                Some(self.result(text.to_string(), true, start, duration, Some(TurnSignal::End)))
            }
            _ => None,
        }
    }

    /// The open turn's latest text as a final, for when the connection ends
    /// before its turn.end. Clears the turn, so it is only reported once.
    /// Cartesia never said the speaker finished, so it carries no turn signal.
    fn finish_open_turn(&mut self, now_ms: u64) -> Option<TranscriptResult> {
        let start = self.turn_start_ms.take()?;
        let text = std::mem::take(&mut self.turn_text);
        if text.is_empty() {
            return None;
        }
        Some(self.result(text, true, start, Some(now_ms.saturating_sub(start)), None))
    }

    fn result(
        &self,
        text: String,
        is_final: bool,
        start_ms: u64,
        duration_ms: Option<u64>,
        turn: Option<TurnSignal>,
    ) -> TranscriptResult {
        TranscriptResult {
            text,
            is_final,
            // Cartesia reports no confidence; its text is never revised.
            confidence: 1.0,
            timestamp_ms: start_ms,
            speaker: Some(self.party.clone()),
            language: None,
            segment_id: None,
            duration_ms,
            speaker_tag: None,
            turn,
        }
    }
}

/// The endpoint URL with every required query parameter. The API key goes in
/// the `X-API-Key` header, never in the URL.
fn build_ws_url(base_url: &str) -> String {
    format!(
        "{}?model={}&encoding=pcm_s16le&sample_rate={}&cartesia_version={}",
        base_url, MODEL, SAMPLE_RATE, API_VERSION
    )
}

/// 16-bit samples as little-endian bytes (`pcm_s16le`).
fn pcm_to_bytes(samples: &[i16]) -> Vec<u8> {
    samples.iter().flat_map(|s| s.to_le_bytes()).collect()
}

fn epoch_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Cartesia ink-2 streaming STT for one party.
pub struct CartesiaSTT {
    api_key: String,
    /// The app's STT language. ink-2 detects the language itself; this is
    /// only checked against SUPPORTED_LANGUAGES for a warning.
    language: String,
    /// Speaker label for results ("You" or "Them").
    party: String,
    app_handle: Option<tauri::AppHandle>,
    /// Endpoint without query parameters (tests point it at a local server).
    base_url: String,
    audio_tx: Option<mpsc::Sender<Vec<u8>>>,
    result_tx: Option<mpsc::Sender<TranscriptResult>>,
    reader_task: Option<tokio::task::JoinHandle<()>>,
    /// Shared with the reader, so stop_stream can report an open turn the
    /// reader never got to.
    turns: Arc<Mutex<TurnTracker>>,
    is_streaming: bool,
    /// Set by the reader when Cartesia reports an error a reconnect can't fix.
    fatal_error: Arc<AtomicBool>,
    /// Cartesia rejected the key or account: no reconnects until the next start.
    reconnect_blocked: bool,
    /// Background connection attempt while offline.
    reconnect_task: Option<tokio::task::JoinHandle<Result<CartesiaSocket, ConnectError>>>,
    reconnect_attempt: u32,
    next_reconnect_at: Option<Instant>,
    /// Audio chunks dropped because the writer fell behind.
    dropped_chunks: u64,
    /// Samples dropped in a row for lack of queue room.
    dropped_samples_streak: usize,
    /// The party is muted: no stream is open, so nothing is sent or billed.
    paused: bool,
    /// Set by an unmute until the new stream is ready; audio fed meanwhile is held.
    resuming_since: Option<Instant>,
    /// Audio held while reconnecting after an unmute, sent before live audio.
    resume_hold: Vec<i16>,
}

impl CartesiaSTT {
    pub fn new() -> Self {
        Self {
            api_key: String::new(),
            language: "en".to_string(),
            party: "Them".to_string(),
            app_handle: None,
            base_url: DEFAULT_WS_URL.to_string(),
            audio_tx: None,
            result_tx: None,
            reader_task: None,
            turns: Arc::new(Mutex::new(TurnTracker::new("Them"))),
            is_streaming: false,
            fatal_error: Arc::new(AtomicBool::new(false)),
            reconnect_blocked: false,
            reconnect_task: None,
            reconnect_attempt: 0,
            next_reconnect_at: None,
            dropped_chunks: 0,
            dropped_samples_streak: 0,
            paused: false,
            resuming_since: None,
            resume_hold: Vec::new(),
        }
    }

    pub fn with_api_key(api_key: &str) -> Self {
        let mut stt = Self::new();
        stt.set_api_key(api_key);
        stt
    }

    pub fn set_api_key(&mut self, api_key: &str) {
        self.api_key = api_key.trim().to_string();
    }

    /// Set the party label ("You" or "Them") used as the result speaker.
    pub fn set_party(&mut self, party: &str) {
        self.party = party.to_string();
    }

    pub fn set_app_handle(&mut self, handle: tauri::AppHandle) {
        self.app_handle = Some(handle);
    }

    #[cfg(test)]
    fn for_endpoint(api_key: &str, base_url: &str) -> Self {
        let mut stt = Self::with_api_key(api_key);
        stt.base_url = base_url.to_string();
        stt
    }

    fn emit_status(&self, status: &str, message: Option<String>) {
        if let Some(ref handle) = self.app_handle {
            let event = ConnectionStatusEvent {
                provider: "cartesia".to_string(),
                party: self.party.clone(),
                status: status.to_string(),
                message,
            };
            if let Err(e) = tauri::Emitter::emit(handle, "stt_connection_status", &event) {
                log::warn!("CartesiaSTT: Failed to emit status event: {}", e);
            }
        }
    }

    /// Open the WebSocket with the key in the `X-API-Key` header.
    async fn connect(api_key: &str, url: &str) -> Result<CartesiaSocket, ConnectError> {
        let mut request = url
            .into_client_request()
            .map_err(|e| ConnectError::Other(format!("Invalid Cartesia URL: {}", e)))?;
        let key = HeaderValue::from_str(api_key)
            .map_err(|_| ConnectError::Auth("The Cartesia API key contains invalid characters".to_string()))?;
        request.headers_mut().insert("X-API-Key", key);

        match tokio::time::timeout(CONNECT_TIMEOUT, tokio_tungstenite::connect_async(request)).await {
            Err(_) => Err(ConnectError::Other("Cartesia didn't answer within 10 s".to_string())),
            Ok(Ok((socket, _response))) => Ok(socket),
            Ok(Err(tokio_tungstenite::tungstenite::Error::Http(response))) => {
                let code = response.status().as_u16();
                if code == 401 || code == 403 {
                    Err(ConnectError::Auth(format!("Cartesia rejected the API key (HTTP {})", code)))
                } else {
                    Err(ConnectError::Other(format!("Cartesia refused the connection (HTTP {})", code)))
                }
            }
            Ok(Err(e)) => Err(ConnectError::Other(format!("Couldn't connect to Cartesia: {}", e))),
        }
    }

    /// Start the reader and writer tasks for a connected socket.
    fn install_session(&mut self, socket: CartesiaSocket, result_tx: mpsc::Sender<TranscriptResult>) {
        let (write_half, read_half) = socket.split();
        let (audio_tx, audio_rx) = mpsc::channel::<Vec<u8>>(AUDIO_QUEUE_CHUNKS);
        self.turns = Arc::new(Mutex::new(TurnTracker::new(&self.party)));
        self.fatal_error = Arc::new(AtomicBool::new(false));
        self.audio_tx = Some(audio_tx);
        self.result_tx = Some(result_tx.clone());
        self.reader_task = Some(spawn_reader_task(
            read_half,
            result_tx,
            Arc::clone(&self.turns),
            Arc::clone(&self.fatal_error),
            self.party.clone(),
            self.app_handle.clone(),
        ));
        spawn_writer_task(write_half, audio_rx, self.party.clone());
        self.is_streaming = true;
        self.reconnect_attempt = 0;
        self.next_reconnect_at = None;
        self.dropped_chunks = 0;
        self.dropped_samples_streak = 0;
        self.emit_status("connected", None);
    }

    /// The open turn's latest text as a final, for when the reader can't send it.
    fn take_open_turn(&self) -> Option<TranscriptResult> {
        self.turns
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .finish_open_turn(epoch_now_ms())
    }

    /// Muted: close the stream so nothing is sent or billed. Cartesia still
    /// sends the turn in progress (the reader delivers it), and nothing
    /// reconnects until unmute.
    fn pause(&mut self) {
        self.paused = true;
        self.resuming_since = None;
        self.resume_hold.clear();
        if let Some(task) = self.reconnect_task.take() {
            task.abort();
        }
        self.next_reconnect_at = None;
        if self.is_streaming {
            // Dropping the audio sender makes the writer send the close command.
            self.audio_tx = None;
            self.is_streaming = false;
            log::info!("CartesiaSTT: paused ({}): stream closed while muted", self.party);
        } else {
            log::info!("CartesiaSTT: paused ({}) while not connected", self.party);
        }
        self.emit_status("paused", Some("Muted: not streaming to Cartesia".to_string()));
    }

    /// Unmuted: reconnect right away. Audio fed until the stream is ready is
    /// held (at most 1 s) and sent first, so the first words aren't lost.
    fn resume(&mut self) {
        self.paused = false;
        // Not started, already stopped, or the key was refused.
        if self.result_tx.is_none() || self.reconnect_blocked {
            return;
        }
        self.resuming_since = Some(Instant::now());
        self.reconnect_attempt = 0;
        self.next_reconnect_at = None;
        self.drive_reconnect();
    }

    /// After an unmute, send the audio held while reconnecting before live audio.
    fn flush_resume_hold(&mut self) {
        let Some(since) = self.resuming_since.take() else { return };
        let held = std::mem::take(&mut self.resume_hold);
        if let Some(audio_tx) = self.audio_tx.as_ref() {
            for frame in held.chunks(SAMPLE_RATE as usize / 10) {
                let _ = audio_tx.try_send(pcm_to_bytes(frame));
            }
        }
        log::info!(
            "CartesiaSTT: resumed ({}): connected in {} ms, sent {} ms of held audio",
            self.party,
            since.elapsed().as_millis(),
            held.len() * 1000 / SAMPLE_RATE as usize
        );
    }

    /// The reader or the writer has stopped: the connection is gone.
    fn session_ended(&self) -> bool {
        self.reader_task.as_ref().map_or(true, |t| t.is_finished())
            || self.audio_tx.as_ref().map_or(true, |tx| tx.is_closed())
    }

    /// Drop the dead connection, keep its open turn, and reconnect from
    /// feed_audio unless Cartesia refused the key or account.
    fn mark_disconnected(&mut self) {
        self.is_streaming = false;
        self.audio_tx = None;
        if let Some(reader) = self.reader_task.take() {
            reader.abort();
        }
        if let (Some(last), Some(tx)) = (self.take_open_turn(), self.result_tx.as_ref()) {
            let _ = tx.try_send(last);
        }
        if self.fatal_error.load(Ordering::SeqCst) {
            log::warn!("CartesiaSTT: Cartesia refused the session ({}); not reconnecting", self.party);
            self.reconnect_blocked = true;
            self.emit_status("error", Some("Cartesia refused the API key or account — check it in Settings → STT".to_string()));
            return;
        }
        log::warn!("CartesiaSTT: connection lost ({}), reconnecting in the background", self.party);
        self.reconnect_attempt = 0;
        self.next_reconnect_at = None;
        self.emit_status("reconnecting", Some("Connection lost — reconnecting".to_string()));
    }

    /// Advance the background reconnect without waiting: pick up a finished
    /// attempt, or start the next one once its backoff has passed.
    fn drive_reconnect(&mut self) {
        if self.reconnect_blocked {
            return;
        }
        let Some(result_tx) = self.result_tx.clone() else { return };
        if let Some(task) = self.reconnect_task.as_ref() {
            if !task.is_finished() {
                return;
            }
            // Unconstrained: with the task's coop budget used up, polling a
            // finished JoinHandle can still return Pending (and drop the socket).
            match self.reconnect_task.take().and_then(|t| tokio::task::unconstrained(t).now_or_never()) {
                Some(Ok(Ok(socket))) => {
                    log::info!("CartesiaSTT: reconnected ({}) after {} attempt(s)", self.party, self.reconnect_attempt + 1);
                    self.install_session(socket, result_tx);
                    return;
                }
                Some(Ok(Err(ConnectError::Auth(msg)))) => {
                    log::warn!("CartesiaSTT: {} ({}); not reconnecting", msg, self.party);
                    self.reconnect_blocked = true;
                    self.emit_status("error", Some(msg));
                    return;
                }
                Some(Ok(Err(e))) => log::warn!("CartesiaSTT: reconnect failed ({}): {}", self.party, e),
                Some(Err(e)) => log::warn!("CartesiaSTT: reconnect task ended ({}): {}", self.party, e),
                None => log::warn!("CartesiaSTT: reconnect result unavailable ({})", self.party),
            }
            self.reconnect_attempt += 1;
            let wait = reconnect_backoff(self.reconnect_attempt);
            self.next_reconnect_at = Some(Instant::now() + wait);
            self.emit_status("reconnecting",
                Some(format!("Reconnect attempt {} failed, retrying in {} s", self.reconnect_attempt, wait.as_secs())));
            return;
        }
        if self.next_reconnect_at.is_some_and(|at| Instant::now() < at) {
            return;
        }
        let (key, url) = (self.api_key.clone(), build_ws_url(&self.base_url));
        self.reconnect_task = Some(tokio::spawn(async move { Self::connect(&key, &url).await }));
    }
}

/// Read Cartesia's events and send the results. When the socket ends with a
/// turn still open, its latest text is sent as a final.
fn spawn_reader_task(
    mut read_half: futures::stream::SplitStream<CartesiaSocket>,
    result_tx: mpsc::Sender<TranscriptResult>,
    turns: Arc<Mutex<TurnTracker>>,
    fatal_error: Arc<AtomicBool>,
    party: String,
    app_handle: Option<tauri::AppHandle>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(message) = read_half.next().await {
            match message {
                Ok(Message::Text(text)) => {
                    let Some(event) = ServerEvent::parse(&text) else {
                        log::debug!("CartesiaSTT: ignored a message that isn't an event ({} bytes)", text.len());
                        continue;
                    };
                    match &event {
                        ServerEvent::Connected { request_id } => {
                            log::info!("CartesiaSTT: session ready ({}), request_id={}", party, request_id);
                        }
                        ServerEvent::Error { status_code, title, message } => {
                            log::warn!("CartesiaSTT: error from Cartesia ({}): {:?} {}: {}", party, status_code, title, message);
                            if status_code.is_some_and(|c| FATAL_STATUS_CODES.contains(&c)) {
                                fatal_error.store(true, Ordering::SeqCst);
                            }
                            if let Some(ref handle) = app_handle {
                                let event = ConnectionStatusEvent {
                                    provider: "cartesia".to_string(),
                                    party: party.clone(),
                                    status: "error".to_string(),
                                    message: Some(format!("{}: {}", title, message)),
                                };
                                let _ = tauri::Emitter::emit(handle, "stt_connection_status", &event);
                            }
                        }
                        _ => {}
                    }
                    let result = turns
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .on_event(&event, epoch_now_ms());
                    if let Some(result) = result {
                        if result.is_final {
                            log::debug!("CartesiaSTT: final turn ({}, {} chars)", party, result.text.len());
                        }
                        if result_tx.send(result).await.is_err() {
                            log::warn!("CartesiaSTT: result channel closed");
                            return;
                        }
                    }
                }
                Ok(Message::Close(frame)) => {
                    log::info!("CartesiaSTT: closed by Cartesia ({}): {:?}", party, frame.map(|f| f.code));
                    break;
                }
                Err(e) => {
                    log::warn!("CartesiaSTT: read error ({}): {}", party, e);
                    break;
                }
                _ => {}
            }
        }
        let last = turns
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .finish_open_turn(epoch_now_ms());
        if let Some(result) = last {
            log::info!("CartesiaSTT: connection ended mid-turn ({}); kept the turn's latest text", party);
            let _ = result_tx.send(result).await;
        }
        log::info!("CartesiaSTT: reader exiting ({})", party);
    })
}

/// Send audio as binary frames, filling gaps with silence so Cartesia's turn
/// detection keeps running while no audio arrives. When the audio channel
/// closes, send the close command; Cartesia then sends the last events and
/// closes the socket itself.
fn spawn_writer_task(
    mut write_half: SplitSink<CartesiaSocket, Message>,
    mut audio_rx: mpsc::Receiver<Vec<u8>>,
    party: String,
) {
    tokio::spawn(async move {
        let mut gap_check = tokio::time::interval(GAP_CHECK_INTERVAL);
        gap_check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut last_sent = Instant::now();
        let mut silence_samples: usize = 0;
        loop {
            let frame = tokio::select! {
                audio = audio_rx.recv() => match audio {
                    Some(frame) => frame,
                    None => break,
                },
                _ = gap_check.tick() => {
                    let samples = silence_samples_for(last_sent.elapsed());
                    if samples == 0 {
                        continue;
                    }
                    silence_samples += samples;
                    vec![0u8; samples * 2]
                }
            };
            if let Err(e) = write_half.send(Message::Binary(frame.into())).await {
                log::warn!("CartesiaSTT: write error ({}): {}", party, e);
                return;
            }
            last_sent = Instant::now();
        }
        let close = serde_json::json!({"type": "close"}).to_string();
        if let Err(e) = write_half.send(Message::Text(close.into())).await {
            log::warn!("CartesiaSTT: couldn't send the close command ({}): {}", party, e);
        }
        log::info!(
            "CartesiaSTT: writer exiting ({}); {:.1} s of silence filled in gaps",
            party,
            silence_samples as f64 / SAMPLE_RATE as f64
        );
    });
}

#[async_trait]
impl STTProvider for CartesiaSTT {
    fn provider_name(&self) -> &str {
        "Cartesia"
    }

    fn provider_type(&self) -> STTProviderType {
        STTProviderType::Cartesia
    }

    async fn start_stream(
        &mut self,
        result_tx: mpsc::Sender<TranscriptResult>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if self.is_streaming {
            return Err("Stream already active".into());
        }
        if self.api_key.is_empty() {
            return Err("Cartesia API key not configured. Add it in Settings → STT.".into());
        }
        if let Some(task) = self.reconnect_task.take() {
            task.abort();
        }
        self.reconnect_blocked = false;
        if self.paused {
            // Muted from the start: connect on the first unmute, not now.
            self.result_tx = Some(result_tx);
            log::info!("CartesiaSTT: muted at start ({}); connecting on unmute", self.party);
            self.emit_status("paused", Some("Muted: not streaming to Cartesia".to_string()));
            return Ok(());
        }

        log::info!(
            "CartesiaSTT: connecting ({}, model {}, app language {}; ink-2 detects the language itself)",
            self.party, MODEL, self.language
        );
        self.emit_status("connecting", None);
        match Self::connect(&self.api_key, &build_ws_url(&self.base_url)).await {
            Ok(socket) => {
                self.install_session(socket, result_tx);
                log::info!("CartesiaSTT: stream started ({})", self.party);
                Ok(())
            }
            Err(ConnectError::Auth(msg)) => {
                self.emit_status("error", Some(msg.clone()));
                Err(msg.into())
            }
            Err(e) => {
                // Network trouble at the start: keep the party and connect in
                // the background instead of losing it for the whole meeting.
                log::warn!("CartesiaSTT: couldn't connect ({}): {}; retrying in the background", self.party, e);
                self.result_tx = Some(result_tx);
                self.reconnect_attempt = 1;
                self.next_reconnect_at = Some(Instant::now() + reconnect_backoff(1));
                self.emit_status("reconnecting", Some(e.to_string()));
                Ok(())
            }
        }
    }

    async fn feed_audio(
        &mut self,
        chunk: AudioChunk,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // Not started, or already stopped.
        if self.result_tx.is_none() || chunk.pcm_data.is_empty() {
            return Ok(());
        }
        // Muted: nothing goes to Cartesia (the audio loop doesn't feed a muted party anyway).
        if self.paused {
            return Ok(());
        }
        if self.is_streaming && self.session_ended() {
            self.mark_disconnected();
        }
        // Offline: advance the reconnect, never waiting. Right after an unmute
        // the audio is held for the new stream; after a lost connection it's
        // dropped, since a backlog could never catch up.
        if !self.is_streaming {
            self.drive_reconnect();
            if !self.is_streaming {
                if self.resuming_since.is_some() {
                    hold_for_resume(&mut self.resume_hold, &chunk.pcm_data);
                }
                return Ok(());
            }
        }
        self.flush_resume_hold();
        let Some(audio_tx) = self.audio_tx.as_ref() else {
            return Ok(());
        };
        // Never wait here: the audio loop also serves the other party and the recording.
        let samples = chunk.pcm_data.len();
        match audio_tx.try_send(pcm_to_bytes(&chunk.pcm_data)) {
            Ok(()) => self.dropped_samples_streak = 0,
            Err(TrySendError::Full(_)) => {
                self.dropped_chunks += 1;
                self.dropped_samples_streak += samples;
                if self.dropped_chunks.is_power_of_two() {
                    log::warn!("CartesiaSTT: sending is behind ({}); {} audio chunks dropped", self.party, self.dropped_chunks);
                }
                // The writer stopped taking audio (half-open socket): replace the connection.
                if self.dropped_samples_streak > STALLED_SAMPLES {
                    log::warn!("CartesiaSTT: writer stalled for 5 s of audio ({})", self.party);
                    self.mark_disconnected();
                }
            }
            Err(TrySendError::Closed(_)) => self.mark_disconnected(),
        }
        Ok(())
    }

    async fn stop_stream(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // Offline at the end: no reconnect after the meeting stopped.
        if let Some(task) = self.reconnect_task.take() {
            task.abort();
        }
        self.next_reconnect_at = None;
        self.resuming_since = None;
        self.resume_hold.clear();
        // Dropping the audio sender makes the writer send the close command.
        self.audio_tx = None;
        if let Some(reader) = self.reader_task.take() {
            let abort = reader.abort_handle();
            if tokio::time::timeout(FINAL_RESULTS_WAIT, reader).await.is_err() {
                log::warn!("CartesiaSTT: Cartesia didn't close within 5 s ({}); keeping the open turn as it is", self.party);
                abort.abort();
                if let (Some(last), Some(tx)) = (self.take_open_turn(), self.result_tx.as_ref()) {
                    let _ = tx.send(last).await;
                }
            }
        }
        self.result_tx = None;
        self.is_streaming = false;
        self.emit_status("disconnected", None);
        log::info!("CartesiaSTT: stream stopped ({})", self.party);
        Ok(())
    }

    async fn test_connection(&self) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        if self.api_key.is_empty() {
            return Err("No Cartesia API key configured".into());
        }
        let mut socket = Self::connect(&self.api_key, &build_ws_url(&self.base_url)).await?;
        // Wait for `connected` without sending audio, so the test costs nothing.
        let outcome = tokio::time::timeout(CONNECT_TIMEOUT, async {
            while let Some(message) = socket.next().await {
                match message {
                    Ok(Message::Text(text)) => match ServerEvent::parse(&text) {
                        Some(ServerEvent::Connected { .. }) => return Ok(()),
                        Some(ServerEvent::Error { title, message, .. }) => {
                            return Err(format!("Cartesia: {}: {}", title, message));
                        }
                        _ => {}
                    },
                    Ok(Message::Close(_)) => break,
                    Err(e) => return Err(format!("Cartesia connection failed: {}", e)),
                    _ => {}
                }
            }
            Err("Cartesia closed the connection".to_string())
        })
        .await;
        let _ = socket.close(None).await;
        match outcome {
            Ok(Ok(())) => {
                log::info!("CartesiaSTT: connection test passed");
                Ok(true)
            }
            Ok(Err(e)) => Err(e.into()),
            Err(_) => Err("Cartesia didn't confirm the session within 10 s".into()),
        }
    }

    fn set_language(&mut self, language: &str) {
        self.language = language.to_string();
        let base = language.split(['-', '_']).next().unwrap_or("").to_lowercase();
        if !SUPPORTED_LANGUAGES.contains(&base.as_str()) {
            log::warn!(
                "CartesiaSTT: ink-2 transcribes English, French, Hindi, Japanese and Spanish; '{}' isn't one of them",
                language
            );
        }
    }

    fn set_muted(&mut self, muted: bool) {
        if muted == self.paused {
            return;
        }
        if muted {
            self.pause();
        } else {
            self.resume();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::AudioSource;
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
    use tokio_tungstenite::tungstenite::http::StatusCode;

    fn event(json: &str) -> ServerEvent {
        ServerEvent::parse(json).expect("valid event")
    }

    fn chunk(samples: Vec<i16>) -> AudioChunk {
        AudioChunk { pcm_data: samples, source: AudioSource::System, timestamp_ms: 0, is_speech: true }
    }

    fn text(json: &str) -> Message {
        Message::Text(json.to_string().into())
    }

    /// A local WebSocket server standing in for Cartesia, and its endpoint URL.
    async fn local_server() -> (TcpListener, String) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/stt/turns/websocket", listener.local_addr().unwrap());
        (listener, url)
    }

    async fn next_result(rx: &mut mpsc::Receiver<TranscriptResult>) -> TranscriptResult {
        tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("a result within 5 s")
            .expect("result channel open")
    }

    /// The handshake carries the key header and the query, audio arrives in
    /// order, and stop sends the close command and returns the last turn.
    #[tokio::test]
    async fn streams_audio_and_returns_the_last_turn_on_stop() {
        let (listener, url) = local_server().await;
        let (seen_tx, mut seen_rx) = mpsc::channel::<String>(16);
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let handshake_seen = seen_tx.clone();
            let mut ws = tokio_tungstenite::accept_hdr_async(socket, move |req: &Request, resp: Response| {
                let key = req.headers().get("X-API-Key").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
                let _ = handshake_seen.try_send(format!("key={key}"));
                let _ = handshake_seen.try_send(format!("query={}", req.uri().query().unwrap_or("")));
                Ok(resp)
            })
            .await
            .unwrap();
            ws.send(text(r#"{"type":"connected","request_id":"r1"}"#)).await.unwrap();
            while let Some(Ok(message)) = ws.next().await {
                match message {
                    // Gap-filling silence (a slow test run) isn't part of this check.
                    Message::Binary(bytes) if bytes.iter().all(|b| *b == 0) => {}
                    Message::Binary(bytes) => seen_tx.send(format!("audio={:?}", bytes.to_vec())).await.unwrap(),
                    Message::Text(t) => {
                        seen_tx.send(format!("text={t}")).await.unwrap();
                        ws.send(text(r#"{"type":"turn.start","request_id":"r1"}"#)).await.unwrap();
                        ws.send(text(r#"{"type":"turn.update","transcript":"Hello","request_id":"r1"}"#)).await.unwrap();
                        ws.send(text(r#"{"type":"turn.end","transcript":"Hello there.","request_id":"r1"}"#)).await.unwrap();
                        ws.close(None).await.unwrap();
                        break;
                    }
                    _ => {}
                }
            }
        });

        let mut stt = CartesiaSTT::for_endpoint("test-key", &url);
        stt.set_party("You");
        let (tx, mut rx) = mpsc::channel(16);
        stt.start_stream(tx).await.unwrap();
        stt.feed_audio(chunk(vec![1, 2])).await.unwrap();
        stt.feed_audio(chunk(vec![-1])).await.unwrap();
        stt.stop_stream().await.unwrap();
        server.await.unwrap();

        let mut seen = Vec::new();
        while let Ok(line) = seen_rx.try_recv() {
            seen.push(line);
        }
        assert_eq!(seen[0], "key=test-key");
        assert_eq!(seen[1], "query=model=ink-2&encoding=pcm_s16le&sample_rate=16000&cartesia_version=2026-08-14");
        assert_eq!(&seen[2..], [
            "audio=[1, 0, 2, 0]".to_string(),
            "audio=[255, 255]".to_string(),
            r#"text={"type":"close"}"#.to_string(),
        ]);

        let interim = next_result(&mut rx).await;
        assert_eq!((interim.text.as_str(), interim.is_final), ("Hello", false));
        let last = next_result(&mut rx).await;
        assert_eq!((last.text.as_str(), last.is_final), ("Hello there.", true));
        assert_eq!(last.speaker.as_deref(), Some("You"));
        assert!(rx.recv().await.is_none(), "no further results after stop");
    }

    /// The server drops mid-turn: the turn's latest text still arrives as a final.
    #[tokio::test]
    async fn a_dropped_connection_keeps_the_open_turn() {
        let (listener, url) = local_server().await;
        tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
            ws.send(text(r#"{"type":"turn.start"}"#)).await.unwrap();
            ws.send(text(r#"{"type":"turn.update","transcript":"half a sente"}"#)).await.unwrap();
            drop(ws);
        });

        let mut stt = CartesiaSTT::for_endpoint("test-key", &url);
        let (tx, mut rx) = mpsc::channel(16);
        stt.start_stream(tx).await.unwrap();
        let interim = next_result(&mut rx).await;
        assert!(!interim.is_final);
        let kept = next_result(&mut rx).await;
        assert_eq!((kept.text.as_str(), kept.is_final), ("half a sente", true));
        assert_eq!(kept.timestamp_ms, interim.timestamp_ms);
    }

    #[tokio::test]
    async fn connection_test_passes_on_connected() {
        let (listener, url) = local_server().await;
        tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
            ws.send(text(r#"{"type":"connected","request_id":"r1"}"#)).await.unwrap();
            // Any audio here would be billed: the test must not send any.
            while let Some(Ok(message)) = ws.next().await {
                assert!(!matches!(message, Message::Binary(_)), "connection test sent audio");
            }
        });
        let stt = CartesiaSTT::for_endpoint("test-key", &url);
        assert!(stt.test_connection().await.unwrap());
    }

    #[tokio::test]
    async fn connection_test_reports_an_error_event() {
        let (listener, url) = local_server().await;
        tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
            ws.send(text(r#"{"type":"error","status_code":400,"title":"Bad Request","message":"Unsupported model"}"#)).await.unwrap();
            let _ = ws.next().await;
        });
        let stt = CartesiaSTT::for_endpoint("test-key", &url);
        let err = stt.test_connection().await.unwrap_err().to_string();
        assert_eq!(err, "Cartesia: Bad Request: Unsupported model");
    }

    #[tokio::test]
    async fn a_rejected_key_fails_without_streaming() {
        let (listener, url) = local_server().await;
        tokio::spawn(async move {
            for _ in 0..2 {
                let (socket, _) = listener.accept().await.unwrap();
                let _ = tokio_tungstenite::accept_hdr_async(socket, |_: &Request, _: Response| {
                    let mut reject = ErrorResponse::new(Some("invalid key".to_string()));
                    *reject.status_mut() = StatusCode::UNAUTHORIZED;
                    Err(reject)
                })
                .await;
            }
        });
        let mut stt = CartesiaSTT::for_endpoint("wrong-key", &url);
        let err = stt.test_connection().await.unwrap_err().to_string();
        assert_eq!(err, "Cartesia rejected the API key (HTTP 401)");
        let (tx, _rx) = mpsc::channel(16);
        assert!(stt.start_stream(tx).await.is_err());
        assert!(!stt.is_streaming);
    }

    #[tokio::test]
    async fn no_key_means_no_connection_attempt() {
        let mut stt = CartesiaSTT::new();
        let (tx, _rx) = mpsc::channel(16);
        assert!(stt.start_stream(tx).await.unwrap_err().to_string().contains("API key not configured"));
        assert!(stt.test_connection().await.is_err());
    }

    #[test]
    fn silence_fills_only_real_gaps() {
        assert_eq!(silence_samples_for(Duration::from_millis(10)), 0);
        assert_eq!(silence_samples_for(Duration::from_millis(149)), 0);
        assert_eq!(silence_samples_for(Duration::from_millis(150)), 2_400);
        assert_eq!(silence_samples_for(Duration::from_millis(400)), 6_400);
        assert_eq!(silence_samples_for(Duration::from_secs(5)), 16_000);
    }

    #[test]
    fn reconnect_backoff_schedule() {
        let secs: Vec<u64> = (1..=6).map(|a| reconnect_backoff(a).as_secs()).collect();
        assert_eq!(secs, [1, 2, 4, 8, 15, 15]);
    }

    /// While no audio is fed (a muted party), silence goes out at real-time
    /// pace; while audio flows, nothing is added to it.
    #[tokio::test]
    async fn gaps_are_filled_with_silence_at_real_time_pace() {
        let (listener, url) = local_server().await;
        // (all zeros, sample count) per frame, in arrival order.
        let (frames_tx, mut frames_rx) = mpsc::channel::<(bool, usize)>(4096);
        tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
            while let Some(Ok(message)) = ws.next().await {
                match message {
                    Message::Binary(bytes) => {
                        let _ = frames_tx.send((bytes.iter().all(|b| *b == 0), bytes.len() / 2)).await;
                    }
                    Message::Text(_) => {
                        ws.close(None).await.unwrap();
                        break;
                    }
                    _ => {}
                }
            }
        });

        let mut stt = CartesiaSTT::for_endpoint("test-key", &url);
        let (tx, _rx) = mpsc::channel(16);
        stt.start_stream(tx).await.unwrap();
        tokio::time::sleep(Duration::from_millis(1_000)).await; // muted: nothing fed
        for _ in 0..50 {
            stt.feed_audio(chunk(vec![7; 160])).await.unwrap(); // 10 ms chunks
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        stt.stop_stream().await.unwrap();

        let mut frames = Vec::new();
        while let Ok(frame) = frames_rx.try_recv() {
            frames.push(frame);
        }
        let first_audio = frames.iter().position(|(zero, _)| !zero).expect("real audio arrived");
        let silence: usize = frames[..first_audio].iter().map(|(_, n)| n).sum();
        assert!((11_200..=18_400).contains(&silence), "{} samples of silence for a 1 s gap", silence);
        assert!(
            frames[first_audio..].iter().all(|(zero, _)| !zero),
            "silence was mixed into flowing audio"
        );
    }

    /// The server drops mid-turn: the turn is kept, the provider reconnects in
    /// the background without blocking feed_audio, and results keep coming.
    #[tokio::test]
    async fn reconnects_after_the_server_drops_and_keeps_transcribing() {
        let (listener, url) = local_server().await;
        tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
            ws.send(text(r#"{"type":"turn.start"}"#)).await.unwrap();
            ws.send(text(r#"{"type":"turn.update","transcript":"lost words"}"#)).await.unwrap();
            loop {
                if let Some(Ok(Message::Binary(_))) = ws.next().await { break; }
            }
            drop(ws);
            let (socket, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
            ws.send(text(r#"{"type":"turn.start"}"#)).await.unwrap();
            ws.send(text(r#"{"type":"turn.end","transcript":"after reconnect"}"#)).await.unwrap();
            while let Some(Ok(message)) = ws.next().await {
                if let Message::Text(_) = message {
                    ws.close(None).await.unwrap();
                    break;
                }
            }
        });

        let mut stt = CartesiaSTT::for_endpoint("test-key", &url);
        let (tx, mut rx) = mpsc::channel(64);
        stt.start_stream(tx).await.unwrap();
        let mut finals = Vec::new();
        let mut slowest_feed = Duration::ZERO;
        let deadline = Instant::now() + Duration::from_secs(5);
        while !finals.iter().any(|t: &String| t == "after reconnect") && Instant::now() < deadline {
            let started = Instant::now();
            stt.feed_audio(chunk(vec![7; 160])).await.unwrap();
            slowest_feed = slowest_feed.max(started.elapsed());
            while let Ok(result) = rx.try_recv() {
                if result.is_final { finals.push(result.text) }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(finals, ["lost words", "after reconnect"]);
        assert!(slowest_feed < Duration::from_millis(50), "feed_audio blocked for {:?}", slowest_feed);
        assert!(stt.is_streaming);
        stt.stop_stream().await.unwrap();
    }

    /// Cartesia refuses the key or account mid-session: no reconnect loop.
    #[tokio::test]
    async fn a_refused_session_stops_reconnecting() {
        let (listener, url) = local_server().await;
        let accepts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = Arc::clone(&accepts);
        tokio::spawn(async move {
            loop {
                let (socket, _) = listener.accept().await.unwrap();
                counted.fetch_add(1, Ordering::SeqCst);
                let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
                ws.send(text(r#"{"type":"error","status_code":402,"title":"Payment Required","message":"Out of credits"}"#)).await.unwrap();
                ws.close(None).await.unwrap();
            }
        });

        let mut stt = CartesiaSTT::for_endpoint("test-key", &url);
        let (tx, _rx) = mpsc::channel(16);
        stt.start_stream(tx).await.unwrap();
        let until = Instant::now() + Duration::from_millis(1_500);
        while Instant::now() < until {
            stt.feed_audio(chunk(vec![7; 160])).await.unwrap();
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(accepts.load(Ordering::SeqCst), 1, "reconnected after a fatal error");
        assert!(!stt.is_streaming && stt.reconnect_blocked);
    }

    /// The network is down when the meeting starts: the party isn't lost, it
    /// connects in the background once Cartesia is reachable.
    #[tokio::test]
    async fn offline_at_start_connects_in_the_background() {
        let (listener, url) = local_server().await;
        let address = listener.local_addr().unwrap();
        drop(listener); // nothing listens yet

        let mut stt = CartesiaSTT::for_endpoint("test-key", &url);
        let (tx, mut rx) = mpsc::channel(16);
        stt.start_stream(tx).await.expect("a network failure isn't fatal");
        assert!(!stt.is_streaming);

        let listener = TcpListener::bind(address).await.unwrap();
        tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
            ws.send(text(r#"{"type":"turn.start"}"#)).await.unwrap();
            ws.send(text(r#"{"type":"turn.end","transcript":"back online"}"#)).await.unwrap();
            while let Some(Ok(_)) = ws.next().await {}
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut got = None;
        while got.is_none() && Instant::now() < deadline {
            stt.feed_audio(chunk(vec![7; 160])).await.unwrap();
            if let Ok(result) = rx.try_recv() {
                got = Some(result.text);
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(got.as_deref(), Some("back online"));
    }

    #[tokio::test]
    async fn stopping_while_offline_ends_the_reconnects() {
        let (listener, url) = local_server().await;
        drop(listener);
        let mut stt = CartesiaSTT::for_endpoint("test-key", &url);
        let (tx, _rx) = mpsc::channel(16);
        stt.start_stream(tx).await.unwrap();
        stt.stop_stream().await.unwrap();
        stt.feed_audio(chunk(vec![7; 160])).await.unwrap();
        assert!(stt.reconnect_task.is_none() && stt.result_tx.is_none());
    }

    #[test]
    fn resume_hold_keeps_the_newest_second() {
        let mut held = Vec::new();
        hold_for_resume(&mut held, &vec![1; 12_000]);
        hold_for_resume(&mut held, &vec![2; 12_000]);
        assert_eq!(held.len(), 16_000);
        assert_eq!((held[0], held[3_999], held[4_000]), (1, 1, 2));
    }

    /// A local server that closes each session when it gets the close command,
    /// and counts the sessions it accepted.
    async fn closing_server(listener: TcpListener) -> Arc<std::sync::atomic::AtomicUsize> {
        let accepts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = Arc::clone(&accepts);
        tokio::spawn(async move {
            loop {
                let (socket, _) = listener.accept().await.unwrap();
                counted.fetch_add(1, Ordering::SeqCst);
                let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
                tokio::spawn(async move {
                    while let Some(Ok(message)) = ws.next().await {
                        if let Message::Text(_) = message {
                            let _ = ws.close(None).await;
                            break;
                        }
                    }
                });
            }
        });
        accepts
    }

    /// Muting closes the stream (Cartesia still returns the sentence in
    /// progress) and nothing reconnects or is sent while muted.
    #[tokio::test]
    async fn muting_closes_the_stream_and_keeps_the_last_turn() {
        let (listener, url) = local_server().await;
        let accepts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = Arc::clone(&accepts);
        tokio::spawn(async move {
            loop {
                let (socket, _) = listener.accept().await.unwrap();
                counted.fetch_add(1, Ordering::SeqCst);
                let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
                tokio::spawn(async move {
                    while let Some(Ok(message)) = ws.next().await {
                        if let Message::Text(_) = message {
                            ws.send(text(r#"{"type":"turn.start"}"#)).await.unwrap();
                            ws.send(text(r#"{"type":"turn.end","transcript":"said before mute"}"#)).await.unwrap();
                            let _ = ws.close(None).await;
                            break;
                        }
                    }
                });
            }
        });

        let mut stt = CartesiaSTT::for_endpoint("test-key", &url);
        let (tx, mut rx) = mpsc::channel(16);
        stt.start_stream(tx).await.unwrap();
        stt.feed_audio(chunk(vec![7; 160])).await.unwrap();
        stt.set_muted(true);
        let last = next_result(&mut rx).await;
        assert_eq!((last.text.as_str(), last.is_final), ("said before mute", true));

        for _ in 0..30 {
            stt.feed_audio(chunk(vec![7; 160])).await.unwrap();
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(accepts.load(Ordering::SeqCst), 1, "reconnected while muted");
        assert!(!stt.is_streaming);
        assert!(rx.try_recv().is_err(), "results while muted");
    }

    /// Unmuting reconnects at once, and the first words (fed while Cartesia is
    /// still connecting) reach it before live audio.
    #[tokio::test]
    async fn unmuting_reconnects_and_sends_held_audio_first() {
        let (listener, url) = local_server().await;
        let (first_tx, mut first_rx) = mpsc::channel::<Vec<u8>>(4);
        tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
            while let Some(Ok(message)) = ws.next().await {
                if let Message::Text(_) = message {
                    let _ = ws.close(None).await;
                    break;
                }
            }
            // Session 2 answers slowly, so audio fed meanwhile has to be held.
            let (socket, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_millis(150)).await;
            let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
            let mut answered = false;
            while let Some(Ok(message)) = ws.next().await {
                if let Message::Binary(bytes) = message {
                    if bytes.iter().all(|b| *b == 0) {
                        continue;
                    }
                    let _ = first_tx.send(bytes.to_vec()).await;
                    if !answered {
                        answered = true;
                        ws.send(text(r#"{"type":"turn.start"}"#)).await.unwrap();
                        ws.send(text(r#"{"type":"turn.end","transcript":"after unmute"}"#)).await.unwrap();
                    }
                }
            }
        });

        let mut stt = CartesiaSTT::for_endpoint("test-key", &url);
        let (tx, mut rx) = mpsc::channel(16);
        stt.start_stream(tx).await.unwrap();
        stt.set_muted(true);
        tokio::time::sleep(Duration::from_millis(50)).await;
        stt.set_muted(false);
        stt.feed_audio(chunk(vec![3; 160])).await.unwrap();
        stt.feed_audio(chunk(vec![4; 160])).await.unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !stt.is_streaming && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
            stt.feed_audio(chunk(vec![5; 160])).await.unwrap();
        }

        let first = tokio::time::timeout(Duration::from_secs(5), first_rx.recv()).await.unwrap().unwrap();
        let mut expected = pcm_to_bytes(&vec![3; 160]);
        expected.extend(pcm_to_bytes(&vec![4; 160]));
        assert!(first.starts_with(&expected), "the held first words weren't sent first");
        assert_eq!(next_result(&mut rx).await.text, "after unmute");
    }

    #[tokio::test]
    async fn muted_at_start_connects_only_on_unmute() {
        let (listener, url) = local_server().await;
        let accepts = closing_server(listener).await;
        let mut stt = CartesiaSTT::for_endpoint("test-key", &url);
        stt.set_muted(true);
        let (tx, _rx) = mpsc::channel(16);
        stt.start_stream(tx).await.unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(accepts.load(Ordering::SeqCst), 0, "connected while muted");

        stt.set_muted(false);
        let deadline = Instant::now() + Duration::from_secs(5);
        while !stt.is_streaming && Instant::now() < deadline {
            stt.feed_audio(chunk(vec![7; 160])).await.unwrap();
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(stt.is_streaming);
        assert_eq!(accepts.load(Ordering::SeqCst), 1);
        stt.stop_stream().await.unwrap();
    }

    #[tokio::test]
    async fn stopping_while_muted_ends_without_reconnecting() {
        let (listener, url) = local_server().await;
        let accepts = closing_server(listener).await;
        let mut stt = CartesiaSTT::for_endpoint("test-key", &url);
        let (tx, _rx) = mpsc::channel(16);
        stt.start_stream(tx).await.unwrap();
        stt.set_muted(true);
        let started = Instant::now();
        stt.stop_stream().await.unwrap();
        assert!(started.elapsed() < Duration::from_secs(2), "stop waited {:?}", started.elapsed());
        stt.set_muted(false);
        stt.feed_audio(chunk(vec![7; 160])).await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(accepts.load(Ordering::SeqCst), 1, "reconnected after stop");
        assert!(stt.reconnect_task.is_none());
    }

    /// Fast mute/unmute toggling ends with one live session: audio reaches only
    /// it, so each turn arrives once.
    #[tokio::test]
    async fn rapid_mute_toggling_leaves_one_live_session() {
        let (listener, url) = local_server().await;
        tokio::spawn(async move {
            loop {
                let (socket, _) = listener.accept().await.unwrap();
                let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
                tokio::spawn(async move {
                    let mut answered = false;
                    while let Some(Ok(message)) = ws.next().await {
                        match message {
                            Message::Binary(bytes) if !answered && bytes.iter().any(|b| *b != 0) => {
                                answered = true;
                                ws.send(text(r#"{"type":"turn.start"}"#)).await.unwrap();
                                ws.send(text(r#"{"type":"turn.end","transcript":"once"}"#)).await.unwrap();
                            }
                            Message::Text(_) => {
                                let _ = ws.close(None).await;
                                break;
                            }
                            _ => {}
                        }
                    }
                });
            }
        });

        let mut stt = CartesiaSTT::for_endpoint("test-key", &url);
        let (tx, mut rx) = mpsc::channel(64);
        stt.start_stream(tx).await.unwrap();
        for _ in 0..3 {
            stt.set_muted(true);
            stt.set_muted(false);
        }
        let mut finals = Vec::new();
        let until = Instant::now() + Duration::from_millis(800);
        while Instant::now() < until {
            stt.feed_audio(chunk(vec![7; 160])).await.unwrap();
            while let Ok(result) = rx.try_recv() {
                if result.is_final { finals.push(result.text) }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(stt.is_streaming);
        assert_eq!(finals, ["once"]);
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

    /// Streams a test clip to the real Cartesia API at real-time pace. Needs
    /// CARTESIA_API_KEY and CARTESIA_TEST_WAV (16 kHz mono 16-bit WAV with
    /// speech that mentions "meeting"). ink-2 costs 3 credits per second of audio.
    #[tokio::test]
    #[ignore = "calls the Cartesia API; needs CARTESIA_API_KEY and CARTESIA_TEST_WAV"]
    async fn live_transcribes_the_test_clip() {
        let key = std::env::var("CARTESIA_API_KEY").expect("CARTESIA_API_KEY");
        let wav = std::fs::read(std::env::var("CARTESIA_TEST_WAV").expect("CARTESIA_TEST_WAV")).unwrap();
        let samples = wav_samples(&wav);

        let mut stt = CartesiaSTT::with_api_key(&key);
        assert!(stt.test_connection().await.expect("connection test"));

        let (tx, mut rx) = mpsc::channel(1024);
        stt.start_stream(tx).await.expect("start");
        for frame in samples.chunks(1600) {
            stt.feed_audio(chunk(frame.to_vec())).await.unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        stt.stop_stream().await.unwrap();

        let mut interims = 0;
        let mut finals = Vec::new();
        let mut signals = std::collections::BTreeMap::new();
        while let Ok(result) = rx.try_recv() {
            if let Some(turn) = result.turn {
                *signals.entry(turn.as_str()).or_insert(0) += 1;
            }
            if result.is_final { finals.push(result) } else { interims += 1 }
        }
        println!("{} interim results, {} final turns, turn signals {:?}", interims, finals.len(), signals);
        for f in &finals {
            println!("final ({:?}): start {} ms, {:?} ms long: {}", f.turn, f.timestamp_ms % 100_000, f.duration_ms, f.text);
        }
        assert!(!finals.is_empty(), "no final turn");
        assert!(finals.iter().any(|f| f.turn == Some(TurnSignal::End)), "no final carried the End signal");
        let all = finals.iter().map(|f| f.text.to_lowercase()).collect::<Vec<_>>().join(" ");
        assert!(all.contains("meeting"), "unexpected transcript: {all}");
    }

    /// Like a party muted after the first sentence: audio stops for 3 s, and
    /// the gap-filling silence lets Cartesia end the turn during the pause.
    #[tokio::test]
    #[ignore = "calls the Cartesia API; needs CARTESIA_API_KEY and CARTESIA_TEST_WAV"]
    async fn live_turn_ends_while_no_audio_is_fed() {
        let key = std::env::var("CARTESIA_API_KEY").expect("CARTESIA_API_KEY");
        let wav = std::fs::read(std::env::var("CARTESIA_TEST_WAV").expect("CARTESIA_TEST_WAV")).unwrap();
        let samples = wav_samples(&wav);
        // The test clip's first sentence ends about 4.3 s in.
        let (first, rest) = samples.split_at(16_000 * 45 / 10);

        let mut stt = CartesiaSTT::with_api_key(&key);
        let (tx, mut rx) = mpsc::channel(1024);
        stt.start_stream(tx).await.expect("start");
        for frame in first.chunks(1600) {
            stt.feed_audio(chunk(frame.to_vec())).await.unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        tokio::time::sleep(Duration::from_secs(3)).await; // "muted": nothing fed
        let mut during_gap = Vec::new();
        while let Ok(result) = rx.try_recv() {
            if result.is_final { during_gap.push(result.text) }
        }
        println!("finals during the gap: {:?}", during_gap);
        for frame in rest.chunks(1600) {
            stt.feed_audio(chunk(frame.to_vec())).await.unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        stt.stop_stream().await.unwrap();
        let mut after = Vec::new();
        while let Ok(result) = rx.try_recv() {
            if result.is_final { after.push(result.text) }
        }
        println!("finals after the gap: {:?}", after);
        assert_eq!(during_gap.len(), 1, "the first turn should end during the gap");
        assert!(after.iter().any(|t| t.to_lowercase().contains("meeting")));
    }

    /// Muted after the first sentence: Cartesia returns it and the stream
    /// closes, so the muted 3 s aren't billed. Unmuting starts a new stream
    /// that transcribes the second sentence.
    #[tokio::test]
    #[ignore = "calls the Cartesia API; needs CARTESIA_API_KEY and CARTESIA_TEST_WAV"]
    async fn live_mute_closes_and_unmute_resumes() {
        let key = std::env::var("CARTESIA_API_KEY").expect("CARTESIA_API_KEY");
        let wav = std::fs::read(std::env::var("CARTESIA_TEST_WAV").expect("CARTESIA_TEST_WAV")).unwrap();
        let samples = wav_samples(&wav);
        let (first, rest) = samples.split_at(16_000 * 45 / 10);

        let mut stt = CartesiaSTT::with_api_key(&key);
        let (tx, mut rx) = mpsc::channel(1024);
        stt.start_stream(tx).await.expect("start");
        for frame in first.chunks(1600) {
            stt.feed_audio(chunk(frame.to_vec())).await.unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        stt.set_muted(true);
        tokio::time::sleep(Duration::from_secs(3)).await;
        let mut by_end_of_mute = Vec::new();
        while let Ok(result) = rx.try_recv() {
            if result.is_final { by_end_of_mute.push(result.text) }
        }
        println!("finals by the end of the mute: {:?}", by_end_of_mute);
        assert!(!stt.is_streaming, "still streaming while muted");

        stt.set_muted(false);
        for frame in rest.chunks(1600) {
            stt.feed_audio(chunk(frame.to_vec())).await.unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        stt.stop_stream().await.unwrap();
        let mut after = Vec::new();
        while let Ok(result) = rx.try_recv() {
            if result.is_final { after.push(result.text) }
        }
        println!("finals after unmute: {:?}", after);
        assert_eq!(by_end_of_mute.len(), 1, "the first sentence should come back at mute");
        assert!(after.iter().any(|t| t.to_lowercase().contains("meeting")));
    }

    #[test]
    fn parses_every_event_type() {
        assert_eq!(
            event(r#"{"type":"connected","request_id":"r1"}"#),
            ServerEvent::Connected { request_id: "r1".into() }
        );
        assert_eq!(event(r#"{"type":"turn.start","request_id":"r1"}"#), ServerEvent::TurnStart {});
        assert_eq!(
            event(r#"{"type":"turn.update","transcript":"Hi I","request_id":"r1"}"#),
            ServerEvent::TurnUpdate { transcript: "Hi I".into() }
        );
        assert_eq!(
            event(r#"{"type":"turn.eager_end","transcript":"Hi I need","request_id":"r1"}"#),
            ServerEvent::TurnEagerEnd { transcript: "Hi I need".into() }
        );
        assert_eq!(event(r#"{"type":"turn.resume","request_id":"r1"}"#), ServerEvent::TurnResume {});
        assert_eq!(
            event(r#"{"type":"turn.end","transcript":"Hi I need help.","request_id":"r1"}"#),
            ServerEvent::TurnEnd { transcript: "Hi I need help.".into() }
        );
        assert_eq!(
            event(r#"{"type":"error","status_code":401,"title":"Unauthorized","message":"Invalid API key","error_code":"invalid_api_key"}"#),
            ServerEvent::Error { status_code: Some(401), title: "Unauthorized".into(), message: "Invalid API key".into() }
        );
    }

    #[test]
    fn unknown_or_malformed_messages_are_harmless() {
        assert_eq!(event(r#"{"type":"turn.something_new","x":1}"#), ServerEvent::Unknown);
        assert_eq!(ServerEvent::parse("not json"), None);
        assert_eq!(ServerEvent::parse(r#"{"transcript":"no type"}"#), None);
        let mut turns = TurnTracker::new("Them");
        assert!(turns.on_event(&ServerEvent::Unknown, 1_000).is_none());
    }

    #[test]
    fn a_turn_becomes_interims_then_one_final() {
        let mut turns = TurnTracker::new("Them");
        assert!(turns.on_event(&event(r#"{"type":"turn.start"}"#), 10_000).is_none());

        let update = turns.on_event(&event(r#"{"type":"turn.update","transcript":"Hi I"}"#), 10_400).unwrap();
        assert_eq!(update.text, "Hi I");
        assert!(!update.is_final);
        assert_eq!(update.timestamp_ms, 10_000);
        assert_eq!(update.speaker.as_deref(), Some("Them"));

        let eager = turns.on_event(&event(r#"{"type":"turn.eager_end","transcript":"Hi I need to cancel"}"#), 11_000).unwrap();
        assert!(!eager.is_final);
        assert_eq!(eager.text, "Hi I need to cancel");
        let resumed = turns.on_event(&event(r#"{"type":"turn.resume"}"#), 11_100).unwrap();
        assert_eq!((resumed.text.as_str(), resumed.is_final), ("Hi I need to cancel", false));

        let end = turns.on_event(&event(r#"{"type":"turn.end","transcript":"Hi I need to cancel my plan. "}"#), 12_500).unwrap();
        assert!(end.is_final);
        assert_eq!(end.text, "Hi I need to cancel my plan.");
        assert_eq!(end.timestamp_ms, 10_000);
        assert_eq!(end.duration_ms, Some(2_500));
        assert_eq!(end.language, None);
        assert_eq!(end.speaker_tag, None);
    }

    #[test]
    fn turn_events_carry_cartesias_turn_signals() {
        let mut turns = TurnTracker::new("Them");
        turns.on_event(&event(r#"{"type":"turn.start"}"#), 10_000);
        let update = turns.on_event(&event(r#"{"type":"turn.update","transcript":"What would you"}"#), 10_300).unwrap();
        assert_eq!(update.turn, None);

        let eager = turns.on_event(&event(r#"{"type":"turn.eager_end","transcript":"What would you do"}"#), 10_800).unwrap();
        assert_eq!((eager.turn, eager.is_final), (Some(TurnSignal::EagerEnd), false));

        // turn.resume carries no text: it reports the turn's latest text again.
        let resumed = turns.on_event(&event(r#"{"type":"turn.resume"}"#), 11_000).unwrap();
        assert_eq!((resumed.turn, resumed.is_final), (Some(TurnSignal::Resumed), false));
        assert_eq!((resumed.text.as_str(), resumed.timestamp_ms), ("What would you do", 10_000));

        let end = turns.on_event(&event(r#"{"type":"turn.end","transcript":"What would you do first?"}"#), 12_000).unwrap();
        assert_eq!((end.turn, end.is_final), (Some(TurnSignal::End), true));
    }

    #[test]
    fn a_resume_before_any_text_reports_nothing() {
        let mut turns = TurnTracker::new("Them");
        turns.on_event(&event(r#"{"type":"turn.start"}"#), 1_000);
        assert!(turns.on_event(&event(r#"{"type":"turn.resume"}"#), 1_100).is_none());
    }

    #[test]
    fn a_turn_cut_short_by_the_connection_has_no_turn_signal() {
        // Cartesia didn't say the speaker finished, so Auto-Answer must not
        // treat it as a turn end.
        let mut turns = TurnTracker::new("Them");
        turns.on_event(&event(r#"{"type":"turn.start"}"#), 1_000);
        turns.on_event(&event(r#"{"type":"turn.eager_end","transcript":"What would"}"#), 1_500);
        let last = turns.finish_open_turn(2_000).unwrap();
        assert_eq!((last.is_final, last.turn), (true, None));
    }

    #[test]
    fn empty_turns_produce_nothing() {
        let mut turns = TurnTracker::new("You");
        turns.on_event(&event(r#"{"type":"turn.start"}"#), 1_000);
        assert!(turns.on_event(&event(r#"{"type":"turn.update","transcript":"  "}"#), 1_200).is_none());
        assert!(turns.on_event(&event(r#"{"type":"turn.end","transcript":""}"#), 1_500).is_none());
        assert!(turns.finish_open_turn(2_000).is_none());
    }

    #[test]
    fn a_turn_without_turn_start_is_stamped_at_its_first_event() {
        let mut turns = TurnTracker::new("Them");
        let update = turns.on_event(&event(r#"{"type":"turn.update","transcript":"Hello"}"#), 5_000).unwrap();
        assert_eq!(update.timestamp_ms, 5_000);
        let end = turns.on_event(&event(r#"{"type":"turn.end","transcript":"Hello there"}"#), 6_000).unwrap();
        assert_eq!((end.timestamp_ms, end.duration_ms), (5_000, Some(1_000)));
    }

    #[test]
    fn an_open_turn_is_finished_once_with_its_latest_text() {
        let mut turns = TurnTracker::new("Them");
        turns.on_event(&event(r#"{"type":"turn.start"}"#), 1_000);
        turns.on_event(&event(r#"{"type":"turn.update","transcript":"half a sente"}"#), 1_600);
        let last = turns.finish_open_turn(2_000).unwrap();
        assert!(last.is_final);
        assert_eq!(last.text, "half a sente");
        assert_eq!((last.timestamp_ms, last.duration_ms), (1_000, Some(1_000)));
        assert!(turns.finish_open_turn(3_000).is_none());
        // A turn that already ended leaves nothing to finish.
        turns.on_event(&event(r#"{"type":"turn.start"}"#), 4_000);
        turns.on_event(&event(r#"{"type":"turn.end","transcript":"Done."}"#), 4_500);
        assert!(turns.finish_open_turn(5_000).is_none());
    }

    #[test]
    fn url_has_required_params_and_no_key() {
        let url = build_ws_url(DEFAULT_WS_URL);
        assert_eq!(
            url,
            "wss://api.cartesia.ai/stt/turns/websocket?model=ink-2&encoding=pcm_s16le&sample_rate=16000&cartesia_version=2026-08-14"
        );
        assert!(!url.to_lowercase().contains("key"));
    }

    /// The frontend selects the provider and stores its key by this id.
    #[test]
    fn registered_as_cartesia() {
        assert_eq!(STTProviderType::from_str("cartesia"), Some(STTProviderType::Cartesia));
        assert_eq!(STTProviderType::Cartesia.as_str(), "cartesia");
        assert_eq!(CartesiaSTT::new().provider_type(), STTProviderType::Cartesia);
        let info = crate::stt::provider::list_available_providers()
            .into_iter()
            .find(|p| p.provider_type == "cartesia")
            .expect("listed");
        assert!(info.requires_api_key && !info.is_local);
        assert_eq!(info.supported_languages, ["en", "fr", "hi", "ja", "es"]);
    }

    #[test]
    fn pcm_is_little_endian() {
        assert_eq!(pcm_to_bytes(&[1, -2, 0x1234]), vec![0x01, 0x00, 0xFE, 0xFF, 0x34, 0x12]);
    }
}
