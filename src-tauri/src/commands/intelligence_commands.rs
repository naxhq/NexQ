use std::sync::Arc;

use tauri::{command, AppHandle, Emitter, State};

use crate::intelligence::action_config::{AllActionConfigs, InstructionPresets};
use crate::intelligence::context_scope::{self, ResolvedScope, TranscriptWindow};
use crate::intelligence::IntelligenceEngine;
use crate::llm::cli_agent::context::Seg;
use crate::llm::cli_agent::manager::{OnDelta, SessionKey, SessionScope};
use crate::llm::cli_agent::protocol::{AgentErrorKind, TurnResult};
use crate::llm::cli_agent::routing::{
    self, choose_route, AgentFallbackPayload, AskFailure, ClaudeHealth, Route,
};
use crate::llm::provider::{
    emit_error, emit_token, is_cancelled, CancelToken, GenerationParams, LLMProvider,
    RagChunkInfo, StreamEndPayload, StreamStartPayload,
};
use crate::llm::{create_provider, ProviderConfig, ProviderType};
use crate::rag;
use crate::state::AppState;

/// Compose instruction presets + custom text into a single string.
/// Mirrors the frontend's `composeInstructions()` in aiActionsStore.ts.
pub(crate) fn compose_instructions(presets: &InstructionPresets, custom: &str) -> String {
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

/// Build transcript text from frontend-provided segments, applying the window
/// (the per-action window or the user's scope), and the window that applied
/// in seconds (0 = all). Segments whose span overlaps the window are kept
/// (see `context_scope::overlapping`).
/// The frontend transcript store is the single source of truth for ALL STT engines.
/// When `include_segment_ids` is true, each line includes the segment ID for LLM reference.
/// STT engines stamp segments either in epoch ms or relative to their stream
/// start, so segment times and a `Since` cutoff are compared relative to the
/// live meeting's `start_ms` (0 when there is none), like the session path.
fn build_transcript_from_segments(
    segments_json: &str,
    window: TranscriptWindow,
    include_segment_ids: bool,
    start_ms: i64,
) -> (String, u64) {
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
            return (String::new(), context_scope::effective_window_seconds(window, &[]));
        }
    };

    let starts: Vec<u64> = segments
        .iter()
        .map(|s| routing::relative_ms(s.timestamp_ms as i64, start_ms))
        .collect();
    let window = match window {
        TranscriptWindow::Since(ms) => TranscriptWindow::Since(routing::relative_ms(ms, start_ms) as i64),
        other => other,
    };
    let effective_window = context_scope::effective_window_seconds(window, &starts);

    let text = context_scope::overlapping(&starts, window)
        .into_iter()
        .map(|i| &segments[i])
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
        .join("\n");
    (text, effective_window)
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

/// Document excerpts found by RAG retrieval for one request, plus the
/// metadata the AI Log shows.
#[derive(Default)]
struct RagRetrieval {
    /// Formatted excerpts for the prompt (empty when nothing matched).
    context_text: String,
    query: Option<String>,
    chunks: Vec<RagChunkInfo>,
    filtered: usize,
    total_candidates: usize,
}

