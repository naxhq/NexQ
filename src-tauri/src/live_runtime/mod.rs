//! The running side of live notes, the live brief and memory suggestions:
//! one actor per meeting and feature, fed from the transcript path without
//! ever blocking it, calling the model through the shared AI run service.
//!
//! Everything the app provides (database, events, model calls, the live
//! meeting, the live-answer gate, the scope generation) comes in through
//! `Deps`, so the whole thing runs in tests with fakes.


pub mod app;
pub mod brief;
pub mod cheapest;
#[cfg(test)]
mod contract_tests;
pub mod db;
pub mod llm;
pub mod memory;
pub mod notes;
pub mod settings;
pub mod state;

#[cfg(test)]
mod tests;

use crate::live_common::Clock;
use crate::live_notes::engine::TranscriptLine;
use crate::live_runtime::brief::{BriefCmd, BriefHandle, BriefParams};
use crate::live_runtime::db::{LiveDb, LiveScope};
use crate::live_runtime::llm::LlmFactory;
use crate::live_runtime::notes::{NoteEdit, NotesCmd, NotesHandle, NotesParams};
use crate::live_runtime::settings::{merge, BriefSettings, MemorySettings, NotetakerSettings, BRIEF_KEY, MEMORY_KEY, NOTETAKER_KEY};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

pub trait Emitter: Send + Sync {
    fn emit(&self, event: &str, payload: Value);
}

/// Drops what an actor says about a meeting that is being deleted, even in the
/// moment before the actor has seen its own discard.
struct GuardedEmitter {
    inner: Arc<dyn Emitter>,
    deleted: Arc<Mutex<std::collections::HashSet<String>>>,
}

impl Emitter for GuardedEmitter {
    fn emit(&self, event: &str, payload: Value) {
        if let Some(id) = payload.get("meeting_id").and_then(Value::as_str) {
            if self.deleted.lock().map(|d| d.contains(id)).unwrap_or(false) {
                return;
            }
        }
        self.inner.emit(event, payload);
    }
}

/// What the app gives the runtimes.
#[derive(Clone)]
pub struct Deps {
    pub db: LiveDb,
    pub emitter: Arc<dyn Emitter>,
    pub factory: Arc<dyn LlmFactory>,
    pub clock: Arc<dyn Clock>,
    /// True while a live answer is generating.
    pub busy: Arc<dyn Fn() -> bool + Send + Sync>,
    /// The id of the running meeting, if any.
    pub live_meeting: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    /// The scope generation of the AI run service for (meeting, is_brief).
    pub generation: Arc<dyn Fn(&str, bool) -> u64 + Send + Sync>,
    /// Meetings that are gone: suggestions and saves for them are dropped.
    pub deleted: Arc<Mutex<std::collections::HashSet<String>>>,
    /// A meeting's notes and brief sessions may end.
    pub close_sessions: Arc<dyn Fn(String) + Send + Sync>,
    pub tick: Duration,
    pub scope_check: Duration,
    pub final_timeout: Duration,
}

struct Inner {
    notetaker: NotetakerSettings,
    brief: BriefSettings,
    notes: HashMap<String, NotesHandle>,
    briefs: HashMap<String, BriefHandle>,
    /// What each CLI session was last given: `meeting|session` -> token.
    session_tokens: HashMap<String, String>,
    /// Epoch ms that counts as 0 for each live meeting (see `live_common::rel_ms`).
    bases: HashMap<String, Option<i64>>,
}

pub struct LiveRuntimes {
    deps: Deps,
    inner: Arc<Mutex<Inner>>,
}

static GLOBAL: OnceLock<Arc<LiveRuntimes>> = OnceLock::new();

/// The app's runtimes, once `init` has run.
pub fn global() -> Option<Arc<LiveRuntimes>> {
    GLOBAL.get().cloned()
}

pub fn init(rt: Arc<LiveRuntimes>) {
    let _ = GLOBAL.set(rt);
}

/// Modes whose answers may carry the brief: live answers for the user, never
/// translation, summaries, action items or bookmarks.
pub const ANSWER_MODES: &[&str] = &["Assist", "WhatToSay", "Shorten", "FollowUp", "Recap", "AskQuestion"];

impl LiveRuntimes {
    pub fn new(deps: Deps) -> Arc<Self> {
        let notetaker = deps.db.kv_get(NOTETAKER_KEY).and_then(|j| serde_json::from_str(&j).ok()).unwrap_or_default();
        let brief = deps.db.kv_get(BRIEF_KEY).and_then(|j| serde_json::from_str(&j).ok()).unwrap_or_default();
        deps.db.mark_interrupted();
        Arc::new(Self {
            deps,
            inner: Arc::new(Mutex::new(Inner {
                notetaker,
                brief,
                notes: HashMap::new(),
                briefs: HashMap::new(),
                session_tokens: HashMap::new(),
                bases: HashMap::new(),
            })),
        })
    }

    pub fn deps(&self) -> &Deps {
        &self.deps
    }

