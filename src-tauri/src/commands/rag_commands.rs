use std::sync::Arc;
use tauri::{command, AppHandle, Emitter, State};
use crate::intelligence::IntelligenceEngine;
use crate::rag::{self, RagManager, config::RagConfig, embedder::OllamaEmbedder};
use crate::state::AppState;

#[command]
pub async fn rebuild_rag_index(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Auto-enable RAG when user explicitly requests a rebuild
    let rag_arc = state.rag.as_ref()
        .ok_or_else(|| "RAG manager not initialized".to_string())?;

    {
        let mut mgr = rag_arc.lock().map_err(|e| e.to_string())?;
        if !mgr.config().enabled {
            let mut config = mgr.config().clone();
            config.enabled = true;
            mgr.update_config(config);
            log::info!("RAG auto-enabled via rebuild request");
        }
    }

    // Get list of context resources
    let resources = {
        let ctx = state.context.as_ref()
            .ok_or_else(|| "Context manager not initialized".to_string())?;
        let ctx_mgr = ctx.lock().map_err(|e| e.to_string())?;
        ctx_mgr.list_resources()
    };

    let db_arc = state.database.as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    // Clear existing index
    {
        let db = db_arc.lock().map_err(|e| e.to_string())?;
        RagManager::clear_index(db.connection())?;
    }

    // Re-index each file
    for resource in &resources {
        let text = rag::file_processor::extract_text(&resource.file_path, &resource.file_type)
            .unwrap_or_default();

        if !text.is_empty() {
            // Extract config under brief lock, then drop guard before await
            let (config, embedder_url) = {
                let mgr = rag_arc.lock().map_err(|e| e.to_string())?;
                (mgr.config().clone(), mgr.embedder_url())
            };
            RagManager::index_file_async(
                db_arc,
                &resource.id,
                &text,
                &resource.name,
                &app_handle,
                &config,
                &embedder_url,
            ).await?;
        }
    }

    // Emit completion event
    let _ = app_handle.emit("rag_index_progress", serde_json::json!({
        "status": "complete",
        "total_files": resources.len(),
    }));

    log::info!("RAG index rebuild complete: {} files processed", resources.len());
    Ok(())
}

#[command]
pub async fn rebuild_file_index(
    resource_id: String,
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let rag_arc = state.rag.as_ref()
        .ok_or_else(|| "RAG manager not initialized".to_string())?;
    let db_arc = state.database.as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    // Remove existing index for this file
    {
        let db = db_arc.lock().map_err(|e| e.to_string())?;
        RagManager::remove_file_index(db.connection(), &resource_id)?;
    }

    // Get file info from context manager
    let (file_path, file_type, file_name) = {
        let ctx = state.context.as_ref()
            .ok_or_else(|| "Context manager not initialized".to_string())?;
        let ctx_mgr = ctx.lock().map_err(|e| e.to_string())?;
        let resources = ctx_mgr.list_resources();
        let resource = resources.iter()
            .find(|r| r.id == resource_id)
            .ok_or_else(|| format!("Resource {} not found", resource_id))?;
        (resource.file_path.clone(), resource.file_type.clone(), resource.name.clone())
    };

    // Extract text and re-index
    let text = rag::file_processor::extract_text(&file_path, &file_type)
        .unwrap_or_default();

    if !text.is_empty() {
        let (config, embedder_url) = {
            let mgr = rag_arc.lock().map_err(|e| e.to_string())?;
            (mgr.config().clone(), mgr.embedder_url())
        };
        RagManager::index_file_async(
            db_arc,
            &resource_id,
            &text,
            &file_name,
            &app_handle,
            &config,
            &embedder_url,
        ).await?;
    }

    let _ = app_handle.emit("rag_index_progress", serde_json::json!({
        "status": "file_complete",
        "resource_id": resource_id,
    }));

    log::info!("RAG file index rebuilt for resource {}", resource_id);
    Ok(())
}

#[command]
pub async fn clear_rag_index(
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db_arc = state.database.as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db_arc.lock().map_err(|e| e.to_string())?;
    RagManager::clear_index(db.connection())?;

    log::info!("RAG index cleared");
    Ok(())
}

