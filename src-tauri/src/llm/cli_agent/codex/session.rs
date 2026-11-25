//! `CodexSession`: one persistent, hidden `codex app-server` process (JSON-RPC
//! over stdio, one thread), with turns serialized FIFO.
//!
//! Same shape as `ClaudeSession`: three dedicated threads own the pipes (stdin
//! writer fed by a channel, stdout reader, stderr reader), the turn lock is a
//! fair `tokio::sync::Mutex` around the notification receiver, and each turn
//! runs in a spawned driver task that holds the lock until the turn completes,
//! so a cancelled or dropped `ask` never leaves stale events for the next one.
//!
//! Differences that follow from the protocol:
//! - Requests have ids and responses come back out of band, so the stdout
//!   reader completes a `oneshot` per request.
//! - The server asks questions (approvals). The stdout reader answers them
//!   straight away with `policy::decide`, so a turn never waits on an approval.
//! - Fail closed: the session has no shell and no file tools, so a command or
//!   file change item that starts at all means something got past the launch
//!   switches. The turn is interrupted, the process killed and the turn fails.
//! - There is no "append without a model call" message: `append_context` queues
//!   the text and the next `ask` prepends it.

use super::launch::{build_args, configure_command, discover_user_mcp_servers, CodexLaunch};
use super::policy::{self, decide, CodexPolicy, Verdict};
use crate::llm::cli_agent::approval::{ApprovalRequest, ChatApprovals};
use super::protocol::{
    self, Account, Incoming, Item, Notification, RpcError, ServerRequest, ThreadStart, TurnStatus, Usage,
};
use crate::llm::cli_agent::manager::{OnDelta, SessionHandle};
use crate::llm::cli_agent::process_tree::ProcessTree;
use crate::llm::cli_agent::protocol::{classify_error, AgentErrorKind, McpServerState, ToolResult, ToolUse, TurnResult};
use crate::llm::cli_agent::session::{
    encode_activity, encode_tool_result, failed_server_names, nothing_usable, strip_marker, AgentError, InitInfo,
    SessionTimeouts, THINKING_SIGNAL,
};
use crate::llm::provider::CancelToken;
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc as std_mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex, OwnedMutexGuard};

const CLOSE_GRACE: Duration = Duration::from_secs(2);
const STDERR_TAIL_LINES: usize = 20;
/// How long `spawn` waits for NexQ's own MCP servers to start (or fail).
const MCP_STARTUP_WAIT: Duration = Duration::from_secs(25);
/// Context queued by `append_context` is cut to this many characters (oldest first).
const MAX_PENDING_CONTEXT_CHARS: usize = 200_000;

/// The hang guards a Codex session runs with: a longer silence is allowed than
/// for Claude, because a high reasoning effort can think quietly for a while.
pub fn default_timeouts() -> SessionTimeouts {
    SessionTimeouts {
        init: Duration::from_secs(30),
        append: Duration::from_secs(30),
        inactivity: Duration::from_secs(180),
        drain: Duration::from_secs(60),
    }
}

/// What the stdout reader needs to answer the server's questions.
struct Approvals {
    policy: CodexPolicy,
    /// Set only for a workspace chat that can ask: a held request waits here.
    ask: Option<super::super::approval::ChatApprovals>,
    /// Where a held request's question runs (the reader is a plain thread).
    rt: tokio::runtime::Handle,
}

/// State shared with the pipe threads and turn drivers.
struct Shared {
    child: Mutex<Option<Child>>,
    tree: Mutex<Option<ProcessTree>>,
    alive: AtomicBool,
    /// Set by `close`/drop so in-flight turns report a deliberate shutdown.
    closed: AtomicBool,
    stdin_tx: Mutex<Option<std_mpsc::Sender<String>>>,
    stderr_tail: Mutex<VecDeque<String>>,
    stderr_done: AtomicBool,
    exit_status: Mutex<Option<String>>,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, RpcError>>>>,
    /// Startup state of every MCP server Codex reported, in first-seen order.
    mcp: Mutex<Vec<McpServerState>>,
    /// The thread's cumulative token usage when the last turn ended.
    usage_baseline: Mutex<Usage>,
    /// A workspace chat that can ask (None everywhere else).
    ask: Option<ChatApprovals>,
    /// Set while a turn is interrupted or the session closes: nothing new is asked.
    refuse_asks: AtomicBool,
    /// The MCP tool calls the running turn has started, for binding a question to one.
    started: Mutex<Vec<StartedTool>>,
    /// The worst plan-limit signal since it was last taken.
    plan_limit: Mutex<Option<crate::llm::cli_agent::protocol::PlanLimit>>,
    /// Which MCP tools may run: the allowlist `item_breach` checks every item against.
    policy: CodexPolicy,
    /// The keys of the MCP servers NexQ configured: any other that starts is a breach.
    expected_servers: Vec<String>,
}

/// The oldest started call of `server` whose real tool is among `named` and
/// that no question is bound to yet; it is marked bound.
fn bind_in(started: &mut [StartedTool], server: &str, named: &[String]) -> Option<StartedTool> {
    let item = started.iter_mut().find(|t| !t.bound && t.server == server && named.contains(&t.tool))?;
    item.bound = true;
    Some(item.clone())
}

/// One `item/started` MCP tool call: its real tool and arguments.
#[derive(Debug, Clone)]
struct StartedTool {
    item_id: String,
    server: String,
    tool: String,
    args: Value,
    /// A question was already bound to it.
    bound: bool,
}

impl Shared {
    /// Refuse every open question of this chat and any asked until the next
    /// turn (cancel, interrupt, close, drop).
    fn deny_asks(&self) {
        self.refuse_asks.store(true, Ordering::SeqCst);
        if let Some(a) = &self.ask {
            a.broker.deny_chat(&a.chat_id);
        }
    }

    fn may_ask(&self) -> bool {
        !self.refuse_asks.load(Ordering::SeqCst) && !self.closed.load(Ordering::SeqCst) && self.alive.load(Ordering::SeqCst)
    }

    /// Bind a question of `server` naming `named` to a started call of that
    /// server whose tool is among those names, not yet bound to another question.
    fn bind(&self, server: &str, named: &[String]) -> Option<StartedTool> {
        bind_in(&mut self.started.lock().unwrap(), server, named)
    }

