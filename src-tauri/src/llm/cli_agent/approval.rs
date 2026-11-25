//! Per-call tool approval for workspace chat (purpose Chat only).
//!
//! # Threat model
//!
//! **Assets.** What a tool can do for the user's accounts and data (send mail,
//! write notes, call APIs), the user's files outside the chat's folders, and
//! the user's secrets in tool arguments.
//!
//! **Attacker.** Anything that reaches the model or the CLI without the user
//! typing it: tool output, meeting transcripts and documents, the model's own
//! text, and MCP server metadata (tool names, titles, descriptions,
//! `annotations`, the text of an approval request). It can ask for any tool
//! call and can word a request to look harmless. It cannot click.
//!
//! **Guarantees** (each has a test, in `approval/tests.rs` unless noted):
//! 1. *Only the user approves.* A call that must ask runs only after
//!    `answer_workspace_approval(approval_id, true)` for its own, unguessable,
//!    still-open question. Nothing in a stream, a transcript or a tool result
//!    reaches the broker. Unknown, repeated, late and cancelled ids change
//!    nothing.
//! 2. *Default is deny.* Unknown tools, odd names (case, padding, aliases), a
//!    missing or repeated request id, unreadable parameters, a tool changed
//!    since it was listed, a request that cannot be matched to the call that is
//!    running, and anything asked while a turn is stopping or the session is
//!    closing, are refused. Shell, edit and web tools never run.
//! 3. *What runs is what was shown.* The arguments of the question are the
//!    call's own (Claude `updatedInput` is the asked `input`; Codex uses the
//!    started call's arguments; ACP `rawInput`). They are shown in full, or the
//!    call is refused when they exceed 100 KB.
//! 4. *Nothing is disguised.* Bidirectional overrides, zero-width and other
//!    invisible characters are written out as `\u{XXXX}`. Only short values
//!    under known secret key names are hidden, and visibly so.
//! 5. *No standing grants.* There is no "always allow": every call is decided
//!    alone, and ACP is only ever answered `allow_once`.
//! 6. *Server claims never widen anything.* `readOnlyHint` /
//!    `destructiveHint` can only let a tool the user already allowed run
//!    without a question (with a read-like name), never allow a tool the user
//!    did not allow. They are read fresh by each check, forgotten when the
//!    server's command, arguments, URL or environment changes, and a missing
//!    hint means ask.
//! 7. *Closing leaves nothing open.* A cancel, a stopped turn, a closed or
//!    reaped session, a deleted chat and app exit refuse every open and queued
//!    question; an answer to a question whose turn has ended is ignored.
//! 8. *A CLI that cannot ask never runs a tool that would ask*; this is
//!    enforced when the session is launched, not only by the caller.
//!
//! Live, notes, brief and past-meeting sessions never ask: they run exactly as
//! before (`--permission-prompts none`, fixed allow lists). Only a session of
//! `SessionScope::Workspace` that was given a [`ChatApprovals`] can ask.
//!
//! Three parts:
//!
//! 1. [`ApprovalPolicy`]: a pure decision per tool call, [`ToolVerdict`]
//!    `Allow` (run), `Ask` (the user decides, per call) or `Deny`.
//!    - An MCP tool runs by itself only when the user allowed it AND the server
//!      marked it read-only (`readOnlyHint`) AND its name is not write-like
//!      AND it is not marked destructive. Every other allowed tool asks. A tool
//!      the user did not allow is denied. A missing hint means ask.
//!    - Built-in `Read`, `Grep` and `Glob` run only on paths inside the chat's
//!      scope folders; anything else, and every shell, edit and web tool, is
//!      denied. There is no "always allow": every call is decided alone.
//! 2. [`ApprovalBroker`] / [`WorkspaceApprovals`]: asks the UI (event
//!    `workspace_chat_approval`), one question at a time per chat, and turns
//!    the click (command `answer_workspace_approval`) into a bool. A timeout
//!    (60 s), a cancel, a closed chat, an unknown id or an exiting app is a
//!    refusal. Nothing the model writes or a tool returns reaches the broker:
//!    only the command can approve.
//! 3. The per-CLI wiring (Claude `can_use_tool`, Codex elicitation, ACP
//!    `session/request_permission`), documented where it lives.
//!
//! What the user sees is what runs: the request's `input` is kept as received
//! and is what an approval returns (`updatedInput`); the text shown is a
//! redacted, size-capped rendering of the same value, flagged when cut.

