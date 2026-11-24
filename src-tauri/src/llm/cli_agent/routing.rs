//! Request routing for the CLI agent providers (Claude, Antigravity, Codex:
//! whichever is the active provider; the names `ClaudeHealth` and
//! `Route::ClaudeSession` date from when it was only Claude).
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

use super::command::SourcesLaunch;
use super::context::{
    build_delta_prompt, build_document_preload, pack_messages, transcript_lines, DeltaCursor, Seg,
    SentLine,
};
use super::status::probe_kind;
use super::CliAgentKind;
use super::manager::{
    tier_for, AgentSessionManager, ClaudeCliConfig, OnDelta, SessionInit, SessionKey,
    SessionScope, Tier,
};
use super::protocol::{AgentErrorKind, ImageAttachment, TurnResult};
use super::session::AgentError;
use crate::context::token_counter::count_tokens;
use crate::llm::provider::{CancelToken, LLMProvider};
use crate::llm::{ProviderConfig, ProviderType};
use crate::sources::config::SourceToggles;
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

/// Pick the route of one request. Only a CLI agent provider has sessions,
/// and only meeting scopes (live or past) use them; Utility requests go
/// through the provider's own `stream_completion`, never with sources. With
/// `with_sources` a meeting request goes to the with-sources session of its
/// tier. When Claude is unavailable the request goes to the fallback
/// provider, or, with none configured, down the stateless path, where the
/// Claude provider reports the reason.
pub fn choose_route(
    active: &ProviderType,
    claude_health: ClaudeHealth,
    scope: &SessionScope,
    mode: &str,
    cfg: &ClaudeCliConfig,
    with_sources: bool,
) -> Route {
    if !active.is_cli_agent() {
        return Route::Stateless;
    }
    match claude_health {
        ClaudeHealth::Unavailable(_) => match &cfg.fallback_provider {
            Some(provider) => Route::Fallback(fallback_config(provider)),
            None => Route::Stateless,
        },
        ClaudeHealth::Healthy => match scope {
            SessionScope::Utility => Route::Stateless,
            SessionScope::Live(_) | SessionScope::Past(_) => {
                let tier = tier_for(mode, scope, cfg);
                Route::ClaudeSession(if with_sources {
                    SessionKey::sources(scope.clone(), tier)
                } else {
                    SessionKey::plain(scope.clone(), tier)
                })
            }
        },
    }
}

/// How long answers skip a with-sources session that just failed to start.
pub const SOURCES_COOLDOWN: Duration = Duration::from_secs(120);

#[derive(Debug, Clone)]
struct SourcesFailure {
    at: Instant,
    reason: String,
    generation: u64,
}

/// With-sources sessions that just failed to start, one failure per session
/// key (a Past or Deep failure does not push Live Fast answers to the plain
/// session). For [`SOURCES_COOLDOWN`] after a failure, requests that ask for
/// sources on that key go straight to the plain session (no waiting on a
/// server that hangs); then one background retry runs. A key's failure is
/// cleared when its start works; all of them when the sources or their secrets
/// change or the user retries.
pub struct SourcesCooldown {
    cooldown: Duration,
    failures: Mutex<HashMap<SessionKey, SourcesFailure>>,
    generation: std::sync::atomic::AtomicU64,
}

impl Default for SourcesCooldown {
    fn default() -> Self {
        Self::with_duration(SOURCES_COOLDOWN)
    }
}

impl SourcesCooldown {
    pub fn with_duration(cooldown: Duration) -> Self {
        Self { cooldown, failures: Mutex::new(HashMap::new()), generation: Default::default() }
    }

    pub fn duration(&self) -> Duration {
        self.cooldown
    }

    /// A with-sources start of `key` failed. Returns this failure's generation,
    /// for the retry timer ([`begin_retry`](Self::begin_retry)).
    pub fn fail(&self, key: &SessionKey, reason: &str, now: Instant) -> u64 {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.failures
            .lock()
            .unwrap()
            .insert(key.clone(), SourcesFailure { at: now, reason: reason.to_string(), generation });
        generation
    }

    /// Sources changed or the user asked to retry: forget every failure (and
    /// make their pending retry timers stale).
    pub fn clear(&self) {
        self.failures.lock().unwrap().clear();
    }

    /// `key` started fine: forget its failure (and its pending retry timer).
    pub fn clear_key(&self, key: &SessionKey) {
        self.failures.lock().unwrap().remove(key);
    }

