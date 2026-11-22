//! MAI recognition runs in Microsoft's JavaScript Speech SDK in the launcher.
//! Rust still owns capture, the bounded PCM queue and the transcript pipeline.

use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tauri::{
    ipc::{Channel, Response},
    AppHandle, Emitter, Manager, State, WebviewWindow,
};
use tokio::{
    sync::{mpsc, Mutex as AsyncMutex},
    task::JoinHandle,
    time::timeout,
};
use uuid::Uuid;

use super::provider::{reported_language, STTProvider, STTProviderType, TranscriptResult};
use crate::audio::AudioChunk;

pub const ID: &str = "azure_mai_streaming";
pub const REGION_KEY: &str = "azure_mai_streaming_region";
const REGIONS: &[&str] = &["swedencentral", "centralus", "eastus2", "southeastasia"];
const STOP_LIMIT: Duration = Duration::from_secs(4);
// Longer than the token, SDK start and service-turn deadlines combined, so
// the launcher can dispose the test recognizer before the command returns.
const PROBE_LIMIT: Duration = Duration::from_secs(23);
const AUDIO_QUEUE: usize = 32;
const SILENCE_TICK: Duration = Duration::from_millis(200);
const HOST_START_LIMIT: Duration = Duration::from_secs(12);
const HOST_IDLE_LIMIT: Duration = Duration::from_secs(6);
const RESUME_BYTES: usize = 16_000; // last half-second captured after unmute
// Reconnect after a launcher stall or a network/SDK failure, backing off
// between attempts. Credential and model failures are not retried.
const RETRY_FIRST: Duration = Duration::from_secs(2);
const RETRY_MAX: Duration = Duration::from_secs(30);
// A session that stayed up this long resets the backoff.
const RETRY_RESET_AFTER: Duration = Duration::from_secs(60);
type SttError = Box<dyn std::error::Error + Send + Sync>;

#[derive(Clone)]
struct Config {
    key: String,
    region: String,
    language: Option<String>,
}

