//! Reading MCP server definitions (pasted JSON, Claude Code's `~/.claude.json`),
//! splitting secrets out of them, and the read-only default for tool switches.

use super::config::{is_valid_tool_full_name, EnvVar, McpServer, McpTool, McpTransport};
use serde_json::Value;

/// One server as written in someone's JSON, before secrets are split out.
#[derive(Debug, Clone, PartialEq)]
pub struct RawServer {
    pub transport: McpTransport,
    pub env: Vec<(String, String)>,
    pub headers: Vec<(String, String)>,
    /// An HTTP server that needs an OAuth sign-in (Claude Code import only).
    pub oauth: bool,
}

/// A secret value on its way to Credential Manager.
#[derive(Clone, PartialEq)]
pub struct SecretValue {
    pub credential_id: String,
    pub value: String,
}

impl std::fmt::Debug for SecretValue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SecretValue")
            .field("credential_id", &self.credential_id)
            .field("value", &"<redacted>")
            .finish()
    }
}

/// Parse pasted JSON: `{"mcpServers": {...}}`, or just the `{name: {...}}` map.
pub fn parse_mcp_json(text: &str) -> Result<Vec<(String, RawServer)>, String> {
    let root: Value =
        serde_json::from_str(text.trim()).map_err(|e| format!("This is not valid JSON ({e})"))?;
    let map = match root.get("mcpServers") {
        Some(Value::Object(m)) => m,
        Some(_) => return Err("\"mcpServers\" must be an object of servers".to_string()),
        None => root
            .as_object()
            .ok_or_else(|| "Expected a JSON object with your servers".to_string())?,
    };
    if map.is_empty() {
        return Err("No servers found in this JSON".to_string());
    }
    map.iter()
        .map(|(name, entry)| Ok((name.clone(), parse_server(name, entry, false)?)))
        .collect()
}

/// The user-scope servers (top-level `mcpServers`) of Claude Code's
/// `~/.claude.json`, sorted by name; the first entry that cannot be read fails
/// the whole call. Per-project servers are ignored.
pub fn read_claude_code_servers(claude_json: &str) -> Result<Vec<(String, RawServer)>, String> {
    read_claude_code_entries(claude_json)?
        .into_iter()
        .map(|(name, entry)| entry.map(|raw| (name, raw)))
        .collect()
}

/// Every user-scope server of `~/.claude.json` by name, sorted, each with the
/// reason it cannot be imported (SSE, a malformed entry) instead of failing
/// the whole list.
pub fn read_claude_code_entries(
    claude_json: &str,
) -> Result<Vec<(String, Result<RawServer, String>)>, String> {
    let root: Value = serde_json::from_str(claude_json)
        .map_err(|e| format!("Claude Code's config is not valid JSON ({e})"))?;
    let Some(map) = root.get("mcpServers").and_then(Value::as_object) else {
        return Ok(Vec::new());
    };
    let mut entries: Vec<_> = map
        .iter()
        .map(|(name, entry)| (name.clone(), parse_server(name, entry, true)))
        .collect();
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(entries)
}

