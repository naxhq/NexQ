//! Restarting the speech-to-text of one side of a running meeting.
//!
//! The audio loop of `start_capture_per_party` owns both sides' providers. To
//! change one side's language without touching the other side, the capture or
//! the recording, the `set_party_language` command asks the loop to hand that
//! side's provider over (`Take`), stops it, starts a new one on the same
//! result channel and gives it back (`Put`). The loop keeps running meanwhile:
//! audio for that side isn't transcribed during the swap, but it is still
//! recorded and measured, and the other side's provider keeps being fed.
//!
//! Every provider of a side gets its own sender into the side's result
//! channel (`SwapSignal::attach`). It tags results with the provider's
//! generation, so the transcript task can tell the old provider's late results
//! from the new one's, and moves stream-relative timestamps onto the meeting's
//! time base.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::{mpsc, oneshot, Notify};
use tokio::task::JoinHandle;

use crate::stt::provider::{STTProvider, TranscriptResult};
use crate::stt::segment_accumulator::{AccumulatorOutput, SegmentAccumulator, EPOCH_MS_FLOOR};

/// One side of the meeting. "Them" is the room in an in-person meeting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    You,
    Them,
}

impl Side {
    pub fn parse(party: &str) -> Option<Side> {
        match party.trim().to_ascii_lowercase().as_str() {
            "you" => Some(Side::You),
            "them" => Some(Side::Them),
            _ => None,
        }
    }

    /// Index into the per-side state arrays (You, Them).
    pub fn index(self) -> usize {
        match self {
            Side::You => 0,
            Side::Them => 1,
        }
    }
}

/// How long the command waits for the audio loop to answer a `Take`.
const TAKE_TIMEOUT: Duration = Duration::from_secs(2);

/// How long a stopped provider gets to send the results it still has in flight
/// (the Whisper API and Groq transcribe their last chunk after `stop_stream`).
const DRAIN_TIMEOUT: Duration = Duration::from_secs(3);

/// The sender a provider writes its results to.
pub type ResultTx = mpsc::Sender<TranscriptResult>;

/// A result with the generation of the provider that made it.
#[derive(Debug)]
pub struct Tagged {
    pub generation: u32,
    pub result: TranscriptResult,
}

/// A side's result channel, read by the side's transcript task.
pub type SideTx = mpsc::Sender<Tagged>;

/// What a side's transcript task learns about swaps of its provider, and how
/// providers are attached to the side's result channel.
pub struct SwapSignal {
    generation: AtomicU32,
    flush: Notify,
    /// The start of the meeting's capture: stream-relative timestamps of a
    /// replacement provider are offset by the time since it.
    origin: Instant,
    /// The forwarding task of the newest provider.
    adapter: Mutex<Option<JoinHandle<()>>>,
}

impl Default for SwapSignal {
    fn default() -> Self {
        SwapSignal {
            generation: AtomicU32::new(0),
            flush: Notify::new(),
            origin: Instant::now(),
            adapter: Mutex::new(None),
        }
    }
}

/// A timestamp on the meeting's time base. Providers stamp results either with
/// epoch time (kept as it is) or with the time since their stream started (Groq,
/// Whisper API, Azure, whisper.cpp, Windows Speech): a replacement stream's
/// restarts at zero, so it is moved by when the stream began.
pub fn meeting_timestamp(timestamp_ms: u64, stream_offset_ms: u64) -> u64 {
    if timestamp_ms >= EPOCH_MS_FLOOR {
        timestamp_ms
    } else {
        timestamp_ms + stream_offset_ms
    }
}

impl SwapSignal {
    /// How many times the side's provider has been swapped.
    pub fn generation(&self) -> u32 {
        self.generation.load(Ordering::Relaxed)
    }

    /// The old provider has stopped and sent what it had: the transcript task
    /// ends the line it has open, and results of older generations stop counting.
    pub fn swapped(&self) {
        self.generation.fetch_add(1, Ordering::Relaxed);
        self.flush.notify_one();
    }

    /// A sender for the side's newest provider (the one of the current
    /// generation). Its results reach the side's channel tagged and on the
    /// meeting's time base.
    pub fn attach(&self, main: &SideTx) -> ResultTx {
        let generation = self.generation();
        let offset_ms = if generation == 0 { 0 } else { self.origin.elapsed().as_millis() as u64 };
        let (tx, mut rx) = mpsc::channel::<TranscriptResult>(256);
        let main = main.clone();
        let handle = tokio::spawn(async move {
            while let Some(mut result) = rx.recv().await {
                result.timestamp_ms = meeting_timestamp(result.timestamp_ms, offset_ms);
                if main.send(Tagged { generation, result }).await.is_err() {
                    break;
                }
            }
        });
        if let Ok(mut slot) = self.adapter.lock() {
            *slot = Some(handle);
        }
        tx
    }

