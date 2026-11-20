//! Keeps a capture side running when its device goes away mid-meeting.
//!
//! cpal 0.18 reports a lost or changed device through the stream's error
//! callback (`StreamInvalidated`, `DeviceNotAvailable`, ...) and expects the
//! app to rebuild the stream. Each capture side ("You", "Them", or one shared
//! input for both) runs on its own thread that owns its stream. The error
//! callback only sends `(side, generation, error)` to that thread; the thread
//! drops the stream and opens it again, on the chosen device or else the
//! default one, with backoff, and gives up after a minute. Rebuilds never
//! touch `AppState::audio`, the chunk channel, the recorder or the other side.
//!
//! [`Supervisor`] is the thread's state machine. Opening a device
//! ([`CaptureOpener`]) and the time ([`Clock`]) are injected, so tests drive it
//! without hardware or waiting.

use std::sync::atomic::{AtomicU64, Ordering};
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
const STEADY_RETRY: Duration = Duration::from_secs(5);
/// After this long without a stream the side is reported lost, once, and
/// the thread stops trying.
pub const GIVE_UP_AFTER: Duration = Duration::from_secs(60);
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
    Lost,
    Stopped,
}

pub struct Supervisor<O: CaptureOpener, C: Clock> {
    kind: CaptureKind,
    device_id: String,
    opener: O,
    clock: C,
    stream: Option<O::Stream>,
    /// The current stream's generation (each open attempt takes a new one).
    generation: u64,
    /// The current stream's device.
    device: String,
    phase: Phase,
    counters: Arc<CaptureCounters>,
    sink: StatusSink,
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
            generation: 0,
            device: String::new(),
            phase: Phase::Stopped,
            counters,
            sink,
        }
    }

    pub fn now(&self) -> Instant {
        self.clock.now()
    }

    /// The first open. On failure: the error of each device tried, in order.
    pub fn start(&mut self) -> Result<Started, Vec<String>> {
        let (opened, errors) = self.open_first();
        let opened = opened.ok_or(errors.clone())?;
        self.stream = Some(opened.stream);
        self.device = opened.device.clone();
        self.phase = Phase::Running;
        log::info!("{}: capturing '{}'", self.kind.label(), opened.device);
        Ok(Started { device: opened.device, replaced: errors.into_iter().next() })
    }

    fn open_first(&mut self) -> (Option<Opened<O::Stream>>, Vec<String>) {
        let mut errors = Vec::new();
        for choice in device_choices(self.kind, &self.device_id) {
            self.generation += 1;
            match self.opener.open(&choice, self.generation) {
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
                let now = self.clock.now();
                self.phase = Phase::Pending { due: now + REBUILD_DEBOUNCE, outage_start: now, attempt: 0 };
                self.emit(CaptureState::Recovering, self.device.clone(), String::new());
            }
        }
    }

    /// Run a reconnect that is due. Returns when the next one is due, if any.
    pub fn poll(&mut self) -> Option<Instant> {
        let Phase::Pending { due, outage_start, attempt } = self.phase else {
            return None;
        };
        let now = self.clock.now();
        if now < due {
            return Some(due);
        }
        // Drop the failed stream before opening its replacement.
        self.stream = None;
        let label = self.kind.label();
        let (opened, errors) = self.open_first();
        match opened {
            Some(opened) => {
                let before = std::mem::replace(&mut self.device, opened.device.clone());
                self.stream = Some(opened.stream);
                self.phase = Phase::Running;
                self.counters.rebuilds.fetch_add(1, Ordering::Relaxed);
                log::info!(
                    "{label}: reconnected on '{}' after {} ms (attempt {})",
                    opened.device,
                    now.duration_since(outage_start).as_millis(),
                    attempt + 1
                );
                let message = recovered_message(self.kind, &self.device_id, &before, &opened.device);
                self.emit(CaptureState::Recovered, opened.device, message);
                None
            }
            None => {
                log::warn!("{label}: reconnect attempt {} failed: {}", attempt + 1, errors.join("; "));
                let give_up_at = outage_start + GIVE_UP_AFTER;
                if now >= give_up_at {
                    log::error!("{label}: '{}' didn't come back; giving up", self.device);
                    self.phase = Phase::Lost;
                    self.emit(CaptureState::Lost, self.device.clone(), lost_message(self.kind).to_string());
                    return None;
                }
                let next = (now + backoff(attempt)).min(give_up_at);
                self.phase = Phase::Pending { due: next, outage_start, attempt: attempt + 1 };
                Some(next)
            }
        }
    }

    /// Drop the stream and cancel any pending rebuild.
    pub fn stop(&mut self) {
        self.stream = None;
        self.phase = Phase::Stopped;
    }

    fn emit(&self, state: CaptureState, device: String, message: String) {
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
            format!("The other side's audio device disconnected. Listening on {now} for now.")
        }
        (CaptureKind::Output, false) => format!("Now listening on {now} for the other side."),
        (CaptureKind::InputThem, _) => format!("Now capturing the other side from {now}."),
        (CaptureKind::Dual, _) => format!("Now using {now} for you and the other side."),
    }
}

