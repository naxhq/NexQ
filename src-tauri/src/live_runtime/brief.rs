//! One meeting's live brief: an actor owning the brief engine. It searches
//! the meeting's scope locally, calls the model only when the trigger says so,
//! and throws away anything a scope change overtook.

use crate::ai_runs::AiPurpose;
use crate::live_brief::engine::{BriefConfig, BriefEngine, BriefLine, BriefSink, BriefSnapshot, BriefStatus, BriefStore};
use crate::live_brief::search::{LocalSearch, Passage};
use crate::live_brief::sheet::{Sheet, SheetHolder, SheetView};
use crate::live_common::{Clock, LlmCall, PauseReason, RunState};
use crate::live_runtime::db::{LiveDb, LiveScope};
use crate::live_runtime::llm::{LlmFactory, Selection, SwapLlm};
use crate::live_runtime::settings::BriefSettings;
use crate::live_runtime::Emitter;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

pub enum BriefCmd {
    Line { ms: u64, text: String },
    Refresh,
    /// The meeting's scope changed: look it up now.
    ScopeChanged,
    Pause,
    Resume,
    KeepGoing,
    Stop,
    Finish,
    Quit,
    Get(oneshot::Sender<Value>),
}

/// What live answers read without asking the actor.
pub struct BriefShared {
    pub holder: Arc<Mutex<SheetHolder>>,
    pub scope_key: Mutex<String>,
    pub memory: Mutex<String>,
    pub nonce: String,
}

pub struct BriefHandle {
    pub tx: mpsc::UnboundedSender<BriefCmd>,
    pub queued: Arc<AtomicUsize>,
    pub finished: Arc<AtomicBool>,
    pub shared: Arc<BriefShared>,
}

pub struct BriefParams {
    pub meeting_id: String,
    pub settings: BriefSettings,
    pub scope: LiveScope,
    pub db: LiveDb,
    pub emitter: Arc<dyn Emitter>,
    pub factory: Arc<dyn LlmFactory>,
    pub clock: Arc<dyn Clock>,
    pub busy: Arc<dyn Fn() -> bool + Send + Sync>,
    /// The scope generation of the AI run service (see `AiRuns::generation`).
    pub generation: Arc<dyn Fn(&str) -> u64 + Send + Sync>,
    pub on_exit: Arc<dyn Fn(&str) + Send + Sync>,
    pub tick: Duration,
    /// How often the meeting's scope is looked up again.
    pub scope_check: Duration,
    /// The brief is still wanted in this scope (workspace has it on, settings on).
    pub still_enabled: Arc<dyn Fn(&LiveScope) -> bool + Send + Sync>,
}

struct Sink;
impl BriefSink for Sink {
    fn status(&self, _: &BriefStatus) {}
    fn sheet(&self, _: &SheetView) {}
    fn cap_reached(&self) {}
}

struct DbStore {
    db: LiveDb,
    meeting_id: String,
}
impl BriefStore for DbStore {
    fn save(&self, s: &BriefSnapshot) -> Result<(), String> {
        self.db.save_brief(&self.meeting_id, s.sheet.as_ref(), &s.status, s.tokens_used, s.cap)
    }
}

struct SearchFn {
    db: LiveDb,
    scope: Arc<Mutex<LiveScope>>,
}
impl LocalSearch for SearchFn {
    fn search(&self, query: &str, _limit_tokens: u32, max: usize) -> Vec<Passage> {
        let scope = self.scope.lock().unwrap().clone();
        self.db.search(&scope, query, max)
    }
}

pub fn sheet_to_contract(sheet: &Sheet, generated_at: i64) -> Value {
    json!({
        "now": sheet.now,
        "facts": sheet.facts.iter().map(|f| {
            // the passage id is `kind:ref_id#n`
            let (kind, rest) = f.source_id.split_once(':').unwrap_or(("", f.source_id.as_str()));
            let ref_id = rest.rsplit_once('#').map(|(r, _)| r).unwrap_or(rest);
            let pid = rest.rsplit_once('#').and_then(|(_, n)| n.parse::<i64>().ok());
            json!({
                "text": f.text, "source": f.source_title, "passage_id": pid,
                "sources": [{"kind": kind, "ref_id": ref_id, "sub_ref": Value::Null, "title": f.source_title, "start_ms": f.source_ms}],
            })
        }).collect::<Vec<_>>(),
        "earlier": sheet.earlier,
        "generated_at": generated_at,
    })
}