use super::acp::permission::split_tool;
use super::command::SourcesLaunch;
use super::CliAgentKind;
use crate::sources::config::McpServer;
use async_trait::async_trait;
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::{oneshot, Mutex as AsyncMutex};

/// A question unanswered this long is refused (below the Claude watchdog's 90 s).
pub const APPROVAL_TIMEOUT: Duration = Duration::from_secs(60);
/// Event carrying an [`ApprovalEvent`].
pub const APPROVAL_EVENT: &str = "workspace_chat_approval";
/// Event telling the UI a question is over (answered, timed out, cancelled).
pub const APPROVAL_CLOSED_EVENT: &str = "workspace_chat_approval_closed";
/// Event for a call refused without a question (its arguments are too long to show).
pub const APPROVAL_REFUSED_EVENT: &str = "workspace_chat_approval_refused";
/// Arguments longer than this are not shown, so the call is refused instead.
pub const MAX_ARGS_BYTES: usize = 100 * 1024;
/// What replaces the value under a key that looks like a secret.
/// What every hidden value starts with; the rest says its type and size.
pub const HIDDEN: &str = "[hidden: looks like a key";

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolVerdict {
    Allow,
    Ask,
    Deny(&'static str),
}

/// What is known about one MCP tool.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ToolFacts {
    /// The user switched the tool on.
    pub allowed: bool,
    /// The server's `annotations.readOnlyHint`; `None` = not known.
    pub read_only: Option<bool>,
    /// The server's `annotations.destructiveHint`; `None` = not known.
    pub destructive: Option<bool>,
}

const WRITE_STEMS: [&str; 33] = [
    "writ", "creat", "updat", "delet", "remov", "send", "post", "patch", "edit", "renam", "exec", "insert",
    "upload", "publish", "push", "merg", "commit", "kill", "append", "sav", "modif", "replac", "clear",
    "reset", "archiv", "trash", "invit", "shar", "import", "install", "deploy", "cancel", "submit",
];
const WRITE_WORDS: [&str; 22] = [
    "put", "set", "add", "run", "drop", "move", "mv", "rm", "del", "approve", "reject", "assign", "schedule",
    "reply", "forward", "mark", "write", "apply", "revoke", "grant", "enable", "disable",
];

