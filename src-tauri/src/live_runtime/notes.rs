//! One meeting's live notes: an actor that owns the engine. Lines reach it
//! through an unbounded channel (the transcript path never blocks and never
//! loses a line), and it keeps taking them while a model call is in flight.

use crate::ai_runs::AiPurpose;
use crate::live_common::{Clock, LlmCall, RunState};
use crate::live_notes::db::StoredNotes;
use crate::live_notes::doc::{BlockKind, NoteDoc};
use crate::live_notes::engine::{NotesConfig, NotesEngine, NotesSink, NotesSnapshot, NotesStatus, NotesStore, TranscriptLine};
use crate::live_notes::prompts::{Detail, NotesPromptOptions, OutputLanguage};
use crate::live_notes::reducer::ReduceReport;
use crate::live_notes::trigger::{Decision, RunReason};
use crate::live_runtime::db::LiveDb;
use crate::live_runtime::llm::{LlmFactory, Selection, SwapLlm};
use crate::live_runtime::settings::NotetakerSettings;
use crate::live_runtime::Emitter;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
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
    KeepGoing,
    /// The user stopped the notes (the meeting goes on).
    Stop,
    /// The meeting ended: final pass (bounded), then done.
    Finish,
    /// The app is closing: save and go.
    Quit,
    /// The meeting is being deleted: stop and save nothing.
    Discard,
    Edit(NoteEdit, oneshot::Sender<Result<Value, String>>),
    Get(oneshot::Sender<Value>),
}

