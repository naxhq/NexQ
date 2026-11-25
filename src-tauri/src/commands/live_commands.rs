//! IPC for live notes, the live brief and memory suggestions. Thin: the work
//! is in `live_runtime`. Start commands refuse a meeting that is not the
//! running one, so a demo or an old meeting never reaches a model.

use crate::live_runtime::notes::NoteEdit;
use crate::live_runtime::{global, LiveRuntimes};
use crate::workspace::types::MemoryItem;
use serde_json::Value;
use std::sync::Arc;
use tauri::command;

fn rt() -> Result<Arc<LiveRuntimes>, String> {
    global().ok_or_else(|| "Live notes are not available in this run".to_string())
}

#[command]
pub async fn notetaker_start(meeting_id: String) -> Result<(), String> {
    rt()?.notetaker_start(&meeting_id)
}

#[command]
pub async fn notetaker_stop(meeting_id: String) -> Result<(), String> {
    rt()?.notetaker_stop(&meeting_id);
    Ok(())
}

#[command]
pub async fn notetaker_update_now(meeting_id: String) -> Result<(), String> {
    rt()?.notetaker_update_now(&meeting_id);
    Ok(())
}

#[command]
pub async fn notetaker_continue(meeting_id: String) -> Result<(), String> {
    rt()?.notetaker_continue(&meeting_id);
    Ok(())
}

#[command]
pub async fn get_notetaker_settings() -> Result<Value, String> {
    serde_json::to_value(rt()?.notetaker_settings()).map_err(|e| e.to_string())
}

/// Merges a patch; returns the merged settings.
#[command]
pub async fn set_notetaker_settings(settings: Value) -> Result<Value, String> {
    serde_json::to_value(rt()?.patch_notetaker(&settings)?).map_err(|e| e.to_string())
}

#[command]
pub async fn get_meeting_notes(meeting_id: String) -> Result<Option<Value>, String> {
    Ok(rt()?.get_notes(&meeting_id).await)
}

#[command]
pub async fn save_meeting_notes_edit(meeting_id: String, edit: NoteEdit) -> Result<Value, String> {
    rt()?.edit_notes(&meeting_id, edit).await
}

#[command]
pub async fn get_meeting_brief(meeting_id: String) -> Result<Option<Value>, String> {
    Ok(rt()?.get_brief(&meeting_id).await)
}

#[command]
pub async fn brief_start(meeting_id: String) -> Result<(), String> {
    rt()?.brief_start(&meeting_id)
}

#[command]
pub async fn brief_stop(meeting_id: String) -> Result<(), String> {
    rt()?.brief_stop(&meeting_id);
    Ok(())
}

#[command]
pub async fn brief_refresh(meeting_id: String) -> Result<(), String> {
    rt()?.brief_refresh(&meeting_id);
    Ok(())
}

#[command]
pub async fn brief_continue(meeting_id: String) -> Result<(), String> {
    rt()?.brief_continue(&meeting_id);
    Ok(())
}

#[command]
pub async fn get_brief_settings() -> Result<Value, String> {
    serde_json::to_value(rt()?.brief_settings()).map_err(|e| e.to_string())
}

#[command]
pub async fn set_brief_settings(settings: Value) -> Result<Value, String> {
    serde_json::to_value(rt()?.patch_brief(&settings)?).map_err(|e| e.to_string())
}

/// One AI call per chunk of the finished meeting; proposals come back as `suggested`.
#[command]
pub async fn suggest_memory(workspace_id: String, meeting_id: String) -> Result<Vec<MemoryItem>, String> {
    rt()?.suggest_memory(&workspace_id, &meeting_id).await
}
