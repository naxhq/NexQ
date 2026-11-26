//! `codex app-server` JSON-RPC messages: pure builders and parsers.
//!
//! The wire format is JSON-RPC 2.0 *without* the `"jsonrpc"` member, one JSON
//! object per line. Method names and shapes come from the schema the binary
//! generates itself (`codex app-server generate-json-schema --out DIR`, Codex
//! CLI 0.171.0). Fixtures in `testdata/` named `real_*` were captured from a
//! live app-server; `schema_*` ones are built from that schema for messages a
//! logged-in but quota-exhausted account cannot provoke (successful turns,
//! approval requests). Parsers read `serde_json::Value`s and ignore unknown
//! fields, so a newer Codex that adds fields keeps working.

use serde_json::{json, Map, Value};

/// `clientInfo.name`; Codex reports it as the thread's `originator`.
pub const CLIENT_NAME: &str = "nexq";

/// Approval policy of every NexQ thread. `untrusted` asks for anything but
/// Codex's own list of side-effect-free commands, and every ask is answered by
/// the policy in `policy.rs`.
pub const APPROVAL_POLICY: &str = "untrusted";

/// Sandbox of every NexQ thread (`SandboxMode`).
pub const SANDBOX_MODE: &str = "read-only";

// ---------------------------------------------------------------------------
// Requests and notifications NexQ sends
// ---------------------------------------------------------------------------

fn request(id: u64, method: &str, params: Value) -> String {
    json!({ "id": id, "method": method, "params": params }).to_string()
}

pub fn initialize_request(id: u64, client_version: &str) -> String {
    request(
        id,
        "initialize",
        json!({
            "clientInfo": { "name": CLIENT_NAME, "title": "NexQ", "version": client_version },
            "capabilities": { "experimentalApi": false },
        }),
    )
}

/// The `initialized` notification that ends the handshake.
pub fn initialized_notification() -> String {
    json!({ "method": "initialized" }).to_string()
}

pub fn account_read_request(id: u64) -> String {
    request(id, "account/read", json!({ "refreshToken": false }))
}

pub fn model_list_request(id: u64) -> String {
    request(id, "model/list", json!({}))
}

/// What `thread/start` is asked for.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ThreadStart {
    pub cwd: String,
    /// Empty: the account's default model.
    pub model: String,
    /// Replaces Codex's own coding-agent system prompt. Empty: keep Codex's.
    pub base_instructions: String,
    /// Extra developer message (the notes folders the model may read).
    pub developer_instructions: String,
    /// Per-thread config overrides (`thread/start`'s `config`): NexQ's own MCP
    /// servers, secrets included. Sent over the pipe, so it never shows on the
    /// process's command line. `None`: nothing to add.
    pub config: Option<Value>,
}

pub fn thread_start_request(id: u64, t: &ThreadStart) -> String {
    let mut p = Map::new();
    p.insert("cwd".into(), json!(t.cwd));
    if !t.model.is_empty() {
        p.insert("model".into(), json!(t.model));
    }
    p.insert("approvalPolicy".into(), json!(APPROVAL_POLICY));
    p.insert("sandbox".into(), json!(SANDBOX_MODE));
    // Nothing of a meeting is kept in the user's Codex history.
    p.insert("ephemeral".into(), json!(true));
    p.insert("serviceName".into(), json!(CLIENT_NAME));
    if !t.base_instructions.is_empty() {
        p.insert("baseInstructions".into(), json!(t.base_instructions));
    }
    if !t.developer_instructions.is_empty() {
        p.insert("developerInstructions".into(), json!(t.developer_instructions));
    }
    if let Some(config) = &t.config {
        p.insert("config".into(), config.clone());
    }
    request(id, "thread/start", Value::Object(p))
}

pub fn turn_start_request(
    id: u64,
    thread_id: &str,
    text: &str,
    model: Option<&str>,
    effort: Option<&str>,
) -> String {
    let mut p = Map::new();
    p.insert("threadId".into(), json!(thread_id));
    p.insert("input".into(), json!([{ "type": "text", "text": text, "text_elements": [] }]));
    if let Some(m) = model.filter(|m| !m.is_empty()) {
        p.insert("model".into(), json!(m));
    }
    if let Some(e) = effort.filter(|e| !e.is_empty()) {
        p.insert("effort".into(), json!(e));
    }
    request(id, "turn/start", Value::Object(p))
}

pub fn turn_interrupt_request(id: u64, thread_id: &str, turn_id: &str) -> String {
    request(id, "turn/interrupt", json!({ "threadId": thread_id, "turnId": turn_id }))
}

// ---------------------------------------------------------------------------
// What the server sends
// ---------------------------------------------------------------------------

/// A JSON-RPC error object.
#[derive(Debug, Clone, PartialEq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
}

/// One stdout line.
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    Response { id: u64, result: Result<Value, RpcError> },
    Notification(Notification),
    /// A request the server makes of us (approvals, input); `id` is echoed back.
    Request { id: Value, request: ServerRequest },
}

