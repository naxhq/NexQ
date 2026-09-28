use tauri::{command, AppHandle, Emitter, State};

use crate::intelligence::action_config::{AllActionConfigs, InstructionPresets};
use crate::intelligence::IntelligenceEngine;
use crate::llm::provider::GenerationParams;
use crate::llm::provider::RagChunkInfo;
use crate::rag;
use crate::state::AppState;

/// Compose instruction presets + custom text into a single string.
/// Mirrors the frontend's `composeInstructions()` in aiActionsStore.ts.
fn compose_instructions(presets: &InstructionPresets, custom: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(tone) = &presets.tone {
        parts.push(format!("{} tone.", tone));
    }
    if let Some(fmt) = &presets.format {
        let text = match fmt.as_str() {
            "bullets" => "Use bullet points.".to_string(),
            "paragraphs" => "Use paragraphs.".to_string(),
            "numbered" => "Use a numbered list.".to_string(),
            "oneliner" => "Keep it to one line.".to_string(),
            other => format!("Use {} format.", other),
        };
        parts.push(text);
    }
    if let Some(length) = &presets.length {
        let text = match length.as_str() {
            "brief" => "Brief responses.".to_string(),
            "standard" => "Standard length responses.".to_string(),
            "detailed" => "Detailed responses.".to_string(),
            other => format!("{} responses.", other),
        };
        parts.push(text);
    }
    if presets.opinion.as_deref() == Some("add") {
        parts.push("After answering based on the provided context, add a short section '## My Take' with your own analysis, interpretation, or recommendation — clearly separated from the factual answer above.".to_string());
    }
    let prefix = parts.join(" ");
    if !prefix.is_empty() && !custom.is_empty() {
        format!("{} {}", prefix, custom)
    } else if !prefix.is_empty() {
        prefix
    } else {
        custom.to_string()
    }
}