#[command]
pub async fn get_rag_status(
    state: State<'_, AppState>,
) -> Result<String, String> {
    let db_arc = state.database.as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    // Get the actual resource count from the context manager (in-memory, reliable)
    let context_file_count = state.context.as_ref()
        .and_then(|c| c.lock().ok())
        .map(|c| c.list_resources().len())
        .unwrap_or(0);

    let db = db_arc.lock().map_err(|e| e.to_string())?;
    let mut status = RagManager::get_status(db.connection())?;

    // Use context manager count as total_files (context_resources DB table may be empty)
    status.total_files = context_file_count.max(status.indexed_files);

    serde_json::to_string(&status)
        .map_err(|e| format!("Failed to serialize RAG status: {}", e))
}

#[command]
pub async fn test_rag_search(
    query: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let rag_arc = state.rag.as_ref()
        .ok_or_else(|| "RAG manager not initialized".to_string())?;
    let db_arc = state.database.as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let (config, embedder_url, model) = {
        let mgr = rag_arc.lock().map_err(|e| e.to_string())?;
        (mgr.config().clone(), mgr.embedder_url(), mgr.embedding_model())
    };

    let results = RagManager::search_async(db_arc, &query, &config, &embedder_url, &model).await?;

    serde_json::to_string(&results)
        .map_err(|e| format!("Failed to serialize search results: {}", e))
}

#[command]
pub async fn get_rag_config(
    state: State<'_, AppState>,
) -> Result<String, String> {
    let rag_arc = state.rag.as_ref()
        .ok_or_else(|| "RAG manager not initialized".to_string())?;

    let mgr = rag_arc.lock().map_err(|e| e.to_string())?;
    let config = mgr.config();

    serde_json::to_string(config)
        .map_err(|e| format!("Failed to serialize RAG config: {}", e))
}

#[command]
pub async fn update_rag_config(
    config_json: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let rag_arc = state.rag.as_ref()
        .ok_or_else(|| "RAG manager not initialized".to_string())?;

    let new_config: RagConfig = serde_json::from_str(&config_json)
        .map_err(|e| format!("Failed to parse RAG config: {}", e))?;

    let mut mgr = rag_arc.lock().map_err(|e| e.to_string())?;
    mgr.update_config(new_config);

    log::info!("RAG config updated");
    Ok(())
}

#[command]
pub async fn test_ollama_embedding_connection(
    state: State<'_, AppState>,
) -> Result<String, String> {
    let base_url = {
        let rag_arc = state.rag.as_ref()
            .ok_or_else(|| "RAG manager not initialized".to_string())?;
        let mgr = rag_arc.lock().map_err(|e| e.to_string())?;
        mgr.embedder_url()
    };

    let status = OllamaEmbedder::test_connection(&base_url).await?;

    serde_json::to_string(&status)
        .map_err(|e| format!("Failed to serialize connection status: {}", e))
}

#[command]
pub async fn pull_embedding_model(
    model: String,
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let base_url = {
        let rag_arc = state.rag.as_ref()
            .ok_or_else(|| "RAG manager not initialized".to_string())?;
        let mgr = rag_arc.lock().map_err(|e| e.to_string())?;
        mgr.embedder_url()
    };

    OllamaEmbedder::pull_model(&base_url, &model, app_handle).await
}

/// Remove the RAG index for a single file without touching other files.
/// Called automatically when a file is removed from context.
#[command]
pub async fn remove_file_rag_index(
    resource_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db_arc = state.database.as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db_arc.lock().map_err(|e| e.to_string())?;
    RagManager::remove_file_index(db.connection(), &resource_id)?;

    log::info!("RAG index removed for resource {}", resource_id);
    Ok(())
}