    // ---------------------------------------------------------------- settings

    pub fn notetaker_settings(&self) -> NotetakerSettings {
        self.inner.lock().unwrap().notetaker.clone()
    }

    pub fn brief_settings(&self) -> BriefSettings {
        self.inner.lock().unwrap().brief.clone()
    }

    /// Merges a patch atomically, saves, tells the webview, and, when turned off,
    /// stops every active run (one in flight included).
    pub fn patch_notetaker(&self, patch: &Value) -> Result<NotetakerSettings, String> {
        let (merged, stop): (NotetakerSettings, Vec<tokio::sync::mpsc::UnboundedSender<NotesCmd>>) = {
            let mut g = self.inner.lock().unwrap();
            let merged = merge(&g.notetaker, patch)?;
            self.deps.db.kv_set(NOTETAKER_KEY, &serde_json::to_string(&merged).map_err(|e| e.to_string())?)?;
            let turning_off = g.notetaker.enabled && !merged.enabled;
            g.notetaker = merged.clone();
            let stop = if turning_off { g.notes.values().map(|h| h.tx.clone()).collect() } else { Vec::new() };
            (merged, stop)
        };
        for tx in stop {
            let _ = tx.send(NotesCmd::Stop);
        }
        // model, cap, detail, language and mode reach a running actor for its next run
        if merged.enabled {
            for h in self.inner.lock().unwrap().notes.values() {
                let _ = h.tx.send(NotesCmd::Reconfigure(merged.clone()));
            }
        }
        self.deps.emitter.emit("notetaker_settings_changed", serde_json::to_value(&merged).unwrap_or(Value::Null));
        Ok(merged)
    }

    pub fn memory_settings(&self) -> MemorySettings {
        self.deps.db.kv_get(MEMORY_KEY).and_then(|j| serde_json::from_str(&j).ok()).unwrap_or_default()
    }

    /// Which model proposes memory (shared by the button and auto-suggest).
    pub fn patch_memory(&self, patch: &Value) -> Result<MemorySettings, String> {
        let _g = self.inner.lock().unwrap();
        let merged = merge(&self.memory_settings(), patch)?;
        self.deps.db.kv_set(MEMORY_KEY, &serde_json::to_string(&merged).map_err(|e| e.to_string())?)?;
        drop(_g);
        self.deps.emitter.emit("memory_settings_changed", serde_json::to_value(&merged).unwrap_or(Value::Null));
        Ok(merged)
    }

    /// The brief's model settings. (Whether it runs is the workspace's switch, not a setting here.)
    pub fn patch_brief(&self, patch: &Value) -> Result<BriefSettings, String> {
        // an older caller may still send `enabled`: it means nothing any more
        let mut patch = patch.clone();
        if let Some(o) = patch.as_object_mut() {
            o.remove("enabled");
        }
        let merged = {
            let mut g = self.inner.lock().unwrap();
            let merged = merge(&g.brief, &patch)?;
            self.deps.db.kv_set(BRIEF_KEY, &serde_json::to_string(&merged).map_err(|e| e.to_string())?)?;
            g.brief = merged.clone();
            for h in g.briefs.values() {
                let _ = h.tx.send(BriefCmd::Reconfigure(merged.clone()));
            }
            merged
        };
        self.deps.emitter.emit("brief_settings_changed", serde_json::to_value(&merged).unwrap_or(Value::Null));
        Ok(merged)
    }

    // ---------------------------------------------------------------- the transcript path

    /// A final transcript line of the running meeting. Never blocks: two
    /// channel sends. Notes never lose a line; counters show the backlog.
    pub fn feed(&self, meeting_id: &str, speaker: &str, text: &str, ms: u64) {
        let mut g = match self.inner.try_lock() {
            Ok(g) => g,
            // A settings change holds the lock for a moment: wait that long rather than lose the line.
            Err(_) => self.inner.lock().unwrap(),
        };
        // The contract is time since the meeting started; speech providers may stamp wall-clock ms.
        let ms = if crate::live_common::is_epoch_ms(ms as i64) {
            let base = match g.bases.get(meeting_id) {
                Some(b) => *b,
                None => {
                    let b = self.deps.db.meeting_start_ms(meeting_id).filter(|s| crate::live_common::is_epoch_ms(*s)).or(Some(ms as i64));
                    g.bases.insert(meeting_id.to_string(), b);
                    b
                }
            };
            crate::live_common::rel_ms(ms as i64, base)
        } else {
            ms
        };
        if let Some(h) = g.notes.get(meeting_id) {
            let q = h.queued.fetch_add(1, Ordering::SeqCst) + 1;
            h.max_queued.fetch_max(q, Ordering::SeqCst);
            if h.tx.send(NotesCmd::Line(TranscriptLine { ms, speaker: speaker.to_string(), text: text.to_string() })).is_err() {
                h.queued.fetch_sub(1, Ordering::SeqCst);
            }
        }
        if let Some(h) = g.briefs.get(meeting_id) {
            h.queued.fetch_add(1, Ordering::SeqCst);
            if h.tx.send(BriefCmd::Line { ms, text: text.to_string() }).is_err() {
                h.queued.fetch_sub(1, Ordering::SeqCst);
            }
        }
    }

