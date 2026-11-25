//! One meeting's live brief: an actor owning the brief engine. It searches
//! the meeting's scope locally, calls the model only when the trigger says so,
//! and throws away anything a scope change overtook (the sheet of a scope is
//! never shown under another).

use crate::ai_runs::AiPurpose;
use crate::live_brief::engine::{BriefConfig, BriefEngine, BriefLine, BriefSink, BriefSnapshot, BriefStatus, BriefStore};
use crate::live_brief::search::{LocalSearch, Passage};
use crate::live_brief::sheet::{Sheet, SheetHolder, SheetView};
use crate::live_common::{Clock, LlmCall};
use crate::live_runtime::db::{LiveDb, LiveScope};
use crate::live_runtime::llm::{LlmFactory, Selection, SwapLlm};
use crate::live_runtime::settings::BriefSettings;
use crate::live_runtime::state::{snapshot, RunSnapshot, StateInput};
use crate::live_runtime::Emitter;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

pub enum BriefCmd {
    Line { ms: u64, text: String },
    Refresh,
    /// The meeting's scope changed: resolve it again now.
    ScopeChanged,
    Pause,
    Resume,
    /// Forgive the failures and run again with the current settings.
    TryAgain,
    /// New model and cap for the next run.
    Reconfigure(BriefSettings),
    KeepGoing,
    Stop,
    Finish,
    Quit,
    /// The meeting is being deleted: stop and save nothing.
    Discard,
    Get(oneshot::Sender<Value>),
    State(oneshot::Sender<Value>),
}

/// What live answers and the scope-change path reach without asking the actor.
pub struct BriefShared {
    pub holder: Arc<Mutex<SheetHolder>>,
    /// Bumped by every invalidation; part of the holder's scope key.
    pub counter: AtomicU64,
    pub nonce: String,
    swap: Arc<SwapLlm>,
}

/// The key a sheet is held under: scope fingerprint, invalidation counter
/// and the AI run service's generation. Any difference hides the sheet.
pub fn scope_key(fingerprint: &str, counter: u64, generation: u64) -> String {
    format!("{fingerprint}#{counter}#{generation}")
}

