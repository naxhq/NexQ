//! Checking an MCP server without any CLI: NexQ speaks the client side of MCP
//! itself (`initialize`, `notifications/initialized`, `tools/list`).
//!
//! Used by `mcp_check` when Claude isn't installed, so a PC with only
//! Antigravity or Codex can still Check a server and get its tool list.
//! stdio servers talk newline-delimited JSON-RPC over their stdin and stdout;
//! http servers get one POST per message (streamable HTTP), answered as plain
//! JSON or as an SSE stream. Secret values never appear in the errors.

use super::command::{configure_command, sandbox_dir};
use super::mcp_check::CHECK_MCP_TIMEOUT_MS;
use super::mcp_diagnose::{redact, resolve_command};
use super::process_tree::ProcessTree;
use crate::sources::config::{McpServer, McpTransport};
use crate::sources::mcp_json::{credential_id, header_credential_id};
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// The MCP revision NexQ announces.
const PROTOCOL_VERSION: &str = "2025-06-18";
/// A server with more `tools/list` pages than this gets the first ones only.
const MAX_PAGES: usize = 10;

/// Why a handshake did not give a tool list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HandshakeError {
    /// The overall limit ran out.
    Timeout,
    /// The command could not be started, or ended before it answered.
    Stopped,
    /// The server answered a request with a JSON-RPC error.
    Rpc(String),
    /// What came back wasn't an MCP answer.
    Protocol(String),
    /// A URL answered with this HTTP status.
    Http(u16),
    /// The URL could not be reached.
    Unreachable,
}

impl HandshakeError {
    /// Short plain text for the user, with every secret value hidden.
    pub fn message(&self, secrets: &[String]) -> String {
        match self {
            Self::Timeout => "The server took too long to start.".to_string(),
            Self::Stopped => {
                "The server failed to start. Check its command, arguments and sign-in values.".to_string()
            }
            Self::Rpc(text) => format!("The server refused the request: {}", redact(text, secrets)),
            Self::Protocol(text) => format!("The server's answer wasn't valid MCP: {}", redact(text, secrets)),
            Self::Http(401 | 403) => {
                "The server needs a sign-in NexQ doesn't have. Check its header values.".to_string()
            }
            Self::Http(404 | 405) => "The server doesn't accept streamable HTTP requests. Servers that only \
                 speak the older SSE transport can't be checked yet."
                .to_string(),
            Self::Http(code) => format!("The server didn't accept the request (HTTP {code})."),
            Self::Unreachable => "The server couldn't be reached.".to_string(),
        }
    }
}

// ---- messages ---------------------------------------------------------------

fn request(id: u64, method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

fn initialize_request(id: u64) -> Value {
    request(
        id,
        "initialize",
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "nexq", "version": env!("CARGO_PKG_VERSION") },
        }),
    )
}

fn initialized_notification() -> Value {
    json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })
}

fn tools_list_request(id: u64, cursor: Option<&str>) -> Value {
    match cursor {
        Some(c) => request(id, "tools/list", json!({ "cursor": c })),
        None => request(id, "tools/list", json!({})),
    }
}

/// What one message from the server is, seen from the request `want` we wait on.
#[derive(Debug, PartialEq)]
enum Incoming {
    /// The answer to our request: its `result`, or the error text.
    Response(Result<Value, String>),
    /// A request of the server's own (it carries an `id` and a `method`).
    ServerRequest { id: Value, method: String },
    /// A notification, an answer to something else, or noise.
    Ignore,
}

fn same_id(value: &Value, want: u64) -> bool {
    match value {
        Value::Number(n) => n.as_u64() == Some(want),
        Value::String(s) => s.parse::<u64>().ok() == Some(want),
        _ => false,
    }
}

fn classify(message: &Value, want: u64) -> Incoming {
    if let Some(method) = message.get("method").and_then(Value::as_str) {
        return match message.get("id") {
            Some(id) if !id.is_null() => Incoming::ServerRequest { id: id.clone(), method: method.to_string() },
            _ => Incoming::Ignore,
        };
    }
    if !message.get("id").is_some_and(|id| same_id(id, want)) {
        return Incoming::Ignore;
    }
    if let Some(error) = message.get("error") {
        let text = error
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| error.to_string());
        return Incoming::Response(Err(text));
    }
    match message.get("result") {
        Some(result) => Incoming::Response(Ok(result.clone())),
        None => Incoming::Ignore,
    }
}

