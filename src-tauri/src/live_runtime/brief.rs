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
    /// The person saw the "moved online" line.
    DismissMoved,
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
    /// Why the last search failed (cleared by the next one that worked): shown as the brief's reason.
    error: Arc<Mutex<Option<String>>>,
}
impl LocalSearch for SearchFn {
    fn search(&self, query: &str, _limit_tokens: u32, max: usize) -> Vec<Passage> {
        let scope = self.scope.lock().unwrap().clone();
        match self.db.search_checked(&scope, query, max) {
            Ok(found) => {
                *self.error.lock().unwrap() = None;
                found
            }
            Err(e) => {
                *self.error.lock().unwrap() = Some(e);
                Vec::new()
            }
        }
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

/// How often the meeting's notes are read again for the brief.
const NOTES_REFRESH: Duration = Duration::from_secs(5);
/// Most tokens of the notes outline a brief prompt carries.
const BRIEF_NOTES_TOKENS: u32 = 500;

pub fn spawn(p: BriefParams) -> Result<BriefHandle, String> {
    let selection = Selection { provider: p.settings.provider.clone(), model: p.settings.model.clone(), effort: p.settings.effort.clone() };
    let swap = SwapLlm::new(p.factory.clone(), AiPurpose::Brief, &p.meeting_id, selection)?;
    let scope_cell = Arc::new(Mutex::new(p.scope.clone()));
    let discarded = Arc::new(AtomicBool::new(false));
    let search_error = Arc::new(Mutex::new(None));
    let mut cfg = BriefConfig::default();
    cfg.trigger.cap_tokens = p.settings.cap;
    let search = SearchFn { db: p.db.clone(), scope: scope_cell.clone(), error: search_error.clone() };
    let store = Arc::new(DbStore { db: p.db.clone(), meeting_id: p.meeting_id.clone(), scope: scope_cell.clone(), discarded: discarded.clone() });
    let key0 = scope_key(&p.scope.fingerprint, 0, p.scope.generation);
    let mut engine = BriefEngine::new(swap.clone(), p.clock.clone(), search, &key0, cfg, Arc::new(Sink), store);
    engine.set_memory(&p.scope.memory_text);
    let shared = Arc::new(BriefShared { holder: engine.holder_handle(), counter: AtomicU64::new(0), nonce: engine.nonce.clone(), swap: swap.clone() });
    let (tx, rx) = mpsc::unbounded_channel();
    let handle = BriefHandle { tx, queued: Arc::new(AtomicUsize::new(0)), finished: Arc::new(AtomicBool::new(false)), shared: shared.clone() };
    let actor = Actor {
        queued: handle.queued.clone(),
        finished: handle.finished.clone(),
        p,
        swap,
        engine,
        scope_cell,
        shared,
        discarded,
        search_error,
        last_snap: None,
        stop_reason: None,
        last_rev: None,
        stopped: false,
        quitting: false,
        interrupted: false,
        last_scope_check: std::time::Instant::now(),
        notes_text: String::new(),
        notes_read: None,
    };
    tokio::spawn(actor.run(rx));
    Ok(handle)
}

type Engine = BriefEngine<Arc<SwapLlm>, Arc<dyn Clock>, SearchFn>;

/// The brief's actor: owns the engine and every flag the loop needs.
struct Actor {
    p: BriefParams,
    swap: Arc<SwapLlm>,
    engine: Engine,
    scope_cell: Arc<Mutex<LiveScope>>,
    shared: Arc<BriefShared>,
    queued: Arc<AtomicUsize>,
    finished: Arc<AtomicBool>,
    discarded: Arc<AtomicBool>,
    search_error: Arc<Mutex<Option<String>>>,
    last_snap: Option<RunSnapshot>,
    stop_reason: Option<String>,
    last_rev: Option<u64>,
    stopped: bool,
    quitting: bool,
    interrupted: bool,
    last_scope_check: std::time::Instant,
    /// The meeting's live notes as an outline, read at most every few seconds.
    notes_text: String,
    notes_read: Option<std::time::Instant>,
}

impl Actor {
    /// The one state the UI shows (see `state`). A failing search is the reason while nothing else is.
    fn snapshot(&self) -> RunSnapshot {
        let st = self.engine.status();
        let search_error = self.search_error.lock().unwrap().clone().map(|e| format!("The brief could not search your workspace: {e}"));
        snapshot(&StateInput {
            meeting_id: self.p.meeting_id.clone(),
            state: st.state,
            in_flight: st.in_flight,
            tokens_used: st.tokens_used,
            total_tokens: self.engine.sent_tokens_total(),
            cap: st.cap,
            last_error: st.last_error.clone().or(search_error),
            error_code: self.engine.last_code(),
            finished: false,
            user_stopped: self.stopped,
            manual_mode: false,
            started: st.tokens_used > 0 || self.engine.has_sheet(),
            not_covered: None,
            ended: None,
            moved_online: self.swap.moved_online().map(|(from, to)| crate::live_runtime::state::MovedOnline { from, to }),
            next_in_ms: None,
            final_note: None,
            stop_reason: self.stop_reason.clone(),
            model: self.swap.label(),
        })
    }

    fn emit_state(&mut self) {
        let snap = self.snapshot();
        if self.last_snap.as_ref() != Some(&snap) {
            self.p.emitter.emit("brief_state", serde_json::to_value(&snap).unwrap_or(Value::Null));
            self.last_snap = Some(snap);
        }
    }

    fn emit_sheet(&mut self) {
        let v = self.engine.view();
        if self.last_rev != Some(v.rev) {
            self.last_rev = Some(v.rev);
            if !self.discarded.load(Ordering::SeqCst) {
                let payload = json!({"meeting_id": self.p.meeting_id, "sheet": v.sheet.as_ref().map(|s| sheet_to_contract(s, self.p.clock.now_ms() as i64))});
                self.p.emitter.emit("brief_sheet", payload);
            }
        }
    }

    /// Resolve the scope again: adopt a new one (sheet cleared, call cancelled),
    /// or, when the brief is not wanted in it, clear, save an empty sheet and stop.
    fn refresh_scope(&mut self) {
        let counter = self.shared.counter.load(Ordering::SeqCst);
        match self.p.db.scope_result(&self.p.meeting_id) {
            Ok(mut s) if (self.p.still_enabled)(&s) => {
                s.generation = (self.p.generation)(&self.p.meeting_id, true);
                let key = scope_key(&s.fingerprint, counter, s.generation);
                if key != self.engine.scope() {
                    self.swap.cancel_and_renew();
                    self.engine.set_scope(&key, &s.memory_text);
                }
                // the instructions can change without the scope (they are an edit, not access)
                *self.scope_cell.lock().unwrap() = s;
            }
            other => {
                self.stop_reason = Some(match &other {
                    Err(e) => format!("The brief stopped: {e}"),
                    _ => "The brief is off in this workspace".to_string(),
                });
                self.shared.invalidate();
                self.engine.set_scope(&format!("off#{}", self.shared.counter.load(Ordering::SeqCst)), "");
                let fp = other.ok().map(|s| s.fingerprint).unwrap_or_default();
                let st = self.engine.status();
                let _ = self.p.db.save_brief(&self.p.meeting_id, None, "off", st.tokens_used, st.cap, &fp);
                self.stopped = true;
                self.quitting = true;
            }
        }
        self.last_scope_check = std::time::Instant::now();
    }

    /// The workspace's instructions and the meeting's live notes, as the next
    /// prompt carries them (data, fenced like the rest). The notes are read at
    /// most every few seconds.
    fn refresh_context(&mut self) {
        if self.notes_read.map_or(true, |t| t.elapsed() >= NOTES_REFRESH) {
            self.notes_text = self
                .p
                .db
                .load_notes(&self.p.meeting_id)
                .map(|n| n.doc.outline(BRIEF_NOTES_TOKENS))
                .unwrap_or_default();
            self.notes_read = Some(std::time::Instant::now());
        }
        let instructions = self.scope_cell.lock().unwrap().instructions.clone();
        self.engine.set_context(&instructions, &self.notes_text);
    }

    fn handle(&mut self, cmd: BriefCmd) {
        match cmd {
            BriefCmd::Line { ms, text } => {
                self.queued.fetch_sub(1, Ordering::SeqCst);
                self.engine.feed(BriefLine { start_ms: ms, end_ms: None, text });
            }
            BriefCmd::Refresh => self.engine.request_refresh(),
            BriefCmd::ScopeChanged => self.last_scope_check = std::time::Instant::now() - self.p.scope_check - Duration::from_secs(1),
            BriefCmd::Pause => self.engine.pause(),
            BriefCmd::Resume => self.engine.resume(),
            BriefCmd::TryAgain => self.engine.retry(),
            BriefCmd::DismissMoved => self.swap.dismiss_moved(),
            BriefCmd::Reconfigure(s) => {
                // a changed limit only: the same one again would reset Keep going's fresh allotment
                if s.cap != self.p.settings.cap {
                    self.engine.set_cap(s.cap);
                }
                self.p.settings = s.clone();
                let sel = Selection { provider: s.provider.clone(), model: s.model.clone(), effort: s.effort.clone() };
                if sel != self.swap.selection() {
                    if let Err(e) = self.swap.reselect(sel) {
                        log::warn!("live brief: the new model could not be set: {e}");
                    }
                }
            }
            BriefCmd::State(reply) => {
                let _ = reply.send(serde_json::to_value(self.snapshot()).unwrap_or(Value::Null));
            }
            BriefCmd::KeepGoing => self.engine.keep_going(),
            BriefCmd::Stop => {
                self.swap.cancel();
                self.engine.stop();
                self.stopped = true;
                self.quitting = true;
            }
            BriefCmd::Finish => {
                self.swap.cancel();
                self.quitting = true;
            }
            BriefCmd::Quit => {
                self.swap.cancel();
                self.save_interrupted();
                self.quitting = true;
                self.interrupted = true;
            }
            BriefCmd::Discard => {
                self.discarded.store(true, Ordering::SeqCst);
                self.swap.cancel();
                self.quitting = true;
            }
            BriefCmd::Get(reply) => {
                let _ = reply.send(json!(self.engine.view().sheet.as_ref().map(|s| sheet_to_contract(s, self.p.clock.now_ms() as i64))));
            }
        }
    }

    fn save_interrupted(&self) {
        let st = self.engine.status();
        let fp = self.scope_cell.lock().unwrap().fingerprint.clone();
        let _ = self.p.db.save_brief(&self.p.meeting_id, self.engine.view().sheet.as_ref(), "interrupted", st.tokens_used, st.cap, &fp);
    }

    /// One run when the trigger says so, taking commands while the call is in flight.
    /// Returns false when the actor must end.
    async fn maybe_run(&mut self, rx: &mut mpsc::UnboundedReceiver<BriefCmd>) -> bool {
        // What the request is built from is read first; if either changed when
        // the answer comes, the answer is dropped without being looked at.
        let counter0 = self.shared.counter.load(Ordering::SeqCst);
        let gen0 = (self.p.generation)(&self.p.meeting_id, true);
        self.swap.set_expected(Some(gen0));
        self.refresh_context();
        let (_tick, prepared) = self.engine.step();
        let Some(prep) = prepared else { return true };
        // the workspace's switch is read again before every run: off (or a new scope) means this prompt is never sent
        let before = self.engine.scope();
        self.refresh_scope();
        if self.quitting || self.engine.scope() != before {
            self.engine.abort(prep);
            return !self.quitting;
        }
        self.emit_state();
        let req = prep.request.clone();
        let swap = self.swap.clone();
        let fut = swap.call(&req);
        tokio::pin!(fut);
        let mut scope_poll = tokio::time::interval(self.p.scope_check.max(Duration::from_millis(5)));
        let result = loop {
            tokio::select! {
                r = &mut fut => break r,
                cmd = rx.recv() => match cmd {
                    Some(c) => self.handle(c),
                    None => { self.swap.cancel(); self.quitting = true; }
                },
                _ = scope_poll.tick() => { self.refresh_scope(); }
            }
        };
        let overtaken = self.shared.counter.load(Ordering::SeqCst) != counter0
            || (self.p.generation)(&self.p.meeting_id, true) != gen0
            || self.discarded.load(Ordering::SeqCst);
        if overtaken {
            self.engine.abort(prep);
            if !self.discarded.load(Ordering::SeqCst) {
                self.refresh_scope();
            }
        } else {
            self.engine.complete(prep, result);
        }
        !self.quitting
    }

    async fn run(mut self, mut rx: mpsc::UnboundedReceiver<BriefCmd>) {
        self.emit_state();
        let mut ticker = tokio::time::interval(self.p.tick);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                cmd = rx.recv() => match cmd { Some(c) => self.handle(c), None => break },
                _ = ticker.tick() => {}
            }
            if self.quitting {
                break;
            }
            if self.last_scope_check.elapsed() >= self.p.scope_check {
                self.refresh_scope();
                if self.quitting {
                    break;
                }
            }
            self.engine.set_gate(!(self.p.busy)());
            if !self.maybe_run(&mut rx).await {
                break;
            }
            self.emit_state();
            self.emit_sheet();
        }
        if self.interrupted {
            self.save_interrupted();
        }
        self.emit_state();
        self.emit_sheet();
        self.finished.store(true, Ordering::SeqCst);
        (self.p.on_exit)(&self.p.meeting_id);
    }
}
