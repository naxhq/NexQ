use tauri::{command, State};

use crate::state::AppState;

/// Loads a document into the library. With `workspace_id` it joins that
/// workspace in the same step (and the sessions that use the workspace start
/// again); without, it is filed nowhere and no meeting uses it.
#[command]
pub async fn load_context_file(
    file_path: String,
    workspace_id: Option<String>,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    use crate::commands::workspace_commands::{change_and_restart, Touch};
    let ws = workspace_id.clone();
    // Reading and parsing a PDF or Word file takes a while: off the async runtime's threads.
    tokio::task::block_in_place(|| {
        change_and_restart(
            &state,
            &app,
            |_| ws.as_deref().map(Touch::ws).unwrap_or_default(),
            || load_context_file_now(&file_path, workspace_id.as_deref(), &state),
        )
    })
}

fn load_context_file_now(file_path: &str, workspace_id: Option<&str>, state: &AppState) -> Result<String, String> {
    let ctx_mgr = state
        .context
        .as_ref()
        .ok_or_else(|| "Context manager not initialized".to_string())?;

    let (resource, text) = {
        let mut ctx = ctx_mgr
            .lock()
            .map_err(|e| format!("Failed to lock context manager: {}", e))?;
        let resource = ctx.load_file(file_path)?;
        let text = ctx.cached_text(&resource.id).unwrap_or_default();
        (resource, text)
    };

    // Persist to DB so the resource survives app restarts, with its text (so a
    // start reads no file) and, when given, its workspace in the same step.
    // Without a workspace it is filed nowhere and no meeting uses it.
    if let Some(db_arc) = state.database.as_ref() {
        if let Ok(db_guard) = db_arc.lock() {
            let saved = if crate::workspace::available() {
                crate::workspace::documents::add_document(db_guard.connection(), &resource, &text, workspace_id)
            } else {
                crate::db::context::add_context_resource(
                    db_guard.connection(),
                    &crate::workspace::documents::db_row(&resource),
                )
                .map_err(|e| e.to_string())
            };
            if let Err(e) = saved {
                log::warn!("Failed to persist context resource to DB: {}", e);
            }
        }
    }

    crate::workspace_chat::runtime::documents_changed(&state.workspace_chat);
    serde_json::to_string(&resource)
        .map_err(|e| format!("Failed to serialize resource: {}", e))
}

/// Removes a document from the library and from every workspace; the sessions
/// that held its text start again.
#[command]
pub async fn remove_context_file(
    resource_id: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use crate::commands::workspace_commands::{change_and_restart, holders_of};
    use crate::workspace::types::ItemKind;
    let removed = change_and_restart(
        &state,
        &app,
        |conn| holders_of(conn, ItemKind::Document, &resource_id),
        || remove_context_file_now(&resource_id, &state),
    );
    crate::workspace_chat::runtime::documents_changed(&state.workspace_chat);
    removed
}

fn remove_context_file_now(resource_id: &str, state: &AppState) -> Result<(), String> {
    let ctx_mgr = state
        .context
        .as_ref()
        .ok_or_else(|| "Context manager not initialized".to_string())?;

    {
        let mut ctx = ctx_mgr
            .lock()
            .map_err(|e| format!("Failed to lock context manager: {}", e))?;
        ctx.remove_file(resource_id)?;
    }

    // Remove from DB (context record + RAG chunks)
    if let Some(db_arc) = state.database.as_ref() {
        if let Ok(db_guard) = db_arc.lock() {
            if crate::workspace::available() {
                // Row, saved text, index chunks and every workspace membership.
                let _ = crate::workspace::documents::remove_document(db_guard.connection(), resource_id);
            } else {
                let _ = crate::db::context::delete_context_resource(db_guard.connection(), resource_id);
                let _ = crate::db::rag::delete_chunks_by_file(db_guard.connection(), resource_id);
            }
        }
    }
    Ok(())
}

#[command]
pub async fn list_context_resources(
    state: State<'_, AppState>,
) -> Result<String, String> {
    let ctx_mgr = state
        .context
        .as_ref()
        .ok_or_else(|| "Context manager not initialized".to_string())?;

    let ctx = ctx_mgr
        .lock()
        .map_err(|e| format!("Failed to lock context manager: {}", e))?;

    let resources = ctx.list_resources();

    serde_json::to_string(&resources)
        .map_err(|e| format!("Failed to serialize resources: {}", e))
}

#[command]
pub async fn set_custom_instructions(
    instructions: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let ctx_mgr = state
        .context
        .as_ref()
        .ok_or_else(|| "Context manager not initialized".to_string())?;

    let mut ctx = ctx_mgr
        .lock()
        .map_err(|e| format!("Failed to lock context manager: {}", e))?;

    ctx.set_custom_instructions(&instructions);

    Ok(())
}

#[command]
pub async fn get_token_budget(
    state: State<'_, AppState>,
) -> Result<String, String> {
    let ctx_mgr = state
        .context
        .as_ref()
        .ok_or_else(|| "Context manager not initialized".to_string())?;

    let ctx = ctx_mgr
        .lock()
        .map_err(|e| format!("Failed to lock context manager: {}", e))?;

    // Default model context window: 128k tokens (can be overridden later)
    let model_context_window: u64 = 128_000;
    // Transcript tokens default to 0 when not in a meeting
    let transcript_tokens: usize = 0;

    let budget = ctx.get_token_budget(model_context_window, transcript_tokens);

    serde_json::to_string(&budget)
        .map_err(|e| format!("Failed to serialize token budget: {}", e))
}
