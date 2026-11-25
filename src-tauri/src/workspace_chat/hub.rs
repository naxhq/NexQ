//! The chat hub: the request guard, session fingerprints, and the background
//! indexer with its progress. One lives in `AppState`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use super::provenance::Provenance;
use crate::ai_runs::AiRuns;
use crate::llm::cli_agent::command::SourcesLaunch;
use crate::llm::cli_agent::CliAgentKind;
use crate::llm::provider::CancelToken;
use crate::workspace_search::indexer::{IndexProgress, IndexProvider, IndexerConfig, IndexerService};

/// Chat answers that may run at once, and while a meeting is active.
pub const MAX_ANSWERS: usize = 2;
pub const MAX_ANSWERS_IN_MEETING: usize = 1;
/// How often an open workspace is rescanned.
pub const RESCAN_EVERY: Duration = Duration::from_secs(600);

// ── the tool seam ────────────────────────────────────────────────────────────

/// What a chat's CLI session may do with tools. Today every chat is read-only
/// (the launch the sources layer builds); the approval work plugs in here
/// without touching the engine: build its policy from `server_ids`, adjust the
/// launch, register the chat's approvals before the run, clear them on close
/// and deny pending requests on cancel.
pub struct ToolContext<'a> {
    pub chat_id: &'a str,
    pub kind: Option<CliAgentKind>,
    /// MCP servers of the chat's scope.
    pub server_ids: &'a [String],
}

pub trait ToolPolicy: Send + Sync {
    /// Change the launch before the session starts (allowed tools, flags).
    fn adjust_launch(&self, _ctx: &ToolContext, _launch: &mut SourcesLaunch) {}
    /// Called right before the run, after the launch is final.
    fn before_run(&self, _ctx: &ToolContext) {}
    /// The user cancelled the request in flight.
    fn on_cancel(&self, _chat_id: &str) {}
    /// The chat was closed or deleted.
    fn on_close(&self, _chat_id: &str) {}
    /// What the tools of this chat can do (nothing runs).
    fn describe(&self, _ctx: &ToolContext, _scope_dirs: &[std::path::PathBuf]) -> ChatCapabilities {
        ChatCapabilities::default()
    }
}

/// What a chat's tools can and cannot do, for the composer.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ChatCapabilities {
    /// The CLI can ask before a tool that changes things runs.
    pub can_ask: bool,
    /// Tools that are off in this chat, with the reason.
    pub tools_off: Vec<ToolOff>,
    /// Sentences for the composer and the context report.
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ToolOff {
    pub tool: String,
    pub reason: String,
}

/// Read-only tools as the sources layer launches them.
pub struct ReadOnlyPolicy;
impl ToolPolicy for ReadOnlyPolicy {}

// ── wakes for the indexer ─────────────────────────────────────────────────────

/// What changed that the index should follow. A wake is never lost: while the
/// indexer is not running yet it waits here and is delivered when it starts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Wake {
    Rescan,
    Meeting(String),
    RemoveMeeting(String),
    Folder(String),
    RemoveFolder(String),
    Documents,
    Points,
}

fn deliver(i: &IndexerService, w: Wake) {
    match w {
        Wake::Rescan => i.rescan(),
        Wake::Meeting(id) => i.index_meeting(&id),
        Wake::RemoveMeeting(id) => i.remove_meeting(&id),
        Wake::Folder(id) => i.index_folder(&id),
        Wake::RemoveFolder(id) => i.remove_folder(&id),
        Wake::Documents => i.index_documents(),
        Wake::Points => i.index_talking_points(),
    }
}

/// What the session of a chat was built from, compared with now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Seen {
    First,
    Same,
    Changed,
}

// ── the guard ──────────────────────────────────────────────────────────────

struct Active {
    chat_id: String,
    cancel: Arc<CancelToken>,
}

/// Held while an answer runs; dropping it (also when the task panics) frees
/// the slot.
pub struct Permit {
    hub: Arc<ChatHub>,
    pub request_id: String,
    pub cancel: Arc<CancelToken>,
}

impl std::fmt::Debug for Permit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Permit({})", self.request_id)
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        if let Ok(mut a) = self.hub.active.lock() {
            a.remove(&self.request_id);
        }
    }
}

