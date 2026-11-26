//! LIVE check of per-call tool approval in workspace chat, against the real
//! `claude` on this machine (the user's own subscription, the
//! cheapest model, effort low, a handful of short turns). Antigravity is NOT
//! driven here: its terms do not allow third-party use, so its approval path is
//! covered by unit tests only.
//!
//! Everything is local and temporary: a throwaway stdio MCP server (Python
//! stdlib) with `read_note` (readOnlyHint), `set_flag` (no hint; writes a
//! file) and `delete_flag` (destructive); a temp working folder; no network of
//! its own. A tee wrapper logs the raw protocol lines to a temp file.
//!
//! `cargo test --test approval_live live_claude -- --ignored --nocapture --test-threads=1`

use nexq_lib::llm::cli_agent::approval::{
    ApprovalEvent, ApprovalNotice, ApprovalPolicy, ChatApprovals, WorkspaceApprovals,
};
use nexq_lib::llm::cli_agent::command::{SessionConfig, SourcesLaunch};
use nexq_lib::llm::cli_agent::detect::find_claude_binary;
use nexq_lib::llm::cli_agent::session::{ClaudeSession, SessionTimeouts};
use nexq_lib::llm::cli_agent::CliAgentKind;
use nexq_lib::llm::provider::CancelToken;
use nexq_lib::sources::config::{McpServer, McpTool};
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

const SERVER_PY: &str = r#"
import sys, os, json
D = os.environ["PROBE_DIR"]
def log(s):
    with open(os.path.join(D, "calls.log"), "a", encoding="utf-8") as f:
        f.write(s + "\n")
