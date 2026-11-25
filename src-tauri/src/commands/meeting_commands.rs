use std::collections::HashMap;
use std::sync::atomic::Ordering;

use tauri::{command, AppHandle, Manager, State};

use crate::commands::meeting_chat_commands::chat_history_preload;
use crate::db::meeting_chat::{self, MeetingChatMessage};
use crate::db::meetings::{
    self, MeetingActionItem, MeetingBookmark, MeetingSpeaker, MeetingTopicSection,
    MeetingUpdate, TranscriptSegment,
};
use crate::llm::cli_agent::command::SourcesLaunch;
use crate::llm::cli_agent::context::{build_preload_messages, Seg, SentLine};
use crate::llm::cli_agent::manager::{tier_for, SessionInit, SessionKey, SessionScope, Tier};
use crate::llm::cli_agent::protocol::AgentErrorKind;
use crate::llm::cli_agent::routing::{self, SessionRecord, PRELOAD_MESSAGE_CHARS};
use crate::sources::launch::build_sources_launch;
use crate::state::{AppState, LiveMeeting};
use crate::workspace::runtime;
use crate::workspace::EffectiveScope;

/// Global custom instructions (AI Actions settings).
fn custom_instructions(state: &AppState) -> String {
    state
        .intelligence
        .as_ref()
        .and_then(|i| i.lock().ok())
        .map(|engine| engine.get_action_configs().custom_instructions.clone())
        .unwrap_or_default()
}

/// The launch of a with-sources session from the saved sources and secrets,
/// cut down to what `scope` may use: `Ok(None)` when nothing usable is
/// enabled, `Err` when something was enabled but every source was left out.
pub(crate) fn current_sources_launch(
    state: &AppState,
    scope: &EffectiveScope,
) -> Result<Option<SourcesLaunch>, String> {
    let cfg = runtime::sources_for(state, scope)?;
    build_sources_launch(&cfg, &crate::commands::sources_commands::saved_secret)
}

/// `record` as a with-sources session starts it: the sources launch, and the
/// system prompt followed by what each source is.
fn with_sources_record(
    state: &AppState,
    mut record: SessionRecord,
    scope: &EffectiveScope,
) -> Result<SessionRecord, String> {
    let launch = current_sources_launch(state, scope)?.ok_or_else(|| "No personal sources are enabled".to_string())?;
    record.system_prompt = format!("{}\n\n{}", record.system_prompt, launch.system_prompt_addition);
    record.sources = Some(launch);
    Ok(record)
}

/// What a live-meeting Claude session starts with: the scenario prompt,
/// speaker context and custom instructions as its system prompt, and the
/// context documents as preload when they fit the cap (else RAG mode). A
/// Deep session (Recap) also gets the transcript so far (`finals`). With
/// `with_sources` it is the with-sources session's record (see
/// [`with_sources_record`]); that fails when no source is usable.
pub(crate) fn live_session_record(
    state: &AppState,
    tier: Tier,
    finals: &[Seg],
    with_sources: bool,
) -> Result<SessionRecord, String> {
    // Stamp first: the generation and sources epoch this record is built under.
    // If the scope restarts while it is built, the record is refused at insert.
    let live_id = state.live_meeting.lock().ok().and_then(|m| m.as_ref().map(|m| m.id.clone()));
    let stamp = live_id
        .as_ref()
        .map(|id| record_stamp(state, &SessionKey { scope: SessionScope::Live(id.clone()), tier, with_sources }))
        .unwrap_or_default();
    let (scenario_prompt, speaker_context) = state
        .active_scenario
        .read()
        .map(|s| (s.system_prompt.clone(), s.speaker_context.clone()))
        .unwrap_or_default();
    // The running meeting's own scope: its workspace, what it borrows, and
    // General when its workspace includes it.
    let scoped = match live_id.as_deref() {
        Some(id) => runtime::for_meeting(state, id),
        None => runtime::for_default(state),
    };
    let documents = state
        .context
        .as_ref()
        .and_then(|c| c.lock().ok())
        .map(|c| c.get_assembled_context_for(&scoped))
        .unwrap_or_default();
    let (mut preload, rag_mode) = routing::document_preload(&documents);
    let mut sent = HashMap::new();
    if tier == Tier::Deep {
        preload.extend(build_preload_messages(finals, None, PRELOAD_MESSAGE_CHARS, true));
        sent = finals.iter().map(|s| (s.id.clone(), SentLine::held(&s.text))).collect();
    }
    let record = SessionRecord {
        system_prompt: routing::live_system_prompt(
            &scenario_prompt,
            &speaker_context,
            &runtime::instructions_with_workspace(&custom_instructions(state), &scoped.scope),
        ),
        preload,
        sent,
        rag_mode,
        generation: stamp.0,
        sources_epoch: stamp.1,
        ..SessionRecord::default()
    };
    if with_sources {
        with_sources_record(state, record, &scoped.scope)
    } else {
        Ok(record)
    }
}

/// The generation and sources epoch a record for `key` starts to be built under.
fn record_stamp(state: &AppState, key: &SessionKey) -> (u64, u64) {
    (state.agent_sessions.generation_for(key), state.meeting_sessions.sources_epoch(&key.scope))
}

/// What the AI gets about a past meeting: its summary, its final
/// transcript (speaker names, times relative to the start, segment ids) and
/// its saved "Ask this meeting" chat.
pub(crate) struct PastMeetingContext {
    pub summary: Option<String>,
    pub transcript: Vec<Seg>,
    pub chat: Vec<MeetingChatMessage>,
}

pub(crate) fn past_meeting_context(state: &AppState, meeting_id: &str) -> Result<PastMeetingContext, String> {
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;
    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;
    let meeting = meetings::get_meeting(db.connection(), meeting_id)
        .map_err(|e| format!("Failed to load meeting: {}", e))?;
    let names: HashMap<String, String> = meetings::list_meeting_speakers(db.connection(), meeting_id)
        .unwrap_or_default()
        .into_iter()
        .map(|s| (s.speaker_id, s.display_name))
        .collect();
    let chat = meeting_chat::list_chat_messages(db.connection(), meeting_id).unwrap_or_else(|e| {
        log::warn!("Failed to load the chat of meeting {meeting_id}: {e}");
        Vec::new()
    });
    drop(db);

    let start_ms = chrono::DateTime::parse_from_rfc3339(&meeting.start_time)
        .map(|t| t.timestamp_millis())
        .unwrap_or(0);
    Ok(PastMeetingContext {
        transcript: past_transcript(&meeting.transcript, &names, start_ms),
        summary: meeting.summary,
        chat,
    })
}

