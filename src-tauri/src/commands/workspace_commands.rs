//! IPC for workspaces: CRUD, the library, a meeting's scope, talking points
//! and memory. Everything here is data; no AI call is made.
//!
//! Every command that changes data goes through [`change_and_restart`]: it
//! reads who depends on what is touched BEFORE the change and AFTER it, and
//! restarts the sessions of both (so revoking access reaches the sessions that
//! had it). A test lists the mutating commands and fails if one does not.

use std::collections::BTreeMap;
use std::sync::Arc;

use rusqlite::Connection;
use serde::Serialize;
use tauri::{command, AppHandle, Emitter, State};

use crate::commands::meeting_commands;
use crate::state::AppState;
use crate::workspace::library::{self, LibrarySnapshot};
use crate::workspace::types::*;
use crate::workspace::access::ViewState;
use crate::workspace::access::{self, Kind};
use crate::workspace::{documents, meetings, memory, purge, restart, scope, sources_seed, store, talking_points};

#[derive(Serialize, Clone)]
pub(crate) struct WorkspacesChanged {
    pub(crate) workspace_id: Option<String>,
}

#[derive(Serialize, Clone)]
pub(crate) struct MemoryChanged {
    pub(crate) workspace_id: String,
}

fn emit_changed(app: &AppHandle, workspace_id: Option<&str>) {
    let _ = app.emit("workspaces_changed", WorkspacesChanged { workspace_id: workspace_id.map(str::to_string) });
}

fn emit_memory(app: &AppHandle, workspace_id: &str) {
    let _ = app.emit("memory_changed", MemoryChanged { workspace_id: workspace_id.to_string() });
}

/// Why workspaces can't be used in this run, as one sentence.
fn unavailable() -> String {
    match crate::workspace::last_error() {
        Some(e) => format!("Workspaces are unavailable. {e}"),
        None => "Workspaces are unavailable in this run".to_string(),
    }
}

/// Runs `f` on the shared connection when workspaces are available.
pub(crate) fn with_conn<T>(state: &AppState, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
    if !crate::workspace::available() {
        return Err(unavailable());
    }
    let db = state.database.as_ref().ok_or_else(|| "Database not initialized".to_string())?;
    let guard = db.lock().map_err(|e| format!("Failed to lock database: {e}"))?;
    f(guard.connection())
}

/// Runs a read on a read-only connection of its own: it never waits for the shared one
/// (which the transcript writer holds), so the rail and change views stay quick during a
/// meeting. Falls back to the shared connection only when no reader can be opened.
pub(crate) fn with_reader<T>(state: &AppState, f: impl Fn(&Connection) -> Result<T, String>) -> Result<T, String> {
    if !crate::workspace::available() {
        return Err(unavailable());
    }
    match state.readers.as_ref().map(|r| r.with(&f)) {
        Some(Ok(out)) => out,
        _ => with_conn(state, |c| f(c)),
    }
}

/// What the library holds right now (documents loaded, folders and servers saved).
fn snapshot(state: &AppState) -> LibrarySnapshot {
    let resources = state.context.as_ref().and_then(|c| c.lock().ok()).map(|c| c.list_resources()).unwrap_or_default();
    let sources = state.personal_sources.read().map(|c| c.clone()).unwrap_or_default();
    LibrarySnapshot::from_app(&resources, &sources)
}

fn detail_of(state: &AppState, id: &str) -> Result<WorkspaceDetail, String> {
    let (workspace, summary, rows) = with_conn(state, |conn| {
        Ok((store::get_workspace(conn, id)?, store::get_summary(conn, id)?, store::list_items(conn, id)?))
    })?;
    Ok(WorkspaceDetail {
        summary,
        instructions: workspace.instructions,
        recaps_with_ai: workspace.recaps_with_ai,
        suggest_memory: workspace.suggest_memory,
        brief_enabled: workspace.brief_default,
        items: library::resolve_items(id, &rows, &snapshot(state)),
    })
}

/// The running meeting's id, if one runs.
fn live_meeting_id(state: &AppState) -> Option<String> {
    state.live_meeting.lock().ok().and_then(|m| m.as_ref().map(|m| m.id.clone()))
}

// ── Who depends on what changes ──────────────────────────────────────────────

/// What a change touches: workspaces (every meeting and chat that uses their
/// material), workspaces whose chats only are affected, and single meetings.
#[derive(Debug, Default, Clone, PartialEq)]
pub(crate) struct Touch {
    workspaces: Vec<String>,
    chats_of: Vec<String>,
    meetings: Vec<String>,
    /// The change takes access away whatever the views say (an opt-out): every
    /// dependent restarts at once.
    revoke: bool,
}

impl Touch {
    pub fn none() -> Self {
        Self::default()
    }

    pub fn ws(id: &str) -> Self {
        Self { workspaces: vec![id.to_string()], ..Self::default() }
    }

    pub fn chats(id: &str) -> Self {
        Self { chats_of: vec![id.to_string()], ..Self::default() }
    }

    pub fn meeting(id: &str) -> Self {
        Self { meetings: vec![id.to_string()], ..Self::default() }
    }

    /// `Touch::ws(id)` when `yes`, nothing otherwise.
    pub fn ws_if(yes: bool, id: &str) -> Self {
        if yes { Self::ws(id) } else { Self::none() }
    }

    pub fn also(mut self, other: Touch) -> Self {
        self.workspaces.extend(other.workspaces);
        self.chats_of.extend(other.chats_of);
        self.meetings.extend(other.meetings);
        self.revoke |= other.revoke;
        self
    }

    /// Marks the change as taking access away, as a backstop over the views.
    pub fn revoking(mut self) -> Self {
        self.revoke = true;
        self
    }
}

/// The sessions that start again.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Dependents {
    meetings: Vec<String>,
    chats: Vec<String>,
}

impl Dependents {
    fn merge(&mut self, other: Dependents) {
        for m in other.meetings {
            if !self.meetings.contains(&m) {
                self.meetings.push(m);
            }
        }
        for c in other.chats {
            if !self.chats.contains(&c) {
                self.chats.push(c);
            }
        }
    }
}

/// Chats whose scope includes `workspace_id`: its own, and (for General) the
/// ones of workspaces that also use General. Empty when there are no chats yet.
fn chats_using(conn: &Connection, workspace_id: &str) -> Vec<String> {
    let sql = "SELECT c.id FROM workspace_chats c JOIN workspaces w ON w.id = c.workspace_id
               WHERE c.workspace_id = ?1 OR (?1 = 'general' AND w.include_general = 1 AND w.keep_separate = 0)";
    let Ok(mut stmt) = conn.prepare(sql) else { return Vec::new() };
    let Ok(rows) = stmt.query_map(rusqlite::params![workspace_id], |row| row.get::<_, String>(0)) else {
        return Vec::new();
    };
    rows.filter_map(Result::ok).collect()
}

/// Chats that have a session or a running answer: the only ones a change can affect
/// now. A chat with neither looks its scope up afresh when it next asks.
fn chats_in_use(state: &AppState, chats: Vec<String>) -> Vec<String> {
    let mut live: std::collections::HashSet<String> = state.agent_sessions.snapshot().into_iter().filter_map(|s| s.chat_id).collect();
    for scope in state.meeting_sessions.scopes() {
        if let crate::llm::cli_agent::manager::SessionScope::Workspace(id) = scope {
            live.insert(id);
        }
    }
    chats.into_iter().filter(|c| live.contains(c) || state.workspace_chat.running_for(c)).collect()
}

/// The meetings (running, open in a view, or with a session record) and chats
/// whose scope includes `workspace_id` right now.
pub(crate) fn dependents_of(state: &AppState, workspace_id: &str) -> Dependents {
    let mut candidates: Vec<String> = live_meeting_id(state).into_iter().collect();
    let from_sessions = state.agent_sessions.snapshot().into_iter().filter_map(|s| s.meeting_id);
    let from_records = state.meeting_sessions.scopes().into_iter().filter_map(|s| match s {
        crate::llm::cli_agent::manager::SessionScope::Live(id)
        | crate::llm::cli_agent::manager::SessionScope::Past(id) => Some(id),
        _ => None,
    });
    for id in from_sessions.chain(from_records) {
        if !candidates.contains(&id) {
            candidates.push(id);
        }
    }
    with_reader(state, |conn| {
        let meetings: Vec<String> = candidates
            .iter()
            .filter(|m| {
                meetings::get_meeting_scope(conn, m).map(|s| s.effective.iter().any(|w| w == workspace_id)).unwrap_or(false)
            })
            .cloned()
            .collect();
        Ok(Dependents { meetings, chats: chats_in_use(state, chats_using(conn, workspace_id)) })
    })
    .unwrap_or_default()
}