pub fn status_event(meeting_id: &str, st: &BriefStatus, stopped: bool) -> Value {
    let (status, reason): (&str, Option<String>) = if stopped {
        ("off", None)
    } else {
        match st.state {
            RunState::Stopped => ("off", None),
            RunState::CapReached => ("capped", Some("The token cap for this meeting was reached".into())),
            RunState::Paused(PauseReason::User) => ("paused", None),
            RunState::Paused(PauseReason::PlanLimit) => ("paused", Some(st.last_error.clone().unwrap_or_else(|| "The plan's usage limit was reached".into()))),
            RunState::Paused(PauseReason::Failures) => ("error", Some(st.last_error.clone().map(|e| format!("Three runs in a row failed: {e}")).unwrap_or_else(|| "Three runs in a row failed".into()))),
            RunState::Running => {
                if st.in_flight || st.tokens_used > 0 {
                    ("running", st.last_error.clone())
                } else {
                    ("idle", None)
                }
            }
        }
    };
    json!({"meeting_id": meeting_id, "status": status, "tokens_used": st.tokens_used, "cap": st.cap, "reason": reason})
}

pub fn spawn(p: BriefParams) -> Result<BriefHandle, String> {
    let selection = Selection { provider: p.settings.provider.clone(), model: p.settings.model.clone(), effort: p.settings.effort.clone() };
    let swap = SwapLlm::new(p.factory.clone(), AiPurpose::Brief, &p.meeting_id, selection)?;
    let scope_cell = Arc::new(Mutex::new(p.scope.clone()));
    let mut cfg = BriefConfig::default();
    cfg.trigger.cap_tokens = p.settings.cap;
    let search = SearchFn { db: p.db.clone(), scope: scope_cell.clone() };
    let store = Arc::new(DbStore { db: p.db.clone(), meeting_id: p.meeting_id.clone() });
    let mut engine = BriefEngine::new(swap.clone(), p.clock.clone(), search, &p.scope.fingerprint, cfg, Arc::new(Sink), store);
    engine.set_memory(&p.scope.memory_text);
    let shared = Arc::new(BriefShared {
        holder: engine.holder_handle(),
        scope_key: Mutex::new(p.scope.fingerprint.clone()),
        memory: Mutex::new(p.scope.memory_text.clone()),
        nonce: engine.nonce.clone(),
    });
    let (tx, rx) = mpsc::unbounded_channel();
    let handle = BriefHandle { tx, queued: Arc::new(AtomicUsize::new(0)), finished: Arc::new(AtomicBool::new(false)), shared: shared.clone() };
    tokio::spawn(run(p, swap, engine, scope_cell, shared, rx, handle.queued.clone(), handle.finished.clone()));
    Ok(handle)
}