    /// A final line of the running meeting, whoever the caller is.
    pub fn feed_current(&self, speaker: &str, text: &str, ms: u64) {
        if let Some(id) = (self.deps.live_meeting)() {
            self.feed(&id, speaker, text, ms);
        }
    }

    /// The meeting's scope changed. Synchronous and never blocks on the
    /// database: before this returns the brief's sheet is gone, its running
    /// call is cancelled and its answer will be dropped; answers never see the
    /// old sheet. The actor then resolves the new scope.
    pub fn scope_changed(&self, meeting_id: &str) {
        let g = self.inner.lock().unwrap();
        if let Some(h) = g.briefs.get(meeting_id) {
            h.shared.invalidate();
            let _ = h.tx.send(BriefCmd::ScopeChanged);
        }
    }

    /// The meeting is being deleted: its actors stop at once and save
    /// nothing, and suggestions still in flight for it are dropped.
    fn guarded_emitter(&self) -> Arc<dyn Emitter> {
        Arc::new(GuardedEmitter { inner: self.deps.emitter.clone(), deleted: self.deps.deleted.clone() })
    }

    pub fn meeting_deleted(&self, meeting_id: &str) {
        self.deps.deleted.lock().unwrap().insert(meeting_id.to_string());
        // a memory run in flight for it is stopped too, not only checked between its calls
        memory::cancel_runs_of_meeting(meeting_id);
        let mut g = self.inner.lock().unwrap();
        if let Some(h) = g.notes.remove(meeting_id) {
            let _ = h.tx.send(NotesCmd::Discard);
        }
        if let Some(h) = g.briefs.remove(meeting_id) {
            h.shared.invalidate();
            let _ = h.tx.send(BriefCmd::Discard);
        }
        g.session_tokens.retain(|k, _| !k.starts_with(&format!("{meeting_id}|")));
        g.bases.remove(meeting_id);
    }

    // ---------------------------------------------------------------- notes

    /// Called once when an actor ends: it leaves the registry, and when neither notes nor brief are
    /// left for the meeting its sessions close.
    fn exit_closure(&self) -> Arc<dyn Fn(&str) + Send + Sync> {
        let inner = self.inner.clone();
        let close = self.deps.close_sessions.clone();
        Arc::new(move |id: &str| {
            let mut g = inner.lock().unwrap();
            if g.notes.get(id).map(|h| h.finished.load(Ordering::SeqCst)).unwrap_or(false) {
                g.notes.remove(id);
            }
            if g.briefs.get(id).map(|h| h.finished.load(Ordering::SeqCst)).unwrap_or(false) {
                g.briefs.remove(id);
            }
            if !g.notes.contains_key(id) && !g.briefs.contains_key(id) {
                drop(g);
                close(id.to_string());
            }
        })
    }

    fn require_live(&self, meeting_id: &str) -> Result<(), String> {
        match (self.deps.live_meeting)() {
            Some(id) if id == meeting_id => Ok(()),
            _ => Err("This works only in the meeting that is running".to_string()),
        }
    }

    pub fn notetaker_start(&self, meeting_id: &str) -> Result<(), String> {
        self.require_live(meeting_id)?;
        let settings = {
            let g = self.inner.lock().unwrap();
            if !g.notetaker.enabled {
                return Err("Live notes are turned off".into());
            }
            if let Some(h) = g.notes.get(meeting_id).filter(|h| !h.finished.load(Ordering::SeqCst)) {
                // start / try again on a paused or failed actor: it runs again with the current settings
                let _ = h.tx.send(NotesCmd::Reconfigure(g.notetaker.clone()));
                let _ = h.tx.send(NotesCmd::TryAgain);
                let _ = h.tx.send(NotesCmd::Resume);
                return Ok(());
            }
            g.notetaker.clone()
        };
        let resume = self.deps.db.load_notes(meeting_id);
        let on_exit = self.exit_closure();
        let handle = notes::spawn(NotesParams {
            meeting_id: meeting_id.to_string(),
            settings,
            resume,
            db: self.deps.db.clone(),
            emitter: self.guarded_emitter(),
            factory: self.deps.factory.clone(),
            clock: self.deps.clock.clone(),
            busy: self.deps.busy.clone(),
            generation: self.deps.generation.clone(),
            on_exit,
            tick: self.deps.tick,
            final_timeout: self.deps.final_timeout,
            preload: Vec::new(),
            one_shot: false,
            live_meeting: self.deps.live_meeting.clone(),
        })?;
        self.inner.lock().unwrap().notes.insert(meeting_id.to_string(), handle);
        Ok(())
    }

    fn notes_cmd(&self, meeting_id: &str, cmd: NotesCmd) {
        if let Some(h) = self.inner.lock().unwrap().notes.get(meeting_id) {
            let _ = h.tx.send(cmd);
        }
    }