#[derive(Default)]
pub struct ChatHub {
    ai: OnceLock<Arc<AiRuns>>,
    active: Mutex<HashMap<String, Active>>,
    fingerprints: Mutex<HashMap<String, String>>,
    indexer: Mutex<Option<Arc<IndexerService>>>,
    progress: Mutex<IndexProgress>,
    open_workspace: Mutex<Option<String>>,
    recap_cancel: Mutex<Option<Arc<CancelToken>>>,
    tools: OnceLock<Arc<dyn ToolPolicy>>,
    pending: Mutex<Vec<Wake>>,
    /// What each CLI chat's live session has been given so far (it keeps its
    /// earlier turns), so a revocation of any of it ends that session.
    session_prov: Mutex<HashMap<String, Provenance>>,
    last_kick: Mutex<Option<std::time::Instant>>,
    /// The session generation (plain, with sources) a chat's session had when it last received a turn.
    session_gen: Mutex<HashMap<String, (Option<u64>, Option<u64>)>>,
    starter: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

impl ChatHub {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// The service chats run on. Set once (by the app's wiring); a second
    /// call is ignored.
    pub fn set_ai_runs(&self, ai: Arc<AiRuns>) {
        let _ = self.ai.set(ai);
    }

    /// The one tool policy of the app (made on first use).
    pub fn tools_or(&self, make: impl FnOnce() -> Arc<dyn ToolPolicy>) -> Arc<dyn ToolPolicy> {
        self.tools.get_or_init(make).clone()
    }

    pub fn ai_runs(&self) -> Option<Arc<AiRuns>> {
        self.ai.get().cloned()
    }

    /// Take a slot for one answer: one per chat, two in all, one while a
    /// meeting is active.
    pub fn try_acquire(self: &Arc<Self>, chat_id: &str, request_id: &str, meeting_active: bool) -> Result<Permit, String> {
        let mut active = self.active.lock().map_err(|_| "Chat is busy".to_string())?;
        if active.values().any(|a| a.chat_id == chat_id) {
            return Err("This chat is still answering. Wait for it or stop it first.".into());
        }
        if active.contains_key(request_id) {
            return Err("This request is already running.".into());
        }
        let limit = if meeting_active { MAX_ANSWERS_IN_MEETING } else { MAX_ANSWERS };
        if active.len() >= limit {
            return Err(if meeting_active {
                "A meeting is running, so only one chat answer runs at a time. Try again when the other one is done.".into()
            } else {
                "Two chat answers are already running. Try again when one is done.".into()
            });
        }
        let cancel = Arc::new(CancelToken::new());
        active.insert(request_id.to_string(), Active { chat_id: chat_id.to_string(), cancel: cancel.clone() });
        Ok(Permit { hub: self.clone(), request_id: request_id.to_string(), cancel })
    }

    /// Cancel a request. Returns whether it was running.
    pub fn cancel(&self, request_id: &str) -> Option<String> {
        let active = self.active.lock().ok()?;
        let a = active.get(request_id)?;
        a.cancel.cancel();
        Some(a.chat_id.clone())
    }

    /// The `request_id` of the answer this chat is writing now, if any (the id
    /// the chat store holds; tool events of the answer carry it).
    pub fn request_of(&self, chat_id: &str) -> Option<String> {
        self.active.lock().ok()?.iter().find(|(_, a)| a.chat_id == chat_id).map(|(id, _)| id.clone())
    }

    pub fn running_for(&self, chat_id: &str) -> bool {
        self.active.lock().map(|a| a.values().any(|x| x.chat_id == chat_id)).unwrap_or(false)
    }

    pub fn running(&self) -> usize {
        self.active.lock().map(|a| a.len()).unwrap_or(0)
    }

    // ── sessions ──

    /// Remember what a chat's session was built from; true when it differs
    /// from the last time (the session must start again).
    pub fn fingerprint_changed(&self, chat_id: &str, fingerprint: &str) -> bool {
        let mut f = self.fingerprints.lock().unwrap();
        let changed = f.get(chat_id).map_or(false, |old| old != fingerprint);
        f.insert(chat_id.to_string(), fingerprint.to_string());
        changed
    }

