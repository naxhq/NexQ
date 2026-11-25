//! When a session restarts after a change. Taking access away restarts at
//! once. Adding or editing material (a note saved every 800 ms, a document, a
//! memory item) is coalesced: at most one restart per 30 s for each meeting or
//! chat, and a meeting's never while a live answer is running.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// The least time between two restarts caused by grants.
pub const GRANT_COALESCE: Duration = Duration::from_secs(30);
/// The least time between two restarts caused by edits of what a session already used.
pub const EDIT_GAP: Duration = Duration::from_secs(5);
/// A waiting restart happens after this long even while a live answer runs.
pub const MAX_DEFER: Duration = Duration::from_secs(60);
/// How often a waiting restart looks again while a live answer is running.
pub const BUSY_RECHECK: Duration = Duration::from_secs(2);

/// What to do with a restart that a grant asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Now,
    Later(Duration),
}

#[derive(Default)]
struct Slot {
    last: Option<Instant>,
    pending: bool,
    waiting_since: Option<Instant>,
}

/// The restarts of each meeting or chat (key `meeting:<id>` or `chat:<id>`).
#[derive(Default)]
pub struct Restarts {
    slots: Mutex<HashMap<String, Slot>>,
}

impl Restarts {
    /// Whether a grant's restart may happen now. `busy`: a live answer is running.
    pub fn decide(&self, key: &str, now: Instant, busy: bool) -> Action {
        self.decide_gap(key, now, busy, GRANT_COALESCE)
    }

    /// [`decide`](Self::decide) with the least time since the last restart.
    /// A restart that has waited `MAX_DEFER` happens even while a live answer runs.
    pub fn decide_gap(&self, key: &str, now: Instant, busy: bool, gap: Duration) -> Action {
        let slots = self.slots.lock().unwrap();
        let slot = slots.get(key);
        if busy {
            let waited = slot.and_then(|s| s.waiting_since).map(|t| now.saturating_duration_since(t));
            return match waited {
                Some(w) if w >= MAX_DEFER => Action::Now,
                _ => Action::Later(BUSY_RECHECK),
            };
        }
        match slot.and_then(|s| s.last) {
            Some(last) if now.saturating_duration_since(last) < gap => Action::Later(gap - now.saturating_duration_since(last)),
            _ => Action::Now,
        }
    }

    /// A restart happened (any kind): later grants count from now, and any
    /// restart that was waiting is done.
    pub fn restarted(&self, key: &str, now: Instant) {
        let mut slots = self.slots.lock().unwrap();
        let slot = slots.entry(key.to_string()).or_default();
        slot.last = Some(now);
        slot.pending = false;
        slot.waiting_since = None;
    }

    /// A restart is waiting for its time. True when this call made it wait
    /// (the caller starts the timer); false when one already waits.
    pub fn mark_pending(&self, key: &str) -> bool {
        let mut slots = self.slots.lock().unwrap();
        let slot = slots.entry(key.to_string()).or_default();
        let first = !std::mem::replace(&mut slot.pending, true);
        if first {
            slot.waiting_since = Some(Instant::now());
        }
        first
    }

    pub fn is_pending(&self, key: &str) -> bool {
        self.slots.lock().unwrap().get(key).is_some_and(|s| s.pending)
    }

    /// Forget a meeting or chat (it ended or was deleted).
    pub fn forget(&self, key: &str) {
        self.slots.lock().unwrap().remove(key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_grant_restarts_at_once_and_the_next_ones_wait_for_the_30_second_mark() {
        let r = Restarts::default();
        let t0 = Instant::now();
        assert_eq!(r.decide("meeting:m", t0, false), Action::Now);
        r.restarted("meeting:m", t0);
        // An autosave 800 ms later, and again: they wait for what is left of 30 s.
        assert_eq!(r.decide("meeting:m", t0 + Duration::from_millis(800), false), Action::Later(GRANT_COALESCE - Duration::from_millis(800)));
        assert_eq!(r.decide("meeting:m", t0 + Duration::from_secs(29), false), Action::Later(Duration::from_secs(1)));
        assert_eq!(r.decide("meeting:m", t0 + GRANT_COALESCE, false), Action::Now);
        // Another meeting is not held back.
        assert_eq!(r.decide("meeting:other", t0 + Duration::from_secs(1), false), Action::Now);
    }

    #[test]
    fn an_edit_waits_five_seconds_and_a_busy_wait_ends_after_a_minute() {
        let r = Restarts::default();
        let t0 = Instant::now();
        r.restarted("meeting:m", t0);
        assert_eq!(r.decide_gap("meeting:m", t0 + Duration::from_secs(1), false, EDIT_GAP), Action::Later(Duration::from_secs(4)));
        assert_eq!(r.decide_gap("meeting:m", t0 + Duration::from_secs(5), false, EDIT_GAP), Action::Now);
        // a restart that waits while answers keep running is let through after MAX_DEFER
        assert!(r.mark_pending("meeting:m"));
        let t1 = Instant::now();
        assert_eq!(r.decide_gap("meeting:m", t1 + Duration::from_secs(30), true, EDIT_GAP), Action::Later(BUSY_RECHECK));
        assert_eq!(r.decide_gap("meeting:m", t1 + MAX_DEFER + Duration::from_millis(5), true, EDIT_GAP), Action::Now);
    }

    #[test]
    fn a_grant_never_restarts_while_a_live_answer_runs() {
        let r = Restarts::default();
        let t0 = Instant::now();
        assert_eq!(r.decide("meeting:m", t0, true), Action::Later(BUSY_RECHECK));
        r.restarted("meeting:m", t0);
        assert_eq!(r.decide("meeting:m", t0 + Duration::from_secs(60), true), Action::Later(BUSY_RECHECK));
        assert_eq!(r.decide("meeting:m", t0 + Duration::from_secs(60), false), Action::Now);
    }

    #[test]
    fn one_waiting_restart_per_key_and_a_restart_clears_it() {
        let r = Restarts::default();
        assert!(r.mark_pending("chat:c"), "the first grant starts the timer");
        assert!(!r.mark_pending("chat:c"), "the rest ride on it");
        assert!(r.is_pending("chat:c"));
        // A revocation restarts at once: the waiting grant is covered.
        r.restarted("chat:c", Instant::now());
        assert!(!r.is_pending("chat:c"));
        assert!(r.mark_pending("chat:c"));
        r.forget("chat:c");
        assert!(!r.is_pending("chat:c"));
    }
}
