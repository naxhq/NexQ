//! Test double for `claude.exe` speaking the `stream-json` protocol, used by
//! `tests/claude_session.rs`. It accepts (and ignores) the real launch args.
//!
//! Configuration travels inside the system prompt file (`--system-prompt-file`),
//! one `key=value` directive per line, because the session strips/controls the
//! child environment and parallel tests cannot share process env vars:
//! - `fake_mode=normal|slow|crash_mid_turn|hang` (default `normal`)
//! - `fake_mcp=<name>:<status>,...`: the `mcp_servers` of `system/init` (e.g.
//!   `mira:failed,notes:connected`). Default none.
//! - `fake_record=<path>`: every stdin line received is appended to this file.
//!
//! Behaviour:
//! - Startup: a blank line and a truncated JSON line (the reader must skip
//!   both). Like the real CLI, `system/init` is printed only once a stdin
//!   message arrives, and again before every turn. A missing system prompt file
//!   exits with code 3.
//! - `shouldQuery:false` user message: an empty `result` at once, no deltas.
//! - Query `hello`: deltas `Hello`, ` world`. Query `fail:<msg>`: an error
//!   result with text `<msg>`. Any other query `q`: `answer:<q>` in 3-char deltas.
//! - `slow`: one delta per character, 100 ms apart.
//! - `crash_mid_turn`: exits with code 1 right after the first delta.
//! - `hang`: after the first delta, sleeps forever without exiting or
//!   printing anything (a wedged CLI).
//! - `control_request` `initialize` (the model-list probe, launched without
//!   `--system-prompt-file`): a `system/status` line, then a
//!   `control_response` with a small model catalog (Haiku without effort
//!   support, like the real CLI). After that, stdin EOF takes 3 s to exit
//!   (a CLI slow to shut down).
//! - Thinking: unless `CLAUDE_CODE_DISABLE_THINKING=1` is set, every query
//!   first streams a `thinking_delta` and reports `thinking_tokens: 3`.
//! - Usage: like the real CLI, `total_cost_usd` is cumulative for the process
//!   (0.0001 per answered query); token counts are per turn, mostly cache
//!   writes on the first query and cache reads afterwards.
//! - stdin EOF: exits 0.

use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::time::Duration;

fn emit(out: &mut impl Write, v: &Value) {
    writeln!(out, "{v}").unwrap();
    out.flush().unwrap();
}

