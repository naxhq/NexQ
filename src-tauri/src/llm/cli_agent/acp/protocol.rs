//! Agent Client Protocol messages: JSON-RPC 2.0, one JSON object per line.
//!
//! Pure building and parsing (no I/O), so everything here is unit tested
//! against lines captured from `agy acp` (Antigravity CLI 1.5.14) in `testdata/`.

use crate::llm::cli_agent::protocol::{classify_error, AgentErrorKind, ToolUse, TurnResult};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// The ACP protocol version NexQ speaks.
pub const PROTOCOL_VERSION: u64 = 1;

// ---- building ---------------------------------------------------------

/// A request line (without the trailing newline).
pub fn request(id: u64, method: &str, params: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string()
}

/// A notification line (no `id`, no reply expected).
pub fn notification(method: &str, params: Value) -> String {
    json!({ "jsonrpc": "2.0", "method": method, "params": params }).to_string()
}

/// A success reply to an agent request. `id` is echoed as received (number or string).
pub fn response_ok(id: &Value, result: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string()
}

/// An error reply to an agent request.
pub fn response_err(id: &Value, code: i64, message: &str) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
        .to_string()
}

/// JSON-RPC "Method not found".
pub const METHOD_NOT_FOUND: i64 = -32601;

/// `initialize` params: no client file system, no terminal. The agent has to
/// use its own tools (and ask us for permission to run them).
pub fn initialize_params() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false },
        "clientInfo": { "name": "NexQ", "title": "NexQ", "version": env!("CARGO_PKG_VERSION") },
    })
}

/// `session/new` params. `additionalDirectories` is only sent when the agent
/// advertised it (an agent that does not know the field may reject it);
/// `system_prompt_append` goes in `_meta.antigravity.systemPrompt.append`.
pub fn session_new_params(
    cwd: &Path,
    mcp_servers: &[Value],
    additional_dirs: &[PathBuf],
    send_additional_dirs: bool,
    system_prompt_append: Option<&str>,
) -> Value {
    let mut params = json!({
        "cwd": cwd.to_string_lossy(),
        "mcpServers": mcp_servers,
    });
    if send_additional_dirs && !additional_dirs.is_empty() {
        params["additionalDirectories"] = additional_dirs
            .iter()
            .map(|d| Value::String(d.to_string_lossy().into_owned()))
            .collect();
    }
    if let Some(text) = system_prompt_append {
        params["_meta"] = json!({ "antigravity": { "systemPrompt": { "append": text } } });
    }
    params
}

/// `session/prompt` params: one text block.
pub fn prompt_params(session_id: &str, text: &str) -> Value {
    json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": text }] })
}

/// `session/set_model` params (verified against `agy acp`).
pub fn set_model_params(session_id: &str, model_id: &str) -> Value {
    json!({ "sessionId": session_id, "modelId": model_id })
}

/// `session/cancel` params.
pub fn cancel_params(session_id: &str) -> Value {
    json!({ "sessionId": session_id })
}

// ---- parsing ----------------------------------------------------------

/// A JSON-RPC error object.
#[derive(Debug, Clone, PartialEq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl RpcError {
    /// The message plus the agent's `data.details`/`data` text when it has one.
    pub fn text(&self) -> String {
        let detail = match &self.data {
            Some(Value::String(s)) => Some(s.clone()),
            Some(Value::Object(o)) => o.get("details").and_then(Value::as_str).map(str::to_string),
            _ => None,
        };
        match detail {
            Some(d) if !d.is_empty() && !self.message.contains(&d) => {
                format!("{}: {d}", self.message)
            }
            _ => self.message.clone(),
        }
    }
}

/// One line from the agent.
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    /// The answer to one of our requests.
    Response { id: u64, result: Result<Value, RpcError> },
    /// A request from the agent: it waits for our reply to `id`.
    Request { id: Value, method: String, params: Value },
    /// A notification (`session/update`, ...).
    Notification { method: String, params: Value },
}

