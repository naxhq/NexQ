//! Restarting the speech-to-text of one side of a running meeting.
//!
//! The audio loop of `start_capture_per_party` owns both sides' providers. To
//! change one side's language without touching the other side, the capture or
//! the recording, the `set_party_language` command asks the loop to hand that
//! side's provider over (`Take`), stops it, starts a new one on the same
//! result channel and gives it back (`Put`). The loop keeps running meanwhile:
//! audio for that side isn't transcribed during the swap, but it is still
//! recorded and measured, and the other side's provider keeps being fed.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, oneshot, Notify};

use crate::stt::provider::{STTProvider, TranscriptResult};
use crate::stt::segment_accumulator::{AccumulatorOutput, SegmentAccumulator};

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

pub type ResultTx = mpsc::Sender<TranscriptResult>;

/// What a side's transcript task learns about swaps of its provider.
#[derive(Default)]
pub struct SwapSignal {
    generation: AtomicU32,
    flush: Notify,
}

impl SwapSignal {
    /// How many times the side's provider has been swapped. A side that keeps
    /// provider-made segment ids puts it in its ids, so the new provider's
    /// first lines don't reuse the old one's.
    pub fn generation(&self) -> u32 {
        self.generation.load(Ordering::Relaxed)
    }

    /// The old provider has stopped: new ids from now on, and the line the
    /// transcript task has open ends as a final line of its own.
    pub fn swapped(&self) {
        self.generation.fetch_add(1, Ordering::Relaxed);
        self.flush.notify_one();
    }
}

/// Run a side's transcript task until its result channel closes: feed every
/// result to the accumulator, and end the open line when the side's provider
/// is swapped (after the results the old provider sent while stopping, and
/// before anything the new one sends). The caller flushes at the end.
pub async fn pump_accumulated(
    rx: &mut mpsc::Receiver<TranscriptResult>,
    signal: &SwapSignal,
    accumulator: &mut SegmentAccumulator,
    pause_threshold: &AtomicU64,
    mut on_result: impl FnMut(&TranscriptResult),
    mut on_output: impl FnMut(AccumulatorOutput),
) {
    loop {
        tokio::select! {
            biased;
            received = rx.recv() => {
                let Some(result) = received else { break };
                on_result(&result);
                // Live-update the threshold from settings changes.
                accumulator.set_pause_threshold(pause_threshold.load(Ordering::Relaxed));
                for output in accumulator.feed_result(result) {
                    on_output(output);
                }
            }
            _ = signal.flush.notified() => {
                if let Some(output) = accumulator.flush() {
                    on_output(output);
                }
            }
        }
    }
}

