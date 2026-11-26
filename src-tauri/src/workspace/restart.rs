//! When a session restarts after a change. Taking access away restarts at
//! once. Adding material (a document, a memory item) is coalesced: at most one
//! restart per 30 s for each meeting or chat. Editing what a session already used
//! (a note saved every 800 ms) restarts it only after 30 s without a further edit,
//! never once per autosave. A meeting's restart never happens while a live answer runs.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::Notify;

/// The least time between two restarts caused by grants.
pub const GRANT_COALESCE: Duration = Duration::from_secs(30);
/// Edits of what a session already used restart it after this long without another edit.
pub const EDIT_QUIET: Duration = Duration::from_secs(30);
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
    /// The least time since the last restart that the waiting restart needs:
    /// the strictest (smallest) of the requests that joined it.
    gap: Duration,
    /// The waiting restart comes from edits only: it waits for `EDIT_QUIET` after the last one.
    quiet: bool,
    last_edit: Option<Instant>,
    /// Wakes the waiter when the gap shortens or the restart is done.
    wake: Arc<Notify>,
}

/// What a waiting restart does next.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// Restart now.
    Restart,
    /// Look again after this long (or sooner, when woken).
    Sleep(Duration),
    /// Nothing waits any more (a revocation restarted it, or it was forgotten).
    Cancelled,
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
        decide_in(slots.get(key), now, busy, gap)
    }

    /// A restart happened (any kind): later grants count from now, and any
    /// restart that was waiting is done (its waiter is woken to find that out).
    pub fn restarted(&self, key: &str, now: Instant) {
        let mut slots = self.slots.lock().unwrap();
        let slot = slots.entry(key.to_string()).or_default();
        slot.last = Some(now);
        slot.pending = false;
        slot.waiting_since = None;
        slot.quiet = false;
        slot.last_edit = None;
        slot.wake.notify_one();
    }

    /// A restart with this `gap` must wait. True when this call made it wait
    /// (the caller starts the waiter). When one already waits, the strictest
    /// gap wins: a shorter one shortens the wait and wakes the waiter.
    pub fn mark_pending(&self, key: &str, gap: Duration) -> bool {
        self.mark_pending_at(key, gap, Instant::now())
    }

    /// [`mark_pending`](Self::mark_pending) at a given moment (for tests).
    pub fn mark_pending_at(&self, key: &str, gap: Duration, now: Instant) -> bool {
        let mut slots = self.slots.lock().unwrap();
        let slot = slots.entry(key.to_string()).or_default();
        if slot.pending {
            if slot.quiet {
                // a grant joins a wait for quiet: it follows the grant's own rule
                slot.quiet = false;
                slot.gap = gap;
                slot.wake.notify_one();
                return false;
            }
            if gap < slot.gap {
                slot.gap = gap;
                slot.wake.notify_one();
            }
            return false;
        }
        slot.pending = true;
        slot.waiting_since = Some(now);
        slot.gap = gap;
        slot.quiet = false;
        true
    }

    /// An edit of what the session already used happened at `now`. True when this call
    /// made a restart wait (the caller starts the waiter); otherwise the one already waiting
    /// now waits 30 s from this edit.
    pub fn edit_at(&self, key: &str, now: Instant) -> bool {
        let mut slots = self.slots.lock().unwrap();
        let slot = slots.entry(key.to_string()).or_default();
        slot.last_edit = Some(now);
        if slot.pending {
            return false;
        }
        slot.pending = true;
        slot.waiting_since = Some(now);
        slot.gap = Duration::ZERO;
        slot.quiet = true;
        true
    }

    /// The waiter's next move, from the slot as it is now (the gap and whether
    /// anything still waits are read again on every call).
    pub fn step(&self, key: &str, now: Instant, busy: bool) -> Step {
        let slots = self.slots.lock().unwrap();
        let Some(slot) = slots.get(key).filter(|s| s.pending) else {
            return Step::Cancelled;
        };
        if slot.quiet {
            if let Some(edit) = slot.last_edit {
                let quiet_for = now.saturating_duration_since(edit);
                if quiet_for < EDIT_QUIET {
                    return Step::Sleep(EDIT_QUIET - quiet_for);
                }
            }
        }
        match decide_in(Some(slot), now, busy, slot.gap) {
            Action::Now => Step::Restart,
            Action::Later(d) => Step::Sleep(d),
        }
    }

    /// What wakes the waiter of `key`.
    pub fn waker(&self, key: &str) -> Arc<Notify> {
        self.slots.lock().unwrap().entry(key.to_string()).or_default().wake.clone()
    }

    pub fn is_pending(&self, key: &str) -> bool {
        self.slots.lock().unwrap().get(key).is_some_and(|s| s.pending)
    }

    /// Forget a meeting or chat (it ended or was deleted); a waiter is woken to stop.
    pub fn forget(&self, key: &str) {
        if let Some(slot) = self.slots.lock().unwrap().remove(key) {
            slot.wake.notify_one();
        }
    }
}

