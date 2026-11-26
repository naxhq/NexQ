use super::*;
use crate::llm::cli_agent::command::SessionConfig;
use crate::llm::cli_agent::manager::{NoopStatusSink, OnDelta, SessionHandle, SessionSpawner};
use crate::llm::cli_agent::protocol::TurnResult;
use crate::llm::cli_agent::settings::CliSettings;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

#[derive(Clone)]
enum Behavior {
    Text(Vec<&'static str>),
    Fail(fn() -> LLMError),
    /// Waits until the run's own cancel token fires.
    UntilCancelled,
    /// Waits until this many calls are inside at once, then answers.
    Rendezvous(usize),
}

#[derive(Clone)]
struct Call {
    config: ProviderConfig,
    messages: Vec<LLMMessage>,
    model: String,
    params: GenerationParams,
}

struct FakeApi {
    calls: Mutex<Vec<Call>>,
    behavior: Mutex<Behavior>,
    current: AtomicUsize,
    arrived: AtomicUsize,
    max_concurrent: AtomicUsize,
    listing: Mutex<Vec<ModelInfo>>,
    list_calls: AtomicUsize,
    ollama_window: Mutex<Option<u64>>,
    show_calls: AtomicUsize,
}

impl FakeApi {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            calls: Mutex::new(Vec::new()),
            behavior: Mutex::new(Behavior::Text(vec!["hello ", "world"])),
            current: AtomicUsize::new(0),
            arrived: AtomicUsize::new(0),
            max_concurrent: AtomicUsize::new(0),
            listing: Mutex::new(Vec::new()),
            list_calls: AtomicUsize::new(0),
            ollama_window: Mutex::new(None),
            show_calls: AtomicUsize::new(0),
        })
    }

    fn set(&self, b: Behavior) {
        *self.behavior.lock().unwrap() = b;
    }

    fn calls(&self) -> Vec<Call> {
        self.calls.lock().unwrap().clone()
    }
}

