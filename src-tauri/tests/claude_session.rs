//! Integration tests for `ClaudeSession` against `examples/fake_claude.rs`.
//!
//! The fake is configured through directives in the system prompt
//! (`fake_mode=...`, `fake_record=...`): the session controls the child's
//! environment and parallel tests cannot share process env vars.

use nexq_lib::llm::cli_agent::command::{SessionConfig, SourcesLaunch};
use nexq_lib::llm::cli_agent::detect::find_claude_binary;
use nexq_lib::llm::cli_agent::models::probe_models;
use nexq_lib::llm::cli_agent::protocol::AgentErrorKind;
use nexq_lib::llm::cli_agent::session::{AgentError, ClaudeSession, SessionTimeouts};
use nexq_lib::llm::provider::CancelToken;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Build `fake_claude` once and return its path (next to this test binary's
/// `deps` dir, so it follows whatever target dir / profile cargo used).
fn fake_bin() -> PathBuf {
    static BIN: OnceLock<PathBuf> = OnceLock::new();
    BIN.get_or_init(|| {
        let mut cmd = std::process::Command::new(env!("CARGO"));
        cmd.args(["build", "--example", "fake_claude"])
            .current_dir(env!("CARGO_MANIFEST_DIR"));
        // Drop the per-crate vars cargo injects into test processes: build scripts
        // (e.g. ring's) watch CARGO_MANIFEST_DIR / OUT_DIR, so inheriting them would force a
        // full rebuild on every run.
        for (key, _) in std::env::vars() {
            let injected = [
                "CARGO_MANIFEST_",
                "CARGO_PKG_",
                "CARGO_CRATE_",
                "CARGO_PRIMARY_PACKAGE",
                "CARGO_BIN_",
                "OUT_DIR",
            ]
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
        assert!(
            out.status.success(),
            "building fake_claude failed:\n{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let profile_dir = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .to_path_buf();
        let bin = profile_dir
            .join("examples")
            .join(format!("fake_claude{}", std::env::consts::EXE_SUFFIX));
        assert!(bin.is_file(), "missing {}", bin.display());
        bin
    })
    .clone()
}

fn cfg(mode: &str, record: Option<&Path>) -> SessionConfig {
    let mut system_prompt = format!("You are a test double.\nfake_mode={mode}\n");
    if let Some(path) = record {
        system_prompt.push_str(&format!("fake_record={}\n", path.display()));
    }
    SessionConfig {
        model: "haiku".into(),
        effort: Some("low".into()),
        system_prompt,
        thinking: false,
        sources: None,
    }
}

/// The private mcp-config file (it holds secrets) is gone as soon as the
/// session's init has arrived (the CLI keeps the config in memory), and still
/// gone after `close` and after a plain drop.
#[tokio::test]
async fn private_mcp_config_file_is_deleted_once_init_arrived() {
    let json = r#"{"mcpServers":{"a":{"command":"x","env":{"API_KEY":"va"}}}}"#;
    let sources = SourcesLaunch { mcp_config_json: Some(json.into()), ..Default::default() };
    let with = |mode| SessionConfig { sources: Some(sources.clone()), ..cfg(mode, None) };

    let closed = ClaudeSession::spawn(fake_bin(), with("normal")).await.unwrap();
    let path = closed.mcp_config_path().expect("mcp config path").to_path_buf();
    assert!(!path.exists(), "secrets file left on disk after init");
    closed.close().await;
    assert!(!path.exists(), "file left after close");

    let dropped = ClaudeSession::spawn(fake_bin(), with("normal")).await.unwrap();
    let path = dropped.mcp_config_path().unwrap().to_path_buf();
    drop(dropped);
    assert!(!path.exists(), "file left after drop");

    // A plain session never writes one.
    let plain = spawn("normal").await;
    assert!(plain.mcp_config_path().is_none());
    plain.close().await;
}

/// A with-sources session with some failed MCP servers still starts while
/// something is usable (a notes folder, or a server that connected); the
/// statuses are in `init_info`. With nothing usable left the start fails and
/// the error carries the statuses.
#[tokio::test]
async fn failed_mcp_servers_fail_the_start_only_when_nothing_is_usable() {
    let sources = |dirs: Vec<PathBuf>| SourcesLaunch {
        add_dirs: dirs,
        mcp_config_json: Some(r#"{"mcpServers":{}}"#.into()),
        server_labels: vec![("mira".to_string(), "Mira".to_string())],
        ..Default::default()
    };
    let with = |mcp: &str, dirs: Vec<PathBuf>| SessionConfig {
        sources: Some(sources(dirs)),
        ..cfg(&format!("normal
fake_mcp={mcp}"), None)
    };

    // One server failed, another connected: starts.
    let s = ClaudeSession::spawn(fake_bin(), with("mira:failed,wiki:connected", vec![])).await.unwrap();
    let states: Vec<_> = s.init_info().mcp_servers.iter().map(|m| (m.name.clone(), m.status.clone())).collect();
    assert_eq!(states, [("mira".into(), "failed".into()), ("wiki".into(), "connected".into())]);
    s.close().await;

    // The only server failed but a notes folder is left: starts.
    let s = ClaudeSession::spawn(fake_bin(), with("mira:failed", vec![std::env::temp_dir()])).await.unwrap();
    s.close().await;

    // Only server, failed, no folder: nothing usable, with the statuses.
    let err = match ClaudeSession::spawn(fake_bin(), with("mira:failed", vec![])).await {
        Err(e) => e,
        Ok(_) => panic!("started with nothing usable"),
    };
    match err {
        AgentError::NoUsableSources { message, info } => {
            assert_eq!(message, "Mira didn't start");
            assert_eq!(info.mcp_servers.len(), 1);
            assert_eq!(info.mcp_servers[0].status, "failed");
        }
        other => panic!("{other:?}"),
    }
}

async fn spawn(mode: &str) -> ClaudeSession {
    ClaudeSession::spawn(fake_bin(), cfg(mode, None))
        .await
        .expect("spawn fake")
}

/// `on_delta` that appends into the returned buffer.
fn collector() -> (Arc<Mutex<String>>, Box<dyn Fn(&str) + Send + Sync>) {
    let buf = Arc::new(Mutex::new(String::new()));
    let sink = buf.clone();
    (
        buf,
        Box::new(move |d: &str| sink.lock().unwrap().push_str(d)),
    )
}

fn token() -> Arc<CancelToken> {
    Arc::new(CancelToken::new())
}

#[tokio::test]
async fn spawn_then_ask_streams_and_completes() {
    let session = spawn("normal").await;
    assert!(session.is_alive());
    assert_eq!(session.model(), "haiku");
    let (buf, on_delta) = collector();
    let result = session.ask("hello", on_delta, token()).await.unwrap();
    assert_eq!(*buf.lock().unwrap(), "Hello world");
    assert_eq!(result.text, "Hello world");
    assert!(!result.is_error);
    session.close().await;
    assert!(!session.is_alive());
}

#[tokio::test]
async fn append_context_returns_without_query() {
    let record =
        std::env::temp_dir().join(format!("nexq-fake-claude-{}.jsonl", uuid::Uuid::new_v4()));
    let session = ClaudeSession::spawn(fake_bin(), cfg("normal", Some(&record)))
        .await
        .unwrap();
    tokio::time::timeout(
        Duration::from_secs(5),
        session.append_context("context doc"),
    )
    .await
    .expect("append_context timed out")
    .unwrap();
    let lines = std::fs::read_to_string(&record).unwrap();
    let last: serde_json::Value = serde_json::from_str(lines.lines().last().unwrap()).unwrap();
    assert_eq!(last["shouldQuery"], false);
    assert_eq!(last["message"]["content"], "context doc");
    // The session is still usable for a real turn afterwards.
    let (_, on_delta) = collector();
    assert_eq!(
        session.ask("q", on_delta, token()).await.unwrap().text,
        "answer:q"
    );
    session.close().await;
    let _ = std::fs::remove_file(&record);
}

#[tokio::test]
async fn concurrent_asks_are_fifo() {
    let session = spawn("normal").await;
    let order = Arc::new(Mutex::new(Vec::<(u8, String)>::new()));
    let tagged = |tag: u8| -> (Arc<Mutex<String>>, Box<dyn Fn(&str) + Send + Sync>) {
        let buf = Arc::new(Mutex::new(String::new()));
        let (sink, order) = (buf.clone(), order.clone());
        let cb = Box::new(move |d: &str| {
            sink.lock().unwrap().push_str(d);
            order.lock().unwrap().push((tag, d.to_string()));
        });
        (buf, cb)
    };
    let (buf1, cb1) = tagged(1);
    let (buf2, cb2) = tagged(2);
    // join! polls the first ask first, so it takes the turn lock first.
    let (r1, r2) = tokio::join!(
        session.ask("1", cb1, token()),
        session.ask("2", cb2, token())
    );
    assert_eq!(
        vec![r1.unwrap().text, r2.unwrap().text],
        vec!["answer:1", "answer:2"]
    );
    assert_eq!(*buf1.lock().unwrap(), "answer:1");
    assert_eq!(*buf2.lock().unwrap(), "answer:2");
    let tags: Vec<u8> = order.lock().unwrap().iter().map(|(t, _)| *t).collect();
    let first_two = tags.iter().position(|t| *t == 2).unwrap();
    assert!(
        tags[first_two..].iter().all(|t| *t == 2),
        "turns interleaved: {tags:?}"
    );
    session.close().await;
}

#[tokio::test]
async fn cancel_then_ask_has_no_bleed() {
    let session = spawn("slow").await;
    let cancel = token();
    let buf1 = Arc::new(Mutex::new(String::new()));
    let (sink, trigger) = (buf1.clone(), cancel.clone());
    let on_delta = Box::new(move |d: &str| {
        sink.lock().unwrap().push_str(d);
        trigger.cancel();
    });
    let started = Instant::now();
    let first = session.ask("first", on_delta, cancel).await;
    assert_eq!(first, Err(AgentError::Cancelled));
    // "answer:first" takes ~1.2 s to stream in slow mode; cancel must not wait for it.
    assert!(
        started.elapsed() < Duration::from_millis(800),
        "cancel took {:?}",
        started.elapsed()
    );
    assert_eq!(*buf1.lock().unwrap(), "a", "deltas forwarded after cancel");

    let (buf2, on_delta) = collector();
    let second = session.ask("second", on_delta, token()).await.unwrap();
    assert_eq!(second.text, "answer:second");
    assert_eq!(*buf2.lock().unwrap(), "answer:second");
    assert_eq!(*buf1.lock().unwrap(), "a");
    session.close().await;
}

/// `on_delta` that records every delta, empty ones included.
fn recorder() -> (Arc<Mutex<Vec<String>>>, Box<dyn Fn(&str) + Send + Sync>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    (seen, Box::new(move |d: &str| sink.lock().unwrap().push(d.to_string())))
}

#[tokio::test]
async fn thinking_off_sets_the_env_var_and_streams_only_text() {
    let session = spawn("normal").await;
    let (seen, on_delta) = recorder();
    let turn = session.ask("hello", on_delta, token()).await.unwrap();
    assert_eq!(*seen.lock().unwrap(), vec!["Hello", " world"]);
    assert_eq!(turn.thinking_tokens, 0, "the fake saw CLAUDE_CODE_DISABLE_THINKING=1");
    session.close().await;
}

#[tokio::test]
async fn thinking_on_is_signalled_once_before_text() {
    let cfg = SessionConfig { thinking: true, ..cfg("normal", None) };
    let session = ClaudeSession::spawn(fake_bin(), cfg).await.expect("spawn fake");
    let (seen, on_delta) = recorder();
    let turn = session.ask("hello", on_delta, token()).await.unwrap();
    assert_eq!(*seen.lock().unwrap(), vec!["", "Hello", " world"]);
    assert_eq!(turn.thinking_tokens, 3);
    assert_eq!(turn.output_tokens, 14);
    session.close().await;
}

#[tokio::test]
async fn usage_is_per_turn_although_the_cli_cost_is_cumulative() {
    let session = spawn("normal").await;
    let mut turns = Vec::new();
    for q in ["a", "b", "c"] {
        let (_, on_delta) = collector();
        turns.push(session.ask(q, on_delta, token()).await.unwrap());
    }
    for (i, t) in turns.iter().enumerate() {
        let expected_total = 0.0001 * (i + 1) as f64;
        assert!((t.total_cost_usd - expected_total).abs() < 1e-12, "total {}", t.total_cost_usd);
    }
    for t in &turns {
        assert!((t.cost_usd - 0.0001).abs() < 1e-12, "per-turn cost {}", t.cost_usd);
    }
    assert_eq!((turns[0].cache_write_tokens, turns[0].cache_read_tokens), (500, 0));
    assert_eq!((turns[1].cache_write_tokens, turns[1].cache_read_tokens), (20, 500));
    assert_eq!(turns[1].prompt_tokens(), 530);
    session.close().await;

    // A new process starts counting from zero again.
    let fresh = spawn("normal").await;
    let (_, on_delta) = collector();
    let t = fresh.ask("d", on_delta, token()).await.unwrap();
    assert!((t.cost_usd - 0.0001).abs() < 1e-12);
    fresh.close().await;
}

#[tokio::test]
async fn crash_mid_turn_returns_crashed() {
    let session = spawn("crash_mid_turn").await;
    let (_, on_delta) = collector();
    let result = tokio::time::timeout(Duration::from_secs(3), session.ask("x", on_delta, token()))
        .await
        .expect("crash not reported within 3 s");
    match &result {
        Err(e @ AgentError::Crashed(reason)) => {
            assert!(reason.contains("exit code 1"), "reason: {reason}");
            assert_eq!(e.kind(), AgentErrorKind::Crashed);
        }
        other => panic!("expected Crashed, got {other:?}"),
    }
    assert!(!session.is_alive());
    // Later turns fail fast instead of hanging.
    let (_, on_delta) = collector();
    let again =
        tokio::time::timeout(Duration::from_secs(1), session.ask("y", on_delta, token())).await;
    assert!(
        matches!(again, Ok(Err(AgentError::Crashed(_)))),
        "got {again:?}"
    );
}

#[tokio::test]
async fn error_result_maps_to_cli_error() {
    let session = spawn("normal").await;
    let (_, on_delta) = collector();
    let result = session
        .ask("fail:Not logged in · Please run /login", on_delta, token())
        .await;
    assert!(
        matches!(&result, Err(AgentError::Cli(AgentErrorKind::NotLoggedIn, msg)) if msg.contains("/login")),
        "got {result:?}"
    );
    assert!(session.is_alive());
    let (_, on_delta) = collector();
    assert_eq!(
        session.ask("ok", on_delta, token()).await.unwrap().text,
        "answer:ok"
    );
    session.close().await;
}

/// `spawn` with short hang guards.
async fn spawn_hanging(inactivity: Duration, drain: Duration) -> ClaudeSession {
    let timeouts = SessionTimeouts {
        inactivity,
        drain,
        ..SessionTimeouts::default()
    };
    ClaudeSession::spawn_with_timeouts(fake_bin(), cfg("hang", None), timeouts)
        .await
        .expect("spawn fake")
}

#[tokio::test]
async fn hung_turn_times_out_and_session_dies() {
    let session = spawn_hanging(Duration::from_secs(1), Duration::from_secs(30)).await;
    let (buf, on_delta) = collector();
    let started = Instant::now();
    let result = tokio::time::timeout(Duration::from_secs(10), session.ask("x", on_delta, token()))
        .await
        .expect("hung turn never returned");
    assert_eq!(result, Err(AgentError::Timeout));
    assert!(
        started.elapsed() >= Duration::from_millis(900),
        "timed out early: {:?}",
        started.elapsed()
    );
    assert_eq!(
        *buf.lock().unwrap(),
        "ans",
        "first delta should have streamed"
    );
    assert!(!session.is_alive(), "hung session must be reported dead");
    // Later turns fail fast instead of queueing behind the hung one.
    let (_, on_delta) = collector();
    let again =
        tokio::time::timeout(Duration::from_secs(2), session.ask("y", on_delta, token())).await;
    assert!(
        matches!(again, Ok(Err(AgentError::Crashed(_)))),
        "got {again:?}"
    );
    session.close().await;
}

#[tokio::test]
async fn cancelled_turn_that_never_finishes_is_killed_after_drain_limit() {
    let session = spawn_hanging(Duration::from_secs(30), Duration::from_secs(1)).await;
    let cancel = token();
    let trigger = cancel.clone();
    let on_delta = Box::new(move |_: &str| trigger.cancel());
    let first = tokio::time::timeout(Duration::from_secs(5), session.ask("x", on_delta, cancel))
        .await
        .expect("cancel did not return");
    assert_eq!(first, Err(AgentError::Cancelled));
    assert!(session.is_alive(), "still draining right after cancel");
    let deadline = Instant::now() + Duration::from_secs(5);
    while session.is_alive() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        !session.is_alive(),
        "drain limit did not kill the hung session"
    );
    let (_, on_delta) = collector();
    let again =
        tokio::time::timeout(Duration::from_secs(2), session.ask("y", on_delta, token())).await;
    assert!(
        matches!(again, Ok(Err(AgentError::Crashed(_)))),
        "got {again:?}"
    );
    session.close().await;
}

#[tokio::test]
async fn spawn_missing_binary_is_not_installed() {
    let bin = std::env::temp_dir()
        .join("nexq-no-such-dir")
        .join("claude.exe");
    let err = ClaudeSession::spawn(bin, cfg("normal", None))
        .await
        .err()
        .expect("spawn must fail");
    assert!(matches!(err, AgentError::Spawn(_)), "got {err:?}");
    assert_eq!(err.kind(), AgentErrorKind::NotInstalled);
}

#[tokio::test]
async fn probe_lists_models_from_the_initialize_answer() {
    // Before the answer the fake prints a blank line, a truncated JSON line
    // and a `system/status` line; the probe must skip all three. After it,
    // the fake takes 3 s to exit once stdin closes: the catalog must not
    // wait for that (the process is cleaned up in the background).
    let started = Instant::now();
    let models = probe_models(&fake_bin()).await.expect("probe");
    assert!(
        started.elapsed() < Duration::from_millis(1500),
        "probe waited for the process to exit: {:?}",
        started.elapsed()
    );
    let values: Vec<&str> = models.iter().map(|m| m.value.as_str()).collect();
    assert_eq!(values, ["opus", "sonnet", "haiku", "claude-opus-4-6"]);
    let haiku = &models[2];
    assert!(!haiku.supports_effort && haiku.effort_levels.is_empty());
    assert_eq!(models[1].display_name, "Sonnet 5.5");
    assert_eq!(models[3].effort_levels, ["low", "medium", "high", "max"]);
}

#[tokio::test]
async fn probe_missing_binary_fails() {
    let bin = std::env::temp_dir()
        .join("nexq-no-such-dir")
        .join("claude.exe");
    assert!(probe_models(&bin).await.is_err());
}

/// Manual check against the real `claude` (no model call, costs nothing):
/// `cargo test --test claude_session real_claude_models -- --ignored --nocapture`
#[tokio::test]
#[ignore]
async fn real_claude_models() {
    let bin = find_claude_binary().expect("claude.exe not found");
    let models = probe_models(&bin).await.expect("probe");
    for m in &models {
        println!(
            "{:<28} -> {:<28} {:<22} effort {:?}",
            m.value, m.resolved_model, m.display_name, m.effort_levels
        );
    }
    assert!(models.iter().any(|m| m.value == "sonnet"));
}

/// A solid-colour PNG, base64 encoded (no `data:` prefix).
fn solid_png_base64(width: u32, height: u32, rgba: [u8; 4]) -> String {
    let img = image::RgbaImage::from_pixel(width, height, image::Rgba(rgba));
    let mut png = std::io::Cursor::new(Vec::new());
    img.write_to(&mut png, image::ImageFormat::Png).expect("encode png");
    let bytes = png.into_inner();
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16
            | (*chunk.get(1).unwrap_or(&0) as u32) << 8
            | *chunk.get(2).unwrap_or(&0) as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Manual smoke test of Ask images against the real, logged-in `claude`, with
/// the app's own launch args and stream-json (two Haiku requests):
/// `cargo test --test claude_session real_claude_image -- --ignored --nocapture`
#[tokio::test]
#[ignore]
async fn real_claude_image() {
    use nexq_lib::llm::cli_agent::protocol::ImageAttachment;
    let bin = find_claude_binary().expect("claude.exe not found");
    let cfg = SessionConfig {
        model: "haiku".into(),
        effort: Some("low".into()),
        system_prompt: "You are a terse assistant. Answer in as few words as possible.".into(),
        thinking: false,
        sources: None,
    };
    let session = ClaudeSession::spawn(bin, cfg).await.expect("spawn real claude");

    // A small red square: answered from the picture.
    let red = ImageAttachment { media_type: "image/png".into(), data: solid_png_base64(64, 64, [255, 0, 0, 255]) };
    let (_, on_delta) = collector();
    let turn = session
        .ask_with_images("What color is this square? Answer with one word.", &[red], on_delta, token())
        .await
        .expect("image turn");
    println!("red square -> {:?}", turn.text);
    assert!(turn.text.to_lowercase().contains("red"), "not read from the image: {}", turn.text);

    // 1000x9000: over the API's 8000 px limit. What does the CLI report?
    let tall = ImageAttachment { media_type: "image/png".into(), data: solid_png_base64(1000, 9000, [0, 0, 255, 255]) };
    let (_, on_delta) = collector();
    let result = session
        .ask_with_images("What color is this? One word.", &[tall], on_delta, token())
        .await;
    println!("1000x9000 -> {result:?}");

    // Bytes that are not an image (a base64 body Claude can't decode): the
    // error path `ask_meeting_session` turns into "Claude couldn't use the attached image".
    let broken = ImageAttachment { media_type: "image/png".into(), data: "bm90IGEgcG5n".into() };
    let (_, on_delta) = collector();
    let result = session
        .ask_with_images("What color is this? One word.", &[broken], on_delta, token())
        .await;
    println!("not an image -> {result:?}");
    session.close().await;
}

/// Manual smoke test against the real, logged-in `claude` (costs a few tokens):
/// `cargo test --test claude_session real_claude -- --ignored`
#[tokio::test]
#[ignore]
async fn real_claude_two_turns() {
    let bin = find_claude_binary().expect("claude.exe not found");
    let cfg = SessionConfig {
        model: "haiku".into(),
        effort: Some("low".into()),
        system_prompt: "You are a terse assistant. Answer in as few words as possible.".into(),
        thinking: false,
        sources: None,
    };
    let session = ClaudeSession::spawn(bin, cfg)
        .await
        .expect("spawn real claude");
    session
        .append_context("Background note: the project codename is PINEAPPLE.")
        .await
        .unwrap();
    let (buf1, on_delta) = collector();
    let t1 = session
        .ask(
            "Remember the number 7341. Reply only with OK.",
            on_delta,
            token(),
        )
        .await
        .unwrap();
    println!(
        "turn 1: {:?} (streamed {:?})",
        t1.text,
        buf1.lock().unwrap()
    );
    let (buf2, on_delta) = collector();
    let t2 = session
        .ask(
            "What number did I ask you to remember, and what is the project codename?",
            on_delta,
            token(),
        )
        .await
        .unwrap();
    println!(
        "turn 2: {:?} tokens in/out {}/{} cost ${}",
        t2.text, t2.input_tokens, t2.output_tokens, t2.cost_usd
    );
    assert_eq!(*buf2.lock().unwrap(), t2.text);
    assert!(
        t2.text.contains("7341"),
        "turn 2 forgot turn 1: {}",
        t2.text
    );
    assert!(
        t2.text.to_uppercase().contains("PINEAPPLE"),
        "context not applied: {}",
        t2.text
    );
    session.close().await;
    assert!(!session.is_alive());
}
