//! The runtimes against fakes: a scripted model service, an in-memory
//! database with every migration, a fake clock and a recording emitter.

use super::db::LiveDb;
use super::llm::{LlmFactory, LlmSlot, Selection};
use super::notes::{doc_to_contract, NoteEdit};
use super::*;
use crate::ai_runs::AiPurpose;
use crate::live_common::{FakeClock, LlmCall, LlmError, LlmReply, LlmRequest};
use crate::llm::provider::CancelToken;
use crate::workspace::test_support::{file, memory_db, new_ws};
use async_trait::async_trait;
use rusqlite::Connection;
use serde_json::json;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

// ---------------------------------------------------------------- fakes

#[derive(Default)]
struct FakeState {
    replies: Mutex<VecDeque<Result<LlmReply, LlmError>>>,
    calls: Mutex<Vec<(AiPurpose, String, LlmRequest)>>,
    delay: Mutex<Duration>,
    cancel_seen: AtomicUsize,
    inflight: AtomicUsize,
    max_inflight: AtomicUsize,
    /// A provider that never answers and ignores cancel.
    ignore_cancel: AtomicBool,
    /// The provider the fake app has active ("" = not simulated, "none" = no usable provider).
    active: Mutex<String>,
    /// Which provider each call was made for.
    providers: Mutex<Vec<String>>,
}

impl FakeState {
    fn count(&self, p: AiPurpose) -> usize {
        self.calls.lock().unwrap().iter().filter(|c| c.0 == p).count()
    }
    fn prompts(&self, p: AiPurpose) -> Vec<String> {
        self.calls.lock().unwrap().iter().filter(|c| c.0 == p).map(|c| format!("{}\n{}", c.2.system, c.2.user)).collect()
    }
    fn push(&self, r: Result<LlmReply, LlmError>) {
        self.replies.lock().unwrap().push_back(r);
    }
}

struct FakeLlm {
    st: Arc<FakeState>,
    purpose: AiPurpose,
    meeting: String,
    cancel: Arc<CancelToken>,
    provider: String,
}

#[async_trait]
impl LlmCall for FakeLlm {
    async fn call(&self, req: &LlmRequest) -> Result<LlmReply, LlmError> {
        if !self.provider.is_empty() {
            self.st.providers.lock().unwrap().push(self.provider.clone());
        }
        self.st.calls.lock().unwrap().push((self.purpose, self.meeting.clone(), req.clone()));
        let now = self.st.inflight.fetch_add(1, Ordering::SeqCst) + 1;
        self.st.max_inflight.fetch_max(now, Ordering::SeqCst);
        let delay = *self.st.delay.lock().unwrap();
        let out = if delay.is_zero() {
            Ok(())
        } else {
            if self.st.ignore_cancel.load(Ordering::SeqCst) {
                tokio::time::sleep(delay).await;
                Ok(())
            } else {
                tokio::select! {
                    _ = tokio::time::sleep(delay) => Ok(()),
                    _ = self.cancel.cancelled() => { self.st.cancel_seen.fetch_add(1, Ordering::SeqCst); Err(LlmError::cancelled()) }
                }
            }
        };
        self.st.inflight.fetch_sub(1, Ordering::SeqCst);
        out?;
        if let Some(r) = self.st.replies.lock().unwrap().pop_front() {
            return r;
        }
        let text = match self.purpose {
            AiPurpose::Brief => r#"{"now":"Acme pricing","facts":[{"text":"Acme pays 12 dollars per seat","source":"P1"}]}"#,
            AiPurpose::Memory => r#"{"items":[{"kind":"fact","title":"Acme price","text":"Acme pays 12 dollars per seat","t":"00:10"}]}"#,
            _ => r#"{"ops":[{"op":"add","type":"bullet","text":"Something was said","t":"00:10"}]}"#,
        };
        Ok(LlmReply { text: text.into(), input_tokens: Some(900), output_tokens: Some(40), cached_input_tokens: Some(600) })
    }
}

struct FakeFactory(Arc<FakeState>);

impl LlmFactory for FakeFactory {
    fn provider_of(&self, _sel: &Selection) -> Option<String> {
        let a = self.0.active.lock().unwrap().clone();
        if a.is_empty() || a == "none" {
            None
        } else {
            Some(a)
        }
    }

    fn resolved(&self, _sel: &Selection) -> Result<String, String> {
        let a = self.0.active.lock().unwrap().clone();
        if a == "none" {
            Err("No AI provider is set up".to_string())
        } else {
            Ok(a)
        }
    }

    fn label(&self, _sel: &Selection) -> Option<super::state::ModelLabel> {
        let a = self.0.active.lock().unwrap().clone();
        if a.is_empty() || a == "none" {
            return None;
        }
        Some(super::state::ModelLabel { label: format!("{a} model"), provider: a, model: "model".into() })
    }

    fn make(&self, purpose: AiPurpose, meeting_id: &str, _sel: &Selection) -> Result<LlmSlot, String> {
        let cancel = Arc::new(CancelToken::new());
        let provider = self.0.active.lock().unwrap().clone();
        Ok(LlmSlot { llm: Arc::new(FakeLlm { st: self.0.clone(), purpose, meeting: meeting_id.to_string(), cancel: cancel.clone(), provider }), cancel, expected: Arc::new(std::sync::atomic::AtomicU64::new(super::llm::NO_GENERATION)) })
    }
}

#[derive(Default)]
struct Events {
    all: Mutex<Vec<(String, Value)>>,
    /// Set by the property test: every published sheet is checked against the scope in force at that moment.
    watch: Mutex<Option<(Arc<Mutex<Connection>>, String)>>,
    violations: Mutex<Vec<String>>,
}

/// The workspaces (by letter in their names) a meeting's scope draws material from right now.
fn allowed_letters(conn: &Connection, meeting: &str) -> Vec<char> {
    let scope = crate::workspace::scope::scope_for(conn, crate::workspace::scope::ScopeOwner::Meeting(meeting)).unwrap();
    scope
        .material_workspaces
        .iter()
        .filter_map(|w| conn.query_row("SELECT name FROM workspaces WHERE id = ?1", [w], |r| r.get::<_, String>(0)).ok())
        .filter_map(|n| n.chars().next())
        .collect()
}

fn foreign_canaries(text: &str, allowed: &[char]) -> Vec<char> {
    ['A', 'B', 'C']
        .into_iter()
        .filter(|l| !allowed.contains(l) && (text.contains(&format!("DOCCANARY{l}")) || text.contains(&format!("MEMCANARY{l}"))))
        .collect()
}

impl Emitter for Events {
    fn emit(&self, event: &str, payload: Value) {
        if event == "brief_sheet" && !payload["sheet"].is_null() {
            let watch = self.watch.lock().unwrap().clone();
            if let Some((conn, meeting)) = watch {
                let allowed = allowed_letters(&conn.lock().unwrap(), &meeting);
                let bad = foreign_canaries(&payload.to_string(), &allowed);
                if !bad.is_empty() {
                    self.violations.lock().unwrap().push(format!("sheet with {bad:?} while only {allowed:?} were in scope"));
                }
            }
        }
        self.all.lock().unwrap().push((event.to_string(), payload));
    }
}

impl Events {
    fn of(&self, name: &str) -> Vec<Value> {
        self.all.lock().unwrap().iter().filter(|(n, _)| n == name).map(|(_, v)| v.clone()).collect()
    }
    fn last_status(&self, name: &str, meeting: &str) -> Option<Value> {
        self.of(name).into_iter().filter(|v| v["meeting_id"] == meeting).last()
    }
}

struct H {
    rt: Arc<LiveRuntimes>,
    fake: Arc<FakeState>,
    events: Arc<Events>,
    clock: FakeClock,
    live: Arc<Mutex<Option<String>>>,
    busy: Arc<AtomicBool>,
    closed: Arc<Mutex<Vec<String>>>,
    conn: Arc<Mutex<Connection>>,
    /// The AI run service's scope generation (bump = the sessions restarted).
    gen: Arc<std::sync::atomic::AtomicU64>,
}

fn harness_on(conn: Arc<Mutex<Connection>>) -> H {
    let fake = Arc::new(FakeState::default());
    let events = Arc::new(Events::default());
    let clock = FakeClock::new(1_000);
    let live: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let busy = Arc::new(AtomicBool::new(false));
    let closed = Arc::new(Mutex::new(Vec::new()));
    let gen = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let (l2, b2, c2, g2) = (live.clone(), busy.clone(), closed.clone(), gen.clone());
    let deps = Deps {
        db: LiveDb::new(conn.clone() as Arc<dyn db::ConnProvider>),
        emitter: events.clone(),
        factory: Arc::new(FakeFactory(fake.clone())),
        clock: Arc::new(clock.clone()),
        busy: Arc::new(move || b2.load(Ordering::SeqCst)),
        live_meeting: Arc::new(move || l2.lock().unwrap().clone()),
        generation: Arc::new(move |_, _| g2.load(Ordering::SeqCst)),
        deleted: Arc::new(Mutex::new(std::collections::HashSet::new())),
        close_sessions: Arc::new(move |id| c2.lock().unwrap().push(id)),
        tick: Duration::from_millis(10),
        scope_check: Duration::from_millis(25),
        final_timeout: Duration::from_millis(300),
    };
    H { rt: LiveRuntimes::new(deps), fake, events, clock, live, busy, closed, conn, gen }
}

fn harness() -> H {
    // memory_db runs every step of STEPS, search (v10) included
    harness_on(Arc::new(Mutex::new(memory_db())))
}

impl H {
    fn start_meeting(&self, id: &str) {
        // a save never creates a row for a meeting that does not exist
        self.conn.lock().unwrap().execute("INSERT OR IGNORE INTO meetings (id, title, start_time, transcript, ai_interactions) VALUES (?1, 'm', 't', '[]', '[]')", [id]).unwrap();
        *self.live.lock().unwrap() = Some(id.to_string());
    }
    fn enable_notes(&self) {
        self.rt.patch_notetaker(&json!({"enabled": true})).unwrap();
    }
    /// Lines the actor has taken, at clock time `at`, then the clock moves on so a run is due.
    async fn speak(&self, meeting: &str, n_words: usize, at: u64) {
        self.clock.set(at);
        let text = (0..n_words).map(|i| format!("w{i}")).collect::<Vec<_>>().join(" ");
        self.rt.feed(meeting, "Them", &text, at);
        tokio::time::sleep(Duration::from_millis(40)).await;
        self.clock.set(at + 3_000);
    }
}

async fn until(what: &str, f: impl Fn() -> bool) {
    for _ in 0..400 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for: {what}");
}

fn add_memory(c: &Connection, ws: &str, title: &str, text: &str, status: &str, updated_at: i64) {
    let item = crate::workspace::memory::create_memory(
        c,
        crate::workspace::types::MemoryCreate {
            workspace_id: ws.to_string(),
            kind: "fact".into(),
            title: title.into(),
            text: text.into(),
            source_meeting: None,
            source_ms: None,
            status: Some(status.into()),
            unsupported: false,
        },
    )
    .unwrap();
    c.execute("UPDATE workspace_memory SET updated_at = ?2 WHERE id = ?1", rusqlite::params![item.id, updated_at]).unwrap();
}

fn make_meeting(h: &H, ws: &str) -> String {
    let c = h.conn.lock().unwrap();
    let m = crate::db::meetings::create_meeting(&c, "m").unwrap();
    crate::workspace::meetings::set_home(&c, &m.id, ws).unwrap();
    m.id
}

fn brief_workspace(h: &H) -> String {
    let c = h.conn.lock().unwrap();
    let ws = new_ws(&c, "Sales", false, false);
    c.execute("UPDATE workspaces SET brief_default = 1 WHERE id = ?1", [&ws]).unwrap();
    ws
}

fn index_doc(h: &H, ws: &str, id: &str, title: &str, text: &str) {
    use crate::workspace_search::{passages::build_text_passages, store::replace_source, PassageKind};
    let c = h.conn.lock().unwrap();
    let p = build_text_passages(PassageKind::Document, id, None, title, text, None);
    replace_source(&c, PassageKind::Document, id, None, &p, "h", 0, 0).unwrap();
    file(&c, ws, "document", id);
}

// ---------------------------------------------------------------- notes

#[tokio::test]
async fn nothing_runs_when_off_on_silence_or_for_a_meeting_that_is_not_live() {
    let h = harness();
    h.start_meeting("m1");
    assert!(h.rt.notetaker_start("m1").is_err(), "off by default");
    h.enable_notes();
    assert!(h.rt.notetaker_start("demo-1").is_err(), "not the running meeting");
    assert!(h.rt.notetaker_start("m1").is_ok());
    // silence, punctuation, and a long wait
    h.rt.feed("m1", "Them", "...", 1_000);
    h.rt.feed("m1", "Them", "   ", 1_000);
    h.clock.set(10 * 60_000);
    let _ = h.rt.notetaker_update_now("m1");
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(h.fake.calls.lock().unwrap().len(), 0, "no model call on silence");
    // lines for a meeting nobody started notes for go nowhere
    h.rt.feed("other", "Them", "words words words", 5);
    assert_eq!(h.fake.calls.lock().unwrap().len(), 0);
}

#[tokio::test]
async fn two_meetings_back_to_back_keep_to_themselves() {
    let h = harness();
    h.enable_notes();
    h.rt.patch_notetaker(&json!({"scope": "every"})).unwrap();
    h.start_meeting("A");
    h.rt.on_meeting_start("A");
    h.speak("A", 120, 1_000).await;
    until("a run for A", || h.fake.count(AiPurpose::Notes) == 1).await;
    until("doc event", || !h.events.of("notetaker_doc").is_empty()).await;
    h.rt.on_meeting_end("A");
    *h.live.lock().unwrap() = None;
    until("A finished", || h.events.last_status("notetaker_state", "A").map(|v| v["status"] == "finished").unwrap_or(false)).await;
    until("A's sessions closed", || h.closed.lock().unwrap().contains(&"A".to_string())).await;

    h.start_meeting("B");
    h.rt.on_meeting_start("B");
    h.clock.set(900_000);
    h.rt.feed("B", "Them", &(0..120).map(|i| format!("beta{i}")).collect::<Vec<_>>().join(" "), 900_000);
    tokio::time::sleep(Duration::from_millis(40)).await;
    h.clock.set(904_000);
    until("a run for B", || h.fake.calls.lock().unwrap().iter().any(|c| c.1 == "B")).await;
    let calls = h.fake.calls.lock().unwrap();
    let b_prompt = &calls.iter().find(|c| c.1 == "B").unwrap().2.user;
    assert!(!b_prompt.contains("w5 ") && b_prompt.contains("beta5"), "B sees only B");
    drop(calls);
    // A's notes stay A's
    let a = h.rt.get_notes("A").await.unwrap();
    assert!(a["blocks"].as_array().unwrap().len() >= 1);
    h.rt.on_meeting_end("B");
}

#[tokio::test]
async fn this_meeting_choice_ends_with_the_meeting() {
    let h = harness();
    h.enable_notes(); // scope "meeting"
    h.start_meeting("A");
    assert!(h.rt.notetaker_start("A").is_ok());
    h.rt.on_meeting_end("A");
    assert!(!h.rt.notetaker_settings().enabled, "next meeting starts with notes off");
    assert!(h.events.of("notetaker_settings_changed").len() >= 2);
    h.start_meeting("B");
    h.rt.on_meeting_start("B");
    assert!(h.fake.calls.lock().unwrap().is_empty());
    // "every meeting" is remembered
    let h2 = harness();
    h2.rt.patch_notetaker(&json!({"enabled": true, "scope": "every"})).unwrap();
    h2.start_meeting("A");
    h2.rt.on_meeting_end("A");
    assert!(h2.rt.notetaker_settings().enabled);
}