    pub fn notetaker_stop(&self, meeting_id: &str) {
        self.notes_cmd(meeting_id, NotesCmd::Stop);
    }

    fn notes_alive(&self, meeting_id: &str) -> bool {
        self.inner.lock().unwrap().notes.get(meeting_id).map(|h| !h.finished.load(Ordering::SeqCst)).unwrap_or(false)
    }

    /// "Update now": never a silent no-op. With no actor (after Stop, or never
    /// started) it starts one when it may, or says why it cannot.
    pub fn notetaker_update_now(&self, meeting_id: &str) -> Result<(), String> {
        if !self.notes_alive(meeting_id) {
            if (self.deps.live_meeting)().as_deref() != Some(meeting_id) {
                // the meeting is over: update from the saved transcript
                return self.update_ended(meeting_id);
            }
            self.notetaker_start(meeting_id)?;
        }
        // any new words are enough, however few; with none it says so instead of doing nothing
        let nothing_new = self
            .inner
            .lock()
            .unwrap()
            .notes
            .get(meeting_id)
            .map(|h| h.queued.load(Ordering::SeqCst) == 0 && !h.has_new.load(Ordering::SeqCst))
            .unwrap_or(true);
        if nothing_new {
            return Err("Nothing new to add since the last update".into());
        }
        self.notes_cmd(meeting_id, NotesCmd::Manual);
        Ok(())
    }

    /// What the notes of an ended meeting never covered, from the saved coverage and the saved transcript.
    fn ended_uncovered(&self, meeting_id: &str, stored: &crate::live_notes::StoredNotes) -> Option<(u64, u64)> {
        let (lines, _) = self.deps.db.meeting_lines(meeting_id);
        if stored.doc.started_at.is_none() {
            // notes that never took a line and wrote nothing: the whole transcript is still open
            if stored.doc.blocks.is_empty() && stored.doc.covered_to.is_none() {
                if let (Some(first), Some(last)) = (lines.first(), lines.last()) {
                    return Some((first.ms, last.ms));
                }
            }
            return stored.doc.uncovered;
        }
        let times: Vec<u64> = lines.iter().map(|l| l.ms).collect();
        stored.doc.uncovered_in(&times)
    }

    /// "Update notes" for a meeting that is over: passes over the saved transcript for the part the
    /// notes never covered, until it is covered, the limit is reached or a run fails. The limit
    /// applies (the larger of the saved one and the settings'), it is refused while another
    /// meeting is live (it never competes with a live meeting) and says why when it cannot run.
    fn update_ended(&self, meeting_id: &str) -> Result<(), String> {
        if let Some(live) = (self.deps.live_meeting)() {
            if live != meeting_id {
                return Err("Another meeting is live right now. Update these notes after it ends".into());
            }
        }
        // asked for by the person on notes that exist: it does not need the live switch ("this meeting" turns it off at the end)
        let settings = self.notetaker_settings();
        let Some(stored) = self.deps.db.load_notes(meeting_id) else {
            return Err("There are no notes for this meeting".into());
        };
        let Some((from, to)) = self.ended_uncovered(meeting_id, &stored) else {
            return Err("Nothing new to add since the last update".into());
        };
        let mut stored = stored;
        let limit = stored.cap.max(settings.cap);
        if limit > 0 && stored.tokens_used >= limit {
            return Err("The token limit for this meeting was reached. Press Keep going to raise it and update".into());
        }
        stored.cap = limit;
        let (lines, _) = self.deps.db.meeting_lines(meeting_id);
        let preload: Vec<TranscriptLine> = lines
            .into_iter()
            .filter(|l| l.ms >= from && l.ms <= to)
            .map(|l| TranscriptLine { ms: l.ms, speaker: l.speaker, text: l.text })
            .collect();
        if preload.is_empty() {
            return Err("The saved transcript has nothing in the part that was not covered".into());
        }
        let on_exit = self.exit_closure();
        let handle = notes::spawn(NotesParams {
            meeting_id: meeting_id.to_string(),
            settings,
            resume: Some(stored),
            db: self.deps.db.clone(),
            emitter: self.guarded_emitter(),
            factory: self.deps.factory.clone(),
            clock: self.deps.clock.clone(),
            busy: self.deps.busy.clone(),
            generation: self.deps.generation.clone(),
            on_exit,
            tick: self.deps.tick,
            final_timeout: self.deps.final_timeout,
            preload,
            one_shot: true,
            live_meeting: self.deps.live_meeting.clone(),
        })?;
        self.inner.lock().unwrap().notes.insert(meeting_id.to_string(), handle);
        Ok(())
    }

    pub fn notetaker_pause(&self, meeting_id: &str) -> Result<(), String> {
        if !self.notes_alive(meeting_id) {
            return Err("Live notes are not running in this meeting".into());
        }
        self.notes_cmd(meeting_id, NotesCmd::Pause);
        Ok(())
    }