    /// Wait until the newest provider's results have all reached the side's
    /// channel (every sender it had is gone), or `timeout`.
    pub async fn drained(&self, timeout: Duration) {
        let handle = self.adapter.lock().ok().and_then(|mut slot| slot.take());
        if let Some(handle) = handle {
            let _ = tokio::time::timeout(timeout, handle).await;
        }
    }
}

/// Run a side's transcript task until its result channel closes: feed every
/// result to the accumulator, and end the open line when the side's provider
/// is swapped, interim words included, so the new provider starts a line of its
/// own. A result of an older generation than the current one arrives too late
/// and is dropped. The caller flushes at the end.
pub async fn pump_accumulated(
    rx: &mut mpsc::Receiver<Tagged>,
    signal: &SwapSignal,
    accumulator: &mut SegmentAccumulator,
    pause_threshold: &AtomicU64,
    mut on_result: impl FnMut(&TranscriptResult),
    mut on_output: impl FnMut(AccumulatorOutput),
) {
    let mut current = 0u32;
    loop {
        tokio::select! {
            biased;
            received = rx.recv() => {
                let Some(Tagged { generation, result }) = received else { break };
                if generation < current {
                    log::debug!("Dropping a result of an earlier STT provider (generation {generation} < {current})");
                    continue;
                }
                if generation > current {
                    // The new provider is already talking: its first line is its own.
                    if let Some(output) = accumulator.close_line() {
                        on_output(output);
                    }
                    current = generation;
                }
                on_result(&result);
                // Live-update the threshold from settings changes.
                accumulator.set_pause_threshold(pause_threshold.load(Ordering::Relaxed));
                for output in accumulator.feed_result(result) {
                    on_output(output);
                }
            }
            _ = signal.flush.notified() => {
                let swapped_to = signal.generation();
                if current < swapped_to {
                    if let Some(output) = accumulator.close_line() {
                        on_output(output);
                    }
                    current = swapped_to;
                }
            }
        }
    }
}

/// The transcript task of a side whose provider makes its own segments (no
/// accumulator). `on_line` gets each result with the generation of the provider
/// that made it. When the provider is swapped, the interim line it left open is
/// passed on once more as a final.
pub async fn pump_direct(
    rx: &mut mpsc::Receiver<Tagged>,
    signal: &SwapSignal,
    mut on_result: impl FnMut(&TranscriptResult),
    mut on_line: impl FnMut(u32, TranscriptResult),
) {
    let mut current = 0u32;
    let mut open: Option<(u32, TranscriptResult)> = None;
    loop {
        tokio::select! {
            biased;
            received = rx.recv() => {
                let Some(Tagged { generation, result }) = received else { break };
                if generation > current {
                    if let Some((generation, mut line)) = open.take() {
                        line.is_final = true;
                        on_line(generation, line);
                    }
                    current = generation;
                }
                on_result(&result);
                if result.is_final {
                    if open.as_ref().is_some_and(|(_, line)| line.segment_id == result.segment_id) {
                        open = None;
                    }
                } else if generation == current {
                    open = Some((generation, result.clone()));
                }
                on_line(generation, result);
            }
            _ = signal.flush.notified() => {
                let swapped_to = signal.generation();
                if current < swapped_to {
                    if let Some((generation, mut line)) = open.take() {
                        line.is_final = true;
                        on_line(generation, line);
                    }
                    current = swapped_to;
                }
            }
        }
    }
}

/// A side's provider, handed over by the audio loop together with what a new provider needs.
pub struct TakenSide<P> {
    pub provider: P,
    /// The side's result channel; the transcript task of the side reads its other end.
    pub tx: SideTx,
    /// Told by the command once the old provider has stopped.
    pub signal: Arc<SwapSignal>,
}

/// A message to the audio loop.
pub enum SideSwapMsg<P> {
    /// Hand over the side's provider; answers None when the side has nothing to swap.
    Take { side: Side, reply: oneshot::Sender<Option<TakenSide<P>>> },
    /// Give the side its new provider (None: it goes without STT).
    /// `muted` is the mute state the provider was started with.
    Put { side: Side, provider: Option<P>, muted: bool },
}

pub type SideSwapSender = mpsc::UnboundedSender<SideSwapMsg<Box<dyn STTProvider>>>;