    fn send_line(&self, line: String) -> bool {
        match self.stdin_tx.lock().unwrap().as_ref() {
            Some(tx) => tx.send(line).is_ok(),
            None => false,
        }
    }

    /// A new request id and the channel its response arrives on.
    fn register(&self) -> (u64, oneshot::Receiver<Result<Value, RpcError>>) {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        (id, rx)
    }

    fn crash_reason(&self) -> String {
        if self.closed.load(Ordering::SeqCst) {
            return "session closed".to_string();
        }
        let status = self.exit_status.lock().unwrap().clone().unwrap_or_else(|| "pipe closed".to_string());
        let tail: Vec<String> = self.stderr_tail.lock().unwrap().iter().cloned().collect();
        if tail.is_empty() {
            format!("codex exited unexpectedly ({status})")
        } else {
            format!("codex exited unexpectedly ({status}): {}", tail.join(" | "))
        }
    }

    /// End the process and everything it started.
    fn kill_tree(&self) {
        let child = self.child.lock().unwrap().take();
        let tree = self.tree.lock().unwrap().take();
        if let Some(mut child) = child {
            match tree {
                Some(tree) => tree.kill(&mut child),
                None => {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
    }

    /// Kill an unresponsive process; `reason` becomes its crash reason.
    fn terminate(&self, reason: &str) {
        log::warn!("codex session unresponsive ({reason}); killing it");
        *self.exit_status.lock().unwrap() = Some(reason.to_string());
        self.alive.store(false, Ordering::SeqCst);
        self.kill_tree();
    }

    fn record_mcp(&self, name: &str, status: &str, error: Option<&str>) {
        let status = mcp_status(status, error);
        let mut all = self.mcp.lock().unwrap();
        match all.iter_mut().find(|s| s.name == name) {
            Some(s) => s.status = status.to_string(),
            None => all.push(McpServerState { name: name.to_string(), status: status.to_string() }),
        }
    }
}

/// The first MCP server that is starting or ready although NexQ did not
/// configure it (one that merely failed never ran).
fn unexpected_server<'a>(servers: &'a [McpServerState], expected: &[String]) -> Option<&'a McpServerState> {
    servers
        .iter()
        .find(|s| !expected.contains(&s.name) && matches!(s.status.as_str(), "pending" | "connected"))
}

/// A thread item the session may not see: `Some(what it was)` for anything
/// but model text, reasoning and the other kinds that are inert by
/// construction (the user's message, the plan text, a context compaction), and
/// an MCP tool call that the policy allows. An allowlist: a new item kind
/// that Codex adds is refused until it is looked at.
fn item_breach(item: &Item, policy: &CodexPolicy) -> Option<String> {
    match item {
        Item::AgentMessage { .. } | Item::Reasoning { .. } => None,
        Item::McpToolCall { server, tool, .. } => {
            (!policy::tool_allowed(&policy.allowed_tools, server, tool)).then(|| format!("the MCP tool {server}.{tool}"))
        }
        Item::CommandExecution { .. } => Some("a command".to_string()),
        Item::FileChange { .. } => Some("a file change".to_string()),
        Item::Other { kind } if matches!(kind.as_str(), "userMessage" | "plan" | "contextCompaction") => None,
        Item::Other { kind } if kind.is_empty() => Some("an unknown tool".to_string()),
        Item::Other { kind } => Some(format!("a {kind} tool")),
    }
}

/// Codex's startup status mapped to the words the Claude `system/init` uses
/// (`connected`, `failed`, `needs-auth`, `pending`).
fn mcp_status(status: &str, error: Option<&str>) -> &'static str {
    match status {
        "ready" => "connected",
        "failed" => {
            let e = error.unwrap_or("").to_lowercase();
            if e.contains("not logged in") || e.contains("login") || e.contains("authoriz") || e.contains("auth") {
                "needs-auth"
            } else {
                "failed"
            }
        }
        _ => "pending",
    }
}

enum TurnMsg {
    Delta(String),
    Tool(ToolUse),
    ToolDone(ToolResult),
    Thinking,
    Done(Result<TurnResult, AgentError>),
}

pub struct CodexSession {
    model: String,
    effort: Option<String>,
    thread_id: String,
    shared: Arc<Shared>,
    /// The FIFO turn lock; the holder owns the current turn's notifications.
    turn: Arc<AsyncMutex<mpsc::UnboundedReceiver<Notification>>>,
    /// Text from `append_context` that the next `ask` carries along.
    pending_context: Mutex<Vec<String>>,
    timeouts: SessionTimeouts,
    init: Mutex<InitInfo>,
}

impl CodexSession {
    /// Start `codex app-server` with everything of the user's switched off,
    /// sign-in checked, and one read-only thread ready for questions.
    pub async fn spawn(launch: CodexLaunch) -> Result<CodexSession, AgentError> {
        Self::spawn_with_timeouts(launch, default_timeouts()).await
    }

    /// [`spawn`](Self::spawn) with custom hang guards (tests use short ones).
    pub async fn spawn_with_timeouts(launch: CodexLaunch, timeouts: SessionTimeouts) -> Result<CodexSession, AgentError> {
        let user_servers = match launch.user_mcp_servers.clone() {
            Some(names) => names,
            None => discover_user_mcp_servers(&launch.program, &launch.prefix_args).await.ok_or_else(|| {
                // Without the names the user's own MCP servers would load.
                AgentError::Spawn("could not read the list of MCP servers from the Codex config".into())
            })?,
        };
        let args = build_args(&launch, &user_servers);
        let approvals = Arc::new(Approvals { policy: launch.policy.clone(), ask: launch.ask.clone(), rt: tokio::runtime::Handle::current() });
        let spawn_launch = launch.clone();
        let (shared, events) =
            tokio::task::spawn_blocking(move || start_process(&spawn_launch, &args, approvals))
                .await
                .map_err(|e| AgentError::Spawn(format!("spawn task failed: {e}")))??;

        let mut session = CodexSession {
            model: launch.model.clone(),
            effort: launch.effort.clone().filter(|e| !e.is_empty()),
            thread_id: String::new(),
            shared,
            turn: Arc::new(AsyncMutex::new(events)),
            pending_context: Mutex::new(Vec::new()),
            timeouts,
            init: Mutex::new(InitInfo::default()),
        };
        match tokio::time::timeout(timeouts.init + MCP_STARTUP_WAIT, session.prime(&launch, &user_servers)).await.unwrap_or(Err(AgentError::Timeout)) {
            Ok(()) => Ok(session),
            Err(e) => {
                session.close().await;
                Err(e)
            }
        }
    }