/// The live runtimes of the meetings that use `workspace_id` look their scope up again now.
pub(crate) fn poke_live(state: &AppState, workspace_id: &str) {
    if let Some(rt) = crate::live_runtime::global() {
        for id in dependents_of(state, workspace_id).meetings {
            rt.scope_changed(&id);
        }
    }
}

/// The ids of the meetings filed in a workspace.
fn meeting_ids_of(conn: &Connection, workspace_id: &str) -> Vec<String> {
    conn.prepare("SELECT id FROM meetings WHERE workspace_id = ?1")
        .and_then(|mut stmt| stmt.query_map(rusqlite::params![workspace_id], |row| row.get::<_, String>(0)).map(|r| r.filter_map(Result::ok).collect()))
        .unwrap_or_default()
}

/// Everything that depends on `touch` at this moment.
fn dependents_for(state: &AppState, touch: &Touch) -> Dependents {
    let mut all = Dependents { meetings: touch.meetings.clone(), chats: Vec::new() };
    for ws in &touch.workspaces {
        all.merge(dependents_of(state, ws));
    }
    for ws in &touch.chats_of {
        let chats = with_reader(state, |conn| Ok(chats_in_use(state, chats_using(conn, ws)))).unwrap_or_default();
        all.merge(Dependents { meetings: Vec::new(), chats });
    }
    all
}

/// What a meeting or chat to restart is.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Target {
    Meeting(String),
    Chat(String),
}

impl Target {
    fn key(&self) -> String {
        match self {
            Target::Meeting(id) => format!("meeting:{id}"),
            Target::Chat(id) => format!("chat:{id}"),
        }
    }
}

/// What each dependent could use at one moment.
#[derive(Debug, Default)]
pub(crate) struct Pending {
    deps: Dependents,
    views: BTreeMap<Target, ViewState>,
    forced: bool,
}

/// What each of `deps` may use now: present, gone (it does not exist) or
/// unreadable (the read failed: treated as a revocation).
fn views_of(state: &AppState, deps: &Dependents) -> BTreeMap<Target, ViewState> {
    let targets: Vec<Target> = deps
        .meetings
        .iter()
        .map(|m| Target::Meeting(m.clone()))
        .chain(deps.chats.iter().map(|c| Target::Chat(c.clone())))
        .collect();
    with_reader(state, |conn| {
        Ok(targets
            .iter()
            .map(|t| {
                let v = match t {
                    Target::Meeting(id) => access::read_meeting_view(conn, id),
                    Target::Chat(id) => access::read_chat_view(conn, id),
                };
                (t.clone(), v)
            })
            .collect::<BTreeMap<_, _>>())
    })
    .unwrap_or_else(|_| targets.into_iter().map(|t| (t, ViewState::Unreadable)).collect())
}

/// First half of a change: who depends on what it touches, and what they may use now.
pub(crate) fn begin_change(state: &AppState, touched: &dyn Fn(&Connection) -> Touch) -> Pending {
    let touch = with_reader(state, |conn| Ok(touched(conn))).unwrap_or_default();
    let deps = dependents_for(state, &touch);
    let views = views_of(state, &deps);
    Pending { deps, views, forced: touch.revoke }
}

/// What to do with one dependent once a change is done.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Decision {
    Restart(Kind),
    /// It no longer exists: its sessions end and nothing starts again.
    Close,
}

/// What to do for every dependent from before OR after (the union): a
/// revocation when anything it could use is gone, was unreadable, or the change
/// failed part way; an edit when something it used changed content; a grant
/// otherwise; and `Close` for one that no longer exists. Pure, so the rule is
/// tested without an app.
pub(crate) fn decisions(
    before: &BTreeMap<Target, ViewState>,
    after: &BTreeMap<Target, ViewState>,
    ok: bool,
) -> Vec<(Target, Decision)> {
    let mut targets: Vec<&Target> = before.keys().chain(after.keys()).collect();
    targets.sort();
    targets.dedup();
    let mut out = Vec::new();
    for target in targets {
        let d = match after.get(target) {
            None | Some(ViewState::Gone) => Decision::Close,
            Some(ViewState::Unreadable) => Decision::Restart(Kind::Revoke),
            Some(ViewState::Present(now)) => match before.get(target) {
                Some(ViewState::Present(was)) => Decision::Restart(if ok { access::kind_of(was, now) } else { Kind::Revoke }),
                // it was a dependent but could not be read, or was not there: unknown before = revoke
                Some(_) => Decision::Restart(Kind::Revoke),
                // a new dependent (a borrow or General added)
                None => Decision::Restart(if ok { Kind::Grant } else { Kind::Revoke }),
            },
        };
        out.push((target.clone(), d));
    }
    out
}

/// Second half: reads the dependents again, decides and restarts.
pub(crate) fn finish_change(state: &AppState, app: &AppHandle, touched: &dyn Fn(&Connection) -> Touch, before: Pending, ok: bool) {
    let touch = with_reader(state, |conn| Ok(touched(conn))).unwrap_or_default();
    let forced = before.forced || touch.revoke;
    let mut deps = dependents_for(state, &touch);
    deps.merge(before.deps);
    // The live brief and the core memory follow every change at once, grant or
    // revocation: invalidating is cheap, local and not a session restart, so
    // it is neither coalesced nor delayed and comes before anything else.
    if let Some(rt) = crate::live_runtime::global() {
        for id in &deps.meetings {
            rt.scope_changed(id);
        }
    }
    let after = views_of(state, &deps);
    // A change declared as taking access away is one, whatever the views show.
    for (target, d) in decisions(&before.views, &after, ok && !forced) {
        match d {
            Decision::Restart(kind) => apply_restart(app, target, kind),
            Decision::Close => close_gone(app, &target),
        }
    }
}

/// A dependent that no longer exists: its sessions end, nothing starts again.
fn close_gone(app: &AppHandle, target: &Target) {
    use tauri::Manager;
    app.state::<AppState>().restarts.forget(&target.key());
    match target {
        Target::Meeting(id) => meeting_commands::drop_meeting_sessions(app, id),
        Target::Chat(id) => meeting_commands::restart_chat_sessions(app, vec![id.clone()]),
    }
}

fn restart_now(app: &AppHandle, target: &Target) {
    match target {
        Target::Meeting(id) => meeting_commands::restart_meeting_sessions(app, id),
        Target::Chat(id) => meeting_commands::restart_chat_sessions(app, vec![id.clone()]),
    }
}

/// A live answer is running for this meeting (a grant waits for it to finish).
fn answering(target: &Target) -> bool {
    matches!(target, Target::Meeting(_)) && crate::ai_runs::LiveGate::global().is_busy()
}

/// Restarts a session after a change: at once for a revocation; for a grant at
/// most once per 30 s per meeting or chat, and never while a live answer runs.
pub(crate) fn apply_restart(app: &AppHandle, target: Target, kind: Kind) {
    use std::time::Instant;
    use tauri::Manager;
    let restarts = app.state::<AppState>().restarts.clone();
    let key = target.key();
    match kind {
        Kind::Revoke => {
            restart_now(app, &target);
            restarts.restarted(&key, Instant::now());
        }
        Kind::Edit => {
            // A note saved every 800 ms must not restart a live session each time: one
            // restart, 30 s after the last edit (and never while a live answer runs).
            if restarts.edit_at(&key, Instant::now()) {
                spawn_waiter(app.clone(), target, restarts, key, restart::EDIT_QUIET);
            }
        }
        Kind::Grant => {
            let gap = restart::GRANT_COALESCE;
            match restarts.decide_gap(&key, Instant::now(), answering(&target), gap) {
                restart::Action::Now => {
                    restart_now(app, &target);
                    restarts.restarted(&key, Instant::now());
                }
                restart::Action::Later(wait) => {
                    // One waiter per meeting or chat. A grant that joins a wait for quiet
                    // takes the grant's rule; a revocation restarts at once and cancels it.
                    if restarts.mark_pending(&key, gap) {
                        spawn_waiter(app.clone(), target, restarts, key, wait);
                    }
                }
            }
        }
    }
}