/// The audio loop answers a `Take` for one of its sides. A side with no
/// provider (or no result channel) has nothing to swap. If the command has
/// stopped waiting, the provider goes back where it was.
pub fn handle_take<P>(
    provider: &mut Option<P>,
    tx: Option<&SideTx>,
    signal: &Arc<SwapSignal>,
    reply: oneshot::Sender<Option<TakenSide<P>>>,
) {
    let taken = match (provider.take(), tx) {
        (Some(p), Some(tx)) => Some(TakenSide { provider: p, tx: tx.clone(), signal: signal.clone() }),
        (p, _) => {
            *provider = p;
            None
        }
    };
    if let Err(Some(back)) = reply.send(taken) {
        *provider = Some(back.provider);
    }
}

/// The audio loop installs a side's new provider. The mute state the provider
/// started with is recorded, so the loop's next mute check passes on any change since.
pub fn handle_put<P>(provider: &mut Option<P>, muted_applied: &mut bool, new: Option<P>, started_muted: bool) {
    *provider = new;
    *muted_applied = started_muted;
}

/// The part of a result id that tells which provider made it: the session
/// prefix, then `s<generation>` once a side's provider has been swapped.
pub fn generation_prefix(prefix: &str, generation: u32) -> String {
    if generation == 0 {
        prefix.to_string()
    } else {
        format!("{prefix}s{generation}")
    }
}

/// How a swap ended.
#[derive(Debug, PartialEq, Eq)]
pub enum SwapOutcome {
    /// The new provider runs.
    Swapped,
    /// The old provider stopped but the new one couldn't start: the side goes without STT.
    StartFailed(String),
    /// The side has no running provider to swap, or the meeting's audio loop is gone.
    NotRunning,
}

impl SwapOutcome {
    /// What `set_party_language` answers: whether the side was restarted. A new
    /// provider that can't start is an error, so the caller restarts the whole capture.
    pub fn into_answer(self) -> Result<bool, String> {
        match self {
            SwapOutcome::Swapped => Ok(true),
            SwapOutcome::NotRunning => Ok(false),
            SwapOutcome::StartFailed(e) => Err(format!("Failed to start STT: {e}")),
        }
    }
}

/// Replace one side's provider with `new_provider`: stop the old one, let it
/// finish what it still sends, start the new one on the same result channel,
/// hand it to the loop. The other side is not involved.
pub async fn swap_side_provider(
    sender: &SideSwapSender,
    side: Side,
    new_provider: Box<dyn STTProvider>,
    muted_flag: &AtomicBool,
) -> SwapOutcome {
    swap_side_provider_within(sender, side, new_provider, muted_flag, DRAIN_TIMEOUT).await
}

