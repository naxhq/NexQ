//! IPC for workspaces: CRUD, the library, a meeting's scope, talking points
//! and memory. Everything here is data; no AI call is made.

use rusqlite::Connection;
use serde::Serialize;
use tauri::{command, AppHandle, Emitter, State};

use crate::commands::meeting_commands;
use crate::state::AppState;
use crate::workspace::library::{self, LibrarySnapshot};
use crate::workspace::types::*;
use crate::workspace::{documents, meetings, memory, purge, sources_seed, store, talking_points};

#[derive(Serialize, Clone)]
struct WorkspacesChanged {
    workspace_id: Option<String>,
}

#[derive(Serialize, Clone)]
struct MemoryChanged {
    workspace_id: String,
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
        items: library::resolve_items(id, &rows, &snapshot(state)),
    })
}

/// The running meeting's id, if one runs.
fn live_meeting_id(state: &AppState) -> Option<String> {
    state.live_meeting.lock().ok().and_then(|m| m.as_ref().map(|m| m.id.clone()))
}

// ── Workspaces ───────────────────────────────────────────────────────────────

#[command]
pub async fn get_workspaces_status() -> Result<WorkspacesStatus, String> {
    Ok(WorkspacesStatus { available: crate::workspace::available(), error: crate::workspace::last_error() })
}

#[command]
pub async fn list_workspaces(state: State<'_, AppState>) -> Result<Vec<WorkspaceSummary>, String> {
    with_conn(&state, store::list_summaries)
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
    let ws = with_conn(&state, |conn| store::create_workspace(conn, input))?;
    emit_changed(&app, Some(&ws.id));
    detail_of(&state, &ws.id)
}