    /// `initialize`, sign-in check, `thread/start`, and (for NexQ's own MCP
    /// servers) the wait for their startup.
    async fn prime(&mut self, launch: &CodexLaunch, user_servers: &[String]) -> Result<(), AgentError> {
        let version = env!("CARGO_PKG_VERSION");
        let (id, rx) = self.shared.register();
        self.send_line(protocol::initialize_request(id, version))?;
        self.await_response(rx).await?;
        self.send_line(protocol::initialized_notification())?;

        let (id, rx) = self.shared.register();
        self.send_line(protocol::account_read_request(id))?;
        match protocol::parse_account(&self.await_response(rx).await?) {
            Account::ChatGpt { .. } => {}
            Account::LoggedOut => {
                return Err(AgentError::Cli(
                    AgentErrorKind::NotLoggedIn,
                    "Codex is not signed in. Run `codex login` and choose Sign in with ChatGPT.".into(),
                ))
            }
            Account::ApiKey | Account::Other(_) => {
                return Err(AgentError::Cli(
                    AgentErrorKind::NotLoggedIn,
                    "Codex is signed in with an API key, not a ChatGPT subscription. Run `codex login` and choose Sign in with ChatGPT."
                        .into(),
                ))
            }
        }

        let developer = developer_instructions(launch.has_notes);
        let start = ThreadStart {
            cwd: launch.cwd.to_string_lossy().into_owned(),
            model: launch.model.clone(),
            base_instructions: launch.system_prompt.clone(),
            developer_instructions: developer,
            config: launch.thread_config(user_servers),
        };
        let (id, rx) = self.shared.register();
        self.send_line(protocol::thread_start_request(id, &start))?;
        let result = self.await_response(rx).await?;
        let (thread_id, model) = protocol::parse_thread_start(&result)
            .ok_or_else(|| AgentError::Spawn("Codex answered thread/start without a thread".into()))?;
        self.thread_id = thread_id;
        if self.model.is_empty() {
            self.model = model;
        }
        log::info!("codex session {} ready (model {})", self.thread_id, self.model);

        let expected = launch.server_keys();
        if !expected.is_empty() {
            self.wait_for_mcp(&expected).await;
        } else {
            // Nothing to wait for, but whatever server started anyway has been
            // announced before this answer comes back (the pipe is ordered).
            let (id, rx) = self.shared.register();
            self.send_line(protocol::account_read_request(id))?;
            self.await_response(rx).await?;
        }
        let info = InitInfo { tools: Vec::new(), mcp_servers: self.shared.mcp.lock().unwrap().clone() };
        // The user's own servers are switched off: one that starts anyway means
        // the config was not honoured, and its tools are not ours to vouch for.
        if let Some(server) = unexpected_server(&info.mcp_servers, &expected) {
            return Err(AgentError::Cli(
                AgentErrorKind::Other,
                format!(
                    "Codex started an MCP server NexQ did not configure (`{}`), so the session was closed.",
                    server.name
                ),
            ));
        }
        *self.init.lock().unwrap() = info.clone();
        // The notes server is one of the servers: when it fails and nothing else
        // is left, there is nothing to answer from.
        if !expected.is_empty() && nothing_usable(false, &info) {
            let labels: Vec<(String, String)> = Vec::new();
            return Err(AgentError::NoUsableSources {
                message: format!("{} didn't start", failed_server_names(&info, &labels)),
                info,
            });
        }
        Ok(())
    }

    /// Wait until every server in `expected` is ready or failed, at most
    /// [`MCP_STARTUP_WAIT`].
    async fn wait_for_mcp(&self, expected: &[String]) {
        let deadline = Instant::now() + MCP_STARTUP_WAIT;
        loop {
            let settled = {
                let all = self.shared.mcp.lock().unwrap();
                expected.iter().all(|key| all.iter().any(|s| &s.name == key && s.status != "pending"))
            };
            if settled || Instant::now() >= deadline || !self.is_alive() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    fn send_line(&self, line: String) -> Result<(), AgentError> {
        if self.shared.send_line(line) {
            Ok(())
        } else {
            Err(AgentError::Crashed(self.shared.crash_reason()))
        }
    }

    /// The response to a registered request. A JSON-RPC error is classified
    /// like any CLI error.
    async fn await_response(&self, rx: oneshot::Receiver<Result<Value, RpcError>>) -> Result<Value, AgentError> {
        match rx.await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(e)) => Err(AgentError::Cli(classify_error(&e.message), e.message)),
            Err(_) => Err(AgentError::Crashed(self.shared.crash_reason())),
        }
    }

    /// Queue `text` for the next `ask`: Codex has no way to take context
    /// without answering, so it travels with the next question.
    pub async fn append_context(&self, text: &str) -> Result<(), AgentError> {
        if !self.is_alive() {
            return Err(AgentError::Crashed(self.shared.crash_reason()));
        }
        if text.trim().is_empty() {
            return Ok(());
        }
        let mut queue = self.pending_context.lock().unwrap();
        queue.push(text.to_string());
        trim_queue(&mut queue, MAX_PENDING_CONTEXT_CHARS);
        Ok(())
    }