    /// `None`: try the with-sources session `key`. `Some(text)`: don't, answer
    /// on the plain session and show this notice (the failure's reason, and
    /// when the next try is).
    pub fn gate(&self, key: &SessionKey, now: Instant) -> Option<String> {
        let failure = self.failures.lock().unwrap().get(key).cloned()?;
        let wait = (failure.at + self.cooldown).saturating_duration_since(now);
        let when = if wait.is_zero() {
            "Trying again now.".to_string()
        } else if wait < Duration::from_secs(60) {
            "Trying again in under a minute.".to_string()
        } else {
            format!("Trying again in {} min.", wait.as_secs().div_ceil(60))
        };
        Some(format!(
            "Your sources couldn't be loaded, so this answer didn't use them. {}. {when}",
            failure.reason.trim_end_matches('.')
        ))
    }

    /// The routing decision of a request for `key`, as `run_session_assist`
    /// takes it: `None` to go on with `key`, or `Some((plain key, notice))` when
    /// `key` is a with-sources session still cooling down after a failure, so
    /// the plain session answers and the notice says why.
    pub fn plain_instead(&self, key: &SessionKey, now: Instant) -> Option<(SessionKey, String)> {
        if !key.with_sources {
            return None;
        }
        self.gate(key, now).map(|text| (key.sibling(), text))
    }

    /// The cooldown of failure `generation` of `key` ended: true if it is still
    /// that key's current failure (not cleared or replaced since), meaning the
    /// caller runs the background retry.
    pub fn begin_retry(&self, key: &SessionKey, generation: u64) -> bool {
        self.failures.lock().unwrap().get(key).is_some_and(|f| f.generation == generation)
    }

    pub fn is_failed(&self, key: &SessionKey) -> bool {
        self.failures.lock().unwrap().contains_key(key)
    }
}

/// Modes that run by themselves, never because the user asked: they never use
/// sources, whatever the pills say.
pub const BACKGROUND_MODES: [&str; 3] = ["MeetingSummary", "ActionItemsExtraction", "BookmarkSuggestions"];

/// First line of the per-request sources note.
pub const SOURCES_NOTE_HEADER: &str = "## Sources for this answer";

/// Whether one request may use sources. `toggles` is what the user's pills
/// said when they asked, or `None` for an automatic answer (a detected
/// question's Auto-Answer sends none). In order:
/// 1. a background mode: never;
/// 2. no toggles (automatic): never;
/// 3. Shorten and FollowUp: whatever produced the answer they work on used;
/// 4. any other request: when a pill is on.
pub fn wants_sources(mode: &str, toggles: Option<SourceToggles>, last_answer_with_sources: bool) -> bool {
    if BACKGROUND_MODES.contains(&mode) {
        return false;
    }
    let Some(toggles) = toggles else {
        return false;
    };
    match mode {
        "Shorten" | "FollowUp" => last_answer_with_sources,
        _ => toggles.notes || toggles.tools,
    }
}

/// The per-request note saying which sources this answer may use. It is an
/// instruction, not a lock (the user enabled both kinds in settings).
pub fn sources_note(t: SourceToggles) -> String {
    let word = |on: bool| if on { "on" } else { "off" };
    format!(
        "{SOURCES_NOTE_HEADER}\nNotes: {}. Tools: {}. Use only the sources marked on.",
        word(t.notes),
        word(t.tools)
    )
}