/// Parse one line of the server's stdout. `None` for anything that is not a
/// JSON-RPC message (log noise).
pub fn parse_line(line: &str) -> Option<Incoming> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    let obj = v.as_object()?;
    let method = obj.get("method").and_then(Value::as_str);
    let id = obj.get("id").cloned();
    match (method, id) {
        (Some(method), Some(id)) => {
            let params = obj.get("params").cloned().unwrap_or(Value::Null);
            Some(Incoming::Request { id, request: parse_server_request(method, &params) })
        }
        (Some(method), None) => {
            let params = obj.get("params").cloned().unwrap_or(Value::Null);
            Some(Incoming::Notification(parse_notification(method, &params)))
        }
        (None, Some(id)) => {
            let id = id.as_u64()?;
            if let Some(err) = obj.get("error") {
                Some(Incoming::Response {
                    id,
                    result: Err(RpcError {
                        code: err.get("code").and_then(Value::as_i64).unwrap_or(0),
                        message: err
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown error")
                            .to_string(),
                    }),
                })
            } else {
                Some(Incoming::Response {
                    id,
                    result: Ok(obj.get("result").cloned().unwrap_or(Value::Null)),
                })
            }
        }
        (None, None) => None,
    }
}

/// Counts of one `ThreadTokenUsage` breakdown (`total` is cumulative for the
/// thread, `last` is the last model request).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Usage {
    pub input: u64,
    pub cached_input: u64,
    pub cache_write: u64,
    pub output: u64,
    pub reasoning: u64,
}

impl Usage {
    fn parse(v: &Value) -> Usage {
        let n = |k: &str| v.get(k).and_then(Value::as_u64).unwrap_or(0);
        Usage {
            input: n("inputTokens"),
            cached_input: n("cachedInputTokens"),
            cache_write: n("cacheWriteInputTokens"),
            output: n("outputTokens"),
            reasoning: n("reasoningOutputTokens"),
        }
    }

    /// `self - earlier`, never negative.
    pub fn since(&self, earlier: &Usage) -> Usage {
        Usage {
            input: self.input.saturating_sub(earlier.input),
            cached_input: self.cached_input.saturating_sub(earlier.cached_input),
            cache_write: self.cache_write.saturating_sub(earlier.cache_write),
            output: self.output.saturating_sub(earlier.output),
            reasoning: self.reasoning.saturating_sub(earlier.reasoning),
        }
    }
}

/// `turn.status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnStatus {
    Completed,
    Interrupted,
    Failed,
    InProgress,
}

/// A failed turn: the message plus Codex's own machine-readable cause
/// (`codexErrorInfo`, e.g. `usageLimitExceeded`).
#[derive(Debug, Clone, PartialEq)]
pub struct TurnError {
    pub message: String,
    /// The variant name for a string cause, the single key for an object cause
    /// (`httpConnectionFailed`).
    pub info: Option<String>,
}

fn parse_turn_error(v: &Value) -> Option<TurnError> {
    if v.is_null() {
        return None;
    }
    let message = v.get("message").and_then(Value::as_str).unwrap_or("").to_string();
    let info = match v.get("codexErrorInfo") {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Object(o)) => o.keys().next().cloned(),
        _ => None,
    };
    Some(TurnError { message, info })
}

/// A `commandActions` entry: Codex's own reading of what a shell command does.
#[derive(Debug, Clone, PartialEq)]
pub enum CommandAction {
    Read { path: String },
    ListFiles { path: Option<String> },
    Search { query: Option<String>, path: Option<String> },
    Unknown,
}

fn parse_command_actions(v: Option<&Value>) -> Vec<CommandAction> {
    let Some(items) = v.and_then(Value::as_array) else { return Vec::new() };
    items
        .iter()
        .map(|a| {
            let s = |k: &str| a.get(k).and_then(Value::as_str).map(str::to_string);
            match a.get("type").and_then(Value::as_str) {
                Some("read") => match s("path") {
                    Some(path) => CommandAction::Read { path },
                    None => CommandAction::Unknown,
                },
                Some("listFiles") | Some("list_files") => CommandAction::ListFiles { path: s("path") },
                Some("search") => CommandAction::Search { query: s("query"), path: s("path") },
                _ => CommandAction::Unknown,
            }
        })
        .collect()
}

/// A thread item (`item/started`, `item/completed`).
#[derive(Debug, Clone, PartialEq)]
pub enum Item {
    AgentMessage { id: String, text: String, phase: Option<String> },
    Reasoning { id: String },
    McpToolCall {
        id: String,
        server: String,
        tool: String,
        arguments: Value,
        /// `inProgress`, `completed` or `failed`.
        status: String,
        error: Option<String>,
    },
    CommandExecution {
        id: String,
        command: String,
        actions: Vec<CommandAction>,
        /// `inProgress`, `completed`, `failed` or `declined`.
        status: String,
    },
    FileChange { id: String },
    Other { kind: String },
}