/// The one waiter of a meeting or chat: looks again whenever woken or after `wait`.
fn spawn_waiter(app: AppHandle, target: Target, restarts: Arc<restart::Restarts>, key: String, wait: std::time::Duration) {
    use std::time::Instant;
    tauri::async_runtime::spawn(async move {
        let wake = restarts.waker(&key);
        let mut wait = wait;
        loop {
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = wake.notified() => {}
            }
            match restarts.step(&key, Instant::now(), answering(&target)) {
                restart::Step::Cancelled => break,
                restart::Step::Restart => {
                    restart_now(&app, &target);
                    restarts.restarted(&key, Instant::now());
                    break;
                }
                restart::Step::Sleep(next) => wait = next,
            }
        }
    });
}

/// THE way to change workspace data. `touched` says what the change reaches
/// (read before and after, so a revoked link is seen by the first read and a
/// granted one by the second); `change` does it. Each dependent's restart is a
/// revocation or a grant by comparing what it could use before and after (see
/// [`decisions`]), never by what the caller says. Nothing outside this module
/// decides which sessions restart.
pub(crate) fn change_and_restart<T>(
    state: &AppState,
    app: &AppHandle,
    touched: impl Fn(&Connection) -> Touch,
    change: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let before = begin_change(state, &touched);
    let result = change();
    finish_change(state, app, &touched, before, result.is_ok());
    result
}

/// [`change_and_restart`] for a change that has to wait (a blocking job).
pub(crate) async fn change_and_restart_async<T, F>(
    state: &AppState,
    app: &AppHandle,
    touched: impl Fn(&Connection) -> Touch,
    change: F,
) -> Result<T, String>
where
    F: std::future::Future<Output = Result<T, String>>,
{
    let before = begin_change(state, &touched);
    let result = change.await;
    finish_change(state, app, &touched, before, result.is_ok());
    result
}

// ── Workspaces ───────────────────────────────────────────────────────────────

#[command]
pub async fn get_workspaces_status(state: State<'_, AppState>) -> Result<WorkspacesStatus, String> {
    Ok(WorkspacesStatus {
        available: crate::workspace::available(),
        error: crate::workspace::last_error(),
        db: state.db_problem.clone(),
    })
}

#[command]
pub async fn list_workspaces(state: State<'_, AppState>) -> Result<Vec<WorkspaceSummary>, String> {
    with_reader(&state, store::list_summaries)
}

#[command]
pub async fn get_workspace(id: String, state: State<'_, AppState>) -> Result<WorkspaceDetail, String> {
    detail_of(&state, &id)
}

