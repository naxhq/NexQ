//! Test double for `agy acp`, used by `tests/acp_session.rs`.
//!
//! Launch flags (the session passes its `AcpLaunch.args` through untouched):
//! - `--record <path>`: every stdin line received is appended to this file.
//! - `--meta`: advertise `_meta.antigravity.systemPrompt.append` (Antigravity style).
//! - `--mode-auto`: `session/new` says the current mode is `auto` (the modes
//!   offered are `auto`, `default`, `plan`); otherwise it is `default`.
//! - `--login-fail`: `session/new` fails with `-32000` "API key is missing".
//! - `--bad-model`: `session/set_model` fails.
//! - `--exit-on-start`: print an auth error on stderr and exit 1 before `initialize`.
//!
//! The behaviour of a prompt is picked by its last paragraph:
//! - `hello`: a thought chunk, then `Hello`, ` world`, then usage.
//! - `echo`: the whole prompt text back as `echo:<text>`.
//! - `perm:<kind>:<tool>:<path>`: like `agy`: a `tool_call` `in_progress`, an
//!   update `pending`, the permission request (kind `read`, `execute`, ...), an
//!   update `in_progress`, then `completed` or `failed` by the answer, and
//!   says `perm:allowed` or `perm:rejected`. `<path>` may be empty.
//! - `raw:<json array>`: a scripted turn. Steps: `{"update": {...}}` sends that
//!   `session/update`, `{"perm": {...toolCall...}}` sends a permission request for
//!   that tool call and says `answer:<optionId>` (or `answer:cancelled`),
//!   `{"chunk": "text"}` sends text. Then the turn ends normally.
//! - `auto:<kind>:<tool>`: a tool call that the agent auto-allows, like
//!   Antigravity's reads and writes in its working directory and its web
//!   search: `tool_call` in progress and `completed`, with no permission
//!   request. Says `auto:done` if the session lets it finish the turn.
//! - `fsreq`: sends an `fs/read_text_file` request and says `fs:error` if it got an error reply.
//! - `slow`: 100 chunks, 50 ms apart; `session/cancel` ends it with `stopReason: cancelled`.
//! - `crash`: one chunk, then exit code 1 with a line on stderr.
//! - `hang`: one chunk, then silence forever.
//! - `quota`: a JSON-RPC error 402 "prepayment credits are depleted".
//! - `env`: whether `NEXQ_TEST_SECRET` and `GEMINI_API_KEY` reached this process.
//! - anything else `q`: `answer:<q>`.
//! - stdin EOF: exit 0.

use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

fn emit(v: &Value) {
    let mut out = std::io::stdout().lock();
    writeln!(out, "{v}").unwrap();
    out.flush().unwrap();
}

fn reply(id: &Value, result: Value) {
    emit(&json!({"jsonrpc": "2.0", "id": id, "result": result}));
}

fn reply_err(id: &Value, code: i64, message: &str) {
    emit(&json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}));
}

fn update(update: Value) {
    emit(&json!({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "fake-sid", "update": update}}));
}

fn chunk(text: &str) {
    update(json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}}));
}

fn usage() -> Value {
    json!({"inputTokens": 100, "outputTokens": 7, "cachedReadTokens": 40, "cachedWriteTokens": 0, "thoughtTokens": 3, "totalTokens": 147})
}

fn end_turn(id: &Value) {
    reply(id, json!({"stopReason": "end_turn", "usage": usage()}));
}