    /// Ask one question; text deltas go to `on_delta` as they stream, and
    /// [`THINKING_SIGNAL`] once if the model thinks before its first text.
    /// Turns are FIFO per session. When `cancel` fires, deltas stop at once and
    /// this returns `Err(Cancelled)`; the turn is interrupted and drained in the
    /// background, and only then may the next turn start.
    pub async fn ask(
        &self,
        prompt: &str,
        on_delta: Box<dyn Fn(&str) + Send + Sync>,
        cancel: Arc<CancelToken>,
    ) -> Result<TurnResult, AgentError> {
        let mut rx = self.start_turn(prompt, &cancel).await?;
        // Thinking is reported once, and only before any text.
        let mut quiet = false;
        loop {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => {
                    self.shared.deny_asks();
                    return Err(AgentError::Cancelled);
                }
                msg = rx.recv() => match msg {
                    Some(TurnMsg::Thinking) => {
                        if !quiet {
                            quiet = true;
                            on_delta(THINKING_SIGNAL);
                        }
                    }
                    Some(TurnMsg::Delta(text)) => {
                        quiet = true;
                        on_delta(&text);
                    }
                    Some(TurnMsg::Tool(tool)) => {
                        quiet = true;
                        on_delta(&encode_activity(&tool));
                    }
                    Some(TurnMsg::ToolDone(result)) => on_delta(&encode_tool_result(&result)),
                    Some(TurnMsg::Done(result)) => return result,
                    None => return Err(AgentError::Crashed(self.shared.crash_reason())),
                },
            }
        }
    }

    pub fn is_alive(&self) -> bool {
        if !self.shared.alive.load(Ordering::SeqCst) {
            return false;
        }
        match self.shared.child.lock().unwrap().as_mut() {
            Some(child) => matches!(child.try_wait(), Ok(None)),
            None => false,
        }
    }

    /// Close stdin, give the process 2 s to exit, then kill it and everything
    /// it started. Idempotent.
    pub async fn close(&self) {
        self.shared.closed.store(true, Ordering::SeqCst);
        self.shared.deny_asks();
        self.shared.stdin_tx.lock().unwrap().take();
        let deadline = Instant::now() + CLOSE_GRACE;
        loop {
            let exited = match self.shared.child.lock().unwrap().as_mut() {
                Some(child) => !matches!(child.try_wait(), Ok(None)),
                None => true,
            };
            if exited || Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        self.shared.kill_tree();
        self.shared.alive.store(false, Ordering::SeqCst);
    }

    /// The model this session runs (as configured, or the account default).
    pub fn model(&self) -> &str {
        &self.model
    }

    /// The configured reasoning effort, if any.
    pub fn effort(&self) -> Option<&str> {
        self.effort.as_deref()
    }

    /// NexQ's own MCP servers and how they started (the user's are off).
    pub fn init_info(&self) -> InitInfo {
        self.init.lock().unwrap().clone()
    }

    /// Take the turn lock (FIFO), send `turn/start` and spawn the driver that
    /// forwards this turn's events until it completes, holding the lock.
    async fn start_turn(
        &self,
        prompt: &str,
        cancel: &CancelToken,
    ) -> Result<mpsc::UnboundedReceiver<TurnMsg>, AgentError> {
        let guard = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(AgentError::CancelledBeforeSend),
            guard = self.turn.clone().lock_owned() => guard,
        };
        if cancel.is_cancelled() {
            return Err(AgentError::CancelledBeforeSend);
        }
        if !self.is_alive() {
            return Err(AgentError::Crashed(self.shared.crash_reason()));
        }
        let context: Vec<String> = std::mem::take(&mut *self.pending_context.lock().unwrap());
        let text = compose_prompt(&context, prompt);
        let (id, response) = self.shared.register();
        let line = protocol::turn_start_request(id, &self.thread_id, &text, None, self.effort.as_deref());
        if !self.shared.send_line(line) {
            self.shared.pending.lock().unwrap().remove(&id);
            // The context was not delivered: keep it for the next ask.
            let mut queue = self.pending_context.lock().unwrap();
            let mut merged = context;
            merged.append(&mut queue);
            *queue = merged;
            return Err(AgentError::Crashed(self.shared.crash_reason()));
        }
        let (tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(drive_turn(guard, tx, self.shared.clone(), self.thread_id.clone(), response, self.timeouts));
        Ok(rx)
    }
}

impl Drop for CodexSession {
    fn drop(&mut self) {
        self.shared.closed.store(true, Ordering::SeqCst);
        self.shared.deny_asks();
        self.shared.stdin_tx.lock().unwrap().take();
        self.shared.kill_tree();
        self.shared.alive.store(false, Ordering::SeqCst);
    }
}

#[async_trait::async_trait]
impl SessionHandle for CodexSession {
    async fn append_context(&self, text: &str) -> Result<(), AgentError> {
        CodexSession::append_context(self, text).await
    }

    async fn ask(&self, prompt: &str, on_delta: OnDelta, cancel: Arc<CancelToken>) -> Result<TurnResult, AgentError> {
        CodexSession::ask(self, prompt, on_delta, cancel).await
    }

    fn is_alive(&self) -> bool {
        CodexSession::is_alive(self)
    }

    async fn close(&self) {
        CodexSession::close(self).await
    }

    fn model(&self) -> String {
        CodexSession::model(self).to_string()
    }

    fn init_info(&self) -> InitInfo {
        CodexSession::init_info(self)
    }

    fn take_plan_limit(&self) -> Option<crate::llm::cli_agent::protocol::PlanLimit> {
        self.shared.plan_limit.lock().unwrap().take()
    }
}

/// The developer message about reading (and nothing else: the system prompt is
/// the thread's base instructions). The session has no shell: notes come only
/// from the `nexq_notes` tools.
fn developer_instructions(has_notes: bool) -> String {
    if !has_notes {
        return "You have no files to read and no commands to run. Answer from the conversation and your tools only.".to_string();
    }
    "You have no shell and no file access. The user's notes are available only through the nexq_notes tools: list_notes, search_notes and read_note (read-only). Call list_notes first. Do not try to run commands or change files.".to_string()
}

/// The user message: queued context first, then the question.
pub fn compose_prompt(context: &[String], prompt: &str) -> String {
    if context.is_empty() {
        return prompt.to_string();
    }
    format!(
        "Background so far (for reference, do not reply to it by itself):\n{}\n\nNow answer this:\n{}",
        context.join("\n\n"),
        prompt
    )
}

/// Drop the oldest entries until at most `max_chars` remain (the newest entry
/// always stays).
fn trim_queue(queue: &mut Vec<String>, max_chars: usize) {
    let mut total: usize = queue.iter().map(|s| s.chars().count()).sum();
    while total > max_chars && queue.len() > 1 {
        total -= queue.remove(0).chars().count();
    }
}

/// A turn's token counts: Codex's `input` includes the cached part, NexQ's
/// `input_tokens` is the uncached prompt only.
fn turn_result(text: String, usage: Usage, duration_ms: u64) -> TurnResult {
    TurnResult {
        text,
        is_error: false,
        input_tokens: usage.input.saturating_sub(usage.cached_input).saturating_sub(usage.cache_write),
        output_tokens: usage.output,
        cache_read_tokens: usage.cached_input,
        cache_write_tokens: usage.cache_write,
        thinking_tokens: usage.reasoning,
        cost_usd: 0.0,
        total_cost_usd: 0.0,
        duration_ms,
        latency_ms: 0,
        first_text_ms: None,
    }
}