/// Search the indexed documents for `question_text` and the recent
/// transcript (`transcript_excerpt`), keeping the `top_k` best chunks.
async fn retrieve_rag(
    state: &AppState,
    question_text: Option<String>,
    transcript_excerpt: String,
    top_k: usize,
) -> Result<RagRetrieval, String> {
    let mut out = RagRetrieval::default();

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

    if !(has_question || has_transcript) || !has_indexed_chunks {
        return Ok(out);
    }
    let (Some(rag_arc), Some(db_arc)) = (state.rag.as_ref(), state.database.as_ref()) else {
        return Ok(out);
    };

    let (mut config, embedder_url, embedding_model) = {
        let rag_guard = rag_arc.lock().map_err(|e| e.to_string())?;
        (rag_guard.config().clone(), rag_guard.embedder_url(), rag_guard.embedding_model())
    };
    config.top_k = top_k;

    let mut all_chunks: Vec<rag::search::ScoredChunk> = Vec::new();

    // Search 1: question only (clean semantic match)
    if let Some(ref q) = question_text {
        out.query = Some(q.clone());
        match rag::RagManager::search_async(db_arc, q, &config, &embedder_url, &embedding_model).await {
            Ok(chunks) => all_chunks.extend(chunks),
            Err(e) => log::warn!("RAG search (question-only) failed: {}", e),
        }
    }

    // Search 2: question + transcript (contextual match)
    if has_question && has_transcript {
        let combined = format!("{}\n\n{}", question_text.as_ref().unwrap(), transcript_excerpt);
        if out.query.is_none() {
            out.query = Some(combined.clone());
        }
        match rag::RagManager::search_async(db_arc, &combined, &config, &embedder_url, &embedding_model).await {
            Ok(chunks) => all_chunks.extend(chunks),
            Err(e) => log::warn!("RAG search (combined) failed: {}", e),
        }
    } else if !has_question && has_transcript {
        // No question at all — search with transcript only as last resort
        out.query = Some(transcript_excerpt.clone());
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
    merged.truncate(top_k);

    // Build metadata for AI log
    for c in &merged {
        out.chunks.push(RagChunkInfo {
            source: c.source_file.clone(),
            chunk_index: c.chunk_index,
            text: c.text.clone(),
            normalized_score: c.normalized_score,
            raw_score: c.score,
        });
    }
    out.total_candidates = top_k;
    if merged.len() < top_k {
        out.filtered = top_k - merged.len();
    }
    if !merged.is_empty() {
        out.context_text = rag::prompt_builder::build_rag_context(&merged, "");
    }
    Ok(out)
}

/// The last 500 characters of `text` (the RAG query's transcript context).
/// Most document text sent per request when RAG retrieval finds nothing
/// (~8k tokens): stateless providers resend it on every request.
const DOC_FALLBACK_CHARS: usize = 32_000;

/// The attached documents' text, capped at [`DOC_FALLBACK_CHARS`]; None when
/// nothing is attached.
fn attached_documents_fallback(state: &AppState) -> Option<String> {
    let text = state.context.as_ref()?.lock().ok()?.get_resources_context();
    cap_document_text(&text, DOC_FALLBACK_CHARS)
}

fn cap_document_text(text: &str, max_chars: usize) -> Option<String> {
    if text.trim().is_empty() {
        return None;
    }
    if text.chars().count() <= max_chars {
        return Some(text.to_string());
    }
    let head: String = text.chars().take(max_chars).collect();
    Some(format!("{head}

[… documents truncated — index them for full coverage]"))
}

fn tail_chars(text: &str, n: usize) -> String {
    let count = text.chars().count();
    text.chars().skip(count.saturating_sub(n)).collect()
}

/// The meeting scope of a request (the past meeting it names, else the
/// running meeting, else none: Utility) and that scope's close epoch, read
/// together so a meeting ending right after can't have its session
/// recreated by this request (see `MeetingSessions::ensure_current`).
fn request_scope(state: &AppState, past_meeting_id: Option<&str>) -> (SessionScope, u64) {
    if let Some(id) = past_meeting_id.filter(|id| !id.is_empty()) {
        let scope = SessionScope::Past(id.to_string());
        let epoch = state.meeting_sessions.epoch(&scope);
        return (scope, epoch);
    }
    // The epoch is read under the `live_meeting` lock: `end_meeting` clears
    // the live meeting before it closes the scope, so a request that still
    // sees the meeting holds the epoch from before the close.
    let live = state.live_meeting.lock().ok();
    let scope = match live.as_ref().and_then(|m| m.as_ref().map(|m| m.id.clone())) {
        Some(id) => SessionScope::Live(id),
        None => SessionScope::Utility,
    };
    let epoch = state.meeting_sessions.epoch(&scope);
    drop(live);
    (scope, epoch)
}

/// Where this request goes (see `choose_route`).
pub(crate) fn request_route(state: &AppState, mode: &str, scope: &SessionScope) -> Route {
    let active = state
        .llm
        .as_ref()
        .and_then(|l| l.lock().ok())
        .and_then(|r| r.active_provider_type().cloned());
    let Some(active) = active else {
        return Route::Stateless;
    };
    let cfg = state
        .claude_cli_config
        .read()
        .map(|c| c.clone())
        .unwrap_or_default();
    choose_route(&active, state.claude_health.get(), scope, mode, &cfg)
}

/// Fallback provider, model and display name for `config` (type only): the
/// API key comes from the credential store; the model is the configured
/// fallback model, else the provider's first listed model. The result is
/// cached until the provider, model or key changes.
async fn resolve_fallback(
    state: &AppState,
    mut config: ProviderConfig,
) -> Result<(Arc<tokio::sync::Mutex<Box<dyn LLMProvider>>>, String, String), String> {
    let provider_type = ProviderType::from_str(&config.provider_type).map_err(|e| e.to_string())?;
    if config.api_key.is_none() {
        config.api_key = state
            .credentials
            .as_ref()
            .and_then(|c| c.lock().ok())
            .and_then(|c| c.get_key(&config.provider_type).ok().flatten());
    }
    let configured = state
        .claude_cli_config
        .read()
        .ok()
        .and_then(|c| c.fallback_model.clone())
        .filter(|m| !m.trim().is_empty());
    let cache_key = (config.provider_type.clone(), configured.clone(), config.api_key.clone());
    if let Some(cached) = state.claude_fallback.lock().ok().and_then(|slot| {
        slot.as_ref()
            .filter(|c| c.key == cache_key)
            .map(|c| (c.provider.clone(), c.model.clone(), c.name.clone()))
    }) {
        return Ok(cached);
    }
    let provider = create_provider(&config)
        .map_err(|e| format!("Fallback provider {} unavailable: {}", provider_type.display_name(), e))?;
    let model = match configured {
        Some(model) => model,
        None => provider
            .list_models()
            .await
            .ok()
            .and_then(|models| models.into_iter().next())
            .map(|m| m.id)
            .ok_or_else(|| {
                format!("Fallback provider {} has no model to use", provider_type.display_name())
            })?,
    };
    let resolved = routing::CachedFallback {
        key: cache_key,
        provider: Arc::new(tokio::sync::Mutex::new(provider)),
        model,
        name: provider_type.display_name().to_string(),
    };
    let out = (resolved.provider.clone(), resolved.model.clone(), resolved.name.clone());
    if let Ok(mut slot) = state.claude_fallback.lock() {
        *slot = Some(resolved);
    }
    Ok(out)
}

/// Everything the Claude session path needs from a request.
pub(crate) struct SessionAssist<'a> {
    pub key: SessionKey,
    /// The scope's close epoch when the request chose it.
    pub epoch: u64,
    pub mode: &'a str,
    pub custom_question: Option<&'a str>,
    pub detected_question: Option<String>,
    pub transcript_segments: Option<&'a str>,
    /// The transcript scope the user picked (`None` = the action's default).
    pub scope: Option<&'a ResolvedScope>,
    pub task_instructions: String,
    pub include_rag: bool,
    pub include_instructions: bool,
    pub include_question: bool,
    pub rag_top_k: usize,
    pub temperature: f64,
    pub params: GenerationParams,
    pub cancel: Arc<CancelToken>,
}

/// A request a Claude session answered: what was sent, which model
/// answered, and the turn's result (text and tokens).
pub(crate) struct SessionAnswer {
    pub prompt: String,
    pub model: String,
    pub turn: TurnResult,
}

/// How the Claude session path ended.
pub(crate) enum SessionOutcome {
    /// Answered (`Some`), or stopped, closed, or failed with an error that
    /// is not an outage (already reported to the UI).
    Done(Result<Option<SessionAnswer>, String>),
    /// The session's context was full: answer this request statelessly.
    Stateless,
    /// Claude is unavailable (after one restart where it applies).
    Unavailable(AgentErrorKind, String),
}

/// Answer one request on the meeting's warm Claude session: only the
/// transcript the session has not seen goes out, with the action's own
/// prompt and presets as `## Task instructions`.
pub(crate) async fn session_assist(state: &AppState, app: &AppHandle, req: SessionAssist<'_>) -> SessionOutcome {
    let start = std::time::Instant::now();
    let SessionAssist { key, mode, params, cancel, .. } = &req;

    let live_start_ms = match &key.scope {
        SessionScope::Live(_) => state.live_meeting.lock().ok().and_then(|m| m.clone()).map(|m| m.start_ms).unwrap_or(0),
        _ => 0,
    };
    let finals = match &key.scope {
        SessionScope::Live(_) => {
            req.transcript_segments
                .map(|json| routing::segments_from_json(json, live_start_ms))
                .unwrap_or_default()
        }
        // The whole transcript is preloaded into a past-meeting session.
        _ => Vec::new(),
    };

    let ready = state.meeting_sessions.ensure_current(key, req.epoch, || match &key.scope {
        SessionScope::Live(_) => Ok(crate::commands::meeting_commands::live_session_record(state, key.tier, &finals)),
        SessionScope::Past(id) => crate::commands::meeting_commands::past_session_record(state, id),
        SessionScope::Utility => Err("Utility requests have no meeting session".to_string()),
    });
    match ready {
        Ok(true) => {}
        // The meeting ended / its view was left since the request chose it.
        Ok(false) => return end_closed(app, params, start),
        Err(e) => {
            emit_error(app, params, &e);
            return SessionOutcome::Done(Err(e));
        }
    }
    let record = state.meeting_sessions.get(key).unwrap_or_default();

    // Documents over the preload cap: retrieve the relevant excerpts per request.
    let mut rag = RagRetrieval::default();
    if record.rag_mode && req.include_rag {
        let question_text = req
            .custom_question
            .filter(|q| !q.is_empty())
            .map(str::to_string)
            .or_else(|| req.detected_question.clone());
        let recent: String = finals
            .iter()
            .map(|s| format!("{}: {}", s.speaker, s.text))
            .collect::<Vec<_>>()
            .join("\n");
        match retrieve_rag(state, question_text, tail_chars(&recent, 500), req.rag_top_k).await {
            Ok(found) => rag = found,
            Err(e) => log::warn!("RAG retrieval for the Claude session failed: {e}"),
        }
    }
    // Bookmark suggestions cite segment ids: the session already holds every
    // line tagged with its id (preload and deltas), so nothing extra is sent.

    let session_key = routing::session_key_label(key);
    let rag_context = rag.context_text.clone();
    // The user's scope rides along as a short note (no section for the default).
    let scope_note = context_scope::session_scope_note(req.scope, live_start_ms).unwrap_or_default();
    let scope_label = ResolvedScope::label_of(req.scope);
    let compose = |new: &[Seg]| {
        routing::compose_delta(
            new,
            &[
                ("## Relevant document excerpts", rag_context.as_str()),
                (context_scope::SCOPE_HEADER, scope_note.as_str()),
            ],
            &req.task_instructions,
            req.custom_question,
            req.detected_question.as_deref(),
        )
    };
    // What was sent and to which model, for the caller (saved chat, replay).
    let sent: std::sync::Mutex<Option<(String, String)>> = std::sync::Mutex::new(None);
    let on_sent = |prompt: &str, model: &str, new_count: usize| {
        if let Ok(mut slot) = sent.lock() {
            *slot = Some((prompt.to_string(), model.to_string()));
        }
        let _ = app.emit(
            "llm_stream_start",
            StreamStartPayload {
                mode: mode.to_string(),
                model: model.to_string(),
                provider: ProviderType::ClaudeCli.display_name().to_string(),
                system_prompt: record.system_prompt.clone(),
                user_prompt: prompt.to_string(),
                include_transcript: new_count > 0,
                include_rag: !rag.chunks.is_empty(),
                include_instructions: req.include_instructions,
                include_question: req.include_question,
                temperature: req.temperature,
                rag_query: rag.query.clone(),
                rag_chunks: rag.chunks.clone(),
                rag_chunks_filtered: rag.filtered,
                rag_total_candidates: rag.total_candidates,
                transcript_window_seconds: 0,
                transcript_segments_count: new_count,
                transcript_segments_total: finals.len(),
                request_id: params.request_id.clone(),
                session_key: Some(session_key.clone()),
                scope_label: scope_label.clone(),
            },
        );
    };
    // First words (from `start`, like the end's latency) and a once-per-request
    // thinking signal, across a restart's second attempt too.
    let timing = Arc::new(crate::llm::cli_agent::provider::StreamTiming::new(start));
    let make_on_delta = || -> OnDelta {
        let app = app.clone();
        let params = params.clone();
        let timing = timing.clone();
        Box::new(move |token: &str| {
            let thinking = timing.on_delta(token);
            if is_cancelled(&params) {
                return;
            }
            if thinking {
                crate::llm::provider::emit_thinking(&app, &params);
            } else if !token.is_empty() {
                emit_token(&app, &params, token, None);
            }
        })
    };

    let result = routing::ask_meeting_session(
        &state.agent_sessions,
        &state.meeting_sessions,
        key,
        &finals,
        compose,
        on_sent,
        make_on_delta,
        cancel.clone(),
    )
    .await;

    match result {
        // A stopped stream already got its end from `cancel_generation`.
        _ if cancel.is_cancelled() => SessionOutcome::Done(Ok(None)),
        Ok(turn) => {
            state.claude_health.record_success();
            let total = turn.prompt_tokens() + turn.output_tokens;
            let usage = crate::llm::cli_agent::provider::stream_usage(&turn, timing.first_token_ms());
            crate::llm::provider::emit_end_with_usage(
                app,
                params,
                total,
                start.elapsed().as_millis() as u64,
                Some(usage),
            );
            let (prompt, model) = sent.lock().ok().and_then(|mut s| s.take()).unwrap_or_default();
            SessionOutcome::Done(Ok(Some(SessionAnswer { prompt, model, turn })))
        }
        Err(AskFailure::Cancelled) => SessionOutcome::Done(Ok(None)),
        // The meeting ended / its view was left mid-request: just end the
        // stream (no outage, no fallback).
        Err(AskFailure::Closed) => end_closed(app, params, start),
        // Part of the answer is already on screen: report, don't repeat it.
        Err(AskFailure::AfterOutput(e)) | Err(AskFailure::Error(e)) => {
            let message = e.to_string();
            emit_error(app, params, &message);
            SessionOutcome::Done(Err(message))
        }
        Err(AskFailure::ContextFull(e)) => {
            log::warn!("Claude session context full ({e}); answering this request statelessly");
            SessionOutcome::Stateless
        }
        Err(AskFailure::Unavailable(kind, e)) => SessionOutcome::Unavailable(kind, e.to_string()),
    }
}

/// A session request whose meeting closed: just end the stream (no outage,
/// no fallback).
fn end_closed(app: &AppHandle, params: &GenerationParams, start: std::time::Instant) -> SessionOutcome {
    let _ = app.emit(
        "llm_stream_end",
        StreamEndPayload {
            total_tokens: 0,
            latency_ms: start.elapsed().as_millis() as u64,
            request_id: params.request_id.clone(),
            cancelled: true,
            usage: None,
        },
    );
    SessionOutcome::Done(Ok(None))
}

/// Claude turned out unavailable for a session request: mark it so and
/// return the fallback route (the same decision as for a request arriving
/// while Claude is down), or report the outage when no fallback is set.
pub(crate) fn route_after_outage(
    state: &AppState,
    app: &AppHandle,
    mode: &str,
    scope: &SessionScope,
    kind: AgentErrorKind,
    reason: &str,
    params: &GenerationParams,
) -> Result<Route, String> {
    log::warn!("Claude unavailable ({reason}); falling back");
    state.claude_health.mark_unavailable(kind);
    match request_route(state, mode, scope) {
        fallback @ Route::Fallback(_) => Ok(fallback),
        _ => {
            // No fallback to switch to: a usage limit is still announced once
            // per outage (empty `provider` = nothing took over).
            if kind == AgentErrorKind::RateLimited && state.claude_health.take_fallback_notice() {
                let _ = app.emit(
                    routing::FALLBACK_EVENT,
                    AgentFallbackPayload {
                        reason: routing::reason_label(kind).to_string(),
                        provider: String::new(),
                    },
                );
            }
            let message = format!("Claude unavailable ({}): {}", routing::reason_label(kind), reason);
            emit_error(app, params, &message);
            Err(message)
        }
    }
}

/// The provider for today's full-prompt path, with its model, display name
/// and type: the fallback provider on [`Route::Fallback`] (announcing the
/// outage once with `agent_fallback`), else the active provider.
pub(crate) async fn stateless_provider(
    state: &AppState,
    app: &AppHandle,
    route: &Route,
    params: &GenerationParams,
) -> Result<(Arc<tokio::sync::Mutex<Box<dyn LLMProvider>>>, String, String, Option<ProviderType>), String> {
    match route {
        Route::Fallback(config) => match resolve_fallback(state, config.clone()).await {
            Ok((provider, model, name)) => {
                if state.claude_health.take_fallback_notice() {
                    let reason = match state.claude_health.get() {
                        ClaudeHealth::Unavailable(kind) => routing::reason_label(kind),
                        ClaudeHealth::Healthy => "unavailable",
                    };
                    let _ = app.emit(
                        routing::FALLBACK_EVENT,
                        AgentFallbackPayload {
                            reason: reason.to_string(),
                            provider: name.clone(),
                        },
                    );
                }
                let provider_type = ProviderType::from_str(&config.provider_type).ok();
                Ok((provider, model, name, provider_type))
            }
            Err(message) => {
                emit_error(app, params, &message);
                Err(message)
            }
        },
        _ => {
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

            Ok((provider, model_name, ptype, router.active_provider_type().cloned()))
        }
    }
}

#[command]
pub async fn generate_assist(
    mode: String,
    custom_question: Option<String>,
    transcript_segments: Option<String>,
    request_id: Option<String>,
    past_meeting_id: Option<String>,
    scope: Option<ResolvedScope>,
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // The user's transcript scope (`scope` names the session scope below).
    let user_scope = scope;
    // Every stream carries a request id so listeners can tell streams apart.
    let request_id = request_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    // Extract what we need from the intelligence engine under its lock
    let (generation_guard, last_question, cancel_token, action_config_snapshot, composed_instructions, presets) = {
        let intel = state
            .intelligence
            .as_ref()
            .ok_or_else(|| "Intelligence engine not initialized".to_string())?;
        let engine = intel
            .lock()
            .map_err(|e| format!("Failed to lock intelligence engine: {}", e))?;

        // The guard releases the engine on every exit path (early returns included),
        // and only once this function, and so `stream_completion`, has finished.
        // It covers the Claude session path and the fallback alike.
        let guard = engine
            .begin_generation(&request_id)
            .ok_or_else(|| "Generation already in progress".to_string())?;

        // Look up per-action config
        let action_cfg = engine.get_action_config(&mode).cloned();
        let global_defaults = engine.get_action_configs().global_defaults.clone();

        // Compose instructions from AllActionConfigs (reliable path — same sync as system prompts)
        let all_configs = engine.get_action_configs();
        let composed = compose_instructions(
            &all_configs.instruction_presets,
            &all_configs.custom_instructions,
        );
        // Presets alone: in a Claude session the custom text is in the session prompt.
        let presets = compose_instructions(&all_configs.instruction_presets, "");

        let question = engine.last_detected_question().cloned();
        let cancel = guard.cancel_token();

        (guard, question, cancel, (action_cfg, global_defaults), composed, presets)
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

    // Build generation params from per-action overrides or global defaults
    let temperature = action_cfg
        .as_ref()
        .and_then(|c| c.temperature)
        .unwrap_or(global_defaults.temperature);

    // ── Route: warm Claude session, fallback provider, or stateless ──
    let (scope, epoch) = request_scope(&state, past_meeting_id.as_deref());
    let mut route = request_route(&state, &mode, &scope);

    if let Route::ClaudeSession(key) = &route {
        // The action's own prompt (or the mode template) and presets travel in
        // the user message; the scenario prompt is the session's system prompt.
        let action_prompt = action_cfg
            .as_ref()
            .map(|c| c.system_prompt.clone())
            .unwrap_or_else(|| crate::intelligence::prompt_templates::get_system_prompt(&mode).to_string());
        let task_instructions = if include_instructions && !presets.is_empty() {
            format!("{}\n\n{}", action_prompt, presets)
        } else {
            action_prompt
        };
        let req = SessionAssist {
            key: key.clone(),
            epoch,
            mode: &mode,
            custom_question: custom_question.as_deref(),
            detected_question: if custom_question.is_none() {
                effective_question.as_ref().map(|q| q.text.clone())
            } else {
                None
            },
            transcript_segments: transcript_segments.as_deref(),
            scope: user_scope.as_ref(),
            task_instructions,
            include_rag,
            include_instructions,
            include_question,
            rag_top_k,
            temperature,
            params: GenerationParams {
                temperature: None,
                max_tokens: None,
                cache_name: None,
                enable_web_search: false,
                request_id: Some(request_id.clone()),
                silent: false,
                cancel: Some(cancel_token.clone()),
            },
            cancel: cancel_token.clone(),
        };
        match session_assist(&state, &app_handle, req).await {
            SessionOutcome::Done(result) => {
                // Release the engine only now that the stream has fully stopped.
                drop(generation_guard);
                return result.map(|_| ());
            }
            SessionOutcome::Stateless => route = Route::Stateless,
            SessionOutcome::Unavailable(kind, reason) => {
                let params = GenerationParams {
                    request_id: Some(request_id.clone()),
                    cancel: Some(cancel_token.clone()),
                    ..GenerationParams::default()
                };
                route = route_after_outage(&state, &app_handle, &mode, &scope, kind, &reason, &params)?;
            }
        }
    }

    // ── Today's stateless full-prompt path (active or fallback provider) ──

    // Determine transcript window: per-action override or global default,
    // unless the user picked a scope for this request.
    let action_window_seconds = default_window_seconds(
        &mode,
        action_cfg.as_ref().and_then(|c| c.transcript_window_seconds),
        global_defaults.transcript_window_seconds,
    );
    let window = context_scope::stateless_window(user_scope.as_ref(), action_window_seconds);
    let mut window_seconds = match window {
        TranscriptWindow::Seconds(secs) => secs,
        // No frontend segments to measure from (legacy buffer): the whole meeting.
        TranscriptWindow::Since(_) => 0,
    };

    // Build transcript from frontend segments (universal — works with any STT engine).
    // The frontend transcript store is the single source of truth.
    // Falls back to engine buffer only if frontend didn't send segments.
    let include_segment_ids = mode == "BookmarkSuggestions";
    let mut transcript_text = if let Some(ref segs) = transcript_segments {
        let start_ms = state
            .live_meeting
            .lock()
            .ok()
            .and_then(|m| m.as_ref().map(|m| m.start_ms))
            .unwrap_or(0);
        let (text, effective) = build_transcript_from_segments(segs, window, include_segment_ids, start_ms);
        window_seconds = effective;
        text
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

    // Get the LLM provider and model info: the fallback provider when Claude
    // is unavailable, else the active one.
    let (provider_arc, model, provider_name, provider_type) = {
        let params = GenerationParams {
            request_id: Some(request_id.clone()),
            cancel: Some(cancel_token.clone()),
            ..GenerationParams::default()
        };
        stateless_provider(&state, &app_handle, &route, &params).await?
    };

    // Check for active Gemini context cache — only applies when Gemini is the provider
    let active_cache_name = if provider_type == Some(ProviderType::Gemini) {
        state.gemini_cache
            .lock()
            .ok()
            .and_then(|slot| slot.as_ref().map(|c| c.name.clone()))
    } else {
        None
    };

    let enable_web_search = action_cfg.as_ref().map(|c| c.web_search).unwrap_or(false);

    let params = GenerationParams {
        temperature: Some(temperature),
        max_tokens: None,
        cache_name: active_cache_name.clone(),
        enable_web_search,
        request_id: Some(request_id),
        silent: false,
        cancel: Some(cancel_token.clone()),
    };

    // When Gemini cache is active, skip RAG entirely — no Ollama embed needed.
    // The full context is already cached on Gemini servers.
    // Note: we don't check config.enabled here — the action-level include_rag
    // toggle is the user's intent. If they enabled RAG for this action and have
    // indexed files, we should search. (config.enabled defaults to false and is
    // inconsistently set, while Test Knowledge Base ignores it entirely.)
    let mut rag = if include_rag && active_cache_name.is_none() {
        // RAG query sources (priority: custom_question > effective_question > transcript)
        // custom_question is what the user typed (Ask mode) or the clicked question (Assist mode)
        // effective_question is the auto-detected question from the meeting
        let question_text = custom_question.as_deref()
            .filter(|q| !q.is_empty())
            .map(|q| q.to_string())
            .or_else(|| effective_question.as_ref().map(|q| q.text.clone()));
        retrieve_rag(&state, question_text, tail_chars(&transcript_text, 500), rag_top_k).await?
    } else {
        RagRetrieval::default()
    };
    // Nothing retrieved (no index yet, Ollama unreachable, or no match): include
    // the attached documents directly so the AI still has the meeting context.
    if include_rag && active_cache_name.is_none() && rag.context_text.is_empty() {
        if let Some(docs) = attached_documents_fallback(&state) {
            rag.context_text = docs;
        }
    }

    let context_text = rag.context_text;
    let include_context = !context_text.is_empty();

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
        rag.query,
        rag.chunks,
        rag.filtered,
        rag.total_candidates,
        window_seconds,
        included_segments,
        total_segments,
        ResolvedScope::label_of(user_scope.as_ref()),
        app_handle,
        cancel_token,
    )
    .await;

    // Release the engine only now that the stream has fully stopped.
    drop(generation_guard);

    result
}

#[command]
pub async fn cancel_generation(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let intel = state
        .intelligence
        .as_ref()
        .ok_or_else(|| "Intelligence engine not initialized".to_string())?;

    let engine = intel
        .lock()
        .map_err(|e| format!("Failed to lock intelligence engine: {}", e))?;

    // Only sets the flag: providers stop at the next chunk and the generation guard is
    // released when `generate_assist` returns. The cancelled end event is emitted here so
    // the UI settles immediately, tagged with the in-flight request id.
    let in_flight = engine.cancel();
    drop(engine);

    if let Some(request_id) = in_flight {
        let _ = app_handle.emit(
            "llm_stream_end",
            StreamEndPayload {
                total_tokens: 0,
                latency_ms: 0,
                request_id: Some(request_id),
                cancelled: true,
                usage: None,
            },
        );
    }
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

/// A meeting summary covers the whole meeting unless its action sets a window;
/// other actions fall back to the global window.
fn default_window_seconds(mode: &str, action_window: Option<u64>, global_window: u64) -> u64 {
    action_window.unwrap_or(if mode == "MeetingSummary" { 0 } else { global_window })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meeting_summary_defaults_to_whole_meeting() {
        assert_eq!(default_window_seconds("MeetingSummary", None, 300), 0);
        assert_eq!(default_window_seconds("MeetingSummary", Some(120), 300), 120);
        assert_eq!(default_window_seconds("Assist", None, 300), 300);
    }

    #[test]
    fn document_fallback_is_capped() {
        assert_eq!(cap_document_text("  
", 10), None);
        assert_eq!(cap_document_text("short doc", 10).as_deref(), Some("short doc"));
        let capped = cap_document_text(&"é".repeat(25), 10).unwrap();
        assert!(capped.starts_with(&"é".repeat(10)));
        assert!(!capped.starts_with(&"é".repeat(11)));
        assert!(capped.ends_with("index them for full coverage]"));
    }

    const SEGS: &str = r#"[
        {"id":"a","text":"Intro","speaker":"User","timestamp_ms":1000},
        {"id":"b","text":"A long merged answer","speaker":"Them","timestamp_ms":100000},
        {"id":"c","text":"Next","speaker":"User","timestamp_ms":290000}
    ]"#;

    #[test]
    fn stateless_transcript_keeps_segments_overlapping_the_window() {
        // 60 s before the newest segment = 230 s: "b" began earlier but ran until 290 s.
        let (text, window) = build_transcript_from_segments(SEGS, TranscriptWindow::Seconds(60), false, 0);
        assert_eq!(text, "[Them]: A long merged answer\n[You]: Next");
        assert_eq!(window, 60);
        let (text, window) = build_transcript_from_segments(SEGS, TranscriptWindow::Seconds(0), true, 0);
        assert_eq!(text.lines().count(), 3);
        assert!(text.starts_with("[a] You: Intro"));
        assert_eq!(window, 0);
    }

    #[test]
    fn stateless_transcript_since_a_time_reports_the_effective_window() {
        let (text, window) = build_transcript_from_segments(SEGS, TranscriptWindow::Since(200_000), false, 0);
        assert_eq!(text, "[Them]: A long merged answer\n[You]: Next");
        assert_eq!(window, 90);
        let (text, _) = build_transcript_from_segments("not json", TranscriptWindow::Since(0), false, 0);
        assert!(text.is_empty());
    }

    #[test]
    fn stateless_since_cutoff_matches_stream_relative_and_epoch_segments() {
        // Meeting started at epoch START; "Them" is stamped relative to its
        // stream (whisper.cpp, Groq...), "You" in epoch ms (Web Speech).
        const START: i64 = 1_700_000_000_000;
        let segs = format!(
            r#"[
            {{"id":"a","text":"Early","speaker":"Them","timestamp_ms":10000}},
            {{"id":"a2","text":"Before","speaker":"Them","timestamp_ms":60000}},
            {{"id":"b","text":"Mine","speaker":"User","timestamp_ms":{}}},
            {{"id":"c","text":"Late","speaker":"Them","timestamp_ms":200000}}
        ]"#,
            START + 150_000
        );
        let (text, window) =
            build_transcript_from_segments(&segs, TranscriptWindow::Since(START + 120_000), false, START);
        // "Before" (60 s) runs until "Mine" (150 s), past the 120 s cutoff.
        assert_eq!(text, "[Them]: Before
[You]: Mine
[Them]: Late");
        assert_eq!(window, 80);
    }
}