impl BriefShared {
    /// Synchronous: the sheet is gone, the running call is cancelled and its
    /// answer will be dropped, before this returns.
    pub fn invalidate(&self) {
        let n = self.counter.fetch_add(1, Ordering::SeqCst) + 1;
        self.holder.lock().unwrap().set_scope(&format!("invalid#{n}"));
        self.swap.cancel_and_renew();
    }
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
    /// The AI run service's scope generation for (meeting, is_brief).
    pub generation: Arc<dyn Fn(&str, bool) -> u64 + Send + Sync>,
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
    scope: Arc<Mutex<LiveScope>>,
    discarded: Arc<AtomicBool>,
}
impl BriefStore for DbStore {
    fn save(&self, s: &BriefSnapshot) -> Result<(), String> {
        if self.discarded.load(Ordering::SeqCst) {
            return Ok(());
        }
        let fp = self.scope.lock().unwrap().fingerprint.clone();
        self.db.save_brief(&self.meeting_id, s.sheet.as_ref(), &s.status, s.tokens_used, s.cap, &fp)
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

pub fn spawn(p: BriefParams) -> Result<BriefHandle, String> {
    let selection = Selection { provider: p.settings.provider.clone(), model: p.settings.model.clone(), effort: p.settings.effort.clone() };
    let swap = SwapLlm::new(p.factory.clone(), AiPurpose::Brief, &p.meeting_id, selection)?;
    let scope_cell = Arc::new(Mutex::new(p.scope.clone()));
    let discarded = Arc::new(AtomicBool::new(false));
    let mut cfg = BriefConfig::default();
    cfg.trigger.cap_tokens = p.settings.cap;
    let search = SearchFn { db: p.db.clone(), scope: scope_cell.clone() };
    let store = Arc::new(DbStore { db: p.db.clone(), meeting_id: p.meeting_id.clone(), scope: scope_cell.clone(), discarded: discarded.clone() });
    let key0 = scope_key(&p.scope.fingerprint, 0, p.scope.generation);
    let mut engine = BriefEngine::new(swap.clone(), p.clock.clone(), search, &key0, cfg, Arc::new(Sink), store);
    engine.set_memory(&p.scope.memory_text);
    let shared = Arc::new(BriefShared { holder: engine.holder_handle(), counter: AtomicU64::new(0), nonce: engine.nonce.clone(), swap: swap.clone() });
    let (tx, rx) = mpsc::unbounded_channel();
    let handle = BriefHandle { tx, queued: Arc::new(AtomicUsize::new(0)), finished: Arc::new(AtomicBool::new(false)), shared: shared.clone() };
    tokio::spawn(run(p, swap, engine, scope_cell, shared, rx, handle.queued.clone(), handle.finished.clone(), discarded));
    Ok(handle)
}

#[allow(clippy::too_many_arguments)]
#[allow(unused_assignments)]
async fn run(
    p: BriefParams,
    swap: Arc<SwapLlm>,
    mut engine: BriefEngine<Arc<SwapLlm>, Arc<dyn Clock>, SearchFn>,
    scope_cell: Arc<Mutex<LiveScope>>,
    shared: Arc<BriefShared>,
    mut rx: mpsc::UnboundedReceiver<BriefCmd>,
    queued: Arc<AtomicUsize>,
    finished: Arc<AtomicBool>,
    discarded: Arc<AtomicBool>,
) {
    let mut last_snap: Option<RunSnapshot> = None;
    let mut stop_reason: Option<String> = None;
    let mut last_rev: Option<u64> = None;
    let mut stopped = false;
    let mut quitting = false;
    let mut interrupted = false;
    let mut last_scope_check = std::time::Instant::now();

    // the one state the UI shows (see `state`)
    macro_rules! build_snap {
        () => {{
            let st = engine.status();
            snapshot(&StateInput {
                meeting_id: p.meeting_id.clone(),
                state: st.state,
                in_flight: st.in_flight,
                tokens_used: st.tokens_used,
                total_tokens: engine.sent_tokens_total(),
                cap: st.cap,
                last_error: st.last_error.clone(),
                error_code: engine.last_code(),
                finished: false,
                user_stopped: stopped,
                manual_mode: false,
                started: st.tokens_used > 0 || engine.has_sheet(),
                uncovered: false,
                next_in_ms: None,
                final_note: None,
                stop_reason: stop_reason.clone(),
                model: swap.label(),
            })
        }};
    }
    macro_rules! emit_state {
        () => {{
            let snap = build_snap!();
            if last_snap.as_ref() != Some(&snap) {
                p.emitter.emit("brief_state", serde_json::to_value(&snap).unwrap_or(Value::Null));
                last_snap = Some(snap);
            }
        }};
    }
    macro_rules! emit_sheet {
        () => {{
            let v = engine.view();
            if last_rev != Some(v.rev) {
                last_rev = Some(v.rev);
                if !discarded.load(Ordering::SeqCst) {
                    let payload = json!({"meeting_id": p.meeting_id, "sheet": v.sheet.as_ref().map(|s| sheet_to_contract(s, p.clock.now_ms() as i64))});
                    p.emitter.emit("brief_sheet", payload);
                }
            }
        }};
    }
    // Resolve the scope again: adopt a new one (sheet cleared, call cancelled),
    // or, when the brief is not wanted in it, clear, save an empty sheet and stop.
    macro_rules! refresh_scope {
        () => {{
            let counter = shared.counter.load(Ordering::SeqCst);
            match p.db.scope_result(&p.meeting_id) {
                Ok(mut s) if (p.still_enabled)(&s) => {
                    s.generation = (p.generation)(&p.meeting_id, true);
                    let key = scope_key(&s.fingerprint, counter, s.generation);
                    if key != engine.scope() {
                        swap.cancel_and_renew();
                        engine.set_scope(&key, &s.memory_text);
                        *scope_cell.lock().unwrap() = s;
                    }
                }
                other => {
                    stop_reason = Some(match &other {
                        Err(e) => format!("The brief stopped: {e}"),
                        _ => "The brief is off in this workspace".to_string(),
                    });
                    shared.invalidate();
                    engine.set_scope(&format!("off#{}", shared.counter.load(Ordering::SeqCst)), "");
                    let fp = other.ok().map(|s| s.fingerprint).unwrap_or_default();
                    let st = engine.status();
                    let _ = p.db.save_brief(&p.meeting_id, None, "off", st.tokens_used, st.cap, &fp);
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
                BriefCmd::TryAgain => engine.retry(),
                BriefCmd::Reconfigure(s) => {
                    engine.set_cap(s.cap);
                    let sel = Selection { provider: s.provider.clone(), model: s.model.clone(), effort: s.effort.clone() };
                    if sel != swap.selection() {
                        if let Err(e) = swap.reselect(sel) {
                            log::warn!("live brief: the new model could not be set: {e}");
                        }
                    }
                }
                BriefCmd::State(reply) => {
                    let _ = reply.send(serde_json::to_value(build_snap!()).unwrap_or(Value::Null));
                }
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
                    let fp = scope_cell.lock().unwrap().fingerprint.clone();
                    let _ = p.db.save_brief(&p.meeting_id, engine.view().sheet.as_ref(), "interrupted", st.tokens_used, st.cap, &fp);
                    quitting = true;
                    interrupted = true;
                }
                BriefCmd::Discard => {
                    discarded.store(true, Ordering::SeqCst);
                    swap.cancel();
                    quitting = true;
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
        // What the request is built from is read first; if either changed when
        // the answer comes, the answer is dropped without being looked at.
        let counter0 = shared.counter.load(Ordering::SeqCst);
        let gen0 = (p.generation)(&p.meeting_id, true);
        swap.set_expected(Some(gen0));
        let (_tick, prepared) = engine.step();
        if let Some(prep) = prepared {
            // the workspace's switch is read again before every run: off (or a new scope) means this prompt is never sent
            let before = engine.scope();
            refresh_scope!();
            if quitting || engine.scope() != before {
                engine.abort(prep);
                if quitting {
                    break;
                }
                continue;
            }
            emit_state!();
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
            let overtaken = shared.counter.load(Ordering::SeqCst) != counter0
                || (p.generation)(&p.meeting_id, true) != gen0
                || discarded.load(Ordering::SeqCst);
            if overtaken {
                engine.abort(prep);
                if !discarded.load(Ordering::SeqCst) {
                    refresh_scope!();
                }
            } else {
                engine.complete(prep, result);
            }
            if quitting {
                break;
            }
        }
        emit_state!();
        emit_sheet!();
    }
    if interrupted {
        let st = engine.status();
        let fp = scope_cell.lock().unwrap().fingerprint.clone();
        let _ = p.db.save_brief(&p.meeting_id, engine.view().sheet.as_ref(), "interrupted", st.tokens_used, st.cap, &fp);
    }
    emit_state!();
    emit_sheet!();
    finished.store(true, Ordering::SeqCst);
    (p.on_exit)(&p.meeting_id);
}
