//! "Ask this meeting": questions about a past meeting, answered by its warm
//! Claude session (or, with any other provider, statelessly from the full
//! transcript), and saved with the meeting.

use std::sync::{Arc, Mutex};

use tauri::{command, AppHandle, Emitter, State};

use crate::commands::intelligence_commands::{
    compose_instructions, plan_toggles, request_plan, request_route_locked, route_after_outage, run_session_assist,
    sources_unavailable_notice, stateless_provider, SessionAssist, SessionOutcome,
};
use crate::commands::meeting_commands::{past_meeting_context, PastMeetingContext};
use crate::db::meeting_chat::{self, MeetingChatMessage};
use crate::intelligence::prompt_templates::MEETING_ASK_PROMPT;
use crate::llm::cli_agent::context::{build_preload_messages, pack_messages};
use crate::llm::cli_agent::manager::{SessionKey, SessionScope};
use crate::llm::provider::emit_activity;
use crate::sources::config::SourceToggles;
use crate::llm::cli_agent::routing::{earlier_exchange, Route, PRELOAD_MESSAGE_CHARS, REPLAY_TAIL_CHARS};
use crate::llm::provider::{GenerationParams, LLMError, LLMMessage, StreamStartPayload, TokenSink};
use crate::state::AppState;

/// Intelligence mode of an "Ask this meeting" request (stream events, AI Log).
pub const MEETING_ASK_MODE: &str = "MeetingAsk";

/// Saved question/answer pairs, oldest first. A question without an answer
/// right after it is left out.
fn exchanges(chat: &[MeetingChatMessage]) -> Vec<(&str, &str)> {
    chat.windows(2)
        .filter(|pair| pair[0].role == "user" && pair[1].role == "assistant")
        .map(|pair| (pair[0].content.as_str(), pair[1].content.as_str()))
        .collect()
}

/// The most recent exchanges whose text fits in `budget` characters, oldest
/// first, each as [`earlier_exchange`] text.
fn recent_exchanges(chat: &[MeetingChatMessage], budget: usize) -> Vec<String> {
    let mut used = 0usize;
    let mut kept: Vec<String> = exchanges(chat)
        .into_iter()
        .rev()
        .map(|(q, a)| earlier_exchange(q, a))
        .take_while(|text| {
            used += text.chars().count();
            used <= budget
        })
        .collect();
    kept.reverse();
    kept
}

/// Preload messages replaying the meeting's saved chat into a fresh Claude
/// session (`shouldQuery:false`), so follow-up questions work. Only the most
/// recent exchanges are kept (about 30k tokens).
pub(crate) fn chat_history_preload(chat: &[MeetingChatMessage]) -> Vec<String> {
    pack_messages(&recent_exchanges(chat, REPLAY_TAIL_CHARS), PRELOAD_MESSAGE_CHARS)
}

/// The user message of a stateless "Ask this meeting" request: the summary,
/// the whole transcript, the earlier questions with their answers, then the
/// question.
fn stateless_user_prompt(context: &PastMeetingContext, question: &str) -> String {
    let mut parts = build_preload_messages(&context.transcript, context.summary.as_deref(), usize::MAX, false);
    parts.extend(recent_exchanges(&context.chat, REPLAY_TAIL_CHARS));
    parts.push(format!("## Question\n{}", question.trim()));
    parts.join("\n\n")
}

/// System prompt of a stateless request: the Ask instructions plus the
/// composed tone/format presets and custom instructions.
fn stateless_system_prompt(composed_instructions: &str) -> String {
    if composed_instructions.trim().is_empty() {
        MEETING_ASK_PROMPT.to_string()
    } else {
        format!("{MEETING_ASK_PROMPT}\n\nAdditional Instructions: {}", composed_instructions.trim())
    }
}