/// How Claude names a tool: anything but letters, digits, `_` and `-` becomes `_`.
fn tool_name(key: &str, tool: &str) -> String {
    let clean: String =
        tool.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect();
    format!("mcp__{key}__{clean}")
}

/// The tools of one `tools/list` result (full names) and the cursor of the next page.
fn tools_page(result: &Value, key: &str) -> Result<(Vec<String>, Option<String>), HandshakeError> {
    let tools = result
        .get("tools")
        .and_then(Value::as_array)
        .ok_or_else(|| HandshakeError::Protocol("the tool list is missing".to_string()))?;
    let names = tools
        .iter()
        .filter_map(|t| t.get("name").and_then(Value::as_str))
        .map(|name| tool_name(key, name))
        .collect();
    let next = result
        .get("nextCursor")
        .and_then(Value::as_str)
        .filter(|c| !c.is_empty())
        .map(str::to_string);
    Ok((names, next))
}

/// The messages in a JSON body: one object, or a batch (array).
fn json_messages(body: &str) -> Vec<Value> {
    match serde_json::from_str::<Value>(body.trim()) {
        Ok(Value::Array(items)) => items,
        Ok(value @ Value::Object(_)) => vec![value],
        _ => Vec::new(),
    }
}

/// Incremental reader of a server-sent-events body: feed it bytes, get the
/// `data` of every event that is complete.
#[derive(Default)]
struct SseBuffer {
    buf: Vec<u8>,
}

impl SseBuffer {
    fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(bytes);
        let mut events = Vec::new();
        while let Some((end, gap)) = event_end(&self.buf) {
            let raw: Vec<u8> = self.buf.drain(..end + gap).take(end).collect();
            if let Some(data) = event_data(&String::from_utf8_lossy(&raw)) {
                events.push(data);
            }
        }
        events
    }

    /// The last event, when the stream ended without a closing blank line.
    fn finish(&mut self) -> Option<String> {
        let raw = std::mem::take(&mut self.buf);
        event_data(&String::from_utf8_lossy(&raw))
    }
}

/// Where the first event in `buf` ends and how long the blank line after it is.
fn event_end(buf: &[u8]) -> Option<(usize, usize)> {
    let lf = buf.windows(2).position(|w| w == b"\n\n").map(|p| (p, 2));
    let crlf = buf.windows(4).position(|w| w == b"\r\n\r\n").map(|p| (p, 4));
    match (lf, crlf) {
        (Some(a), Some(b)) => Some(if a.0 <= b.0 { a } else { b }),
        (a, b) => a.or(b),
    }
}

/// The joined `data:` lines of one event, `None` when it has none.
fn event_data(event: &str) -> Option<String> {
    let lines: Vec<&str> = event
        .lines()
        .filter_map(|l| l.strip_prefix("data:"))
        .map(|d| d.strip_prefix(' ').unwrap_or(d))
        .collect();
    (!lines.is_empty()).then(|| lines.join("\n")).filter(|d| !d.trim().is_empty())
}

/// The messages in a complete SSE body.
#[cfg(test)]
fn sse_messages(body: &str) -> Vec<Value> {
    let mut sse = SseBuffer::default();
    let mut events = sse.push(body.as_bytes());
    events.extend(sse.finish());
    events.iter().flat_map(|d| json_messages(d)).collect()
}

// ---- stdio ------------------------------------------------------------------

/// Where the server's lines come from.
trait LineSource {
    /// The next line, `None` when the server closed its output.
    fn next_line(&mut self, deadline: Instant) -> Result<Option<String>, HandshakeError>;
}

/// Lines from any reader (tests; the deadline can't interrupt a blocking read).
struct BufLines<R: BufRead>(R);

impl<R: BufRead> LineSource for BufLines<R> {
    fn next_line(&mut self, _deadline: Instant) -> Result<Option<String>, HandshakeError> {
        let mut line = String::new();
        match self.0.read_line(&mut line) {
            Ok(0) => Ok(None),
            Ok(_) => Ok(Some(line)),
            Err(_) => Ok(None),
        }
    }
}