/// The real CLI's answer shape (`response.response.models`), trimmed.
fn initialize_response(request_id: &Value) -> Value {
    let all = ["low", "medium", "high", "xhigh", "max"];
    json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": {
                "models": [
                    {"value":"opus","resolvedModel":"claude-opus-5-5","displayName":"Opus 5.5","description":"Best for everyday, complex tasks","supportsEffort":true,"supportedEffortLevels":all},
                    {"value":"sonnet","resolvedModel":"claude-sonnet-5-5","displayName":"Sonnet 5.5","description":"Efficient for routine tasks","supportsEffort":true,"supportedEffortLevels":all},
                    {"value":"haiku","resolvedModel":"claude-haiku-4-5-20251001","displayName":"Haiku 4.5","description":"Fastest for quick answers"},
                    {"value":"claude-opus-4-6","resolvedModel":"claude-opus-4-6","displayName":"Opus 4.6","description":"Best for everyday, complex tasks","supportsEffort":true,"supportedEffortLevels":["low","medium","high","max"]}
                ],
                "account": {}
            }
        }
    })
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let arg_after = |flag: &str| {
        args.iter()
            .position(|a| a == flag)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let model = arg_after("--model").unwrap_or_default();
    // The model probe passes no system prompt file; a session always does.
    let prompt = match arg_after("--system-prompt-file") {
        None => String::new(),
        Some(prompt_path) => match std::fs::read_to_string(&prompt_path) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("fake_claude: cannot read system prompt file {prompt_path:?}: {e}");
                std::process::exit(3);
            }
        },
    };
    let directive = |key: &str| {
        prompt.lines().find_map(|l| {
            l.trim()
                .strip_prefix(&format!("{key}="))
                .map(str::to_string)
        })
    };
    let mode = directive("fake_mode").unwrap_or_else(|| "normal".into());
    let record = directive("fake_record");

    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    writeln!(out).unwrap();
    writeln!(out, r#"{{"type":"system","subtype":"ini"#).unwrap();
    out.flush().unwrap();
    let mcp_servers: Vec<Value> = directive("fake_mcp")
        .unwrap_or_default()
        .split(',')
        .filter_map(|p| p.split_once(':'))
        .map(|(name, status)| json!({"name": name, "status": status, "source": "dynamic"}))
        .collect();
    let init = json!({"type":"system","subtype":"init","session_id":"fake-session","model":model,"tools":[],"mcp_servers":mcp_servers});
    eprintln!("fake_claude: ready (mode={mode})");

    let thinking = std::env::var("CLAUDE_CODE_DISABLE_THINKING").as_deref() != Ok("1");
    let mut answered = 0u32;
    let mut answered_initialize = false;
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if let Some(path) = &record {
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .unwrap();
            writeln!(f, "{line}").unwrap();
        }
        let Ok(msg) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if msg["type"] == "control_request" && msg["request"]["subtype"] == "initialize" {
            emit(
                &mut out,
                &json!({"type":"system","subtype":"status","status":"initializing"}),
            );
            emit(&mut out, &initialize_response(&msg["request_id"]));
            answered_initialize = true;
            continue;
        }
        if msg["type"] != "user" {
            continue;
        }
        emit(&mut out, &init);
        if msg["shouldQuery"] == false {
            emit(
                &mut out,
                &json!({"type":"result","subtype":"success","is_error":false,"result":"","usage":{"input_tokens":0,"output_tokens":0}}),
            );
            continue;
        }
        let content = msg["message"]["content"].as_str().unwrap_or("").to_string();
        if let Some(err) = content.strip_prefix("fail:") {
            emit(
                &mut out,
                &json!({"type":"result","subtype":"success","is_error":true,"result":err}),
            );
            continue;
        }
        let answer = if content == "hello" {
            "Hello world".to_string()
        } else {
            format!("answer:{content}")
        };
        let chars: Vec<char> = answer.chars().collect();
        let deltas: Vec<String> = if content == "hello" {
            vec!["Hello".into(), " world".into()]
        } else if mode == "slow" {
            chars.iter().map(|c| c.to_string()).collect()
        } else {
            chars.chunks(3).map(|c| c.iter().collect()).collect()
        };
        emit(
            &mut out,
            &json!({"type":"system","subtype":"status","status":"requesting"}),
        );
        emit(
            &mut out,
            &json!({"type":"stream_event","event":{"type":"message_start"}}),
        );
        if thinking {
            emit(
                &mut out,
                &json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me see"}}}),
            );
            emit(
                &mut out,
                &json!({"type":"system","subtype":"thinking_tokens","tokens":3}),
            );
        }
        for d in deltas {
            emit(
                &mut out,
                &json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":d}}}),
            );
            if mode == "crash_mid_turn" {
                eprintln!("fake_claude: crashing mid-turn");
                std::process::exit(1);
            }
            if mode == "hang" {
                eprintln!("fake_claude: hanging mid-turn");
                loop {
                    std::thread::sleep(Duration::from_secs(3600));
                }
            }
            if mode == "slow" {
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        emit(
            &mut out,
            &json!({"type":"assistant","message":{"content":[{"type":"text","text":answer}]}}),
        );
        answered += 1;
        let (cache_write, cache_read) = if answered == 1 { (500, 0) } else { (20, 500) };
        let thinking_tokens = if thinking { 3 } else { 0 };
        emit(
            &mut out,
            &json!({"type":"result","subtype":"success","is_error":false,"result":answer,
                "total_cost_usd":0.0001 * f64::from(answered),"duration_ms":5,
                "usage":{"input_tokens":10,"cache_creation_input_tokens":cache_write,
                    "cache_read_input_tokens":cache_read,"output_tokens":chars.len() + thinking_tokens,
                    "output_tokens_details":{"thinking_tokens":thinking_tokens}}}),
        );
    }
    if answered_initialize {
        std::thread::sleep(Duration::from_secs(3));
    }
}
