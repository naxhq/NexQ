//! Keeps a capture side running when its device goes away mid-meeting.
//!
//! cpal 0.18 reports a lost or changed device through the stream's error
//! callback (`StreamInvalidated`, `DeviceNotAvailable`, ...) and expects the
//! app to rebuild the stream. Each capture side ("You", "Them", or one shared
//! input for both) runs on its own thread that owns its stream. The error
//! callback only sends `(side, generation, error)` to that thread; the thread
//! drops the stream and opens it again, on the chosen device or else the
//! default one, with backoff. After a minute without a stream the side is
//! reported lost, once, and the thread keeps probing every few seconds until
//! the device is back. While the default device stands in for a missing chosen
//! one, the thread also probes for the chosen device and goes back to it.
//! Rebuilds never touch `AppState::audio`, the chunk channel, the recorder or
//! the other side.
//!
//! [`Supervisor`] is the thread's state machine. Opening a device
//! ([`CaptureOpener`]) and the time ([`Clock`]) are injected, so tests drive it
//! without hardware or waiting.

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;

use super::capture_common::{classify_stream_error, StreamErrorAction};

/// Errors that arrive together (a device going away reports more than one)
/// cause one rebuild, this long after the first.
pub const REBUILD_DEBOUNCE: Duration = Duration::from_millis(300);
/// Wait after each failed reopen, then `STEADY_RETRY` from there on.
const BACKOFF: [Duration; 4] = [
    Duration::from_millis(500),
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
];
/// The slow retry and the probe interval: how often a side that is lost, or
/// running on a stand-in device, looks for its device again.
const STEADY_RETRY: Duration = Duration::from_secs(5);
/// After this long without a stream the side is reported lost, once. It keeps
/// probing every `STEADY_RETRY` until its device is back or capture stops.
pub const GIVE_UP_AFTER: Duration = Duration::from_secs(60);
/// A reconnected stream that fails again sooner than this is the same outage:
/// the backoff and the minute keep running instead of starting over.
const STABLE_AFTER: Duration = Duration::from_secs(5);
/// How long starting capture waits for a side to open (a slow Bluetooth
/// device): past it the side carries on opening and start returns.
pub const START_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptureSide {
    You,
    Them,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptureState {
    Recovering,
    Recovered,
    Lost,
}

/// Payload of the `audio_capture_status` event. `message` is empty when there
/// is nothing to tell the user (reconnecting, or back on the same device).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CaptureStatus {
    pub side: CaptureSide,
    pub state: CaptureState,
    pub device: String,
    pub message: String,
}

/// Where a side's statuses go (the app emits them as events).
pub type StatusSink = Arc<dyn Fn(CaptureStatus) + Send + Sync>;

/// What a side captures. Decides its fallback and its wording.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureKind {
    /// "You": a microphone. A missing chosen mic falls back to the default one.
    Mic,
    /// "Them": what plays on an output (loopback). Falls back to the default output.
    Output,
    /// "Them" from an input device (a virtual cable, a room mic). No fallback:
    /// the default mic would be the user's own voice.
    InputThem,
    /// You and Them share one input device: one stream, each chunk tagged
    /// twice. No fallback, for the same reason.
    Dual,
}

impl CaptureKind {
    pub fn side(self) -> CaptureSide {
        match self {
            CaptureKind::Mic | CaptureKind::Dual => CaptureSide::You,
            CaptureKind::Output | CaptureKind::InputThem => CaptureSide::Them,
        }
    }

    fn falls_back(self) -> bool {
        matches!(self, CaptureKind::Mic | CaptureKind::Output)
    }

    fn label(self) -> &'static str {
        match self {
            CaptureKind::Mic => "Mic capture",
            CaptureKind::Output => "System capture",
            CaptureKind::InputThem => "Them input capture",
            CaptureKind::Dual => "Shared input capture",
        }
    }
}

/// The device an open attempt asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeviceChoice {
    Chosen(String),
    Default,
}

fn is_default_id(device_id: &str) -> bool {
    device_id.is_empty() || device_id == "default"
}

/// The devices a side tries, in order: the chosen one, then the default one
/// where that is safe (the same order as starting capture).
pub fn device_choices(kind: CaptureKind, device_id: &str) -> Vec<DeviceChoice> {
    if is_default_id(device_id) {
        vec![DeviceChoice::Default]
    } else if kind.falls_back() {
        vec![DeviceChoice::Chosen(device_id.to_string()), DeviceChoice::Default]
    } else {
        vec![DeviceChoice::Chosen(device_id.to_string())]
    }
}

/// An open stream (dropping it closes the device) and the device's name.
pub struct Opened<S> {
    pub stream: S,
    pub device: String,
}

/// Opens a side's stream. `generation` goes into the stream's error callback
/// so the side can tell its current stream's errors from an older one's.
pub trait CaptureOpener {
    type Stream;
    fn open(&mut self, choice: &DeviceChoice, generation: u64) -> Result<Opened<Self::Stream>, String>;
}

pub trait Clock {
    fn now(&self) -> Instant;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }
}

/// Per side, for the audio stats line.
#[derive(Debug, Default)]
pub struct CaptureCounters {
    pub xruns: AtomicU64,
    pub rebuilds: AtomicU64,
}

impl CaptureCounters {
    pub fn xruns(&self) -> u64 {
        self.xruns.load(Ordering::Relaxed)
    }
    pub fn rebuilds(&self) -> u64 {
        self.rebuilds.load(Ordering::Relaxed)
    }
}

/// What a side's thread receives.
#[derive(Debug)]
pub enum SideMessage {
    /// From a stream's error callback.
    StreamError {
        side: CaptureSide,
        generation: u64,
        error: cpal::Error,
    },
    /// Stop capture, End, or a Settings hot-swap: drop the stream, cancel any
    /// pending rebuild, end the thread.
    Stop,
}

/// Messages a side's thread can take before senders wait. Error callbacks
/// never wait: they drop a message when it is full.
const SIDE_CHANNEL_CAPACITY: usize = 64;

pub fn side_channel() -> (SyncSender<SideMessage>, Receiver<SideMessage>) {
    std::sync::mpsc::sync_channel(SIDE_CHANNEL_CAPACITY)
}

/// A stream's error callback: hands the error to its side's thread and
/// returns. Never blocks, never touches the stream.
pub fn error_callback(
    errors: SyncSender<SideMessage>,
    side: CaptureSide,
    generation: u64,
) -> impl FnMut(cpal::Error) + Send + 'static {
    move |error| {
        let _ = errors.try_send(SideMessage::StreamError { side, generation, error });
    }
}

/// A side's first open: the device it got, and why the chosen device was
/// passed over when the default replaced it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Started {
    pub device: String,
    pub replaced: Option<String>,
}

#[derive(Debug, Clone, Copy)]
enum Phase {
    Running,
    /// The stream failed: reopen at `due`. `outage_start` is the first error.
    Pending {
        due: Instant,
        outage_start: Instant,
        attempt: usize,
    },
    /// Reported lost. Probe for the device at `probe_due`, then every `STEADY_RETRY`.
    Lost { probe_due: Instant },
    Stopped,
}

type OpenedAt<S> = (u64, Opened<S>);

pub struct Supervisor<O: CaptureOpener, C: Clock> {
    kind: CaptureKind,
    device_id: String,
    opener: O,
    clock: C,
    stream: Option<O::Stream>,
    /// Counts open attempts: each takes a new generation.
    last_generation: u64,
    /// The current stream's generation.
    generation: u64,
    /// The current stream's device (the last one's while reconnecting or lost).
    device: String,
    phase: Phase,
    /// While running on a stand-in device: when to look for the chosen one again.
    stand_in_probe_due: Option<Instant>,
    /// The last stream error that made the side rebuild: a refused permission
    /// is told apart from a device that went away.
    permission_denied: bool,
    counters: Arc<CaptureCounters>,
    sink: StatusSink,
    /// Set by `SideHandle::request_stop`: cuts a reconnect short and keeps it
    /// from reporting anything afterwards.
    stop_requested: Arc<AtomicBool>,
    /// The last reconnect: when it succeeded, and the outage it ended
    /// (its start and how many attempts it took).
    last_recovery: Option<(Instant, Instant, usize)>,
}

