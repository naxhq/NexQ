//! Wiring to the running app: builds the engine's dependencies from
//! `AppState`, starts the indexer after startup settles, and the small hooks
//! other commands call when something that should be indexed changes.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use tauri::{AppHandle, Emitter};

use super::engine::ChatDeps;
use super::hub::{ChatHub, Wake};
use super::provider::WorkspaceIndexProvider;
use crate::ai_runs::{AiRuns, ModelSelection};
use crate::state::AppState;

/// How long after launch the indexer starts (a meeting may start first).
pub const START_DELAY: Duration = Duration::from_secs(20);
/// Chats created and never used are removed after this long.
pub const EMPTY_CHAT_TTL_MS: i64 = 24 * 3600 * 1000;

fn db_path(state: &AppState) -> Result<std::path::PathBuf, String> {
    let db = state.database.as_ref().ok_or_else(|| "Database not initialized".to_string())?;
    let guard = db.lock().map_err(|e| format!("Failed to lock database: {e}"))?;
    Ok(guard.path().to_path_buf())
}

/// The chat engine's dependencies from the running app. Chats need the
/// workspace tables; without them this says so.
pub fn build_deps(app: &AppHandle, state: &AppState) -> Result<Arc<ChatDeps>, String> {
    if !crate::workspace::available() {
        return Err(match crate::workspace::last_error() {
            Some(e) => format!("Workspaces are unavailable. {e}"),
            None => "Workspaces are unavailable in this run".to_string(),
        });
    }
    let hub = state.workspace_chat.clone();
    // the app's one AiRuns (state.ai_runs); only a run without it makes its own
    let ai = match hub.ai_runs() {
        Some(ai) => ai,
        None => {
            let ai = state
                .ai_runs
                .clone()
                .unwrap_or_else(|| Arc::new(AiRuns::new(app.clone(), state.agent_sessions.clone(), state.credentials.clone())));
            hub.set_ai_runs(ai.clone());
            hub.ai_runs().unwrap_or(ai)
        }
    };
    let tools = {
        let (cli, sources) = (state.agent_sessions.clone(), state.personal_sources.clone());
        hub.tools_or(move || {
            Arc::new(super::approval::ApprovalToolPolicy::new(
                cli,
                crate::llm::cli_agent::approval::WorkspaceApprovals::global(),
                sources,
                Arc::new(crate::llm::cli_agent::approval::approval_support),
            ))
        })
    };
    let flag = state.meeting_active.clone();
    let llm = state.llm.clone();
    let app2 = app.clone();
    Ok(Arc::new(ChatDeps {
        db_path: db_path(state)?,
        ai,
        hub,
        sources: state.personal_sources.clone(),
        secret: Arc::new(crate::commands::sources_commands::saved_secret),
        meeting_active: Arc::new(move || flag.load(Ordering::SeqCst)),
        emit: Arc::new(move |event, payload| {
            let _ = app2.emit(event, payload);
        }),
        transcripts: crate::llm::cli_agent::transcripts::global(),
        tools,
        default_selection: Arc::new(move || {
            let router = llm.as_ref()?.lock().ok()?;
            let provider = router.active_provider_type()?;
            Some(ModelSelection::new(provider.as_str(), router.active_model(), None))
        }),
    }))
}

/// Starts the indexer (once) and tidies old empty chats.
pub fn ensure_indexer(app: &AppHandle, state: &AppState) -> Result<(), String> {
    if !crate::workspace::available() {
        return Ok(());
    }
    let hub = state.workspace_chat.clone();
    let path = db_path(state)?;
    if let Ok(conn) = crate::db::open_writer(&path) {
        let _ = super::store::prune_empty_chats(&conn, EMPTY_CHAT_TTL_MS);
    }
    let provider = Arc::new(WorkspaceIndexProvider { db_path: path.clone(), sources: state.personal_sources.clone() });
    let flag = state.meeting_active.clone();
    let app2 = app.clone();
    let hub2 = hub.clone();
    hub.start_indexer(
        path,
        provider,
        Arc::new(move || flag.load(Ordering::SeqCst)),
        Arc::new(move |p, ws| {
            let workspace_id = ws.or_else(|| hub2.open_workspace()).unwrap_or_else(|| crate::workspace::GENERAL_ID.to_string());
            let _ = app2.emit(
                "workspace_index_progress",
                json!({
                    "workspace_id": workspace_id,
                    "done": p.done,
                    "total": p.total,
                    "current": if p.current.is_empty() { serde_json::Value::Null } else { json!(p.current) },
                    "skipped": p.skipped,
                }),
            );
        }),
        true,
    )
}

