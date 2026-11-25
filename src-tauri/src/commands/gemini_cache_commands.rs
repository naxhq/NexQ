use tauri::{command, State};

use crate::llm::gemini_cache::GeminiCacheClient;
use crate::state::AppState;

/// Create a Gemini context cache from all loaded context resources.
///
/// Reads the assembled context text from ContextManager, grabs the Gemini API key
/// from CredentialManager, creates the cache, and stores it in AppState.
/// Returns JSON with `{ name, model, expire_time, total_token_count }`.
#[command]
pub async fn create_gemini_context_cache(
    model: String,
    ttl_secs: u64,
    system_prompt: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    // The documents of the running meeting's scope (the default workspace's
    // when none runs). The cache answers only requests with the same scope.
    let scoped = crate::workspace::runtime::for_live_or_default(&state);
    let scope_fingerprint = scoped.scope.fingerprint();
    let context_text = {
        let ctx = state
            .context
            .as_ref()
            .ok_or("Context manager not initialized")?
            .lock()
            .map_err(|e| format!("Context lock failed: {}", e))?;
        ctx.get_assembled_context_for(&scoped)
    };

    if context_text.trim().is_empty() {
        return Err("No context resources loaded. Add documents before creating a cache.".to_string());
    }

    // Get Gemini API key and base URL
    let (api_key, base_url) = {
        let creds = state
            .credentials
            .as_ref()
            .ok_or("Credential manager not initialized")?
            .lock()
            .map_err(|e| format!("Credentials lock failed: {}", e))?;

        let key = creds
            .get_key("gemini")
            .map_err(|e| format!("Credential error: {}", e))?
            .ok_or("Gemini API key not configured")?;

        let llm = state
            .llm
            .as_ref()
            .ok_or("LLM router not initialized")?
            .lock()
            .map_err(|e| format!("LLM lock failed: {}", e))?;

        let url = llm
            .active_provider_type()
            .map(|_| crate::llm::ProviderType::Gemini.default_base_url().to_string())
            .unwrap_or_else(|| "https://generativelanguage.googleapis.com".to_string());

        (key, url)
    };

    let client = GeminiCacheClient::new(&api_key, Some(&base_url));

    let cached = client
        .create(
            &model,
            system_prompt.as_deref(),
            &context_text,
            ttl_secs,
        )
        .await?;

    log::info!(
        "Gemini context cache created: {} ({} tokens, expires {})",
        cached.name,
        cached.total_token_count,
        cached.expire_time
    );

    // Store in AppState
    {
        let mut cache_slot = state
            .gemini_cache
            .lock()
            .map_err(|e| format!("Cache state lock failed: {}", e))?;
        *cache_slot = Some(cached.clone());
    }
    if let Ok(mut scope_slot) = state.gemini_cache_scope.lock() {
        *scope_slot = Some(scope_fingerprint);
    }

    serde_json::to_string(&cached).map_err(|e| format!("Serialize failed: {}", e))
}

/// Delete the active Gemini context cache and clear it from AppState.
#[command]
pub async fn delete_gemini_context_cache(
    state: State<'_, AppState>,
) -> Result<(), String> {
    let cache_name = {
        let slot = state
            .gemini_cache
            .lock()
            .map_err(|e| format!("Cache state lock failed: {}", e))?;
        slot.as_ref().map(|c| c.name.clone())
    };

    let Some(name) = cache_name else {
        return Ok(()); // Nothing to delete
    };

    // Get API key and base URL
    let (api_key, base_url) = {
        let creds = state
            .credentials
            .as_ref()
            .ok_or("Credential manager not initialized")?
            .lock()
            .map_err(|e| format!("Credentials lock failed: {}", e))?;

        let key = creds
            .get_key("gemini")
            .map_err(|e| format!("Credential error: {}", e))?
            .ok_or("Gemini API key not configured")?;

        (key, "https://generativelanguage.googleapis.com".to_string())
    };

    let client = GeminiCacheClient::new(&api_key, Some(&base_url));
    client.delete(&name).await?;

    // Clear from state
    {
        let mut slot = state
            .gemini_cache
            .lock()
            .map_err(|e| format!("Cache state lock failed: {}", e))?;
        *slot = None;
    }
    if let Ok(mut scope_slot) = state.gemini_cache_scope.lock() {
        *scope_slot = None;
    }

    log::info!("Gemini context cache deleted: {}", name);
    Ok(())
}

/// Return the active Gemini cache info, or null if none.
#[command]
pub async fn get_gemini_cache_status(
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let slot = state
        .gemini_cache
        .lock()
        .map_err(|e| format!("Cache state lock failed: {}", e))?;

    match slot.as_ref() {
        None => Ok(None),
        Some(c) => {
            let json = serde_json::to_string(c)
                .map_err(|e| format!("Serialize failed: {}", e))?;
            Ok(Some(json))
        }
    }
}