/// Test RAG pipeline end-to-end: search for chunks, then call the configured LLM
/// to answer the question using those chunks as context.
///
/// Accepts optional `llm_provider` and `llm_model` from the frontend to ensure
/// the correct LLM is used (the backend router may be out of sync with the
/// frontend's persisted settings).
///
/// Uses the same streaming events as generate_assist (llm_stream_start/token/end)
/// so the frontend can display the response progressively.
#[command]
pub async fn test_rag_answer(
    query: String,
    llm_provider: Option<String>,
    llm_model: Option<String>,
    request_id: Option<String>,
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let request_id = request_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    // 1. Search RAG for relevant chunks
    let rag_arc = state.rag.as_ref()
        .ok_or_else(|| "RAG manager not initialized".to_string())?;
    let db_arc = state.database.as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let (config, embedder_url, emb_model) = {
        let mgr = rag_arc.lock().map_err(|e| e.to_string())?;
        (mgr.config().clone(), mgr.embedder_url(), mgr.embedding_model())
    };

    let chunks = RagManager::search_async(db_arc, &query, &config, &embedder_url, &emb_model).await?;

    if chunks.is_empty() {
        return Err("No relevant chunks found in the knowledge base".to_string());
    }

    // 2. Build context from chunks
    let custom_instr = state.context.as_ref()
        .and_then(|c| c.lock().ok())
        .map(|c| c.get_custom_instructions().to_string())
        .unwrap_or_default();
    let context = rag::prompt_builder::build_rag_context(&chunks, &custom_instr);

    // 3. Get LLM provider — sync from frontend if provided
    let llm_arc = state.llm.as_ref()
        .ok_or_else(|| "LLM router not initialized".to_string())?;

    // If the frontend passed a provider that differs from the active one, use a
    // temporary provider for this call. The router's active provider and model
    // are never changed by a test.
    let mut temp_provider: Option<(
        Arc<tokio::sync::Mutex<Box<dyn crate::llm::provider::LLMProvider>>>,
        String,
    )> = None;
    if let Some(ref provider_str) = llm_provider {
        let requested = provider_str.to_lowercase();
        let current_type = {
            let router = llm_arc.lock().map_err(|e| e.to_string())?;
            router.active_provider_type().map(|pt| pt.as_str().to_string())
        };

        if current_type.as_deref() != Some(requested.as_str()) {
            // Load the API key from the credential store so cloud providers work correctly
            let api_key = state.credentials.as_ref()
                .and_then(|c| c.lock().ok())
                .and_then(|creds| creds.get_key(&requested).ok().flatten());

            let provider_config = crate::llm::ProviderConfig {
                provider_type: requested.clone(),
                api_key,
                base_url: None, // use provider's default base URL
                auth_type: None,
                auth_value: None,
                auth_header: None,
                thinking: Default::default(),
                extra_request_json: None,
            };

            match crate::llm::create_provider(&provider_config) {
                Ok(p) => {
                    let display = crate::llm::ProviderType::from_str(&requested)
                        .map(|pt| pt.display_name().to_string())
                        .unwrap_or_else(|_| requested.clone());
                    log::info!("Test KB: using temporary {} provider", requested);
                    temp_provider = Some((Arc::new(tokio::sync::Mutex::new(p)), display));
                }
                Err(e) => return Err(format!("Could not use {}: {}", requested, e)),
            }
        }
    }

    let (provider_arc, model_name, provider_name) = {
        let router = llm_arc.lock().map_err(|e| e.to_string())?;
        let model_name = llm_model.clone()
            .unwrap_or_else(|| router.active_model().to_string());
        if model_name.is_empty() {
            return Err("No active model selected — configure one in LLM settings".to_string());
        }
        match temp_provider {
            Some((provider, display)) => (provider, model_name, display),
            None => {
                let provider = router.get_provider()
                    .map_err(|e| format!("No active LLM provider: {}", e))?;
                let ptype = router.active_provider_type()
                    .map(|pt| pt.display_name().to_string())
                    .unwrap_or_else(|| "Unknown".to_string());
                (provider, model_name, ptype)
            }
        }
    };

    // 4. Call LLM with streaming (reuses existing llm_stream_* events)
    let cancel_flag = Arc::new(crate::llm::provider::CancelToken::new());
    let system_prompt = crate::intelligence::prompt_templates::get_system_prompt("AskQuestion");
    IntelligenceEngine::generate_assist(
        system_prompt,
        "AskQuestion",
        Some(&query),
        String::new(),  // no transcript for test
        None,           // no detected question
        context,
        true,           // include_context
        false,          // include_transcript (none for test)
        false,          // include_question
        true,           // include_rag (this is a RAG test)
        false,          // include_instructions
        provider_arc,
        model_name,
        provider_name,
        crate::llm::provider::GenerationParams {
            request_id: Some(request_id),
            ..Default::default()
        },
        // Metadata for StreamStartEvent (test-rag defaults)
        0.7,                        // temperature (default)
        Some(query.clone()),        // rag_query
        Vec::new(),                 // rag_chunks (not tracked for test)
        0,                          // rag_chunks_filtered
        chunks.len(),               // rag_total_candidates
        0,                          // transcript_window_seconds (no transcript)
        0,                          // transcript_segments_count
        0,                          // transcript_segments_total
        None,                       // scope_label
        app_handle,
        cancel_flag,
    ).await
}
