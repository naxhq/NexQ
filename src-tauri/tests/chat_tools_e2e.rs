//! End to end, with the fake CLI (`examples/fake_claude.rs`): a workspace chat
//! asks the AI service for an answer, the CLI calls a tool, the user is asked,
//! and the answer comes back. Everything between the fake process and the
//! events the chat store reads is the real code: `AiRuns`, the session
//! manager, `ClaudeSession`, the approval broker and `chat_events`.
//!
//! Covered: ask, card event, allow, tool runs, answer; deny; timeout; stop;
//! two chats at once; a read-only tool that never asks; every event carrying
//! the answer's id and never the CLI's own.

use async_trait::async_trait;
use nexq_lib::ai_runs::{
    chat_events, AiPurpose, AiRunError, AiRunRequest, AiRuns, ApiBackend, ConfigSource, LiveGate, ModelSelection,
};
use nexq_lib::llm::cli_agent::approval::{ApprovalPolicy, ChatApprovals, WorkspaceApprovals};
use nexq_lib::llm::cli_agent::command::{SessionConfig, SourcesLaunch};
use nexq_lib::llm::cli_agent::manager::{
    AgentSessionManager, NoopStatusSink, SessionHandle, SessionKey, SessionScope, SessionSpawner, Tier,
};
use nexq_lib::llm::cli_agent::session::{AgentError, ClaudeSession};
use nexq_lib::llm::cli_agent::settings::CliSettings;
use nexq_lib::llm::provider::{CancelToken, CompletionStats, GenerationParams, LLMError, LLMMessage, ModelInfo, TokenSink};
use nexq_lib::llm::ProviderConfig;
use nexq_lib::sources::config::{McpServer, McpTool};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

fn fake_bin() -> PathBuf {
    static BIN: OnceLock<PathBuf> = OnceLock::new();
    BIN.get_or_init(|| {
        let mut cmd = std::process::Command::new(env!("CARGO"));
        cmd.args(["build", "--example", "fake_claude"]).current_dir(env!("CARGO_MANIFEST_DIR"));
        for (key, _) in std::env::vars() {
            let injected = ["CARGO_MANIFEST_", "CARGO_PKG_", "CARGO_CRATE_", "CARGO_PRIMARY_PACKAGE", "CARGO_BIN_", "OUT_DIR"]
                .iter()
                .any(|p| key.starts_with(p));
            if injected {
                cmd.env_remove(key);
            }
        }
        if !cfg!(debug_assertions) {
            cmd.arg("--release");
        }
        let out = cmd.output().expect("run cargo build --example fake_claude");
        assert!(out.status.success(), "building fake_claude failed:\n{}", String::from_utf8_lossy(&out.stderr));
        let profile_dir = std::env::current_exe().unwrap().parent().unwrap().parent().unwrap().to_path_buf();
        let bin = profile_dir.join("examples").join(format!("fake_claude{}", std::env::consts::EXE_SUFFIX));
        assert!(bin.is_file(), "missing {}", bin.display());
        bin
    })
    .clone()
}

struct FakeCli;

#[async_trait]
impl SessionSpawner for FakeCli {
    async fn spawn(&self, cfg: SessionConfig) -> Result<Arc<dyn SessionHandle>, AgentError> {
        Ok(Arc::new(ClaudeSession::spawn(fake_bin(), cfg).await?))
    }
}

struct NoApi;

#[async_trait]
impl ApiBackend for NoApi {
    async fn stream(&self, _: ProviderConfig, _: Vec<LLMMessage>, _: String, _: GenerationParams, _: Option<TokenSink>) -> Result<CompletionStats, LLMError> {
        Err(LLMError::NotConfigured("no API in this test".into()))
    }
    async fn list_models(&self, _: ProviderConfig) -> Result<Vec<ModelInfo>, LLMError> {
        Err(LLMError::NotConfigured("no API in this test".into()))
    }
    async fn ollama_window(&self, _: &str, _: &str) -> Option<u64> {
        None
    }
}

struct NoConfigs;