/// Lines a reader thread sends over a channel, so the deadline holds.
struct ChannelLines(mpsc::Receiver<String>);

impl LineSource for ChannelLines {
    fn next_line(&mut self, deadline: Instant) -> Result<Option<String>, HandshakeError> {
        let left = deadline.checked_duration_since(Instant::now()).ok_or(HandshakeError::Timeout)?;
        match self.0.recv_timeout(left) {
            Ok(line) => Ok(Some(line)),
            Err(mpsc::RecvTimeoutError::Timeout) => Err(HandshakeError::Timeout),
            Err(mpsc::RecvTimeoutError::Disconnected) => Ok(None),
        }
    }
}

fn send_line(out: &mut impl Write, message: &Value) -> Result<(), HandshakeError> {
    writeln!(out, "{message}").and_then(|_| out.flush()).map_err(|_| HandshakeError::Stopped)
}

/// Send `message` (a request with id `want`) and read until its answer. The
/// server's own requests get an error back (`ping` an empty result); anything
/// else it says in between is skipped, including lines that aren't JSON.
fn stdio_request(
    src: &mut impl LineSource,
    out: &mut impl Write,
    message: &Value,
    want: u64,
    deadline: Instant,
) -> Result<Value, HandshakeError> {
    send_line(out, message)?;
    loop {
        let Some(line) = src.next_line(deadline)? else {
            return Err(HandshakeError::Stopped);
        };
        let Ok(parsed) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        let messages = match parsed {
            Value::Array(items) => items,
            other => vec![other],
        };
        for msg in &messages {
            match classify(msg, want) {
                Incoming::Response(Ok(result)) => return Ok(result),
                Incoming::Response(Err(text)) => return Err(HandshakeError::Rpc(text)),
                Incoming::ServerRequest { id, method } => {
                    let reply = if method == "ping" {
                        json!({ "jsonrpc": "2.0", "id": id, "result": {} })
                    } else {
                        json!({ "jsonrpc": "2.0", "id": id,
                                "error": { "code": -32601, "message": "Method not found" } })
                    };
                    send_line(out, &reply)?;
                }
                Incoming::Ignore => {}
            }
        }
    }
}

/// The whole handshake over a line source and a writer; the tool list of `key`.
fn stdio_handshake(
    src: &mut impl LineSource,
    out: &mut impl Write,
    key: &str,
    deadline: Instant,
) -> Result<Vec<String>, HandshakeError> {
    stdio_request(src, out, &initialize_request(1), 1, deadline)?;
    send_line(out, &initialized_notification())?;
    let mut tools = Vec::new();
    let mut cursor: Option<String> = None;
    for page in 0..MAX_PAGES {
        let id = 2 + page as u64;
        let result = stdio_request(src, out, &tools_list_request(id, cursor.as_deref()), id, deadline)?;
        let (names, next) = tools_page(&result, key)?;
        tools.extend(names);
        match next {
            Some(c) => cursor = Some(c),
            None => break,
        }
    }
    Ok(tools)
}