impl<O: CaptureOpener, C: Clock> Supervisor<O, C> {
    pub fn new(
        kind: CaptureKind,
        device_id: &str,
        opener: O,
        clock: C,
        counters: Arc<CaptureCounters>,
        sink: StatusSink,
    ) -> Self {
        Self {
            kind,
            device_id: device_id.to_string(),
            opener,
            clock,
            stream: None,
            last_generation: 0,
            generation: 0,
            device: String::new(),
            phase: Phase::Stopped,
            stand_in_probe_due: None,
            permission_denied: false,
            counters,
            sink,
            stop_requested: Arc::new(AtomicBool::new(false)),
            last_recovery: None,
        }
    }

    fn with_stop_flag(mut self, stop_requested: Arc<AtomicBool>) -> Self {
        self.stop_requested = stop_requested;
        self
    }

    fn stopping(&self) -> bool {
        self.stop_requested.load(Ordering::SeqCst)
    }

    pub fn now(&self) -> Instant {
        self.clock.now()
    }

    /// The default device stands in for a chosen one that isn't there.
    fn on_stand_in(&self) -> bool {
        self.kind.falls_back() && !is_default_id(&self.device_id) && self.device != self.device_id
    }

    /// Make `opened` the current stream. The previous one is dropped only now,
    /// after the new one is open, so a swap leaves no gap. Returns the device
    /// that was current.
    fn adopt(&mut self, (generation, opened): OpenedAt<O::Stream>) -> String {
        let before = std::mem::replace(&mut self.device, opened.device);
        self.stream = Some(opened.stream);
        self.generation = generation;
        self.phase = Phase::Running;
        self.stand_in_probe_due = self.on_stand_in().then(|| self.clock.now() + STEADY_RETRY);
        before
    }

    /// The first open. On failure: the error of each device tried, in order.
    pub fn start(&mut self) -> Result<Started, Vec<String>> {
        let (opened, errors) = self.open_first();
        let opened = opened.ok_or_else(|| errors.clone())?;
        let device = opened.1.device.clone();
        self.adopt(opened);
        log::info!("{}: capturing '{}'", self.kind.label(), device);
        Ok(Started { device, replaced: errors.into_iter().next() })
    }

    /// Open one device. A stop request refuses it, and a panic inside a
    /// driver call counts as a failed attempt: it must not end the thread.
    fn try_open(&mut self, choice: &DeviceChoice) -> Result<OpenedAt<O::Stream>, String> {
        if self.stopping() {
            return Err("capture is stopping".to_string());
        }
        self.last_generation += 1;
        let generation = self.last_generation;
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.opener.open(choice, generation)))
            .unwrap_or_else(|_| Err("opening the device panicked".to_string()))
            .map(|opened| (generation, opened))
    }

    /// The chosen device, then the default one where that is safe.
    fn open_first(&mut self) -> (Option<OpenedAt<O::Stream>>, Vec<String>) {
        let mut errors = Vec::new();
        for choice in device_choices(self.kind, &self.device_id) {
            if self.stopping() {
                break;
            }
            match self.try_open(&choice) {
                Ok(opened) => return (Some(opened), errors),
                Err(e) => errors.push(e),
            }
        }
        (None, errors)
    }

    /// Handle one message. False once the side has stopped.
    pub fn on_message(&mut self, message: SideMessage) -> bool {
        match message {
            SideMessage::Stop => {
                self.stop();
                false
            }
            SideMessage::StreamError { side, generation, error } => {
                self.on_stream_error(side, generation, &error);
                true
            }
        }
    }

    pub fn on_stream_error(&mut self, side: CaptureSide, generation: u64, error: &cpal::Error) {
        let label = self.kind.label();
        match classify_stream_error(error.kind()) {
            StreamErrorAction::CountXrun => {
                self.counters.xruns.fetch_add(1, Ordering::Relaxed);
                log::debug!("{label}: {:?}: {error}", error.kind());
            }
            StreamErrorAction::Warn => log::warn!("{label}: {:?}: {error}", error.kind()),
            StreamErrorAction::Rebuild => {
                let current = side == self.kind.side()
                    && generation == self.generation
                    && matches!(self.phase, Phase::Running);
                if !current {
                    log::debug!(
                        "{label}: ignored {:?} from {side:?} stream {generation} (current {})",
                        error.kind(),
                        self.generation
                    );
                    return;
                }
                log::warn!("{label}: {:?}: {error}. Reconnecting '{}'", error.kind(), self.device);
                self.permission_denied = error.kind() == cpal::ErrorKind::PermissionDenied;
                self.stand_in_probe_due = None;
                let now = self.clock.now();
                // A stream that fails again right after reconnecting is the
                // same outage: the backoff goes on and the minute isn't reset.
                let carried = self
                    .last_recovery
                    .filter(|(at, _, _)| now.duration_since(*at) < STABLE_AFTER)
                    .map(|(_, start, attempts)| (start, attempts));
                match carried {
                    Some((start, _)) if now >= start + GIVE_UP_AFTER => {
                        log::error!("{label}: '{}' keeps failing; giving up", self.device);
                        self.go_lost(now);
                    }
                    Some((start, attempts)) => {
                        let due = (now + backoff(attempts)).min(start + GIVE_UP_AFTER);
                        self.phase = Phase::Pending { due, outage_start: start, attempt: attempts };
                        self.emit(CaptureState::Recovering, self.device.clone(), String::new());
                    }
                    None => {
                        self.phase = Phase::Pending { due: now + REBUILD_DEBOUNCE, outage_start: now, attempt: 0 };
                        self.emit(CaptureState::Recovering, self.device.clone(), String::new());
                    }
                }
            }
        }
    }

    /// Report the side lost (once) and start probing.
    fn go_lost(&mut self, now: Instant) {
        self.stream = None;
        self.stand_in_probe_due = None;
        self.phase = Phase::Lost { probe_due: now + STEADY_RETRY };
        self.emit(CaptureState::Lost, self.device.clone(), lost_message(self.kind, self.permission_denied));
    }

    /// Start returned before the first open finished, and it later failed on
    /// every device: the side is lost from the start, and keeps probing.
    fn begin_lost_at_start(&mut self) {
        self.device = self.device_id.clone();
        self.go_lost(self.clock.now());
    }

    /// Start returned before the first open finished, and the default device
    /// opened in place of the chosen one: say so, as a reconnect would.
    fn announce_late_start(&mut self, started: &Started) {
        if started.replaced.is_some() {
            let message = recovered_message(self.kind, &self.device_id, "", &started.device);
            self.emit(CaptureState::Recovered, started.device.clone(), message);
        }
    }

    /// Do what is due: a reconnect, a look for the chosen device while on a
    /// stand-in, or a probe after "lost". Returns when to call again, if ever.
    pub fn poll(&mut self) -> Option<Instant> {
        match self.phase {
            Phase::Pending { due, outage_start, attempt } => self.poll_pending(due, outage_start, attempt),
            Phase::Running => self.poll_stand_in(),
            Phase::Lost { probe_due } => self.poll_lost(probe_due),
            Phase::Stopped => None,
        }
    }

    fn poll_pending(&mut self, due: Instant, outage_start: Instant, attempt: usize) -> Option<Instant> {
        let now = self.clock.now();
        if now < due {
            return Some(due);
        }
        // Drop the failed stream before opening its replacement.
        self.stream = None;
        let label = self.kind.label();
        let (opened, errors) = self.open_first();
        if self.stopping() {
            // Stop arrived while opening: drop what opened, report nothing.
            drop(opened);
            self.stop();
            return None;
        }
        match opened {
            Some(opened) => {
                self.last_recovery = Some((now, outage_start, attempt + 1));
                let device = opened.1.device.clone();
                let before = self.adopt(opened);
                self.counters.rebuilds.fetch_add(1, Ordering::Relaxed);
                log::info!(
                    "{label}: reconnected on '{device}' after {} ms (attempt {})",
                    now.duration_since(outage_start).as_millis(),
                    attempt + 1
                );
                let message = recovered_message(self.kind, &self.device_id, &before, &device);
                self.emit(CaptureState::Recovered, device, message);
                self.poll_stand_in()
            }
            None => {
                log::warn!("{label}: reconnect attempt {} failed: {}", attempt + 1, errors.join("; "));
                let give_up_at = outage_start + GIVE_UP_AFTER;
                if now >= give_up_at {
                    log::error!("{label}: '{}' didn't come back; still probing", self.device);
                    self.go_lost(now);
                    return self.poll();
                }
                let next = (now + backoff(attempt)).min(give_up_at);
                self.phase = Phase::Pending { due: next, outage_start, attempt: attempt + 1 };
                Some(next)
            }
        }
    }

    /// Running on a stand-in: look for the chosen device. When it opens it
    /// takes over and the stand-in closes; when it doesn't, nothing is said.
    fn poll_stand_in(&mut self) -> Option<Instant> {
        let due = self.stand_in_probe_due?;
        let now = self.clock.now();
        if now < due {
            return Some(due);
        }
        let label = self.kind.label();
        let chosen = DeviceChoice::Chosen(self.device_id.clone());
        match self.try_open(&chosen) {
            Ok(opened) => {
                if self.stopping() {
                    drop(opened);
                    self.stop();
                    return None;
                }
                let device = opened.1.device.clone();
                let before = self.adopt(opened);
                self.counters.rebuilds.fetch_add(1, Ordering::Relaxed);
                log::info!("{label}: '{device}' is back (was on '{before}')");
                let message = recovered_message(self.kind, &self.device_id, &before, &device);
                self.emit(CaptureState::Recovered, device, message);
                None
            }
            Err(e) => {
                if self.stopping() {
                    self.stop();
                    return None;
                }
                log::debug!("{label}: '{}' not back yet: {e}", self.device_id);
                let next = now + STEADY_RETRY;
                self.stand_in_probe_due = Some(next);
                Some(next)
            }
        }
    }

    /// Lost: try to open again. Success is told with a message every time.
    fn poll_lost(&mut self, probe_due: Instant) -> Option<Instant> {
        let now = self.clock.now();
        if now < probe_due {
            return Some(probe_due);
        }
        let label = self.kind.label();
        let (opened, errors) = self.open_first();
        if self.stopping() {
            drop(opened);
            self.stop();
            return None;
        }
        match opened {
            Some(opened) => {
                let device = opened.1.device.clone();
                let before = self.adopt(opened);
                self.counters.rebuilds.fetch_add(1, Ordering::Relaxed);
                log::info!("{label}: back on '{device}' after being lost");
                let mut message = recovered_message(self.kind, &self.device_id, &before, &device);
                if message.is_empty() {
                    message = back_message(self.kind, &device);
                }
                self.emit(CaptureState::Recovered, device, message);
                self.poll_stand_in()
            }
            None => {
                log::debug!("{label}: still lost: {}", errors.join("; "));
                let next = now + STEADY_RETRY;
                self.phase = Phase::Lost { probe_due: next };
                Some(next)
            }
        }
    }

    /// Drop the stream and cancel any pending rebuild or probe.
    pub fn stop(&mut self) {
        self.stream = None;
        self.stand_in_probe_due = None;
        self.phase = Phase::Stopped;
    }

    /// Report a status, unless the side is stopping: what is still queued from
    /// before Stop must not show up after it.
    fn emit(&self, state: CaptureState, device: String, message: String) {
        if self.stopping() {
            return;
        }
        (self.sink)(CaptureStatus { side: self.kind.side(), state, device, message });
    }
}