/// What a past-meeting Claude session starts with: the meeting's summary (if
/// any), its final transcript with segment ids, speaker names and `[mm:ss]`
/// times (bookmark suggestions cite the ids), then the questions already
/// asked about it with their answers, so follow-ups work.
pub(crate) fn past_session_record(
    state: &AppState,
    meeting_id: &str,
    with_sources: bool,
) -> Result<SessionRecord, String> {
    let stamp = record_stamp(
        state,
        &SessionKey { scope: SessionScope::Past(meeting_id.to_string()), tier: Tier::Deep, with_sources },
    );
    let context = past_meeting_context(state, meeting_id)?;
    let mut preload = build_preload_messages(
        &context.transcript,
        context.summary.as_deref(),
        PRELOAD_MESSAGE_CHARS,
        true,
    );
    preload.extend(chat_history_preload(&context.chat));
    // The past meeting's own scope, not whatever is running now.
    let scoped = runtime::for_meeting(state, meeting_id);
    let record = SessionRecord {
        system_prompt: routing::past_system_prompt(&runtime::instructions_with_workspace(
            &custom_instructions(state),
            &scoped.scope,
        )),
        preload,
        generation: stamp.0,
        sources_epoch: stamp.1,
        ..SessionRecord::default()
    };
    if with_sources {
        with_sources_record(state, record, &scoped.scope)
    } else {
        Ok(record)
    }
}

/// Final segments of a stored transcript (JSON array of segments), labelled
/// with the meeting's speaker names where known.
fn past_transcript(transcript: &serde_json::Value, names: &HashMap<String, String>, start_ms: i64) -> Vec<Seg> {
    let Some(items) = transcript.as_array() else {
        return Vec::new();
    };
    items
        .iter()
        .filter(|item| item.get("is_final").and_then(|v| v.as_bool()).unwrap_or(true))
        .filter_map(|item| {
            let text = item.get("text")?.as_str()?.trim();
            if text.is_empty() {
                return None;
            }
            let speaker = item.get("speaker").and_then(|v| v.as_str()).unwrap_or("Unknown");
            // A diarized remote line ("Them" + tag "S1") is labelled with the
            // tag's name ("Erin", else "Speaker 1"); its speaker_id ("them")
            // would only say "Them". In-person lines keep their speaker_id name.
            let tag = item.get("speaker_tag").and_then(|v| v.as_str()).filter(|t| !t.is_empty());
            let speaker_id = item.get("speaker_id").and_then(|v| v.as_str());
            let named = tag
                .and_then(|t| names.get(&meetings::remote_speaker_id(t)))
                .or_else(|| {
                    speaker_id
                        .filter(|id| tag.is_none() || *id != "them")
                        .and_then(|id| names.get(id))
                })
                .or_else(|| if tag.is_none() { names.get(speaker) } else { None });
            let label = match (named, tag) {
                (Some(name), _) => name.clone(),
                (None, Some(t)) => meetings::default_remote_speaker_name(t),
                (None, None) => routing::speaker_label(speaker).to_string(),
            };
            let timestamp_ms = item.get("timestamp_ms").and_then(|v| v.as_i64()).unwrap_or(0);
            let id = item
                .get("id")
                .and_then(|v| v.as_str())
                .filter(|id| !id.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| routing::fallback_segment_id(timestamp_ms, speaker, text));
            Some(Seg {
                id,
                text: text.to_string(),
                speaker: label,
                timestamp_ms: routing::relative_ms(timestamp_ms, start_ms),
            })
        })
        .collect()
}

/// In the background: build `key`'s record with `build` on a blocking
/// thread (documents, token count, DB reads stay off the command's path),
/// record it unless a request already did, and start the session. Work for
/// a scope closed meanwhile (meeting ended / view left) is discarded, and a
/// session that finished starting after the close is closed again. A
/// definite outage found at start (not installed / not logged in) marks
/// Claude unavailable so requests go straight to the fallback.
pub(crate) fn start_session_in_background(
    app: &AppHandle,
    key: SessionKey,
    build: impl Fn(&AppState) -> Result<SessionRecord, String> + Send + Sync + 'static,
) {
    start_session_attempt(app, key, std::sync::Arc::new(build), true);
}

/// One try of [`start_session_in_background`]. The generation is read before
/// the record is built: if the scope restarts in between, the session is not
/// started from that record and (once) the record is built again.
fn start_session_attempt(
    app: &AppHandle,
    key: SessionKey,
    build: std::sync::Arc<dyn Fn(&AppState) -> Result<SessionRecord, String> + Send + Sync>,
    retry: bool,
) {
    let (epoch, generation) = {
        let state = app.state::<AppState>();
        (state.meeting_sessions.epoch(&key.scope), state.agent_sessions.generation_for(&key))
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let label = routing::session_key_label(&key);
        let built = {
            let app = app.clone();
            let build = build.clone();
            tokio::task::spawn_blocking(move || build(&app.state::<AppState>())).await
        };
        let state = app.state::<AppState>();
        let record = match built {
            Ok(Ok(record)) => record,
            Ok(Err(e)) => {
                log::warn!("Claude session {label} not prepared: {e}");
                if key.with_sources {
                    note_sources_failure(&app, &key, &e);
                }
                return;
            }
            Err(e) => {
                log::warn!("Claude session {label} not prepared: {e}");
                return;
            }
        };
        if !state.meeting_sessions.insert_checked(key.clone(), record, epoch, Some(generation)) {
            // Closed while the record was built: nothing to start. Restarted
            // while it was built (same epoch): build it again, once.
            if retry && state.meeting_sessions.epoch(&key.scope) == epoch {
                start_session_attempt(&app, key, build, false);
            }
            return;
        }
        let Some(record) = state.meeting_sessions.get(&key) else {
            return;
        };
        if record.stateless_only {
            return;
        }
        let init = SessionInit {
            system_prompt: record.system_prompt,
            preload: record.preload,
            sources: record.sources,
        };
        match state.agent_sessions.ensure_at(&key, init, None, Some(generation)).await {
            Ok(handle) => {
                if key.with_sources {
                    state.sources_cooldown.clear_key(&key);
                }
                // Closed (and not reopened) while it was starting: close exactly
                // this session (never a newer one that took the key); live
                // sessions are never reaped.
                let closed = state.meeting_sessions.epoch(&key.scope) != epoch
                    && !state.meeting_sessions.contains(&key);
                if closed {
                    if let Some(handle) = state.agent_sessions.retire_handle_if_idle(&key, &handle) {
                        handle.close().await;
                    }
                }
            }
            Err(e) if crate::llm::cli_agent::manager::is_scope_changed(&e) => {
                // Restarted while it started: that record is gone. Build a new one, once.
                log::info!("Claude session {label} was restarted while it started");
                // The record this attempt stored is from before the restart: gone.
                state.meeting_sessions.remove_if_generation(&key, generation);
                if retry {
                    start_session_attempt(&app, key, build, false);
                }
            }
            Err(e) => {
                log::warn!("Claude session {label} did not start: {e}");
                if key.with_sources && crate::commands::intelligence_commands::is_sources_start_failure(&e) {
                    note_sources_failure(&app, &key, &e.to_string());
                }
                if let Some(kind @ (AgentErrorKind::NotInstalled | AgentErrorKind::Outdated | AgentErrorKind::NotLoggedIn)) =
                    routing::unavailable_kind(&e)
                {
                    state.claude_health.mark_unavailable(kind);
                }
            }
        }
    });
}

