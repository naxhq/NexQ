//! IPC for workspace search, the index and workspace chat.

use tauri::{command, AppHandle, Emitter, State};

use crate::commands::workspace_commands::{change_and_restart, with_conn, with_reader, Touch};
use crate::state::AppState;
use crate::workspace::store as wstore;
use crate::workspace_chat::types::*;
use crate::workspace_chat::{engine, ops, runtime, store};

// ── search and index ─────────────────────────────────────────────────────────

#[command]
pub async fn get_index_status(id: String, state: State<'_, AppState>, app: AppHandle) -> Result<IndexStatus, String> {
    let active = state.meeting_active.load(std::sync::atomic::Ordering::SeqCst);
    let hub = state.workspace_chat.clone();
    runtime::workspace_opened(&app, &state, &id);
    let status = with_reader(&state, |conn| ops::index_status(conn, &hub, &id, active))?;
    // a backlog with no indexer yet (just after an upgrade): start it now, not after the start delay
    if status.state == "indexing" && hub.indexer().is_none() {
        runtime::material_changed(&hub);
    }
    Ok(status)
}

/// Scan this workspace's material again now, and (when the workspace turned
/// "Prepare recaps with AI" on) make a few missing recaps, never in a meeting.
#[command]
pub async fn rescan_workspace(id: String, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    with_conn(&state, |conn| wstore::get_workspace(conn, &id).map(|_| ()))?;
    let hub = state.workspace_chat.clone();
    hub.set_open_workspace(Some(id.clone()));
    let _ = with_conn(&state, |conn| {
        crate::workspace_search::cards::clear_recap_failures_of(conn, &id);
        Ok(())
    });
    runtime::ensure_indexer(&app, &state)?;
    runtime::material_changed(&hub);
    if let Ok(deps) = runtime::build_deps(&app, &state) {
        let token = std::sync::Arc::new(crate::llm::provider::CancelToken::new());
        hub.set_recap_cancel(Some(token.clone()));
        tauri::async_runtime::spawn(async move {
            // waits for the first pass (it writes the cards the recaps hang on)
            let made = ops::recaps_when_ready(&deps, &id, token).await;
            if made > 0 {
                (deps.emit)("workspaces_changed", serde_json::json!({ "workspace_id": id }));
            }
        });
    }
    Ok(())
}

/// "Try again" for the recaps that failed: any workspace, the way opening it does (never in a meeting).
#[command]
pub async fn retry_recaps(workspace_id: String, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    with_conn(&state, |conn| wstore::get_workspace(conn, &workspace_id).map(|_| ()))?;
    runtime::retry_recaps(&app, &state, &workspace_id);
    Ok(())
}

/// The recap the AI wrote for a meeting, or null.
#[command]
pub async fn get_meeting_recap(meeting_id: String, state: State<'_, AppState>) -> Result<Option<MeetingRecap>, String> {
    with_reader(&state, |conn| ops::meeting_recap(conn, &meeting_id))
}

/// Delete a meeting's AI recap; no new one is written for that meeting.
#[command]
pub async fn delete_meeting_recap(meeting_id: String, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    let ws = with_conn(&state, |conn| {
        crate::workspace_search::cards::decline_recap(conn, &meeting_id).map_err(|e| format!("Couldn't delete the recap: {e}"))?;
        Ok(conn.query_row("SELECT workspace_id FROM meetings WHERE id = ?1", [&meeting_id], |r| r.get::<_, Option<String>>(0)).ok().flatten())
    })?;
    let _ = app.emit("workspaces_changed", serde_json::json!({ "workspace_id": ws }));
    Ok(())
}

// ── chats ────────────────────────────────────────────────────────────────────

#[command]
pub async fn list_workspace_chats(workspace_id: String, state: State<'_, AppState>, app: AppHandle) -> Result<Vec<WorkspaceChat>, String> {
    runtime::workspace_opened(&app, &state, &workspace_id);
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
pub async fn update_workspace_chat(id: String, patch: WorkspaceChatPatch, state: State<'_, AppState>, app: AppHandle) -> Result<WorkspaceChat, String> {
    // Only "include meetings" changes what the chat may use; a title, a model or
    // a depth never touches its session.
    let ws = with_conn(&state, |conn| Ok(store::get_chat(conn, &id)?.map(|c| c.chat.workspace_id))).unwrap_or(None).unwrap_or_default();
    let matters = patch.include_meetings.is_some();
    change_and_restart(&state, &app, |_| if matters { Touch::chats(&ws) } else { Touch::none() }, || {
        with_conn(&state, |conn| store::update_chat(conn, &id, patch))
    })
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
    // The workspace-wide choice (no chat) also decides which meetings the live
    // brief and answers of that workspace may read: meetings and chats both.
    let ws = workspace_id.clone();
    let workspace_wide = chat_id.is_none();
    change_and_restart(&state, &app, |_| if workspace_wide { Touch::ws(&ws) } else { Touch::chats(&ws) }, || {
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
pub async fn save_answer_to_library(message_id: i64, title: String, text: String, state: State<'_, AppState>, app: AppHandle) -> Result<String, String> {
    let (_, workspace_id) = with_conn(&state, |conn| ops::answer_of(conn, message_id))?;
    let id = change_and_restart(&state, &app, |_| Touch::ws(&workspace_id), || {
        let ctx = state.context.as_ref().ok_or_else(|| "Context manager not initialized".to_string())?;
        let mut ctx = ctx.lock().map_err(|e| format!("Failed to lock context manager: {e}"))?;
        with_conn(&state, |conn| ops::save_answer_as_document(conn, &mut ctx, message_id, &title, &text))
    })?;
    runtime::documents_changed(&state.workspace_chat);
    let _ = app.emit("workspaces_changed", serde_json::json!({ "workspace_id": workspace_id }));
    Ok(id)
}

/// "Add to instructions": the answer is appended to the workspace's
/// instructions after a separator.
#[command]
pub async fn add_answer_to_instructions(message_id: i64, text: String, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    let (_, workspace_id) = with_conn(&state, |conn| ops::answer_of(conn, message_id))?;
    change_and_restart(&state, &app, |_| Touch::ws(&workspace_id), || {
        with_conn(&state, |conn| ops::add_answer_to_instructions(conn, message_id, &text).map(|_| ()))
    })?;
    let _ = app.emit("workspaces_changed", serde_json::json!({ "workspace_id": workspace_id }));
    Ok(())
}