fn backoff(attempt: usize) -> Duration {
    BACKOFF.get(attempt).copied().unwrap_or(STEADY_RETRY)
}

/// What to tell the user after a reconnect: nothing when the device is the
/// same, otherwise which device is now in use.
fn recovered_message(kind: CaptureKind, device_id: &str, before: &str, now: &str) -> String {
    if now == before {
        return String::new();
    }
    // The chosen device is gone and the default stands in for it.
    let stand_in = !is_default_id(device_id) && now != device_id;
    match (kind, stand_in) {
        (CaptureKind::Mic, true) => format!("Your microphone disconnected. Using {now} for now."),
        (CaptureKind::Mic, false) => format!("Now using {now} as your microphone."),
        (CaptureKind::Output, true) => {
            format!("The speakers or headphones you hear the call on disconnected. Listening on {now} instead.")
        }
        (CaptureKind::Output, false) => format!("Now listening on {now} for the other side."),
        (CaptureKind::InputThem, _) => format!("Now capturing the other side from {now}."),
        (CaptureKind::Dual, _) => format!("Now using {now} for you and the other side."),
    }
}

/// After "lost", the device is back on the same one: always worth a line.
fn back_message(kind: CaptureKind, device: &str) -> String {
    match kind {
        CaptureKind::Mic => format!("{device} is back as your microphone."),
        CaptureKind::Output => format!("{device} is back. Listening for the other side again."),
        CaptureKind::InputThem => format!("{device} is back. Capturing the other side again."),
        CaptureKind::Dual => format!("{device} is back for you and the other side."),
    }
}

fn lost_message(kind: CaptureKind, permission_denied: bool) -> String {
    let system = if cfg!(target_os = "macos") { "macOS" } else { "Windows" };
    if permission_denied {
        return match kind {
            CaptureKind::Output => format!(
                "{system} privacy settings are blocking NexQ from capturing the call's audio. Allow it in {system} settings and NexQ reconnects."
            ),
            _ => format!(
                "{system} privacy settings are blocking your microphone. Allow microphone access for NexQ in {system} settings and NexQ reconnects."
            ),
        };
    }
    match kind {
        CaptureKind::Mic => "Your microphone disconnected. NexQ reconnects it when it's back, or pick another microphone in Audio & Devices.",
        CaptureKind::Output => "The speakers or headphones you hear the call on disconnected. NexQ reconnects them when they're back, or pick another device in Audio & Devices.",
        CaptureKind::InputThem => "The device the other side comes in on disconnected. NexQ reconnects it when it's back, or pick another device in Audio & Devices.",
        CaptureKind::Dual => "Your shared input device disconnected. NexQ reconnects it when it's back, or pick another device in Audio & Devices.",
    }
    .to_string()
}

/// A running side: its thread and the channel that reaches it.
pub struct SideHandle {
    kind: CaptureKind,
    messages: SyncSender<SideMessage>,
    stop_requested: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl SideHandle {
    pub fn kind(&self) -> CaptureKind {
        self.kind
    }

    /// Ask the thread to stop; `join` waits for it. Never waits itself: the
    /// flag reaches a reconnect in progress, the message wakes an idle thread.
    pub fn request_stop(&self) {
        self.stop_requested.store(true, Ordering::SeqCst);
        let _ = self.messages.try_send(SideMessage::Stop);
    }

    pub fn join(mut self) {
        self.join_inner();
    }

    fn join_inner(&mut self) {
        if let Some(thread) = self.thread.take() {
            self.request_stop();
            let _ = thread.join();
        }
    }
}

impl Drop for SideHandle {
    fn drop(&mut self) {
        self.join_inner();
    }
}

/// What `spawn_side` needs to start a side.
pub struct SideSpec<O, C> {
    pub kind: CaptureKind,
    pub device_id: String,
    pub opener: O,
    pub clock: C,
    pub counters: Arc<CaptureCounters>,
    pub sink: StatusSink,
    /// How long to wait for the first open before carrying on without it.
    pub start_timeout: Duration,
}

/// Start a side's thread and wait up to `spec.start_timeout` for its first
/// open. `messages` is the channel the opener's error callbacks send to.
///
/// Returns the handle and, unless the open is still going after the timeout,
/// what it opened. On failure the thread has ended. A first open that finishes
/// after the timeout is reported like a reconnect: a stand-in device as
/// "recovered", no device at all as "lost" (and the side keeps probing).
pub fn spawn_side<O, C>(
    spec: SideSpec<O, C>,
    messages: (SyncSender<SideMessage>, Receiver<SideMessage>),
) -> Result<(SideHandle, Option<Started>), Vec<String>>
where
    O: CaptureOpener + Send + 'static,
    C: Clock + Send + 'static,
{
    spawn_side_with(spec, messages, None)
}

/// Who owns the first open's outcome. The thread claims it (WAITING -> DONE)
/// and sends it, or finds start has given up (ABANDONED) and reports it
/// itself. Exactly one of the two happens, so an outcome is never sent to a
/// start that has stopped listening.
const WAITING: u8 = 0;
const DONE: u8 = 1;
const ABANDONED: u8 = 2;

/// Runs after the wait timed out and before start gives up on it. Only tests
/// pass one, to let the thread claim the outcome in that gap.
type BeforeAbandon = Box<dyn FnOnce(&AtomicU8) + Send>;

fn spawn_side_with<O, C>(
    spec: SideSpec<O, C>,
    messages: (SyncSender<SideMessage>, Receiver<SideMessage>),
    before_abandon: Option<BeforeAbandon>,
) -> Result<(SideHandle, Option<Started>), Vec<String>>
where
    O: CaptureOpener + Send + 'static,
    C: Clock + Send + 'static,
{
    let SideSpec { kind, device_id, opener, clock, counters, sink, start_timeout } = spec;
    let (tx, rx) = messages;
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<Started, Vec<String>>>();
    let handoff = Arc::new(AtomicU8::new(WAITING));
    let thread_handoff = Arc::clone(&handoff);
    let stop_requested = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop_requested);
    let thread_name = match kind.side() {
        CaptureSide::You => "capture-you",
        CaptureSide::Them => "capture-them",
    };
    let thread = std::thread::Builder::new()
        .name(thread_name.into())
        .spawn(move || {
            let mut supervisor =
                Supervisor::new(kind, &device_id, opener, clock, counters, sink).with_stop_flag(thread_stop);
            let result = supervisor.start();
            // Claim the outcome for start, or find that start has gone on.
            let claimed =
                thread_handoff.compare_exchange(WAITING, DONE, Ordering::SeqCst, Ordering::SeqCst).is_ok();
            match result {
                Ok(started) => {
                    if claimed {
                        let _ = ready_tx.send(Ok(started));
                    } else {
                        supervisor.announce_late_start(&started);
                    }
                    run_side(&mut supervisor, &rx);
                }
                Err(errors) => {
                    if claimed {
                        let _ = ready_tx.send(Err(errors));
                    } else if !supervisor.stopping() {
                        supervisor.begin_lost_at_start();
                        run_side(&mut supervisor, &rx);
                    }
                }
            }
        })
        .map_err(|e| vec![format!("Failed to start the capture thread: {e}")])?;
    let handle = SideHandle { kind, messages: tx, stop_requested, thread: Some(thread) };

