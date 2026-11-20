//! `AgentSessionManager`: the Claude CLI sessions NexQ keeps open, keyed by
//! meeting scope and model tier.
//!
//! - Lazy start: `ensure` spawns (once per key, even under concurrent calls)
//!   and preloads a session, and restarts one that died.
//! - Each session has a delta cursor so a request only sends transcript
//!   segments the session has not seen yet; it resets when the session is
//!   (re)started.
//! - Past-meeting sessions close after 15 min without AI activity
//!   (`reap_idle`, driven by `run_idle_reaper` every 60 s).
//! - Every state transition is reported through a [`StatusSink`]
//!   (`agent_session_status` in the app).
//!
//! Sessions are stored as `Arc<dyn SessionHandle>` and created by a
//! [`SessionSpawner`], so the manager is testable without a process.

use super::command::{SessionConfig, SourcesLaunch};
use super::context::DeltaCursor;
use super::detect::find_claude_binary;
use super::models::{effective_effort, ModelCatalog};
use super::protocol::{AgentErrorKind, ImageAttachment, TurnResult};
use super::session::{failed_mcp_servers, AgentError, ClaudeSession, InitInfo, SessionTimeouts};
use crate::llm::provider::CancelToken;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

/// Past-meeting sessions idle this long are closed.
pub const PAST_IDLE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
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
}

impl SessionScope {
    fn label(&self) -> &'static str {
        match self {
            SessionScope::Live(_) => "live",
            SessionScope::Past(_) => "past",
            SessionScope::Utility => "utility",
        }
    }

    fn meeting_id(&self) -> Option<String> {
        match self {
            SessionScope::Live(id) | SessionScope::Past(id) => Some(id.clone()),
            SessionScope::Utility => None,
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

/// Claude CLI model settings (persisted by the settings UI).
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
    /// Provider id used when Claude is unavailable; `None` = no fallback.
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
    }
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
    /// `"live"` | `"past"` | `"utility"`.
    pub scope: String,
    pub meeting_id: Option<String>,
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

/// What the manager needs from a running session ([`ClaudeSession`] in the
/// app, fakes in tests).
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
                "This Claude session can't take images".to_string(),
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
}

/// Starts sessions for the manager.
#[async_trait]
pub trait SessionSpawner: Send + Sync {
    async fn spawn(&self, cfg: SessionConfig) -> Result<Arc<dyn SessionHandle>, AgentError>;
}

/// Spawns real `claude.exe` sessions (binary resolved on every spawn, so a
/// fresh install is picked up without restarting NexQ).
pub struct ClaudeSpawner;

#[async_trait]
impl SessionSpawner for ClaudeSpawner {
    async fn spawn(&self, cfg: SessionConfig) -> Result<Arc<dyn SessionHandle>, AgentError> {
        let bin = tokio::task::spawn_blocking(find_claude_binary)
            .await
            .ok()
            .flatten()
            .ok_or_else(|| {
                AgentError::Spawn("Claude CLI not installed: claude.exe not found".into())
            })?;
        let timeouts = if cfg.sources.is_some() {
            SessionTimeouts { init: SOURCES_INIT_TIMEOUT, ..SessionTimeouts::default() }
        } else {
            SessionTimeouts::default()
        };
        Ok(Arc::new(ClaudeSession::spawn_with_timeouts(bin, cfg, timeouts).await?))
    }
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
    state: SessionState,
    error: Option<TurnError>,
    last_used: Instant,
    in_flight: usize,
    /// Turns finished on this session (any outcome).
    turns: usize,
    /// What a with-sources session came up without (see
    /// [`AgentSessionStatus::sources_notice`]).
    sources_notice: Option<String>,
}

pub struct AgentSessionManager {
    spawner: Arc<dyn SessionSpawner>,
    sink: Arc<dyn StatusSink>,
    config: Arc<RwLock<ClaudeCliConfig>>,
    /// Which efforts each model accepts (`--effort` is clamped to it).
    catalog: Arc<ModelCatalog>,
    entries: Mutex<HashMap<SessionKey, Entry>>,
    /// Serializes spawning per key so concurrent `ensure`s start one session.
    spawn_locks: Mutex<HashMap<SessionKey, Arc<AsyncMutex<()>>>>,
    cursors: Mutex<HashMap<SessionKey, Arc<AsyncMutex<DeltaCursor>>>>,
    usage: Mutex<HashMap<SessionScope, SessionUsage>>,
    shutting_down: AtomicBool,
}

