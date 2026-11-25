//! The one state the UI shows for live notes and the brief
//! (`notetaker_state` / `brief_state` events and the `get_*_state` getters):
//!
//! `{meeting_id, status, reason, error_kind, can[], tokens_used, total_tokens,
//!   cap, next_in_ms, model}`
//!
//! `status`: off | waiting | on | running | paused | capped | error | finished.
//! "running" only while a call is in flight, "on" between runs, "waiting"
//! before the first words. `can` is what the person may do now: update,
//! pause, resume, keep_going, try_again, start.

use crate::live_common::{PauseReason, RunState};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ModelLabel {
    pub provider: String,
    pub model: String,
    /// "OpenAI · gpt-5-nano (cheapest)"
    pub label: String,
}

/// A stretch of the meeting the notes never covered (ms since the meeting started).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NotCovered {
    pub from_ms: u64,
    pub to_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RunSnapshot {
    pub meeting_id: String,
    pub status: &'static str,
    pub reason: Option<String>,
    pub error_kind: Option<String>,
    pub can: Vec<&'static str>,
    pub tokens_used: u64,
    pub total_tokens: u64,
    pub cap: u64,
    pub next_in_ms: Option<u64>,
    pub model: Option<ModelLabel>,
    /// Set once the notes are finished and part of the meeting was never covered.
    pub not_covered: Option<NotCovered>,
}

pub struct StateInput {
    pub meeting_id: String,
    pub state: RunState,
    pub in_flight: bool,
    pub tokens_used: u64,
    pub total_tokens: u64,
    pub cap: u64,
    pub last_error: Option<String>,
    pub error_code: &'static str,
    pub finished: bool,
    pub user_stopped: bool,
    /// Notes on manual: they only run on "Update now".
    pub manual_mode: bool,
    /// A run happened or words are waiting: it is past "waiting".
    pub started: bool,
    /// Speech (ms since the start) the finished notes do not cover.
    pub not_covered: Option<(u64, u64)>,
    pub next_in_ms: Option<u64>,
    pub final_note: Option<String>,
    pub stop_reason: Option<String>,
    pub model: Option<ModelLabel>,
}

fn kind_of(code: &str, plan_limit: bool) -> Option<String> {
    if plan_limit {
        return Some("plan_limit".into());
    }
    Some(if code.is_empty() { "failed" } else { code }.to_string())
}

pub fn snapshot(i: &StateInput) -> RunSnapshot {
    let mut error_kind = None;
    let (status, reason, can): (&'static str, Option<String>, Vec<&'static str>) = if i.finished {
        ("finished", i.final_note.clone(), if i.not_covered.is_some() { vec!["update"] } else { vec![] })
    } else if i.user_stopped || i.state == RunState::Stopped {
        ("off", i.stop_reason.clone(), vec!["start"])
    } else {
        match i.state {
            RunState::CapReached => ("capped", Some("The token cap for this meeting was reached".to_string()), vec!["keep_going"]),
            RunState::Paused(PauseReason::User) => ("paused", None, vec!["resume", "update"]),
            RunState::Paused(PauseReason::PlanLimit) => {
                error_kind = kind_of(i.error_code, true);
                ("paused", Some(i.last_error.clone().unwrap_or_else(|| "The plan's usage limit was reached".into())), vec!["try_again"])
            }
            RunState::Paused(PauseReason::Failures) => {
                error_kind = kind_of(i.error_code, false);
                ("error", Some(match i.last_error.as_deref().map(str::trim).filter(|e| !e.is_empty()) {
                    Some(e) => format!("Three runs in a row failed: {e}"),
                    None => "Three runs in a row failed and the model gave no reason. Try again runs it once more".to_string(),
                }), vec!["try_again", "update"])
            }
            RunState::Running => {
                if i.last_error.is_some() {
                    error_kind = kind_of(i.error_code, false);
                }
                if i.in_flight {
                    ("running", i.last_error.clone(), vec!["pause"])
                } else if i.manual_mode {
                    ("on", Some("Manual: it updates when you press Update now".to_string()), vec!["pause", "update"])
                } else if !i.started {
                    ("waiting", i.last_error.clone(), vec!["pause", "update"])
                } else {
                    ("on", i.last_error.clone(), vec!["pause", "update"])
                }
            }
            RunState::Stopped => unreachable!("handled above"),
        }
    };
    let next_in_ms = if status == "on" || status == "waiting" { i.next_in_ms } else { None };
    RunSnapshot {
        meeting_id: i.meeting_id.clone(),
        status,
        reason,
        error_kind,
        can,
        tokens_used: i.tokens_used,
        total_tokens: i.total_tokens,
        cap: i.cap,
        next_in_ms,
        model: i.model.clone(),
        not_covered: if status == "finished" { i.not_covered.map(|(from_ms, to_ms)| NotCovered { from_ms, to_ms }) } else { None },
    }
}