/// Forward one turn's events until `turn/completed` (or process exit), then
/// release the turn lock. A receiver that goes away (a cancelled `ask`)
/// interrupts the turn; draining then takes at most `timeouts.drain`. No event
/// for `timeouts.inactivity`, or a drain that runs out, kills the process and
/// ends the turn with `Timeout`.
async fn drive_turn(
    mut events: OwnedMutexGuard<mpsc::UnboundedReceiver<Notification>>,
    tx: mpsc::UnboundedSender<TurnMsg>,
    shared: Arc<Shared>,
    thread_id: String,
    response: oneshot::Receiver<Result<Value, RpcError>>,
    timeouts: SessionTimeouts,
) {
    let outcome = run_turn(&mut events, &tx, &shared, &thread_id, response, timeouts).await;
    let _ = tx.send(TurnMsg::Done(outcome));
}

async fn run_turn(
    events: &mut OwnedMutexGuard<mpsc::UnboundedReceiver<Notification>>,
    tx: &mpsc::UnboundedSender<TurnMsg>,
    shared: &Arc<Shared>,
    thread_id: &str,
    response: oneshot::Receiver<Result<Value, RpcError>>,
    timeouts: SessionTimeouts,
) -> Result<TurnResult, AgentError> {
    // The turn id arrives with the response to `turn/start`.
    let response = tokio::time::timeout(timeouts.inactivity, response).await;
    let turn_id = match response {
        Err(_) => {
            shared.terminate(&format!("no answer to turn/start for {} s", timeouts.inactivity.as_secs()));
            return Err(AgentError::Timeout);
        }
        Ok(Err(_)) => return Err(AgentError::Crashed(shared.crash_reason())),
        Ok(Ok(Err(e))) => return Err(AgentError::Cli(classify_error(&e.message), e.message)),
        Ok(Ok(Ok(value))) => protocol::parse_turn_start(&value)
            .ok_or_else(|| AgentError::Cli(AgentErrorKind::Other, "Codex answered turn/start without a turn".into()))?,
    };

    // A new turn: questions may be asked again, and no call has started yet.
    shared.refuse_asks.store(false, Ordering::SeqCst);
    shared.started.lock().unwrap().clear();
    let mut interrupted = false;
    let mut drain_deadline: Option<tokio::time::Instant> = None;
    // Interim ("commentary") messages are the model narrating its tool use:
    // not part of the answer.
    let mut commentary: HashSet<String> = HashSet::new();
    let mut open_tools: HashSet<String> = HashSet::new();
    let mut streamed = String::new();
    let mut final_text: Option<String> = None;
    let mut total_usage: Option<Usage> = None;
    let mut last_error: Option<protocol::TurnError> = None;

    let interrupt = |shared: &Shared, interrupted: &mut bool| {
        // An interrupted turn leaves no question open and asks no new one.
        shared.deny_asks();
        if !*interrupted {
            *interrupted = true;
            // Nobody waits for the response; the reader drops what has no taker.
            let id = shared.next_id.fetch_add(1, Ordering::SeqCst);
            shared.send_line(protocol::turn_interrupt_request(id, thread_id, &turn_id));
        }
    };
    if tx.is_closed() {
        interrupt(shared, &mut interrupted);
        drain_deadline = Some(tokio::time::Instant::now() + timeouts.drain);
    }

    loop {
        let wait = match drain_deadline {
            Some(deadline) => timeouts.inactivity.min(deadline.saturating_duration_since(tokio::time::Instant::now())),
            None => timeouts.inactivity,
        };
        tokio::select! {
            event = tokio::time::timeout(wait, events.recv()) => {
                let event = match event {
                    Ok(Some(event)) => event,
                    Ok(None) => return Err(AgentError::Crashed(shared.crash_reason())),
                    Err(_) => {
                        let drained_out =
                            drain_deadline.is_some_and(|d| tokio::time::Instant::now() >= d);
                        shared.terminate(&if drained_out {
                            format!("cancelled turn did not finish within {} s", timeouts.drain.as_secs())
                        } else {
                            format!("no output for {} s", timeouts.inactivity.as_secs())
                        });
                        return Err(AgentError::Timeout);
                    }
                };
                // A server NexQ did not configure that came up (the user's own,
                // switched off, or a plugin's): nothing it offers is vouched for.
                if let Some(server) = unexpected_server(&shared.mcp.lock().unwrap(), &shared.expected_servers) {
                    let name = server.name.clone();
                    interrupt(shared, &mut interrupted);
                    shared.terminate(&format!("unexpected MCP server {name} started"));
                    return Err(AgentError::Cli(
                        AgentErrorKind::Other,
                        format!("Codex started an MCP server NexQ did not configure (`{name}`), which NexQ does not allow. The session was closed."),
                    ));
                }
                // The session has no shell, no file tools and no web: only
                // model text, reasoning and the allowed MCP tools may appear
                // (any turn: this thread runs one at a time).
                if let Notification::ItemStarted { item, .. } | Notification::ItemCompleted { item, .. } = &event {
                    if let Some(what) = item_breach(item, &shared.policy) {
                        interrupt(shared, &mut interrupted);
                        shared.terminate(&format!("{what} started"));
                        return Err(AgentError::Cli(
                            AgentErrorKind::Other,
                            format!("Codex tried to use {what}, which NexQ does not allow. The session was closed."),
                        ));
                    }
                }
                match event {
                    Notification::AgentMessageDelta { turn_id: t, item_id, delta } if t == turn_id => {
                        if !commentary.contains(&item_id) {
                            // Model text can't carry the activity marker.
                            let delta = strip_marker(delta);
                            if !delta.is_empty() {
                                streamed.push_str(&delta);
                                let _ = tx.send(TurnMsg::Delta(delta));
                            }
                        }
                    }
                    Notification::ReasoningDelta { turn_id: t } if t == turn_id => {
                        let _ = tx.send(TurnMsg::Thinking);
                    }
                    Notification::ItemStarted { turn_id: t, item } if t == turn_id => match item {
                        Item::AgentMessage { id, phase, .. } => {
                            if phase.as_deref() == Some("commentary") {
                                commentary.insert(id);
                            }
                        }
                        Item::Reasoning { .. } => {
                            let _ = tx.send(TurnMsg::Thinking);
                        }
                        Item::McpToolCall { id, server, tool, arguments, .. } => {
                            open_tools.insert(id.clone());
                            shared.started.lock().unwrap().push(StartedTool {
                                item_id: id.clone(),
                                server: server.clone(),
                                tool: tool.clone(),
                                args: arguments.clone(),
                                bound: false,
                            });
                            let _ = tx.send(TurnMsg::Tool(ToolUse {
                                id,
                                name: format!("mcp__{server}__{tool}"),
                                input: arguments,
                            }));
                        }
                        _ => {}
                    },
                    Notification::ItemCompleted { turn_id: t, item } if t == turn_id => match item {
                        Item::AgentMessage { id, text, phase } => {
                            if phase.as_deref() != Some("commentary") && !commentary.contains(&id) && !text.is_empty() {
                                final_text = Some(strip_marker(text));
                            }
                        }
                        Item::McpToolCall { id, status, .. } if open_tools.remove(&id) =>
                        {
                            shared.started.lock().unwrap().retain(|t| t.item_id != id);
                            let _ = tx.send(TurnMsg::ToolDone(ToolResult {
                                tool_use_id: id,
                                is_error: status != "completed",
                            }));
                        }
                        _ => {}
                    },
                    Notification::TokenUsage { turn_id: t, total, .. } if t == turn_id => {
                        total_usage = Some(total);
                    }
                    Notification::PlanLimit(limit) => {
                        let mut slot = shared.plan_limit.lock().unwrap();
                        *slot = Some(match slot.take() {
                            Some(old) => old.merge(limit),
                            None => limit,
                        });
                    }
                    Notification::Error { turn_id: t, error, will_retry } if t == turn_id => {
                        if will_retry {
                            log::info!("codex: transient error, retrying: {}", error.message);
                        } else {
                            last_error = Some(error);
                        }
                    }
                    Notification::TurnCompleted { turn_id: t, status, error, duration_ms } if t == turn_id => {
                        return match status {
                            TurnStatus::Completed => {
                                let mut baseline = shared.usage_baseline.lock().unwrap();
                                let total = total_usage.unwrap_or(*baseline);
                                let delta = total.since(&baseline);
                                *baseline = total;
                                Ok(turn_result(final_text.take().unwrap_or(streamed), delta, duration_ms))
                            }
                            TurnStatus::Interrupted if interrupted => Err(AgentError::Cancelled),
                            TurnStatus::Interrupted => Err(AgentError::Cli(
                                AgentErrorKind::Other,
                                "Codex stopped the turn".to_string(),
                            )),
                            TurnStatus::Failed | TurnStatus::InProgress => {
                                let err = error.or(last_error).unwrap_or(protocol::TurnError {
                                    message: "The Codex turn failed".to_string(),
                                    info: None,
                                });
                                Err(AgentError::Cli(protocol::classify_turn_error(&err), err.message))
                            }
                        };
                    }
                    // Other turns' events, status chatter: only a sign of life.
                    _ => {}
                }
            }
            _ = tx.closed(), if drain_deadline.is_none() => {
                interrupt(shared, &mut interrupted);
                drain_deadline = Some(tokio::time::Instant::now() + timeouts.drain);
            }
        }
    }
}