/// Parse one stdout line. Errors are for lines that are not JSON-RPC at all.
pub fn parse_line(line: &str) -> Result<Incoming, String> {
    let v: Value = serde_json::from_str(line.trim()).map_err(|e| e.to_string())?;
    let obj = v.as_object().ok_or("not a JSON object")?;
    let method = obj.get("method").and_then(Value::as_str);
    let id = obj.get("id").filter(|id| !id.is_null());
    match (method, id) {
        (Some(method), Some(id)) => Ok(Incoming::Request {
            id: id.clone(),
            method: method.to_string(),
            params: obj.get("params").cloned().unwrap_or(Value::Null),
        }),
        (Some(method), None) => Ok(Incoming::Notification {
            method: method.to_string(),
            params: obj.get("params").cloned().unwrap_or(Value::Null),
        }),
        (None, Some(id)) => {
            let id = id.as_u64().ok_or("response id is not a number")?;
            let result = match obj.get("error") {
                Some(err) => Err(RpcError {
                    code: err.get("code").and_then(Value::as_i64).unwrap_or(0),
                    message: err
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown error")
                        .to_string(),
                    data: err.get("data").cloned(),
                }),
                None => Ok(obj.get("result").cloned().unwrap_or(Value::Null)),
            };
            Ok(Incoming::Response { id, result })
        }
        (None, None) => Err("neither a method nor an id".to_string()),
    }
}

/// What `initialize` told us that NexQ acts on.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AgentInit {
    pub name: String,
    pub version: String,
    /// `agentCapabilities._meta.antigravity.systemPrompt.append`: the system
    /// prompt can travel in `session/new`'s `_meta`.
    pub system_prompt_append: bool,
    /// `agentCapabilities.sessionCapabilities.additionalDirectories`.
    pub additional_directories: bool,
    /// Ids of the login methods the agent offers (`oauth-personal`, ...).
    pub auth_methods: Vec<String>,
}

/// Parse the `initialize` result (the `result` object, or the whole response line).
pub fn parse_initialize(v: &Value) -> AgentInit {
    let v = v.get("result").unwrap_or(v);
    let caps = &v["agentCapabilities"];
    AgentInit {
        name: v["agentInfo"]["name"].as_str().unwrap_or_default().to_string(),
        version: v["agentInfo"]["version"].as_str().unwrap_or_default().to_string(),
        system_prompt_append: caps["_meta"]["antigravity"]["systemPrompt"]["append"]
            .as_bool()
            .unwrap_or(false),
        additional_directories: caps["sessionCapabilities"]["additionalDirectories"].is_object(),
        auth_methods: v["authMethods"]
            .as_array()
            .map(|a| a.iter().filter_map(|m| m["id"].as_str().map(str::to_string)).collect())
            .unwrap_or_default(),
    }
}

/// The `session/new` result.
#[derive(Debug, Clone, PartialEq)]
pub struct NewSession {
    pub session_id: String,
    pub models: Vec<(String, String)>,
    pub current_model: Option<String>,
}