    /// Resume works from every state: a paused or failed actor runs again, a
    /// stopped one is started.
    pub fn notetaker_resume(&self, meeting_id: &str) -> Result<(), String> {
        if self.notes_alive(meeting_id) {
            self.notes_cmd(meeting_id, NotesCmd::TryAgain);
            self.notes_cmd(meeting_id, NotesCmd::Resume);
            Ok(())
        } else {
            self.notetaker_start(meeting_id)
        }
    }

    pub fn notetaker_continue(&self, meeting_id: &str) -> Result<(), String> {
        if self.notes_alive(meeting_id) {
            self.notes_cmd(meeting_id, NotesCmd::KeepGoing);
            return Ok(());
        }
        // an ended meeting that stopped at the limit: one press raises it and covers what is left
        if (self.deps.live_meeting)().as_deref() == Some(meeting_id) {
            return Err("Live notes are not running in this meeting".into());
        }
        let Some(stored) = self.deps.db.load_notes(meeting_id) else {
            return Err("There are no notes for this meeting".into());
        };
        let base = self.notetaker_settings().cap;
        let raised = stored.cap.max(base).max(stored.tokens_used) + base;
        self.deps.db.save_notes(meeting_id, &stored.doc, &stored.status, stored.tokens_used, raised)?;
        self.update_ended(meeting_id)
    }

    /// The person saw the "moved online" line of the notes or the brief.
    pub fn dismiss_moved_online(&self, meeting_id: &str, brief: bool) {
        if brief {
            self.brief_cmd(meeting_id, BriefCmd::DismissMoved);
        } else {
            self.notes_cmd(meeting_id, NotesCmd::DismissMoved);
        }
    }

    fn model_label(&self, sel: &llm::Selection) -> Option<state::ModelLabel> {
        self.deps.factory.label(sel)
    }

    /// The state the UI shows, for a running or a stopped feature (same payload as the events).
    pub async fn notetaker_state(&self, meeting_id: &str) -> Value {
        let tx = self.inner.lock().unwrap().notes.get(meeting_id).map(|h| h.tx.clone());
        if let Some(tx) = tx {
            let (r, rx) = oneshot::channel();
            if tx.send(NotesCmd::State(r)).is_ok() {
                if let Ok(Ok(v)) = tokio::time::timeout(Duration::from_secs(2), rx).await {
                    return v;
                }
            }
        }
        let settings = self.notetaker_settings();
        let stored = self.deps.db.load_notes(meeting_id);
        let (mut status, used, cap) = stored.as_ref().map(|s| (Some(s.status.clone()), s.tokens_used, s.cap)).unwrap_or((None, 0, settings.cap));
        // An ended meeting with nothing running: whatever the switch says and however the notes ended
        // (done, interrupted by a crash or a quit mid-pass), the part of the transcript no run
        // folded in is worked out now from what was saved.
        let ended = (self.deps.live_meeting)().as_deref() != Some(meeting_id);
        let not_covered = if ended { stored.as_ref().and_then(|s| self.ended_uncovered(meeting_id, s)) } else { None };
        if ended && stored.is_some() {
            status = Some("done".to_string());
        }
        let over_cap = stored.as_ref().is_some_and(|s| ended && not_covered.is_some() && s.tokens_used >= s.cap.max(settings.cap).max(1));
        // covered but empty: the runs found nothing to write, or nothing was said at all (then there is no box)
        let nothing_written = ended && not_covered.is_none() && stored.as_ref().is_some_and(|s| s.doc.blocks.is_empty());
        let no_speech = nothing_written && stored.as_ref().is_some_and(|s| s.doc.covered_to.is_none());
        let ended_info = if !ended || no_speech {
            None
        } else {
            stored.as_ref().map(|s| match (not_covered, s.status.as_str(), &s.doc.ended) {
                (None, _, _) if nothing_written => ("nothing_to_note".to_string(), Some("The notes read the whole call and found nothing to write down".to_string())),
                (None, _, _) => ("covered".to_string(), None),
                // the person stopped them, or turned them off, during the meeting
                (Some(_), "stopped", _) => ("stopped".to_string(), Some("The notes were stopped before the meeting ended".to_string())),
                (Some(_), "done", Some((k, d))) if k != "covered" => (k.clone(), d.clone()),
                (Some(_), "done", _) if over_cap => ("limit".to_string(), None),
                // the app closed or crashed before the end pass could save how it went
                (Some(_), _, _) => ("interrupted".to_string(), Some("NexQ was closed before the notes caught up".to_string())),
            })
        };
        let reason = if let Some((from, to)) = not_covered {
            Some(format!("Not covered: {} to {}", crate::live_common::fmt_clock(from), crate::live_common::fmt_clock(to)))
        } else if !settings.enabled {
            Some("Live notes are turned off".to_string())
        } else {
            None
        };
        let model = self.model_label(&notes::selection_of(&settings));
        let mut snap = state::idle_snapshot(meeting_id, status.as_deref(), used, cap.max(1), reason, model, not_covered, ended_info, over_cap);
        if ended && stored.is_none() {
            // a meeting that never had notes says so; nothing can be started on it
            snap.can.clear();
            snap.reason = Some("No live notes were taken in this meeting".to_string());
        } else if no_speech {
            snap.status = "off";
            snap.can.clear();
            snap.reason = Some("Nothing was said in this meeting".to_string());
        }
        serde_json::to_value(snap).unwrap_or(Value::Null)
    }

