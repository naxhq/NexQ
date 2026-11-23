//! What NexQ lets a Codex session do when the app-server asks.
//!
//! Pure decisions: the session's reader thread calls [`decide`] for every
//! [`ServerRequest`] and answers at once, so a turn can never stall on an
//! approval nobody sees.
//!
//! A Codex session has no shell and no file tools to use: the shell tool is
//! switched off at launch (`launch.rs`), and the notes folders are served by
//! NexQ's own read-only MCP server (`nexq_notes`, see `notes_mcp`). So the
//! rules are short:
//!
//! - Commands, file changes, extra permissions (and the legacy
//!   `execCommandApproval` / `applyPatchApproval`, which carry an argv or a
//!   patch NexQ does not look at): always refused. NexQ no longer judges
//!   command strings. The session also treats the start of a command or file
//!   change item as a breach and ends (see `session.rs`).
//! - MCP tool calls (an elicitation that names the tool): allowed only for
//!   tools in the allowed set, which holds `nexq_notes`' three and the tools the
//!   user allowed.
//! - Everything else (questions to the user, dynamic tools, token refresh):
//!   refused.

use super::protocol::ServerRequest;
use serde_json::Value;
use std::collections::HashSet;

/// The session's approval policy.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CodexPolicy {
    /// MCP tools a call may use, as `mcp__<server key>__<tool>` (the names the
    /// Claude sessions use) or `mcp__<server key>__*` for a whole server.
    pub allowed_tools: HashSet<String>,
}

/// The answer to one request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Allow,
    Deny(&'static str),
}

impl Verdict {
    pub fn is_allow(&self) -> bool {
        matches!(self, Verdict::Allow)
    }
}

/// Decide `req`.
pub fn decide(req: &ServerRequest, policy: &CodexPolicy) -> Verdict {
    match req {
        ServerRequest::CommandApproval { .. } => Verdict::Deny("commands are not allowed"),
        ServerRequest::FileChangeApproval { .. } => Verdict::Deny("file changes are not allowed"),
        ServerRequest::PermissionsApproval => Verdict::Deny("extra permissions are not allowed"),
        ServerRequest::McpElicitation { server, message, meta } => decide_mcp(server, message, meta, policy),
        ServerRequest::UserInput => Verdict::Deny("no one to ask"),
        ServerRequest::DynamicToolCall => Verdict::Deny("no client tools"),
        ServerRequest::AuthTokensRefresh => Verdict::Deny("NexQ does not manage Codex sign-in"),
        ServerRequest::Unknown { .. } => Verdict::Deny("unknown request"),
    }
}

/// Is `mcp__<server>__<tool>` (or the whole server) in the allowed set?
pub fn tool_allowed(allowed: &HashSet<String>, server: &str, tool: &str) -> bool {
    !server.is_empty()
        && !tool.is_empty()
        && (allowed.contains(&format!("mcp__{server}__{tool}")) || allowed.contains(&format!("mcp__{server}__*")))
}

/// Codex asks before an MCP tool call through an elicitation whose `_meta`
/// says `codex_approval_kind: "mcp_tool_call"`; the tool is named in the
/// message (`Allow the <server> MCP server to run tool "<tool>"?`) and in
/// `_meta.tool_title`. Anything that does not clearly name an allowed tool of
/// the asking server is refused (a form from a server is never answered).
fn decide_mcp(server: &str, message: &str, meta: &Value, policy: &CodexPolicy) -> Verdict {
    if meta.get("codex_approval_kind").and_then(Value::as_str) != Some("mcp_tool_call") {
        return Verdict::Deny("not a tool approval");
    }
    let mut candidates: Vec<String> = Vec::new();
    for key in ["tool_name", "tool", "tool_title"] {
        if let Some(name) = meta.get(key).and_then(Value::as_str) {
            candidates.push(name.to_string());
        }
    }
    candidates.extend(quoted(message));
    if candidates.iter().any(|tool| tool_allowed(&policy.allowed_tools, server, tool)) {
        Verdict::Allow
    } else {
        Verdict::Deny("tool not allowed")
    }
}

