// src-tauri/src/commands/translation_commands.rs
use tauri::{command, AppHandle, Emitter, Listener};
use crate::state::AppState;
use crate::translation::{
    TranslationProviderType, TranslationResult, ConnectionStatus, Language,
    DetectedLanguage,
};
use tauri::Manager;

#[command]
pub async fn set_translation_provider(
    app: AppHandle,
    provider: String,
    region: Option<String>,
) -> Result<(), String> {
    let state = app.state::<AppState>();

    // Load credentials from CredentialManager into the router
    if let Some(ref cred_arc) = state.credentials {
        if let Ok(cred) = cred_arc.lock() {
            let trans_arc = state.translation.as_ref()
                .ok_or("Translation router not initialized")?;
            let mut router = trans_arc.lock()
                .map_err(|_| "Translation lock poisoned".to_string())?;

            if let Ok(Some(key)) = cred.get_key("translation_microsoft") {
                router.set_microsoft_credentials(key, region.clone());
            }
            if let Ok(Some(key)) = cred.get_key("translation_google") {
                router.set_google_credentials(key);
            }
            if let Ok(Some(key)) = cred.get_key("translation_deepl") {
                router.set_deepl_credentials(key);
            }
        }
    }

    let provider_type = match provider.as_str() {
        "microsoft" => TranslationProviderType::Microsoft,
        "google" => TranslationProviderType::Google,
        "deepl" => TranslationProviderType::Deepl,
        "opus-mt" => TranslationProviderType::OpusMt,
        "llm" => TranslationProviderType::Llm,
        other => return Err(format!("Unknown translation provider: {}", other)),
    };

    let trans_arc = state.translation.as_ref()
        .ok_or("Translation router not initialized")?;
    let mut router = trans_arc.lock()
        .map_err(|_| "Translation lock poisoned".to_string())?;

    router.set_provider(provider_type)
        .map_err(|e| e.to_string())
}

/// Update the backend's default target/source language for translation.
/// Called by the frontend whenever the user changes language settings.
#[command]
pub async fn set_translation_languages(
    app: AppHandle,
    target_lang: String,
    source_lang: Option<String>,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let trans_arc = state.translation.as_ref()
        .ok_or("Translation router not initialized")?;
    let mut router = trans_arc.lock()
        .map_err(|_| "Translation lock poisoned".to_string())?;

    router.set_default_target_lang(target_lang.clone());
    router.set_default_source_lang(source_lang.clone());
    log::info!("Translation languages updated: target={}, source={:?}", target_lang, source_lang);
    Ok(())
}

