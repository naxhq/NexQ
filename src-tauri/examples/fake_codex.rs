//! Test double for `codex.exe` speaking the `app-server` JSON-RPC protocol,
//! used by `tests/codex_session.rs`. It accepts (and ignores) the real launch
//! args apart from `-c fake_*=value` pairs, which configure it (tests pass them
//! through `CodexLaunch::mcp_overrides`, because parallel tests cannot share
//! process env vars and the session controls the child's environment):
//!
//! - `fake_mode=normal|slow|hang|crash` (default `normal`)
//! - `fake_account=chatgpt|apikey|none` (default `chatgpt`)
//! - `fake_mcp=<name>:<status>,...`: `mcpServer/startupStatus/updated`
//!   notifications sent after `thread/start` (status `ready` or `failed`)
//! - `fake_notes=<dir>`: the notes folder the `approve:read` query reads
//! - `fake_record=<path>`: every stdin line, and the argv, appended to this file
//!
//! One-shot subcommands (no app-server): `mcp list --json` prints two servers,
//! `login status` prints `Logged in using ChatGPT`, `debug models` prints a
//! small catalog.
//!
//! Turn behaviour (`turn/start` text `q`):
//! - `hello`: deltas `Hello`, ` world`. Any other `q`: `answer:<q>` in 3-char
//!   deltas. Each answer is preceded by a reasoning delta and a "commentary"
//!   message that must not be streamed, and followed by token usage
//!   (cumulative, per turn: input +1200, cached +1000, output +80, reasoning +30).
//! - `mcp`: an `mcpToolCall` item (`mira` / `kb_search`) before the answer.
//! - `read`: a `commandExecution` item that reads `a.md`, before the answer.
//! - `usage`: a failed turn with Codex's real usage-limit error.
//! - `fail:<msg>`: a failed turn with `<msg>` and no error cause.
//! - `approve:cmd|read|file|mcp-ok|mcp-no`: a server request; the answer is
//!   `decision:<what the client replied>`.
//! - `slow` mode: one delta per character, 100 ms apart, interruptible.
//! - `crash` mode: exits with code 1 right after the first delta.
//! - `hang` mode: sleeps forever after the first delta.
//! - `turn/interrupt`: the running turn completes as `interrupted`.
//! - stdin EOF: exits 0.

use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::{BufRead, Write};
use std::sync::mpsc;
use std::time::Duration;

fn emit(v: &Value) {
    let mut out = std::io::stdout().lock();
    writeln!(out, "{v}").unwrap();
    out.flush().unwrap();
}

fn note(method: &str, params: Value) {
    emit(&json!({ "method": method, "params": params }));
}

fn respond(id: &Value, result: Value) {
    emit(&json!({ "id": id, "result": result }));
}

struct Config {
    mode: String,
    account: String,
    mcp: Vec<(String, String)>,
    notes: String,
    record: Option<String>,
}

fn config_from_args(args: &[String]) -> Config {
    let mut c = Config {
        mode: "normal".into(),
        account: "chatgpt".into(),
        mcp: vec![],
        notes: String::new(),
        record: None,
    };
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a != "-c" {
            continue;
        }
        let Some(pair) = it.next() else { break };
        let Some((k, v)) = pair.split_once('=') else { continue };
        match k {
            "fake_mode" => c.mode = v.into(),
            "fake_account" => c.account = v.into(),
            "fake_notes" => c.notes = v.into(),
            "fake_record" => c.record = Some(v.into()),
            "fake_mcp" => {
                c.mcp = v
                    .split(',')
                    .filter_map(|s| s.split_once(':'))
                    .map(|(n, s)| (n.to_string(), s.to_string()))
                    .collect()
            }
            _ => {}
        }
    }
    c
}

fn record(c: &Config, line: &str) {
    if let Some(path) = &c.record {
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap();
        writeln!(f, "{line}").unwrap();
    }
}

fn usage_obj(n: u64) -> Value {
    json!({
        "totalTokens": n * 1280,
        "inputTokens": n * 1200,
        "cachedInputTokens": n * 1000,
        "cacheWriteInputTokens": 0,
        "outputTokens": n * 80,
        "reasoningOutputTokens": n * 30,
    })
}