impl AgentSessionManager {
    pub fn new(
        spawner: Arc<dyn SessionSpawner>,
        sink: Arc<dyn StatusSink>,
        config: Arc<RwLock<ClaudeCliConfig>>,
    ) -> Self {
        Self {
            spawner,
            sink,
            config,
            catalog: Arc::new(ModelCatalog::default()),
            entries: Mutex::new(HashMap::new()),
            spawn_locks: Mutex::new(HashMap::new()),
            cursors: Mutex::new(HashMap::new()),
            usage: Mutex::new(HashMap::new()),
            shutting_down: AtomicBool::new(false),
        }
    }

    /// Clamp `--effort` to what each model accepts, per `catalog` (the app
    /// passes the catalog the CLI reported). Without one the saved effort is
    /// passed as is.
    pub fn with_catalog(mut self, catalog: Arc<ModelCatalog>) -> Self {
        self.catalog = catalog;
        self
    }

    /// The running session for `key`, spawning it (with `init`) if there is
    /// none or it died. Concurrent calls for one key start a single session.
    /// A (re)started session gets a fresh delta cursor.
    pub async fn ensure(
        &self,
        key: &SessionKey,
        init: SessionInit,
    ) -> Result<Arc<dyn SessionHandle>, AgentError> {
        let lock = self.spawn_lock(key);
        let _spawning = lock.lock().await;
        if self.shutting_down.load(Ordering::SeqCst) {
            return Err(shut_down_error());
        }

        let stale = {
            let mut entries = self.entries.lock().unwrap();
            match entries.get_mut(key) {
                Some(entry) if entry.handle.is_alive() && !restart_after_error(key, entry) => {
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

        let (model, effort, thinking) = {
            let cfg = self.config.read().unwrap();
            let (m, e) = cfg.model_for(key.tier);
            (
                m.to_string(),
                effective_effort(self.catalog.find(m).as_ref(), e),
                cfg.thinking_for(key.tier),
            )
        };
        self.emit(key, SessionState::Starting, &model, None);
        let cfg = SessionConfig {
            model: model.clone(),
            effort,
            system_prompt: init.system_prompt,
            thinking,
            sources: if key.with_sources { init.sources.clone() } else { None },
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
        self.cursors.lock().unwrap().insert(
            key.clone(),
            Arc::new(AsyncMutex::new(DeltaCursor::default())),
        );
        self.entries.lock().unwrap().insert(
            key.clone(),
            Entry {
                handle: handle.clone(),
                state: SessionState::Ready,
                error: None,
                last_used: Instant::now(),
                in_flight: 0,
                turns: 0,
                sources_notice,
            },
        );
        self.emit(key, SessionState::Ready, &handle.model(), None);
        Ok(handle)
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
                AgentError::Crashed("no Claude session is running for this request".into())
            })?;
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
        for with_sources in [false, true] {
            self.close_variant(scope, with_sources).await;
        }
        self.usage.lock().unwrap().remove(scope);
    }

    /// Close both tiers' with-sources sessions of `scope` and leave the plain
    /// ones (the sources changed in settings; usage is kept).
    pub async fn close_sources(&self, scope: &SessionScope) {
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

    /// Close every session (app exit). Sessions still starting are closed as
    /// soon as they come up, and no new session starts afterwards.
    pub async fn close_all(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        let drained: Vec<(SessionKey, Entry)> = self.entries.lock().unwrap().drain().collect();
        self.cursors.lock().unwrap().clear();
        futures::future::join_all(drained.iter().map(|(_, entry)| entry.handle.close())).await;
        for (key, entry) in &drained {
            self.emit(key, SessionState::Closed, &entry.handle.model(), None);
        }
        self.usage.lock().unwrap().clear();
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
            log::info!("closing idle Claude session for {:?}", key.scope);
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
fn restart_after_error(key: &SessionKey, entry: &Entry) -> bool {
    key.scope == SessionScope::Utility
        && entry.state == SessionState::Error
        && entry.in_flight == 0
}

fn is_stale(key: &SessionKey, entry: &Entry, now: Instant) -> bool {
    matches!(key.scope, SessionScope::Past(_))
        && entry.in_flight == 0
        && now.saturating_duration_since(entry.last_used) >= PAST_IDLE_TIMEOUT
}

/// Same session object (compares data pointers; vtable pointers may differ).
fn same_session(a: &Arc<dyn SessionHandle>, b: &Arc<dyn SessionHandle>) -> bool {
    std::ptr::eq(Arc::as_ptr(a) as *const (), Arc::as_ptr(b) as *const ())
}

fn shut_down_error() -> AgentError {
    AgentError::Spawn("NexQ is shutting down".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    struct FakeSession {
        model: String,
        alive: AtomicBool,
        closed: AtomicBool,
        appended: Mutex<Vec<String>>,
    }

    #[async_trait]
    impl SessionHandle for FakeSession {
        async fn append_context(&self, text: &str) -> Result<(), AgentError> {
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
    }

    #[async_trait]
    impl SessionSpawner for FakeSpawner {
        async fn spawn(&self, cfg: SessionConfig) -> Result<Arc<dyn SessionHandle>, AgentError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            tokio::task::yield_now().await;
            if cfg.sources.is_some() && self.fail_sources.load(Ordering::SeqCst) {
                return Err(AgentError::Spawn("MCP server mira failed to start".into()));
            }
            let s = Arc::new(FakeSession {
                model: cfg.model.clone(),
                alive: AtomicBool::new(true),
                closed: AtomicBool::new(false),
                appended: Mutex::new(Vec::new()),
            });
            self.spawned.lock().unwrap().push((cfg, s.clone()));
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
        let mgr = AgentSessionManager::new(
            spawner.clone(),
            sink.clone(),
            Arc::new(RwLock::new(ClaudeCliConfig::default())),
        );
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
        let mgr = AgentSessionManager::new(spawner.clone(), Arc::new(NoopStatusSink), Arc::new(RwLock::new(cfg)));
        mgr.ensure(&key(SessionScope::Utility, Tier::Fast), init(&[])).await.unwrap();
        mgr.ensure(&key(SessionScope::Past("m".into()), Tier::Deep), init(&[])).await.unwrap();
        let thinking: Vec<bool> = spawner.spawned.lock().unwrap().iter().map(|(c, _)| c.thinking).collect();
        assert_eq!(thinking, vec![true, false]);
    }

    #[tokio::test]
    async fn ensure_clamps_effort_to_the_model_catalog() {
        let spawner = Arc::new(FakeSpawner::default());
        let catalog = Arc::new(ModelCatalog::default());
        let info = |value: &str, levels: &[&str]| crate::llm::cli_agent::models::ClaudeModelInfo {
            value: value.into(),
            resolved_model: value.into(),
            display_name: value.into(),
            description: String::new(),
            supports_effort: !levels.is_empty(),
            effort_levels: levels.iter().map(|s| s.to_string()).collect(),
        };
        catalog.set(vec![
            info("haiku", &[]),
            info("claude-opus-4-6", &["low", "medium", "high", "max"]),
        ]);
        let cfg = ClaudeCliConfig {
            deep_model: "claude-opus-4-6".into(),
            deep_effort: "xhigh".into(),
            ..ClaudeCliConfig::default()
        };
        let mgr = AgentSessionManager::new(
            spawner.clone(),
            Arc::new(NoopStatusSink),
            Arc::new(RwLock::new(cfg)),
        )
        .with_catalog(catalog);
        mgr.ensure(&key(SessionScope::Utility, Tier::Fast), init(&[])).await.unwrap();
        mgr.ensure(&key(SessionScope::Past("m".into()), Tier::Deep), init(&[])).await.unwrap();
        let spawned = spawner.spawned.lock().unwrap();
        // Haiku takes no effort: none is passed.
        assert_eq!((spawned[0].0.model.as_str(), spawned[0].0.effort.as_deref()), ("haiku", None));
        // xhigh isn't offered by this model: the closest lower level is used.
        assert_eq!(spawned[1].0.effort.as_deref(), Some("high"));
    }

    #[test]
    fn status_serializes_snake_case() {
        let s = AgentSessionStatus {
            scope: "live".into(),
            meeting_id: Some("m1".into()),
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
}