fn lost_message(kind: CaptureKind) -> &'static str {
    match kind {
        CaptureKind::Mic => {
            "Your microphone disconnected and didn't come back. Pick a microphone in Audio & Devices to continue."
        }
        CaptureKind::Output => {
            "The other side's audio device disconnected and didn't come back. Pick a device in Audio & Devices to continue."
        }
        CaptureKind::InputThem => {
            "The other side's input device disconnected and didn't come back. Pick a device in Audio & Devices to continue."
        }
        CaptureKind::Dual => {
            "Your shared input device disconnected and didn't come back. Pick a device in Audio & Devices to continue."
        }
    }
}

/// A running side: its thread and the channel that reaches it.
pub struct SideHandle {
    kind: CaptureKind,
    messages: SyncSender<SideMessage>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl SideHandle {
    pub fn kind(&self) -> CaptureKind {
        self.kind
    }

    /// Ask the thread to stop; `join` waits for it.
    pub fn request_stop(&self) {
        let _ = self.messages.send(SideMessage::Stop);
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

/// Start a side's thread and wait up to `start_timeout` for its first open.
/// `messages` is the channel the opener's error callbacks send to.
///
/// Returns the handle and, unless the open is still going after the timeout,
/// what it opened. On failure the thread has ended.
#[allow(clippy::too_many_arguments)]
pub fn spawn_side<O, C>(
    kind: CaptureKind,
    device_id: &str,
    opener: O,
    clock: C,
    counters: Arc<CaptureCounters>,
    sink: StatusSink,
    messages: (SyncSender<SideMessage>, Receiver<SideMessage>),
    start_timeout: Duration,
) -> Result<(SideHandle, Option<Started>), Vec<String>>
where
    O: CaptureOpener + Send + 'static,
    C: Clock + Send + 'static,
{
    let (tx, rx) = messages;
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<Started, Vec<String>>>();
    let device_id = device_id.to_string();
    let thread_name = match kind.side() {
        CaptureSide::You => "capture-you",
        CaptureSide::Them => "capture-them",
    };
    let thread = std::thread::Builder::new()
        .name(thread_name.into())
        .spawn(move || {
            let mut supervisor = Supervisor::new(kind, &device_id, opener, clock, counters, sink);
            let started = supervisor.start();
            let ok = started.is_ok();
            let _ = ready_tx.send(started);
            if ok {
                run_side(&mut supervisor, &rx);
            }
        })
        .map_err(|e| vec![format!("Failed to start the capture thread: {e}")])?;
    let handle = SideHandle { kind, messages: tx, thread: Some(thread) };

    match ready_rx.recv_timeout(start_timeout) {
        Ok(Ok(started)) => Ok((handle, Some(started))),
        Ok(Err(errors)) => Err(errors), // the thread has ended; dropping the handle joins it
        Err(RecvTimeoutError::Timeout) => {
            log::warn!("{} is slow to start; it keeps opening in the background", kind.label());
            Ok((handle, None))
        }
        Err(RecvTimeoutError::Disconnected) => {
            Err(vec!["The capture thread ended before starting".to_string()])
        }
    }
}

/// A side's thread after its first open: wait for an error, a due reconnect
/// or Stop.
fn run_side<O: CaptureOpener, C: Clock>(supervisor: &mut Supervisor<O, C>, rx: &Receiver<SideMessage>) {
    loop {
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
            self.log.lock().unwrap().live[slot(self.side)] -= 1;
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
        rig.run_for(&mut sup, Duration::from_secs(10));

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
    fn when_nothing_opens_it_backs_off_reports_lost_once_and_stops() {
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
        assert_eq!(sup.poll(), None, "no more attempts");
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
            CaptureKind::Mic,
            "default",
            opener,
            SystemClock,
            Arc::clone(&rig.counters),
            rig.sink(),
            (tx, rx),
            START_TIMEOUT,
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

    #[test]
    fn a_side_that_cannot_open_reports_every_error() {
        let rig = Rig::new(&[]);
        let (tx, rx) = side_channel();
        let result = spawn_side(
            CaptureKind::Mic,
            "Headset",
            rig.opener(CaptureSide::You, "Realtek"),
            SystemClock,
            Arc::clone(&rig.counters),
            rig.sink(),
            (tx, rx),
            START_TIMEOUT,
        );
        assert_eq!(result.err().unwrap(), vec!["'Headset' not found", "'Realtek' not found"]);
    }
}