fn turn_obj(id: &str, status: &str, error: Value) -> Value {
    json!({ "id": id, "items": [], "itemsView": "notLoaded", "status": status, "error": error, "durationMs": 1500 })
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    // One-shot subcommands.
    if args.iter().any(|a| a == "mcp") && args.iter().any(|a| a == "list") {
        println!(r#"[{{"name":"mira","enabled":true,"transport":{{"type":"stdio","command":"x","env":{{"TOKEN":"secret"}}}}}},{{"name":"web search","enabled":true}}]"#);
        return;
    }
    if args.iter().any(|a| a == "login") {
        println!("Logged in using ChatGPT");
        return;
    }
    if args.iter().any(|a| a == "debug") && args.iter().any(|a| a == "models") {
        println!(
            r#"{{"models":[{{"slug":"fake-big","display_name":"Fake Big","visibility":"list","priority":1,"default_reasoning_level":"low","supported_reasoning_levels":[{{"effort":"low"}},{{"effort":"high"}}]}},{{"slug":"fake-hidden","display_name":"Hidden","visibility":"hide","priority":0}}]}}"#
        );
        return;
    }
    if !args.iter().any(|a| a == "app-server") {
        std::process::exit(2);
    }

    let cfg = config_from_args(&args);
    record(&cfg, &format!("ARGV {}", args.join(" ")));

    let (tx, rx) = mpsc::channel::<Option<Value>>();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            match serde_json::from_str::<Value>(&line) {
                Ok(v) => {
                    let _ = tx.send(Some(v));
                }
                Err(_) => continue,
            }
        }
        let _ = tx.send(None);
    });

    let mut turns = 0u64;
    let mut backlog: VecDeque<Value> = VecDeque::new();
    loop {
        let msg = match backlog.pop_front() {
            Some(m) => m,
            None => match rx.recv() {
                Ok(Some(m)) => m,
                _ => return,
            },
        };
        record(&cfg, &msg.to_string());
        let id = msg.get("id").cloned().unwrap_or(Value::Null);
        match msg.get("method").and_then(Value::as_str) {
            Some("initialize") => respond(
                &id,
                json!({ "userAgent": "fake/0.0.0", "codexHome": "C:\\fake", "platformFamily": "windows", "platformOs": "windows" }),
            ),
            Some("account/read") => {
                let account = match cfg.account.as_str() {
                    "apikey" => json!({ "type": "apiKey" }),
                    "none" => Value::Null,
                    _ => json!({ "type": "chatgpt", "email": "fake@example.com", "planType": "pro" }),
                };
                respond(&id, json!({ "account": account, "requiresOpenaiAuth": true }));
            }
            Some("model/list") => respond(
                &id,
                json!({ "data": [
                    { "id": "fake-big", "model": "fake-big", "displayName": "Fake Big", "hidden": false,
                      "defaultReasoningEffort": "low",
                      "supportedReasoningEfforts": [{ "reasoningEffort": "low" }, { "reasoningEffort": "high" }] },
                    { "id": "fake-old", "model": "fake-old", "displayName": "Old", "hidden": true,
                      "defaultReasoningEffort": "low", "supportedReasoningEfforts": [] }
                ], "nextCursor": null }),
            ),
            Some("thread/start") => {
                let model = msg["params"]["model"].as_str().unwrap_or("fake-default").to_string();
                respond(&id, json!({ "thread": { "id": "thread-1" }, "model": model }));
                note("thread/started", json!({ "thread": { "id": "thread-1" } }));
                for (name, status) in &cfg.mcp {
                    note("mcpServer/startupStatus/updated", json!({ "threadId": "thread-1", "name": name, "status": "starting", "error": null }));
                    let error = (status == "failed").then(|| "MCP startup failed".to_string());
                    note("mcpServer/startupStatus/updated", json!({ "threadId": "thread-1", "name": name, "status": status, "error": error }));
                }
            }
            Some("turn/start") => {
                turns += 1;
                let text = msg["params"]["input"][0]["text"].as_str().unwrap_or("");
                // The question is the last line when context was prepended.
                let q = text.rsplit("Now answer this:\n").next().unwrap_or(text).trim().to_string();
                run_turn(&cfg, &rx, &mut backlog, &id, &q, turns);
            }
            Some("turn/interrupt") => respond(&id, json!({})),
            _ => {}
        }
    }
}