type Started = (Arc<Shared>, mpsc::UnboundedReceiver<Notification>);

/// Spawn the child (no shell, no window, stripped env, in a kill-on-close job)
/// and its three pipe threads. Blocking; run on a blocking thread.
fn start_process(launch: &CodexLaunch, args: &[String], approvals: Arc<Approvals>) -> Result<Started, AgentError> {
    let mut cmd = Command::new(&launch.program);
    cmd.args(args);
    configure_command(&mut cmd, launch);
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AgentError::Spawn(format!("Codex CLI not installed: {} ({e})", launch.program.display()))
        } else {
            AgentError::Spawn(format!("failed to start {}: {e}", launch.program.display()))
        }
    })?;
    let tree = ProcessTree::adopt(&child);
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");

    let (stdin_tx, stdin_rx) = std_mpsc::channel::<String>();
    let shared = Arc::new(Shared {
        child: Mutex::new(Some(child)),
        tree: Mutex::new(Some(tree)),
        alive: AtomicBool::new(true),
        closed: AtomicBool::new(false),
        stdin_tx: Mutex::new(Some(stdin_tx)),
        stderr_tail: Mutex::new(VecDeque::new()),
        stderr_done: AtomicBool::new(false),
        exit_status: Mutex::new(None),
        next_id: AtomicU64::new(1),
        pending: Mutex::new(HashMap::new()),
        mcp: Mutex::new(Vec::new()),
        usage_baseline: Mutex::new(Usage::default()),
        ask: approvals.ask.clone(),
        refuse_asks: AtomicBool::new(false),
        started: Mutex::new(Vec::new()),
        plan_limit: Mutex::new(None),
        policy: approvals.policy.clone(),
        expected_servers: launch.server_keys(),
    });
    let (event_tx, event_rx) = mpsc::unbounded_channel();

    // A pipe thread that fails to start must not leave the child running.
    let kill_shared = shared.clone();
    let spawn_thread = move |name: &str, f: Box<dyn FnOnce() + Send>| {
        std::thread::Builder::new().name(name.to_string()).spawn(f).map(|_| ()).map_err(|e| {
            kill_shared.alive.store(false, Ordering::SeqCst);
            kill_shared.kill_tree();
            AgentError::Spawn(format!("cannot start {name} thread: {e}"))
        })
    };

    spawn_thread(
        "codex-stdin",
        Box::new(move || {
            let mut stdin = stdin;
            for line in stdin_rx {
                let written =
                    stdin.write_all(line.as_bytes()).and_then(|_| stdin.write_all(b"\n")).and_then(|_| stdin.flush());
                if let Err(e) = written {
                    log::warn!("codex stdin write failed: {e}");
                    break;
                }
            }
            // Dropping `stdin` here closes the pipe, which ends the process.
        }),
    )?;

    let err_shared = shared.clone();
    spawn_thread(
        "codex-stderr",
        Box::new(move || {
            let _ = for_each_line(stderr, |line| {
                let line = line.trim_end();
                if line.is_empty() {
                    return;
                }
                log::debug!("codex stderr: {line}");
                let mut tail = err_shared.stderr_tail.lock().unwrap();
                if tail.len() == STDERR_TAIL_LINES {
                    tail.pop_front();
                }
                tail.push_back(line.to_string());
            });
            err_shared.stderr_done.store(true, Ordering::SeqCst);
        }),
    )?;

    let out_shared = shared.clone();
    spawn_thread(
        "codex-stdout",
        Box::new(move || {
            let read = for_each_line(stdout, |line| match protocol::parse_line(line) {
                Some(Incoming::Response { id, result }) => {
                    if let Some(waiter) = out_shared.pending.lock().unwrap().remove(&id) {
                        let _ = waiter.send(result);
                    }
                }
                Some(Incoming::Notification(note)) => {
                    if let Notification::McpStartup { name, status, error } = &note {
                        out_shared.record_mcp(name, status, error.as_deref());
                    }
                    let _ = event_tx.send(note);
                }
                Some(Incoming::Request { id, request }) => {
                    let verdict = decide(&request, &approvals.policy);
                    log::info!("codex asked ({}): {}", request_name(&request), verdict_name(&verdict));
                    match (&approvals.ask, &request) {
                        // A workspace chat: every tool approval is decided from the call that
                        // is actually running (its real tool and arguments), never from the
                        // request's own words. The JSON-RPC id stays open meanwhile.
                        (Some(ask), ServerRequest::McpElicitation { server, message, meta })
                            if policy::is_tool_approval(meta) =>
                        {
                            let (ask, shared, request, id) = (ask.clone(), out_shared.clone(), request.clone(), id.clone());
                            let (server, named) = (server.clone(), policy::named_tools(message, meta));
                            let rules = approvals.policy.clone();
                            approvals.rt.spawn(async move {
                                let allow = decide_bound(&shared, &ask, &rules, &server, &named).await;
                                let reply = protocol::reply_for(&request, allow);
                                shared.send_line(protocol::reply_line(&id, &reply));
                            });
                        }
                        _ => {
                            let reply = protocol::reply_for(&request, verdict.is_allow());
                            out_shared.send_line(protocol::reply_line(&id, &reply));
                        }
                    }
                }
                None => log::debug!("codex stdout: skipping a line that is not JSON-RPC"),
            });
            if let Err(e) = read {
                log::warn!("codex stdout read failed: {e}");
            }
            // Dead as of stdout EOF, before the bounded wait for the exit
            // status, so `is_alive` never reports a dying session as usable.
            out_shared.alive.store(false, Ordering::SeqCst);
            record_exit(&out_shared);
            // Requests still waiting see their channel close.
            out_shared.pending.lock().unwrap().clear();
            // `event_tx` drops here: pending turns see the channel close.
        }),
    )?;

    Ok((shared, event_rx))
}