fn parse_item(v: &Value) -> Item {
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    match v.get("type").and_then(Value::as_str).unwrap_or("") {
        "agentMessage" => Item::AgentMessage {
            id: s("id"),
            text: s("text"),
            phase: v.get("phase").and_then(Value::as_str).map(str::to_string),
        },
        "reasoning" => Item::Reasoning { id: s("id") },
        "mcpToolCall" => Item::McpToolCall {
            id: s("id"),
            server: s("server"),
            tool: s("tool"),
            arguments: v.get("arguments").cloned().unwrap_or(Value::Null),
            status: s("status"),
            error: v
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .map(str::to_string),
        },
        "commandExecution" => Item::CommandExecution {
            id: s("id"),
            command: s("command"),
            actions: parse_command_actions(v.get("commandActions")),
            status: s("status"),
        },
        "fileChange" => Item::FileChange { id: s("id") },
        other => Item::Other { kind: other.to_string() },
    }
}

/// A server notification NexQ cares about; everything else is `Other` (it
/// still counts as a sign of life).
#[derive(Debug, Clone, PartialEq)]
pub enum Notification {
    TurnStarted { turn_id: String },
    TurnCompleted {
        turn_id: String,
        status: TurnStatus,
        error: Option<TurnError>,
        duration_ms: u64,
    },
    AgentMessageDelta { turn_id: String, item_id: String, delta: String },
    /// A reasoning (thinking) text or summary delta.
    ReasoningDelta { turn_id: String },
    ItemStarted { turn_id: String, item: Item },
    ItemCompleted { turn_id: String, item: Item },
    TokenUsage { turn_id: String, total: Usage, last: Usage },
    /// An error mid-turn. `will_retry`: Codex tries again by itself.
    Error { turn_id: String, error: TurnError, will_retry: bool },
    /// `mcpServer/startupStatus/updated`: `starting`, `ready`, `failed`.
    McpStartup { name: String, status: String, error: Option<String> },
    /// `account/rateLimits/updated`: only a window past 90% used, or one that
    /// says the limit was reached.
    PlanLimit(crate::llm::cli_agent::protocol::PlanLimit),
    Other(String),
}

fn parse_notification(method: &str, p: &Value) -> Notification {
    let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    match method {
        "turn/started" => Notification::TurnStarted { turn_id: s(&p["turn"], "id") },
        "turn/completed" => {
            let turn = &p["turn"];
            let status = match turn.get("status").and_then(Value::as_str) {
                Some("completed") => TurnStatus::Completed,
                Some("interrupted") => TurnStatus::Interrupted,
                Some("failed") => TurnStatus::Failed,
                _ => TurnStatus::InProgress,
            };
            Notification::TurnCompleted {
                turn_id: s(turn, "id"),
                status,
                error: turn.get("error").and_then(parse_turn_error),
                duration_ms: turn.get("durationMs").and_then(Value::as_u64).unwrap_or(0),
            }
        }
        "item/agentMessage/delta" => Notification::AgentMessageDelta {
            turn_id: s(p, "turnId"),
            item_id: s(p, "itemId"),
            delta: s(p, "delta"),
        },
        "item/reasoning/textDelta" | "item/reasoning/summaryTextDelta" => {
            Notification::ReasoningDelta { turn_id: s(p, "turnId") }
        }
        "item/started" => Notification::ItemStarted { turn_id: s(p, "turnId"), item: parse_item(&p["item"]) },
        "item/completed" => {
            Notification::ItemCompleted { turn_id: s(p, "turnId"), item: parse_item(&p["item"]) }
        }
        "thread/tokenUsage/updated" => Notification::TokenUsage {
            turn_id: s(p, "turnId"),
            total: Usage::parse(&p["tokenUsage"]["total"]),
            last: Usage::parse(&p["tokenUsage"]["last"]),
        },
        "error" => Notification::Error {
            turn_id: s(p, "turnId"),
            error: parse_turn_error(&p["error"]).unwrap_or(TurnError {
                message: String::new(),
                info: None,
            }),
            will_retry: p.get("willRetry").and_then(Value::as_bool).unwrap_or(false),
        },
        "mcpServer/startupStatus/updated" => Notification::McpStartup {
            name: s(p, "name"),
            status: s(p, "status"),
            error: p.get("error").and_then(Value::as_str).map(str::to_string),
        },
        "account/rateLimits/updated" => parse_plan_limit(&p["rateLimits"])
            .map(Notification::PlanLimit)
            .unwrap_or_else(|| Notification::Other(method.to_string())),
        other => Notification::Other(other.to_string()),
    }
}

/// Used share at or past which a window counts as "near".
const NEAR_PERCENT: u64 = 90;

/// A plan limit from a `RateLimitSnapshot` (`primary`/`secondary` windows with
/// `usedPercent`, `resetsAt`; `rateLimitReachedType` set once the limit is hit).
fn parse_plan_limit(snapshot: &Value) -> Option<crate::llm::cli_agent::protocol::PlanLimit> {
    use crate::llm::cli_agent::protocol::{PlanLimit, PlanLimitLevel};
    let reached = snapshot.get("rateLimitReachedType").is_some_and(|v| !v.is_null());
    let worst = ["primary", "secondary"]
        .iter()
        .filter_map(|k| snapshot.get(*k).filter(|w| !w.is_null()))
        .max_by_key(|w| w["usedPercent"].as_u64().unwrap_or(0))?;
    let used = worst["usedPercent"].as_u64().unwrap_or(0);
    let level = if reached || used >= 100 {
        PlanLimitLevel::Hit
    } else if used >= NEAR_PERCENT {
        PlanLimitLevel::Near
    } else {
        return None;
    };
    Some(PlanLimit {
        level,
        resets_at: worst["resetsAt"].as_u64(),
        window: worst["windowDurationMins"].as_u64().map(|m| format!("{m}m")),
        used: Some(used as f64),
    })
}