/// `claude_code`: an HTTP server without headers (or with an `oauth` block) is
/// one Claude Code signs in to itself, which NexQ cannot do.
fn parse_server(name: &str, entry: &Value, claude_code: bool) -> Result<RawServer, String> {
    let obj = entry
        .as_object()
        .ok_or_else(|| format!("Server \"{name}\" must be an object"))?;
    let kind = obj.get("type").and_then(Value::as_str).unwrap_or("");
    let url = obj.get("url").and_then(Value::as_str);
    let command = obj.get("command").and_then(Value::as_str);
    let pairs = |key: &str| -> Vec<(String, String)> {
        obj.get(key)
            .and_then(Value::as_object)
            .map(|m| m.iter().map(|(k, v)| (k.clone(), scalar_text(v))).collect())
            .unwrap_or_default()
    };

    if kind == "sse" {
        return Err(format!("Server \"{name}\" uses SSE, which is not supported yet"));
    }
    if kind == "http" || (kind.is_empty() && url.is_some() && command.is_none()) {
        let url = url.ok_or_else(|| format!("Server \"{name}\" is missing its \"url\""))?;
        let headers = pairs("headers");
        let oauth = claude_code && (headers.is_empty() || obj.contains_key("oauth"));
        return Ok(RawServer {
            transport: McpTransport::Http {
                url: url.to_string(),
                header_names: headers.iter().map(|(k, _)| k.clone()).collect(),
            },
            env: Vec::new(),
            headers,
            oauth,
        });
    }
    let command = command
        .ok_or_else(|| format!("Server \"{name}\" needs a \"command\" (or an http \"url\")"))?;
    let args = obj
        .get("args")
        .and_then(Value::as_array)
        .map(|a| a.iter().map(scalar_text).collect())
        .unwrap_or_default();
    Ok(RawServer {
        transport: McpTransport::Stdio { command: command.to_string(), args },
        env: pairs("env"),
        headers: Vec::new(),
        oauth: false,
    })
}

fn scalar_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// An env var whose name contains KEY, TOKEN, SECRET or PASSWORD.
pub fn is_secret_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    ["KEY", "TOKEN", "SECRET", "PASSWORD"].iter().any(|w| upper.contains(w))
}

/// Verbs that mean a tool changes something somewhere, or does something that
/// cannot be undone. Any one of them in a name keeps the tool off.
const WRITE_VERBS: &[&str] = &[
    "add", "create", "insert", "update", "edit", "modify", "patch", "put", "set", "write", "save",
    "store", "delete", "remove", "archive", "move", "rename", "complete", "close", "send", "post",
    "reply", "forward", "draft", "invite", "schedule", "cancel", "approve", "assign", "mark",
    "upload", "publish", "merge", "run", "execute", "apply", "remember", "log", "transfer", "pay",
    "charge", "buy", "order", "submit", "nuke", "drop", "truncate", "wipe", "purge", "destroy",
    "kill", "stop", "start", "restart", "reset", "clear", "revoke", "grant", "deploy", "import",
    "sync", "trigger", "call", "invoke", "exec", "shell", "enable", "disable", "install",
    "uninstall", "push", "replace", "overwrite", "append", "attach", "share", "tag", "label",
    "pin", "subscribe", "unsubscribe", "ban", "block", "lock", "unlock", "rotate", "restore",
    "revert", "commit", "rollback", "migrate", "flush", "terminate", "abort", "retry", "confirm",
    "reject", "accept", "decline", "snooze", "dismiss", "undo", "redo", "copy", "clone", "fork",
    "duplicate", "rebase", "fire", "launch", "open",
];

/// Verbs that clearly mean "look something up". `query` is deliberately not one:
/// a query tool can be a SQL console. Neither is `fetch`: a fetch tool can send
/// a request out (a URL fetcher is also a way to leak what it was given).
const READ_VERBS: &[&str] = &[
    "get", "list", "search", "read", "find", "lookup", "show", "describe", "status",
    "brief", "view", "count", "check",
];

/// Lowercase words of a tool name, split on `_`, `-`, `.` and camelCase.
fn name_words(name: &str) -> Vec<String> {
    let mut words: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut prev_lower = false;
    for c in name.chars() {
        if matches!(c, '_' | '-' | '.' | ' ') {
            if !cur.is_empty() {
                words.push(std::mem::take(&mut cur));
            }
            prev_lower = false;
            continue;
        }
        if c.is_uppercase() && prev_lower && !cur.is_empty() {
            words.push(std::mem::take(&mut cur));
        }
        prev_lower = c.is_lowercase() || c.is_ascii_digit();
        cur.extend(c.to_lowercase());
    }
    if !cur.is_empty() {
        words.push(cur);
    }
    words
}