/// How long a question waits for the call it is about to appear as started.
const BIND_WAIT: Duration = Duration::from_secs(5);

/// Decide one tool approval of a chat from the started call it belongs to:
/// ask the user for a tool that asks (with the call's real arguments), allow a
/// tool that runs by itself, refuse the rest, anything it cannot bind, and
/// anything once the turn is interrupted or the session is closing.
async fn decide_bound(shared: &Arc<Shared>, ask: &ChatApprovals, rules: &CodexPolicy, server: &str, named: &[String]) -> bool {
    let waited = tokio::time::Instant::now();
    let call = loop {
        if !shared.may_ask() {
            return false;
        }
        if let Some(call) = shared.bind(server, named) {
            break call;
        }
        if waited.elapsed() >= BIND_WAIT {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    };
    let allowed = policy::tool_allowed(&rules.allowed_tools, &call.server, &call.tool);
    let asks = policy::tool_allowed(&rules.ask_tools, &call.server, &call.tool);
    if !allowed {
        return false;
    }
    if !asks {
        return shared.may_ask();
    }
    let answer = ask
        .broker
        .ask(ApprovalRequest {
            chat_id: ask.chat_id.clone(),
            request_id: call.item_id.clone(),
            server: call.server.clone(),
            tool: call.tool.clone(),
            args: call.args.clone(),
        })
        .await;
    answer && shared.may_ask()
}

/// The verdict, for the log (never the request's content).
fn verdict_name(v: &Verdict) -> &'static str {
    match v {
        Verdict::Allow => "allow",
        Verdict::Ask { .. } => "ask",
        Verdict::Deny(why) => why,
    }
}

/// What a server request is, for the log (never its content).
fn request_name(req: &ServerRequest) -> &'static str {
    match req {
        ServerRequest::CommandApproval { .. } => "command",
        ServerRequest::FileChangeApproval { .. } => "file change",
        ServerRequest::PermissionsApproval => "permissions",
        ServerRequest::McpElicitation { .. } => "mcp tool",
        ServerRequest::UserInput => "user input",
        ServerRequest::DynamicToolCall => "dynamic tool",
        ServerRequest::AuthTokensRefresh => "token refresh",
        ServerRequest::Unknown { .. } => "unknown",
    }
}

/// Call `f` with every line of `reader` (without the line ending) until EOF.
/// Invalid UTF-8 is replaced rather than ending the stream.
fn for_each_line(reader: impl Read, mut f: impl FnMut(&str)) -> std::io::Result<()> {
    let mut reader = BufReader::new(reader);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        if reader.read_until(b'\n', &mut buf)? == 0 {
            return Ok(());
        }
        let line = String::from_utf8_lossy(&buf);
        f(line.trim_end_matches(['\r', '\n']));
    }
}

