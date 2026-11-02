//! Request routing for the Claude CLI provider.
//!
//! - [`choose_route`]: a request goes to a warm meeting session, to the
//!   fallback provider (Claude unavailable), or down today's stateless path
//!   (any other provider, or no meeting scope).
//! - [`HealthTracker`]: whether Claude is usable; set unavailable after a
//!   failed restart, back to healthy by the background re-probe (rate limits
//!   back off for 15 min first).
//! - [`MeetingSessions`]: what each meeting session was given (system prompt,
//!   preload, every delta sent, which segments it holds), so a crashed
//!   session can be restarted with the same context.
//! - [`ask_meeting_session`]: send one delta on a meeting session, restarting
//!   it once on a crash, timeout, logout or rate limit, and say how a failed
//!   request should be handled ([`AskFailure`]).

use super::context::{
    build_delta_prompt, build_document_preload, pack_messages, transcript_lines, DeltaCursor, Seg,
    SentLine,
};
use super::detect::{claude_auth_status, find_claude_binary, ClaudeLogin, API_BILLED_NOTE};
use super::manager::{
    tier_for, AgentSessionManager, ClaudeCliConfig, OnDelta, SessionInit, SessionKey,
    SessionScope, Tier,
};
use super::protocol::{AgentErrorKind, TurnResult};
use super::session::AgentError;
use crate::context::token_counter::count_tokens;
use crate::llm::provider::{CancelToken, LLMProvider};
use crate::llm::{ProviderConfig, ProviderType};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Context documents up to this many tokens are preloaded into a live
/// session; beyond it the session runs RAG retrieval per request instead.
pub const DOC_PRELOAD_TOKEN_CAP: usize = 100_000;
/// Largest single preload message (characters).
pub const PRELOAD_MESSAGE_CHARS: usize = 100_000;
/// After a context overflow the session restarts with its preload and only
/// the most recent deltas that fit in this many characters (~30k tokens).
pub const REPLAY_TAIL_CHARS: usize = 120_000;
/// How often an unavailable Claude is re-probed.
pub const HEALTH_PROBE_INTERVAL: Duration = Duration::from_secs(60);
/// A rate-limited Claude is not re-probed before this (the login probe
/// succeeds while the usage limit still holds).
pub const RATE_LIMIT_BACKOFF: Duration = Duration::from_secs(15 * 60);
/// Tauri event carrying [`AgentFallbackPayload`].
pub const FALLBACK_EVENT: &str = "agent_fallback";

/// Payload of `agent_fallback`: Claude is unavailable and requests now go to
/// `provider` (the fallback provider's display name; empty when a usage limit
/// was hit and no fallback provider is configured).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentFallbackPayload {
    pub reason: String,
    pub provider: String,
}

/// Whether Claude can take requests right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaudeHealth {
    Healthy,
    Unavailable(AgentErrorKind),
}

/// Where one `generate_assist` request goes.
#[derive(Debug, Clone)]
pub enum Route {
    /// The warm Claude session of a meeting.
    ClaudeSession(SessionKey),
    /// Claude is unavailable: today's full-prompt path on this provider.
    Fallback(ProviderConfig),
    /// Today's full-prompt path on the active provider.
    Stateless,
}

/// Pick the route of one request. Only the Claude CLI provider has sessions,
/// and only meeting scopes (live or past) use them; Utility requests go
/// through the provider's own `stream_completion`. When Claude is unavailable
/// the request goes to the fallback provider, or, with none configured, down
/// the stateless path, where the Claude provider reports the reason.
pub fn choose_route(
    active: &ProviderType,
    claude_health: ClaudeHealth,
    scope: &SessionScope,
    mode: &str,
    cfg: &ClaudeCliConfig,
) -> Route {
    if *active != ProviderType::ClaudeCli {
        return Route::Stateless;
    }
    match claude_health {
        ClaudeHealth::Unavailable(_) => match &cfg.fallback_provider {
            Some(provider) => Route::Fallback(fallback_config(provider)),
            None => Route::Stateless,
        },
        ClaudeHealth::Healthy => match scope {
            SessionScope::Utility => Route::Stateless,
            SessionScope::Live(_) | SessionScope::Past(_) => Route::ClaudeSession(SessionKey {
                scope: scope.clone(),
                tier: tier_for(mode, scope, cfg),
            }),
        },
    }
}

/// A provider config naming only the type; the caller adds the API key.
pub fn fallback_config(provider: &str) -> ProviderConfig {
    ProviderConfig {
        provider_type: provider.to_string(),
        api_key: None,
        base_url: None,
        auth_type: None,
        auth_value: None,
        auth_header: None,
    }
}

struct HealthState {
    health: ClaudeHealth,
    /// When it became unavailable.
    since: Instant,
    /// The outage was announced with `agent_fallback`; cleared only by a
    /// successful Claude turn, so a flapping outage toasts once.
    announced: bool,
}

/// Claude's health and whether the current outage was already announced.
pub struct HealthTracker {
    state: Mutex<HealthState>,
}

impl Default for HealthTracker {
    fn default() -> Self {
        Self {
            state: Mutex::new(HealthState {
                health: ClaudeHealth::Healthy,
                since: Instant::now(),
                announced: false,
            }),
        }
    }
}

impl HealthTracker {
    pub fn get(&self) -> ClaudeHealth {
        self.state.lock().unwrap().health
    }

    pub fn mark_unavailable(&self, kind: AgentErrorKind) {
        self.mark_unavailable_at(kind, Instant::now());
    }

    fn mark_unavailable_at(&self, kind: AgentErrorKind, now: Instant) {
        let mut state = self.state.lock().unwrap();
        state.health = ClaudeHealth::Unavailable(kind);
        state.since = now;
    }

    /// Whether the background probe should check Claude now: only while it
    /// is unavailable, and for a rate limit only after [`RATE_LIMIT_BACKOFF`].
    pub fn probe_due(&self, now: Instant) -> bool {
        let state = self.state.lock().unwrap();
        match state.health {
            ClaudeHealth::Healthy => false,
            ClaudeHealth::Unavailable(AgentErrorKind::RateLimited) => {
                now.saturating_duration_since(state.since) >= RATE_LIMIT_BACKOFF
            }
            ClaudeHealth::Unavailable(_) => true,
        }
    }

    /// The probe found Claude usable: requests try it again. The outage stays
    /// announced until a turn succeeds. True when Claude was unavailable.
    pub fn mark_healthy(&self) -> bool {
        let mut state = self.state.lock().unwrap();
        let was_down = state.health != ClaudeHealth::Healthy;
        state.health = ClaudeHealth::Healthy;
        was_down
    }

    /// A Claude turn succeeded: healthy, and a next outage is announced again.
    pub fn record_success(&self) {
        let mut state = self.state.lock().unwrap();
        state.health = ClaudeHealth::Healthy;
        state.announced = false;
    }

    /// True the first time it is called during an outage.
    pub fn take_fallback_notice(&self) -> bool {
        let mut state = self.state.lock().unwrap();
        let first = !state.announced;
        state.announced = true;
        first
    }
}

/// The fallback provider client built for a (type, model, key) choice, kept
/// so fallback requests don't rebuild it or list models every time.
pub struct CachedFallback {
    /// `(provider type, configured fallback model, API key)` it was built for.
    pub key: (String, Option<String>, Option<String>),
    pub provider: Arc<tokio::sync::Mutex<Box<dyn LLMProvider>>>,
    pub model: String,
    /// Display name, e.g. "Ollama".
    pub name: String,
}

/// What one meeting session holds, so it can be restarted with it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SessionRecord {
    pub system_prompt: String,
    /// Context given at the session's first start (documents, transcript...).
    pub preload: Vec<String>,
    /// Every delta the session received since, in order.
    pub replay: Vec<String>,
    /// What the session was sent of each final transcript segment (by id):
    /// its text, and whether the context still holds it.
    pub sent: HashMap<String, SentLine>,
    /// Context documents were over the cap: requests run RAG retrieval.
    pub rag_mode: bool,
    /// The preload alone overflows the context: requests skip the session
    /// and go down the stateless path.
    pub stateless_only: bool,
}

impl SessionRecord {
    /// System prompt and context for (re)starting the session: the preload
    /// followed by every delta sent so far (packed into few messages).
    fn restart_init(&self) -> SessionInit {
        let mut preload = self.preload.clone();
        preload.extend(pack_messages(&self.replay, PRELOAD_MESSAGE_CHARS));
        SessionInit {
            system_prompt: self.system_prompt.clone(),
            preload,
        }
    }
}