#[command]
pub async fn translate_text(
    app: AppHandle,
    text: String,
    target_lang: String,
    source_lang: Option<String>,
) -> Result<TranslationResult, String> {
    let state = app.state::<AppState>();
    let trans_arc = state.translation.as_ref()
        .ok_or("Translation router not initialized")?;

    let target = target_lang;
    let source = source_lang.filter(|s| !s.is_empty() && s != "auto");

    // Check cache first, then clone Arc<dyn Provider> BEFORE dropping lock
    let (cached_result, provider_arc, provider_name) = {
        let router = trans_arc.lock().map_err(|_| "Lock poisoned")?;
        if let Some(cached) = router.cache().get(&text, &target) {
            (Some(cached.to_string()), None, router.active_provider_name())
        } else {
            let p = router.get_provider().map_err(|e| e.to_string())?;
            let name = p.provider_name().to_string();
            (None, Some(p), name)
        }
        // Lock dropped here — safe to .await below
    };

    if let Some(cached) = cached_result {
        return Ok(TranslationResult {
            segment_id: None,
            original_text: text,
            translated_text: cached,
            source_lang: source.as_deref().unwrap_or("auto").to_string(),
            target_lang: target,
            provider: provider_name,
        });
    }

    // Translate — no lock held, using Arc clone
    let provider = provider_arc.unwrap();

    // Handle LLM provider specially — construct a translation prompt
    // and route through LLMRouter instead of the marker trait
    let is_llm = {
        let router = trans_arc.lock().map_err(|_| "Lock poisoned")?;
        router.active_type() == Some(&crate::translation::TranslationProviderType::Llm)
    };

    let translated = if is_llm {
        // LLM translation: use existing LLMRouter with a translation prompt
        translate_via_llm(&app, &text, source.as_deref(), &target).await?
    } else {
        // Split long text if needed (>5000 chars for cloud providers)
        let chunks = crate::translation::TranslationRouter::split_long_text(&text, 5000);
        let mut parts = Vec::new();
        for chunk in &chunks {
            // Retry once on failure
            match provider.translate(chunk, source.as_deref(), &target).await {
                Ok(t) => parts.push(t),
                Err(_first_err) => {
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    match provider.translate(chunk, source.as_deref(), &target).await {
                        Ok(t) => parts.push(t),
                        Err(e) => {
                            // Track consecutive failures
                            let mut router = trans_arc.lock().map_err(|_| "Lock poisoned")?;
                            let count = router.record_failure();
                            if count >= 3 {
                                let _ = app.emit("translation_error", serde_json::json!({
                                    "error": "Translation paused — connection issue",
                                    "consecutive_failures": count,
                                }));
                            }
                            return Err(e.to_string());
                        }
                    }
                }
            }
        }
        // Reset failure counter on success
        {
            let mut router = trans_arc.lock().map_err(|_| "Lock poisoned")?;
            router.reset_failures();
        }
        parts.join("")
    };

    // Cache the result
    {
        let mut router = trans_arc.lock().map_err(|_| "Lock poisoned")?;
        router.cache_mut().insert(&text, &target, translated.clone());
    }

    Ok(TranslationResult {
        segment_id: None,
        original_text: text,
        translated_text: translated,
        source_lang: source.as_deref().unwrap_or("auto").to_string(),
        target_lang: target,
        provider: provider_name,
    })
}

#[command]
pub async fn translate_segments(
    app: AppHandle,
    segment_ids: Vec<String>,
    texts: Vec<String>,
    meeting_id: String,
    target_lang: Option<String>,
    source_lang: Option<String>,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let target = target_lang.ok_or("target_lang is required")?;
    let source = source_lang.as_deref();

    let trans_arc = state.translation.as_ref()
        .ok_or("Translation router not initialized")?;

    // Clone provider Arc out of lock scope — safe to .await
    let (provider_arc, provider_name, is_llm) = {
        let router = trans_arc.lock().map_err(|_| "Lock poisoned")?;
        let p = router.get_provider().map_err(|e| e.to_string())?;
        let name = p.provider_name().to_string();
        let is_llm = router.active_type() == Some(&TranslationProviderType::Llm);
        (p, name, is_llm)
    };

    for (seg_id, text) in segment_ids.iter().zip(texts.iter()) {
        let translated = if is_llm {
            translate_via_llm(&app, text, source, &target).await?
        } else {
            provider_arc.translate(text, source, &target).await
                .map_err(|e| e.to_string())?
        };

        // Save to DB
        if let Some(ref db_arc) = state.database {
            if let Ok(db) = db_arc.lock() {
                let _ = crate::db::translation::save_translation(
                    db.connection(),
                    seg_id,
                    &meeting_id,
                    source.unwrap_or("auto"),
                    &target,
                    text,
                    &translated,
                    &provider_name,
                );
            }
        }

        // Emit result event
        let result = TranslationResult {
            segment_id: Some(seg_id.clone()),
            original_text: text.clone(),
            translated_text: translated,
            source_lang: source.as_deref().unwrap_or("auto").to_string(),
            target_lang: target.clone(),
            provider: provider_name.clone(),
        };
        let _ = app.emit("translation_result", &result);
    }

    Ok(())
}