/// The Ask instructions with the tone/format presets, for a Claude session
/// (whose system prompt already holds the custom instructions).
fn session_task_instructions(presets: &str) -> String {
    if presets.trim().is_empty() {
        MEETING_ASK_PROMPT.to_string()
    } else {
        format!("{MEETING_ASK_PROMPT}\n\n{}", presets.trim())
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// What answered a question, saved on the assistant row.
struct Answer {
    text: String,
    model: String,
    input_tokens: i64,
    output_tokens: i64,
}

/// The question row and the answer row of one exchange.
fn exchange_rows(meeting_id: &str, question: &str, asked_at: i64, answer: &Answer, answered_at: i64) -> [MeetingChatMessage; 2] {
    [
        MeetingChatMessage {
            id: uuid::Uuid::new_v4().to_string(),
            meeting_id: meeting_id.to_string(),
            role: "user".into(),
            content: question.to_string(),
            model: None,
            input_tokens: None,
            output_tokens: None,
            created_at: asked_at,
        },
        MeetingChatMessage {
            id: uuid::Uuid::new_v4().to_string(),
            meeting_id: meeting_id.to_string(),
            role: "assistant".into(),
            content: answer.text.clone(),
            model: Some(answer.model.clone()).filter(|m| !m.is_empty()),
            input_tokens: Some(answer.input_tokens),
            output_tokens: Some(answer.output_tokens),
            // Always after the question, even within the same millisecond.
            created_at: answered_at.max(asked_at + 1),
        },
    ]
}

/// Save one answered question with the meeting.
fn save_exchange(state: &AppState, meeting_id: &str, question: &str, asked_at: i64, answer: &Answer) -> Result<(), String> {
    if answer.text.trim().is_empty() {
        return Ok(());
    }
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;
    let db = db.lock().map_err(|e| format!("Failed to lock database: {}", e))?;
    for row in exchange_rows(meeting_id, question, asked_at, answer, now_ms()) {
        meeting_chat::insert_chat_message(db.connection(), &row)
            .map_err(|e| format!("Answer not saved: {}", e))?;
    }
    Ok(())
}

/// The meeting's saved "Ask this meeting" chat, oldest first.
#[command]
pub async fn list_meeting_chat(
    meeting_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<MeetingChatMessage>, String> {
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;
    let db = db.lock().map_err(|e| format!("Failed to lock database: {}", e))?;
    meeting_chat::list_chat_messages(db.connection(), &meeting_id)
        .map_err(|e| format!("Failed to load meeting chat: {}", e))
}

/// Ask a question about a past meeting. The answer streams through the
/// `llm_stream_*` events tagged with `request_id` (Stop: `cancel_generation`).
/// With the Claude CLI it goes to the meeting's Deep session (restart,
/// overflow and fallback handled like every session request); with any other
/// provider the prompt carries the whole transcript. An answered question is
/// saved with the meeting.
#[command]
pub async fn ask_meeting(
    meeting_id: String,
    question: String,
    request_id: String,
    sources: Option<SourceToggles>,
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let question = question.trim().to_string();
    if question.is_empty() {
        return Err("Type a question first".to_string());
    }
    let asked_at = now_ms();

    let (generation_guard, cancel, presets, composed, temperature) = {
        let intel = state
            .intelligence
            .as_ref()
            .ok_or_else(|| "Intelligence engine not initialized".to_string())?;
        let engine = intel
            .lock()
            .map_err(|e| format!("Failed to lock intelligence engine: {}", e))?;
        // Released on every exit path, once the stream has fully stopped.
        let guard = engine
            .begin_generation(&request_id)
            .ok_or_else(|| "Generation already in progress".to_string())?;
        let configs = engine.get_action_configs();
        let presets = compose_instructions(&configs.instruction_presets, "");
        let composed = compose_instructions(&configs.instruction_presets, &configs.custom_instructions);
        let cancel = guard.cancel_token();
        (guard, cancel, presets, composed, configs.global_defaults.temperature)
    };
    let params = GenerationParams {
        request_id: Some(request_id.clone()),
        cancel: Some(cancel.clone()),
        ..GenerationParams::default()
    };

    let scope = SessionScope::Past(meeting_id.clone());
    let epoch = state.meeting_sessions.epoch(&scope);
    // Asking about a past meeting is the user's own question: the pills decide.
    let scoped = crate::workspace::runtime::for_meeting(&state, &meeting_id);
    let plan = request_plan(&state, MEETING_ASK_MODE, &scope, sources, &scoped);
    let with_sources = plan.with_sources();
    let (no_library, no_tools) = plan.key_flags();
    let mut route = request_route_locked(&state, MEETING_ASK_MODE, &scope, with_sources, no_library, no_tools);

    if let Route::ClaudeSession(key) = &route {
        let make_req = |key: SessionKey| SessionAssist {
            key,
            epoch,
            mode: MEETING_ASK_MODE,
            custom_question: Some(&question),
            detected_question: None,
            transcript_segments: None,
            scope: None,
            task_instructions: session_task_instructions(&presets),
            include_rag: false,
            include_instructions: true,
            include_question: true,
            rag_top_k: 0,
            temperature,
            params: params.clone(),
            cancel: cancel.clone(),
            images: &[],
            workspace: None,
            sources: Some(plan_toggles(&plan)),
        };
        match run_session_assist(&state, &app_handle, key.clone(), make_req).await {
            SessionOutcome::Done(Ok(Some(answer))) => {
                // A restarted session replays the answer with its question; the
                // session that answered (the plain one after a sources fallback).
                state.meeting_sessions.record_reply(&answer.key, &answer.prompt, &answer.turn.text);
                let saved = save_exchange(
                    &state,
                    &meeting_id,
                    &question,
                    asked_at,
                    &Answer {
                        model: answer.model,
                        input_tokens: (answer.turn.input_tokens + answer.turn.cache_read_tokens) as i64,
                        output_tokens: answer.turn.output_tokens as i64,
                        text: answer.turn.text,
                    },
                );
                drop(generation_guard);
                return saved;
            }
            SessionOutcome::Done(result) => {
                drop(generation_guard);
                return result.map(|_| ());
            }
            SessionOutcome::Stateless | SessionOutcome::SourcesFailed(_) => route = Route::Stateless,
            SessionOutcome::Unavailable(kind, reason) => {
                route = route_after_outage(&state, &app_handle, MEETING_ASK_MODE, &scope, kind, &reason, &params)?;
            }
        }
    }

    // ── Stateless: the whole meeting in one prompt (active or fallback provider) ──
    if with_sources {
        emit_activity(&app_handle, &params, sources_unavailable_notice());
    }
    let (provider, model, provider_name, _) = stateless_provider(&state, &app_handle, &route, &params).await?;
    let context = past_meeting_context(&state, &meeting_id)?;
    let system_prompt = stateless_system_prompt(&composed);
    let user_prompt = stateless_user_prompt(&context, &question);
    if cancel.is_cancelled() {
        return Ok(());
    }
    let _ = app_handle.emit(
        "llm_stream_start",
        StreamStartPayload {
            mode: MEETING_ASK_MODE.to_string(),
            model: model.clone(),
            provider: provider_name,
            system_prompt: system_prompt.clone(),
            user_prompt: user_prompt.clone(),
            include_transcript: !context.transcript.is_empty(),
            include_rag: false,
            include_instructions: !composed.trim().is_empty(),
            include_question: true,
            temperature,
            rag_query: None,
            rag_chunks: Vec::new(),
            rag_chunks_filtered: 0,
            rag_total_candidates: 0,
            transcript_window_seconds: 0,
            transcript_segments_count: context.transcript.len(),
            transcript_segments_total: context.transcript.len(),
            request_id: Some(request_id.clone()),
            session_key: None,
            scope_label: None,
        },
    );

    let collected = Arc::new(Mutex::new(String::new()));
    let sink: TokenSink = {
        let collected = collected.clone();
        Arc::new(move |token: &str| {
            if let Ok(mut text) = collected.lock() {
                text.push_str(token);
            }
        })
    };
    let messages = vec![
        LLMMessage { role: "system".into(), content: system_prompt },
        LLMMessage { role: "user".into(), content: user_prompt },
    ];
    let result = {
        let provider = provider.lock().await;
        provider
            .stream_completion(
                messages,
                &model,
                GenerationParams { temperature: Some(temperature), ..params },
                app_handle.clone(),
                Some(sink),
            )
            .await
    };

    // The provider already emitted the end / error event of this request; a
    // stopped stream got its end from `cancel_generation` and is not saved.
    let outcome = match result {
        Ok(stats) if !cancel.is_cancelled() => {
            let text = collected.lock().map(|t| t.clone()).unwrap_or_default();
            save_exchange(
                &state,
                &meeting_id,
                &question,
                asked_at,
                &Answer {
                    text,
                    model,
                    input_tokens: stats.prompt_tokens as i64,
                    output_tokens: stats.completion_tokens as i64,
                },
            )
        }
        Ok(_) | Err(LLMError::Cancelled) => Ok(()),
        Err(_) if cancel.is_cancelled() => Ok(()),
        Err(e) => Err(e.to_string()),
    };
    drop(generation_guard);
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::cli_agent::context::Seg;

    fn row(role: &str, content: &str, created_at: i64) -> MeetingChatMessage {
        MeetingChatMessage {
            id: format!("{role}-{created_at}"),
            meeting_id: "m1".into(),
            role: role.into(),
            content: content.into(),
            model: None,
            input_tokens: None,
            output_tokens: None,
            created_at,
        }
    }

    #[test]
    fn meeting_chat_preload_replays_answered_questions_only() {
        let chat = vec![
            row("user", "When do we ship?", 1),
            row("assistant", "Friday.", 2),
            row("user", "Unanswered", 3),
            row("user", "Who owns it?", 4),
            row("assistant", "Dana.", 5),
        ];
        assert_eq!(
            chat_history_preload(&chat),
            vec![format!(
                "{}\n\n{}",
                earlier_exchange("When do we ship?", "Friday."),
                earlier_exchange("Who owns it?", "Dana.")
            )]
        );
        assert!(chat_history_preload(&[]).is_empty());
    }

    #[test]
    fn meeting_chat_preload_keeps_the_most_recent_exchanges() {
        let long = "x".repeat(REPLAY_TAIL_CHARS / 2);
        let chat = vec![
            row("user", "old", 1),
            row("assistant", &long, 2),
            row("user", "mid", 3),
            row("assistant", &long, 4),
            row("user", "new", 5),
            row("assistant", "short", 6),
        ];
        let kept = recent_exchanges(&chat, REPLAY_TAIL_CHARS);
        assert_eq!(kept.len(), 2, "the oldest exchange no longer fits");
        assert!(kept[0].contains("\nmid\n") && kept[1].contains("\nnew\n"));
    }

    #[test]
    fn meeting_chat_stateless_prompt_has_meeting_history_and_question() {
        let context = PastMeetingContext {
            summary: Some("We agreed to ship.".into()),
            transcript: vec![Seg { id: "s1".into(), text: "Ship Friday".into(), speaker: "Dana".into(), timestamp_ms: 65_000 }],
            chat: vec![row("user", "When?", 1), row("assistant", "Friday.", 2)],
        };
        assert_eq!(
            stateless_user_prompt(&context, " Who decided? "),
            "## Meeting summary\nWe agreed to ship.\n\n\
             ## Meeting transcript\n[01:05] Dana: Ship Friday\n\n\
             ## Earlier question about this meeting\nWhen?\n\n## Your answer\nFriday.\n\n\
             ## Question\nWho decided?"
        );
        assert_eq!(stateless_system_prompt(" "), MEETING_ASK_PROMPT);
        assert!(stateless_system_prompt("Be brief.").ends_with("\n\nAdditional Instructions: Be brief."));
        assert!(session_task_instructions("Brief responses.").ends_with("\n\nBrief responses."));
    }

    #[test]
    fn meeting_chat_exchange_rows_keep_question_before_answer() {
        let answer = Answer { text: "Friday.".into(), model: "sonnet".into(), input_tokens: 900, output_tokens: 12 };
        let [q, a] = exchange_rows("m1", "When?", 1_000, &answer, 1_000);
        assert_eq!((q.role.as_str(), q.content.as_str(), q.created_at, q.model), ("user", "When?", 1_000, None));
        assert_eq!((a.role.as_str(), a.content.as_str(), a.created_at), ("assistant", "Friday.", 1_001));
        assert_eq!((a.model.as_deref(), a.input_tokens, a.output_tokens), (Some("sonnet"), Some(900), Some(12)));
        assert_ne!(q.id, a.id);
    }
}