/// [`SessionRecord`]s of the open meeting sessions, plus a per-scope epoch
/// bumped on every close so background work started before a close can tell
/// it is stale.
#[derive(Default)]
pub struct MeetingSessions {
    /// Lock order: `epochs`, then `records`.
    epochs: Mutex<HashMap<SessionScope, u64>>,
    records: Mutex<HashMap<SessionKey, SessionRecord>>,
}

impl MeetingSessions {
    /// Record `key`'s session unless it already has a record. True if inserted.
    pub fn insert_if_absent(&self, key: SessionKey, record: SessionRecord) -> bool {
        let mut records = self.records.lock().unwrap();
        if records.contains_key(&key) {
            return false;
        }
        records.insert(key, record);
        true
    }

    /// How many times `scope` was closed.
    pub fn epoch(&self, scope: &SessionScope) -> u64 {
        self.epochs.lock().unwrap().get(scope).copied().unwrap_or(0)
    }

    /// For background starts: if `scope` was not closed since `epoch`, record
    /// `key`'s session (unless already recorded) and return true; else
    /// discard `record` and return false.
    pub fn insert_if_current(&self, key: SessionKey, record: SessionRecord, epoch: u64) -> bool {
        let epochs = self.epochs.lock().unwrap();
        if epochs.get(&key.scope).copied().unwrap_or(0) != epoch {
            return false;
        }
        self.records.lock().unwrap().entry(key).or_insert(record);
        true
    }

    /// For a request's lazy start: unless `scope` was closed since `epoch`
    /// (read when the request chose its scope), make sure `key` has a record
    /// (`build` runs only when it has none) and return true. Returns false
    /// once the scope was closed, so an ended meeting's record is never
    /// recreated (and no session is started for it).
    pub fn ensure_current(
        &self,
        key: &SessionKey,
        epoch: u64,
        build: impl FnOnce() -> Result<SessionRecord, String>,
    ) -> Result<bool, String> {
        if self.epoch(&key.scope) != epoch {
            return Ok(false);
        }
        if self.contains(key) {
            return Ok(true);
        }
        let record = build()?;
        Ok(self.insert_if_current(key.clone(), record, epoch))
    }

    fn is_stateless_only(&self, key: &SessionKey) -> bool {
        self.records
            .lock()
            .unwrap()
            .get(key)
            .map(|r| r.stateless_only)
            .unwrap_or(false)
    }

    pub fn contains(&self, key: &SessionKey) -> bool {
        self.records.lock().unwrap().contains_key(key)
    }

    pub fn get(&self, key: &SessionKey) -> Option<SessionRecord> {
        self.records.lock().unwrap().get(key).cloned()
    }

    /// Forget every tier of `scope` (meeting ended / meeting view left).
    pub fn remove_scope(&self, scope: &SessionScope) {
        let mut epochs = self.epochs.lock().unwrap();
        *epochs.entry(scope.clone()).or_insert(0) += 1;
        self.records.lock().unwrap().retain(|key, _| key.scope != *scope);
    }

    fn restart_init(&self, key: &SessionKey) -> Option<SessionInit> {
        self.records.lock().unwrap().get(key).map(SessionRecord::restart_init)
    }

    fn sent_lines(&self, key: &SessionKey) -> HashMap<String, SentLine> {
        self.records
            .lock()
            .unwrap()
            .get(key)
            .map(|r| r.sent.clone())
            .unwrap_or_default()
    }

    /// A chat answer to `prompt`: keep it with that prompt in the replay, so
    /// a restarted session still knows what it answered (follow-ups work).
    /// Nothing happens if `prompt` is no longer in the replay.
    pub fn record_reply(&self, key: &SessionKey, prompt: &str, reply: &str) {
        if reply.trim().is_empty() {
            return;
        }
        if let Some(record) = self.records.lock().unwrap().get_mut(key) {
            if let Some(entry) = record.replay.iter_mut().rev().find(|delta| delta.as_str() == prompt) {
                *entry = answered_turn(prompt, reply);
            }
        }
    }

    fn record_sent(&self, key: &SessionKey, prompt: &str, sent: HashMap<String, SentLine>) {
        if let Some(record) = self.records.lock().unwrap().get_mut(key) {
            record.replay.push(prompt.to_string());
            record.sent = sent;
        }
    }

    /// Keep only the most recent deltas that fit in `budget` characters.
    /// When that drops nothing (the preload itself is too big), mark the
    /// record stateless-only. Lines left only in dropped deltas stay sent
    /// (old context is forgotten on purpose) but are no longer held, so one
    /// that changes later goes whole instead of as a continuation.
    fn truncate_replay(&self, key: &SessionKey, budget: usize) {
        if let Some(record) = self.records.lock().unwrap().get_mut(key) {
            let mut used = 0usize;
            let keep = record
                .replay
                .iter()
                .rev()
                .take_while(|delta| {
                    used += delta.chars().count();
                    used <= budget
                })
                .count();
            let drop = record.replay.len() - keep;
            record.replay.drain(..drop);
            if drop == 0 {
                record.stateless_only = true;
            }
            let SessionRecord { preload, replay, sent, .. } = record;
            for (id, line) in sent.iter_mut() {
                let tag = format!("[{id}]");
                line.held = preload.iter().chain(replay.iter()).any(|m| m.contains(&tag));
            }
        }
    }
}

/// How a meeting-session request failed, and so how it is handled.
#[derive(Debug, Clone, PartialEq)]
pub enum AskFailure {
    /// The meeting ended or its view was left while the request ran: not an
    /// outage; the stream just ends.
    Closed,
    /// Stopped by the user (`cancel_generation` already ended the stream).
    Cancelled,
    /// Failed after part of the answer had streamed. Not retried and not
    /// sent elsewhere (that would repeat the text); reported as an error.
    AfterOutput(AgentError),
    /// The session's context is full. It was reset to its preload plus the
    /// most recent deltas (or, when the preload alone is too big, marked
    /// stateless-only); this request goes down the stateless path.
    ContextFull(AgentError),
    /// Claude is unavailable (after one restart where it applies).
    Unavailable(AgentErrorKind, AgentError),
    /// Any other error result, reported as it is.
    Error(AgentError),
}

/// Errors worth one session restart (the context is replayed).
pub fn is_restartable(err: &AgentError) -> bool {
    matches!(
        err,
        AgentError::Crashed(_)
            | AgentError::Timeout
            | AgentError::Cli(AgentErrorKind::NotLoggedIn | AgentErrorKind::RateLimited, _)
    )
}

/// The outage an error means, or `None` for errors that are not about
/// Claude being unavailable (a stop, a full context, or an error result such
/// as a refused request), which are handled on their own.
pub fn unavailable_kind(err: &AgentError) -> Option<AgentErrorKind> {
    match err {
        AgentError::Cancelled
        | AgentError::CancelledBeforeSend
        | AgentError::Cli(AgentErrorKind::Other | AgentErrorKind::ContextOverflow, _) => None,
        AgentError::Timeout => Some(AgentErrorKind::Crashed),
        other => match other.kind() {
            AgentErrorKind::ContextOverflow => None,
            kind => Some(kind),
        },
    }
}

/// Short readable reason for the fallback toast.
pub fn reason_label(kind: AgentErrorKind) -> &'static str {
    match kind {
        AgentErrorKind::NotInstalled => "not installed",
        AgentErrorKind::NotLoggedIn => "not logged in",
        AgentErrorKind::RateLimited => "usage limit reached",
        AgentErrorKind::ContextOverflow => "conversation too long",
        AgentErrorKind::Crashed => "session crashed",
        AgentErrorKind::Other => "unavailable",
    }
}

/// True when the prompt reached Claude and stays in its history: answered,
/// stopped mid-turn, or answered with an error result.
fn delivered(result: &Result<TurnResult, AgentError>) -> bool {
    matches!(
        result,
        Ok(_) | Err(AgentError::Cancelled) | Err(AgentError::Cli(AgentErrorKind::Other, _))
    )
}

/// Take `key`'s session out of service (closed in the background) so the
/// next `ensure` starts it again from its record.
fn retire(manager: &AgentSessionManager, key: &SessionKey) {
    if let Some(old) = manager.retire_if_idle(key) {
        tokio::spawn(async move { old.close().await });
    }
}