pub struct NotesHandle {
    pub tx: mpsc::UnboundedSender<NotesCmd>,
    /// Lines sent and not yet taken by the actor (a backpressure counter).
    pub queued: Arc<AtomicUsize>,
    pub max_queued: Arc<AtomicUsize>,
    pub finished: Arc<AtomicBool>,
    pub dropped_lines: Arc<AtomicU64>,
    pub sent_tokens: Arc<AtomicU64>,
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

pub fn status_event(meeting_id: &str, st: &NotesStatus, total_tokens: u64, finished: bool, stopped_by_user: bool, final_note: Option<String>) -> Value {
    let (status, reason): (&str, Option<String>) = if finished {
        ("finished", final_note)
    } else if stopped_by_user || st.state == RunState::Stopped {
        ("off", None)
    } else {
        match st.state {
            RunState::CapReached => ("capped", Some("The token cap for this meeting was reached".to_string())),
            RunState::Paused(crate::live_common::PauseReason::User) => ("paused", None),
            RunState::Paused(crate::live_common::PauseReason::PlanLimit) => ("paused", Some(st.last_error.clone().unwrap_or_else(|| "The plan's usage limit was reached".into()))),
            RunState::Paused(crate::live_common::PauseReason::Failures) => ("error", Some(st.last_error.clone().map(|e| format!("Three runs in a row failed: {e}")).unwrap_or_else(|| "Three runs in a row failed".into()))),
            // over its cap a run never shows as running
            _ if st.tokens_used >= st.cap => ("capped", Some("The token cap for this meeting was reached".to_string())),
            _ => {
                if st.in_flight || st.tokens_used > 0 {
                    ("running", st.last_error.clone())
                } else {
                    ("idle", None)
                }
            }
        }
    };
    json!({
        "meeting_id": meeting_id,
        "status": status,
        "tokens_used": st.tokens_used,
        "total_tokens": total_tokens,
        "cap": st.cap,
        "reason": reason,
    })
}

fn cfg_from(s: &NotetakerSettings) -> NotesConfig {
    let mut cfg = NotesConfig::default();
    cfg.trigger.cap_tokens = s.cap;
    cfg.prompt = NotesPromptOptions {
        detail: match s.detail.as_str() {
            "brief" => Detail::Brief,
            "detailed" => Detail::Detailed,
            _ => Detail::Standard,
        },
        language: if s.language == "meeting" { OutputLanguage::Meeting } else { OutputLanguage::Fixed(s.language.clone()) },
        small_model: false,
    };
    cfg
}

pub fn spawn(p: NotesParams) -> Result<NotesHandle, String> {
    let selection = Selection { provider: p.settings.provider.clone(), model: p.settings.model.clone(), effort: p.settings.effort.clone() };
    let swap = SwapLlm::new(p.factory.clone(), AiPurpose::Notes, &p.meeting_id, selection)?;
    let (tx, rx) = mpsc::unbounded_channel();
    let handle = NotesHandle {
        tx,
        queued: Arc::new(AtomicUsize::new(0)),
        max_queued: Arc::new(AtomicUsize::new(0)),
        finished: Arc::new(AtomicBool::new(false)),
        dropped_lines: Arc::new(AtomicU64::new(0)),
        sent_tokens: Arc::new(AtomicU64::new(0)),
    };
    let shared = (handle.queued.clone(), handle.finished.clone(), handle.dropped_lines.clone(), handle.sent_tokens.clone());
    tokio::spawn(run(p, swap, rx, shared));
    Ok(handle)
}

type Shared = (Arc<AtomicUsize>, Arc<AtomicBool>, Arc<AtomicU64>, Arc<AtomicU64>);

#[allow(unused_assignments)]
async fn run(p: NotesParams, swap: Arc<SwapLlm>, mut rx: mpsc::UnboundedReceiver<NotesCmd>, shared: Shared) {
    let (queued, finished_flag, dropped, sent) = shared;
    let dirty = Arc::new(AtomicBool::new(false));
    let sink = Arc::new(ActorSink { dirty: dirty.clone() });
    let discarded = Arc::new(AtomicBool::new(false));
    let store = Arc::new(DbStore { db: p.db.clone(), meeting_id: p.meeting_id.clone(), discarded: discarded.clone() });
    let mut cfg = cfg_from(&p.settings);
    cfg.final_timeout = p.final_timeout;
    let mut engine = NotesEngine::new(swap.clone(), p.clock.clone(), cfg, sink, store);
    if let Some(r) = p.resume {
        engine.resume_from(r.doc, r.tokens_used, r.cap);
    }
    let auto = p.settings.update_mode == "automatic";
    let mut last_state = Value::Null;
    let mut last_doc_emit = Instant::now() - Duration::from_secs(5);
    let mut done = false;
    let mut finishing = false;
    let mut user_stopped = false;
    let mut quitting = false;
    let mut interrupted = false;

    macro_rules! emit_state {
        () => {{
            let ev = status_event(&p.meeting_id, &engine.status(), engine.sent_tokens_total, done, user_stopped, engine.final_note.clone());
            if ev != last_state {
                p.emitter.emit("notetaker_state", ev.clone());
                last_state = ev;
            }
            dropped.store(engine.dropped_lines, Ordering::SeqCst);
            sent.store(engine.sent_tokens_total, Ordering::SeqCst);
        }};
    }
    macro_rules! flush_doc {
        ($force:expr) => {{
            if dirty.load(Ordering::SeqCst) && ($force || last_doc_emit.elapsed() >= Duration::from_millis(250)) {
                dirty.store(false, Ordering::SeqCst);
                last_doc_emit = Instant::now();
                p.emitter.emit("notetaker_doc", json!({"meeting_id": p.meeting_id, "version": engine.doc().version, "doc": doc_to_contract(engine.doc())}));
            }
        }};
    }
    // Commands that never need the engine idle. Returns false to leave.
    macro_rules! handle {
        ($cmd:expr) => {{
            match $cmd {
                NotesCmd::Line(l) => {
                    queued.fetch_sub(1, Ordering::SeqCst);
                    engine.feed(l);
                }
                NotesCmd::Manual => engine.request_manual(),
                NotesCmd::Pause => engine.pause(),
                NotesCmd::Resume => engine.resume(),
                NotesCmd::KeepGoing => engine.keep_going(),
                NotesCmd::Stop => {
                    user_stopped = true;
                    swap.cancel();
                    engine.stop();
                    quitting = true;
                }
                NotesCmd::Finish => finishing = true,
                NotesCmd::Discard => {
                    discarded.store(true, Ordering::SeqCst);
                    swap.cancel();
                    quitting = true;
                }
                NotesCmd::Quit => {
                    swap.cancel();
                    let st = engine.status();
                    let _ = p.db.save_notes(&p.meeting_id, engine.doc(), "interrupted", st.tokens_used, st.cap);
                    quitting = true;
                    interrupted = true;
                }
                NotesCmd::Edit(edit, reply) => {
                    let res = apply_edit(engine.doc_mut(), &edit).map(|_| {
                        engine.save_now();
                        dirty.store(true, Ordering::SeqCst);
                        doc_to_contract(engine.doc())
                    });
                    let _ = reply.send(res);
                }
                NotesCmd::Get(reply) => {
                    let _ = reply.send(doc_to_contract(engine.doc()));
                }
            }
        }};
    }

    emit_state!();
    let mut ticker = tokio::time::interval(p.tick);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    'main: loop {
        tokio::select! {
            cmd = rx.recv() => match cmd {
                Some(c) => handle!(c),
                None => break 'main,
            },
            _ = ticker.tick() => {}
        }
        if quitting {
            break;
        }
        if finishing {
            let _ = engine.finish().await;
            done = true;
            finished_flag.store(true, Ordering::SeqCst);
            break;
        }
        engine.set_gate(!(p.busy)());
        if let Decision::Run(reason) = engine.poll() {
            let allowed = auto || matches!(reason, RunReason::Manual | RunReason::Final);
            if allowed {
                let gen0 = (p.generation)(&p.meeting_id, false);
                swap.set_expected(Some(gen0));
                if let Some(prep) = engine.prepare(reason) {
                    let req = prep.request.clone();
                    let fut = swap.call(&req);
                    tokio::pin!(fut);
                    let result = loop {
                        tokio::select! {
                            r = &mut fut => break r,
                            cmd = rx.recv() => match cmd {
                                Some(c) => handle!(c),
                                None => { swap.cancel(); quitting = true; }
                            },
                        }
                    };
                    if discarded.load(Ordering::SeqCst) || (p.generation)(&p.meeting_id, false) != gen0 {
                        // the scope generation moved or the meeting is going: nothing is applied, the lines go back
                        engine.abort(prep);
                    } else {
                        engine.complete(prep, result);
                    }
                    if quitting {
                        break;
                    }
                }
            }
        }
        emit_state!();
        flush_doc!(false);
    }
    if discarded.load(Ordering::SeqCst) {
        finished_flag.store(true, Ordering::SeqCst);
        (p.on_exit)(&p.meeting_id);
        return;
    }
    if interrupted {
        // a run that was in flight finished after the quit saved: save as interrupted once more
        let st = engine.status();
        let _ = p.db.save_notes(&p.meeting_id, engine.doc(), "interrupted", st.tokens_used, st.cap);
    }
    if finishing && !done {
        let _ = engine.finish().await;
        done = true;
        finished_flag.store(true, Ordering::SeqCst);
    }
    emit_state!();
    flush_doc!(true);
    finished_flag.store(true, Ordering::SeqCst);
    (p.on_exit)(&p.meeting_id);
}

#[allow(unused)]
fn _assert_send() {
    fn is_send<T: Send>() {}
    is_send::<NotesParams>();
    let _ = Mutex::new(0);
}
