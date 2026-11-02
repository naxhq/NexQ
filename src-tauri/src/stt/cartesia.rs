// Cartesia Realtime STT (Auto): WebSocket streaming with built-in turn detection
//
// Connects to wss://api.cartesia.ai/stt/turns/websocket (model ink-2) and sends
// 16 kHz mono PCM as binary frames. Cartesia decides where each speaker turn
// starts and ends, and reports it as events:
// - turn.update / turn.eager_end carry the turn so far (cumulative, never
//   revised) and become interim results
// - turn.end carries the finished turn and becomes the final result
// Cartesia sends no word timestamps, so a turn is stamped with the time its
// turn.start arrived.
//
// - API key in the X-API-Key handshake header, never in the URL
// - Stop sends {"type":"close"}; Cartesia finishes the last turn and closes
// - A connection that ends mid-turn keeps the turn's latest text as a final
// - Status events on `stt_connection_status`, like Deepgram

use async_trait::async_trait;
use futures::stream::SplitSink;
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::sync::mpsc::error::TrySendError;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::audio::AudioChunk;
use crate::stt::deepgram::ConnectionStatusEvent;
use crate::stt::provider::{STTProvider, STTProviderType, TranscriptResult};

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

/// Audio chunks queued for the writer (100 ms each, so about 25 s).
const AUDIO_QUEUE_CHUNKS: usize = 256;

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
                Some(self.result(self.turn_text.clone(), false, start, None))
            }
            ServerEvent::TurnEnd { transcript } => {
                let start = self.turn_start_ms.take().unwrap_or(now_ms);
                self.turn_text.clear();
                let text = transcript.trim();
                if text.is_empty() {
                    return None;
                }
                Some(self.result(text.to_string(), true, start, Some(now_ms.saturating_sub(start))))
            }
            _ => None,
        }
    }

    /// The open turn's latest text as a final, for when the connection ends
    /// before its turn.end. Clears the turn, so it is only reported once.
    fn finish_open_turn(&mut self, now_ms: u64) -> Option<TranscriptResult> {
        let start = self.turn_start_ms.take()?;
        let text = std::mem::take(&mut self.turn_text);
        if text.is_empty() {
            return None;
        }
        Some(self.result(text, true, start, Some(now_ms.saturating_sub(start))))
    }

    fn result(&self, text: String, is_final: bool, start_ms: u64, duration_ms: Option<u64>) -> TranscriptResult {
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
    /// Audio chunks dropped because the writer fell behind.
    dropped_chunks: u64,
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
            dropped_chunks: 0,
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
        self.audio_tx = Some(audio_tx);
        self.result_tx = Some(result_tx.clone());
        self.reader_task = Some(spawn_reader_task(
            read_half,
            result_tx,
            Arc::clone(&self.turns),
            self.party.clone(),
            self.app_handle.clone(),
        ));
        spawn_writer_task(write_half, audio_rx, self.party.clone());
        self.is_streaming = true;
        self.dropped_chunks = 0;
        self.emit_status("connected", None);
    }

    /// Report the open turn's latest text as a final (when the reader can't).
    async fn finish_open_turn(&mut self) {
        let last = self
            .turns
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .finish_open_turn(epoch_now_ms());
        if let (Some(result), Some(tx)) = (last, self.result_tx.as_ref()) {
            let _ = tx.send(result).await;
        }
    }
}

/// Read Cartesia's events and send the results. When the socket ends with a
/// turn still open, its latest text is sent as a final.
fn spawn_reader_task(
    mut read_half: futures::stream::SplitStream<CartesiaSocket>,
    result_tx: mpsc::Sender<TranscriptResult>,
    turns: Arc<Mutex<TurnTracker>>,
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

/// Send audio as binary frames. When the audio channel closes, send the close
/// command; Cartesia then sends the last events and closes the socket itself.
fn spawn_writer_task(
    mut write_half: SplitSink<CartesiaSocket, Message>,
    mut audio_rx: mpsc::Receiver<Vec<u8>>,
    party: String,
) {
    tokio::spawn(async move {
        while let Some(frame) = audio_rx.recv().await {
            if let Err(e) = write_half.send(Message::Binary(frame.into())).await {
                log::warn!("CartesiaSTT: write error ({}): {}", party, e);
                return;
            }
        }
        let close = serde_json::json!({"type": "close"}).to_string();
        if let Err(e) = write_half.send(Message::Text(close.into())).await {
            log::warn!("CartesiaSTT: couldn't send the close command ({}): {}", party, e);
        }
        log::info!("CartesiaSTT: writer exiting ({})", party);
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
            Err(e) => {
                self.emit_status("error", Some(e.to_string()));
                Err(e.into())
            }
        }
    }

    async fn feed_audio(
        &mut self,
        chunk: AudioChunk,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if !self.is_streaming || chunk.pcm_data.is_empty() {
            return Ok(());
        }
        let Some(audio_tx) = self.audio_tx.as_ref() else {
            return Ok(());
        };
        // Never wait here: the audio loop also serves the other party and the recording.
        match audio_tx.try_send(pcm_to_bytes(&chunk.pcm_data)) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                self.dropped_chunks += 1;
                if self.dropped_chunks.is_power_of_two() {
                    log::warn!("CartesiaSTT: sending is behind ({}); {} audio chunks dropped", self.party, self.dropped_chunks);
                }
            }
            Err(TrySendError::Closed(_)) => {
                log::warn!("CartesiaSTT: connection lost ({})", self.party);
                self.is_streaming = false;
                self.audio_tx = None;
                self.emit_status("disconnected", Some("Connection lost".to_string()));
            }
        }
        Ok(())
    }

    async fn stop_stream(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // Dropping the audio sender makes the writer send the close command.
        self.audio_tx = None;
        if let Some(reader) = self.reader_task.take() {
            let abort = reader.abort_handle();
            if tokio::time::timeout(FINAL_RESULTS_WAIT, reader).await.is_err() {
                log::warn!("CartesiaSTT: Cartesia didn't close within 5 s ({}); keeping the open turn as it is", self.party);
                abort.abort();
                self.finish_open_turn().await;
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
        while let Ok(result) = rx.try_recv() {
            if result.is_final { finals.push(result) } else { interims += 1 }
        }
        println!("{} interim results, {} final turns", interims, finals.len());
        for f in &finals {
            println!("final: start {} ms, {:?} ms long: {}", f.timestamp_ms % 100_000, f.duration_ms, f.text);
        }
        assert!(!finals.is_empty(), "no final turn");
        let all = finals.iter().map(|f| f.text.to_lowercase()).collect::<Vec<_>>().join(" ");
        assert!(all.contains("meeting"), "unexpected transcript: {all}");
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
        assert!(turns.on_event(&event(r#"{"type":"turn.resume"}"#), 11_100).is_none());

        let end = turns.on_event(&event(r#"{"type":"turn.end","transcript":"Hi I need to cancel my plan. "}"#), 12_500).unwrap();
        assert!(end.is_final);
        assert_eq!(end.text, "Hi I need to cancel my plan.");
        assert_eq!(end.timestamp_ms, 10_000);
        assert_eq!(end.duration_ms, Some(2_500));
        assert_eq!(end.language, None);
        assert_eq!(end.speaker_tag, None);
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