/// Send one request on the meeting session `key` (whose record the caller
/// inserted): ensure the session, take what the final segments add to what
/// it was sent (new lines, the new words of grown lines, corrected lines;
/// see [`DeltaCursor::take_new`]), build the prompt with `compose(new_segments)`, report it with
/// `on_sent(prompt, model, new_segment_count)` and ask.
///
/// - A crash, timeout, logout or rate limit before any output restarts the
///   session once with its preload plus every earlier delta and asks again.
/// - A delivered prompt is recorded for replay; an undelivered one is rolled
///   back so its segments go with the next request.
/// - A full context resets the session to its preload plus a short replay
///   tail ([`AskFailure::ContextFull`]).
pub async fn ask_meeting_session(
    manager: &AgentSessionManager,
    sessions: &MeetingSessions,
    key: &SessionKey,
    finals: &[Seg],
    compose: impl FnOnce(&[Seg]) -> String,
    on_sent: impl FnOnce(&str, &str, usize),
    make_on_delta: impl Fn() -> OnDelta,
    cancel: Arc<CancelToken>,
) -> Result<TurnResult, AskFailure> {
    let mut compose = Some(compose);
    let mut on_sent = Some(on_sent);
    let mut prompt: Option<String> = None;
    let mut restarted = false;
    let streamed = Arc::new(AtomicBool::new(false));
    loop {
        let Some(init) = sessions.restart_init(key) else {
            return Err(AskFailure::Closed);
        };
        if sessions.is_stateless_only(key) {
            return Err(AskFailure::ContextFull(AgentError::Cli(
                AgentErrorKind::ContextOverflow,
                "this meeting is too long for a Claude session".into(),
            )));
        }
        let attempt = async {
            let handle = manager.ensure(key, init).await?;
            if cancel.is_cancelled() {
                return Err(AgentError::CancelledBeforeSend);
            }
            let mut cursor = manager.cursor(key).await;
            // The manager resets a cursor whenever its session (re)starts; the
            // record knows what the (replayed) context holds.
            let known = sessions.sent_lines(key);
            if *cursor.sent_lines() != known {
                *cursor = DeltaCursor::with_sent(known);
            }
            let before = cursor.clone();
            let new = cursor.take_new(finals);
            if prompt.is_none() {
                let build = compose.take().expect("compose runs once");
                prompt = Some(build(&new));
            }
            let text = prompt.clone().unwrap_or_default();
            if let Some(report) = on_sent.take() {
                report(&text, &handle.model(), new.len());
            }
            let on_delta: OnDelta = {
                let inner = make_on_delta();
                let streamed = streamed.clone();
                Box::new(move |token: &str| {
                    if !token.is_empty() {
                        streamed.store(true, Ordering::SeqCst);
                    }
                    inner(token)
                })
            };
            let result = manager.ask(key, &text, on_delta, cancel.clone()).await;
            if delivered(&result) {
                sessions.record_sent(key, &text, cursor.sent_lines().clone());
            } else {
                *cursor = before;
            }
            result
        };
        let err = match attempt.await {
            Ok(turn) => {
                // Closed while this turn ran: don't leave the session behind.
                if !sessions.contains(key) {
                    retire(manager, key);
                }
                return Ok(turn);
            }
            Err(e) => e,
        };
        if !sessions.contains(key) {
            retire(manager, key);
            return Err(AskFailure::Closed);
        }
        if err.is_cancel() || cancel.is_cancelled() {
            return Err(AskFailure::Cancelled);
        }
        // Before the overflow case: text already on screen is never re-answered.
        if streamed.load(Ordering::SeqCst) {
            return Err(AskFailure::AfterOutput(err));
        }
        if matches!(err, AgentError::Cli(AgentErrorKind::ContextOverflow, _)) {
            log::warn!("Claude session {key:?} is full ({err}); resetting it to a short replay");
            sessions.truncate_replay(key, REPLAY_TAIL_CHARS);
            retire(manager, key);
            return Err(AskFailure::ContextFull(err));
        }
        if !restarted && is_restartable(&err) {
            log::warn!("Claude session {key:?} failed ({err}); restarting it once");
            restarted = true;
            retire(manager, key);
            continue;
        }
        return Err(match unavailable_kind(&err) {
            Some(kind) => AskFailure::Unavailable(kind, err),
            None => AskFailure::Error(err),
        });
    }
}

/// Session system prompt for a live meeting: the scenario prompt, the
/// speaker context, the global custom instructions and how the session's
/// messages are laid out.
pub fn live_system_prompt(scenario_prompt: &str, speaker_context: &str, custom_instructions: &str) -> String {
    let base = if scenario_prompt.trim().is_empty() {
        "You are NexQ, a real-time AI meeting assistant. Help the user follow the \
         meeting and respond well: accurate, concise, actionable."
    } else {
        scenario_prompt.trim()
    };
    let mut parts = vec![base.to_string()];
    if !speaker_context.trim().is_empty() {
        parts.push(speaker_context.trim().to_string());
    }
    if !custom_instructions.trim().is_empty() {
        parts.push(format!("Additional Instructions: {}", custom_instructions.trim()));
    }
    parts.push(LIVE_SESSION_RULES.to_string());
    parts.join("\n\n")
}

/// Session system prompt for a finished meeting open in the meeting view.
pub fn past_system_prompt(custom_instructions: &str) -> String {
    let mut parts = vec![PAST_SESSION_PROMPT.to_string()];
    if !custom_instructions.trim().is_empty() {
        parts.push(format!("Additional Instructions: {}", custom_instructions.trim()));
    }
    parts.join("\n\n")
}

const ANSWER_HEADER: &str = "## Your answer";

/// A request and the answer it got, as replayed into a restarted session.
pub fn answered_turn(prompt: &str, reply: &str) -> String {
    format!("{prompt}\n\n{ANSWER_HEADER}\n{}", reply.trim())
}

/// A saved "Ask this meeting" exchange, as replayed into a fresh session.
pub fn earlier_exchange(question: &str, answer: &str) -> String {
    format!(
        "## Earlier question about this meeting\n{}\n\n{ANSWER_HEADER}\n{}",
        question.trim(),
        answer.trim()
    )
}