/// The words of a tool name: split at anything that is not a letter or digit
/// and at lower-to-upper changes (`sendMail`, `send_mail`, `send-mail`).
fn name_words(name: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut cur = String::new();
    let mut prev_lower = false;
    for c in name.chars() {
        if !c.is_alphanumeric() {
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

/// Does the tool's name say it changes something?
pub fn is_write_like(tool: &str) -> bool {
    name_words(tool).iter().any(|w| {
        let w = w.as_str();
        WRITE_STEMS.iter().any(|s| w.starts_with(s))
            || WRITE_WORDS.iter().any(|v| w == *v || w.strip_suffix('s') == Some(*v) || w.strip_suffix("ed") == Some(*v) || w.strip_suffix("ing") == Some(*v))
    })
}

/// The decision for one MCP tool: see the module docs.
pub fn mcp_verdict(facts: &ToolFacts, tool: &str) -> ToolVerdict {
    if !facts.allowed {
        return ToolVerdict::Deny("the tool is not allowed");
    }
    if facts.destructive == Some(true) {
        return ToolVerdict::Ask;
    }
    if facts.read_only == Some(true) && !is_write_like(tool) {
        ToolVerdict::Allow
    } else {
        ToolVerdict::Ask
    }
}

/// `path` as the file system sees it: absolute, no `..` at all, symlinks and
/// junctions resolved. A path that does not exist (yet) is resolved through its
/// deepest existing ancestor, with the rest appended as plain names. `None`
/// (deny) for a relative path, a `..`, or when nothing of it can be resolved.
fn canonical(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
        return None;
    }
    let mut existing = path.to_path_buf();
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    loop {
        match std::fs::canonicalize(&existing) {
            Ok(mut resolved) => {
                for name in rest.iter().rev() {
                    resolved.push(name);
                }
                return Some(resolved);
            }
            Err(_) => {
                rest.push(existing.file_name()?.to_owned());
                if !existing.pop() {
                    return None;
                }
            }
        }
    }
}

/// Is `target` inside `dir`? Both go through [`canonical`] (the Windows
/// canonical form, so case and `\\?\` spellings agree) and are compared
/// component by component: `D:\scope2` is not inside `D:\scope`, a junction
/// that leads out is not inside, and anything that cannot be resolved is not.
fn inside(dir: &Path, target: &str) -> bool {
    let (Some(d), Some(t)) = (canonical(dir), canonical(Path::new(target))) else { return false };
    d.components().count() > 1 && t.starts_with(&d)
}

/// A pattern that names its own root (`C:\x`, `/x`, `\\host\x`) instead of
/// being relative to the folder.
fn is_rooted(pattern: &str) -> bool {
    let p = Path::new(pattern);
    p.is_absolute() || p.has_root() || pattern.chars().nth(1) == Some(':') || pattern.starts_with(['/', '\\'])
}

/// The decision for a built-in tool: reads of the scope folders only.
pub fn builtin_verdict(tool: &str, input: &Value, scope_dirs: &[PathBuf]) -> ToolVerdict {
    let key = match tool {
        "Read" => "file_path",
        "Grep" | "Glob" => "path",
        _ => return ToolVerdict::Deny("this tool is never allowed in chat"),
    };
    let Some(path) = input.get(key).and_then(Value::as_str).filter(|p| !p.is_empty()) else {
        return ToolVerdict::Deny("the call names no path");
    };
    // A Glob pattern is relative to the path: it must not climb out of it.
    if tool == "Glob" {
        let pattern = input.get("pattern").and_then(Value::as_str).unwrap_or("");
        if pattern.replace('\\', "/").split('/').any(|c| c == "..") || is_rooted(pattern) {
            return ToolVerdict::Deny("the pattern leaves the folder");
        }
    }
    if scope_dirs.iter().any(|d| inside(d, path)) {
        ToolVerdict::Allow
    } else {
        ToolVerdict::Deny("outside the chat's folders")
    }
}

/// Everything the decision needs for one chat.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ApprovalPolicy {
    /// `(server key, tool name)` -> facts, for the servers of this chat.
    pub tools: HashMap<(String, String), ToolFacts>,
    /// The folders the built-in read tools may touch.
    pub scope_dirs: Vec<PathBuf>,
}

impl ApprovalPolicy {
    /// From the saved servers of the chat's scope (hints as the last check stored them).
    pub fn from_servers(servers: &[McpServer], scope_dirs: Vec<PathBuf>) -> Self {
        let mut tools = HashMap::new();
        for s in servers {
            for t in &s.tools {
                tools.insert(
                    (s.key.clone(), t.name.clone()),
                    ToolFacts { allowed: t.allowed, read_only: t.read_only_hint, destructive: t.destructive_hint },
                );
            }
        }
        Self { tools, scope_dirs }
    }

    fn server_keys(&self) -> Vec<String> {
        let mut keys: Vec<String> = self.tools.keys().map(|(s, _)| s.clone()).collect();
        keys.sort();
        keys.dedup();
        keys
    }

    /// An MCP tool by server and tool name; a tool the policy does not know is denied.
    pub fn mcp(&self, server: &str, tool: &str) -> ToolVerdict {
        match self.tools.get(&(server.to_string(), tool.to_string())) {
            Some(facts) => mcp_verdict(facts, tool),
            None => ToolVerdict::Deny("an unknown tool"),
        }
    }

    /// A call by the agent's tool name: `mcp__<server>__<tool>` (also the
    /// `mcp_<s>_<t>` and `<s>__<t>` forms) or a built-in's name.
    pub fn verdict_for_name(&self, name: &str, input: &Value) -> ToolVerdict {
        match split_tool(name, &self.server_keys()) {
            Some((server, tool)) => self.mcp(&server, &tool),
            None if name.to_lowercase().starts_with("mcp") => ToolVerdict::Deny("an unknown tool"),
            None => builtin_verdict(name, input, &self.scope_dirs),
        }
    }

    /// `mcp__<server>__<tool>` of every tool with this verdict kind.
    fn full_names(&self, want: impl Fn(&ToolVerdict) -> bool) -> Vec<String> {
        let mut out: Vec<String> = self
            .tools
            .iter()
            .filter(|((_, tool), facts)| want(&mcp_verdict(facts, tool)))
            .map(|((s, t), _)| format!("mcp__{s}__{t}"))
            .collect();
        out.sort();
        out
    }

    /// The tools that run by themselves.
    pub fn auto_run_tools(&self) -> Vec<String> {
        self.full_names(|v| *v == ToolVerdict::Allow)
    }

    /// The tools that ask on every call.
    pub fn ask_tools(&self) -> Vec<String> {
        self.full_names(|v| *v == ToolVerdict::Ask)
    }

    /// Make a Claude launch match this policy. Tools that ask are taken out of
    /// `--allowedTools` so the CLI hands them to us; with no way to ask
    /// (`support` is `Unsupported`) they are disallowed up front instead.
    ///
    /// Only the unsupported case changes the launch: the tools that would ask
    /// are switched off for every CLI. With support, `build_args` (Claude)
    /// and the Codex/ACP spawners read the ask list from the session's
    /// [`ChatApprovals`], and the launch keeps the full allowed list that the
    /// other CLIs need to expose the tools at all.
    pub fn adjust_launch(&self, launch: &mut SourcesLaunch, support: &ApprovalSupport) {
        if matches!(support, ApprovalSupport::Unsupported(_)) {
            // Only tools that run by themselves stay: one that would ask, and one
            // the policy does not know at all, are switched off (default is deny).
            let auto: HashSet<String> = self.auto_run_tools().into_iter().collect();
            let mut off: Vec<String> = launch
                .allowed_tools
                .iter()
                .filter(|t| t.starts_with("mcp__") && !auto.contains(*t))
                .cloned()
                .collect();
            off.extend(self.ask_tools());
            launch.allowed_tools.retain(|t| !t.starts_with("mcp__") || auto.contains(t));
            for t in off {
                if !launch.disallowed_tools.contains(&t) {
                    launch.disallowed_tools.push(t);
                }
            }
        }
    }
}

/// The sources a session of `approvals` launches with. A chat that cannot ask
/// has its asking tools removed from allowed and added to disallowed here, in
/// the one place every CLI's launch goes through, so a caller that forgot
/// `adjust_launch` still cannot run a tool that would need a question.
pub fn launch_sources(
    kind: CliAgentKind,
    sources: Option<&SourcesLaunch>,
    approvals: Option<&ChatApprovals>,
) -> Option<SourcesLaunch> {
    let mut launch = sources.cloned()?;
    // Only Claude asks; every other CLI runs a chat's read-only tools and nothing that would need a question.
    if let Some(a) = approvals.filter(|a| !a.can_ask || kind != CliAgentKind::Claude) {
        a.policy.adjust_launch(&mut launch, &ApprovalSupport::Unsupported("this CLI cannot ask".into()));
    }
    Some(launch)
}

/// Can this CLI ask the user per call?
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApprovalSupport {
    Supported,
    /// It cannot; the reason is for the composer's note.
    Unsupported(String),
}

/// Verified live on 2.1.330 (questions, deny, allow, cancel, timeout, close).
/// The oldest Claude version shown to carry `--permission-prompts host` and the
/// `can_use_tool` / `control_response` / `control_cancel_request` strings: the
/// installed 2.1.328, 2.1.329 and 2.1.330 binaries all do (string search of the
/// binaries; not run). Versions between NexQ's minimum (2.1.259) and 2.1.328
/// were not available to look at, so they stay unsupported.
pub const CLAUDE_ASK_MIN_VERSION: super::detect::ClaudeVersion = (2, 1, 328);

/// Claude's support for `version` (the detected one, if any).
pub fn claude_support_for_version(version: Option<super::detect::ClaudeVersion>) -> ApprovalSupport {
    match version {
        Some(v) if v >= CLAUDE_ASK_MIN_VERSION => ApprovalSupport::Supported,
        Some(v) => ApprovalSupport::Unsupported(format!(
            "Claude {} can't ask before a tool runs; update to {} or newer.",
            super::detect::format_version(v),
            super::detect::format_version(CLAUDE_ASK_MIN_VERSION)
        )),
        None => ApprovalSupport::Unsupported("NexQ couldn't read Claude's version, so it can't ask before a tool runs.".into()),
    }
}

/// Whether `kind`'s installed CLI can ask. Claude: by its version (blocking
/// detection, cached). Codex and Antigravity do not ask for now: their
/// approval protocols are not verified live, so the tools that would ask are
/// off for them (and only read-only tools run).
pub fn approval_support(kind: CliAgentKind) -> ApprovalSupport {
    match kind {
        CliAgentKind::Claude => {
            let version = super::detect::find_current_claude()
                .ok()
                .and_then(|bin| super::detect::claude_version_cached(&bin));
            claude_support_for_version(version)
        }
        CliAgentKind::Codex => ApprovalSupport::Unsupported("Tools that change things are off with Codex for now.".into()),
        CliAgentKind::Antigravity => {
            ApprovalSupport::Unsupported("Tools that change things are off with Antigravity for now.".into())
        }
    }
}

// ---------------------------------------------------------------------------
// Showing the arguments
// ---------------------------------------------------------------------------

/// Is this key one of the known names of a secret? Only these are hidden:
/// `password`, `secret`, `credential(s)`, `authorization`, `auth`, `bearer`,
/// `cookie`, `apikey`, `X-Api-Key`, `private_key`, `access_token`,
/// `refreshToken`... A word like `max_tokens` or `author` is shown.
pub fn is_secret_key(key: &str) -> bool {
    let words = name_words(key);
    let has = |w: &str| words.iter().any(|x| x == w);
    const NOT_SECRET_TOKEN: [&str; 10] = ["max", "min", "total", "num", "count", "input", "output", "prompt", "completion", "limit"];
    let secret_token = has("token") && !NOT_SECRET_TOKEN.iter().any(|n| has(n));
    let secret_key = has("apikey")
        || words.windows(2).any(|w| w[1] == "key" && ["api", "secret", "private", "access", "auth", "subscription"].contains(&w[0].as_str()));
    ["password", "passwd", "secret", "credential", "credentials", "authorization", "auth", "bearer", "cookie"]
        .iter()
        .any(|w| has(w))
        || secret_token
        || secret_key
}

/// A hidden value is only ever a short scalar: that is what a secret is. A long
/// string, an object or an array under a secret-looking key is shown (its own
/// keys are checked in turn), so nothing sizeable is hidden from the user.
const MAX_HIDDEN_CHARS: usize = 256;

fn hidden_scalar(value: &Value) -> Option<String> {
    match value {
        Value::String(s) if s.chars().count() <= MAX_HIDDEN_CHARS => {
            Some(format!("{HIDDEN}, string, {} chars]", s.chars().count()))
        }
        Value::Number(_) => Some(format!("{HIDDEN}, number]")),
        Value::Bool(_) => Some(format!("{HIDDEN}, boolean]")),
        _ => None,
    }
}

fn redact(value: &Value, hid: &mut bool) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| {
                    if is_secret_key(k) {
                        if let Some(h) = hidden_scalar(v) {
                            *hid = true;
                            return (k.clone(), Value::String(h));
                        }
                    }
                    (k.clone(), redact(v, hid))
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(|i| redact(i, hid)).collect()),
        other => other.clone(),
    }
}