async fn swap_side_provider_within(
    sender: &SideSwapSender,
    side: Side,
    mut new_provider: Box<dyn STTProvider>,
    muted_flag: &AtomicBool,
    drain_timeout: Duration,
) -> SwapOutcome {
    let (reply, answer) = oneshot::channel();
    if sender.send(SideSwapMsg::Take { side, reply }).is_err() {
        return SwapOutcome::NotRunning;
    }
    let TakenSide { provider: mut old, tx, signal } =
        match tokio::time::timeout(TAKE_TIMEOUT, answer).await {
            Ok(Ok(Some(taken))) => taken,
            _ => return SwapOutcome::NotRunning,
        };

    if let Err(e) = old.stop_stream().await {
        log::warn!("{:?} STT stop before a language swap: {}", side, e);
    }
    drop(old);
    // What the old provider still had in flight goes into the channel before the boundary.
    signal.drained(drain_timeout).await;
    signal.swapped();

    let muted = muted_flag.load(Ordering::Relaxed);
    new_provider.set_muted(muted);
    let (started, outcome) = match new_provider.start_stream(signal.attach(&tx)).await {
        Ok(()) => (Some(new_provider), SwapOutcome::Swapped),
        Err(e) => (None, SwapOutcome::StartFailed(e.to_string())),
    };
    if let Err(mpsc::error::SendError(SideSwapMsg::Put { provider: Some(mut orphan), .. })) =
        sender.send(SideSwapMsg::Put { side, provider: started, muted })
    {
        // The meeting ended while we swapped: nobody is left to run it.
        let _ = orphan.stop_stream().await;
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::AudioChunk;
    use async_trait::async_trait;

    type Log = Arc<Mutex<Vec<String>>>;

    struct Mock {
        name: &'static str,
        log: Log,
        fail_start: bool,
        /// Results sent right after the stream starts, from the sender it was given.
        on_start: Vec<TranscriptResult>,
        /// A sender kept after `stop_stream`, which sends its results late (Groq, Whisper API).
        late_after_stop: Option<(Vec<TranscriptResult>, Duration)>,
        tx: Option<ResultTx>,
    }

    impl Mock {
        fn new(name: &'static str, log: &Log) -> Mock {
            Mock { name, log: log.clone(), fail_start: false, on_start: vec![], late_after_stop: None, tx: None }
        }
        fn boxed(name: &'static str, log: &Log) -> Box<dyn STTProvider> {
            Box::new(Mock::new(name, log))
        }
        fn note(&self, what: &str) {
            self.log.lock().unwrap().push(format!("{}:{}", self.name, what));
        }
    }

    #[async_trait]
    impl STTProvider for Mock {
        fn provider_name(&self) -> &str {
            self.name
        }
        fn provider_type(&self) -> crate::stt::provider::STTProviderType {
            crate::stt::provider::STTProviderType::Deepgram
        }
        async fn start_stream(
            &mut self,
            tx: ResultTx,
        ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
            if self.fail_start {
                return Err("no connection".into());
            }
            self.note("start");
            for result in self.on_start.drain(..) {
                tx.send(result).await.unwrap();
            }
            self.tx = Some(tx);
            Ok(())
        }
        async fn feed_audio(&mut self, _c: AudioChunk) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
            Ok(())
        }
        async fn stop_stream(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
            self.note("stop");
            if let (Some((late, after)), Some(tx)) = (self.late_after_stop.take(), self.tx.take()) {
                tokio::spawn(async move {
                    tokio::time::sleep(after).await;
                    for result in late {
                        let _ = tx.send(result).await;
                    }
                });
            }
            Ok(())
        }
        async fn test_connection(&self) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
            Ok(true)
        }
        fn set_language(&mut self, _l: &str) {}
        fn set_muted(&mut self, muted: bool) {
            self.note(&format!("muted={muted}"));
        }
    }

    /// A stand-in for the audio loop: both sides' state and the message handling.
    struct FakeLoop {
        providers: [Option<Box<dyn STTProvider>>; 2],
        txs: [Option<SideTx>; 2],
        rxs: [Option<mpsc::Receiver<Tagged>>; 2],
        signals: [Arc<SwapSignal>; 2],
        muted_applied: [bool; 2],
    }

    impl FakeLoop {
        fn new(you: Option<Box<dyn STTProvider>>, them: Option<Box<dyn STTProvider>>) -> Self {
            let (you_tx, you_rx) = mpsc::channel(64);
            let (them_tx, them_rx) = mpsc::channel(64);
            let have = [you.is_some(), them.is_some()];
            FakeLoop {
                providers: [you, them],
                txs: [have[0].then_some(you_tx), have[1].then_some(them_tx)],
                rxs: [Some(you_rx), Some(them_rx)],
                signals: [Arc::default(), Arc::default()],
                muted_applied: [false, false],
            }
        }

        fn handle(&mut self, msg: SideSwapMsg<Box<dyn STTProvider>>) {
            match msg {
                SideSwapMsg::Take { side, reply } => {
                    let i = side.index();
                    handle_take(&mut self.providers[i], self.txs[i].as_ref(), &self.signals[i], reply);
                }
                SideSwapMsg::Put { side, provider, muted } => {
                    let i = side.index();
                    handle_put(&mut self.providers[i], &mut self.muted_applied[i], provider, muted);
                }
            }
        }

        /// What a side's channel holds now: (generation, text, timestamp).
        fn received(&mut self, side: Side) -> Vec<(u32, String, u64)> {
            let rx = self.rxs[side.index()].as_mut().unwrap();
            let mut out = vec![];
            while let Ok(t) = rx.try_recv() {
                out.push((t.generation, t.result.text, t.result.timestamp_ms));
            }
            out
        }
    }

    /// Run `swap_side_provider` while a fake loop answers its messages.
    async fn swap(
        fake: &mut FakeLoop,
        side: Side,
        new: Box<dyn STTProvider>,
        muted: &AtomicBool,
    ) -> SwapOutcome {
        swap_within(fake, side, new, muted, Duration::from_millis(200)).await
    }

    async fn swap_within(
        fake: &mut FakeLoop,
        side: Side,
        new: Box<dyn STTProvider>,
        muted: &AtomicBool,
        drain: Duration,
    ) -> SwapOutcome {
        let (sender, mut rx) = mpsc::unbounded_channel();
        let swapping = swap_side_provider_within(&sender, side, new, muted, drain);
        tokio::pin!(swapping);
        loop {
            tokio::select! {
                outcome = &mut swapping => {
                    while let Ok(msg) = rx.try_recv() { fake.handle(msg); }
                    return outcome;
                }
                Some(msg) = rx.recv() => fake.handle(msg),
            }
        }
    }

    fn events(log: &Log) -> Vec<String> {
        log.lock().unwrap().clone()
    }

    fn result(text: &str, is_final: bool, at: u64) -> TranscriptResult {
        TranscriptResult {
            text: text.into(),
            is_final,
            confidence: 0.9,
            timestamp_ms: at,
            speaker: None,
            language: None,
            segment_id: None,
            duration_ms: Some(500),
            speaker_tag: None,
            turn: None,
        }
    }

    #[tokio::test]
    async fn a_swap_restarts_only_the_targeted_side() {
        let log: Log = Default::default();
        let mut fake = FakeLoop::new(Some(Mock::boxed("you_old", &log)), Some(Mock::boxed("them_old", &log)));

        let outcome = swap(&mut fake, Side::Them, Mock::boxed("them_new", &log), &AtomicBool::new(false)).await;

        assert_eq!(outcome, SwapOutcome::Swapped);
        // The old Them provider stopped and the new one started; "You" saw nothing.
        assert_eq!(events(&log), ["them_old:stop", "them_new:muted=false", "them_new:start"]);
        assert_eq!(fake.providers[Side::Them.index()].as_ref().unwrap().provider_name(), "them_new");
        assert_eq!(fake.providers[Side::You.index()].as_ref().unwrap().provider_name(), "you_old");
        assert_eq!(fake.signals[Side::Them.index()].generation(), 1);
        assert_eq!(fake.signals[Side::You.index()].generation(), 0);
    }

    #[tokio::test]
    async fn the_new_provider_starts_with_the_sides_mute_state() {
        let log: Log = Default::default();
        let mut fake = FakeLoop::new(Some(Mock::boxed("you_old", &log)), None);

        swap(&mut fake, Side::You, Mock::boxed("you_new", &log), &AtomicBool::new(true)).await;

        assert!(events(&log).contains(&"you_new:muted=true".to_string()));
        assert!(fake.muted_applied[Side::You.index()]);
        assert!(!fake.muted_applied[Side::Them.index()]);
    }

    #[tokio::test]
    async fn a_side_without_a_provider_has_nothing_to_swap() {
        let log: Log = Default::default();
        let mut fake = FakeLoop::new(None, Some(Mock::boxed("them_old", &log)));

        let outcome = swap(&mut fake, Side::You, Mock::boxed("you_new", &log), &AtomicBool::new(false)).await;

        assert_eq!(outcome, SwapOutcome::NotRunning);
        assert!(events(&log).is_empty(), "nothing started or stopped");
        assert!(fake.providers[Side::You.index()].is_none());
        assert_eq!(fake.providers[Side::Them.index()].as_ref().unwrap().provider_name(), "them_old");
    }

    #[tokio::test]
    async fn a_new_provider_that_cant_start_leaves_that_side_without_stt_and_the_other_running() {
        let log: Log = Default::default();
        let mut fake = FakeLoop::new(Some(Mock::boxed("you_old", &log)), Some(Mock::boxed("them_old", &log)));
        let mut failing = Mock::new("you_new", &log);
        failing.fail_start = true;

        let outcome = swap(&mut fake, Side::You, Box::new(failing), &AtomicBool::new(false)).await;

        assert_eq!(outcome, SwapOutcome::StartFailed("no connection".into()));
        assert!(fake.providers[Side::You.index()].is_none());
        assert_eq!(fake.providers[Side::Them.index()].as_ref().unwrap().provider_name(), "them_old");
    }

    #[test]
    fn only_a_swap_that_could_not_start_is_an_error_for_the_caller() {
        assert_eq!(SwapOutcome::Swapped.into_answer(), Ok(true));
        assert_eq!(SwapOutcome::NotRunning.into_answer(), Ok(false));
        // The frontend then restarts the whole capture instead of marking the config applied.
        assert_eq!(
            SwapOutcome::StartFailed("no connection".into()).into_answer(),
            Err("Failed to start STT: no connection".to_string())
        );
    }

    #[tokio::test]
    async fn a_meeting_that_has_ended_is_not_running() {
        let log: Log = Default::default();
        let (sender, rx) = mpsc::unbounded_channel();
        drop(rx);
        let outcome =
            swap_side_provider(&sender, Side::You, Mock::boxed("you_new", &log), &AtomicBool::new(false)).await;
        assert_eq!(outcome, SwapOutcome::NotRunning);
    }

    #[tokio::test]
    async fn a_provider_taken_for_a_command_that_gave_up_goes_back() {
        let log: Log = Default::default();
        let mut fake = FakeLoop::new(Some(Mock::boxed("you_old", &log)), None);
        let (reply, answer) = oneshot::channel();
        drop(answer);
        fake.handle(SideSwapMsg::Take { side: Side::You, reply });
        assert_eq!(fake.providers[0].as_ref().unwrap().provider_name(), "you_old");
    }

    // ---- results are tagged by provider, and late ones arrive before the boundary

    #[tokio::test]
    async fn results_of_the_old_provider_that_arrive_after_its_stop_come_before_the_new_ones() {
        let log: Log = Default::default();
        let mut fake = FakeLoop::new(None, None);
        // Them has a first provider whose results are tagged generation 0.
        let (tx, rx) = mpsc::channel(64);
        fake.txs[Side::Them.index()] = Some(tx.clone());
        fake.rxs[Side::Them.index()] = Some(rx);
        let signal = fake.signals[Side::Them.index()].clone();
        let mut old = Mock::new("them_old", &log);
        // Sends its last chunk 50 ms after stop_stream, like a provider with a request in flight.
        old.late_after_stop = Some((vec![result("last words", true, 4_000)], Duration::from_millis(50)));
        let mut old: Box<dyn STTProvider> = Box::new(old);
        old.start_stream(signal.attach(&tx)).await.unwrap();
        fake.providers[Side::Them.index()] = Some(old);
        let mut new = Mock::new("them_new", &log);
        new.on_start = vec![result("nuevas palabras", true, 100)];

        let outcome = swap_within(&mut fake, Side::Them, Box::new(new), &AtomicBool::new(false), Duration::from_secs(2)).await;
        assert_eq!(outcome, SwapOutcome::Swapped);
        tokio::time::sleep(Duration::from_millis(50)).await; // the forwarding task is asynchronous

        let got = fake.received(Side::Them);
        let texts: Vec<(u32, &str)> = got.iter().map(|(g, t, _)| (*g, t.as_str())).collect();
        assert_eq!(texts, [(0, "last words"), (1, "nuevas palabras")]);
    }

    #[tokio::test]
    async fn a_straggler_past_the_drain_time_is_tagged_with_its_old_generation() {
        let log: Log = Default::default();
        let mut fake = FakeLoop::new(None, None);
        let (tx, rx) = mpsc::channel(64);
        fake.txs[0] = Some(tx.clone());
        fake.rxs[0] = Some(rx);
        let signal = fake.signals[0].clone();
        let mut old = Mock::new("you_old", &log);
        old.late_after_stop = Some((vec![result("very late", true, 4_000)], Duration::from_millis(300)));
        let mut old: Box<dyn STTProvider> = Box::new(old);
        old.start_stream(signal.attach(&tx)).await.unwrap();
        fake.providers[0] = Some(old);

        swap_within(&mut fake, Side::You, Mock::boxed("you_new", &log), &AtomicBool::new(false), Duration::from_millis(20)).await;
        tokio::time::sleep(Duration::from_millis(400)).await;

        let got = fake.received(Side::You);
        // The pump drops it: its generation (0) is older than the current one (1).
        assert_eq!(got.iter().map(|(g, t, _)| (*g, t.as_str())).collect::<Vec<_>>(), [(0, "very late")]);
        assert_eq!(fake.signals[0].generation(), 1);
    }

    // ---- timestamps stay on the meeting's time base

    #[test]
    fn stream_relative_timestamps_move_by_the_stream_start_and_epoch_ones_stay() {
        assert_eq!(meeting_timestamp(1_500, 60_000), 61_500);
        assert_eq!(meeting_timestamp(0, 60_000), 60_000);
        let epoch = 1_800_000_000_000;
        assert_eq!(meeting_timestamp(epoch, 60_000), epoch);
        // The first provider starts at the meeting's origin: nothing moves.
        assert_eq!(meeting_timestamp(1_500, 0), 1_500);
    }

    #[tokio::test]
    async fn a_replacement_stream_continues_the_meetings_time_base() {
        let log: Log = Default::default();
        let mut fake = FakeLoop::new(Some(Mock::boxed("you_old", &log)), None);
        // The meeting is 80 ms old when the stream restarts, so zero becomes about 80.
        tokio::time::sleep(Duration::from_millis(80)).await;
        let mut new = Mock::new("you_new", &log);
        new.on_start = vec![
            result("relative", true, 10),
            result("epoch", true, 1_800_000_000_000),
        ];
        swap(&mut fake, Side::You, Box::new(new), &AtomicBool::new(false)).await;
        // The adapter forwards asynchronously.
        tokio::time::sleep(Duration::from_millis(50)).await;

        let got = fake.received(Side::You);
        assert_eq!(got.len(), 2);
        assert!(got[0].2 >= 90 && got[0].2 < 2_000, "relative stamp moved onto the meeting's clock: {}", got[0].2);
        assert_eq!(got[1].2, 1_800_000_000_000, "epoch stamp unchanged");
    }

    // ---- the open line of a swapped side

    /// Run a side's transcript task over a channel until it is closed; returns its outputs.
    async fn run_side(
        mut rx: mpsc::Receiver<Tagged>,
        signal: Arc<SwapSignal>,
        out: Arc<Mutex<Vec<(String, bool)>>>,
    ) {
        let pause = AtomicU64::new(60_000);
        let mut acc = SegmentAccumulator::new(60_000);
        let sink = out.clone();
        pump_accumulated(&mut rx, &signal, &mut acc, &pause, |_| {}, move |o| {
            sink.lock().unwrap().push((format!("{}:{}", o.id, o.text), o.is_final));
        })
        .await;
        if let Some(o) = acc.flush() {
            out.lock().unwrap().push((format!("{}:{}", o.id, o.text), o.is_final));
        }
    }

    /// Let the spawned transcript tasks work through what they were sent.
    async fn settle() {
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
    }

    fn tag(generation: u32, result: TranscriptResult) -> Tagged {
        Tagged { generation, result }
    }

    #[tokio::test]
    async fn the_open_line_of_a_swapped_side_ends_before_the_new_providers_first_line() {
        let (tx, rx) = mpsc::channel(8);
        let signal: Arc<SwapSignal> = Arc::default();
        let out: Arc<Mutex<Vec<(String, bool)>>> = Default::default();
        let task = tokio::spawn(run_side(rx, signal.clone(), out.clone()));

        tx.send(tag(0, result("hello there", true, 1_000))).await.unwrap();
        tx.send(tag(0, result("how are you", true, 1_600))).await.unwrap();
        settle().await;
        signal.swapped();
        settle().await;
        tx.send(tag(1, result("hola amigo", true, 2_200))).await.unwrap();
        drop(tx);
        task.await.unwrap();

        let lines = out.lock().unwrap().clone();
        let finals: Vec<&str> = lines.iter().filter(|(_, f)| *f).map(|(l, _)| l.as_str()).collect();
        assert!(finals.iter().any(|l| l.starts_with("acc_1:") && l.contains("hello there") && l.contains("how are you")), "{finals:?}");
        assert!(finals.iter().any(|l| l.starts_with("acc_2:") && l.ends_with("hola amigo")), "{finals:?}");
        assert!(!finals.iter().any(|l| l.contains("how are you") && l.contains("hola amigo")), "{finals:?}");
    }

    #[tokio::test]
    async fn interim_only_words_of_the_old_provider_become_their_own_final_line() {
        let (tx, rx) = mpsc::channel(8);
        let signal: Arc<SwapSignal> = Arc::default();
        let out: Arc<Mutex<Vec<(String, bool)>>> = Default::default();
        let task = tokio::spawn(run_side(rx, signal.clone(), out.clone()));

        // No final yet: the old provider only guessed.
        tx.send(tag(0, result("good mor", false, 1_000))).await.unwrap();
        settle().await;
        signal.swapped();
        settle().await;
        tx.send(tag(1, result("buenos dias", true, 2_000))).await.unwrap();
        drop(tx);
        task.await.unwrap();

        let lines = out.lock().unwrap().clone();
        // The interim ("acc_1") is closed as a final with its words, and the new one gets "acc_2".
        assert!(lines.contains(&("acc_1:good mor".to_string(), true)), "{lines:?}");
        assert!(lines.contains(&("acc_2:buenos dias".to_string(), true)), "{lines:?}");
        assert!(!lines.contains(&("acc_1:buenos dias".to_string(), true)), "{lines:?}");
    }

    #[tokio::test]
    async fn a_new_providers_result_that_beats_the_swap_notice_still_starts_a_new_line() {
        let (tx, rx) = mpsc::channel(8);
        let signal: Arc<SwapSignal> = Arc::default();
        let out: Arc<Mutex<Vec<(String, bool)>>> = Default::default();
        let task = tokio::spawn(run_side(rx, signal.clone(), out.clone()));

        tx.send(tag(0, result("hello there", true, 1_000))).await.unwrap();
        // Both the new provider's result and, only after it, the notice are queued before the task runs.
        tx.send(tag(1, result("hola amigo", true, 2_000))).await.unwrap();
        signal.swapped();
        drop(tx);
        task.await.unwrap();

        let lines = out.lock().unwrap().clone();
        assert!(lines.contains(&("acc_2:hola amigo".to_string(), true)), "{lines:?}");
        assert!(!lines.iter().any(|(l, _)| l.contains("hello there") && l.contains("hola amigo")), "{lines:?}");
    }

    #[tokio::test]
    async fn a_late_result_of_the_old_provider_never_joins_the_new_line() {
        let (tx, rx) = mpsc::channel(8);
        let signal: Arc<SwapSignal> = Arc::default();
        let out: Arc<Mutex<Vec<(String, bool)>>> = Default::default();
        let task = tokio::spawn(run_side(rx, signal.clone(), out.clone()));

        tx.send(tag(0, result("hello there", true, 1_000))).await.unwrap();
        settle().await;
        signal.swapped();
        settle().await;
        tx.send(tag(1, result("hola amigo", true, 2_000))).await.unwrap();
        tx.send(tag(0, result("too late", true, 1_900))).await.unwrap();
        drop(tx);
        task.await.unwrap();

        let lines = out.lock().unwrap().clone();
        assert!(!lines.iter().any(|(l, _)| l.contains("too late")), "{lines:?}");
        assert!(lines.contains(&("acc_2:hola amigo".to_string(), true)), "{lines:?}");
    }

    #[tokio::test]
    async fn swapping_one_side_leaves_the_other_sides_open_line_open() {
        let (you_tx, you_rx) = mpsc::channel(8);
        let (them_tx, them_rx) = mpsc::channel(8);
        let (you_signal, them_signal): (Arc<SwapSignal>, Arc<SwapSignal>) = (Arc::default(), Arc::default());
        let (you_out, them_out): (Arc<Mutex<Vec<(String, bool)>>>, Arc<Mutex<Vec<(String, bool)>>>) =
            (Default::default(), Default::default());
        let you_task = tokio::spawn(run_side(you_rx, you_signal.clone(), you_out.clone()));
        let them_task = tokio::spawn(run_side(them_rx, them_signal.clone(), them_out.clone()));

        you_tx.send(tag(0, result("you open line", true, 1_000))).await.unwrap();
        them_tx.send(tag(0, result("them open line", true, 1_000))).await.unwrap();
        settle().await;
        // Only Them is swapped.
        them_signal.swapped();
        settle().await;
        // Both sides then get their next words: Them starts a new line, You's line goes on.
        you_tx.send(tag(0, result("you more", true, 1_400))).await.unwrap();
        them_tx.send(tag(1, result("them new words", true, 1_400))).await.unwrap();
        settle().await;
        let last_id = |out: &Arc<Mutex<Vec<(String, bool)>>>| {
            out.lock().unwrap().last().unwrap().0.split(':').next().unwrap().to_string()
        };
        assert_eq!(last_id(&them_out), "acc_2", "Them's open line ended at the swap");
        assert_eq!(last_id(&you_out), "acc_1", "You's open line is still open");

        drop((you_tx, them_tx));
        you_task.await.unwrap();
        them_task.await.unwrap();
    }

    #[tokio::test]
    async fn a_direct_sides_open_interim_line_is_finalized_at_the_swap() {
        let (tx, mut rx) = mpsc::channel(8);
        let signal: Arc<SwapSignal> = Arc::default();
        let lines: Arc<Mutex<Vec<(u32, String, bool)>>> = Default::default();
        let sink = lines.clone();
        let task = {
            let signal = signal.clone();
            tokio::spawn(async move {
                pump_direct(&mut rx, &signal, |_| {}, move |generation, r| {
                    sink.lock().unwrap().push((generation, r.text, r.is_final));
                })
                .await;
            })
        };

        tx.send(tag(0, result("good mor", false, 1_000))).await.unwrap();
        settle().await;
        signal.swapped();
        settle().await;
        drop(tx);
        task.await.unwrap();

        let got = lines.lock().unwrap().clone();
        assert_eq!(got, [(0, "good mor".to_string(), false), (0, "good mor".to_string(), true)]);
    }

    #[test]
    fn ids_of_a_swapped_provider_get_their_own_prefix() {
        assert_eq!(generation_prefix("a3", 0), "a3");
        assert_eq!(generation_prefix("a3", 2), "a3s2");
    }

    #[test]
    fn sides_parse_from_the_party_names() {
        assert_eq!(Side::parse("you"), Some(Side::You));
        assert_eq!(Side::parse("Them"), Some(Side::Them));
        assert_eq!(Side::parse("room"), None);
    }
}