/// The state of a feature that has no actor (never started, stopped, or after a restart).
pub fn idle_snapshot(meeting_id: &str, stored_status: Option<&str>, tokens_used: u64, cap: u64, reason: Option<String>, model: Option<ModelLabel>, not_covered: Option<(u64, u64)>) -> RunSnapshot {
    let (status, can): (&'static str, Vec<&'static str>) = match stored_status {
        Some("done") if not_covered.is_some() => ("finished", vec!["update"]),
        Some("done") => ("finished", vec![]),
        Some("cap_reached") => ("capped", vec!["keep_going"]),
        _ => ("off", vec!["start"]),
    };
    RunSnapshot { meeting_id: meeting_id.to_string(), status, reason, error_kind: None, can, tokens_used, total_tokens: 0, cap, next_in_ms: None, model, not_covered: if status == "finished" { not_covered.map(|(from_ms, to_ms)| NotCovered { from_ms, to_ms }) } else { None } }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> StateInput {
        StateInput {
            meeting_id: "m".into(),
            state: RunState::Running,
            in_flight: false,
            tokens_used: 0,
            total_tokens: 0,
            cap: 120_000,
            last_error: None,
            error_code: "",
            finished: false,
            user_stopped: false,
            manual_mode: false,
            started: false,
            not_covered: None,
            next_in_ms: Some(12_000),
            final_note: None,
            stop_reason: None,
            model: None,
        }
    }

    #[test]
    fn running_only_while_a_call_is_in_flight_on_between_runs_waiting_before_the_first_words() {
        let mut i = base();
        assert_eq!(snapshot(&i).status, "waiting");
        i.started = true;
        i.tokens_used = 900;
        let s = snapshot(&i);
        assert_eq!((s.status, s.can.clone(), s.next_in_ms), ("on", vec!["pause", "update"], Some(12_000)));
        i.in_flight = true;
        let s = snapshot(&i);
        assert_eq!((s.status, s.can, s.next_in_ms), ("running", vec!["pause"], None));
    }

    #[test]
    fn every_state_offers_what_can_be_done_next() {
        let mut i = base();
        i.started = true;
        i.state = RunState::Paused(PauseReason::User);
        assert_eq!(snapshot(&i).can, vec!["resume", "update"]);
        i.state = RunState::CapReached;
        assert_eq!((snapshot(&i).status, snapshot(&i).can), ("capped", vec!["keep_going"]));
        i.state = RunState::Paused(PauseReason::PlanLimit);
        i.last_error = Some("Usage limit reached".into());
        let s = snapshot(&i);
        assert_eq!((s.status, s.error_kind.as_deref(), s.reason.as_deref(), s.can), ("paused", Some("plan_limit"), Some("Usage limit reached"), vec!["try_again"]));
        i.state = RunState::Paused(PauseReason::Failures);
        i.last_error = Some("no key".into());
        i.error_code = "no_key";
        let s = snapshot(&i);
        assert_eq!((s.status, s.error_kind.as_deref(), s.can), ("error", Some("no_key"), vec!["try_again", "update"]));
        i.state = RunState::Stopped;
        i.user_stopped = true;
        assert_eq!((snapshot(&i).status, snapshot(&i).can), ("off", vec!["start"]));
    }

    #[test]
    fn manual_mode_says_so_and_a_finished_manual_meeting_offers_update() {
        let mut i = base();
        i.manual_mode = true;
        i.started = true;
        let s = snapshot(&i);
        assert_eq!((s.status, s.can.contains(&"update"), s.next_in_ms), ("on", true, Some(12_000)));
        assert!(s.reason.unwrap().contains("Update now"));
        i.finished = true;
        i.not_covered = Some((60_000, 120_000));
        i.final_note = Some("Notes were on manual. Not covered: 02:00 to 40:00".into());
        let s = snapshot(&i);
        assert_eq!((s.status, s.can), ("finished", vec!["update"]));
    }

    #[test]
    fn idle_states() {
        assert_eq!(idle_snapshot("m", None, 0, 100, None, None, None).can, vec!["start"]);
        assert_eq!(idle_snapshot("m", Some("done"), 5, 100, None, None, None).status, "finished");
        assert_eq!(idle_snapshot("m", Some("cap_reached"), 100, 100, None, None, None).can, vec!["keep_going"]);
        let s = idle_snapshot("m", Some("done"), 5, 100, None, None, Some((60_000, 90_000)));
        assert_eq!((s.status, s.can, s.not_covered.map(|n| (n.from_ms, n.to_ms))), ("finished", vec!["update"], Some((60_000, 90_000))));
    }
}
