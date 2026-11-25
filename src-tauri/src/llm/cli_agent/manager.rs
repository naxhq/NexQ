//! `AgentSessionManager`: the CLI agent sessions NexQ keeps open (Claude,
//! Antigravity or Codex: whichever provider is active), keyed by meeting
//! scope and model tier.
//!
//! One kind is active at a time (`CliSettings::active`). Switching it closes
//! the sessions of the other kind (`close_other_kinds`; `ensure` also refuses
//! to reuse one), so a meeting never answers from two agents at once.
//!
//! - Lazy start: `ensure` spawns (once per key, even under concurrent calls)
//!   and preloads a session, and restarts one that died.
//! - Each session has a delta cursor so a request only sends transcript
//!   segments the session has not seen yet; it resets when the session is
//!   (re)started.
//! - Past-meeting and Workspace-chat sessions close after 15 min without AI
//!   activity (`reap_idle`, driven by `run_idle_reaper` every 60 s). Notes and
//!   Brief sessions end with their meeting (`close_scope`); a long idle limit
//!   only catches a meeting end that never arrived.
//! - A session may carry its own kind, model and effort ([`SessionOverride`],
//!   `ensure_with`): a chat can use Codex while the live provider is Claude.
//!   Such a session is pinned to its kind, and a provider switch leaves it.
//! - Every state transition is reported through a [`StatusSink`]
//!   (`agent_session_status` in the app).
//!
//! Sessions are stored as `Arc<dyn SessionHandle>` and created by a
//! [`SessionSpawner`], so the manager is testable without a process.

use super::command::{SessionConfig, SourcesLaunch};
use super::context::DeltaCursor;
use super::protocol::{AgentErrorKind, ImageAttachment, PlanLimit, TurnResult};
use super::session::{failed_mcp_servers, AgentError, ClaudeSession, InitInfo};
use super::settings::CliSettings;
use super::CliAgentKind;
use crate::llm::provider::CancelToken;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

/// Past-meeting sessions idle this long are closed.
pub const PAST_IDLE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// Workspace-chat sessions idle this long are closed.
pub const WORKSPACE_IDLE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// Notes and Brief sessions end with their meeting; one left idle this long
/// (the meeting end never reached us) is closed anyway.
pub const MEETING_AUX_IDLE_TIMEOUT: Duration = Duration::from_secs(2 * 60 * 60);
/// A graceful close waits at most this long for turns in flight.
pub const DRAIN_TIMEOUT: Duration = Duration::from_secs(10);
/// How often the idle reaper runs.
pub const REAP_INTERVAL: Duration = Duration::from_secs(60);
/// Tauri event carrying [`AgentSessionStatus`].
pub const STATUS_EVENT: &str = "agent_session_status";
/// How long a with-sources session may take to come up. MCP servers connect
/// during start (`MCP_TIMEOUT` is 20 s) and `system/init` waits for them, so
/// a slow server holds it up to that long; the plain session's 20 s would turn
/// it into a launch error. Plain sessions keep [`SessionTimeouts::default`].
/// A Check has its own, longer limit (`mcp_check::CHECK_INIT_TIMEOUT`).
pub const SOURCES_INIT_TIMEOUT: Duration = Duration::from_secs(60);

/// What a session is for.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum SessionScope {
    /// The running meeting (by meeting id).
    Live(String),
    /// A past meeting open in the meeting view (by meeting id).
    Past(String),
    /// Callers with no meeting (translation, knowledge-base test, wizard).
    Utility,
    /// A workspace chat (by chat id). Reaped after [`WORKSPACE_IDLE_TIMEOUT`].
    Workspace(String),
    /// Live notes of a meeting (by meeting id). Ends with the meeting.
    Notes(String),
    /// The brief of a meeting (by meeting id). Ends with the meeting.
    Brief(String),
}