/// Wait for the reply to our request `id`; `session/cancel` seen meanwhile is returned in `.1`.
fn wait_reply(rx: &Receiver<Value>, id: &Value) -> (Value, bool) {
    let mut cancelled = false;
    loop {
        let Ok(msg) = rx.recv() else { std::process::exit(0) };
        if msg["method"] == "session/cancel" {
            cancelled = true;
        }
        if msg.get("method").is_none() && msg["id"] == *id {
            return (msg, cancelled);
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |f: &str| args.iter().any(|a| a == f);
    let arg_after = |f: &str| args.iter().position(|a| a == f).and_then(|i| args.get(i + 1)).cloned();
    let record = arg_after("--record");

    if flag("--exit-on-start") {
        eprintln!("fake_acp: Not logged in. Please log in first.");
        std::process::exit(1);
    }

    // stdin on its own thread, so a prompt in progress can see `session/cancel`.
    let (tx, rx) = mpsc::channel::<Value>();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if let Some(path) = &record {
                let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap();
                writeln!(f, "{line}").unwrap();
            }
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                let _ = tx.send(v);
            }
        }
    });
    eprintln!("fake_acp: ready");

    let mut next_agent_id = 1000u64;
    while let Ok(msg) = rx.recv() {
        let id = msg["id"].clone();
        match msg["method"].as_str().unwrap_or_default() {
            "initialize" => {
                let mut caps = json!({"promptCapabilities": {"image": false}});
                if flag("--meta") {
                    caps["_meta"] = json!({"antigravity": {"systemPrompt": {"append": true}}});
                }
                reply(&id, json!({
                    "protocolVersion": 1,
                    "agentCapabilities": caps,
                    "agentInfo": {"name": "fake-acp", "version": "0.0.1"},
                    "authMethods": [{"id": "oauth-personal", "name": "Log in with Google"}],
                }));
            }
            "session/new" => {
                if flag("--login-fail") {
                    reply_err(&id, -32000, "Gemini API key is missing or not configured.");
                    continue;
                }
                let current_mode = if flag("--mode-auto") { "auto" } else { "default" };
                reply(&id, json!({
                    "sessionId": "fake-sid",
                    "modes": {
                        "currentModeId": current_mode,
                        "availableModes": [
                            {"id": "auto", "name": "Auto"},
                            {"id": "default", "name": "Default"},
                            {"id": "plan", "name": "Plan"},
                        ],
                    },
                    "models": {
                        "availableModels": [
                            {"modelId": "fake-fast", "name": "Fake Fast"},
                            {"modelId": "fake-deep", "name": "Fake Deep"},
                        ],
                        "currentModelId": "fake-fast",
                    },
                }));
            }
            "session/set_mode" => reply(&id, json!({})),
            "session/set_model" => {
                if flag("--bad-model") {
                    reply_err(&id, -32602, "Invalid params: unknown model");
                } else {
                    reply(&id, json!({}));
                }
            }
            "session/prompt" => {
                let text = msg["params"]["prompt"][0]["text"].as_str().unwrap_or_default().to_string();
                let last = text.rsplit("\n\n").next().unwrap_or_default().trim().to_string();
                prompt(&rx, &id, &text, &last, &mut next_agent_id);
            }
            // `session/cancel` outside a prompt, and anything unknown: ignored.
            _ => {}
        }
    }
}

