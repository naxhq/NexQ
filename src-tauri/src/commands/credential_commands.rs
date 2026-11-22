use tauri::{command, State};

use crate::state::AppState;

#[command]
pub async fn store_api_key(
    provider: String,
    key: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let cred_mgr = state
        .credentials
        .as_ref()
        .ok_or_else(|| "Credential manager not initialized".to_string())?;

    let cred = cred_mgr
        .lock()
        .map_err(|e| format!("Failed to lock credential manager: {}", e))?;

    cred.store_key(&provider, &key)
}

#[command]
pub async fn get_api_key(
    provider: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    // The MAI settings and runtime only need presence and a short-lived
    // Speech token respectively. Never return this saved key over IPC.
    if provider == crate::stt::azure_mai_streaming::ID {
        return Ok(None);
    }
    let cred_mgr = state
        .credentials
        .as_ref()
        .ok_or_else(|| "Credential manager not initialized".to_string())?;

    let cred = cred_mgr
        .lock()
        .map_err(|e| format!("Failed to lock credential manager: {}", e))?;

    cred.get_key(&provider)
}

#[command]
pub async fn delete_api_key(
    provider: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let cred_mgr = state
        .credentials
        .as_ref()
        .ok_or_else(|| "Credential manager not initialized".to_string())?;

    let cred = cred_mgr
        .lock()
        .map_err(|e| format!("Failed to lock credential manager: {}", e))?;

    cred.delete_key(&provider)
}

#[command]
pub async fn has_api_key(
    provider: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let cred_mgr = state
        .credentials
        .as_ref()
        .ok_or_else(|| "Credential manager not initialized".to_string())?;

    let cred = cred_mgr
        .lock()
        .map_err(|e| format!("Failed to lock credential manager: {}", e))?;

    cred.has_key(&provider)
}