/// Start the command like a session would (same folder, environment, shims and
/// no console window) and run the handshake on its pipes. The command and
/// everything it started are ended afterwards.
fn stdio_check(
    command: &str,
    args: &[String],
    env: &[(String, String)],
    key: &str,
    limit: Duration,
) -> Result<Vec<String>, HandshakeError> {
    let deadline = Instant::now() + limit;
    let path = env.iter().find(|(k, _)| k.eq_ignore_ascii_case("PATH")).map(|(_, v)| std::ffi::OsString::from(v));
    let mut cmd = Command::new(resolve_command(command, path.as_deref()));
    configure_command(&mut cmd, &sandbox_dir());
    cmd.args(args)
        .envs(env.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|_| HandshakeError::Stopped)?;
    let tree = ProcessTree::adopt(&child);
    let (Some(mut stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        tree.kill(&mut child);
        return Err(HandshakeError::Stopped);
    };
    let (tx, rx) = mpsc::channel::<String>();
    // Ends when the pipe closes (the tree is killed below); never joined.
    std::thread::spawn(move || {
        let mut reader = std::io::BufReader::new(stdout);
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if tx.send(line).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let result = stdio_handshake(&mut ChannelLines(rx), &mut stdin, key, deadline);
    drop(stdin);
    tree.kill(&mut child);
    result
}

// ---- streamable HTTP --------------------------------------------------------

/// POST one message and return the answer to request `want` (`None` for a
/// notification: any 2xx will do). Takes a plain JSON body or an SSE stream.
async fn http_post(
    client: &reqwest::Client,
    url: &str,
    headers: &[(String, String)],
    session: Option<&str>,
    message: &Value,
    want: Option<u64>,
) -> Result<(Option<Value>, Option<String>), HandshakeError> {
    use futures::StreamExt;

    let mut req = client
        .post(url)
        .header("Accept", "application/json, text/event-stream")
        .header("Content-Type", "application/json");
    if let Some(id) = session {
        req = req.header("Mcp-Session-Id", id).header("MCP-Protocol-Version", PROTOCOL_VERSION);
    }
    for (name, value) in headers {
        req = req.header(name.as_str(), value.as_str());
    }
    let resp = req.json(message).send().await.map_err(|_| HandshakeError::Unreachable)?;
    let status = resp.status();
    if !status.is_success() {
        return Err(HandshakeError::Http(status.as_u16()));
    }
    let session_id = resp
        .headers()
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let Some(want) = want else {
        return Ok((None, session_id));
    };
    let is_sse = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|t| t.to_ascii_lowercase().contains("text/event-stream"));
    let protocol = |text: &str| HandshakeError::Protocol(text.to_string());
    let outcome = |messages: &[Value]| -> Option<Result<Value, HandshakeError>> {
        messages.iter().find_map(|m| match classify(m, want) {
            Incoming::Response(Ok(result)) => Some(Ok(result)),
            Incoming::Response(Err(text)) => Some(Err(HandshakeError::Rpc(text))),
            _ => None,
        })
    };
    if !is_sse {
        let body = resp.text().await.map_err(|_| HandshakeError::Unreachable)?;
        return match outcome(&json_messages(&body)) {
            Some(result) => result.map(|r| (Some(r), session_id)),
            None => Err(protocol("no answer to the request")),
        };
    }
    // Stop at the answer: some servers keep the stream open afterwards.
    let mut stream = resp.bytes_stream();
    let mut sse = SseBuffer::default();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| HandshakeError::Unreachable)?;
        for data in sse.push(&chunk) {
            if let Some(result) = outcome(&json_messages(&data)) {
                return result.map(|r| (Some(r), session_id));
            }
        }
    }
    if let Some(data) = sse.finish() {
        if let Some(result) = outcome(&json_messages(&data)) {
            return result.map(|r| (Some(r), session_id));
        }
    }
    Err(protocol("the stream ended without an answer"))
}

async fn http_handshake(
    url: &str,
    headers: &[(String, String)],
    key: &str,
) -> Result<Vec<String>, HandshakeError> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| HandshakeError::Unreachable)?;
    let (_, session) = http_post(&client, url, headers, None, &initialize_request(1), Some(1)).await?;
    http_post(&client, url, headers, session.as_deref(), &initialized_notification(), None).await?;
    let mut tools = Vec::new();
    let mut cursor: Option<String> = None;
    let mut outcome = Ok(());
    for page in 0..MAX_PAGES {
        let id = 2 + page as u64;
        let message = tools_list_request(id, cursor.as_deref());
        let step = http_post(&client, url, headers, session.as_deref(), &message, Some(id)).await;
        let result = match step {
            Ok((Some(result), _)) => tools_page(&result, key),
            Ok((None, _)) => Err(HandshakeError::Protocol("no answer to the request".to_string())),
            Err(e) => Err(e),
        };
        match result {
            Ok((names, next)) => {
                tools.extend(names);
                match next {
                    Some(c) => cursor = Some(c),
                    None => break,
                }
            }
            Err(e) => {
                outcome = Err(e);
                break;
            }
        }
    }
    // Politely end the session; a server may not support it.
    if let Some(id) = session {
        let mut req = client.delete(url).header("Mcp-Session-Id", id).timeout(Duration::from_secs(2));
        for (name, value) in headers {
            req = req.header(name.as_str(), value.as_str());
        }
        let _ = req.send().await;
    }
    outcome.map(|_| tools)
}

// ---- entry point ------------------------------------------------------------

