//! `ai_runs`: the one service every chat, notes, brief, recap and memory call
//! goes through, so none of them can block or disturb a live answer.
//!
//! - **Own provider instance.** An API run builds its provider with
//!   `create_provider` for that run (own HTTP client, own state). It never
//!   takes the router's mutex, works for a provider other than the active
//!   one, reads its key from the credential manager by provider, and is
//!   silent: no `llm_stream_*` event, tokens go to the caller's sink only.
//! - **CLI agents** run on their own sessions (`SessionScope::Workspace`,
//!   `Notes`, `Brief`) with a kind, model and effort of their own, so a chat
//!   can use Codex while the live provider is Claude.
//! - **Typed errors, no fallback.** A run that fails says what failed
//!   ([`AiRunError`]); it never quietly goes to another provider.
//! - **Priority.** [`LiveGate`]: see `gate.rs`.
//! - **Windows.** [`AiRuns::model_window`]; Ollama calls send `num_ctx`.
//! - **Cache.** The stable part of the prompt (`system`, `stable_context`) is
//!   marked for Anthropic's prompt cache (`cache_control`) on these runs only.
//!
//! The network edge is behind [`ApiBackend`] so the whole flow is tested with
//! fakes; [`LiveBackend`] is the real one.

pub mod gate;
pub mod windows;

use crate::credentials::CredentialManager;
use crate::llm::cli_agent::command::SourcesLaunch;
use crate::llm::cli_agent::manager::{
    AgentSessionManager, SessionInit, SessionKey, SessionOverride, SessionScope, Tier,
};
use crate::llm::cli_agent::protocol::{classify_error, AgentErrorKind, PlanLimit, PlanLimitLevel};
use crate::llm::cli_agent::session::{is_activity, AgentError, THINKING_SIGNAL};
use crate::llm::cli_agent::{transcripts, CliAgentKind};
use crate::llm::provider::{
    CancelToken, CompletionStats, GenerationParams, LLMError, LLMMessage, ModelInfo, TokenSink,
};
use crate::llm::thinking::ThinkingSetting;
use crate::llm::{create_provider, ProviderConfig, ProviderType};
use async_trait::async_trait;
pub use gate::{local_server_id, GateWait, LiveBusy, LiveGate, LiveTarget};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
pub use windows::{bucket_context, estimate_tokens, ModelWindows};

/// How long a run waits for a live answer to finish before giving up with
/// [`AiRunError::Preempted`].
pub const DEFER_LIMIT: Duration = Duration::from_secs(90);

/// What a run is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AiPurpose {
    Chat,
    Notes,
    Brief,
    Recap,
    Memory,
}

impl AiPurpose {
    pub fn label(self) -> &'static str {
        match self {
            AiPurpose::Chat => "chat",
            AiPurpose::Notes => "notes",
            AiPurpose::Brief => "brief",
            AiPurpose::Recap => "recap",
            AiPurpose::Memory => "memory",
        }
    }

    /// Runs the user is not waiting on: they yield to live answers on any
    /// provider, not only on a shared local server.
    pub fn is_background(self) -> bool {
        matches!(self, AiPurpose::Notes | AiPurpose::Brief)
    }

    /// Structured background output wants no thinking unless the effort asks.
    fn thinks_by_default(self) -> bool {
        matches!(self, AiPurpose::Chat | AiPurpose::Recap)
    }
}

/// Which model answers: the provider id (`ProviderType::as_str`), the model
/// (empty = the provider's own default, CLI agents only) and an optional effort
/// (`off`, `low`, `medium`, `high`, `xhigh`, `max`).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ModelSelection {
    pub provider: String,
    pub model: String,
    pub effort: Option<String>,
}

impl ModelSelection {
    pub fn new(provider: &str, model: &str, effort: Option<&str>) -> Self {
        Self { provider: provider.to_string(), model: model.to_string(), effort: effort.map(str::to_string) }
    }
}