impl Config {
    fn new(key: &str, region: &str, language: &str) -> Result<Self, String> {
        let key = key.trim();
        if key.is_empty() {
            return Err("Add an Azure Speech resource key in Settings → STT Providers.".into());
        }
        let region = region.trim().to_ascii_lowercase();
        if !REGIONS.contains(&region.as_str()) {
            return Err(
                "Choose a supported Azure MAI Streaming region in Settings → STT Providers.".into(),
            );
        }
        Ok(Self {
            key: key.to_owned(),
            region,
            language: reported_language(language),
        })
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Start {
    id: Uuid,
    region: String,
    language: Option<String>,
    probe: bool,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum SdkEvent {
    Connected,
    Reconnecting,
    Transcript {
        text: String,
        is_final: bool,
        timestamp_ms: u64,
        duration_ms: Option<u64>,
        language: Option<String>,
    },
    ClearInterim,
    Failed {
        reason: Failure,
    },
    Closed,
    Verified,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Failure {
    Credentials,
    Model,
    Network,
    Launcher,
    Sdk,
}

impl Failure {
    fn message(&self) -> &'static str {
        match self {
            Self::Credentials => "Azure rejected the Speech resource key or region. Make sure they match and that key authentication is enabled.",
            Self::Model => "Azure rejected MAI-Transcribe-2-Streaming. Check the Speech resource region and model availability.",
            Self::Network => "Azure MAI Streaming could not reach the Speech service. Check the connection to Azure and try again.",
            Self::Launcher => "The NexQ launcher stopped responding to Azure MAI Streaming. Reopen the launcher or restart capture.",
            Self::Sdk => "Azure MAI Streaming could not start or finish a Speech SDK session.",
        }
    }
}

struct Link {
    config: Config,
    pcm: AsyncMutex<mpsc::Receiver<Vec<u8>>>,
    events: mpsc::Sender<SdkEvent>,
    last_read: Mutex<Option<Instant>>,
}

#[derive(Default)]
pub struct MaiBridge {
    host: Mutex<Option<Channel<Start>>>,
    sessions: Mutex<HashMap<Uuid, Arc<Link>>>,
    host_generation: AtomicU64,
}

impl MaiBridge {
    fn link(&self, id: Uuid) -> Result<Arc<Link>, String> {
        self.sessions
            .lock()
            .unwrap()
            .get(&id)
            .cloned()
            .ok_or_else(|| "Azure MAI Streaming session is closed".into())
    }
}

/// The ID is scoped to a single session. The key stays in Rust; only a
/// short-lived Speech token is handed to the SDK in the launcher.
struct Session {
    id: Uuid,
    app: AppHandle,
    events: mpsc::Receiver<SdkEvent>,
    link: Arc<Link>,
    host_generation: u64,
}

impl Session {
    fn open(
        app: &AppHandle,
        config: Config,
        probe: bool,
    ) -> Result<(Self, mpsc::Sender<Vec<u8>>), String> {
        let bridge = app.state::<MaiBridge>();
        let host_slot = bridge.host.lock().unwrap();
        let host = host_slot.clone().ok_or(
            "Azure MAI Streaming SDK is unavailable in the launcher. Restart NexQ and try again.",
        )?;
        let host_generation = bridge.host_generation.load(Ordering::Relaxed);
        drop(host_slot);
        let id = Uuid::new_v4();
        let (pcm_tx, pcm) = mpsc::channel(AUDIO_QUEUE);
        let (events, event_rx) = mpsc::channel(64);
        let request = Start {
            id,
            region: config.region.clone(),
            language: config.language.clone(),
            probe,
        };
        let link = Arc::new(Link {
            config,
            pcm: AsyncMutex::new(pcm),
            events,
            last_read: Mutex::new(None),
        });
        bridge.sessions.lock().unwrap().insert(id, link.clone());
        let session = Self {
            id,
            app: app.clone(),
            events: event_rx,
            link,
            host_generation,
        };
        host.send(request)
            .map_err(|_| "Azure MAI Streaming SDK is unavailable in the launcher")?;
        Ok((session, pcm_tx))
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.app
            .state::<MaiBridge>()
            .sessions
            .lock()
            .unwrap()
            .remove(&self.id);
    }
}

fn require_launcher(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "launcher" {
        Ok(())
    } else {
        Err("Azure MAI Streaming SDK is only available in the launcher".into())
    }
}

#[tauri::command]
pub fn azure_mai_register(
    window: WebviewWindow,
    bridge: State<'_, MaiBridge>,
    channel: Channel<Start>,
) -> Result<(), String> {
    require_launcher(&window)?;
    let mut host = bridge.host.lock().unwrap();
    *host = Some(channel);
    bridge.host_generation.fetch_add(1, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub async fn azure_mai_read(
    window: WebviewWindow,
    bridge: State<'_, MaiBridge>,
    id: Uuid,
) -> Result<Response, String> {
    require_launcher(&window)?;
    let link = bridge.link(id)?;
    *link.last_read.lock().unwrap() = Some(Instant::now());
    // One read in flight per SDK session. An empty body means EOF, not silence;
    // it instructs the SDK to finish recognition and release the input stream.
    let mut source = link.pcm.lock().await;
    let pcm = match timeout(SILENCE_TICK, source.recv()).await {
        Ok(Some(first)) => drain_pcm_batch(first, &mut source),
        Ok(None) => Vec::new(),
        // Loopback devices may not call back at all while silent.
        Err(_) => pcm_frame(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            &[],
        ),
    };
    Ok(Response::new(pcm))
}

#[tauri::command]
pub async fn azure_mai_event(
    window: WebviewWindow,
    bridge: State<'_, MaiBridge>,
    id: Uuid,
    event: SdkEvent,
) -> Result<(), String> {
    require_launcher(&window)?;
    bridge
        .link(id)?
        .events
        .send(event)
        .await
        .map_err(|_| "Azure MAI Streaming session is closed".into())
}

#[tauri::command]
pub async fn azure_mai_token(
    window: WebviewWindow,
    bridge: State<'_, MaiBridge>,
    id: Uuid,
) -> Result<String, String> {
    require_launcher(&window)?;
    let config = &bridge.link(id)?.config;
    let mut key = reqwest::header::HeaderValue::from_str(&config.key).map_err(|_| "credentials")?;
    key.set_sensitive(true);
    // Microsoft's documented browser SDK flow: exchange the regional Speech
    // resource key for a short-lived token. This is not a transcription REST call.
    let response = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|_| "sdk")?
        .post(format!(
            "https://{}.api.cognitive.microsoft.com/sts/v1.0/issueToken",
            config.region
        ))
        .header("Ocp-Apim-Subscription-Key", key)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .send()
        .await
        .map_err(|_| "network")?;
    match response.status().as_u16() {
        200 => response.text().await.map_err(|_| "network".into()),
        401 | 403 => Err("credentials".into()),
        429 | 500..=599 => Err("network".into()),
        _ => Err("credentials".into()),
    }
}

#[tauri::command]
pub async fn test_azure_mai_connection(
    app: AppHandle,
    key: String,
    region: String,
) -> Result<bool, String> {
    probe(&app, Config::new(&key, &region, "auto")?).await
}

async fn probe(app: &AppHandle, config: Config) -> Result<bool, String> {
    let (mut session, _pcm) = Session::open(app, config, true)?;
    timeout(PROBE_LIMIT, async {
        while let Some(event) = session.events.recv().await {
            match event {
                SdkEvent::Verified => return Ok(true),
                SdkEvent::Failed { reason } => return Err(reason.message().into()),
                SdkEvent::Closed => break,
                _ => (),
            }
        }
        Err(Failure::Sdk.message().into())
    })
    .await
    .map_err(|_| Failure::Network.message().to_owned())?
}

fn status(app: &AppHandle, party: &str, state: &str, message: Option<&str>) {
    let _ = app.emit(
        "stt_connection_status",
        serde_json::json!({
            "provider": ID, "party": party, "status": state, "message": message
        }),
    );
}

/// After a retryable failure, decide whether to reconnect now. The first call
/// schedules the attempt; later calls fire it once the backoff has passed.
fn retry_due(
    flagged: bool,
    now: Instant,
    connected_at: Option<Instant>,
    retry_at: &mut Option<Instant>,
    backoff: &mut Duration,
) -> bool {
    if !flagged {
        return false;
    }
    match *retry_at {
        Some(at) => now >= at,
        None => {
            if connected_at.is_some_and(|t| now.duration_since(t) >= RETRY_RESET_AFTER) {
                *backoff = RETRY_FIRST;
            }
            *retry_at = Some(now + *backoff);
            *backoff = (*backoff * 2).min(RETRY_MAX);
            false
        }
    }
}

/// Whether a session that ended on this failure should be reopened.
fn retryable(reason: &Failure) -> bool {
    matches!(reason, Failure::Network | Failure::Launcher | Failure::Sdk)
}

async fn collect(
    mut session: Session,
    party: String,
    tx: mpsc::Sender<TranscriptResult>,
    retry: Arc<AtomicBool>,
) {
    let mut has_interim = false;
    let started = Instant::now();
    let mut watchdog = tokio::time::interval(Duration::from_secs(1));
    loop {
        let event = tokio::select! {
            event = session.events.recv() => {
                let Some(event) = event else { break };
                event
            }
            _ = watchdog.tick() => {
                let stale = session.link.last_read.lock().unwrap().map_or_else(
                    || started.elapsed() >= HOST_START_LIMIT,
                    |last| last.elapsed() >= HOST_IDLE_LIMIT,
                );
                let new_host = session.app.state::<MaiBridge>().host_generation.load(Ordering::Relaxed)
                    != session.host_generation;
                if stale || new_host {
                    // A new host is picked up by `feed_audio` directly; a stalled
                    // one is retried with backoff instead of ending the side.
                    if stale && !new_host {
                        retry.store(true, Ordering::Relaxed);
                    }
                    status(&session.app, &party, "reconnecting", Some(Failure::Launcher.message()));
                    break;
                }
                continue;
            }
        };
        match event {
            SdkEvent::Connected => status(&session.app, &party, "connected", None),
            SdkEvent::Reconnecting => status(
                &session.app,
                &party,
                "reconnecting",
                Some(Failure::Network.message()),
            ),
            SdkEvent::Transcript {
                text,
                is_final,
                timestamp_ms,
                duration_ms,
                language,
            } => {
                let text = text.trim();
                if text.is_empty() {
                    continue;
                }
                let result = TranscriptResult {
                    text: text.to_owned(),
                    is_final,
                    confidence: 0.0,
                    timestamp_ms,
                    speaker: Some(if party == "You" {
                        "User".into()
                    } else {
                        "Them".into()
                    }),
                    language,
                    segment_id: None,
                    duration_ms,
                    speaker_tag: None,
                    turn: None,
                };
                if tx.send(result).await.is_err() {
                    return;
                }
                has_interim = !is_final;
            }
            SdkEvent::ClearInterim => {
                if std::mem::take(&mut has_interim)
                    && tx.send(TranscriptResult::clear_interim()).await.is_err()
                {
                    return;
                }
            }
            SdkEvent::Failed { reason } => {
                let again = retryable(&reason);
                retry.store(again, Ordering::Relaxed);
                status(
                    &session.app,
                    &party,
                    if again { "reconnecting" } else { "error" },
                    Some(reason.message()),
                );
                break;
            }
            SdkEvent::Closed => break,
            SdkEvent::Verified => (),
        }
    }
    if has_interim {
        let _ = tx.send(TranscriptResult::clear_interim()).await;
    }
}

pub struct AzureMaiSTT {
    app: AppHandle,
    key: String,
    region: String,
    language: String,
    party: String,
    muted: bool,
    result_tx: Option<mpsc::Sender<TranscriptResult>>,
    pcm_tx: Option<mpsc::Sender<Vec<u8>>>,
    task: Option<JoinHandle<()>>,
    resume: bool,
    resume_pcm: VecDeque<Vec<u8>>,
    resume_bytes: usize,
    host_generation: u64,
    /// Set by `collect` when its session ended on a failure worth retrying.
    retry: Arc<AtomicBool>,
    retry_at: Option<Instant>,
    backoff: Duration,
    connected_at: Option<Instant>,
}

impl AzureMaiSTT {
    pub fn new(app: AppHandle, key: String, region: String, party: &str) -> Self {
        Self {
            app,
            key,
            region,
            language: "auto".into(),
            party: party.into(),
            muted: false,
            result_tx: None,
            pcm_tx: None,
            task: None,
            resume: false,
            resume_pcm: VecDeque::new(),
            resume_bytes: 0,
            host_generation: 0,
            retry: Arc::new(AtomicBool::new(false)),
            retry_at: None,
            backoff: RETRY_FIRST,
            connected_at: None,
        }
    }

    fn retry_due(&mut self, now: Instant) -> bool {
        retry_due(
            self.retry.load(Ordering::Relaxed),
            now,
            self.connected_at,
            &mut self.retry_at,
            &mut self.backoff,
        )
    }

    fn connect(
        &mut self,
        config: Config,
        tx: mpsc::Sender<TranscriptResult>,
    ) -> Result<(), String> {
        let (session, pcm) = Session::open(&self.app, config, false)?;
        self.host_generation = session.host_generation;
        status(&self.app, &self.party, "connecting", None);
        for frame in self.resume_pcm.drain(..) {
            let _ = pcm.try_send(frame);
        }
        self.resume_bytes = 0;
        self.pcm_tx = Some(pcm);
        self.retry.store(false, Ordering::Relaxed);
        self.retry_at = None;
        self.connected_at = Some(Instant::now());
        self.task = Some(tokio::spawn(collect(
            session,
            self.party.clone(),
            tx,
            self.retry.clone(),
        )));
        Ok(())
    }
}

fn pcm_frame(timestamp_ms: u64, samples: &[i16]) -> Vec<u8> {
    // Frame per capture chunk: an 8-byte LE wall-clock timestamp, then raw PCM.
    let mut frame = Vec::with_capacity(8 + 2 * samples.len());
    frame.extend(timestamp_ms.to_le_bytes());
    frame.extend(samples.iter().flat_map(|sample| sample.to_le_bytes()));
    frame
}

fn drain_pcm_batch(mut frame: Vec<u8>, source: &mut mpsc::Receiver<Vec<u8>>) -> Vec<u8> {
    // A WebView IPC round trip can be slower than a device callback. Send any
    // PCM that arrived during the previous round trip with the next chunk,
    // without delaying a read to fill the batch.
    for _ in 0..AUDIO_QUEUE {
        let Ok(next) = source.try_recv() else { break };
        frame[..8].copy_from_slice(&next[..8]);
        frame.extend_from_slice(&next[8..]);
    }
    frame
}

#[async_trait]
impl STTProvider for AzureMaiSTT {
    fn provider_name(&self) -> &str {
        "Azure MAI Streaming"
    }
    fn provider_type(&self) -> STTProviderType {
        STTProviderType::AzureMaiStreaming
    }

    async fn start_stream(&mut self, tx: mpsc::Sender<TranscriptResult>) -> Result<(), SttError> {
        if self.result_tx.is_some() {
            return Err("Azure MAI Streaming is already active".into());
        }
        let config = Config::new(&self.key, &self.region, &self.language)?;
        if self.muted {
            status(&self.app, &self.party, "paused", None);
        } else {
            self.connect(config, tx.clone())?;
        }
        self.result_tx = Some(tx);
        Ok(())
    }

    async fn feed_audio(&mut self, chunk: AudioChunk) -> Result<(), SttError> {
        if self.muted || chunk.pcm_data.is_empty() {
            return Ok(());
        }
        let task_finished = self.task.as_ref().is_none_or(JoinHandle::is_finished);
        let host_changed = self
            .app
            .state::<MaiBridge>()
            .host_generation
            .load(Ordering::Relaxed)
            != self.host_generation;
        let retry_due = task_finished && self.retry_due(Instant::now());
        if (self.resume || host_changed || retry_due) && task_finished {
            if let Some(tx) = self.result_tx.clone() {
                let config = Config::new(&self.key, &self.region, &self.language)?;
                self.resume = false;
                self.retry_at = None;
                if let Err(error) = self.connect(config, tx) {
                    self.host_generation = self
                        .app
                        .state::<MaiBridge>()
                        .host_generation
                        .load(Ordering::Relaxed);
                    // The launcher may still be coming back: try again after the
                    // next backoff step rather than leaving this side dead.
                    self.retry.store(true, Ordering::Relaxed);
                    status(&self.app, &self.party, "error", Some(&error));
                    return Err(error.into());
                }
            }
        }
        if self.resume {
            let frame = pcm_frame(chunk.timestamp_ms, &chunk.pcm_data);
            self.resume_bytes += frame.len();
            self.resume_pcm.push_back(frame);
            while self.resume_bytes > RESUME_BYTES || self.resume_pcm.len() >= AUDIO_QUEUE {
                self.resume_bytes -= self.resume_pcm.pop_front().unwrap().len();
            }
            return Ok(());
        }
        if let Some(pcm_tx) = &self.pcm_tx {
            // Non-blocking; never stall the other party or replay stale audio.
            if let Ok(permit) = pcm_tx.try_reserve() {
                permit.send(pcm_frame(chunk.timestamp_ms, &chunk.pcm_data));
            }
        }
        Ok(())
    }

    async fn stop_stream(&mut self) -> Result<(), SttError> {
        self.resume = false;
        self.retry.store(false, Ordering::Relaxed);
        self.retry_at = None;
        self.resume_pcm.clear();
        self.resume_bytes = 0;
        self.pcm_tx = None;
        if let Some(mut task) = self.task.take() {
            if timeout(STOP_LIMIT, &mut task).await.is_err() {
                task.abort();
                let _ = task.await;
                if let Some(tx) = &self.result_tx {
                    let _ = tx.try_send(TranscriptResult::clear_interim());
                }
            }
        }
        self.result_tx = None;
        status(&self.app, &self.party, "disconnected", None);
        Ok(())
    }

    async fn test_connection(&self) -> Result<bool, SttError> {
        Ok(probe(&self.app, Config::new(&self.key, &self.region, "auto")?).await?)
    }

    fn set_language(&mut self, language: &str) {
        self.language = language.into();
    }

    fn set_muted(&mut self, muted: bool) {
        if self.muted == muted {
            return;
        }
        self.muted = muted;
        self.resume = !muted;
        if muted {
            self.pcm_tx = None; // EOF; drain the final before the next unmute.
            self.resume_pcm.clear();
            self.resume_bytes = 0;
            if self.result_tx.is_some() {
                status(&self.app, &self.party, "paused", None);
            }
        }
    }
}

impl Drop for AzureMaiSTT {
    fn drop(&mut self) {
        self.pcm_tx = None;
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_and_normalizes_speech_resource_settings() {
        let config = Config::new(" demo ", " SwedenCentral ", "auto").unwrap();
        assert_eq!(
            (&*config.key, &*config.region, config.language),
            ("demo", "swedencentral", None)
        );
        assert!(Config::new("", "centralus", "auto").is_err());
        assert!(Config::new("demo", "westeurope", "auto").is_err());
        assert_eq!(
            Config::new("demo", "eastus2", "uk-UA")
                .unwrap()
                .language
                .as_deref(),
            Some("uk-UA")
        );
    }

    #[test]
    fn a_stalled_or_dropped_session_is_retried_with_backoff() {
        let start = Instant::now();
        let (mut at, mut backoff) = (None, RETRY_FIRST);
        // Nothing to retry.
        assert!(!retry_due(false, start, Some(start), &mut at, &mut backoff));
        // The first call schedules, the attempt fires once the delay passes.
        assert!(!retry_due(true, start, Some(start), &mut at, &mut backoff));
        assert!(!retry_due(true, start + Duration::from_secs(1), Some(start), &mut at, &mut backoff));
        assert!(retry_due(true, start + RETRY_FIRST, Some(start), &mut at, &mut backoff));
        // Repeated failures double the wait up to the cap.
        let mut delays = vec![];
        for _ in 0..6 {
            at = None;
            retry_due(true, start, Some(start), &mut at, &mut backoff);
            delays.push(at.unwrap() - start);
        }
        assert_eq!(delays[0], Duration::from_secs(4));
        assert_eq!(*delays.last().unwrap(), RETRY_MAX);
        // A session that stayed up for a while starts over at the first delay.
        at = None;
        let later = start + RETRY_RESET_AFTER;
        retry_due(true, later, Some(start), &mut at, &mut backoff);
        assert_eq!(at.unwrap() - later, RETRY_FIRST);
    }

    #[test]
    fn only_transient_failures_are_retried() {
        assert!(retryable(&Failure::Network));
        assert!(retryable(&Failure::Launcher));
        assert!(retryable(&Failure::Sdk));
        assert!(!retryable(&Failure::Credentials));
        assert!(!retryable(&Failure::Model));
    }

    #[test]
    fn capture_frames_are_little_endian_pcm_without_wav_headers() {
        assert_eq!(
            pcm_frame(1, &[0x1234, -2]),
            [1, 0, 0, 0, 0, 0, 0, 0, 0x34, 0x12, 0xfe, 0xff]
        );
    }

    #[test]
    fn an_ipc_read_drains_queued_chunks_in_order_without_waiting() {
        let (tx, mut rx) = mpsc::channel(AUDIO_QUEUE);
        tx.try_send(pcm_frame(20, &[2, 3])).unwrap();
        tx.try_send(pcm_frame(30, &[4])).unwrap();
        assert_eq!(
            drain_pcm_batch(pcm_frame(10, &[1]), &mut rx),
            pcm_frame(30, &[1, 2, 3, 4])
        );
        assert!(rx.is_empty());
    }

    #[test]
    fn sdk_ipc_decodes_transcript_events_from_the_launcher() {
        let event: SdkEvent = serde_json::from_str(
            r#"{
            "kind":"transcript","text":"hello","isFinal":false,
            "timestampMs":1700000000000,"durationMs":150,"language":null
        }"#,
        )
        .unwrap();
        assert!(matches!(
            event,
            SdkEvent::Transcript {
                is_final: false,
                timestamp_ms: 1_700_000_000_000,
                duration_ms: Some(150),
                ..
            }
        ));
    }
}