/// Build transcript text from frontend-provided segments, applying the per-action window.
/// The frontend transcript store is the single source of truth for ALL STT engines.
/// When `include_segment_ids` is true, each line includes the segment ID for LLM reference.
fn build_transcript_from_segments(segments_json: &str, window_seconds: u64, include_segment_ids: bool) -> String {
    #[derive(serde::Deserialize)]
    struct Seg {
        #[serde(default)]
        id: String,
        text: String,
        speaker: String,
        timestamp_ms: u64,
    }
    let segments: Vec<Seg> = match serde_json::from_str(segments_json) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("Failed to parse frontend transcript segments: {}", e);
            return String::new();
        }
    };

    if segments.is_empty() {
        return String::new();
    }

    // Find the latest timestamp for windowing
    let latest_ts = segments.iter().map(|s| s.timestamp_ms).max().unwrap_or(0);

    // Apply window: 0 = all segments, otherwise filter by time window
    let cutoff_ms = if window_seconds == 0 {
        0
    } else {
        latest_ts.saturating_sub(window_seconds * 1000)
    };

    segments.iter()
        .filter(|s| s.timestamp_ms >= cutoff_ms)
        .map(|s| {
            let label = match s.speaker.as_str() {
                "User" => "You",
                "Them" => "Them",
                other => other,
            };
            if include_segment_ids && !s.id.is_empty() {
                format!("[{}] {}: {}", s.id, label, s.text)
            } else {
                format!("[{}]: {}", label, s.text)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Count total segments in the JSON, regardless of window filtering.
fn count_total_segments(segments_json: &str) -> usize {
    #[derive(serde::Deserialize)]
    #[allow(dead_code)]
    struct Seg { text: String }
    serde_json::from_str::<Vec<Seg>>(segments_json)
        .map(|s| s.len())
        .unwrap_or(0)
}

#[command]
pub async fn generate_assist(
    mode: String,
    custom_question: Option<String>,
    transcript_segments: Option<String>,
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Extract what we need from the intelligence engine under its lock
    let (last_question, cancel_flag, action_config_snapshot, composed_instructions) = {
        let intel = state
            .intelligence
            .as_ref()
            .ok_or_else(|| "Intelligence engine not initialized".to_string())?;
        let engine = intel
            .lock()
            .map_err(|e| format!("Failed to lock intelligence engine: {}", e))?;

        if engine.is_generating() {
            return Err("Generation already in progress".to_string());
        }

        engine.set_generating(true);

        // Look up per-action config
        let action_cfg = engine.get_action_config(&mode).cloned();
        let global_defaults = engine.get_action_configs().global_defaults.clone();

        // Compose instructions from AllActionConfigs (reliable path — same sync as system prompts)
        let all_configs = engine.get_action_configs();
        let composed = compose_instructions(
            &all_configs.instruction_presets,
            &all_configs.custom_instructions,
        );

        let question = engine.last_detected_question().cloned();
        let cancel = engine.cancel_flag();

        (question, cancel, (action_cfg, global_defaults), composed)
    };

    let (action_cfg, global_defaults) = action_config_snapshot;

    // Compute include_question early for effective_question logic
    let include_question = action_cfg.as_ref().map(|c| c.include_detected_question).unwrap_or(true);

    // Construct effective question for the Detected Question prompt section.
    // custom_question (user-typed or user-clicked) is ALWAYS used if provided — it's explicit input.
    // Auto-detected questions are only used when include_detected_question is true.
    let effective_question = if let Some(ref cq) = custom_question {
        // User explicitly provided a question (Ask mode typed text, or clicked a specific question)
        Some(crate::intelligence::question_detector::DetectedQuestion {
            text: cq.clone(),
            confidence: 1.0,
            timestamp_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            source: "user-selected".to_string(),
        })
    } else if include_question {
        // No custom question — use auto-detected question if the action's toggle allows it
        last_question
    } else {
        // Action has include_detected_question=false and no custom question
        None
    };

    // Determine transcript window: per-action override or global default
    let window_seconds = action_cfg
        .as_ref()
        .and_then(|c| c.transcript_window_seconds)
        .unwrap_or(global_defaults.transcript_window_seconds);

    // Build transcript from frontend segments (universal — works with any STT engine).
    // The frontend transcript store is the single source of truth.
    // Falls back to engine buffer only if frontend didn't send segments.
    let include_segment_ids = mode == "BookmarkSuggestions";
    let mut transcript_text = if let Some(ref segs) = transcript_segments {
        build_transcript_from_segments(segs, window_seconds, include_segment_ids)
    } else {
        // Legacy fallback: read from backend buffer
        let intel = state.intelligence.as_ref()
            .ok_or_else(|| "Intelligence engine not initialized".to_string())?;
        let engine = intel.lock().map_err(|e| e.to_string())?;
        if window_seconds == 0 {
            engine.get_all_transcript()
        } else {
            engine.transcript_buffer.get_recent_text(window_seconds)
        }
    };

    // Prepend speaker context from active scenario (if set) before transcript
    if let Ok(scenario) = state.active_scenario.read() {
        if !scenario.speaker_context.is_empty() && !transcript_text.is_empty() {
            transcript_text = format!("{}\n\n{}", scenario.speaker_context, transcript_text);
        }
    }

    let total_segments = transcript_segments.as_ref()
        .map(|s| count_total_segments(s))
        .unwrap_or(0);
    let included_segments = transcript_text.lines()
        .filter(|l| l.starts_with("["))
        .count();

    // Resolve per-action settings
    // Read default top-K from RagConfig (Context Strategy) — single source of truth
    let rag_default_top_k = state.rag.as_ref()
        .and_then(|r| r.lock().ok())
        .map(|r| r.config().top_k)
        .unwrap_or(5);
    let rag_top_k = action_cfg.as_ref().and_then(|c| c.rag_top_k).unwrap_or(rag_default_top_k);

    let include_rag = action_cfg.as_ref().map(|c| c.include_rag_chunks).unwrap_or(true);
    let include_transcript = action_cfg.as_ref().map(|c| c.include_transcript).unwrap_or(true);
    // include_question already computed above
    let include_instructions = action_cfg.as_ref().map(|c| c.include_custom_instructions).unwrap_or(true);

    // Resolve base system prompt: per-action config > active scenario > hardcoded template.
    // Active scenario is set by the frontend at meeting start based on the selected AI scenario.
    let base_system_prompt = action_cfg
        .as_ref()
        .map(|c| c.system_prompt.clone())
        .unwrap_or_else(|| {
            // Check if the active scenario has a system prompt set
            let scenario_prompt = state.active_scenario.read().ok().and_then(|s| {
                if s.system_prompt.is_empty() { None } else { Some(s.system_prompt.clone()) }
            });
            scenario_prompt.unwrap_or_else(|| {
                crate::intelligence::prompt_templates::get_system_prompt(&mode).to_string()
            })
        });

    // Append composed instructions (tone + format + length + custom text) to system prompt.
    // These are behavioral directives that belong in the system context, not as reference materials.
    let system_prompt = if include_instructions && !composed_instructions.is_empty() {
        format!("{}\n\nAdditional Instructions: {}", base_system_prompt, composed_instructions)
    } else {
        base_system_prompt
    };

    // Build generation params from per-action overrides or global defaults
    let temperature = action_cfg
        .as_ref()
        .and_then(|c| c.temperature)
        .unwrap_or(global_defaults.temperature);

    // Check for active Gemini context cache — only applies when Gemini is the provider
    let active_cache_name = {
        let is_gemini = state.llm.as_ref()
            .and_then(|l| l.lock().ok())
            .and_then(|r| r.active_provider_type().cloned())
            .map(|pt| pt == crate::llm::ProviderType::Gemini)
            .unwrap_or(false);

        if is_gemini {
            state.gemini_cache
                .lock()
                .ok()
                .and_then(|slot| slot.as_ref().map(|c| c.name.clone()))
        } else {
            None
        }
    };

    let enable_web_search = action_cfg.as_ref().map(|c| c.web_search).unwrap_or(false);

    let params = GenerationParams {
        temperature: Some(temperature),
        max_tokens: None,
        cache_name: active_cache_name.clone(),
        enable_web_search,
    };

    // RAG metadata for StreamStartEvent
    let mut rag_query_text: Option<String> = None;
    let mut rag_chunk_infos: Vec<RagChunkInfo> = Vec::new();
    let mut rag_chunks_filtered: usize = 0;
    let mut rag_total_candidates: usize = 0;

    let context_text = {
        let mut parts: Vec<String> = Vec::new();

        // When Gemini cache is active, skip RAG entirely — no Ollama embed needed.
        // The full context is already cached on Gemini servers.
        if include_rag && active_cache_name.is_none() {
            // Note: we don't check config.enabled here — the action-level include_rag
            // toggle is the user's intent. If they enabled RAG for this action and have
            // indexed files, we should search. (config.enabled defaults to false and is
            // inconsistently set, while Test Knowledge Base ignores it entirely.)
            {
                // RAG query sources (priority: custom_question > effective_question > transcript)
                // custom_question is what the user typed (Ask mode) or the clicked question (Assist mode)
                // effective_question is the auto-detected question from the meeting
                let question_text = custom_question.as_deref()
                    .filter(|q| !q.is_empty())
                    .map(|q| q.to_string())
                    .or_else(|| effective_question.as_ref().map(|q| q.text.clone()));

                let transcript_excerpt: String = transcript_text
                    .chars().rev().take(500).collect::<String>()
                    .chars().rev().collect();

                // Dual search: search with question alone, then with question+transcript, merge results.
                // This prevents transcript noise from drowning out a clear question match,
                // while still benefiting from transcript context when relevant.
                let has_question = question_text.is_some();
                let has_transcript = !transcript_excerpt.is_empty();

                // Skip the search when nothing is indexed: search_async embeds the query
                // via Ollama *before* touching the index, so an empty index still cost
                // 1–2 embed round trips (and possibly an Ollama model swap) on every
                // Assist/Ask before the LLM call started. If the status query fails, search anyway.
                let has_indexed_chunks = state.database.as_ref().map_or(false, |db| {
                    db.lock()
                        .ok()
                        .and_then(|guard| rag::RagManager::get_status(guard.connection()).ok())
                        .map_or(true, |status| status.total_chunks > 0)
                });

                if (has_question || has_transcript) && has_indexed_chunks {
                    if let (Some(rag_arc), Some(db_arc)) =
                        (state.rag.as_ref(), state.database.as_ref()) {

                        let (mut config, embedder_url, embedding_model) = {
                            let rag_guard = rag_arc.lock().map_err(|e| e.to_string())?;
                            (rag_guard.config().clone(), rag_guard.embedder_url(), rag_guard.embedding_model())
                        };
                        config.top_k = rag_top_k;

                        let mut all_chunks: Vec<rag::search::ScoredChunk> = Vec::new();

                        // Search 1: question only (clean semantic match)
                        if let Some(ref q) = question_text {
                            rag_query_text = Some(q.clone());
                            match rag::RagManager::search_async(db_arc, q, &config, &embedder_url, &embedding_model).await {
                                Ok(chunks) => all_chunks.extend(chunks),
                                Err(e) => log::warn!("RAG search (question-only) failed: {}", e),
                            }
                        }

                        // Search 2: question + transcript (contextual match)
                        if has_question && has_transcript {
                            let combined = format!("{}\n\n{}", question_text.as_ref().unwrap(), transcript_excerpt);
                            if rag_query_text.is_none() {
                                rag_query_text = Some(combined.clone());
                            }
                            match rag::RagManager::search_async(db_arc, &combined, &config, &embedder_url, &embedding_model).await {
                                Ok(chunks) => all_chunks.extend(chunks),
                                Err(e) => log::warn!("RAG search (combined) failed: {}", e),
                            }
                        } else if !has_question && has_transcript {
                            // No question at all — search with transcript only as last resort
                            rag_query_text = Some(transcript_excerpt.clone());
                            match rag::RagManager::search_async(db_arc, &transcript_excerpt, &config, &embedder_url, &embedding_model).await {
                                Ok(chunks) => all_chunks.extend(chunks),
                                Err(e) => log::warn!("RAG search (transcript-only) failed: {}", e),
                            }
                        }

                        // Deduplicate: keep highest normalized_score per chunk_id
                        let mut best: std::collections::HashMap<String, rag::search::ScoredChunk> = std::collections::HashMap::new();
                        for chunk in all_chunks {
                            let entry = best.entry(chunk.chunk_id.clone()).or_insert(chunk.clone());
                            if chunk.normalized_score > entry.normalized_score {
                                *entry = chunk;
                            }
                        }
                        let mut merged: Vec<rag::search::ScoredChunk> = best.into_values().collect();
                        merged.sort_by(|a, b| b.normalized_score.partial_cmp(&a.normalized_score).unwrap_or(std::cmp::Ordering::Equal));
                        merged.truncate(rag_top_k);

                        // Build metadata for AI log
                        for c in &merged {
                            rag_chunk_infos.push(RagChunkInfo {
                                source: c.source_file.clone(),
                                chunk_index: c.chunk_index,
                                text: c.text.clone(),
                                normalized_score: c.normalized_score,
                                raw_score: c.score,
                            });
                        }
                        rag_total_candidates = rag_top_k;
                        if merged.len() < rag_top_k {
                            rag_chunks_filtered = rag_top_k - merged.len();
                        }
                        if !merged.is_empty() {
                            parts.push(rag::prompt_builder::build_rag_context(&merged, ""));
                        }
                    }
                }
            }
        }

        parts.join("\n\n")
    };

    let include_context = !context_text.is_empty();

    // Get the LLM provider and model info
    let (provider_arc, model, provider_name) = {
        let llm = state
            .llm
            .as_ref()
            .ok_or_else(|| "LLM router not initialized".to_string())?;
        let router = llm
            .lock()
            .map_err(|e| format!("Failed to lock LLM router: {}", e))?;

        let provider = router
            .get_provider()
            .map_err(|e| format!("No active LLM provider: {}", e))?;

        let model_name = router.active_model().to_string();
        if model_name.is_empty() {
            return Err("No active model selected".to_string());
        }

        let ptype = router
            .active_provider_type()
            .map(|pt| pt.display_name().to_string())
            .unwrap_or_else(|| "Unknown".to_string());

        (provider, model_name, ptype)
    };

    // Run the generation asynchronously
    let mode_clone = mode.clone();
    let result = IntelligenceEngine::generate_assist(
        &system_prompt,
        &mode_clone,
        custom_question.as_deref(),
        transcript_text,
        effective_question,
        context_text,
        include_context,
        include_transcript,
        include_question,
        include_rag,
        include_instructions,
        provider_arc,
        model,
        provider_name,
        params,
        temperature,
        rag_query_text,
        rag_chunk_infos,
        rag_chunks_filtered,
        rag_total_candidates,
        window_seconds,
        included_segments,
        total_segments,
        app_handle,
        cancel_flag,
    )
    .await;

    // Clear generating state
    {
        let intel = state.intelligence.as_ref();
        if let Some(intel) = intel {
            if let Ok(engine) = intel.lock() {
                engine.set_generating(false);
            }
        }
    }

    result
}

#[command]
pub async fn cancel_generation(state: State<'_, AppState>) -> Result<(), String> {
    let intel = state
        .intelligence
        .as_ref()
        .ok_or_else(|| "Intelligence engine not initialized".to_string())?;

    let engine = intel
        .lock()
        .map_err(|e| format!("Failed to lock intelligence engine: {}", e))?;

    engine.cancel();
    engine.set_generating(false);

    // Cancellation is handled via the atomic flag in IntelligenceEngine.
    // The LLM provider stream will check for cancellation on the next iteration.
    log::info!("Generation cancelled");
    Ok(())
}

#[command]
pub async fn set_auto_trigger(
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let intel = state
        .intelligence
        .as_ref()
        .ok_or_else(|| "Intelligence engine not initialized".to_string())?;

    let engine = intel
        .lock()
        .map_err(|e| format!("Failed to lock intelligence engine: {}", e))?;

    engine.set_auto_trigger(enabled);
    log::info!("Auto-trigger set to: {}", enabled);
    Ok(())
}

#[command]
pub async fn set_context_window_seconds(
    seconds: u64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let intel = state
        .intelligence
        .as_ref()
        .ok_or_else(|| "Intelligence engine not initialized".to_string())?;

    let mut engine = intel
        .lock()
        .map_err(|e| format!("Failed to lock intelligence engine: {}", e))?;

    engine.set_context_window(seconds);
    log::info!("Context window set to: {}s", seconds);
    Ok(())
}

/// Push a transcript segment to the intelligence engine's buffer.
/// Called from the frontend when Web Speech API produces results.
#[command]
pub async fn push_transcript(
    text: String,
    speaker: String,
    timestamp_ms: u64,
    is_final: bool,
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let intel = state
        .intelligence
        .as_ref()
        .ok_or_else(|| "Intelligence engine not initialized".to_string())?;

    let mut engine = intel
        .lock()
        .map_err(|e| format!("Failed to lock intelligence engine: {}", e))?;

    // Clone text and speaker before they are moved into push_transcript
    let text_clone = text.clone();
    let speaker_clone = speaker.clone();

    let questions = engine.push_transcript(text, speaker, timestamp_ms, is_final);

    // Emit question detected events
    for q in questions {
        let payload = serde_json::json!({
            "text": q.text,
            "confidence": q.confidence,
            "timestamp_ms": q.timestamp_ms,
            "source": q.source,
        });
        let _ = app_handle.emit("question_detected", &payload);
    }

    // Feed transcript to RAG indexer if enabled
    if is_final {
        if let Some(rag_arc) = state.rag.as_ref() {
            if let Ok(mut rag_mgr) = rag_arc.lock() {
                if rag_mgr.config().enabled && rag_mgr.config().include_transcript {
                    if let Some(indexer) = rag_mgr.transcript_indexer_mut() {
                        indexer.push_segment(&text_clone, &speaker_clone, timestamp_ms);
                    }
                }
            }
        }
    }

    Ok(())
}

/// Update action configs from the frontend.
/// Frontend is the source of truth — this syncs to backend IntelligenceEngine.
#[command]
pub async fn update_action_configs(
    configs_json: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let configs: AllActionConfigs = serde_json::from_str(&configs_json)
        .map_err(|e| format!("Failed to parse action configs: {}", e))?;

    let intel = state
        .intelligence
        .as_ref()
        .ok_or_else(|| "Intelligence engine not initialized".to_string())?;

    let mut engine = intel
        .lock()
        .map_err(|e| format!("Failed to lock intelligence engine: {}", e))?;

    // Also sync global defaults to intelligence engine settings
    engine.set_auto_trigger(configs.global_defaults.auto_trigger);
    engine.set_context_window(configs.global_defaults.transcript_window_seconds);

    engine.set_action_configs(configs);

    log::info!("Action configs updated from frontend");
    Ok(())
}

/// Set the active scenario prompts from the frontend (called at meeting start).
/// The intelligence pipeline reads these for scenario-aware prompt assembly.
#[command]
pub async fn set_active_scenario(
    system_prompt: String,
    summary_prompt: String,
    question_detection_prompt: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut scenario = state.active_scenario.write()
        .map_err(|e| format!("Failed to lock active scenario: {}", e))?;
    scenario.system_prompt = system_prompt;
    scenario.summary_prompt = summary_prompt;
    scenario.question_detection_prompt = question_detection_prompt;
    log::info!("Active scenario updated (system_prompt len={}, summary_prompt len={})",
        scenario.system_prompt.len(), scenario.summary_prompt.len());
    Ok(())
}

/// Update the speaker context within the active scenario.
/// Called by the frontend when speaker information changes during a meeting.
#[command]
pub async fn update_speaker_context(
    speaker_context: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut scenario = state.active_scenario.write()
        .map_err(|e| format!("Failed to lock active scenario: {}", e))?;
    scenario.speaker_context = speaker_context;
    log::info!("Speaker context updated (len={})", scenario.speaker_context.len());
    Ok(())
}

/// Get current action configs from the backend.
#[command]
pub async fn get_action_configs(
    state: State<'_, AppState>,
) -> Result<String, String> {
    let intel = state
        .intelligence
        .as_ref()
        .ok_or_else(|| "Intelligence engine not initialized".to_string())?;

    let engine = intel
        .lock()
        .map_err(|e| format!("Failed to lock intelligence engine: {}", e))?;

    let configs = engine.get_action_configs();
    serde_json::to_string(configs)
        .map_err(|e| format!("Failed to serialize action configs: {}", e))
}
