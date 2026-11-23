//! Turning a [`SourcesLaunch`] (built once for every CLI by
//! `sources::launch::build_sources_launch`, in Claude's terms: an mcp-config
//! JSON text, `--add-dir` folders, `mcp__<server>__<tool>` allow and deny
//! lists) into what Antigravity (ACP) and Codex take.
//!
//! - Antigravity: `session/new`'s `mcpServers` (stdio
//!   `{name, command, args, env: [{name, value}]}`, http
//!   `{type: "http", name, url, headers: [{name, value}]}`),
//!   `additionalDirectories`, and a [`PermissionPolicy`] that answers its
//!   `session/request_permission`.
//! - Codex: one config table per server (sent in `thread/start`'s `config`,
//!   never on the command line), the readable folders, and a [`CodexPolicy`].
//!   The allowed tools are also enforced by the server's own `enabled_tools`
//!   (a tool outside it is not even offered), and the denied ones by
//!   `disabled_tools`, on top of the approval decision.
//!
//! Secrets: each server's own values travel only in that server's entry. The
//! outputs hold them, so none of these types is ever logged (the launch types
//! redact them in `Debug`).

use super::acp::permission::{McpToolRule, PermissionPolicy};
use super::codex::policy::CodexPolicy;
use super::command::SourcesLaunch;
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::path::PathBuf;

/// How long one MCP tool call may take for Codex (`tool_timeout_sec`), like
/// Claude's `MCP_TOOL_TIMEOUT`.
const CODEX_TOOL_TIMEOUT_SEC: u64 = 20;
/// Codex's MCP startup limit when the launch names none, like `MCP_TIMEOUT`.
const CODEX_STARTUP_TIMEOUT_SEC: u64 = 20;

/// `(server key, entry)` of every server in the launch's mcp-config JSON, in
/// the file's order (the entry is `{command, args, env}` or `{type, url, headers}`).
fn config_entries(launch: &SourcesLaunch) -> Vec<(String, Value)> {
    let Some(text) = launch.mcp_config_json.as_deref() else { return Vec::new() };
    let Ok(config) = serde_json::from_str::<Value>(text) else { return Vec::new() };
    config["mcpServers"]
        .as_object()
        .map(|servers| servers.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default()
}

/// Split `mcp__<key>__<tool>` into `(key, tool)` for the longest `key` among
/// `servers` that fits (keys may contain underscores). `tool` may be `*`.
fn split_tool<'a>(name: &'a str, servers: &[String]) -> Option<(&'a str, &'a str)> {
    let rest = name.strip_prefix("mcp__")?;
    servers
        .iter()
        .filter_map(|key| {
            let tool = rest.strip_prefix(key.as_str())?.strip_prefix("__")?;
            (!tool.is_empty()).then_some((key.len(), &rest[..key.len()], tool))
        })
        .max_by_key(|(len, _, _)| *len)
        .map(|(_, key, tool)| (key, tool))
}

/// The server keys and, for each of `names` that belongs to one, its tool.
fn tools_by_server(names: &[String], servers: &[String]) -> Vec<(String, String)> {
    names
        .iter()
        .filter_map(|n| split_tool(n, servers))
        .map(|(k, t)| (k.to_string(), t.to_string()))
        .collect()
}

// ---------------------------------------------------------------------------
// Antigravity (ACP)
// ---------------------------------------------------------------------------

/// What an ACP session is given for its sources.
#[derive(Clone, Default)]
pub struct AcpSources {
    /// `session/new`'s `mcpServers`. Hold secrets.
    pub mcp_servers: Vec<Value>,
    /// `session/new`'s `additionalDirectories`: the notes folders.
    pub additional_dirs: Vec<PathBuf>,
    pub policy: PermissionPolicy,
}

impl std::fmt::Debug for AcpSources {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AcpSources")
            .field("mcp_servers", &format_args!("<redacted, {}>", self.mcp_servers.len()))
            .field("additional_dirs", &self.additional_dirs)
            .finish()
    }
}