/// Run one turn to its `turn/completed`. Messages that arrive meanwhile and
/// are not an interrupt are handed back through `backlog`.
fn run_turn(
    cfg: &Config,
    rx: &mpsc::Receiver<Option<Value>>,
    backlog: &mut VecDeque<Value>,
    start_id: &Value,
    q: &str,
    turn_no: u64,
) {
    let turn_id = format!("turn-{turn_no}");
    respond(start_id, json!({ "turn": turn_obj(&turn_id, "inProgress", Value::Null) }));
    note("turn/started", json!({ "threadId": "thread-1", "turn": turn_obj(&turn_id, "inProgress", Value::Null) }));
    let item = |t: &str, extra: Value| {
        let mut base = json!({ "type": t, "id": format!("{t}-{turn_no}") });
        if let (Some(b), Some(e)) = (base.as_object_mut(), extra.as_object()) {
            for (k, v) in e {
                b.insert(k.clone(), v.clone());
            }
        }
        base
    };
    let started = |it: Value| note("item/started", json!({ "threadId": "thread-1", "turnId": turn_id, "startedAtMs": 1, "item": it }));
    let completed = |it: Value| note("item/completed", json!({ "threadId": "thread-1", "turnId": turn_id, "completedAtMs": 2, "item": it }));
    let finish = |status: &str, error: Value| {
        note("turn/completed", json!({ "threadId": "thread-1", "turn": turn_obj(&turn_id, status, error) }));
    };

    if q == "usage" {
        let error = json!({
            "message": "You've hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 26th, 2026 9:15 AM.",
            "codexErrorInfo": "usageLimitExceeded",
        });
        note("error", json!({ "error": error, "willRetry": false, "threadId": "thread-1", "turnId": turn_id }));
        finish("failed", error);
        return;
    }
    if let Some(message) = q.strip_prefix("fail:") {
        let error = json!({ "message": message, "codexErrorInfo": null });
        note("error", json!({ "error": error, "willRetry": false, "threadId": "thread-1", "turnId": turn_id }));
        finish("failed", error);
        return;
    }

    // Thinking, then narration that is not part of the answer.
    started(item("reasoning", json!({})));
    note("item/reasoning/summaryTextDelta", json!({ "threadId": "thread-1", "turnId": turn_id, "itemId": "reasoning", "summaryIndex": 0, "delta": "Thinking" }));
    let narration = item("agentMessage", json!({ "id": "msg-narration", "text": "", "phase": "commentary" }));
    started(narration.clone());
    note("item/agentMessage/delta", json!({ "threadId": "thread-1", "turnId": turn_id, "itemId": narration["id"], "delta": "Let me look." }));
    completed(item("agentMessage", json!({ "id": "msg-narration", "text": "Let me look.", "phase": "commentary" })));

    let answer = if q == "hello" { "Hello world".to_string() } else { format!("answer:{q}") };
    let mut answer = answer;

    if q == "mcp" {
        let call = json!({ "type": "mcpToolCall", "id": "call-1", "server": "mira", "tool": "kb_search",
                           "arguments": { "query": "budget" }, "status": "inProgress" });
        started(call.clone());
        let mut done = call;
        done["status"] = json!("completed");
        completed(done);
    }
    if q == "read" {
        let cmd = json!({ "type": "commandExecution", "id": "cmd-1", "command": "type a.md",
                          "commandActions": [{ "type": "read", "command": "type a.md", "name": "a.md", "path": "a.md" }],
                          "status": "inProgress" });
        started(cmd.clone());
        let mut done = cmd;
        done["status"] = json!("completed");
        completed(done);
    }
    if let Some(kind) = q.strip_prefix("approve:") {
        let notes = cfg.notes.replace('/', "\\");
        let (method, params) = match kind {
            "cmd" => (
                "item/commandExecution/requestApproval",
                json!({ "threadId": "thread-1", "turnId": turn_id, "itemId": "cmd-2", "startedAtMs": 1,
                        "command": "del C:\\x.txt", "cwd": "C:\\sandbox",
                        "commandActions": [{ "type": "unknown", "command": "del C:\\x.txt" }] }),
            ),
            "read" => (
                "item/commandExecution/requestApproval",
                json!({ "threadId": "thread-1", "turnId": turn_id, "itemId": "cmd-3", "startedAtMs": 1,
                        "command": format!("type {notes}\\a.md"),
                        "cwd": std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default(),
                        "commandActions": [{ "type": "read", "command": "type a.md", "name": "a.md", "path": format!("{notes}\\a.md") }] }),
            ),
            "file" => (
                "item/fileChange/requestApproval",
                json!({ "threadId": "thread-1", "turnId": turn_id, "itemId": "fc-1", "startedAtMs": 1 }),
            ),
            tool => (
                "mcpServer/elicitation/request",
                json!({ "threadId": "thread-1", "turnId": turn_id, "serverName": "mira", "mode": "form",
                        "message": format!("Allow the mira MCP server to run tool \"{}\"?", if tool == "mcp-ok" { "kb_search" } else { "send_mail" }),
                        "_meta": { "codex_approval_kind": "mcp_tool_call" },
                        "requestedSchema": { "type": "object", "properties": {} } }),
            ),
        };
        emit(&json!({ "id": 9000 + turn_no, "method": method, "params": params }));
        // Wait for the client's reply to that request.
        let reply = loop {
            match rx.recv() {
                Ok(Some(m)) if m.get("method").is_none() && m.get("id") == Some(&json!(9000 + turn_no)) => break m,
                Ok(Some(m)) => backlog.push_back(m),
                _ => return,
            }
        };
        record(cfg, &reply.to_string());
        let decision = reply["result"]["decision"]
            .as_str()
            .or_else(|| reply["result"]["action"].as_str())
            .unwrap_or("?")
            .to_string();
        answer = format!("decision:{decision}");
    }

    let msg = item("agentMessage", json!({ "id": "msg-answer", "text": "", "phase": "final_answer" }));
    started(msg.clone());
    let chars: Vec<char> = answer.chars().collect();
    let pieces: Vec<String> = if q == "hello" {
        vec!["Hello".into(), " world".into()]
    } else if cfg.mode == "slow" {
        chars.iter().map(|c| c.to_string()).collect()
    } else {
        chars.chunks(3).map(|c| c.iter().collect()).collect()
    };
    for (i, piece) in pieces.iter().enumerate() {
        note("item/agentMessage/delta", json!({ "threadId": "thread-1", "turnId": turn_id, "itemId": msg["id"], "delta": piece }));
        if i == 0 && cfg.mode == "crash" {
            std::process::exit(1);
        }
        if i == 0 && cfg.mode == "hang" {
            loop {
                std::thread::sleep(Duration::from_secs(3600));
            }
        }
        if cfg.mode == "slow" {
            // Interruptible: an `turn/interrupt` ends the turn.
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(Some(m)) if m.get("method").and_then(Value::as_str) == Some("turn/interrupt") => {
                    record(cfg, &m.to_string());
                    respond(&m["id"], json!({}));
                    finish("interrupted", Value::Null);
                    return;
                }
                Ok(Some(m)) => backlog.push_back(m),
                Ok(None) => return,
                Err(_) => {}
            }
        }
    }
    let mut full = msg;
    full["text"] = json!(answer);
    completed(full);
    note("thread/tokenUsage/updated", json!({
        "threadId": "thread-1", "turnId": turn_id,
        "tokenUsage": { "total": usage_obj(turn_no), "last": usage_obj(1), "modelContextWindow": 272000 },
    }));
    finish("completed", Value::Null);
}