    /// The saved notes (live or not) in the contract's shape.
    pub async fn get_notes(&self, meeting_id: &str) -> Option<Value> {
        let tx = self.inner.lock().unwrap().notes.get(meeting_id).map(|h| h.tx.clone());
        if let Some(tx) = tx {
            let (r, rx) = oneshot::channel();
            if tx.send(NotesCmd::Get(r)).is_ok() {
                if let Ok(v) = rx.await {
                    return Some(v);
                }
            }
        }
        self.deps.db.load_notes(meeting_id).map(|s| notes::doc_to_contract(&s.doc))
    }

    /// A user edit: through the running actor when there is one, else on the saved notes.
    pub async fn edit_notes(&self, meeting_id: &str, edit: NoteEdit) -> Result<Value, String> {
        let tx = self.inner.lock().unwrap().notes.get(meeting_id).filter(|h| !h.finished.load(Ordering::SeqCst)).map(|h| h.tx.clone());
        if let Some(tx) = tx {
            let (r, rx) = oneshot::channel();
            if tx.send(NotesCmd::Edit(edit.clone(), r)).is_ok() {
                if let Ok(res) = rx.await {
                    return res;
                }
            }
        }
        let stored = self.deps.db.load_notes(meeting_id);
        let (mut doc, status, used, cap) = match stored {
            Some(s) => (s.doc, s.status, s.tokens_used, s.cap),
            None => (crate::live_notes::doc::NoteDoc::new(), "idle".into(), 0, self.notetaker_settings().cap),
        };
        notes::apply_edit(&mut doc, &edit)?;
        self.deps.db.save_notes(meeting_id, &doc, &status, used, cap)?;
        Ok(notes::doc_to_contract(&doc))
    }

    // ---------------------------------------------------------------- brief

    pub fn brief_start(&self, meeting_id: &str) -> Result<(), String> {
        self.require_live(meeting_id)?;
        let settings = {
            let g = self.inner.lock().unwrap();
            if let Some(h) = g.briefs.get(meeting_id).filter(|h| !h.finished.load(Ordering::SeqCst)) {
                let _ = h.tx.send(BriefCmd::Reconfigure(g.brief.clone()));
                let _ = h.tx.send(BriefCmd::TryAgain);
                let _ = h.tx.send(BriefCmd::Resume);
                return Ok(());
            }
            g.brief.clone()
        };
        let mut scope = self.deps.db.scope_result(meeting_id).map_err(|e| format!("The brief cannot start: {e}"))?;
        scope.generation = (self.deps.generation)(meeting_id, true);
        if !scope.brief_enabled {
            return Err("The brief is off in this workspace".into());
        }
        let on_exit = self.exit_closure();
        let still: Arc<dyn Fn(&LiveScope) -> bool + Send + Sync> = Arc::new(move |s: &LiveScope| s.brief_enabled);
        let handle = brief::spawn(BriefParams {
            meeting_id: meeting_id.to_string(),
            settings,
            scope,
            db: self.deps.db.clone(),
            emitter: self.guarded_emitter(),
            factory: self.deps.factory.clone(),
            clock: self.deps.clock.clone(),
            busy: self.deps.busy.clone(),
            generation: self.deps.generation.clone(),
            on_exit,
            tick: self.deps.tick,
            scope_check: self.deps.scope_check,
            still_enabled: still,
        })?;
        self.inner.lock().unwrap().briefs.insert(meeting_id.to_string(), handle);
        Ok(())
    }

    fn brief_cmd(&self, meeting_id: &str, cmd: BriefCmd) {
        if let Some(h) = self.inner.lock().unwrap().briefs.get(meeting_id) {
            let _ = h.tx.send(cmd);
        }
    }

    pub fn brief_stop(&self, meeting_id: &str) {
        self.brief_cmd(meeting_id, BriefCmd::Stop);
    }

    fn brief_alive(&self, meeting_id: &str) -> bool {
        self.inner.lock().unwrap().briefs.get(meeting_id).map(|h| !h.finished.load(Ordering::SeqCst)).unwrap_or(false)
    }

    /// "Refresh": never a silent no-op (it starts the brief when it may, or says why not).
    pub fn brief_refresh(&self, meeting_id: &str) -> Result<(), String> {
        if !self.brief_alive(meeting_id) {
            self.brief_start(meeting_id)?;
        }
        self.brief_cmd(meeting_id, BriefCmd::Refresh);
        Ok(())
    }