/// The `"..."` substrings of `text`.
fn quoted(text: &str) -> Vec<String> {
    text.split('"').skip(1).step_by(2).map(str::to_string).filter(|s| !s.is_empty()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::cli_agent::codex::protocol::CommandAction;
    use serde_json::json;

    fn elicitation(server: &str, message: &str, meta: Value) -> ServerRequest {
        ServerRequest::McpElicitation { server: server.into(), message: message.into(), meta }
    }

    fn policy(tools: &[&str]) -> CodexPolicy {
        CodexPolicy { allowed_tools: tools.iter().map(|t| t.to_string()).collect() }
    }

    fn verdict(req: &ServerRequest, p: &CodexPolicy) -> Verdict {
        decide(req, p)
    }

    fn tool_approval(server: &str, tool: &str) -> ServerRequest {
        elicitation(
            server,
            &format!("Allow the {server} MCP server to run tool \"{tool}\"?"),
            json!({ "codex_approval_kind": "mcp_tool_call", "tool_title": tool }),
        )
    }

    #[test]
    fn every_command_is_refused_however_harmless_it_looks() {
        // Even with every tool allowed, and with a classification that says "read".
        let everything = policy(&["mcp__nexq_notes__read_note", "mcp__mira__*"]);
        for legacy in [false, true] {
            for (command, actions) in [
                ("type D:\\notes\\a.md", vec![CommandAction::Read { path: "D:\\notes\\a.md".into() }]),
                ("rg falcon D:\\notes", vec![CommandAction::Search { query: Some("falcon".into()), path: None }]),
                ("dir D:\\notes", vec![CommandAction::ListFiles { path: Some("D:\\notes".into()) }]),
                ("powershell -Command Remove-Item x", vec![CommandAction::Unknown]),
                ("", vec![]),
            ] {
                let req = ServerRequest::CommandApproval {
                    legacy,
                    command: command.into(),
                    cwd: Some("C:\\sandbox".into()),
                    actions,
                };
                assert_eq!(verdict(&req, &everything), Verdict::Deny("commands are not allowed"), "{command}");
            }
        }
    }

    #[test]
    fn file_changes_permissions_and_questions_are_always_refused() {
        let policy = policy(&["mcp__mira__*"]);
        for req in [
            ServerRequest::FileChangeApproval { legacy: false },
            ServerRequest::FileChangeApproval { legacy: true },
            ServerRequest::PermissionsApproval,
            ServerRequest::UserInput,
            ServerRequest::DynamicToolCall,
            ServerRequest::AuthTokensRefresh,
            ServerRequest::Unknown { method: "x".into() },
        ] {
            assert!(!verdict(&req, &policy).is_allow(), "{req:?}");
        }
    }

    #[test]
    fn an_allowed_mcp_tool_is_approved() {
        let req = tool_approval("mira", "kb_search");
        assert_eq!(verdict(&req, &policy(&["mcp__mira__kb_search"])), Verdict::Allow);
        // A whole server.
        assert_eq!(verdict(&req, &policy(&["mcp__mira__*"])), Verdict::Allow);
        // The notes server's tools.
        let notes = policy(&["mcp__nexq_notes__list_notes", "mcp__nexq_notes__search_notes", "mcp__nexq_notes__read_note"]);
        for tool in ["list_notes", "search_notes", "read_note"] {
            assert_eq!(verdict(&tool_approval("nexq_notes", tool), &notes), Verdict::Allow, "{tool}");
        }
        assert!(!verdict(&tool_approval("nexq_notes", "write_note"), &notes).is_allow());
    }

    #[test]
    fn a_tool_that_is_not_allowed_is_refused() {
        let req = tool_approval("mira", "send_mail");
        assert!(!verdict(&req, &policy(&["mcp__mira__kb_search", "mcp__other__*"])).is_allow());
        assert!(!verdict(&req, &CodexPolicy::default()).is_allow());
    }

    #[test]
    fn the_allowed_tool_must_belong_to_the_asking_server() {
        let req = elicitation(
            "evil",
            "Allow the evil MCP server to run tool \"kb_search\"?",
            json!({ "codex_approval_kind": "mcp_tool_call" }),
        );
        assert!(!verdict(&req, &policy(&["mcp__mira__kb_search"])).is_allow());
        // Nor can a server called like ours borrow our tools.
        assert!(!verdict(&tool_approval("nexq", "notes__read_note"), &policy(&["mcp__nexq_notes__read_note"])).is_allow());
    }

    #[test]
    fn a_form_from_a_server_is_never_answered() {
        let req = elicitation("mira", "Please enter your password", json!({}));
        assert!(!verdict(&req, &policy(&["mcp__mira__*"])).is_allow());
        let other_kind = elicitation("mira", "\"kb_search\"", json!({ "codex_approval_kind": "something_else" }));
        assert!(!verdict(&other_kind, &policy(&["mcp__mira__*"])).is_allow());
    }

    #[test]
    fn no_tool_name_means_no() {
        let req = elicitation("mira", "Allow it?", json!({ "codex_approval_kind": "mcp_tool_call" }));
        assert!(!verdict(&req, &policy(&["mcp__mira__*"])).is_allow());
    }
}