fn decide_in(slot: Option<&Slot>, now: Instant, busy: bool, gap: Duration) -> Action {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A shorter gap than a grant's, for the strictest-gap tests.
    const EDIT_GAP: Duration = Duration::from_secs(5);

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
    fn typing_never_restarts_and_30_quiet_seconds_do() {
        let r = Restarts::default();
        let t0 = Instant::now();
        assert!(r.edit_at("meeting:m", t0), "the first edit starts the wait");
        // an autosave every 800 ms: always "wait for what is left of 30 s"
        let mut now = t0;
        for _ in 0..10 {
            now += Duration::from_millis(800);
            assert!(!r.edit_at("meeting:m", now));
            assert_eq!(r.step("meeting:m", now, false), Step::Sleep(EDIT_QUIET));
        }
        assert_eq!(r.step("meeting:m", now + Duration::from_secs(29), false), Step::Sleep(Duration::from_secs(1)));
        assert_eq!(r.step("meeting:m", now + EDIT_QUIET, false), Step::Restart);
        // a live answer still holds it back, for at most MAX_DEFER
        assert_eq!(r.step("meeting:m", now + EDIT_QUIET, true), Step::Sleep(BUSY_RECHECK));
        assert_eq!(r.step("meeting:m", t0 + MAX_DEFER + EDIT_QUIET + Duration::from_secs(60), true), Step::Restart);
        r.restarted("meeting:m", now + EDIT_QUIET);
        assert!(!r.is_pending("meeting:m"));
        assert!(r.edit_at("meeting:m", now + EDIT_QUIET + Duration::from_secs(1)), "a later edit starts a new wait");
    }

    #[test]
    fn a_grant_joining_a_wait_for_quiet_follows_its_own_rule() {
        let r = Restarts::default();
        let t0 = Instant::now();
        assert!(r.edit_at("chat:c", t0));
        assert!(!r.mark_pending_at("chat:c", GRANT_COALESCE, t0));
        // no restart happened before, so the grant is not held for the typing
        assert_eq!(r.step("chat:c", t0 + Duration::from_secs(1), false), Step::Restart);
    }

    #[test]
    fn a_busy_wait_ends_after_a_minute() {
        let r = Restarts::default();
        assert!(r.mark_pending("meeting:m", GRANT_COALESCE));
        let t1 = Instant::now();
        assert_eq!(r.decide_gap("meeting:m", t1 + Duration::from_secs(30), true, GRANT_COALESCE), Action::Later(BUSY_RECHECK));
        assert_eq!(r.decide_gap("meeting:m", t1 + MAX_DEFER + Duration::from_millis(5), true, GRANT_COALESCE), Action::Now);
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
        assert!(r.mark_pending("chat:c", GRANT_COALESCE), "the first grant starts the timer");
        assert!(!r.mark_pending("chat:c", GRANT_COALESCE), "the rest ride on it");
        assert!(r.is_pending("chat:c"));
        // A revocation restarts at once: the waiting grant is covered.
        r.restarted("chat:c", Instant::now());
        assert!(!r.is_pending("chat:c"));
        assert!(r.mark_pending("chat:c", GRANT_COALESCE));
        r.forget("chat:c");
        assert!(!r.is_pending("chat:c"));
    }

    // ── fake clock: the strictest request wins, a revocation cancels ───────────

    fn waiter(r: &Restarts, key: &str, now: Instant, busy: bool) -> Step {
        r.step(key, now, busy)
    }

    #[test]
    fn an_edit_that_arrives_while_a_grant_waits_shortens_the_wait() {
        let r = Restarts::default();
        let t0 = Instant::now();
        r.restarted("meeting:m", t0);
        // The grant waits for the 30 s mark.
        assert_eq!(r.decide_gap("meeting:m", t0 + Duration::from_secs(1), false, GRANT_COALESCE), Action::Later(Duration::from_secs(29)));
        assert!(r.mark_pending_at("meeting:m", GRANT_COALESCE, t0 + Duration::from_secs(1)));
        assert_eq!(waiter(&r, "meeting:m", t0 + Duration::from_secs(5), false), Step::Sleep(Duration::from_secs(25)));
        // An edit of what the session already used joins it: 5 s from the last restart.
        assert!(!r.mark_pending_at("meeting:m", EDIT_GAP, t0 + Duration::from_secs(2)), "it rides on the waiter");
        assert_eq!(waiter(&r, "meeting:m", t0 + Duration::from_secs(4), false), Step::Sleep(Duration::from_secs(1)));
        assert_eq!(waiter(&r, "meeting:m", t0 + Duration::from_secs(5), false), Step::Restart, "not at 30 s");
        // A later grant never lengthens it again.
        r.mark_pending_at("meeting:m", GRANT_COALESCE, t0 + Duration::from_secs(3));
        assert_eq!(waiter(&r, "meeting:m", t0 + Duration::from_secs(5), false), Step::Restart);
    }

    #[test]
    fn a_revocation_cancels_the_waiter_and_later_grants_count_from_it() {
        let r = Restarts::default();
        let t0 = Instant::now();
        r.restarted("meeting:m", t0);
        r.mark_pending_at("meeting:m", GRANT_COALESCE, t0 + Duration::from_secs(1));
        assert!(matches!(waiter(&r, "meeting:m", t0 + Duration::from_secs(2), false), Step::Sleep(_)));
        // The revocation restarts at once.
        r.restarted("meeting:m", t0 + Duration::from_secs(3));
        assert_eq!(waiter(&r, "meeting:m", t0 + Duration::from_secs(4), false), Step::Cancelled);
        assert!(!r.is_pending("meeting:m"));
        // The next grant waits from the revocation, not from the old restart.
        assert_eq!(r.decide("meeting:m", t0 + Duration::from_secs(10), false), Action::Later(Duration::from_secs(23)));
        // A forgotten key cancels too.
        r.mark_pending_at("meeting:m", EDIT_GAP, t0 + Duration::from_secs(11));
        r.forget("meeting:m");
        assert_eq!(waiter(&r, "meeting:m", t0 + Duration::from_secs(12), false), Step::Cancelled);
    }

    #[test]
    fn an_edit_while_a_live_answer_runs_waits_for_it_but_is_released_after_a_minute() {
        let r = Restarts::default();
        let t0 = Instant::now();
        r.restarted("meeting:m", t0);
        assert!(r.mark_pending_at("meeting:m", EDIT_GAP, t0 + Duration::from_secs(6)));
        // Answers keep running: it keeps waiting, however short its gap is.
        for s in [7, 20, 40, 65] {
            assert_eq!(waiter(&r, "meeting:m", t0 + Duration::from_secs(s), true), Step::Sleep(BUSY_RECHECK), "{s} s");
        }
        // 60 s after it began to wait it goes ahead.
        assert_eq!(waiter(&r, "meeting:m", t0 + Duration::from_secs(6) + MAX_DEFER, true), Step::Restart);
        // And when the answer ends sooner it goes at its gap.
        let r2 = Restarts::default();
        r2.restarted("meeting:n", t0);
        r2.mark_pending_at("meeting:n", EDIT_GAP, t0 + Duration::from_secs(1));
        assert_eq!(waiter(&r2, "meeting:n", t0 + Duration::from_secs(3), true), Step::Sleep(BUSY_RECHECK));
        assert_eq!(waiter(&r2, "meeting:n", t0 + Duration::from_secs(8), false), Step::Restart);
    }

    #[test]
    fn a_grant_then_an_edit_while_answering_still_waits_for_the_answer() {
        let r = Restarts::default();
        let t0 = Instant::now();
        r.restarted("meeting:m", t0);
        r.mark_pending_at("meeting:m", GRANT_COALESCE, t0 + Duration::from_secs(1));
        r.mark_pending_at("meeting:m", EDIT_GAP, t0 + Duration::from_secs(2));
        assert_eq!(waiter(&r, "meeting:m", t0 + Duration::from_secs(10), true), Step::Sleep(BUSY_RECHECK));
        assert_eq!(waiter(&r, "meeting:m", t0 + Duration::from_secs(10), false), Step::Restart);
    }

    #[tokio::test]
    async fn the_waiter_is_woken_when_the_gap_shortens_or_the_restart_is_done() {
        let r = Restarts::default();
        r.mark_pending("meeting:m", GRANT_COALESCE);
        let wake = r.waker("meeting:m");
        let woken = |wake: Arc<Notify>| async move { tokio::time::timeout(Duration::from_millis(500), wake.notified()).await.is_ok() };
        // A longer or equal gap does not wake it.
        r.mark_pending("meeting:m", GRANT_COALESCE);
        assert!(!tokio::time::timeout(Duration::from_millis(50), wake.notified()).await.is_ok());
        // A shorter one does.
        r.mark_pending("meeting:m", EDIT_GAP);
        assert!(woken(wake.clone()).await);
        // So does a restart that covers it.
        r.restarted("meeting:m", Instant::now());
        assert!(woken(wake).await);
    }
}
