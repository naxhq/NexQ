//! One meeting's live notes: an actor that owns the engine. Lines reach it
//! through an unbounded channel (the transcript path never blocks and never
//! loses a line), and it keeps taking them while a model call is in flight.

use crate::ai_runs::AiPurpose;
use crate::live_common::{Clock, LlmCall};
use crate::live_notes::db::StoredNotes;
use crate::live_notes::doc::{BlockKind, NoteDoc};
use crate::live_notes::engine::{NotesConfig, NotesEngine, NotesSink, NotesSnapshot, NotesStatus, NotesStore, TranscriptLine};
use crate::live_notes::prompts::{Detail, NotesPromptOptions, OutputLanguage};
use crate::live_notes::reducer::ReduceReport;
use crate::live_notes::trigger::{Decision, RunReason};
use crate::live_runtime::db::LiveDb;
use crate::live_runtime::llm::{LlmFactory, Selection, SwapLlm};
use crate::live_runtime::settings::NotetakerSettings;
use crate::live_runtime::state::{snapshot, RunSnapshot, StateInput};
use crate::live_runtime::Emitter;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot};

/// A user edit of the saved notes, as the webview sends it.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum NoteEdit {
    Update { id: String, text: Option<String>, r#type: Option<String>, pinned: Option<bool> },
    Add { id: String, r#type: String, parent: Option<String>, text: String, after: Option<String> },
    Delete { id: String },
}

pub enum NotesCmd {
    Line(TranscriptLine),
    Manual,
    Pause,
    Resume,
    /// Forgive the failures and run again with the current settings.
    TryAgain,
    KeepGoing,
    /// The user stopped the notes (the meeting goes on).
    Stop,
    /// The meeting ended: final pass (bounded), then done.
    Finish,
    /// The app is closing: save and go.
    Quit,
    /// The meeting is being deleted: stop and save nothing.
    Discard,
    /// New settings (model, cap, detail, language, mode) for the next run.
    Reconfigure(NotetakerSettings),
    Edit(NoteEdit, oneshot::Sender<Result<Value, String>>),
    Get(oneshot::Sender<Value>),
    State(oneshot::Sender<Value>),
}

pub struct NotesHandle {
    pub tx: mpsc::UnboundedSender<NotesCmd>,
    /// Lines sent and not yet taken by the actor (a backpressure counter).
    pub queued: Arc<AtomicUsize>,
    pub max_queued: Arc<AtomicUsize>,
    pub finished: Arc<AtomicBool>,
    pub dropped_lines: Arc<AtomicU64>,
    pub sent_tokens: Arc<AtomicU64>,
    /// Words the actor holds that no run has covered yet ("Update now" says "nothing new" without it).
    pub has_new: Arc<AtomicBool>,
}

pub struct NotesParams {
    pub meeting_id: String,
    pub settings: NotetakerSettings,
    pub resume: Option<StoredNotes>,
    pub db: LiveDb,
    pub emitter: Arc<dyn Emitter>,
    pub factory: Arc<dyn LlmFactory>,
    pub clock: Arc<dyn Clock>,
    /// True while a live answer is generating.
    pub busy: Arc<dyn Fn() -> bool + Send + Sync>,
    /// The AI run service's scope generation for (meeting, is_brief).
    pub generation: Arc<dyn Fn(&str, bool) -> u64 + Send + Sync>,
    /// Called once when the actor ends (the registry forgets it, sessions close).
    pub on_exit: Arc<dyn Fn(&str) + Send + Sync>,
    pub tick: Duration,
    pub final_timeout: Duration,
    /// An update of an ENDED meeting: these saved lines (the uncovered part) are sent in one
    /// run, then the notes are finished again. Empty for a live meeting.
    pub preload: Vec<TranscriptLine>,
    pub one_shot: bool,
}

// ---------------------------------------------------------------- contract shapes

pub fn doc_to_contract(doc: &NoteDoc) -> Value {
    let mut blocks: Vec<&crate::live_notes::doc::Block> = doc.blocks.iter().collect();
    blocks.sort_by_key(|b| b.order);
    json!({
        "version": doc.version,
        "blocks": blocks.iter().map(|b| json!({
            "id": b.id, "type": b.kind.as_str(), "parent": b.parent, "text": b.text,
            "t": b.start_ms, "edited": b.edited, "pinned": b.pinned,
        })).collect::<Vec<_>>(),
    })
}

/// Applies a user edit to a document. Returns false when nothing matched.
pub fn apply_edit(doc: &mut NoteDoc, edit: &NoteEdit) -> Result<(), String> {
    match edit {
        NoteEdit::Update { id, text, r#type, pinned } => {
            if doc.get(id).is_none() {
                return Err(format!("There is no note {id}"));
            }
            if let Some(t) = text {
                if !doc.user_edit(id, t) {
                    return Err("The text is empty".into());
                }
            }
            if let Some(k) = r#type {
                let kind = BlockKind::from_loose(k).ok_or_else(|| format!("Unknown type: {k}"))?;
                if let Some(b) = doc.get_mut(id) {
                    b.kind = kind;
                    b.edited = true;
                    if kind == BlockKind::Topic {
                        b.parent = None;
                    }
                }
            }
            if let Some(p) = pinned {
                doc.user_pin(id, *p);
            }
            Ok(())
        }
        NoteEdit::Add { id, r#type, parent, text, after } => {
            let kind = BlockKind::from_loose(r#type).ok_or_else(|| format!("Unknown type: {}", r#type))?;
            let newid = doc.user_add_with_id(Some(id), kind, parent.as_deref(), text, after.as_deref(), 0);
            newid.map(|_| ()).ok_or_else(|| "The text is empty".to_string())
        }
        NoteEdit::Delete { id } => {
            if doc.user_delete(id) {
                Ok(())
            } else {
                Err(format!("There is no note {id}"))
            }
        }
    }
}

// ---------------------------------------------------------------- the actor

struct ActorSink {
    dirty: Arc<AtomicBool>,
}

impl NotesSink for ActorSink {
    fn status(&self, _: &NotesStatus) {}
    fn doc(&self, _: &NoteDoc, _: &ReduceReport) {
        self.dirty.store(true, Ordering::SeqCst);
    }
    fn cap_reached(&self) {}
}

struct DbStore {
    db: LiveDb,
    meeting_id: String,
    discarded: Arc<AtomicBool>,
}

impl NotesStore for DbStore {
    fn save(&self, s: &NotesSnapshot) -> Result<(), String> {
        if self.discarded.load(Ordering::SeqCst) {
            return Ok(());
        }
        self.db.save_notes(&self.meeting_id, &s.doc, &s.status, s.tokens_used, s.cap)
    }
}

fn prompt_of(s: &NotetakerSettings) -> NotesPromptOptions {
    NotesPromptOptions {
        detail: match s.detail.as_str() {
            "brief" => Detail::Brief,
            "detailed" => Detail::Detailed,
            _ => Detail::Standard,
        },
        language: if s.language == "meeting" { OutputLanguage::Meeting } else { OutputLanguage::Fixed(s.language.clone()) },
        small_model: false,
    }
}

pub fn selection_of(s: &NotetakerSettings) -> Selection {
    Selection { provider: s.provider.clone(), model: s.model.clone(), effort: s.effort.clone() }
}

fn cfg_from(s: &NotetakerSettings) -> NotesConfig {
    let mut cfg = NotesConfig::default();
    cfg.trigger.cap_tokens = s.cap;
    cfg.prompt = prompt_of(s);
    cfg
}

pub fn spawn(p: NotesParams) -> Result<NotesHandle, String> {
    let swap = SwapLlm::new(p.factory.clone(), AiPurpose::Notes, &p.meeting_id, selection_of(&p.settings))?;
    let (tx, rx) = mpsc::unbounded_channel();
    let handle = NotesHandle {
        tx,
        queued: Arc::new(AtomicUsize::new(0)),
        max_queued: Arc::new(AtomicUsize::new(0)),
        finished: Arc::new(AtomicBool::new(false)),
        dropped_lines: Arc::new(AtomicU64::new(0)),
        sent_tokens: Arc::new(AtomicU64::new(0)),
        has_new: Arc::new(AtomicBool::new(false)),
    };
    let actor = Actor::new(p, swap, &handle);
    tokio::spawn(actor.run(rx));
    Ok(handle)
}

struct Actor {
    p: NotesParams,
    swap: Arc<SwapLlm>,
    engine: NotesEngine<Arc<SwapLlm>, Arc<dyn Clock>>,
    settings: NotetakerSettings,
    queued: Arc<AtomicUsize>,
    finished_flag: Arc<AtomicBool>,
    dropped: Arc<AtomicU64>,
    sent: Arc<AtomicU64>,
    has_new: Arc<AtomicBool>,
    dirty: Arc<AtomicBool>,
    discarded: Arc<AtomicBool>,
    last: Option<RunSnapshot>,
    last_deadline: Option<u64>,
    last_doc_emit: Instant,
    done: bool,
    finishing: bool,
    /// Manual mode, meeting over: waits for one "Update now" for what was never sent.
    ended_waiting: bool,
    user_stopped: bool,
    quitting: bool,
    interrupted: bool,
    /// The update of an ended meeting: one run on the saved lines, then done.
    one_shot: bool,
    ran: bool,
    /// Set when the meeting ended while a run was in flight: that run gets `final_timeout`, not forever.
    finish_deadline: Option<tokio::time::Instant>,
}

impl Actor {
    fn new(mut p: NotesParams, swap: Arc<SwapLlm>, handle: &NotesHandle) -> Self {
        let dirty = Arc::new(AtomicBool::new(false));
        let discarded = Arc::new(AtomicBool::new(false));
        let sink = Arc::new(ActorSink { dirty: dirty.clone() });
        let store = Arc::new(DbStore { db: p.db.clone(), meeting_id: p.meeting_id.clone(), discarded: discarded.clone() });
        let mut cfg = cfg_from(&p.settings);
        cfg.final_timeout = p.final_timeout;
        let mut engine = NotesEngine::new(swap.clone(), p.clock.clone(), cfg, sink, store);
        if let Some(r) = p.resume.take() {
            engine.resume_from(r.doc, r.tokens_used, r.cap);
        }
        let one_shot = p.one_shot;
        if one_shot {
            // the range is taken up again by this run; what it leaves is marked again at the end
            engine.doc_mut().uncovered = None;
            for l in std::mem::take(&mut p.preload) {
                engine.feed(l);
            }
            engine.request_manual();
        }
        let settings = p.settings.clone();
        Self {
            p,
            swap,
            engine,
            settings,
            queued: handle.queued.clone(),
            finished_flag: handle.finished.clone(),
            dropped: handle.dropped_lines.clone(),
            sent: handle.sent_tokens.clone(),
            has_new: handle.has_new.clone(),
            dirty,
            discarded,
            last: None,
            last_deadline: None,
            last_doc_emit: Instant::now() - Duration::from_secs(5),
            done: false,
            finishing: false,
            ended_waiting: false,
            user_stopped: false,
            quitting: false,
            interrupted: false,
            one_shot,
            ran: false,
            finish_deadline: None,
        }
    }

    fn auto(&self) -> bool {
        self.settings.update_mode == "automatic"
    }

    /// The one state the UI shows (see `state`).
    fn snapshot(&self) -> RunSnapshot {
        let st = self.engine.status();
        snapshot(&StateInput {
            meeting_id: self.p.meeting_id.clone(),
            state: st.state,
            in_flight: st.in_flight,
            tokens_used: st.tokens_used,
            total_tokens: self.engine.sent_tokens_total,
            cap: st.cap,
            last_error: st.last_error.clone(),
            error_code: self.engine.last_code(),
            finished: self.done || self.ended_waiting,
            user_stopped: self.user_stopped,
            manual_mode: !self.auto(),
            started: st.tokens_used > 0 || st.pending_words > 0,
            not_covered: if self.done || self.ended_waiting { self.engine.uncovered() } else { None },
            next_in_ms: if self.auto() { self.engine.next_run_in_ms() } else { None },
            final_note: self.engine.final_note.clone(),
            stop_reason: None,
            model: self.swap.label(),
        })
    }

    /// Emits the state when it changed. `next_in_ms` is a deadline the UI counts
    /// down, so it only counts as a change when the deadline moved by seconds.
    fn emit_state(&mut self) {
        let snap = self.snapshot();
        let deadline = snap.next_in_ms.map(|n| self.p.clock.now_ms() + n);
        let mut same = self.last.clone();
        if let Some(l) = same.as_mut() {
            l.next_in_ms = snap.next_in_ms;
        }
        let deadline_moved = match (self.last_deadline, deadline) {
            (Some(a), Some(b)) => a.abs_diff(b) > 1_500,
            (None, None) => false,
            _ => true,
        };
        if same.as_ref() != Some(&snap) || deadline_moved {
            self.p.emitter.emit("notetaker_state", serde_json::to_value(&snap).unwrap_or(Value::Null));
            self.last = Some(snap);
            self.last_deadline = deadline;
        }
        self.dropped.store(self.engine.dropped_lines, Ordering::SeqCst);
        self.has_new.store(self.engine.has_pending(), Ordering::SeqCst);
        self.sent.store(self.engine.sent_tokens_total, Ordering::SeqCst);
    }

    fn flush_doc(&mut self, force: bool) {
        if self.dirty.load(Ordering::SeqCst) && (force || self.last_doc_emit.elapsed() >= Duration::from_millis(250)) {
            self.dirty.store(false, Ordering::SeqCst);
            self.last_doc_emit = Instant::now();
            self.p.emitter.emit(
                "notetaker_doc",
                json!({"meeting_id": self.p.meeting_id, "version": self.engine.doc().version, "doc": doc_to_contract(self.engine.doc())}),
            );
        }
    }

    /// New settings for the next run (a run in flight finishes as it was).
    fn reconfigure(&mut self, s: NotetakerSettings) {
        self.engine.set_prompt(prompt_of(&s));
        self.engine.set_cap(s.cap);
        if selection_of(&s) != selection_of(&self.settings) {
            if let Err(e) = self.swap.reselect(selection_of(&s)) {
                log::warn!("live notes: the new model could not be set: {e}");
            }
        }
        self.settings = s;
    }

    fn handle(&mut self, cmd: NotesCmd) {
        match cmd {
            NotesCmd::Line(l) => {
                self.queued.fetch_sub(1, Ordering::SeqCst);
                self.engine.feed(l);
            }
            NotesCmd::Manual => self.engine.request_manual(),
            NotesCmd::Pause => self.engine.pause(),
            NotesCmd::Resume => self.engine.resume(),
            NotesCmd::TryAgain => self.engine.retry(),
            NotesCmd::KeepGoing => self.engine.keep_going(),
            NotesCmd::Stop => {
                self.user_stopped = true;
                self.swap.cancel();
                self.engine.stop();
                self.quitting = true;
            }
            NotesCmd::Finish => {
                if self.auto() {
                    self.finishing = true;
                    self.finish_deadline = Some(tokio::time::Instant::now() + self.p.final_timeout);
                } else {
                    // manual: nothing runs unasked; what was never sent stays one "Update now" away
                    self.ended_waiting = true;
                    let range = self.engine.pending_range().map(|(a, b)| format!(" Not covered: {} to {}", crate::live_common::fmt_clock(a), crate::live_common::fmt_clock(b))).unwrap_or_default();
                    self.engine.final_note = Some(format!("Notes were on manual.{range}"));
                }
            }
            NotesCmd::Discard => {
                self.discarded.store(true, Ordering::SeqCst);
                self.swap.cancel();
                self.quitting = true;
            }
            NotesCmd::Quit => {
                self.swap.cancel();
                if !self.ended_waiting {
                    // what was never sent stays known: the range is saved with the notes
                    self.engine.mark_uncovered();
                    let st = self.engine.status();
                    let _ = self.p.db.save_notes(&self.p.meeting_id, self.engine.doc(), "interrupted", st.tokens_used, st.cap);
                    self.interrupted = true;
                }
                self.quitting = true;
            }
            NotesCmd::Reconfigure(s) => self.reconfigure(s),
            NotesCmd::Edit(edit, reply) => {
                let res = apply_edit(self.engine.doc_mut(), &edit).map(|_| {
                    self.engine.save_now();
                    self.dirty.store(true, Ordering::SeqCst);
                    doc_to_contract(self.engine.doc())
                });
                let _ = reply.send(res);
            }
            NotesCmd::Get(reply) => {
                let _ = reply.send(doc_to_contract(self.engine.doc()));
            }
            NotesCmd::State(reply) => {
                let _ = reply.send(serde_json::to_value(self.snapshot()).unwrap_or(Value::Null));
            }
        }
    }

    /// One run when the trigger says so, taking commands while the call is in flight.
    async fn maybe_run(&mut self, rx: &mut mpsc::UnboundedReceiver<NotesCmd>) {
        let Decision::Run(reason) = self.engine.poll() else { return };
        let allowed = self.auto() || matches!(reason, RunReason::Manual | RunReason::Final);
        if !allowed {
            return;
        }
        let gen0 = (self.p.generation)(&self.p.meeting_id, false);
        self.swap.set_expected(Some(gen0));
        self.ran = true;
        let Some(prep) = self.engine.prepare(reason) else {
            // the trigger believed there were words but the engine holds none: forget the request so it cannot stick
            self.engine.resync();
            return;
        };
        // "running" is shown while the call is in flight
        self.emit_state();
        let req = prep.request.clone();
        let swap = self.swap.clone();
        let fut = swap.call(&req);
        tokio::pin!(fut);
        let mut timed_out = false;
        let result = loop {
            // a run still going when the meeting ended is given `final_timeout` and then cancelled:
            // its lines go back and the end says which minutes are not covered
            let deadline = if timed_out { None } else { self.finish_deadline };
            tokio::select! {
                r = &mut fut => break r,
                cmd = rx.recv() => match cmd {
                    Some(c) => self.handle(c),
                    None => { self.swap.cancel(); self.quitting = true; }
                },
                _ = async move {
                    match deadline {
                        Some(d) => tokio::time::sleep_until(d).await,
                        None => std::future::pending::<()>().await,
                    }
                } => {
                    timed_out = true;
                    self.swap.cancel();
                }
            }
        };
        if self.discarded.load(Ordering::SeqCst) || (self.p.generation)(&self.p.meeting_id, false) != gen0 {
            // the scope generation moved or the meeting is going: nothing is applied, the lines go back
            self.engine.abort(prep);
        } else {
            self.engine.complete(prep, result);
        }
    }

    fn swap_in_flight(&self) -> bool {
        self.engine.status().in_flight
    }

    /// The update of an ended meeting is done (or failed): finish the notes again and say what is left.
    async fn finish_one_shot(&mut self) {
        let err = self.engine.status().last_error.clone();
        let _ = self.engine.finish_with(false).await;
        if let Some((from, to)) = self.engine.doc().uncovered {
            let why = err.map(|e| format!("The update did not finish: {e}. ")).unwrap_or_default();
            self.engine.final_note = Some(format!("{why}Not covered: {} to {}", crate::live_common::fmt_clock(from), crate::live_common::fmt_clock(to)));
        } else {
            self.engine.final_note = None;
        }
        self.done = true;
    }

    async fn run(mut self, mut rx: mpsc::UnboundedReceiver<NotesCmd>) {
        self.emit_state();
        let mut ticker = tokio::time::interval(self.p.tick);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        'main: loop {
            tokio::select! {
                cmd = rx.recv() => match cmd {
                    Some(c) => self.handle(c),
                    None => break 'main,
                },
                _ = ticker.tick() => {}
            }
            if self.quitting {
                break;
            }
            if self.finishing {
                let _ = self.engine.finish().await;
                self.done = true;
                break;
            }
            self.engine.set_gate(!(self.p.busy)());
            self.maybe_run(&mut rx).await;
            if self.quitting {
                break;
            }
            if self.one_shot && self.ran && !self.swap_in_flight() {
                self.finish_one_shot().await;
                break;
            }
            if self.ended_waiting && !self.engine.has_pending() {
                // the one update after the meeting covered everything
                self.engine.final_note = None;
                let _ = self.engine.finish_with(false).await;
                self.done = true;
                break;
            }
            self.emit_state();
            self.flush_doc(false);
        }
        if self.discarded.load(Ordering::SeqCst) {
            self.finished_flag.store(true, Ordering::SeqCst);
            (self.p.on_exit)(&self.p.meeting_id);
            return;
        }
        if self.interrupted {
            // a run that was in flight finished after the quit saved: save as interrupted once more
            let st = self.engine.status();
            let _ = self.p.db.save_notes(&self.p.meeting_id, self.engine.doc(), "interrupted", st.tokens_used, st.cap);
        }
        if self.ended_waiting && !self.done {
            let _ = self.engine.finish_with(false).await;
            self.done = true;
        }
        self.emit_state();
        self.flush_doc(true);
        self.finished_flag.store(true, Ordering::SeqCst);
        (self.p.on_exit)(&self.p.meeting_id);
    }
}