TOOLS = [
    {"name": "read_note", "description": "Read a note by name.", "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}, "annotations": {"readOnlyHint": True}},
    {"name": "set_flag", "description": "Write the flag file with a value.", "inputSchema": {"type": "object", "properties": {"value": {"type": "string"}}, "required": ["value"]}},
    {"name": "delete_flag", "description": "Delete the flag file.", "inputSchema": {"type": "object", "properties": {}}, "annotations": {"readOnlyHint": False, "destructiveHint": True}},
]
def send(o):
    sys.stdout.write(json.dumps(o) + "\n"); sys.stdout.flush()
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    m = json.loads(line)
    i = m.get("id"); method = m.get("method")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": i, "result": {"protocolVersion": m["params"].get("protocolVersion", "2025-06-18"), "capabilities": {"tools": {}}, "serverInfo": {"name": "probe", "version": "1"}}})
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": i, "result": {"tools": TOOLS}})
    elif method == "tools/call":
        name = m["params"]["name"]; args = m["params"].get("arguments") or {}
        log("%s %s" % (name, json.dumps(args, sort_keys=True)))
        if name == "read_note":
            text = "note %s: the sky is teal" % args.get("name")
        elif name == "set_flag":
            open(os.path.join(D, "flag.txt"), "w", encoding="utf-8").write(str(args.get("value")))
            text = "flag set"
        elif name == "delete_flag":
            try: os.remove(os.path.join(D, "flag.txt"))
            except FileNotFoundError: pass
            text = "flag deleted"
        else:
            send({"jsonrpc": "2.0", "id": i, "error": {"code": -32601, "message": "unknown tool"}}); continue
        send({"jsonrpc": "2.0", "id": i, "result": {"content": [{"type": "text", "text": text}]}})
    elif i is not None:
        send({"jsonrpc": "2.0", "id": i, "error": {"code": -32601, "message": "no such method"}})
"#;

const TEE_PY: &str = r#"
import sys, os, subprocess, threading
log = open(os.environ["TEE_LOG"], "a", buffering=1, encoding="utf-8", errors="replace")
real, args = sys.argv[1], sys.argv[2:]
p = subprocess.Popen([real] + args, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
def pump_in():
    for line in sys.stdin.buffer:
        log.write(">> " + line.decode("utf-8", "replace").rstrip("\n") + "\n")
        try:
            p.stdin.write(line); p.stdin.flush()
        except Exception:
            break
    try: p.stdin.close()
    except Exception: pass
threading.Thread(target=pump_in, daemon=True).start()
for line in p.stdout:
    log.write("<< " + line.decode("utf-8", "replace").rstrip("\n") + "\n")
    sys.stdout.buffer.write(line); sys.stdout.buffer.flush()
p.wait()
sys.exit(p.returncode)
"#;

struct Rig {
    dir: PathBuf,
    probe: PathBuf,
    tee_log: PathBuf,
    tee_py: PathBuf,
    mcp_config: String,
}

impl Rig {
    fn new(name: &str) -> Rig {
        let dir = std::env::temp_dir().join(format!("nexq-approval-live-{name}-{}", std::process::id()));
        let probe = dir.join("probe");
        std::fs::create_dir_all(&probe).unwrap();
        let server = dir.join("server.py");
        std::fs::write(&server, SERVER_PY).unwrap();
        let tee_py = dir.join("tee.py");
        std::fs::write(&tee_py, TEE_PY).unwrap();
        let tee_log = dir.join("wire.log");
        std::env::set_var("TEE_LOG", &tee_log);
        let mcp_config = serde_json::json!({"mcpServers": {"probe": {
            "command": "python",
            "args": [server.to_string_lossy()],
            "env": {"PROBE_DIR": probe.to_string_lossy()},
        }}})
        .to_string();
        Rig { dir, probe, tee_log, tee_py, mcp_config }
    }

    fn flag(&self) -> Option<String> {
        std::fs::read_to_string(self.probe.join("flag.txt")).ok()
    }

    fn calls(&self) -> Vec<String> {
        std::fs::read_to_string(self.probe.join("calls.log")).unwrap_or_default().lines().map(str::to_string).collect()
    }

    fn reset(&self) {
        let _ = std::fs::remove_file(self.probe.join("flag.txt"));
        let _ = std::fs::remove_file(self.probe.join("calls.log"));
    }

    fn wire(&self) -> String {
        std::fs::read_to_string(&self.tee_log).unwrap_or_default()
    }

    /// The wire lines that matter, one per line, from `from` on.
    fn show_wire(&self, label: &str, from: usize, needles: &[&str]) -> usize {
        let wire = self.wire();
        let lines: Vec<&str> = wire.lines().collect();
        for l in lines.iter().skip(from) {
            if needles.iter().any(|n| l.contains(n)) {
                let short: String = l.chars().take(900).collect();
                eprintln!("WIRE[{label}] {short}");
            }
        }
        lines.len()
    }
}

fn policy() -> ApprovalPolicy {
    let tool = |n: &str, ro: Option<bool>, d: Option<bool>| McpTool {
        name: n.into(),
        full_name: format!("mcp__probe__{n}"),
        allowed: true,
        read_only_hint: ro,
        destructive_hint: d,
    };
    ApprovalPolicy::from_servers(
        &[McpServer {
            key: "probe".into(),
            tools: vec![tool("read_note", Some(true), None), tool("set_flag", None, None), tool("delete_flag", Some(false), Some(true))],
            ..Default::default()
        }],
        vec![],
    )
}

type Notices = Arc<Mutex<mpsc::Receiver<ApprovalNotice>>>;

fn broker(timeout: Duration) -> (Arc<WorkspaceApprovals>, Notices) {
    let b = Arc::new(WorkspaceApprovals::new().with_timeout(timeout));
    let (tx, rx) = mpsc::channel();
    let tx = Mutex::new(tx);
    b.set_emitter(Arc::new(move |n| {
        let _ = tx.lock().unwrap().send(n);
    }));
    (b, Arc::new(Mutex::new(rx)))
}

async fn next_notice(rx: &Notices, within: Duration) -> Option<ApprovalNotice> {
    let end = Instant::now() + within;
    while Instant::now() < end {
        if let Ok(n) = rx.lock().unwrap().try_recv() {
            return Some(n);
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    None
}

async fn next_question(rx: &Notices, within: Duration) -> Option<ApprovalEvent> {
    let end = Instant::now() + within;
    while Instant::now() < end {
        match next_notice(rx, Duration::from_millis(200)).await {
            Some(ApprovalNotice::Request(e)) => return Some(e),
            Some(other) => eprintln!("NOTICE {other:?}"),
            None => {}
        }
    }
    None
}

fn drain(rx: &Notices) -> Vec<ApprovalNotice> {
    let mut out = Vec::new();
    while let Ok(n) = rx.lock().unwrap().try_recv() {
        out.push(n);
    }
    out
}

fn collector() -> (Arc<Mutex<String>>, Box<dyn Fn(&str) + Send + Sync>) {
    let buf = Arc::new(Mutex::new(String::new()));
    let sink = buf.clone();
    (buf, Box::new(move |d: &str| sink.lock().unwrap().push_str(d)))
}

const SYSTEM: &str = "You are a test harness. Do exactly what is asked with the tools given, then reply in under 15 words.";

fn sources(rig: &Rig) -> SourcesLaunch {
    SourcesLaunch {
        mcp_config_json: Some(rig.mcp_config.clone()),
        allowed_tools: vec!["mcp__probe__read_note".into(), "mcp__probe__set_flag".into(), "mcp__probe__delete_flag".into()],
        server_labels: vec![("probe".into(), "Probe".into())],
        ..Default::default()
    }
}

fn chat(b: &Arc<WorkspaceApprovals>) -> ChatApprovals {
    ChatApprovals { can_ask: true, chat_id: "live".into(), broker: b.clone(), policy: Arc::new(policy()) }
}

fn leftovers(rig: &Rig) {
    // Best effort: whatever the tee wrapper left running for this rig.
    let marker = rig.dir.to_string_lossy().replace('\\', "\\\\");
    let _ = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            &format!(
                "Get-CimInstance Win32_Process | Where-Object {{ $_.CommandLine -like '*{marker}*' }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }}"
            ),
        ])
        .output();
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "talks to the real Claude CLI and the user's account"]
async fn live_claude_asks_before_a_tool_that_writes() {
    let Some(real) = find_claude_binary() else { return };
    let rig = Rig::new("claude");
    let cmd = rig.dir.join("claude_tee.cmd");
    std::fs::write(&cmd, format!("@echo off\r\npython \"{}\" \"{}\" %*\r\n", rig.tee_py.display(), real.display())).unwrap();
    let (b, rx) = broker(Duration::from_secs(60));
    let cfg = SessionConfig {
        kind: CliAgentKind::Claude,
        model: "haiku".into(),
        effort: Some("low".into()),
        system_prompt: SYSTEM.into(),
        thinking: false,
        sources: Some(sources(&rig)),
        approvals: Some(chat(&b)),
    };
    let timeouts = SessionTimeouts { init: Duration::from_secs(90), ..SessionTimeouts::default() };
    let s = Arc::new(ClaudeSession::spawn_with_timeouts(cmd.clone(), cfg, timeouts).await.expect("spawn"));
    eprintln!("LIVE init tools: {:?}", s.init_info().tools);
    let mut at = rig.show_wire("start", 0, &["\"subtype\":\"init\""]);
    let ask = |prompt: &str| {
        let (buf, sink) = collector();
        (buf, sink, prompt.to_string())
    };

    // 1. A read-only tool runs with no question.
    let (buf, sink, p) = ask("Call the read_note tool with name \"a\" and tell me what it returned.");
    let r = s.ask(&p, sink, Arc::new(CancelToken::new())).await;
    eprintln!("LIVE[1] result ok={} text={:?} calls={:?} notices={:?}", r.is_ok(), r.as_ref().map(|t| t.text.clone()).unwrap_or_default(), rig.calls(), drain(&rx));
    let _ = buf;
    at = rig.show_wire("1 read_note", at, &["control_request", "control_response", "tool_use", "tool_result"]);
    assert_eq!(rig.calls().len(), 1, "read_note ran");

    // 2. set_flag asks. Deny: it did not run, the model is told.
    rig.reset();
    let (_, sink, p) = ask("Call the set_flag tool with value \"on\", then tell me whether it worked.");
    let turn = s.ask(&p, sink, Arc::new(CancelToken::new()));
    tokio::pin!(turn);
    let q = tokio::select! { q = next_question(&rx, Duration::from_secs(90)) => q, _ = &mut turn => None };
    let q = q.expect("a question for set_flag");
    eprintln!("LIVE[2] question: tool={} server={} args={} redacted={}", q.tool, q.server, q.args.replace('\n', " "), q.redacted);
    assert_eq!((q.server.as_str(), q.tool.as_str()), ("probe", "set_flag"));
    assert!(b.answer(&q.approval_id, false));
    let r = turn.await;
    eprintln!("LIVE[2] deny -> ok={} text={:?} flag={:?} calls={:?}", r.is_ok(), r.as_ref().map(|t| t.text.clone()).unwrap_or_default(), rig.flag(), rig.calls());
    at = rig.show_wire("2 deny", at, &["control_request", "control_response", "tool_result"]);
    assert!(rig.flag().is_none() && rig.calls().is_empty(), "denied: the tool did not run");

    // 2b. Allow: it ran once with exactly the shown input.
    rig.reset();
    let (_, sink, p) = ask("Call the set_flag tool with value \"on\", then tell me whether it worked.");
    let turn = s.ask(&p, sink, Arc::new(CancelToken::new()));
    tokio::pin!(turn);
    let q = tokio::select! { q = next_question(&rx, Duration::from_secs(90)) => q, _ = &mut turn => None };
    let q = q.expect("a question for set_flag");
    assert!(b.answer(&q.approval_id, true));
    let r = turn.await;
    eprintln!("LIVE[2b] allow -> ok={} text={:?} flag={:?} calls={:?} shown_args={}", r.is_ok(), r.as_ref().map(|t| t.text.clone()).unwrap_or_default(), rig.flag(), rig.calls(), q.args.replace('\n', " "));
    at = rig.show_wire("2b allow", at, &["control_request", "control_response", "tool_result"]);
    assert_eq!(rig.calls().len(), 1, "ran exactly once");
    assert!(rig.calls()[0].contains("\"value\": \"on\""), "{:?}", rig.calls());

    // 3. Nobody answers: timeout denies. (Short timeout broker would need a new
    // session; the 60 s default is used, the turn is cancelled by the test after
    // the question has been open 3 s only to measure the closed notice below.)

    // 4. Cancel mid-question: denied, flag untouched.
    rig.reset();
    let cancel = Arc::new(CancelToken::new());
    let (_, sink, p) = ask("Call the set_flag tool with value \"cancelled\".");
    let turn = s.ask(&p, sink, cancel.clone());
    tokio::pin!(turn);
    let q = tokio::select! { q = next_question(&rx, Duration::from_secs(90)) => q, _ = &mut turn => None };
    let q = q.expect("a question for set_flag");
    cancel.cancel();
    let r = turn.await;
    let after = drain(&rx);
    eprintln!("LIVE[4] cancel -> {:?} flag={:?} calls={:?} notices={after:?}", r.as_ref().map(|t| t.text.clone()).map_err(|e| e.to_string()), rig.flag(), rig.calls());
    assert!(!b.answer(&q.approval_id, true), "the question is gone");
    tokio::time::sleep(Duration::from_secs(3)).await;
    at = rig.show_wire("4 cancel", at, &["control_request", "control_response", "control_cancel_request", "tool_result"]);
    assert!(rig.flag().is_none() && rig.calls().is_empty(), "cancelled: nothing ran");

    // 6. Close during a question.
    rig.reset();
    let (_, sink, p) = ask("Call the set_flag tool with value \"closing\".");
    let s2 = s.clone();
    let turn = tokio::spawn(async move { s2.ask(&p, sink, Arc::new(CancelToken::new())).await.map(|t| t.text).map_err(|e| e.to_string()) });
    let q = next_question(&rx, Duration::from_secs(90)).await.expect("a question for set_flag");
    s.close().await;
    let r = tokio::time::timeout(Duration::from_secs(20), turn).await;
    eprintln!("LIVE[6] close -> {r:?} flag={:?} calls={:?}", rig.flag(), rig.calls());
    assert!(!b.answer(&q.approval_id, true));
    rig.show_wire("6 close", at, &["control_request", "control_response", "control_cancel_request"]);
    assert!(rig.flag().is_none() && rig.calls().is_empty(), "closed: nothing ran");

    leftovers(&rig);
}

/// 3: the 60 s auto-deny, measured with a short broker timeout on its own session.
#[tokio::test]
#[ignore = "talks to the real Claude CLI and the user's account"]
async fn live_claude_timeout_denies() {
    let Some(real) = find_claude_binary() else { return };
    let rig = Rig::new("claude-timeout");
    let cmd = rig.dir.join("claude_tee.cmd");
    std::fs::write(&cmd, format!("@echo off\r\npython \"{}\" \"{}\" %*\r\n", rig.tee_py.display(), real.display())).unwrap();
    let (b, rx) = broker(Duration::from_secs(4));
    let cfg = SessionConfig {
        kind: CliAgentKind::Claude,
        model: "haiku".into(),
        effort: Some("low".into()),
        system_prompt: SYSTEM.into(),
        thinking: false,
        sources: Some(sources(&rig)),
        approvals: Some(chat(&b)),
    };
    let timeouts = SessionTimeouts { init: Duration::from_secs(90), ..SessionTimeouts::default() };
    let s = ClaudeSession::spawn_with_timeouts(cmd, cfg, timeouts).await.expect("spawn");
    let (_, sink) = collector();
    let started = Instant::now();
    let r = s.ask("Call the set_flag tool with value \"late\", then tell me whether it worked.", sink, Arc::new(CancelToken::new())).await;
    let notices = drain(&rx);
    eprintln!("LIVE[3] timeout -> ok={} text={:?} after {:?}; notices {notices:?}; flag={:?} calls={:?}", r.is_ok(), r.as_ref().map(|t| t.text.clone()).unwrap_or_default(), started.elapsed(), rig.flag(), rig.calls());
    rig.show_wire("3 timeout", 0, &["control_request", "control_response", "tool_result"]);
    assert!(rig.flag().is_none() && rig.calls().is_empty());
    s.close().await;
    leftovers(&rig);
}