/// Parse the `session/new` result (the `result` object, or the whole response line).
pub fn parse_session_new(v: &Value) -> Result<NewSession, String> {
    let v = v.get("result").unwrap_or(v);
    let session_id = v["sessionId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("session/new returned no sessionId")?
        .to_string();
    Ok(NewSession {
        session_id,
        models: models_from_session_new(v),
        current_model: v["models"]["currentModelId"].as_str().map(str::to_string),
    })
}

/// `(model id, display name)` of every model `session/new` offers
/// (`models.availableModels`). Accepts the result object or the whole
/// response line; an entry without a name shows its id.
pub fn models_from_session_new(v: &Value) -> Vec<(String, String)> {
    let v = v.get("result").unwrap_or(v);
    v["models"]["availableModels"]
        .as_array()
        .map(|models| {
            models
                .iter()
                .filter_map(|m| {
                    let id = m["modelId"].as_str().filter(|s| !s.is_empty())?;
                    let name = m["name"].as_str().filter(|s| !s.is_empty()).unwrap_or(id);
                    Some((id.to_string(), name.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// A `tool_call` / `tool_call_update` as far as NexQ needs it.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolCallInfo {
    pub id: String,
    /// The agent's tool name (`read_file`, `mcp_server_tool`, ...). Antigravity
    /// sends `name`; empty when an agent does not.
    pub name: String,
    /// `read`, `search`, `edit`, `execute`, `fetch`, `other`, ... (lowercase).
    pub kind: String,
    /// `pending`, `in_progress`, `completed` or `failed`.
    pub status: Option<String>,
    pub title: String,
    pub raw_input: Value,
    /// `locations[].path`.
    pub locations: Vec<String>,
}

impl ToolCallInfo {
    /// The call ended (well or not).
    pub fn finished(&self) -> bool {
        matches!(self.status.as_deref(), Some("completed" | "failed"))
    }

    pub fn failed(&self) -> bool {
        self.status.as_deref() == Some("failed")
    }
}

/// Parse a tool call object (a `session/update` update, or the `toolCall` of
/// a permission request).
pub fn parse_tool_call(v: &Value) -> ToolCallInfo {
    let id = v["toolCallId"].as_str().unwrap_or_default().to_string();
    let name = v["name"]
        .as_str()
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        .unwrap_or_default();
    let raw_input = if v["rawInput"].is_null() { v["args"].clone() } else { v["rawInput"].clone() };
    ToolCallInfo {
        id,
        name,
        kind: v["kind"].as_str().unwrap_or("other").to_lowercase(),
        status: v["status"].as_str().map(str::to_string),
        title: v["title"].as_str().unwrap_or_default().to_string(),
        raw_input,
        locations: v["locations"]
            .as_array()
            .map(|l| l.iter().filter_map(|x| x["path"].as_str().map(str::to_string)).collect())
            .unwrap_or_default(),
    }
}

/// One `session/update` notification.
#[derive(Debug, Clone, PartialEq)]
pub enum Update {
    MessageChunk(String),
    ThoughtChunk,
    ToolCall(ToolCallInfo),
    ToolCallUpdate(ToolCallInfo),
    /// `usage_update`, `available_commands_update`, `session_info_update`,
    /// `config_option_update`, plans, ...: nothing to do, but it proves the agent is alive.
    Other,
}

/// Parse the `update` object of a `session/update` notification.
pub fn parse_update(update: &Value) -> Update {
    match update["sessionUpdate"].as_str().unwrap_or_default() {
        "agent_message_chunk" => match update["content"]["text"].as_str() {
            Some(text) if update["content"]["type"].as_str().unwrap_or("text") == "text" => {
                Update::MessageChunk(text.to_string())
            }
            _ => Update::Other,
        },
        "agent_thought_chunk" => Update::ThoughtChunk,
        "tool_call" => Update::ToolCall(parse_tool_call(update)),
        "tool_call_update" => Update::ToolCallUpdate(parse_tool_call(update)),
        _ => Update::Other,
    }
}

/// The `update` of a `session/update` notification's params.
pub fn update_of(params: &Value) -> &Value {
    &params["update"]
}

/// How a `session/prompt` ended.
#[derive(Debug, Clone, PartialEq)]
pub struct PromptEnd {
    pub stop_reason: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub thinking_tokens: u64,
}

/// Parse the `session/prompt` result.
pub fn parse_prompt_end(v: &Value) -> PromptEnd {
    let v = v.get("result").unwrap_or(v);
    let usage = &v["usage"];
    let n = |key: &str| usage[key].as_u64().unwrap_or(0);
    PromptEnd {
        stop_reason: v["stopReason"].as_str().unwrap_or("end_turn").to_string(),
        input_tokens: n("inputTokens"),
        output_tokens: n("outputTokens"),
        cache_read_tokens: n("cachedReadTokens"),
        cache_write_tokens: n("cachedWriteTokens"),
        thinking_tokens: n("thoughtTokens"),
    }
}

impl PromptEnd {
    /// The turn's [`TurnResult`] with the streamed `text`. Claude's cost fields stay 0
    /// (a subscription CLI reports tokens only).
    pub fn into_turn_result(self, text: String, duration_ms: u64) -> TurnResult {
        TurnResult {
            text,
            is_error: false,
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
            cache_read_tokens: self.cache_read_tokens,
            cache_write_tokens: self.cache_write_tokens,
            thinking_tokens: self.thinking_tokens,
            duration_ms,
            ..TurnResult::default()
        }
    }
}

// ---- tool activity ----------------------------------------------------

/// The call as the [`ToolUse`] that NexQ's activity lines and chips know:
/// `Read {file_path}`, `Grep {pattern}` and `mcp__<server>__<tool>`
/// (`servers` are the keys of the MCP servers the session was started with;
/// both CLIs name an MCP tool `mcp_<server>_<tool>`). Anything else keeps the
/// agent's own name.
pub fn tool_use_for_activity(info: &ToolCallInfo, servers: &[String]) -> ToolUse {
    if let Some((server, tool)) = split_mcp_tool_name(&info.name, servers) {
        return ToolUse {
            id: info.id.clone(),
            name: format!("mcp__{server}__{tool}"),
            input: Value::Null,
        };
    }
    let first_path = info
        .locations
        .first()
        .cloned()
        .or_else(|| first_string(&info.raw_input, &["file_path", "path", "filepath", "file", "uri"]));
    let (name, input) = match (info.kind.as_str(), first_path) {
        ("read", Some(path)) => ("Read".to_string(), json!({ "file_path": path })),
        ("search", _) => {
            let pattern = first_string(&info.raw_input, &["pattern", "query", "regex", "glob"])
                .unwrap_or_else(|| info.title.clone());
            ("Grep".to_string(), json!({ "pattern": pattern }))
        }
        _ => (
            if info.name.is_empty() { info.title.clone() } else { info.name.clone() },
            Value::Null,
        ),
    };
    ToolUse { id: info.id.clone(), name, input }
}

/// `(server, tool)` of an MCP tool name `mcp_<server>_<tool>` (or
/// `mcp__<server>__<tool>`), where `server` is one of `servers` (the longest
/// match, since keys may contain `_`).
pub fn split_mcp_tool_name(name: &str, servers: &[String]) -> Option<(String, String)> {
    let rest = name.strip_prefix("mcp_")?;
    let rest = rest.strip_prefix('_').unwrap_or(rest);
    servers
        .iter()
        .filter_map(|s| {
            let tail = rest.strip_prefix(s.as_str())?;
            let tool = tail.strip_prefix("__").or_else(|| tail.strip_prefix('_'))?;
            (!tool.is_empty()).then(|| (s.clone(), tool.to_string()))
        })
        .max_by_key(|(s, _)| s.len())
}

fn first_string(v: &Value, keys: &[&str]) -> Option<String> {
    let obj = v.as_object()?;
    keys.iter().find_map(|k| {
        obj.iter()
            .find(|(key, val)| key.eq_ignore_ascii_case(k) && val.is_string())
            .and_then(|(_, val)| val.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    })
}

// ---- errors -----------------------------------------------------------

/// Coarse kind of an ACP error (the JSON-RPC error of a request, or a crash
/// reason). Quota errors ("prepayment credits are depleted", 402/429,
/// `RESOURCE_EXHAUSTED`) are `RateLimited`; auth errors (`-32000` is ACP's
/// `auth_required`, "API key is missing") are `NotLoggedIn`.
pub fn classify_acp_error(code: Option<i64>, text: &str) -> AgentErrorKind {
    let t = text.to_lowercase();
    let quota = matches!(code, Some(402 | 429))
        || t.contains("credits are depleted")
        || t.contains("prepayment")
        || t.contains("resource_exhausted")
        || t.contains("quota")
        || t.contains("payment required")
        || t.contains("rate limit")
        || t.contains("usage limit")
        || t.contains("too many requests");
    if quota {
        return AgentErrorKind::RateLimited;
    }
    let auth = code == Some(-32000)
        || t.contains("api key is missing")
        || t.contains("not configured")
        || t.contains("authentication required")
        || t.contains("authenticate")
        || t.contains("unauthenticated")
        || t.contains("not authenticated")
        || t.contains("sign in")
        || t.contains("login required")
        || t.contains("set an auth method")
        || t.contains("auth method");
    if auth {
        return AgentErrorKind::NotLoggedIn;
    }
    classify_error(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Value {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/llm/cli_agent/acp/testdata")
            .join(name);
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
    }

    fn line(name: &str) -> String {
        fixture(name).to_string()
    }

    #[test]
    fn builders_make_json_rpc_lines() {
        let v: Value = serde_json::from_str(&request(4, "session/prompt", json!({"a": 1}))).unwrap();
        assert_eq!(v["jsonrpc"], "2.0");
        assert_eq!(v["id"], 4);
        assert_eq!(v["method"], "session/prompt");
        let n: Value = serde_json::from_str(&notification("session/cancel", cancel_params("s"))).unwrap();
        assert!(n.get("id").is_none());
        assert_eq!(n["params"]["sessionId"], "s");
        let ok: Value = serde_json::from_str(&response_ok(&json!("abc"), json!({"outcome": {}}))).unwrap();
        assert_eq!(ok["id"], "abc");
        let err: Value = serde_json::from_str(&response_err(&json!(5), METHOD_NOT_FOUND, "no")).unwrap();
        assert_eq!(err["error"]["code"], -32601);
        assert_eq!(err["id"], 5);
    }

    #[test]
    fn initialize_params_disable_client_fs_and_terminal() {
        let p = initialize_params();
        assert_eq!(p["protocolVersion"], 1);
        assert_eq!(p["clientCapabilities"]["fs"]["readTextFile"], false);
        assert_eq!(p["clientCapabilities"]["fs"]["writeTextFile"], false);
        assert_eq!(p["clientCapabilities"]["terminal"], false);
    }

    #[test]
    fn session_new_params_shape() {
        let dirs = vec![PathBuf::from("C:\\Notes")];
        let p = session_new_params(Path::new("C:\\Work"), &[], &dirs, true, Some("Be brief."));
        assert_eq!(p["cwd"], "C:\\Work");
        assert_eq!(p["mcpServers"], json!([]));
        assert_eq!(p["additionalDirectories"], json!(["C:\\Notes"]));
        assert_eq!(p["_meta"]["antigravity"]["systemPrompt"]["append"], "Be brief.");
        // An agent that does not advertise additionalDirectories never gets the field.
        let p = session_new_params(Path::new("C:\\Work"), &[], &dirs, false, None);
        assert!(p.get("additionalDirectories").is_none());
        assert!(p.get("_meta").is_none());
    }

    #[test]
    fn parses_responses_requests_and_notifications() {
        match parse_line(&line("agy_initialize.json")).unwrap() {
            Incoming::Response { id: 1, result: Ok(r) } => assert_eq!(r["protocolVersion"], 1),
            other => panic!("{other:?}"),
        }
        match parse_line(&line("err_not_logged_in.json")).unwrap() {
            Incoming::Response { id: 2, result: Err(e) } => {
                assert_eq!(e.code, -32000);
                assert!(e.message.contains("API key is missing"));
            }
            other => panic!("{other:?}"),
        }
        match parse_line(&line("agy_permission_run_command.json")).unwrap() {
            Incoming::Request { id, method, params } => {
                assert_eq!(id, json!(7));
                assert_eq!(method, "session/request_permission");
                assert_eq!(params["toolCall"]["kind"], "execute");
            }
            other => panic!("{other:?}"),
        }
        match parse_line(&line("agy_update_message_chunk.json")).unwrap() {
            Incoming::Notification { method, .. } => assert_eq!(method, "session/update"),
            other => panic!("{other:?}"),
        }
        assert!(parse_line("not json").is_err());
        assert!(parse_line("[1]").is_err());
        assert!(parse_line(r#"{"jsonrpc":"2.0"}"#).is_err());
        // A string id on a request is kept as is.
        match parse_line(r#"{"jsonrpc":"2.0","id":"x1","method":"fs/read_text_file","params":{}}"#).unwrap() {
            Incoming::Request { id, .. } => assert_eq!(id, json!("x1")),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn initialize_reads_capabilities() {
        let agy = parse_initialize(&fixture("agy_initialize.json"));
        assert_eq!(agy.name, "Antigravity ACP Server");
        assert_eq!(agy.version, "1.5.14");
        assert!(agy.system_prompt_append);
        assert!(agy.additional_directories);
        assert_eq!(agy.auth_methods, vec!["oauth-personal", "gemini-api-key"]);
    }

    #[test]
    fn session_new_lists_models() {
        let agy = parse_session_new(&fixture("agy_session_new.json")).unwrap();
        assert_eq!(agy.session_id, "636be507-896c-4d66-a8ce-0cd6ff38b168");
        assert_eq!(agy.current_model.as_deref(), Some("gemini-4-neon-high"));
        assert_eq!(agy.models.len(), 4);
        assert_eq!(agy.models[2], ("gemini-3.8-flash-low".to_string(), "Gemini 3.8 Flash (Low)".to_string()));

        // Result object or whole response: same list.
        assert_eq!(agy.models, models_from_session_new(&fixture("agy_session_new.json")["result"]));
        assert!(models_from_session_new(&json!({})).is_empty());
        assert!(parse_session_new(&json!({"result": {}})).is_err());
        // A model without a name shows its id.
        let v = json!({"models": {"availableModels": [{"modelId": "m1"}, {"name": "no id"}]}});
        assert_eq!(models_from_session_new(&v), vec![("m1".to_string(), "m1".to_string())]);
    }

    #[test]
    fn updates_parse() {
        let u = |name: &str| parse_update(update_of(&fixture(name)["params"]));
        assert_eq!(
            u("agy_update_message_chunk.json"),
            Update::MessageChunk("According to the note, the launch date is March 3.".into())
        );
        assert_eq!(u("agy_update_thought_chunk.json"), Update::ThoughtChunk);
        let Update::ToolCall(call) = u("agy_update_tool_call_read.json") else { panic!() };
        assert_eq!(call.name, "read_file");
        assert_eq!(call.kind, "read");
        assert_eq!(call.status.as_deref(), Some("in_progress"));
        assert_eq!(call.locations, vec!["C:\\Users\\Vahid\\Notes\\falcon.md"]);
        assert!(!call.finished());
        let Update::ToolCallUpdate(done) = u("agy_update_tool_call_update_failed.json") else { panic!() };
        assert!(done.finished() && done.failed());
        assert_eq!(done.id, call.id);
        assert_eq!(parse_update(&json!({"sessionUpdate": "usage_update", "used": 3})), Update::Other);
        assert_eq!(parse_update(&json!({"sessionUpdate": "available_commands_update"})), Update::Other);
        // Non-text content is not answer text.
        let img = json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "image", "data": "x"}});
        assert_eq!(parse_update(&img), Update::Other);
    }

    #[test]
    fn a_call_without_a_name_has_an_empty_one() {
        let info = parse_tool_call(&json!({
            "toolCallId": "read_file-1763800000000-3", "kind": "read", "title": "ReadFile", "status": "pending"
        }));
        assert_eq!(info.name, "");
        assert_eq!(info.kind, "read");
    }

    #[test]
    fn prompt_end_maps_usage() {
        let end = parse_prompt_end(&fixture("agy_prompt_done.json"));
        assert_eq!(end.stop_reason, "end_turn");
        let r = end.into_turn_result("hi".into(), 1500);
        assert_eq!(r.text, "hi");
        assert!(!r.is_error);
        assert_eq!((r.input_tokens, r.output_tokens), (12518, 409));
        assert_eq!((r.cache_read_tokens, r.cache_write_tokens, r.thinking_tokens), (8006, 0, 292));
        assert_eq!(r.duration_ms, 1500);
        assert_eq!(r.cost_usd, 0.0);
        assert_eq!(r.prompt_tokens(), 12518 + 8006);
    }

    #[test]
    fn activity_names_match_what_the_chips_expect() {
        let servers = vec!["probe-srv".to_string(), "my_notes".to_string(), "my".to_string()];
        let call = |v: &str| {
            let Update::ToolCall(c) = parse_update(update_of(&fixture(v)["params"])) else { panic!() };
            c
        };
        let read = tool_use_for_activity(&call("agy_update_tool_call_read.json"), &servers);
        assert_eq!(read.name, "Read");
        assert_eq!(read.input["file_path"], "C:\\Users\\Vahid\\Notes\\falcon.md");
        let mcp = tool_use_for_activity(&call("agy_update_tool_call_mcp.json"), &servers);
        assert_eq!(mcp.name, "mcp__probe-srv__get_secret_word");

        // Longest server key wins; `__` separated names work too.
        assert_eq!(
            split_mcp_tool_name("mcp_my_notes_search", &servers),
            Some(("my_notes".to_string(), "search".to_string()))
        );
        assert_eq!(
            split_mcp_tool_name("mcp__my__x", &servers),
            Some(("my".to_string(), "x".to_string()))
        );
        assert_eq!(split_mcp_tool_name("mcp_other_x", &servers), None);
        assert_eq!(split_mcp_tool_name("read_file", &servers), None);
        assert_eq!(split_mcp_tool_name("mcp_my_", &servers), None);

        // Search: pattern from the input, else the title. Unknown tools keep their name.
        let search = parse_tool_call(&json!({"toolCallId": "g-1", "name": "grep_search", "kind": "search", "title": "Grep falcon", "rawInput": {"pattern": "falcon"}}));
        let t = tool_use_for_activity(&search, &[]);
        assert_eq!((t.name.as_str(), t.input["pattern"].as_str()), ("Grep", Some("falcon")));
        let other = parse_tool_call(&json!({"toolCallId": "x-1", "name": "run_command", "kind": "execute", "title": "Run it"}));
        assert_eq!(tool_use_for_activity(&other, &[]).name, "run_command");
    }

    #[test]
    fn errors_are_classified() {
        let err = |name: &str| match parse_line(&line(name)).unwrap() {
            Incoming::Response { result: Err(e), .. } => e,
            other => panic!("{other:?}"),
        };
        let e = err("err_not_logged_in.json");
        assert_eq!(classify_acp_error(Some(e.code), &e.text()), AgentErrorKind::NotLoggedIn);
        let e = err("err_credits_depleted.json");
        assert_eq!(classify_acp_error(Some(e.code), &e.text()), AgentErrorKind::RateLimited);
        assert_eq!(classify_acp_error(None, "Your prepayment credits are depleted"), AgentErrorKind::RateLimited);
        assert_eq!(classify_acp_error(None, "429 RESOURCE_EXHAUSTED"), AgentErrorKind::RateLimited);
        assert_eq!(classify_acp_error(None, "Please log in first"), AgentErrorKind::NotLoggedIn);
        assert_eq!(classify_acp_error(None, "agy exited unexpectedly (exit code 1)"), AgentErrorKind::Crashed);
        assert_eq!(classify_acp_error(None, "something odd"), AgentErrorKind::Other);
    }

    #[test]
    fn rpc_error_text_includes_details() {
        let e = RpcError { code: -32603, message: "Internal error".into(), data: Some(json!({"details": "Directory does not exist"})) };
        assert_eq!(e.text(), "Internal error: Directory does not exist");
        let e = RpcError { code: 1, message: "plain".into(), data: None };
        assert_eq!(e.text(), "plain");
    }
}