#[async_trait]
impl ApiBackend for FakeApi {
    async fn stream(
        &self,
        config: ProviderConfig,
        messages: Vec<LLMMessage>,
        model: String,
        params: GenerationParams,
        sink: Option<TokenSink>,
    ) -> Result<CompletionStats, LLMError> {
        self.calls.lock().unwrap().push(Call {
            config,
            messages,
            model,
            params: params.clone(),
        });
        let now = self.current.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_concurrent.fetch_max(now, Ordering::SeqCst);
        let behavior = self.behavior.lock().unwrap().clone();
        let out = match behavior {
            Behavior::Text(tokens) => {
                for t in tokens {
                    if let Some(sink) = &sink {
                        sink(t);
                    }
                    tokio::task::yield_now().await;
                }
                Ok(CompletionStats {
                    prompt_tokens: 100,
                    completion_tokens: 7,
                    total_tokens: 107,
                    latency_ms: 1,
                    cache_read_tokens: 40,
                    cache_write_tokens: 3,
                })
            }
            Behavior::Fail(make) => Err(make()),
            Behavior::UntilCancelled => {
                params.cancel.as_ref().unwrap().cancelled().await;
                Err(LLMError::Cancelled)
            }
            Behavior::Rendezvous(n) => {
                let deadline = Instant::now() + Duration::from_secs(3);
                self.arrived.fetch_add(1, Ordering::SeqCst);
                while self.arrived.load(Ordering::SeqCst) < n {
                    if Instant::now() > deadline {
                        self.current.fetch_sub(1, Ordering::SeqCst);
                        return Err(LLMError::ProviderError("never ran side by side".into()));
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                Ok(CompletionStats { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, ..Default::default() })
            }
        };
        self.current.fetch_sub(1, Ordering::SeqCst);
        out
    }

    async fn list_models(&self, _config: ProviderConfig) -> Result<Vec<ModelInfo>, LLMError> {
        self.list_calls.fetch_add(1, Ordering::SeqCst);
        Ok(self.listing.lock().unwrap().clone())
    }

    async fn ollama_window(&self, _base_url: &str, _model: &str) -> Option<u64> {
        self.show_calls.fetch_add(1, Ordering::SeqCst);
        *self.ollama_window.lock().unwrap()
    }
}

/// Keys by provider, no router, no active provider.
struct FakeConfigs {
    keys: HashMap<&'static str, &'static str>,
    extra: Mutex<HashMap<String, String>>,
    base_urls: Mutex<HashMap<String, String>>,
}

impl FakeConfigs {
    fn new(keys: &[(&'static str, &'static str)]) -> Arc<Self> {
        Arc::new(Self {
            keys: keys.iter().cloned().collect(),
            extra: Mutex::default(),
            base_urls: Mutex::default(),
        })
    }
}

impl ConfigSource for FakeConfigs {
    fn config_for(&self, s: &ModelSelection) -> Result<ProviderConfig, AiRunError> {
        let ptype = ProviderType::from_str(&s.provider).map_err(|e| AiRunError::Other { message: e.to_string() })?;
        let api_key = self.keys.get(s.provider.as_str()).map(|k| k.to_string());
        if ptype.requires_api_key() && api_key.is_none() {
            return Err(AiRunError::NoKey { provider: s.provider.clone(), message: "no key".into() });
        }
        Ok(ProviderConfig {
            provider_type: s.provider.clone(),
            api_key,
            base_url: self.base_urls.lock().unwrap().get(&s.provider).cloned(),
            auth_type: None,
            auth_value: None,
            auth_header: None,
            thinking: Default::default(),
            extra_request_json: self.extra.lock().unwrap().get(&s.provider).cloned(),
        })
    }
}

struct FakeSession {
    model: String,
    alive: AtomicBool,
    closed: AtomicBool,
    appended: Mutex<Vec<String>>,
    asked: Mutex<Vec<String>>,
    plan: Mutex<Option<PlanLimit>>,
    delay: Duration,
}

#[async_trait]
impl SessionHandle for FakeSession {
    async fn append_context(&self, text: &str) -> Result<(), AgentError> {
        self.appended.lock().unwrap().push(text.to_string());
        Ok(())
    }

    async fn ask(&self, prompt: &str, on_delta: OnDelta, _cancel: Arc<CancelToken>) -> Result<TurnResult, AgentError> {
        self.asked.lock().unwrap().push(prompt.to_string());
        on_delta(THINKING_SIGNAL);
        if prompt == "warn" {
            *self.plan.lock().unwrap() =
                Some(PlanLimit { level: PlanLimitLevel::Near, resets_at: Some(1_900_000_000), window: Some("five_hour".into()), used: Some(0.93) });
        }
        if prompt == "limit" {
            *self.plan.lock().unwrap() =
                Some(PlanLimit { level: PlanLimitLevel::Hit, resets_at: Some(1_900_000_000), window: None, used: None });
            return Err(AgentError::Cli(AgentErrorKind::RateLimited, "You've hit your usage limit".into()));
        }
        if prompt == "tools" {
            on_delta(&crate::llm::cli_agent::session::encode_activity(&crate::llm::cli_agent::protocol::ToolUse {
                id: "t1".into(),
                name: "Read".into(),
                input: serde_json::json!({"file_path": "plan.md"}),
            }));
        }
        if prompt == "errresult" {
            return Ok(TurnResult { text: "5-hour usage limit reached".into(), is_error: true, ..Default::default() });
        }
        if !self.delay.is_zero() {
            tokio::time::sleep(self.delay).await;
        }
        on_delta("answer");
        Ok(TurnResult {
            text: format!("answer to {prompt}"),
            input_tokens: 10,
            output_tokens: 5,
            cache_read_tokens: 30,
            cache_write_tokens: 2,
            cost_usd: 0.25,
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

    fn take_plan_limit(&self) -> Option<PlanLimit> {
        self.plan.lock().unwrap().take()
    }
}

#[derive(Default)]
struct FakeSpawner {
    spawned: Mutex<Vec<(SessionConfig, Arc<FakeSession>)>>,
    delay_ms: AtomicUsize,
}

#[async_trait]
impl SessionSpawner for FakeSpawner {
    async fn spawn(&self, cfg: SessionConfig) -> Result<Arc<dyn SessionHandle>, AgentError> {
        tokio::task::yield_now().await;
        let s = Arc::new(FakeSession {
            model: if cfg.model.is_empty() { "default-model".into() } else { cfg.model.clone() },
            alive: AtomicBool::new(true),
            closed: AtomicBool::new(false),
            appended: Mutex::new(Vec::new()),
            asked: Mutex::new(Vec::new()),
            plan: Mutex::new(None),
            delay: Duration::from_millis(self.delay_ms.load(Ordering::SeqCst) as u64),
        });
        self.spawned.lock().unwrap().push((cfg, s.clone()));
        Ok(s)
    }
}

struct Rig {
    runs: AiRuns,
    api: Arc<FakeApi>,
    spawner: Arc<FakeSpawner>,
    cli: Arc<AgentSessionManager>,
    settings: Arc<CliSettings>,
    gate: Arc<LiveGate>,
    configs: Arc<FakeConfigs>,
}

fn rig() -> Rig {
    let api = FakeApi::new();
    let spawner = Arc::new(FakeSpawner::default());
    let settings = Arc::new(CliSettings::isolated());
    let cli = Arc::new(AgentSessionManager::new(spawner.clone(), Arc::new(NoopStatusSink), settings.clone()));
    let gate = LiveGate::new();
    let configs = FakeConfigs::new(&[("openai", "sk-openai"), ("anthropic", "sk-ant"), ("gemini", "g-key")]);
    let runs = AiRuns::with_parts(api.clone(), cli.clone(), gate.clone(), configs.clone())
        .with_defer_limit(Duration::from_millis(400));
    Rig { runs, api, spawner, cli, settings, gate, configs }
}

fn sel(provider: &str, model: &str) -> ModelSelection {
    ModelSelection::new(provider, model, None)
}

fn req(purpose: AiPurpose, provider: &str, model: &str, user: &str) -> AiRunRequest {
    AiRunRequest::new(purpose, sel(provider, model), "You are helpful.", user)
}

fn model_info(id: &str, window: Option<u64>) -> ModelInfo {
    ModelInfo { id: id.into(), name: id.into(), provider: "x".into(), context_window: window }
}

fn collecting() -> (TokenSink, Arc<Mutex<Vec<String>>>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let target = seen.clone();
    (Arc::new(move |t: &str| target.lock().unwrap().push(t.to_string())), seen)
}

// ---------------------------------------------------------------------------
// API runs
// ---------------------------------------------------------------------------

#[tokio::test]
async fn an_api_run_streams_silently_with_its_own_settings_and_reports_usage() {
    let r = rig();
    let (sink, seen) = collecting();
    let mut request = req(AiPurpose::Chat, "openai", "gpt-x", "hi");
    request.temperature = Some(0.2);
    request.max_output = 500;
    request.stable_context = Some("CONTEXT".into());
    let out = r.runs.run(request, Some(sink)).await.unwrap();

    assert_eq!(out.text, "hello world");
    assert_eq!(*seen.lock().unwrap(), vec!["hello ".to_string(), "world".to_string()]);
    assert_eq!(out.usage.input_tokens, 100);
    assert_eq!(out.usage.output_tokens, 7);
    assert_eq!((out.usage.cache_read_tokens, out.usage.cache_write_tokens), (40, 3));
    assert_eq!(out.usage.prompt_tokens(), 143);
    assert!(out.usage.first_token_ms.is_some());
    assert_eq!(out.model, "gpt-x");

    let call = &r.api.calls()[0];
    // The provider asked for is the provider used: its own key, its own model.
    assert_eq!(call.config.provider_type, "openai");
    assert_eq!(call.config.api_key.as_deref(), Some("sk-openai"));
    assert_eq!(call.model, "gpt-x");
    // Silent: no llm_stream_* event; tagged with a request id of its own; capped output.
    assert!(call.params.silent);
    assert!(call.params.request_id.is_some());
    assert_eq!(call.params.max_tokens, Some(500));
    assert_eq!(call.params.temperature, Some(0.2));
    // Stable part first, as one system message the provider can cache.
    assert_eq!(call.messages[0].role, "system");
    assert_eq!(call.messages[0].content, "You are helpful.\n\nCONTEXT");
    assert_eq!(call.messages[1].content, "hi");
    assert!(call.params.cache_system);
}

#[tokio::test]
async fn a_run_works_for_a_provider_other_than_the_active_one_with_its_own_key() {
    let r = rig();
    // The router could be on Ollama; the run names Anthropic and Gemini.
    r.runs.run(req(AiPurpose::Notes, "anthropic", "claude-x", "a"), None).await.unwrap();
    r.runs.run(req(AiPurpose::Memory, "gemini", "gemini-x", "b"), None).await.unwrap();
    let calls = r.api.calls();
    assert_eq!(calls[0].config.api_key.as_deref(), Some("sk-ant"));
    assert_eq!(calls[1].config.api_key.as_deref(), Some("g-key"));
}

#[tokio::test]
async fn runs_do_not_share_state_or_wait_for_each_other() {
    let r = rig();
    r.api.set(Behavior::Rendezvous(3));
    let runs = Arc::new(r.runs);
    let mut tasks = Vec::new();
    for (provider, model) in [("openai", "a"), ("anthropic", "b"), ("gemini", "c")] {
        let runs = runs.clone();
        tasks.push(tokio::spawn(async move { runs.run(req(AiPurpose::Chat, provider, model, "x"), None).await }));
    }
    for t in tasks {
        t.await.unwrap().expect("each run is inside the provider at the same time as the others");
    }
    assert_eq!(r.api.max_concurrent.load(Ordering::SeqCst), 3);
    // Each run had its own cancel token: cancelling one leaves the rest.
    let calls = r.api.calls();
    assert_eq!(calls.len(), 3);
    let ids: std::collections::HashSet<_> = calls.iter().map(|c| c.params.request_id.clone()).collect();
    assert_eq!(ids.len(), 3);
}

#[tokio::test]
async fn cancelling_one_run_stops_only_that_run() {
    let r = rig();
    r.api.set(Behavior::UntilCancelled);
    let runs = Arc::new(r.runs);
    let (a, b) = (req(AiPurpose::Chat, "openai", "m", "a"), req(AiPurpose::Chat, "openai", "m", "b"));
    let (cancel_a, cancel_b) = (a.cancel.clone(), b.cancel.clone());
    let ta = tokio::spawn({ let runs = runs.clone(); async move { runs.run(a, None).await } });
    let tb = tokio::spawn({ let runs = runs.clone(); async move { runs.run(b, None).await } });
    tokio::time::sleep(Duration::from_millis(50)).await;
    cancel_a.cancel();
    assert_eq!(ta.await.unwrap().unwrap_err(), AiRunError::Cancelled);
    assert!(!tb.is_finished(), "the other run keeps going");
    cancel_b.cancel();
    assert_eq!(tb.await.unwrap().unwrap_err(), AiRunError::Cancelled);
}

#[tokio::test]
async fn a_run_cancelled_before_it_starts_never_reaches_the_provider() {
    let r = rig();
    let request = req(AiPurpose::Chat, "openai", "m", "a");
    request.cancel.cancel();
    assert_eq!(r.runs.run(request, None).await.unwrap_err(), AiRunError::Cancelled);
    assert!(r.api.calls().is_empty());
}

#[tokio::test]
async fn a_missing_key_is_a_typed_error_and_nothing_is_sent() {
    let r = rig();
    let err = r.runs.run(req(AiPurpose::Chat, "groq", "m", "a"), None).await.unwrap_err();
    assert!(matches!(&err, AiRunError::NoKey { provider, .. } if provider == "groq"), "{err:?}");
    assert_eq!(err.kind(), "no_key");
    assert!(r.api.calls().is_empty());
}

#[tokio::test]
async fn failures_are_typed_and_never_fall_back_to_another_provider() {
    let cases: Vec<(fn() -> LLMError, &str)> = vec![
        (|| LLMError::AuthError("Authentication failed: bad".into()), "no_key"),
        (|| LLMError::ProviderError("Anthropic request failed (429): rate limit exceeded".into()), "rate_limited"),
        (|| LLMError::ProviderError("You exceeded your current quota".into()), "rate_limited"),
        (|| LLMError::ConnectionFailed("Failed to connect to Ollama".into()), "unavailable"),
        (|| LLMError::NotConfigured("not set".into()), "unavailable"),
        (|| LLMError::ProviderError("This model's maximum context length is 8192 tokens".into()), "too_long"),
        (|| LLMError::InvalidResponse("garbage".into()), "other"),
    ];
    for (fail, kind) in cases {
        let r = rig();
        r.api.set(Behavior::Fail(fail));
        // Both a primary and a would-be fallback provider have keys.
        let err = r.runs.run(req(AiPurpose::Chat, "openai", "m", "a"), None).await.unwrap_err();
        assert_eq!(err.kind(), kind, "{err:?}");
        assert_eq!(r.api.calls().len(), 1, "exactly one attempt, on the provider asked for");
        assert_eq!(r.api.calls()[0].config.provider_type, "openai");
        assert_eq!(r.spawner.spawned.lock().unwrap().len(), 0, "no CLI fallback either");
    }
}

#[tokio::test]
async fn a_prompt_longer_than_the_models_window_is_refused_before_sending() {
    let r = rig();
    *r.api.listing.lock().unwrap() = vec![model_info("small", Some(1000)), model_info("big", Some(1_000_000))];
    let long = "word ".repeat(2000); // ~2500 tokens
    let err = r.runs.run(req(AiPurpose::Chat, "openai", "small", &long), None).await.unwrap_err();
    match err {
        AiRunError::TooLong { needed, window } => {
            assert_eq!(window, 1000);
            assert!(needed > 2500);
        }
        other => panic!("{other:?}"),
    }
    assert!(r.api.calls().is_empty());
    // The same prompt fits the big one.
    r.runs.run(req(AiPurpose::Chat, "openai", "big", &long), None).await.unwrap();
}

#[tokio::test]
async fn the_window_comes_from_the_listing_once_and_from_show_for_ollama() {
    let r = rig();
    *r.api.listing.lock().unwrap() = vec![model_info("a", Some(200_000)), model_info("b", Some(128_000)), model_info("nowin", None)];
    assert_eq!(r.runs.model_window(&sel("openai", "a")).await, Some(200_000));
    assert_eq!(r.runs.model_window(&sel("openai", "b")).await, Some(128_000));
    assert_eq!(r.runs.model_window(&sel("openai", "nowin")).await, None);
    assert_eq!(r.runs.model_window(&sel("openai", "a")).await, Some(200_000));
    assert_eq!(r.api.list_calls.load(Ordering::SeqCst), 1, "one listing serves every model");

    *r.api.ollama_window.lock().unwrap() = Some(32_768);
    assert_eq!(r.runs.model_window(&sel("ollama", "qwen")).await, Some(32_768));
    assert_eq!(r.runs.model_window(&sel("ollama", "qwen")).await, Some(32_768));
    assert_eq!(r.api.show_calls.load(Ordering::SeqCst), 1);

    assert_eq!(r.runs.model_window(&sel("claude_cli", "sonnet")).await, Some(200_000));
    assert_eq!(r.runs.model_window(&sel("claude_cli", "opus[1m]")).await, Some(1_000_000));
    assert_eq!(r.runs.model_window(&sel("nope", "x")).await, None);
}

#[tokio::test]
async fn ollama_runs_send_num_ctx_sized_to_the_prompt_and_never_below_before() {
    let r = rig();
    *r.api.ollama_window.lock().unwrap() = Some(131_072);
    r.runs.run(req(AiPurpose::Chat, "ollama", "llama", "short"), None).await.unwrap();
    let long = "w".repeat(4 * 9000);
    r.runs.run(req(AiPurpose::Chat, "ollama", "llama", &long), None).await.unwrap();
    // Shorter again: the context does not shrink (a server reloads the model when it changes).
    r.runs.run(req(AiPurpose::Chat, "ollama", "llama", "short"), None).await.unwrap();
    let ctx: Vec<_> = r.api.calls().iter().map(|c| c.params.num_ctx).collect();
    assert_eq!(ctx, vec![Some(4096), Some(16384), Some(16384)]);

    // Other providers get none.
    r.runs.run(req(AiPurpose::Chat, "openai", "m", "x"), None).await.unwrap();
    assert_eq!(r.api.calls().last().unwrap().params.num_ctx, None);
}

#[tokio::test]
async fn num_ctx_never_goes_above_the_models_window_and_a_users_own_value_wins() {
    let r = rig();
    *r.api.ollama_window.lock().unwrap() = Some(6000);
    r.runs.run(req(AiPurpose::Chat, "ollama", "tiny", "x"), None).await.unwrap();
    assert_eq!(r.api.calls()[0].params.num_ctx, Some(4096));
    let long = "w".repeat(4 * 4500);
    r.runs.run(req(AiPurpose::Chat, "ollama", "tiny", &long), None).await.unwrap();
    assert_eq!(r.api.calls()[1].params.num_ctx, Some(6000));

    // The user set num_ctx in the provider's extra JSON: that is what the server
    // gets (it is merged last), so the run is checked against it and sends none.
    let r = rig();
    *r.api.ollama_window.lock().unwrap() = Some(131_072);
    r.configs.extra.lock().unwrap().insert("ollama".into(), r#"{"options":{"num_ctx":2048}}"#.into());
    let err = r.runs.run(req(AiPurpose::Chat, "ollama", "m", &"w".repeat(4 * 3000)), None).await.unwrap_err();
    assert!(matches!(err, AiRunError::TooLong { window: 2048, .. }), "{err:?}");
    r.runs.run(req(AiPurpose::Chat, "ollama", "m", "short"), None).await.unwrap();
    assert_eq!(r.api.calls().last().unwrap().params.num_ctx, None);
}

#[tokio::test]
async fn effort_becomes_the_requests_thinking_and_background_runs_default_to_none() {
    let r = rig();
    let mut high = req(AiPurpose::Chat, "openai", "m", "x");
    high.selection.effort = Some("high".into());
    r.runs.run(high, None).await.unwrap();
    let mut low = req(AiPurpose::Chat, "openai", "m", "x");
    low.selection.effort = Some("low".into());
    r.runs.run(low, None).await.unwrap();
    r.runs.run(req(AiPurpose::Notes, "openai", "m", "x"), None).await.unwrap();
    r.runs.run(req(AiPurpose::Chat, "openai", "m", "x"), None).await.unwrap();
    let c = r.api.calls();
    assert_eq!(c[0].params.thinking, ThinkingSetting::High);
    assert_eq!(c[1].params.thinking, ThinkingSetting::Low);
    assert!(c[2].params.thinking_auto_off && c[2].params.thinking == ThinkingSetting::Auto);
    assert!(!c[3].params.thinking_auto_off);
}

// ---------------------------------------------------------------------------
// Priority
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_local_run_waits_for_a_live_answer_on_its_server_then_starts() {
    let r = Arc::new(rig());
    r.gate.set_target(LiveTarget::for_provider(&ProviderType::Ollama, None));
    *r.api.ollama_window.lock().unwrap() = Some(32_768);
    let live = r.gate.enter();
    let task = tokio::spawn({
        let r = r.clone();
        async move { r.runs.run(req(AiPurpose::Chat, "ollama", "m", "x"), None).await }
    });
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert!(r.api.calls().is_empty(), "never starts while the live answer runs");
    drop(live);
    task.await.unwrap().unwrap();
    assert_eq!(r.api.calls().len(), 1);
}

#[tokio::test]
async fn a_local_run_gives_up_with_preempted_when_live_does_not_finish() {
    let r = rig();
    r.gate.set_target(LiveTarget::Server("localhost:11434".into()));
    let _live = r.gate.enter();
    let err = r.runs.run(req(AiPurpose::Notes, "ollama", "m", "x"), None).await.unwrap_err();
    assert_eq!(err, AiRunError::Preempted);
    assert!(r.api.calls().is_empty());
}

#[tokio::test]
async fn a_running_local_run_is_cancelled_when_a_live_answer_starts() {
    let r = Arc::new(rig());
    r.gate.set_target(LiveTarget::Server("localhost:11434".into()));
    r.api.set(Behavior::UntilCancelled);
    let request = req(AiPurpose::Brief, "ollama", "m", "x");
    let caller_cancel = request.cancel.clone();
    let task = tokio::spawn({
        let r = r.clone();
        async move { r.runs.run(request, None).await }
    });
    tokio::time::sleep(Duration::from_millis(60)).await;
    assert_eq!(r.api.calls().len(), 1, "it started: the server was free");
    let _live = r.gate.enter();
    let err = tokio::time::timeout(Duration::from_secs(2), task).await.unwrap().unwrap().unwrap_err();
    assert_eq!(err, AiRunError::Preempted, "stopped for the live answer, and said so");
    assert!(!caller_cancel.is_cancelled(), "the caller's own token is not touched");
}

#[tokio::test]
async fn live_on_another_server_or_on_an_api_does_not_hold_a_local_run() {
    let r = rig();
    // Live answers go to LM Studio; the run is on Ollama.
    r.gate.set_target(LiveTarget::for_provider(&ProviderType::LmStudio, None));
    let _live = r.gate.enter();
    *r.api.ollama_window.lock().unwrap() = Some(32_768);
    r.runs.run(req(AiPurpose::Chat, "ollama", "m", "x"), None).await.unwrap();
    // Live answers go to a cloud API.
    r.gate.set_target(LiveTarget::NoLocalServer);
    r.runs.run(req(AiPurpose::Chat, "ollama", "m", "x"), None).await.unwrap();
    assert_eq!(r.api.calls().len(), 2);
}

#[tokio::test]
async fn notes_and_brief_on_an_api_wait_for_live_but_chat_and_memory_do_not() {
    let r = Arc::new(rig());
    let live = r.gate.enter();
    for purpose in [AiPurpose::Chat, AiPurpose::Memory, AiPurpose::Recap] {
        r.runs.run(req(purpose, "openai", "m", "x"), None).await.unwrap();
    }
    assert_eq!(r.api.calls().len(), 3, "user-facing runs go through");

    let before = r.api.calls().len();
    let task = tokio::spawn({
        let r = r.clone();
        async move { r.runs.run(req(AiPurpose::Notes, "openai", "m", "x"), None).await }
    });
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert_eq!(r.api.calls().len(), before, "notes do not start under a live answer");
    drop(live);
    task.await.unwrap().unwrap();
    assert_eq!(r.api.calls().len(), before + 1);
}

#[tokio::test]
async fn a_cli_notes_run_does_not_start_under_a_live_answer_either() {
    let r = rig();
    let _live = r.gate.enter();
    let mut request = req(AiPurpose::Notes, "claude_cli", "haiku", "x");
    request.session_key = Some(SessionKey::plain(SessionScope::Notes("m1".into()), Tier::Fast));
    let err = r.runs.run(request, None).await.unwrap_err();
    assert_eq!(err, AiRunError::Preempted);
    assert!(r.spawner.spawned.lock().unwrap().is_empty());
}

#[tokio::test]
async fn cancelling_while_waiting_for_live_ends_the_wait() {
    let r = Arc::new(rig());
    let _live = r.gate.enter();
    let request = req(AiPurpose::Notes, "openai", "m", "x");
    let cancel = request.cancel.clone();
    let task = tokio::spawn({
        let r = r.clone();
        async move { r.runs.run(request, None).await }
    });
    tokio::time::sleep(Duration::from_millis(30)).await;
    cancel.cancel();
    assert_eq!(task.await.unwrap().unwrap_err(), AiRunError::Cancelled);
}

// ---------------------------------------------------------------------------
// CLI agents
// ---------------------------------------------------------------------------

fn chat_key(id: &str) -> SessionKey {
    SessionKey::plain(SessionScope::Workspace(id.into()), Tier::Deep)
}

fn cli_req(provider: &str, model: &str, effort: Option<&str>, key: &SessionKey, user: &str) -> AiRunRequest {
    let mut r = AiRunRequest::new(AiPurpose::Chat, ModelSelection::new(provider, model, effort), "SYS", user);
    r.session_key = Some(key.clone());
    r
}

#[tokio::test]
async fn a_chat_uses_codex_while_the_live_provider_is_claude() {
    let r = rig();
    r.settings.set_active(CliAgentKind::Claude);
    let key = chat_key("c1");
    let (sink, seen) = collecting();
    let out = r.runs.run(cli_req("codex_cli", "gpt-x", Some("high"), &key, "hello"), Some(sink)).await.unwrap();
    assert_eq!(out.text, "answer to hello");
    assert_eq!(*seen.lock().unwrap(), vec!["answer".to_string()], "thinking markers never reach the sink");
    assert_eq!(out.usage.input_tokens, 10);
    assert_eq!(out.usage.cache_read_tokens, 30);
    assert_eq!(out.usage.cost_usd, Some(0.25));
    assert_eq!(out.window, Some(200_000));
    assert_eq!(out.model, "gpt-x");

    let (cfg, _) = r.spawner.spawned.lock().unwrap()[0].clone();
    assert_eq!(cfg.kind, CliAgentKind::Codex);
    assert_eq!(cfg.model, "gpt-x");
    assert_eq!(cfg.effort.as_deref(), Some("high"));
    assert_eq!(cfg.system_prompt, "SYS");
    assert_eq!(r.settings.active(), CliAgentKind::Claude, "the live provider is untouched");
}

#[tokio::test]
async fn a_live_provider_switch_leaves_a_chat_of_another_kind_open() {
    let r = rig();
    let key = chat_key("c1");
    r.runs.run(cli_req("codex_cli", "gpt-x", None, &key, "hi"), None).await.unwrap();
    // A plain session that follows the active provider (Claude).
    r.cli.ensure(&SessionKey::plain(SessionScope::Live("m".into()), Tier::Fast), SessionInit::default()).await.unwrap();
    // The user switches the live provider to Antigravity.
    r.settings.set_active(CliAgentKind::Antigravity);
    let closed = r.cli.close_other_kinds().await;
    assert_eq!(closed, 1, "only the live Claude session");
    let spawned = r.spawner.spawned.lock().unwrap();
    let codex = spawned.iter().find(|(c, _)| c.kind == CliAgentKind::Codex).unwrap();
    assert!(!codex.1.closed.load(Ordering::SeqCst), "the chat's Codex session stays");
    drop(spawned);
    // And the chat goes on in the same session.
    r.runs.run(cli_req("codex_cli", "gpt-x", None, &key, "again"), None).await.unwrap();
    assert_eq!(r.spawner.spawned.lock().unwrap().iter().filter(|(c, _)| c.kind == CliAgentKind::Codex).count(), 1);
}

#[tokio::test]
async fn a_chat_session_is_reused_sends_only_the_new_turn_and_replays_history_once() {
    let r = rig();
    let key = chat_key("c1");
    let mut first = cli_req("claude_cli", "sonnet", None, &key, "second question");
    first.messages = vec![
        LLMMessage { role: "user".into(), content: "first question".into() },
        LLMMessage { role: "assistant".into(), content: "first answer".into() },
        LLMMessage { role: "user".into(), content: "second question".into() },
    ];
    r.runs.run(first, None).await.unwrap();
    let mut again = cli_req("claude_cli", "sonnet", None, &key, "third question");
    again.messages = vec![
        LLMMessage { role: "user".into(), content: "first question".into() },
        LLMMessage { role: "assistant".into(), content: "first answer".into() },
        LLMMessage { role: "user".into(), content: "second question".into() },
        LLMMessage { role: "assistant".into(), content: "x".into() },
        LLMMessage { role: "user".into(), content: "third question".into() },
    ];
    r.runs.run(again, None).await.unwrap();

    let spawned = r.spawner.spawned.lock().unwrap();
    assert_eq!(spawned.len(), 1, "one session for the chat");
    let session = &spawned[0].1;
    assert_eq!(*session.asked.lock().unwrap(), vec!["second question", "third question"]);
    let appended = session.appended.lock().unwrap();
    assert_eq!(appended.len(), 1, "the earlier turns are replayed only when the session starts");
    assert!(appended[0].contains("first question") && appended[0].contains("first answer"));
}

#[tokio::test]
async fn changing_the_chats_model_replaces_its_session() {
    let r = rig();
    let key = chat_key("c1");
    r.runs.run(cli_req("claude_cli", "sonnet", Some("medium"), &key, "a"), None).await.unwrap();
    r.runs.run(cli_req("claude_cli", "sonnet", Some("medium"), &key, "b"), None).await.unwrap();
    r.runs.run(cli_req("claude_cli", "opus", Some("high"), &key, "c"), None).await.unwrap();
    let spawned = r.spawner.spawned.lock().unwrap();
    assert_eq!(spawned.len(), 2);
    assert!(spawned[0].1.closed.load(Ordering::SeqCst));
    assert_eq!(spawned[1].0.model, "opus");
}

#[tokio::test]
async fn a_run_without_a_session_key_uses_one_session_and_closes_it() {
    let r = rig();
    let request = AiRunRequest::new(AiPurpose::Memory, sel("claude_cli", "haiku"), "SYS", "extract");
    let out = r.runs.run(request, None).await.unwrap();
    assert_eq!(out.text, "answer to extract");
    let spawned = r.spawner.spawned.lock().unwrap();
    assert_eq!(spawned.len(), 1);
    assert!(spawned[0].1.closed.load(Ordering::SeqCst));
    assert!(r.cli.snapshot().is_empty());
}

#[tokio::test]
async fn notes_runs_start_a_fresh_session_after_n_turns() {
    let r = rig();
    let key = SessionKey::plain(SessionScope::Notes("m1".into()), Tier::Fast);
    for i in 0..5 {
        let mut request = cli_req("claude_cli", "haiku", None, &key, &format!("run {i}"));
        request.purpose = AiPurpose::Notes;
        request.recycle_after = Some(2);
        r.runs.run(request, None).await.unwrap();
    }
    // Turns 1-2 on the first session, 3-4 on the second, 5 on the third.
    let spawned = r.spawner.spawned.lock().unwrap();
    assert_eq!(spawned.len(), 3);
    let asked: Vec<usize> = spawned.iter().map(|(_, s)| s.asked.lock().unwrap().len()).collect();
    assert_eq!(asked, vec![2, 2, 1]);
    // Notes ran thinking-off.
    assert!(!spawned[0].0.thinking);
}

#[tokio::test]
async fn the_plan_limit_is_surfaced_on_success_and_on_failure() {
    let r = rig();
    let key = chat_key("c1");
    let near = r.runs.run(cli_req("claude_cli", "sonnet", None, &key, "warn"), None).await.unwrap();
    let limit = near.plan_limit.expect("near the limit");
    assert_eq!(limit.level, PlanLimitLevel::Near);
    assert_eq!(limit.resets_at, Some(1_900_000_000));
    let calm = r.runs.run(cli_req("claude_cli", "sonnet", None, &key, "fine"), None).await.unwrap();
    assert!(calm.plan_limit.is_none(), "the signal is taken once");

    let err = r.runs.run(cli_req("claude_cli", "sonnet", None, &key, "limit"), None).await.unwrap_err();
    match &err {
        AiRunError::RateLimited { plan_limit: Some(l), .. } => {
            assert_eq!(l.level, PlanLimitLevel::Hit);
            assert_eq!(l.resets_at, Some(1_900_000_000));
        }
        other => panic!("{other:?}"),
    }
    assert!(err.plan_limit().is_some());
    // An error result the CLI printed as text is a rate limit too.
    let key2 = chat_key("c2");
    let err = r.runs.run(cli_req("claude_cli", "sonnet", None, &key2, "errresult"), None).await.unwrap_err();
    assert_eq!(err.kind(), "rate_limited");
    assert_eq!(err.plan_limit().map(|l| l.level), Some(PlanLimitLevel::Hit));
}

#[tokio::test]
async fn a_cli_failure_never_falls_back_to_an_api_provider() {
    let r = rig();
    let key = chat_key("c1");
    let err = r.runs.run(cli_req("claude_cli", "sonnet", None, &key, "limit"), None).await.unwrap_err();
    assert_eq!(err.kind(), "rate_limited");
    assert!(r.api.calls().is_empty());
}

#[tokio::test]
async fn a_chat_session_gets_its_transcript_folder_launch() {
    let r = rig();
    let key = SessionKey::sources(SessionScope::Workspace("c9".into()), Tier::Deep);
    r.cli.set_chat_approvals(crate::llm::cli_agent::approval::ChatApprovals {
        can_ask: true,
        chat_id: "c9".into(),
        broker: Arc::new(crate::llm::cli_agent::approval::WorkspaceApprovals::new()),
        policy: Arc::new(Default::default()),
    });
    let launch = SourcesLaunch { add_dirs: vec!["/tmp/x".into()], ..Default::default() };
    let mut request = cli_req("claude_cli", "sonnet", None, &key, "q");
    request.sources = Some(launch.clone());
    r.runs.run(request, None).await.unwrap();
    let spawned = r.spawner.spawned.lock().unwrap();
    assert_eq!(spawned[0].0.sources.as_ref().map(|s| s.add_dirs.clone()), Some(launch.add_dirs));
}

#[tokio::test]
async fn a_cli_prompt_longer_than_the_window_is_refused() {
    let r = rig();
    let key = chat_key("c1");
    let huge = "w".repeat(4 * 250_000);
    let err = r.runs.run(cli_req("claude_cli", "sonnet", None, &key, &huge), None).await.unwrap_err();
    assert!(matches!(err, AiRunError::TooLong { window: 200_000, .. }), "{err:?}");
    assert!(r.spawner.spawned.lock().unwrap().is_empty());
}

#[tokio::test]
async fn closing_a_chat_waits_for_its_turn_in_flight_and_keeps_usage() {
    let r = Arc::new(rig());
    r.spawner.delay_ms.store(150, Ordering::SeqCst);
    let key = chat_key("c1");
    let task = tokio::spawn({
        let r = r.clone();
        let key = key.clone();
        async move { r.runs.run(cli_req("claude_cli", "sonnet", None, &key, "slow one"), None).await }
    });
    tokio::time::sleep(Duration::from_millis(60)).await;
    r.runs.close_chat("c1").await;
    // The answer in flight was delivered, and only then did the session close.
    assert_eq!(task.await.unwrap().unwrap().text, "answer to slow one");
    assert!(r.spawner.spawned.lock().unwrap()[0].1.closed.load(Ordering::SeqCst));
    assert_eq!(r.cli.usage(&key.scope).requests, 1, "usage survives the close");
}

#[test]
fn error_kinds_and_texts() {
    assert_eq!(AiRunError::Preempted.kind(), "preempted");
    assert_eq!(AiRunError::Cancelled.kind(), "cancelled");
    assert!(AiRunError::TooLong { needed: 10, window: 5 }.to_string().contains("window (5 tokens)"));
    assert!(AiRunError::TooLong { needed: 10, window: 0 }.to_string().contains("too long"));
    let u = AiUsage { input_tokens: 5, output_tokens: 3, cache_read_tokens: 10, cache_write_tokens: 1, ..Default::default() };
    assert_eq!((u.prompt_tokens(), u.billable_new_tokens()), (16, 8));
    assert_eq!(thinking_for_effort(Some("xhigh")), ThinkingSetting::High);
    assert_eq!(thinking_for_effort(Some("off")), ThinkingSetting::Off);
    assert_eq!(thinking_for_effort(None), ThinkingSetting::Auto);
}

#[tokio::test]
async fn a_run_built_before_its_scope_restarted_starts_no_session() {
    let r = rig();
    let key = chat_key("c1");
    let scope = key.scope.clone();
    let before = r.runs.generation(&key);
    r.cli.detach_scope(&scope); // the workspace changed: the chat's sessions restart
    let mut stale = cli_req("claude_cli", "sonnet", None, &key, "question");
    stale.expected_generation = Some(before);
    let err = r.runs.run(stale, None).await.unwrap_err();
    assert!(matches!(err, AiRunError::Unavailable { ref message } if message.contains("changed")), "{err:?}");
    assert!(r.spawner.spawned.lock().unwrap().is_empty(), "nothing started from the old context");
    // The same run built after the change goes through.
    let mut fresh = cli_req("claude_cli", "sonnet", None, &key, "question");
    fresh.expected_generation = Some(r.runs.generation(&key));
    assert!(r.runs.run(fresh, None).await.is_ok());
}

// ---------------------------------------------------------------------------
// The model lists "Automatic" picks from
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_provider_list_is_fetched_once_kept_and_read_without_fetching() {
    let r = rig();
    *r.api.listing.lock().unwrap() = vec![model_info("gpt-5", Some(400_000)), model_info("gpt-5-nano", Some(400_000)), model_info("gpt-4o-mini-tts", None)];
    // Unknown until fetched: reading never fetches.
    assert_eq!(r.runs.known_models("openai"), None);
    assert!(r.runs.models_due("openai"));
    assert_eq!(r.api.list_calls.load(Ordering::SeqCst), 0);
    let told: Arc<Mutex<Vec<String>>> = Arc::default();
    let sink = told.clone();
    r.runs.set_models_updated(Arc::new(move |p: &str| sink.lock().unwrap().push(p.to_string())));
    assert!(r.runs.refresh_models("openai").await);
    assert_eq!(r.runs.known_models("openai"), Some(vec!["gpt-5".to_string(), "gpt-5-nano".to_string(), "gpt-4o-mini-tts".to_string()]));
    assert_eq!(*told.lock().unwrap(), vec!["openai".to_string()], "the UI hears it arrived");
    // Within the day: no second fetch.
    assert!(!r.runs.models_due("openai"));
    assert!(!r.runs.refresh_models("openai").await);
    assert_eq!(r.api.list_calls.load(Ordering::SeqCst), 1);
    // What "Automatic" says: the label is the active model before the list, the small one after.
    use crate::live_runtime::cheapest::{cheapest, CheapestInput};
    let label = |avail: &[String]| cheapest(&CheapestInput { provider: "openai", active_model: "gpt-5", available: avail, ..Default::default() }).label;
    assert_eq!(label(&[]), "OpenAI · gpt-5 (active model)");
    assert_eq!(label(&r.runs.known_models("openai").unwrap()), "OpenAI · gpt-5-nano (cheapest)", "the speech model is skipped");
}

#[tokio::test]
async fn a_changed_key_or_address_makes_the_list_stale_and_due_again() {
    let r = rig();
    *r.api.listing.lock().unwrap() = vec![model_info("gpt-5-nano", None)];
    assert!(r.runs.refresh_models("openai").await);
    assert!(r.runs.known_models("openai").is_some());
    r.configs.base_urls.lock().unwrap().insert("openai".into(), "http://proxy.example/v1".into());
    assert_eq!(r.runs.known_models("openai"), None, "fetched for another address");
    assert!(r.runs.models_due("openai"));
    assert!(r.runs.refresh_models("openai").await);
    assert_eq!(r.api.list_calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn a_list_is_never_fetched_while_a_live_answer_runs_or_for_providers_that_keep_none() {
    let r = rig();
    *r.api.listing.lock().unwrap() = vec![model_info("gpt-5-nano", None)];
    let live = r.gate.enter();
    assert!(!r.runs.refresh_models("openai").await);
    assert_eq!(r.api.list_calls.load(Ordering::SeqCst), 0);
    drop(live);
    assert!(r.runs.refresh_models("openai").await);
    for p in ["ollama", "lm_studio", "custom", "claude_cli", "codex_cli", "antigravity_cli", "nope"] {
        assert!(!r.runs.models_due(p), "{p}");
        assert!(!r.runs.refresh_models(p).await, "{p}");
        assert_eq!(r.runs.known_models(p), None, "{p}");
    }
    assert_eq!(r.api.list_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_failed_or_empty_fetch_keeps_no_list_and_is_not_repeated_at_once() {
    let r = rig();
    // The provider answers with nothing usable.
    assert!(!r.runs.refresh_models("gemini").await);
    assert_eq!(r.runs.known_models("gemini"), None);
    assert!(!r.runs.models_due("gemini"), "waits before the next try");
    assert!(!r.runs.refresh_models("gemini").await);
    assert_eq!(r.api.list_calls.load(Ordering::SeqCst), 1);
    // No key saved: nothing to fetch with, nothing known.
    assert!(!r.runs.models_due("openrouter"));
    assert_eq!(r.runs.known_models("openrouter"), None);
}

#[tokio::test]
async fn an_old_list_is_fetched_again() {
    let api = FakeApi::new();
    *api.listing.lock().unwrap() = vec![model_info("claude-haiku-5-5", None)];
    let cli = Arc::new(AgentSessionManager::new(Arc::new(FakeSpawner::default()), Arc::new(NoopStatusSink), Arc::new(CliSettings::isolated())));
    let configs = FakeConfigs::new(&[("anthropic", "sk-ant")]);
    let runs = AiRuns::with_parts(api.clone(), cli, LiveGate::new(), configs).with_models_ttl(Duration::ZERO);
    assert!(runs.refresh_models("anthropic").await);
    assert!(runs.models_due("anthropic"));
    assert!(runs.refresh_models("anthropic").await);
    assert_eq!(api.list_calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn a_chats_tool_calls_reach_its_activity_emitter() {
    let r = rig();
    let seen: Arc<Mutex<Vec<(String, String)>>> = Arc::default();
    let sink = seen.clone();
    r.runs.set_chat_activity(Arc::new(move |chat, line| sink.lock().unwrap().push((chat.to_string(), line.label))));
    let key = chat_key("c1");
    r.runs.run(cli_req("claude_cli", "sonnet", None, &key, "tools"), None).await.unwrap();
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 1, "one tool call, one activity line: {seen:?}");
    assert_eq!(seen[0].0, "c1");
    assert!(!seen[0].1.is_empty());
}