/// Fails closed: a tool starts on only when its name has a read verb and no
/// write verb. A name with no verb (`inbox`, `tasks`, `calendar`) or an unknown
/// one (`nuke_db`, `transfer_funds`) starts off, and the user can switch it on.
pub fn tool_allowed_by_default(tool_name: &str) -> bool {
    let words = name_words(tool_name);
    let has = |list: &[&str]| words.iter().any(|w| list.contains(&w.as_str()));
    has(READ_VERBS) && !has(WRITE_VERBS)
}

/// The tool list after a Check: the user's earlier switches stay, a new tool
/// takes the read-only default, a tool the server no longer has is dropped.
/// Only valid names under `mcp__<key>__` count (see `is_valid_tool_full_name`).
pub fn merge_checked_tools(old: &[McpTool], found_full_names: &[String], key: &str) -> Vec<McpTool> {
    let prefix = format!("mcp__{key}__");
    let mut merged: Vec<McpTool> = Vec::new();
    for full in found_full_names {
        if !is_valid_tool_full_name(key, full) {
            continue;
        }
        let name = &full[prefix.len()..];
        if merged.iter().any(|t| t.name == name) {
            continue;
        }
        let allowed = old
            .iter()
            .find(|t| t.name == name)
            .map(|t| t.allowed)
            .unwrap_or_else(|| tool_allowed_by_default(name));
        merged.push(McpTool { name: name.to_string(), full_name: full.clone(), allowed });
    }
    merged
}

/// A key for the generated mcp-config: lowercase `[a-z0-9-]`, no `__`, not in
/// `taken`. The CLI keeps such a key verbatim in `mcp__<key>__<tool>`.
pub fn unique_key(name: &str, taken: &[String]) -> String {
    let mut base = String::new();
    let mut pending_dash = false;
    for c in name.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if pending_dash && !base.is_empty() {
                base.push('-');
            }
            pending_dash = false;
            base.push(c);
        } else {
            pending_dash = true;
        }
    }
    if base.is_empty() {
        base = "server".to_string();
    }
    let mut key = base.clone();
    let mut n = 2;
    while taken.iter().any(|t| *t == key) {
        key = format!("{base}-{n}");
        n += 1;
    }
    key
}

/// Credential Manager id of a secret env var.
pub fn credential_id(server_key: &str, env_name: &str) -> String {
    format!("mcp:{server_key}:{env_name}")
}

/// Credential Manager id of an HTTP header value.
pub fn header_credential_id(server_key: &str, header: &str) -> String {
    format!("mcp:{server_key}:header:{header}")
}