impl SessionScope {
    fn label(&self) -> &'static str {
        match self {
            SessionScope::Live(_) => "live",
            SessionScope::Past(_) => "past",
            SessionScope::Utility => "utility",
            SessionScope::Workspace(_) => "workspace",
            SessionScope::Notes(_) => "notes",
            SessionScope::Brief(_) => "brief",
        }
    }

    pub(crate) fn meeting_id(&self) -> Option<String> {
        match self {
            SessionScope::Live(id) | SessionScope::Past(id) | SessionScope::Notes(id) | SessionScope::Brief(id) => {
                Some(id.clone())
            }
            SessionScope::Utility | SessionScope::Workspace(_) => None,
        }
    }

    /// The chat id of a Workspace scope.
    pub fn chat_id(&self) -> Option<&str> {
        match self {
            SessionScope::Workspace(id) => Some(id),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Tier {
    Fast,
    Deep,
}

impl Tier {
    fn label(self) -> &'static str {
        match self {
            Tier::Fast => "fast",
            Tier::Deep => "deep",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SessionKey {
    pub scope: SessionScope,
    pub tier: Tier,
    /// The with-sources variant: runs beside the plain session of the same
    /// scope and tier (notes folders and MCP tools, see `crate::sources`).
    pub with_sources: bool,
}

impl SessionKey {
    /// The plain session of `scope` and `tier`.
    pub fn plain(scope: SessionScope, tier: Tier) -> Self {
        Self { scope, tier, with_sources: false }
    }

    /// The with-sources session of `scope` and `tier`.
    pub fn sources(scope: SessionScope, tier: Tier) -> Self {
        Self { scope, tier, with_sources: true }
    }

    /// The other variant of the same scope and tier.
    pub fn sibling(&self) -> Self {
        Self { scope: self.scope.clone(), tier: self.tier, with_sources: !self.with_sources }
    }
}

/// One CLI agent's model settings (persisted by the settings UI; one per
/// [`CliAgentKind`], see `settings.rs` for the defaults). Named for Claude,
/// where it started: the saved Claude config keeps loading unchanged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ClaudeCliConfig {
    pub fast_model: String,
    pub fast_effort: String,
    pub deep_model: String,
    pub deep_effort: String,
    /// Extended thinking on the Fast tier (and the Utility session). Off by
    /// default: Haiku otherwise thinks on every turn before its first word.
    pub fast_thinking: bool,
    /// Extended thinking on the Deep tier.
    pub deep_thinking: bool,
    /// Provider id used when this CLI is unavailable; `None` = no fallback.
    pub fallback_provider: Option<String>,
    /// Model used on the fallback provider; `None` = its first listed model.
    pub fallback_model: Option<String>,
}

impl Default for ClaudeCliConfig {
    fn default() -> Self {
        Self {
            fast_model: "haiku".into(),
            fast_effort: "low".into(),
            deep_model: "sonnet".into(),
            deep_effort: "medium".into(),
            fast_thinking: false,
            deep_thinking: true,
            fallback_provider: None,
            fallback_model: None,
        }
    }
}

impl ClaudeCliConfig {
    /// `(model, effort)` for a tier.
    pub fn model_for(&self, tier: Tier) -> (&str, &str) {
        match tier {
            Tier::Fast => (&self.fast_model, &self.fast_effort),
            Tier::Deep => (&self.deep_model, &self.deep_effort),
        }
    }

    /// Whether a tier's sessions use extended thinking.
    pub fn thinking_for(&self, tier: Tier) -> bool {
        match tier {
            Tier::Fast => self.fast_thinking,
            Tier::Deep => self.deep_thinking,
        }
    }
}

/// Which tier serves `mode` (an intelligence mode such as `"Assist"` or
/// `"Recap"`) in `scope`: live meetings use Deep only for Recap, past meetings
/// always use Deep, utility calls use Fast. Identical Fast/Deep settings
/// always resolve to Fast so only one session runs.
pub fn tier_for(mode: &str, scope: &SessionScope, cfg: &ClaudeCliConfig) -> Tier {
    if cfg.model_for(Tier::Fast) == cfg.model_for(Tier::Deep)
        && cfg.thinking_for(Tier::Fast) == cfg.thinking_for(Tier::Deep)
    {
        return Tier::Fast;
    }
    match scope {
        SessionScope::Live(_) if mode == "Recap" => Tier::Deep,
        SessionScope::Live(_) | SessionScope::Utility => Tier::Fast,
        SessionScope::Past(_) => Tier::Deep,
        // Notes and the brief default to the cheapest tier; a chat to the better one.
        SessionScope::Notes(_) | SessionScope::Brief(_) => Tier::Fast,
        SessionScope::Workspace(_) => Tier::Deep,
    }
}

/// What one session is started with instead of the settings of the active
/// provider: a kind of its own (the session is then pinned to it: switching
/// the live provider leaves it alone), a model and an effort.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SessionOverride {
    pub kind: Option<CliAgentKind>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub thinking: Option<bool>,
}

/// Cumulative token/cost/timing accounting for one scope (estimate from the
/// CLI), over every successful turn of every tier and restart.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SessionUsage {
    /// Uncached prompt tokens.
    pub input_tokens: u64,
    /// Prompt tokens read from the prompt cache.
    pub cache_read_tokens: u64,
    /// Prompt tokens written to the prompt cache.
    pub cache_write_tokens: u64,
    /// Output tokens, thinking included.
    pub output_tokens: u64,
    /// The part of `output_tokens` spent thinking.
    pub thinking_tokens: u64,
    pub cost_usd: f64,
    /// Answered requests.
    pub requests: u64,
    /// Sum of every request's wall time (ask start → result).
    pub total_latency_ms: u64,
    /// Sum of every request's time to its first text (its whole wall time
    /// when no text came before the result).
    pub total_first_token_ms: u64,
    pub last_latency_ms: u64,
    /// When the last answered request started (ms since the Unix epoch).
    pub last_request_at_ms: u64,
}

impl SessionUsage {
    /// Add one answered turn (its `latency_ms` / `first_text_ms` measured by
    /// the manager), started at `started_at_ms` (epoch ms).
    pub fn add_turn(&mut self, turn: &TurnResult, started_at_ms: u64) {
        self.input_tokens += turn.input_tokens;
        self.cache_read_tokens += turn.cache_read_tokens;
        self.cache_write_tokens += turn.cache_write_tokens;
        self.output_tokens += turn.output_tokens;
        self.thinking_tokens += turn.thinking_tokens;
        self.cost_usd += turn.cost_usd;
        self.requests += 1;
        self.total_latency_ms += turn.latency_ms;
        self.total_first_token_ms += turn.first_text_ms.unwrap_or(turn.latency_ms);
        self.last_latency_ms = turn.latency_ms;
        self.last_request_at_ms = started_at_ms;
    }
}

fn epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Payload of the `agent_session_status` event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentSessionStatus {
    /// `"live"` | `"past"` | `"utility"` | `"workspace"` | `"notes"` | `"brief"`.
    pub scope: String,
    pub meeting_id: Option<String>,
    /// The chat id of a `"workspace"` session.
    #[serde(default)]
    pub chat_id: Option<String>,
    /// `"fast"` | `"deep"`.
    pub tier: String,
    /// `"starting"` | `"ready"` | `"busy"` | `"error"` | `"closed"`.
    pub state: String,
    pub model: String,
    /// Readable reason for `error`.
    pub detail: Option<String>,
    /// Snake_case [`AgentErrorKind`] of `detail` (`"rate_limited"`,
    /// `"not_logged_in"`, ...); set exactly when `detail` is.
    #[serde(default)]
    pub error_kind: Option<String>,
    /// The with-sources session of the scope and tier (notes folders and MCP
    /// tools), not the plain one.
    #[serde(default)]
    pub with_sources: bool,
    /// For a running with-sources session that came up without something: the
    /// servers that did not start and the sources left out ("Mira didn't
    /// start, so its tools aren't available"). `None` when all is in.
    #[serde(default)]
    pub sources_notice: Option<String>,
    /// Cumulative usage of the whole scope (all tiers).
    pub usage: SessionUsage,
}

/// Used only when `ensure` has to spawn a session.
#[derive(Debug, Clone, Default)]
pub struct SessionInit {
    pub system_prompt: String,
    /// Context messages appended (`shouldQuery:false`) right after spawn.
    pub preload: Vec<String>,
    /// What a with-sources session launches with. `ensure` uses it only for a
    /// `key.with_sources` key; a plain session ignores it.
    pub sources: Option<SourcesLaunch>,
}

/// Streaming text callback. A named alias so `async_trait` leaves the
/// higher-ranked `&str` lifetime alone.
pub type OnDelta = Box<dyn Fn(&str) + Send + Sync>;

/// What the manager needs from a running session ([`ClaudeSession`],
/// `AcpSession` or `CodexSession` in the app, fakes in tests).
#[async_trait]
pub trait SessionHandle: Send + Sync {
    async fn append_context(&self, text: &str) -> Result<(), AgentError>;
    async fn ask(
        &self,
        prompt: &str,
        on_delta: OnDelta,
        cancel: Arc<CancelToken>,
    ) -> Result<TurnResult, AgentError>;
    /// [`SessionHandle::ask`] with images sent along. A handle that can't
    /// carry images refuses them instead of answering without.
    async fn ask_with_images(
        &self,
        prompt: &str,
        images: &[ImageAttachment],
        on_delta: OnDelta,
        cancel: Arc<CancelToken>,
    ) -> Result<TurnResult, AgentError> {
        if !images.is_empty() {
            return Err(AgentError::Cli(
                AgentErrorKind::Other,
                "This session can't take images".to_string(),
            ));
        }
        self.ask(prompt, on_delta, cancel).await
    }
    fn is_alive(&self) -> bool;
    async fn close(&self);
    fn model(&self) -> String;
    /// The tools and MCP server states of the latest `system/init`. Empty for
    /// a handle that has none (fakes).
    fn init_info(&self) -> InitInfo {
        InitInfo::default()
    }
    /// The plan-limit signal the CLI reported since this was last asked
    /// (taking it clears it). `None` for a handle that has none.
    fn take_plan_limit(&self) -> Option<PlanLimit> {
        None
    }
}

#[async_trait]
impl SessionHandle for ClaudeSession {
    async fn append_context(&self, text: &str) -> Result<(), AgentError> {
        ClaudeSession::append_context(self, text).await
    }

    async fn ask(
        &self,
        prompt: &str,
        on_delta: OnDelta,
        cancel: Arc<CancelToken>,
    ) -> Result<TurnResult, AgentError> {
        ClaudeSession::ask(self, prompt, on_delta, cancel).await
    }

    async fn ask_with_images(
        &self,
        prompt: &str,
        images: &[ImageAttachment],
        on_delta: OnDelta,
        cancel: Arc<CancelToken>,
    ) -> Result<TurnResult, AgentError> {
        ClaudeSession::ask_with_images(self, prompt, images, on_delta, cancel).await
    }

    fn is_alive(&self) -> bool {
        ClaudeSession::is_alive(self)
    }

    async fn close(&self) {
        ClaudeSession::close(self).await
    }

    fn model(&self) -> String {
        ClaudeSession::model(self).to_string()
    }

    fn init_info(&self) -> InitInfo {
        ClaudeSession::init_info(self)
    }

    fn take_plan_limit(&self) -> Option<PlanLimit> {
        ClaudeSession::take_plan_limit(self)
    }
}

/// Starts sessions for the manager. The app's is `spawner::CliSpawner`, which
/// dispatches on [`SessionConfig::kind`].
#[async_trait]
pub trait SessionSpawner: Send + Sync {
    async fn spawn(&self, cfg: SessionConfig) -> Result<Arc<dyn SessionHandle>, AgentError>;
}

/// Receives every session status transition.
pub trait StatusSink: Send + Sync {
    fn emit(&self, status: &AgentSessionStatus);
}

/// Drops statuses (before the app handle exists, and in tests).
pub struct NoopStatusSink;

impl StatusSink for NoopStatusSink {
    fn emit(&self, _status: &AgentSessionStatus) {}
}

/// Emits `agent_session_status` to every window.
pub struct TauriStatusSink(pub tauri::AppHandle);

impl StatusSink for TauriStatusSink {
    fn emit(&self, status: &AgentSessionStatus) {
        use tauri::Emitter;
        if let Err(e) = self.0.emit(STATUS_EVENT, status) {
            log::warn!("cannot emit {STATUS_EVENT}: {e}");
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionState {
    Starting,
    Ready,
    Busy,
    Error,
    Closed,
}

impl SessionState {
    fn label(self) -> &'static str {
        match self {
            SessionState::Starting => "starting",
            SessionState::Ready => "ready",
            SessionState::Busy => "busy",
            SessionState::Error => "error",
            SessionState::Closed => "closed",
        }
    }
}

struct Entry {
    handle: Arc<dyn SessionHandle>,
    /// The CLI agent the session was started for.
    kind: CliAgentKind,
    state: SessionState,
    error: Option<TurnError>,
    last_used: Instant,
    in_flight: usize,
    /// Turns finished on this session (any outcome).
    turns: usize,
    /// What a with-sources session came up without (see
    /// [`AgentSessionStatus::sources_notice`]).
    sources_notice: Option<String>,
    /// The override the session was started with (`None` follows the active
    /// provider). A session with its own kind is not touched by a provider switch.
    requested: Option<SessionOverride>,
    /// A graceful close is waiting for the turns in flight: no new turn starts.
    draining: bool,
}

impl Entry {
    /// Started for a kind of its own, not the active one.
    fn pinned(&self) -> bool {
        self.requested.as_ref().is_some_and(|o| o.kind.is_some())
    }
}

pub struct AgentSessionManager {
    spawner: Arc<dyn SessionSpawner>,
    sink: Arc<dyn StatusSink>,
    /// Per-kind configuration and catalogs (efforts are clamped to the
    /// catalog of the kind), and which kind is active.
    settings: Arc<CliSettings>,
    entries: Mutex<HashMap<SessionKey, Entry>>,
    /// Serializes spawning per key so concurrent `ensure`s start one session.
    spawn_locks: Mutex<HashMap<SessionKey, Arc<AsyncMutex<()>>>>,
    /// Sessions taken out of their key by [`AgentSessionManager::detach_scope`]
    /// while a turn of theirs is still running. A new session may already
    /// hold the key; these only finish their turns and are then closed.
    retiring: Mutex<Vec<(SessionKey, Entry)>>,
    /// Bumped whenever a scope's sessions are taken out of service for a
    /// change of what they were started with (see [`AgentSessionManager::generation`]).
    /// Lock order: `entries`, then `scope_gen`.
    scope_gen: Mutex<HashMap<SessionScope, u64>>,
    /// Bumped when a scope's with-sources sessions are closed for a change of
    /// the sources (only with-sources keys see it). Same lock order.
    sources_gen: Mutex<HashMap<SessionScope, u64>>,
    cursors: Mutex<HashMap<SessionKey, Arc<AsyncMutex<DeltaCursor>>>>,
    usage: Mutex<HashMap<SessionScope, SessionUsage>>,
    shutting_down: AtomicBool,
    /// Woken whenever a turn ends (a graceful close waits on it).
    turn_ended: tokio::sync::Notify,
    /// Called with the key of every session taken out of service (closed,
    /// reaped, retired, replaced), e.g. to delete a chat's transcript folder.
    on_closed: Mutex<Option<ClosedHook>>,
    /// Per-call tool approval of workspace chats, by chat id. Read when a
    /// `Workspace` session starts; no other scope ever has one.
    chat_approvals: Mutex<HashMap<String, super::approval::ChatApprovals>>,
}

/// See `AgentSessionManager::set_closed_hook`.
pub type ClosedHook = Arc<dyn Fn(&SessionKey) + Send + Sync>;

impl AgentSessionManager {
    pub fn new(
        spawner: Arc<dyn SessionSpawner>,
        sink: Arc<dyn StatusSink>,
        settings: Arc<CliSettings>,
    ) -> Self {
        Self {
            spawner,
            sink,
            settings,
            entries: Mutex::new(HashMap::new()),
            spawn_locks: Mutex::new(HashMap::new()),
            retiring: Mutex::new(Vec::new()),
            scope_gen: Mutex::new(HashMap::new()),
            sources_gen: Mutex::new(HashMap::new()),
            cursors: Mutex::new(HashMap::new()),
            usage: Mutex::new(HashMap::new()),
            shutting_down: AtomicBool::new(false),
            turn_ended: tokio::sync::Notify::new(),
            on_closed: Mutex::new(None),
            chat_approvals: Mutex::new(HashMap::new()),
        }
    }

    /// Let the chat's sessions ask before a tool runs (takes effect for a
    /// session started afterwards; a changed policy replaces the session).
    pub fn set_chat_approvals(&self, approvals: super::approval::ChatApprovals) {
        self.chat_approvals.lock().unwrap().insert(approvals.chat_id.clone(), approvals);
    }

    /// The chat is gone: forget its approvals and refuse any open question.
    pub fn clear_chat_approvals(&self, chat_id: &str) {
        if let Some(a) = self.chat_approvals.lock().unwrap().remove(chat_id) {
            a.broker.deny_chat(chat_id);
        }
    }

    fn approvals_for(&self, scope: &SessionScope) -> Option<super::approval::ChatApprovals> {
        let chat = scope.chat_id()?;
        self.chat_approvals.lock().unwrap().get(chat).cloned()
    }

    /// Run `hook` for every session that leaves service (any reason).
    pub fn set_closed_hook(&self, hook: ClosedHook) {
        *self.on_closed.lock().unwrap() = Some(hook);
    }

    fn notify_closed(&self, key: &SessionKey) {
        // A chat session that leaves service leaves no question open.
        if key.with_sources {
            if let Some(a) = self.approvals_for(&key.scope) {
                a.broker.deny_chat(&a.chat_id);
            }
        }
        let hook = self.on_closed.lock().unwrap().clone();
        if let Some(hook) = hook {
            hook(key);
        }
    }

    /// The settings the manager reads (configuration, catalogs, active kind).
    pub fn settings(&self) -> &Arc<CliSettings> {
        &self.settings
    }

    /// The running session for `key`, spawning it (with `init`) if there is
    /// none or it died. Concurrent calls for one key start a single session.
    /// A (re)started session gets a fresh delta cursor.
    pub async fn ensure(
        &self,
        key: &SessionKey,
        init: SessionInit,
    ) -> Result<Arc<dyn SessionHandle>, AgentError> {
        self.ensure_with(key, init, None).await
    }

    /// [`AgentSessionManager::ensure`] for a session with its own kind, model
    /// and effort. A running session started with a different override is
    /// replaced (the chat changed its model); one without an override follows
    /// the active provider exactly as before.
    pub async fn ensure_with(
        &self,
        key: &SessionKey,
        init: SessionInit,
        overrides: Option<SessionOverride>,
    ) -> Result<Arc<dyn SessionHandle>, AgentError> {
        self.ensure_at(key, init, overrides, None).await
    }

    /// The generation of `scope`: read it BEFORE building the `init` a session
    /// is started with, and pass it to [`AgentSessionManager::ensure_at`].
    pub fn generation(&self, scope: &SessionScope) -> u64 {
        self.scope_gen.lock().unwrap().get(scope).copied().unwrap_or(0)
    }

    /// The generation a session of `key` is started under: the scope's, and for
    /// a with-sources key also the sources' (a change of the sources makes a
    /// with-sources start stale but leaves plain ones alone). Read it before
    /// building the init, as [`AgentSessionManager::generation`].
    pub fn generation_for(&self, key: &SessionKey) -> u64 {
        let scope = self.generation(&key.scope);
        if key.with_sources {
            let sources = self.sources_gen.lock().unwrap().get(&key.scope).copied().unwrap_or(0);
            scope + (sources << 32)
        } else {
            scope
        }
    }

    /// Whether the generation of `key` moved since `expected` was read.
    fn changed_since(&self, key: &SessionKey, expected: Option<u64>) -> bool {
        expected.is_some_and(|g| self.generation_for(key) != g)
    }

    fn bump_sources(&self, scope: &SessionScope) {
        let _entries = self.entries.lock().unwrap();
        *self.sources_gen.lock().unwrap().entry(scope.clone()).or_insert(0) += 1;
    }

    /// Bumps the generation of `scope`; the caller holds the `entries` lock, so
    /// the bump and the removal of the scope's sessions are one step.
    fn bump_locked(&self, scope: &SessionScope) {
        *self.scope_gen.lock().unwrap().entry(scope.clone()).or_insert(0) += 1;
    }

    fn bump_scope(&self, scope: &SessionScope) {
        let _entries = self.entries.lock().unwrap();
        self.bump_locked(scope);
    }

    /// [`AgentSessionManager::ensure_with`] for an `init` built when `scope` was
    /// at generation `expected`. If the scope was restarted since (its sessions
    /// detached or closed), nothing starts with that `init`: a session already
    /// being spawned is closed instead of inserted, and the call fails with
    /// [`scope_changed`] so the caller builds a fresh record and tries once more.
    pub async fn ensure_at(
        &self,
        key: &SessionKey,
        init: SessionInit,
        overrides: Option<SessionOverride>,
        expected: Option<u64>,
    ) -> Result<Arc<dyn SessionHandle>, AgentError> {
        let overrides = overrides.filter(|o| *o != SessionOverride::default());
        let pinned_kind = overrides.as_ref().and_then(|o| o.kind);
        let lock = self.spawn_lock(key);
        let _spawning = lock.lock().await;
        if self.shutting_down.load(Ordering::SeqCst) {
            return Err(shut_down_error());
        }
        if self.changed_since(key, expected) {
            return Err(scope_changed());
        }

        let mut kind = pinned_kind.unwrap_or_else(|| self.settings.active());
        let stale = {
            let mut entries = self.entries.lock().unwrap();
            match entries.get_mut(key) {
                Some(entry)
                    if entry.kind == kind
                        && entry.requested == overrides
                        && !entry.draining
                        && entry.handle.is_alive()
                        && !restart_after_error(key, entry) =>
                {
                    entry.last_used = Instant::now();
                    return Ok(entry.handle.clone());
                }
                Some(_) => entries.remove(key),
                None => None,
            }
        };
        if let Some(dead) = stale {
            dead.handle.close().await;
        }

        // The provider can change while a session starts: one of the old kind
        // is then closed instead of kept, and the new kind is started.
        let mut attempts = 0;
        loop {
            attempts += 1;
            let (model, effort, thinking) = {
                let cfg = self.settings.config(kind);
                let (m, e) = cfg.model_for(key.tier);
                let (m, e) = match &overrides {
                    Some(o) => (o.model.as_deref().unwrap_or(m), o.effort.as_deref().unwrap_or(e)),
                    None => (m, e),
                };
                let resolved = self.settings.resolve(kind, m, e);
                // The thinking toggle is Claude's alone.
                let wanted = overrides
                    .as_ref()
                    .and_then(|o| o.thinking)
                    .unwrap_or_else(|| cfg.thinking_for(key.tier));
                let thinking = kind.supports_thinking_toggle() && wanted;
                (resolved.model, resolved.effort, thinking)
            };
            self.emit(key, SessionState::Starting, &model, None);
            let cfg = SessionConfig {
                kind,
                model: model.clone(),
                effort,
                system_prompt: init.system_prompt.clone(),
                thinking,
                sources: if key.with_sources { init.sources.clone() } else { None },
                approvals: if key.with_sources { self.approvals_for(&key.scope) } else { None },
            };
            let handle = match self.spawner.spawn(cfg).await {
                Ok(handle) => handle,
                Err(e) => {
                    self.emit(key, SessionState::Error, &model, Some(TurnError::of(&e)));
                    return Err(e);
                }
            };
            for message in &init.preload {
                if let Err(e) = handle.append_context(message).await {
                    handle.close().await;
                    self.emit(key, SessionState::Error, &model, Some(TurnError::of(&e)));
                    return Err(e);
                }
            }
            // `close_all` ran while this session was starting: don't leak it.
            if self.shutting_down.load(Ordering::SeqCst) {
                handle.close().await;
                self.emit(key, SessionState::Closed, &model, None);
                return Err(shut_down_error());
            }

            let sources_notice = match (&init.sources, key.with_sources) {
                (Some(launch), true) => crate::sources::activity::sources_degraded_notice(
                    &launch.server_labels,
                    &failed_mcp_servers(&handle.init_info()),
                    &launch.left_out,
                ),
                _ => None,
            };
            // Check the kind and insert under one lock: a switch after this
            // point runs `close_other_kinds`, which then finds the entry.
            let mut stale = false;
            let inserted = {
                let mut entries = self.entries.lock().unwrap();
                if self.changed_since(key, expected) {
                    // The scope was restarted while this session started: it
                    // was built from material that is no longer current.
                    stale = true;
                    false
                } else if pinned_kind.is_some() || self.settings.active() == kind {
                    self.cursors.lock().unwrap().insert(
                        key.clone(),
                        Arc::new(AsyncMutex::new(DeltaCursor::default())),
                    );
                    entries.insert(
                        key.clone(),
                        Entry {
                            handle: handle.clone(),
                            kind,
                            state: SessionState::Ready,
                            error: None,
                            last_used: Instant::now(),
                            in_flight: 0,
                            turns: 0,
                            sources_notice,
                            requested: overrides.clone(),
                            draining: false,
                        },
                    );
                    true
                } else {
                    false
                }
            };
            if inserted {
                self.emit(key, SessionState::Ready, &handle.model(), None);
                return Ok(handle);
            }
            handle.close().await;
            self.emit(key, SessionState::Closed, &model, None);
            if stale {
                return Err(scope_changed());
            }
            kind = pinned_kind.unwrap_or_else(|| self.settings.active());
            if attempts >= 3 {
                return Err(AgentError::Crashed("the AI provider kept changing while a session started".into()));
            }
        }
    }

    /// Ask on the session `ensure` started for `key`, reporting busy, then
    /// ready (or error), and adding the turn's usage to the scope's total.
    /// The result carries the turn's wall time (`latency_ms`) and time to
    /// first text (`first_text_ms`), measured from this call.
    pub async fn ask(
        &self,
        key: &SessionKey,
        prompt: &str,
        on_delta: OnDelta,
        cancel: Arc<CancelToken>,
    ) -> Result<TurnResult, AgentError> {
        self.ask_with_images(key, prompt, &[], on_delta, cancel).await
    }

    /// [`AgentSessionManager::ask`] with `images` sent along with `prompt`.
    pub async fn ask_with_images(
        &self,
        key: &SessionKey,
        prompt: &str,
        images: &[ImageAttachment],
        on_delta: OnDelta,
        cancel: Arc<CancelToken>,
    ) -> Result<TurnResult, AgentError> {
        let handle = {
            let mut entries = self.entries.lock().unwrap();
            let entry = entries.get_mut(key).ok_or_else(|| {
                AgentError::Crashed("no CLI agent session is running for this request".into())
            })?;
            if entry.draining {
                return Err(AgentError::Crashed("this session is restarting; try again in a moment".into()));
            }
            entry.in_flight += 1;
            entry.last_used = Instant::now();
            entry.state = SessionState::Busy;
            entry.error = None;
            entry.handle.clone()
        };
        self.emit(key, SessionState::Busy, &handle.model(), None);

        // Settles in_flight/state even if this future is dropped mid-turn.
        let mut turn = TurnGuard {
            manager: self,
            key,
            handle: handle.clone(),
            outcome: TurnOutcome::Abandoned,
        };
        let started = Instant::now();
        let started_at_ms = epoch_ms();
        let first_text: Arc<std::sync::OnceLock<u64>> = Arc::default();
        let on_delta: OnDelta = {
            let first_text = first_text.clone();
            Box::new(move |token: &str| {
                if !token.is_empty() && !crate::llm::cli_agent::session::is_activity(token) {
                    first_text.get_or_init(|| started.elapsed().as_millis() as u64);
                }
                on_delta(token)
            })
        };
        let mut result = handle.ask_with_images(prompt, images, on_delta, cancel).await;

        if let Ok(done) = &mut result {
            done.latency_ms = started.elapsed().as_millis() as u64;
            done.first_text_ms = first_text.get().copied();
            self.usage
                .lock()
                .unwrap()
                .entry(key.scope.clone())
                .or_default()
                .add_turn(done, started_at_ms);
        }
        turn.outcome = match &result {
            Ok(_) => TurnOutcome::Succeeded,
            Err(e) if e.is_cancel() => TurnOutcome::Cancelled,
            Err(e) => TurnOutcome::Failed(TurnError::of(e)),
        };
        drop(turn);
        result
    }

    /// End of one `ask` on `handle`: release its in-flight slot and move the
    /// session to ready/error, unless the entry was closed or replaced.
    fn finish_turn(
        &self,
        key: &SessionKey,
        handle: &Arc<dyn SessionHandle>,
        outcome: &TurnOutcome,
    ) {
        let transition = {
            let mut entries = self.entries.lock().unwrap();
            match entries.get_mut(key) {
                Some(entry) if same_session(&entry.handle, handle) => {
                    entry.in_flight = entry.in_flight.saturating_sub(1);
                    entry.turns += 1;
                    entry.last_used = Instant::now();
                    let idle = entry.in_flight == 0;
                    match outcome {
                        // A success proves the session healthy again.
                        TurnOutcome::Succeeded if idle => {
                            entry.state = SessionState::Ready;
                            entry.error = None;
                        }
                        TurnOutcome::Cancelled | TurnOutcome::Abandoned
                            if idle && entry.state == SessionState::Busy =>
                        {
                            entry.state = SessionState::Ready;
                        }
                        TurnOutcome::Failed(error) => {
                            entry.state = SessionState::Error;
                            entry.error = Some(error.clone());
                        }
                        _ => {}
                    }
                    Some((entry.state, entry.error.clone()))
                }
                _ => None,
            }
        };
        if transition.is_none() {
            // A turn of a session that was detached for a restart.
            let mut retiring = self.retiring.lock().unwrap();
            if let Some((_, entry)) = retiring.iter_mut().find(|(k, e)| k == key && same_session(&e.handle, handle)) {
                entry.in_flight = entry.in_flight.saturating_sub(1);
            }
        }
        self.turn_ended.notify_waiters();
        if let Some((state, error)) = transition {
            self.emit(key, state, &handle.model(), error);
        }
    }

    /// The delta cursor of `key`'s current session. Hold the guard while
    /// taking new segments and sending them, so concurrent requests on one
    /// session never send the same segment twice.
    pub async fn cursor(&self, key: &SessionKey) -> OwnedMutexGuard<DeltaCursor> {
        let cursor = self
            .cursors
            .lock()
            .unwrap()
            .entry(key.clone())
            .or_default()
            .clone();
        cursor.lock_owned().await
    }

    /// Record AI activity on `key` (postpones the idle timeout).
    pub fn touch(&self, key: &SessionKey) {
        if let Some(entry) = self.entries.lock().unwrap().get_mut(key) {
            entry.last_used = Instant::now();
        }
    }

    /// Close every tier of `scope` (meeting ended / left the meeting view). A
    /// session still starting for that scope is waited for and closed too.
    pub async fn close_scope(&self, scope: &SessionScope) {
        // (No generation bump: closing ends the scope or follows a restart that
        // already bumped it; the records and the epoch guard an ended meeting.)
        for with_sources in [false, true] {
            self.close_variant(scope, with_sources).await;
        }
        self.usage.lock().unwrap().remove(scope);
    }

    /// Close both tiers' with-sources sessions of `scope` and leave the plain
    /// ones (the sources changed in settings; usage is kept).
    pub async fn close_sources(&self, scope: &SessionScope) {
        self.bump_sources(scope);
        self.close_variant(scope, true).await;
    }

    async fn close_variant(&self, scope: &SessionScope, with_sources: bool) {
        for tier in [Tier::Fast, Tier::Deep] {
            let key = SessionKey { scope: scope.clone(), tier, with_sources };
            let lock = self.spawn_lock(&key);
            let _spawning = lock.lock().await;
            self.close_key(&key).await;
        }
    }

    /// Append `text` to `key`'s session context (`shouldQuery:false`) only if
    /// that session is running: `Ok(false)` when there is none (never spawns).
    pub async fn append_if_running(&self, key: &SessionKey, text: &str) -> Result<bool, AgentError> {
        let handle = {
            let entries = self.entries.lock().unwrap();
            match entries.get(key) {
                Some(entry) if entry.handle.is_alive() => entry.handle.clone(),
                _ => return Ok(false),
            }
        };
        handle.append_context(text).await?;
        Ok(true)
    }

    /// Close the sessions started for a kind other than the active one (the
    /// user switched provider). Sessions of the active kind stay. Returns how
    /// many were closed.
    ///
    /// Each key is closed under its spawn lock, so the old session's `closed`
    /// is always reported before a replacement for the same key starts (a late
    /// `closed` would otherwise erase the replacement's status).
    pub async fn close_other_kinds(&self) -> usize {
        let keys: Vec<SessionKey> = {
            let active = self.settings.active();
            let entries = self.entries.lock().unwrap();
            entries
                .iter()
                .filter(|(_, e)| e.kind != active && !e.pinned())
                .map(|(k, _)| k.clone())
                .collect()
        };
        let closes = keys.into_iter().map(|key| async move {
            let lock = self.spawn_lock(&key);
            let _spawning = lock.lock().await;
            let removed = {
                let active = self.settings.active();
                let mut entries = self.entries.lock().unwrap();
                match entries.get(&key) {
                    Some(e) if e.kind != active && !e.pinned() => {
                        self.cursors.lock().unwrap().remove(&key);
                        entries.remove(&key)
                    }
                    _ => None,
                }
            };
            match removed {
                Some(entry) => {
                    self.close_removed(&key, entry).await;
                    1
                }
                None => 0,
            }
        });
        futures::future::join_all(closes).await.into_iter().sum()
    }

    /// Close every session (app exit). Sessions still starting are closed as
    /// soon as they come up, and no new session starts afterwards.
    pub async fn close_all(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        let mut drained: Vec<(SessionKey, Entry)> = self.entries.lock().unwrap().drain().collect();
        drained.extend(self.retiring.lock().unwrap().drain(..));
        self.cursors.lock().unwrap().clear();
        futures::future::join_all(drained.iter().map(|(_, entry)| entry.handle.close())).await;
        for (key, entry) in &drained {
            self.emit(key, SessionState::Closed, &entry.handle.model(), None);
            self.notify_closed(key);
        }
        self.usage.lock().unwrap().clear();
    }

    /// Close every tier of `scope` the gentle way: no new turn starts, the
    /// turns in flight finish (at most `bound`, then they are cut), and only
    /// then do the processes close. Usage is kept. For scope restarts (the
    /// sources or the scope of a meeting changed) and chat deletion.
    pub async fn close_scope_graceful(&self, scope: &SessionScope, bound: Duration) {
        let mut keys = Vec::new();
        for with_sources in [false, true] {
            for tier in [Tier::Fast, Tier::Deep] {
                keys.push(SessionKey { scope: scope.clone(), tier, with_sources });
            }
        }
        futures::future::join_all(keys.iter().map(|key| self.close_key_graceful(key, bound))).await;
    }

    /// Takes every session of `scope` out of service at once, without waiting
    /// for anything: a request that arrives next finds no session for its key
    /// and starts a new one under the new record, never queued behind the old
    /// one's turns (no spawn lock is taken). A turn still running on an old
    /// session finishes there; close those with
    /// [`AgentSessionManager::close_retired_graceful`]. Returns how many sessions
    /// were detached.
    pub fn detach_scope(&self, scope: &SessionScope) -> usize {
        let mut moved: Vec<(SessionKey, Entry)> = Vec::new();
        {
            let mut entries = self.entries.lock().unwrap();
            // The bump and the removal are one step: a spawn that started before
            // finds the generation changed when it is about to insert.
            self.bump_locked(scope);
            let keys: Vec<SessionKey> = entries.keys().filter(|k| &k.scope == scope).cloned().collect();
            for key in keys {
                if let Some(mut entry) = entries.remove(&key) {
                    entry.draining = true;
                    moved.push((key, entry));
                }
            }
        }
        {
            let mut cursors = self.cursors.lock().unwrap();
            for (key, _) in &moved {
                cursors.remove(key);
            }
        }
        let count = moved.len();
        self.retiring.lock().unwrap().extend(moved);
        count
    }

    /// Closes the sessions [`AgentSessionManager::detach_scope`] took out for
    /// `scope`: after their turns in flight finish (at most `bound`, then they
    /// are cut). A session that took the key since is not touched.
    pub async fn close_retired_graceful(&self, scope: &SessionScope, bound: Duration) {
        let deadline = tokio::time::Instant::now() + bound;
        loop {
            let ended = self.turn_ended.notified();
            tokio::pin!(ended);
            ended.as_mut().enable();
            let idle = self.retiring.lock().unwrap().iter().filter(|(k, _)| &k.scope == scope).all(|(_, e)| e.in_flight == 0);
            if idle {
                break;
            }
            if tokio::time::timeout_at(deadline, ended).await.is_err() {
                log::warn!("closing retired sessions of {:?} with a turn still in flight after {bound:?}", scope);
                break;
            }
        }
        let taken: Vec<(SessionKey, Entry)> = {
            let mut retiring = self.retiring.lock().unwrap();
            let (mine, rest): (Vec<_>, Vec<_>) = retiring.drain(..).partition(|(k, _)| &k.scope == scope);
            *retiring = rest;
            mine
        };
        futures::future::join_all(taken.iter().map(|(_, entry)| entry.handle.close())).await;
    }

    /// [`AgentSessionManager::close_scope_graceful`] for one key.
    pub async fn close_key_graceful(&self, key: &SessionKey, bound: Duration) {
        self.bump_scope(&key.scope);
        let lock = self.spawn_lock(key);
        let _spawning = lock.lock().await;
        let running = {
            let mut entries = self.entries.lock().unwrap();
            match entries.get_mut(key) {
                Some(entry) => {
                    entry.draining = true;
                    true
                }
                None => false,
            }
        };
        if !running {
            return;
        }
        let deadline = tokio::time::Instant::now() + bound;
        loop {
            // Register before looking, so a turn ending in between is not missed.
            let ended = self.turn_ended.notified();
            tokio::pin!(ended);
            ended.as_mut().enable();
            let idle = self.entries.lock().unwrap().get(key).map_or(true, |e| e.in_flight == 0);
            if idle {
                break;
            }
            if tokio::time::timeout_at(deadline, ended).await.is_err() {
                log::warn!("closing {:?} with a turn still in flight after {bound:?}", key.scope);
                break;
            }
        }
        self.close_key(key).await;
    }

    /// If `key`'s session has finished `max_turns` turns and none is in
    /// flight, close it so the next `ensure` starts a fresh one (notes
    /// sessions are renewed every 25 runs so history does not grow). Scope
    /// usage is kept. True when it was recycled.
    pub async fn recycle_after(&self, key: &SessionKey, max_turns: usize) -> bool {
        if self.turns(key) < max_turns {
            return false;
        }
        match self.retire_if_idle(key) {
            Some(handle) => {
                handle.close().await;
                true
            }
            None => false,
        }
    }

    /// Close past-meeting sessions with no AI activity for 15 min (and no turn
    /// in flight). Keys busy starting a session are skipped this round.
    pub async fn reap_idle(&self, now: Instant) {
        // Check and remove under one lock: an `ask` or `ensure` that touches
        // the entry either happens first (not stale) or finds it gone.
        let stale: Vec<(SessionKey, Entry)> = {
            let mut entries = self.entries.lock().unwrap();
            let keys: Vec<SessionKey> = entries
                .iter()
                .filter(|(key, entry)| is_stale(key, entry, now))
                .map(|(key, _)| key.clone())
                .collect();
            let mut cursors = self.cursors.lock().unwrap();
            keys.into_iter()
                .filter_map(|key| {
                    cursors.remove(&key);
                    entries.remove_entry(&key)
                })
                .collect()
        };
        for (key, entry) in stale {
            log::info!("closing idle {} session for {:?}", entry.kind.short_name(), key.scope);
            self.close_removed(&key, entry).await;
        }
    }

    /// What `key`'s running with-sources session came up without, if anything.
    pub fn sources_notice(&self, key: &SessionKey) -> Option<String> {
        self.entries.lock().unwrap().get(key).and_then(|e| e.sources_notice.clone())
    }

    /// Turns finished on `key`'s current session (0 when none is running).
    pub fn turns(&self, key: &SessionKey) -> usize {
        self.entries
            .lock()
            .unwrap()
            .get(key)
            .map(|e| e.turns)
            .unwrap_or(0)
    }

    /// Take `key`'s session out of service if no turn is in flight, so the
    /// next `ensure` starts a fresh one. Reports `closed` and returns the
    /// handle for the caller to `close()` (off the request's critical path).
    /// Scope usage is kept.
    /// Like [`AgentSessionManager::retire_if_idle`], but only when the session at
    /// `key` is `handle` itself: a newer session that took the key is left alone.
    pub fn retire_handle_if_idle(&self, key: &SessionKey, handle: &Arc<dyn SessionHandle>) -> Option<Arc<dyn SessionHandle>> {
        let entry = {
            let mut entries = self.entries.lock().unwrap();
            match entries.get(key) {
                Some(e) if e.in_flight == 0 && same_session(&e.handle, handle) => entries.remove(key)?,
                _ => return None,
            }
        };
        self.cursors.lock().unwrap().remove(key);
        self.emit(key, SessionState::Closed, &entry.handle.model(), None);
        self.notify_closed(key);
        Some(entry.handle)
    }

    pub fn retire_if_idle(&self, key: &SessionKey) -> Option<Arc<dyn SessionHandle>> {
        let entry = {
            let mut entries = self.entries.lock().unwrap();
            match entries.get(key) {
                Some(e) if e.in_flight == 0 => entries.remove(key)?,
                _ => return None,
            }
        };
        self.cursors.lock().unwrap().remove(key);
        self.emit(key, SessionState::Closed, &entry.handle.model(), None);
        self.notify_closed(key);
        Some(entry.handle)
    }

    /// Cumulative usage of `scope` across tiers and restarts.
    pub fn usage(&self, scope: &SessionScope) -> SessionUsage {
        self.usage
            .lock()
            .unwrap()
            .get(scope)
            .copied()
            .unwrap_or_default()
    }

    /// Current status of every open session.
    pub fn snapshot(&self) -> Vec<AgentSessionStatus> {
        let mut rows: Vec<(SessionKey, SessionState, String, Option<TurnError>)> = self
            .entries
            .lock()
            .unwrap()
            .iter()
            .map(|(key, e)| (key.clone(), e.state, e.handle.model(), e.error.clone()))
            .collect();
        rows.sort_by(|a, b| a.0.cmp(&b.0));
        rows.into_iter()
            .map(|(key, state, model, error)| self.status(&key, state, &model, error))
            .collect()
    }

    fn spawn_lock(&self, key: &SessionKey) -> Arc<AsyncMutex<()>> {
        self.spawn_locks
            .lock()
            .unwrap()
            .entry(key.clone())
            .or_default()
            .clone()
    }

    async fn close_key(&self, key: &SessionKey) {
        let removed = self.entries.lock().unwrap().remove(key);
        self.cursors.lock().unwrap().remove(key);
        if let Some(entry) = removed {
            self.close_removed(key, entry).await;
        }
    }

    /// Close an entry (and cursor) already taken out of the maps.
    async fn close_removed(&self, key: &SessionKey, entry: Entry) {
        entry.handle.close().await;
        self.emit(key, SessionState::Closed, &entry.handle.model(), None);
        self.notify_closed(key);
    }

    fn status(
        &self,
        key: &SessionKey,
        state: SessionState,
        model: &str,
        error: Option<TurnError>,
    ) -> AgentSessionStatus {
        AgentSessionStatus {
            scope: key.scope.label().to_string(),
            meeting_id: key.scope.meeting_id(),
            chat_id: key.scope.chat_id().map(str::to_string),
            tier: key.tier.label().to_string(),
            state: state.label().to_string(),
            model: model.to_string(),
            detail: error.as_ref().map(|e| e.text.clone()),
            error_kind: error.map(|e| e.kind.as_str().to_string()),
            with_sources: key.with_sources,
            sources_notice: self.sources_notice(key),
            usage: self.usage(&key.scope),
        }
    }

    fn emit(&self, key: &SessionKey, state: SessionState, model: &str, error: Option<TurnError>) {
        self.sink.emit(&self.status(key, state, model, error));
    }
}

/// Why a session is in `error`: readable text plus its classified kind.
#[derive(Debug, Clone, PartialEq)]
struct TurnError {
    text: String,
    kind: AgentErrorKind,
}

impl TurnError {
    fn of(e: &AgentError) -> Self {
        Self { text: e.to_string(), kind: e.kind() }
    }
}

/// How an `ask` ended, for [`TurnGuard`].
enum TurnOutcome {
    /// The caller's future was dropped mid-turn.
    Abandoned,
    Succeeded,
    Cancelled,
    Failed(TurnError),
}

/// Settles a turn's in-flight slot and state when dropped, so a caller that
/// drops `ask` (select!, timeout, abort) never leaves a session stuck busy.
struct TurnGuard<'a> {
    manager: &'a AgentSessionManager,
    key: &'a SessionKey,
    handle: Arc<dyn SessionHandle>,
    outcome: TurnOutcome,
}

impl Drop for TurnGuard<'_> {
    fn drop(&mut self) {
        self.manager
            .finish_turn(self.key, &self.handle, &self.outcome);
    }
}

/// Drive `reap_idle` every [`REAP_INTERVAL`] for the app's lifetime.
pub async fn run_idle_reaper(manager: Arc<AgentSessionManager>) {
    let mut tick = tokio::time::interval(REAP_INTERVAL);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tick.tick().await;
        manager.reap_idle(Instant::now()).await;
    }
}