/// Connect to `server` and list its tools as `mcp__<key>__<tool>`, within
/// [`CHECK_MCP_TIMEOUT_MS`]. `secret` looks a saved value up by credential id.
/// The error is a short sentence for the user.
pub async fn list_tools(
    server: &McpServer,
    secret: &(dyn Fn(&str) -> Option<String> + Sync),
) -> Result<Vec<String>, String> {
    let limit = Duration::from_millis(CHECK_MCP_TIMEOUT_MS as u64);
    let missing = |what: &str| format!("{}: the saved value for {what} is missing", server.label);
    let mut secrets: Vec<String> = Vec::new();
    let result = match &server.transport {
        McpTransport::Stdio { command, args } => {
            let mut env: Vec<(String, String)> = Vec::new();
            for var in &server.env {
                let value = if var.secret {
                    let value = secret(&credential_id(&server.key, &var.name)).ok_or_else(|| missing(&var.name))?;
                    secrets.push(value.clone());
                    value
                } else {
                    var.value.clone().unwrap_or_default()
                };
                env.push((var.name.clone(), value));
            }
            let (command, args, key) = (command.clone(), args.clone(), server.key.clone());
            tokio::task::spawn_blocking(move || stdio_check(&command, &args, &env, &key, limit))
                .await
                .unwrap_or(Err(HandshakeError::Stopped))
        }
        McpTransport::Http { url, header_names } => {
            let mut headers: Vec<(String, String)> = Vec::new();
            for name in header_names {
                let value = secret(&header_credential_id(&server.key, name))
                    .ok_or_else(|| missing(&format!("the {name} header")))?;
                secrets.push(value.clone());
                headers.push((name.clone(), value));
            }
            match tokio::time::timeout(limit, http_handshake(url, &headers, &server.key)).await {
                Ok(result) => result,
                Err(_) => Err(HandshakeError::Timeout),
            }
        }
    };
    result.map_err(|e| e.message(&secrets))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn far() -> Instant {
        Instant::now() + Duration::from_secs(30)
    }

    #[test]
    fn requests_have_the_expected_shape() {
        let init = initialize_request(1);
        assert_eq!(init["jsonrpc"], "2.0");
        assert_eq!(init["method"], "initialize");
        assert_eq!(init["params"]["protocolVersion"], "2025-06-18");
        assert_eq!(init["params"]["capabilities"], json!({}));
        assert_eq!(init["params"]["clientInfo"]["name"], "nexq");
        assert!(initialized_notification().get("id").is_none());
        assert_eq!(tools_list_request(3, None)["params"], json!({}));
        assert_eq!(tools_list_request(3, Some("abc"))["params"]["cursor"], "abc");
    }

    #[test]
    fn classify_tells_answers_requests_and_noise_apart() {
        let ok = json!({ "jsonrpc": "2.0", "id": 2, "result": { "tools": [] } });
        assert_eq!(classify(&ok, 2), Incoming::Response(Ok(json!({ "tools": [] }))));
        assert_eq!(classify(&ok, 3), Incoming::Ignore);
        let err = json!({ "jsonrpc": "2.0", "id": 2, "error": { "code": -1, "message": "boom" } });
        assert_eq!(classify(&err, 2), Incoming::Response(Err("boom".to_string())));
        let ping = json!({ "jsonrpc": "2.0", "id": 9, "method": "ping" });
        assert_eq!(classify(&ping, 2), Incoming::ServerRequest { id: json!(9), method: "ping".into() });
        let note = json!({ "jsonrpc": "2.0", "method": "notifications/message" });
        assert_eq!(classify(&note, 2), Incoming::Ignore);
        // A string id that spells our number is ours.
        assert_eq!(classify(&json!({ "id": "2", "result": {} }), 2), Incoming::Response(Ok(json!({}))));
    }

    #[test]
    fn tools_get_the_claude_name_and_the_cursor_is_read() {
        let result = json!({
            "tools": [ { "name": "get_note" }, { "name": "weird name.v2" }, { "description": "no name" } ],
            "nextCursor": "page2"
        });
        let (names, next) = tools_page(&result, "my-server").unwrap();
        assert_eq!(names, vec!["mcp__my-server__get_note", "mcp__my-server__weird_name_v2"]);
        assert_eq!(next.as_deref(), Some("page2"));
        let (_, none) = tools_page(&json!({ "tools": [], "nextCursor": "" }), "k").unwrap();
        assert_eq!(none, None);
        assert!(matches!(tools_page(&json!({}), "k"), Err(HandshakeError::Protocol(_))));
    }

    #[test]
    fn json_bodies_may_be_an_object_or_a_batch() {
        assert_eq!(json_messages(r#" {"id":1,"result":{}} "#).len(), 1);
        assert_eq!(json_messages(r#"[{"id":1},{"id":2}]"#).len(), 2);
        assert!(json_messages("not json").is_empty());
    }

    #[test]
    fn sse_bodies_are_split_into_events() {
        let body = ": comment\nevent: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/x\"}\n\n\
                    id: 7\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}\n\n";
        let messages = sse_messages(body);
        assert_eq!(messages.len(), 2);
        assert_eq!(classify(&messages[1], 1), Incoming::Response(Ok(json!({ "ok": true }))));
        // CRLF line ends, data split over lines, no blank line at the very end.
        let crlf = "data: {\"id\":1,\r\ndata: \"result\":{}}\r\n\r\n";
        assert_eq!(sse_messages(crlf).len(), 1);
        assert_eq!(sse_messages("data: {\"id\":1,\"result\":{}}").len(), 1);
        assert!(sse_messages("event: ping\n\n").is_empty());
    }

    #[test]
    fn sse_events_can_arrive_in_pieces() {
        let mut sse = SseBuffer::default();
        assert!(sse.push(b"data: {\"id\":1,").is_empty());
        assert!(sse.push(b"\"result\":{}}\n").is_empty());
        let events = sse.push(b"\ndata: next\n\n");
        assert_eq!(events, vec!["{\"id\":1,\"result\":{}}".to_string(), "next".to_string()]);
    }

    #[test]
    fn messages_hide_secrets_and_stay_plain() {
        let secrets = vec!["s3cret-value".to_string()];
        let rpc = HandshakeError::Rpc("bad key s3cret-value".to_string()).message(&secrets);
        assert!(!rpc.contains("s3cret-value"), "{rpc}");
        assert!(HandshakeError::Timeout.message(&[]).contains("too long"));
        assert!(HandshakeError::Http(401).message(&[]).contains("sign-in"));
        assert!(HandshakeError::Http(405).message(&[]).contains("SSE"));
        assert!(HandshakeError::Http(500).message(&[]).contains("500"));
    }

    /// A transcript the fake server prints, answering whatever is asked.
    fn transcript(lines: &[Value]) -> BufLines<Cursor<Vec<u8>>> {
        let mut text = String::new();
        for line in lines {
            text.push_str(&format!("{line}\n"));
        }
        BufLines(Cursor::new(text.into_bytes()))
    }

    #[test]
    fn handshake_follows_pages_and_answers_the_server() {
        let mut src = BufLines(Cursor::new(
            [
                "Starting server...\n".to_string(), // not JSON: skipped
                format!("{}\n", json!({ "jsonrpc": "2.0", "id": 1, "result": { "protocolVersion": "2025-06-18" } })),
                format!("{}\n", json!({ "jsonrpc": "2.0", "method": "notifications/message", "params": {} })),
                format!("{}\n", json!({ "jsonrpc": "2.0", "id": "srv-1", "method": "roots/list" })),
                format!("{}\n", json!({ "jsonrpc": "2.0", "id": 2, "result": { "tools": [{ "name": "a" }], "nextCursor": "c2" } })),
                format!("{}\n", json!({ "jsonrpc": "2.0", "id": 3, "result": { "tools": [{ "name": "b" }] } })),
            ]
            .concat()
            .into_bytes(),
        ));
        let mut out: Vec<u8> = Vec::new();
        let tools = stdio_handshake(&mut src, &mut out, "srv", far()).unwrap();
        assert_eq!(tools, vec!["mcp__srv__a", "mcp__srv__b"]);
        let sent: Vec<Value> =
            String::from_utf8(out).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        let methods: Vec<&str> = sent.iter().filter_map(|m| m["method"].as_str()).collect();
        assert_eq!(methods, vec!["initialize", "notifications/initialized", "tools/list", "tools/list"]);
        // The server's own request was answered with an error.
        let refused = sent.iter().find(|m| m["id"] == "srv-1").expect("reply to the server request");
        assert_eq!(refused["error"]["code"], -32601);
        // The second page asked with the cursor.
        assert_eq!(sent.last().unwrap()["params"]["cursor"], "c2");
    }

    #[test]
    fn handshake_reports_rpc_errors_and_closed_servers() {
        let mut src = transcript(&[json!({ "jsonrpc": "2.0", "id": 1, "error": { "code": -32000, "message": "no" } })]);
        let err = stdio_handshake(&mut src, &mut Vec::new(), "k", far()).unwrap_err();
        assert_eq!(err, HandshakeError::Rpc("no".to_string()));
        let mut empty = transcript(&[]);
        assert_eq!(stdio_handshake(&mut empty, &mut Vec::new(), "k", far()).unwrap_err(), HandshakeError::Stopped);
        // initialize fine, then tools/list refused.
        let mut half = transcript(&[
            json!({ "id": 1, "result": {} }),
            json!({ "id": 2, "error": { "message": "tools unsupported" } }),
        ]);
        assert!(matches!(
            stdio_handshake(&mut half, &mut Vec::new(), "k", far()),
            Err(HandshakeError::Rpc(m)) if m == "tools unsupported"
        ));
    }

    #[test]
    fn handshake_stops_after_the_page_cap() {
        let pages: Vec<Value> = std::iter::once(json!({ "id": 1, "result": {} }))
            .chain((0..20).map(|i| json!({ "id": 2 + i, "result": { "tools": [{ "name": format!("t{i}") }], "nextCursor": "more" } })))
            .collect();
        let tools = stdio_handshake(&mut transcript(&pages), &mut Vec::new(), "k", far()).unwrap();
        assert_eq!(tools.len(), MAX_PAGES);
    }

    #[test]
    fn a_silent_server_times_out() {
        let (tx, rx) = mpsc::channel::<String>();
        let started = Instant::now();
        let err = stdio_handshake(
            &mut ChannelLines(rx),
            &mut Vec::new(),
            "k",
            Instant::now() + Duration::from_millis(150),
        )
        .unwrap_err();
        assert_eq!(err, HandshakeError::Timeout);
        assert!(started.elapsed() < Duration::from_secs(5));
        drop(tx);
    }

    /// The real notes server (`notes_mcp::serve`) on the other end of two OS pipes.
    #[test]
    fn handshake_against_the_notes_server_over_pipes() {
        let (server_in, mut client_out) = std::io::pipe().unwrap();
        let (client_in, server_out) = std::io::pipe().unwrap();
        let server = std::thread::spawn(move || {
            let (notes, _) = crate::notes_mcp::vault::Notes::open(&[]);
            crate::notes_mcp::serve(std::io::BufReader::new(server_in), server_out, &notes)
        });
        let mut src = BufLines(std::io::BufReader::new(client_in));
        let tools = stdio_handshake(&mut src, &mut client_out, "nexq_notes", far()).unwrap();
        assert!(!tools.is_empty(), "{tools:?}");
        assert!(tools.iter().all(|t| t.starts_with("mcp__nexq_notes__")), "{tools:?}");
        drop(client_out); // the server sees EOF and ends
        server.join().unwrap().unwrap();
    }

    // ---- HTTP against a tiny local server ----

    /// Answers each connection once. `routes` maps the request's JSON-RPC
    /// method to (content type, body, extra header lines); every request line
    /// and its headers are recorded.
    async fn fake_http(
        answers: Vec<(&'static str, String, String, String)>,
    ) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { return };
                let mut data = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    let n = sock.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    data.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&data).to_string();
                    if let Some(split) = text.find("\r\n\r\n") {
                        let len = text[..split]
                            .lines()
                            .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                            .unwrap_or(0);
                        if data.len() >= split + 4 + len {
                            break;
                        }
                    }
                }
                let text = String::from_utf8_lossy(&data).to_string();
                log.lock().unwrap().push(text.clone());
                let first = text.lines().next().unwrap_or("").to_string();
                let body_json = text.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
                let method = serde_json::from_str::<Value>(&body_json)
                    .ok()
                    .and_then(|v| v["method"].as_str().map(str::to_string))
                    .unwrap_or_else(|| first.clone());
                let cursor = serde_json::from_str::<Value>(&body_json)
                    .ok()
                    .and_then(|v| v["params"]["cursor"].as_str().map(str::to_string))
                    .unwrap_or_default();
                let key = format!("{method}|{cursor}");
                let reply = answers
                    .iter()
                    .find(|(m, ..)| key == *m || method == *m)
                    .map(|(_, ct, body, extra)| (ct.clone(), body.clone(), extra.clone()));
                let response = match reply {
                    Some((ct, body, extra)) if ct == "202" => {
                        format!("HTTP/1.1 202 Accepted\r\n{extra}Content-Length: 0\r\nConnection: close\r\n\r\n{body}")
                    }
                    Some((ct, body, extra)) => format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: {ct}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    ),
                    None => "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
                };
                let _ = sock.write_all(response.as_bytes()).await;
                let _ = sock.shutdown().await;
            }
        });
        (url, seen)
    }

    #[tokio::test]
    async fn http_handshake_takes_json_and_sse_answers_and_carries_the_session() {
        let init = json!({ "jsonrpc": "2.0", "id": 1, "result": { "protocolVersion": "2025-06-18" } }).to_string();
        let page1 = format!(
            "event: message\ndata: {}\n\n",
            json!({ "jsonrpc": "2.0", "id": 2, "result": { "tools": [{ "name": "one" }], "nextCursor": "p2" } })
        );
        let page2 = json!({ "jsonrpc": "2.0", "id": 3, "result": { "tools": [{ "name": "two" }] } }).to_string();
        let (url, seen) = fake_http(vec![
            ("initialize", "application/json".into(), init, "Mcp-Session-Id: sess-42\r\n".into()),
            ("notifications/initialized", "202".into(), String::new(), String::new()),
            ("tools/list|", "text/event-stream".into(), page1, String::new()),
            ("tools/list|p2", "application/json".into(), page2, String::new()),
        ])
        .await;
        let headers = vec![("X-Api-Key".to_string(), "k-123".to_string())];
        let tools = http_handshake(&url, &headers, "web").await.unwrap();
        assert_eq!(tools, vec!["mcp__web__one", "mcp__web__two"]);
        let requests = seen.lock().unwrap().clone();
        let lower: Vec<String> = requests.iter().map(|r| r.to_ascii_lowercase()).collect();
        assert!(lower[0].contains("accept: application/json, text/event-stream"), "{}", lower[0]);
        assert!(lower[0].contains("x-api-key: k-123"));
        assert!(!lower[0].contains("mcp-session-id"));
        // Everything after initialize carries the session id.
        assert!(lower[1..4].iter().all(|r| r.contains("mcp-session-id: sess-42")));
    }

    #[tokio::test]
    async fn http_errors_map_to_plain_messages() {
        // Nothing routed: the fake answers 404, as a legacy SSE-only server would.
        let (url, _) = fake_http(vec![]).await;
        let err = http_handshake(&url, &[], "k").await.unwrap_err();
        assert_eq!(err, HandshakeError::Http(404));
        assert!(err.message(&[]).contains("SSE"));
        // A server that is not there.
        let gone = http_handshake("http://127.0.0.1:1/mcp", &[], "k").await.unwrap_err();
        assert_eq!(gone, HandshakeError::Unreachable);
    }

    #[tokio::test]
    async fn list_tools_reports_a_missing_secret_without_starting_anything() {
        let server = McpServer {
            key: "s".into(),
            label: "S".into(),
            transport: McpTransport::Http { url: "http://127.0.0.1:1/mcp".into(), header_names: vec!["Authorization".into()] },
            ..Default::default()
        };
        let err = list_tools(&server, &|_| None).await.unwrap_err();
        assert!(err.contains("Authorization"), "{err}");
    }

    #[tokio::test]
    async fn list_tools_hides_the_secret_header_value_in_errors() {
        let (url, _) = fake_http(vec![]).await;
        let server = McpServer {
            key: "s".into(),
            label: "S".into(),
            transport: McpTransport::Http { url, header_names: vec!["Authorization".into()] },
            ..Default::default()
        };
        let err = list_tools(&server, &|_| Some("Bearer top-secret".into())).await.unwrap_err();
        assert!(!err.contains("top-secret"), "{err}");
    }
}