#[command]
pub async fn translate_batch(
    app: AppHandle,
    meeting_id: String,
    target_lang: Option<String>,
) -> Result<serde_json::Value, String> {
    let state = app.state::<AppState>();
    let target = target_lang.ok_or("target_lang is required")?;

    // Count total segments and load only untranslated ones (skip already-translated to save API calls)
    let (total, already_done, untranslated): (usize, usize, Vec<(String, String)>) = {
        let db_arc = state.database.as_ref().ok_or("DB not initialized")?;
        let db = db_arc.lock().map_err(|_| "DB lock poisoned")?;

        let total: usize = db.connection().query_row(
            "SELECT COUNT(*) FROM transcript_segments WHERE meeting_id = ?1 AND is_final = 1",
            [&meeting_id],
            |row| row.get(0),
        ).map_err(|e| e.to_string())?;

        let already_done = crate::db::translation::count_meeting_translations(
            db.connection(), &meeting_id, &target,
        ).map_err(|e| e.to_string())?;

        let mut stmt = db.connection().prepare(
            "SELECT ts.id, ts.text FROM transcript_segments ts
             WHERE ts.meeting_id = ?1 AND ts.is_final = 1
               AND ts.id NOT IN (
                 SELECT segment_id FROM transcript_translations
                 WHERE meeting_id = ?1 AND target_lang = ?2
               )
             ORDER BY ts.timestamp_ms"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([&meeting_id, &target], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }).map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

        (total, already_done, rows)
    };

    // Nothing to translate — emit completed and return
    if untranslated.is_empty() {
        let _ = app.emit("batch_translation_progress", serde_json::json!({
            "meetingId": meeting_id,
            "completed": total,
            "total": total,
            "targetLang": target,
        }));
        return Ok(serde_json::json!({
            "total": total,
            "alreadyDone": already_done,
            "newlyTranslated": 0,
        }));
    }

    // Emit initial progress so UI shows the starting point (e.g. 10/24)
    if already_done > 0 {
        let _ = app.emit("batch_translation_progress", serde_json::json!({
            "meetingId": meeting_id,
            "completed": already_done,
            "total": total,
            "targetLang": target,
        }));
    }

    let (provider_arc, provider_name, is_llm) = {
        let trans_arc = state.translation.as_ref()
            .ok_or("Translation router not initialized")?;
        let router = trans_arc.lock().map_err(|_| "Lock poisoned")?;
        let p = router.get_provider().map_err(|e| e.to_string())?;
        let is_llm = router.active_type() == Some(&TranslationProviderType::Llm);
        (p, router.active_provider_name(), is_llm)
    };

    // Translate only untranslated segments in chunks of 10
    let mut completed = already_done;
    for chunk in untranslated.chunks(10) {
        let texts: Vec<String> = chunk.iter().map(|(_, t)| t.clone()).collect();

        let translations = if is_llm {
            let mut results = Vec::with_capacity(texts.len());
            for text in &texts {
                results.push(translate_via_llm(&app, text, None, &target).await?);
            }
            results
        } else {
            provider_arc.translate_batch(&texts, None, &target).await
                .map_err(|e| e.to_string())?
        };

        // Save each translation
        for ((seg_id, orig_text), translated) in chunk.iter().zip(translations.iter()) {
            if let Some(ref db_arc) = state.database {
                if let Ok(db) = db_arc.lock() {
                    let _ = crate::db::translation::save_translation(
                        db.connection(), seg_id, &meeting_id,
                        "auto", &target, orig_text, translated, &provider_name,
                    );
                }
            }

            let result = TranslationResult {
                segment_id: Some(seg_id.clone()),
                original_text: orig_text.clone(),
                translated_text: translated.clone(),
                source_lang: "auto".to_string(),
                target_lang: target.clone(),
                provider: provider_name.clone(),
            };
            let _ = app.emit("translation_result", &result);
        }

        // Emit progress
        completed += chunk.len();
        let _ = app.emit("batch_translation_progress", serde_json::json!({
            "meetingId": meeting_id,
            "completed": completed.min(total),
            "total": total,
            "targetLang": target,
        }));
    }

    let newly_translated = completed - already_done;
    Ok(serde_json::json!({
        "total": total,
        "alreadyDone": already_done,
        "newlyTranslated": newly_translated,
    }))
}

#[command]
pub async fn detect_language(
    app: AppHandle,
    text: String,
) -> Result<DetectedLanguage, String> {
    let state = app.state::<AppState>();
    let trans_arc = state.translation.as_ref()
        .ok_or("Translation router not initialized")?;
    let provider_arc = {
        let router = trans_arc.lock().map_err(|_| "Lock poisoned")?;
        router.get_provider().map_err(|e| e.to_string())?
        // lock dropped here
    };
    provider_arc.detect_language(&text).await.map_err(|e| e.to_string())
}

#[command]
pub async fn test_translation_connection(
    app: AppHandle,
    _provider: String,
) -> Result<ConnectionStatus, String> {
    let state = app.state::<AppState>();
    let trans_arc = state.translation.as_ref()
        .ok_or("Translation router not initialized")?;
    let provider_arc = {
        let router = trans_arc.lock().map_err(|_| "Lock poisoned")?;
        router.get_provider().map_err(|e| e.to_string())?
        // lock dropped here
    };
    provider_arc.test_connection().await.map_err(|e| e.to_string())
}

#[command]
pub async fn get_translation_languages(
    app: AppHandle,
) -> Result<Vec<Language>, String> {
    let state = app.state::<AppState>();
    let trans_arc = state.translation.as_ref()
        .ok_or("Translation router not initialized")?;
    let provider_arc = {
        let router = trans_arc.lock().map_err(|_| "Lock poisoned")?;
        router.get_provider().map_err(|e| e.to_string())?
        // lock dropped here
    };
    provider_arc.supported_languages().await.map_err(|e| e.to_string())
}

#[command]
pub async fn get_meeting_translations(
    app: AppHandle,
    meeting_id: String,
    target_lang: String,
) -> Result<Vec<TranslationResult>, String> {
    let state = app.state::<AppState>();
    let db_arc = state.database.as_ref().ok_or("DB not initialized")?;
    let db = db_arc.lock().map_err(|_| "DB lock poisoned")?;

    let rows = crate::db::translation::get_meeting_translations(
        db.connection(), &meeting_id, &target_lang
    ).map_err(|e| e.to_string())?;

    Ok(rows.into_iter().map(|r| TranslationResult {
        segment_id: Some(r.segment_id),
        original_text: r.original_text,
        translated_text: r.translated_text,
        source_lang: r.source_lang,
        target_lang: r.target_lang,
        provider: r.provider,
    }).collect())
}

#[command]
pub async fn get_all_meeting_translations(
    app: AppHandle,
    meeting_id: String,
) -> Result<Vec<TranslationResult>, String> {
    let state = app.state::<AppState>();
    let db_arc = state.database.as_ref().ok_or("DB not initialized")?;
    let db = db_arc.lock().map_err(|_| "DB lock poisoned")?;

    let rows = crate::db::translation::get_all_meeting_translations(
        db.connection(), &meeting_id
    ).map_err(|e| e.to_string())?;

    Ok(rows.into_iter().map(|r| TranslationResult {
        segment_id: Some(r.segment_id),
        original_text: r.original_text,
        translated_text: r.translated_text,
        source_lang: r.source_lang,
        target_lang: r.target_lang,
        provider: r.provider,
    }).collect())
}

/// Helper: translate text using the configured LLM provider
/// instead of a dedicated translation API.
///
/// Since LLMProvider::stream_completion emits tokens via Tauri events
/// (llm_stream_token) and returns CompletionStats (no content field),
/// we listen for stream tokens, collect them into a buffer, then return
/// the assembled text.
async fn translate_via_llm(
    app: &AppHandle,
    text: &str,
    source: Option<&str>,
    target: &str,
) -> Result<String, String> {
    let state = app.state::<AppState>();
    let llm_arc = state.llm.as_ref().ok_or("LLM router not initialized")?;

    let src_label = source.unwrap_or("the detected language");
    let prompt = format!(
        "Translate the following text from {} to {}. \
         Return ONLY the translation, no explanations or commentary.\n\n{}",
        src_label, target, text
    );

    let messages = vec![crate::llm::provider::LLMMessage {
        role: "user".to_string(),
        content: prompt,
    }];

    let provider_arc = {
        let router = llm_arc.lock().map_err(|_| "LLM lock poisoned")?;
        router.get_provider().map_err(|e| format!("LLM not configured: {}", e))?
    };

    let model = {
        let router = llm_arc.lock().map_err(|_| "LLM lock poisoned")?;
        router.active_model().to_string()
    };

    // Set up a buffer to collect streamed tokens
    let buffer = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let buffer_clone = buffer.clone();

    // Listen for stream tokens and collect them
    let listener_id = app.listen("llm_stream_token", move |event| {
        if let Ok(payload) = serde_json::from_str::<crate::llm::provider::StreamTokenPayload>(event.payload()) {
            if let Ok(mut buf) = buffer_clone.lock() {
                buf.push_str(&payload.token);
            }
        }
    });

    let params = crate::llm::provider::GenerationParams::default();
    let provider = provider_arc.lock().await;
    let result = provider.stream_completion(
        messages, &model, params, app.clone()
    ).await;

    // Stop listening
    app.unlisten(listener_id);

    // Check for errors
    result.map_err(|e| format!("LLM translation failed: {}", e))?;

    // Extract collected text
    let collected = buffer.lock()
        .map_err(|_| "Buffer lock poisoned".to_string())?
        .clone();

    if collected.is_empty() {
        return Err("LLM returned empty translation".to_string());
    }

    Ok(collected)
}

#[command]
pub async fn export_translated_transcript(
    app: AppHandle,
    meeting_id: String,
    target_lang: String,
    format: String,
) -> Result<String, String> {
    let state = app.state::<AppState>();
    let db_arc = state.database.as_ref().ok_or("DB not initialized")?;
    let db = db_arc.lock().map_err(|_| "DB lock poisoned")?;

    // Load segments
    let mut seg_stmt = db.connection().prepare(
        "SELECT id, text, speaker, timestamp_ms FROM transcript_segments
         WHERE meeting_id = ?1 AND is_final = 1 ORDER BY timestamp_ms"
    ).map_err(|e| e.to_string())?;

    let segments: Vec<(String, String, String, i64)> = seg_stmt
        .query_map([&meeting_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    // Load translations
    let translations = crate::db::translation::get_meeting_translations(
        db.connection(), &meeting_id, &target_lang
    ).map_err(|e| e.to_string())?;

    let trans_map: std::collections::HashMap<String, String> = translations
        .into_iter()
        .map(|t| (t.segment_id, t.translated_text))
        .collect();

    let mut output = String::new();

    match format.as_str() {
        "translated_txt" => {
            for (seg_id, _orig, speaker, _ts) in &segments {
                let translated = trans_map.get(seg_id).cloned().unwrap_or_else(|| "[not translated]".into());
                output.push_str(&format!("{}: {}\n", speaker, translated));
            }
        }
        "bilingual_txt" => {
            for (seg_id, orig, speaker, _ts) in &segments {
                let translated = trans_map.get(seg_id).cloned().unwrap_or_else(|| "[not translated]".into());
                output.push_str(&format!("{}: {}\n", speaker, orig));
                output.push_str(&format!("  → {}\n\n", translated));
            }
        }
        "bilingual_md" => {
            output.push_str("# Translated Transcript\n\n");
            for (seg_id, orig, speaker, ts) in &segments {
                let minutes = ts / 60000;
                let seconds = (ts % 60000) / 1000;
                let translated = trans_map.get(seg_id).cloned().unwrap_or_else(|| "[not translated]".into());
                output.push_str(&format!("**{}** _{:02}:{:02}_\n", speaker, minutes, seconds));
                output.push_str(&format!("> {}\n", orig));
                output.push_str(&format!("> _{}_\n\n", translated));
            }
        }
        _ => return Err(format!("Unknown export format: {}", format)),
    }

    Ok(output)
}
