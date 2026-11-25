//! IPC for workspace search, the index and workspace chat.

use tauri::{command, AppHandle, Emitter, State};

use crate::commands::workspace_commands::{change_and_restart, with_conn, Touch};
use crate::state::AppState;
use crate::workspace::store as wstore;
use crate::workspace_chat::types::*;
use crate::workspace_chat::{engine, ops, runtime, store};
use crate::workspace_search::Passage;

// ── search and index ─────────────────────────────────────────────────────────

#[command]
pub async fn search_workspace(
    id: String,
    query: String,
    kinds: Option<Vec<String>>,
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<Passage>, String> {
    let path = with_conn(&state, |c| Ok(c.path().map(std::path::PathBuf::from)))?
        .ok_or_else(|| "Database not initialized".to_string())?;
    let conn = ops::reader(&path)?;
    ops::search_workspace(&conn, &id, &query, kinds, limit.unwrap_or(10))
}

#[command]
pub async fn get_index_status(id: String, state: State<'_, AppState>) -> Result<IndexStatus, String> {
    let active = state.meeting_active.load(std::sync::atomic::Ordering::SeqCst);
    let hub = state.workspace_chat.clone();
    hub.set_open_workspace(Some(id.clone()));
    with_conn(&state, |conn| ops::index_status(conn, &hub, &id, active))
}

/// Scan this workspace's material again now, and (when the workspace turned
/// "Prepare recaps with AI" on) make a few missing recaps, never in a meeting.
#[command]
pub async fn rescan_workspace(id: String, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    with_conn(&state, |conn| wstore::get_workspace(conn, &id).map(|_| ()))?;
    let hub = state.workspace_chat.clone();
    hub.set_open_workspace(Some(id.clone()));
    runtime::ensure_indexer(&app, &state)?;
    runtime::material_changed(&hub);
    if let Ok(deps) = runtime::build_deps(&app, &state) {
        let token = std::sync::Arc::new(crate::llm::provider::CancelToken::new());
        hub.set_recap_cancel(Some(token.clone()));
        tauri::async_runtime::spawn(async move {
            // the first pass writes the cards the recaps hang on
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            let made = ops::recap_missing(&deps, &id, token).await;
            if made > 0 {
                (deps.emit)("workspaces_changed", serde_json::json!({ "workspace_id": id }));
            }
        });
    }
    Ok(())
}

// ── chats ────────────────────────────────────────────────────────────────────

#[command]
pub async fn list_workspace_chats(workspace_id: String, state: State<'_, AppState>) -> Result<Vec<WorkspaceChat>, String> {
    with_conn(&state, |conn| {
        let _ = store::prune_empty_chats(conn, runtime::EMPTY_CHAT_TTL_MS);
        store::list_chats(conn, &workspace_id)
    })
}

#[command]
pub async fn create_workspace_chat(workspace_id: String, state: State<'_, AppState>, app: AppHandle) -> Result<WorkspaceChat, String> {
    // the chat starts on the model that is active now
    let selection = runtime::build_deps(&app, &state).ok().and_then(|d| (d.default_selection)());
    with_conn(&state, |conn| {
        store::create_chat(
            conn,
            &workspace_id,
            selection.as_ref().map(|s| s.provider.as_str()),
            selection.as_ref().map(|s| s.model.as_str()).filter(|m| !m.is_empty()),
            selection.as_ref().and_then(|s| s.effort.as_deref()),
        )
    })
}

#[command]
pub async fn update_workspace_chat(id: String, patch: WorkspaceChatPatch, state: State<'_, AppState>) -> Result<WorkspaceChat, String> {
    with_conn(&state, |conn| store::update_chat(conn, &id, patch))
}

#[command]
pub async fn delete_workspace_chat(id: String, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    let deps = runtime::build_deps(&app, &state)?;
    engine::delete_chat(&deps, &id).await
}

#[command]
pub async fn list_workspace_messages(chat_id: String, state: State<'_, AppState>) -> Result<Vec<WorkspaceMessage>, String> {
    with_conn(&state, |conn| store::list_messages(conn, &chat_id))
}

#[command]
pub async fn set_chat_meeting_included(
    workspace_id: String,
    chat_id: Option<String>,
    meeting_id: String,
    included: bool,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    // Taking a meeting out of a chat takes effect for its next request and
    // drops its CLI session (and its transcripts folder) at once, like any
    // other change of access.
    let ws = workspace_id.clone();
    change_and_restart(&state, &app, |_| Touch::chats(&ws), || {
        with_conn(&state, |conn| store::set_meeting_included(conn, &workspace_id, chat_id.as_deref(), &meeting_id, included))
    })
}

#[command]
pub async fn list_chat_meeting_prefs(
    workspace_id: String,
    chat_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<MeetingPref>, String> {
    with_conn(&state, |conn| store::list_meeting_prefs(conn, &workspace_id, chat_id.as_deref()))
}

#[command]
pub async fn set_chat_item_pref(
    chat_id: String,
    kind: String,
    ref_id: String,
    pref: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    // "exclude" takes the item out of the chat's next request and ends its session at once.
    let ws = with_conn(&state, |conn| Ok(store::get_chat(conn, &chat_id)?.map(|c| c.chat.workspace_id))).unwrap_or(None).unwrap_or_default();
    change_and_restart(&state, &app, |_| Touch::chats(&ws), || {
        with_conn(&state, |conn| store::set_item_pref(conn, &chat_id, &kind, &ref_id, pref.as_deref()))
    })
}

#[command]
pub async fn list_chat_item_prefs(chat_id: String, state: State<'_, AppState>) -> Result<Vec<ItemPref>, String> {
    with_conn(&state, |conn| store::list_item_prefs(conn, &chat_id))
}

#[command]
pub async fn preview_chat_context(
    chat_id: String,
    question: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ContextReport, String> {
    let deps = runtime::build_deps(&app, &state)?;
    engine::preview(&deps, &chat_id, question.as_deref()).await
}

/// Which tools are off in this chat and why (nothing runs).
#[command]
pub async fn get_chat_capabilities(
    chat_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<crate::workspace_chat::ChatCapabilities, String> {
    let deps = runtime::build_deps(&app, &state)?;
    engine::chat_capabilities(&deps, &chat_id)
}

#[command]
pub async fn ask_workspace(
    chat_id: String,
    question: String,
    request_id: String,
    deeper: Option<bool>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let deps = runtime::build_deps(&app, &state)?;
    engine::start_ask(deps, &chat_id, &question, &request_id, deeper.unwrap_or(false)).map(|_| ())
}

#[command]
pub async fn cancel_workspace_request(request_id: String, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    if let Some(chat_id) = state.workspace_chat.cancel(&request_id) {
        if let Ok(deps) = runtime::build_deps(&app, &state) {
            deps.tools.on_cancel(&chat_id);
        }
    }
    Ok(())
}

// ── answers into the library ─────────────────────────────────────────────────

/// "Save to library": the answer becomes a Markdown document of the workspace.
#[command]
pub async fn save_answer_to_library(message_id: i64, title: String, state: State<'_, AppState>, app: AppHandle) -> Result<String, String> {
    let (_, workspace_id) = with_conn(&state, |conn| ops::answer_of(conn, message_id))?;
    let id = change_and_restart(&state, &app, |_| Touch::ws(&workspace_id), || {
        let ctx = state.context.as_ref().ok_or_else(|| "Context manager not initialized".to_string())?;
        let mut ctx = ctx.lock().map_err(|e| format!("Failed to lock context manager: {e}"))?;
        with_conn(&state, |conn| ops::save_answer_as_document(conn, &mut ctx, message_id, &title))
    })?;
    runtime::documents_changed(&state.workspace_chat);
    let _ = app.emit("workspaces_changed", serde_json::json!({ "workspace_id": workspace_id }));
    Ok(id)
}

/// "Add to instructions": the answer is appended to the workspace's
/// instructions after a separator.
#[command]
pub async fn add_answer_to_instructions(message_id: i64, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    let (_, workspace_id) = with_conn(&state, |conn| ops::answer_of(conn, message_id))?;
    change_and_restart(&state, &app, |_| Touch::ws(&workspace_id), || {
        with_conn(&state, |conn| ops::add_answer_to_instructions(conn, message_id).map(|_| ()))
    })?;
    let _ = app.emit("workspaces_changed", serde_json::json!({ "workspace_id": workspace_id }));
    Ok(())
}