/// Turn a raw server into a config entry plus the secrets to store. Secret env
/// values and every header value leave the entry. A new server comes back off
/// (the user switches it on after a successful Check).
pub fn into_server(name: &str, raw: RawServer, taken_keys: &[String]) -> (McpServer, Vec<SecretValue>) {
    let key = unique_key(name, taken_keys);
    let mut secrets = Vec::new();
    let mut env = Vec::new();
    for (var, value) in raw.env {
        if is_secret_name(&var) {
            secrets.push(SecretValue { credential_id: credential_id(&key, &var), value });
            env.push(EnvVar { name: var, value: None, secret: true });
        } else {
            env.push(EnvVar { name: var, value: Some(value), secret: false });
        }
    }
    for (header, value) in raw.headers {
        secrets.push(SecretValue { credential_id: header_credential_id(&key, &header), value });
    }
    let server = McpServer {
        id: uuid::Uuid::new_v4().to_string(),
        key,
        label: name.to_string(),
        transport: raw.transport,
        // Every new server starts off: the user turns it on after a Check.
        enabled: false,
        env,
        tools: Vec::new(),
        last_check: None,
        needs_sign_in: raw.oauth,
    };
    (server, secrets)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_mcp_json_accepts_wrapper_bare_map_and_many() {
        let w = parse_mcp_json(r#"{"mcpServers":{"a":{"command":"npx","args":["-y","x"],"env":{"API_KEY":"k","MODE":"ro"}},"b":{"type":"http","url":"https://h/mcp","headers":{"Authorization":"Bearer t"}}}}"#).unwrap();
        assert_eq!(w.len(), 2);
        assert_eq!(parse_mcp_json(r#"{"a":{"command":"node","args":["s.js"]}}"#).unwrap().len(), 1);
        assert!(parse_mcp_json("not json").unwrap_err().contains("JSON"));
        assert!(parse_mcp_json(r#"{"mcpServers":{}}"#).unwrap_err().contains("No servers"));
    }

    #[test]
    fn parse_rejects_entries_that_are_not_servers() {
        assert!(parse_mcp_json(r#"{"a":{"args":["x"]}}"#).unwrap_err().contains("command"));
        assert!(parse_mcp_json(r#"{"a":{"type":"sse","url":"https://h"}}"#).unwrap_err().contains("SSE"));
        assert!(parse_mcp_json(r#"{"a":"npx"}"#).unwrap_err().contains("object"));
    }

    #[test]
    fn secrets_are_split_out_and_never_kept_in_the_server() {
        let (name, raw) = parse_mcp_json(r#"{"a":{"command":"x","env":{"GITHUB_TOKEN":"t","db_password":"p","MODE":"ro"}}}"#).unwrap().remove(0);
        let (server, secrets) = into_server(&name, raw, &[]);
        assert_eq!(secrets.len(), 2);
        assert!(secrets.iter().any(|s| s.credential_id == "mcp:a:GITHUB_TOKEN" && s.value == "t"));
        assert!(server.env.iter().filter(|e| e.secret).all(|e| e.value.is_none()));
        assert_eq!(server.env.iter().find(|e| e.name == "MODE").unwrap().value.as_deref(), Some("ro"));
        assert!(!serde_json::to_string(&server).unwrap().contains("\"t\""));
    }

    #[test]
    fn header_values_are_secrets_and_only_their_names_stay() {
        let (name, raw) = parse_mcp_json(r#"{"b":{"type":"http","url":"https://h/mcp","headers":{"Authorization":"Bearer t"}}}"#).unwrap().remove(0);
        let (server, secrets) = into_server(&name, raw, &[]);
        assert_eq!(secrets.len(), 1);
        assert_eq!(secrets[0].credential_id, "mcp:b:header:Authorization");
        assert_eq!(secrets[0].value, "Bearer t");
        assert_eq!(server.transport, McpTransport::Http { url: "https://h/mcp".into(), header_names: vec!["Authorization".into()] });
        assert!(!serde_json::to_string(&server).unwrap().contains("Bearer"));
        assert!(!format!("{:?}", secrets[0]).contains("Bearer"));
    }

    #[test]
    fn secret_names() {
        for n in ["API_KEY", "api_key", "GITHUB_TOKEN", "CLIENT_SECRET", "DB_PASSWORD"] {
            assert!(is_secret_name(n), "{n}");
        }
        for n in ["MODE", "VAULT_PATH", "PORT"] {
            assert!(!is_secret_name(n), "{n}");
        }
    }

    #[test]
    fn read_only_heuristic_defaults() {
        for t in ["kb_search", "kb_read", "person_brief", "list_tasks", "get_calendar", "find_email", "read_email", "read_thread", "status", "getNote", "search-notes"] {
            assert!(tool_allowed_by_default(t), "{t}");
        }
        for t in [
            "add_task", "update_task", "complete_task", "add_history", "delete_note", "send_email",
            "create_event", "draft_email", "draft_reply", "remember", "writeFile", "moveItem",
            "set_status", "post_message", "transfer_funds", "nuke_db", "run_query", "execute_sql",
            // No verb at all, or a name that does not clearly read: off until the user says so.
            "calendar", "free_slots", "tasks", "inbox", "query", "get_and_delete",
            // A fetcher can send a request out.
            "fetch", "fetch_url", "web_fetch",
        ] {
            assert!(!tool_allowed_by_default(t), "{t}");
        }
    }

    #[test]
    fn merge_checked_tools_keeps_choices_defaults_new_drops_gone() {
        let old = vec![
            McpTool { name: "kb_search".into(), full_name: "mcp__m__kb_search".into(), allowed: false },
            McpTool { name: "gone".into(), full_name: "mcp__m__gone".into(), allowed: true },
        ];
        let found = vec!["mcp__m__kb_search".into(), "mcp__m__delete_note".into(), "mcp__m__kb_read".into(), "mcp__other__x".into()];
        let mut found = found;
        found.push("mcp__m__--add-dir".into());
        found.push("mcp__m__a b".into());
        let merged = merge_checked_tools(&old, &found, "m");
        let get = |n: &str| merged.iter().find(|t| t.name == n).map(|t| t.allowed);
        assert_eq!((get("kb_search"), get("delete_note"), get("kb_read"), get("gone"), get("x")), (Some(false), Some(false), Some(true), None, None));
        assert_eq!(merged.iter().find(|t| t.name == "kb_read").unwrap().full_name, "mcp__m__kb_read");
    }

    #[test]
    fn claude_code_import_reads_user_scope_and_flags_oauth() {
        let json = r#"{"mcpServers":{"local":{"command":"node","args":["s.js"]},"hdr":{"type":"http","url":"https://a/mcp","headers":{"X-Api-Key":"v"}},"oauth":{"type":"http","url":"https://b/mcp"}},"projects":{"D:/p":{"mcpServers":{"proj":{"command":"x"}}}}}"#;
        let servers = read_claude_code_servers(json).unwrap();
        assert_eq!(servers.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(), ["hdr", "local", "oauth"]);
        assert!(servers.iter().find(|(n, _)| n == "oauth").unwrap().1.oauth);
        assert!(!servers.iter().find(|(n, _)| n == "hdr").unwrap().1.oauth);
        assert!(read_claude_code_servers("{}").unwrap().is_empty());
        assert!(read_claude_code_servers("[").unwrap_err().contains("JSON"));
    }

    #[test]
    fn oauth_servers_import_off_and_flagged() {
        let json = r#"{"mcpServers":{"oauth":{"type":"http","url":"https://b/mcp"}}}"#;
        let (name, raw) = read_claude_code_servers(json).unwrap().remove(0);
        let (server, secrets) = into_server(&name, raw, &[]);
        assert!(server.needs_sign_in && !server.enabled && secrets.is_empty());
    }

    #[test]
    fn every_new_server_starts_off() {
        let (name, raw) = parse_mcp_json(r#"{"a":{"command":"node","args":["s.js"]}}"#).unwrap().remove(0);
        assert!(!into_server(&name, raw, &[]).0.enabled);
    }

    #[test]
    fn claude_code_entries_keep_the_unreadable_ones_apart() {
        let json = r#"{"mcpServers":{"ok":{"command":"x"},"sse":{"type":"sse","url":"https://h"}}}"#;
        let entries = read_claude_code_entries(json).unwrap();
        assert_eq!(entries.iter().map(|(n, e)| (n.as_str(), e.is_ok())).collect::<Vec<_>>(), [("ok", true), ("sse", false)]);
        assert!(read_claude_code_servers(json).unwrap_err().contains("SSE"));
    }

    #[test]
    fn unique_keys() {
        assert_eq!(unique_key("My Server!", &[]), "my-server");
        assert_eq!(unique_key("mira", &["mira".into()]), "mira-2");
        assert_eq!(unique_key("mira", &["mira".into(), "mira-2".into()]), "mira-3");
        assert_eq!(unique_key("a__b", &[]), "a-b");
        assert_eq!(unique_key("Ünï", &[]), "n");
        assert_eq!(unique_key("!!!", &[]), "server");
    }

    #[test]
    fn credential_ids() {
        assert_eq!(credential_id("a", "API_KEY"), "mcp:a:API_KEY");
        assert_eq!(header_credential_id("a", "Authorization"), "mcp:a:header:Authorization");
    }
}
