//! Integration tests for `CodexSession` against `examples/fake_codex.rs`.
//!
//! The fake is configured through `-c fake_*=value` pairs that the tests put in
//! `CodexLaunch::mcp_overrides` (see the fake's header): the session controls
//! the child's environment and parallel tests cannot share process env vars.
//!
//! `live_*` tests talk to the real `codex` on this machine and are `#[ignore]`d:
//! `cargo test --test codex_session -- --ignored --nocapture`.

use nexq_lib::llm::cli_agent::codex::launch::{discover_user_mcp_servers, find_codex};
use nexq_lib::llm::cli_agent::codex::models::probe_models;
use nexq_lib::llm::cli_agent::codex::{CodexLaunch, CodexPolicy, CodexSession};
use nexq_lib::llm::cli_agent::protocol::AgentErrorKind;
use nexq_lib::llm::cli_agent::session::{
    decode_activity, decode_tool_result, is_activity, AgentError, SessionTimeouts, THINKING_SIGNAL,
};
use nexq_lib::llm::provider::CancelToken;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Build `fake_codex` once and return its path (next to this test binary's
/// `deps` dir, so it follows whatever target dir / profile cargo used).
fn fake_bin() -> PathBuf {
    static BIN: OnceLock<PathBuf> = OnceLock::new();
    BIN.get_or_init(|| {
        let mut cmd = std::process::Command::new(env!("CARGO"));
        cmd.args(["build", "--example", "fake_codex"]).current_dir(env!("CARGO_MANIFEST_DIR"));
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
        let out = cmd.output().expect("run cargo build --example fake_codex");
        assert!(out.status.success(), "building fake_codex failed:\n{}", String::from_utf8_lossy(&out.stderr));
        let profile_dir = std::env::current_exe().unwrap().parent().unwrap().parent().unwrap().to_path_buf();
        let bin = profile_dir.join("examples").join(format!("fake_codex{}", std::env::consts::EXE_SUFFIX));
        assert!(bin.is_file(), "missing {}", bin.display());
        bin
    })
    .clone()
}

fn scratch(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nexq-codex-test-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A launch of the fake. `fake` are `key=value` directives for it.
fn launch(fake: &[&str]) -> CodexLaunch {
    let mut l = CodexLaunch::new(fake_bin(), vec![], scratch("cwd"), "fake-model".into());
    l.system_prompt = "You are a test double.".into();
    // The fake has no config of the user's to switch off.
    l.user_mcp_servers = Some(vec![]);
    // Directives travel as `-c key=value` like any override.
    l.mcp_overrides = fake.iter().map(|d| d.to_string()).collect();
    l
}

fn record_path(tag: &str) -> PathBuf {
    scratch(tag).join("record.txt")
}

fn recorded(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

async fn spawn(fake: &[&str]) -> CodexSession {
    CodexSession::spawn(launch(fake)).await.expect("spawn fake codex")
}

type Deltas = Arc<Mutex<Vec<String>>>;

/// `on_delta` that appends every token into the returned list.
type OnDelta = Box<dyn Fn(&str) + Send + Sync>;

fn collector() -> (Deltas, OnDelta) {
    let buf: Deltas = Arc::new(Mutex::new(Vec::new()));
    let sink = buf.clone();
    (buf, Box::new(move |d: &str| sink.lock().unwrap().push(d.to_string())))
}

fn token() -> Arc<CancelToken> {
    Arc::new(CancelToken::new())
}

fn text_of(deltas: &Deltas) -> String {
    deltas.lock().unwrap().iter().filter(|d| !is_activity(d)).cloned().collect()
}

#[tokio::test]
async fn streams_an_answer_and_reports_per_turn_usage() {
    let record = record_path("stream");
    let rec = format!("fake_record={}", record.display());
    let mut l = launch(&[&rec]);
    l.effort = Some("high".into());
    l.user_mcp_servers = Some(vec!["mira".into()]);
    let s = CodexSession::spawn(l).await.unwrap();
    assert!(s.is_alive());
    assert_eq!(s.model(), "fake-model");

    let (deltas, on_delta) = collector();
    let r = s.ask("hello", on_delta, token()).await.unwrap();
    assert_eq!(r.text, "Hello world");
    // The thinking signal first, then the answer's own deltas; the model's
    // narration ("Let me look.") is not streamed.
    assert_eq!(*deltas.lock().unwrap(), [THINKING_SIGNAL, "Hello", " world"]);
    // Codex counts the cached part inside `input`; NexQ's input is uncached only.
    assert_eq!(r.input_tokens, 200);
    assert_eq!(r.cache_read_tokens, 1000);
    assert_eq!(r.output_tokens, 80);
    assert_eq!(r.thinking_tokens, 30);
    assert_eq!(r.duration_ms, 1500);
    assert_eq!(r.cost_usd, 0.0);

    // The second turn's usage is its own share of the thread's running total.
    let (_, on_delta) = collector();
    let r2 = s.ask("again", on_delta, token()).await.unwrap();
    assert_eq!(r2.text, "answer:again");
    assert_eq!((r2.input_tokens, r2.cache_read_tokens, r2.output_tokens), (200, 1000, 80));

    s.close().await;
    assert!(!s.is_alive());

    // What the session asked of Codex.
    let rec = recorded(&record);
    assert!(rec.contains("ARGV app-server"), "{rec}");
    assert!(rec.contains("mcp_servers.mira.enabled=false"), "{rec}");
    assert!(rec.contains("--disable plugins"), "{rec}");
    let thread_start = rec.lines().find(|l| l.contains("\"thread/start\"")).expect("thread/start");
    for needle in [
        "\"sandbox\":\"read-only\"",
        "\"approvalPolicy\":\"untrusted\"",
        "\"ephemeral\":true",
        "\"baseInstructions\":\"You are a test double.\"",
        "\"model\":\"fake-model\"",
    ] {
        assert!(thread_start.contains(needle), "{needle} in {thread_start}");
    }
    let turn_start = rec.lines().find(|l| l.contains("\"turn/start\"")).expect("turn/start");
    assert!(turn_start.contains("\"effort\":\"high\""), "{turn_start}");
}

/// The shell tool exists only with a notes folder; MCP servers and their
/// secrets travel in `thread/start`'s config, never on the command line.
#[tokio::test]
async fn the_shell_tool_needs_a_notes_folder_and_secrets_stay_off_the_command_line() {
    // No notes folder: the shell tool is switched off, and so is the image viewer.
    let record = record_path("shell-off");
    let rec = format!("fake_record={}", record.display());
    let s = CodexSession::spawn(launch(&[&rec])).await.unwrap();
    s.close().await;
    let text = recorded(&record);
    assert!(text.contains("--disable shell_tool"), "{text}");
    assert!(text.contains("--disable view_image"), "{text}");

    // A notes folder and an MCP server with a secret.
    let record = record_path("shell-on");
    let rec = format!("fake_record={}", record.display());
    let notes = scratch("shell-notes");
    let mut l = launch(&[&rec]);
    l.readable_dirs = vec![notes];
    l.mcp_servers.insert(
        "mira".into(),
        serde_json::json!({ "command": "node", "args": ["s.js"], "env": { "TOKEN": "s3cret-token" }, "enabled_tools": ["kb_search"] }),
    );
    let s = CodexSession::spawn(l).await.unwrap();
    s.close().await;
    let text = recorded(&record);
    let argv = text.lines().find(|l| l.starts_with("ARGV")).expect("argv");
    assert!(!argv.contains("--disable shell_tool"), "{argv}");
    assert!(argv.contains("--disable view_image"), "{argv}");
    assert!(!argv.contains("s3cret-token"), "a secret reached the command line: {argv}");
    let thread_start = text.lines().find(|l| l.contains("\"thread/start\"")).expect("thread/start");
    let v: serde_json::Value = serde_json::from_str(thread_start).unwrap();
    let server = &v["params"]["config"]["mcp_servers"]["mira"];
    assert_eq!(server["env"]["TOKEN"], "s3cret-token");
    assert_eq!(server["enabled_tools"], serde_json::json!(["kb_search"]));
}

#[tokio::test]
async fn context_is_queued_and_sent_with_the_next_question_only() {
    let record = record_path("context");
    let rec = format!("fake_record={}", record.display());
    let s = spawn(&[&rec]).await;
    s.append_context("Them: what is the budget?").await.unwrap();
    s.append_context("You: about two million").await.unwrap();
    // No model call yet.
    assert!(!recorded(&record).contains("\"turn/start\""));

    let (_, on_delta) = collector();
    let r = s.ask("Summarise", on_delta, token()).await.unwrap();
    // The fake answers the question that follows "Now answer this:".
    assert_eq!(r.text, "answer:Summarise");
    let rec_text = recorded(&record);
    let turn_start = rec_text.lines().find(|l| l.contains("\"turn/start\"")).unwrap();
    assert!(turn_start.contains("Them: what is the budget?"), "{turn_start}");
    assert!(turn_start.contains("You: about two million"), "{turn_start}");

    // It is not sent twice.
    let (_, on_delta) = collector();
    s.ask("Next", on_delta, token()).await.unwrap();
    let rec_text = recorded(&record);
    let last_turn = rec_text.lines().rfind(|l| l.contains("\"turn/start\"")).unwrap();
    assert!(!last_turn.contains("Them: what is the budget?"), "{last_turn}");
    s.close().await;
}

#[tokio::test]
async fn tool_activity_is_reported_like_a_claude_session_does() {
    let s = spawn(&[]).await;
    let (deltas, on_delta) = collector();
    s.ask("mcp", on_delta, token()).await.unwrap();
    {
        let all = deltas.lock().unwrap();
        let tool = all.iter().find_map(|d| decode_activity(d)).expect("a tool activity");
        assert_eq!(tool.name, "mcp__mira__kb_search");
        assert_eq!(tool.input["query"], "budget");
        let done = all.iter().find_map(|d| decode_tool_result(d)).expect("a tool result");
        assert_eq!(done.tool_use_id, tool.id);
        assert!(!done.is_error);
        // The chip comes before the answer text.
        let at = |pred: &dyn Fn(&String) -> bool| all.iter().position(pred).unwrap();
        assert!(at(&|d| decode_activity(d).is_some()) < at(&|d| d.starts_with("ans")));
    }

    let (deltas, on_delta) = collector();
    s.ask("read", on_delta, token()).await.unwrap();
    {
        let all = deltas.lock().unwrap();
        let read = all.iter().find_map(|d| decode_activity(d)).expect("a read activity");
        assert_eq!((read.name.as_str(), read.input["file_path"].as_str()), ("Read", Some("a.md")));
    }
    s.close().await;
}

async fn decision(fake: &[&str], configure: impl FnOnce(&mut CodexLaunch), query: &str) -> String {
    let mut l = launch(fake);
    configure(&mut l);
    let s = CodexSession::spawn(l).await.unwrap();
    let (_, on_delta) = collector();
    let r = s.ask(query, on_delta, token()).await.unwrap();
    s.close().await;
    r.text
}

#[tokio::test]
async fn commands_and_file_changes_are_declined() {
    assert_eq!(decision(&[], |_| {}, "approve:cmd").await, "decision:decline");
    assert_eq!(decision(&[], |_| {}, "approve:file").await, "decision:decline");
    // Even with notes folders enabled, a destructive command stays refused.
    let notes = scratch("notes");
    let dir = notes.clone();
    assert_eq!(decision(&[], move |l| l.readable_dirs = vec![dir], "approve:cmd").await, "decision:decline");
}

#[tokio::test]
async fn a_plain_read_runs_only_inside_an_enabled_notes_folder() {
    let notes = scratch("notes");
    let directive = format!("fake_notes={}", notes.display());
    // Enabled folder: allowed.
    let dir = notes.clone();
    assert_eq!(decision(&[&directive], move |l| l.readable_dirs = vec![dir], "approve:read").await, "decision:accept");
    // No folder, or another one: declined.
    assert_eq!(decision(&[&directive], |_| {}, "approve:read").await, "decision:decline");
    let other = scratch("other");
    assert_eq!(decision(&[&directive], move |l| l.readable_dirs = vec![other], "approve:read").await, "decision:decline");
}

#[tokio::test]
async fn an_mcp_tool_is_approved_only_when_it_is_in_the_allowed_set() {
    let allow = |l: &mut CodexLaunch| {
        l.policy = CodexPolicy { allowed_tools: ["mcp__mira__kb_search".to_string()].into_iter().collect() };
    };
    assert_eq!(decision(&[], allow, "approve:mcp-ok").await, "decision:accept");
    assert_eq!(decision(&[], allow, "approve:mcp-no").await, "decision:decline");
    // Nothing allowed: nothing approved.
    assert_eq!(decision(&[], |_| {}, "approve:mcp-ok").await, "decision:decline");
}

#[tokio::test]
async fn cancel_interrupts_the_turn_and_the_next_one_still_runs() {
    let record = record_path("cancel");
    let rec = format!("fake_record={}", record.display());
    let s = spawn(&["fake_mode=slow", &rec]).await;
    let cancel = token();
    let seen_first = Arc::new(Mutex::new(false));
    let (flag, cancel2) = (seen_first.clone(), cancel.clone());
    let on_delta: Box<dyn Fn(&str) + Send + Sync> = Box::new(move |d: &str| {
        if !d.is_empty() && !is_activity(d) {
            *flag.lock().unwrap() = true;
            cancel2.cancel();
        }
    });
    let started = Instant::now();
    let err = s.ask("a long question", on_delta, cancel).await.unwrap_err();
    assert!(err.is_cancel(), "{err:?}");
    assert!(*seen_first.lock().unwrap());
    // Cancelled right after the first character, not after the whole answer.
    assert!(started.elapsed() < Duration::from_millis(1500), "{:?}", started.elapsed());

    // The next question waits for the interrupted turn to end, then runs.
    let (_, on_delta) = collector();
    let r = s.ask("hello", on_delta, token()).await.unwrap();
    assert_eq!(r.text, "Hello world");
    assert!(recorded(&record).contains("\"turn/interrupt\""));
    s.close().await;
}

#[tokio::test]
async fn a_cancel_before_the_question_is_sent_leaves_context_queued() {
    let s = spawn(&[]).await;
    s.append_context("Them: important").await.unwrap();
    let cancel = token();
    cancel.cancel();
    let (_, on_delta) = collector();
    let err = s.ask("q", on_delta, cancel).await.unwrap_err();
    assert!(matches!(err, AgentError::CancelledBeforeSend), "{err:?}");
    s.close().await;
}

#[tokio::test]
async fn a_crash_mid_turn_is_reported_as_a_crash() {
    let s = spawn(&["fake_mode=crash"]).await;
    let (_, on_delta) = collector();
    let err = s.ask("hello", on_delta, token()).await.unwrap_err();
    assert!(matches!(err, AgentError::Crashed(_)), "{err:?}");
    assert_eq!(err.kind(), AgentErrorKind::Crashed);
    assert!(!s.is_alive());
    // A dead session says so instead of hanging.
    let (_, on_delta) = collector();
    assert!(matches!(s.ask("again", on_delta, token()).await, Err(AgentError::Crashed(_))));
    assert!(s.append_context("x").await.is_err());
}

#[tokio::test]
async fn the_usage_limit_is_a_rate_limit_with_the_reset_time() {
    let s = spawn(&[]).await;
    let (_, on_delta) = collector();
    let err = s.ask("usage", on_delta, token()).await.unwrap_err();
    match &err {
        AgentError::Cli(AgentErrorKind::RateLimited, message) => {
            assert!(message.contains("Nov 26th, 2026 9:15 AM"), "{message}");
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(err.kind(), AgentErrorKind::RateLimited);
    // The session survives: the next question works.
    assert!(s.is_alive());
    let (_, on_delta) = collector();
    assert_eq!(s.ask("hello", on_delta, token()).await.unwrap().text, "Hello world");
    s.close().await;
}

#[tokio::test]
async fn a_failed_turn_without_a_cause_is_classified_from_its_text() {
    let s = spawn(&[]).await;
    let (_, on_delta) = collector();
    let err = s.ask("fail:Not logged in. Run codex login", on_delta, token()).await.unwrap_err();
    assert_eq!(err.kind(), AgentErrorKind::NotLoggedIn);
    let (_, on_delta) = collector();
    let err = s.ask("fail:something odd", on_delta, token()).await.unwrap_err();
    assert_eq!(err.kind(), AgentErrorKind::Other);
    s.close().await;
}

#[tokio::test]
async fn only_a_chatgpt_subscription_login_starts_a_session() {
    for (account, needle) in [("none", "not signed in"), ("apikey", "API key")] {
        let err = match CodexSession::spawn(launch(&[&format!("fake_account={account}")])).await {
            Err(e) => e,
            Ok(_) => panic!("started with account {account}"),
        };
        match &err {
            AgentError::Cli(AgentErrorKind::NotLoggedIn, message) => {
                assert!(message.contains(needle), "{message}");
            }
            other => panic!("{other:?}"),
        }
    }
}

#[tokio::test]
async fn a_missing_binary_is_not_installed() {
    let mut l = launch(&[]);
    l.program = PathBuf::from("C:\\definitely\\not\\here\\codex.exe");
    let err = match CodexSession::spawn(l).await {
        Err(e) => e,
        Ok(_) => panic!("started a missing binary"),
    };
    assert!(matches!(err, AgentError::Spawn(_)), "{err:?}");
    assert_eq!(err.kind(), AgentErrorKind::NotInstalled);
}

#[tokio::test]
async fn a_hung_codex_is_killed_by_the_inactivity_guard() {
    let timeouts = SessionTimeouts {
        init: Duration::from_secs(10),
        append: Duration::from_secs(10),
        inactivity: Duration::from_millis(800),
        drain: Duration::from_secs(5),
    };
    let s = CodexSession::spawn_with_timeouts(launch(&["fake_mode=hang"]), timeouts).await.unwrap();
    let (_, on_delta) = collector();
    let err = s.ask("hello", on_delta, token()).await.unwrap_err();
    assert!(matches!(err, AgentError::Timeout), "{err:?}");
    assert!(!s.is_alive());
}

#[tokio::test]
async fn nexqs_own_mcp_servers_are_waited_for_and_their_failure_reported() {
    let own = "mcp_servers.notes.command=\"x\"";
    // Ready: starts, and the state is in init_info.
    let s = spawn(&[own, "fake_mcp=notes:ready"]).await;
    let states: Vec<_> = s.init_info().mcp_servers.iter().map(|m| (m.name.clone(), m.status.clone())).collect();
    assert_eq!(states, [("notes".to_string(), "connected".to_string())]);
    s.close().await;

    // Failed, but a notes folder is left: starts, with the failure listed.
    let mut l = launch(&[own, "fake_mcp=notes:failed"]);
    l.readable_dirs = vec![scratch("notes")];
    let s = CodexSession::spawn(l).await.unwrap();
    assert_eq!(s.init_info().mcp_servers[0].status, "failed");
    s.close().await;

    // Failed with nothing else to offer: the start fails, with the statuses.
    let err = match CodexSession::spawn(launch(&[own, "fake_mcp=notes:failed"])).await {
        Err(e) => e,
        Ok(_) => panic!("started with nothing usable"),
    };
    match err {
        AgentError::NoUsableSources { message, info } => {
            assert_eq!(message, "notes didn't start");
            assert_eq!(info.mcp_servers[0].status, "failed");
        }
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn the_users_mcp_servers_are_found_and_switched_off() {
    let fake = fake_bin();
    let names = discover_user_mcp_servers(&fake, &[]).await.expect("mcp list");
    assert_eq!(names, ["mira", "web search"]);

    // A launch that does not know the names asks Codex, and switches them off.
    let record = record_path("users");
    let rec = format!("fake_record={}", record.display());
    let mut l = launch(&[&rec]);
    l.user_mcp_servers = None;
    let s = CodexSession::spawn(l).await.unwrap();
    s.close().await;
    let rec = recorded(&record);
    assert!(rec.contains("mcp_servers.mira.enabled=false"), "{rec}");
    assert!(rec.contains("mcp_servers.\"web search\".enabled=false"), "{rec}");
}

#[tokio::test]
async fn the_model_list_comes_from_the_app_server() {
    let models = probe_models(&fake_bin(), &[]).await.expect("models");
    // The hidden one is left out.
    assert_eq!(models.len(), 1);
    assert_eq!(models[0].slug, "fake-big");
    assert_eq!(models[0].efforts, ["low", "high"]);
    assert_eq!(models[0].default_effort, "low");
}

#[tokio::test]
async fn closing_is_idempotent_and_ends_the_session() {
    let s = spawn(&[]).await;
    s.close().await;
    s.close().await;
    assert!(!s.is_alive());
    let (_, on_delta) = collector();
    assert!(s.ask("hello", on_delta, token()).await.is_err());
}

// ---------------------------------------------------------------------------
// Live: the real Codex CLI on this machine (ignored by default)
// ---------------------------------------------------------------------------

/// Spawn a real session the way NexQ will, time it, and ask one question. When
/// the account's usage is used up (the case when this was written) the answer
/// is a rate-limit error that carries the reset time.
#[tokio::test]
#[ignore = "talks to the real Codex CLI and the user's account"]
async fn live_real_codex_starts_fast_and_answers_or_reports_the_limit() {
    let Some((program, prefix)) = find_codex() else {
        eprintln!("codex not installed; skipping");
        return;
    };
    let cwd = nexq_lib::llm::cli_agent::command::sandbox_dir();
    let mut l = CodexLaunch::new(program, prefix, cwd, String::new());
    l.effort = Some("low".into());
    l.system_prompt = "You are a terse assistant. Answer in one short sentence.".into();

    let t0 = Instant::now();
    let s = CodexSession::spawn(l).await.expect("spawn real codex");
    eprintln!("LIVE: session ready in {:?} (includes `codex mcp list`), model {}", t0.elapsed(), s.model());
    assert!(s.init_info().mcp_servers.is_empty(), "the user's MCP servers must not start");

    let (deltas, on_delta) = collector();
    let t1 = Instant::now();
    match s.ask("Say hi.", on_delta, token()).await {
        Ok(r) => eprintln!("LIVE: answered in {:?}: {:?} ({r:?})", t1.elapsed(), r.text),
        Err(e) => {
            eprintln!("LIVE: turn failed after {:?}: {e} (kind {:?})", t1.elapsed(), e.kind());
            assert_eq!(e.kind(), AgentErrorKind::RateLimited, "{e:?}");
        }
    }
    eprintln!("LIVE: text so far: {:?}", text_of(&deltas));
    s.close().await;
}

#[tokio::test]
#[ignore = "talks to the real Codex CLI"]
async fn live_real_codex_lists_models() {
    let Some((program, prefix)) = find_codex() else { return };
    let t0 = Instant::now();
    let models = probe_models(&program, &prefix).await.expect("models");
    eprintln!("LIVE: {} models in {:?}", models.len(), t0.elapsed());
    for m in &models {
        eprintln!("LIVE:   {} ({}) default {} efforts {:?}", m.slug, m.display_name, m.default_effort, m.efforts);
    }
    assert!(!models.is_empty());
}