/// After stdout EOF: record the exit status and let stderr finish (both
/// bounded, so a lingering grandchild holding a pipe cannot hang us).
fn record_exit(shared: &Shared) {
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        let status = match shared.child.lock().unwrap().as_mut() {
            Some(child) => child.try_wait().ok().flatten(),
            None => break,
        };
        if let Some(status) = status {
            *shared.exit_status.lock().unwrap() = Some(match status.code() {
                Some(code) => format!("exit code {code}"),
                None => "terminated".to_string(),
            });
            break;
        }
        if Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let deadline = Instant::now() + Duration::from_millis(500);
    while !shared.stderr_done.load(Ordering::SeqCst) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_travels_before_the_question() {
        assert_eq!(compose_prompt(&[], "Who is Dana?"), "Who is Dana?");
        let text = compose_prompt(&["Them: hi".into(), "You: hello".into()], "Summarise");
        assert!(text.starts_with("Background so far"));
        assert!(text.contains("Them: hi\n\nYou: hello"));
        assert!(text.ends_with("Now answer this:\nSummarise"));
    }

    #[test]
    fn the_context_queue_drops_the_oldest_first() {
        let mut q = vec!["a".repeat(10), "b".repeat(10), "c".repeat(10)];
        trim_queue(&mut q, 25);
        assert_eq!(q.len(), 2);
        assert!(q[0].starts_with('b'));
        // The newest entry always stays, however long.
        let mut q = vec!["a".into(), "z".repeat(100)];
        trim_queue(&mut q, 10);
        assert_eq!(q.len(), 1);
        assert!(q[0].starts_with('z'));
    }

    #[test]
    fn token_counts_follow_nexqs_meaning() {
        let usage = Usage { input: 1200, cached_input: 1000, cache_write: 0, output: 80, reasoning: 30 };
        let r = turn_result("hi".into(), usage, 1500);
        assert_eq!(r.input_tokens, 200);
        assert_eq!(r.cache_read_tokens, 1000);
        assert_eq!(r.output_tokens, 80);
        assert_eq!(r.thinking_tokens, 30);
        assert_eq!(r.prompt_tokens(), 1200);
        assert_eq!(r.duration_ms, 1500);
        assert_eq!(r.cost_usd, 0.0);
        assert!(!r.is_error);
    }

    #[test]
    fn items_are_an_allowlist() {
        let policy = CodexPolicy { allowed_tools: ["mcp__nexq_notes__read_note".to_string(), "mcp__wiki__*".to_string()].into(), ..Default::default() };
        let mcp = |server: &str, tool: &str| Item::McpToolCall {
            id: "i".into(),
            server: server.into(),
            tool: tool.into(),
            arguments: Value::Null,
            status: "inProgress".into(),
            error: None,
        };
        let other = |kind: &str| Item::Other { kind: kind.into() };
        for ok in [
            Item::AgentMessage { id: "m".into(), text: String::new(), phase: None },
            Item::Reasoning { id: "r".into() },
            other("userMessage"),
            other("plan"),
            other("contextCompaction"),
            mcp("nexq_notes", "read_note"),
            mcp("wiki", "anything"),
        ] {
            assert_eq!(item_breach(&ok, &policy), None, "{ok:?}");
        }
        for bad in [
            Item::CommandExecution { id: "c".into(), command: "dir".into(), actions: vec![], status: String::new() },
            Item::FileChange { id: "f".into() },
            other("webSearch"),
            other("imageView"),
            other("dynamicToolCall"),
            other("collabAgentToolCall"),
            other("hookPrompt"),
            other("somethingNew"),
            other(""),
            mcp("nexq_notes", "write_note"),
            mcp("evil", "read_note"),
            mcp("", ""),
        ] {
            assert!(item_breach(&bad, &policy).is_some(), "{bad:?}");
        }
    }

    #[test]
    fn only_a_started_unexpected_server_counts() {
        let state = |name: &str, status: &str| McpServerState { name: name.into(), status: status.into() };
        let expected = vec!["nexq_notes".to_string()];
        let all = [state("nexq_notes", "connected"), state("old", "failed"), state("auth", "needs-auth")];
        assert!(unexpected_server(&all, &expected).is_none());
        assert_eq!(unexpected_server(&[state("mira", "pending")], &expected).map(|s| s.name.as_str()), Some("mira"));
        assert_eq!(unexpected_server(&[state("mira", "connected")], &expected).map(|s| s.name.as_str()), Some("mira"));
    }

    #[test]
    fn mcp_startup_words_match_the_claude_ones() {
        assert_eq!(mcp_status("ready", None), "connected");
        assert_eq!(mcp_status("starting", None), "pending");
        assert_eq!(mcp_status("failed", Some("spawn error")), "failed");
        assert_eq!(mcp_status("failed", Some("The context7 MCP server is not logged in")), "needs-auth");
    }

    #[test]
    fn the_developer_message_points_to_the_notes_tools_only() {
        let none = developer_instructions(false);
        assert!(none.contains("no files"));
        let some = developer_instructions(true);
        assert!(some.contains("list_notes") && some.contains("search_notes") && some.contains("read_note"));
        assert!(some.contains("no shell"));
    }

    #[test]
    fn default_timeouts_are_longer_than_claudes_for_thinking() {
        let t = default_timeouts();
        assert!(t.inactivity >= SessionTimeouts::default().inactivity);
    }

    mod binding {
        use super::super::*;
        use serde_json::json;

        fn started(id: &str, server: &str, tool: &str, args: Value) -> StartedTool {
            StartedTool { item_id: id.into(), server: server.into(), tool: tool.into(), args, bound: false }
        }

        #[test]
        fn a_question_binds_to_the_call_that_is_running_and_only_once() {
            let mut calls = vec![
                started("i1", "mira", "kb_search", json!({"q": "x"})),
                started("i2", "mira", "send_mail", json!({"to": "a@b.c"})),
            ];
            let named = vec!["send_mail".to_string()];
            let bound = bind_in(&mut calls, "mira", &named).unwrap();
            // The real call and its real arguments, whatever the question's own text said.
            assert_eq!((bound.item_id.as_str(), bound.args.clone()), ("i2", json!({"to": "a@b.c"})));
            assert!(bind_in(&mut calls, "mira", &named).is_none(), "a repeated question finds nothing left");
        }

        #[test]
        fn a_question_that_names_another_tool_or_server_binds_to_nothing() {
            let mut calls = vec![started("i1", "mira", "send_mail", json!({}))];
            for (server, named) in [
                ("other", vec!["send_mail".to_string()]),
                ("mira", vec!["kb_search".to_string()]),     // says the harmless one
                ("mira", vec!["SEND_MAIL".to_string()]),
                ("mira", vec![]),
                ("", vec!["send_mail".to_string()]),
            ] {
                assert!(bind_in(&mut calls, server, &named).is_none(), "{server:?} {named:?}");
            }
            assert!(!calls[0].bound);
        }

        #[test]
        fn the_title_is_never_a_name_and_an_interrupted_turn_asks_nothing() {
            use crate::llm::cli_agent::codex::policy::named_tools;
            let meta = json!({"codex_approval_kind": "mcp_tool_call", "tool_title": "kb_search", "tool_name": "send_mail"});
            let names = named_tools("Allow the mira MCP server to run tool \"send_mail\"?", &meta);
            assert!(names.contains(&"send_mail".to_string()) && !names.contains(&"kb_search".to_string()));
        }
    }
}