    /// Like [`fingerprint_changed`], and also says when there was nothing yet.
    pub fn fingerprint_status(&self, chat_id: &str, fingerprint: &str) -> Seen {
        let mut f = self.fingerprints.lock().unwrap();
        let status = match f.get(chat_id) {
            None => Seen::First,
            Some(old) if old == fingerprint => Seen::Same,
            Some(_) => Seen::Changed,
        };
        f.insert(chat_id.to_string(), fingerprint.to_string());
        status
    }

    /// What the chat's live session already holds, if one runs.
    pub fn session_provenance(&self, chat_id: &str) -> Option<Provenance> {
        self.session_prov.lock().unwrap().get(chat_id).cloned()
    }

    /// The session is about to receive something resting on `prov`.
    pub fn hold_in_session(&self, chat_id: &str, prov: &Provenance, generation: (Option<u64>, Option<u64>)) {
        self.session_gen.lock().unwrap().insert(chat_id.to_string(), generation);
        self.session_prov.lock().unwrap().entry(chat_id.to_string()).or_default().merge(prov);
    }

    /// True only when the live session is the one that received the last turn: the same
    /// generation now as then. After an idle restart or any change of session it is not.
    pub fn session_is_current(&self, chat_id: &str, generation: (Option<u64>, Option<u64>)) -> bool {
        self.session_gen.lock().unwrap().get(chat_id) == Some(&generation)
    }

    /// The session ended: it holds nothing any more.
    pub fn reset_session(&self, chat_id: &str) {
        self.session_gen.lock().unwrap().remove(chat_id);
        self.session_prov.lock().unwrap().remove(chat_id);
    }

    pub fn forget_chat(&self, chat_id: &str) {
        self.session_gen.lock().unwrap().remove(chat_id);
        self.session_prov.lock().unwrap().remove(chat_id);
        self.fingerprints.lock().unwrap().remove(chat_id);
    }

    // ── indexer ──

    pub fn start_indexer(
        self: &Arc<Self>,
        db_path: std::path::PathBuf,
        provider: Arc<dyn IndexProvider>,
        meeting_active: Arc<dyn Fn() -> bool + Send + Sync>,
        emit: Arc<dyn Fn(IndexProgress, Option<String>) + Send + Sync>,
        initial_scan: bool,
    ) -> Result<(), String> {
        let mut slot = self.indexer.lock().map_err(|_| "indexer is busy".to_string())?;
        if slot.is_some() {
            return Ok(());
        }
        // wakes that came while it was not running are delivered below, once it is
        let hub = self.clone();
        let hub2 = self.clone();
        let svc = IndexerService::start(IndexerConfig {
            db_path,
            provider,
            meeting_active,
            on_progress: Arc::new(move |p| {
                if let Ok(mut cur) = hub.progress.lock() {
                    *cur = p.clone();
                }
                let ws = hub.open_workspace.lock().ok().and_then(|w| w.clone());
                emit(p, ws);
            }),
            rescan_interval: RESCAN_EVERY,
            initial_scan,
            timer_enabled: Some(Arc::new(move || hub2.open_workspace.lock().map(|w| w.is_some()).unwrap_or(false))),
        })?;
        let svc = Arc::new(svc);
        // under the same lock `wake` uses: no wake falls between "not started" and "started"
        let waiting: Vec<Wake> = self.pending.lock().map(|mut p| std::mem::take(&mut *p)).unwrap_or_default();
        for w in waiting {
            deliver(&svc, w);
        }
        *slot = Some(svc);
        Ok(())
    }

    /// How the indexer is started on demand (by the app's wiring).
    pub fn set_starter(&self, f: Arc<dyn Fn() + Send + Sync>) {
        if let Ok(mut s) = self.starter.lock() {
            *s = Some(f);
        }
    }