/// A Utility session left in `error` by a failed turn (e.g. context too
/// long) is replaced on its next use: Utility requests are unrelated, so
/// nothing is lost. Meeting sessions keep theirs; restarting them means
/// replaying context, which the caller (Task 15) owns.
///
/// Notes and Brief sessions are replaced too: every run resends what it
/// needs (the outline, the passages), and `ai_runs` replays a chat's history
/// into a Workspace session when a fresh one starts.
fn restart_after_error(key: &SessionKey, entry: &Entry) -> bool {
    matches!(
        key.scope,
        SessionScope::Utility | SessionScope::Workspace(_) | SessionScope::Notes(_) | SessionScope::Brief(_)
    ) && entry.state == SessionState::Error
        && entry.in_flight == 0
}

fn is_stale(key: &SessionKey, entry: &Entry, now: Instant) -> bool {
    let limit = match key.scope {
        SessionScope::Past(_) => PAST_IDLE_TIMEOUT,
        SessionScope::Workspace(_) => WORKSPACE_IDLE_TIMEOUT,
        SessionScope::Notes(_) | SessionScope::Brief(_) => MEETING_AUX_IDLE_TIMEOUT,
        SessionScope::Live(_) | SessionScope::Utility => return false,
    };
    entry.in_flight == 0 && now.saturating_duration_since(entry.last_used) >= limit
}