/// Characters that can disguise text: bidirectional overrides and isolates,
/// zero-width and invisible formatting characters.
fn is_disguising(c: char) -> bool {
    matches!(c as u32,
        0x0000..=0x0008 | 0x000B..=0x001F | 0x007F..=0x009F       // control characters (tab and newline stay)
        | 0x00AD | 0x034F | 0x061C | 0x115F | 0x1160 | 0x17B4 | 0x17B5 | 0x180E
        | 0x200B..=0x200F | 0x2028 | 0x2029 | 0x202A..=0x202E | 0x2060..=0x206F
        | 0x3164 | 0xFE00..=0xFE0F | 0xFEFF | 0xFFA0 | 0xFFF9..=0xFFFB
        | 0xE0000..=0xE007F | 0xE0100..=0xE01EF)
}

/// `text` with every disguising character written out as `\u{XXXX}`.
pub fn escape_invisible(text: &str) -> String {
    text.chars()
        .map(|c| if is_disguising(c) { format!("\\u{{{:04X}}}", c as u32) } else { c.to_string() })
        .collect()
}

/// The card's rendering of a call's arguments.
#[derive(Debug, Clone, PartialEq)]
pub struct Shown {
    pub text: String,
    /// Some short value was replaced by a [`HIDDEN`] marker.
    pub redacted: bool,
}