/// A with-sources session failed to start: answers that ask for sources use
/// the plain session for [`routing::SOURCES_COOLDOWN`], then one background
/// retry runs (unless the failure was cleared or replaced meanwhile).
pub(crate) fn note_sources_failure(app: &AppHandle, key: &SessionKey, reason: &str) {
    let state = app.state::<AppState>();
    let generation = state.sources_cooldown.fail(key, reason, std::time::Instant::now());
    let wait = state.sources_cooldown.duration();
    // The retry starts the same session key (its start clears that key's failure).
    let retry_key = key.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(wait).await;
        let state = app.state::<AppState>();
        if !state.sources_cooldown.begin_retry(&retry_key, generation) {
            return;
        }
        retry_sources_key(&app, retry_key);
    });
}

/// Start the with-sources session `key` again in the background (the result
/// clears or renews the cooldown).
fn retry_sources_key(app: &AppHandle, key: SessionKey) {
    let state = app.state::<AppState>();
    state.meeting_sessions.clear_sources(&key.scope);
    match key.scope.clone() {
        SessionScope::Live(_) => {
            start_session_in_background(app, key.clone(), move |state| live_session_record(state, key.tier, &[], true))
        }
        SessionScope::Past(id) => {
            start_session_in_background(app, key, move |state| past_session_record(state, &id, true))
        }
        SessionScope::Utility | SessionScope::Workspace(_) | SessionScope::Notes(_) | SessionScope::Brief(_) => {}
    }
}

/// The user asked to try the sources again (from the error state): forget the
/// failure and restart the with-sources sessions now.
#[command]
pub fn retry_sources_session(app: AppHandle) -> Result<(), String> {
    restart_sources_sessions(&app);
    Ok(())
}

/// The sources changed: forget and close every with-sources session (their
/// records are rebuilt from the new settings on the next request), and start
/// the running meeting's Fast one again when sources are still enabled. All in
/// the background; plain sessions are untouched.
pub(crate) fn restart_sources_sessions(app: &AppHandle) {
    let state = app.state::<AppState>();
    // A new try: sources or secrets changed, or the user asked.
    state.sources_cooldown.clear();
    let mut scopes = state.meeting_sessions.scopes_with_sources();
    for status in state.agent_sessions.snapshot().into_iter().filter(|s| s.with_sources) {
        let scope = match (status.scope.as_str(), status.meeting_id) {
            ("live", Some(id)) => SessionScope::Live(id),
            ("past", Some(id)) => SessionScope::Past(id),
            _ => continue,
        };
        if !scopes.contains(&scope) {
            scopes.push(scope);
        }
    }
    for scope in &scopes {
        state.meeting_sessions.clear_sources(scope);
    }
    let live = state.live_meeting.lock().ok().and_then(|m| m.as_ref().map(|m| m.id.clone()));
    let rewarm = live.filter(|id| {
        routing::cli_agent_is_active(&state)
            && runtime::sources_for(&state, &runtime::for_meeting(&state, id).scope)
                .map(|c| c.has_enabled())
                .unwrap_or(false)
    });
    let sessions = state.agent_sessions.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        for scope in &scopes {
            sessions.close_sources(scope).await;
        }
        if let Some(id) = rewarm {
            let key = SessionKey::sources(SessionScope::Live(id), Tier::Fast);
            start_session_in_background(&app, key, |state| live_session_record(state, Tier::Fast, &[], true));
        }
    });
}

/// The scope of a meeting changed (a borrowed workspace added or removed, a
/// new home, or its material or instructions edited): forget and close its
/// sessions, which hold the old documents and sources, and warm the running
/// meeting's Fast ones again with the new scope. Like a sources restart:
/// in the background, requests in flight finish or restart on their own, and
/// other meetings' sessions are untouched.
pub(crate) fn restart_meeting_sessions(app: &AppHandle, meeting_id: &str) {
    let state = app.state::<AppState>();
    state.sources_cooldown.clear();
    let live_scope = SessionScope::Live(meeting_id.to_string());
    let past_scope = SessionScope::Past(meeting_id.to_string());
    // Its notes and brief sessions were started with context from the same
    // scope: they start again too (a run builds its own context each time).
    let aux_scopes = [SessionScope::Notes(meeting_id.to_string()), SessionScope::Brief(meeting_id.to_string())];
    // The brief drops its sheet and looks the new scope up now.
    if let Some(rt) = crate::live_runtime::global() {
        rt.scope_changed(meeting_id);
        // Its sessions start again: they get the brief and memory again.
        rt.forget_sessions(meeting_id);
    }
    let is_live = live_meeting_is(&state, meeting_id);
    state.meeting_sessions.remove_scope(&live_scope);
    state.meeting_sessions.remove_scope(&past_scope);
    // The old sessions leave their keys at once; a request that comes next
    // starts a new session under the new record and never queues behind the
    // old ones, which only finish the turn they are in and close.
    state.agent_sessions.detach_scope(&live_scope);
    state.agent_sessions.detach_scope(&past_scope);
    for scope in &aux_scopes {
        state.agent_sessions.detach_scope(scope);
    }
    let rewarm = is_live && routing::cli_agent_is_active(&state);
    let with_sources = rewarm
        && runtime::sources_for(&state, &runtime::for_meeting(&state, meeting_id).scope)
            .map(|c| c.has_enabled())
            .unwrap_or(false);
    let sessions = state.agent_sessions.clone();
    let app = app.clone();
    let id = meeting_id.to_string();
    if rewarm {
        let key = SessionKey::plain(SessionScope::Live(id.clone()), Tier::Fast);
        start_session_in_background(&app, key, |state| live_session_record(state, Tier::Fast, &[], false));
        if with_sources {
            let key = SessionKey::sources(SessionScope::Live(id), Tier::Fast);
            start_session_in_background(&app, key, |state| live_session_record(state, Tier::Fast, &[], true));
        }
    }
    tauri::async_runtime::spawn(async move {
        let bound = crate::llm::cli_agent::manager::DRAIN_TIMEOUT;
        sessions.close_retired_graceful(&live_scope, bound).await;
        sessions.close_retired_graceful(&past_scope, bound).await;
        for scope in &aux_scopes {
            sessions.close_retired_graceful(scope, bound).await;
        }
    });
}