/// `{name, value}` pairs out of a JSON object of string values.
fn name_value_list(object: Option<&Value>) -> Vec<Value> {
    object
        .and_then(Value::as_object)
        .map(|o| {
            o.iter()
                .map(|(k, v)| json!({ "name": k, "value": v.as_str().unwrap_or_default() }))
                .collect()
        })
        .unwrap_or_default()
}

/// One server as ACP's `session/new` wants it.
fn acp_server(key: &str, entry: &Value) -> Option<Value> {
    if let Some(command) = entry["command"].as_str() {
        return Some(json!({
            "name": key,
            "command": command,
            "args": entry["args"].as_array().cloned().unwrap_or_default(),
            "env": name_value_list(entry.get("env")),
        }));
    }
    let url = entry["url"].as_str()?;
    let kind = match entry["type"].as_str() {
        Some("sse") => "sse",
        _ => "http",
    };
    Some(json!({
        "type": kind,
        "name": key,
        "url": url,
        "headers": name_value_list(entry.get("headers")),
    }))
}

/// The ACP view of `launch`. `None` (a plain session): nothing, and a policy
/// that allows nothing.
pub fn acp_sources(launch: Option<&SourcesLaunch>) -> AcpSources {
    let Some(launch) = launch else {
        return AcpSources { policy: PermissionPolicy::deny_all(), ..Default::default() };
    };
    let entries = config_entries(launch);
    let keys: Vec<String> = entries.iter().map(|(k, _)| k.clone()).collect();
    let rule = |(key, tool): (String, String)| {
        if tool == "*" {
            McpToolRule::whole_server(&key)
        } else {
            McpToolRule::tool(&key, &tool)
        }
    };
    let allow = tools_by_server(&launch.allowed_tools, &keys).into_iter().map(rule).collect();
    let deny = tools_by_server(&launch.disallowed_tools, &keys).into_iter().map(rule).collect();
    AcpSources {
        mcp_servers: entries.iter().filter_map(|(k, e)| acp_server(k, e)).collect(),
        additional_dirs: launch.add_dirs.clone(),
        policy: PermissionPolicy::new(&launch.add_dirs, allow, deny),
    }
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

/// What a Codex session is given for its sources.
#[derive(Clone, Default)]
pub struct CodexSources {
    /// Server key -> its Codex config table (for `thread/start`'s `config`). Hold secrets.
    pub mcp_servers: Map<String, Value>,
    /// The notes folders commands may read.
    pub readable_dirs: Vec<PathBuf>,
    pub policy: CodexPolicy,
}

impl std::fmt::Debug for CodexSources {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CodexSources")
            .field("mcp_servers", &format_args!("<redacted, {}>", self.mcp_servers.len()))
            .field("readable_dirs", &self.readable_dirs)
            .field("policy", &self.policy)
            .finish()
    }
}

/// One server as a Codex `mcp_servers.<key>` table, limited to its allowed tools.
fn codex_server(entry: &Value, enabled: Option<Vec<String>>, disabled: Vec<String>, startup_sec: u64) -> Option<Value> {
    let mut table = Map::new();
    if let Some(command) = entry["command"].as_str() {
        table.insert("command".into(), json!(command));
        table.insert("args".into(), entry["args"].clone().as_array().map(|a| json!(a)).unwrap_or(json!([])));
        if let Some(env) = entry["env"].as_object().filter(|e| !e.is_empty()) {
            table.insert("env".into(), json!(env));
        }
    } else {
        table.insert("url".into(), json!(entry["url"].as_str()?));
        if let Some(headers) = entry["headers"].as_object().filter(|h| !h.is_empty()) {
            table.insert("http_headers".into(), json!(headers));
        }
    }
    if let Some(enabled) = enabled {
        table.insert("enabled_tools".into(), json!(enabled));
    }
    if !disabled.is_empty() {
        table.insert("disabled_tools".into(), json!(disabled));
    }
    table.insert("tool_timeout_sec".into(), json!(CODEX_TOOL_TIMEOUT_SEC));
    table.insert("startup_timeout_sec".into(), json!(startup_sec));
    Some(Value::Object(table))
}