impl std::fmt::Display for Shown {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.text)
    }
}

impl std::ops::Deref for Shown {
    type Target = str;
    fn deref(&self) -> &str {
        &self.text
    }
}

/// The whole of `args` as pretty JSON for the card: short values under known
/// secret key names replaced by a [`HIDDEN`] marker (with their type and
/// length), invisible and control characters escaped, nothing else changed or
/// cut. `None` when it is longer than [`MAX_ARGS_BYTES`]: a call the user
/// cannot read in full is refused, not shown in part. This is only a
/// rendering: what runs is the untouched `args`.
pub fn display_args(args: &Value) -> Option<Shown> {
    let mut redacted = false;
    let text = serde_json::to_string_pretty(&redact(args, &mut redacted)).unwrap_or_default();
    (text.len() <= MAX_ARGS_BYTES).then(|| Shown { text: escape_invisible(&text), redacted })
}

// ---------------------------------------------------------------------------
// The broker
// ---------------------------------------------------------------------------

/// One question to the user.
#[derive(Debug, Clone, PartialEq)]
pub struct ApprovalRequest {
    pub chat_id: String,
    /// The CLI's own id for the call (Claude `request_id`, Codex JSON-RPC id,
    /// ACP `toolCallId`), so a cancel from the CLI finds it.
    pub request_id: String,
    pub server: String,
    pub tool: String,
    /// The call's arguments exactly as the CLI sent them.
    pub args: Value,
}