/// The material of these chats' workspace changed: their sessions leave at once
/// (the next run starts one from its fresh context) and close after the turn
/// they are in.
pub(crate) fn restart_chat_sessions(app: &AppHandle, chat_ids: Vec<String>) {
    if chat_ids.is_empty() {
        return;
    }
    let state = app.state::<AppState>();
    let scopes: Vec<SessionScope> = chat_ids.into_iter().map(SessionScope::Workspace).collect();
    for scope in &scopes {
        state.agent_sessions.detach_scope(scope);
    }
    let sessions = state.agent_sessions.clone();
    tauri::async_runtime::spawn(async move {
        for scope in &scopes {
            sessions.close_retired_graceful(scope, crate::llm::cli_agent::manager::DRAIN_TIMEOUT).await;
        }
    });
}

fn live_meeting_is(state: &AppState, meeting_id: &str) -> bool {
    state.live_meeting.lock().ok().map_or(false, |m| m.as_ref().map_or(false, |m| m.id == meeting_id))
}

/// A meeting that no longer exists: every session of it ends and nothing
/// starts again (no rewarm), and its notes and brief stop.
pub(crate) fn drop_meeting_sessions(app: &AppHandle, meeting_id: &str) {
    let state = app.state::<AppState>();
    if let Some(rt) = crate::live_runtime::global() {
        rt.meeting_deleted(meeting_id);
    }
    state.restarts.forget(&format!("meeting:{meeting_id}"));
    let scopes = [
        SessionScope::Live(meeting_id.to_string()),
        SessionScope::Past(meeting_id.to_string()),
        SessionScope::Notes(meeting_id.to_string()),
        SessionScope::Brief(meeting_id.to_string()),
    ];
    for scope in &scopes {
        state.meeting_sessions.remove_scope(scope);
        state.agent_sessions.detach_scope(scope);
    }
    let sessions = state.agent_sessions.clone();
    tauri::async_runtime::spawn(async move {
        for scope in &scopes {
            sessions.close_retired_graceful(scope, crate::llm::cli_agent::manager::DRAIN_TIMEOUT).await;
        }
    });
}

/// Forget and close every session of `scope` without blocking the caller
/// (closing waits for a session that is still starting).
fn close_scope_in_background(state: &AppState, scope: SessionScope) {
    state.meeting_sessions.remove_scope(&scope);
    let sessions = state.agent_sessions.clone();
    tauri::async_runtime::spawn(async move { sessions.close_scope(&scope).await });
}

/// Start the Claude session of a past meeting opened in the meeting view
/// (Deep tier; summary + transcript preloaded). Does nothing unless the
/// Claude CLI is the active provider. Returns at once; the session starts in
/// the background.
#[command]
pub async fn start_past_meeting_session(
    meeting_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let Some(kind) = routing::active_cli_kind(&state) else {
        return Ok(());
    };
    let scope = SessionScope::Past(meeting_id.clone());
    let cfg = state.cli_settings.config(kind);
    let key = SessionKey::plain(scope.clone(), tier_for("MeetingSummary", &scope, &cfg));
    start_session_in_background(&app, key, move |state| past_session_record(state, &meeting_id, false));
    Ok(())
}

/// Close the Claude session of a past meeting (the meeting view was left).
#[command]
pub async fn close_past_meeting_session(
    meeting_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    close_scope_in_background(&state, SessionScope::Past(meeting_id.clone()));
    if let Some(ai) = state.ai_runs.clone() {
        tauri::async_runtime::spawn(async move { ai.close_meeting(&meeting_id).await });
    }
    Ok(())
}

#[command]
pub async fn save_meeting_ai_interactions(
    meeting_id: String,
    ai_interactions_json: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;

    let ai_interactions: serde_json::Value = serde_json::from_str(&ai_interactions_json)
        .map_err(|e| format!("Failed to parse AI interactions: {}", e))?;

    let update = MeetingUpdate {
        title: None,
        end_time: None,
        duration_seconds: None,
        transcript: None,
        ai_interactions: Some(ai_interactions),
        summary: None,
        config_snapshot: None,
        recording_path: None,
        recording_size: None,
        waveform_path: None,
        recording_offset_ms: None,
    };

    meetings::update_meeting(db.connection(), &meeting_id, &update)
        .map_err(|e| format!("Failed to save AI interactions: {}", e))
}