pub struct AiRunRequest {
    pub purpose: AiPurpose,
    pub selection: ModelSelection,
    /// Instructions. The stable part: for an API run it is cached; for a CLI
    /// session it is the session's system prompt, applied when the session
    /// starts (put anything that changes per run in `messages`).
    pub system: String,
    /// Large stable material (documents, the outline) sent after `system` and
    /// cached with it. Same CLI rule as `system`.
    pub stable_context: Option<String>,
    /// The conversation, oldest first; the last one is the new user turn. A
    /// CLI session sends only that last turn and replays the earlier ones
    /// only when it starts a fresh session.
    pub messages: Vec<LLMMessage>,
    pub max_output: u64,
    pub temperature: Option<f64>,
    pub cancel: Arc<CancelToken>,
    /// The CLI session this run belongs to (`Workspace`, `Notes` or `Brief`
    /// scope). `None`: a session used for this run alone, closed after it.
    pub session_key: Option<SessionKey>,
    /// What a CLI session launches with (a chat's transcript folder, see
    /// `transcripts`); the key must then be a with-sources key.
    pub sources: Option<SourcesLaunch>,
    /// Start a fresh CLI session after this many turns (notes: 25).
    pub recycle_after: Option<usize>,
    /// Prompt size when the caller knows it (else estimated from the text).
    pub est_input_tokens: Option<u64>,
    /// The scope generation ([`AiRuns::generation`]) read BEFORE the caller built
    /// `system`, `stable_context` and the sources from the workspace. If that
    /// scope restarted since, no CLI session starts with them and the run fails
    /// with `Unavailable` ("changed while this was starting"): build the
    /// context again and retry once. `None`: read when the run starts.
    pub expected_generation: Option<u64>,
}

