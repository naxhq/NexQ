//! Turning a [`SourcesLaunch`] (built once for every CLI by
//! `sources::launch::build_sources_launch`, in Claude's terms: an mcp-config
//! JSON text, `--add-dir` folders, `mcp__<server>__<tool>` allow and deny
//! lists) into what Antigravity (ACP) and Codex take.
//!
//! Neither of them is given a folder to read or a file tool to read it with.
//! The notes folders become NexQ's own read-only MCP server (`nexq_notes`, see
//! `notes_mcp`: `nexq.exe --notes-mcp`), which opens every file itself. What
//! each CLI gets:
//!
//! - Antigravity: `session/new`'s `mcpServers` (stdio
//!   `{name, command, args, env: [{name, value}]}`, http
//!   `{type: "http", name, url, headers: [{name, value}]}`) and a
//!   [`PermissionPolicy`] that allows only MCP tools: `nexq_notes`' three and
//!   the user's allowed ones.
//! - Codex: one config table per server (sent in `thread/start`'s `config`,
//!   never on the command line) and a [`CodexPolicy`]. The allowed tools are
//!   also enforced by the server's own `enabled_tools` (a tool outside it is
//!   not even offered), and the denied ones by `disabled_tools`, on top of the
//!   approval decision.
//!
//! Secrets: each server's own values travel only in that server's entry. The
//! outputs hold them, so none of these types is ever logged (the launch types
//! redact them in `Debug`).

use super::acp::permission::{McpToolRule, PermissionPolicy};
use super::codex::policy::CodexPolicy;
use super::command::SourcesLaunch;
use crate::notes_mcp::{server_command, SERVER_KEY as NOTES_SERVER, TOOLS as NOTES_TOOLS};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::path::Path;

/// How long one MCP tool call may take for Codex (`tool_timeout_sec`), like
/// Claude's `MCP_TOOL_TIMEOUT`.
const CODEX_TOOL_TIMEOUT_SEC: u64 = 20;
/// Codex's MCP startup limit when the launch names none, like `MCP_TIMEOUT`.
const CODEX_STARTUP_TIMEOUT_SEC: u64 = 20;

/// Server keys a user server may not take: `nexq_notes` is ours, and `nexq`
/// could name a tool that Antigravity's `mcp_<server>_<tool>` spelling makes
/// look like one of ours (`mcp_nexq_notes_read_note`).
const RESERVED_KEYS: [&str; 2] = [NOTES_SERVER, "nexq"];

/// `(server key, entry)` of every user server in the launch's mcp-config JSON,
/// in the file's order (the entry is `{command, args, env}` or
/// `{type, url, headers}`), then NexQ's notes server when the launch has notes
/// folders and `exe` (this program) is known.
fn config_entries(launch: &SourcesLaunch, exe: Option<&Path>) -> Vec<(String, Value)> {
    let mut entries: Vec<(String, Value)> = launch
        .mcp_config_json
        .as_deref()
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .and_then(|config| {
            config["mcpServers"].as_object().map(|servers| {
                servers
                    .iter()
                    .filter(|(k, _)| !RESERVED_KEYS.contains(&k.as_str()))
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect()
            })
        })
        .unwrap_or_default();
    if !launch.add_dirs.is_empty() {
        match exe {
            Some(exe) => entries.push((NOTES_SERVER.to_string(), server_command(exe, &launch.add_dirs))),
            None => log::warn!("cannot find the NexQ program: the notes folders are not served"),
        }
    }
    entries
}

/// The notes server's tools as allowed tools (`mcp__nexq_notes__<tool>`).
fn notes_tool_names() -> Vec<String> {
    NOTES_TOOLS.iter().map(|t| format!("mcp__{NOTES_SERVER}__{t}")).collect()
}

/// What a session that has notes folders is told about them: the Claude text
/// from `sources::launch::sources_system_prompt` names Claude's file tools,
/// which these CLIs do not have.
pub fn adapt_system_prompt(prompt: &str, has_notes: bool) -> String {
    let prompt = if has_notes {
        prompt.replace(
            crate::sources::launch::NOTES_TOOLS_HINT,
            "read-only; use the list_notes, search_notes and read_note tools, which are the only way to read them",
        )
    } else {
        prompt.to_string()
    };
    // The CLI's own tools (web search, file and shell tools) are refused, and
    // one the CLI runs without asking ends the session, losing the answer.
    format!("{prompt}\n\n{TOOL_RULE}")
}