#[command]
pub async fn start_meeting(
    title: Option<String>,
    workspace_id: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    // Before anything starts (audio, recording): no database, no meeting, and a
    // sentence that says why. The page calls this before it opens the microphone.
    let db = state.database.as_ref().ok_or_else(|| match &state.db_problem {
        Some(problem) => format!(
            "NexQ can't start a meeting because it can't open its meetings file. {}",
            problem.message
        ),
        None => "NexQ can't start a meeting: the meetings file isn't open yet.".to_string(),
    })?;

    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;

    let title = title.unwrap_or_else(|| {
        format!(
            "Meeting {}",
            chrono::Local::now().format("%Y-%m-%d %H:%M")
        )
    });

    // A requested workspace that is unknown or archived falls back to the default one, and
    // the response says so (`workspace_notice`): a meeting always starts when the database
    // is open. The meeting and its home are created in one transaction: no orphan row.
    let (meeting, workspace_notice) = create_meeting_filed(db.connection(), &title, workspace_id.as_deref(), crate::workspace::available())?;
    state.meeting_active.store(true, Ordering::SeqCst);
    state.workspace_chat.cancel_recaps(); // recaps never run in a meeting

    // Clear per-meeting state so the new meeting starts fresh.
    // The intelligence buffer and last detected question persist across
    // meetings otherwise, leaking the previous meeting's transcript into
    // the first AI call of the new meeting.
    drop(db); // release DB lock before acquiring other locks
    if let Some(intel_arc) = state.intelligence.as_ref() {
        if let Ok(mut engine) = intel_arc.lock() {
            engine.clear_session();
        }
    }
    if let Some(rag_arc) = state.rag.as_ref() {
        if let Ok(mut rag_mgr) = rag_arc.lock() {
            if let Some(indexer) = rag_mgr.transcript_indexer_mut() {
                indexer.set_owner(Some(meeting.id.clone()));
                indexer.reset();
            }
        }
    }

    // Live Claude session: start the Fast session now so the first request
    // finds it warm (the frontend pushes the scenario before this call).
    let start_ms = chrono::DateTime::parse_from_rfc3339(&meeting.start_time)
        .map(|t| t.timestamp_millis())
        .unwrap_or_else(|_| chrono::Utc::now().timestamp_millis());
    if let Ok(mut live) = state.live_meeting.lock() {
        *live = Some(LiveMeeting {
            id: meeting.id.clone(),
            start_ms,
        });
    }
    // Notes and brief start by themselves where the user turned them on for every meeting.
    if let Some(rt) = crate::live_runtime::global() {
        rt.on_meeting_start(&meeting.id);
    }
    if routing::cli_agent_is_active(&state) {
        let key = SessionKey::plain(SessionScope::Live(meeting.id.clone()), Tier::Fast);
        start_session_in_background(&app, key, |state| {
            live_session_record(state, Tier::Fast, &[], false)
        });
        // The with-sources Fast session warms beside it, so the first answer
        // with a pill on finds it ready. Deep ones start on first use.
        let scope = runtime::for_meeting(&state, &meeting.id).scope;
        let has_sources = runtime::sources_for(&state, &scope).map(|c| c.has_enabled()).unwrap_or(false);
        if has_sources {
            let key = SessionKey::sources(SessionScope::Live(meeting.id.clone()), Tier::Fast);
            start_session_in_background(&app, key, |state| {
                live_session_record(state, Tier::Fast, &[], true)
            });
        }
    }

    meeting_response(&meeting, workspace_notice)
}

/// Creates the meeting in the workspace asked for. With no workspace asked for it goes to the
/// default one (General when that fails too, and with no home at all as the last resort). A
/// workspace that was asked for and cannot be used never turns into another one: the meeting
/// starts filed nowhere, and the sentence says so.
fn create_meeting_filed(
    conn: &rusqlite::Connection,
    title: &str,
    requested: Option<&str>,
    workspaces: bool,
) -> Result<(meetings::Meeting, Option<String>), String> {
    use crate::workspace::meetings as ws_meetings;
    use crate::workspace::store::StartHome;
    if !workspaces {
        return ws_meetings::create_meeting_in(conn, title, None).map(|m| (m, None));
    }
    let asked = requested.filter(|id| !id.is_empty()).is_some();
    let (home, notice) = crate::workspace::store::home_for_start(conn, requested);
    let home = match home {
        StartHome::Unfiled => return ws_meetings::create_meeting_unfiled(conn, title).map(|m| (m, notice)),
        StartHome::Home(h) => h,
    };
    match ws_meetings::create_meeting_in(conn, title, Some(&home)) {
        Ok(m) => Ok((m, notice)),
        Err(first) => {
            log::warn!("The meeting could not be filed in {home}: {first}");
            if asked {
                let note = "That workspace couldn't be used, so this meeting is not filed in a workspace and uses none of their material. Pick one from the island to file it";
                return ws_meetings::create_meeting_unfiled(conn, title).map(|m| (m, Some(note.to_string()))).map_err(|_| first);
            }
            let general = crate::workspace::types::GENERAL_ID;
            let last_resorts: &[Option<&str>] = if home == general { &[None] } else { &[Some(general), None] };
            for next in last_resorts {
                if let Ok(m) = ws_meetings::create_meeting_in(conn, title, *next) {
                    return Ok((m, None));
                }
            }
            Err(first)
        }
    }
}

/// The JSON `start_meeting` answers with: the meeting, plus `workspace_notice` only when it
/// was filed somewhere other than asked.
pub(crate) fn meeting_response(meeting: &meetings::Meeting, notice: Option<String>) -> Result<String, String> {
    let mut value = serde_json::to_value(meeting).map_err(|e| format!("Failed to serialize meeting: {}", e))?;
    if let (Some(text), Some(obj)) = (notice, value.as_object_mut()) {
        obj.insert("workspace_notice".to_string(), serde_json::Value::String(text));
    }
    serde_json::to_string(&value).map_err(|e| format!("Failed to serialize meeting: {}", e))
}

