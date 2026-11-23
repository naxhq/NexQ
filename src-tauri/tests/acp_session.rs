//! Integration tests for `AcpSession` against `examples/fake_acp.rs`.
//!
//! The fake is configured through launch args (`--record`, `--meta`, ...) and
//! by the text of each prompt; see its header. The live tests at the end talk
//! to a real, logged-in `agy` and are `#[ignore]`d.

use nexq_lib::llm::cli_agent::acp::permission::{McpToolRule, PermissionPolicy};
use nexq_lib::llm::cli_agent::acp::{probe_models, AcpLaunch, AcpSession};
use nexq_lib::llm::cli_agent::protocol::AgentErrorKind;
use nexq_lib::llm::cli_agent::session::{
    decode_activity, decode_tool_result, is_activity, AgentError, SessionTimeouts, THINKING_SIGNAL,
};
use nexq_lib::llm::provider::CancelToken;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Build `fake_acp` once and return its path (next to this test binary's
/// `deps` dir, so it follows whatever target dir / profile cargo used).
fn fake_bin() -> PathBuf {
    static BIN: OnceLock<PathBuf> = OnceLock::new();
    BIN.get_or_init(|| {
        let mut cmd = std::process::Command::new(env!("CARGO"));
        cmd.args(["build", "--example", "fake_acp"]).current_dir(env!("CARGO_MANIFEST_DIR"));
        // Drop the per-crate vars cargo injects into test processes: build scripts
        // watch CARGO_MANIFEST_DIR / OUT_DIR, so inheriting them would force a
        // full rebuild on every run.
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
        let out = cmd.output().expect("run cargo build --example fake_acp");
        assert!(out.status.success(), "building fake_acp failed:\n{}", String::from_utf8_lossy(&out.stderr));
        let profile_dir = std::env::current_exe().unwrap().parent().unwrap().parent().unwrap().to_path_buf();
        let bin = profile_dir.join("examples").join(format!("fake_acp{}", std::env::consts::EXE_SUFFIX));
        assert!(bin.is_file(), "missing {}", bin.display());
        bin
    })
    .clone()
}

/// A scratch dir with a notes folder (`notes/a.md`) and a file outside it.
struct Scratch {
    root: PathBuf,
    notes: PathBuf,
}

impl Scratch {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!("nexq-acp-it-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::write(root.join("notes").join("a.md"), "a").unwrap();
        std::fs::write(root.join("outside.md"), "o").unwrap();
        // The agent sends plain paths, not `\\?\` ones.
        let plain = |p: PathBuf| PathBuf::from(p.to_string_lossy().trim_start_matches(r"\\?\").to_string());
        let root = plain(std::fs::canonicalize(&root).unwrap());
        Self { notes: root.join("notes"), root }
    }

    fn record(&self) -> PathBuf {
        self.root.join("record.jsonl")
    }

    fn launch(&self, extra: &[&str]) -> AcpLaunch {
        let mut args: Vec<String> = vec!["--record".into(), self.record().to_string_lossy().into_owned()];
        args.extend(extra.iter().map(|a| a.to_string()));
        let mut launch = AcpLaunch::new(fake_bin(), args, self.root.clone());
        launch.policy = PermissionPolicy::new(
            std::slice::from_ref(&self.notes),
            vec![McpToolRule::tool("srv", "search")],
            vec![],
        );
        launch.mcp_servers = vec![serde_json::json!({"name": "srv", "command": "x", "args": [], "env": []})];
        launch.additional_dirs = vec![self.notes.clone()];
        launch
    }

    /// Every JSON line the fake received.
    fn recorded(&self) -> Vec<Value> {
        std::fs::read_to_string(self.record())
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect()
    }

    fn prompts(&self) -> Vec<String> {
        self.recorded()
            .iter()
            .filter(|m| m["method"] == "session/prompt")
            .map(|m| m["params"]["prompt"][0]["text"].as_str().unwrap_or_default().to_string())
            .collect()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

type Deltas = Arc<Mutex<Vec<String>>>;
type OnDeltaBox = Box<dyn Fn(&str) + Send + Sync>;

fn collector() -> (Deltas, OnDeltaBox) {
    let deltas: Deltas = Arc::new(Mutex::new(Vec::new()));
    let sink = deltas.clone();
    (deltas, Box::new(move |t: &str| sink.lock().unwrap().push(t.to_string())))
}

fn no_cancel() -> Arc<CancelToken> {
    Arc::new(CancelToken::new())
}

async fn ask(session: &AcpSession, prompt: &str) -> Result<nexq_lib::llm::cli_agent::protocol::TurnResult, AgentError> {
    let (_, on_delta) = collector();
    session.ask(prompt, on_delta, no_cancel()).await
}

#[tokio::test]
async fn streams_the_answer_thinking_once_and_usage() {
    let s = Scratch::new("stream");
    let mut launch = s.launch(&[]);
    launch.model = "fake-deep".into();
    let session = AcpSession::spawn(launch).await.unwrap();
    assert!(session.is_alive());
    assert_eq!(session.model(), "fake-deep");
    assert_eq!(session.models().len(), 2);

    let (deltas, on_delta) = collector();
    let result = session.ask("hello", on_delta, no_cancel()).await.unwrap();
    assert_eq!(result.text, "Hello world");
    assert!(!result.is_error);
    let got = deltas.lock().unwrap().clone();
    assert_eq!(got, vec![THINKING_SIGNAL.to_string(), "Hello".to_string(), " world".to_string()]);
    assert_eq!((result.input_tokens, result.output_tokens), (100, 7));
    assert_eq!((result.cache_read_tokens, result.thinking_tokens), (40, 3));
    assert_eq!(result.prompt_tokens(), 140);

    // The model was selected with session/set_model; the session used the fake's id.
    let rec = s.recorded();
    let set_model = rec.iter().find(|m| m["method"] == "session/set_model").expect("set_model sent");
    assert_eq!(set_model["params"]["modelId"], "fake-deep");
    assert_eq!(set_model["params"]["sessionId"], "fake-sid");
    // The session starts with no client fs or terminal, the cwd, the servers and the folders.
    let new = rec.iter().find(|m| m["method"] == "session/new").unwrap();
    assert_eq!(new["params"]["mcpServers"][0]["name"], "srv");
    assert!(new["params"].get("additionalDirectories").is_none(), "the fake did not advertise them");
    let init = rec.iter().find(|m| m["method"] == "initialize").unwrap();
    assert_eq!(init["params"]["clientCapabilities"]["terminal"], false);

    // Turns are repeatable and the default model is kept when none is chosen.
    let again = ask(&session, "plain question").await.unwrap();
    assert_eq!(again.text, "answer:plain question");
    session.close().await;
    assert!(!session.is_alive());
    session.close().await; // idempotent
}

#[tokio::test]
async fn no_model_keeps_the_agents_default_and_sends_advertised_dirs() {
    let s = Scratch::new("dirs");
    let session = AcpSession::spawn(s.launch(&["--dirs"])).await.unwrap();
    let rec = s.recorded();
    assert!(rec.iter().all(|m| m["method"] != "session/set_model"));
    let new = rec.iter().find(|m| m["method"] == "session/new").unwrap();
    assert_eq!(new["params"]["additionalDirectories"][0], s.notes.to_string_lossy().as_ref());
    session.close().await;
}

#[tokio::test]
async fn system_prompt_goes_in_the_first_prompt_when_the_agent_has_no_meta() {
    let s = Scratch::new("instructions");
    let mut launch = s.launch(&[]);
    launch.system_prompt = "Be terse.".into();
    let session = AcpSession::spawn(launch).await.unwrap();
    assert_eq!(ask(&session, "echo").await.unwrap().text, "echo:## Instructions\n\nBe terse.\n\necho");
    // Only the first prompt carries it.
    assert_eq!(ask(&session, "echo").await.unwrap().text, "echo:echo");
    let new = s.recorded().into_iter().find(|m| m["method"] == "session/new").unwrap();
    assert!(new["params"].get("_meta").is_none());
    session.close().await;
}

#[tokio::test]
async fn system_prompt_goes_in_session_new_meta_when_advertised() {
    let s = Scratch::new("meta");
    let mut launch = s.launch(&["--meta"]);
    launch.system_prompt = "Be terse.".into();
    let session = AcpSession::spawn(launch).await.unwrap();
    assert_eq!(ask(&session, "echo").await.unwrap().text, "echo:echo", "no Instructions block");
    let new = s.recorded().into_iter().find(|m| m["method"] == "session/new").unwrap();
    assert_eq!(new["params"]["_meta"]["antigravity"]["systemPrompt"]["append"], "Be terse.");
    session.close().await;
}

#[tokio::test]
async fn append_context_is_prepended_to_the_next_prompt_only() {
    let s = Scratch::new("context");
    let session = AcpSession::spawn(s.launch(&[])).await.unwrap();
    session.append_context("Earlier: Ana said hi.").await.unwrap();
    session.append_context("Earlier: Bo said bye.").await.unwrap();
    session.append_context("   ").await.unwrap(); // nothing to queue
    assert!(s.prompts().is_empty(), "no model call for context");
    let r = ask(&session, "echo").await.unwrap();
    assert_eq!(r.text, "echo:Earlier: Ana said hi.\n\nEarlier: Bo said bye.\n\necho");
    assert_eq!(ask(&session, "echo").await.unwrap().text, "echo:echo");
    assert_eq!(s.prompts().len(), 2);
    session.close().await;
    assert!(session.append_context("late").await.is_err(), "closed session");
}

/// Collects `(tool name, ended with error)` from an `ask`'s activity tokens.
fn tools_in(deltas: &[String]) -> Vec<(String, Option<bool>)> {
    let mut out: Vec<(String, Option<bool>)> = Vec::new();
    for token in deltas.iter().filter(|t| is_activity(t)) {
        if let Some(tool) = decode_activity(token) {
            out.push((tool.name, None));
        } else if let Some(done) = decode_tool_result(token) {
            out.last_mut().expect("a result follows its tool").1 = Some(done.is_error);
        }
    }
    out
}

async fn ask_collect(session: &AcpSession, prompt: &str) -> (String, Vec<String>) {
    let (deltas, on_delta) = collector();
    let r = session.ask(prompt, on_delta, no_cancel()).await.unwrap();
    let got = deltas.lock().unwrap().clone();
    (r.text, got)
}

#[tokio::test]
async fn permission_requests_follow_the_policy() {
    let s = Scratch::new("perm");
    let session = AcpSession::spawn(s.launch(&[])).await.unwrap();
    let inside = s.notes.join("a.md").to_string_lossy().into_owned();
    let outside = s.root.join("outside.md").to_string_lossy().into_owned();

    // execute: refused, and the tool ends in error.
    let (text, deltas) = ask_collect(&session, "perm:execute:run_command:").await;
    assert_eq!(text, "perm:rejected");
    assert_eq!(tools_in(&deltas), vec![("run_command".to_string(), Some(true))]);

    // read inside the notes folder: allowed, and it shows up as a Read chip source.
    let (text, deltas) = ask_collect(&session, &format!("perm:read:read_file:{inside}")).await;
    assert_eq!(text, "perm:allowed");
    assert_eq!(tools_in(&deltas), vec![("Read".to_string(), Some(false))]);
    let read = deltas.iter().find_map(|t| decode_activity(t)).unwrap();
    assert_eq!(read.input["file_path"], inside.as_str());

    // read outside the folder, and a traversal out of it: refused.
    assert_eq!(ask_collect(&session, &format!("perm:read:read_file:{outside}")).await.0, "perm:rejected");
    let traversal = format!("{}\\..\\outside.md", s.notes.display());
    assert_eq!(ask_collect(&session, &format!("perm:read:read_file:{traversal}")).await.0, "perm:rejected");
    // a read with no path at all: refused.
    assert_eq!(ask_collect(&session, "perm:read:read_file:").await.0, "perm:rejected");
    // an edit inside the folder: refused.
    assert_eq!(ask_collect(&session, &format!("perm:edit:edit_file:{inside}")).await.0, "perm:rejected");

    // An allowed MCP tool is allowed and named like Claude's `mcp__<server>__<tool>`.
    let (text, deltas) = ask_collect(&session, "perm:other:mcp_srv_search:").await;
    assert_eq!(text, "perm:allowed");
    assert_eq!(tools_in(&deltas), vec![("mcp__srv__search".to_string(), Some(false))]);
    // Another tool of the same server, and another server: refused.
    assert_eq!(ask_collect(&session, "perm:other:mcp_srv_delete:").await.0, "perm:rejected");
    assert_eq!(ask_collect(&session, "perm:other:mcp_other_search:").await.0, "perm:rejected");

    // The reply the agent got is a JSON-RPC result with the selected option.
    let replies: Vec<Value> = s.recorded().into_iter().filter(|m| m["result"]["outcome"].is_object()).collect();
    assert_eq!(replies.len(), 9);
    assert_eq!(replies[0]["result"]["outcome"], serde_json::json!({"outcome": "selected", "optionId": "deny"}));
    assert_eq!(replies[1]["result"]["outcome"]["optionId"], "allow");
    session.close().await;
}

#[tokio::test]
async fn unknown_agent_requests_get_an_error_reply() {
    let s = Scratch::new("fsreq");
    let session = AcpSession::spawn(s.launch(&[])).await.unwrap();
    assert_eq!(ask(&session, "fsreq").await.unwrap().text, "fs:error");
    let reply = s.recorded().into_iter().find(|m| m["id"] == 1000 && m.get("method").is_none()).expect("a reply to the agent's request");
    assert_eq!(reply["error"]["code"], -32601);
    session.close().await;
}

#[tokio::test]
async fn cancel_sends_session_cancel_and_the_next_turn_still_works() {
    let s = Scratch::new("cancel");
    let session = AcpSession::spawn(s.launch(&[])).await.unwrap();
    let cancel = no_cancel();
    let (deltas, on_delta) = collector();
    let canceller = {
        let (cancel, deltas) = (cancel.clone(), deltas.clone());
        tokio::spawn(async move {
            while deltas.lock().unwrap().is_empty() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            cancel.cancel();
        })
    };
    let start = Instant::now();
    let err = session.ask("slow", on_delta, cancel).await.unwrap_err();
    canceller.await.unwrap();
    assert!(matches!(err, AgentError::Cancelled), "{err:?}");
    assert!(start.elapsed() < Duration::from_secs(4), "slow turn is 5 s: cancel must cut it short");

    // The next turn waits for the cancelled one to finish, then answers.
    let r = ask(&session, "hello").await.unwrap();
    assert_eq!(r.text, "Hello world", "no leftover text from the cancelled turn");
    assert!(s.recorded().iter().any(|m| m["method"] == "session/cancel" && m["params"]["sessionId"] == "fake-sid"));

    // Cancelled before it was sent: the prompt never reaches the agent.
    let before = s.prompts().len();
    let token = no_cancel();
    token.cancel();
    let (_, on_delta) = collector();
    let err = session.ask("hello", on_delta, token).await.unwrap_err();
    assert!(matches!(err, AgentError::CancelledBeforeSend), "{err:?}");
    assert_eq!(s.prompts().len(), before);
    session.close().await;
}

#[tokio::test]
async fn a_crash_mid_turn_is_an_error_and_the_session_is_dead() {
    let s = Scratch::new("crash");
    let session = AcpSession::spawn(s.launch(&[])).await.unwrap();
    let err = ask(&session, "crash").await.unwrap_err();
    assert!(matches!(err, AgentError::Crashed(_)), "{err:?}");
    assert_eq!(err.kind(), AgentErrorKind::Crashed);
    assert!(err.to_string().contains("fake_acp"), "{err}");
    assert!(err.to_string().contains("exit code 1"), "{err}");
    assert!(!session.is_alive());
    assert!(ask(&session, "hello").await.is_err());
    session.close().await;
}

#[tokio::test]
async fn a_silent_agent_times_out_and_is_killed() {
    let s = Scratch::new("hang");
    let timeouts = SessionTimeouts { inactivity: Duration::from_millis(400), ..SessionTimeouts::default() };
    let session = AcpSession::spawn_with_timeouts(s.launch(&[]), timeouts).await.unwrap();
    let err = ask(&session, "hang").await.unwrap_err();
    assert!(matches!(err, AgentError::Timeout), "{err:?}");
    assert!(!session.is_alive());
}

#[tokio::test]
async fn quota_and_login_errors_are_classified() {
    let s = Scratch::new("errors");
    let session = AcpSession::spawn(s.launch(&[])).await.unwrap();
    let err = ask(&session, "quota").await.unwrap_err();
    assert_eq!(err.kind(), AgentErrorKind::RateLimited);
    assert!(err.to_string().contains("credits are depleted"));
    assert!(session.is_alive(), "a refused turn does not kill the session");
    session.close().await;

    // session/new fails with ACP's auth_required.
    let err = AcpSession::spawn(s.launch(&["--login-fail"])).await.err().expect("spawn fails");
    assert_eq!(err.kind(), AgentErrorKind::NotLoggedIn, "{err:?}");

    // The agent exits at once saying it is not logged in.
    let err = AcpSession::spawn(s.launch(&["--exit-on-start"])).await.err().expect("spawn fails");
    assert_eq!(err.kind(), AgentErrorKind::NotLoggedIn, "{err:?}");

    // A model the agent rejects fails the start with its name in the message.
    let mut launch = s.launch(&["--bad-model"]);
    launch.model = "nope".into();
    let err = AcpSession::spawn(launch).await.err().expect("spawn fails");
    assert!(err.to_string().contains("model nope not available"), "{err}");

    // A missing binary is NotInstalled.
    let mut launch = s.launch(&[]);
    launch.program = s.root.join("no-such-agent.exe");
    let err = AcpSession::spawn(launch).await.err().expect("spawn fails");
    assert_eq!(err.kind(), AgentErrorKind::NotInstalled, "{err:?}");
}

#[tokio::test]
async fn paid_key_env_vars_never_reach_the_agent() {
    let s = Scratch::new("env");
    // The fake reads these three; the first is only removed through `env_remove`.
    std::env::set_var("NEXQ_TEST_SECRET", "x");
    std::env::set_var("GEMINI_API_KEY", "x");
    std::env::set_var("ANTHROPIC_API_KEY", "x");
    let mut launch = s.launch(&[]);
    launch.env_remove = vec!["NEXQ_TEST_SECRET".into()];
    let session = AcpSession::spawn(launch).await.unwrap();
    let r = ask(&session, "env").await.unwrap();
    assert_eq!(r.text, "env:NEXQ_TEST_SECRET=unset GEMINI_API_KEY=unset ANTHROPIC_API_KEY=unset");
    session.close().await;
}

#[tokio::test]
async fn probe_models_lists_models_without_a_prompt() {
    let s = Scratch::new("probe");
    let models = probe_models(fake_bin(), vec!["--record".into(), s.record().to_string_lossy().into_owned()]).await.unwrap();
    assert_eq!(
        models,
        vec![("fake-fast".to_string(), "Fake Fast".to_string()), ("fake-deep".to_string(), "Fake Deep".to_string())]
    );
    assert!(s.prompts().is_empty());
    let err = probe_models(fake_bin(), vec!["--login-fail".into()]).await.unwrap_err();
    assert_eq!(err.kind(), AgentErrorKind::NotLoggedIn);
}

// ---- live (real agy, logged in): cargo test --test acp_session -- --ignored ----

fn agy() -> Option<PathBuf> {
    let p = Path::new(&std::env::var_os("LOCALAPPDATA")?).join("agy").join("bin").join("agy.exe");
    p.is_file().then_some(p)
}

#[tokio::test]
#[ignore = "needs a logged-in Antigravity CLI; uses a few tokens"]
async fn live_antigravity_reads_a_note_and_refuses_a_command() {
    let Some(agy) = agy() else { return };
    let s = Scratch::new("live");
    std::fs::write(s.notes.join("falcon.md"), "Project Falcon launches on March 3.").unwrap();
    let models = probe_models(agy.clone(), nexq_lib::llm::cli_agent::acp::antigravity_args()).await.unwrap();
    assert!(!models.is_empty());
    let low = models.iter().find(|(id, _)| id.contains("flash") && id.ends_with("low")).unwrap_or(&models[0]).0.clone();

    let mut launch = AcpLaunch::new(agy, nexq_lib::llm::cli_agent::acp::antigravity_args(), s.notes.clone());
    launch.model = low;
    launch.system_prompt = "Answer in one short line.".into();
    launch.additional_dirs = vec![s.notes.clone()];
    launch.policy = PermissionPolicy::new(std::slice::from_ref(&s.notes), vec![], vec![]);
    let session = AcpSession::spawn(launch).await.unwrap();

    let (text, deltas) = {
        let (deltas, on_delta) = collector();
        let r = session.ask("What is the Project Falcon launch date? Read falcon.md in my notes folder.", on_delta, no_cancel()).await.unwrap();
        let got = deltas.lock().unwrap().clone();
        (r.text, got)
    };
    assert!(text.contains("March 3") || text.contains("3 March"), "{text}");
    eprintln!("tools: {:?}", tools_in(&deltas));

    let r = ask(&session, &format!("Run the shell command: echo hi > {}\\out.txt . Then say whether it worked.", s.root.display())).await.unwrap();
    eprintln!("command answer: {}", r.text);
    assert!(!s.root.join("out.txt").exists(), "the command must not have run");
    session.close().await;
}