/// The Codex view of `launch`. `None` (a plain session): nothing allowed.
pub fn codex_sources(launch: Option<&SourcesLaunch>) -> CodexSources {
    let Some(launch) = launch else { return CodexSources::default() };
    let entries = config_entries(launch);
    let keys: Vec<String> = entries.iter().map(|(k, _)| k.clone()).collect();
    let allowed = tools_by_server(&launch.allowed_tools, &keys);
    let denied = tools_by_server(&launch.disallowed_tools, &keys);
    let startup_sec = launch
        .mcp_startup_timeout_ms
        .map(|ms| u64::from(ms).div_ceil(1000).max(1))
        .unwrap_or(CODEX_STARTUP_TIMEOUT_SEC);

    let mut policy_tools: HashSet<String> = HashSet::new();
    let mut servers = Map::new();
    for (key, entry) in &entries {
        let mine = |list: &[(String, String)]| -> Vec<String> {
            list.iter().filter(|(k, _)| k == key).map(|(_, t)| t.clone()).collect()
        };
        let (allowed_here, denied_here) = (mine(&allowed), mine(&denied));
        // A denied tool is never allowed, even when a wildcard would cover it.
        let whole_server = allowed_here.iter().any(|t| t == "*");
        let enabled: Option<Vec<String>> = if whole_server {
            None
        } else {
            Some(allowed_here.iter().filter(|t| !denied_here.contains(t)).cloned().collect())
        };
        for tool in &allowed_here {
            if !denied_here.contains(tool) {
                policy_tools.insert(format!("mcp__{key}__{tool}"));
            }
        }
        let disabled: Vec<String> = denied_here.into_iter().filter(|t| t != "*").collect();
        if let Some(table) = codex_server(entry, enabled, disabled, startup_sec) {
            servers.insert(key.clone(), table);
        }
    }
    CodexSources {
        mcp_servers: servers,
        readable_dirs: launch.add_dirs.clone(),
        policy: CodexPolicy { allowed_tools: policy_tools },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::cli_agent::acp::permission::{decide, parse_request, PermissionRequest};

    /// What `build_sources_launch` makes for a notes folder, a stdio server
    /// with two secret values and an http server with one secret header.
    fn launch(notes: &str) -> SourcesLaunch {
        let config = json!({ "mcpServers": {
            "mira": { "command": "node", "args": ["s.js", "--x"], "env": { "API_KEY": "mira-secret", "MODE": "ro" } },
            "wiki": { "type": "http", "url": "https://wiki.test/mcp", "headers": { "Authorization": "Bearer wiki-secret" } },
            "my_srv": { "command": "uvx", "args": [] },
        }});
        SourcesLaunch {
            add_dirs: vec![PathBuf::from(notes)],
            mcp_config_json: Some(config.to_string()),
            allowed_tools: vec![
                "Read".into(),
                "Grep".into(),
                "Glob".into(),
                "mcp__mira__kb_search".into(),
                "mcp__mira__kb_read".into(),
                "mcp__wiki__*".into(),
                "mcp__my_srv__do_it".into(),
            ],
            disallowed_tools: vec!["Read(C:/private/**)".into(), "mcp__mira__send_mail".into(), "mcp__mira__kb_read".into()],
            ..Default::default()
        }
    }

    #[test]
    fn acp_servers_use_the_acp_shapes() {
        let a = acp_sources(Some(&launch("C:\\Notes")));
        assert_eq!(a.mcp_servers.len(), 3);
        let by_name = |n: &str| a.mcp_servers.iter().find(|s| s["name"] == n).unwrap().clone();
        let mira = by_name("mira");
        assert_eq!(mira["command"], "node");
        assert_eq!(mira["args"], json!(["s.js", "--x"]));
        assert_eq!(mira["env"], json!([{ "name": "API_KEY", "value": "mira-secret" }, { "name": "MODE", "value": "ro" }]));
        assert!(mira.get("type").is_none());
        let wiki = by_name("wiki");
        assert_eq!(wiki["type"], "http");
        assert_eq!(wiki["url"], "https://wiki.test/mcp");
        assert_eq!(wiki["headers"], json!([{ "name": "Authorization", "value": "Bearer wiki-secret" }]));
        assert!(wiki.get("command").is_none());
        // A stdio server with no env still has the (empty) list ACP requires.
        let srv = by_name("my_srv");
        assert_eq!(srv["env"], json!([]));
        assert_eq!(srv["args"], json!([]));
        assert_eq!(a.additional_dirs, vec![PathBuf::from("C:\\Notes")]);
    }

    #[test]
    fn secrets_stay_with_their_own_server_and_out_of_debug() {
        let a = acp_sources(Some(&launch("C:\\Notes")));
        let text_of = |name: &str| a.mcp_servers.iter().find(|s| s["name"] == name).unwrap().to_string();
        assert!(text_of("mira").contains("mira-secret") && !text_of("mira").contains("wiki-secret"));
        assert!(text_of("wiki").contains("wiki-secret") && !text_of("wiki").contains("mira-secret"));
        assert!(!text_of("my_srv").contains("secret"));
        assert!(!format!("{a:?}").contains("secret"));
        let c = codex_sources(Some(&launch("C:\\Notes")));
        let table = |k: &str| c.mcp_servers[k].to_string();
        assert!(table("mira").contains("mira-secret") && !table("mira").contains("wiki-secret"));
        assert!(table("wiki").contains("wiki-secret") && !table("wiki").contains("mira-secret"));
        assert!(!format!("{c:?}").contains("secret"));
    }

    fn request(kind: &str, name: &str, path: Option<&str>) -> PermissionRequest {
        // Same shape the session builds from `session/request_permission`.
        parse_request(&json!({
            "toolCall": {
                "toolCallId": "t-1", "name": name, "kind": kind, "title": name,
                "locations": path.map(|p| json!([{ "path": p }])).unwrap_or(json!([])),
            },
            "options": [
                { "optionId": "allow", "name": "Allow", "kind": "allow_once" },
                { "optionId": "reject", "name": "Reject", "kind": "reject_once" },
            ],
        }))
    }

    #[test]
    fn the_acp_policy_allows_allowed_tools_and_notes_reads_only() {
        let root = std::env::temp_dir().join(format!("nexq-convert-{}", std::process::id()));
        let notes = root.join("notes");
        std::fs::create_dir_all(&notes).unwrap();
        std::fs::write(notes.join("a.md"), "a").unwrap();
        let notes = std::fs::canonicalize(&notes).unwrap();
        let notes_plain = PathBuf::from(notes.to_string_lossy().trim_start_matches(r"\\?\").to_string());
        let a = acp_sources(Some(&launch(&notes_plain.to_string_lossy())));
        let allowed = |r: &PermissionRequest| decide(r, &a.policy).is_allow(r);
        assert!(allowed(&request("read", "read_file", Some(&notes_plain.join("a.md").to_string_lossy()))));
        assert!(!allowed(&request("read", "read_file", Some(&root.join("x.md").to_string_lossy()))));
        assert!(allowed(&request("other", "mcp_mira_kb_search", None)));
        // Denied tools are refused, even one that is also in the allow list.
        assert!(!allowed(&request("other", "mcp_mira_send_mail", None)));
        assert!(!allowed(&request("other", "mcp_mira_kb_read", None)));
        // A whole-server rule, a server with an underscore in its key, an unknown tool.
        assert!(allowed(&request("other", "mcp_wiki_anything", None)));
        assert!(allowed(&request("other", "mcp_my_srv_do_it", None)));
        assert!(!allowed(&request("other", "mcp_mira_other_tool", None)));
        assert!(!allowed(&request("execute", "run_command", None)));
        // A plain session allows nothing at all.
        let none = acp_sources(None);
        assert!(none.mcp_servers.is_empty() && none.additional_dirs.is_empty());
        assert!(!decide(&request("other", "mcp_mira_kb_search", None), &none.policy).is_allow(&request("other", "mcp_mira_kb_search", None)));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn codex_tables_enforce_the_allowed_tools_themselves() {
        let c = codex_sources(Some(&launch("C:\\Notes")));
        let mira = &c.mcp_servers["mira"];
        assert_eq!(mira["command"], "node");
        assert_eq!(mira["args"], json!(["s.js", "--x"]));
        assert_eq!(mira["env"]["API_KEY"], "mira-secret");
        // kb_read is both allowed and denied: denied wins everywhere.
        assert_eq!(mira["enabled_tools"], json!(["kb_search"]));
        assert_eq!(mira["disabled_tools"], json!(["send_mail", "kb_read"]));
        assert_eq!(mira["tool_timeout_sec"], 20);
        assert_eq!(mira["startup_timeout_sec"], 20);
        // A whole-server rule: no enabled_tools list.
        let wiki = &c.mcp_servers["wiki"];
        assert_eq!(wiki["url"], "https://wiki.test/mcp");
        assert_eq!(wiki["http_headers"]["Authorization"], "Bearer wiki-secret");
        assert!(wiki.get("enabled_tools").is_none() && wiki.get("command").is_none());
        // Underscored key.
        assert_eq!(c.mcp_servers["my_srv"]["enabled_tools"], json!(["do_it"]));
        // A server with nothing allowed gets an empty list: no tool at all.
        let mut none_allowed = launch("C:\\Notes");
        none_allowed.allowed_tools.retain(|t| !t.starts_with("mcp__my_srv"));
        let c2 = codex_sources(Some(&none_allowed));
        assert_eq!(c2.mcp_servers["my_srv"]["enabled_tools"], json!([]));
    }

    #[test]
    fn the_codex_policy_and_folders() {
        let c = codex_sources(Some(&launch("C:\\Notes")));
        assert_eq!(c.readable_dirs, vec![PathBuf::from("C:\\Notes")]);
        let tools = &c.policy.allowed_tools;
        assert!(tools.contains("mcp__mira__kb_search"));
        assert!(!tools.contains("mcp__mira__kb_read"), "denied");
        assert!(!tools.contains("mcp__mira__send_mail"));
        assert!(tools.contains("mcp__wiki__*"));
        assert!(tools.contains("mcp__my_srv__do_it"));
        // The built-in Claude tool names are not MCP tools.
        assert!(!tools.iter().any(|t| t == "Read" || t.starts_with("Read(")));
        // A plain session: nothing.
        let none = codex_sources(None);
        assert!(none.mcp_servers.is_empty() && none.readable_dirs.is_empty() && none.policy.allowed_tools.is_empty());
    }

    #[test]
    fn a_check_launch_timeout_becomes_seconds() {
        let mut l = launch("C:\\Notes");
        l.mcp_startup_timeout_ms = Some(60_000);
        assert_eq!(codex_sources(Some(&l)).mcp_servers["mira"]["startup_timeout_sec"], 60);
        l.mcp_startup_timeout_ms = Some(1_500);
        assert_eq!(codex_sources(Some(&l)).mcp_servers["mira"]["startup_timeout_sec"], 2);
    }

    #[test]
    fn a_launch_without_servers_or_with_bad_json_converts_to_nothing_but_folders() {
        let l = SourcesLaunch { add_dirs: vec![PathBuf::from("C:\\Notes")], ..Default::default() };
        let a = acp_sources(Some(&l));
        assert!(a.mcp_servers.is_empty());
        assert_eq!(a.additional_dirs.len(), 1);
        let bad = SourcesLaunch { mcp_config_json: Some("{not json".into()), ..Default::default() };
        assert!(acp_sources(Some(&bad)).mcp_servers.is_empty());
        assert!(codex_sources(Some(&bad)).mcp_servers.is_empty());
    }

    #[test]
    fn tool_names_split_on_the_longest_matching_key() {
        let keys = vec!["a".to_string(), "a__b".to_string()];
        assert_eq!(split_tool("mcp__a__b__tool", &keys), Some(("a__b", "tool")));
        assert_eq!(split_tool("mcp__a__tool", &keys), Some(("a", "tool")));
        assert_eq!(split_tool("mcp__z__tool", &keys), None);
        assert_eq!(split_tool("Read", &keys), None);
        assert_eq!(split_tool("mcp__a__", &keys), None);
    }
}
