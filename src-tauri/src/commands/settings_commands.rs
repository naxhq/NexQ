use tauri::{command, AppHandle};
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "config.json";

#[command]
pub async fn get_config(key: String, app: AppHandle) -> Result<Option<String>, String> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| format!("Failed to open config store: {}", e))?;

    let value = store.get(&key);

    match value {
        Some(val) => {
            // Return the JSON value as a string
            let s = serde_json::to_string(&val)
                .map_err(|e| format!("Failed to serialize config value: {}", e))?;
            Ok(Some(s))
        }
        None => Ok(None),
    }
}

#[command]
pub async fn set_config(key: String, value: String, app: AppHandle) -> Result<(), String> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| format!("Failed to open config store: {}", e))?;

    // Parse the value as a JSON value so it's stored properly
    let json_value: serde_json::Value = serde_json::from_str(&value).unwrap_or_else(|_| {
        // If it's not valid JSON, store as a plain string
        serde_json::Value::String(value.clone())
    });

    store.set(key, json_value);

    Ok(())
}

/// The settings files that could not be read at start and what was done
/// (see `store_guard`). Returned once: the UI shows it and it is cleared.
#[tauri::command]
pub fn take_store_recovery(state: tauri::State<'_, crate::state::AppState>) -> Vec<crate::store_guard::StoreRecovery> {
    state.store_findings.lock().map(|mut f| std::mem::take(&mut *f)).unwrap_or_default()
}