/// A request from the server that the client must answer.
#[derive(Debug, Clone, PartialEq)]
pub enum ServerRequest {
    /// `item/commandExecution/requestApproval`, and the legacy
    /// `execCommandApproval` (which has no `commandActions`: `parsedCmd`
    /// carries the same information, parsed here into `actions`).
    CommandApproval {
        legacy: bool,
        command: String,
        cwd: Option<String>,
        actions: Vec<CommandAction>,
    },
    /// `item/fileChange/requestApproval` and the legacy `applyPatchApproval`.
    FileChangeApproval { legacy: bool },
    /// `item/permissions/requestApproval`: more sandbox permissions.
    PermissionsApproval,
    /// `mcpServer/elicitation/request`: Codex asks before an MCP tool call
    /// (`_meta.codex_approval_kind == "mcp_tool_call"`) or the server asks the
    /// user for a form.
    McpElicitation { server: String, message: String, meta: Value },
    /// `item/tool/requestUserInput`.
    UserInput,
    /// `item/tool/call` (a client-implemented tool; NexQ has none).
    DynamicToolCall,
    /// `account/chatgptAuthTokens/refresh`: NexQ never supplies tokens.
    AuthTokensRefresh,
    Unknown { method: String },
}

fn parse_server_request(method: &str, p: &Value) -> ServerRequest {
    let s = |k: &str| p.get(k).and_then(Value::as_str).map(str::to_string);
    match method {
        "item/commandExecution/requestApproval" => ServerRequest::CommandApproval {
            legacy: false,
            command: s("command").unwrap_or_default(),
            cwd: s("cwd"),
            actions: parse_command_actions(p.get("commandActions")),
        },
        "execCommandApproval" => ServerRequest::CommandApproval {
            legacy: true,
            // `command` is an argv array here.
            command: p
                .get("command")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" "))
                .unwrap_or_default(),
            cwd: s("cwd"),
            actions: parse_command_actions(p.get("parsedCmd")),
        },
        "item/fileChange/requestApproval" => ServerRequest::FileChangeApproval { legacy: false },
        "applyPatchApproval" => ServerRequest::FileChangeApproval { legacy: true },
        "item/permissions/requestApproval" => ServerRequest::PermissionsApproval,
        "mcpServer/elicitation/request" => ServerRequest::McpElicitation {
            server: s("serverName").unwrap_or_default(),
            message: s("message").unwrap_or_default(),
            meta: p.get("_meta").cloned().unwrap_or(Value::Null),
        },
        "item/tool/requestUserInput" => ServerRequest::UserInput,
        "item/tool/call" => ServerRequest::DynamicToolCall,
        "account/chatgptAuthTokens/refresh" => ServerRequest::AuthTokensRefresh,
        other => ServerRequest::Unknown { method: other.to_string() },
    }
}

/// What NexQ answers a [`ServerRequest`] with.
#[derive(Debug, Clone, PartialEq)]
pub enum Reply {
    Result(Value),
    Error { code: i64, message: String },
}

/// The reply that allows (`allow == true`) or refuses `req`. Only requests that
/// have an allow form can be allowed; the others are always refused.
pub fn reply_for(req: &ServerRequest, allow: bool) -> Reply {
    match req {
        ServerRequest::CommandApproval { legacy: false, .. } => {
            Reply::Result(json!({ "decision": if allow { "accept" } else { "decline" } }))
        }
        ServerRequest::CommandApproval { legacy: true, .. } | ServerRequest::FileChangeApproval { legacy: true } => {
            Reply::Result(json!({ "decision": if allow { "approved" } else { "denied" } }))
        }
        ServerRequest::FileChangeApproval { legacy: false } => {
            Reply::Result(json!({ "decision": if allow { "accept" } else { "decline" } }))
        }
        // An empty grant: no extra permissions.
        ServerRequest::PermissionsApproval => Reply::Result(json!({ "permissions": {}, "scope": "turn" })),
        ServerRequest::McpElicitation { .. } => {
            Reply::Result(json!({ "action": if allow { "accept" } else { "decline" } }))
        }
        // No answers: the model carries on without.
        ServerRequest::UserInput => Reply::Result(json!({ "answers": {} })),
        ServerRequest::DynamicToolCall => Reply::Result(json!({ "contentItems": [], "success": false })),
        ServerRequest::AuthTokensRefresh | ServerRequest::Unknown { .. } => Reply::Error {
            code: -32601,
            message: "not supported by this client".to_string(),
        },
    }
}

