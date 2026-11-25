//! When to run the notes model. Pure: time comes in as an argument, nothing
//! is started here. The caller asks `poll(now)` and, on `Run`, calls
//! `begin_run`, makes the call, then `end_ok` / `end_err`.

use crate::live_common::{speech_units_x2, LlmErrorKind, RunGuard, RunState};

#[derive(Debug, Clone)]
pub struct NotesTriggerConfig {
    /// New words (CJK: two characters count as one word) before a normal run.
    pub min_words: u32,
    /// A pause in speech of at least this long before a normal run.
    pub pause_ms: u64,
    pub min_gap_ms: u64,
    /// A run is forced after this long if `forced_min_words` are waiting.
    pub max_gap_ms: u64,
    pub forced_min_words: u32,
    /// Counted tokens per meeting before "Keep taking notes?".
    pub cap_tokens: u64,
    pub max_failures: u32,
}

impl Default for NotesTriggerConfig {
    fn default() -> Self {
        Self {
            min_words: 100,
            pause_ms: 2_000,
            min_gap_ms: 20_000,
            max_gap_ms: 90_000,
            forced_min_words: 15,
            cap_tokens: 120_000,
            max_failures: 3,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunReason {
    Words,
    MaxGap,
    Manual,
    Final,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Wait,
    Run(RunReason),
}

/// What a started run took from the queue; given back if the run fails.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Taken {
    pub units_x2: u32,
}

#[derive(Debug, Clone)]
pub struct NotesTrigger {
    pub cfg: NotesTriggerConfig,
    pub guard: RunGuard,
    pending_x2: u32,
    last_speech_ms: Option<u64>,
    last_run_ms: Option<u64>,
    manual: bool,
    final_requested: bool,
}

impl NotesTrigger {
    pub fn new(cfg: NotesTriggerConfig) -> Self {
        let guard = RunGuard::new(cfg.cap_tokens, cfg.max_failures);
        Self { cfg, guard, pending_x2: 0, last_speech_ms: None, last_run_ms: None, manual: false, final_requested: false }
    }

    /// A finished transcript line arrived at `now`.
    pub fn on_line(&mut self, now: u64, text: &str) {
        let u = speech_units_x2(text);
        if u == 0 {
            return;
        }
        self.pending_x2 += u;
        self.last_speech_ms = Some(now);
    }

    pub fn pending_words(&self) -> u32 {
        self.pending_x2 / 2
    }

    pub fn state(&self) -> RunState {
        self.guard.state
    }

    pub fn request_manual(&mut self) {
        self.manual = true;
    }

    pub fn request_final(&mut self) {
        self.final_requested = true;
    }

    pub fn set_gate(&mut self, open: bool) {
        self.guard.set_gate(open);
    }

    pub fn poll(&mut self, now: u64) -> Decision {
        let nothing_new = self.pending_x2 == 0;
        if self.final_requested {
            if nothing_new || matches!(self.guard.state, RunState::Stopped | RunState::CapReached) {
                self.final_requested = false;
                return Decision::Wait;
            }
            if self.guard.can_start_final() {
                return Decision::Run(RunReason::Final);
            }
            return Decision::Wait;
        }
        if self.manual {
            if nothing_new {
                // never on silence: the request is dropped
                self.manual = false;
                return Decision::Wait;
            }
            if self.guard.can_start_manual() {
                return Decision::Run(RunReason::Manual);
            }
            if matches!(self.guard.state, RunState::Stopped | RunState::CapReached) {
                self.manual = false;
            }
            return Decision::Wait;
        }
        if nothing_new || !self.guard.can_start() {
            return Decision::Wait;
        }
        let since_run = self.last_run_ms.map(|t| now.saturating_sub(t));
        if let Some(s) = since_run {
            if s < self.cfg.min_gap_ms {
                return Decision::Wait;
            }
        }
        let words = self.pending_x2 / 2;
        let quiet_for = self.last_speech_ms.map(|t| now.saturating_sub(t)).unwrap_or(0);
        if words >= self.cfg.min_words && quiet_for >= self.cfg.pause_ms {
            return Decision::Run(RunReason::Words);
        }
        if words >= self.cfg.forced_min_words {
            let waited = since_run.unwrap_or(0);
            if self.last_run_ms.is_some() && waited >= self.cfg.max_gap_ms {
                return Decision::Run(RunReason::MaxGap);
            }
        }
        Decision::Wait
    }

    pub fn begin_run(&mut self, now: u64) -> Taken {
        self.guard.begin();
        self.manual = false;
        self.final_requested = false;
        let taken = Taken { units_x2: self.pending_x2 };
        self.pending_x2 = 0;
        self.last_run_ms = Some(now);
        taken
    }

    /// A run used only part of the queue (very long backlog): the rest stays.
    pub fn give_back(&mut self, units_x2: u32) {
        self.pending_x2 += units_x2;
    }

    /// Returns true when this run reached the cap.
    pub fn end_ok(&mut self, counted_tokens: u64) -> bool {
        self.guard.end_ok(counted_tokens)
    }

    /// A failed run: its lines go back to the queue.
    pub fn end_err(&mut self, kind: LlmErrorKind, taken: Taken, counted_tokens: u64) {
        self.pending_x2 += taken.units_x2;
        match kind {
            LlmErrorKind::PlanLimit => self.guard.end_plan_limit(),
            LlmErrorKind::Cancelled => self.guard.end_cancelled(),
            LlmErrorKind::Failed => self.guard.end_failed(counted_tokens),
        }
    }

    pub fn pause(&mut self) {
        self.guard.pause();
    }
    pub fn resume(&mut self) {
        self.guard.resume();
    }
    pub fn keep_going(&mut self) {
        self.guard.keep_going();
    }
    pub fn stop(&mut self) {
        self.guard.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::live_common::PauseReason;

    fn words(n: usize) -> String {
        vec!["word"; n].join(" ")
    }

    fn trig() -> NotesTrigger {
        NotesTrigger::new(NotesTriggerConfig::default())
    }

    #[test]
    fn runs_on_words_after_a_pause() {
        let mut t = trig();
        t.on_line(1_000, &words(100));
        assert_eq!(t.poll(1_500), Decision::Wait, "no pause yet");
        assert_eq!(t.poll(3_100), Decision::Run(RunReason::Words));
    }

    #[test]
    fn too_few_words_wait() {
        let mut t = trig();
        t.on_line(1_000, &words(99));
        assert_eq!(t.poll(30_000), Decision::Wait);
        t.on_line(31_000, "one more");
        assert_eq!(t.poll(34_000), Decision::Run(RunReason::Words));
    }

    #[test]
    fn min_gap_between_runs_and_queueing() {
        let mut t = trig();
        t.on_line(0, &words(120));
        assert_eq!(t.poll(3_000), Decision::Run(RunReason::Words));
        let taken = t.begin_run(3_000);
        assert_eq!(taken.units_x2, 240);
        // lines arrive while the run is in flight: they queue
        t.on_line(10_000, &words(150));
        assert_eq!(t.poll(15_000), Decision::Wait, "one at a time");
        t.end_ok(500);
        assert_eq!(t.poll(15_000), Decision::Wait, "min gap not over");
        assert_eq!(t.pending_words(), 150);
        assert_eq!(t.poll(23_100), Decision::Run(RunReason::Words));
    }

    #[test]
    fn forced_at_max_gap_even_without_pause() {
        let mut t = trig();
        t.on_line(0, &words(120));
        assert_eq!(t.poll(2_500), Decision::Run(RunReason::Words));
        t.begin_run(2_500);
        t.end_ok(10);
        // non-stop talking: 40 words, never a pause of 2 s
        for i in 0..90u64 {
            t.on_line(3_000 + i * 1_000, &words(1));
            let d = t.poll(3_000 + i * 1_000 + 500);
            if i < 87 {
                assert_eq!(d, Decision::Wait, "i={i}");
            }
        }
        // 90 s after the last run: forced (about 90 words waiting, 15 needed)
        assert_eq!(t.poll(2_500 + 90_000), Decision::Run(RunReason::MaxGap));
    }

    #[test]
    fn forced_needs_enough_words() {
        let mut t = trig();
        t.on_line(0, &words(120));
        t.begin_run(0);
        t.end_ok(1);
        t.on_line(50_000, &words(10));
        t.on_line(95_000, &words(1));
        assert_eq!(t.poll(95_100), Decision::Wait);
        t.on_line(95_200, &words(5));
        assert_eq!(t.poll(95_300), Decision::Run(RunReason::MaxGap));
    }

    #[test]
    fn never_on_silence() {
        let mut t = trig();
        assert_eq!(t.poll(1_000_000), Decision::Wait);
        t.request_manual();
        assert_eq!(t.poll(1_000_001), Decision::Wait);
        assert_eq!(t.poll(1_000_002), Decision::Wait, "manual request was dropped");
        t.request_final();
        assert_eq!(t.poll(1_000_003), Decision::Wait);
        t.on_line(0, "   ... ");
        assert_eq!(t.pending_words(), 0);
    }

    #[test]
    fn manual_skips_gap_and_threshold() {
        let mut t = trig();
        t.on_line(0, &words(10));
        t.begin_run(0);
        t.end_ok(1);
        t.on_line(1_000, &words(5));
        t.request_manual();
        assert_eq!(t.poll(2_000), Decision::Run(RunReason::Manual));
    }

    #[test]
    fn manual_waits_while_a_run_is_in_flight() {
        let mut t = trig();
        t.on_line(0, &words(120));
        t.begin_run(0);
        t.on_line(100, &words(5));
        t.request_manual();
        assert_eq!(t.poll(200), Decision::Wait);
        t.end_ok(1);
        assert_eq!(t.poll(300), Decision::Run(RunReason::Manual));
    }

    #[test]
    fn gate_closed_while_live_answer_is_busy() {
        let mut t = trig();
        t.on_line(0, &words(150));
        t.set_gate(false);
        assert_eq!(t.poll(5_000), Decision::Wait);
        t.request_manual();
        assert_eq!(t.poll(5_000), Decision::Wait);
        t.set_gate(true);
        assert_eq!(t.poll(5_000), Decision::Run(RunReason::Manual));
    }

    #[test]
    fn pause_and_resume() {
        let mut t = trig();
        t.on_line(0, &words(150));
        t.pause();
        assert_eq!(t.poll(5_000), Decision::Wait);
        t.resume();
        assert_eq!(t.poll(5_000), Decision::Run(RunReason::Words));
    }

    #[test]
    fn final_pass_ignores_gap_pause_and_gate_but_not_stop() {
        let mut t = trig();
        t.on_line(0, &words(150));
        t.begin_run(0);
        t.end_ok(1);
        t.on_line(1_000, &words(7));
        t.set_gate(false);
        t.request_final();
        assert_eq!(t.poll(1_100), Decision::Run(RunReason::Final));
        let mut s = trig();
        s.on_line(0, &words(7));
        s.stop();
        s.request_final();
        assert_eq!(s.poll(10), Decision::Wait);
    }

    #[test]
    fn final_waits_for_the_running_run() {
        let mut t = trig();
        t.on_line(0, &words(150));
        t.begin_run(0);
        t.on_line(10, &words(7));
        t.request_final();
        assert_eq!(t.poll(20), Decision::Wait);
        t.end_ok(1);
        assert_eq!(t.poll(30), Decision::Run(RunReason::Final));
    }

    #[test]
    fn three_failures_pause_and_lines_return() {
        let mut t = trig();
        t.on_line(0, &words(150));
        let mut now = 5_000;
        for i in 0..3 {
            assert_eq!(t.poll(now), Decision::Run(RunReason::Words), "i={i}");
            let taken = t.begin_run(now);
            t.end_err(LlmErrorKind::Failed, taken, 0);
            assert_eq!(t.pending_words(), 150);
            now += 21_000;
        }
        assert_eq!(t.state(), RunState::Paused(PauseReason::Failures));
        assert_eq!(t.poll(now), Decision::Wait);
        t.resume();
        assert_eq!(t.poll(now), Decision::Run(RunReason::Words));
        let taken = t.begin_run(now);
        t.end_ok(5);
        let _ = taken;
        // a success resets the streak
        t.on_line(now + 100, &words(150));
        let taken = t.begin_run(now + 30_000);
        t.end_err(LlmErrorKind::Failed, taken, 0);
        assert_eq!(t.guard.failures, 1);
    }

    #[test]
    fn plan_limit_pauses_with_reason_and_cancel_is_free() {
        let mut t = trig();
        t.on_line(0, &words(150));
        let taken = t.begin_run(5_000);
        t.end_err(LlmErrorKind::Cancelled, taken, 0);
        assert_eq!(t.state(), RunState::Running);
        assert_eq!(t.guard.failures, 0);
        let taken = t.begin_run(30_000);
        t.end_err(LlmErrorKind::PlanLimit, taken, 0);
        assert_eq!(t.state(), RunState::Paused(PauseReason::PlanLimit));
    }

    #[test]
    fn cap_reached_then_keep_going_adds_the_same_amount() {
        let mut t = NotesTrigger::new(NotesTriggerConfig { cap_tokens: 1_000, ..Default::default() });
        t.on_line(0, &words(150));
        t.begin_run(5_000);
        assert!(!t.end_ok(600));
        t.on_line(6_000, &words(150));
        t.begin_run(30_000);
        assert!(t.end_ok(600), "1200 >= 1000");
        assert_eq!(t.state(), RunState::CapReached);
        t.on_line(40_000, &words(150));
        assert_eq!(t.poll(60_000), Decision::Wait);
        t.request_manual();
        assert_eq!(t.poll(60_000), Decision::Wait, "cap blocks even manual runs");
        t.keep_going();
        assert_eq!(t.guard.cap, 2_200);
        assert_eq!(t.poll(60_000), Decision::Run(RunReason::Words));
    }

    #[test]
    fn cjk_counts_characters_as_half_words() {
        let mut t = trig();
        let jp = "来月の予算を承認します。".repeat(15); // 11 chars * 15 = 165 chars ~ 82 words
        t.on_line(0, &jp);
        assert_eq!(t.poll(5_000), Decision::Wait);
        t.on_line(100, &jp);
        assert_eq!(t.poll(5_000), Decision::Run(RunReason::Words));
    }

    #[test]
    fn stopped_never_runs() {
        let mut t = trig();
        t.on_line(0, &words(500));
        t.stop();
        assert_eq!(t.poll(60_000), Decision::Wait);
        t.request_manual();
        assert_eq!(t.poll(60_000), Decision::Wait);
    }
}