    /// Tell the indexer something changed. Delivered at once when it runs;
    /// otherwise kept and the indexer is started now (not after its start
    /// delay), which then delivers it.
    pub fn wake(&self, w: Wake) {
        let start = {
            let slot = match self.indexer.lock() {
                Ok(s) => s,
                Err(_) => return,
            };
            match slot.as_ref() {
                Some(i) => {
                    deliver(i, w);
                    return;
                }
                None => {
                    if let Ok(mut p) = self.pending.lock() {
                        if !p.contains(&w) {
                            p.push(w);
                        }
                    }
                    self.starter.lock().ok().and_then(|s| s.clone())
                }
            }
        };
        if let Some(f) = start {
            f();
        }
    }

    pub fn indexer(&self) -> Option<Arc<IndexerService>> {
        self.indexer.lock().ok().and_then(|i| i.clone())
    }

    pub fn shutdown_indexer(&self) {
        if let Some(i) = self.indexer.lock().ok().and_then(|mut i| i.take()) {
            i.shutdown();
        }
    }

    pub fn set_open_workspace(&self, id: Option<String>) {
        if let Ok(mut w) = self.open_workspace.lock() {
            *w = id;
        }
    }

    pub fn open_workspace(&self) -> Option<String> {
        self.open_workspace.lock().ok().and_then(|w| w.clone())
    }

    /// True at most once in `every`: a rescan asked for because a backlog sits with no pass
    /// running (a missed wake) must not become one pass per status poll.
    pub fn should_kick(&self, every: std::time::Duration) -> bool {
        let mut last = self.last_kick.lock().unwrap();
        if last.map_or(true, |t| t.elapsed() >= every) {
            *last = Some(std::time::Instant::now());
            true
        } else {
            false
        }
    }

    #[cfg(test)]
    pub fn set_progress_for_tests(&self, done: usize, total: usize) {
        *self.progress.lock().unwrap() = IndexProgress { done, total, current: String::new(), skipped: 0 };
    }

    /// True while an indexing pass has work left (a pass that finished is not running).
    pub fn pass_running(&self) -> bool {
        let p = self.progress();
        p.total > 0 && p.done < p.total
    }

    pub fn progress(&self) -> IndexProgress {
        self.progress.lock().map(|p| p.clone()).unwrap_or_default()
    }

    pub fn set_recap_cancel(&self, token: Option<Arc<CancelToken>>) {
        if let Ok(mut r) = self.recap_cancel.lock() {
            if let Some(old) = r.take() {
                old.cancel();
            }
            *r = token;
        }
    }

    pub fn cancel_recaps(&self) {
        if let Ok(mut r) = self.recap_cancel.lock() {
            if let Some(old) = r.take() {
                old.cancel();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_per_chat_two_overall_one_in_a_meeting() {
        let hub = ChatHub::new();
        let a = hub.try_acquire("c1", "r1", false).unwrap();
        assert!(hub.try_acquire("c1", "r2", false).unwrap_err().contains("still answering"));
        let b = hub.try_acquire("c2", "r3", false).unwrap();
        assert!(hub.try_acquire("c3", "r4", false).unwrap_err().contains("Two chat answers"));
        drop(a);
        assert!(hub.try_acquire("c1", "r5", false).is_ok());
        drop(b);
        // while a meeting is active: one at a time
        let hub = ChatHub::new();
        let _x = hub.try_acquire("c1", "r1", true).unwrap();
        assert!(hub.try_acquire("c2", "r2", true).unwrap_err().contains("meeting"));
    }

    #[test]
    fn cancel_fires_the_token_and_a_dropped_permit_frees_the_slot() {
        let hub = ChatHub::new();
        let p = hub.try_acquire("c1", "r1", false).unwrap();
        assert_eq!(hub.cancel("r1"), Some("c1".into()));
        assert!(p.cancel.is_cancelled());
        assert_eq!(hub.cancel("nope"), None);
        assert!(hub.running_for("c1"));
        drop(p);
        assert!(!hub.running_for("c1"));
    }

    #[test]
    fn fingerprints_report_a_change_once() {
        let hub = ChatHub::new();
        assert!(!hub.fingerprint_changed("c", "a"));
        assert!(!hub.fingerprint_changed("c", "a"));
        assert!(hub.fingerprint_changed("c", "b"));
        assert!(!hub.fingerprint_changed("c", "b"));
        hub.forget_chat("c");
        assert!(!hub.fingerprint_changed("c", "z"));
    }
}