#[command]
pub async fn update_workspace(
    id: String,
    patch: WorkspacePatch,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<WorkspaceDetail, String> {
    with_conn(&state, |conn| store::update_workspace(conn, &id, patch))?;
    emit_changed(&app, Some(&id));
    // The instructions or the material of a running meeting may have changed.
    restart_live_if_involved(&state, &app, &id);
    detail_of(&state, &id)
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

/// What starts again when a workspace changes.
#[derive(Default)]
pub(crate) struct Dependents {
    meetings: Vec<String>,
    chats: Vec<String>,
}

/// The meetings (running, open in a view, or with a session record) and chats
/// whose scope includes `workspace_id`. Read it BEFORE a change that removes
/// the link (a deleted workspace, a ended borrow).
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
    with_conn(state, |conn| {
        let meetings: Vec<String> = candidates
            .iter()
            .filter(|m| {
                meetings::get_meeting_scope(conn, m).map(|s| s.effective.iter().any(|w| w == workspace_id)).unwrap_or(false)
            })
            .cloned()
            .collect();
        Ok(Dependents { meetings, chats: chats_using(conn, workspace_id) })
    })
    .unwrap_or_default()
}

/// Starts the dependents' sessions again from their new scope.
pub(crate) fn restart_dependents(app: &AppHandle, deps: Dependents) {
    for id in deps.meetings {
        meeting_commands::restart_meeting_sessions(app, &id);
    }
    meeting_commands::restart_chat_sessions(app, deps.chats);
}

/// A workspace changed (its material, instructions or borrowers): every
/// session that was started with its material starts again from the new scope.
pub(crate) fn restart_live_if_involved(state: &AppState, app: &AppHandle, workspace_id: &str) {
    restart_dependents(app, dependents_of(state, workspace_id));
}

#[command]
pub async fn clone_workspace(
    id: String,
    name: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<WorkspaceDetail, String> {
    let copy = with_conn(&state, |conn| store::clone_workspace(conn, &id, &name))?;
    emit_changed(&app, Some(&copy.id));
    detail_of(&state, &copy.id)
}

#[command]
pub async fn archive_workspace(id: String, archived: bool, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    with_conn(&state, |conn| store::archive_workspace(conn, &id, archived).map(|_| ()))?;
    emit_changed(&app, Some(&id));
    Ok(())
}

#[command]
pub async fn delete_workspace(id: String, mode: DeleteMode, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    if let Some(live) = live_meeting_id(&state) {
        let home = with_conn(&state, |conn| Ok(store::home_of(conn, &live)?)).unwrap_or(None);
        if home.as_deref() == Some(id.as_str()) {
            return Err("A meeting is running in this workspace. End it first".to_string());
        }
    }
    // Meetings that used it (their own, or by borrowing) and its chats start
    // again once it is gone; read who they are first.
    let mut deps = dependents_of(&state, &id);
    let own: Vec<String> = with_conn(&state, |conn| {
        let mut stmt = conn
            .prepare("SELECT id FROM meetings WHERE workspace_id = ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map(rusqlite::params![id], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
        Ok(rows.filter_map(Result::ok).collect())
    })
    .unwrap_or_default();
    for m in own {
        if !deps.meetings.contains(&m) {
            deps.meetings.push(m);
        }
    }
    let deleted = with_conn(&state, |conn| store::delete_workspace(conn, &id, mode))?;
    if let Some(dir) = purge::recordings_dir() {
        purge::delete_files_inside(&dir, &deleted.files);
    }
    emit_changed(&app, None);
    emit_memory(&app, &id);
    restart_dependents(&app, deps);
    Ok(())
}

#[command]
pub async fn set_default_workspace(id: String, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    with_conn(&state, |conn| store::set_default_workspace(conn, &id))?;
    emit_changed(&app, None);
    Ok(())
}

#[command]
pub async fn reorder_workspaces(ids: Vec<String>, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    with_conn(&state, |conn| store::reorder_workspaces(conn, &ids))?;
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
    with_conn(&state, |conn| store::add_item(conn, &id, kind, &ref_id, label.as_deref()))?;
    emit_changed(&app, Some(&id));
    restart_live_if_involved(&state, &app, &id);
    Ok(())
}

#[command]
pub async fn update_workspace_item(
    id: String,
    kind: ItemKind,
    ref_id: String,
    patch: ItemPatch,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    with_conn(&state, |conn| store::update_item(conn, &id, kind, &ref_id, patch))?;
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
    with_conn(&state, |conn| store::remove_item(conn, &id, kind, &ref_id))?;
    emit_changed(&app, Some(&id));
    restart_live_if_involved(&state, &app, &id);
    Ok(())
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
    with_conn(&state, |conn| sources_seed::remove_item_everywhere(conn, &cfg, kind, &ref_id))?;
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
    emit_changed(&app, Some(&id));
    restart_live_if_involved(&state, &app, &id);
    Ok(resource.id)
}

// ── Meetings ─────────────────────────────────────────────────────────────────

#[command]
pub async fn move_meeting(meeting_id: String, workspace_id: String, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    with_conn(&state, |conn| meetings::move_meeting_atomic(conn, &meeting_id, &workspace_id))?;
    emit_changed(&app, None);
    // A new home changes the scope: the meeting's sessions start again.
    meeting_commands::restart_meeting_sessions(&app, &meeting_id);
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
    with_conn(&state, |conn| meetings::list_workspace_meetings(conn, &id, query.as_deref(), limit, offset))
}

#[command]
pub async fn get_meeting_scope(meeting_id: String, state: State<'_, AppState>) -> Result<MeetingScope, String> {
    with_conn(&state, |conn| meetings::get_meeting_scope(conn, &meeting_id))
}

#[command]
pub async fn set_meeting_scope(
    meeting_id: String,
    borrowed: Vec<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<MeetingScope, String> {
    let scope = with_conn(&state, |conn| meetings::set_meeting_scope(conn, &meeting_id, &borrowed))?;
    emit_changed(&app, Some(&scope.home));
    meeting_commands::restart_meeting_sessions(&app, &meeting_id);
    Ok(scope)
}

// ── Talking points ───────────────────────────────────────────────────────────

#[command]
pub async fn list_talking_points(workspace_id: String, state: State<'_, AppState>) -> Result<Vec<TalkingPoint>, String> {
    with_conn(&state, |conn| talking_points::list_talking_points(conn, &workspace_id))
}

#[command]
pub async fn save_talking_point(point: TalkingPoint, state: State<'_, AppState>, app: AppHandle) -> Result<TalkingPoint, String> {
    let saved = with_conn(&state, |conn| talking_points::save_talking_point(conn, point))?;
    emit_changed(&app, Some(&saved.workspace_id));
    if saved.in_context {
        restart_live_if_involved(&state, &app, &saved.workspace_id);
    }
    Ok(saved)
}

#[command]
pub async fn delete_talking_point(id: String, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    let workspace = with_conn(&state, |conn| {
        let ws = talking_points::get_talking_point(conn, &id)?.map(|p| p.workspace_id);
        talking_points::delete_talking_point(conn, &id)?;
        Ok(ws)
    })?;
    emit_changed(&app, workspace.as_deref());
    if let Some(ws) = workspace.as_deref() {
        // Its text may be in the context of a running session.
        restart_live_if_involved(&state, &app, ws);
    }
    Ok(())
}

#[command]
pub async fn copy_talking_point(id: String, workspace_id: String, state: State<'_, AppState>, app: AppHandle) -> Result<TalkingPoint, String> {
    let copy = with_conn(&state, |conn| talking_points::copy_talking_point(conn, &id, &workspace_id))?;
    emit_changed(&app, Some(&workspace_id));
    Ok(copy)
}

#[command]
pub async fn reorder_talking_points(workspace_id: String, ids: Vec<String>, state: State<'_, AppState>) -> Result<(), String> {
    with_conn(&state, |conn| talking_points::reorder_talking_points(conn, &workspace_id, &ids))
}

#[command]
pub async fn get_point_progress(meeting_id: String, point_id: String, state: State<'_, AppState>) -> Result<Option<PointProgress>, String> {
    with_conn(&state, |conn| talking_points::get_point_progress(conn, &meeting_id, &point_id))
}

#[command]
pub async fn save_point_progress(
    meeting_id: String,
    point_id: String,
    said: Vec<PointSaid>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    with_conn(&state, |conn| talking_points::save_point_progress(conn, &meeting_id, &point_id, &said))
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
    let in_context = with_conn(&state, |conn| {
        talking_points::save_meeting_point_edit(conn, &meeting_id, &point_id, doc.as_deref())?;
        Ok(crate::workspace::scope::scope_for(conn, crate::workspace::ScopeOwner::Meeting(&meeting_id))?
            .talking_point_ids
            .contains(&point_id))
    })?;
    // This meeting's own version of a context note is in its sessions' context.
    if in_context {
        meeting_commands::restart_meeting_sessions(&app, &meeting_id);
    }
    Ok(())
}

// ── Memory ───────────────────────────────────────────────────────────────────

#[command]
pub async fn list_memory(workspace_id: String, state: State<'_, AppState>) -> Result<Vec<MemoryItem>, String> {
    with_conn(&state, |conn| memory::list_memory(conn, &workspace_id))
}

#[command]
pub async fn save_memory(item: MemoryItem, state: State<'_, AppState>, app: AppHandle) -> Result<MemoryItem, String> {
    let saved = with_conn(&state, |conn| memory::save_memory(conn, item))?;
    emit_memory(&app, &saved.workspace_id);
    Ok(saved)
}

#[command]
pub async fn delete_memory(id: String, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    let workspace = with_conn(&state, |conn| {
        let ws = memory::get_memory(conn, &id)?.map(|m| m.workspace_id);
        memory::delete_memory(conn, &id)?;
        Ok(ws)
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
    let item = with_conn(&state, |conn| memory::resolve_memory(conn, &id, &action, patch))?;
    emit_memory(&app, &item.workspace_id);
    Ok(())
}