/// Payload of `workspace_chat_approval`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ApprovalEvent {
    pub chat_id: String,
    pub request_id: String,
    pub approval_id: String,
    pub server: String,
    pub tool: String,
    /// Pretty JSON of the whole call; short values under known secret key
    /// names are replaced by a visible marker.
    pub args: String,
    /// Some value in `args` was replaced by such a marker.
    pub redacted: bool,
    /// Always false: arguments are shown in full, or the call is refused.
    pub truncated: bool,
}

/// The arguments of `answer_workspace_approval` as `invoke` sends them.
#[derive(Debug, Clone, PartialEq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerApprovalArgs {
    pub approval_id: String,
    pub allow: bool,
}

/// What the UI is told.
#[derive(Debug, Clone, PartialEq)]
pub enum ApprovalNotice {
    Request(ApprovalEvent),
    /// The question is over: `answered`, `timed_out`, `cancelled` (the words the store reads).
    Closed { chat_id: String, approval_id: String, reason: &'static str },
    /// A call refused without asking, with the reason to show.
    Refused { chat_id: String, request_id: String, server: String, tool: String, reason: String },
}

pub type ApprovalEmitter = Arc<dyn Fn(ApprovalNotice) + Send + Sync>;

/// Which answer a chat is writing right now (the `request_id` the chat
/// store holds), or `None` when it writes none. The CLI's own permission id is
/// never shown: every event carries this one.
pub type AskResolver = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// The event name and JSON payload of a notice: the one place the wire shape of
/// the approval events is made (the app emits it; the contract tests check it).
pub fn notice_payload(notice: &ApprovalNotice) -> (&'static str, serde_json::Value) {
    match notice {
        ApprovalNotice::Request(ev) => (APPROVAL_EVENT, serde_json::to_value(ev).unwrap_or_default()),
        ApprovalNotice::Refused { chat_id, request_id, server, tool, reason } => (
            APPROVAL_REFUSED_EVENT,
            serde_json::json!({ "chat_id": chat_id, "request_id": request_id, "server": server, "tool": tool, "reason": reason }),
        ),
        ApprovalNotice::Closed { chat_id, approval_id, reason } => (
            APPROVAL_CLOSED_EVENT,
            serde_json::json!({ "chat_id": chat_id, "approval_id": approval_id, "reason": reason }),
        ),
    }
}

#[async_trait]
pub trait ApprovalBroker: Send + Sync {
    /// Ask; true only when the user allowed this one call.
    async fn ask(&self, req: ApprovalRequest) -> bool;
    /// Refuse every question of `chat_id`, pending and queued (a cancel, a close).
    fn deny_chat(&self, chat_id: &str);
    /// Refuse the pending question the CLI named (it cancelled the call).
    fn deny_request(&self, chat_id: &str, request_id: &str);
    /// Questions asked and not yet answered or refused, for `chat_id`.
    fn pending(&self, chat_id: &str) -> usize;
}

struct Pending {
    chat_id: String,
    request_id: String,
    tx: oneshot::Sender<bool>,
}

#[derive(Default)]
struct BrokerState {
    pending: HashMap<String, Pending>,
    locks: HashMap<String, Arc<AsyncMutex<()>>>,
    /// Bumped by `deny_chat`: a question queued before it is refused.
    epochs: HashMap<String, u64>,
    /// Questions asked or waiting for their turn, per chat.
    open: HashMap<String, usize>,
    shut_down: bool,
}

pub struct WorkspaceApprovals {
    state: Mutex<BrokerState>,
    emitter: Mutex<Option<ApprovalEmitter>>,
    resolver: Mutex<Option<AskResolver>>,
    timeout: Duration,
}

impl WorkspaceApprovals {
    pub fn new() -> Self {
        Self { state: Mutex::default(), emitter: Mutex::new(None), resolver: Mutex::new(None), timeout: APPROVAL_TIMEOUT }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// The app-wide broker (the Tauri command and every chat session share it).
    pub fn global() -> Arc<WorkspaceApprovals> {
        static BROKER: OnceLock<Arc<WorkspaceApprovals>> = OnceLock::new();
        BROKER.get_or_init(|| Arc::new(WorkspaceApprovals::new())).clone()
    }

    /// Where questions go; with none set, every question is refused.
    pub fn set_emitter(&self, emitter: ApprovalEmitter) {
        *self.emitter.lock().unwrap() = Some(emitter);
    }

    /// How a chat's running answer is found (see [`AskResolver`]). With none
    /// set the CLI's own id is used (tests, and anything that is not a chat).
    pub fn set_ask_resolver(&self, resolver: AskResolver) {
        *self.resolver.lock().unwrap() = Some(resolver);
    }

    /// `Ok(id)`: the answer to attach a question to; `Err(())`: a resolver is
    /// set and the chat writes no answer, so nothing may be asked.
    fn ask_id(&self, chat_id: &str, cli_id: &str) -> Result<String, ()> {
        match self.resolver.lock().unwrap().clone() {
            Some(resolve) => resolve(chat_id).ok_or(()),
            None => Ok(cli_id.to_string()),
        }
    }

    /// Emit through the app's events (`workspace_chat_approval`, `..._closed`, `..._refused`).
    pub fn install_app(&self, app: tauri::AppHandle) {
        use tauri::Emitter;
        self.set_emitter(Arc::new(move |notice| {
            let (event, payload) = notice_payload(&notice);
            let _ = app.emit(event, payload);
        }));
    }

    /// The user's click. Unknown, repeated or late ids do nothing (false).
    pub fn answer(&self, approval_id: &str, allow: bool) -> bool {
        let taken = self.state.lock().unwrap().pending.remove(approval_id);
        match taken {
            Some(p) => {
                let _ = p.tx.send(allow);
                true
            }
            None => false,
        }
    }

    /// App exit: refuse everything and refuse anything asked later.
    pub fn shut_down(&self) {
        self.state.lock().unwrap().shut_down = true;
        let chats: Vec<String> = self.state.lock().unwrap().pending.values().map(|p| p.chat_id.clone()).collect();
        for chat in chats {
            self.deny_chat(&chat);
        }
        let queued: Vec<String> = self.state.lock().unwrap().open.keys().cloned().collect();
        for chat in queued {
            self.deny_chat(&chat);
        }
    }

    fn notify(&self, notice: ApprovalNotice) {
        let emitter = self.emitter.lock().unwrap().clone();
        if let Some(emit) = emitter {
            emit(notice);
        }
    }

    fn refuse(&self, taken: Vec<(String, Pending)>) {
        for (approval_id, p) in taken {
            let _ = p.tx.send(false);
            self.notify(ApprovalNotice::Closed { chat_id: p.chat_id, approval_id, reason: "cancelled" });
        }
    }
}

impl Default for WorkspaceApprovals {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ApprovalBroker for WorkspaceApprovals {
    async fn ask(&self, req: ApprovalRequest) -> bool {
        if self.emitter.lock().unwrap().is_none() {
            return false;
        }
        // A question belongs to the answer the chat is writing; with none running
        // (a late request of a stopped answer) nothing is asked.
        let Ok(ask_id) = self.ask_id(&req.chat_id, &req.request_id) else {
            self.notify(ApprovalNotice::Refused {
                chat_id: req.chat_id.clone(),
                request_id: String::new(),
                server: req.server.clone(),
                tool: req.tool.clone(),
                reason: format!("{} was refused: no answer is waiting for it.", req.tool),
            });
            return false;
        };
        // What the user cannot read in full they are not asked to approve.
        let Some(args) = display_args(&req.args) else {
            self.notify(ApprovalNotice::Refused {
                chat_id: req.chat_id.clone(),
                request_id: ask_id.clone(),
                server: req.server.clone(),
                tool: req.tool.clone(),
                reason: format!(
                    "{} was refused: its arguments are longer than {} KB, too long to show before it runs.",
                    req.tool,
                    MAX_ARGS_BYTES / 1024
                ),
            });
            return false;
        };
        let (epoch, lock) = {
            let mut st = self.state.lock().unwrap();
            if st.shut_down {
                return false;
            }
            *st.open.entry(req.chat_id.clone()).or_insert(0) += 1;
            (
                st.epochs.get(&req.chat_id).copied().unwrap_or(0),
                st.locks.entry(req.chat_id.clone()).or_default().clone(),
            )
        };
        // One question at a time per chat.
        let _turn = lock.lock().await;
        let (approval_id, rx) = {
            let mut st = self.state.lock().unwrap();
            let close = |st: &mut BrokerState| {
                if let Some(n) = st.open.get_mut(&req.chat_id) {
                    *n = n.saturating_sub(1);
                }
            };
            if st.shut_down || st.epochs.get(&req.chat_id).copied().unwrap_or(0) != epoch {
                close(&mut st);
                return false;
            }
            let approval_id = uuid::Uuid::new_v4().to_string();
            let (tx, rx) = oneshot::channel();
            st.pending.insert(
                approval_id.clone(),
                Pending { chat_id: req.chat_id.clone(), request_id: req.request_id.clone(), tx },
            );
            (approval_id, rx)
        };
        let (args, redacted) = (args.text, args.redacted);
        let truncated = false;
        self.notify(ApprovalNotice::Request(ApprovalEvent {
            chat_id: req.chat_id.clone(),
            request_id: ask_id.clone(),
            approval_id: approval_id.clone(),
            server: req.server.clone(),
            tool: req.tool.clone(),
            args,
            redacted,
            truncated,
        }));
        let (allowed, reason) = match tokio::time::timeout(self.timeout, rx).await {
            Ok(Ok(allow)) => (allow, "answered"),
            Ok(Err(_)) => (false, "cancelled"),
            Err(_) => (false, "timed_out"),
        };
        let still_open = {
            let mut st = self.state.lock().unwrap();
            if let Some(n) = st.open.get_mut(&req.chat_id) {
                *n = n.saturating_sub(1);
            }
            st.pending.remove(&approval_id).is_some()
        };
        // Answered and cancelled questions already told the UI; a timeout did not.
        if still_open || reason == "answered" {
            self.notify(ApprovalNotice::Closed { chat_id: req.chat_id, approval_id, reason });
        }
        allowed
    }