const LIVE_SESSION_RULES: &str = "\
## How this session works
You are connected to a live meeting through NexQ. Context documents and the \
transcript arrive as messages. Each request carries only the transcript lines \
that are new since the previous request (\"[mm:ss] [SEGMENT_ID] Speaker: \
text\"), then \"## Task instructions\" and, when present, the question. A \
line whose text starts with \"…\" continues the earlier line with the same \
SEGMENT_ID (the speaker kept talking; it carries only the new words). A line \
whose text starts with \"(corrected)\" replaces the earlier line with the same \
SEGMENT_ID. Treat every transcript line you have received as one continuous \
meeting. Follow the \
task instructions of the current message only; they replace those of earlier \
messages. When asked for segment ids, use the [SEGMENT_ID] of the lines; \
otherwise never mention them. Answer directly, without preamble, and never \
repeat the transcript back. Respond in the language used in the meeting.";

const PAST_SESSION_PROMPT: &str = "\
You are NexQ's assistant for a meeting that has already ended. Its summary \
(when one exists) and full transcript arrive as context messages; each \
transcript line reads \"[mm:ss] [SEGMENT_ID] Speaker: text\". Each request \
carries \"## Task instructions\" and, when present, a question. Follow the \
task instructions of the current message only; they replace those of earlier \
messages. When asked for segment ids, use the [SEGMENT_ID] of the lines. \
Earlier questions about this meeting and the answers you gave may also \
arrive as context; use them for follow-up questions. Base your answers on \
this meeting, answer directly without preamble, and respond in the language \
used in the meeting.";

/// Preload messages for the context documents, and whether the session must
/// use RAG retrieval instead (documents over [`DOC_PRELOAD_TOKEN_CAP`]).
pub fn document_preload(documents: &str) -> (Vec<String>, bool) {
    if documents.trim().is_empty() {
        return (Vec::new(), false);
    }
    if count_tokens(documents) > DOC_PRELOAD_TOKEN_CAP {
        return (Vec::new(), true);
    }
    (build_document_preload(documents, PRELOAD_MESSAGE_CHARS), false)
}

/// The user message of one request: the new transcript lines, optional
/// extra sections (document excerpts from RAG, segment-id transcript), then
/// the task instructions and the question(s).
pub fn compose_delta(
    new_segments: &[Seg],
    extra_sections: &[(&str, &str)],
    task_instructions: &str,
    question: Option<&str>,
    detected_question: Option<&str>,
) -> String {
    let mut parts = Vec::new();
    if !new_segments.is_empty() {
        parts.push(format!(
            "## New transcript since last request\n{}",
            transcript_lines(new_segments, true)
        ));
    }
    for (header, body) in extra_sections {
        if !body.trim().is_empty() {
            parts.push(format!("{header}\n{}", body.trim()));
        }
    }
    parts.push(build_delta_prompt(&[], task_instructions, question, detected_question));
    parts.retain(|p| !p.is_empty());
    parts.join("\n\n")
}

/// `live:<meeting>:fast` style label for logs and the AI Log.
pub fn session_key_label(key: &SessionKey) -> String {
    let tier = match key.tier {
        Tier::Fast => "fast",
        Tier::Deep => "deep",
    };
    match &key.scope {
        SessionScope::Live(id) => format!("live:{id}:{tier}"),
        SessionScope::Past(id) => format!("past:{id}:{tier}"),
        SessionScope::Utility => format!("utility:{tier}"),
    }
}

/// `You` for the mic party, the label otherwise.
pub fn speaker_label(speaker: &str) -> &str {
    match speaker {
        "User" => "You",
        other => other,
    }
}

/// Milliseconds since `start_ms` for a wall-clock timestamp; timestamps
/// already relative (smaller than the start) are kept.
pub fn relative_ms(timestamp_ms: i64, start_ms: i64) -> u64 {
    let ts = timestamp_ms.max(0);
    if start_ms > 0 && ts >= start_ms {
        (ts - start_ms) as u64
    } else {
        ts as u64
    }
}

/// A stable, short id for a segment that has none (older callers), derived
/// from its time, speaker and text.
pub fn fallback_segment_id(timestamp_ms: i64, speaker: &str, text: &str) -> String {
    use std::hash::{Hash, Hasher};
    // `DefaultHasher::new()` uses fixed keys: the same segment always hashes the same.
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    (timestamp_ms, speaker, text).hash(&mut hasher);
    format!("seg-{:016x}", hasher.finish())
}

/// Speaker suffix the frontend gives text the STT hasn't finalized yet.
pub const INTERIM_SUFFIX: &str = " (interim)";

/// Split request segments into final lines and text still being transcribed.
/// Interim text may still change, so it rides along with one request and is
/// never recorded as sent (nor preloaded) in a session.
pub fn split_interim(segments: Vec<Seg>) -> (Vec<Seg>, Vec<Seg>) {
    segments.into_iter().partition(|s| !s.speaker.ends_with(INTERIM_SUFFIX))
}

/// Segments from `generate_assist`'s `transcript_segments` JSON, with
/// timestamps relative to `start_ms`. Blank segments are skipped.
pub fn segments_from_json(json: &str, start_ms: i64) -> Vec<Seg> {
    #[derive(Deserialize)]
    struct Raw {
        #[serde(default)]
        id: String,
        text: String,
        speaker: String,
        timestamp_ms: i64,
    }
    let raw: Vec<Raw> = match serde_json::from_str(json) {
        Ok(raw) => raw,
        Err(e) => {
            log::warn!("Failed to parse transcript segments: {e}");
            return Vec::new();
        }
    };
    raw.into_iter()
        .filter(|s| !s.text.trim().is_empty())
        .map(|s| Seg {
            id: if s.id.is_empty() {
                fallback_segment_id(s.timestamp_ms, &s.speaker, &s.text)
            } else {
                s.id
            },
            speaker: speaker_label(&s.speaker).to_string(),
            timestamp_ms: relative_ms(s.timestamp_ms, start_ms),
            text: s.text,
        })
        .collect()
}

/// No-cost check that Claude is installed and logged in (to a subscription
/// or, flagged in the UI, an API account).
pub async fn probe_claude() -> Result<(), AgentErrorKind> {
    let bin = tokio::task::spawn_blocking(find_claude_binary)
        .await
        .ok()
        .flatten()
        .ok_or(AgentErrorKind::NotInstalled)?;
    let auth = claude_auth_status(&bin)
        .await
        .map_err(|_| AgentErrorKind::Other)?;
    match auth.login {
        ClaudeLogin::Subscription => Ok(()),
        ClaudeLogin::LoggedOut => Err(AgentErrorKind::NotLoggedIn),
        // Not blocked (the user may want it); Settings and the footer chip
        // flag it, so it never passes for the subscription.
        ClaudeLogin::ApiBilled => {
            log::warn!("{API_BILLED_NOTE}");
            Ok(())
        }
    }
}

/// While Claude is the active provider and unavailable, re-probe it every
/// [`HEALTH_PROBE_INTERVAL`] (no model call; a rate limit waits
/// [`RATE_LIMIT_BACKOFF`] first) and mark it healthy again once it is
/// installed and logged in, so requests switch back to it.
pub async fn run_health_probe(app: tauri::AppHandle) {
    use tauri::Manager;
    let mut tick = tokio::time::interval(HEALTH_PROBE_INTERVAL);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tick.tick().await;
        let Some(state) = app.try_state::<crate::state::AppState>() else {
            continue;
        };
        if !state.claude_health.probe_due(Instant::now()) || !claude_is_active(&state) {
            continue;
        }
        if probe_claude().await.is_ok() && state.claude_health.mark_healthy() {
            log::info!("Claude CLI looks available again; requests try it again");
        }
    }
}