impl ConfigSource for NoConfigs {
    fn config_for(&self, _: &ModelSelection) -> Result<ProviderConfig, AiRunError> {
        Err(AiRunError::Other { message: "no API in this test".into() })
    }
}

type Events = Arc<Mutex<Vec<(String, Value)>>>;

struct Rig {
    runs: Arc<AiRuns>,
    broker: Arc<WorkspaceApprovals>,
    events: Events,
    /// chat id -> the answer it is writing (what the chat hub knows).
    asks: Arc<Mutex<HashMap<String, String>>>,
    dir: PathBuf,
}

impl Rig {
    fn new(name: &str, approval_timeout: Duration, chats: &[&str]) -> Rig {
        // Built here, before any clock runs: the first test pays for the build.
        fake_bin();
        let dir = std::env::temp_dir().join(format!("nexq-chat-e2e-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("notes")).unwrap();
        let cli = Arc::new(AgentSessionManager::new(Arc::new(FakeCli), Arc::new(NoopStatusSink), Arc::new(CliSettings::isolated())));
        let runs = Arc::new(AiRuns::with_parts(Arc::new(NoApi), cli.clone(), LiveGate::new(), Arc::new(NoConfigs)));
        let broker = Arc::new(WorkspaceApprovals::new().with_timeout(approval_timeout));
        let events: Events = Arc::default();
        let sink = events.clone();
        // The same emitter the app installs: the payloads are made by the real functions.
        broker.set_emitter(Arc::new(move |n| {
            let (event, payload) = nexq_lib::llm::cli_agent::approval::notice_payload(&n);
            sink.lock().unwrap().push((event.to_string(), payload));
        }));
        let asks: Arc<Mutex<HashMap<String, String>>> = Arc::default();
        let (resolve, sink2) = (asks.clone(), events.clone());
        chat_events::wire(
            &runs,
            &broker,
            Arc::new(move |chat| resolve.lock().unwrap().get(chat).cloned()),
            Arc::new(move |event, payload| sink2.lock().unwrap().push((event.to_string(), payload))),
        );
        let tool = |n: &str, ro: Option<bool>| McpTool {
            name: n.into(),
            full_name: format!("mcp__fake__{n}"),
            allowed: true,
            read_only_hint: ro,
            destructive_hint: None,
        };
        let policy = Arc::new(ApprovalPolicy::from_servers(
            &[McpServer { key: "fake".into(), tools: vec![tool("read_note", Some(true)), tool("set_flag", None)], ..Default::default() }],
            vec![dir.join("notes")],
        ));
        for chat in chats {
            cli.set_chat_approvals(ChatApprovals { can_ask: true, chat_id: chat.to_string(), broker: broker.clone(), policy: policy.clone() });
        }
        Rig { runs, broker, events, asks, dir }
    }

    fn log(&self) -> Vec<String> {
        std::fs::read_to_string(self.dir.join("tool.log")).unwrap_or_default().lines().map(str::to_string).collect()
    }

    fn request(&self, chat: &str, ask_id: &str, query: &str) -> AiRunRequest {
        self.asks.lock().unwrap().insert(chat.to_string(), ask_id.to_string());
        let system = format!("fake_tool_log={}\nYou are a test.", self.dir.join("tool.log").display());
        let mut req = AiRunRequest::new(AiPurpose::Chat, ModelSelection::new("claude_cli", "haiku", None), &system, query);
        req.session_key = Some(SessionKey::sources(SessionScope::Workspace(chat.to_string()), Tier::Deep));
        req.sources = Some(SourcesLaunch {
            add_dirs: vec![self.dir.join("notes")],
            mcp_config_json: Some(r#"{"mcpServers":{}}"#.into()),
            allowed_tools: vec!["mcp__fake__read_note".into(), "mcp__fake__set_flag".into()],
            server_labels: vec![("fake".into(), "Fake".into())],
            ..Default::default()
        });
        req
    }

    fn of(&self, event: &str, chat: &str) -> Vec<Value> {
        self.events.lock().unwrap().iter().filter(|(e, p)| e == event && p["chat_id"] == chat).map(|(_, p)| p.clone()).collect()
    }

    async fn question(&self, chat: &str) -> Value {
        let end = Instant::now() + Duration::from_secs(30);
        while Instant::now() < end {
            if let Some(q) = self.of("workspace_chat_approval", chat).first() {
                return q.clone();
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("no tool question for {chat}: {:?}", self.events.lock().unwrap());
    }

    fn clean(&self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn spawn_run(rig: &Rig, req: AiRunRequest) -> tokio::task::JoinHandle<Result<String, AiRunError>> {
    let runs = rig.runs.clone();
    tokio::spawn(async move { runs.run(req, None).await.map(|r| r.text) })
}

const SET_FLAG: &str = r#"tool:mcp__fake__set_flag {"value":"on"}"#;

fn no_cli_ids(events: &Events) {
    let all = serde_json::to_string(&*events.lock().unwrap()).unwrap();
    assert!(!all.contains("req-"), "the CLI's own permission id leaked into an event: {all}");
}

#[tokio::test]
async fn a_tool_that_asks_shows_a_card_for_the_running_answer_and_allow_runs_it_once() {
    let rig = Rig::new("allow", Duration::from_secs(60), &["c1"]);
    let run = spawn_run(&rig, rig.request("c1", "ask-1", SET_FLAG));
    let q = rig.question("c1").await;
    // The card belongs to the answer the chat is writing, with the call's own arguments.
    assert_eq!(q["request_id"], "ask-1");
    assert_eq!((q["server"].as_str(), q["tool"].as_str()), (Some("fake"), Some("set_flag")));
    assert!(q["args"].as_str().unwrap().contains("\"value\": \"on\""));
    assert!(rig.log().is_empty(), "nothing ran before the click");
    assert!(rig.broker.answer(q["approval_id"].as_str().unwrap(), true));
    assert_eq!(run.await.unwrap().unwrap(), "tool:ran");
    // It ran once, with exactly the arguments that were shown.
    assert_eq!(rig.log(), vec![r#"ran mcp__fake__set_flag {"value":"on"}"#.to_string()]);
    // The activity of the answer: the tool, then its chip once it ended well.
    let activity = rig.of("workspace_chat_activity", "c1");
    assert!(activity.iter().all(|a| a["request_id"] == "ask-1"));
    assert!(activity.iter().any(|a| a["activity"]["label"] == "Fake: set_flag" && a["activity"]["chip"].is_null()));
    assert!(activity.iter().any(|a| a["activity"]["chip_only"] == true));
    assert!(rig.of("workspace_chat_approval_closed", "c1").iter().any(|c| c["reason"] == "answered"));
    no_cli_ids(&rig.events);
    rig.clean();
}

#[tokio::test]
async fn deny_means_the_tool_did_not_run_and_the_chat_is_told() {
    let rig = Rig::new("deny", Duration::from_secs(60), &["c1"]);
    let run = spawn_run(&rig, rig.request("c1", "ask-1", SET_FLAG));
    let q = rig.question("c1").await;
    assert!(rig.broker.answer(q["approval_id"].as_str().unwrap(), false));
    assert_eq!(run.await.unwrap().unwrap(), "tool:refused");
    assert!(rig.log().is_empty());
    let activity = rig.of("workspace_chat_activity", "c1");
    assert!(
        activity.iter().any(|a| a["activity"]["kind"] == "notice" && a["activity"]["label"].as_str().unwrap().contains("was not run")),
        "{activity:?}"
    );
    no_cli_ids(&rig.events);
    rig.clean();
}

#[tokio::test]
async fn a_read_only_tool_runs_without_a_card() {
    let rig = Rig::new("readonly", Duration::from_secs(60), &["c1"]);
    let text = spawn_run(&rig, rig.request("c1", "ask-1", r#"tool:mcp__fake__read_note {"name":"a"}"#)).await.unwrap().unwrap();
    assert_eq!(text, "tool:ran");
    assert!(rig.of("workspace_chat_approval", "c1").is_empty());
    assert_eq!(rig.log().len(), 1);
    rig.clean();
}

#[tokio::test]
async fn nobody_answering_denies_after_the_timeout_and_the_card_is_closed_with_the_same_word() {
    let rig = Rig::new("timeout", Duration::from_millis(400), &["c1"]);
    let text = spawn_run(&rig, rig.request("c1", "ask-1", SET_FLAG)).await.unwrap().unwrap();
    assert_eq!(text, "tool:refused");
    assert!(rig.log().is_empty());
    let closed = rig.of("workspace_chat_approval_closed", "c1");
    assert!(closed.iter().any(|c| c["reason"] == "timed_out"), "{closed:?}");
    rig.clean();
}

#[tokio::test]
async fn stopping_the_answer_while_a_question_is_open_denies_it_and_closes_the_card() {
    let rig = Rig::new("stop", Duration::from_secs(60), &["c1"]);
    let mut req = rig.request("c1", "ask-1", SET_FLAG);
    let cancel = Arc::new(CancelToken::new());
    req.cancel = cancel.clone();
    let run = spawn_run(&rig, req);
    let q = rig.question("c1").await;
    cancel.cancel();
    assert_eq!(run.await.unwrap().unwrap_err(), AiRunError::Cancelled);
    assert!(!rig.broker.answer(q["approval_id"].as_str().unwrap(), true), "a late click finds nothing");
    assert!(rig.log().is_empty(), "the tool never ran");
    let closed = rig.of("workspace_chat_approval_closed", "c1");
    assert!(closed.iter().any(|c| c["reason"] == "cancelled"), "{closed:?}");
    rig.clean();
}

#[tokio::test]
async fn two_chats_ask_at_once_and_each_card_is_for_its_own_answer() {
    let rig = Rig::new("two", Duration::from_secs(60), &["c1", "c2"]);
    let r1 = spawn_run(&rig, rig.request("c1", "ask-1", SET_FLAG));
    let r2 = spawn_run(&rig, rig.request("c2", "ask-2", r#"tool:mcp__fake__set_flag {"value":"two"}"#));
    let (q1, q2) = (rig.question("c1").await, rig.question("c2").await);
    assert_eq!((q1["request_id"].as_str(), q2["request_id"].as_str()), (Some("ask-1"), Some("ask-2")));
    assert_ne!(q1["approval_id"], q2["approval_id"]);
    // Answer them the other way round: c2 allowed, c1 denied.
    assert!(rig.broker.answer(q2["approval_id"].as_str().unwrap(), true));
    assert!(rig.broker.answer(q1["approval_id"].as_str().unwrap(), false));
    assert_eq!(r2.await.unwrap().unwrap(), "tool:ran");
    assert_eq!(r1.await.unwrap().unwrap(), "tool:refused");
    assert_eq!(rig.log(), vec![r#"ran mcp__fake__set_flag {"value":"two"}"#.to_string()]);
    // Each chat's events carry only its own answer's id.
    for (chat, ask) in [("c1", "ask-1"), ("c2", "ask-2")] {
        for event in ["workspace_chat_approval", "workspace_chat_activity"] {
            assert!(rig.of(event, chat).iter().all(|p| p["request_id"] == ask), "{chat} {event}");
        }
    }
    no_cli_ids(&rig.events);
    rig.clean();
}

#[tokio::test]
async fn a_question_with_no_answer_running_is_refused_and_says_so() {
    // The chat hub knows no running answer for the chat: nothing may be asked.
    let rig = Rig::new("none", Duration::from_secs(60), &["c1"]);
    let req = rig.request("c1", "ask-1", SET_FLAG);
    rig.asks.lock().unwrap().clear();
    let text = spawn_run(&rig, req).await.unwrap().unwrap();
    assert_eq!(text, "tool:refused");
    assert!(rig.of("workspace_chat_approval", "c1").is_empty());
    assert!(rig.of("workspace_chat_approval_refused", "c1").iter().any(|r| r["reason"].as_str().unwrap().contains("no answer")));
    assert!(rig.log().is_empty());
    rig.clean();
    let _ = json!(null);
}