/// A side's provider, handed over by the audio loop together with what a new provider needs.
pub struct TakenSide<P> {
    pub provider: P,
    /// The side's result channel; the transcript task of the side reads its other end.
    pub tx: ResultTx,
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
    tx: Option<&ResultTx>,
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

/// Replace one side's provider with `new_provider`: stop the old one, start the
/// new one on the same result channel, hand it to the loop. The other side is not involved.
pub async fn swap_side_provider(
    sender: &SideSwapSender,
    side: Side,
    mut new_provider: Box<dyn STTProvider>,
    muted_flag: &AtomicBool,
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
    signal.swapped();

    let muted = muted_flag.load(Ordering::Relaxed);
    new_provider.set_muted(muted);
    let (started, outcome) = match new_provider.start_stream(tx).await {
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
    use std::sync::Mutex;

    type Log = Arc<Mutex<Vec<String>>>;

    struct Mock {
        name: &'static str,
        log: Log,
        fail_start: bool,
    }

    impl Mock {
        fn boxed(name: &'static str, log: &Log) -> Box<dyn STTProvider> {
            Box::new(Mock { name, log: log.clone(), fail_start: false })
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
            _tx: ResultTx,
        ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
            if self.fail_start {
                return Err("no connection".into());
            }
            self.note("start");
            Ok(())
        }
        async fn feed_audio(&mut self, _c: AudioChunk) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
            Ok(())
        }
        async fn stop_stream(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
            self.note("stop");
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
        txs: [Option<ResultTx>; 2],
        signals: [Arc<SwapSignal>; 2],
        muted_applied: [bool; 2],
    }

    impl FakeLoop {
        fn new(you: Option<Box<dyn STTProvider>>, them: Option<Box<dyn STTProvider>>) -> Self {
            let (tx, _rx) = mpsc::channel(4);
            let have = [you.is_some(), them.is_some()];
            FakeLoop {
                providers: [you, them],
                txs: [have[0].then(|| tx.clone()), have[1].then(|| tx.clone())],
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
    }

    /// Run `swap_side_provider` while a fake loop answers its messages.
    async fn swap(
        fake: &mut FakeLoop,
        side: Side,
        new: Box<dyn STTProvider>,
        muted: &AtomicBool,
    ) -> SwapOutcome {
        let (sender, mut rx) = mpsc::unbounded_channel();
        let swapping = swap_side_provider(&sender, side, new, muted);
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
        let failing: Box<dyn STTProvider> =
            Box::new(Mock { name: "you_new", log: log.clone(), fail_start: true });

        let outcome = swap(&mut fake, Side::You, failing, &AtomicBool::new(false)).await;

        assert_eq!(outcome, SwapOutcome::StartFailed("no connection".into()));
        assert!(fake.providers[Side::You.index()].is_none());
        assert_eq!(fake.providers[Side::Them.index()].as_ref().unwrap().provider_name(), "them_old");
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

    fn final_result(text: &str, at: u64) -> TranscriptResult {
        TranscriptResult {
            text: text.into(),
            is_final: true,
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

    /// Let the spawned transcript tasks work through what they were sent.
    async fn settle() {
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
    }

    /// Run a side's transcript task over a channel until it is closed; returns its outputs.
    async fn run_side(
        mut rx: mpsc::Receiver<TranscriptResult>,
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

    #[tokio::test]
    async fn the_open_line_of_a_swapped_side_ends_before_the_new_providers_first_line() {
        let (tx, rx) = mpsc::channel(8);
        let signal: Arc<SwapSignal> = Arc::default();
        let out: Arc<Mutex<Vec<(String, bool)>>> = Default::default();
        let task = tokio::spawn(run_side(rx, signal.clone(), out.clone()));

        // The old provider's line is open (a long pause threshold keeps it open).
        tx.send(final_result("hello there", 1_000)).await.unwrap();
        // Swapped: the old provider's last result is already queued, then the signal.
        tx.send(final_result("how are you", 1_600)).await.unwrap();
        settle().await; // the task has taken what the old provider sent
        signal.swapped();
        settle().await;
        // The new provider's first words, right after.
        tx.send(final_result("hola amigo", 2_200)).await.unwrap();
        drop(tx);
        task.await.unwrap();

        let lines: Vec<(String, bool)> = out.lock().unwrap().iter().filter(|(_, f)| *f).cloned().collect();
        let finals: Vec<&str> = lines.iter().map(|(l, _)| l.as_str()).collect();
        // The old line closed with everything the old provider said, on its own id...
        assert!(finals.iter().any(|l| l.starts_with("acc_1:") && l.contains("hello there") && l.contains("how are you")), "{finals:?}");
        // ...and the new provider's words are another line.
        assert!(finals.iter().any(|l| l.starts_with("acc_2:") && l.ends_with("hola amigo")), "{finals:?}");
        assert!(!finals.iter().any(|l| l.contains("how are you") && l.contains("hola amigo")), "{finals:?}");
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

        you_tx.send(final_result("you open line", 1_000)).await.unwrap();
        them_tx.send(final_result("them open line", 1_000)).await.unwrap();
        settle().await;
        // Only Them is swapped.
        them_signal.swapped();
        settle().await;
        // Both sides then get their next words: Them starts a new line, You's line goes on.
        you_tx.send(final_result("you more", 1_400)).await.unwrap();
        them_tx.send(final_result("them new words", 1_400)).await.unwrap();
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