/// Appended to every Antigravity and Codex session prompt.
pub const TOOL_RULE: &str = "Never search the web, run commands, or read or write files with your own tools. \
Answer from the conversation, and use only the MCP tools you are given.";

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
    /// `session/new`'s `mcpServers`, `nexq_notes` included. Hold secrets.
    pub mcp_servers: Vec<Value>,
    pub policy: PermissionPolicy,
}

impl std::fmt::Debug for AcpSources {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AcpSources")
            .field("mcp_servers", &format_args!("<redacted, {}>", self.mcp_servers.len()))
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
    acp_sources_for(launch, std::env::current_exe().ok().as_deref())
}

/// [`acp_sources`] for a given NexQ program (the notes server's command).
pub fn acp_sources_for(launch: Option<&SourcesLaunch>, exe: Option<&Path>) -> AcpSources {
    let Some(launch) = launch else {
        return AcpSources { policy: PermissionPolicy::deny_all(), ..Default::default() };
    };
    let entries = config_entries(launch, exe);
    let keys: Vec<String> = entries.iter().map(|(k, _)| k.clone()).collect();
    let rule = |(key, tool): (String, String)| {
        if tool == "*" {
            McpToolRule::whole_server(&key)
        } else {
            McpToolRule::tool(&key, &tool)
        }
    };
    let mut allowed_names = launch.allowed_tools.clone();
    if keys.iter().any(|k| k == NOTES_SERVER) {
        allowed_names.extend(notes_tool_names());
    }
    let allow = tools_by_server(&allowed_names, &keys).into_iter().map(rule).collect();
    let deny = tools_by_server(&launch.disallowed_tools, &keys).into_iter().map(rule).collect();
    AcpSources {
        mcp_servers: entries.iter().filter_map(|(k, e)| acp_server(k, e)).collect(),
        policy: PermissionPolicy::new(allow, deny),
    }
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

/// What a Codex session is given for its sources.
#[derive(Clone, Default)]
pub struct CodexSources {
    /// Server key -> its Codex config table (for `thread/start`'s `config`),
    /// `nexq_notes` included. Hold secrets.
    pub mcp_servers: Map<String, Value>,
    /// Does the session have notes folders (served by `nexq_notes`)?
    pub has_notes: bool,
    pub policy: CodexPolicy,
}

impl std::fmt::Debug for CodexSources {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CodexSources")
            .field("mcp_servers", &format_args!("<redacted, {}>", self.mcp_servers.len()))
            .field("has_notes", &self.has_notes)
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
    codex_sources_for(launch, std::env::current_exe().ok().as_deref())
}

/// [`codex_sources`] for a given NexQ program (the notes server's command).
pub fn codex_sources_for(launch: Option<&SourcesLaunch>, exe: Option<&Path>) -> CodexSources {
    let Some(launch) = launch else { return CodexSources::default() };
    let entries = config_entries(launch, exe);
    let keys: Vec<String> = entries.iter().map(|(k, _)| k.clone()).collect();
    let mut allowed_names = launch.allowed_tools.clone();
    let has_notes = keys.iter().any(|k| k == NOTES_SERVER);
    if has_notes {
        allowed_names.extend(notes_tool_names());
    }
    let allowed = tools_by_server(&allowed_names, &keys);
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
    CodexSources { mcp_servers: servers, has_notes, policy: CodexPolicy { allowed_tools: policy_tools, ..Default::default() } }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::cli_agent::acp::permission::{decide, parse_request, PermissionRequest};
    use std::path::PathBuf;

    const EXE: &str = "C:\\Program Files\\NexQ\\nexq.exe";

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

    fn acp(l: &SourcesLaunch) -> AcpSources {
        acp_sources_for(Some(l), Some(Path::new(EXE)))
    }

    fn codex(l: &SourcesLaunch) -> CodexSources {
        codex_sources_for(Some(l), Some(Path::new(EXE)))
    }

    #[test]
    fn acp_servers_use_the_acp_shapes() {
        let a = acp(&launch("C:\\Notes"));
        assert_eq!(a.mcp_servers.len(), 4);
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
    }

    #[test]
    fn the_notes_folders_become_the_notes_server_for_both_clis() {
        let l = launch("C:\\My Notes");
        let a = acp(&l);
        let notes = a.mcp_servers.iter().find(|s| s["name"] == "nexq_notes").expect("notes server");
        assert_eq!(notes["command"], EXE);
        assert_eq!(notes["args"], json!(["--notes-mcp"]));
        assert_eq!(notes["env"][0]["name"], "NEXQ_NOTES_DIRS");
        let dirs: Vec<String> = serde_json::from_str(notes["env"][0]["value"].as_str().unwrap()).unwrap();
        assert_eq!(dirs, ["C:\\My Notes"]);
        let c = codex(&l);
        let table = &c.mcp_servers["nexq_notes"];
        assert_eq!(table["command"], EXE);
        assert_eq!(table["args"], json!(["--notes-mcp"]));
        assert_eq!(table["env"]["NEXQ_NOTES_DIRS"], notes["env"][0]["value"]);
        assert_eq!(table["enabled_tools"], json!(["list_notes", "search_notes", "read_note"]));
        assert!(c.has_notes);
        for tool in ["list_notes", "search_notes", "read_note"] {
            assert!(c.policy.allowed_tools.contains(&format!("mcp__nexq_notes__{tool}")), "{tool}");
        }
        // No notes folder, no notes server. Servers alone are not notes.
        let mut none = launch("C:\\Notes");
        none.add_dirs.clear();
        assert!(!acp(&none).mcp_servers.iter().any(|s| s["name"] == "nexq_notes"));
        assert!(!codex(&none).mcp_servers.contains_key("nexq_notes") && !codex(&none).has_notes);
        // Without a known program there is nothing to start.
        assert!(!acp_sources_for(Some(&l), None).mcp_servers.iter().any(|s| s["name"] == "nexq_notes"));
    }

    #[test]
    fn a_user_server_cannot_take_the_notes_servers_name() {
        let config = json!({ "mcpServers": {
            "nexq_notes": { "command": "evil" },
            "nexq": { "command": "evil2" },
            "mira": { "command": "node" },
        }});
        let l = SourcesLaunch {
            add_dirs: vec![PathBuf::from("C:\\Notes")],
            mcp_config_json: Some(config.to_string()),
            allowed_tools: vec!["mcp__nexq__notes_read_note".into()],
            ..Default::default()
        };
        let a = acp(&l);
        let names: Vec<&str> = a.mcp_servers.iter().map(|s| s["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["mira", "nexq_notes"]);
        assert_eq!(a.mcp_servers[1]["command"], EXE, "the real notes server, not the user's");
        assert!(!acp_allows(&a, "mcp_nexq_notes_write_note"));
        assert!(!acp_allows(&a, "mcp_nexq_notes_read_note_extra"));
        assert!(!codex(&l).mcp_servers.contains_key("nexq"));
    }

    #[test]
    fn secrets_stay_with_their_own_server_and_out_of_debug() {
        let a = acp(&launch("C:\\Notes"));
        let text_of = |name: &str| a.mcp_servers.iter().find(|s| s["name"] == name).unwrap().to_string();
        assert!(text_of("mira").contains("mira-secret") && !text_of("mira").contains("wiki-secret"));
        assert!(text_of("wiki").contains("wiki-secret") && !text_of("wiki").contains("mira-secret"));
        assert!(!text_of("my_srv").contains("secret"));
        assert!(!format!("{a:?}").contains("secret"));
        let c = codex(&launch("C:\\Notes"));
        let table = |k: &str| c.mcp_servers[k].to_string();
        assert!(table("mira").contains("mira-secret") && !table("mira").contains("wiki-secret"));
        assert!(table("wiki").contains("wiki-secret") && !table("wiki").contains("mira-secret"));
        assert!(!format!("{c:?}").contains("secret"));
    }

    fn request(kind: &str, name: &str) -> PermissionRequest {
        // Same shape the session builds from `session/request_permission`.
        parse_request(&json!({
            "toolCall": { "toolCallId": "t-1", "name": name, "kind": kind, "title": name },
            "options": [
                { "optionId": "allow", "name": "Allow", "kind": "allow_once" },
                { "optionId": "reject", "name": "Reject", "kind": "reject_once" },
            ],
        }))
    }

    fn acp_allows(a: &AcpSources, tool: &str) -> bool {
        let r = request("other", tool);
        decide(&r, &a.policy).is_allow(&r)
    }

    #[test]
    fn the_acp_policy_allows_the_notes_tools_and_the_allowed_tools_only() {
        let a = acp(&launch("C:\\Notes"));
        for tool in ["list_notes", "search_notes", "read_note"] {
            assert!(acp_allows(&a, &format!("mcp_nexq_notes_{tool}")), "{tool}");
        }
        assert!(!acp_allows(&a, "mcp_nexq_notes_write_note"));
        assert!(acp_allows(&a, "mcp_mira_kb_search"));
        // Denied tools are refused, even one that is also in the allow list.
        assert!(!acp_allows(&a, "mcp_mira_send_mail"));
        assert!(!acp_allows(&a, "mcp_mira_kb_read"));
        // A whole-server rule, a server with an underscore in its key, an unknown tool.
        assert!(acp_allows(&a, "mcp_wiki_anything"));
        assert!(acp_allows(&a, "mcp_my_srv_do_it"));
        assert!(!acp_allows(&a, "mcp_mira_other_tool"));
        // The built-in tools are never allowed, whatever they are called or ask for.
        for (kind, name) in [("read", "read_file"), ("execute", "run_command"), ("search", "grep_search"), ("edit", "write_file")] {
            let r = request(kind, name);
            assert!(!decide(&r, &a.policy).is_allow(&r), "{name}");
        }
        // A plain session allows nothing at all and has no servers.
        let none = acp_sources(None);
        assert!(none.mcp_servers.is_empty());
        assert!(!acp_allows(&none, "mcp_mira_kb_search") && !acp_allows(&none, "mcp_nexq_notes_read_note"));
    }

    #[test]
    fn codex_tables_enforce_the_allowed_tools_themselves() {
        let c = codex(&launch("C:\\Notes"));
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
        let c2 = codex(&none_allowed);
        assert_eq!(c2.mcp_servers["my_srv"]["enabled_tools"], json!([]));
    }

    #[test]
    fn the_codex_policy_allows_mcp_tools_only() {
        let c = codex(&launch("C:\\Notes"));
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
        assert!(none.mcp_servers.is_empty() && !none.has_notes && none.policy.allowed_tools.is_empty());
    }

    #[test]
    fn a_check_launch_timeout_becomes_seconds() {
        let mut l = launch("C:\\Notes");
        l.mcp_startup_timeout_ms = Some(60_000);
        assert_eq!(codex(&l).mcp_servers["mira"]["startup_timeout_sec"], 60);
        l.mcp_startup_timeout_ms = Some(1_500);
        assert_eq!(codex(&l).mcp_servers["mira"]["startup_timeout_sec"], 2);
    }

    #[test]
    fn a_launch_without_servers_or_with_bad_json_converts_to_the_notes_server_only() {
        let l = SourcesLaunch { add_dirs: vec![PathBuf::from("C:\\Notes")], ..Default::default() };
        let a = acp(&l);
        assert_eq!(a.mcp_servers.len(), 1);
        assert_eq!(a.mcp_servers[0]["name"], "nexq_notes");
        let bad = SourcesLaunch { mcp_config_json: Some("{not json".into()), ..Default::default() };
        assert!(acp(&bad).mcp_servers.is_empty());
        assert!(codex(&bad).mcp_servers.is_empty());
    }

    #[test]
    fn the_prompt_names_the_notes_tools_instead_of_claudes_file_tools() {
        let folder = crate::sources::config::NotesFolder { id: "n".into(), label: "Notes".into(), path: "C:\\Notes".into(), enabled: true };
        let text = crate::sources::launch::sources_system_prompt(&[&folder], &[]);
        assert!(text.contains("Grep"), "Claude's wording: {text}");
        let adapted = adapt_system_prompt(&text, true);
        assert!(adapted.contains("list_notes, search_notes and read_note") && !adapted.contains("Grep"), "{adapted}");
        assert!(adapted.ends_with(TOOL_RULE));
        assert_eq!(adapt_system_prompt(&text, false), format!("{text}\n\n{TOOL_RULE}"));
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