/// The JSON line that answers the server request `id`.
pub fn reply_line(id: &Value, reply: &Reply) -> String {
    match reply {
        Reply::Result(result) => json!({ "id": id, "result": result }).to_string(),
        Reply::Error { code, message } => {
            json!({ "id": id, "error": { "code": code, "message": message } }).to_string()
        }
    }
}

// ---------------------------------------------------------------------------
// Responses NexQ reads
// ---------------------------------------------------------------------------

/// `account/read` result: how Codex is signed in.
#[derive(Debug, Clone, PartialEq)]
pub enum Account {
    ChatGpt { email: Option<String>, plan: Option<String> },
    ApiKey,
    /// Bedrock, GCP and anything newer: not a ChatGPT subscription.
    Other(String),
    LoggedOut,
}

pub fn parse_account(result: &Value) -> Account {
    let Some(acc) = result.get("account").filter(|a| !a.is_null()) else {
        return Account::LoggedOut;
    };
    match acc.get("type").and_then(Value::as_str) {
        Some("chatgpt") => Account::ChatGpt {
            email: acc.get("email").and_then(Value::as_str).map(str::to_string),
            plan: acc.get("planType").and_then(Value::as_str).map(str::to_string),
        },
        Some("apiKey") => Account::ApiKey,
        Some(other) => Account::Other(other.to_string()),
        None => Account::LoggedOut,
    }
}

/// `thread/start` result: the thread id and the model it will use.
pub fn parse_thread_start(result: &Value) -> Option<(String, String)> {
    let id = result.get("thread")?.get("id")?.as_str()?.to_string();
    let model = result.get("model").and_then(Value::as_str).unwrap_or("").to_string();
    Some((id, model))
}

/// `turn/start` result: the new turn's id.
pub fn parse_turn_start(result: &Value) -> Option<String> {
    Some(result.get("turn")?.get("id")?.as_str()?.to_string())
}