impl AiRunRequest {
    pub fn new(purpose: AiPurpose, selection: ModelSelection, system: &str, user: &str) -> Self {
        Self {
            purpose,
            selection,
            system: system.to_string(),
            stable_context: None,
            messages: vec![LLMMessage { role: "user".into(), content: user.to_string() }],
            max_output: 1024,
            temperature: None,
            cancel: Arc::new(CancelToken::new()),
            session_key: None,
            sources: None,
            recycle_after: None,
            est_input_tokens: None,
            expected_generation: None,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct AiUsage {
    /// Uncached prompt tokens.
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    /// The CLI's cost estimate; `None` for an API run (no price list here).
    pub cost_usd: Option<f64>,
    pub latency_ms: u64,
    pub first_token_ms: Option<u64>,
}

impl AiUsage {
    /// Every prompt token: uncached, cache reads and cache writes.
    pub fn prompt_tokens(&self) -> u64 {
        self.input_tokens + self.cache_read_tokens + self.cache_write_tokens
    }

    /// Tokens that count against a budget: the uncached input and the output.
    pub fn billable_new_tokens(&self) -> u64 {
        self.input_tokens + self.output_tokens
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AiRunResult {
    pub text: String,
    pub usage: AiUsage,
    /// The model that answered (a CLI reports the one it resolved).
    pub model: String,
    /// The model's context window, when known.
    pub window: Option<u64>,
    /// The plan was near or at its limit during this run (CLI agents).
    pub plan_limit: Option<PlanLimit>,
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum AiRunError {
    /// No key saved for the provider, or the provider refused it.
    #[error("{message}")]
    NoKey { provider: String, message: String },
    /// Rate limit, quota or (CLI) usage limit of the plan.
    #[error("{message}")]
    RateLimited { message: String, plan_limit: Option<PlanLimit> },
    /// Not installed, not signed in, not reachable, crashed or timed out.
    #[error("{message}")]
    Unavailable { message: String },
    /// The caller cancelled.
    #[error("cancelled")]
    Cancelled,
    /// The prompt does not fit the model's window (`window` 0: not known, the
    /// provider said so).
    #[error("{}", too_long_text(*.needed, *.window))]
    TooLong { needed: u64, window: u64 },
    /// A live answer took the server (or was running for too long): the run did
    /// not start or was stopped for it. Try again later.
    #[error("a live answer has priority; try again in a moment")]
    Preempted,
    #[error("{message}")]
    Other { message: String },
}

impl AiRunError {
    /// Stable snake_case name for the frontend.
    pub fn kind(&self) -> &'static str {
        match self {
            AiRunError::NoKey { .. } => "no_key",
            AiRunError::RateLimited { .. } => "rate_limited",
            AiRunError::Unavailable { .. } => "unavailable",
            AiRunError::Cancelled => "cancelled",
            AiRunError::TooLong { .. } => "too_long",
            AiRunError::Preempted => "preempted",
            AiRunError::Other { .. } => "other",
        }
    }

    /// The plan-limit signal an error carries (a hit limit).
    pub fn plan_limit(&self) -> Option<&PlanLimit> {
        match self {
            AiRunError::RateLimited { plan_limit, .. } => plan_limit.as_ref(),
            _ => None,
        }
    }
}

fn too_long_text(needed: u64, window: u64) -> String {
    if window == 0 {
        format!("the prompt (about {needed} tokens) is too long for this model")
    } else {
        format!("the prompt (about {needed} tokens) does not fit this model's window ({window} tokens)")
    }
}

/// The size of a run, for a "too long" error the provider reports in words.
#[derive(Clone, Copy)]
struct Size {
    needed: u64,
    window: u64,
}

/// What turns a failure message into an error kind (API providers say it in text).
fn classify_failure(message: String, provider: &str, size: Size) -> AiRunError {
    let lower = message.to_lowercase();
    match classify_error(&message) {
        AgentErrorKind::RateLimited => AiRunError::RateLimited { message, plan_limit: None },
        AgentErrorKind::ContextOverflow => AiRunError::TooLong { needed: size.needed, window: size.window },
        AgentErrorKind::NotLoggedIn | AgentErrorKind::NotInstalled | AgentErrorKind::Outdated => {
            AiRunError::Unavailable { message }
        }
        _ if lower.contains("429") || lower.contains("quota") || lower.contains("overloaded") => {
            AiRunError::RateLimited { message, plan_limit: None }
        }
        _ if lower.contains("401") || lower.contains("403") || lower.contains("invalid api key") => {
            AiRunError::NoKey { provider: provider.to_string(), message }
        }
        _ => AiRunError::Other { message },
    }
}

fn map_llm_error(e: LLMError, provider: &str, size: Size) -> AiRunError {
    match e {
        LLMError::Cancelled => AiRunError::Cancelled,
        LLMError::AuthError(message) => AiRunError::NoKey { provider: provider.to_string(), message },
        LLMError::NotConfigured(message) => AiRunError::Unavailable { message },
        LLMError::ConnectionFailed(message) => AiRunError::Unavailable { message },
        LLMError::HttpError(e) => AiRunError::Unavailable { message: e.to_string() },
        other => classify_failure(other.to_string(), provider, size),
    }
}

fn map_agent_error(e: AgentError, size: Size) -> AiRunError {
    if e.is_cancel() {
        return AiRunError::Cancelled;
    }
    let message = e.to_string();
    match e.kind() {
        AgentErrorKind::RateLimited => AiRunError::RateLimited {
            message,
            plan_limit: Some(PlanLimit { level: PlanLimitLevel::Hit, resets_at: None, window: None, used: None }),
        },
        AgentErrorKind::ContextOverflow => AiRunError::TooLong { needed: size.needed, window: size.window },
        AgentErrorKind::NotInstalled
        | AgentErrorKind::Outdated
        | AgentErrorKind::NotLoggedIn
        | AgentErrorKind::Crashed => AiRunError::Unavailable { message },
        AgentErrorKind::Other => match e {
            AgentError::Timeout | AgentError::Spawn(_) => AiRunError::Unavailable { message },
            _ => AiRunError::Other { message },
        },
    }
}

/// The reasoning setting an effort asks for (`None`: the provider's own).
fn thinking_for_effort(effort: Option<&str>) -> ThinkingSetting {
    match effort.map(|e| e.trim().to_lowercase()).as_deref() {
        None | Some("") | Some("auto") => ThinkingSetting::Auto,
        Some("off") | Some("none") | Some("minimal") => ThinkingSetting::Off,
        Some("low") => ThinkingSetting::Low,
        Some(_) => ThinkingSetting::High,
    }
}

// ---------------------------------------------------------------------------
// The edges: provider configs and the network.
// ---------------------------------------------------------------------------

/// Where a provider's config (endpoint, key, auth) comes from.
pub trait ConfigSource: Send + Sync {
    fn config_for(&self, selection: &ModelSelection) -> Result<ProviderConfig, AiRunError>;
}

/// Keys from the credential manager; endpoints (a custom or remote Ollama URL)
/// from configs the app registered with [`CredentialConfigs::set_hint`].
pub struct CredentialConfigs {
    credentials: Option<Arc<Mutex<CredentialManager>>>,
    hints: RwLock<HashMap<String, ProviderConfig>>,
}

impl CredentialConfigs {
    pub fn new(credentials: Option<Arc<Mutex<CredentialManager>>>) -> Self {
        Self { credentials, hints: RwLock::new(HashMap::new()) }
    }

    /// Remember a provider's endpoint and auth settings (its key is read fresh
    /// from the credential manager, never kept here).
    pub fn set_hint(&self, mut config: ProviderConfig) {
        config.api_key = None;
        self.hints.write().unwrap().insert(config.provider_type.clone(), config);
    }
}

impl ConfigSource for CredentialConfigs {
    fn config_for(&self, selection: &ModelSelection) -> Result<ProviderConfig, AiRunError> {
        let provider = selection.provider.as_str();
        let ptype = ProviderType::from_str(provider)
            .map_err(|e| AiRunError::Other { message: e.to_string() })?;
        let mut config = self.hints.read().unwrap().get(provider).cloned().unwrap_or_else(|| ProviderConfig {
            provider_type: provider.to_string(),
            api_key: None,
            base_url: None,
            auth_type: None,
            auth_value: None,
            auth_header: None,
            thinking: Default::default(),
            extra_request_json: None,
        });
        if ptype.requires_api_key() && config.api_key.is_none() {
            let key = self
                .credentials
                .as_ref()
                .and_then(|c| c.lock().ok())
                .and_then(|c| c.get_key(provider).ok().flatten())
                .filter(|k| !k.trim().is_empty());
            match key {
                Some(key) => config.api_key = Some(key),
                None => {
                    return Err(AiRunError::NoKey {
                        provider: provider.to_string(),
                        message: format!("No {} key is saved. Add one in Settings.", ptype.display_name()),
                    })
                }
            }
        }
        if matches!(ptype, ProviderType::Custom) && config.base_url.is_none() {
            return Err(AiRunError::Unavailable { message: "The custom endpoint has no address.".into() });
        }
        Ok(config)
    }
}

/// The network side of an API run (faked in tests).
#[async_trait]
pub trait ApiBackend: Send + Sync {
    /// One streamed completion on a provider built for this call alone.
    async fn stream(
        &self,
        config: ProviderConfig,
        messages: Vec<LLMMessage>,
        model: String,
        params: GenerationParams,
        sink: Option<TokenSink>,
    ) -> Result<CompletionStats, LLMError>;

    async fn list_models(&self, config: ProviderConfig) -> Result<Vec<ModelInfo>, LLMError>;

    /// An Ollama model's real window (`/api/show`).
    async fn ollama_window(&self, base_url: &str, model: &str) -> Option<u64>;
}

/// The real backend: `create_provider` per call, over the app's handle.
pub struct LiveBackend {
    app: tauri::AppHandle,
}

impl LiveBackend {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

#[async_trait]
impl ApiBackend for LiveBackend {
    async fn stream(
        &self,
        config: ProviderConfig,
        messages: Vec<LLMMessage>,
        model: String,
        params: GenerationParams,
        sink: Option<TokenSink>,
    ) -> Result<CompletionStats, LLMError> {
        let provider = create_provider(&config).map_err(LLMError::NotConfigured)?;
        provider.stream_completion(messages, &model, params, self.app.clone(), sink).await
    }

    async fn list_models(&self, config: ProviderConfig) -> Result<Vec<ModelInfo>, LLMError> {
        let provider = create_provider(&config).map_err(LLMError::NotConfigured)?;
        provider.list_models().await
    }

    async fn ollama_window(&self, base_url: &str, model: &str) -> Option<u64> {
        let client = reqwest::Client::builder().timeout(Duration::from_secs(5)).build().ok()?;
        let body = client
            .post(format!("{}/api/show", base_url.trim_end_matches('/')))
            .json(&serde_json::json!({ "model": model }))
            .send()
            .await
            .ok()?
            .json::<serde_json::Value>()
            .await
            .ok()?;
        windows::parse_ollama_show(&body)
    }
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

pub struct AiRuns {
    api: Arc<dyn ApiBackend>,
    cli: Arc<AgentSessionManager>,
    gate: Arc<LiveGate>,
    configs: Arc<dyn ConfigSource>,
    /// The app's endpoint hints (None for a service built from parts).
    hints: Option<Arc<CredentialConfigs>>,
    windows: ModelWindows,
    defer_limit: Duration,
    /// The window last asked of each local model: only grows, so the server
    /// does not reload the model when a prompt is a little longer.
    ollama_ctx: Mutex<HashMap<(String, String), u64>>,
}

impl AiRuns {
    /// The app's service: real backend, the app-wide gate, keys from the
    /// credential manager. Also wires a chat's transcript folder to its
    /// session: it goes away when the session closes.
    pub fn new(
        app: tauri::AppHandle,
        cli: Arc<AgentSessionManager>,
        credentials: Option<Arc<Mutex<CredentialManager>>>,
    ) -> Self {
        cli.set_closed_hook(Arc::new(|key: &SessionKey| {
            if key.with_sources {
                if let Some(chat) = key.scope.chat_id() {
                    transcripts::global().remove(chat);
                }
            }
        }));
        let configs = Arc::new(CredentialConfigs::new(credentials));
        let mut runs = Self::with_parts(Arc::new(LiveBackend::new(app)), cli, LiveGate::global(), configs.clone());
        runs.hints = Some(configs);
        runs
    }

    /// Remember a provider's endpoint and auth settings (a custom or remote
    /// Ollama address) for runs on that provider. Call it whenever the app
    /// learns them; keys are never kept here.
    pub fn set_hint(&self, config: ProviderConfig) {
        if let Some(hints) = &self.hints {
            hints.set_hint(config);
        }
    }

    pub fn with_parts(
        api: Arc<dyn ApiBackend>,
        cli: Arc<AgentSessionManager>,
        gate: Arc<LiveGate>,
        configs: Arc<dyn ConfigSource>,
    ) -> Self {
        Self {
            api,
            cli,
            gate,
            configs,
            hints: None,
            windows: ModelWindows::new(),
            defer_limit: DEFER_LIMIT,
            ollama_ctx: Mutex::new(HashMap::new()),
        }
    }

    pub fn with_defer_limit(mut self, limit: Duration) -> Self {
        self.defer_limit = limit;
        self
    }

    /// The generation of a CLI session scope: read it before building the
    /// context of a run for that scope (see [`AiRunRequest::expected_generation`]).
    pub fn generation(&self, scope: &SessionScope) -> u64 {
        self.cli.generation(scope)
    }

    pub fn gate(&self) -> &Arc<LiveGate> {
        &self.gate
    }

    /// The model's real context window, when it can be found (see `windows`).
    pub async fn model_window(&self, selection: &ModelSelection) -> Option<u64> {
        let ptype = ProviderType::from_str(&selection.provider).ok()?;
        if ptype.is_cli_agent() {
            return Some(windows::cli_window(&selection.model));
        }
        if let Some(hit) = self.windows.cached(&selection.provider, &selection.model) {
            return hit;
        }
        let config = self.configs.config_for(selection).ok()?;
        let window = if matches!(ptype, ProviderType::Ollama) {
            let base = config.base_url.clone().unwrap_or_else(|| ptype.default_base_url().to_string());
            self.api.ollama_window(&base, &selection.model).await
        } else {
            self.listed_window(&config, selection).await
        };
        self.windows.store(&selection.provider, &selection.model, window);
        window
    }

    async fn listed_window(&self, config: &ProviderConfig, selection: &ModelSelection) -> Option<u64> {
        if self.windows.listing_fresh(&selection.provider) {
            return None;
        }
        let models = self.api.list_models(config.clone()).await.ok()?;
        self.windows.mark_listed(&selection.provider);
        let mut found = None;
        for m in models {
            if m.id == selection.model {
                found = m.context_window;
            }
            self.windows.store(&selection.provider, &m.id, m.context_window);
        }
        found
    }

    /// Run one request to the end. Tokens go to `sink` as they arrive.
    pub async fn run(&self, req: AiRunRequest, sink: Option<TokenSink>) -> Result<AiRunResult, AiRunError> {
        if req.cancel.is_cancelled() {
            return Err(AiRunError::Cancelled);
        }
        let ptype = ProviderType::from_str(&req.selection.provider)
            .map_err(|e| AiRunError::Other { message: e.to_string() })?;
        match ptype.cli_agent_kind() {
            Some(kind) => self.run_cli(kind, req, sink).await,
            None => self.run_api(ptype, req, sink).await,
        }
    }

    // -- priority ----------------------------------------------------------

    /// Wait out a live answer when this run must not start under one.
    async fn admit(&self, req: &AiRunRequest, local: Option<&str>) -> Result<(), AiRunError> {
        let gated = match local {
            Some(server) => self.gate.shares_server(server),
            None => req.purpose.is_background(),
        };
        if !gated {
            return Ok(());
        }
        match self.gate.wait_idle(&req.cancel, self.defer_limit).await {
            GateWait::Idle => Ok(()),
            GateWait::Cancelled => Err(AiRunError::Cancelled),
            GateWait::TimedOut => Err(AiRunError::Preempted),
        }
    }

    // -- API providers -----------------------------------------------------

    async fn run_api(
        &self,
        ptype: ProviderType,
        req: AiRunRequest,
        sink: Option<TokenSink>,
    ) -> Result<AiRunResult, AiRunError> {
        let config = self.configs.config_for(&req.selection)?;
        let local = local_server_id(&ptype, config.base_url.as_deref());
        self.admit(&req, local.as_deref()).await?;

        // Size: what goes in plus what may come out, against the real window.
        let system = join_system(&req.system, req.stable_context.as_deref());
        let input = req.est_input_tokens.unwrap_or_else(|| {
            estimate_tokens(&system) + req.messages.iter().map(|m| estimate_tokens(&m.content) + 4).sum::<u64>()
        });
        let needed = input + req.max_output;
        let mut window = self.model_window(&req.selection).await;
        // A num_ctx the user set in the provider's extra JSON wins over ours.
        let user_ctx = user_num_ctx(config.extra_request_json.as_deref());
        if let Some(user) = user_ctx {
            window = Some(window.map_or(user, |w| w.min(user)));
        }
        if let Some(w) = window {
            if needed > w {
                return Err(AiRunError::TooLong { needed, window: w });
            }
        }
        let num_ctx = (matches!(ptype, ProviderType::Ollama) && user_ctx.is_none())
            .then(|| self.sticky_context(&config, &req.selection.model, needed, window));

        let mut messages = Vec::with_capacity(req.messages.len() + 1);
        if !system.is_empty() {
            messages.push(LLMMessage { role: "system".into(), content: system });
        }
        messages.extend(req.messages.iter().cloned());

        // The run's own token, so a live answer can stop it without touching
        // the caller's.
        let inner = Arc::new(CancelToken::new());
        let thinking = thinking_for_effort(req.selection.effort.as_deref());
        let params = GenerationParams {
            temperature: req.temperature,
            max_tokens: Some(req.max_output),
            request_id: Some(uuid::Uuid::new_v4().to_string()),
            silent: true,
            cancel: Some(inner.clone()),
            thinking,
            thinking_auto_off: !req.purpose.thinks_by_default() && thinking == ThinkingSetting::Auto,
            cache_system: true,
            num_ctx,
            ..Default::default()
        };

        let collector = Collector::new(sink);
        let started = Instant::now();
        let work = self.api.stream(
            config,
            messages,
            req.selection.model.clone(),
            params,
            Some(collector.sink()),
        );
        tokio::pin!(work);

        let watch_live = local.as_deref().is_some_and(|s| self.gate.shares_server(s));
        let (mut stopped, mut preempted) = (false, false);
        let outcome = loop {
            tokio::select! {
                out = &mut work => break out,
                _ = req.cancel.cancelled(), if !stopped => {
                    stopped = true;
                    inner.cancel();
                }
                _ = self.gate.live_started(), if watch_live && !stopped => {
                    stopped = true;
                    preempted = true;
                    inner.cancel();
                }
            }
        };
        match outcome {
            Ok(stats) => Ok(AiRunResult {
                text: collector.text(),
                usage: AiUsage {
                    input_tokens: stats.prompt_tokens,
                    output_tokens: stats.completion_tokens,
                    cache_read_tokens: stats.cache_read_tokens,
                    cache_write_tokens: stats.cache_write_tokens,
                    cost_usd: None,
                    latency_ms: started.elapsed().as_millis() as u64,
                    first_token_ms: collector.first_token_ms(),
                },
                model: req.selection.model.clone(),
                window,
                plan_limit: None,
            }),
            Err(LLMError::Cancelled) if preempted && !req.cancel.is_cancelled() => Err(AiRunError::Preempted),
            Err(e) => Err(map_llm_error(e, &req.selection.provider, Size { needed, window: window.unwrap_or(0) })),
        }
    }

    /// The context size to ask Ollama for: enough for this prompt, in a stable
    /// bucket, and never smaller than what this model was asked for before.
    fn sticky_context(&self, config: &ProviderConfig, model: &str, needed: u64, window: Option<u64>) -> u64 {
        let server = config.base_url.clone().unwrap_or_default();
        let mut seen = self.ollama_ctx.lock().unwrap();
        let slot = seen.entry((server, model.to_string())).or_insert(0);
        let wanted = bucket_context(needed, window).max(*slot);
        let wanted = window.map_or(wanted, |w| wanted.min(w));
        *slot = wanted;
        wanted
    }

    // -- CLI agents --------------------------------------------------------

    async fn run_cli(
        &self,
        kind: CliAgentKind,
        req: AiRunRequest,
        sink: Option<TokenSink>,
    ) -> Result<AiRunResult, AiRunError> {
        self.admit(&req, None).await?;
        let window = windows::cli_window(&req.selection.model);
        let last = req
            .messages
            .last()
            .ok_or_else(|| AiRunError::Other { message: "A run needs at least one message.".into() })?;
        let history = &req.messages[..req.messages.len() - 1];
        let needed = req.est_input_tokens.unwrap_or_else(|| {
            estimate_tokens(&join_system(&req.system, req.stable_context.as_deref()))
                + req.messages.iter().map(|m| estimate_tokens(&m.content)).sum::<u64>()
        }) + req.max_output;
        if needed > window {
            return Err(AiRunError::TooLong { needed, window });
        }

        let ephemeral = req.session_key.is_none();
        let key = req.session_key.clone().unwrap_or_else(|| {
            SessionKey::plain(SessionScope::Workspace(format!("run-{}", uuid::Uuid::new_v4())), Tier::Fast)
        });
        let expected = req.expected_generation.unwrap_or_else(|| self.cli.generation(&key.scope));
        let overrides = SessionOverride {
            kind: Some(kind),
            model: Some(req.selection.model.clone()).filter(|m| !m.trim().is_empty()),
            effort: req.selection.effort.clone().filter(|e| !e.trim().is_empty()),
            thinking: (!req.purpose.thinks_by_default()).then_some(false),
        };
        let init = SessionInit {
            system_prompt: join_system(&req.system, req.stable_context.as_deref()),
            preload: if history.is_empty() { Vec::new() } else { vec![replay(history)] },
            sources: req.sources.clone(),
        };

        if let Some(n) = req.recycle_after {
            self.cli.recycle_after(&key, n).await;
        }
        let size = Size { needed, window };
        let result = self.ask_cli(&key, init, overrides, expected, &last.content, &req, sink, size).await;
        if ephemeral {
            self.cli.close_scope(&key.scope).await;
        }
        let (turn, handle_model, plan_limit) = result?;
        Ok(AiRunResult {
            text: turn.text.clone(),
            usage: AiUsage {
                input_tokens: turn.input_tokens,
                output_tokens: turn.output_tokens,
                cache_read_tokens: turn.cache_read_tokens,
                cache_write_tokens: turn.cache_write_tokens,
                cost_usd: Some(turn.cost_usd),
                latency_ms: turn.latency_ms,
                first_token_ms: turn.first_text_ms,
            },
            model: handle_model,
            window: Some(window),
            plan_limit,
        })
    }

    async fn ask_cli(
        &self,
        key: &SessionKey,
        init: SessionInit,
        overrides: SessionOverride,
        expected: u64,
        prompt: &str,
        req: &AiRunRequest,
        sink: Option<TokenSink>,
        size: Size,
    ) -> Result<(crate::llm::cli_agent::protocol::TurnResult, String, Option<PlanLimit>), AiRunError> {
        // Not raced against the cancel: dropping a spawn mid-way would leave the
        // session status stuck on "starting". The cancel is checked right after.
        let handle = self.cli.ensure_at(key, init, Some(overrides), Some(expected)).await.map_err(|e| {
            if crate::llm::cli_agent::manager::is_scope_changed(&e) {
                AiRunError::Unavailable { message: "The workspace changed while this was starting. Try again.".to_string() }
            } else {
                map_agent_error(e, size)
            }
        })?;
        if req.cancel.is_cancelled() {
            return Err(AiRunError::Cancelled);
        }
        let on_delta: crate::llm::cli_agent::manager::OnDelta = Box::new(move |token: &str| {
            if token.is_empty() || token == THINKING_SIGNAL || is_activity(token) {
                return;
            }
            if let Some(sink) = &sink {
                sink(token);
            }
        });
        let turn = self.cli.ask(key, prompt, on_delta, req.cancel.clone()).await;
        let plan_limit = handle.take_plan_limit();
        match turn {
            Ok(turn) if turn.is_error => {
                let mut err = classify_failure(turn.text.clone(), &req.selection.provider, size);
                if let AiRunError::RateLimited { plan_limit: slot, .. } = &mut err {
                    *slot = plan_limit.clone().or(Some(PlanLimit {
                        level: PlanLimitLevel::Hit,
                        resets_at: None,
                        window: None,
                        used: None,
                    }));
                }
                Err(err)
            }
            Ok(turn) => Ok((turn, handle.model(), plan_limit)),
            Err(e) => {
                let mut err = map_agent_error(e, size);
                if let (AiRunError::RateLimited { plan_limit: slot, .. }, Some(signal)) = (&mut err, plan_limit) {
                    *slot = Some(signal);
                }
                Err(err)
            }
        }
    }

    // -- chats -------------------------------------------------------------

    /// A chat is closed or deleted: its sessions end after their turn in
    /// flight (at most 10 s) and its transcript folder goes.
    pub async fn close_chat(&self, chat_id: &str) {
        let scope = SessionScope::Workspace(chat_id.to_string());
        self.cli
            .close_scope_graceful(&scope, crate::llm::cli_agent::manager::DRAIN_TIMEOUT)
            .await;
        transcripts::global().remove(chat_id);
    }

    /// A meeting ended: its notes and brief sessions end the same way.
    pub async fn close_meeting(&self, meeting_id: &str) {
        for scope in [SessionScope::Notes(meeting_id.to_string()), SessionScope::Brief(meeting_id.to_string())] {
            self.cli
                .close_scope_graceful(&scope, crate::llm::cli_agent::manager::DRAIN_TIMEOUT)
                .await;
        }
    }
}

/// `system`, then `context`, as one stable block.
fn join_system(system: &str, context: Option<&str>) -> String {
    match context.map(str::trim).filter(|c| !c.is_empty()) {
        Some(context) if system.trim().is_empty() => context.to_string(),
        Some(context) => format!("{}\n\n{}", system.trim_end(), context),
        None => system.to_string(),
    }
}

/// The earlier turns of a conversation, as one message for a fresh CLI session.
fn replay(history: &[LLMMessage]) -> String {
    let mut text = String::from("The conversation so far (earlier turns, for context only):\n");
    for m in history {
        let who = if m.role == "assistant" { "Assistant" } else { "User" };
        text.push_str(&format!("\n{who}: {}\n", m.content));
    }
    text
}

/// `options.num_ctx` from a provider's extra request JSON, if the user set one.
fn user_num_ctx(extra: Option<&str>) -> Option<u64> {
    let value: serde_json::Value = serde_json::from_str(extra?).ok()?;
    value.get("options")?.get("num_ctx")?.as_u64()
}

/// Gathers the streamed text and the time of its first token, and forwards
/// every token to the caller's sink.
struct Collector {
    text: Arc<Mutex<String>>,
    first: Arc<std::sync::OnceLock<u64>>,
    start: Instant,
    forward: Option<TokenSink>,
}

impl Collector {
    fn new(forward: Option<TokenSink>) -> Self {
        Self {
            text: Arc::default(),
            first: Arc::default(),
            start: Instant::now(),
            forward,
        }
    }

    fn sink(&self) -> TokenSink {
        let (text, first, start, forward) = (self.text.clone(), self.first.clone(), self.start, self.forward.clone());
        Arc::new(move |token: &str| {
            if !token.is_empty() {
                first.get_or_init(|| start.elapsed().as_millis() as u64);
            }
            text.lock().unwrap().push_str(token);
            if let Some(forward) = &forward {
                forward(token);
            }
        })
    }

    fn text(&self) -> String {
        self.text.lock().unwrap().clone()
    }

    fn first_token_ms(&self) -> Option<u64> {
        self.first.get().copied()
    }
}

#[cfg(test)]
mod tests;
