//! Answering `session/request_permission`: a pure policy with one rule.
//!
//! An Antigravity session has no file tools of its own to use: the notes are
//! served by NexQ's `nexq_notes` MCP server (see `notes_mcp`), and its working
//! directory is an empty folder. So a request is allowed only when it is a call
//! of an MCP tool the policy names, `nexq_notes`' three read-only tools and
//! the MCP tools the user allowed (and not one the user switched off).
//! Everything else is rejected whatever its kind, name or arguments (a shell
//! command, a read, a search, an edit, a fetch): NexQ no longer tries to judge
//! command strings or file paths. A request gets the reject option, or
//! `cancelled` when the agent offered none.
//!
//! The session also watches what actually runs (`session.rs`): a tool call that
//! completes without NexQ having allowed it ends the session.

use serde_json::{json, Value};

/// One allowed (or denied) MCP tool: `tool == None` means every tool of `server`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpToolRule {
    /// The server key (the `name` NexQ gave it in `session/new`).
    pub server: String,
    pub tool: Option<String>,
}

impl McpToolRule {
    pub fn tool(server: &str, tool: &str) -> Self {
        Self { server: server.to_string(), tool: Some(tool.to_string()) }
    }

    pub fn whole_server(server: &str) -> Self {
        Self { server: server.to_string(), tool: None }
    }

    /// Does the agent's tool `name` (`mcp_<server>_<tool>`, which
    /// Antigravity uses; `mcp__<server>__<tool>` and
    /// `<server>__<tool>` are accepted too) name a tool this rule covers?
    pub fn matches(&self, name: &str) -> bool {
        let s = &self.server;
        [format!("mcp_{s}_"), format!("mcp__{s}__"), format!("{s}__")]
            .iter()
            .filter_map(|prefix| name.strip_prefix(prefix.as_str()))
            .any(|rest| match &self.tool {
                Some(tool) => rest == tool,
                None => !rest.is_empty(),
            })
    }
}

/// Which MCP tools may run.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PermissionPolicy {
    allow_mcp: Vec<McpToolRule>,
    deny_mcp: Vec<McpToolRule>,
}

impl PermissionPolicy {
    /// `allow_mcp`/`deny_mcp`: tool rules; a denied tool is refused even when
    /// a rule allows it.
    pub fn new(allow_mcp: Vec<McpToolRule>, deny_mcp: Vec<McpToolRule>) -> Self {
        Self { allow_mcp, deny_mcp }
    }

    /// A policy that allows nothing.
    pub fn deny_all() -> Self {
        Self::default()
    }

    fn mcp_allowed(&self, name: &str) -> bool {
        !self.deny_mcp.iter().any(|r| r.matches(name)) && self.allow_mcp.iter().any(|r| r.matches(name))
    }
}

// ---- the request ------------------------------------------------------

/// One option of a permission request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionOption {
    pub id: String,
    /// `allow_once`, `allow_always`, `reject_once`, `reject_always`.
    pub kind: String,
}

/// A parsed `session/request_permission`.
#[derive(Debug, Clone, PartialEq)]
pub struct PermissionRequest {
    /// The tool call this asks about (`toolCall.toolCallId`).
    pub tool_call_id: String,
    /// The agent's tool name (`read_file`, `run_command`, `mcp_srv_tool`, ...).
    pub tool_name: String,
    /// `read`, `search`, `edit`, `execute`, `fetch`, `other`, ... (lowercase).
    /// Only for the log: the decision does not look at it.
    pub kind: String,
    pub options: Vec<PermissionOption>,
}

