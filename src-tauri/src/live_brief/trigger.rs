//! When to search and when to call the model for the live brief. Pure.
//!
//! * a local search every 30 s of speech (cheap, no model);
//! * the model only when half of the top passages changed, the topic changed,
//!   or the user pressed Refresh, and at least 45 s after the last call.

use crate::live_common::{LlmErrorKind, RunGuard, RunState};

#[derive(Debug, Clone)]
pub struct BriefTriggerConfig {
    pub search_every_speech_ms: u64,
    pub min_gap_ms: u64,
    /// How many top passages are compared between searches.
    pub top_k: usize,
    /// Share of the top passages that must be new to justify a call.
    pub changed_fraction: f32,
    pub cap_tokens: u64,
    pub max_failures: u32,
}

impl Default for BriefTriggerConfig {
    fn default() -> Self {
        Self {
            search_every_speech_ms: 30_000,
            min_gap_ms: 45_000,
            top_k: 6,
            changed_fraction: 0.5,
            // about 60k tokens an hour; the cap leaves room for two hours
            cap_tokens: 120_000,
            max_failures: 3,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchReason {
    Speech,
    Manual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BriefAction {
    Wait,
    Search(SearchReason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallReason {
    PassagesChanged,
    TopicChange,
    Manual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelDecision {
    Skip,
    Call(CallReason),
}

#[derive(Debug, Clone)]
pub struct BriefTrigger {
    pub cfg: BriefTriggerConfig,
    pub guard: RunGuard,
    speech_ms: u64,
    total_speech_ms: u64,
    last_call_ms: Option<u64>,
    last_top: Vec<String>,
    topic_dirty: bool,
    manual: bool,
    /// State before the call in flight, restored if it fails.
    prev_top: Vec<String>,
    prev_dirty: bool,
}

impl BriefTrigger {
    pub fn new(cfg: BriefTriggerConfig) -> Self {
        let guard = RunGuard::new(cfg.cap_tokens, cfg.max_failures);
        Self { cfg, guard, speech_ms: 0, total_speech_ms: 0, last_call_ms: None, last_top: vec![], topic_dirty: false, manual: false, prev_top: vec![], prev_dirty: false }
    }

    /// `ms` of speech just finished (silence never adds to this).
    pub fn on_speech(&mut self, ms: u64) {
        self.speech_ms += ms;
        self.total_speech_ms += ms;
    }

    pub fn on_topic_change(&mut self) {
        self.topic_dirty = true;
    }

    pub fn request_manual(&mut self) {
        self.manual = true;
    }

    pub fn set_gate(&mut self, open: bool) {
        self.guard.set_gate(open);
    }

    pub fn state(&self) -> RunState {
        self.guard.state
    }

    pub fn poll(&mut self, _now: u64) -> BriefAction {
        if self.manual {
            if self.total_speech_ms == 0 || matches!(self.guard.state, RunState::Stopped | RunState::CapReached) {
                self.manual = false;
                return BriefAction::Wait;
            }
            if self.guard.can_start_manual() {
                return BriefAction::Search(SearchReason::Manual);
            }
            return BriefAction::Wait;
        }
        if !self.guard.can_start() {
            return BriefAction::Wait;
        }
        if self.speech_ms >= self.cfg.search_every_speech_ms {
            return BriefAction::Search(SearchReason::Speech);
        }
        BriefAction::Wait
    }

    /// Share of the first `top_k` ids that were not in the last call.
    pub fn changed_share(&self, top: &[String]) -> f32 {
        let k = top.len().min(self.cfg.top_k);
        if k == 0 {
            return 0.0;
        }
        let new = top.iter().take(k).filter(|id| !self.last_top.contains(id)).count();
        new as f32 / k as f32
    }

    /// Called with the result of the local search. Decides whether to call.
    pub fn after_search(&mut self, now: u64, top_ids: &[String]) -> ModelDecision {
        self.speech_ms = 0;
        let manual = std::mem::take(&mut self.manual);
        if top_ids.is_empty() {
            return ModelDecision::Skip;
        }
        if manual {
            return ModelDecision::Call(CallReason::Manual);
        }
        if let Some(t) = self.last_call_ms {
            if now.saturating_sub(t) < self.cfg.min_gap_ms {
                return ModelDecision::Skip;
            }
        }
        if self.topic_dirty {
            return ModelDecision::Call(CallReason::TopicChange);
        }
        if self.changed_share(top_ids) >= self.cfg.changed_fraction {
            return ModelDecision::Call(CallReason::PassagesChanged);
        }
        ModelDecision::Skip
    }

    pub fn begin_call(&mut self, now: u64, sent_ids: &[String]) {
        self.guard.begin();
        self.last_call_ms = Some(now);
        self.prev_top = std::mem::take(&mut self.last_top);
        self.prev_dirty = self.topic_dirty;
        self.last_top = sent_ids.iter().take(self.cfg.top_k).cloned().collect();
        self.topic_dirty = false;
    }

    pub fn end_ok(&mut self, counted: u64) -> bool {
        self.guard.end_ok(counted)
    }

    /// A failed or cancelled call does not count as sent: the next search
    /// sees the same change again.
    pub fn end_err(&mut self, kind: LlmErrorKind, counted: u64) {
        match kind {
            LlmErrorKind::PlanLimit => self.guard.end_plan_limit(),
            LlmErrorKind::Cancelled => self.guard.end_cancelled(),
            LlmErrorKind::Failed => self.guard.end_failed(counted),
        }
        self.last_top = std::mem::take(&mut self.prev_top);
        self.topic_dirty = self.topic_dirty || self.prev_dirty;
        self.last_call_ms = None;
    }

    /// Scope changed: nothing carries over.
    pub fn reset_scope(&mut self) {
        self.last_top.clear();
        self.topic_dirty = false;
        self.speech_ms = 0;
        self.last_call_ms = None;
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

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn t() -> BriefTrigger {
        BriefTrigger::new(BriefTriggerConfig::default())
    }

    #[test]
    fn search_every_30s_of_speech_never_on_silence() {
        let mut b = t();
        assert_eq!(b.poll(1_000_000), BriefAction::Wait);
        b.on_speech(29_000);
        assert_eq!(b.poll(0), BriefAction::Wait);
        b.on_speech(2_000);
        assert_eq!(b.poll(0), BriefAction::Search(SearchReason::Speech));
        b.after_search(0, &ids(&["a"]));
        assert_eq!(b.poll(0), BriefAction::Wait, "counter restarted");
    }

    #[test]
    fn first_search_with_results_calls() {
        let mut b = t();
        b.on_speech(31_000);
        let top = ids(&["a", "b", "c", "d", "e", "f"]);
        assert_eq!(b.after_search(31_000, &top), ModelDecision::Call(CallReason::PassagesChanged));
    }

    #[test]
    fn half_changed_calls_less_does_not() {
        let mut b = t();
        let first = ids(&["a", "b", "c", "d", "e", "f"]);
        b.begin_call(0, &first);
        b.end_ok(100);
        b.on_speech(31_000);
        // 2 of 6 new
        assert_eq!(b.after_search(60_000, &ids(&["a", "b", "c", "d", "x", "y"])), ModelDecision::Skip);
        // 3 of 6 new
        assert_eq!(b.after_search(61_000, &ids(&["a", "b", "c", "x", "y", "z"])), ModelDecision::Call(CallReason::PassagesChanged));
        // order alone does not count
        assert_eq!(b.after_search(62_000, &ids(&["f", "e", "d", "c", "b", "a"])), ModelDecision::Skip);
    }

    #[test]
    fn min_gap_45s_even_for_topic_change() {
        let mut b = t();
        b.begin_call(10_000, &ids(&["a"]));
        b.end_ok(10);
        b.on_topic_change();
        assert_eq!(b.after_search(40_000, &ids(&["x", "y"])), ModelDecision::Skip);
        assert_eq!(b.after_search(56_000, &ids(&["x", "y"])), ModelDecision::Call(CallReason::TopicChange));
    }

    #[test]
    fn manual_bypasses_gap_but_needs_speech_and_results() {
        let mut b = t();
        b.request_manual();
        assert_eq!(b.poll(0), BriefAction::Wait, "no speech yet");
        b.on_speech(5_000);
        b.begin_call(0, &ids(&["a"]));
        b.end_ok(1);
        b.request_manual();
        assert_eq!(b.poll(1_000), BriefAction::Search(SearchReason::Manual));
        assert_eq!(b.after_search(1_000, &ids(&["a"])), ModelDecision::Call(CallReason::Manual));
        b.request_manual();
        assert_eq!(b.after_search(2_000, &[]), ModelDecision::Skip, "nothing found, nothing to call");
    }

    #[test]
    fn topic_change_flag_clears_after_a_call() {
        let mut b = t();
        b.on_topic_change();
        let top = ids(&["a", "b"]);
        assert_eq!(b.after_search(0, &top), ModelDecision::Call(CallReason::TopicChange));
        b.begin_call(0, &top);
        b.end_ok(1);
        assert_eq!(b.after_search(100_000, &top), ModelDecision::Skip);
    }

    #[test]
    fn one_at_a_time_gate_pause_cap_failures() {
        let mut b = t();
        b.on_speech(40_000);
        b.begin_call(0, &ids(&["a"]));
        assert_eq!(b.poll(1), BriefAction::Wait, "in flight");
        b.end_ok(10);
        b.set_gate(false);
        assert_eq!(b.poll(1), BriefAction::Wait, "live answer first");
        b.set_gate(true);
        assert_eq!(b.poll(1), BriefAction::Search(SearchReason::Speech));
        b.pause();
        assert_eq!(b.poll(1), BriefAction::Wait);
        b.resume();
        for _ in 0..3 {
            b.begin_call(0, &ids(&["a"]));
            b.end_err(LlmErrorKind::Failed, 0);
        }
        assert_eq!(b.state(), RunState::Paused(PauseReason::Failures));
        b.resume();
        b.begin_call(0, &ids(&["a"]));
        b.end_err(LlmErrorKind::PlanLimit, 0);
        assert_eq!(b.state(), RunState::Paused(PauseReason::PlanLimit));
    }

    #[test]
    fn cap_then_keep_going() {
        let mut b = BriefTrigger::new(BriefTriggerConfig { cap_tokens: 1_000, ..Default::default() });
        b.begin_call(0, &ids(&["a"]));
        assert!(b.end_ok(1_200));
        assert_eq!(b.state(), RunState::CapReached);
        b.on_speech(60_000);
        assert_eq!(b.poll(0), BriefAction::Wait);
        b.keep_going();
        assert_eq!(b.guard.cap, 2_200);
        assert_eq!(b.poll(0), BriefAction::Search(SearchReason::Speech));
    }

    #[test]
    fn scope_reset_forgets_sent_passages() {
        let mut b = t();
        b.begin_call(0, &ids(&["a", "b"]));
        b.end_ok(1);
        assert_eq!(b.changed_share(&ids(&["a", "b"])), 0.0);
        b.reset_scope();
        assert_eq!(b.changed_share(&ids(&["a", "b"])), 1.0);
    }
}