#[command]
pub async fn create_workspace(
    input: CreateWorkspaceInput,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<WorkspaceDetail, String> {
    let ws = change_and_restart(&state, &app, |_| Touch::none(), || {
        with_conn(&state, |conn| store::create_workspace(conn, input))
    })?;
    emit_changed(&app, Some(&ws.id));
    detail_of(&state, &ws.id)
}

/// Whether a patch changes what answers can use: the instructions, General, or
/// keeping the workspace separate, and only when the value really changes.
pub(crate) fn workspace_patch_matters(current: &Workspace, patch: &WorkspacePatch) -> bool {
    patch.instructions.as_ref().is_some_and(|v| *v != current.instructions)
        || patch.include_general.is_some_and(|v| v != current.include_general)
        || patch.keep_separate.is_some_and(|v| v != current.keep_separate)
}

/// What an item patch touches: nothing for a label or pin; the workspace for an
/// index opt-in change; and an opt-out (`index_opt_in: false`) is declared as a
/// revocation, so it restarts at once even if the views looked the same.
pub(crate) fn item_touch(workspace_id: &str, patch: &ItemPatch) -> Touch {
    let touch = Touch::ws_if(item_patch_matters(patch), workspace_id);
    if patch.index_opt_in == Some(false) { touch.revoking() } else { touch }
}

/// Whether an item patch changes what answers can use: the folder index opt-in.
/// A label or a pin never does.
pub(crate) fn item_patch_matters(patch: &ItemPatch) -> bool {
    patch.index_opt_in.is_some()
}

#[command]
pub async fn update_workspace(
    id: String,
    patch: WorkspacePatch,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<WorkspaceDetail, String> {
    // A name, colour, description, default scenario, recaps or memory switch, pin
    // or brief switch is cosmetic: it never touches a running session.
    let matters = with_conn(&state, |conn| store::get_workspace(conn, &id)).map_or(true, |cur| workspace_patch_matters(&cur, &patch));
    change_and_restart(&state, &app, |_| Touch::ws_if(matters, &id), || {
        with_conn(&state, |conn| store::update_workspace(conn, &id, patch).map(|_| ()))
    })?;
    // Cosmetic for sessions, but the brief switch and memory suggestions reach
    // the live runtimes at once (off stops the run and clears the sheet).
    poke_live(&state, &id);
    emit_changed(&app, Some(&id));
    detail_of(&state, &id)
}

#[command]
pub async fn clone_workspace(
    id: String,
    name: String,
    new_id: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<WorkspaceDetail, String> {
    let copy = change_and_restart(&state, &app, |_| Touch::none(), || {
        with_conn(&state, |conn| store::clone_workspace(conn, &id, &name, new_id))
    })?;
    emit_changed(&app, Some(&copy.id));
    detail_of(&state, &copy.id)
}

#[command]
pub async fn archive_workspace(id: String, archived: bool, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    change_and_restart(&state, &app, |_| Touch::ws(&id), || {
        with_conn(&state, |conn| store::archive_workspace(conn, &id, archived).map(|_| ()))
    })?;
    emit_changed(&app, Some(&id));
    Ok(())
}

#[command]
pub async fn delete_workspace(id: String, mode: DeleteMode, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    if let Some(live) = live_meeting_id(&state) {
        let home = with_conn(&state, |conn| store::home_of(conn, &live)).unwrap_or(None);
        if home.as_deref() == Some(id.as_str()) {
            return Err("A meeting is running in this workspace. End it first".to_string());
        }
    }
    // The workspace's own meetings (they move or go) and everything that used
    // its material (by borrowing, by including General) or chatted in it.
    let touched = |conn: &Connection| {
        let own: Vec<String> = conn
            .prepare("SELECT id FROM meetings WHERE workspace_id = ?1")
            .and_then(|mut stmt| stmt.query_map(rusqlite::params![id], |row| row.get::<_, String>(0)).map(|r| r.filter_map(Result::ok).collect()))
            .unwrap_or_default();
        own.iter().fold(Touch::ws(&id), |t, m| t.also(Touch::meeting(m)))
    };
    // Meetings that are about to go stop their notes and brief first and save nothing.
    if mode == DeleteMode::Delete {
        if let (Some(rt), Ok(own)) = (crate::live_runtime::global(), with_conn(&state, |conn| Ok(meeting_ids_of(conn, &id)))) {
            for m in own {
                rt.meeting_deleted(&m);
            }
        }
    }
    // Rows, cached data and recording files go: off the async runtime's threads.
    let deleted = tokio::task::block_in_place(|| {
        change_and_restart(&state, &app, touched, || {
            with_conn(&state, |conn| store::delete_workspace(conn, &id, mode))
        })
    })?;
    if let Some(dir) = purge::recordings_dir() {
        tokio::task::block_in_place(|| purge::delete_files_inside(&dir, &deleted.files));
    }
    emit_changed(&app, None);
    emit_memory(&app, &id);
    Ok(())
}

/// Each meeting in its own transaction, then its recording files (only inside
/// NexQ's recordings folder). A failure is reported and the next meeting goes on.
fn delete_meetings_blocking(
    db: &std::sync::Arc<std::sync::Mutex<crate::db::DatabaseManager>>,
    ids: &[String],
    running: Option<&str>,
) -> DeleteMeetingsReport {
    let mut report = DeleteMeetingsReport { deleted: 0, failed: Vec::new() };
    for meeting in ids {
        if running == Some(meeting.as_str()) {
            report.failed.push(FailedMeeting { id: meeting.clone(), reason: "This meeting is running. End it first".to_string() });
            continue;
        }
        let purged = db
            .lock()
            .map_err(|e| format!("Failed to lock database: {e}"))
            .and_then(|guard| {
                let tx = guard.connection().unchecked_transaction().map_err(|e| e.to_string())?;
                let files = purge::purge_meeting(&tx, meeting)?;
                tx.commit().map_err(|e| e.to_string())?;
                Ok(files)
            });
        match purged {
            Ok(files) => {
                if let Some(dir) = purge::recordings_dir() {
                    purge::delete_files_inside(&dir, &files);
                }
                report.deleted += 1;
            }
            Err(reason) => report.failed.push(FailedMeeting { id: meeting.clone(), reason }),
        }
    }
    report
}

/// Deletes every meeting of a workspace, one at a time and each in its own
/// transaction (rows, cached data and recordings on disk), so a failure or an
/// interruption leaves the others done and the rest untouched. The running
/// meeting is refused and reported, not deleted.
#[command]
pub async fn delete_workspace_meetings(id: String, state: State<'_, AppState>, app: AppHandle) -> Result<DeleteMeetingsReport, String> {
    let ids: Vec<String> = with_conn(&state, |conn| {
        let mut stmt = conn
            .prepare("SELECT id FROM meetings WHERE workspace_id = ?1 ORDER BY start_time")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map(rusqlite::params![id], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
        Ok(rows.filter_map(Result::ok).collect())
    })?;
    let running = live_meeting_id(&state);
    let db = state.database.clone().ok_or_else(|| "Database not initialized".to_string())?;
    let touched = |_: &Connection| ids.iter().fold(Touch::ws(&id), |t, m| t.also(Touch::meeting(m)));
    // Their notes and brief stop first and save nothing (the running meeting is refused below).
    if let Some(rt) = crate::live_runtime::global() {
        for m in ids.iter().filter(|m| running.as_deref() != Some(m.as_str())) {
            rt.meeting_deleted(m);
        }
    }
    // The purges and the files on disk take a while: not on the async runtime's threads.
    // Started only once the change has begun (access revoked first), not before.
    let job = {
        let ids = ids.clone();
        async move {
            tauri::async_runtime::spawn_blocking(move || delete_meetings_blocking(&db, &ids, running.as_deref()))
                .await
                .map_err(|e| format!("The deletion was interrupted: {e}"))
        }
    };
    let report = change_and_restart_async(&state, &app, touched, job).await?;
    emit_changed(&app, Some(&id));
    Ok(report)
}

#[command]
pub async fn set_default_workspace(id: String, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    change_and_restart(&state, &app, |_| Touch::none(), || with_conn(&state, |conn| store::set_default_workspace(conn, &id)))?;
    emit_changed(&app, None);
    Ok(())
}

#[command]
pub async fn reorder_workspaces(ids: Vec<String>, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    change_and_restart(&state, &app, |_| Touch::none(), || with_conn(&state, |conn| store::reorder_workspaces(conn, &ids)))?;
    emit_changed(&app, None);
    Ok(())
}

// ── Items and the library ────────────────────────────────────────────────────

#[command]
pub async fn add_workspace_item(
    id: String,
    kind: ItemKind,
    ref_id: String,
    label: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let configured = state.personal_sources.read().map(|c| sources_seed::is_configured(&c, kind, &ref_id)).unwrap_or(false);
    if !configured {
        return Err("This item is no longer in your sources".to_string());
    }
    change_and_restart(&state, &app, |_| Touch::ws(&id), || {
        with_conn(&state, |conn| store::add_item(conn, &id, kind, &ref_id, label.as_deref()))
    })?;
    emit_changed(&app, Some(&id));
    Ok(())
}

/// Changes an item that is in the workspace; an item that is not fails with
/// `not_found` (it may have been removed meanwhile) and is never created.
#[command]
pub async fn update_workspace_item(
    id: String,
    kind: ItemKind,
    ref_id: String,
    patch: ItemPatch,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let touch = item_touch(&id, &patch);
    change_and_restart(&state, &app, |_| touch.clone(), || {
        with_conn(&state, |conn| store::update_item(conn, &id, kind, &ref_id, patch))
    })?;
    crate::workspace_chat::runtime::folder_opt_out_check(&state, kind == ItemKind::Folder, &ref_id);
    emit_changed(&app, Some(&id));
    Ok(())
}

#[command]
pub async fn remove_workspace_item(
    id: String,
    kind: ItemKind,
    ref_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    change_and_restart(&state, &app, |_| Touch::ws(&id), || {
        with_conn(&state, |conn| store::remove_item(conn, &id, kind, &ref_id))
    })?;
    crate::workspace_chat::runtime::folder_opt_out_check(&state, kind == ItemKind::Folder, &ref_id);
    emit_changed(&app, Some(&id));
    Ok(())
}

/// The workspaces that point to a library item.
pub(crate) fn holders_of(conn: &Connection, kind: ItemKind, ref_id: &str) -> Touch {
    let ids: Vec<String> = conn
        .prepare("SELECT workspace_id FROM workspace_items WHERE kind = ?1 AND ref_id = ?2")
        .and_then(|mut stmt| {
            stmt.query_map(rusqlite::params![kind.as_str(), ref_id], |row| row.get::<_, String>(0)).map(|r| r.filter_map(Result::ok).collect())
        })
        .unwrap_or_default();
    ids.iter().fold(Touch::none(), |t, w| t.also(Touch::ws(w)))
}

/// The user removed a folder or server (after the new config was saved with
/// `set_personal_sources`): it leaves every workspace. Documents leave through
/// `remove_context_file`. Refused while the item is still in the saved sources.
#[command]
pub async fn remove_library_item(
    kind: ItemKind,
    ref_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let cfg = state.personal_sources.read().map(|c| c.clone()).unwrap_or_default();
    change_and_restart(&state, &app, |conn| holders_of(conn, kind, &ref_id), || {
        with_conn(&state, |conn| sources_seed::remove_item_everywhere(conn, &cfg, kind, &ref_id))
    })?;
    emit_changed(&app, None);
    Ok(())
}

#[command]
pub async fn list_library(state: State<'_, AppState>) -> Result<Vec<LibraryItem>, String> {
    let members = with_conn(&state, store::memberships)?;
    Ok(library::library_items(&members, &snapshot(&state)))
}

/// Saves Markdown as a document of the library and files it in `id`; returns
/// the document's id.
#[command]
pub async fn add_workspace_text(
    id: String,
    title: String,
    markdown: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    tokio::task::block_in_place(|| {
        change_and_restart(&state, &app, |_| Touch::ws(&id), || {
            with_conn(&state, |conn| store::get_workspace(conn, &id).map(|_| ()))?;
            let resource = {
                let ctx = state.context.as_ref().ok_or_else(|| "Context manager not initialized".to_string())?;
                let mut ctx = ctx.lock().map_err(|e| format!("Failed to lock context manager: {e}"))?;
                ctx.add_text(&title, &markdown)?
            };
            let saved = with_conn(&state, |conn| documents::add_document(conn, &resource, &markdown, Some(&id)));
            if let Err(e) = saved {
                // Don't leave a document the database doesn't know.
                if let Some(ctx) = state.context.as_ref() {
                    if let Ok(mut ctx) = ctx.lock() {
                        let _ = ctx.remove_file(&resource.id);
                    }
                }
                return Err(e);
            }
            Ok(resource.id)
        })
    })
    .inspect(|_| {
        crate::workspace_chat::runtime::documents_changed(&state.workspace_chat);
        emit_changed(&app, Some(&id));
    })
}

// ── Meetings ─────────────────────────────────────────────────────────────────

/// What moving a meeting touches: the meeting, the chats of the workspace it is
/// filed in at this moment (read before the move: the one it leaves; after: the
/// one it joins), and the chats of the destination.
pub(crate) fn move_touch(conn: &Connection, meeting_id: &str, destination: &str) -> Touch {
    let touch = Touch::meeting(meeting_id).also(Touch::chats(destination));
    match store::home_of(conn, meeting_id) {
        Ok(Some(home)) => touch.also(Touch::chats(&home)),
        _ => touch,
    }
}

/// What deleting a meeting touches: the meeting and the chats of its workspace.
pub(crate) fn delete_touch(conn: &Connection, meeting_id: &str) -> Touch {
    let touch = Touch::meeting(meeting_id);
    match store::home_of(conn, meeting_id) {
        Ok(Some(home)) => touch.also(Touch::chats(&home)),
        _ => touch,
    }
}

#[command]
pub async fn move_meeting(meeting_id: String, workspace_id: String, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    // The meeting's own sessions, and the chats of the workspace it leaves (read
    // before the change) and of the one it joins (read after): the meeting
    // leaves the first chats' meetings, which is a revocation for them.
    let touched = |conn: &Connection| move_touch(conn, &meeting_id, &workspace_id);
    change_and_restart(&state, &app, touched, || {
        with_conn(&state, |conn| meetings::move_meeting_atomic(conn, &meeting_id, &workspace_id))
    })?;
    emit_changed(&app, None);
    Ok(())
}

#[command]
pub async fn list_workspace_meetings(
    id: String,
    query: Option<String>,
    limit: u32,
    offset: u32,
    state: State<'_, AppState>,
) -> Result<WorkspaceMeetingPage, String> {
    with_reader(&state, |conn| meetings::list_workspace_meetings(conn, &id, query.as_deref(), limit, offset))
}

#[command]
pub async fn get_meeting_scope(meeting_id: String, state: State<'_, AppState>) -> Result<MeetingScope, String> {
    with_reader(&state, |conn| meetings::get_meeting_scope(conn, &meeting_id))
}

#[command]
pub async fn set_meeting_scope(
    meeting_id: String,
    borrowed: Vec<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<MeetingScope, String> {
    let scope = change_and_restart(&state, &app, |_| Touch::meeting(&meeting_id), || {
        with_conn(&state, |conn| meetings::set_meeting_scope(conn, &meeting_id, &borrowed))
    })?;
    emit_changed(&app, Some(&scope.home));
    Ok(scope)
}

// ── Showing a library file ───────────────────────────────────────────────────

/// The real path of `sub_path` below a saved folder: the folder must be
/// enabled and in at least one workspace, and the result must stay inside the
/// folder's real root (see `workspace::reveal`).
fn library_file_path(state: &AppState, folder_id: &str, sub_path: Option<&str>) -> Result<std::path::PathBuf, String> {
    let folder = state
        .personal_sources
        .read()
        .map_err(|_| "Couldn't read your sources".to_string())?
        .notes_folders
        .iter()
        .find(|f| f.id == folder_id)
        .cloned()
        .ok_or_else(|| "This folder is no longer in your sources".to_string())?;
    if !folder.enabled {
        return Err("This folder is switched off".to_string());
    }
    let filed = with_conn(state, |conn| Ok(!holders_of(conn, ItemKind::Folder, folder_id).workspaces.is_empty()))?;
    if !filed {
        return Err("This folder is not in any workspace".to_string());
    }
    crate::workspace::reveal::resolve_in_folder(std::path::Path::new(&folder.path), sub_path.unwrap_or(""))
}

/// The path of a file of a library folder as the user knows it, after the
/// same checks as `reveal_library_file`.
#[command]
pub async fn get_library_file_path(folder_id: String, sub_path: Option<String>, state: State<'_, AppState>) -> Result<String, String> {
    library_file_path(&state, &folder_id, sub_path.as_deref()).map(|p| crate::workspace::reveal::display_path(&p))
}

/// Shows a file of a library folder in the file manager (selected; never
/// opened or run).
#[command]
pub async fn reveal_library_file(folder_id: String, sub_path: Option<String>, state: State<'_, AppState>) -> Result<(), String> {
    let path = library_file_path(&state, &folder_id, sub_path.as_deref())?;
    crate::workspace::reveal::reveal(&path)
}

// ── Talking points ───────────────────────────────────────────────────────────

/// A talking point's workspace when it is used as AI context.
fn context_point(conn: &Connection, id: &str) -> Touch {
    match talking_points::get_talking_point(conn, id) {
        Ok(Some(p)) => Touch::ws_if(p.in_context, &p.workspace_id),
        _ => Touch::none(),
    }
}

#[command]
pub async fn list_talking_points(workspace_id: String, state: State<'_, AppState>) -> Result<Vec<TalkingPoint>, String> {
    with_reader(&state, |conn| talking_points::list_talking_points(conn, &workspace_id))
}

/// A new talking point with a new id, created whole in one step: `content`
/// carries the document, Markdown, plain text and `in_context` (required, no
/// default).
#[command]
pub async fn create_talking_point(
    workspace_id: String,
    title: Option<String>,
    content: TalkingContent,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<TalkingPoint, String> {
    // A point made as AI context with text in it reaches the sessions.
    let has_text = [&content.doc_json, &content.markdown, &content.plain_text]
        .iter()
        .any(|t| t.as_deref().is_some_and(|t| !t.trim().is_empty() && t.trim() != "{}"));
    let feeds_context = content.in_context && has_text;
    let point = change_and_restart(&state, &app, |_| Touch::ws_if(feeds_context, &workspace_id), || {
        with_conn(&state, |conn| talking_points::create_talking_point(conn, &workspace_id, title, content))
    })?;
    crate::workspace_chat::runtime::talking_points_changed(&state.workspace_chat);
    emit_changed(&app, Some(&point.workspace_id));
    Ok(point)
}

/// Changes the fields present of a point that exists: `not_found` when it was
/// deleted, `conflict` when a content change is made on a version older than
/// `expected_updated_at` (the `updated_at` of the row in `list_talking_points`). `in_context`
/// changes only when present; the sessions restart whenever the old or the new
/// value is "use as AI context".
#[command]
pub async fn patch_talking_point(
    id: String,
    patch: TalkingPointPatch,
    expected_updated_at: Option<i64>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<TalkingPoint, String> {
    let point = change_and_restart(&state, &app, |conn| context_point(conn, &id), || {
        with_conn(&state, |conn| talking_points::patch_talking_point(conn, &id, patch, expected_updated_at))
    })?;
    crate::workspace_chat::runtime::talking_points_changed(&state.workspace_chat);
    emit_changed(&app, Some(&point.workspace_id));
    Ok(point)
}

#[command]
pub async fn delete_talking_point(id: String, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    let workspace = with_conn(&state, |conn| Ok(talking_points::get_talking_point(conn, &id)?.map(|p| p.workspace_id))).unwrap_or(None);
    change_and_restart(&state, &app, |conn| context_point(conn, &id), || {
        with_conn(&state, |conn| talking_points::delete_talking_point(conn, &id))
    })?;
    crate::workspace_chat::runtime::talking_points_changed(&state.workspace_chat);
    emit_changed(&app, workspace.as_deref());
    Ok(())
}

#[command]
pub async fn copy_talking_point(id: String, workspace_id: String, state: State<'_, AppState>, app: AppHandle) -> Result<TalkingPoint, String> {
    let touched = |conn: &Connection| {
        let flagged = matches!(talking_points::get_talking_point(conn, &id), Ok(Some(p)) if p.in_context);
        Touch::ws_if(flagged, &workspace_id)
    };
    let copy = change_and_restart(&state, &app, touched, || {
        with_conn(&state, |conn| talking_points::copy_talking_point(conn, &id, &workspace_id))
    })?;
    emit_changed(&app, Some(&workspace_id));
    Ok(copy)
}

#[command]
pub async fn reorder_talking_points(workspace_id: String, ids: Vec<String>, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    change_and_restart(&state, &app, |_| Touch::none(), || {
        with_conn(&state, |conn| talking_points::reorder_talking_points(conn, &workspace_id, &ids))
    })?;
    emit_changed(&app, Some(&workspace_id));
    Ok(())
}

#[command]
pub async fn get_point_progress(meeting_id: String, point_id: String, state: State<'_, AppState>) -> Result<Option<PointProgress>, String> {
    with_reader(&state, |conn| talking_points::get_point_progress(conn, &meeting_id, &point_id))
}

/// What was said is the user's own record: no session sees it.
#[command]
pub async fn save_point_progress(
    meeting_id: String,
    point_id: String,
    said: Vec<PointSaid>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    change_and_restart(&state, &app, |_| Touch::none(), || {
        with_conn(&state, |conn| talking_points::save_point_progress(conn, &meeting_id, &point_id, &said))
    })
}

#[command]
pub async fn get_meeting_point_edit(meeting_id: String, point_id: String, state: State<'_, AppState>) -> Result<Option<String>, String> {
    with_conn(&state, |conn| talking_points::get_meeting_point_edit(conn, &meeting_id, &point_id))
}

#[command]
pub async fn save_meeting_point_edit(
    meeting_id: String,
    point_id: String,
    doc: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    // This meeting's own version of a context note is in its sessions' context.
    let touched = |conn: &Connection| {
        let in_scope = scope::scope_for(conn, crate::workspace::ScopeOwner::Meeting(&meeting_id))
            .map(|s| s.talking_point_ids.contains(&point_id))
            .unwrap_or(false);
        if in_scope { Touch::meeting(&meeting_id) } else { Touch::none() }
    };
    change_and_restart(&state, &app, touched, || {
        with_conn(&state, |conn| talking_points::save_meeting_point_edit(conn, &meeting_id, &point_id, doc.as_deref()))
    })
}

// ── Memory ───────────────────────────────────────────────────────────────────

/// A memory item's workspace (memory reaches the chats and the live answers of its scope).
fn memory_chats(conn: &Connection, id: &str) -> Touch {
    match memory::get_memory(conn, id) {
        Ok(Some(m)) => Touch::ws(&m.workspace_id),
        _ => Touch::none(),
    }
}

#[command]
pub async fn list_memory(workspace_id: String, state: State<'_, AppState>) -> Result<Vec<MemoryItem>, String> {
    with_reader(&state, |conn| memory::list_memory(conn, &workspace_id))
}

/// A new memory item under a new id.
#[command]
pub async fn create_memory(input: MemoryCreate, state: State<'_, AppState>, app: AppHandle) -> Result<MemoryItem, String> {
    let ws = input.workspace_id.clone();
    let item = change_and_restart(&state, &app, |_| Touch::ws(&ws), || {
        with_conn(&state, |conn| memory::create_memory(conn, input))
    })?;
    emit_memory(&app, &item.workspace_id);
    Ok(item)
}

/// Changes an item that exists; a forgotten id fails with `not_found`.
#[command]
pub async fn update_memory(id: String, patch: MemoryUpdate, state: State<'_, AppState>, app: AppHandle) -> Result<MemoryItem, String> {
    let item = change_and_restart(&state, &app, |conn| memory_chats(conn, &id), || {
        with_conn(&state, |conn| memory::update_memory(conn, &id, patch))
    })?;
    emit_memory(&app, &item.workspace_id);
    Ok(item)
}

#[command]
pub async fn delete_memory(id: String, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    let workspace = with_conn(&state, |conn| Ok(memory::get_memory(conn, &id)?.map(|m| m.workspace_id))).unwrap_or(None);
    change_and_restart(&state, &app, |conn| memory_chats(conn, &id), || {
        with_conn(&state, |conn| memory::delete_memory(conn, &id))
    })?;
    if let Some(ws) = workspace {
        emit_memory(&app, &ws);
    }
    Ok(())
}

#[command]
pub async fn resolve_memory(
    id: String,
    action: String,
    patch: Option<MemoryPatch>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let item = change_and_restart(&state, &app, |conn| memory_chats(conn, &id), || {
        with_conn(&state, |conn| memory::resolve_memory(conn, &id, &action, patch))
    })?;
    emit_memory(&app, &item.workspace_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    //! Every command that changes data must go through `change_and_restart`.
    //! The two lists below are compared with the commands of the files: a new
    //! command that is in neither list, or a mutating one that does not call
    //! the helper, fails here.

    use super::*;
    use crate::workspace::access::AccessView;

    /// (source file, its text without the tests, the mutating commands in it)
    fn files() -> Vec<(&'static str, String, &'static [&'static str])> {
        fn code(text: &str) -> String {
            text.split("#[cfg(test)]").next().unwrap_or(text).to_string()
        }
        vec![
            ("workspace_commands.rs", code(include_str!("workspace_commands.rs")), MUTATING),
            ("context_commands.rs", code(include_str!("context_commands.rs")), &["load_context_file", "remove_context_file"]),
            ("sources_commands.rs", code(include_str!("sources_commands.rs")), &["set_personal_sources"]),
            (
                "workspace_chat_commands.rs",
                code(include_str!("workspace_chat_commands.rs")),
                &["save_answer_to_library", "add_answer_to_instructions", "set_chat_meeting_included", "set_chat_item_pref"],
            ),
        ]
    }

    const MUTATING: &[&str] = &[
        "create_workspace", "update_workspace", "clone_workspace", "archive_workspace", "delete_workspace",
        "delete_workspace_meetings",
        "set_default_workspace", "reorder_workspaces", "add_workspace_item", "update_workspace_item",
        "remove_workspace_item", "remove_library_item", "add_workspace_text", "move_meeting", "set_meeting_scope",
        "create_talking_point", "patch_talking_point", "delete_talking_point", "copy_talking_point",
        "reorder_talking_points", "save_point_progress", "save_meeting_point_edit", "create_memory",
        "update_memory", "delete_memory", "resolve_memory",
    ];

    /// Commands that only read.
    const READ_ONLY: &[&str] = &[
        "get_workspaces_status", "list_workspaces", "get_workspace", "list_library", "list_workspace_meetings",
        "get_meeting_scope", "list_talking_points", "get_point_progress",
        "get_meeting_point_edit", "list_memory", "get_library_file_path", "reveal_library_file",
    ];

    /// The text of command `name`: from its `fn` to the next `#[command]`
    /// (or the end), or None when the file has no such command.
    fn body<'a>(code: &'a str, name: &str) -> Option<&'a str> {
        let start = code.find(&format!("fn {name}("))?;
        let rest = &code[start..];
        let end = rest[1..].find("#[command]").map(|i| i + 1).unwrap_or(rest.len());
        Some(&rest[..end])
    }

    /// The names of the `#[command]` functions of `code`.
    fn commands(code: &str) -> Vec<String> {
        code.split("#[command]")
            .skip(1)
            .filter_map(|chunk| {
                let after = chunk.find("fn ")? + 3;
                let name: String = chunk[after..].chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
                Some(name)
            })
            .collect()
    }

    #[test]
    fn every_mutating_command_goes_through_change_and_restart() {
        for (file, code, mutating) in files() {
            for name in mutating {
                let text = body(&code, name).unwrap_or_else(|| panic!("{file}: no command {name}"));
                assert!(
                    text.contains("change_and_restart(") || text.contains("change_and_restart_async("),
                    "{file}: {name} changes data but does not use change_and_restart"
                );
            }
        }
    }

    #[test]
    fn every_command_of_the_workspace_file_is_classified() {
        let (_, code, _) = files().remove(0);
        for name in commands(&code) {
            assert!(
                MUTATING.contains(&name.as_str()) || READ_ONLY.contains(&name.as_str()),
                "{name} is new: add it to MUTATING (and use change_and_restart) or to READ_ONLY"
            );
        }
        // And the lists name real commands.
        let found = commands(&code);
        for name in MUTATING.iter().chain(READ_ONLY) {
            assert!(found.iter().any(|f| f == name), "{name} is listed but is not a command");
        }
    }

    #[test]
    fn a_command_that_reads_never_calls_the_helper_and_a_mutating_one_registered_in_lib_is_known() {
        let (_, code, _) = files().remove(0);
        for name in READ_ONLY {
            assert!(!body(&code, name).unwrap().contains("change_and_restart("), "{name} only reads");
        }
        // Every mutating command is registered, so none can be reached unclassified.
        let lib = include_str!("../lib.rs");
        for name in MUTATING {
            assert!(lib.contains(&format!("workspace_commands::{name},")), "{name} is not registered in lib.rs");
        }
    }

    fn view(items: &[&str], memory: &[&str]) -> AccessView {
        AccessView {
            material: ["general".to_string()].into_iter().collect(),
            items: items.iter().map(|s| s.to_string()).collect(),
            memory: memory.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn a_change_is_a_revocation_exactly_when_something_a_dependent_had_is_gone() {
        let m = |id: &str| Target::Meeting(id.into());
        let p = |v: AccessView| ViewState::Present(v);
        let before: BTreeMap<Target, ViewState> =
            [(m("a"), p(view(&["document:d1"], &["mem1"]))), (m("b"), p(view(&["document:d1"], &[]))), (m("c"), p(view(&[], &[])))].into();
        let after: BTreeMap<Target, ViewState> = [
            (m("a"), p(view(&["document:d1"], &[]))),                // memory forgotten
            (m("b"), p(view(&["document:d1", "document:d2"], &[]))), // a document added
            (m("c"), p(view(&["folder:f"], &[]))),                   // new access
            (m("d"), p(view(&["document:d1"], &[]))),                // became a dependent
        ]
        .into();
        let kinds: BTreeMap<Target, Decision> = decisions(&before, &after, true).into_iter().collect();
        assert_eq!(kinds[&m("a")], Decision::Restart(Kind::Revoke));
        assert_eq!(kinds[&m("b")], Decision::Restart(Kind::Grant));
        assert_eq!(kinds[&m("c")], Decision::Restart(Kind::Grant));
        assert_eq!(kinds[&m("d")], Decision::Restart(Kind::Grant));
        // A change that failed part way restarts at once, whatever it was.
        assert!(decisions(&before, &after, false).iter().all(|(_, d)| *d == Decision::Restart(Kind::Revoke)));
    }

    #[test]
    fn the_union_of_before_and_after_is_decided_and_the_gone_are_closed_not_rewarmed() {
        let m = |id: &str| Target::Meeting(id.into());
        let c = |id: &str| Target::Chat(id.into());
        let p = |v: AccessView| ViewState::Present(v);
        let before: BTreeMap<Target, ViewState> = [(m("a"), p(view(&[], &[]))), (m("b"), p(view(&[], &[]))), (c("x"), p(view(&[], &[])))].into();
        // a was deleted; b can't be read; x is not read at all after (it fell out of the list)
        let after: BTreeMap<Target, ViewState> = [(m("a"), ViewState::Gone), (m("b"), ViewState::Unreadable)].into();
        let d: BTreeMap<Target, Decision> = decisions(&before, &after, true).into_iter().collect();
        assert_eq!(d[&m("a")], Decision::Close);
        assert_eq!(d[&m("b")], Decision::Restart(Kind::Revoke));
        assert_eq!(d[&c("x")], Decision::Close, "no view after means closed, not forgotten");
        // a dependent whose view before was unreadable or gone is a revocation
        let before2: BTreeMap<Target, ViewState> = [(m("a"), ViewState::Unreadable), (m("b"), ViewState::Gone)].into();
        let after2: BTreeMap<Target, ViewState> = [(m("a"), p(view(&[], &[]))), (m("b"), p(view(&[], &[])))].into();
        assert!(decisions(&before2, &after2, true).iter().all(|(_, d)| *d == Decision::Restart(Kind::Revoke)));
    }

    #[test]
    fn a_content_edit_is_an_edit_not_a_grant_and_not_a_revocation() {
        let m = Target::Meeting("a".into());
        let mut was = view(&["talking_point:p"], &[]);
        was.hashes.insert("tp:p".into(), 1);
        let mut now = was.clone();
        now.hashes.insert("tp:p".into(), 2);
        let before: BTreeMap<Target, ViewState> = [(m.clone(), ViewState::Present(was))].into();
        let after: BTreeMap<Target, ViewState> = [(m.clone(), ViewState::Present(now))].into();
        assert_eq!(decisions(&before, &after, true)[0].1, Decision::Restart(Kind::Edit));
    }

    #[test]
    fn only_a_change_to_instructions_general_or_separation_restarts_for_a_workspace_edit() {
        let conn = crate::workspace::test_support::memory_db();
        let ws = store::get_workspace(&conn, "general").unwrap();
        let ws = Workspace { id: "w".into(), include_general: true, keep_separate: false, instructions: "be brief".into(), ..ws };
        let patch = |json: &str| serde_json::from_str::<WorkspacePatch>(json).unwrap();
        // Cosmetic: never.
        for json in [
            r#"{"name":"New name"}"#,
            r##"{"color":"#123456"}"##,
            r#"{"description":"d"}"#,
            r#"{"default_scenario":null}"#,
            r#"{"recaps_with_ai":true}"#,
            r#"{"suggest_memory":true}"#,
            r#"{"pinned":true}"#,
            r#"{"brief_enabled":true}"#,
            r#"{"instructions":"be brief"}"#,
            r#"{"include_general":true}"#,
            r#"{"keep_separate":false}"#,
        ] {
            assert!(!workspace_patch_matters(&ws, &patch(json)), "{json} is cosmetic");
        }
        for json in [r#"{"instructions":"be long"}"#, r#"{"include_general":false}"#, r#"{"keep_separate":true}"#] {
            assert!(workspace_patch_matters(&ws, &patch(json)), "{json} changes access");
        }
        assert!(!item_patch_matters(&ItemPatch { pinned: Some(true), label: Some(Some("x".into())), ..Default::default() }));
        assert!(item_patch_matters(&ItemPatch { index_opt_in: Some(false), ..Default::default() }));
    }

    /// The live commands change no material (settings, start/stop, suggestions
    /// that no prompt reads until the user saves them). Each is listed, so a new
    /// one must be classified; one that changed material would have to be moved
    /// to `MUTATING` of its own file and use `change_and_restart`.
    const LIVE_NO_MATERIAL: &[&str] = &[
        "notetaker_start", "notetaker_stop", "notetaker_update_now", "notetaker_continue", "get_notetaker_settings",
        "set_notetaker_settings", "get_meeting_notes", "save_meeting_notes_edit", "get_meeting_brief", "brief_start",
        "brief_stop", "brief_refresh", "brief_continue", "get_brief_settings", "set_brief_settings",
        "get_memory_settings", "set_memory_settings", "suggest_memory", "notetaker_pause", "notetaker_resume",
        "get_notetaker_state", "get_brief_state", "get_automatic_model", "brief_pause", "brief_resume",
    ];

    #[test]
    fn every_live_command_is_classified_and_registered() {
        let code = include_str!("live_commands.rs").split("#[cfg(test)]").next().unwrap().to_string();
        let found = commands(&code);
        for name in &found {
            assert!(LIVE_NO_MATERIAL.contains(&name.as_str()), "{name} is new: classify it (does it change material?)");
        }
        let lib = include_str!("../lib.rs");
        for name in LIVE_NO_MATERIAL {
            assert!(found.iter().any(|f| f == name), "{name} is listed but is not a command");
            assert!(lib.contains(&format!("live_commands::{name},")), "{name} is not registered in lib.rs");
        }
    }

    // ── every write path of the other command files, classified ───────────────

    #[derive(Clone, Copy)]
    enum Rule {
        /// Changes what a scope may use: must go through `change_and_restart`.
        Must,
        /// Only reads.
        Read,
        /// Writes, but not what a scope may use; the reason is the audit.
        Exempt(&'static str),
    }
    use Rule::{Exempt, Must, Read};

    /// (file, command, rule) for every command of the files below.
    const OTHER_COMMANDS: &[(&str, &str, Rule)] = &[
        ("meeting_commands", "retry_sources_session", Exempt("restarts sessions of the sources, changes no data")),
        ("meeting_commands", "start_past_meeting_session", Exempt("session of a view")),
        ("meeting_commands", "close_past_meeting_session", Exempt("session of a view")),
        ("meeting_commands", "save_meeting_ai_interactions", Exempt("the meeting's own log")),
        ("meeting_commands", "start_meeting", Exempt("a new meeting has no session to restart")),
        ("meeting_commands", "end_meeting", Exempt("ends the meeting's own sessions itself")),
        ("meeting_commands", "list_meetings", Read),
        ("meeting_commands", "get_meeting", Read),
        ("meeting_commands", "delete_meeting", Must),
        ("meeting_commands", "search_meetings", Read),
        ("meeting_commands", "rename_meeting", Exempt("the meeting's own title")),
        ("meeting_commands", "update_meeting_summary", Exempt("the meeting's own text, read when a request is built")),
        ("meeting_commands", "append_transcript_segment", Exempt("the live transcript itself")),
        ("meeting_commands", "save_meeting_speakers", Exempt("the meeting's own content")),
        ("meeting_commands", "save_meeting_bookmarks", Exempt("the meeting's own content")),
        ("meeting_commands", "add_meeting_bookmark", Exempt("the meeting's own content")),
        ("meeting_commands", "update_meeting_bookmark", Exempt("the meeting's own content")),
        ("meeting_commands", "delete_meeting_bookmark", Exempt("the meeting's own content")),
        ("meeting_commands", "save_meeting_action_items", Exempt("the meeting's own content")),
        ("meeting_commands", "update_action_item", Exempt("the meeting's own content")),
        ("meeting_commands", "delete_action_item", Exempt("the meeting's own content")),
        ("meeting_commands", "save_meeting_topic_sections", Exempt("the meeting's own content")),
        ("meeting_commands", "update_meeting_mode", Exempt("audio mode and scenario of the meeting")),
        ("meeting_commands", "rename_speaker", Exempt("the meeting's own content")),
        ("context_commands", "load_context_file", Must),
        ("context_commands", "remove_context_file", Must),
        ("context_commands", "list_context_resources", Read),
        ("context_commands", "set_custom_instructions", Exempt("global instruction text, an edit for every meeting, not access")),
        ("context_commands", "get_token_budget", Read),
        ("sources_commands", "discard_pending_mcp_servers", Exempt("staged servers, not yet in any config")),
        ("sources_commands", "inspect_notes_folder", Read),
        ("sources_commands", "open_source_file", Read),
        ("sources_commands", "classify_secret_names", Read),
        ("sources_commands", "import_mcp_servers_json", Exempt("staged until set_personal_sources")),
        ("sources_commands", "list_claude_code_mcp_servers", Read),
        ("sources_commands", "import_claude_code_mcp_servers", Exempt("staged until set_personal_sources")),
        ("sources_commands", "save_mcp_server_form", Exempt("staged until set_personal_sources")),
        ("sources_commands", "check_mcp_server", Read),
        ("sources_commands", "delete_mcp_secrets", Exempt("secrets only; the sources restart follows their revision")),
        ("sources_commands", "set_personal_sources", Must),
        ("workspace_chat_commands", "get_index_status", Read),
        ("workspace_chat_commands", "get_meeting_recap", Read),
        ("workspace_chat_commands", "delete_meeting_recap", Exempt("a recap is derived text, not access to anything")),
        ("workspace_chat_commands", "rescan_workspace", Exempt("re-indexes what is already in scope")),
        ("workspace_chat_commands", "list_workspace_chats", Read),
        ("workspace_chat_commands", "create_workspace_chat", Exempt("a new chat has no session")),
        ("workspace_chat_commands", "update_workspace_chat", Must),
        ("workspace_chat_commands", "delete_workspace_chat", Exempt("ends the chat's own sessions in engine::delete_chat")),
        ("workspace_chat_commands", "list_workspace_messages", Read),
        ("workspace_chat_commands", "set_chat_meeting_included", Must),
        ("workspace_chat_commands", "list_chat_meeting_prefs", Read),
        ("workspace_chat_commands", "set_chat_item_pref", Must),
        ("workspace_chat_commands", "list_chat_item_prefs", Read),
        ("workspace_chat_commands", "preview_chat_context", Read),
        ("workspace_chat_commands", "get_chat_capabilities", Read),
        ("workspace_chat_commands", "ask_workspace", Exempt("a request, not a change of access")),
        ("workspace_chat_commands", "cancel_workspace_request", Exempt("stops a request")),
        ("workspace_chat_commands", "save_answer_to_library", Must),
        ("workspace_chat_commands", "add_answer_to_instructions", Must),
    ];

    fn other_sources() -> Vec<(&'static str, String)> {
        fn code(text: &str) -> String {
            text.split("#[cfg(test)]").next().unwrap_or(text).to_string()
        }
        vec![
            ("meeting_commands", code(include_str!("meeting_commands.rs"))),
            ("context_commands", code(include_str!("context_commands.rs"))),
            ("sources_commands", code(include_str!("sources_commands.rs"))),
            ("workspace_chat_commands", code(include_str!("workspace_chat_commands.rs"))),
        ]
    }

    #[test]
    fn every_command_of_the_other_files_is_classified_and_the_writers_use_the_helper() {
        for (file, code) in other_sources() {
            let found = commands(&code);
            for name in &found {
                assert!(
                    OTHER_COMMANDS.iter().any(|(f, n, _)| *f == file && n == name),
                    "{file}::{name} is a new command: classify it in OTHER_COMMANDS (Must, Read or Exempt with a reason)"
                );
            }
            for (f, name, _) in OTHER_COMMANDS.iter().filter(|(f, _, _)| *f == file) {
                assert!(found.iter().any(|c| c == name), "{f}::{name} is classified but is not a command");
            }
        }
        let sources = other_sources();
        for (file, name, rule) in OTHER_COMMANDS {
            let code = &sources.iter().find(|(f, _)| f == file).unwrap().1;
            let text = body(code, name).unwrap_or_else(|| panic!("{file}: no command {name}"));
            match rule {
                Must => assert!(
                    text.contains("change_and_restart(") || text.contains("change_and_restart_async("),
                    "{file}::{name} changes what a scope may use but does not use change_and_restart"
                ),
                Read => {}
                Exempt(reason) => assert!(!reason.trim().is_empty(), "{file}::{name} needs a reason"),
            }
        }
    }

    #[test]
    fn moving_or_deleting_a_meeting_touches_the_chats_of_both_workspaces() {
        let conn = crate::workspace::test_support::memory_db();
        let a = crate::workspace::test_support::new_ws(&conn, "A", false, false);
        let b = crate::workspace::test_support::new_ws(&conn, "B", false, false);
        conn.execute("INSERT INTO meetings (id, title, start_time, workspace_id) VALUES ('m', 't', 'x', ?1)", rusqlite::params![a]).unwrap();
        // Before the move the source is A: both chats are touched.
        let before = move_touch(&conn, "m", &b);
        assert!(before.meetings == vec!["m".to_string()]);
        assert!(before.chats_of.contains(&a) && before.chats_of.contains(&b), "{before:?}");
        // After it the source is B; the destination is still named, so A's chats were read before.
        conn.execute("UPDATE meetings SET workspace_id = ?1 WHERE id = 'm'", rusqlite::params![b]).unwrap();
        assert!(move_touch(&conn, "m", &b).chats_of.contains(&b));
        // Deleting reads the home while the meeting is there.
        conn.execute("UPDATE meetings SET workspace_id = ?1 WHERE id = 'm'", rusqlite::params![a]).unwrap();
        assert!(delete_touch(&conn, "m").chats_of.contains(&a));
        conn.execute("DELETE FROM meetings WHERE id = 'm'", []).unwrap();
        assert_eq!(delete_touch(&conn, "m").meetings, vec!["m".to_string()], "gone: the meeting itself still named");
    }

    #[test]
    fn an_index_opt_out_is_declared_a_revocation_and_a_label_or_pin_touches_nothing() {
        let off = item_touch("w", &ItemPatch { index_opt_in: Some(false), ..Default::default() });
        assert!(off.revoke && off.workspaces == vec!["w".to_string()]);
        let on = item_touch("w", &ItemPatch { index_opt_in: Some(true), ..Default::default() });
        assert!(!on.revoke && on.workspaces == vec!["w".to_string()]);
        assert_eq!(item_touch("w", &ItemPatch { pinned: Some(true), label: Some(None), ..Default::default() }), Touch::none());
        // The declaration survives combining and forces every dependent to revoke
        // even where the views are identical (so the kind would be Grant or Edit).
        assert!(Touch::ws("a").also(off.clone()).revoke);
        let same: BTreeMap<Target, ViewState> = [(Target::Meeting("m".into()), ViewState::Present(view(&["document:d"], &[])))].into();
        let forced = off.revoke;
        let kind = |ok: bool| decisions(&same, &same, ok)[0].1;
        assert_eq!(kind(true), Decision::Restart(Kind::Grant));
        assert_eq!(decisions(&same, &same, true && !forced)[0].1, Decision::Restart(Kind::Revoke));
    }

    #[test]
    fn touch_and_dependents_merge_without_duplicates() {
        let t = Touch::ws("a").also(Touch::meeting("m")).also(Touch::chats("b"));
        assert_eq!((t.workspaces.len(), t.meetings.len(), t.chats_of.len()), (1, 1, 1));
        assert_eq!(Touch::ws_if(false, "a"), Touch::none());
        let mut d = Dependents { meetings: vec!["m".into()], chats: vec!["c".into()] };
        d.merge(Dependents { meetings: vec!["m".into(), "n".into()], chats: vec!["c".into()] });
        assert_eq!((d.meetings.len(), d.chats.len()), (2, 1));
    }
}