/// Same session object (compares data pointers; vtable pointers may differ).
fn same_session(a: &Arc<dyn SessionHandle>, b: &Arc<dyn SessionHandle>) -> bool {
    std::ptr::eq(Arc::as_ptr(a) as *const (), Arc::as_ptr(b) as *const ())
}

const SCOPE_CHANGED: &str = "the meeting's material changed while this session started";

/// A session was about to start from an `init` built before its scope was
/// restarted. Retryable: build a fresh record and ask once more.
pub fn scope_changed() -> AgentError {
    AgentError::Crashed(SCOPE_CHANGED.to_string())
}

/// Whether `err` is [`scope_changed`].
pub fn is_scope_changed(err: &AgentError) -> bool {
    matches!(err, AgentError::Crashed(m) if m == SCOPE_CHANGED)
}

fn shut_down_error() -> AgentError {
    AgentError::Spawn("NexQ is shutting down".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::cli_agent::session::SessionTimeouts;
    use std::sync::atomic::AtomicUsize;

    struct FakeSession {
        model: String,
        alive: AtomicBool,
        closed: AtomicBool,
        appended: Mutex<Vec<String>>,
        /// Held at the first warm-up message until released.
        warm: Mutex<Option<Arc<TestGate>>>,
    }

    #[async_trait]
    impl SessionHandle for FakeSession {
        async fn append_context(&self, text: &str) -> Result<(), AgentError> {
            let gate = self.warm.lock().unwrap().take();
            if let Some(gate) = gate {
                gate.pass().await;
            }
            self.appended.lock().unwrap().push(text.to_string());
            Ok(())
        }

        async fn ask(
            &self,
            prompt: &str,
            on_delta: OnDelta,
            _cancel: Arc<CancelToken>,
        ) -> Result<TurnResult, AgentError> {
            if let Some(msg) = prompt.strip_prefix("fail:") {
                return Err(AgentError::Crashed(msg.to_string()));
            }
            if let Some(msg) = prompt.strip_prefix("cli:") {
                return Err(AgentError::Cli(
                    crate::llm::cli_agent::protocol::classify_error(msg),
                    msg.to_string(),
                ));
            }
            if prompt == "block" {
                // A turn that never finishes (until the caller drops it).
                std::future::pending::<()>().await;
            }
            if prompt == "yield" {
                // Still in flight across a scheduler turn.
                tokio::task::yield_now().await;
            }
            if prompt == "activity-slow" {
                // A tool use first, text 30 ms later.
                let tool = crate::llm::cli_agent::protocol::ToolUse {
                    id: "t1".into(),
                    name: "Grep".into(),
                    input: serde_json::json!({"pattern": "x"}),
                };
                on_delta(&crate::llm::cli_agent::session::encode_activity(&tool));
                tokio::time::sleep(Duration::from_millis(30)).await;
                on_delta("a");
            } else if prompt == "slow" {
                // Thinks, then answers 30 ms in and finishes 60 ms in.
                on_delta(crate::llm::cli_agent::session::THINKING_SIGNAL);
                tokio::time::sleep(Duration::from_millis(30)).await;
                on_delta("a");
                tokio::time::sleep(Duration::from_millis(30)).await;
            } else {
                on_delta(prompt);
            }
            Ok(TurnResult {
                text: prompt.to_string(),
                input_tokens: 10,
                cache_read_tokens: 30,
                cache_write_tokens: 4,
                output_tokens: 2,
                thinking_tokens: 1,
                cost_usd: 0.5,
                ..Default::default()
            })
        }

        fn is_alive(&self) -> bool {
            self.alive.load(Ordering::SeqCst)
        }

        async fn close(&self) {
            self.closed.store(true, Ordering::SeqCst);
            self.alive.store(false, Ordering::SeqCst);
        }

        fn model(&self) -> String {
            self.model.clone()
        }
    }

    #[derive(Default)]
    struct FakeSpawner {
        spawned: Mutex<Vec<(SessionConfig, Arc<FakeSession>)>>,
        calls: AtomicUsize,
        /// Refuse to start a with-sources session.
        fail_sources: AtomicBool,
        /// Switch the active kind while the next session starts.
        switch_during_spawn: Mutex<Option<(Arc<CliSettings>, CliAgentKind)>>,
        /// Hold the next spawn at its start / after the session exists, until released.
        gate_start: Mutex<Option<Arc<TestGate>>>,
        gate_end: Mutex<Option<Arc<TestGate>>>,
        /// Hold the warm-up (the first preload message) of the next session.
        gate_warm: Mutex<Option<Arc<TestGate>>>,
    }

    /// A point a fake spawner waits at: `entered` says it is there, `release` lets it go.
    #[derive(Default)]
    struct TestGate {
        entered: tokio::sync::Notify,
        release: tokio::sync::Notify,
    }

    impl TestGate {
        async fn pass(&self) {
            self.entered.notify_one();
            self.release.notified().await;
        }
    }

    #[async_trait]
    impl SessionSpawner for FakeSpawner {
        async fn spawn(&self, cfg: SessionConfig) -> Result<Arc<dyn SessionHandle>, AgentError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let start = self.gate_start.lock().unwrap().take();
            if let Some(gate) = start {
                gate.pass().await;
            }
            tokio::task::yield_now().await;
            if let Some((settings, kind)) = self.switch_during_spawn.lock().unwrap().take() {
                settings.set_active(kind);
            }
            if cfg.sources.is_some() && self.fail_sources.load(Ordering::SeqCst) {
                return Err(AgentError::Spawn("MCP server mira failed to start".into()));
            }
            let s = Arc::new(FakeSession {
                model: cfg.model.clone(),
                alive: AtomicBool::new(true),
                closed: AtomicBool::new(false),
                appended: Mutex::new(Vec::new()),
                warm: Mutex::new(self.gate_warm.lock().unwrap().take()),
            });
            self.spawned.lock().unwrap().push((cfg, s.clone()));
            let end = self.gate_end.lock().unwrap().take();
            if let Some(gate) = end {
                gate.pass().await;
            }
            Ok(s)
        }
    }

    #[derive(Default)]
    struct RecordingSink(Mutex<Vec<AgentSessionStatus>>);

    impl StatusSink for RecordingSink {
        fn emit(&self, status: &AgentSessionStatus) {
            self.0.lock().unwrap().push(status.clone());
        }
    }

    impl RecordingSink {
        fn states(&self) -> Vec<String> {
            self.0
                .lock()
                .unwrap()
                .iter()
                .map(|s| s.state.clone())
                .collect()
        }
    }

    fn setup() -> (AgentSessionManager, Arc<FakeSpawner>, Arc<RecordingSink>) {
        let spawner = Arc::new(FakeSpawner::default());
        let sink = Arc::new(RecordingSink::default());
        let mgr = AgentSessionManager::new(spawner.clone(), sink.clone(), Arc::new(CliSettings::isolated()));
        (mgr, spawner, sink)
    }

    fn key(scope: SessionScope, tier: Tier) -> SessionKey {
        SessionKey::plain(scope, tier)
    }

    fn init(preload: &[&str]) -> SessionInit {
        SessionInit {
            system_prompt: "sp".into(),
            preload: preload.iter().map(|s| s.to_string()).collect(),
            sources: None,
        }
    }

    fn no_delta() -> OnDelta {
        Box::new(|_| {})
    }

    #[test]
    fn tier_routing() {
        let cfg = ClaudeCliConfig::default();
        let live = SessionScope::Live("m1".into());
        let past = SessionScope::Past("m1".into());
        assert_eq!(tier_for("Recap", &live, &cfg), Tier::Deep);
        assert_eq!(tier_for("Assist", &live, &cfg), Tier::Fast);
        assert_eq!(tier_for("Assist", &past, &cfg), Tier::Deep);
        assert_eq!(tier_for("Recap", &SessionScope::Utility, &cfg), Tier::Fast);
        let same = ClaudeCliConfig {
            deep_model: "haiku".into(),
            deep_effort: "low".into(),
            deep_thinking: false,
            ..ClaudeCliConfig::default()
        };
        assert_eq!(tier_for("Recap", &live, &same), Tier::Fast);
        assert_eq!(tier_for("Assist", &past, &same), Tier::Fast);
        // Same model, but only Deep thinks: two different sessions.
        let thinks = ClaudeCliConfig { deep_thinking: true, ..same };
        assert_eq!(tier_for("Recap", &live, &thinks), Tier::Deep);
    }

    #[test]
    fn default_config_is_haiku_low_sonnet_medium() {
        let cfg = ClaudeCliConfig::default();
        assert_eq!(cfg.model_for(Tier::Fast), ("haiku", "low"));
        assert_eq!(cfg.model_for(Tier::Deep), ("sonnet", "medium"));
        assert!(!cfg.thinking_for(Tier::Fast));
        assert!(cfg.thinking_for(Tier::Deep));
        assert_eq!(cfg.fallback_provider, None);
        let partial: ClaudeCliConfig = serde_json::from_str(r#"{"deep_model":"opus"}"#).unwrap();
        assert_eq!(partial.model_for(Tier::Deep), ("opus", "medium"));
        // A config saved before the thinking settings existed loads with defaults.
        let old: ClaudeCliConfig = serde_json::from_str(
            r#"{"fast_model":"haiku","fast_effort":"low","deep_model":"sonnet","deep_effort":"medium","fallback_provider":null,"fallback_model":null}"#,
        )
        .unwrap();
        assert_eq!((old.fast_thinking, old.deep_thinking), (false, true));
    }

    #[tokio::test]
    async fn ensure_passes_each_tiers_thinking_setting() {
        let spawner = Arc::new(FakeSpawner::default());
        let cfg = ClaudeCliConfig { fast_thinking: true, deep_thinking: false, ..Default::default() };
        let mgr = AgentSessionManager::new(spawner.clone(), Arc::new(NoopStatusSink), CliSettings::isolated_with(cfg));
        mgr.ensure(&key(SessionScope::Utility, Tier::Fast), init(&[])).await.unwrap();
        mgr.ensure(&key(SessionScope::Past("m".into()), Tier::Deep), init(&[])).await.unwrap();
        let thinking: Vec<bool> = spawner.spawned.lock().unwrap().iter().map(|(c, _)| c.thinking).collect();
        assert_eq!(thinking, vec![true, false]);
    }

    #[tokio::test]
    async fn ensure_clamps_effort_to_the_model_catalog() {
        let spawner = Arc::new(FakeSpawner::default());
        let info = |value: &str, levels: &[&str]| crate::llm::cli_agent::models::ClaudeModelInfo {
            value: value.into(),
            resolved_model: value.into(),
            display_name: value.into(),
            description: String::new(),
            supports_effort: !levels.is_empty(),
            effort_levels: levels.iter().map(|s| s.to_string()).collect(),
            default_effort: None,
        };
        let cfg = ClaudeCliConfig {
            deep_model: "claude-opus-4-6".into(),
            deep_effort: "xhigh".into(),
            ..ClaudeCliConfig::default()
        };
        let settings = CliSettings::isolated_with(cfg);
        settings.catalog(CliAgentKind::Claude).set(vec![
            info("haiku", &[]),
            info("claude-opus-4-6", &["low", "medium", "high", "max"]),
        ]);
        let mgr = AgentSessionManager::new(spawner.clone(), Arc::new(NoopStatusSink), settings);
        mgr.ensure(&key(SessionScope::Utility, Tier::Fast), init(&[])).await.unwrap();
        mgr.ensure(&key(SessionScope::Past("m".into()), Tier::Deep), init(&[])).await.unwrap();
        let spawned = spawner.spawned.lock().unwrap();
        // Haiku takes no effort: none is passed.
        assert_eq!((spawned[0].0.model.as_str(), spawned[0].0.effort.as_deref()), ("haiku", None));
        // xhigh isn't offered by this model: the closest lower level is used.
        assert_eq!(spawned[1].0.effort.as_deref(), Some("high"));
    }

    fn catalog_entry(value: &str, levels: &[&str]) -> crate::llm::cli_agent::models::ClaudeModelInfo {
        crate::llm::cli_agent::models::ClaudeModelInfo {
            value: value.into(),
            resolved_model: value.into(),
            display_name: value.into(),
            description: String::new(),
            supports_effort: !levels.is_empty(),
            effort_levels: levels.iter().map(|s| s.to_string()).collect(),
            default_effort: None,
        }
    }

    #[tokio::test]
    async fn the_active_kind_decides_what_is_spawned_and_with_which_model() {
        let spawner = Arc::new(FakeSpawner::default());
        let settings = Arc::new(CliSettings::isolated());
        settings.catalog(CliAgentKind::Codex).set(vec![
            catalog_entry("gpt-6.2-sol", &["low", "medium", "high", "xhigh", "max", "ultra"]),
            catalog_entry("gpt-6-luna", &["low", "medium"]),
        ]);
        settings.catalog(CliAgentKind::Antigravity).set(vec![
            catalog_entry("gemini-4-neon-high", &[]),
            catalog_entry("gemini-3.8-flash-low", &[]),
        ]);
        let mgr = AgentSessionManager::new(spawner.clone(), Arc::new(NoopStatusSink), settings.clone());

        // Codex: Fast and Deep are the first listed model at low and medium effort.
        settings.set_active(CliAgentKind::Codex);
        mgr.ensure(&key(SessionScope::Utility, Tier::Fast), init(&[])).await.unwrap();
        mgr.ensure(&key(SessionScope::Past("m".into()), Tier::Deep), init(&[])).await.unwrap();
        // Antigravity: Fast is listed, Deep (`gemini-4-neon-medium`) is not, so the first listed
        // one; no effort, no thinking toggle.
        settings.set_active(CliAgentKind::Antigravity);
        mgr.ensure(&key(SessionScope::Live("l".into()), Tier::Fast), init(&[])).await.unwrap();
        mgr.ensure(&key(SessionScope::Live("l2".into()), Tier::Deep), init(&[])).await.unwrap();
        let spawned = spawner.spawned.lock().unwrap();
        let seen: Vec<_> = spawned
            .iter()
            .map(|(c, _)| (c.kind, c.model.as_str(), c.effort.as_deref(), c.thinking))
            .collect();
        assert_eq!(
            seen,
            vec![
                (CliAgentKind::Codex, "gpt-6.2-sol", Some("low"), false),
                (CliAgentKind::Codex, "gpt-6.2-sol", Some("medium"), false),
                (CliAgentKind::Antigravity, "gemini-3.8-flash-low", None, false),
                (CliAgentKind::Antigravity, "gemini-4-neon-high", None, false),
            ]
        );
    }

    #[tokio::test]
    async fn claude_keeps_its_thinking_toggle_and_the_others_ignore_it() {
        let spawner = Arc::new(FakeSpawner::default());
        let settings = Arc::new(CliSettings::isolated());
        for kind in CliAgentKind::ALL {
            let mut cfg = ClaudeCliConfig::default_for(kind);
            cfg.fast_thinking = true;
            settings.set_config(kind, cfg);
        }
        let mgr = AgentSessionManager::new(spawner.clone(), Arc::new(NoopStatusSink), settings.clone());
        for (i, kind) in CliAgentKind::ALL.into_iter().enumerate() {
            settings.set_active(kind);
            mgr.ensure(&key(SessionScope::Live(format!("m{i}")), Tier::Fast), init(&[])).await.unwrap();
        }
        let thinking: Vec<(CliAgentKind, bool)> =
            spawner.spawned.lock().unwrap().iter().map(|(c, _)| (c.kind, c.thinking)).collect();
        assert_eq!(
            thinking,
            vec![(CliAgentKind::Claude, true), (CliAgentKind::Antigravity, false), (CliAgentKind::Codex, false)]
        );
    }

    #[tokio::test]
    async fn switching_the_active_kind_replaces_the_sessions_of_the_other_kind() {
        let (mgr, spawner, sink) = setup();
        let settings = mgr.settings().clone();
        let k = key(SessionScope::Live("m1".into()), Tier::Fast);
        let first = mgr.ensure(&k, init(&[])).await.unwrap();
        // Same kind: the session is reused.
        let again = mgr.ensure(&k, init(&[])).await.unwrap();
        assert!(same_session(&first, &again));
        assert_eq!(spawner.calls.load(Ordering::SeqCst), 1);

        // Another kind became active: the old session is closed on request...
        assert!(settings.set_active(CliAgentKind::Codex));
        assert_eq!(mgr.close_other_kinds().await, 1);
        assert!(!first.is_alive());
        assert!(mgr.snapshot().is_empty());
        assert!(sink.states().last().is_some_and(|s| s == "closed"));
        // ...and nothing of the active kind is touched.
        let fresh = mgr.ensure(&k, init(&[])).await.unwrap();
        assert!(!same_session(&first, &fresh));
        assert_eq!(mgr.close_other_kinds().await, 0);
        assert!(fresh.is_alive());
        assert_eq!(spawner.spawned.lock().unwrap().last().unwrap().0.kind, CliAgentKind::Codex);
    }

    #[tokio::test]
    async fn a_switch_while_a_session_starts_closes_it_and_starts_the_new_kind() {
        let (mgr, spawner, sink) = setup();
        let settings = mgr.settings().clone();
        let start = settings.active();
        *spawner.switch_during_spawn.lock().unwrap() = Some((settings.clone(), CliAgentKind::Codex));
        let k = key(SessionScope::Live("m1".into()), Tier::Fast);
        let handle = mgr.ensure(&k, init(&[])).await.unwrap();
        let spawned = spawner.spawned.lock().unwrap();
        assert_eq!(spawned.len(), 2);
        assert_eq!(spawned[0].0.kind, start);
        assert!(spawned[0].1.closed.load(Ordering::SeqCst), "the old kind's session is closed, never kept");
        assert_eq!(spawned[1].0.kind, CliAgentKind::Codex);
        assert!(handle.is_alive());
        drop(spawned);
        // Nothing of the old kind is left for shared context to reach.
        assert_eq!(mgr.close_other_kinds().await, 0);
        assert!(mgr.append_if_running(&k, "ctx").await.unwrap());
        assert_eq!(sink.states().last().map(String::as_str), Some("ready"));
    }

    #[tokio::test]
    async fn the_old_sessions_closed_is_reported_before_its_replacement_starts() {
        let (mgr, _spawner, sink) = setup();
        let mgr = Arc::new(mgr);
        let k = key(SessionScope::Live("m1".into()), Tier::Fast);
        mgr.ensure(&k, init(&[])).await.unwrap();
        mgr.settings().set_active(CliAgentKind::Antigravity);
        let (closer, starter) = (mgr.clone(), mgr.clone());
        let k2 = k.clone();
        let (closed, started) = tokio::join!(
            async move { closer.close_other_kinds().await },
            async move { starter.ensure(&k2, init(&[])).await }
        );
        assert!(closed <= 1);
        assert!(started.unwrap().is_alive());
        // Whatever the order, the last word on the key is the replacement's.
        assert_eq!(sink.states().last().map(String::as_str), Some("ready"));
        assert_eq!(mgr.snapshot().len(), 1);
    }

    #[tokio::test]
    async fn ensure_never_reuses_a_session_of_another_kind() {
        let (mgr, spawner, _sink) = setup();
        let k = key(SessionScope::Past("m1".into()), Tier::Deep);
        let first = mgr.ensure(&k, init(&[])).await.unwrap();
        // The switch was not announced to the manager (no `close_other_kinds`):
        // `ensure` still starts a session for the active kind.
        mgr.settings().set_active(CliAgentKind::Antigravity);
        let second = mgr.ensure(&k, init(&[])).await.unwrap();
        assert!(!same_session(&first, &second));
        assert!(!first.is_alive(), "the old one is closed");
        assert_eq!(spawner.calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn status_serializes_snake_case() {
        let s = AgentSessionStatus {
            scope: "live".into(),
            meeting_id: Some("m1".into()),
            chat_id: None,
            tier: "fast".into(),
            state: "ready".into(),
            model: "haiku".into(),
            detail: None,
            error_kind: None,
            with_sources: true,
            sources_notice: None,
            usage: SessionUsage {
                input_tokens: 1,
                output_tokens: 2,
                cost_usd: 0.5,
                cache_read_tokens: 3,
                requests: 4,
                last_request_at_ms: 5,
                ..Default::default()
            },
        };
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["meeting_id"], "m1");
        assert_eq!(v["usage"]["input_tokens"], 1);
        assert_eq!(v["usage"]["output_tokens"], 2);
        assert_eq!(v["usage"]["cost_usd"], 0.5);
        assert_eq!(v["usage"]["cache_read_tokens"], 3);
        assert_eq!(v["usage"]["cache_write_tokens"], 0);
        assert_eq!(v["usage"]["thinking_tokens"], 0);
        assert_eq!(v["usage"]["requests"], 4);
        assert_eq!(v["usage"]["total_latency_ms"], 0);
        assert_eq!(v["usage"]["total_first_token_ms"], 0);
        assert_eq!(v["usage"]["last_latency_ms"], 0);
        assert_eq!(v["usage"]["last_request_at_ms"], 5);
        assert!(v["error_kind"].is_null());
        assert_eq!(v["with_sources"], true);
    }

    #[test]
    fn old_status_payload_defaults_with_sources_false() {
        let old = r#"{"scope":"live","meeting_id":"m1","tier":"fast","state":"ready","model":"haiku","detail":null,"usage":{}}"#;
        let s: AgentSessionStatus = serde_json::from_str(old).unwrap();
        assert!(!s.with_sources);
    }

    fn seg(id: &str, text: &str) -> crate::llm::cli_agent::context::Seg {
        crate::llm::cli_agent::context::Seg {
            id: id.into(),
            text: text.into(),
            speaker: "Them".into(),
            timestamp_ms: 1,
        }
    }

    fn launch() -> SourcesLaunch {
        SourcesLaunch {
            add_dirs: vec!["D:/vault".into()],
            allowed_tools: vec!["Read".into()],
            ..Default::default()
        }
    }

    fn init_with_sources() -> SessionInit {
        SessionInit { sources: Some(launch()), ..init(&[]) }
    }

    #[test]
    fn session_key_variants() {
        let live = SessionScope::Live("m".into());
        let plain = SessionKey::plain(live.clone(), Tier::Fast);
        let sources = SessionKey::sources(live, Tier::Fast);
        assert!(!plain.with_sources && sources.with_sources);
        assert_eq!(plain.sibling(), sources);
        assert_eq!(sources.sibling(), plain);
        assert_ne!(plain, sources);
    }

    #[tokio::test]
    async fn ensure_passes_sources_only_for_with_sources_keys() {
        let (mgr, spawner, _) = setup();
        let live = SessionScope::Live("m".into());
        mgr.ensure(&SessionKey::plain(live.clone(), Tier::Fast), init_with_sources()).await.unwrap();
        mgr.ensure(&SessionKey::sources(live, Tier::Fast), init_with_sources()).await.unwrap();
        let spawned = spawner.spawned.lock().unwrap();
        assert!(spawned[0].0.sources.is_none());
        assert_eq!(spawned[1].0.sources, Some(launch()));
    }

    #[tokio::test]
    async fn plain_and_sources_sessions_are_independent() {
        let (mgr, spawner, _) = setup();
        let live = SessionScope::Live("m".into());
        let plain = SessionKey::plain(live.clone(), Tier::Fast);
        let sources = SessionKey::sources(live, Tier::Fast);
        mgr.ensure(&plain, init_with_sources()).await.unwrap();
        mgr.ensure(&sources, init_with_sources()).await.unwrap();
        assert_eq!(spawner.calls.load(Ordering::SeqCst), 2);
        let segs = [seg("s1", "hello")];
        assert_eq!(mgr.cursor(&plain).await.take_new(&segs).len(), 1);
        // The with-sources cursor has not seen it.
        assert_eq!(mgr.cursor(&sources).await.take_new(&segs).len(), 1);
        assert_eq!(mgr.cursor(&plain).await.take_new(&segs).len(), 0);
        mgr.ask(&plain, "hi", no_delta(), Arc::new(CancelToken::new())).await.unwrap();
        assert_eq!(mgr.turns(&plain), 1);
        assert_eq!(mgr.turns(&sources), 0);
    }

    #[tokio::test]
    async fn close_scope_closes_all_four_and_close_sources_only_sources() {
        let (mgr, _, _) = setup();
        let live = SessionScope::Live("m".into());
        let keys = [
            SessionKey::plain(live.clone(), Tier::Fast),
            SessionKey::plain(live.clone(), Tier::Deep),
            SessionKey::sources(live.clone(), Tier::Fast),
            SessionKey::sources(live.clone(), Tier::Deep),
        ];
        for k in &keys {
            mgr.ensure(k, init_with_sources()).await.unwrap();
        }
        mgr.close_sources(&live).await;
        let left: Vec<_> = mgr.snapshot().into_iter().map(|s| (s.tier, s.with_sources)).collect();
        assert_eq!(left, vec![("fast".to_string(), false), ("deep".to_string(), false)]);
        for k in &keys[2..] {
            mgr.ensure(k, init_with_sources()).await.unwrap();
        }
        mgr.close_scope(&live).await;
        assert!(mgr.snapshot().is_empty());
    }

    #[tokio::test]
    async fn sources_spawn_failure_leaves_plain_session_ready() {
        let (mgr, spawner, sink) = setup();
        spawner.fail_sources.store(true, Ordering::SeqCst);
        let live = SessionScope::Live("m".into());
        let plain = SessionKey::plain(live.clone(), Tier::Fast);
        let sources = SessionKey::sources(live, Tier::Fast);
        mgr.ensure(&plain, init_with_sources()).await.unwrap();
        assert!(mgr.ensure(&sources, init_with_sources()).await.is_err());
        let errors: Vec<_> = sink.0.lock().unwrap().iter().filter(|s| s.state == "error").cloned().collect();
        assert_eq!(errors.len(), 1);
        assert!(errors[0].with_sources && errors[0].detail.as_deref().unwrap().contains("mira"));
        let snap = mgr.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!((snap[0].state.as_str(), snap[0].with_sources), ("ready", false));
        let turn = mgr.ask(&plain, "hello", no_delta(), Arc::new(CancelToken::new())).await.unwrap();
        assert_eq!(turn.text, "hello");
    }

    #[tokio::test]
    async fn append_if_running_never_spawns() {
        let (mgr, spawner, _) = setup();
        let k = SessionKey::plain(SessionScope::Live("m".into()), Tier::Fast);
        assert_eq!(mgr.append_if_running(&k, "x").await, Ok(false));
        assert_eq!(spawner.calls.load(Ordering::SeqCst), 0);
        mgr.ensure(&k, init(&[])).await.unwrap();
        assert_eq!(mgr.append_if_running(&k, "shared answer").await, Ok(true));
        let spawned = spawner.spawned.lock().unwrap();
        assert_eq!(*spawned[0].1.appended.lock().unwrap(), vec!["shared answer"]);
        assert_eq!(spawner.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_with_sources_session_reports_what_was_left_out() {
        let (mgr, _, sink) = setup();
        let k = SessionKey::sources(SessionScope::Live("m".into()), Tier::Fast);
        let launch = SourcesLaunch { left_out: vec!["Vault: folder not found".into()], ..launch() };
        mgr.ensure(&k, SessionInit { sources: Some(launch), ..init(&[]) }).await.unwrap();
        assert_eq!(mgr.sources_notice(&k).as_deref(), Some("Left out: Vault: folder not found"));
        let ready = sink.0.lock().unwrap().iter().find(|s| s.state == "ready").cloned().unwrap();
        assert_eq!(ready.sources_notice.as_deref(), Some("Left out: Vault: folder not found"));
        assert_eq!(mgr.snapshot()[0].sources_notice, ready.sources_notice);
        // A session with everything in, and a plain one, carry none.
        let plain = SessionKey::plain(SessionScope::Live("m".into()), Tier::Fast);
        mgr.ensure(&plain, init_with_sources()).await.unwrap();
        assert_eq!(mgr.sources_notice(&plain), None);
    }

    #[test]
    fn sources_init_timeout_is_longer_than_a_hung_servers_failure() {
        // `system/init` waits for a hung MCP server up to MCP_TIMEOUT (20 s).
        assert_eq!(SOURCES_INIT_TIMEOUT, Duration::from_secs(60));
        assert!(SOURCES_INIT_TIMEOUT > SessionTimeouts::default().init);
    }

    #[tokio::test]
    async fn ensure_spawns_once_preloads_and_restarts_dead() {
        let (mgr, spawner, sink) = setup();
        let k = key(SessionScope::Live("m1".into()), Tier::Deep);
        let (a, b) = tokio::join!(
            mgr.ensure(&k, init(&["doc1", "doc2"])),
            mgr.ensure(&k, init(&["other"]))
        );
        let (a, b) = (a.unwrap(), b.unwrap());
        assert_eq!(
            spawner.calls.load(Ordering::SeqCst),
            1,
            "concurrent ensure spawned twice"
        );
        assert_eq!(a.model(), "sonnet");
        assert_eq!(b.model(), "sonnet");
        {
            let spawned = spawner.spawned.lock().unwrap();
            let (cfg, first) = &spawned[0];
            assert_eq!(
                (cfg.model.as_str(), cfg.effort.as_deref()),
                ("sonnet", Some("medium"))
            );
            assert_eq!(cfg.system_prompt, "sp");
            assert_eq!(*first.appended.lock().unwrap(), vec!["doc1", "doc2"]);
        }
        assert_eq!(sink.states(), vec!["starting", "ready"]);

        // The cursor advances, and resets when the session is restarted.
        let segs = vec![crate::llm::cli_agent::context::Seg {
            id: "s1".into(),
            text: "a".into(),
            speaker: "You".into(),
            timestamp_ms: 0,
        }];
        assert_eq!(mgr.cursor(&k).await.take_new(&segs).len(), 1);
        assert_eq!(mgr.cursor(&k).await.sent(), 1);

        spawner.spawned.lock().unwrap()[0]
            .1
            .alive
            .store(false, Ordering::SeqCst);
        mgr.ensure(&k, init(&["doc3"])).await.unwrap();
        assert_eq!(spawner.calls.load(Ordering::SeqCst), 2);
        assert!(spawner.spawned.lock().unwrap()[0]
            .1
            .closed
            .load(Ordering::SeqCst));
        assert_eq!(
            *spawner.spawned.lock().unwrap()[1]
                .1
                .appended
                .lock()
                .unwrap(),
            vec!["doc3"]
        );
        assert_eq!(mgr.cursor(&k).await.sent(), 0);
    }

    #[tokio::test]
    async fn ask_reports_busy_ready_and_accumulates_usage() {
        let (mgr, _spawner, sink) = setup();
        let scope = SessionScope::Past("m2".into());
        let k = key(scope.clone(), Tier::Deep);
        assert!(matches!(
            mgr.ask(&k, "q", no_delta(), Arc::new(CancelToken::new()))
                .await,
            Err(AgentError::Crashed(_))
        ));
        mgr.ensure(&k, init(&[])).await.unwrap();
        let got = Arc::new(Mutex::new(String::new()));
        let sinkbuf = got.clone();
        let r = mgr
            .ask(
                &k,
                "q1",
                Box::new(move |d| sinkbuf.lock().unwrap().push_str(d)),
                Arc::new(CancelToken::new()),
            )
            .await
            .unwrap();
        assert_eq!(r.text, "q1");
        assert_eq!(*got.lock().unwrap(), "q1");
        mgr.ask(&k, "q2", no_delta(), Arc::new(CancelToken::new()))
            .await
            .unwrap();
        let usage = mgr.usage(&scope);
        assert_eq!(
            (
                usage.input_tokens,
                usage.cache_read_tokens,
                usage.cache_write_tokens,
                usage.output_tokens,
                usage.thinking_tokens,
                usage.cost_usd,
                usage.requests
            ),
            (20, 60, 8, 4, 2, 1.0, 2)
        );
        assert!(usage.last_request_at_ms > 0);
        assert!(usage.total_first_token_ms <= usage.total_latency_ms);
        assert_eq!(
            sink.states(),
            vec!["starting", "ready", "busy", "ready", "busy", "ready"]
        );
        let last = sink.0.lock().unwrap().last().cloned().unwrap();
        assert_eq!(last.scope, "past");
        assert_eq!(last.meeting_id.as_deref(), Some("m2"));
        assert_eq!(last.tier, "deep");
        assert_eq!(last.model, "sonnet");
        assert_eq!(last.usage.input_tokens, 20);
        assert_eq!(last.usage.requests, 2);

        let err = mgr
            .ask(&k, "fail:boom", no_delta(), Arc::new(CancelToken::new()))
            .await;
        assert!(err.is_err());
        let snap = mgr.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].state, "error");
        assert!(snap[0].detail.as_deref().unwrap().contains("boom"));
        assert_eq!(snap[0].error_kind.as_deref(), Some("crashed"));
    }

    #[tokio::test]
    async fn ask_first_text_ignores_activity() {
        let (mgr, _spawner, _sink) = setup();
        let k = key(SessionScope::Live("act".into()), Tier::Fast);
        mgr.ensure(&k, init(&[])).await.unwrap();
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = seen.clone();
        let on_delta: OnDelta = Box::new(move |t: &str| sink.lock().unwrap().push(t.to_string()));
        let turn = mgr.ask(&k, "activity-slow", on_delta, Arc::new(CancelToken::new())).await.unwrap();
        // The activity token reached the caller, but the first-text clock waited for "a".
        assert!(crate::llm::cli_agent::session::is_activity(&seen.lock().unwrap()[0]));
        let first = turn.first_text_ms.expect("text arrived");
        assert!(first >= 25, "first text counted at {first} ms");
    }

    #[tokio::test]
    async fn ask_measures_latency_and_first_text_and_accumulates_them() {
        let (mgr, _spawner, sink) = setup();
        let scope = SessionScope::Live("m9".into());
        let k = key(scope.clone(), Tier::Fast);
        mgr.ensure(&k, init(&[])).await.unwrap();
        let before = epoch_ms();
        let turn = mgr.ask(&k, "slow", no_delta(), Arc::new(CancelToken::new())).await.unwrap();
        // The thinking signal (empty) does not count as the first text.
        let first = turn.first_text_ms.expect("text arrived");
        assert!(first >= 25, "first text after {first} ms");
        assert!(turn.latency_ms >= first + 25, "{} vs {first}", turn.latency_ms);

        let quick = mgr.ask(&k, "q", no_delta(), Arc::new(CancelToken::new())).await.unwrap();
        let usage = mgr.usage(&scope);
        assert_eq!(usage.requests, 2);
        assert_eq!(usage.total_latency_ms, turn.latency_ms + quick.latency_ms);
        assert_eq!(usage.total_first_token_ms, first + quick.first_text_ms.unwrap());
        assert_eq!(usage.last_latency_ms, quick.latency_ms);
        assert!(usage.last_request_at_ms >= before);
        // A failed turn adds nothing.
        let _ = mgr.ask(&k, "fail:x", no_delta(), Arc::new(CancelToken::new())).await;
        assert_eq!(mgr.usage(&scope).requests, 2);
        // The status event carries the scope total.
        let last_ok = sink.0.lock().unwrap().iter().rev().find(|s| s.state == "ready").cloned().unwrap();
        assert_eq!(last_ok.usage.requests, 2);
    }

    #[test]
    fn usage_add_turn_without_text_counts_its_latency_as_first_token() {
        let mut usage = SessionUsage::default();
        let turn = TurnResult { latency_ms: 900, first_text_ms: None, ..Default::default() };
        usage.add_turn(&turn, 42);
        assert_eq!((usage.total_first_token_ms, usage.last_request_at_ms), (900, 42));
    }

    #[tokio::test]
    async fn failed_turn_reports_its_error_kind_and_success_clears_it() {
        let (mgr, _spawner, sink) = setup();
        let k = key(SessionScope::Live("m1".into()), Tier::Fast);
        mgr.ensure(&k, init(&[])).await.unwrap();
        for (prompt, kind) in [
            ("cli:5-hour limit reached ∙ resets 3pm", "rate_limited"),
            ("cli:Please run /login", "not_logged_in"),
            ("cli:prompt is too long", "context_overflow"),
            ("cli:something odd", "other"),
        ] {
            let _ = mgr.ask(&k, prompt, no_delta(), Arc::new(CancelToken::new())).await;
            let last = sink.0.lock().unwrap().last().cloned().unwrap();
            assert_eq!(last.state, "error");
            assert_eq!(last.error_kind.as_deref(), Some(kind), "{prompt}");
            assert!(last.detail.is_some());
        }
        mgr.ask(&k, "fine", no_delta(), Arc::new(CancelToken::new())).await.unwrap();
        let last = sink.0.lock().unwrap().last().cloned().unwrap();
        assert_eq!((last.state.as_str(), last.detail, last.error_kind), ("ready", None, None));
    }

    #[tokio::test]
    async fn close_scope_closes_every_tier_of_that_scope_only() {
        let (mgr, spawner, sink) = setup();
        let live = SessionScope::Live("m1".into());
        mgr.ensure(&key(live.clone(), Tier::Fast), init(&[]))
            .await
            .unwrap();
        mgr.ensure(&key(live.clone(), Tier::Deep), init(&[]))
            .await
            .unwrap();
        mgr.ensure(&key(SessionScope::Utility, Tier::Fast), init(&[]))
            .await
            .unwrap();
        mgr.close_scope(&live).await;
        let closed: Vec<bool> = spawner
            .spawned
            .lock()
            .unwrap()
            .iter()
            .map(|(_, s)| s.closed.load(Ordering::SeqCst))
            .collect();
        assert_eq!(closed, vec![true, true, false]);
        assert_eq!(sink.states().iter().filter(|s| *s == "closed").count(), 2);
        let snap = mgr.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].scope, "utility");

        mgr.close_all().await;
        assert!(mgr.snapshot().is_empty());
        assert!(spawner.spawned.lock().unwrap()[2]
            .1
            .closed
            .load(Ordering::SeqCst));
        assert!(mgr
            .ensure(&key(SessionScope::Utility, Tier::Fast), init(&[]))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn reap_idle_closes_only_stale_past() {
        let (mgr, spawner, _sink) = setup();
        let stale = key(SessionScope::Past("old".into()), Tier::Deep);
        let fresh = key(SessionScope::Past("new".into()), Tier::Deep);
        let live = key(SessionScope::Live("m1".into()), Tier::Fast);
        let utility = key(SessionScope::Utility, Tier::Fast);
        for k in [&stale, &fresh, &live, &utility] {
            mgr.ensure(k, init(&[])).await.unwrap();
        }
        // 20 min from now: everything is 20 min idle except `fresh` (1 min).
        let now = Instant::now() + Duration::from_secs(20 * 60);
        mgr.entries
            .lock()
            .unwrap()
            .get_mut(&fresh)
            .unwrap()
            .last_used = now - Duration::from_secs(60);
        mgr.reap_idle(now).await;

        let closed: Vec<bool> = spawner
            .spawned
            .lock()
            .unwrap()
            .iter()
            .map(|(_, s)| s.closed.load(Ordering::SeqCst))
            .collect();
        assert_eq!(closed, vec![true, false, false, false]);
        let mut left: Vec<String> = mgr.snapshot().into_iter().map(|s| s.scope).collect();
        left.sort();
        assert_eq!(left, vec!["live", "past", "utility"]);

        // Touch keeps a past session alive.
        mgr.touch(&fresh);
        mgr.reap_idle(Instant::now() + Duration::from_secs(14 * 60))
            .await;
        assert!(!spawner.spawned.lock().unwrap()[1]
            .1
            .closed
            .load(Ordering::SeqCst));
    }

    fn in_flight(mgr: &AgentSessionManager, k: &SessionKey) -> usize {
        mgr.entries.lock().unwrap()[k].in_flight
    }

    #[tokio::test]
    async fn dropped_ask_releases_in_flight_and_busy() {
        let (mgr, spawner, sink) = setup();
        let k = key(SessionScope::Past("m3".into()), Tier::Deep);
        mgr.ensure(&k, init(&[])).await.unwrap();
        let dropped = tokio::time::timeout(
            Duration::from_millis(50),
            mgr.ask(&k, "block", no_delta(), Arc::new(CancelToken::new())),
        )
        .await;
        assert!(
            dropped.is_err(),
            "blocking ask should have been dropped by the timeout"
        );
        assert_eq!(in_flight(&mgr, &k), 0);
        assert_eq!(mgr.snapshot()[0].state, "ready");
        assert_eq!(sink.states(), vec!["starting", "ready", "busy", "ready"]);
        // No longer pinned in flight, so the reaper can close it once idle.
        mgr.reap_idle(Instant::now() + Duration::from_secs(20 * 60))
            .await;
        assert!(spawner.spawned.lock().unwrap()[0]
            .1
            .closed
            .load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn reap_idle_keeps_past_session_with_turn_in_flight() {
        let (mgr, spawner, _sink) = setup();
        let k = key(SessionScope::Past("m4".into()), Tier::Deep);
        mgr.ensure(&k, init(&[])).await.unwrap();
        let now = Instant::now() + Duration::from_secs(20 * 60);
        let ask = mgr.ask(&k, "block", no_delta(), Arc::new(CancelToken::new()));
        tokio::pin!(ask);
        tokio::select! {
            biased;
            _ = &mut ask => panic!("blocking ask finished"),
            _ = async {
                // Let the ask register as in flight, then reap 20 min later.
                tokio::task::yield_now().await;
                assert_eq!(in_flight(&mgr, &k), 1);
                mgr.reap_idle(now).await;
            } => {}
        }
        assert!(!spawner.spawned.lock().unwrap()[0]
            .1
            .closed
            .load(Ordering::SeqCst));
        assert_eq!(mgr.snapshot().len(), 1);
    }

    #[tokio::test]
    async fn success_after_concurrent_failure_returns_to_ready() {
        let (mgr, _spawner, _sink) = setup();
        let k = key(SessionScope::Utility, Tier::Fast);
        mgr.ensure(&k, init(&[])).await.unwrap();
        let cancel = || Arc::new(CancelToken::new());
        let (ok, failed) = tokio::join!(mgr.ask(&k, "yield", no_delta(), cancel()), async {
            // Fails while the first turn is still in flight.
            assert_eq!(in_flight(&mgr, &k), 1);
            mgr.ask(&k, "fail:boom", no_delta(), cancel()).await
        });
        assert!(ok.is_ok() && failed.is_err());
        let snap = mgr.snapshot();
        assert_eq!(snap[0].state, "ready");
        assert_eq!(snap[0].detail, None);
    }

    #[tokio::test]
    async fn ensure_replaces_errored_utility_session_only() {
        let (mgr, spawner, _sink) = setup();
        let utility = key(SessionScope::Utility, Tier::Fast);
        let live = key(SessionScope::Live("m1".into()), Tier::Fast);
        for k in [&utility, &live] {
            mgr.ensure(k, init(&[])).await.unwrap();
            let failed = mgr
                .ask(k, "fail:prompt too long", no_delta(), Arc::new(CancelToken::new()))
                .await;
            assert!(failed.is_err());
        }
        assert_eq!(spawner.calls.load(Ordering::SeqCst), 2);

        // Utility: the errored (still alive) session is closed and replaced.
        mgr.ensure(&utility, init(&[])).await.unwrap();
        assert_eq!(spawner.calls.load(Ordering::SeqCst), 3);
        assert!(spawner.spawned.lock().unwrap()[0].1.closed.load(Ordering::SeqCst));
        // Live: the caller owns the restart (context replay); it is reused.
        mgr.ensure(&live, init(&[])).await.unwrap();
        assert_eq!(spawner.calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn turns_count_and_retire_if_idle() {
        let (mgr, spawner, sink) = setup();
        let k = key(SessionScope::Utility, Tier::Fast);
        assert_eq!(mgr.turns(&k), 0);
        assert!(mgr.retire_if_idle(&k).is_none());
        mgr.ensure(&k, init(&[])).await.unwrap();
        for q in ["a", "b"] {
            mgr.ask(&k, q, no_delta(), Arc::new(CancelToken::new())).await.unwrap();
        }
        assert_eq!(mgr.turns(&k), 2);

        let retired = mgr.retire_if_idle(&k).expect("idle session is retired");
        assert_eq!(sink.states().last().map(String::as_str), Some("closed"));
        assert!(mgr.snapshot().is_empty());
        assert_eq!(mgr.turns(&k), 0);
        assert_eq!(mgr.usage(&SessionScope::Utility).input_tokens, 20, "usage kept");
        retired.close().await;

        mgr.ensure(&k, init(&[])).await.unwrap();
        assert_eq!(spawner.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn retire_if_idle_skips_session_with_turn_in_flight() {
        let (mgr, _spawner, _sink) = setup();
        let k = key(SessionScope::Utility, Tier::Fast);
        mgr.ensure(&k, init(&[])).await.unwrap();
        let blocked = mgr.ask(&k, "block", no_delta(), Arc::new(CancelToken::new()));
        tokio::pin!(blocked);
        assert!(futures::poll!(blocked.as_mut()).is_pending());
        assert!(mgr.retire_if_idle(&k).is_none());
        assert_eq!(mgr.snapshot().len(), 1);
    }

    // ---- per-session overrides, new scopes, graceful close ----

    fn over(kind: Option<CliAgentKind>, model: &str, effort: &str) -> Option<SessionOverride> {
        Some(SessionOverride {
            kind,
            model: Some(model).filter(|m| !m.is_empty()).map(str::to_string),
            effort: Some(effort).filter(|e| !e.is_empty()).map(str::to_string),
            thinking: None,
        })
    }

    #[tokio::test]
    async fn a_session_with_its_own_kind_survives_a_provider_switch() {
        let (mgr, spawner, _sink) = setup();
        let chat = key(SessionScope::Workspace("c1".into()), Tier::Deep);
        let live = key(SessionScope::Live("m".into()), Tier::Fast);
        mgr.settings().set_active(CliAgentKind::Claude);
        mgr.ensure(&live, init(&[])).await.unwrap();
        mgr.ensure_with(&chat, init(&[]), over(Some(CliAgentKind::Codex), "gpt-x", "high")).await.unwrap();

        mgr.settings().set_active(CliAgentKind::Antigravity);
        assert_eq!(mgr.close_other_kinds().await, 1, "only the live Claude session follows the switch");
        let scopes: Vec<_> = mgr.snapshot().iter().map(|s| s.scope.clone()).collect();
        assert_eq!(scopes, vec!["workspace"]);

        // The chat keeps its session, and still asks.
        mgr.ensure_with(&chat, init(&[]), over(Some(CliAgentKind::Codex), "gpt-x", "high")).await.unwrap();
        assert_eq!(spawner.calls.load(Ordering::SeqCst), 2);
        let r = mgr.ask(&chat, "hi", no_delta(), Arc::new(CancelToken::new())).await.unwrap();
        assert_eq!(r.text, "hi");
        assert_eq!(mgr.settings().active(), CliAgentKind::Antigravity, "the active kind is untouched by the chat");
    }

    #[tokio::test]
    async fn without_a_kind_override_a_session_still_follows_the_active_provider() {
        let (mgr, _spawner, _sink) = setup();
        let chat = key(SessionScope::Workspace("c1".into()), Tier::Deep);
        // A model-only override pins nothing.
        mgr.ensure_with(&chat, init(&[]), over(None, "opus", "")).await.unwrap();
        mgr.settings().set_active(CliAgentKind::Codex);
        assert_eq!(mgr.close_other_kinds().await, 1);
    }

    #[tokio::test]
    async fn override_model_effort_and_thinking_reach_the_spawner_and_a_change_replaces_the_session() {
        let (mgr, spawner, _sink) = setup();
        let chat = key(SessionScope::Workspace("c1".into()), Tier::Deep);
        let o = SessionOverride {
            kind: Some(CliAgentKind::Claude),
            model: Some("opus".into()),
            effort: Some("high".into()),
            thinking: Some(true),
        };
        let a = mgr.ensure_with(&chat, init(&[]), Some(o.clone())).await.unwrap();
        let again = mgr.ensure_with(&chat, init(&[]), Some(o.clone())).await.unwrap();
        assert!(same_session(&a, &again), "the same override reuses the session");
        {
            let spawned = spawner.spawned.lock().unwrap();
            let cfg = &spawned[0].0;
            assert_eq!((cfg.kind, cfg.model.as_str(), cfg.thinking), (CliAgentKind::Claude, "opus", true));
        }
        let o2 = SessionOverride { model: Some("sonnet".into()), ..o };
        let b = mgr.ensure_with(&chat, init(&[]), Some(o2)).await.unwrap();
        assert!(!same_session(&a, &b));
        assert_eq!(spawner.calls.load(Ordering::SeqCst), 2);
        assert!(spawner.spawned.lock().unwrap()[0].1.closed.load(Ordering::SeqCst), "the old one was closed");
        // An empty override is no override.
        let (mgr2, spawner2, _) = setup();
        let k = key(SessionScope::Utility, Tier::Fast);
        mgr2.ensure_with(&k, init(&[]), Some(SessionOverride::default())).await.unwrap();
        mgr2.ensure(&k, init(&[])).await.unwrap();
        assert_eq!(spawner2.calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn the_new_scopes_have_labels_ids_and_default_tiers() {
        let cfg = ClaudeCliConfig::default();
        for (scope, label, meeting, chat) in [
            (SessionScope::Workspace("c".into()), "workspace", None, Some("c")),
            (SessionScope::Notes("m".into()), "notes", Some("m"), None),
            (SessionScope::Brief("m".into()), "brief", Some("m"), None),
        ] {
            assert_eq!(scope.label(), label);
            assert_eq!(scope.meeting_id().as_deref(), meeting);
            assert_eq!(scope.chat_id(), chat);
            let tier = tier_for("Assist", &scope, &cfg);
            assert_eq!(tier, if label == "workspace" { Tier::Deep } else { Tier::Fast });
        }
    }

    #[tokio::test]
    async fn status_reports_the_chat_id_for_a_workspace_session() {
        let (mgr, _s, sink) = setup();
        mgr.ensure(&key(SessionScope::Workspace("chat-7".into()), Tier::Deep), init(&[])).await.unwrap();
        let rows = sink.0.lock().unwrap();
        let last = rows.last().unwrap();
        assert_eq!(
            (last.scope.as_str(), last.chat_id.as_deref(), last.meeting_id.as_deref()),
            ("workspace", Some("chat-7"), None)
        );
        let old: AgentSessionStatus = serde_json::from_str(
            r#"{"scope":"live","meeting_id":"m","tier":"fast","state":"ready","model":"h","detail":null,"usage":{}}"#,
        )
        .unwrap();
        assert_eq!(old.chat_id, None);
    }

    #[tokio::test]
    async fn workspace_sessions_are_reaped_at_fifteen_minutes_and_notes_much_later() {
        let (mgr, _s, _sink) = setup();
        let chat = key(SessionScope::Workspace("c".into()), Tier::Deep);
        let notes = key(SessionScope::Notes("m".into()), Tier::Fast);
        let brief = key(SessionScope::Brief("m".into()), Tier::Fast);
        let live = key(SessionScope::Live("m".into()), Tier::Fast);
        for k in [&chat, &notes, &brief, &live] {
            mgr.ensure(k, init(&[])).await.unwrap();
        }
        let t0 = Instant::now();
        mgr.reap_idle(t0 + Duration::from_secs(14 * 60)).await;
        assert_eq!(mgr.snapshot().len(), 4);
        mgr.reap_idle(t0 + Duration::from_secs(16 * 60)).await;
        let left: Vec<_> = mgr.snapshot().iter().map(|s| s.scope.clone()).collect();
        assert_eq!(left, vec!["live", "notes", "brief"], "the chat went; notes, brief and live stay");
        mgr.reap_idle(t0 + Duration::from_secs(3 * 60 * 60)).await;
        let left: Vec<_> = mgr.snapshot().iter().map(|s| s.scope.clone()).collect();
        assert_eq!(left, vec!["live"], "a live meeting session is never reaped");
    }

    #[tokio::test]
    async fn a_workspace_session_with_a_turn_in_flight_is_not_reaped() {
        let (mgr, _s, _sink) = setup();
        let chat = key(SessionScope::Workspace("c".into()), Tier::Deep);
        mgr.ensure(&chat, init(&[])).await.unwrap();
        let blocked = mgr.ask(&chat, "block", no_delta(), Arc::new(CancelToken::new()));
        tokio::pin!(blocked);
        assert!(futures::poll!(blocked.as_mut()).is_pending());
        mgr.reap_idle(Instant::now() + Duration::from_secs(60 * 60)).await;
        assert_eq!(mgr.snapshot().len(), 1);
    }

    #[tokio::test]
    async fn notes_and_brief_end_with_their_meeting_and_a_chat_with_its_scope() {
        let (mgr, spawner, _sink) = setup();
        for scope in [SessionScope::Notes("m".into()), SessionScope::Brief("m".into()), SessionScope::Workspace("c".into())] {
            mgr.ensure(&key(scope, Tier::Fast), init(&[])).await.unwrap();
        }
        mgr.close_scope(&SessionScope::Notes("m".into())).await;
        mgr.close_scope(&SessionScope::Brief("m".into())).await;
        assert_eq!(mgr.snapshot().len(), 1);
        mgr.close_scope(&SessionScope::Workspace("c".into())).await;
        assert!(mgr.snapshot().is_empty());
        assert!(spawner.spawned.lock().unwrap().iter().all(|(_, s)| s.closed.load(Ordering::SeqCst)));
    }

    #[tokio::test]
    async fn a_graceful_close_lets_the_turn_in_flight_finish_then_closes_and_keeps_usage() {
        let (mgr, spawner, sink) = setup();
        let mgr = Arc::new(mgr);
        let scope = SessionScope::Workspace("c".into());
        let k = key(scope.clone(), Tier::Deep);
        mgr.ensure(&k, init(&[])).await.unwrap();
        let turn = tokio::spawn({
            let (mgr, k) = (mgr.clone(), k.clone());
            async move { mgr.ask(&k, "slow", no_delta(), Arc::new(CancelToken::new())).await }
        });
        tokio::time::sleep(Duration::from_millis(15)).await;
        let started = Instant::now();
        mgr.close_scope_graceful(&scope, DRAIN_TIMEOUT).await;
        assert!(started.elapsed() >= Duration::from_millis(20), "it waited for the turn");
        assert!(started.elapsed() < Duration::from_secs(3));
        let done = turn.await.unwrap().expect("the turn in flight was delivered");
        assert_eq!(done.text, "slow");
        assert!(spawner.spawned.lock().unwrap()[0].1.closed.load(Ordering::SeqCst));
        assert!(mgr.snapshot().is_empty());
        assert_eq!(mgr.usage(&scope).requests, 1, "usage is kept (a restart is not an ending)");
        assert_eq!(sink.states().last().map(String::as_str), Some("closed"));
    }

    #[tokio::test]
    async fn a_graceful_close_is_bounded_when_a_turn_never_ends() {
        let (mgr, spawner, _sink) = setup();
        let mgr = Arc::new(mgr);
        let k = key(SessionScope::Workspace("c".into()), Tier::Deep);
        mgr.ensure(&k, init(&[])).await.unwrap();
        let _stuck = tokio::spawn({
            let (mgr, k) = (mgr.clone(), k.clone());
            async move { mgr.ask(&k, "block", no_delta(), Arc::new(CancelToken::new())).await }
        });
        tokio::time::sleep(Duration::from_millis(15)).await;
        let started = Instant::now();
        mgr.close_key_graceful(&k, Duration::from_millis(120)).await;
        let took = started.elapsed();
        assert!(took >= Duration::from_millis(100) && took < Duration::from_secs(2), "{took:?}");
        assert!(spawner.spawned.lock().unwrap()[0].1.closed.load(Ordering::SeqCst), "then it is killed");
    }

    #[tokio::test]
    async fn a_draining_session_takes_no_new_turn_and_a_graceful_close_of_nothing_is_fine() {
        let (mgr, _s, _sink) = setup();
        let mgr = Arc::new(mgr);
        let k = key(SessionScope::Workspace("c".into()), Tier::Deep);
        mgr.close_key_graceful(&k, Duration::from_millis(10)).await;
        mgr.ensure(&k, init(&[])).await.unwrap();
        let slow = tokio::spawn({
            let (mgr, k) = (mgr.clone(), k.clone());
            async move { mgr.ask(&k, "slow", no_delta(), Arc::new(CancelToken::new())).await }
        });
        tokio::time::sleep(Duration::from_millis(10)).await;
        let closing = tokio::spawn({
            let (mgr, k) = (mgr.clone(), k.clone());
            async move { mgr.close_key_graceful(&k, DRAIN_TIMEOUT).await }
        });
        tokio::time::sleep(Duration::from_millis(10)).await;
        let late = mgr.ask(&k, "hello", no_delta(), Arc::new(CancelToken::new())).await;
        assert!(matches!(late, Err(AgentError::Crashed(ref m)) if m.contains("restarting")), "{late:?}");
        slow.await.unwrap().unwrap();
        closing.await.unwrap();
    }

    #[tokio::test]
    async fn a_detached_scope_gives_a_new_session_at_once_while_the_old_turn_finishes_and_is_then_closed() {
        let (mgr, spawner, _sink) = setup();
        let mgr = Arc::new(mgr);
        let scope = SessionScope::Live("m".into());
        let k = key(scope.clone(), Tier::Fast);
        mgr.ensure(&k, init(&[])).await.unwrap();
        // A turn that never ends on the old session.
        let stuck = tokio::spawn({
            let (mgr, k) = (mgr.clone(), k.clone());
            async move { mgr.ask(&k, "block", no_delta(), Arc::new(CancelToken::new())).await }
        });
        tokio::time::sleep(Duration::from_millis(15)).await;
        assert_eq!(mgr.detach_scope(&scope), 1);
        // The drain is waiting (it holds nothing a new ask needs) ...
        let drain = tokio::spawn({
            let (mgr, scope) = (mgr.clone(), scope.clone());
            async move { mgr.close_retired_graceful(&scope, Duration::from_millis(400)).await }
        });
        tokio::time::sleep(Duration::from_millis(10)).await;
        // ... and a live ask arriving now gets a new session without waiting for it.
        let started = Instant::now();
        mgr.ensure(&k, init(&["new documents"])).await.unwrap();
        let answer = mgr.ask(&k, "hello", no_delta(), Arc::new(CancelToken::new())).await.unwrap();
        assert_eq!(answer.text, "hello");
        assert!(started.elapsed() < Duration::from_millis(150), "not queued behind the drain: {:?}", started.elapsed());
        let spawned = spawner.spawned.lock().unwrap();
        assert_eq!(spawned.len(), 2);
        assert!(!spawned[1].1.closed.load(Ordering::SeqCst), "the new session is untouched");
        assert!(spawned[1].1.appended.lock().unwrap().iter().any(|m| m == "new documents"));
        drop(spawned);
        // The old turn is cut at the bound and only the old session closes.
        drain.await.unwrap();
        let spawned = spawner.spawned.lock().unwrap();
        assert!(spawned[0].1.closed.load(Ordering::SeqCst));
        assert!(!spawned[1].1.closed.load(Ordering::SeqCst));
        drop(spawned);
        stuck.abort();
        assert_eq!(mgr.snapshot().len(), 1);
    }

    #[tokio::test]
    async fn a_detached_session_closes_right_after_its_turn_when_that_ends_before_the_bound() {
        let (mgr, spawner, _sink) = setup();
        let mgr = Arc::new(mgr);
        let scope = SessionScope::Live("m".into());
        let k = key(scope.clone(), Tier::Fast);
        mgr.ensure(&k, init(&[])).await.unwrap();
        let turn = tokio::spawn({
            let (mgr, k) = (mgr.clone(), k.clone());
            async move { mgr.ask(&k, "slow", no_delta(), Arc::new(CancelToken::new())).await }
        });
        tokio::time::sleep(Duration::from_millis(15)).await;
        mgr.detach_scope(&scope);
        let started = Instant::now();
        mgr.close_retired_graceful(&scope, DRAIN_TIMEOUT).await;
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(turn.await.unwrap().unwrap().text, "slow", "the turn in flight was delivered");
        assert!(spawner.spawned.lock().unwrap()[0].1.closed.load(Ordering::SeqCst));
        // Nothing is left to detach or close.
        assert_eq!(mgr.detach_scope(&scope), 0);
    }

    // ---- a scope restart never lets a session start from a record built before it ----

    fn live_key() -> (SessionScope, SessionKey) {
        let scope = SessionScope::Live("m".into());
        let k = key(scope.clone(), Tier::Fast);
        (scope, k)
    }

    /// Starts `ensure_at` for `k` (built at generation `generation`) in a task.
    fn start_at(
        mgr: &Arc<AgentSessionManager>,
        k: &SessionKey,
        preload: &[&str],
        generation: u64,
    ) -> tokio::task::JoinHandle<Result<Arc<dyn SessionHandle>, AgentError>> {
        let (mgr, k, init) = (mgr.clone(), k.clone(), init(preload));
        tokio::spawn(async move { mgr.ensure_at(&k, init, None, Some(generation)).await })
    }

    fn stale(result: &Result<Arc<dyn SessionHandle>, AgentError>) -> bool {
        matches!(result, Err(e) if is_scope_changed(e))
    }

    #[tokio::test]
    async fn a_detach_before_the_spawn_stops_the_old_record_from_starting_anything() {
        let (mgr, spawner, _sink) = setup();
        let mgr = Arc::new(mgr);
        let (scope, k) = live_key();
        let built_at = mgr.generation(&scope);
        mgr.detach_scope(&scope);
        let result = mgr.ensure_at(&k, init(&["OLD DOCUMENTS"]), None, Some(built_at)).await;
        assert!(stale(&result));
        assert_eq!(spawner.calls.load(Ordering::SeqCst), 0, "nothing was started");
        // A record built after the detach starts normally.
        let fresh = mgr.ensure_at(&k, init(&["NEW DOCUMENTS"]), None, Some(mgr.generation(&scope))).await.unwrap();
        assert!(fresh.is_alive());
        assert_eq!(spawner.spawned.lock().unwrap()[0].1.appended.lock().unwrap()[0], "NEW DOCUMENTS");
    }

    #[tokio::test]
    async fn a_detach_while_the_spawn_is_starting_closes_that_session_and_inserts_nothing() {
        let (mgr, spawner, _sink) = setup();
        let mgr = Arc::new(mgr);
        let (scope, k) = live_key();
        let gate = Arc::new(TestGate::default());
        *spawner.gate_start.lock().unwrap() = Some(gate.clone());
        let task = start_at(&mgr, &k, &["OLD"], mgr.generation(&scope));
        gate.entered.notified().await;
        mgr.detach_scope(&scope);
        gate.release.notify_one();
        assert!(stale(&task.await.unwrap()));
        assert!(spawner.spawned.lock().unwrap()[0].1.closed.load(Ordering::SeqCst), "the stale session is closed");
        assert!(mgr.snapshot().is_empty(), "and never inserted");
    }

    #[tokio::test]
    async fn a_detach_after_the_spawn_but_before_the_insert_is_caught_too() {
        let (mgr, spawner, _sink) = setup();
        let mgr = Arc::new(mgr);
        let (scope, k) = live_key();
        let gate = Arc::new(TestGate::default());
        *spawner.gate_end.lock().unwrap() = Some(gate.clone());
        let task = start_at(&mgr, &k, &[], mgr.generation(&scope));
        gate.entered.notified().await;
        mgr.detach_scope(&scope);
        gate.release.notify_one();
        assert!(stale(&task.await.unwrap()));
        assert!(spawner.spawned.lock().unwrap()[0].1.closed.load(Ordering::SeqCst));
        assert!(mgr.snapshot().is_empty());
    }

    #[tokio::test]
    async fn a_detach_during_the_warm_up_is_caught() {
        let (mgr, spawner, _sink) = setup();
        let mgr = Arc::new(mgr);
        let (scope, k) = live_key();
        let gate = Arc::new(TestGate::default());
        *spawner.gate_warm.lock().unwrap() = Some(gate.clone());
        let task = start_at(&mgr, &k, &["OLD DOCUMENTS"], mgr.generation(&scope));
        gate.entered.notified().await;
        mgr.detach_scope(&scope);
        gate.release.notify_one();
        assert!(stale(&task.await.unwrap()));
        assert!(spawner.spawned.lock().unwrap()[0].1.closed.load(Ordering::SeqCst));
        assert!(mgr.snapshot().is_empty());
    }

    #[tokio::test]
    async fn two_detaches_in_a_row_leave_only_a_record_built_after_the_second_usable() {
        let (mgr, spawner, _sink) = setup();
        let mgr = Arc::new(mgr);
        let (scope, k) = live_key();
        let first = mgr.generation(&scope);
        mgr.detach_scope(&scope);
        let between = mgr.generation(&scope);
        let gate = Arc::new(TestGate::default());
        *spawner.gate_start.lock().unwrap() = Some(gate.clone());
        let task = start_at(&mgr, &k, &["BETWEEN"], between);
        gate.entered.notified().await;
        mgr.detach_scope(&scope);
        gate.release.notify_one();
        assert!(stale(&task.await.unwrap()), "built between the two detaches");
        assert!(stale(&mgr.ensure_at(&k, init(&[]), None, Some(first)).await));
        let last = mgr.generation(&scope);
        assert!(last > between && between > first);
        mgr.ensure_at(&k, init(&["LAST"]), None, Some(last)).await.unwrap();
        assert_eq!(mgr.snapshot().len(), 1);
        let spawned = spawner.spawned.lock().unwrap();
        assert!(spawned[0].1.closed.load(Ordering::SeqCst) && !spawned[1].1.closed.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn an_old_record_cannot_pick_up_the_newer_session_that_took_the_key() {
        let (mgr, spawner, _sink) = setup();
        let mgr = Arc::new(mgr);
        let (scope, k) = live_key();
        let old = mgr.generation(&scope);
        mgr.detach_scope(&scope);
        let new_handle = mgr.ensure_at(&k, init(&["NEW"]), None, Some(mgr.generation(&scope))).await.unwrap();
        assert!(stale(&mgr.ensure_at(&k, init(&["OLD"]), None, Some(old)).await));
        assert_eq!(spawner.calls.load(Ordering::SeqCst), 1);
        assert!(new_handle.is_alive(), "the newer session is untouched");
        // Retiring "by handle" leaves a newer session alone and removes the one it names.
        let other: Arc<dyn SessionHandle> = Arc::new(FakeSession {
            model: "x".into(),
            alive: AtomicBool::new(true),
            closed: AtomicBool::new(false),
            appended: Mutex::new(Vec::new()),
            warm: Mutex::new(None),
        });
        assert!(mgr.retire_handle_if_idle(&k, &other).is_none());
        assert_eq!(mgr.snapshot().len(), 1);
        assert!(mgr.retire_handle_if_idle(&k, &new_handle).is_some());
        assert!(mgr.snapshot().is_empty());
    }

    #[tokio::test]
    async fn every_way_of_closing_a_scope_moves_its_generation() {
        let (mgr, _spawner, _sink) = setup();
        let scope = SessionScope::Workspace("c".into());
        let k = key(scope.clone(), Tier::Deep);
        let mut last = mgr.generation(&scope);
        let with_sources = SessionKey::sources(scope.clone(), Tier::Deep);
        let sources_before = mgr.generation_for(&with_sources);
        mgr.close_sources(&scope).await;
        assert!(mgr.generation_for(&with_sources) > sources_before, "a with-sources start built earlier is stale");
        assert_eq!(mgr.generation(&scope), last, "plain sessions and their records are not affected");
        last = mgr.generation(&scope);
        mgr.close_scope_graceful(&scope, Duration::from_millis(10)).await;
        assert!(mgr.generation(&scope) > last);
        last = mgr.generation(&scope);
        mgr.close_key_graceful(&k, Duration::from_millis(10)).await;
        assert!(mgr.generation(&scope) > last);
        // Another scope's generation did not move.
        assert_eq!(mgr.generation(&SessionScope::Live("m".into())), 0);
    }

    #[tokio::test]
    async fn an_ask_after_the_detach_never_reaches_the_old_session() {
        let (mgr, spawner, _sink) = setup();
        let mgr = Arc::new(mgr);
        let (scope, k) = live_key();
        mgr.ensure(&k, init(&["old"])).await.unwrap();
        mgr.detach_scope(&scope);
        // No session at the key: the ask fails instead of using the retired one.
        let late = mgr.ask(&k, "hello", no_delta(), Arc::new(CancelToken::new())).await;
        assert!(late.is_err());
        mgr.ensure(&k, init(&["new"])).await.unwrap();
        let answer = mgr.ask(&k, "hello", no_delta(), Arc::new(CancelToken::new())).await.unwrap();
        assert_eq!(answer.text, "hello");
        let spawned = spawner.spawned.lock().unwrap();
        assert!(spawned[1].1.appended.lock().unwrap().iter().any(|m| m == "new"));
        drop(spawned);
        mgr.close_retired_graceful(&scope, Duration::from_millis(50)).await;
    }

    #[tokio::test]
    async fn recycle_after_n_turns_replaces_an_idle_session_and_keeps_usage() {
        let (mgr, spawner, _sink) = setup();
        let k = key(SessionScope::Notes("m".into()), Tier::Fast);
        mgr.ensure(&k, init(&[])).await.unwrap();
        assert!(!mgr.recycle_after(&k, 2).await, "no turns yet");
        mgr.ask(&k, "a", no_delta(), Arc::new(CancelToken::new())).await.unwrap();
        assert!(!mgr.recycle_after(&k, 2).await);
        mgr.ask(&k, "b", no_delta(), Arc::new(CancelToken::new())).await.unwrap();
        assert!(mgr.recycle_after(&k, 2).await);
        assert!(spawner.spawned.lock().unwrap()[0].1.closed.load(Ordering::SeqCst));
        assert_eq!(mgr.usage(&SessionScope::Notes("m".into())).requests, 2, "usage kept");
        mgr.ensure(&k, init(&[])).await.unwrap();
        assert_eq!(spawner.calls.load(Ordering::SeqCst), 2);
        assert_eq!(mgr.turns(&k), 0);
    }

    #[tokio::test]
    async fn the_closed_hook_runs_for_every_way_a_session_leaves() {
        let (mgr, _s, _sink) = setup();
        let seen: Arc<Mutex<Vec<SessionKey>>> = Arc::default();
        let target = seen.clone();
        mgr.set_closed_hook(Arc::new(move |k: &SessionKey| target.lock().unwrap().push(k.clone())));
        let a = key(SessionScope::Workspace("a".into()), Tier::Deep);
        let b = key(SessionScope::Workspace("b".into()), Tier::Deep);
        let c = key(SessionScope::Notes("m".into()), Tier::Fast);
        for k in [&a, &b, &c] {
            mgr.ensure(k, init(&[])).await.unwrap();
        }
        mgr.close_scope(&SessionScope::Workspace("a".into())).await; // explicit close
        mgr.touch(&c);
        mgr.reap_idle(Instant::now() + Duration::from_secs(16 * 60)).await; // idle reap of b (a is gone)
        let retired = mgr.retire_if_idle(&c).unwrap(); // retire
        retired.close().await;
        assert_eq!(*seen.lock().unwrap(), vec![a, b, c]);
    }

    #[tokio::test]
    async fn workspace_notes_and_brief_sessions_are_replaced_after_a_failed_turn() {
        let (mgr, spawner, _sink) = setup();
        for scope in [SessionScope::Workspace("c".into()), SessionScope::Notes("m".into()), SessionScope::Brief("m".into())] {
            let k = key(scope, Tier::Fast);
            mgr.ensure(&k, init(&[])).await.unwrap();
            let _ = mgr.ask(&k, "fail:context too long", no_delta(), Arc::new(CancelToken::new())).await;
            mgr.ensure(&k, init(&[])).await.unwrap();
        }
        assert_eq!(spawner.calls.load(Ordering::SeqCst), 6, "each was started again");
        // A live session in error is kept (restarting it means replaying context).
        let live = key(SessionScope::Live("m".into()), Tier::Fast);
        mgr.ensure(&live, init(&[])).await.unwrap();
        let _ = mgr.ask(&live, "fail:x", no_delta(), Arc::new(CancelToken::new())).await;
        mgr.ensure(&live, init(&[])).await.unwrap();
        assert_eq!(spawner.calls.load(Ordering::SeqCst), 7);
    }

    #[tokio::test]
    async fn existing_sessions_keep_their_behaviour_without_overrides() {
        // The same calls as before the overrides existed: reuse, restart on a dead
        // process, and a kind switch replacing the session.
        let (mgr, spawner, _sink) = setup();
        let k = key(SessionScope::Past("m".into()), Tier::Deep);
        let a = mgr.ensure(&k, init(&["ctx"])).await.unwrap();
        let b = mgr.ensure(&k, init(&["ctx"])).await.unwrap();
        assert!(same_session(&a, &b));
        a.close().await;
        let c = mgr.ensure(&k, init(&["ctx"])).await.unwrap();
        assert!(!same_session(&a, &c));
        mgr.settings().set_active(CliAgentKind::Codex);
        let d = mgr.ensure(&k, init(&["ctx"])).await.unwrap();
        assert!(!same_session(&c, &d));
        assert_eq!(spawner.calls.load(Ordering::SeqCst), 3);
    }
}