    pub fn brief_pause(&self, meeting_id: &str) -> Result<(), String> {
        if !self.brief_alive(meeting_id) {
            return Err("The brief is not running in this meeting".into());
        }
        self.brief_cmd(meeting_id, BriefCmd::Pause);
        Ok(())
    }

    pub fn brief_resume(&self, meeting_id: &str) -> Result<(), String> {
        if self.brief_alive(meeting_id) {
            self.brief_cmd(meeting_id, BriefCmd::TryAgain);
            self.brief_cmd(meeting_id, BriefCmd::Resume);
            Ok(())
        } else {
            self.brief_start(meeting_id)
        }
    }

    pub fn brief_continue(&self, meeting_id: &str) -> Result<(), String> {
        if !self.brief_alive(meeting_id) {
            return Err("The brief is not running in this meeting".into());
        }
        self.brief_cmd(meeting_id, BriefCmd::KeepGoing);
        Ok(())
    }

    pub async fn brief_state(&self, meeting_id: &str) -> Value {
        let tx = self.inner.lock().unwrap().briefs.get(meeting_id).map(|h| h.tx.clone());
        if let Some(tx) = tx {
            let (r, rx) = oneshot::channel();
            if tx.send(BriefCmd::State(r)).is_ok() {
                if let Ok(Ok(v)) = tokio::time::timeout(Duration::from_secs(2), rx).await {
                    return v;
                }
            }
        }
        let settings = self.brief_settings();
        let stored = self.deps.db.load_brief(meeting_id);
        let reason = match self.deps.db.scope_result(meeting_id) {
            Ok(s) if !s.brief_enabled => Some("The brief is off in this workspace".to_string()),
            Ok(_) => None,
            Err(e) => Some(format!("The brief cannot run: {e}")),
        };
        let (status, used, cap) = stored.as_ref().map(|s| (Some(s.status.clone()), s.tokens_used, s.cap)).unwrap_or((None, 0, settings.cap));
        let model = self.model_label(&llm::Selection { provider: settings.provider.clone(), model: settings.model.clone(), effort: settings.effort.clone() });
        serde_json::to_value(state::idle_snapshot(meeting_id, status.as_deref(), used, cap.max(1), reason, model, None, None, false)).unwrap_or(Value::Null)
    }

    /// What "Automatic" means for a provider (None = the active one): the model and
    /// the label to show before anything is turned on.
    pub fn automatic_model(&self, provider: Option<&str>) -> Option<cheapest::CheapestChoice> {
        self.deps.factory.automatic(provider)
    }

    pub async fn get_brief(&self, meeting_id: &str) -> Option<Value> {
        let tx = self.inner.lock().unwrap().briefs.get(meeting_id).map(|h| h.tx.clone());
        if let Some(tx) = tx {
            let (r, rx) = oneshot::channel();
            if tx.send(BriefCmd::Get(r)).is_ok() {
                if let Ok(v) = rx.await {
                    return if v.is_null() { None } else { Some(v) };
                }
            }
        }
        // a saved sheet is shown only under the scope it was made for
        let stored = self.deps.db.load_brief(meeting_id)?;
        let fresh = self.deps.db.scope(meeting_id)?;
        if stored.fingerprint != fresh.fingerprint {
            return None;
        }
        stored.sheet.map(|s| brief::sheet_to_contract(&s, 0))
    }

    // ---------------------------------------------------------------- meeting life

    pub fn on_meeting_start(&self, meeting_id: &str) {
        let (n, b) = {
            let g = self.inner.lock().unwrap();
            (g.notetaker.enabled && g.notetaker.scope == "every", true)
        };
        if n {
            if let Err(e) = self.notetaker_start(meeting_id) {
                log::info!("Live notes did not start: {e}");
            }
        }
        if b {
            // the workspace's own switch decides (checked again inside)
            let _ = self.brief_start(meeting_id);
        }
    }

    /// The meeting ended. Never waits: the final pass runs in the actor (at
    /// most `final_timeout`), then the meeting's sessions close.
    pub fn on_meeting_end(&self, meeting_id: &str) {
        let (had, scope_meeting) = {
            let g = self.inner.lock().unwrap();
            let had = g.notes.contains_key(meeting_id) || g.briefs.contains_key(meeting_id);
            if let Some(h) = g.notes.get(meeting_id) {
                let _ = h.tx.send(NotesCmd::Finish);
            }
            if let Some(h) = g.briefs.get(meeting_id) {
                let _ = h.tx.send(BriefCmd::Finish);
            }
            (had, g.notetaker.enabled && g.notetaker.scope == "meeting")
        };
        if !had {
            (self.deps.close_sessions)(meeting_id.to_string());
        }
        // memory suggestions come only after the meeting, and only where the workspace asked for them
        memory::auto_suggest_after(Arc::new(self.deps.clone()), meeting_id.to_string(), Duration::from_secs(5));
        if scope_meeting {
            // "This meeting" ends with the meeting: off for the next one (running actors are left alone).
            let mut g = self.inner.lock().unwrap();
            g.notetaker.enabled = false;
            if let Ok(j) = serde_json::to_string(&g.notetaker) {
                let _ = self.deps.db.kv_set(NOTETAKER_KEY, &j);
            }
            let v = serde_json::to_value(&g.notetaker).unwrap_or(Value::Null);
            drop(g);
            self.deps.emitter.emit("notetaker_settings_changed", v);
        }
        self.inner.lock().unwrap().session_tokens.retain(|k, _| !k.starts_with(&format!("{meeting_id}|")));
    }