#[tokio::test]
async fn plan_limit_pauses_with_the_reason_and_stops_calling() {
    let h = harness();
    h.enable_notes();
    h.start_meeting("m1");
    h.rt.notetaker_start("m1").unwrap();
    h.fake.push(Err(LlmError::plan_limit("Usage limit reached, resets at 5pm")));
    h.speak("m1", 120, 1_000).await;
    until("paused", || h.events.last_status("notetaker_state", "m1").map(|v| v["status"] == "paused").unwrap_or(false)).await;
    let st = h.events.last_status("notetaker_state", "m1").unwrap();
    assert_eq!(st["reason"], "Usage limit reached, resets at 5pm");
    h.clock.set(10 * 60_000);
    tokio::time::sleep(Duration::from_millis(120)).await;
    assert_eq!(h.fake.count(AiPurpose::Notes), 1);
}

#[tokio::test]
async fn three_provider_failures_become_an_error_state() {
    let h = harness();
    h.enable_notes();
    h.start_meeting("m1");
    h.rt.notetaker_start("m1").unwrap();
    for _ in 0..3 {
        h.fake.push(Err(LlmError::failed("The provider said no")));
    }
    h.speak("m1", 120, 1_000).await;
    for i in 1..3u64 {
        until("a failed run", || h.fake.count(AiPurpose::Notes) as u64 >= i).await;
        h.clock.set(1_000 + i * 30_000);
        tokio::time::sleep(Duration::from_millis(60)).await;
    }
    until("error", || h.events.last_status("notetaker_state", "m1").map(|v| v["status"] == "error").unwrap_or(false)).await;
    let st = h.events.last_status("notetaker_state", "m1").unwrap();
    assert!(st["reason"].as_str().unwrap().contains("The provider said no"));
    assert_eq!(h.fake.count(AiPurpose::Notes), 3);
}