/// One line in app setup: the indexer starts once startup has settled.
pub fn attach(app: &AppHandle) {
    let app = app.clone();
    // a change that arrives before the start delay starts the indexer at once
    {
        let state = tauri::Manager::state::<AppState>(&app);
        let app2 = app.clone();
        state.workspace_chat.set_starter(Arc::new(move || {
            let state = tauri::Manager::state::<AppState>(&app2);
            if let Err(e) = ensure_indexer(&app2, &state) {
                log::warn!("Couldn't start the search indexer: {e}");
            }
        }));
    }
    // chats run on the app's one AiRuns
    {
        let state = tauri::Manager::state::<AppState>(&app);
        if let Some(ai) = state.ai_runs.clone() {
            state.workspace_chat.set_ai_runs(ai);
        }
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(START_DELAY).await;
        let state = tauri::Manager::state::<AppState>(&app);
        if let Err(e) = ensure_indexer(&app, &state) {
            log::warn!("Couldn't start the search indexer: {e}");
        }
    });
}

// ── hooks ────────────────────────────────────────────────────────────────────

/// A meeting ended (its transcript is saved): index it.
pub fn meeting_ended(hub: &ChatHub, meeting_id: &str) {
    hub.wake(Wake::Meeting(meeting_id.to_string()));
}

/// A meeting was deleted: drop it from the index (the delete itself already
/// removed its rows; this stops a pass in flight from keeping them).
pub fn meeting_deleted(hub: &ChatHub, meeting_id: &str) {
    hub.wake(Wake::RemoveMeeting(meeting_id.to_string()));
}

/// A document, talking point, folder or opt-in changed: scan again soon.
pub fn material_changed(hub: &ChatHub) {
    hub.wake(Wake::Rescan);
}

/// A document was added, changed or removed: only documents are looked at.
pub fn documents_changed(hub: &ChatHub) {
    hub.wake(Wake::Documents);
}

/// A talking point was saved or deleted: only talking points are looked at.
pub fn talking_points_changed(hub: &ChatHub) {
    hub.wake(Wake::Points);
}

/// A folder was opted in: it is indexed now.
pub fn folder_opted_in(hub: &ChatHub, folder_id: &str) {
    hub.wake(Wake::Folder(folder_id.to_string()));
}

/// A folder item changed or was removed: when no workspace opts it in any
/// more, its passages are deleted right now (not at the next pass).
pub fn folder_opt_out_check(state: &AppState, is_folder: bool, folder_id: &str) {
    if !is_folder || !crate::workspace::available() {
        return;
    }
    let Ok(path) = db_path(state) else { return };
    let Ok(conn) = crate::db::open_writer(&path) else { return };
    let still: i64 = conn
        .query_row("SELECT COUNT(*) FROM workspace_items WHERE kind = 'folder' AND ref_id = ?1 AND index_opt_in = 1", [folder_id], |r| r.get(0))
        .unwrap_or(1);
    if still == 0 {
        let _ = crate::workspace_search::indexer::remove_folder_index(&conn, folder_id);
        folder_unindexed(&state.workspace_chat, folder_id);
    } else {
        folder_opted_in(&state.workspace_chat, folder_id);
    }
}

/// A folder was opted out of or removed: its passages go at once.
pub fn folder_unindexed(hub: &ChatHub, folder_id: &str) {
    hub.wake(Wake::RemoveFolder(folder_id.to_string()));
}
