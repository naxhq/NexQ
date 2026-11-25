//! Per-call tool approval for workspace chat (purpose Chat only).
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
/// The shown arguments are cut at this many characters.
pub const MAX_ARGS_CHARS: usize = 4000;

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

/// `path` made absolute-comparable: `\` as `/`, `.` dropped, `..` resolved
/// lexically; `None` when it is relative or climbs out of its root. Windows
/// paths compare case-insensitively (lower-cased here).
fn normalize(path: &str) -> Option<Vec<String>> {
    let unified = path.replace('\\', "/");
    let p = Path::new(&unified);
    let mut parts: Vec<String> = Vec::new();
    let mut rooted = false;
    for comp in p.components() {
        match comp {
            Component::Prefix(pre) => parts.push(pre.as_os_str().to_string_lossy().to_lowercase()),
            Component::RootDir => rooted = true,
            Component::CurDir => {}
            Component::ParentDir => {
                parts.pop()?;
            }
            Component::Normal(s) => parts.push(s.to_string_lossy().to_lowercase()),
        }
    }
    // A drive prefix or a root makes a path absolute; "a/b" does not.
    let absolute = rooted || unified.chars().nth(1) == Some(':');
    absolute.then_some(parts)
}

fn inside(dir: &Path, target: &str) -> bool {
    let (Some(d), Some(t)) = (normalize(&dir.to_string_lossy()), normalize(target)) else { return false };
    !d.is_empty() && t.len() >= d.len() && t[..d.len()] == d[..]
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
        if pattern.replace('\\', "/").split('/').any(|c| c == "..") || normalize(pattern).is_some() {
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
            None if name.starts_with("mcp") => ToolVerdict::Deny("an unknown tool"),
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
            let asks: HashSet<String> = self.ask_tools().into_iter().collect();
            launch.allowed_tools.retain(|t| !asks.contains(t));
            for t in asks {
                if !launch.disallowed_tools.contains(&t) {
                    launch.disallowed_tools.push(t);
                }
            }
        }
    }
}

/// Can this CLI ask the user per call?
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApprovalSupport {
    Supported,
    /// It cannot; the reason is for the composer's note.
    Unsupported(String),
}

/// The Claude version `--permission-prompts host` with `can_use_tool` requests
/// was checked on (its `--help` lists it; see `protocol.rs` for the messages).
pub const CLAUDE_ASK_MIN_VERSION: super::detect::ClaudeVersion = (2, 1, 330);

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
/// detection, cached). Codex and Antigravity ask through their own protocols
/// (elicitation, `session/request_permission`), which every version NexQ
/// supports has.
pub fn approval_support(kind: CliAgentKind) -> ApprovalSupport {
    match kind {
        CliAgentKind::Claude => {
            let version = super::detect::find_current_claude()
                .ok()
                .and_then(|bin| super::detect::claude_version_cached(&bin));
            claude_support_for_version(version)
        }
        CliAgentKind::Codex | CliAgentKind::Antigravity => ApprovalSupport::Supported,
    }
}

// ---------------------------------------------------------------------------
// Showing the arguments
// ---------------------------------------------------------------------------

/// Does a key name look like it holds a secret?
pub fn is_secret_key(key: &str) -> bool {
    let k = key.to_lowercase();
    ["password", "passwd", "secret", "token", "apikey", "api_key", "api-key", "authorization", "auth", "cookie", "credential", "bearer", "private_key", "privatekey", "session"]
        .iter()
        .any(|s| k.contains(s))
}

fn redact(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), if is_secret_key(k) { Value::String("[hidden]".into()) } else { redact(v) }))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(redact).collect()),
        other => other.clone(),
    }
}

/// Pretty JSON of `args` for the card: values under secret-looking keys hidden,
/// cut at [`MAX_ARGS_CHARS`]. The bool says whether it was cut. This is only a
/// rendering: what runs is the untouched `args`.
pub fn display_args(args: &Value) -> (String, bool) {
    let text = serde_json::to_string_pretty(&redact(args)).unwrap_or_default();
    if text.chars().count() <= MAX_ARGS_CHARS {
        return (text, false);
    }
    let cut: String = text.chars().take(MAX_ARGS_CHARS).collect();
    (format!("{cut}\n…"), true)
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
    /// Pretty JSON, secrets hidden by key name, size-capped.
    pub args: String,
    /// `args` was cut: the call has more than is shown.
    pub truncated: bool,
}

/// What the UI is told.
#[derive(Debug, Clone, PartialEq)]
pub enum ApprovalNotice {
    Request(ApprovalEvent),
    /// The question is over: `answered`, `timed_out`, `cancelled`.
    Closed { chat_id: String, approval_id: String, reason: &'static str },
}

pub type ApprovalEmitter = Arc<dyn Fn(ApprovalNotice) + Send + Sync>;

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
    timeout: Duration,
}

impl WorkspaceApprovals {
    pub fn new() -> Self {
        Self { state: Mutex::default(), emitter: Mutex::new(None), timeout: APPROVAL_TIMEOUT }
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

    /// Emit through the app's events (`workspace_chat_approval`, `..._closed`).
    pub fn install_app(&self, app: tauri::AppHandle) {
        use tauri::Emitter;
        self.set_emitter(Arc::new(move |notice| match notice {
            ApprovalNotice::Request(ev) => {
                let _ = app.emit(APPROVAL_EVENT, ev);
            }
            ApprovalNotice::Closed { chat_id, approval_id, reason } => {
                let _ = app.emit(
                    APPROVAL_CLOSED_EVENT,
                    serde_json::json!({ "chat_id": chat_id, "approval_id": approval_id, "reason": reason }),
                );
            }
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
        let (args, truncated) = display_args(&req.args);
        self.notify(ApprovalNotice::Request(ApprovalEvent {
            chat_id: req.chat_id.clone(),
            request_id: req.request_id.clone(),
            approval_id: approval_id.clone(),
            server: req.server.clone(),
            tool: req.tool.clone(),
            args,
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