#[tokio::test]
async fn cap_then_continue_and_total_tokens_are_reported() {
    let h = harness();
    h.rt.patch_notetaker(&json!({"enabled": true, "cap": 2_000})).unwrap();
    h.start_meeting("m1");
    h.rt.notetaker_start("m1").unwrap();
    h.fake.push(Ok(LlmReply { text: r#"{"ops":[{"op":"add","type":"bullet","text":"Big run","t":"00:10"}]}"#.into(), input_tokens: Some(20_000), cached_input_tokens: Some(0), output_tokens: Some(300) }));
    h.speak("m1", 120, 1_000).await;
    until("capped", || h.events.last_status("notetaker_state", "m1").map(|v| v["status"] == "capped").unwrap_or(false)).await;
    let st = h.events.last_status("notetaker_state", "m1").unwrap();
    assert!(st["tokens_used"].as_u64().unwrap() >= 2_000);
    assert!(st["total_tokens"].as_u64().unwrap() >= 20_000, "total sent is reported beside the counted tokens");
    h.speak("m1", 120, 40_000).await;
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert_eq!(h.fake.count(AiPurpose::Notes), 1, "capped: no more runs");
    h.rt.notetaker_continue("m1").unwrap();
    until("second run", || h.fake.count(AiPurpose::Notes) == 2).await;
}

#[tokio::test]
async fn turning_off_stops_a_run_in_flight_and_nothing_restarts_it() {
    let h = harness();
    h.enable_notes();
    h.start_meeting("m1");
    h.rt.notetaker_start("m1").unwrap();
    *h.fake.delay.lock().unwrap() = Duration::from_secs(10);
    h.speak("m1", 120, 1_000).await;
    until("in flight", || h.fake.inflight.load(Ordering::SeqCst) == 1).await;
    h.rt.patch_notetaker(&json!({"enabled": false})).unwrap();
    until("cancelled", || h.fake.cancel_seen.load(Ordering::SeqCst) == 1).await;
    until("off", || h.events.last_status("notetaker_state", "m1").map(|v| v["status"] == "off").unwrap_or(false)).await;
    assert!(h.rt.notetaker_start("m1").is_err(), "only an explicit enable brings it back");
    h.speak("m1", 120, 80_000).await;
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert_eq!(h.fake.count(AiPurpose::Notes), 1);
}

#[tokio::test]
async fn quit_during_a_run_saves_and_does_not_wait_for_the_model() {
    let h = harness();
    h.enable_notes();
    h.start_meeting("m1");
    h.rt.notetaker_start("m1").unwrap();
    h.fake.push(Ok(LlmReply { text: r#"{"ops":[{"op":"add","type":"bullet","text":"First run saved","t":"00:10"}]}"#.into(), ..Default::default() }));
    h.speak("m1", 120, 1_000).await;
    until("first run", || h.fake.count(AiPurpose::Notes) == 1).await;
    until("saved", || h.rt.deps().db.load_notes("m1").is_some()).await;
    *h.fake.delay.lock().unwrap() = Duration::from_secs(30);
    h.speak("m1", 120, 60_000).await;
    until("second run in flight", || h.fake.inflight.load(Ordering::SeqCst) == 1).await;
    let t0 = Instant::now();
    h.rt.shutdown(Duration::from_secs(2)).await;
    assert!(t0.elapsed() < Duration::from_secs(1), "quit is quick");
    let saved = h.rt.deps().db.load_notes("m1").unwrap();
    assert_eq!(saved.status, "interrupted");
    assert!(saved.doc.blocks.iter().any(|b| b.text == "First run saved"));
}

#[tokio::test]
async fn interrupted_notes_are_resumable_after_a_restart() {
    let h = harness();
    h.enable_notes();
    h.start_meeting("m1");
    h.rt.notetaker_start("m1").unwrap();
    h.speak("m1", 120, 1_000).await;
    until("a run", || h.fake.count(AiPurpose::Notes) == 1).await;
    until("saved running", || h.rt.deps().db.load_notes("m1").map(|s| s.status == "running").unwrap_or(false)).await;
    // the app dies: a new process opens the same database
    let h2 = harness_on(h.conn.clone());
    assert_eq!(h2.rt.deps().db.load_notes("m1").unwrap().status, "interrupted");
    h2.rt.patch_notetaker(&json!({"enabled": true})).unwrap();
    h2.start_meeting("m1");
    h2.rt.notetaker_start("m1").unwrap();
    let doc = h2.rt.get_notes("m1").await.unwrap();
    assert!(doc["blocks"].as_array().unwrap().iter().any(|b| b["text"] == "Something was said"), "the saved notes are the starting point");
}

#[tokio::test]
async fn final_pass_at_the_end_is_bounded_and_end_returns_at_once() {
    let h = harness();
    h.enable_notes();
    h.start_meeting("m1");
    h.rt.notetaker_start("m1").unwrap();
    h.clock.set(1_000);
    h.rt.feed("m1", "Them", "only a few words here", 1_000);
    tokio::time::sleep(Duration::from_millis(40)).await;
    *h.fake.delay.lock().unwrap() = Duration::from_secs(30);
    let t0 = Instant::now();
    h.rt.on_meeting_end("m1");
    assert!(t0.elapsed() < Duration::from_millis(50), "end_meeting never waits");
    until("finished", || h.events.last_status("notetaker_state", "m1").map(|v| v["status"] == "finished").unwrap_or(false)).await;
    assert!(t0.elapsed() < Duration::from_secs(2), "the final pass gave up after final_timeout");
    until("sessions closed", || h.closed.lock().unwrap().contains(&"m1".to_string())).await;
}

#[tokio::test]
async fn a_live_answer_has_priority_over_notes() {
    let h = harness();
    h.enable_notes();
    h.start_meeting("m1");
    h.rt.notetaker_start("m1").unwrap();
    h.busy.store(true, Ordering::SeqCst);
    h.speak("m1", 120, 1_000).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(h.fake.count(AiPurpose::Notes), 0, "a live answer is generating");
    h.busy.store(false, Ordering::SeqCst);
    until("the run after the answer", || h.fake.count(AiPurpose::Notes) == 1).await;
}

#[tokio::test]
async fn manual_mode_only_runs_on_update_now() {
    let h = harness();
    h.rt.patch_notetaker(&json!({"enabled": true, "update_mode": "manual"})).unwrap();
    h.start_meeting("m1");
    h.rt.notetaker_start("m1").unwrap();
    h.speak("m1", 150, 1_000).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(h.fake.count(AiPurpose::Notes), 0);
    h.rt.notetaker_update_now("m1").unwrap();
    until("manual run", || h.fake.count(AiPurpose::Notes) == 1).await;
}

#[tokio::test]
async fn two_hour_soak_has_no_growth_and_costs_stay_under_the_cap() {
    let h = harness();
    h.enable_notes();
    h.start_meeting("m1");
    h.rt.notetaker_start("m1").unwrap();
    let handle_stats = || {
        let g = h.rt.inner.lock().unwrap();
        let n = g.notes.get("m1").unwrap();
        (n.queued.load(Ordering::SeqCst), n.max_queued.load(Ordering::SeqCst), n.dropped_lines.load(Ordering::SeqCst))
    };
    let mut peak_blocks = 0usize;
    // 7200 s, a 15-word line every 6 s
    for i in 0..1_200u64 {
        let t = 1_000 + i * 6_000;
        h.clock.set(t);
        let text = (0..15).map(|k| format!("t{}w{}", i / 50, k)).collect::<Vec<_>>().join(" ");
        h.rt.feed("m1", "Them", &text, t);
        tokio::time::sleep(Duration::from_millis(2)).await;
        h.clock.set(t + 4_000);
        tokio::time::sleep(Duration::from_millis(3)).await;
        if i % 100 == 99 {
            let doc = h.rt.get_notes("m1").await.unwrap();
            peak_blocks = peak_blocks.max(doc["blocks"].as_array().unwrap().len());
            let (q, _, _) = handle_stats();
            assert!(q < 40, "the queue drains (queued {q} at line {i})");
        }
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (q, max_q, dropped) = handle_stats();
    assert_eq!(q, 0);
    assert!(max_q < 60, "backlog stayed small: {max_q}");
    assert_eq!(dropped, 0, "notes never lose a line");
    let runs = h.fake.count(AiPurpose::Notes);
    assert!(runs > 100 && runs < 220, "runs {runs}");
    assert!(h.fake.max_inflight.load(Ordering::SeqCst) == 1, "one at a time");
    let st = h.events.last_status("notetaker_state", "m1").unwrap();
    assert!(st["tokens_used"].as_u64().unwrap() < st["cap"].as_u64().unwrap(), "an hour or two never asks to continue");
    assert!(peak_blocks <= 500);
    // events are throttled: never more than 4 doc events a second of real time
    let n_doc = h.events.of("notetaker_doc").len();
    assert!(n_doc < 200, "doc events {n_doc}");
}

#[tokio::test]
async fn notes_prompts_carry_no_workspace_text_or_secrets() {
    let h = harness();
    let ws = brief_workspace(&h);
    {
        let c = h.conn.lock().unwrap();
        c.execute("UPDATE workspaces SET instructions = 'WORKSPACE_INSTRUCTIONS_CANARY' WHERE id = ?1", [&ws]).unwrap();
        add_memory(&c, &ws, "t", "MEMORY_CANARY", "saved", 1);
    }
    index_doc(&h, &ws, "d1", "Secrets.pdf", "DOCUMENT_CANARY Acme pays 12 dollars per seat in the annual pricing plan");
    let m = make_meeting(&h, &ws);
    h.start_meeting(&m);
    h.enable_notes();
    h.rt.notetaker_start(&m).unwrap();
    h.rt.brief_start(&m).unwrap();
    let text = "Acme annual pricing plan seat discussion ".repeat(30);
    h.clock.set(1_000);
    h.rt.feed(&m, "Them", &text, 1_000);
    tokio::time::sleep(Duration::from_millis(40)).await;
    h.clock.set(4_000);
    until("notes run", || h.fake.count(AiPurpose::Notes) == 1).await;
    for p in h.fake.prompts(AiPurpose::Notes) {
        for c in ["WORKSPACE_INSTRUCTIONS_CANARY", "MEMORY_CANARY", "DOCUMENT_CANARY"] {
            assert!(!p.contains(c), "notes prompt leaked {c}");
        }
    }
}

// ---------------------------------------------------------------- brief

#[tokio::test]
async fn brief_searches_the_scope_calls_once_and_feeds_live_answers() {
    let h = harness();
    let ws = brief_workspace(&h);
    index_doc(&h, &ws, "d1", "Pricing.pdf", "Acme pays 12 dollars per seat in the annual pricing plan. Renewal is in November.");
    let m = make_meeting(&h, &ws);
    h.start_meeting(&m);
    h.rt.brief_start(&m).unwrap();
    let line = "we talk about the annual pricing plan and the Acme seat renewal";
    for i in 0..8u64 {
        h.clock.set(1_000 + i * 5_000);
        h.rt.feed(&m, "Them", line, i * 5_000);
        tokio::time::sleep(Duration::from_millis(15)).await;
    }
    until("one brief call", || h.fake.count(AiPurpose::Brief) == 1).await;
    until("sheet event", || h.events.of("brief_sheet").iter().any(|e| !e["sheet"].is_null())).await;
    let sheet = h.events.of("brief_sheet").into_iter().find(|e| !e["sheet"].is_null()).unwrap();
    let fact = &sheet["sheet"]["facts"][0];
    assert_eq!(fact["source"], "Pricing.pdf");
    assert_eq!(fact["sources"][0]["kind"], "document");
    assert_eq!(fact["sources"][0]["ref_id"], "d1");
    // live answers get it: wrapped, only in answer modes, only once per session
    let t = h.rt.answer_extras(&m, "Assist", None).unwrap();
    assert!(t.contains("Acme pays 12 dollars") && t.contains("[[DATA brief "));
    assert!(h.rt.answer_extras(&m, "MeetingSummary", None).is_none());
    assert!(h.rt.answer_extras(&m, "ActionItemsExtraction", None).is_none());
    let first = h.rt.session_extras(&m, "Assist", "live-fast#0").expect("a new session gets it");
    // not recorded until the turn succeeded: a failed turn leaves it due
    assert!(h.rt.session_extras(&m, "Assist", "live-fast#0").is_some(), "a failed turn does not count");
    h.rt.mark_session_sent(&first);
    assert!(h.rt.session_extras(&m, "Assist", "live-fast#0").is_none(), "the session already has it");
    // a restarted session (new generation) gets it again
    assert!(h.rt.session_extras(&m, "Assist", "live-fast#1").is_some());
    h.rt.forget_sessions(&m);
    assert!(h.rt.session_extras(&m, "Assist", "live-fast#0").is_some(), "a restart of the meeting's sessions resends");
    assert!(h.rt.answer_extras("other-meeting", "Assist", None).is_none());
    // the prompt is fenced and says where the data is
    let p = &h.fake.prompts(AiPurpose::Brief)[0];
    assert!(p.contains("[[DATA passages ") && p.contains("Pricing.pdf"));
}

#[tokio::test]
async fn brief_is_off_in_a_workspace_that_has_it_off() {
    let h = harness();
    let ws = { let c = h.conn.lock().unwrap(); new_ws(&c, "Quiet", false, false) };
    let m = make_meeting(&h, &ws);
    h.start_meeting(&m);
    assert!(h.rt.brief_start(&m).is_err());
}

#[tokio::test]
async fn a_scope_switch_mid_run_clears_the_sheet_and_the_late_reply_is_dropped() {
    let h = harness();
    let ws = brief_workspace(&h);
    index_doc(&h, &ws, "d1", "Pricing.pdf", "OLDSCOPE Acme pays 12 dollars per seat in the annual pricing plan.");
    let other = { let c = h.conn.lock().unwrap(); new_ws(&c, "Other", false, false) };
    let m = make_meeting(&h, &ws);
    h.start_meeting(&m);
    h.rt.brief_start(&m).unwrap();
    *h.fake.delay.lock().unwrap() = Duration::from_millis(400);
    let line = "we talk about the annual pricing plan and the Acme seat renewal";
    for i in 0..8u64 {
        h.clock.set(1_000 + i * 5_000);
        h.rt.feed(&m, "Them", line, i * 5_000);
        tokio::time::sleep(Duration::from_millis(15)).await;
    }
    until("call in flight", || h.fake.inflight.load(Ordering::SeqCst) == 1).await;
    // the user moves the meeting to another workspace while the call runs
    {
        let c = h.conn.lock().unwrap();
        crate::workspace::meetings::set_home(&c, &m, &other).unwrap();
    }
    h.rt.scope_changed(&m);
    tokio::time::sleep(Duration::from_millis(600)).await;
    // the old reply arrived; nothing of it is shown or given to answers
    assert!(h.events.of("brief_sheet").iter().all(|e| e["sheet"].is_null()), "no sheet was ever published");
    assert!(h.rt.answer_extras(&m, "Assist", None).is_none());
    // and the brief of the new scope is off (that workspace has it off): the actor ended
    until("actor ended", || h.rt.inner.lock().unwrap().briefs.get(&m).is_none()).await;
}

#[tokio::test]
async fn memory_reaches_answers_only_as_fenced_core_text() {
    let h = harness();
    let ws = { let c = h.conn.lock().unwrap(); new_ws(&c, "Mem", false, false) };
    {
        let c = h.conn.lock().unwrap();
        for i in 0..40 {
            add_memory(
                &c,
                &ws,
                &format!("Item {i}"),
                &format!("Fact number {i} about the project, with some length to it so the budget is reached soon enough"),
                if i % 5 == 0 { "suggested" } else { "saved" },
                i as i64,
            );
        }
    }
    let m = make_meeting(&h, &ws);
    h.start_meeting(&m);
    let t = h.rt.answer_extras(&m, "Assist", None).unwrap();
    assert!(t.contains("[[DATA memory "));
    assert!(crate::live_common::estimate_tokens(&t) < 600, "about 300 tokens of memory plus the fence");
    assert!(t.contains("Item 39") && !t.contains("Item 0:"), "newest first, suggested items never");
}

#[tokio::test]
async fn live_answer_storm_never_blocks_the_runtimes() {
    let h = harness();
    h.enable_notes();
    h.start_meeting("m1");
    h.rt.notetaker_start("m1").unwrap();
    let rt = h.rt.clone();
    let hammer = std::thread::spawn(move || {
        for _ in 0..20_000 {
            rt.answer_extras("m1", "Assist", Some("s"));
            rt.feed("m1", "Them", "storm", 1);
        }
    });
    h.speak("m1", 120, 1_000).await;
    hammer.join().unwrap();
    // the storm kept "speech" going on the fake clock; let it fall quiet
    let queued = || h.rt.inner.lock().unwrap().notes.get("m1").unwrap().queued.load(Ordering::SeqCst);
    until("the backlog drains", || queued() == 0).await;
    h.clock.set(120_000);
    until("a run after the storm", || h.fake.count(AiPurpose::Notes) >= 1).await;
}

// ---------------------------------------------------------------- edits, settings, memory

#[tokio::test]
async fn edits_work_live_and_after_the_meeting() {
    let h = harness();
    h.enable_notes();
    h.start_meeting("m1");
    h.rt.notetaker_start("m1").unwrap();
    h.speak("m1", 120, 1_000).await;
    until("a run", || h.fake.count(AiPurpose::Notes) == 1).await;
    let doc = h.rt.get_notes("m1").await.unwrap();
    let id = doc["blocks"][0]["id"].as_str().unwrap().to_string();
    let edited = h.rt.edit_notes("m1", NoteEdit::Update { id: id.clone(), text: Some("My words".into()), r#type: None, pinned: Some(true) }).await.unwrap();
    assert!(edited["blocks"][0]["edited"] == true && edited["blocks"][0]["pinned"] == true);
    let added = h.rt.edit_notes("m1", NoteEdit::Add { id: "mine1".into(), r#type: "task".into(), parent: None, text: "Call Ana".into(), after: Some(id.clone()) }).await.unwrap();
    assert_eq!(added["blocks"][1]["id"], "mine1");
    assert!(h.rt.edit_notes("m1", NoteEdit::Delete { id: "nope".into() }).await.is_err());
    h.rt.on_meeting_end("m1");
    until("finished", || h.events.last_status("notetaker_state", "m1").map(|v| v["status"] == "finished").unwrap_or(false)).await;
    // the meeting is over: edits go to the saved notes
    let after = h.rt.edit_notes("m1", NoteEdit::Delete { id: "mine1".into() }).await.unwrap();
    assert!(after["blocks"].as_array().unwrap().iter().all(|b| b["id"] != "mine1"));
    assert_eq!(h.rt.get_notes("m1").await.unwrap()["blocks"][0]["text"], "My words");
}

#[tokio::test]
async fn settings_patch_merges_persists_and_announces() {
    let h = harness();
    let m = h.rt.patch_notetaker(&json!({"detail": "brief", "provider": "openai"})).unwrap();
    assert_eq!((m.detail.as_str(), m.provider.as_deref(), m.enabled), ("brief", Some("openai"), false));
    assert!(h.rt.patch_notetaker(&json!({"detail": "enormous"})).is_err());
    assert_eq!(h.rt.notetaker_settings().detail, "brief", "a bad patch changes nothing");
    assert_eq!(h.events.of("notetaker_settings_changed").len(), 1);
    h.rt.patch_brief(&json!({"cap": 50_000})).unwrap();
    assert_eq!(h.events.of("brief_settings_changed").len(), 1);
    let h2 = harness_on(h.conn.clone());
    assert_eq!(h2.rt.notetaker_settings().detail, "brief");
    assert_eq!(h2.rt.brief_settings().cap, 50_000);
}

#[tokio::test]
async fn memory_suggestions_are_proposals_after_the_meeting_only() {
    let h = harness();
    let ws = { let c = h.conn.lock().unwrap(); new_ws(&c, "Mem", false, false) };
    let m = make_meeting(&h, &ws);
    {
        let c = h.conn.lock().unwrap();
        for i in 0..6 {
            c.execute(
                "INSERT INTO transcript_segments (id, meeting_id, text, speaker, timestamp_ms, is_final, created_at) VALUES (?1,?2,?3,'Them',?4,1,'t')",
                rusqlite::params![format!("s{i}"), m, "Acme pays 12 dollars per seat and the price may change", 5_000 + i * 1_000],
            )
            .unwrap();
        }
    }
    h.start_meeting(&m);
    assert!(h.rt.suggest_memory(&ws, &m).await.is_err(), "not during the meeting");
    *h.live.lock().unwrap() = None;
    let items = h.rt.suggest_memory(&ws, &m).await.unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].status, "suggested");
    assert_eq!(items[0].source_meeting.as_deref(), Some(m.as_str()));
    assert_eq!(h.fake.count(AiPurpose::Memory), 1);
    assert!(h.events.of("memory_changed").len() == 1);
    let saved: i64 = h.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM workspace_memory WHERE status = 'saved'", [], |r| r.get(0)).unwrap();
    assert_eq!(saved, 0, "nothing is saved without the user");
}

#[tokio::test]
async fn auto_suggest_only_when_the_workspace_turned_it_on() {
    let h = harness();
    let ws = { let c = h.conn.lock().unwrap(); new_ws(&c, "Auto", false, false) };
    let m = make_meeting(&h, &ws);
    h.conn.lock().unwrap().execute(
        "INSERT INTO transcript_segments (id, meeting_id, text, speaker, timestamp_ms, is_final, created_at) VALUES ('s1',?1,'Acme pays 12 dollars per seat today','Them',10000,1,'t')",
        [&m],
    ).unwrap();
    h.start_meeting(&m);
    *h.live.lock().unwrap() = None;
    super::memory::auto_suggest_after(Arc::new(h.rt.deps().clone()), m.clone(), Duration::from_millis(10));
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(h.fake.count(AiPurpose::Memory), 0, "off by default");
    h.conn.lock().unwrap().execute("UPDATE workspaces SET suggest_memory = 1 WHERE id = ?1", [&ws]).unwrap();
    super::memory::auto_suggest_after(Arc::new(h.rt.deps().clone()), m.clone(), Duration::from_millis(10));
    until("auto suggestion", || h.fake.count(AiPurpose::Memory) == 1).await;
}

#[test]
fn contract_doc_shape() {
    let mut d = crate::live_notes::doc::NoteDoc::new();
    let t = d.user_add(crate::live_notes::doc::BlockKind::Topic, None, "Plan", 5_000).unwrap();
    d.user_add(crate::live_notes::doc::BlockKind::Bullet, Some(&t), "Do it", 6_000).unwrap();
    let v = doc_to_contract(&d);
    assert_eq!(v["blocks"][1]["parent"], json!(t));
    assert_eq!(v["blocks"][0]["type"], "topic");
    assert_eq!(v["blocks"][0]["t"], 5_000);
}

// ---------------------------------------------------------------- scope: one object, synchronous invalidation

fn publish_a_sheet(h: &H, m: &str) {
    let line = "we talk about the annual pricing plan and the Acme seat renewal";
    for i in 0..8u64 {
        h.clock.set(1_000 + i * 5_000);
        h.rt.feed(m, "Them", line, i * 5_000);
        std::thread::sleep(Duration::from_millis(15));
    }
}

async fn brief_with_sheet(h: &H) -> (String, String) {
    let ws = brief_workspace(h);
    index_doc(h, &ws, "d1", "Pricing.pdf", "DOCCANARYA Acme pays 12 dollars per seat in the annual pricing plan.");
    let m = make_meeting(h, &ws);
    h.start_meeting(&m);
    h.rt.brief_start(&m).unwrap();
    publish_a_sheet(h, &m);
    until("a published sheet", || h.events.of("brief_sheet").iter().any(|e| !e["sheet"].is_null())).await;
    (ws, m)
}

#[tokio::test]
async fn the_scope_fingerprint_changes_with_every_part_of_the_scope() {
    let h = harness();
    let ws = brief_workspace(&h);
    let m = make_meeting(&h, &ws);
    let fp = || h.rt.deps().db.scope(&m).unwrap().fingerprint;
    let base = fp();
    assert_eq!(base, fp(), "stable while nothing changes");
    index_doc(&h, &ws, "d1", "Pricing.pdf", "text");
    let with_doc = fp();
    assert_ne!(base, with_doc, "a document");
    {
        let c = h.conn.lock().unwrap();
        c.execute("INSERT INTO workspace_items (workspace_id, kind, ref_id, added_at, index_opt_in) VALUES (?1, 'folder', 'f1', 0, 0)", [&ws]).unwrap();
    }
    assert_eq!(with_doc, fp(), "a folder the user did not opt in to is not in the scope");
    h.conn.lock().unwrap().execute("UPDATE workspace_items SET index_opt_in = 1 WHERE ref_id = 'f1'", []).unwrap();
    let with_folder = fp();
    assert_ne!(with_doc, with_folder, "an opted-in folder");
    {
        let c = h.conn.lock().unwrap();
        add_memory(&c, &ws, "t", "MEMCANARYA fact", "saved", 1);
    }
    let with_memory = fp();
    assert_ne!(with_folder, with_memory, "saved memory");
    {
        let c = h.conn.lock().unwrap();
        c.execute("INSERT INTO workspace_meeting_prefs (workspace_id, chat_id, meeting_id, included) VALUES (?1, '', 'old-meeting', 0)", [&ws]).unwrap();
    }
    let with_exclusion = fp();
    assert_ne!(with_memory, with_exclusion, "a meeting switched off for the workspace");
    let scope = h.rt.deps().db.scope(&m).unwrap();
    assert!(scope.search.excluded_meeting_ids.contains(&"old-meeting".to_string()) && scope.search.excluded_meeting_ids.contains(&m));
    assert_eq!(scope.search.folder_ids, vec!["f1".to_string()], "search uses exactly the scope's folders");
    let other = {
        let c = h.conn.lock().unwrap();
        new_ws(&c, "Other", false, false)
    };
    h.conn.lock().unwrap().execute("UPDATE meetings SET workspace_id = ?2 WHERE id = ?1", [&m, &other]).unwrap();
    assert_ne!(with_exclusion, fp(), "the home");
}

#[tokio::test]
async fn invalidation_is_synchronous_and_never_waits_for_the_database() {
    let h = harness();
    let (_ws, m) = brief_with_sheet(&h).await;
    assert!(h.rt.answer_extras(&m, "Assist", None).is_some());
    // another thread holds the database while the scope changes
    let conn = h.conn.clone();
    let holder = std::thread::spawn(move || {
        let _g = conn.lock().unwrap();
        std::thread::sleep(Duration::from_millis(400));
    });
    std::thread::sleep(Duration::from_millis(30));
    let t0 = Instant::now();
    h.rt.scope_changed(&m);
    assert!(t0.elapsed() < Duration::from_millis(100), "scope_changed does not wait for the database");
    // nothing of the old sheet is reachable before the actor has done anything
    let shared = h.rt.inner.lock().unwrap().briefs.get(&m).map(|b| b.shared.clone()).unwrap();
    assert!(shared.holder.lock().unwrap().view(h.clock.now_ms()).sheet.is_none(), "the holder is already empty");
    holder.join().unwrap();
    assert!(h.rt.answer_extras(&m, "Assist", None).map(|t| !t.contains("Acme pays")).unwrap_or(true));
    until("null sheet event", || h.events.of("brief_sheet").last().map(|e| e["sheet"].is_null()).unwrap_or(false)).await;
}

#[tokio::test]
async fn a_generation_bump_during_a_run_drops_the_reply() {
    let h = harness();
    let ws = brief_workspace(&h);
    index_doc(&h, &ws, "d1", "Pricing.pdf", "DOCCANARYA Acme pays 12 dollars per seat in the annual pricing plan.");
    let m = make_meeting(&h, &ws);
    h.start_meeting(&m);
    h.rt.brief_start(&m).unwrap();
    *h.fake.delay.lock().unwrap() = Duration::from_millis(300);
    publish_a_sheet(&h, &m);
    until("call in flight", || h.fake.inflight.load(Ordering::SeqCst) == 1).await;
    h.gen.fetch_add(1, Ordering::SeqCst); // the sessions restarted under it
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(h.events.of("brief_sheet").iter().all(|e| e["sheet"].is_null()), "the overtaken reply was never published");
    assert!(h.rt.answer_extras(&m, "Assist", None).map(|t| !t.contains("Acme pays")).unwrap_or(true));
    // notes: same rule, and their lines go back to be sent again
    h.enable_notes();
    h.rt.notetaker_start(&m).unwrap();
    h.speak(&m, 120, 100_000).await;
    until("notes call", || h.fake.count(AiPurpose::Notes) == 1).await;
    h.gen.fetch_add(1, Ordering::SeqCst);
    until("second notes call (the lines were kept)", || {
        h.clock.advance(30_000);
        h.fake.count(AiPurpose::Notes) >= 2
    })
    .await;
}

#[tokio::test]
async fn a_new_scope_with_the_brief_off_clears_saves_an_empty_sheet_and_stops() {
    let h = harness();
    let (ws, m) = brief_with_sheet(&h).await;
    h.conn.lock().unwrap().execute("UPDATE workspaces SET brief_default = 0 WHERE id = ?1", [&ws]).unwrap();
    h.rt.scope_changed(&m);
    until("the actor ended", || h.rt.inner.lock().unwrap().briefs.get(&m).is_none()).await;
    assert!(h.events.of("brief_sheet").last().unwrap()["sheet"].is_null());
    let stored = h.rt.deps().db.load_brief(&m).unwrap();
    assert!(stored.sheet.is_none() && stored.status == "off");
    assert!(h.rt.get_brief(&m).await.is_none());
    assert!(h.rt.answer_extras(&m, "Assist", None).map(|t| !t.contains("Acme pays")).unwrap_or(true));
}

#[tokio::test]
async fn a_saved_sheet_is_shown_only_under_its_own_scope() {
    let h = harness();
    let (ws, m) = brief_with_sheet(&h).await;
    h.rt.on_meeting_end(&m);
    until("saved with a fingerprint", || h.rt.deps().db.load_brief(&m).map(|b| !b.fingerprint.is_empty() && b.sheet.is_some()).unwrap_or(false)).await;
    *h.live.lock().unwrap() = None;
    until("actor gone", || h.rt.inner.lock().unwrap().briefs.get(&m).is_none()).await;
    assert!(h.rt.get_brief(&m).await.is_some(), "same scope: shown");
    index_doc(&h, &ws, "d2", "More.pdf", "a new document joins the scope");
    assert!(h.rt.get_brief(&m).await.is_none(), "the scope changed since: not shown");
}

#[tokio::test]
async fn memory_is_suggested_only_for_the_meetings_own_workspace() {
    let h = harness();
    let (a, b) = {
        let c = h.conn.lock().unwrap();
        (new_ws(&c, "A", false, false), new_ws(&c, "B", false, false))
    };
    let m = make_meeting(&h, &a);
    h.conn
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO transcript_segments (id, meeting_id, text, speaker, timestamp_ms, is_final, created_at) VALUES ('s1',?1,'Acme pays 12 dollars per seat today','Them',10000,1,'t')",
            [&m],
        )
        .unwrap();
    assert!(h.rt.suggest_memory(&b, &m).await.is_err(), "not the meeting's workspace");
    // the meeting moves while the model works
    *h.fake.delay.lock().unwrap() = Duration::from_millis(250);
    let rt = h.rt.clone();
    let (a2, m2) = (a.clone(), m.clone());
    let task = tokio::spawn(async move { rt.suggest_memory(&a2, &m2).await });
    until("the call", || h.fake.inflight.load(Ordering::SeqCst) == 1).await;
    h.conn.lock().unwrap().execute("UPDATE meetings SET workspace_id = ?2 WHERE id = ?1", [&m, &b]).unwrap();
    let out = task.await.unwrap().unwrap();
    assert!(out.is_empty(), "nothing is saved for a meeting that moved");
    let n: i64 = h.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM workspace_memory", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 0);
}

#[tokio::test]
async fn a_deleted_meeting_leaves_no_rows_and_no_events() {
    let h = harness();
    let (_ws, m) = brief_with_sheet(&h).await;
    h.enable_notes();
    h.rt.notetaker_start(&m).unwrap();
    h.speak(&m, 120, 50_000).await;
    until("a notes run", || h.fake.count(AiPurpose::Notes) == 1).await;
    until("notes saved", || h.rt.deps().db.load_notes(&m).is_some()).await;
    *h.fake.delay.lock().unwrap() = Duration::from_millis(300);
    h.speak(&m, 120, 100_000).await;
    until("a run in flight", || h.fake.inflight.load(Ordering::SeqCst) >= 1).await;
    let seen = h.events.all.lock().unwrap().len();
    // the user deletes the meeting: actors stop first, then the rows go
    h.rt.meeting_deleted(&m);
    {
        let c = h.conn.lock().unwrap();
        let tx = c.unchecked_transaction().unwrap();
        crate::workspace::purge::purge_meeting(&tx, &m).unwrap();
        tx.commit().unwrap();
    }
    tokio::time::sleep(Duration::from_millis(600)).await;
    {
        let c = h.conn.lock().unwrap();
        for table in ["meeting_notes", "meeting_briefs"] {
            let n: i64 = c.query_row(&format!("SELECT COUNT(*) FROM {table} WHERE meeting_id = ?1"), [&m], |r| r.get(0)).unwrap();
            assert_eq!(n, 0, "{table} was recreated");
        }
    }
    let late: Vec<String> = h.events.all.lock().unwrap().iter().skip(seen).filter(|(n, v)| n != "memory_changed" && v["meeting_id"] == json!(m)).map(|(n, _)| n.clone()).collect();
    assert!(late.is_empty(), "events after the delete: {late:?}");
    // a late save from anywhere is a no-op
    assert!(h.rt.deps().db.save_notes(&m, &crate::live_notes::doc::NoteDoc::new(), "running", 1, 1).is_ok());
    assert!(h.rt.deps().db.load_notes(&m).is_none());
}

#[tokio::test]
async fn memory_settings_pick_the_model_for_suggestions() {
    let h = harness();
    let m = h.rt.patch_memory(&json!({"provider": "openai", "model": "small"})).unwrap();
    assert_eq!((m.provider.as_deref(), m.model.as_deref()), (Some("openai"), Some("small")));
    assert_eq!(h.events.of("memory_settings_changed").len(), 1);
    assert!(h.rt.patch_memory(&json!({"nonsense": 1})).is_err());
    assert_eq!(h.rt.memory_settings().model.as_deref(), Some("small"));
    assert_eq!(harness_on(h.conn.clone()).rt.memory_settings().provider.as_deref(), Some("openai"));
}

/// Random changes of the meeting's workspace and material while notes, the
/// brief and answers run: nothing published or handed to an answer ever
/// carries material that was not in the scope in force at that moment.
#[tokio::test]
async fn random_scope_changes_never_leak_material_across_workspaces() {
    let h = harness();
    let (a, b) = {
        let c = h.conn.lock().unwrap();
        let a = new_ws(&c, "A", false, false);
        let b = new_ws(&c, "B", false, false);
        c.execute("UPDATE workspaces SET brief_default = 1", []).unwrap();
        add_memory(&c, &a, "mem a", "MEMCANARYA fact in a", "saved", 1);
        add_memory(&c, &b, "mem b", "MEMCANARYB fact in b", "saved", 1);
        (a, b)
    };
    index_doc(&h, &a, "da", "A.pdf", "DOCCANARYA Acme pays 12 dollars per seat in the annual pricing plan renewal");
    index_doc(&h, &b, "db", "B.pdf", "DOCCANARYB Acme pays 99 dollars per seat in the annual pricing plan renewal");
    let m = make_meeting(&h, &a);
    h.start_meeting(&m);
    *h.events.watch.lock().unwrap() = Some((h.conn.clone(), m.clone()));
    h.enable_notes();
    h.rt.brief_start(&m).unwrap();
    h.rt.notetaker_start(&m).unwrap();
    *h.fake.delay.lock().unwrap() = Duration::from_millis(40);
    let mut seed = 0x2545F4914F6CDD1Du64;
    let mut next = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    let mut answers_checked = 0;
    for step in 0..60u64 {
        match next() % 4 {
            0 => {
                let to = if next() % 2 == 0 { &a } else { &b };
                h.conn.lock().unwrap().execute("UPDATE meetings SET workspace_id = ?2 WHERE id = ?1", [&m, to]).unwrap();
                h.rt.scope_changed(&m);
                h.gen.fetch_add(1, Ordering::SeqCst);
            }
            1 => {
                let other = if next() % 2 == 0 { b.clone() } else { a.clone() };
                let borrowed: Vec<String> = if next() % 2 == 0 { vec![] } else { vec![other] };
                let _ = {
                    let c = h.conn.lock().unwrap();
                    crate::workspace::meetings::set_meeting_scope(&c, &m, &borrowed)
                };
                h.rt.scope_changed(&m);
            }
            2 => {
                let in_a = next() % 2 == 0;
                let ws = if in_a { &a } else { &b };
                let letter = if in_a { 'A' } else { 'B' };
                {
                    let c = h.conn.lock().unwrap();
                    add_memory(&c, ws, "more", &format!("MEMCANARY{letter} extra {step}"), "saved", 100 + step as i64);
                }
                h.rt.scope_changed(&m);
            }
            _ => {}
        }
        h.fake.push(Ok(LlmReply {
            text: r#"{"now":"Acme pricing","facts":[{"text":"Acme pays 12 dollars per seat DOCCANARYA","source":"P1"},{"text":"Acme pays 99 dollars per seat DOCCANARYB","source":"P2"}]}"#.into(),
            ..Default::default()
        }));
        publish_a_sheet(&h, &m);
        h.clock.advance(60_000);
        tokio::time::sleep(Duration::from_millis(30)).await;
        // answers at any moment: only what the scope in force allows
        let allowed = allowed_letters(&h.conn.lock().unwrap(), &m);
        if let Some(t) = h.rt.answer_extras(&m, "Assist", None) {
            answers_checked += 1;
            let bad = foreign_canaries(&t, &allowed);
            assert!(bad.is_empty(), "step {step}: an answer carried {bad:?} with only {allowed:?} in scope\n{t}");
        }
        // what is saved is shown only under its own scope
        if let Some(sheet) = h.rt.get_brief(&m).await {
            let bad = foreign_canaries(&sheet.to_string(), &allowed);
            assert!(bad.is_empty(), "step {step}: the saved sheet carried {bad:?}");
        }
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    let v = h.events.violations.lock().unwrap().clone();
    assert!(v.is_empty(), "{v:?}");
    // notes prompts never carried any workspace material at all
    for p in h.fake.prompts(AiPurpose::Notes) {
        assert!(!p.contains("CANARY"), "a notes prompt carried workspace text");
    }
    assert!(answers_checked > 5, "the answers were really exercised ({answers_checked})");
}

#[tokio::test]
async fn a_raised_cap_is_kept_across_stop_and_start_and_over_the_cap_never_runs() {
    let h = harness();
    h.rt.patch_notetaker(&json!({"enabled": true, "cap": 2_000})).unwrap();
    h.start_meeting("m1");
    h.rt.notetaker_start("m1").unwrap();
    h.fake.push(Ok(LlmReply { text: r#"{"ops":[]}"#.into(), input_tokens: Some(20_000), cached_input_tokens: Some(0), output_tokens: Some(300) }));
    h.speak("m1", 120, 1_000).await;
    until("capped", || h.events.last_status("notetaker_state", "m1").map(|v| v["status"] == "capped").unwrap_or(false)).await;
    h.rt.notetaker_continue("m1").unwrap();
    until("running again with the raised cap", || {
        h.events.last_status("notetaker_state", "m1").map(|v| v["status"] != "capped" && v["cap"].as_u64().unwrap() > 20_000).unwrap_or(false)
    })
    .await;
    let raised = h.events.last_status("notetaker_state", "m1").unwrap()["cap"].as_u64().unwrap();
    // stop and start again (the same as pause and resume across a restart): the raised cap is still there
    h.rt.notetaker_stop("m1");
    until("actor ended", || h.rt.inner.lock().unwrap().notes.get("m1").is_none()).await;
    let seen = h.events.of("notetaker_state").len();
    h.rt.notetaker_start("m1").unwrap();
    until("state again", || h.events.of("notetaker_state").len() > seen).await;
    let st = h.events.last_status("notetaker_state", "m1").unwrap();
    assert_eq!(st["cap"].as_u64().unwrap(), raised, "{st}");
    assert!(st["tokens_used"].as_u64().unwrap() < raised, "it only shows running when it may run: {st}");
    // more was used than the saved cap allows: it waits for Keep going
    h.rt.notetaker_stop("m1");
    until("actor ended again", || h.rt.inner.lock().unwrap().notes.get("m1").is_none()).await;
    {
        let c = h.conn.lock().unwrap();
        c.execute("UPDATE meeting_notes SET tokens_used = cap + 10 WHERE meeting_id = 'm1'", []).unwrap();
    }
    h.rt.notetaker_start("m1").unwrap();
    until("capped on start", || h.events.last_status("notetaker_state", "m1").map(|v| v["status"] == "capped").unwrap_or(false)).await;
}

#[tokio::test]
async fn after_a_revoke_no_later_prompt_carries_anything_old() {
    let h = harness();
    let (a, b) = {
        let c = h.conn.lock().unwrap();
        let a = new_ws(&c, "A", false, false);
        let b = new_ws(&c, "B", false, false);
        c.execute("UPDATE workspaces SET brief_default = 1", []).unwrap();
        add_memory(&c, &a, "old fact", "MEMCANARYA saved before", "saved", 1);
        (a, b)
    };
    index_doc(&h, &a, "da", "A.pdf", "DOCCANARYA Acme pays 12 dollars per seat in the annual pricing plan renewal");
    index_doc(&h, &b, "db", "B.pdf", "DOCCANARYB Acme pays 99 dollars per seat in the annual pricing plan renewal");
    let m = make_meeting(&h, &a);
    h.start_meeting(&m);
    h.rt.brief_start(&m).unwrap();
    let old_line = "OLDLINEMARK we talk about the annual pricing plan and the Acme seat renewal";
    for i in 0..8u64 {
        h.clock.set(1_000 + i * 5_000);
        h.rt.feed(&m, "Them", old_line, i * 5_000);
        tokio::time::sleep(Duration::from_millis(15)).await;
    }
    until("a brief call under the old scope", || h.fake.count(AiPurpose::Brief) >= 1).await;
    assert!(h.fake.prompts(AiPurpose::Brief)[0].contains("DOCCANARYA"));
    // the revoke: the meeting leaves A (its material, memory and everything said so far)
    h.conn.lock().unwrap().execute("UPDATE meetings SET workspace_id = ?2 WHERE id = ?1", [&m, &b]).unwrap();
    h.rt.scope_changed(&m);
    tokio::time::sleep(Duration::from_millis(100)).await;
    let mark = h.fake.calls.lock().unwrap().len();
    let new_line = "now the annual pricing plan seat renewal is about the other team";
    for i in 0..10u64 {
        h.clock.set(100_000 + i * 5_000);
        h.rt.feed(&m, "Them", new_line, 100_000 + i * 5_000);
        tokio::time::sleep(Duration::from_millis(15)).await;
    }
    until("a brief call under the new scope", || h.fake.calls.lock().unwrap().len() > mark).await;
    let calls = h.fake.calls.lock().unwrap().clone();
    for (_, _, req) in calls.iter().skip(mark) {
        let text = format!("{}\n{}", req.system, req.user);
        for old in ["DOCCANARYA", "MEMCANARYA", "OLDLINEMARK", "A.pdf"] {
            assert!(!text.contains(old), "a later prompt still carries {old}:\n{text}");
        }
    }
    assert!(calls.iter().skip(mark).any(|(_, _, r)| r.user.contains("DOCCANARYB")), "the new scope's material is used");
    if let Some(t) = h.rt.answer_extras(&m, "Assist", None) {
        assert!(!t.contains("MEMCANARYA") && !t.contains("DOCCANARYA"));
    }
}

// ---------------------------------------------------------------- from a fresh install to the first result
//
// Each test uses only what the UI's controls call, in the order the UI calls
// them, and lists the conditions the backend checks and the control behind each:
//
// LIVE NOTES (src/stores/liveNotesStore.ts `turnOn` / `turnOff`, the settings page):
//   1. settings.enabled      <- "Turn on" in the panel: set_notetaker_settings({enabled: true, scope})
//   2. scope meeting|every   <- the same call ("This meeting" / "Every meeting")
//   3. the meeting is the running one <- start_meeting (notetaker_start refuses any other id)
//   4. a model               <- notes provider in the settings page, else the app's active provider
//   5. update_mode           <- settings page (automatic by default; manual waits for "Update now")
//   6. enough new speech and a pause (100 words, 2 s) <- the conversation itself
//   7. under the token cap, no live answer running <- "Keep going" in the panel / nothing to set
// BRIEF (src/stores/liveBriefStore.ts `turnOn` / `turnOff`):
//   1. the workspace's brief switch <- "Turn on the brief": update_workspace({brief_enabled: true}); the only switch
//   2. the meeting is the running one, a model, under the cap <- as for notes (brief model in the settings page)
// MEMORY SUGGESTIONS (src/memory/MemorySection.tsx):
//   1. the meeting has ended (not the running one) <- the button only shows after a meeting
//   2. the meeting is filed in that workspace <- the meeting's own workspace (the section is that workspace's)
//   3. a saved transcript <- recording a meeting
//   4. a model <- memory model picker (set_memory_settings), else the app's active provider
//   automatic after a meeting: the workspace's suggest_memory switch <- the toggle in MemorySection (update_workspace)

fn set_workspace(h: &H, ws: &str, patch: crate::workspace::types::WorkspacePatch) {
    let c = h.conn.lock().unwrap();
    crate::workspace::store::update_workspace(&c, ws, patch).unwrap();
}

#[tokio::test]
async fn fresh_install_live_notes_this_meeting_every_meeting_and_off_stays_off() {
    let h = harness();
    assert!(!h.rt.notetaker_settings().enabled, "off on a fresh install");
    h.start_meeting("A");
    let err = h.rt.notetaker_start("A").unwrap_err();
    assert!(err.contains("turned off"), "{err}");
    // the panel's "This meeting": set the settings, then start
    h.rt.patch_notetaker(&json!({"enabled": true, "scope": "meeting"})).unwrap();
    h.rt.notetaker_start("A").unwrap();
    h.speak("A", 120, 1_000).await;
    until("the first notes", || h.events.of("notetaker_doc").iter().any(|e| !e["doc"]["blocks"].as_array().unwrap().is_empty())).await;
    assert_eq!(h.fake.count(AiPurpose::Notes), 1);
    // "this meeting" ends with the meeting
    h.rt.on_meeting_end("A");
    until("A finished", || h.events.last_status("notetaker_state", "A").map(|v| v["status"] == "finished").unwrap_or(false)).await;
    *h.live.lock().unwrap() = None;
    h.start_meeting("B");
    h.rt.on_meeting_start("B");
    assert!(h.rt.inner.lock().unwrap().notes.get("B").is_none(), "the next meeting starts with notes off");
    // "every meeting": the next meeting starts by itself
    h.rt.patch_notetaker(&json!({"enabled": true, "scope": "every"})).unwrap();
    h.rt.on_meeting_end("B");
    *h.live.lock().unwrap() = None;
    h.start_meeting("C");
    h.rt.on_meeting_start("C");
    assert!(h.rt.inner.lock().unwrap().notes.get("C").is_some());
    h.speak("C", 120, 200_000).await;
    until("notes for C", || h.fake.calls.lock().unwrap().iter().any(|c| c.1 == "C")).await;
    // turn off (the panel: set_notetaker_settings({enabled:false}) and stop): it stops and stays off after a restart
    h.rt.patch_notetaker(&json!({"enabled": false})).unwrap();
    until("C is off", || h.events.last_status("notetaker_state", "C").map(|v| v["status"] == "off").unwrap_or(false)).await;
    let calls = h.fake.calls.lock().unwrap().len();
    let restarted = harness_on(h.conn.clone());
    restarted.start_meeting("D");
    restarted.rt.on_meeting_start("D");
    assert!(restarted.rt.inner.lock().unwrap().notes.get("D").is_none(), "off stays off after a restart");
    assert!(restarted.rt.notetaker_start("D").is_err());
    restarted.speak("D", 150, 1_000).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(restarted.fake.calls.lock().unwrap().len(), 0);
    assert_eq!(h.fake.calls.lock().unwrap().len(), calls);
}

#[tokio::test]
async fn fresh_install_brief_follows_only_the_workspace_switch_and_off_stays_off() {
    let h = harness();
    let (ws, other) = {
        let c = h.conn.lock().unwrap();
        (new_ws(&c, "Sales", false, false), new_ws(&c, "Quiet", false, false))
    };
    index_doc(&h, &ws, "d1", "Pricing.pdf", "Acme pays 12 dollars per seat in the annual pricing plan.");
    // nothing global to set: a fresh install has no brief setting that could be off
    let fresh = h.rt.brief_settings();
    assert!(serde_json::to_value(&fresh).unwrap().get("enabled").is_none());
    let m = make_meeting(&h, &ws);
    h.start_meeting(&m);
    let err = h.rt.brief_start(&m).unwrap_err();
    assert!(err.contains("off in this workspace"), "{err}");
    // the panel's "Turn on the brief": update_workspace({brief_enabled: true}), then brief_start
    set_workspace(&h, &ws, crate::workspace::types::WorkspacePatch { brief_enabled: Some(true), ..Default::default() });
    h.rt.brief_start(&m).unwrap();
    publish_a_sheet(&h, &m);
    until("the first brief", || h.events.of("brief_sheet").iter().any(|e| !e["sheet"].is_null())).await;
    // the next meeting in that workspace starts it by itself
    h.rt.on_meeting_end(&m);
    *h.live.lock().unwrap() = None;
    until("sessions closed", || h.closed.lock().unwrap().contains(&m)).await;
    let m2 = make_meeting(&h, &ws);
    h.start_meeting(&m2);
    h.rt.on_meeting_start(&m2);
    assert!(h.rt.inner.lock().unwrap().briefs.get(&m2).is_some(), "on in the workspace: it starts with the meeting");
    // another workspace is not affected
    h.rt.on_meeting_end(&m2);
    *h.live.lock().unwrap() = None;
    let m3 = make_meeting(&h, &other);
    h.start_meeting(&m3);
    h.rt.on_meeting_start(&m3);
    assert!(h.rt.inner.lock().unwrap().briefs.get(&m3).is_none());
    // "Turn the brief off": the workspace switch off and the run stops (the same update_workspace call pokes the runtime)
    *h.live.lock().unwrap() = Some(m2.clone());
    set_workspace(&h, &ws, crate::workspace::types::WorkspacePatch { brief_enabled: Some(false), ..Default::default() });
    h.rt.scope_changed(&m2);
    until("the brief stopped", || h.rt.inner.lock().unwrap().briefs.get(&m2).is_none()).await;
    assert!(h.rt.brief_start(&m2).is_err());
    // after a restart it is still off
    let restarted = harness_on(h.conn.clone());
    restarted.start_meeting(&m2);
    restarted.rt.on_meeting_start(&m2);
    assert!(restarted.rt.inner.lock().unwrap().briefs.get(&m2).is_none());
    assert!(restarted.rt.brief_start(&m2).is_err());
    assert_eq!(restarted.fake.count(AiPurpose::Brief), 0);
}

#[tokio::test]
async fn fresh_install_memory_suggestions_need_no_switch_and_auto_follows_the_workspace_toggle() {
    let h = harness();
    let ws = {
        let c = h.conn.lock().unwrap();
        new_ws(&c, "Notes", false, false)
    };
    let m = make_meeting(&h, &ws);
    h.conn
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO transcript_segments (id, meeting_id, text, speaker, timestamp_ms, is_final, created_at) VALUES ('s1',?1,'Acme pays 12 dollars per seat today','Them',10000,1,'t')",
            [&m],
        )
        .unwrap();
    // during the meeting the button is not offered and the command refuses
    h.start_meeting(&m);
    assert!(h.rt.suggest_memory(&ws, &m).await.is_err());
    *h.live.lock().unwrap() = None;
    // after it: no setting to turn on; the section's own button is the whole path
    let items = h.rt.suggest_memory(&ws, &m).await.unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].status, "suggested", "proposals only, never saved");
    // automatic: only the workspace's toggle (update_workspace({suggest_memory: true})), off by default
    let calls = h.fake.count(AiPurpose::Memory);
    super::memory::auto_suggest_after(Arc::new(h.rt.deps().clone()), m.clone(), Duration::from_millis(10));
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(h.fake.count(AiPurpose::Memory), calls, "off by default");
    set_workspace(&h, &ws, crate::workspace::types::WorkspacePatch { suggest_memory: Some(true), ..Default::default() });
    super::memory::auto_suggest_after(Arc::new(h.rt.deps().clone()), m.clone(), Duration::from_millis(10));
    until("the automatic suggestion", || h.fake.count(AiPurpose::Memory) == calls + 1).await;
    // off again, and after a restart it is still off
    set_workspace(&h, &ws, crate::workspace::types::WorkspacePatch { suggest_memory: Some(false), ..Default::default() });
    let restarted = harness_on(h.conn.clone());
    super::memory::auto_suggest_after(Arc::new(restarted.rt.deps().clone()), m.clone(), Duration::from_millis(10));
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(restarted.fake.count(AiPurpose::Memory), 0);
}

// ---------------------------------------------------------------- ME review round 1

fn status_of(h: &H, name: &str, m: &str) -> String {
    h.events.last_status(name, m).and_then(|v| v["status"].as_str().map(str::to_string)).unwrap_or_default()
}

fn can_of(v: &Value) -> Vec<String> {
    v["can"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

#[tokio::test]
async fn state_is_running_only_while_a_run_is_in_flight_and_the_getter_agrees() {
    let h = harness();
    h.enable_notes();
    h.start_meeting("m1");
    h.rt.notetaker_start("m1").unwrap();
    *h.fake.delay.lock().unwrap() = Duration::from_millis(300);
    h.speak("m1", 120, 1_000).await;
    until("running", || status_of(&h, "notetaker_state", "m1") == "running").await;
    assert_eq!(h.rt.notetaker_state("m1").await["status"], "running");
    until("on between runs", || status_of(&h, "notetaker_state", "m1") == "on").await;
    let st = h.rt.notetaker_state("m1").await;
    assert_eq!(st["status"], "on");
    assert!(can_of(&st).contains(&"pause".to_string()) || can_of(&st).contains(&"update".to_string()), "{st}");
    for key in ["meeting_id", "status", "reason", "error_kind", "can", "tokens_used", "total_tokens", "cap", "next_in_ms", "model"] {
        assert!(st.get(key).is_some(), "the state has `{key}`: {st}");
    }
}

#[tokio::test]
async fn a_settings_patch_reaches_a_running_actor_at_once() {
    let h = harness();
    h.enable_notes();
    h.start_meeting("m1");
    h.rt.notetaker_start("m1").unwrap();
    h.speak("m1", 120, 1_000).await;
    until("a run", || h.fake.count(AiPurpose::Notes) == 1).await;
    h.rt.patch_notetaker(&json!({"cap": 777_000})).unwrap();
    for _ in 0..200 {
        if h.rt.notetaker_state("m1").await["cap"] == 777_000 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(h.rt.notetaker_state("m1").await["cap"], 777_000);
    // the brief too
    let (_ws, m) = brief_with_sheet(&h).await;
    h.rt.patch_brief(&json!({"cap": 555_000})).unwrap();
    for _ in 0..200 {
        if h.rt.brief_state(&m).await["cap"] == 555_000 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(h.rt.brief_state(&m).await["cap"], 555_000);
}

#[tokio::test]
async fn pause_resume_and_update_after_stop_are_never_silent_no_ops() {
    let h = harness();
    h.enable_notes();
    h.start_meeting("m1");
    assert!(h.rt.notetaker_pause("m1").is_err(), "nothing runs yet: it says so");
    h.rt.notetaker_start("m1").unwrap();
    h.rt.notetaker_pause("m1").unwrap();
    until("paused", || status_of(&h, "notetaker_state", "m1") == "paused").await;
    let st = h.rt.notetaker_state("m1").await;
    assert!(can_of(&st).contains(&"resume".to_string()), "{st}");
    h.speak("m1", 150, 1_000).await;
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert_eq!(h.fake.count(AiPurpose::Notes), 0, "paused: no automatic run");
    h.rt.notetaker_resume("m1").unwrap();
    until("a run after resume", || h.fake.count(AiPurpose::Notes) == 1).await;
    // Stop, then Update now: it starts again (or refuses with a reason)
    h.rt.notetaker_stop("m1");
    until("actor ended", || h.rt.inner.lock().unwrap().notes.get("m1").is_none()).await;
    let e = h.rt.notetaker_update_now("m1").unwrap_err();
    assert!(e.contains("Nothing new"), "it started again and says there is nothing to add: {e}");
    assert!(h.rt.inner.lock().unwrap().notes.get("m1").is_some(), "update after stop starts it again");
    h.speak("m1", 150, 50_000).await;
    h.rt.notetaker_update_now("m1").unwrap();
    until("a run after update", || h.fake.count(AiPurpose::Notes) == 2).await;
    // off: refused with the reason, not ignored
    h.rt.patch_notetaker(&json!({"enabled": false})).unwrap();
    until("gone", || h.rt.inner.lock().unwrap().notes.get("m1").map(|x| x.finished.load(Ordering::SeqCst)).unwrap_or(true)).await;
    let e = h.rt.notetaker_update_now("m1").unwrap_err();
    assert!(e.contains("turned off"), "{e}");
}

#[tokio::test]
async fn try_again_on_a_failed_actor_runs_again_with_the_current_settings() {
    let h = harness();
    h.enable_notes();
    h.start_meeting("m1");
    h.rt.notetaker_start("m1").unwrap();
    for _ in 0..3 {
        h.fake.push(Err(LlmError::failed("The provider said no")));
    }
    h.speak("m1", 120, 1_000).await;
    for i in 1..3u64 {
        until("a failed run", || h.fake.count(AiPurpose::Notes) as u64 >= i).await;
        h.clock.set(1_000 + i * 30_000);
        tokio::time::sleep(Duration::from_millis(60)).await;
    }
    until("error", || status_of(&h, "notetaker_state", "m1") == "error").await;
    let st = h.rt.notetaker_state("m1").await;
    assert!(can_of(&st).contains(&"try_again".to_string()), "{st}");
    assert_eq!(st["error_kind"].as_str().map(|s| !s.is_empty()), Some(true), "{st}");
    h.rt.notetaker_start("m1").unwrap();
    h.clock.set(200_000);
    until("it runs again", || h.fake.count(AiPurpose::Notes) == 4).await;
    assert_ne!(status_of(&h, "notetaker_state", "m1"), "error");
}

#[tokio::test]
async fn the_getters_answer_when_nothing_runs_and_say_why() {
    let h = harness();
    h.start_meeting("m1");
    let st = h.rt.notetaker_state("m1").await;
    assert_eq!(st["status"], "off");
    assert_eq!(st["reason"], "Live notes are turned off");
    assert_eq!(can_of(&st), vec!["start".to_string()]);
    // a workspace with the brief off: the reason is the switch
    let ws = { let c = h.conn.lock().unwrap(); new_ws(&c, "NoBrief", false, false) };
    let m = make_meeting(&h, &ws);
    let st = h.rt.brief_state(&m).await;
    assert_eq!(st["status"], "off");
    assert!(st["reason"].as_str().unwrap_or("").contains("off in this workspace"), "{st}");
    // a meeting that is gone: the reason is shown, not an empty off
    let st = h.rt.brief_state("no-such-meeting").await;
    assert!(st["reason"].as_str().unwrap_or("").len() > 3, "{st}");
}

#[tokio::test]
async fn manual_mode_runs_nothing_unasked_at_the_end_and_offers_update() {
    let h = harness();
    h.rt.patch_notetaker(&json!({"enabled": true, "update_mode": "manual"})).unwrap();
    h.start_meeting("m1");
    h.rt.notetaker_start("m1").unwrap();
    h.speak("m1", 150, 1_000).await;
    h.rt.on_meeting_end("m1");
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(h.fake.count(AiPurpose::Notes), 0, "no run nobody asked for");
    let st = h.events.last_status("notetaker_state", "m1").unwrap();
    assert!(can_of(&st).contains(&"update".to_string()), "{st}");
}

#[tokio::test]
async fn the_final_pass_that_runs_out_of_time_says_which_minutes_are_not_covered() {
    let h = harness();
    h.enable_notes();
    h.start_meeting("m1");
    h.rt.notetaker_start("m1").unwrap();
    *h.fake.delay.lock().unwrap() = Duration::from_millis(900);
    h.speak("m1", 150, 61_000).await;
    until("a run in flight", || h.fake.inflight.load(Ordering::SeqCst) == 1).await;
    // talk that arrives while that run works: still uncovered when the meeting ends
    h.rt.feed("m1", "Them", &(0..80).map(|i| format!("late{i}")).collect::<Vec<_>>().join(" "), 70_000);
    tokio::time::sleep(Duration::from_millis(40)).await;
    h.rt.on_meeting_end("m1");
    until("finished", || status_of(&h, "notetaker_state", "m1") == "finished").await;
    let st = h.events.last_status("notetaker_state", "m1").unwrap();
    let reason = st["reason"].as_str().unwrap_or("");
    assert!(reason.contains("Not covered"), "{st}");
    assert!(can_of(&st).contains(&"update".to_string()), "{st}");
}

#[tokio::test]
async fn extras_are_sent_again_after_a_session_restart_and_counted_only_after_success() {
    let h = harness();
    let (_ws, m) = brief_with_sheet(&h).await;
    let e = h.rt.session_extras(&m, "Assist", "live-fast#3").unwrap();
    assert!(h.rt.session_extras(&m, "Assist", "live-fast#3").is_some(), "no success yet");
    h.rt.mark_session_sent(&e);
    assert!(h.rt.session_extras(&m, "Assist", "live-fast#3").is_none());
    assert!(h.rt.session_extras(&m, "Assist", "live-fast#4").is_some(), "a new generation is a new session");
    h.rt.forget_sessions(&m);
    assert!(h.rt.session_extras(&m, "Assist", "live-fast#3").is_some());
}

#[tokio::test]
async fn automatic_memory_runs_stay_under_the_cap_and_say_so() {
    let h = harness();
    let ws = { let c = h.conn.lock().unwrap(); new_ws(&c, "Cap", false, false) };
    set_suggest(&h, &ws, true); // an automatic run needs the switch
    let m = make_meeting(&h, &ws);
    {
        let c = h.conn.lock().unwrap();
        for i in 0..6 {
            c.execute(
                "INSERT INTO transcript_segments (id, meeting_id, text, speaker, timestamp_ms, is_final, created_at) VALUES (?1,?2,?3,'Them',?4,1,'t')",
                rusqlite::params![format!("s{i}"), m, "Acme pays 12 dollars per seat and the price may change", 5_000 + i * 1_000],
            )
            .unwrap();
        }
    }
    let e = super::memory::suggest(h.rt.deps(), &ws, &m, Some(5)).await.unwrap_err();
    assert!(e.contains("cap"), "{e}");
    assert_eq!(h.fake.count(AiPurpose::Memory), 0, "nothing was sent over the cap");
    assert!(super::memory::suggest(h.rt.deps(), &ws, &m, Some(100_000)).await.is_ok());
    assert_eq!(h.fake.count(AiPurpose::Memory), 1);
}

fn set_suggest(h: &H, ws: &str, on: bool) {
    let c = h.conn.lock().unwrap();
    crate::workspace::store::update_workspace(&c, ws, crate::workspace::types::WorkspacePatch { suggest_memory: Some(on), ..Default::default() }).unwrap();
}

fn talk(h: &H, m: &str) {
    let c = h.conn.lock().unwrap();
    for i in 0..6 {
        c.execute(
            "INSERT INTO transcript_segments (id, meeting_id, text, speaker, timestamp_ms, is_final, created_at) VALUES (?1,?2,?3,'Them',?4,1,'t')",
            rusqlite::params![format!("s{i}"), m, "Acme pays 12 dollars per seat and the price may change", 5_000 + i * 1_000],
        )
        .unwrap();
    }
}

#[tokio::test]
async fn automatic_memory_suggestions_need_the_switch_when_sent_and_when_saved() {
    // off from the start: nothing is sent
    let h = harness();
    let ws = { let c = h.conn.lock().unwrap(); new_ws(&c, "Off", false, false) };
    let m = make_meeting(&h, &ws);
    talk(&h, &m);
    assert!(super::memory::suggest(h.rt.deps(), &ws, &m, Some(100_000)).await.unwrap().is_empty());
    assert_eq!(h.fake.count(AiPurpose::Memory), 0);
    // a person asking is not an automatic run: the switch is not needed
    assert!(super::memory::suggest(h.rt.deps(), &ws, &m, None).await.is_ok());
    assert_eq!(h.fake.count(AiPurpose::Memory), 1);

    // turned off while the call works: the result is dropped, nothing is saved
    let h = harness();
    let ws = { let c = h.conn.lock().unwrap(); new_ws(&c, "Mid", false, false) };
    set_suggest(&h, &ws, true);
    let m = make_meeting(&h, &ws);
    talk(&h, &m);
    *h.fake.delay.lock().unwrap() = Duration::from_millis(500);
    let flip = async {
        until("the call is in flight", || h.fake.inflight.load(Ordering::SeqCst) == 1).await;
        set_suggest(&h, &ws, false);
    };
    let (out, _) = tokio::join!(super::memory::suggest(h.rt.deps(), &ws, &m, Some(100_000)), flip);
    let out = out.unwrap();
    assert!(out.is_empty(), "{out:?}");
    let n: i64 = h.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM workspace_memory WHERE workspace_id = ?1", [&ws], |r| r.get(0)).unwrap_or(0);
    assert_eq!(n, 0);
}

#[tokio::test]
async fn a_deleted_or_moved_meeting_cancels_its_memory_run_in_flight_for_every_kind_of_run() {
    for automatic in [true, false] {
        let h = harness();
        let ws = { let c = h.conn.lock().unwrap(); new_ws(&c, "Run", false, false) };
        set_suggest(&h, &ws, true);
        let m = make_meeting(&h, &ws);
        talk(&h, &m);
        *h.fake.delay.lock().unwrap() = Duration::from_millis(500);
        let cancel = async {
            until("the call is in flight", || h.fake.inflight.load(Ordering::SeqCst) == 1).await;
            super::memory::cancel_runs_of_meeting(&m);
        };
        let cap = if automatic { Some(100_000) } else { None };
        let (out, _) = tokio::join!(super::memory::suggest(h.rt.deps(), &ws, &m, cap), cancel);
        assert!(out.unwrap().is_empty(), "automatic={automatic}: the result is dropped");
        let n: i64 = h.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM workspace_memory WHERE workspace_id = ?1", [&ws], |r| r.get(0)).unwrap_or(0);
        assert_eq!(n, 0, "automatic={automatic}");
        // moved before the run starts: refused, nothing sent
        let other = { let c = h.conn.lock().unwrap(); new_ws(&c, "Other", false, false) };
        { let c = h.conn.lock().unwrap(); crate::workspace::meetings::move_meeting_atomic(&c, &m, &other).unwrap(); }
        let before = h.fake.count(AiPurpose::Memory);
        assert!(super::memory::suggest(h.rt.deps(), &ws, &m, cap).await.is_err());
        assert_eq!(h.fake.count(AiPurpose::Memory), before);
    }
}

#[tokio::test]
async fn turning_the_switch_off_cancels_only_automatic_runs() {
    let h = harness();
    let ws = { let c = h.conn.lock().unwrap(); new_ws(&c, "Sw", false, false) };
    set_suggest(&h, &ws, true);
    let m = make_meeting(&h, &ws);
    talk(&h, &m);
    *h.fake.delay.lock().unwrap() = Duration::from_millis(400);
    // a person's own request is not cancelled by the switch
    let off = async {
        until("the call is in flight", || h.fake.inflight.load(Ordering::SeqCst) == 1).await;
        set_suggest(&h, &ws, false);
        super::memory::cancel_automatic_runs_of(&ws);
    };
    let (out, _) = tokio::join!(super::memory::suggest(h.rt.deps(), &ws, &m, None), off);
    assert!(out.is_ok());
    assert_eq!(h.fake.count(AiPurpose::Memory), 1);
}

#[tokio::test]
async fn suggesting_for_a_meeting_filed_in_no_workspace_is_refused_before_any_call() {
    let h = harness();
    let ws = { let c = h.conn.lock().unwrap(); new_ws(&c, "Home", false, false) };
    let m = make_meeting(&h, &ws);
    talk(&h, &m);
    { let c = h.conn.lock().unwrap(); c.execute("UPDATE meetings SET workspace_id = 'gone-ws' WHERE id = ?1", [&m]).unwrap(); }
    for cap in [None, Some(100_000)] {
        let e = super::memory::suggest(h.rt.deps(), &ws, &m, cap).await.unwrap_err();
        assert!(e.contains("not filed"), "{e}");
        let e = super::memory::suggest(h.rt.deps(), "gone-ws", &m, cap).await.unwrap_err();
        assert!(e.contains("not filed"), "{e}");
    }
    assert_eq!(h.fake.count(AiPurpose::Memory), 0, "nothing was sent");
}

#[test]
fn the_webview_payload_for_a_new_memory_item_deserialises() {
    let c: crate::workspace::types::MemoryCreate =
        serde_json::from_value(json!({"workspace_id": "w", "kind": "fact", "title": "t", "text": "x", "status": "saved"})).unwrap();
    assert!(!c.unsupported);
    assert_eq!(c.status.as_deref(), Some("saved"));
}


// ---------------------------------------------------------------- QA round 3: one time contract, manual updates

const START_MS: u64 = 1_767_348_000_000; // 2026-01-02T10:00:00Z

fn set_start(h: &H, id: &str, rfc3339: &str) {
    h.conn.lock().unwrap().execute("UPDATE meetings SET start_time = ?2 WHERE id = ?1", [id, rfc3339]).unwrap();
}

async fn say(h: &H, m: &str, words: usize, at_ms: u64, clock: u64) {
    h.clock.set(clock);
    let text = (0..words).map(|i| format!("w{i}")).collect::<Vec<_>>().join(" ");
    h.rt.feed(m, "Them", &text, at_ms);
    tokio::time::sleep(Duration::from_millis(40)).await;
    h.clock.set(clock + 3_000);
}

#[tokio::test]
async fn wall_clock_and_relative_stamps_reach_notes_and_brief_as_time_since_the_start() {
    for epoch in [true, false] {
        let h = harness();
        h.enable_notes();
        h.start_meeting("m1");
        set_start(&h, "m1", "2026-01-02T10:00:00Z");
        h.rt.notetaker_start("m1").unwrap();
        let stamp = |rel: u64| if epoch { START_MS + rel } else { rel };
        say(&h, "m1", 120, stamp(10_000), 1_000).await;
        until("a run", || h.fake.count(AiPurpose::Notes) == 1).await;
        let p = &h.fake.prompts(AiPurpose::Notes)[0];
        assert!(p.contains("[00:10]"), "epoch={epoch}: {p}");
        // the hours since 1970, as a time label would show them (the prompt's own random marker may hold any digits)
        assert!(!p.contains("1767348") && !p.contains(&format!("[{}:", START_MS / 3_600_000)), "epoch={epoch}: a wall-clock time reached the prompt");
        let doc = h.rt.get_notes("m1").await.unwrap();
        for b in doc["blocks"].as_array().unwrap() {
            assert!(b["t"].as_u64().unwrap_or(0) < 3_600_000, "epoch={epoch}: {b}");
        }
        // a stamp before the start is 0, never negative or huge
        h.rt.feed("m1", "Them", "early words here", if epoch { START_MS - 4_000 } else { 0 });
    }
}

#[tokio::test]
async fn memory_lines_follow_the_contract_for_both_kinds_of_stamps() {
    let h = harness();
    let ws = { let c = h.conn.lock().unwrap(); new_ws(&c, "T", false, false) };
    let m = make_meeting(&h, &ws);
    set_start(&h, &m, "2026-01-02T10:00:00Z");
    {
        let c = h.conn.lock().unwrap();
        for (i, ts) in [START_MS + 5_000, START_MS + 65_000, 90_000].iter().enumerate() {
            c.execute(
                "INSERT INTO transcript_segments (id, meeting_id, text, speaker, timestamp_ms, is_final, created_at) VALUES (?1,?2,'a line about pricing','Them',?3,1,'t')",
                rusqlite::params![format!("s{i}"), m, *ts as i64],
            )
            .unwrap();
        }
    }
    let (lines, len) = h.rt.deps().db.meeting_lines(&m);
    assert_eq!(lines.iter().map(|l| l.ms).collect::<Vec<_>>(), vec![5_000, 65_000, 90_000]);
    assert_eq!(len, 90_000);
    // a meeting with no usable start counts from its first stamp
    set_start(&h, &m, "garbage");
    let (lines, _) = h.rt.deps().db.meeting_lines(&m);
    assert!(lines.iter().all(|l| l.ms < 3_600_000), "{:?}", lines.iter().map(|l| l.ms).collect::<Vec<_>>());
}

#[tokio::test]
async fn update_now_runs_with_any_new_words_and_otherwise_says_nothing_new() {
    let h = harness();
    h.enable_notes();
    h.start_meeting("m1");
    h.rt.notetaker_start("m1").unwrap();
    let e = h.rt.notetaker_update_now("m1").unwrap_err();
    assert!(e.contains("Nothing new"), "{e}");
    assert_eq!(h.fake.count(AiPurpose::Notes), 0);
    // 22 words are below the automatic threshold, but Update now takes them
    say(&h, "m1", 22, 4_000, 1_000).await;
    assert_eq!(h.fake.count(AiPurpose::Notes), 0, "too few for an automatic run");
    h.rt.notetaker_update_now("m1").unwrap();
    until("the manual run", || h.fake.count(AiPurpose::Notes) == 1).await;
    // and nothing is left to add now
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert!(h.rt.notetaker_update_now("m1").unwrap_err().contains("Nothing new"));
}

#[tokio::test]
async fn very_large_reported_usage_never_ends_notes_with_an_unexplained_failure() {
    let h = harness();
    h.enable_notes();
    h.start_meeting("m1");
    h.rt.notetaker_start("m1").unwrap();
    for _ in 0..6 {
        h.fake.push(Ok(LlmReply { text: r#"{"ops":[{"op":"add","type":"bullet","text":"x","t":"00:10"}]}"#.into(), input_tokens: Some(u32::MAX), cached_input_tokens: Some(u32::MAX - 100), output_tokens: Some(u32::MAX) }));
    }
    for i in 0..4u64 {
        say(&h, "m1", 120, 10_000 + i * 60_000, 1_000 + i * 60_000).await;
        tokio::time::sleep(Duration::from_millis(120)).await;
        let _ = h.rt.notetaker_continue("m1");
        let st = h.rt.notetaker_state("m1").await;
        assert_ne!(st["status"], "error", "{st}");
        if st["status"] == "capped" {
            assert!(st["reason"].as_str().unwrap_or("").len() > 3, "capped says why: {st}");
        }
    }
}

#[tokio::test]
async fn the_brief_is_running_only_while_its_call_is_in_flight_and_names_its_meeting() {
    let h = harness();
    let (_ws, m) = brief_with_sheet(&h).await;
    // The sheet is out, so the call that made it is over: whatever it cost, the brief is not "running".
    let mut st = h.rt.brief_state(&m).await;
    for _ in 0..200 {
        if st["status"] != "running" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
        st = h.rt.brief_state(&m).await;
    }
    assert_ne!(st["status"], "running", "{st}");
    assert!(st["tokens_used"].as_u64().unwrap_or(0) > 0, "the call spent tokens: {st}");
    assert!(can_of(&st).contains(&"pause".to_string()), "{st}");
    // Every sheet event says which meeting it is for.
    for e in h.events.of("brief_sheet") {
        assert_eq!(e["meeting_id"], m.as_str(), "{e}");
    }
}

#[tokio::test]
async fn pausing_the_brief_pauses_it_and_resume_runs_it_again() {
    let h = harness();
    let (_ws, m) = brief_with_sheet(&h).await;
    h.rt.brief_pause(&m).unwrap();
    until("paused", || status_of(&h, "brief_state", &m) == "paused").await;
    assert!(can_of(&h.rt.brief_state(&m).await).contains(&"resume".to_string()));
    h.rt.brief_resume(&m).unwrap();
    until("running again", || status_of(&h, "brief_state", &m) != "paused").await;
}

#[tokio::test]
async fn starting_the_brief_again_wakes_a_paused_actor() {
    let h = harness();
    let (_ws, m) = brief_with_sheet(&h).await;
    h.rt.brief_pause(&m).unwrap();
    until("paused", || status_of(&h, "brief_state", &m) == "paused").await;
    h.rt.brief_start(&m).unwrap();
    until("running again", || status_of(&h, "brief_state", &m) != "paused").await;
}

// ---------------------------------------------------------------- ME round 2: G2 uncovered range, G3 per-run model, G7 search errors

fn providers(h: &H) -> Vec<String> {
    h.fake.providers.lock().unwrap().clone()
}

#[tokio::test]
async fn the_provider_is_resolved_before_every_run_a_then_b_and_never_falls_back() {
    let h = harness();
    *h.fake.active.lock().unwrap() = "A".into();
    h.enable_notes();
    h.start_meeting("m1");
    h.rt.notetaker_start("m1").unwrap();
    say(&h, "m1", 120, 10_000, 1_000).await;
    until("first run", || h.fake.count(AiPurpose::Notes) == 1).await;
    assert_eq!(providers(&h), vec!["A"]);
    assert_eq!(h.rt.notetaker_state("m1").await["model"]["provider"], "A");
    // the active provider changes between runs: the next run and the label are B, nothing more goes to A
    *h.fake.active.lock().unwrap() = "B".into();
    assert_eq!(h.rt.notetaker_state("m1").await["model"]["provider"], "B", "the label is what the next run will use");
    say(&h, "m1", 120, 70_000, 61_000).await;
    until("second run", || h.fake.count(AiPurpose::Notes) == 2).await;
    assert_eq!(providers(&h), vec!["A", "B"]);
    // nothing usable: the run stops with the reason, no call is made, nothing falls back to A or B
    *h.fake.active.lock().unwrap() = "none".into();
    say(&h, "m1", 120, 130_000, 121_000).await;
    until("a failed run", || h.events.last_status("notetaker_state", "m1").map(|v| v["reason"].as_str().unwrap_or("").contains("No AI provider")).unwrap_or(false)).await;
    assert_eq!(providers(&h), vec!["A", "B"], "no call went to any provider");
    // the provider comes back, also after the error: the next run uses it
    *h.fake.active.lock().unwrap() = "C".into();
    h.rt.notetaker_resume("m1").unwrap();
    h.clock.set(300_000);
    until("a run on C", || providers(&h).last().map(String::as_str) == Some("C")).await;
}

#[tokio::test]
async fn memory_chunks_follow_the_provider_too_and_the_brief_label_is_the_next_runs() {
    let h = harness();
    *h.fake.active.lock().unwrap() = "A".into();
    let ws = { let c = h.conn.lock().unwrap(); new_ws(&c, "Prov", false, false) };
    let m = make_meeting(&h, &ws);
    {
        let c = h.conn.lock().unwrap();
        c.execute(
            "INSERT INTO transcript_segments (id, meeting_id, text, speaker, timestamp_ms, is_final, created_at) VALUES ('s1',?1,'Acme pays 12 dollars per seat today','Them',10000,1,'t')",
            [&m],
        )
        .unwrap();
    }
    super::memory::suggest(h.rt.deps(), &ws, &m, None).await.unwrap();
    *h.fake.active.lock().unwrap() = "B".into();
    super::memory::suggest(h.rt.deps(), &ws, &m, None).await.unwrap();
    assert_eq!(providers(&h), vec!["A", "B"]);
    *h.fake.active.lock().unwrap() = "none".into();
    let e = super::memory::suggest(h.rt.deps(), &ws, &m, None).await.unwrap_err();
    assert!(e.contains("No AI provider"), "{e}");
    assert_eq!(providers(&h).len(), 2);
}

#[tokio::test]
async fn the_range_not_covered_is_saved_survives_the_end_and_is_updated_from_the_saved_transcript() {
    let h = harness();
    let ws = { let c = h.conn.lock().unwrap(); new_ws(&c, "Unc", false, false) };
    let m = make_meeting(&h, &ws);
    {
        let c = h.conn.lock().unwrap();
        for i in 0..40u64 {
            c.execute(
                "INSERT INTO transcript_segments (id, meeting_id, text, speaker, timestamp_ms, is_final, created_at) VALUES (?1,?2,?3,'Them',?4,1,'t')",
                rusqlite::params![format!("s{i}"), m, format!("line {i} about the annual pricing plan and the renewal terms"), (i * 5_000) as i64],
            )
            .unwrap();
        }
    }
    h.rt.patch_notetaker(&json!({"enabled": true, "update_mode": "manual"})).unwrap();
    h.start_meeting(&m);
    h.rt.notetaker_start(&m).unwrap();
    for i in 0..40u64 {
        h.rt.feed(&m, "Them", &format!("line {i} about the annual pricing plan and the renewal terms"), i * 5_000);
    }
    tokio::time::sleep(Duration::from_millis(60)).await;
    h.rt.on_meeting_end(&m);
    *h.live.lock().unwrap() = None;
    until("finished", || status_of(&h, "notetaker_state", &m) == "finished").await;
    // the app closes with the notes waiting on manual: what was never covered is saved with them
    h.rt.shutdown(Duration::from_secs(2)).await;
    until("the actor is gone", || h.rt.inner.lock().unwrap().notes.get(m.as_str()).is_none()).await;
    // saved with the notes: the getter of the ended meeting carries it as data
    let st = h.rt.notetaker_state(&m).await;
    assert_eq!(st["status"], "finished", "{st}");
    assert_eq!(st["not_covered"]["from_ms"], 0, "{st}");
    assert_eq!(st["not_covered"]["to_ms"], 195_000, "{st}");
    assert!(can_of(&st).contains(&"update".to_string()), "{st}");
    // refused with a reason while another meeting is live
    let other = make_meeting(&h, &ws);
    h.start_meeting(&other);
    let e = h.rt.notetaker_update_now(&m).unwrap_err();
    assert!(e.contains("Another meeting is live"), "{e}");
    assert_eq!(h.fake.count(AiPurpose::Notes), 0);
    *h.live.lock().unwrap() = None;
    // now it runs on the saved transcript, for the uncovered part
    h.rt.notetaker_update_now(&m).unwrap();
    until("the update ran", || h.fake.count(AiPurpose::Notes) == 1).await;
    let p = &h.fake.prompts(AiPurpose::Notes)[0];
    assert!(p.contains("line 0 about") && p.contains("line 39 about"), "the saved transcript was sent");
    until("finished again", || {
        let st = h.events.last_status("notetaker_state", &m);
        st.map(|v| v["status"] == "finished" && v["not_covered"].is_null()).unwrap_or(false)
    })
    .await;
    let st = h.rt.notetaker_state(&m).await;
    assert!(st["not_covered"].is_null(), "{st}");
    assert!(h.rt.notetaker_update_now(&m).unwrap_err().contains("Nothing new"));
}

#[tokio::test]
async fn a_failing_brief_search_is_the_reason_the_brief_shows() {
    let h = harness();
    let ws = brief_workspace(&h);
    let m = make_meeting(&h, &ws);
    h.start_meeting(&m);
    h.rt.brief_start(&m).unwrap();
    {
        let c = h.conn.lock().unwrap();
        let _ = c.execute_batch("DROP TABLE search_fts; DROP TABLE search_fts_tri;");
    }
    publish_a_sheet(&h, &m);
    let mut reason = String::new();
    for _ in 0..300 {
        reason = h.rt.brief_state(&m).await["reason"].as_str().unwrap_or("").to_string();
        if reason.contains("could not search") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(reason.contains("could not search"), "{reason}");
}

// ---------------------------------------------------------------- QA round 5: the range not covered is never lost

fn add_segment(h: &H, meeting: &str, id: &str, ms: i64) {
    h.conn
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO transcript_segments (id, meeting_id, text, speaker, timestamp_ms, is_final, created_at) VALUES (?1,?2,'a saved line about pricing','Them',?3,1,'t')",
            rusqlite::params![id, meeting, ms],
        )
        .unwrap();
}

/// A meeting with one covered run (to 10 s), saved lines at 10 s, 50 s and 90 s, and two lines still unsent.
async fn meeting_with_a_backlog(h: &H) {
    h.enable_notes();
    h.start_meeting("m1");
    h.rt.notetaker_start("m1").unwrap();
    say(h, "m1", 120, 10_000, 1_000).await;
    until("the first run", || h.fake.count(AiPurpose::Notes) == 1).await;
    for (i, ms) in [10_000, 50_000, 90_000].into_iter().enumerate() {
        add_segment(h, "m1", &format!("s{i}"), ms);
    }
    *h.fake.delay.lock().unwrap() = Duration::from_millis(900);
    for ms in [50_000u64, 90_000] {
        h.rt.feed("m1", "Them", "more talk about the renewal and the annual pricing plan today", ms);
    }
    tokio::time::sleep(Duration::from_millis(40)).await;
}

#[tokio::test]
async fn a_final_pass_that_ran_out_of_time_is_still_reported_after_reopening_with_a_fresh_runtime() {
    let h = harness();
    meeting_with_a_backlog(&h).await;
    h.rt.on_meeting_end("m1");
    *h.live.lock().unwrap() = None;
    until("finished", || status_of(&h, "notetaker_state", "m1") == "finished").await;
    let st = h.events.last_status("notetaker_state", "m1").unwrap();
    assert_eq!((st["not_covered"]["from_ms"].as_u64(), st["not_covered"]["to_ms"].as_u64()), (Some(50_000), Some(90_000)), "{st}");
    // reopened later: a new runtime on the same database, the notes switch off ("this meeting" ended with it)
    let h2 = harness_on(h.conn.clone());
    let st = h2.rt.notetaker_state("m1").await;
    assert_eq!(st["status"], "finished", "{st}");
    assert_eq!((st["not_covered"]["from_ms"].as_u64(), st["not_covered"]["to_ms"].as_u64()), (Some(50_000), Some(90_000)), "{st}");
    assert!(can_of(&st).contains(&"update".to_string()), "{st}");
    // and "Update notes" works from there, on the saved transcript
    *h2.fake.delay.lock().unwrap() = Duration::ZERO;
    h2.rt.notetaker_update_now("m1").unwrap();
    until("the update", || h2.fake.count(AiPurpose::Notes) == 1).await;
    until("covered", || h2.events.last_status("notetaker_state", "m1").map(|v| v["status"] == "finished" && v["not_covered"].is_null()).unwrap_or(false)).await;
    let h3 = harness_on(h.conn.clone());
    assert!(h3.rt.notetaker_state("m1").await["not_covered"].is_null());
}

#[tokio::test]
async fn quitting_during_the_final_pass_loses_nothing() {
    let h = harness();
    meeting_with_a_backlog(&h).await;
    h.rt.on_meeting_end("m1");
    *h.live.lock().unwrap() = None;
    h.rt.shutdown(Duration::from_millis(80)).await; // the app closes while the pass is running
    let h2 = harness_on(h.conn.clone());
    let st = h2.rt.notetaker_state("m1").await;
    assert_eq!(st["status"], "finished", "{st}");
    assert_eq!((st["not_covered"]["from_ms"].as_u64(), st["not_covered"]["to_ms"].as_u64()), (Some(50_000), Some(90_000)), "{st}");
}

#[tokio::test]
async fn a_crash_mid_meeting_is_marked_from_the_transcript_on_the_next_start() {
    let h = harness();
    meeting_with_a_backlog(&h).await;
    // kill -9: nothing at all runs after this point; the row still says it was running
    let status: String = h.conn.lock().unwrap().query_row("SELECT status FROM meeting_notes WHERE meeting_id = 'm1'", [], |r| r.get(0)).unwrap();
    assert_eq!(status, "running");
    let h2 = harness_on(h.conn.clone()); // starts again: the running row becomes "interrupted"
    *h2.live.lock().unwrap() = None;
    let st = h2.rt.notetaker_state("m1").await;
    assert_eq!(st["status"], "finished", "{st}");
    assert_eq!((st["not_covered"]["from_ms"].as_u64(), st["not_covered"]["to_ms"].as_u64()), (Some(50_000), Some(90_000)), "{st}");
}

#[test]
fn coverage_is_the_last_line_folded_in_against_the_transcript() {
    let mut d = crate::live_notes::doc::NoteDoc::new();
    assert_eq!(d.uncovered_in(&[1_000, 2_000]), None, "notes that never began cover nothing and miss nothing");
    d.started_at = Some(5_000);
    d.covered_to = Some(20_000);
    assert_eq!(d.uncovered_in(&[1_000, 5_000, 20_000]), None, "before the notes began and covered");
    assert_eq!(d.uncovered_in(&[1_000, 5_000, 20_000, 30_000, 45_000]), Some((30_000, 45_000)));
    d.covered_to = None;
    assert_eq!(d.uncovered_in(&[1_000, 5_000, 6_000]), Some((5_000, 6_000)));
}


#[tokio::test]
async fn a_run_still_in_flight_when_the_meeting_ends_is_bounded_by_the_final_timeout() {
    let h = harness();
    h.enable_notes();
    h.start_meeting("m1");
    h.rt.notetaker_start("m1").unwrap();
    *h.fake.delay.lock().unwrap() = Duration::from_secs(5);
    say(&h, "m1", 120, 10_000, 1_000).await;
    until("a run in flight", || h.fake.inflight.load(Ordering::SeqCst) == 1).await;
    let ended = std::time::Instant::now();
    h.rt.on_meeting_end("m1");
    *h.live.lock().unwrap() = None;
    until("finished", || status_of(&h, "notetaker_state", "m1") == "finished").await;
    assert!(ended.elapsed() < Duration::from_secs(3), "the in-flight run was waited for ({:?})", ended.elapsed());
    let st = h.events.last_status("notetaker_state", "m1").unwrap();
    assert_eq!(st["not_covered"]["from_ms"], 10_000, "{st}");
    assert!(can_of(&st).contains(&"update".to_string()), "{st}");
}

// ---------------------------------------------------------------- ME round 3: how the notes ended, keep going after the end, moved online

fn big_usage(h: &H, n: usize) {
    for _ in 0..n {
        h.fake.push(Ok(LlmReply { text: r#"{"ops":[]}"#.into(), input_tokens: Some(20_000), cached_input_tokens: Some(0), output_tokens: Some(300) }));
    }
}

#[tokio::test]
async fn the_notes_say_how_they_ended_as_data() {
    // covered
    let h = harness();
    h.enable_notes();
    h.start_meeting("m1");
    h.rt.notetaker_start("m1").unwrap();
    say(&h, "m1", 120, 10_000, 1_000).await;
    until("a run", || h.fake.count(AiPurpose::Notes) == 1).await;
    let live = h.rt.notetaker_state("m1").await;
    assert!(live["ended"].is_null(), "a running meeting is not finished: {live}");
    h.rt.on_meeting_end("m1");
    *h.live.lock().unwrap() = None;
    until("finished", || status_of(&h, "notetaker_state", "m1") == "finished").await;
    let st = h.events.last_status("notetaker_state", "m1").unwrap();
    assert_eq!(st["ended"]["kind"], "covered", "{st}");
    // a meeting that never had notes says so
    let ws = { let c = h.conn.lock().unwrap(); new_ws(&c, "NoNotes", false, false) };
    let none = make_meeting(&h, &ws);
    let st = h.rt.notetaker_state(&none).await;
    assert_eq!(st["status"], "off", "{st}");
    assert!(st["ended"].is_null() && st["not_covered"].is_null(), "{st}");
    assert!(can_of(&st).is_empty(), "{st}");
    assert!(st["reason"].as_str().unwrap_or("").contains("No live notes"), "{st}");
}

#[tokio::test]
async fn stopping_at_the_limit_is_saved_as_limit_and_keep_going_after_the_end_covers_the_rest() {
    let h = harness();
    h.rt.patch_notetaker(&json!({"enabled": true, "cap": 2_000})).unwrap();
    h.start_meeting("m1");
    h.rt.notetaker_start("m1").unwrap();
    big_usage(&h, 1);
    say(&h, "m1", 120, 10_000, 1_000).await;
    until("capped", || status_of(&h, "notetaker_state", "m1") == "capped").await;
    for (i, ms) in [10_000, 50_000, 90_000].into_iter().enumerate() {
        add_segment(&h, "m1", &format!("s{i}"), ms);
    }
    h.rt.feed("m1", "Them", "more talk about the renewal and the annual pricing plan today", 50_000);
    h.rt.feed("m1", "Them", "and the closing remarks about the budget owner for next year", 90_000);
    tokio::time::sleep(Duration::from_millis(40)).await;
    h.rt.on_meeting_end("m1");
    *h.live.lock().unwrap() = None;
    until("finished", || status_of(&h, "notetaker_state", "m1") == "finished").await;
    let st = h.events.last_status("notetaker_state", "m1").unwrap();
    assert_eq!(st["ended"]["kind"], "limit", "{st}");
    assert!(st["reason"].as_str().unwrap_or("").contains("limit"), "the reason must not blame the end of the meeting: {st}");
    // reopened with a fresh runtime whose limit is the same small one: still over, so Keep going is offered
    let h2 = harness_on(h.conn.clone());
    h2.rt.patch_notetaker(&json!({"enabled": true, "cap": 2_000})).unwrap();
    let st = h2.rt.notetaker_state("m1").await;
    assert_eq!(st["ended"]["kind"], "limit", "{st}");
    assert!(can_of(&st).contains(&"keep_going".to_string()) && can_of(&st).contains(&"update".to_string()), "{st}");
    let e = h2.rt.notetaker_update_now("m1").unwrap_err();
    assert!(e.contains("Keep going"), "{e}");
    assert_eq!(h2.fake.count(AiPurpose::Notes), 0);
    // one press raises the limit and covers everything left
    h2.rt.notetaker_continue("m1").unwrap();
    until("the update ran", || h2.fake.count(AiPurpose::Notes) >= 1).await;
    until("covered", || h2.events.last_status("notetaker_state", "m1").map(|v| v["status"] == "finished" && v["ended"]["kind"] == "covered").unwrap_or(false)).await;
    let h3 = harness_on(h.conn.clone());
    let st = h3.rt.notetaker_state("m1").await;
    assert!(st["not_covered"].is_null() && st["ended"]["kind"] == "covered", "{st}");
}

#[tokio::test]
async fn a_failed_final_pass_is_saved_as_an_error_with_its_text() {
    let h = harness();
    h.enable_notes();
    h.start_meeting("m1");
    h.rt.notetaker_start("m1").unwrap();
    say(&h, "m1", 120, 10_000, 1_000).await;
    until("a run", || h.fake.count(AiPurpose::Notes) == 1).await;
    for _ in 0..3 {
        h.fake.push(Err(LlmError::failed("The provider said no")));
    }
    h.rt.feed("m1", "Them", "late words about the quarterly numbers and the hiring plan", 50_000);
    tokio::time::sleep(Duration::from_millis(40)).await;
    h.rt.on_meeting_end("m1");
    *h.live.lock().unwrap() = None;
    until("finished", || status_of(&h, "notetaker_state", "m1") == "finished").await;
    let st = h.events.last_status("notetaker_state", "m1").unwrap();
    assert_eq!(st["ended"]["kind"], "error", "{st}");
    assert!(st["ended"]["detail"].as_str().unwrap_or("").contains("The provider said no"), "{st}");
}

#[tokio::test]
async fn automatic_moving_from_a_local_model_to_an_online_one_is_reported_until_dismissed() {
    let h = harness();
    *h.fake.active.lock().unwrap() = "ollama".into();
    h.enable_notes();
    h.start_meeting("m1");
    h.rt.notetaker_start("m1").unwrap();
    assert!(h.rt.notetaker_state("m1").await["moved_online"].is_null());
    *h.fake.active.lock().unwrap() = "openai".into();
    let st = h.rt.notetaker_state("m1").await;
    assert_eq!((st["moved_online"]["from"].as_str(), st["moved_online"]["to"].as_str()), (Some("ollama"), Some("openai")), "{st}");
    h.rt.dismiss_moved_online("m1", false);
    tokio::time::sleep(Duration::from_millis(60)).await;
    assert!(h.rt.notetaker_state("m1").await["moved_online"].is_null());
    // online to online, or a pinned provider, never says it
    *h.fake.active.lock().unwrap() = "groq".into();
    assert!(h.rt.notetaker_state("m1").await["moved_online"].is_null());
}

#[tokio::test]
async fn an_unrelated_settings_patch_does_not_reset_keep_goings_fresh_allotment() {
    let h = harness();
    h.rt.patch_notetaker(&json!({"enabled": true, "cap": 2_000})).unwrap();
    h.start_meeting("m1");
    h.rt.notetaker_start("m1").unwrap();
    big_usage(&h, 1);
    say(&h, "m1", 120, 10_000, 1_000).await;
    until("capped", || status_of(&h, "notetaker_state", "m1") == "capped").await;
    h.rt.notetaker_continue("m1").unwrap();
    until("raised", || h.events.last_status("notetaker_state", "m1").map(|v| v["cap"].as_u64().unwrap_or(0) > 20_000).unwrap_or(false)).await;
    let raised = h.rt.notetaker_state("m1").await["cap"].as_u64().unwrap();
    h.rt.patch_notetaker(&json!({"colors": false})).unwrap();
    h.rt.notetaker_start("m1").unwrap(); // Try again also sends the settings
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(h.rt.notetaker_state("m1").await["cap"].as_u64().unwrap(), raised, "the limit was reset to the setting");
}

// ---------------------------------------------------------------- the passes after the end listen to everything

/// An ended meeting with notes that covered nothing yet and `lines` saved lines: updating it takes several passes.
fn seed_ended(h: &H, lines: usize) -> String {
    let ws = { let c = h.conn.lock().unwrap(); new_ws(&c, "Ended", false, false) };
    let m = make_meeting(h, &ws);
    {
        let c = h.conn.lock().unwrap();
        for i in 0..lines {
            c.execute(
                "INSERT INTO transcript_segments (id, meeting_id, text, speaker, timestamp_ms, is_final, created_at) VALUES (?1,?2,?3,'Them',?4,1,'t')",
                rusqlite::params![format!("e{i}"), m, format!("line {i} about the annual pricing plan and the renewal terms for the next year"), 1_000 + (i as i64) * 2_000],
            )
            .unwrap();
        }
    }
    let mut doc = crate::live_notes::doc::NoteDoc::new();
    doc.started_at = Some(0);
    h.rt.deps().db.save_notes(&m, &doc, "done", 100, 120_000).unwrap();
    h.rt.patch_notetaker(&json!({"enabled": true})).unwrap();
    m
}

async fn first_pass_in_flight(h: &H, m: &str) {
    *h.fake.delay.lock().unwrap() = Duration::from_millis(400);
    h.rt.notetaker_update_now(m).unwrap();
    until("the first pass", || h.fake.inflight.load(Ordering::SeqCst) == 1).await;
}

#[tokio::test]
async fn an_update_of_an_ended_meeting_takes_every_pass_until_covered() {
    let h = harness();
    let m = seed_ended(&h, 300);
    h.rt.notetaker_update_now(&m).unwrap();
    until("covered", || h.events.last_status("notetaker_state", &m).map(|v| v["status"] == "finished" && v["ended"]["kind"] == "covered").unwrap_or(false)).await;
    assert!(h.fake.count(AiPurpose::Notes) >= 2, "more than one pass: {}", h.fake.count(AiPurpose::Notes));
}

#[tokio::test]
async fn deleting_the_meeting_mid_pass_stops_the_update_and_saves_nothing() {
    let h = harness();
    let m = seed_ended(&h, 300);
    let before = h.rt.deps().db.load_notes(&m).unwrap().updated_at;
    first_pass_in_flight(&h, &m).await;
    let seen = h.events.all.lock().unwrap().len();
    h.rt.meeting_deleted(&m);
    tokio::time::sleep(Duration::from_millis(900)).await;
    assert_eq!(h.fake.count(AiPurpose::Notes), 1, "no pass after the delete");
    assert_eq!(h.rt.deps().db.load_notes(&m).unwrap().updated_at, before, "nothing saved after the delete");
    let late: Vec<String> = h.events.all.lock().unwrap().iter().skip(seen).filter(|(_, v)| v["meeting_id"] == json!(m)).map(|(n, _)| n.clone()).collect();
    assert!(late.is_empty(), "events after the delete: {late:?}");
}

#[tokio::test]
async fn stopping_mid_update_marks_what_is_left_and_sends_nothing_more() {
    let h = harness();
    let m = seed_ended(&h, 300);
    first_pass_in_flight(&h, &m).await;
    h.rt.notetaker_stop(&m);
    tokio::time::sleep(Duration::from_millis(900)).await;
    assert_eq!(h.fake.count(AiPurpose::Notes), 1);
    let st = h.rt.notetaker_state(&m).await;
    assert!(!st["not_covered"].is_null() && st["ended"]["kind"] != "covered", "{st}");
}

#[tokio::test]
async fn quitting_mid_update_keeps_the_range_for_the_next_start() {
    let h = harness();
    let m = seed_ended(&h, 300);
    first_pass_in_flight(&h, &m).await;
    h.rt.shutdown(Duration::from_secs(2)).await;
    assert_eq!(h.fake.count(AiPurpose::Notes), 1);
    let h2 = harness_on(h.conn.clone());
    let st = h2.rt.notetaker_state(&m).await;
    assert!(!st["not_covered"].is_null(), "{st}");
    assert!(can_of(&st).contains(&"update".to_string()), "{st}");
}

#[tokio::test]
async fn a_new_live_meeting_makes_the_update_give_way_at_once() {
    let h = harness();
    let m = seed_ended(&h, 300);
    first_pass_in_flight(&h, &m).await;
    h.start_meeting("another-live-meeting");
    until("paused", || h.events.last_status("notetaker_state", &m).map(|v| v["ended"]["kind"] == "paused").unwrap_or(false)).await;
    assert_eq!(h.fake.count(AiPurpose::Notes), 1, "no pass for the old meeting once the new one started");
    let st = h.events.last_status("notetaker_state", &m).unwrap();
    assert!(can_of(&st).contains(&"update".to_string()) && st["reason"].as_str().unwrap_or("").contains("another meeting"), "{st}");
}

#[tokio::test]
async fn the_provider_is_resolved_again_for_each_pass_of_an_update() {
    let h = harness();
    *h.fake.active.lock().unwrap() = "A".into();
    let m = seed_ended(&h, 300);
    first_pass_in_flight(&h, &m).await;
    *h.fake.active.lock().unwrap() = "B".into();
    until("covered", || h.events.last_status("notetaker_state", &m).map(|v| v["ended"]["kind"] == "covered").unwrap_or(false)).await;
    let used = providers(&h);
    assert_eq!(used.first().map(String::as_str), Some("A"));
    assert!(used.iter().skip(1).all(|p| p == "B") && used.len() >= 2, "{used:?}");
}

#[tokio::test]
async fn the_limit_reached_between_passes_ends_the_update_as_limit() {
    let h = harness();
    let m = seed_ended(&h, 300);
    h.rt.patch_notetaker(&json!({"cap": 150_000})).unwrap();
    big_usage(&h, 1); // the first pass reports 20k tokens
    h.rt.deps().db.save_notes(&m, &h.rt.deps().db.load_notes(&m).unwrap().doc, "done", 100, 5_000).unwrap();
    h.rt.patch_notetaker(&json!({"cap": 5_000})).unwrap();
    h.rt.notetaker_update_now(&m).unwrap();
    until("ended", || h.events.last_status("notetaker_state", &m).map(|v| v["status"] == "finished").unwrap_or(false)).await;
    let st = h.events.last_status("notetaker_state", &m).unwrap();
    assert_eq!(st["ended"]["kind"], "limit", "{st}");
    assert_eq!(h.fake.count(AiPurpose::Notes), 1, "no pass after the limit");
}

#[tokio::test]
async fn stopping_after_a_provider_change_cancels_the_call_that_was_in_flight() {
    let h = harness();
    let m = seed_ended(&h, 300);
    *h.fake.delay.lock().unwrap() = Duration::from_secs(30);
    h.rt.notetaker_update_now(&m).unwrap();
    until("a pass in flight", || h.fake.inflight.load(Ordering::SeqCst) == 1).await;
    // the settings change swaps the slot while the original call is still running
    h.rt.patch_notetaker(&json!({"provider": "openai", "model": "gpt-x"})).unwrap();
    tokio::time::sleep(Duration::from_millis(60)).await;
    h.rt.notetaker_stop(&m);
    until("the ORIGINAL call was cancelled", || h.fake.cancel_seen.load(Ordering::SeqCst) == 1).await;
    until("the actor is gone", || h.rt.inner.lock().unwrap().notes.get(m.as_str()).is_none()).await;
    assert_eq!(h.fake.count(AiPurpose::Notes), 1);
}

#[tokio::test]
async fn a_provider_that_never_answers_does_not_hold_the_actor() {
    let h = harness();
    let m = seed_ended(&h, 300);
    h.fake.ignore_cancel.store(true, Ordering::SeqCst);
    *h.fake.delay.lock().unwrap() = Duration::from_secs(600);
    h.rt.notetaker_update_now(&m).unwrap();
    until("a pass in flight", || h.fake.inflight.load(Ordering::SeqCst) == 1).await;
    let t = std::time::Instant::now();
    h.rt.meeting_deleted(&m);
    until("the actor is gone", || h.rt.inner.lock().unwrap().notes.get(m.as_str()).is_none()).await;
    assert!(t.elapsed() < Duration::from_secs(5), "held for {:?}", t.elapsed());
    // the same for a stop
    let h2 = harness();
    let m2 = seed_ended(&h2, 300);
    h2.fake.ignore_cancel.store(true, Ordering::SeqCst);
    *h2.fake.delay.lock().unwrap() = Duration::from_secs(600);
    h2.rt.notetaker_update_now(&m2).unwrap();
    until("a pass in flight", || h2.fake.inflight.load(Ordering::SeqCst) == 1).await;
    let t = std::time::Instant::now();
    h2.rt.notetaker_stop(&m2);
    until("the actor is gone", || h2.rt.inner.lock().unwrap().notes.get(m2.as_str()).is_none()).await;
    assert!(t.elapsed() < Duration::from_secs(5), "held for {:?}", t.elapsed());
    let st = h2.rt.notetaker_state(&m2).await;
    assert!(!st["not_covered"].is_null(), "{st}");
}