    fn deny_chat(&self, chat_id: &str) {
        let taken: Vec<(String, Pending)> = {
            let mut st = self.state.lock().unwrap();
            *st.epochs.entry(chat_id.to_string()).or_insert(0) += 1;
            let ids: Vec<String> =
                st.pending.iter().filter(|(_, p)| p.chat_id == chat_id).map(|(id, _)| id.clone()).collect();
            ids.into_iter().filter_map(|id| st.pending.remove(&id).map(|p| (id, p))).collect()
        };
        self.refuse(taken);
    }

    fn deny_request(&self, chat_id: &str, request_id: &str) {
        let taken: Vec<(String, Pending)> = {
            let mut st = self.state.lock().unwrap();
            let ids: Vec<String> = st
                .pending
                .iter()
                .filter(|(_, p)| p.chat_id == chat_id && p.request_id == request_id)
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter().filter_map(|id| st.pending.remove(&id).map(|p| (id, p))).collect()
        };
        self.refuse(taken);
    }

    fn pending(&self, chat_id: &str) -> usize {
        self.state.lock().unwrap().open.get(chat_id).copied().unwrap_or(0)
    }
}

/// What a chat session carries so it can ask: who answers, for which chat,
/// by which rules.
#[derive(Clone)]
pub struct ChatApprovals {
    /// False when the CLI cannot ask (`approval_support`): the session runs as
    /// before, with the tools that would ask switched off by `adjust_launch`.
    pub can_ask: bool,
    pub chat_id: String,
    pub broker: Arc<dyn ApprovalBroker>,
    pub policy: Arc<ApprovalPolicy>,
}

impl std::fmt::Debug for ChatApprovals {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChatApprovals").field("chat_id", &self.chat_id).finish_non_exhaustive()
    }
}

impl PartialEq for ChatApprovals {
    fn eq(&self, other: &Self) -> bool {
        self.can_ask == other.can_ask
            && self.chat_id == other.chat_id
            && Arc::ptr_eq(&self.broker, &other.broker)
            && *self.policy == *other.policy
    }
}

impl ChatApprovals {
    /// Ask the user about `name` called with `input`: the broker's answer, or
    /// a refusal for anything the policy denies. `Allow` is not asked.
    pub async fn decide(&self, request_id: &str, name: &str, input: &Value) -> bool {
        match self.policy.verdict_for_name(name, input) {
            ToolVerdict::Allow => true,
            ToolVerdict::Deny(_) => false,
            ToolVerdict::Ask => {
                let keys = self.policy.server_keys();
                let (server, tool) = split_tool(name, &keys).unwrap_or_default();
                self.broker
                    .ask(ApprovalRequest {
                        chat_id: self.chat_id.clone(),
                        request_id: request_id.to_string(),
                        server,
                        tool,
                        args: input.clone(),
                    })
                    .await
            }
        }
    }
}

#[cfg(test)]
mod tests;