#[command]
pub async fn end_meeting(
    meeting_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    state.meeting_active.store(false, Ordering::SeqCst);
    if let Ok(mut live) = state.live_meeting.lock() {
        if live.as_ref().map(|m| m.id == meeting_id).unwrap_or(true) {
            *live = None;
        }
    }
    close_scope_in_background(&state, SessionScope::Live(meeting_id.clone()));
    // The live transcript chunks belong to the meeting that just ended: no later
    // request may search them, and they are not kept.
    if let Some(rag_arc) = state.rag.as_ref() {
        if let Ok(mut rag_mgr) = rag_arc.lock() {
            if let Some(indexer) = rag_mgr.transcript_indexer_mut() {
                if indexer.owner() == Some(meeting_id.as_str()) {
                    indexer.set_owner(None);
                }
            }
        }
    }
    if let Some(db) = state.database.as_ref() {
        if let Ok(db) = db.lock() {
            let _ = crate::workspace::purge::purge_transcript_chunks(db.connection(), &meeting_id);
        }
    }
    if let Ok(mut warned) = state.material_warned.lock() {
        warned.remove(&meeting_id);
    }
    state.restarts.forget(&format!("meeting:{meeting_id}"));
    // Notes and brief: a bounded final pass in the background (never delays the end),
    // then their sessions end after the turn they are in.
    if let Some(rt) = crate::live_runtime::global() {
        rt.on_meeting_end(&meeting_id);
    } else if let Some(ai) = state.ai_runs.clone() {
        let id = meeting_id.clone();
        tauri::async_runtime::spawn(async move { ai.close_meeting(&id).await });
    }
    crate::workspace_chat::runtime::meeting_ended(&state.workspace_chat, &meeting_id);
    crate::workspace_chat::runtime::recaps_after_meeting(&app, &state, &meeting_id);

    let db_arc = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?
        .clone();

    let (meeting_start_time, end_time, duration_seconds) = {
        let db = db_arc
            .lock()
            .map_err(|e| format!("Failed to lock database: {}", e))?;

        // Get the meeting to calculate duration + extract start_time for offset calc
        let meeting = meetings::get_meeting(db.connection(), &meeting_id)
            .map_err(|e| format!("Failed to get meeting: {}", e))?;

        let end_time = chrono::Utc::now().to_rfc3339();

        // Calculate duration
        let duration_seconds = chrono::DateTime::parse_from_rfc3339(&end_time)
            .ok()
            .and_then(|end| {
                chrono::DateTime::parse_from_rfc3339(&meeting.start_time)
                    .ok()
                    .map(|start| (end - start).num_seconds())
            });

        let update = MeetingUpdate {
            title: None,
            end_time: Some(end_time.clone()),
            duration_seconds,
            transcript: None,
            ai_interactions: None,
            summary: None,
            config_snapshot: None,
            recording_path: None,
            recording_size: None,
            waveform_path: None,
            recording_offset_ms: None,
        };

        meetings::update_meeting(db.connection(), &meeting_id, &update)
            .map_err(|e| format!("Failed to end meeting: {}", e))?;

        (meeting.start_time, end_time, duration_seconds)
    };

    // ── Post-meeting recording pipeline ───────────────────────────────────────
    // Take the pending recording info stored by stop_capture (if any).
    // This is populated when recording_enabled was true for this meeting.
    let pending = {
        let mut lock = state
            .pending_recording
            .lock()
            .map_err(|_| "Pending recording lock poisoned".to_string())?;
        lock.take()
    };

    if let Some(recording) = pending {
        // Calculate offset: how many ms into the meeting did recording start?
        // meeting_start_epoch_ms is parsed from the ISO 8601 start_time.
        let recording_offset_ms: i64 = chrono::DateTime::parse_from_rfc3339(&meeting_start_time)
            .ok()
            .map(|start| {
                let start_ms = start.timestamp_millis();
                recording.start_time_ms as i64 - start_ms
            })
            .unwrap_or(0)
            .max(0); // clamp to 0 if recording started before the meeting (shouldn't happen)

        log::info!(
            "Spawning post-meeting pipeline for meeting {} (offset={}ms)",
            meeting_id,
            recording_offset_ms
        );

        // Spawn the pipeline — don't await, return the IPC response immediately.
        // Counted so an update restart can wait for it (install_update_now).
        let jobs = state.recording_jobs.clone();
        jobs.fetch_add(1, Ordering::SeqCst);
        tokio::spawn(async move {
            crate::audio::process_recording(
                recording.wav_path,
                meeting_id,
                recording_offset_ms,
                db_arc,
                app,
            )
            .await;
            jobs.fetch_sub(1, Ordering::SeqCst);
        });
    } else {
        log::info!(
            "Meeting {} ended with no pending recording (recording not enabled or already consumed)",
            meeting_id
        );
    }

    let _ = (end_time, duration_seconds); // suppress unused warnings
    Ok(())
}

#[command]
pub async fn list_meetings(
    limit: Option<u32>,
    offset: Option<u32>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;

    let limit = limit.unwrap_or(50);
    let offset = offset.unwrap_or(0);

    let summaries = meetings::list_meetings(db.connection(), limit, offset)
        .map_err(|e| format!("Failed to list meetings: {}", e))?;

    serde_json::to_string(&summaries).map_err(|e| format!("Failed to serialize meetings: {}", e))
}

#[command]
pub async fn get_meeting(
    meeting_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;

    let meeting = meetings::get_meeting(db.connection(), &meeting_id)
        .map_err(|e| format!("Failed to get meeting: {}", e))?;

    serde_json::to_string(&meeting).map_err(|e| format!("Failed to serialize meeting: {}", e))
}

#[command]
pub async fn delete_meeting(
    meeting_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    use crate::commands::workspace_commands::{change_and_restart, delete_touch};
    state.workspace_chat.cancel_recaps(); // a recap in flight must not outlive this change
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    // Its notes and brief stop first and save nothing (a save never recreates a row anyway).
    if let Some(rt) = crate::live_runtime::global() {
        rt.meeting_deleted(&meeting_id);
    }
    // Everything about the meeting goes in one step: rows of every table
    // (cached translations, notes, brief, search passages, borrowed ...). Its
    // sessions end and the chats of its workspace stop using it (a change of
    // access like any other).
    let files = change_and_restart(&state, &app, |conn| delete_touch(conn, &meeting_id), || {
        let db = db
            .lock()
            .map_err(|e| format!("Failed to lock database: {}", e))?;
        let tx = db
            .connection()
            .unchecked_transaction()
            .map_err(|e| format!("Failed to delete meeting: {}", e))?;
        let files = crate::workspace::purge::purge_meeting(&tx, &meeting_id)?;
        tx.commit().map_err(|e| format!("Failed to delete meeting: {}", e))?;
        Ok(files)
    })?;
    // Then the recording and waveform, only if they are in NexQ's recordings folder.
    if let Some(dir) = crate::workspace::purge::recordings_dir() {
        crate::workspace::purge::delete_files_inside(&dir, &files);
    }
    crate::workspace_chat::runtime::meeting_deleted(&state.workspace_chat, &meeting_id);
    close_scope_in_background(&state, SessionScope::Past(meeting_id));
    Ok(())
}