/// Codex's own cause of a failed turn mapped to NexQ's error kind; falls back
/// to the message text. `None` info and an unrecognised message is `Other`.
pub fn classify_turn_error(err: &TurnError) -> crate::llm::cli_agent::protocol::AgentErrorKind {
    use crate::llm::cli_agent::protocol::{classify_error, AgentErrorKind};
    match err.info.as_deref() {
        Some("usageLimitExceeded") | Some("rateLimitExceeded") | Some("sessionBudgetExceeded") => {
            AgentErrorKind::RateLimited
        }
        Some("contextWindowExceeded") => AgentErrorKind::ContextOverflow,
        Some("unauthorized") => AgentErrorKind::NotLoggedIn,
        _ => classify_error(&err.message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::cli_agent::protocol::AgentErrorKind;

    const INITIALIZE: &str = include_str!("testdata/real_initialize_response.json");
    const THREAD_START: &str = include_str!("testdata/real_thread_start_response.json");
    const TURN_START: &str = include_str!("testdata/real_turn_start_response.json");
    const ERROR_USAGE: &str = include_str!("testdata/real_error_usage_limit.json");
    const TURN_FAILED: &str = include_str!("testdata/real_turn_completed_usage_limit.json");
    const ACCOUNT: &str = include_str!("testdata/real_account_read_chatgpt.json");
    const MCP_STARTUP: &str = include_str!("testdata/real_mcp_startup_failed.json");

    fn one_line(s: &str) -> String {
        serde_json::from_str::<Value>(s).unwrap().to_string()
    }

    fn notification(s: &str) -> Notification {
        match parse_line(&one_line(s)).expect("a message") {
            Incoming::Notification(n) => n,
            other => panic!("not a notification: {other:?}"),
        }
    }

    fn request_of(s: &str) -> ServerRequest {
        match parse_line(&one_line(s)).expect("a message") {
            Incoming::Request { request, .. } => request,
            other => panic!("not a request: {other:?}"),
        }
    }

    #[test]
    fn requests_are_json_rpc_without_the_version_member() {
        let v: Value = serde_json::from_str(&initialize_request(1, "2.43.0")).unwrap();
        assert_eq!(v["id"], 1);
        assert_eq!(v["method"], "initialize");
        assert_eq!(v["params"]["clientInfo"]["name"], "nexq");
        assert!(v.get("jsonrpc").is_none());
        let n: Value = serde_json::from_str(&initialized_notification()).unwrap();
        assert_eq!(n, json!({ "method": "initialized" }));
    }

    #[test]
    fn thread_start_is_read_only_ephemeral_and_asks_before_commands() {
        let t = ThreadStart {
            cwd: "C:\\sandbox".into(),
            model: "gpt-6.2-sol".into(),
            base_instructions: "Be brief.".into(),
            developer_instructions: "Notes: D:\\notes".into(),
            config: Some(json!({ "mcp_servers": { "mira": { "command": "x" } } })),
        };
        let v: Value = serde_json::from_str(&thread_start_request(7, &t)).unwrap();
        assert_eq!(v["method"], "thread/start");
        let p = &v["params"];
        assert_eq!(p["sandbox"], "read-only");
        assert_eq!(p["approvalPolicy"], "untrusted");
        assert_eq!(p["ephemeral"], true);
        assert_eq!(p["model"], "gpt-6.2-sol");
        assert_eq!(p["baseInstructions"], "Be brief.");
        assert_eq!(p["config"]["mcp_servers"]["mira"]["command"], "x");
        assert_eq!(p["developerInstructions"], "Notes: D:\\notes");
        // No prompt, no model: the fields are left out, not sent empty.
        let bare = ThreadStart { cwd: "C:\\sandbox".into(), ..Default::default() };
        let v: Value = serde_json::from_str(&thread_start_request(8, &bare)).unwrap();
        for key in ["model", "baseInstructions", "developerInstructions", "config"] {
            assert!(v["params"].get(key).is_none(), "{key}");
        }
    }

    #[test]
    fn turn_start_carries_text_and_optional_effort() {
        let v: Value = serde_json::from_str(&turn_start_request(3, "th", "hi", None, Some("low"))).unwrap();
        assert_eq!(v["params"]["threadId"], "th");
        assert_eq!(v["params"]["input"][0], json!({ "type": "text", "text": "hi", "text_elements": [] }));
        assert_eq!(v["params"]["effort"], "low");
        assert!(v["params"].get("model").is_none());
        let v: Value = serde_json::from_str(&turn_start_request(4, "th", "hi", Some("m"), None)).unwrap();
        assert_eq!(v["params"]["model"], "m");
        assert!(v["params"].get("effort").is_none());
    }

    #[test]
    fn interrupt_names_thread_and_turn() {
        let v: Value = serde_json::from_str(&turn_interrupt_request(5, "th", "tu")).unwrap();
        assert_eq!(v["method"], "turn/interrupt");
        assert_eq!(v["params"], json!({ "threadId": "th", "turnId": "tu" }));
    }

    #[test]
    fn parses_the_real_initialize_response() {
        let Incoming::Response { id, result } = parse_line(&one_line(INITIALIZE)).unwrap() else {
            panic!("not a response");
        };
        assert_eq!(id, 1);
        assert!(result.unwrap()["userAgent"].as_str().unwrap().starts_with("nexq/"));
    }

    #[test]
    fn parses_the_real_thread_start_response() {
        let Incoming::Response { result, .. } = parse_line(&one_line(THREAD_START)).unwrap() else {
            panic!("not a response");
        };
        let (thread_id, model) = parse_thread_start(&result.unwrap()).unwrap();
        assert!(!thread_id.is_empty());
        assert_eq!(model, "gpt-6.2-sol");
    }

    #[test]
    fn parses_the_real_turn_start_response() {
        let Incoming::Response { result, .. } = parse_line(&one_line(TURN_START)).unwrap() else {
            panic!("not a response");
        };
        assert!(parse_turn_start(&result.unwrap()).is_some());
    }

    #[test]
    fn a_json_rpc_error_response_keeps_code_and_message() {
        let line = r#"{"id":9,"error":{"code":-32603,"message":"exec failed"}}"#;
        assert_eq!(
            parse_line(line),
            Some(Incoming::Response {
                id: 9,
                result: Err(RpcError { code: -32603, message: "exec failed".into() })
            })
        );
    }

    #[test]
    fn the_real_usage_limit_error_is_a_rate_limit_with_the_reset_time() {
        let Notification::Error { error, will_retry, turn_id } = notification(ERROR_USAGE) else {
            panic!("not an error");
        };
        assert!(!will_retry);
        assert!(!turn_id.is_empty());
        assert_eq!(error.info.as_deref(), Some("usageLimitExceeded"));
        assert!(error.message.contains("Nov 26th, 2026 9:15 AM"), "{}", error.message);
        assert_eq!(classify_turn_error(&error), AgentErrorKind::RateLimited);
    }

    #[test]
    fn the_real_failed_turn_carries_the_same_error() {
        let Notification::TurnCompleted { status, error, .. } = notification(TURN_FAILED) else {
            panic!("not a turn/completed");
        };
        assert_eq!(status, TurnStatus::Failed);
        let error = error.expect("an error");
        assert_eq!(classify_turn_error(&error), AgentErrorKind::RateLimited);
        assert!(error.message.contains("usage limit"));
    }

    #[test]
    fn error_causes_map_to_kinds() {
        let e = |info: Option<&str>, message: &str| TurnError {
            message: message.into(),
            info: info.map(str::to_string),
        };
        assert_eq!(classify_turn_error(&e(Some("contextWindowExceeded"), "x")), AgentErrorKind::ContextOverflow);
        assert_eq!(classify_turn_error(&e(Some("unauthorized"), "x")), AgentErrorKind::NotLoggedIn);
        assert_eq!(classify_turn_error(&e(Some("rateLimitExceeded"), "x")), AgentErrorKind::RateLimited);
        assert_eq!(classify_turn_error(&e(Some("internalServerError"), "boom")), AgentErrorKind::Other);
        // No cause: the text decides.
        assert_eq!(classify_turn_error(&e(None, "You've hit your usage limit.")), AgentErrorKind::RateLimited);
        assert_eq!(classify_turn_error(&e(None, "Not logged in. Run codex login")), AgentErrorKind::NotLoggedIn);
    }

    #[test]
    fn parses_the_real_account_read() {
        let Incoming::Response { result, .. } = parse_line(&one_line(ACCOUNT)).unwrap() else {
            panic!("not a response");
        };
        assert_eq!(
            parse_account(&result.unwrap()),
            Account::ChatGpt { email: Some("user@example.com".into()), plan: Some("pro".into()) }
        );
        assert_eq!(parse_account(&json!({ "account": null, "requiresOpenaiAuth": true })), Account::LoggedOut);
        assert_eq!(parse_account(&json!({ "account": { "type": "apiKey" } })), Account::ApiKey);
        assert_eq!(parse_account(&json!({ "account": { "type": "gcp" } })), Account::Other("gcp".into()));
    }

    #[test]
    fn parses_the_real_mcp_startup_status() {
        let Notification::McpStartup { name, status, error } = notification(MCP_STARTUP) else {
            panic!("not a startup status");
        };
        assert_eq!(name, "pencil");
        assert_eq!(status, "failed");
        assert!(error.is_some());
    }

    #[test]
    fn unknown_notifications_are_kept_as_signs_of_life() {
        let line = r#"{"method":"account/updated","params":{"authMode":"chatgpt"}}"#;
        assert_eq!(
            parse_line(line),
            Some(Incoming::Notification(Notification::Other("account/updated".into())))
        );
        assert_eq!(parse_line("not json"), None);
        assert_eq!(parse_line("{}"), None);
    }

    #[test]
    fn agent_message_and_reasoning_deltas() {
        let n = notification(include_str!("testdata/schema_agent_message_delta.json"));
        assert_eq!(
            n,
            Notification::AgentMessageDelta { turn_id: "tu1".into(), item_id: "it1".into(), delta: "Hello".into() }
        );
        assert_eq!(
            notification(include_str!("testdata/schema_reasoning_summary_delta.json")),
            Notification::ReasoningDelta { turn_id: "tu1".into() }
        );
        assert_eq!(
            notification(include_str!("testdata/schema_reasoning_text_delta.json")),
            Notification::ReasoningDelta { turn_id: "tu1".into() }
        );
    }

    #[test]
    fn token_usage_gives_total_and_last() {
        let Notification::TokenUsage { turn_id, total, last } =
            notification(include_str!("testdata/schema_token_usage_updated.json"))
        else {
            panic!("not token usage");
        };
        assert_eq!(turn_id, "tu1");
        assert_eq!(total, Usage { input: 1200, cached_input: 1000, cache_write: 0, output: 80, reasoning: 30 });
        assert_eq!(last.input, 700);
        let earlier = Usage { input: 500, cached_input: 400, cache_write: 0, output: 20, reasoning: 5 };
        assert_eq!(total.since(&earlier).output, 60);
        // Never negative.
        assert_eq!(earlier.since(&total).input, 0);
    }

    #[test]
    fn an_mcp_tool_call_item_names_server_tool_and_outcome() {
        let Notification::ItemStarted { item, .. } = notification(include_str!("testdata/schema_item_started_mcp.json"))
        else {
            panic!("not item/started");
        };
        let Item::McpToolCall { server, tool, arguments, status, .. } = item else { panic!("not an mcp call") };
        assert_eq!((server.as_str(), tool.as_str(), status.as_str()), ("mira", "kb_search", "inProgress"));
        assert_eq!(arguments["query"], "budget");
        let Notification::ItemCompleted { item: Item::McpToolCall { status, error, .. }, .. } =
            notification(include_str!("testdata/schema_item_completed_mcp_failed.json"))
        else {
            panic!("not a completed mcp call");
        };
        assert_eq!(status, "failed");
        assert_eq!(error.as_deref(), Some("server crashed"));
    }

    #[test]
    fn a_command_item_keeps_codexs_reading_of_the_command() {
        let Notification::ItemStarted { item: Item::CommandExecution { command, actions, status, .. }, .. } =
            notification(include_str!("testdata/schema_item_started_command.json"))
        else {
            panic!("not a command item");
        };
        assert_eq!(status, "inProgress");
        assert!(command.contains("Get-Content"));
        assert_eq!(actions, vec![CommandAction::Read { path: "D:\\notes\\a.md".into() }]);
    }

    #[test]
    fn the_agent_message_item_has_a_phase() {
        let Notification::ItemStarted { item: Item::AgentMessage { phase, .. }, .. } =
            notification(include_str!("testdata/schema_item_started_commentary.json"))
        else {
            panic!("not an agent message");
        };
        assert_eq!(phase.as_deref(), Some("commentary"));
    }

    #[test]
    fn a_completed_turn_has_status_and_duration() {
        let Notification::TurnCompleted { status, error, duration_ms, .. } =
            notification(include_str!("testdata/schema_turn_completed.json"))
        else {
            panic!("not turn/completed");
        };
        assert_eq!(status, TurnStatus::Completed);
        assert!(error.is_none());
        assert_eq!(duration_ms, 1500);
    }

    #[test]
    fn the_command_approval_request_is_parsed_and_declined_with_decline() {
        let (id, req) = match parse_line(&one_line(include_str!("testdata/schema_command_approval_request.json"))) {
            Some(Incoming::Request { id, request }) => (id, request),
            other => panic!("not a request: {other:?}"),
        };
        assert_eq!(id, json!(0));
        let ServerRequest::CommandApproval { legacy, command, cwd, actions } = &req else { panic!("{req:?}") };
        assert!(!legacy);
        assert_eq!(command, "del C:\\x.txt");
        assert_eq!(cwd.as_deref(), Some("C:\\sandbox"));
        assert_eq!(actions, &vec![CommandAction::Unknown]);
        let line = reply_line(&id, &reply_for(&req, false));
        assert_eq!(serde_json::from_str::<Value>(&line).unwrap(), json!({ "id": 0, "result": { "decision": "decline" } }));
    }

    #[test]
    fn every_other_server_request_has_a_refusal() {
        let file = request_of(include_str!("testdata/schema_file_change_approval_request.json"));
        assert_eq!(file, ServerRequest::FileChangeApproval { legacy: false });
        assert_eq!(reply_for(&file, false), Reply::Result(json!({ "decision": "decline" })));
        let perms = request_of(include_str!("testdata/schema_permissions_request.json"));
        assert_eq!(perms, ServerRequest::PermissionsApproval);
        assert_eq!(reply_for(&perms, true), Reply::Result(json!({ "permissions": {}, "scope": "turn" })));
        let legacy = request_of(include_str!("testdata/schema_legacy_exec_approval_request.json"));
        let ServerRequest::CommandApproval { legacy: true, command, .. } = &legacy else { panic!("{legacy:?}") };
        assert_eq!(command, "cmd /c dir");
        assert_eq!(reply_for(&legacy, false), Reply::Result(json!({ "decision": "denied" })));
        let patch = ServerRequest::FileChangeApproval { legacy: true };
        assert_eq!(reply_for(&patch, false), Reply::Result(json!({ "decision": "denied" })));
        assert_eq!(reply_for(&ServerRequest::UserInput, true), Reply::Result(json!({ "answers": {} })));
        assert!(matches!(reply_for(&ServerRequest::AuthTokensRefresh, true), Reply::Error { .. }));
        assert!(matches!(
            reply_for(&ServerRequest::Unknown { method: "x/y".into() }, true),
            Reply::Error { code: -32601, .. }
        ));
        let line = reply_line(&json!("r-1"), &Reply::Error { code: -32601, message: "no".into() });
        assert_eq!(
            serde_json::from_str::<Value>(&line).unwrap(),
            json!({ "id": "r-1", "error": { "code": -32601, "message": "no" } })
        );
    }

    #[test]
    fn the_mcp_elicitation_is_parsed_with_server_message_and_meta() {
        let req = request_of(include_str!("testdata/schema_mcp_elicitation_request.json"));
        let ServerRequest::McpElicitation { server, message, meta } = &req else { panic!("{req:?}") };
        assert_eq!(server, "mira");
        assert!(message.contains("kb_search"));
        assert_eq!(meta["codex_approval_kind"], "mcp_tool_call");
        assert_eq!(reply_for(&req, true), Reply::Result(json!({ "action": "accept" })));
        assert_eq!(reply_for(&req, false), Reply::Result(json!({ "action": "decline" })));
    }

    #[test]
    fn codex_rate_limit_updates_surface_only_near_or_reached_windows() {
        use crate::llm::cli_agent::protocol::PlanLimitLevel;
        let note = |p: Value| parse_notification("account/rateLimits/updated", &p);
        let calm = note(json!({"rateLimits": {"primary": {"usedPercent": 40, "resetsAt": 1900000000, "windowDurationMins": 300}, "secondary": null}}));
        assert_eq!(calm, Notification::Other("account/rateLimits/updated".into()));
        match note(json!({"rateLimits": {"primary": {"usedPercent": 40}, "secondary": {"usedPercent": 93, "resetsAt": 1900000000, "windowDurationMins": 10080}}})) {
            Notification::PlanLimit(l) => {
                assert_eq!(l.level, PlanLimitLevel::Near);
                assert_eq!(l.resets_at, Some(1_900_000_000));
                assert_eq!(l.window.as_deref(), Some("10080m"));
                assert_eq!(l.used, Some(93.0));
            }
            other => panic!("{other:?}"),
        }
        match note(json!({"rateLimits": {"primary": {"usedPercent": 50}, "rateLimitReachedType": "rate_limit_reached"}})) {
            Notification::PlanLimit(l) => assert_eq!(l.level, PlanLimitLevel::Hit),
            other => panic!("{other:?}"),
        }
        match note(json!({"rateLimits": {"primary": {"usedPercent": 100}}})) {
            Notification::PlanLimit(l) => assert_eq!(l.level, PlanLimitLevel::Hit),
            other => panic!("{other:?}"),
        }
    }
}