fn prompt(rx: &Receiver<Value>, id: &Value, text: &str, last: &str, next_agent_id: &mut u64) {
    match last.split(':').next().unwrap_or_default() {
        "hello" => {
            update(json!({"sessionUpdate": "available_commands_update", "availableCommands": []}));
            update(json!({"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "thinking"}}));
            chunk("Hello");
            chunk(" world");
            update(json!({"sessionUpdate": "usage_update", "used": 10, "size": 1000}));
            end_turn(id);
        }
        "echo" => {
            chunk(&format!("echo:{text}"));
            end_turn(id);
        }
        "perm" => {
            let mut parts = last.splitn(4, ':').skip(1);
            let kind = parts.next().unwrap_or("read");
            let tool = parts.next().filter(|t| !t.is_empty()).unwrap_or(if kind == "execute" { "run_command" } else { "read_file" });
            let path = parts.next().unwrap_or_default();
            let call_id = format!("{tool}-{}", *next_agent_id);
            let mut tool_call = json!({
                "toolCallId": call_id, "name": tool, "kind": kind, "status": "pending",
                "title": format!("{tool} {path}"),
                "rawInput": if path.is_empty() { json!({"CommandLine": "echo hi"}) } else { json!({"Path": path}) },
            });
            if !path.is_empty() {
                tool_call["locations"] = json!([{ "path": path }]);
            }
            update(json!({"sessionUpdate": "tool_call", "toolCallId": call_id, "name": tool, "kind": kind, "status": "in_progress", "title": tool, "locations": tool_call["locations"].clone(), "rawInput": tool_call["rawInput"].clone()}));
            update(json!({"sessionUpdate": "tool_call_update", "toolCallId": call_id, "name": tool, "status": "pending"}));
            let req_id = json!(*next_agent_id);
            *next_agent_id += 1;
            emit(&json!({
                "jsonrpc": "2.0", "id": req_id, "method": "session/request_permission",
                "params": {"sessionId": "fake-sid", "toolCall": tool_call, "options": [
                    {"optionId": "allow", "name": "Allow", "kind": "allow_once"},
                    {"optionId": "deny", "name": "Deny", "kind": "reject_once"},
                ]},
            }));
            let (answer, _) = wait_reply(rx, &req_id);
            let allowed = answer["result"]["outcome"]["optionId"] == "allow";
            update(json!({"sessionUpdate": "tool_call_update", "toolCallId": call_id, "name": tool, "status": "in_progress"}));
            update(json!({"sessionUpdate": "tool_call_update", "toolCallId": call_id, "name": tool, "status": if allowed { "completed" } else { "failed" }}));
            chunk(if allowed { "perm:allowed" } else { "perm:rejected" });
            end_turn(id);
        }
        "raw" => {
            let steps: Vec<Value> = serde_json::from_str(last.strip_prefix("raw:").unwrap_or("[]")).unwrap_or_default();
            for step in steps {
                if let Some(u) = step.get("update") {
                    update(u.clone());
                } else if let Some(c) = step.get("chunk").and_then(Value::as_str) {
                    chunk(c);
                } else if let Some(tool_call) = step.get("perm") {
                    let req_id = json!(*next_agent_id);
                    *next_agent_id += 1;
                    emit(&json!({
                        "jsonrpc": "2.0", "id": req_id, "method": "session/request_permission",
                        "params": {"sessionId": "fake-sid", "toolCall": tool_call, "options": [
                            {"optionId": "allow", "name": "Allow", "kind": "allow_once"},
                            {"optionId": "deny", "name": "Deny", "kind": "reject_once"},
                        ]},
                    }));
                    let (answer, _) = wait_reply(rx, &req_id);
                    chunk(&format!("answer:{}", answer["result"]["outcome"]["optionId"].as_str().unwrap_or("cancelled")));
                }
            }
            end_turn(id);
        }
        "auto" => {
            let mut parts = last.splitn(3, ':').skip(1);
            let kind = parts.next().unwrap_or("read");
            let tool = parts.next().filter(|t| !t.is_empty()).unwrap_or("read_file");
            let call_id = format!("{tool}-auto-{}", *next_agent_id);
            *next_agent_id += 1;
            update(json!({"sessionUpdate": "tool_call", "toolCallId": call_id, "name": tool, "kind": kind, "status": "in_progress", "title": tool, "rawInput": {"Path": "inside.txt"}}));
            update(json!({"sessionUpdate": "tool_call_update", "toolCallId": call_id, "status": "completed"}));
            chunk("auto:done");
            end_turn(id);
        }
        "fsreq" => {
            let req_id = json!(*next_agent_id);
            *next_agent_id += 1;
            emit(&json!({"jsonrpc": "2.0", "id": req_id, "method": "fs/read_text_file", "params": {"sessionId": "fake-sid", "path": "C:\\x.txt"}}));
            let (answer, _) = wait_reply(rx, &req_id);
            chunk(if answer.get("error").is_some() { "fs:error" } else { "fs:ok" });
            end_turn(id);
        }
        "slow" => {
            for _ in 0..100 {
                chunk("x");
                if let Ok(msg) = rx.recv_timeout(Duration::from_millis(50)) {
                    if msg["method"] == "session/cancel" {
                        reply(id, json!({"stopReason": "cancelled"}));
                        return;
                    }
                }
            }
            end_turn(id);
        }
        "crash" => {
            chunk("par");
            eprintln!("fake_acp: crashing");
            std::process::exit(1);
        }
        "hang" => {
            chunk("par");
            loop {
                std::thread::sleep(Duration::from_secs(3600));
            }
        }
        "quota" => reply_err(id, 402, "Your prepayment credits are depleted."),
        "env" => {
            let set = |k: &str| if std::env::var_os(k).is_some() { "set" } else { "unset" };
            chunk(&format!("env:NEXQ_TEST_SECRET={} GEMINI_API_KEY={} ANTHROPIC_API_KEY={}", set("NEXQ_TEST_SECRET"), set("GEMINI_API_KEY"), set("ANTHROPIC_API_KEY")));
            end_turn(id);
        }
        _ => {
            chunk(&format!("answer:{last}"));
            end_turn(id);
        }
    }
}