#[command]
pub async fn search_meetings(
    query: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;

    let results = meetings::search_meetings(db.connection(), &query)
        .map_err(|e| format!("Failed to search meetings: {}", e))?;

    serde_json::to_string(&results).map_err(|e| format!("Failed to serialize results: {}", e))
}

#[command]
pub async fn rename_meeting(
    meeting_id: String,
    new_title: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;

    let update = MeetingUpdate {
        title: Some(new_title),
        end_time: None,
        duration_seconds: None,
        transcript: None,
        ai_interactions: None,
        summary: None,
        config_snapshot: None,
        recording_path: None,
        recording_size: None,
        waveform_path: None,
        recording_offset_ms: None,
    };

    meetings::update_meeting(db.connection(), &meeting_id, &update)
        .map_err(|e| format!("Failed to rename meeting: {}", e))
}

#[command]
pub async fn update_meeting_summary(
    meeting_id: String,
    summary: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;

    let update = MeetingUpdate {
        title: None,
        end_time: None,
        duration_seconds: None,
        transcript: None,
        ai_interactions: None,
        summary: Some(summary),
        config_snapshot: None,
        recording_path: None,
        recording_size: None,
        waveform_path: None,
        recording_offset_ms: None,
    };

    meetings::update_meeting(db.connection(), &meeting_id, &update)
        .map_err(|e| format!("Failed to update meeting summary: {}", e))
}

#[command]
pub async fn append_transcript_segment(
    meeting_id: String,
    segment: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;

    // Parse the frontend segment (which may lack meeting_id and created_at)
    let partial: serde_json::Value = serde_json::from_str(&segment)
        .map_err(|e| format!("Failed to parse transcript segment: {}", e))?;

    let full_segment = TranscriptSegment {
        id: partial["id"].as_str().unwrap_or("unknown").to_string(),
        meeting_id: meeting_id.clone(),
        text: partial["text"].as_str().unwrap_or("").to_string(),
        speaker: partial["speaker"].as_str().unwrap_or("Unknown").to_string(),
        speaker_id: partial["speaker_id"].as_str().map(|s| s.to_string()),
        speaker_tag: partial["speaker_tag"].as_str().map(|s| s.to_string()),
        timestamp_ms: partial["timestamp_ms"].as_i64().unwrap_or(0),
        is_final: partial["is_final"].as_bool().unwrap_or(true),
        confidence: partial["confidence"].as_f64().unwrap_or(0.0),
        created_at: chrono::Utc::now().to_rfc3339(),
    };

    meetings::append_transcript_segment(db.connection(), &meeting_id, &full_segment)
        .map_err(|e| format!("Failed to append transcript segment: {}", e))
}

// ── In-person meeting mode commands ─────────────────────────────────────────

#[command]
pub async fn save_meeting_speakers(
    meeting_id: String,
    speakers_json: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;

    let speakers: Vec<MeetingSpeaker> = serde_json::from_str(&speakers_json)
        .map_err(|e| format!("Failed to parse speakers JSON: {}", e))?;

    meetings::save_meeting_speakers(db.connection(), &meeting_id, &speakers)
        .map_err(|e| format!("Failed to save meeting speakers: {}", e))
}

#[command]
pub async fn save_meeting_bookmarks(
    meeting_id: String,
    bookmarks_json: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;

    let bookmarks: Vec<MeetingBookmark> = serde_json::from_str(&bookmarks_json)
        .map_err(|e| format!("Failed to parse bookmarks JSON: {}", e))?;

    meetings::save_meeting_bookmarks(db.connection(), &meeting_id, &bookmarks)
        .map_err(|e| format!("Failed to save meeting bookmarks: {}", e))
}

#[command]
pub async fn add_meeting_bookmark(
    bookmark_json: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;

    let bookmark: MeetingBookmark = serde_json::from_str(&bookmark_json)
        .map_err(|e| format!("Failed to parse bookmark JSON: {}", e))?;

    meetings::add_meeting_bookmark(db.connection(), &bookmark)
        .map_err(|e| format!("Failed to add bookmark: {}", e))
}

#[command]
pub async fn update_meeting_bookmark(
    bookmark_id: String,
    note: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;

    meetings::update_meeting_bookmark_note(db.connection(), &bookmark_id, note.as_deref())
        .map_err(|e| format!("Failed to update bookmark: {}", e))
}

#[command]
pub async fn delete_meeting_bookmark(
    bookmark_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;

    meetings::delete_meeting_bookmark(db.connection(), &bookmark_id)
        .map_err(|e| format!("Failed to delete bookmark: {}", e))
}

#[command]
pub async fn save_meeting_action_items(
    meeting_id: String,
    items_json: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;

    let items: Vec<MeetingActionItem> = serde_json::from_str(&items_json)
        .map_err(|e| format!("Failed to parse action items JSON: {}", e))?;

    meetings::save_meeting_action_items(db.connection(), &meeting_id, &items)
        .map_err(|e| format!("Failed to save meeting action items: {}", e))
}

#[command]
pub async fn update_action_item(
    item_id: String,
    completed: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;

    meetings::update_action_item_completed(db.connection(), &item_id, completed)
        .map_err(|e| format!("Failed to update action item: {}", e))
}

#[command]
pub async fn delete_action_item(
    item_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;

    meetings::delete_action_item(db.connection(), &item_id)
        .map_err(|e| format!("Failed to delete action item: {}", e))
}

#[command]
pub async fn save_meeting_topic_sections(
    meeting_id: String,
    sections_json: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;

    let sections: Vec<MeetingTopicSection> = serde_json::from_str(&sections_json)
        .map_err(|e| format!("Failed to parse topic sections JSON: {}", e))?;

    meetings::save_meeting_topic_sections(db.connection(), &meeting_id, &sections)
        .map_err(|e| format!("Failed to save meeting topic sections: {}", e))
}

#[command]
pub async fn update_meeting_mode(
    meeting_id: String,
    audio_mode: String,
    ai_scenario: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;

    db.connection()
        .execute(
            "UPDATE meetings SET audio_mode = ?1, ai_scenario = ?2 WHERE id = ?3",
            rusqlite::params![audio_mode, ai_scenario, meeting_id],
        )
        .map_err(|e| format!("Failed to update meeting mode: {}", e))?;

    Ok(())
}