    let outcome = match ready_rx.recv_timeout(start_timeout) {
        Err(RecvTimeoutError::Timeout) => {
            if let Some(hook) = before_abandon {
                hook(&handoff);
            }
            if handoff.compare_exchange(WAITING, ABANDONED, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
                log::warn!("{} is slow to start; it keeps opening in the background", kind.label());
                return Ok((handle, None));
            }
            // The thread claimed the outcome just now: it is sending it.
            ready_rx.recv().map_err(|_| RecvTimeoutError::Disconnected)
        }
        other => other,
    };
    match outcome {
        Ok(Ok(started)) => Ok((handle, Some(started))),
        Ok(Err(errors)) => Err(errors), // the thread has ended; dropping the handle joins it
        Err(_) => Err(vec!["The capture thread ended before starting".to_string()]),
    }
}

/// A side's thread after its first open: wait for an error, something due
/// or Stop.
fn run_side<O: CaptureOpener, C: Clock>(supervisor: &mut Supervisor<O, C>, rx: &Receiver<SideMessage>) {
    loop {
        if supervisor.stopping() {
            break;
        }
        let message = match supervisor.poll() {
            Some(due) => match rx.recv_timeout(due.saturating_duration_since(supervisor.now())) {
                Ok(message) => message,
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => break,
            },
            None => match rx.recv() {
                Ok(message) => message,
                Err(_) => break,
            },
        };
        if !supervisor.on_message(message) {
            return;
        }
    }
    supervisor.stop();
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::Mutex;

    /// A clock tests move by hand.
    #[derive(Clone)]
    pub struct FakeClock(Arc<Mutex<Instant>>);

    impl FakeClock {
        pub fn new() -> Self {
            Self(Arc::new(Mutex::new(Instant::now())))
        }
        pub fn advance(&self, by: Duration) {
            *self.0.lock().unwrap() += by;
        }
    }

    impl Clock for FakeClock {
        fn now(&self) -> Instant {
            *self.0.lock().unwrap()
        }
    }

    /// Shared record of what fake openers did, for every side.
    #[derive(Default)]
    pub struct OpenLog {
        /// (side, choice, time) of every open attempt.
        pub attempts: Vec<(CaptureSide, DeviceChoice, Instant)>,
        /// Streams open right now, per side.
        pub live: [usize; 2],
    }

    fn slot(side: CaptureSide) -> usize {
        match side {
            CaptureSide::You => 0,
            CaptureSide::Them => 1,
        }
    }

    pub struct FakeStream {
        side: CaptureSide,
        log: Arc<Mutex<OpenLog>>,
    }

    impl Drop for FakeStream {
        fn drop(&mut self) {
            // Not unwrap: a test that failed while holding the lock mustn't abort here.
            if let Ok(mut log) = self.log.lock() {
                log.live[slot(self.side)] -= 1;
            }
        }
    }

    /// Opens the devices in `present`; "default" is the default device.
    pub struct FakeOpener {
        pub side: CaptureSide,
        pub present: Arc<Mutex<Vec<String>>>,
        pub default_device: String,
        pub log: Arc<Mutex<OpenLog>>,
        pub clock: FakeClock,
    }

    impl CaptureOpener for FakeOpener {
        type Stream = FakeStream;
        fn open(&mut self, choice: &DeviceChoice, _generation: u64) -> Result<Opened<FakeStream>, String> {
            let mut log = self.log.lock().unwrap();
            log.attempts.push((self.side, choice.clone(), self.clock.now()));
            let name = match choice {
                DeviceChoice::Chosen(name) => name.clone(),
                DeviceChoice::Default => self.default_device.clone(),
            };
            if !self.present.lock().unwrap().contains(&name) {
                return Err(format!("'{name}' not found"));
            }
            log.live[slot(self.side)] += 1;
            Ok(Opened { stream: FakeStream { side: self.side, log: Arc::clone(&self.log) }, device: name })
        }
    }

    pub struct Rig {
        pub clock: FakeClock,
        pub present: Arc<Mutex<Vec<String>>>,
        pub log: Arc<Mutex<OpenLog>>,
        pub statuses: Arc<Mutex<Vec<CaptureStatus>>>,
        pub counters: Arc<CaptureCounters>,
    }

    impl Rig {
        pub fn new(present: &[&str]) -> Self {
            Self {
                clock: FakeClock::new(),
                present: Arc::new(Mutex::new(present.iter().map(|s| s.to_string()).collect())),
                log: Arc::default(),
                statuses: Arc::default(),
                counters: Arc::default(),
            }
        }

        pub fn opener(&self, side: CaptureSide, default_device: &str) -> FakeOpener {
            FakeOpener {
                side,
                present: Arc::clone(&self.present),
                default_device: default_device.to_string(),
                log: Arc::clone(&self.log),
                clock: self.clock.clone(),
            }
        }

        pub fn sink(&self) -> StatusSink {
            let statuses = Arc::clone(&self.statuses);
            Arc::new(move |status| statuses.lock().unwrap().push(status))
        }

        fn supervisor(&self, kind: CaptureKind, device_id: &str, default_device: &str) -> Supervisor<FakeOpener, FakeClock> {
            Supervisor::new(
                kind,
                device_id,
                self.opener(kind.side(), default_device),
                self.clock.clone(),
                Arc::clone(&self.counters),
                self.sink(),
            )
        }

        pub fn unplug(&self, name: &str) {
            self.present.lock().unwrap().retain(|n| n != name);
        }

        pub fn attempts(&self, side: CaptureSide) -> usize {
            self.log.lock().unwrap().attempts.iter().filter(|a| a.0 == side).count()
        }

        pub fn live(&self, side: CaptureSide) -> usize {
            self.log.lock().unwrap().live[slot(side)]
        }

        pub fn states(&self) -> Vec<CaptureState> {
            self.statuses.lock().unwrap().iter().map(|s| s.state).collect()
        }

        /// Advance in steps, polling like the side thread would.
        fn run_for<O: CaptureOpener>(&self, sup: &mut Supervisor<O, FakeClock>, total: Duration) {
            let step = Duration::from_millis(50);
            let mut elapsed = Duration::ZERO;
            while elapsed < total {
                self.clock.advance(step);
                elapsed += step;
                sup.poll();
            }
        }
    }

    fn err(kind: cpal::ErrorKind) -> cpal::Error {
        cpal::Error::new(kind)
    }

    fn invalidated(sup: &mut Supervisor<FakeOpener, FakeClock>, side: CaptureSide) {
        let generation = sup.generation;
        sup.on_stream_error(side, generation, &err(cpal::ErrorKind::StreamInvalidated));
    }

    #[test]
    fn choices_fall_back_to_the_default_only_where_safe() {
        use DeviceChoice::*;
        let headset = || Chosen("Headset".to_string());
        assert_eq!(device_choices(CaptureKind::Mic, "Headset"), vec![headset(), Default]);
        assert_eq!(device_choices(CaptureKind::Output, "Headset"), vec![headset(), Default]);
        assert_eq!(device_choices(CaptureKind::InputThem, "Headset"), vec![headset()]);
        assert_eq!(device_choices(CaptureKind::Dual, "Headset"), vec![headset()]);
        assert_eq!(device_choices(CaptureKind::Mic, "default"), vec![Default]);
        assert_eq!(device_choices(CaptureKind::Output, ""), vec![Default]);
    }

    /// (a)
    #[test]
    fn stream_invalidated_reopens_once_on_the_same_device() {
        let rig = Rig::new(&["Realtek"]);
        let mut sup = rig.supervisor(CaptureKind::Mic, "default", "Realtek");
        sup.start().unwrap();
        invalidated(&mut sup, CaptureSide::You);
        rig.run_for(&mut sup, Duration::from_secs(10));

        assert_eq!(rig.attempts(CaptureSide::You), 2, "start + one reopen");
        assert_eq!(rig.live(CaptureSide::You), 1);
        assert_eq!(rig.states(), vec![CaptureState::Recovering, CaptureState::Recovered]);
        let statuses = rig.statuses.lock().unwrap();
        assert_eq!(statuses[1].device, "Realtek");
        assert_eq!(statuses[1].message, "", "same device: nothing to tell the user");
        assert_eq!(rig.counters.rebuilds(), 1);
    }

    /// (b)
    #[test]
    fn a_missing_named_mic_falls_back_to_the_default_and_says_so_once() {
        let rig = Rig::new(&["Headset", "Microphone (Realtek)"]);
        let mut sup = rig.supervisor(CaptureKind::Mic, "Headset", "Microphone (Realtek)");
        assert_eq!(sup.start().unwrap(), Started { device: "Headset".into(), replaced: None });
        rig.unplug("Headset");
        let generation = sup.generation;
        sup.on_stream_error(CaptureSide::You, generation, &err(cpal::ErrorKind::DeviceNotAvailable));
        rig.run_for(&mut sup, Duration::from_secs(2));

        let statuses = rig.statuses.lock().unwrap();
        let recovered: Vec<_> = statuses.iter().filter(|s| s.state == CaptureState::Recovered).collect();
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].side, CaptureSide::You);
        assert_eq!(recovered[0].device, "Microphone (Realtek)");
        assert_eq!(
            recovered[0].message,
            "Your microphone disconnected. Using Microphone (Realtek) for now."
        );
        let log = rig.log.lock().unwrap();
        let reopen: Vec<_> = log.attempts[1..].iter().map(|a| a.1.clone()).collect();
        assert_eq!(reopen, vec![DeviceChoice::Chosen("Headset".into()), DeviceChoice::Default]);
        assert_eq!(log.live[0], 1);
    }

    /// (c)
    #[test]
    fn errors_together_cause_one_reopen() {
        let rig = Rig::new(&["Realtek"]);
        let mut sup = rig.supervisor(CaptureKind::Mic, "default", "Realtek");
        sup.start().unwrap();
        for _ in 0..5 {
            invalidated(&mut sup, CaptureSide::You);
            rig.clock.advance(Duration::from_millis(50));
            sup.poll();
        }
        assert_eq!(rig.attempts(CaptureSide::You), 1, "nothing reopened inside the debounce");
        rig.run_for(&mut sup, Duration::from_secs(5));
        assert_eq!(rig.attempts(CaptureSide::You), 2);
        assert_eq!(rig.states(), vec![CaptureState::Recovering, CaptureState::Recovered]);
    }

    /// (d)
    #[test]
    fn an_error_from_an_old_stream_is_ignored() {
        let rig = Rig::new(&["Realtek"]);
        let mut sup = rig.supervisor(CaptureKind::Mic, "default", "Realtek");
        sup.start().unwrap();
        let first = sup.generation;
        invalidated(&mut sup, CaptureSide::You);
        rig.run_for(&mut sup, Duration::from_secs(1));
        assert_ne!(sup.generation, first);

        // A late error from the stream that was replaced.
        sup.on_stream_error(CaptureSide::You, first, &err(cpal::ErrorKind::DeviceNotAvailable));
        rig.run_for(&mut sup, Duration::from_secs(5));
        assert_eq!(rig.attempts(CaptureSide::You), 2);
        assert_eq!(rig.states(), vec![CaptureState::Recovering, CaptureState::Recovered]);
    }

    /// (e)
    #[test]
    fn when_nothing_opens_it_backs_off_reports_lost_once_and_keeps_probing() {
        let rig = Rig::new(&["Headset", "Realtek"]);
        let mut sup = rig.supervisor(CaptureKind::Mic, "Headset", "Realtek");
        sup.start().unwrap();
        let t0 = rig.clock.now();
        rig.unplug("Headset");
        rig.unplug("Realtek");
        invalidated(&mut sup, CaptureSide::You);
        rig.run_for(&mut sup, Duration::from_secs(120));

        let log = rig.log.lock().unwrap();
        // Each reconnect tries the headset, then the default: take the headset tries.
        let times: Vec<u128> = log.attempts[1..]
            .iter()
            .filter(|a| a.1 == DeviceChoice::Chosen("Headset".into()))
            .map(|a| a.2.duration_since(t0).as_millis())
            .filter(|ms| *ms <= 60_000)
            .collect();
        let mut expected = vec![300, 800, 1800, 3800, 7800];
        let mut t = 7800;
        while t + 5000 < 60_000 {
            t += 5000;
            expected.push(t);
        }
        expected.push(60_000);
        assert_eq!(times, expected);
        assert_eq!(log.live[0], 0);
        drop(log);

        let statuses = rig.statuses.lock().unwrap();
        let lost: Vec<_> = statuses.iter().filter(|s| s.state == CaptureState::Lost).collect();
        assert_eq!(lost.len(), 1, "lost is reported once");
        assert_eq!(lost[0].device, "Headset");
        assert!(lost[0].message.contains("microphone"));
        assert!(sup.poll().is_some(), "after lost it keeps probing");
    }

    /// (f)
    #[test]
    fn stop_during_backoff_cancels_the_reopen() {
        let rig = Rig::new(&["Realtek"]);
        let mut sup = rig.supervisor(CaptureKind::Mic, "default", "Realtek");
        sup.start().unwrap();
        rig.unplug("Realtek");
        invalidated(&mut sup, CaptureSide::You);
        rig.run_for(&mut sup, Duration::from_millis(500)); // first reopen failed, backing off
        assert_eq!(rig.attempts(CaptureSide::You), 2);

        assert!(!sup.on_message(SideMessage::Stop));
        rig.present.lock().unwrap().push("Realtek".into());
        rig.run_for(&mut sup, Duration::from_secs(70));
        assert_eq!(rig.attempts(CaptureSide::You), 2, "nothing opened after Stop");
        assert_eq!(rig.live(CaptureSide::You), 0);
        assert!(!rig.states().contains(&CaptureState::Lost));
    }

    /// (g)
    #[test]
    fn an_error_on_you_never_reopens_them() {
        let rig = Rig::new(&["Mic", "Speakers"]);
        let mut you = rig.supervisor(CaptureKind::Mic, "Mic", "Mic");
        let mut them = rig.supervisor(CaptureKind::Output, "Speakers", "Speakers");
        you.start().unwrap();
        them.start().unwrap();

        // The same generation number on both sides: only the side tag tells them apart.
        let generation = you.generation;
        them.on_stream_error(CaptureSide::You, generation, &err(cpal::ErrorKind::StreamInvalidated));
        you.on_stream_error(CaptureSide::You, generation, &err(cpal::ErrorKind::StreamInvalidated));
        for _ in 0..100 {
            rig.clock.advance(Duration::from_millis(50));
            you.poll();
            them.poll();
        }
        assert_eq!(rig.attempts(CaptureSide::You), 2);
        assert_eq!(rig.attempts(CaptureSide::Them), 1, "Them only opened at start");
        assert_eq!((rig.live(CaptureSide::You), rig.live(CaptureSide::Them)), (1, 1));
        assert!(rig.statuses.lock().unwrap().iter().all(|s| s.side == CaptureSide::You));
    }

    /// A stream that dies right after every reconnect is one outage: backoff
    /// grows, the minute isn't reset, and it ends in one "lost".
    #[test]
    fn a_stream_that_keeps_failing_backs_off_and_is_given_up_on() {
        let rig = Rig::new(&["Realtek"]);
        let mut sup = rig.supervisor(CaptureKind::Mic, "default", "Realtek");
        sup.start().unwrap();
        let mut last_recovery = rig.clock.now();
        invalidated(&mut sup, CaptureSide::You);
        for _ in 0..(150 * 20) {
            if rig.states().contains(&CaptureState::Lost) {
                break;
            }
            rig.clock.advance(Duration::from_millis(50));
            let before = sup.last_recovery;
            sup.poll();
            if sup.last_recovery != before {
                last_recovery = rig.clock.now();
            }
            if matches!(sup.phase, Phase::Running)
                && rig.clock.now().duration_since(last_recovery) >= Duration::from_millis(100)
            {
                invalidated(&mut sup, CaptureSide::You);
            }
        }
        let lost = rig.states().iter().filter(|s| **s == CaptureState::Lost).count();
        assert_eq!(lost, 1, "one lost");
        let attempts = rig.attempts(CaptureSide::You);
        assert!((10..=25).contains(&attempts), "a reopen every few seconds, not several a second: {attempts}");
        assert_eq!(rig.live(CaptureSide::You), 0);
    }

    /// An open that is still going when Stop arrives gives up between devices
    /// and reports nothing.
    #[test]
    fn stop_while_reconnecting_reports_nothing() {
        let rig = Rig::new(&["Headset", "Realtek"]);
        let mut sup = rig.supervisor(CaptureKind::Mic, "Headset", "Realtek");
        sup.start().unwrap();
        invalidated(&mut sup, CaptureSide::You);
        rig.clock.advance(REBUILD_DEBOUNCE);
        sup.stop_requested.store(true, Ordering::SeqCst);
        sup.poll();
        assert_eq!(rig.states(), vec![CaptureState::Recovering], "no recovered after Stop");
        assert_eq!(rig.live(CaptureSide::You), 0);
        assert_eq!(rig.attempts(CaptureSide::You), 1, "Stop before the first device was tried");
    }

    /// A panic inside a driver call is a failed attempt, not a dead side.
    #[test]
    fn a_panicking_open_counts_as_a_failed_attempt() {
        struct Panics(bool);
        impl CaptureOpener for Panics {
            type Stream = ();
            fn open(&mut self, _: &DeviceChoice, _: u64) -> Result<Opened<()>, String> {
                if std::mem::replace(&mut self.0, true) {
                    panic!("driver bug");
                }
                Ok(Opened { stream: (), device: "Mic".into() })
            }
        }
        let rig = Rig::new(&[]);
        let mut sup = Supervisor::new(
            CaptureKind::Mic,
            "default",
            Panics(false),
            rig.clock.clone(),
            Arc::clone(&rig.counters),
            rig.sink(),
        );
        sup.start().unwrap();
        sup.on_stream_error(CaptureSide::You, sup.generation, &err(cpal::ErrorKind::StreamInvalidated));
        rig.run_for(&mut sup, Duration::from_secs(2));
        assert!(rig.states().contains(&CaptureState::Recovering));
        assert!(matches!(sup.phase, Phase::Pending { .. }), "still trying");
    }

    /// An opener whose first open waits until the test lets it go, so "start
    /// stopped waiting" doesn't depend on timing.
    struct Gated {
        gate: Option<std::sync::mpsc::Receiver<()>>,
        outcome: fn(&DeviceChoice) -> Result<Opened<()>, String>,
    }

    impl CaptureOpener for Gated {
        type Stream = ();
        fn open(&mut self, choice: &DeviceChoice, _: u64) -> Result<Opened<()>, String> {
            if let Some(gate) = self.gate.take() {
                let _ = gate.recv();
            }
            (self.outcome)(choice)
        }
    }

    fn spawn_gated(
        rig: &Rig,
        kind: CaptureKind,
        device_id: &str,
        outcome: fn(&DeviceChoice) -> Result<Opened<()>, String>,
    ) -> (SideHandle, std::sync::mpsc::Sender<()>) {
        let (gate_tx, gate_rx) = std::sync::mpsc::channel();
        let (handle, started) = spawn_side(
            SideSpec {
                kind,
                device_id: device_id.to_string(),
                opener: Gated { gate: Some(gate_rx), outcome },
                clock: SystemClock,
                counters: Arc::clone(&rig.counters),
                sink: rig.sink(),
                start_timeout: Duration::from_millis(30),
            },
            side_channel(),
        )
        .unwrap();
        assert!(started.is_none(), "still opening when start stopped waiting");
        (handle, gate_tx)
    }

    fn wait_for(done: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !done() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// M2: the first open fails after start stopped waiting: lost, once, at once.
    #[test]
    fn a_late_start_failure_is_reported_lost_once() {
        let rig = Rig::new(&[]);
        let (handle, release) =
            spawn_gated(&rig, CaptureKind::InputThem, "Mic", |_| Err("busy".to_string()));
        release.send(()).unwrap();
        wait_for(|| rig.states().contains(&CaptureState::Lost));
        assert_eq!(rig.states(), vec![CaptureState::Lost]);
        handle.join();
        assert_eq!(rig.states(), vec![CaptureState::Lost], "Stop adds nothing");
    }

    /// M2: and the side that is lost from the start retries, and is told when it is back.
    #[test]
    fn a_late_start_failure_is_retried() {
        let rig = Rig::new(&[]);
        let mut sup = rig.supervisor(CaptureKind::InputThem, "Mic", "Realtek");
        sup.begin_lost_at_start();
        assert_eq!(rig.states(), vec![CaptureState::Lost]);
        rig.run_for(&mut sup, Duration::from_secs(12)); // two probes fail quietly
        assert_eq!(rig.states(), vec![CaptureState::Lost]);

        rig.present.lock().unwrap().push("Mic".into());
        rig.run_for(&mut sup, Duration::from_secs(6));
        let statuses = rig.statuses.lock().unwrap();
        assert_eq!(statuses.len(), 2);
        assert_eq!(statuses[1].state, CaptureState::Recovered);
        assert_eq!(statuses[1].message, "Mic is back. Capturing the other side again.");
        drop(statuses);
        assert_eq!(rig.live(CaptureSide::Them), 1);
    }

    /// M2: the first open ends on the default device after start stopped
    /// waiting: it is told like a reconnect.
    #[test]
    fn a_late_start_on_the_default_device_is_announced() {
        let rig = Rig::new(&[]);
        let (handle, release) = spawn_gated(&rig, CaptureKind::Mic, "Headset", |choice| match choice {
            DeviceChoice::Chosen(_) => Err("not found".to_string()),
            DeviceChoice::Default => Ok(Opened { stream: (), device: "Microphone (Realtek)".into() }),
        });
        release.send(()).unwrap();
        wait_for(|| rig.states().contains(&CaptureState::Recovered));
        let statuses = rig.statuses.lock().unwrap();
        assert_eq!(statuses.len(), 1);
        assert_eq!(statuses[0].state, CaptureState::Recovered);
        assert_eq!(statuses[0].message, "Your microphone disconnected. Using Microphone (Realtek) for now.");
        drop(statuses);
        handle.join();
    }

    /// M2: a late first open on the chosen device itself says nothing.
    #[test]
    fn a_late_start_on_the_chosen_device_says_nothing() {
        let rig = Rig::new(&[]);
        let mut sup = rig.supervisor(CaptureKind::Mic, "Headset", "Realtek");
        sup.announce_late_start(&Started { device: "Headset".into(), replaced: None });
        assert!(rig.statuses.lock().unwrap().is_empty());
        sup.announce_late_start(&Started { device: "Realtek".into(), replaced: Some("gone".into()) });
        assert_eq!(rig.states(), vec![CaptureState::Recovered]);
    }

    /// B2: an error queued before Stop reports nothing after it.
    #[test]
    fn a_stream_error_queued_before_stop_emits_nothing() {
        let rig = Rig::new(&["Realtek"]);
        let mut sup = rig.supervisor(CaptureKind::Mic, "default", "Realtek");
        sup.start().unwrap();
        sup.stop_requested.store(true, Ordering::SeqCst);
        let generation = sup.generation;
        sup.on_message(SideMessage::StreamError {
            side: CaptureSide::You,
            generation,
            error: err(cpal::ErrorKind::StreamInvalidated),
        });
        assert!(rig.statuses.lock().unwrap().is_empty());
    }

    /// Stopping every side closes the audio channel, so the processing loop ends.
    #[test]
    fn stopping_a_side_releases_the_audio_channel() {
        struct Holds(tokio::sync::mpsc::Sender<u8>);
        impl CaptureOpener for Holds {
            type Stream = ();
            fn open(&mut self, _: &DeviceChoice, _: u64) -> Result<Opened<()>, String> {
                let _ = self.0.try_send(1);
                Ok(Opened { stream: (), device: "Mic".into() })
            }
        }
        let rig = Rig::new(&[]);
        let (audio_tx, mut audio_rx) = tokio::sync::mpsc::channel(4);
        let (tx, rx) = side_channel();
        let (handle, _) = spawn_side(
            SideSpec {
                kind: CaptureKind::Mic,
                device_id: "default".to_string(),
                opener: Holds(audio_tx),
                clock: SystemClock,
                counters: Arc::clone(&rig.counters),
                sink: rig.sink(),
                start_timeout: START_TIMEOUT,
            },
            (tx, rx),
        )
        .unwrap();
        assert_eq!(audio_rx.blocking_recv(), Some(1));
        handle.join();
        assert_eq!(audio_rx.try_recv(), Err(tokio::sync::mpsc::error::TryRecvError::Disconnected));
    }

    /// (j) On a stand-in, the chosen device reappearing, without any stream
    /// error, hands the side back to it: one message, one live stream.
    #[test]
    fn a_stand_in_hands_back_to_the_chosen_device() {
        let rig = Rig::new(&["Microphone (Realtek)"]);
        let mut sup = rig.supervisor(CaptureKind::Mic, "Headset", "Microphone (Realtek)");
        assert_eq!(sup.start().unwrap().device, "Microphone (Realtek)");
        rig.run_for(&mut sup, Duration::from_secs(12)); // probes fail quietly
        assert!(rig.statuses.lock().unwrap().is_empty(), "failed probes say nothing");
        assert_eq!(rig.counters.rebuilds(), 0);

        rig.present.lock().unwrap().push("Headset".into());
        rig.run_for(&mut sup, Duration::from_secs(6));
        let statuses = rig.statuses.lock().unwrap();
        assert_eq!(statuses.len(), 1);
        assert_eq!(statuses[0].state, CaptureState::Recovered);
        assert_eq!(statuses[0].device, "Headset");
        assert_eq!(statuses[0].message, "Now using Headset as your microphone.");
        drop(statuses);
        assert_eq!(rig.live(CaptureSide::You), 1, "the stand-in closed");
        assert_eq!(rig.counters.rebuilds(), 1);
        let attempts = rig.attempts(CaptureSide::You);
        rig.run_for(&mut sup, Duration::from_secs(30));
        assert_eq!(rig.attempts(CaptureSide::You), attempts, "no more probing once back on the chosen device");
    }

    /// (j) A failed probe leaves the stand-in's own errors counting: the
    /// stream the probe didn't replace is still the current one.
    #[test]
    fn a_failed_probe_keeps_the_stand_in_stream_current() {
        let rig = Rig::new(&["Microphone (Realtek)"]);
        let mut sup = rig.supervisor(CaptureKind::Mic, "Headset", "Microphone (Realtek)");
        sup.start().unwrap();
        rig.run_for(&mut sup, Duration::from_secs(6)); // one failed probe
        invalidated(&mut sup, CaptureSide::You);
        rig.run_for(&mut sup, Duration::from_secs(2));
        assert_eq!(rig.states(), vec![CaptureState::Recovering, CaptureState::Recovered]);
    }

    /// (k) After "lost" the device coming back reconnects, with a message even
    /// on the same device, and "lost" was only sent once.
    #[test]
    fn a_lost_side_reconnects_when_its_device_returns() {
        let rig = Rig::new(&["Headset"]);
        let mut sup = rig.supervisor(CaptureKind::Mic, "Headset", "Realtek");
        sup.start().unwrap();
        rig.unplug("Headset");
        invalidated(&mut sup, CaptureSide::You);
        rig.run_for(&mut sup, Duration::from_secs(100));
        assert_eq!(rig.live(CaptureSide::You), 0);

        rig.present.lock().unwrap().push("Headset".into());
        rig.run_for(&mut sup, Duration::from_secs(6));
        let statuses = rig.statuses.lock().unwrap();
        let lost = statuses.iter().filter(|s| s.state == CaptureState::Lost).count();
        assert_eq!(lost, 1, "lost once");
        let last = statuses.last().unwrap();
        assert_eq!(last.state, CaptureState::Recovered);
        assert_eq!(last.message, "Headset is back as your microphone.");
        drop(statuses);
        assert_eq!(rig.live(CaptureSide::You), 1);
        assert_eq!(rig.counters.rebuilds(), 1);
    }

    /// (l) Stop while probing opens nothing more.
    #[test]
    fn stop_while_lost_stops_probing() {
        let rig = Rig::new(&["Headset"]);
        let mut sup = rig.supervisor(CaptureKind::InputThem, "Headset", "Realtek");
        sup.start().unwrap();
        rig.unplug("Headset");
        invalidated(&mut sup, CaptureSide::Them);
        rig.run_for(&mut sup, Duration::from_secs(90));
        let attempts = rig.attempts(CaptureSide::Them);
        assert!(sup.poll().is_some());
        assert!(!sup.on_message(SideMessage::Stop));
        rig.present.lock().unwrap().push("Headset".into());
        rig.run_for(&mut sup, Duration::from_secs(30));
        assert_eq!(rig.attempts(CaptureSide::Them), attempts);
        assert_eq!(rig.live(CaptureSide::Them), 0);
        assert_eq!(sup.poll(), None);
    }

    /// (l) Stop on a stand-in cancels the probe.
    #[test]
    fn stop_on_a_stand_in_stops_probing() {
        let rig = Rig::new(&["Realtek"]);
        let mut sup = rig.supervisor(CaptureKind::Mic, "Headset", "Realtek");
        sup.start().unwrap();
        assert!(!sup.on_message(SideMessage::Stop));
        rig.present.lock().unwrap().push("Headset".into());
        rig.run_for(&mut sup, Duration::from_secs(30));
        assert_eq!(rig.attempts(CaptureSide::You), 2, "the two start attempts only");
        assert_eq!(rig.live(CaptureSide::You), 0);
    }

    /// (m) A side with no fallback only ever probes its chosen device, lost or running.
    #[test]
    fn input_sides_only_probe_the_chosen_device() {
        for kind in [CaptureKind::InputThem, CaptureKind::Dual] {
            let rig = Rig::new(&["Cable", "Realtek"]);
            let mut sup = rig.supervisor(kind, "Cable", "Realtek");
            sup.start().unwrap();
            rig.run_for(&mut sup, Duration::from_secs(30)); // running: no probing at all
            assert_eq!(rig.attempts(kind.side()), 1, "{kind:?} doesn't probe while running");
            rig.unplug("Cable");
            let generation = sup.generation;
            sup.on_stream_error(kind.side(), generation, &err(cpal::ErrorKind::DeviceNotAvailable));
            rig.run_for(&mut sup, Duration::from_secs(120));
            let log = rig.log.lock().unwrap();
            assert!(
                log.attempts.iter().all(|a| a.1 == DeviceChoice::Chosen("Cable".into())),
                "{kind:?} opened something other than its chosen device"
            );
            drop(log);
            rig.present.lock().unwrap().push("Cable".into());
            rig.run_for(&mut sup, Duration::from_secs(6));
            assert_eq!(rig.live(kind.side()), 1, "{kind:?} is back");
            assert!(rig.statuses.lock().unwrap().last().unwrap().message.contains("Cable is back"));
        }
    }

    #[test]
    fn each_kind_words_its_messages_for_what_it_captures() {
        let lost = |kind| lost_message(kind, false);
        assert_eq!(
            lost(CaptureKind::Mic),
            "Your microphone disconnected. NexQ reconnects it when it's back, or pick another microphone in Audio & Devices."
        );
        assert_eq!(
            lost(CaptureKind::Output),
            "The speakers or headphones you hear the call on disconnected. NexQ reconnects them when they're back, or pick another device in Audio & Devices."
        );
        assert_eq!(
            lost(CaptureKind::InputThem),
            "The device the other side comes in on disconnected. NexQ reconnects it when it's back, or pick another device in Audio & Devices."
        );
        assert_eq!(
            lost(CaptureKind::Dual),
            "Your shared input device disconnected. NexQ reconnects it when it's back, or pick another device in Audio & Devices."
        );
        assert_eq!(back_message(CaptureKind::Output, "Speakers"), "Speakers is back. Listening for the other side again.");
        assert_eq!(back_message(CaptureKind::InputThem, "Cable"), "Cable is back. Capturing the other side again.");
        assert_eq!(back_message(CaptureKind::Dual, "Cable"), "Cable is back for you and the other side.");
        assert_eq!(
            recovered_message(CaptureKind::Output, "Speakers", "Speakers", "Headphones"),
            "The speakers or headphones you hear the call on disconnected. Listening on Headphones instead."
        );
        assert_eq!(
            recovered_message(CaptureKind::InputThem, "Cable", "Cable", "Cable 2"),
            "Now capturing the other side from Cable 2."
        );
        assert_eq!(
            recovered_message(CaptureKind::Dual, "Cable", "Cable", "Cable 2"),
            "Now using Cable 2 for you and the other side."
        );
    }

    /// F3: a refused permission isn't called a disconnected device.
    #[test]
    fn a_refused_permission_is_not_called_a_disconnect() {
        let rig = Rig::new(&["Mic"]);
        let mut sup = rig.supervisor(CaptureKind::Mic, "Mic", "Mic");
        sup.start().unwrap();
        rig.unplug("Mic");
        sup.on_stream_error(CaptureSide::You, sup.generation, &err(cpal::ErrorKind::PermissionDenied));
        rig.run_for(&mut sup, Duration::from_secs(70));
        let statuses = rig.statuses.lock().unwrap();
        let lost = statuses.iter().find(|s| s.state == CaptureState::Lost).unwrap();
        assert!(lost.message.contains("privacy settings are blocking your microphone"), "{}", lost.message);
        assert!(!lost.message.contains("disconnected"));
    }

    #[test]
    fn xruns_count_and_warnings_change_nothing() {
        let rig = Rig::new(&["Realtek"]);
        let mut sup = rig.supervisor(CaptureKind::Mic, "default", "Realtek");
        sup.start().unwrap();
        let generation = sup.generation;
        for kind in [cpal::ErrorKind::Xrun, cpal::ErrorKind::Xrun, cpal::ErrorKind::DeviceChanged, cpal::ErrorKind::RealtimeDenied] {
            sup.on_stream_error(CaptureSide::You, generation, &err(kind));
        }
        rig.run_for(&mut sup, Duration::from_secs(5));
        assert_eq!(rig.counters.xruns(), 2);
        assert_eq!(rig.attempts(CaptureSide::You), 1);
        assert!(rig.statuses.lock().unwrap().is_empty());
    }

    #[test]
    fn a_side_without_fallback_never_opens_the_default() {
        let rig = Rig::new(&["Cable", "Realtek"]);
        let mut sup = rig.supervisor(CaptureKind::InputThem, "Cable", "Realtek");
        sup.start().unwrap();
        rig.unplug("Cable");
        invalidated(&mut sup, CaptureSide::Them);
        rig.run_for(&mut sup, Duration::from_secs(90));
        let log = rig.log.lock().unwrap();
        assert!(log.attempts.iter().all(|a| a.1 == DeviceChoice::Chosen("Cable".into())));
        drop(log);
        assert_eq!(rig.states().last(), Some(&CaptureState::Lost));
    }

    #[test]
    fn the_chosen_device_coming_back_is_used_again() {
        let rig = Rig::new(&["Microphone (Realtek)"]);
        let mut sup = rig.supervisor(CaptureKind::Mic, "Headset", "Microphone (Realtek)");
        let started = sup.start().unwrap();
        assert_eq!(started.device, "Microphone (Realtek)");
        assert_eq!(started.replaced.as_deref(), Some("'Headset' not found"));

        rig.present.lock().unwrap().push("Headset".into());
        invalidated(&mut sup, CaptureSide::You); // the default changed
        rig.run_for(&mut sup, Duration::from_secs(1));
        let statuses = rig.statuses.lock().unwrap();
        assert_eq!(statuses.last().unwrap().message, "Now using Headset as your microphone.");
    }

    #[test]
    fn the_status_event_payload_is_lowercase() {
        let status = CaptureStatus {
            side: CaptureSide::Them,
            state: CaptureState::Recovering,
            device: "Speakers".into(),
            message: String::new(),
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            serde_json::json!({"side": "them", "state": "recovering", "device": "Speakers", "message": ""})
        );
    }

    /// The side thread: an error sent the way a stream's callback sends it
    /// gets the stream reopened, and Stop ends the thread.
    #[test]
    fn a_side_thread_reopens_on_a_callback_error_and_stops() {
        let rig = Rig::new(&["Realtek"]);
        let (tx, rx) = side_channel();
        let mut callback = error_callback(tx.clone(), CaptureSide::You, 1);
        let opener = FakeOpener { clock: FakeClock::new(), ..rig.opener(CaptureSide::You, "Realtek") };
        let (handle, started) = spawn_side(
            SideSpec {
                kind: CaptureKind::Mic,
                device_id: "default".to_string(),
                opener,
                clock: SystemClock,
                counters: Arc::clone(&rig.counters),
                sink: rig.sink(),
                start_timeout: START_TIMEOUT,
            },
            (tx, rx),
        )
        .unwrap();
        assert_eq!(started.unwrap().device, "Realtek");

        callback(err(cpal::ErrorKind::StreamInvalidated));
        let deadline = Instant::now() + Duration::from_secs(5);
        while rig.attempts(CaptureSide::You) < 2 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(rig.attempts(CaptureSide::You), 2);
        handle.join();
        assert_eq!(rig.live(CaptureSide::You), 0, "Stop dropped the stream");
    }

    /// The chosen device is missing; the default one opens in its place.
    fn stand_in_outcome(choice: &DeviceChoice) -> Result<Opened<()>, String> {
        match choice {
            DeviceChoice::Chosen(_) => Err("not found".to_string()),
            DeviceChoice::Default => Ok(Opened { stream: (), device: "Realtek".to_string() }),
        }
    }

    /// Spawn a side whose first open waits for a gate. `race_the_timeout`
    /// releases the gate in the gap after start's wait timed out and before it
    /// gives up, and waits for the thread to claim the outcome there.
    fn spawn_racing(
        rig: &Rig,
        outcome: fn(&DeviceChoice) -> Result<Opened<()>, String>,
    ) -> Result<(SideHandle, Option<Started>), Vec<String>> {
        let (gate_tx, gate_rx) = std::sync::mpsc::channel();
        let hook: BeforeAbandon = Box::new(move |handoff| {
            gate_tx.send(()).unwrap();
            wait_for(|| handoff.load(Ordering::SeqCst) == DONE);
            assert_eq!(handoff.load(Ordering::SeqCst), DONE, "the thread claimed the outcome");
        });
        spawn_side_with(
            SideSpec {
                kind: CaptureKind::Mic,
                device_id: "Headset".to_string(),
                opener: Gated { gate: Some(gate_rx), outcome },
                clock: SystemClock,
                counters: Arc::clone(&rig.counters),
                sink: rig.sink(),
                start_timeout: Duration::from_millis(30),
            },
            side_channel(),
            Some(hook),
        )
    }

    /// Late success, start gave up first: the stand-in is announced, once.
    #[test]
    fn a_late_start_on_a_stand_in_is_announced_once() {
        let rig = Rig::new(&[]);
        let (handle, release) = spawn_gated(&rig, CaptureKind::Mic, "Headset", stand_in_outcome);
        release.send(()).unwrap();
        wait_for(|| rig.states().contains(&CaptureState::Recovered));
        handle.join();
        assert_eq!(rig.states(), vec![CaptureState::Recovered]);
    }

    /// Late success, but the thread claimed the outcome before start gave up:
    /// start gets it, and the thread says nothing itself.
    #[test]
    fn a_start_that_finishes_in_the_timeout_gap_is_returned_not_announced() {
        let rig = Rig::new(&[]);
        let (handle, started) = spawn_racing(&rig, stand_in_outcome).unwrap();
        let started = started.expect("start received the outcome");
        assert_eq!(started.device, "Realtek");
        assert!(started.replaced.is_some());
        handle.join();
        assert!(rig.states().is_empty(), "the caller announces it, not the thread");
    }

    /// Late failure, but the thread claimed the outcome before start gave up:
    /// start returns the errors, and nothing is reported lost.
    #[test]
    fn a_failure_in_the_timeout_gap_is_returned_not_reported_lost() {
        let rig = Rig::new(&[]);
        let result = spawn_racing(&rig, |_| Err("busy".to_string()));
        assert_eq!(result.err().unwrap(), vec!["busy", "busy"]);
        assert!(rig.states().is_empty());
    }

    #[test]
    fn a_side_that_cannot_open_reports_every_error() {
        let rig = Rig::new(&[]);
        let (tx, rx) = side_channel();
        let result = spawn_side(
            SideSpec {
                kind: CaptureKind::Mic,
                device_id: "Headset".to_string(),
                opener: rig.opener(CaptureSide::You, "Realtek"),
                clock: SystemClock,
                counters: Arc::clone(&rig.counters),
                sink: rig.sink(),
                start_timeout: START_TIMEOUT,
            },
            (tx, rx),
        );
        assert_eq!(result.err().unwrap(), vec!["'Headset' not found", "'Realtek' not found"]);
    }
}