/// Parse the params of `session/request_permission`.
pub fn parse_request(params: &Value) -> PermissionRequest {
    let info = super::protocol::parse_tool_call(&params["toolCall"]);
    let options = params["options"]
        .as_array()
        .map(|o| {
            o.iter()
                .filter_map(|o| {
                    Some(PermissionOption {
                        id: o["optionId"].as_str()?.to_string(),
                        kind: o["kind"].as_str().unwrap_or_default().to_lowercase(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    PermissionRequest { tool_call_id: info.id, tool_name: info.name, kind: info.kind, options }
}

// ---- the decision -----------------------------------------------------

/// What to answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Selected(String),
    Cancelled,
}

impl Outcome {
    /// The JSON-RPC `result` of the permission request.
    pub fn to_result(&self) -> Value {
        match self {
            Outcome::Selected(id) => json!({ "outcome": { "outcome": "selected", "optionId": id } }),
            Outcome::Cancelled => json!({ "outcome": { "outcome": "cancelled" } }),
        }
    }

    pub fn is_allow(&self, req: &PermissionRequest) -> bool {
        match self {
            Outcome::Selected(id) => req.options.iter().any(|o| &o.id == id && o.kind.starts_with("allow")),
            Outcome::Cancelled => false,
        }
    }
}

/// Is the call allowed by `policy` (ignoring which options the agent offered)?
pub fn is_allowed(req: &PermissionRequest, policy: &PermissionPolicy) -> bool {
    policy.mcp_allowed(&req.tool_name)
}

/// Allow with `allow_once` (never `allow_always`: that would make the agent
/// remember a grant NexQ did not give) when the policy allows the call; every
/// other call gets `reject_once`, else `reject_always`, else `cancelled`.
pub fn decide(req: &PermissionRequest, policy: &PermissionPolicy) -> Outcome {
    let find = |kind: &str| req.options.iter().find(|o| o.kind == kind).map(|o| o.id.clone());
    if is_allowed(req, policy) {
        if let Some(id) = find("allow_once") {
            return Outcome::Selected(id);
        }
    }
    match find("reject_once").or_else(|| find("reject_always")) {
        Some(id) => Outcome::Selected(id),
        None => Outcome::Cancelled,
    }
}

/// [`parse_request`] and [`decide`] in one step.
pub fn decide_params(params: &Value, policy: &PermissionPolicy) -> (PermissionRequest, Outcome) {
    let req = parse_request(params);
    let outcome = decide(&req, policy);
    (req, outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(pairs: &[(&str, &str)]) -> Value {
        Value::Array(pairs.iter().map(|(id, kind)| json!({"optionId": id, "name": id, "kind": kind})).collect())
    }

    fn req(kind: &str, name: &str, input: Value) -> PermissionRequest {
        parse_request(&json!({
            "sessionId": "s",
            "toolCall": { "toolCallId": "c1", "name": name, "kind": kind, "title": name, "rawInput": input },
            "options": options(&[("allow", "allow_once"), ("deny", "reject_once")]),
        }))
    }

    fn selected(o: &Outcome) -> &str {
        match o {
            Outcome::Selected(id) => id,
            Outcome::Cancelled => "<cancelled>",
        }
    }

    fn notes_policy() -> PermissionPolicy {
        PermissionPolicy::new(
            ["list_notes", "search_notes", "read_note"].iter().map(|t| McpToolRule::tool("nexq_notes", t)).collect(),
            vec![],
        )
    }

    #[test]
    fn the_notes_tools_are_allowed_and_nothing_else_of_theirs() {
        let p = notes_policy();
        for tool in ["list_notes", "search_notes", "read_note"] {
            let r = req("other", &format!("mcp_nexq_notes_{tool}"), json!({}));
            assert_eq!(selected(&decide(&r, &p)), "allow", "{tool}");
        }
        for name in ["mcp_nexq_notes_write_note", "mcp_nexq_notes_", "mcp_other_read_note", "read_note", "nexq_notes"] {
            assert_eq!(selected(&decide(&req("other", name, json!({})), &p)), "deny", "{name}");
        }
    }

    #[test]
    fn every_built_in_tool_is_rejected_whatever_its_kind_name_or_path() {
        let p = notes_policy();
        for (kind, name) in [
            ("read", "read_file"),
            ("search", "search_web"),
            ("search", "grep_search"),
            ("execute", "run_command"),
            ("edit", "write_file"),
            ("edit", "edit_file"),
            ("fetch", "read_url_content"),
            ("other", "browser_subagent"),
            ("other", "manage_task"),
            ("move", "rename"),
            ("delete", "delete_file"),
            ("think", "ask_question"),
            ("weird-kind", "whatever"),
        ] {
            let r = req(kind, name, json!({ "Path": "C:\\Notes\\a.md", "CommandLine": "echo hi" }));
            assert_eq!(selected(&decide(&r, &p)), "deny", "{kind} {name}");
        }
        // A read of a file in the (empty) working directory is rejected too.
        assert!(!is_allowed(&req("read", "read_file", json!({ "Path": "inside.txt" })), &p));
        // Nothing allowed: nothing runs.
        assert!(!is_allowed(&req("other", "mcp_nexq_notes_read_note", json!({})), &PermissionPolicy::deny_all()));
    }

    #[test]
    fn user_tools_follow_the_allow_and_deny_rules() {
        let p = PermissionPolicy::new(
            vec![McpToolRule::tool("mira", "kb_search"), McpToolRule::whole_server("wiki"), McpToolRule::tool("mira", "kb_read")],
            vec![McpToolRule::tool("mira", "kb_read")],
        );
        let ok = |name: &str| is_allowed(&req("other", name, json!({})), &p);
        assert!(ok("mcp_mira_kb_search"));
        assert!(ok("mcp__mira__kb_search") && ok("mira__kb_search"));
        assert!(ok("mcp_wiki_anything"));
        // Denied wins; another tool of the server; another server; an empty tool.
        assert!(!ok("mcp_mira_kb_read"));
        assert!(!ok("mcp_mira_send_mail"));
        assert!(!ok("mcp_evil_kb_search"));
        assert!(!ok("mcp_wiki_"));
        // Underscored keys.
        let q = PermissionPolicy::new(vec![McpToolRule::tool("my_srv", "do_it")], vec![]);
        assert!(is_allowed(&req("other", "mcp_my_srv_do_it", json!({})), &q));
    }

    #[test]
    fn captured_requests() {
        let p = notes_policy();
        let parse = |s: &str| -> Value { serde_json::from_str::<Value>(s).unwrap()["params"].clone() };
        let (r, o) = decide_params(&parse(include_str!("testdata/agy_permission_run_command.json")), &p);
        assert_eq!((r.kind.as_str(), r.tool_name.as_str()), ("execute", "run_command"));
        assert_eq!(selected(&o), "deny");
        let (r, o) = decide_params(&parse(include_str!("testdata/agy_permission_read_outside.json")), &p);
        assert_eq!(r.kind, "read");
        assert_eq!(selected(&o), "deny");
        // A captured MCP request: allowed when the policy names its server and tool.
        let fixture: Value = serde_json::from_str(include_str!("testdata/agy_permission_mcp.json")).unwrap();
        let mcp = PermissionPolicy::new(vec![McpToolRule::tool("probe-srv", "get_secret_word")], vec![]);
        let (r, o) = decide_params(&fixture["params"], &mcp);
        assert_eq!(r.tool_name, "mcp_probe-srv_get_secret_word");
        assert_eq!(r.tool_call_id, "call_3");
        assert!(o.is_allow(&r));
        assert!(!decide_params(&fixture["params"], &notes_policy()).1.is_allow(&r));
    }

    #[test]
    fn options_decide_the_reply() {
        let p = notes_policy();
        let with = |name: &str, pairs: &[(&str, &str)]| {
            let mut r = req("other", name, json!({}));
            r.options = pairs.iter().map(|(id, k)| PermissionOption { id: id.to_string(), kind: k.to_string() }).collect();
            decide(&r, &p)
        };
        let ours = "mcp_nexq_notes_read_note";
        // allow_once only: never allow_always.
        assert_eq!(with(ours, &[("a", "allow_always"), ("b", "allow_once")]), Outcome::Selected("b".into()));
        assert_eq!(with(ours, &[("a", "allow_always"), ("r", "reject_once")]), Outcome::Selected("r".into()));
        assert_eq!(with(ours, &[("a", "allow_always")]), Outcome::Cancelled);
        // Rejecting: reject_once first, reject_always next, else cancelled.
        assert_eq!(with("run_command", &[("y", "allow_once"), ("n", "reject_always"), ("m", "reject_once")]), Outcome::Selected("m".into()));
        assert_eq!(with("run_command", &[("y", "allow_once"), ("n", "reject_always")]), Outcome::Selected("n".into()));
        assert_eq!(with("run_command", &[("y", "allow_once"), ("a", "allow_always")]), Outcome::Cancelled);
        assert_eq!(with("run_command", &[]), Outcome::Cancelled);
        // The JSON-RPC result shapes.
        assert_eq!(Outcome::Selected("x".into()).to_result(), json!({"outcome": {"outcome": "selected", "optionId": "x"}}));
        assert_eq!(Outcome::Cancelled.to_result(), json!({"outcome": {"outcome": "cancelled"}}));
    }
}