/// True when the active LLM provider is the Claude CLI.
pub fn claude_is_active(state: &crate::state::AppState) -> bool {
    state
        .llm
        .as_ref()
        .and_then(|llm| llm.lock().ok())
        .and_then(|router| router.active_provider_type().cloned())
        .map(|pt| pt == ProviderType::ClaudeCli)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::cli_agent::command::SessionConfig;
    use crate::llm::cli_agent::manager::{NoopStatusSink, SessionHandle, SessionSpawner};
    use async_trait::async_trait;
    use std::sync::atomic::AtomicUsize;
    use std::sync::RwLock;

    fn live() -> SessionScope {
        SessionScope::Live("m1".into())
    }

    #[test]
    fn route_claude_healthy_live_assist() {
        let route = choose_route(
            &ProviderType::ClaudeCli,
            ClaudeHealth::Healthy,
            &live(),
            "Assist",
            &ClaudeCliConfig::default(),
        );
        match route {
            Route::ClaudeSession(key) => {
                assert_eq!(key, SessionKey { scope: live(), tier: Tier::Fast })
            }
            other => panic!("expected a Claude session, got {other:?}"),
        }
    }

    #[test]
    fn route_unavailable_with_fallback() {
        let cfg = ClaudeCliConfig {
            fallback_provider: Some("ollama".into()),
            ..Default::default()
        };
        let route = choose_route(
            &ProviderType::ClaudeCli,
            ClaudeHealth::Unavailable(AgentErrorKind::NotLoggedIn),
            &live(),
            "Assist",
            &cfg,
        );
        match route {
            Route::Fallback(p) => {
                assert_eq!(p.provider_type, "ollama");
                assert_eq!(p.api_key, None);
            }
            other => panic!("expected the fallback, got {other:?}"),
        }
    }

    #[test]
    fn route_unavailable_no_fallback() {
        let route = choose_route(
            &ProviderType::ClaudeCli,
            ClaudeHealth::Unavailable(AgentErrorKind::RateLimited),
            &live(),
            "Assist",
            &ClaudeCliConfig::default(),
        );
        assert!(matches!(route, Route::Stateless), "{route:?}");
    }

    #[test]
    fn route_non_claude_provider() {
        let route = choose_route(
            &ProviderType::Ollama,
            ClaudeHealth::Healthy,
            &live(),
            "Assist",
            &ClaudeCliConfig::default(),
        );
        assert!(matches!(route, Route::Stateless), "{route:?}");
    }

    #[test]
    fn routing_recap_deep_past_deep_utility_stateless() {
        let cfg = ClaudeCliConfig::default();
        let key = |scope: &SessionScope, mode: &str| {
            match choose_route(&ProviderType::ClaudeCli, ClaudeHealth::Healthy, scope, mode, &cfg) {
                Route::ClaudeSession(k) => Some(k.tier),
                _ => None,
            }
        };
        assert_eq!(key(&live(), "Recap"), Some(Tier::Deep));
        assert_eq!(key(&SessionScope::Past("p".into()), "MeetingSummary"), Some(Tier::Deep));
        assert_eq!(key(&SessionScope::Utility, "Assist"), None);
    }

    #[test]
    fn routing_health_tracker_announces_once_per_outage() {
        let health = HealthTracker::default();
        assert_eq!(health.get(), ClaudeHealth::Healthy);
        assert!(!health.mark_healthy());
        health.mark_unavailable(AgentErrorKind::NotLoggedIn);
        assert_eq!(health.get(), ClaudeHealth::Unavailable(AgentErrorKind::NotLoggedIn));
        assert!(health.take_fallback_notice());
        assert!(!health.take_fallback_notice());
        // The probe flips it back, but only a successful turn re-arms the toast.
        assert!(health.mark_healthy());
        health.mark_unavailable(AgentErrorKind::NotLoggedIn);
        assert!(!health.take_fallback_notice(), "a flapping outage toasts once");
        health.record_success();
        assert_eq!(health.get(), ClaudeHealth::Healthy);
        health.mark_unavailable(AgentErrorKind::RateLimited);
        assert!(health.take_fallback_notice(), "a new outage after a success toasts again");
    }

    #[test]
    fn routing_rate_limit_backs_off_before_probing() {
        let health = HealthTracker::default();
        let t0 = Instant::now();
        assert!(!health.probe_due(t0), "healthy: nothing to probe");
        health.mark_unavailable_at(AgentErrorKind::NotLoggedIn, t0);
        assert!(health.probe_due(t0), "logged out: probe every tick");
        health.mark_unavailable_at(AgentErrorKind::RateLimited, t0);
        assert!(!health.probe_due(t0 + Duration::from_secs(60)));
        assert!(!health.probe_due(t0 + Duration::from_secs(14 * 60)));
        assert!(health.probe_due(t0 + RATE_LIMIT_BACKOFF));
    }

    #[test]
    fn routing_error_classes() {
        assert!(is_restartable(&AgentError::Crashed("x".into())));
        assert!(is_restartable(&AgentError::Timeout));
        assert!(is_restartable(&AgentError::Cli(AgentErrorKind::NotLoggedIn, "x".into())));
        assert!(is_restartable(&AgentError::Cli(AgentErrorKind::RateLimited, "x".into())));
        assert!(!is_restartable(&AgentError::Cli(AgentErrorKind::Other, "refused".into())));
        assert!(!is_restartable(&AgentError::Cli(AgentErrorKind::ContextOverflow, "x".into())));
        assert!(!is_restartable(&AgentError::Spawn("not installed".into())));
        assert!(!is_restartable(&AgentError::Cancelled));

        assert_eq!(unavailable_kind(&AgentError::Cancelled), None);
        assert_eq!(unavailable_kind(&AgentError::CancelledBeforeSend), None);
        assert_eq!(unavailable_kind(&AgentError::Cli(AgentErrorKind::Other, "x".into())), None);
        assert_eq!(
            unavailable_kind(&AgentError::Cli(AgentErrorKind::ContextOverflow, "x".into())),
            None
        );
        assert_eq!(
            unavailable_kind(&AgentError::Spawn("Claude CLI not installed".into())),
            Some(AgentErrorKind::NotInstalled)
        );
        assert_eq!(unavailable_kind(&AgentError::Timeout), Some(AgentErrorKind::Crashed));
        assert_eq!(
            unavailable_kind(&AgentError::Crashed("exit code 1".into())),
            Some(AgentErrorKind::Crashed)
        );
    }

    #[test]
    fn routing_document_preload_respects_cap() {
        assert_eq!(document_preload("  "), (Vec::new(), false));
        let (msgs, rag) = document_preload("## a.md (md)\nhello");
        assert!(!rag);
        assert_eq!(msgs, vec!["## Context documents\n## a.md (md)\nhello"]);
        let huge = "word ".repeat(DOC_PRELOAD_TOKEN_CAP); // ~125k tokens
        assert_eq!(document_preload(&huge), (Vec::new(), true));
    }

    #[test]
    fn routing_compose_delta_orders_sections() {
        let seg = Seg {
            id: "s1".into(),
            text: "We ship Friday".into(),
            speaker: "Them".into(),
            timestamp_ms: 61_000,
        };
        let p = compose_delta(
            &[seg],
            &[("## Relevant document excerpts", "chunk 1"), ("## Empty", " ")],
            "Suggest a reply.",
            None,
            Some("When?"),
        );
        assert_eq!(
            p,
            "## New transcript since last request\n[01:01] [s1] Them: We ship Friday\n\n\
             ## Relevant document excerpts\nchunk 1\n\n\
             ## Task instructions\nSuggest a reply.\n\n\
             ## Detected question\nWhen?"
        );
        assert_eq!(compose_delta(&[], &[], "Do it.", Some("Q"), None), "## Task instructions\nDo it.\n\n## Question\nQ");
    }

    #[test]
    fn routing_segments_from_json_relative_labelled_with_ids() {
        let json = r#"[{"id":"a","text":"Hi","speaker":"User","timestamp_ms":1700000065000},
                       {"text":"  ","speaker":"Them","timestamp_ms":1700000066000},
                       {"text":"Yo","speaker":"Them","timestamp_ms":1700000070000}]"#;
        let segs = segments_from_json(json, 1_700_000_000_000);
        assert_eq!(segs.len(), 2);
        assert_eq!((segs[0].id.as_str(), segs[0].speaker.as_str(), segs[0].timestamp_ms), ("a", "You", 65_000));
        assert_eq!((segs[1].speaker.as_str(), segs[1].timestamp_ms), ("Them", 70_000));
        assert_eq!(segs[1].id, fallback_segment_id(1_700_000_070_000, "Them", "Yo"), "id-less segments get a stable id");
        assert!(segments_from_json("not json", 0).is_empty());
        assert_eq!(relative_ms(5_000, 1_700_000_000_000), 5_000, "already relative");
    }

    /// Interim text goes with one request but never into the session's record:
    /// the final words, once they arrive, are sent as a new line, not a correction.
    #[test]
    fn routing_interim_text_is_not_recorded_as_sent() {
        let json = r#"[{"id":"a","text":"Hi","speaker":"User","timestamp_ms":1000},
                       {"id":"b","text":"What about the bud","speaker":"Them (interim)","timestamp_ms":2000}]"#;
        let (finals, interim) = split_interim(segments_from_json(json, 0));
        assert_eq!(finals.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["a"]);
        assert_eq!(interim[0].speaker, "Them (interim)");
        let mut cursor = DeltaCursor::default();
        cursor.take_new(&finals);
        let final_b = Seg { text: "What about the budget?".into(), speaker: "Them".into(), ..interim[0].clone() };
        assert_eq!(cursor.take_new(&[final_b.clone()]), vec![final_b], "whole line, unmarked");
    }

    #[test]
    fn routing_system_prompts() {
        let p = live_system_prompt("", "", "Be brief.");
        assert!(p.starts_with("You are NexQ, a real-time AI meeting assistant."));
        assert!(p.contains("Additional Instructions: Be brief."));
        assert!(p.contains("## How this session works"));
        let p = live_system_prompt("Interview coach.", "Them = interviewer", "");
        assert!(p.starts_with("Interview coach.\n\nThem = interviewer\n\n## How"));
        assert!(past_system_prompt("x").ends_with("Additional Instructions: x"));
        assert!(past_system_prompt("").contains("[SEGMENT_ID]"));
        assert_eq!(
            session_key_label(&SessionKey { scope: live(), tier: Tier::Fast }),
            "live:m1:fast"
        );
    }

    #[test]
    fn routing_truncate_replay_keeps_recent_tail() {
        let sessions = MeetingSessions::default();
        let key = SessionKey { scope: live(), tier: Tier::Fast };
        sessions.insert_if_absent(
            key.clone(),
            SessionRecord {
                replay: vec!["a".repeat(50), "b".repeat(50), "c".repeat(50)],
                ..Default::default()
            },
        );
        sessions.truncate_replay(&key, 120);
        assert_eq!(sessions.get(&key).unwrap().replay, vec!["b".repeat(50), "c".repeat(50)]);
        assert!(!sessions.insert_if_absent(key.clone(), SessionRecord::default()));
    }

    // ── ask_meeting_session with a fake spawner ─────────────────────────────

    /// What a scripted turn does.
    enum Step {
        Fail(AgentError),
        /// Stream a delta, then fail.
        StreamThenFail(AgentError),
    }

    /// Scripted session: queued steps make the next asks fail.
    #[derive(Default)]
    struct Script {
        appended: Mutex<Vec<Vec<String>>>,
        prompts: Mutex<Vec<String>>,
        steps: Mutex<Vec<Step>>,
        spawns: AtomicUsize,
        /// Closes this scope's records + sessions mid-turn (meeting ended).
        close_on_ask: Mutex<Option<Arc<MeetingSessions>>>,
    }

    impl Script {
        fn fail_next(&self, err: AgentError) {
            self.steps.lock().unwrap().push(Step::Fail(err));
        }
    }

    struct FakeSession {
        script: Arc<Script>,
        index: usize,
        alive: AtomicBool,
    }

    #[async_trait]
    impl SessionHandle for FakeSession {
        async fn append_context(&self, text: &str) -> Result<(), AgentError> {
            self.script.appended.lock().unwrap()[self.index].push(text.to_string());
            Ok(())
        }
        async fn ask(
            &self,
            prompt: &str,
            on_delta: OnDelta,
            _cancel: Arc<CancelToken>,
        ) -> Result<TurnResult, AgentError> {
            self.script.prompts.lock().unwrap().push(prompt.to_string());
            if let Some(sessions) = self.script.close_on_ask.lock().unwrap().take() {
                sessions.remove_scope(&live());
                self.alive.store(false, Ordering::SeqCst);
                return Err(AgentError::Crashed("session closed".into()));
            }
            let step = {
                let mut queue = self.script.steps.lock().unwrap();
                (!queue.is_empty()).then(|| queue.remove(0))
            };
            let err = match step {
                None => {
                    on_delta("ok");
                    return Ok(TurnResult {
                        text: "ok".into(),
                        input_tokens: 7,
                        output_tokens: 1,
                        ..Default::default()
                    });
                }
                Some(Step::Fail(err)) => err,
                Some(Step::StreamThenFail(err)) => {
                    on_delta("partial ");
                    err
                }
            };
            if matches!(err, AgentError::Crashed(_)) {
                self.alive.store(false, Ordering::SeqCst);
            }
            Err(err)
        }
        fn is_alive(&self) -> bool {
            self.alive.load(Ordering::SeqCst)
        }
        async fn close(&self) {
            self.alive.store(false, Ordering::SeqCst);
        }
        fn model(&self) -> String {
            "haiku".into()
        }
    }

    struct FakeSpawner(Arc<Script>);

    #[async_trait]
    impl SessionSpawner for FakeSpawner {
        async fn spawn(&self, _cfg: SessionConfig) -> Result<Arc<dyn SessionHandle>, AgentError> {
            let index = self.0.spawns.fetch_add(1, Ordering::SeqCst);
            self.0.appended.lock().unwrap().push(Vec::new());
            Ok(Arc::new(FakeSession { script: self.0.clone(), index, alive: AtomicBool::new(true) }))
        }
    }

    fn seg(id: &str, ts: u64) -> Seg {
        Seg { id: id.into(), text: id.into(), speaker: "Them".into(), timestamp_ms: ts }
    }

    fn setup(preload: &[&str]) -> (AgentSessionManager, Arc<MeetingSessions>, Arc<Script>, SessionKey) {
        let script = Arc::new(Script::default());
        let manager = AgentSessionManager::new(
            Arc::new(FakeSpawner(script.clone())),
            Arc::new(NoopStatusSink),
            Arc::new(RwLock::new(ClaudeCliConfig::default())),
        );
        let key = SessionKey { scope: live(), tier: Tier::Fast };
        let sessions = Arc::new(MeetingSessions::default());
        sessions.insert_if_absent(
            key.clone(),
            SessionRecord {
                system_prompt: "sp".into(),
                preload: preload.iter().map(|s| s.to_string()).collect(),
                ..Default::default()
            },
        );
        (manager, sessions, script, key)
    }

    async fn ask_with(
        manager: &AgentSessionManager,
        sessions: &MeetingSessions,
        key: &SessionKey,
        finals: &[Seg],
        streamed: &Arc<Mutex<String>>,
    ) -> Result<TurnResult, AskFailure> {
        ask_meeting_session(
            manager,
            sessions,
            key,
            finals,
            |new| compose_delta(new, &[], "Help.", None, None),
            |_prompt, model, _n| assert_eq!(model, "haiku"),
            || {
                let out = streamed.clone();
                Box::new(move |t: &str| out.lock().unwrap().push_str(t))
            },
            Arc::new(CancelToken::new()),
        )
        .await
    }

    async fn ask(
        manager: &AgentSessionManager,
        sessions: &MeetingSessions,
        key: &SessionKey,
        finals: &[Seg],
    ) -> Result<TurnResult, AskFailure> {
        ask_with(manager, sessions, key, finals, &Arc::new(Mutex::new(String::new()))).await
    }

    fn last_prompt(script: &Script) -> String {
        script.prompts.lock().unwrap().last().cloned().unwrap_or_default()
    }

    #[tokio::test]
    async fn routing_session_sends_only_new_segments() {
        let (manager, sessions, script, key) = setup(&["docs"]);
        let mut finals = vec![seg("a", 0), seg("b", 1)];
        ask(&manager, &sessions, &key, &finals).await.unwrap();
        finals.push(seg("c", 2));
        ask(&manager, &sessions, &key, &finals).await.unwrap();
        ask(&manager, &sessions, &key, &finals).await.unwrap();

        let prompts = script.prompts.lock().unwrap().clone();
        assert_eq!(prompts.len(), 3);
        assert!(prompts[0].contains("[a] Them: a\n[00:00] [b] Them: b"), "{}", prompts[0]);
        assert!(prompts[1].contains("Them: c") && !prompts[1].contains("Them: a"));
        assert!(!prompts[2].contains("## New transcript"), "nothing new: {}", prompts[2]);
        assert_eq!(script.spawns.load(Ordering::SeqCst), 1);
        assert_eq!(script.appended.lock().unwrap()[0], vec!["docs"]);
        let record = sessions.get(&key).unwrap();
        assert_eq!(record.sent.len(), 3);
        assert_eq!(record.replay.len(), 3);
        assert_eq!(manager.usage(&live()).input_tokens, 21, "usage counted per turn");
    }

    #[tokio::test]
    async fn routing_late_finalized_line_goes_once_through_the_session() {
        let (manager, sessions, script, key) = setup(&[]);
        ask(&manager, &sessions, &key, &[seg("you1", 5_000), seg("you2", 7_000)]).await.unwrap();
        // The interviewer's question finalizes in place, before the sent lines.
        let finals = vec![seg("question", 4_000), seg("you1", 5_000), seg("you2", 7_000)];
        ask(&manager, &sessions, &key, &finals).await.unwrap();
        let p = last_prompt(&script);
        assert!(p.contains("Them: question"), "{p}");
        assert!(!p.contains("Them: you1") && !p.contains("Them: you2"), "nothing resent: {p}");
        // A shorter, different copy of the same meeting resends nothing.
        ask(&manager, &sessions, &key, &[seg("you1", 5_000)]).await.unwrap();
        assert!(!last_prompt(&script).contains("## New transcript"));
    }

    fn grown(id: &str, text: &str, ts: u64) -> Seg {
        Seg { text: text.into(), ..seg(id, ts) }
    }

    #[tokio::test]
    async fn routing_grown_line_sends_only_its_new_words() {
        let (manager, sessions, script, key) = setup(&[]);
        ask(&manager, &sessions, &key, &[grown("p1", "We ship", 0)]).await.unwrap();
        ask(&manager, &sessions, &key, &[grown("p1", "We ship on Friday", 0)]).await.unwrap();
        let p = last_prompt(&script);
        assert!(p.contains("[00:00] [p1] Them: …on Friday"), "{p}");
        assert!(!p.contains("We ship"), "the sent part is not repeated: {p}");
        ask(&manager, &sessions, &key, &[grown("p1", "We ship on Friday", 0)]).await.unwrap();
        assert!(!last_prompt(&script).contains("## New transcript"));
        assert_eq!(sessions.get(&key).unwrap().sent["p1"], SentLine::held("We ship on Friday"));
    }

    #[tokio::test]
    async fn routing_restart_after_growth_replays_consistently() {
        let (manager, sessions, script, key) = setup(&["docs"]);
        ask(&manager, &sessions, &key, &[grown("p1", "Hello", 0)]).await.unwrap();
        ask(&manager, &sessions, &key, &[grown("p1", "Hello there", 0)]).await.unwrap();
        let (first, second) = {
            let prompts = script.prompts.lock().unwrap();
            (prompts[0].clone(), prompts[1].clone())
        };
        // The session crashes on the next request; the restart replays both
        // deltas and the cursor resumes from the record (no resend of p1).
        script.fail_next(AgentError::Crashed("exit code 1".into()));
        ask(&manager, &sessions, &key, &[grown("p1", "Hello there friend", 0), seg("b", 1)]).await.unwrap();
        assert_eq!(script.appended.lock().unwrap()[1], vec!["docs".to_string(), pack_messages(&[first, second], PRELOAD_MESSAGE_CHARS)[0].clone()]);
        let p = last_prompt(&script);
        assert!(p.contains("[p1] Them: …friend") && p.contains("[b] Them: b"), "{p}");
        assert!(!p.contains("Hello"), "{p}");
    }

    #[tokio::test]
    async fn routing_overflow_marks_dropped_lines_not_held() {
        let (manager, sessions, script, key) = setup(&["docs"]);
        let big = |id: &str| Seg { id: id.into(), text: "x".repeat(REPLAY_TAIL_CHARS / 2 + 10), speaker: "Them".into(), timestamp_ms: 0 };
        ask(&manager, &sessions, &key, &[grown("p1", "Old words", 0), big("old")]).await.unwrap();
        ask(&manager, &sessions, &key, &[big("recent")]).await.unwrap();
        script.fail_next(AgentError::Cli(AgentErrorKind::ContextOverflow, "Prompt is too long".into()));
        ask(&manager, &sessions, &key, &[seg("new", 1)]).await.unwrap_err();
        let record = sessions.get(&key).unwrap();
        assert!(!record.sent["p1"].held && !record.sent["old"].held);
        assert!(record.sent["recent"].held);
        // p1 kept growing: it goes whole (the session lost its start); the
        // dropped unchanged line is not resent.
        let finals = [grown("p1", "Old words and more", 0), big("old"), big("recent"), seg("new", 1)];
        ask(&manager, &sessions, &key, &finals).await.unwrap();
        let p = last_prompt(&script);
        assert!(p.contains("[p1] Them: Old words and more") && p.contains("Them: new"), "{p}");
        assert!(!p.contains("xxxx"), "dropped context is not resent");
    }

    #[tokio::test]
    async fn routing_crash_restarts_once_with_replay() {
        let (manager, sessions, script, key) = setup(&["docs"]);
        ask(&manager, &sessions, &key, &[seg("a", 0)]).await.unwrap();

        let finals = vec![seg("a", 0), seg("b", 1)];
        script.fail_next(AgentError::Crashed("exit code 1".into()));
        ask(&manager, &sessions, &key, &finals).await.unwrap();

        assert_eq!(script.spawns.load(Ordering::SeqCst), 2, "restarted once");
        let prompts = script.prompts.lock().unwrap().clone();
        assert_eq!(prompts.len(), 3);
        assert_eq!(prompts[1], prompts[2], "the same delta is resent");
        assert!(prompts[2].contains("Them: b") && !prompts[2].contains("Them: a"));
        // The new session got the preload plus the first delta, not the failed one.
        let replayed = script.appended.lock().unwrap()[1].clone();
        assert_eq!(replayed, vec!["docs".to_string(), prompts[0].clone()]);
        assert_eq!(sessions.get(&key).unwrap().sent.len(), 2);
    }

    #[tokio::test]
    async fn routing_second_failure_rolls_back_cursor_and_is_an_outage() {
        let (manager, sessions, script, key) = setup(&[]);
        let finals = vec![seg("a", 0)];
        for _ in 0..2 {
            script.fail_next(AgentError::Cli(AgentErrorKind::NotLoggedIn, "Not logged in".into()));
        }
        let failure = ask(&manager, &sessions, &key, &finals).await.unwrap_err();
        assert!(matches!(failure, AskFailure::Unavailable(AgentErrorKind::NotLoggedIn, _)), "{failure:?}");
        assert_eq!(script.spawns.load(Ordering::SeqCst), 2, "one restart only");
        let record = sessions.get(&key).unwrap();
        assert!(record.sent.is_empty(), "undelivered segments are rolled back");
        assert!(record.replay.is_empty());

        // Healthy again: the next request carries the rolled-back segment.
        ask(&manager, &sessions, &key, &finals).await.unwrap();
        assert!(last_prompt(&script).contains("Them: a"));
    }

    #[tokio::test]
    async fn routing_repeated_crash_takes_fallback_route() {
        // Claude exits mid-turn (before any output), and again after the
        // restart: an outage, and with a fallback configured the fallback wins.
        let (manager, sessions, script, key) = setup(&["docs"]);
        for _ in 0..2 {
            script.fail_next(AgentError::Crashed("exit code 1".into()));
        }
        let failure = ask(&manager, &sessions, &key, &[seg("a", 0)]).await.unwrap_err();
        let AskFailure::Unavailable(kind, _) = failure else {
            panic!("expected an outage, got {failure:?}");
        };
        assert_eq!(kind, AgentErrorKind::Crashed);
        let cfg = ClaudeCliConfig { fallback_provider: Some("ollama".into()), ..Default::default() };
        let route = choose_route(&ProviderType::ClaudeCli, ClaudeHealth::Unavailable(kind), &key.scope, "Assist", &cfg);
        assert!(matches!(&route, Route::Fallback(p) if p.provider_type == "ollama"), "{route:?}");
    }

    #[tokio::test]
    async fn routing_failure_after_output_is_not_retried() {
        let (manager, sessions, script, key) = setup(&[]);
        script
            .steps
            .lock()
            .unwrap()
            .push(Step::StreamThenFail(AgentError::Crashed("exit code 1".into())));
        let streamed = Arc::new(Mutex::new(String::new()));
        let failure = ask_with(&manager, &sessions, &key, &[seg("a", 0)], &streamed).await.unwrap_err();
        assert!(matches!(failure, AskFailure::AfterOutput(AgentError::Crashed(_))), "{failure:?}");
        assert_eq!(script.spawns.load(Ordering::SeqCst), 1, "no restart once text streamed");
        assert_eq!(script.prompts.lock().unwrap().len(), 1, "nothing re-streamed");
        assert_eq!(*streamed.lock().unwrap(), "partial ");
        // The dead session comes back from its record on the next request.
        ask(&manager, &sessions, &key, &[seg("a", 0)]).await.unwrap();
        assert_eq!(script.spawns.load(Ordering::SeqCst), 2);
        assert!(last_prompt(&script).contains("Them: a"), "rolled-back segment resent");
    }

    #[tokio::test]
    async fn routing_closed_scope_mid_turn_is_benign() {
        let (manager, sessions, script, key) = setup(&[]);
        *script.close_on_ask.lock().unwrap() = Some(sessions.clone());
        let failure = ask(&manager, &sessions, &key, &[seg("a", 0)]).await.unwrap_err();
        assert_eq!(failure, AskFailure::Closed);
        assert_eq!(script.spawns.load(Ordering::SeqCst), 1, "no restart after a deliberate close");
        // A request after the scope is gone is benign too.
        assert_eq!(ask(&manager, &sessions, &key, &[]).await.unwrap_err(), AskFailure::Closed);
    }

    #[tokio::test]
    async fn routing_context_overflow_resets_to_recent_replay() {
        let (manager, sessions, script, key) = setup(&["docs"]);
        // Two old deltas, each larger than half the replay tail budget.
        let big = |id: &str| Seg { id: id.into(), text: "x".repeat(REPLAY_TAIL_CHARS / 2 + 10), speaker: "Them".into(), timestamp_ms: 0 };
        ask(&manager, &sessions, &key, &[big("old")]).await.unwrap();
        ask(&manager, &sessions, &key, &[big("old"), big("recent")]).await.unwrap();
        let recent_delta = last_prompt(&script);

        script.fail_next(AgentError::Cli(AgentErrorKind::ContextOverflow, "Prompt is too long".into()));
        let finals = vec![big("old"), big("recent"), seg("new", 1)];
        let failure = ask(&manager, &sessions, &key, &finals).await.unwrap_err();
        assert!(matches!(failure, AskFailure::ContextFull(_)), "{failure:?}");
        assert_eq!(sessions.get(&key).unwrap().replay, vec![recent_delta.clone()], "only the recent tail is kept");

        // The next request starts a fresh session from preload + tail and
        // carries the segment the full session never took.
        ask(&manager, &sessions, &key, &finals).await.unwrap();
        assert_eq!(script.spawns.load(Ordering::SeqCst), 2);
        assert_eq!(script.appended.lock().unwrap()[1], vec!["docs".to_string(), recent_delta]);
        assert!(last_prompt(&script).contains("Them: new"));
    }

    #[tokio::test]
    async fn routing_overflow_after_output_is_not_re_answered() {
        let (manager, sessions, script, key) = setup(&[]);
        script.steps.lock().unwrap().push(Step::StreamThenFail(AgentError::Cli(
            AgentErrorKind::ContextOverflow,
            "Prompt is too long".into(),
        )));
        let failure = ask(&manager, &sessions, &key, &[seg("a", 0)]).await.unwrap_err();
        assert!(matches!(failure, AskFailure::AfterOutput(_)), "{failure:?}");
    }

    #[tokio::test]
    async fn routing_preload_only_overflow_goes_stateless_without_spawning() {
        let (manager, sessions, script, key) = setup(&["a huge preload"]);
        script.fail_next(AgentError::Cli(AgentErrorKind::ContextOverflow, "Prompt is too long".into()));
        let failure = ask(&manager, &sessions, &key, &[seg("a", 0)]).await.unwrap_err();
        assert!(matches!(failure, AskFailure::ContextFull(_)), "{failure:?}");
        assert!(sessions.get(&key).unwrap().stateless_only, "nothing to truncate: stateless only");
        // Later requests skip the session entirely.
        let failure = ask(&manager, &sessions, &key, &[seg("a", 0)]).await.unwrap_err();
        assert!(matches!(failure, AskFailure::ContextFull(_)));
        assert_eq!(script.spawns.load(Ordering::SeqCst), 1, "no respawn per request");
        assert_eq!(script.prompts.lock().unwrap().len(), 1);
    }

    #[test]
    fn routing_epoch_discards_background_work_after_close() {
        let sessions = MeetingSessions::default();
        let key = SessionKey { scope: live(), tier: Tier::Fast };
        let epoch = sessions.epoch(&key.scope);
        sessions.remove_scope(&key.scope); // meeting ended while the record was built
        assert!(!sessions.insert_if_current(key.clone(), SessionRecord::default(), epoch));
        assert!(!sessions.contains(&key));
        let fresh = sessions.epoch(&key.scope);
        assert!(sessions.insert_if_current(key.clone(), SessionRecord::default(), fresh));
        assert!(sessions.contains(&key));
    }

    #[test]
    fn routing_request_never_recreates_a_closed_scope() {
        let sessions = MeetingSessions::default();
        let key = SessionKey { scope: live(), tier: Tier::Deep };
        // The request chose its scope, then the meeting ended.
        let epoch = sessions.epoch(&key.scope);
        sessions.remove_scope(&key.scope);
        let built = std::cell::Cell::new(false);
        let ready = sessions.ensure_current(&key, epoch, || {
            built.set(true);
            Ok(SessionRecord::default())
        });
        assert_eq!(ready, Ok(false), "closed: the request ends without a session");
        assert!(!built.get(), "no record is built for a closed scope");
        assert!(!sessions.contains(&key));
    }

    #[test]
    fn routing_request_closed_while_its_record_is_built_is_discarded() {
        let sessions = MeetingSessions::default();
        let key = SessionKey { scope: live(), tier: Tier::Fast };
        let epoch = sessions.epoch(&key.scope);
        let ready = sessions.ensure_current(&key, epoch, || {
            sessions.remove_scope(&key.scope); // end_meeting lands mid-build
            Ok(SessionRecord::default())
        });
        assert_eq!(ready, Ok(false));
        assert!(!sessions.contains(&key));
    }

    #[test]
    fn routing_request_builds_a_missing_record_once() {
        let sessions = MeetingSessions::default();
        let key = SessionKey { scope: live(), tier: Tier::Fast };
        let epoch = sessions.epoch(&key.scope);
        assert_eq!(sessions.ensure_current(&key, epoch, || Ok(SessionRecord::default())), Ok(true));
        assert!(sessions.contains(&key));
        let again = sessions.ensure_current(&key, epoch, || Err("must not rebuild".into()));
        assert_eq!(again, Ok(true));
        assert_eq!(
            sessions.ensure_current(&SessionKey { scope: live(), tier: Tier::Deep }, epoch, || Err("no".into())),
            Err("no".to_string()),
            "a build error is reported"
        );
    }

    #[test]
    fn routing_fallback_segment_id_is_short_and_stable() {
        let a = fallback_segment_id(1, "Them", "hello");
        assert_eq!(a, fallback_segment_id(1, "Them", "hello"));
        assert_ne!(a, fallback_segment_id(2, "Them", "hello"));
        assert!(a.starts_with("seg-") && a.len() == 20, "{a}");
    }

    #[tokio::test]
    async fn routing_delivered_error_result_keeps_segments_sent() {
        let (manager, sessions, script, key) = setup(&[]);
        script.fail_next(AgentError::Cli(AgentErrorKind::Other, "request refused".into()));
        let failure = ask(&manager, &sessions, &key, &[seg("a", 0)]).await.unwrap_err();
        assert!(matches!(failure, AskFailure::Error(AgentError::Cli(AgentErrorKind::Other, _))));
        assert_eq!(script.spawns.load(Ordering::SeqCst), 1, "not retried");
        // The prompt is in Claude's history: its segments are not resent.
        assert!(sessions.get(&key).unwrap().sent.contains_key("a"));
        ask(&manager, &sessions, &key, &[seg("a", 0)]).await.unwrap();
        assert!(!last_prompt(&script).contains("## New transcript"));
    }

    #[tokio::test]
    async fn routing_cancel_before_send_sends_nothing_and_keeps_segments_unsent() {
        let (manager, sessions, script, key) = setup(&[]);
        let cancel = Arc::new(CancelToken::new());
        cancel.cancel();
        let failure = ask_meeting_session(
            &manager,
            &sessions,
            &key,
            &[seg("a", 0)],
            |_| String::from("p"),
            |_, _, _| panic!("nothing is sent once cancelled"),
            || Box::new(|_: &str| {}),
            cancel,
        )
        .await
        .unwrap_err();
        assert_eq!(failure, AskFailure::Cancelled);
        assert!(script.prompts.lock().unwrap().is_empty());
        assert!(sessions.get(&key).unwrap().sent.is_empty());
    }

    #[tokio::test]
    async fn routing_cancel_while_queued_keeps_segments_unsent() {
        // Stopped while waiting for the turn lock: the prompt never reached Claude.
        let (manager, sessions, script, key) = setup(&[]);
        script.fail_next(AgentError::CancelledBeforeSend);
        let failure = ask(&manager, &sessions, &key, &[seg("a", 0)]).await.unwrap_err();
        assert_eq!(failure, AskFailure::Cancelled);
        assert!(sessions.get(&key).unwrap().sent.is_empty(), "segments stay unsent");
        // Stopped mid-turn: the prompt is in history.
        script.fail_next(AgentError::Cancelled);
        ask(&manager, &sessions, &key, &[seg("a", 0)]).await.unwrap_err();
        assert!(sessions.get(&key).unwrap().sent.contains_key("a"));
    }

    #[tokio::test]
    async fn meeting_chat_reply_is_replayed_after_restart() {
        // A chat question and its answer both reach a restarted session, so
        // a follow-up still knows what was answered.
        let (manager, sessions, script, key) = setup(&["transcript"]);
        let turn = ask(&manager, &sessions, &key, &[]).await.unwrap();
        let question = last_prompt(&script);
        sessions.record_reply(&key, &question, &turn.text);
        sessions.record_reply(&key, "a prompt never sent", "ignored");
        assert_eq!(sessions.get(&key).unwrap().replay, vec![answered_turn(&question, "ok")]);

        script.fail_next(AgentError::Crashed("exit code 1".into()));
        ask(&manager, &sessions, &key, &[]).await.unwrap();
        let replayed = script.appended.lock().unwrap()[1].clone();
        assert_eq!(replayed, vec!["transcript".to_string(), answered_turn(&question, "ok")]);
        assert!(replayed[1].ends_with("## Your answer\nok"), "{}", replayed[1]);
    }

    #[test]
    fn meeting_chat_earlier_exchange_format() {
        assert_eq!(
            earlier_exchange(" When? ", "Friday.\n"),
            "## Earlier question about this meeting\nWhen?\n\n## Your answer\nFriday."
        );
    }

    #[tokio::test]
    async fn routing_restarted_elsewhere_resyncs_cursor_from_record() {
        // A session the reaper closed (or that died between requests) comes
        // back with preload + replay; the cursor follows the record.
        let (manager, sessions, script, key) = setup(&["docs"]);
        ask(&manager, &sessions, &key, &[seg("a", 0)]).await.unwrap();
        manager.close_scope(&live()).await;
        ask(&manager, &sessions, &key, &[seg("a", 0), seg("b", 1)]).await.unwrap();
        assert_eq!(script.spawns.load(Ordering::SeqCst), 2);
        let last = last_prompt(&script);
        assert!(last.contains("Them: b") && !last.contains("Them: a"), "{last}");
        assert_eq!(script.appended.lock().unwrap()[1].len(), 2);
    }
}