    /// The app is closing: running notes are saved as interrupted (resumable).
    pub async fn shutdown(&self, wait: Duration) {
        let flags: Vec<Arc<std::sync::atomic::AtomicBool>> = {
            let g = self.inner.lock().unwrap();
            for h in g.notes.values() {
                let _ = h.tx.send(NotesCmd::Quit);
            }
            for h in g.briefs.values() {
                let _ = h.tx.send(BriefCmd::Quit);
            }
            g.notes.values().map(|h| h.finished.clone()).chain(g.briefs.values().map(|h| h.finished.clone())).collect()
        };
        let until = Instant::now() + wait;
        while Instant::now() < until && flags.iter().any(|f| !f.load(Ordering::SeqCst)) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    // ---------------------------------------------------------------- live answers

    /// Reference data for a live answer: the newest brief sheet and the core memory,
    /// each fenced as data. None for modes that are not answers, when nothing
    /// is there, or (for a CLI session) when the session already has it.
    /// Never waits for the brief and never calls a model.
    pub fn answer_extras(&self, meeting_id: &str, mode: &str, session: Option<&str>) -> Option<String> {
        match session {
            None => self.build_extras(meeting_id, mode).map(|e| e.text),
            Some(key) => self.session_extras(meeting_id, mode, key).map(|e| e.text),
        }
    }

    /// For a CLI session: the extras only when this session has not been given
    /// them. `session_key` names the session and its generation (a restart gives
    /// it a new one, so a restarted session gets everything again). Nothing is
    /// recorded until the turn succeeded: `mark_session_sent`.
    pub fn session_extras(&self, meeting_id: &str, mode: &str, session_key: &str) -> Option<SessionExtras> {
        let e = self.build_extras(meeting_id, mode)?;
        let key = format!("{meeting_id}|{session_key}");
        let g = self.inner.lock().ok()?;
        if g.session_tokens.get(&key) == Some(&e.token) {
            return None;
        }
        Some(SessionExtras { text: e.text, token: e.token, key })
    }

    /// The turn that carried `extras` succeeded: this session now has them.
    pub fn mark_session_sent(&self, extras: &SessionExtras) {
        if let Ok(mut g) = self.inner.lock() {
            g.session_tokens.insert(extras.key.clone(), extras.token.clone());
        }
    }

    /// A meeting's sessions restarted: they get the brief and memory again.
    pub fn forget_sessions(&self, meeting_id: &str) {
        if let Ok(mut g) = self.inner.lock() {
            g.session_tokens.retain(|k, _| !k.starts_with(&format!("{meeting_id}|")));
        }
    }

    fn build_extras(&self, meeting_id: &str, mode: &str) -> Option<SessionExtras> {
        if !ANSWER_MODES.contains(&mode) {
            return None;
        }
        // Freshly resolved: what is shown is what this scope allows right now.
        let fresh = self.deps.db.scope(meeting_id)?;
        let generation = (self.deps.generation)(meeting_id, true);
        let now = self.deps.clock.now_ms();
        let (sheet_text, rev, nonce) = {
            let g = self.inner.lock().ok()?;
            match g.briefs.get(meeting_id) {
                Some(h) if !h.finished.load(Ordering::SeqCst) => {
                    let key = brief::scope_key(&fresh.fingerprint, h.shared.counter.load(Ordering::SeqCst), generation);
                    let found = h.shared.holder.lock().ok()?.changed_since(now, &key, None);
                    match found {
                        Some((t, r)) => (Some(t), r, h.shared.nonce.clone()),
                        None => (None, 0, h.shared.nonce.clone()),
                    }
                }
                _ => (None, 0, crate::prompt_data::new_nonce()),
            }
        };
        let memory = fresh.memory_text;
        if sheet_text.is_none() && memory.trim().is_empty() {
            return None;
        }
        let token = format!("{rev}:{:x}", fnv(&memory));
        let mut out = crate::prompt_data::rules(&nonce);
        if let Some(t) = sheet_text {
            out.push('\n');
            out.push_str(&crate::prompt_data::wrap(&nonce, "brief", &t));
        }
        if !memory.trim().is_empty() {
            out.push('\n');
            out.push_str(&crate::prompt_data::wrap(&nonce, "memory", &memory));
        }
        Some(SessionExtras { text: out, token, key: String::new() })
    }
}

/// What a session was (or is about to be) given: see `session_extras`.
#[derive(Debug, Clone)]
pub struct SessionExtras {
    pub text: String,
    token: String,
    key: String,
}

fn fnv(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