#[command]
pub async fn rename_speaker(
    meeting_id: String,
    speaker_id: String,
    new_name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;

    meetings::rename_speaker(db.connection(), &meeting_id, &speaker_id, &new_name)
        .map_err(|e| format!("Failed to rename speaker: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn when_filing_in_the_asked_workspace_fails_the_meeting_starts_unfiled_never_in_general() {
        use crate::workspace::test_support::{memory_db, new_ws};
        let conn = memory_db();
        let ws = new_ws(&conn, "Sales", false, false);
        // Filing in any workspace fails; an unfiled home still works.
        conn.execute_batch(
            "CREATE TRIGGER refuse_filing BEFORE UPDATE OF workspace_id ON meetings
             WHEN NEW.workspace_id NOT LIKE 'unfiled:%' BEGIN SELECT RAISE(ABORT, 'no'); END;",
        )
        .unwrap();
        let (m, notice) = create_meeting_filed(&conn, "A", Some(&ws), true).unwrap();
        assert!(crate::workspace::types::is_unfiled(&m.workspace_id), "not General: {}", m.workspace_id);
        assert!(notice.unwrap().contains("not filed in a workspace"));
    }

    #[test]
    fn past_transcript_labels_remote_speaker_tags() {
        let transcript = serde_json::json!([
            {"id": "a", "text": "Hi", "speaker": "User", "speaker_id": "you", "timestamp_ms": 1_000, "is_final": true},
            {"id": "b", "text": "Hello", "speaker": "Them", "speaker_id": "them", "speaker_tag": "S1", "timestamp_ms": 2_000, "is_final": true},
            {"id": "c", "text": "Yes", "speaker": "Them", "speaker_id": "them", "speaker_tag": "S2", "timestamp_ms": 3_000, "is_final": true},
            {"id": "d", "text": "Plain", "speaker": "Them", "speaker_id": "them", "timestamp_ms": 4_000, "is_final": true},
            {"id": "e", "text": "Room", "speaker": "Them", "speaker_id": "speaker_0", "speaker_tag": "S1", "timestamp_ms": 5_000, "is_final": true}
        ]);
        let names: HashMap<String, String> = [
            ("them:S1", "Erin"),
            ("them", "Them"),
            ("speaker_0", "Dana"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        let labels: Vec<String> = past_transcript(&transcript, &names, 0).into_iter().map(|s| s.speaker).collect();
        assert_eq!(labels, vec!["You", "Erin", "Speaker 2", "Them", "Erin"]);
        // In-person line without a remote name keeps its speaker_id name.
        let names: HashMap<String, String> = [("speaker_0".to_string(), "Dana".to_string())].into_iter().collect();
        let labels: Vec<String> = past_transcript(&transcript, &names, 0).into_iter().map(|s| s.speaker).collect();
        assert_eq!(labels, vec!["You", "Speaker 1", "Speaker 2", "Them", "Dana"]);
    }

    #[test]
    fn a_meeting_asked_for_an_unusable_workspace_starts_unfiled_with_an_empty_scope_and_says_so() {
        use crate::workspace::scope::{scope_for, ScopeOwner};
        use crate::workspace::test_support::{memory_db, new_ws};
        let conn = memory_db();
        let ok = new_ws(&conn, "Sales", false, false);
        let (m, notice) = create_meeting_filed(&conn, "A", Some(&ok), true).unwrap();
        assert_eq!((m.workspace_id.as_str(), notice), (ok.as_str(), None));
        for (title, asked) in [("B", "gone".to_string()), ("C", ok.clone())] {
            if title == "C" {
                crate::workspace::store::archive_workspace(&conn, &ok, true).unwrap();
            }
            let (m, notice) = create_meeting_filed(&conn, title, Some(&asked), true).unwrap();
            assert!(crate::workspace::types::is_unfiled(&m.workspace_id), "{title}: {}", m.workspace_id);
            let notice = notice.unwrap();
            assert!(notice.contains("not filed in a workspace") && notice.contains("island"), "{notice}");
            let scope = scope_for(&conn, ScopeOwner::Meeting(&m.id)).unwrap();
            assert!(scope.material_workspaces.is_empty() && scope.document_ids.is_empty() && scope.folder_ids.is_empty());
            assert!(scope.talking_point_ids.is_empty() && scope.instructions.is_empty() && !scope.unrestricted);
            // The island's picker: an ordinary move gives it a home and its material.
            crate::workspace::meetings::move_meeting_atomic(&conn, &m.id, "general").unwrap();
            assert_eq!(crate::workspace::store::home_of(&conn, &m.id).unwrap().as_deref(), Some("general"));
            assert!(scope_for(&conn, ScopeOwner::Meeting(&m.id)).unwrap().material_workspaces.contains(&"general".to_string()));
        }
        // No id: the default workspace, no sentence.
        let (m, notice) = create_meeting_filed(&conn, "D", None, true).unwrap();
        assert_eq!((m.workspace_id.as_str(), notice), ("general", None));
        // Where the response carries the field, and only then.
        let json: serde_json::Value = serde_json::from_str(&meeting_response(&m, Some("x".into())).unwrap()).unwrap();
        assert_eq!(json["workspace_notice"], "x");
        let json: serde_json::Value = serde_json::from_str(&meeting_response(&m, None).unwrap()).unwrap();
        assert!(json.get("workspace_notice").is_none());
    }

    #[test]
    fn two_unfiled_meetings_do_not_share_a_home_and_cannot_borrow_until_filed() {
        use crate::workspace::test_support::memory_db;
        let conn = memory_db();
        let (a, _) = create_meeting_filed(&conn, "A", Some("gone"), true).unwrap();
        let (b, _) = create_meeting_filed(&conn, "B", Some("gone"), true).unwrap();
        assert_ne!(a.workspace_id, b.workspace_id);
        let err = crate::workspace::meetings::set_meeting_scope(&conn, &a.id, &["general".to_string()]).unwrap_err();
        assert!(err.contains("File this meeting in a workspace first"));
        assert!(crate::workspace::meetings::set_meeting_scope(&conn, &a.id, &[]).is_ok());
        assert!(crate::workspace::access::live_parts(&conn, &a.id).is_some(), "a live meeting without a home can still run its notes");
    }

    #[test]
    fn a_meeting_still_starts_when_workspaces_are_off() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        // Workspaces are off for this run: the meeting is created without a home.
        assert!(create_meeting_filed(&conn, "F", Some("x"), false).is_ok());
    }
}