#[allow(clippy::too_many_arguments)]
async fn run(
    p: BriefParams,
    swap: Arc<SwapLlm>,
    mut engine: BriefEngine<Arc<SwapLlm>, Arc<dyn Clock>, SearchFn>,
    scope_cell: Arc<Mutex<LiveScope>>,
    shared: Arc<BriefShared>,
    mut rx: mpsc::UnboundedReceiver<BriefCmd>,
    queued: Arc<AtomicUsize>,
    finished: Arc<AtomicBool>,
) {
    let mut last_state = Value::Null;
    let mut last_rev: Option<u64> = None;
    let mut stopped = false;
    let mut quitting = false;
    let mut interrupted = false;
    let mut last_scope_check = std::time::Instant::now();

    macro_rules! emit_state {
        () => {{
            let ev = status_event(&p.meeting_id, &engine.status(), stopped);
            if ev != last_state {
                p.emitter.emit("brief_state", ev.clone());
                last_state = ev;
            }
        }};
    }
    macro_rules! emit_sheet {
        () => {{
            let v = engine.view();
            if last_rev != Some(v.rev) {
                last_rev = Some(v.rev);
                let payload = json!({"meeting_id": p.meeting_id, "sheet": v.sheet.as_ref().map(|s| sheet_to_contract(s, p.clock.now_ms() as i64))});
                p.emitter.emit("brief_sheet", payload);
            }
        }};
    }
    // The scope of the meeting changed (or the brief is no longer wanted).
    macro_rules! refresh_scope {
        () => {{
            match p.db.scope(&p.meeting_id) {
                Some(s) if (p.still_enabled)(&s) => {
                    if s.fingerprint != scope_cell.lock().unwrap().fingerprint {
                        swap.cancel_and_renew();
                        engine.set_scope(&s.fingerprint, &s.memory_text);
                        *shared.scope_key.lock().unwrap() = s.fingerprint.clone();
                        *shared.memory.lock().unwrap() = s.memory_text.clone();
                        *scope_cell.lock().unwrap() = s;
                    } else {
                        *shared.memory.lock().unwrap() = s.memory_text.clone();
                    }
                }
                _ => {
                    swap.cancel();
                    stopped = true;
                    quitting = true;
                }
            }
            last_scope_check = std::time::Instant::now();
        }};
    }
    macro_rules! handle {
        ($cmd:expr) => {{
            match $cmd {
                BriefCmd::Line { ms, text } => {
                    queued.fetch_sub(1, Ordering::SeqCst);
                    engine.feed(BriefLine { start_ms: ms, end_ms: None, text });
                }
                BriefCmd::Refresh => engine.request_refresh(),
                BriefCmd::ScopeChanged => last_scope_check = std::time::Instant::now() - p.scope_check - Duration::from_secs(1),
                BriefCmd::Pause => engine.pause(),
                BriefCmd::Resume => engine.resume(),
                BriefCmd::KeepGoing => engine.keep_going(),
                BriefCmd::Stop => {
                    swap.cancel();
                    engine.stop();
                    stopped = true;
                    quitting = true;
                }
                BriefCmd::Finish => {
                    swap.cancel();
                    quitting = true;
                }
                BriefCmd::Quit => {
                    swap.cancel();
                    let st = engine.status();
                    let _ = p.db.save_brief(&p.meeting_id, engine.view().sheet.as_ref(), "interrupted", st.tokens_used, st.cap);
                    quitting = true;
                    interrupted = true;
                }
                BriefCmd::Get(reply) => {
                    let _ = reply.send(json!(engine.view().sheet.as_ref().map(|s| sheet_to_contract(s, p.clock.now_ms() as i64))));
                }
            }
        }};
    }

    emit_state!();
    let mut ticker = tokio::time::interval(p.tick);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    'main: loop {
        tokio::select! {
            cmd = rx.recv() => match cmd { Some(c) => handle!(c), None => break 'main },
            _ = ticker.tick() => {}
        }
        if quitting {
            break;
        }
        if last_scope_check.elapsed() >= p.scope_check {
            refresh_scope!();
            if quitting {
                break;
            }
        }
        engine.set_gate(!(p.busy)());
        let gen_before = (p.generation)(&shared.scope_key.lock().unwrap().clone());
        let (_tick, prepared) = engine.step();
        if let Some(prep) = prepared {
            let req = prep.request.clone();
            let fut = swap.call(&req);
            tokio::pin!(fut);
            let mut scope_poll = tokio::time::interval(p.scope_check.max(Duration::from_millis(5)));
            let result = loop {
                tokio::select! {
                    r = &mut fut => break r,
                    cmd = rx.recv() => match cmd {
                        Some(c) => handle!(c),
                        None => { swap.cancel(); quitting = true; }
                    },
                    _ = scope_poll.tick() => { refresh_scope!(); }
                }
            };
            // A scope change since the request was built: what comes back is about the old scope.
            let gen_after = (p.generation)(&shared.scope_key.lock().unwrap().clone());
            if gen_after != gen_before {
                refresh_scope!();
            }
            engine.complete(prep, result);
            if quitting {
                break;
            }
        }
        emit_state!();
        emit_sheet!();
    }
    if interrupted {
        let st = engine.status();
        let _ = p.db.save_brief(&p.meeting_id, engine.view().sheet.as_ref(), "interrupted", st.tokens_used, st.cap);
    }
    emit_state!();
    emit_sheet!();
    finished.store(true, Ordering::SeqCst);
    (p.on_exit)(&p.meeting_id);
}