/// [`sources_note`] without its header line, for `compose_delta`'s extra
/// sections (which add the header themselves).
pub fn sources_note_body(t: SourceToggles) -> String {
    sources_note(t)
        .strip_prefix(SOURCES_NOTE_HEADER)
        .unwrap_or_default()
        .trim()
        .to_string()
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
        thinking: Default::default(),
        extra_request_json: None,
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
    /// What a with-sources session launches with (also on a restart); `None`
    /// for a plain session.
    pub sources: Option<SourcesLaunch>,
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
            sources: self.sources.clone(),
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
    /// Whether the latest answer of each scope came from a with-sources
    /// session: Shorten and FollowUp follow it.
    last_answer_sources: Mutex<HashMap<SessionScope, bool>>,
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
        self.last_answer_sources.lock().unwrap().remove(scope);
    }

    /// Forget the with-sources records of `scope` (the sources changed in
    /// settings): the next request builds them again from the new settings.
    /// Plain records and the scope's epoch stay.
    pub fn clear_sources(&self, scope: &SessionScope) {
        self.records
            .lock()
            .unwrap()
            .retain(|key, _| !(key.scope == *scope && key.with_sources));
    }

    /// Every scope that has a with-sources record.
    pub fn scopes_with_sources(&self) -> Vec<SessionScope> {
        let mut scopes: Vec<SessionScope> = self
            .records
            .lock()
            .unwrap()
            .keys()
            .filter(|key| key.with_sources)
            .map(|key| key.scope.clone())
            .collect();
        scopes.sort();
        scopes.dedup();
        scopes
    }

    /// Note whether the latest answer of `scope` used sources.
    pub fn set_last_answer(&self, scope: &SessionScope, with_sources: bool) {
        self.last_answer_sources.lock().unwrap().insert(scope.clone(), with_sources);
    }

    /// [`set_last_answer`](Self::set_last_answer) for the answer of `mode`. A
    /// background run (summary, action items, bookmarks) is not an answer
    /// Shorten or FollowUp could work on, so it leaves the note as it was.
    pub fn note_answer(&self, mode: &str, scope: &SessionScope, with_sources: bool) {
        if !BACKGROUND_MODES.contains(&mode) {
            self.set_last_answer(scope, with_sources);
        }
    }

    /// Whether the latest answer of `scope` came from a with-sources session.
    pub fn last_answer_with_sources(&self, scope: &SessionScope) -> bool {
        self.last_answer_sources.lock().unwrap().get(scope).copied().unwrap_or(false)
    }

    /// Put `message` (an answer the sibling session gave) on `key`'s replay,
    /// so a restart of that session still knows it. False when `key` has no
    /// record.
    pub fn record_shared(&self, key: &SessionKey, message: &str) -> bool {
        match self.records.lock().unwrap().get_mut(key) {
            Some(record) => {
                record.replay.push(message.to_string());
                true
            }
            None => false,
        }
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
        AgentErrorKind::Outdated => "too old",
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

/// What the user sees when Claude answers a request with images by an error
/// result: a hint about the image when the error mentions one, else Claude's text.
fn image_refusal(raw: &str) -> String {
    if raw.to_lowercase().contains("image") {
        "Claude couldn't use the attached image. Remove it or paste a smaller one, then send again.".to_string()
    } else {
        raw.to_string()
    }
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
    images: &[ImageAttachment],
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
            let result = manager
                .ask_with_images(key, &text, images, on_delta, cancel.clone())
                .await;
            // An image Claude refused (too big, unreadable) is not in a usable
            // history: roll the request back like an undelivered one.
            let refused = !images.is_empty()
                && !streamed.load(Ordering::SeqCst)
                && matches!(&result, Err(AgentError::Cli(AgentErrorKind::Other, _)));
            if delivered(&result) && !refused {
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
        if let (false, AgentError::Cli(AgentErrorKind::Other, raw)) = (images.is_empty(), &err) {
            log::warn!("Claude refused a request with images: {raw}");
            retire(manager, key);
            return Err(AskFailure::Error(AgentError::Cli(AgentErrorKind::Other, image_refusal(raw))));
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

/// An answer one Fast session gave, as the other one is told it: both keep
/// the same conversation, so either can take a follow-up.
pub fn shared_answer(action_label: &str, question: Option<&str>, answer: &str) -> String {
    let mut out = format!("## Answer given earlier in this meeting ({action_label})");
    if let Some(q) = question.map(str::trim).filter(|q| !q.is_empty()) {
        out.push_str(&format!("\nQuestion: {q}"));
    }
    out.push_str(&format!("\n\n{ANSWER_HEADER}\n{}", answer.trim()));
    out
}

/// Tell the session `target` about an answer its sibling gave: appended to
/// its context when it is running (it is never started for this), and kept on
/// its record's replay so a (re)start knows it too. Failures are only logged:
/// the answer is out already.
pub async fn share_answer(
    manager: &AgentSessionManager,
    sessions: &MeetingSessions,
    target: &SessionKey,
    message: String,
) {
    if let Err(e) = manager.append_if_running(target, &message).await {
        log::warn!("could not share an answer with {}: {e}", session_key_label(target));
    }
    sessions.record_shared(target, &message);
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
    let sources = if key.with_sources { ":sources" } else { "" };
    match &key.scope {
        SessionScope::Live(id) => format!("live:{id}:{tier}{sources}"),
        SessionScope::Past(id) => format!("past:{id}:{tier}{sources}"),
        SessionScope::Utility => format!("utility:{tier}{sources}"),
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

/// While a CLI agent is the active provider and unavailable, re-probe it every
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
        if !state.claude_health.probe_due(Instant::now()) {
            continue;
        }
        let Some(kind) = active_cli_kind(&state) else { continue };
        if probe_kind(kind).await.is_ok() && state.claude_health.mark_healthy() {
            log::info!("{} CLI looks available again; requests try it again", kind.short_name());
        }
    }
}

/// The CLI agent the active LLM provider drives, if it is one.
pub fn active_cli_kind(state: &crate::state::AppState) -> Option<CliAgentKind> {
    state
        .llm
        .as_ref()
        .and_then(|llm| llm.lock().ok())
        .and_then(|router| router.active_provider_type().and_then(ProviderType::cli_agent_kind))
}

/// True when the active LLM provider is a CLI agent (Claude, Antigravity or Codex).
pub fn cli_agent_is_active(state: &crate::state::AppState) -> bool {
    active_cli_kind(state).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::cli_agent::command::SessionConfig;
    use crate::llm::cli_agent::manager::{NoopStatusSink, SessionHandle, SessionSpawner};
    use async_trait::async_trait;
    use std::sync::atomic::AtomicUsize;
    use crate::llm::cli_agent::settings::CliSettings;

    fn live() -> SessionScope {
        SessionScope::Live("m1".into())
    }

    #[test]
    fn every_cli_agent_gets_sessions_and_other_providers_do_not() {
        let cfg = ClaudeCliConfig::default();
        for active in [ProviderType::ClaudeCli, ProviderType::AntigravityCli, ProviderType::CodexCli] {
            match choose_route(&active, ClaudeHealth::Healthy, &live(), "Assist", &cfg, false) {
                Route::ClaudeSession(key) => assert_eq!(key.scope, live()),
                other => panic!("{active:?}: {other:?}"),
            }
            // With sources: the with-sources session.
            match choose_route(&active, ClaudeHealth::Healthy, &live(), "Assist", &cfg, true) {
                Route::ClaudeSession(key) => assert!(key.with_sources),
                other => panic!("{active:?}: {other:?}"),
            }
            // Unavailable with a fallback: the fallback, whatever the CLI.
            let with_fallback = ClaudeCliConfig { fallback_provider: Some("ollama".into()), ..Default::default() };
            let down = ClaudeHealth::Unavailable(AgentErrorKind::NotLoggedIn);
            match choose_route(&active, down, &live(), "Assist", &with_fallback, false) {
                Route::Fallback(c) => assert_eq!(c.provider_type, "ollama"),
                other => panic!("{active:?}: {other:?}"),
            }
            assert!(matches!(choose_route(&active, down, &live(), "Assist", &cfg, false), Route::Stateless));
            assert!(matches!(
                choose_route(&active, ClaudeHealth::Healthy, &SessionScope::Utility, "Assist", &cfg, false),
                Route::Stateless
            ));
        }
        for other in [ProviderType::Ollama, ProviderType::Openai, ProviderType::Custom] {
            assert!(matches!(
                choose_route(&other, ClaudeHealth::Healthy, &live(), "Assist", &cfg, false),
                Route::Stateless
            ));
        }
    }

    #[test]
    fn route_claude_healthy_live_assist() {
        let route = choose_route(
            &ProviderType::ClaudeCli,
            ClaudeHealth::Healthy,
            &live(),
            "Assist",
            &ClaudeCliConfig::default(),
            false,
        );
        match route {
            Route::ClaudeSession(key) => {
                assert_eq!(key, SessionKey::plain(live(), Tier::Fast))
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
            false,
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
            false,
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
            false,
        );
        assert!(matches!(route, Route::Stateless), "{route:?}");
    }

    #[test]
    fn routing_recap_deep_past_deep_utility_stateless() {
        let cfg = ClaudeCliConfig::default();
        let key = |scope: &SessionScope, mode: &str| {
            match choose_route(&ProviderType::ClaudeCli, ClaudeHealth::Healthy, scope, mode, &cfg, false) {
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
        // Too old clears the way NotInstalled does: probed every tick until updated.
        health.mark_unavailable_at(AgentErrorKind::Outdated, t0);
        assert!(health.probe_due(t0), "too old: probe every tick");
        assert!(health.mark_healthy(), "an updated Claude passes the probe and clears it");
        assert_eq!(health.get(), ClaudeHealth::Healthy);
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
        // Too old: a real outage, never restarted (it would fail the same way).
        let too_old = AgentError::Spawn("Claude Code 2.1.206 is too old for NexQ. Update it to 2.1.259 or newer.".into());
        assert!(!is_restartable(&too_old));
        assert_eq!(unavailable_kind(&too_old), Some(AgentErrorKind::Outdated));
        assert_eq!(
            unavailable_kind(&AgentError::Cli(AgentErrorKind::Outdated, "x".into())),
            Some(AgentErrorKind::Outdated)
        );
        assert_eq!(reason_label(AgentErrorKind::Outdated), "too old");
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
            session_key_label(&SessionKey::plain(live(), Tier::Fast)),
            "live:m1:fast"
        );
    }

    #[test]
    fn routing_truncate_replay_keeps_recent_tail() {
        let sessions = MeetingSessions::default();
        let key = SessionKey::plain(live(), Tier::Fast);
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
        /// How many images came with each ask.
        image_counts: Mutex<Vec<usize>>,
        steps: Mutex<Vec<Step>>,
        spawns: AtomicUsize,
        /// Starting a session with sources fails while set.
        fail_sources: AtomicBool,
        /// Starts tried for sessions with sources.
        sources_spawns: AtomicUsize,
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
        async fn ask_with_images(
            &self,
            prompt: &str,
            images: &[ImageAttachment],
            on_delta: OnDelta,
            cancel: Arc<CancelToken>,
        ) -> Result<TurnResult, AgentError> {
            self.script.image_counts.lock().unwrap().push(images.len());
            self.ask(prompt, on_delta, cancel).await
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
        async fn spawn(&self, cfg: SessionConfig) -> Result<Arc<dyn SessionHandle>, AgentError> {
            if cfg.sources.is_some() {
                self.0.sources_spawns.fetch_add(1, Ordering::SeqCst);
                if self.0.fail_sources.load(Ordering::SeqCst) {
                    return Err(AgentError::Spawn("MCP server mira failed to start".into()));
                }
            }
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
            Arc::new(CliSettings::isolated()),
        );
        let key = SessionKey::plain(live(), Tier::Fast);
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
            &[],
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
    async fn routing_session_sends_the_images_with_the_question() {
        let (manager, sessions, script, key) = setup(&[]);
        let images = [ImageAttachment { media_type: "image/png".into(), data: "AAAA".into() }];
        ask_meeting_session(
            &manager,
            &sessions,
            &key,
            &[seg("a", 0)],
            |new| compose_delta(new, &[], "Help.", Some("What is this?"), None),
            |_, _, _| {},
            || Box::new(|_: &str| {}),
            Arc::new(CancelToken::new()),
            &images,
        )
        .await
        .unwrap();
        ask(&manager, &sessions, &key, &[seg("a", 0), seg("b", 1)]).await.unwrap();
        assert_eq!(*script.image_counts.lock().unwrap(), vec![1, 0], "only the question that had images");
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
        let route = choose_route(&ProviderType::ClaudeCli, ClaudeHealth::Unavailable(kind), &key.scope, "Assist", &cfg, false);
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
        let key = SessionKey::plain(live(), Tier::Fast);
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
        let key = SessionKey::plain(live(), Tier::Deep);
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
        let key = SessionKey::plain(live(), Tier::Fast);
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
        let key = SessionKey::plain(live(), Tier::Fast);
        let epoch = sessions.epoch(&key.scope);
        assert_eq!(sessions.ensure_current(&key, epoch, || Ok(SessionRecord::default())), Ok(true));
        assert!(sessions.contains(&key));
        let again = sessions.ensure_current(&key, epoch, || Err("must not rebuild".into()));
        assert_eq!(again, Ok(true));
        assert_eq!(
            sessions.ensure_current(&SessionKey::plain(live(), Tier::Deep), epoch, || Err("no".into())),
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
    async fn routing_refused_image_rolls_the_request_back_and_restarts_the_session() {
        let (manager, sessions, script, key) = setup(&[]);
        script.fail_next(AgentError::Cli(
            AgentErrorKind::Other,
            "API Error: 400 messages.0.content.0.image.source.base64: image exceeds 5 MB maximum".into(),
        ));
        let images = [ImageAttachment { media_type: "image/png".into(), data: "AAAA".into() }];
        let failure = ask_meeting_session(
            &manager,
            &sessions,
            &key,
            &[seg("a", 0)],
            |new| compose_delta(new, &[], "Help.", Some("What is this?"), None),
            |_, _, _| {},
            || Box::new(|_: &str| {}),
            Arc::new(CancelToken::new()),
            &images,
        )
        .await
        .unwrap_err();
        match failure {
            AskFailure::Error(AgentError::Cli(AgentErrorKind::Other, msg)) => {
                assert_eq!(
                    msg,
                    "Claude couldn't use the attached image. Remove it or paste a smaller one, then send again."
                );
            }
            _ => panic!("expected the image refusal"),
        }
        assert!(!sessions.get(&key).unwrap().sent.contains_key("a"), "nothing recorded");
        // The next text-only request starts a fresh session and carries the segments.
        ask(&manager, &sessions, &key, &[seg("a", 0)]).await.unwrap();
        assert_eq!(script.spawns.load(Ordering::SeqCst), 2, "the session was restarted");
        assert!(last_prompt(&script).contains("## New transcript"), "segments were rolled back");
        assert_eq!(*script.image_counts.lock().unwrap(), vec![1, 0]);
    }

    #[test]
    fn routing_image_refusal_keeps_claudes_text_when_it_is_not_about_an_image() {
        assert_eq!(image_refusal("request refused"), "request refused");
        assert!(image_refusal("Could not process Image").contains("attached image"));
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
            &[],
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

    // ── sources: routing, note, shared history ──────────────────────────────

    #[test]
    fn wants_sources_table() {
        let on = Some(SourceToggles { notes: true, tools: false });
        let off = Some(SourceToggles::default());
        assert!(wants_sources("Assist", on, false));
        assert!(wants_sources("AskQuestion", on, false));
        assert!(wants_sources("MeetingAsk", on, false));
        assert!(!wants_sources("Assist", None, false)); // Auto-Answer
        assert!(!wants_sources("Assist", off, true));
        for m in BACKGROUND_MODES {
            assert!(!wants_sources(m, on, true), "{m}");
        }
        assert!(wants_sources("Shorten", off, true)); // follows the producing session
        assert!(!wants_sources("FollowUp", on, false));
        assert!(!wants_sources("Shorten", None, true));
    }

    #[test]
    fn route_with_sources_only_for_meeting_scopes_on_claude() {
        let cfg = ClaudeCliConfig::default();
        let route = |provider: &ProviderType, health, scope: &SessionScope| {
            choose_route(provider, health, scope, "Assist", &cfg, true)
        };
        match route(&ProviderType::ClaudeCli, ClaudeHealth::Healthy, &live()) {
            Route::ClaudeSession(key) => assert_eq!(key, SessionKey::sources(live(), Tier::Fast)),
            other => panic!("{other:?}"),
        }
        let past = SessionScope::Past("p".into());
        match route(&ProviderType::ClaudeCli, ClaudeHealth::Healthy, &past) {
            Route::ClaudeSession(key) => assert_eq!(key, SessionKey::sources(past, Tier::Deep)),
            other => panic!("{other:?}"),
        }
        let r = route(&ProviderType::ClaudeCli, ClaudeHealth::Healthy, &SessionScope::Utility);
        assert!(matches!(r, Route::Stateless), "{r:?}");
        let r = route(&ProviderType::Ollama, ClaudeHealth::Healthy, &live());
        assert!(matches!(r, Route::Stateless), "{r:?}");
        let with_fallback = ClaudeCliConfig { fallback_provider: Some("ollama".into()), ..Default::default() };
        let r = choose_route(
            &ProviderType::ClaudeCli,
            ClaudeHealth::Unavailable(AgentErrorKind::NotLoggedIn),
            &live(),
            "Assist",
            &with_fallback,
            true,
        );
        assert!(matches!(r, Route::Fallback(_)), "{r:?}");
    }

    #[test]
    fn sources_note_exact() {
        assert_eq!(
            sources_note(SourceToggles { notes: true, tools: false }),
            "## Sources for this answer\nNotes: on. Tools: off. Use only the sources marked on."
        );
        assert!(sources_note(SourceToggles::default()).contains("Notes: off. Tools: off."));
        assert!(sources_note(SourceToggles { notes: false, tools: true }).starts_with(SOURCES_NOTE_HEADER));
    }

    #[test]
    fn last_answer_is_per_scope_and_cleared_on_close() {
        let sessions = MeetingSessions::default();
        let other = SessionScope::Live("m2".into());
        assert!(!sessions.last_answer_with_sources(&live()));
        sessions.set_last_answer(&live(), true);
        assert!(sessions.last_answer_with_sources(&live()));
        assert!(!sessions.last_answer_with_sources(&other));
        sessions.set_last_answer(&live(), false);
        assert!(!sessions.last_answer_with_sources(&live()));
        sessions.set_last_answer(&live(), true);
        sessions.remove_scope(&live());
        assert!(!sessions.last_answer_with_sources(&live()));
    }

    #[test]
    fn a_background_run_does_not_change_which_session_shorten_follows() {
        let sessions = MeetingSessions::default();
        // The user's Assist answered with sources.
        sessions.note_answer("Assist", &live(), true);
        assert!(sessions.last_answer_with_sources(&live()));
        // Summary, action items and bookmarks run on the plain session by themselves.
        for mode in BACKGROUND_MODES {
            sessions.note_answer(mode, &live(), false);
            assert!(sessions.last_answer_with_sources(&live()), "{mode}");
            assert!(wants_sources("Shorten", Some(SourceToggles::default()), sessions.last_answer_with_sources(&live())));
            assert!(wants_sources("FollowUp", Some(SourceToggles::default()), sessions.last_answer_with_sources(&live())));
        }
        // A plain answer the user asked for does count.
        sessions.note_answer("Assist", &live(), false);
        assert!(!sessions.last_answer_with_sources(&live()));
    }

    // ── the cooldown after a failed sources start ───────────────────────────

    #[test]
    fn cooldown_gate_counts_down_then_says_trying_again() {
        let cd = SourcesCooldown::with_duration(Duration::from_secs(120));
        let key = SessionKey::sources(live(), Tier::Fast);
        let t0 = Instant::now();
        assert_eq!(cd.gate(&key, t0), None);
        cd.fail(&key, "Mira didn't start", t0);
        let text = cd.gate(&key, t0 + Duration::from_secs(20)).unwrap();
        assert!(text.contains("didn't use them") && text.contains("Mira didn't start"), "{text}");
        assert!(text.ends_with("Trying again in 2 min."), "{text}");
        assert!(!text.contains(" s."), "{text}");
        assert!(cd.gate(&key, t0 + Duration::from_secs(100)).unwrap().ends_with("Trying again in under a minute."));
        assert!(cd.gate(&key, t0 + Duration::from_secs(130)).unwrap().ends_with("Trying again now."));
        cd.clear();
        assert_eq!(cd.gate(&key, t0), None);
    }

    #[test]
    fn a_failed_start_gates_only_its_own_session_key() {
        let cd = SourcesCooldown::default();
        let live_fast = SessionKey::sources(live(), Tier::Fast);
        let live_deep = SessionKey::sources(live(), Tier::Deep);
        let past = SessionKey::sources(SessionScope::Past("m9".into()), Tier::Deep);
        let t0 = Instant::now();
        cd.fail(&past, "Wiki didn't start", t0);
        cd.fail(&live_deep, "Wiki didn't start", t0);
        assert_eq!(cd.gate(&live_fast, t0), None, "Live Fast still tries its sources");
        assert!(cd.gate(&past, t0).is_some() && cd.gate(&live_deep, t0).is_some());
        // A start that works clears only its key.
        cd.clear_key(&past);
        assert!(cd.gate(&past, t0).is_none() && cd.gate(&live_deep, t0).is_some());
    }

    #[test]
    fn a_retry_timer_only_fires_for_the_current_failure_of_its_key() {
        let cd = SourcesCooldown::default();
        let key = SessionKey::sources(live(), Tier::Fast);
        let other = SessionKey::sources(SessionScope::Past("m9".into()), Tier::Deep);
        let first = cd.fail(&key, "a", Instant::now());
        assert!(cd.begin_retry(&key, first));
        let elsewhere = cd.fail(&other, "x", Instant::now());
        assert!(cd.begin_retry(&key, first), "another key's failure doesn't cancel it");
        assert!(cd.begin_retry(&other, elsewhere));
        let second = cd.fail(&key, "b", Instant::now());
        assert!(!cd.begin_retry(&key, first), "replaced by a newer failure");
        assert!(cd.begin_retry(&key, second));
        cd.clear();
        assert!(!cd.begin_retry(&key, second), "cleared (config or secrets changed, or a retry)");
        assert!(!cd.is_failed(&key) && !cd.is_failed(&other));
    }

    #[tokio::test]
    async fn a_failed_sources_start_is_not_retried_by_the_next_requests() {
        // The routing decision run_session_assist takes (`plain_instead`), then
        // the real manager: only the first request starts the with-sources
        // session, the next ones go to the plain session.
        let (manager, sessions, script, plain) = setup(&[]);
        script.fail_sources.store(true, Ordering::SeqCst);
        let key = plain.sibling();
        sessions.insert_if_absent(
            key.clone(),
            SessionRecord { sources: Some(SourcesLaunch::default()), ..Default::default() },
        );
        let cd = SourcesCooldown::default();
        let mut started = 0;
        let mut notices = Vec::new();
        for _ in 0..3 {
            match cd.plain_instead(&key, Instant::now()) {
                None => {
                    let init = sessions.restart_init(&key).unwrap();
                    if manager.ensure(&key, init).await.is_err() {
                        cd.fail(&key, "failed", Instant::now());
                    }
                    started += 1;
                }
                Some((instead, notice)) => {
                    assert_eq!(instead, plain, "the plain session of the same scope and tier answers");
                    notices.push(notice);
                    ask(&manager, &sessions, &instead, &[seg("a", 0)]).await.unwrap();
                }
            }
        }
        assert_eq!(notices.len(), 2);
        assert!(notices[0].contains("Your sources couldn't be loaded") && notices[0].contains("failed"), "{}", notices[0]);
        // A plain key is never held back, failure or not.
        assert!(cd.plain_instead(&plain, Instant::now()).is_none());
        assert_eq!(started, 1, "only the first request tried the sources");
        assert_eq!(script.sources_spawns.load(Ordering::SeqCst), 1);
        // A config change clears it: the next request tries again.
        cd.clear();
        assert!(cd.gate(&key, Instant::now()).is_none());
    }

    #[test]
    fn sources_note_body_drops_the_header() {
        assert_eq!(
            sources_note_body(SourceToggles { notes: false, tools: true }),
            "Notes: off. Tools: on. Use only the sources marked on."
        );
    }

    #[test]
    fn clear_sources_drops_only_the_with_sources_records_of_that_scope() {
        let sessions = MeetingSessions::default();
        let other = SessionScope::Live("m2".into());
        for scope in [live(), other.clone()] {
            for with in [false, true] {
                let key = SessionKey { scope: scope.clone(), tier: Tier::Fast, with_sources: with };
                sessions.insert_if_absent(key, SessionRecord::default());
            }
        }
        assert_eq!(sessions.scopes_with_sources(), vec![live(), other.clone()]);
        let epoch = sessions.epoch(&live());
        sessions.clear_sources(&live());
        assert!(sessions.contains(&SessionKey::plain(live(), Tier::Fast)));
        assert!(!sessions.contains(&SessionKey::sources(live(), Tier::Fast)));
        assert!(sessions.contains(&SessionKey::sources(other.clone(), Tier::Fast)));
        assert_eq!(sessions.epoch(&live()), epoch, "not a close");
        assert_eq!(sessions.scopes_with_sources(), vec![other]);
    }

    #[test]
    fn shared_answer_format() {
        assert_eq!(
            shared_answer("Assist", Some(" Who owns it? "), " Dana.\n"),
            "## Answer given earlier in this meeting (Assist)\nQuestion: Who owns it?\n\n## Your answer\nDana."
        );
        assert_eq!(
            shared_answer("Shorten", None, "Dana."),
            "## Answer given earlier in this meeting (Shorten)\n\n## Your answer\nDana."
        );
    }

    #[test]
    fn restart_init_carries_the_sources_launch() {
        let launch = SourcesLaunch { add_dirs: vec!["D:/v".into()], ..Default::default() };
        let record = SessionRecord { sources: Some(launch.clone()), ..Default::default() };
        assert_eq!(record.restart_init().sources, Some(launch));
        assert_eq!(SessionRecord::default().restart_init().sources, None);
    }

    #[tokio::test]
    async fn share_answer_appends_to_a_running_sibling_and_records_it() {
        let (manager, sessions, script, key) = setup(&[]);
        ask(&manager, &sessions, &key, &[seg("a", 0)]).await.unwrap();
        let sibling = key.sibling();
        // The sibling has a record but is not running: nothing is spawned.
        sessions.insert_if_absent(sibling.clone(), SessionRecord { system_prompt: "sp".into(), ..Default::default() });
        share_answer(&manager, &sessions, &sibling, "msg-1".into()).await;
        assert_eq!(script.spawns.load(Ordering::SeqCst), 1, "never starts the sibling");
        assert_eq!(sessions.get(&sibling).unwrap().replay, vec!["msg-1"]);

        // Running: the live session is told, no query is made.
        manager.ensure(&sibling, sessions.restart_init(&sibling).unwrap()).await.unwrap();
        let asks = script.prompts.lock().unwrap().len();
        share_answer(&manager, &sessions, &sibling, "msg-2".into()).await;
        assert_eq!(script.prompts.lock().unwrap().len(), asks, "an append is not a query");
        assert_eq!(script.appended.lock().unwrap()[1].last().unwrap(), "msg-2");
        assert_eq!(sessions.get(&sibling).unwrap().replay, vec!["msg-1", "msg-2"]);
    }

    #[tokio::test]
    async fn share_answer_without_session_or_record_does_nothing() {
        let (manager, sessions, script, key) = setup(&[]);
        share_answer(&manager, &sessions, &key.sibling(), "lost".into()).await;
        assert_eq!(script.spawns.load(Ordering::SeqCst), 0);
        assert!(!sessions.contains(&key.sibling()));
    }

    #[tokio::test]
    async fn sources_session_gets_catch_up_delta_on_first_answer() {
        let (manager, sessions, script, plain) = setup(&[]);
        let sources = plain.sibling();
        sessions.insert_if_absent(sources.clone(), SessionRecord { system_prompt: "sp".into(), ..Default::default() });
        let finals = vec![seg("s1", 0), seg("s2", 1), seg("s3", 2)];
        ask(&manager, &sessions, &plain, &finals).await.unwrap();
        // The with-sources session has its own cursor: it gets everything.
        ask(&manager, &sessions, &sources, &finals).await.unwrap();
        let first = last_prompt(&script);
        assert!(first.contains("Them: s1") && first.contains("Them: s2") && first.contains("Them: s3"), "{first}");
        // Then only what is new since.
        let finals = vec![seg("s1", 0), seg("s2", 1), seg("s3", 2), seg("s4", 3)];
        ask(&manager, &sessions, &sources, &finals).await.unwrap();
        let second = last_prompt(&script);
        assert!(second.contains("Them: s4") && !second.contains("Them: s1"), "{second}");
        // The plain session was not advanced by the other one.
        ask(&manager, &sessions, &plain, &finals).await.unwrap();
        let plain_prompt = last_prompt(&script);
        assert!(plain_prompt.contains("Them: s4") && !plain_prompt.contains("Them: s3"), "{plain_prompt}");
    }
}
