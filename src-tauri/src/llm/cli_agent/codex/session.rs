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
//! - There is no "append without a model call" message: `append_context` queues
//!   the text and the next `ask` prepends it.

use super::launch::{build_args, configure_command, discover_user_mcp_servers, CodexLaunch};
use super::policy::{decide, CodexPolicy};
use super::protocol::{
    self, Account, CommandAction, Incoming, Item, Notification, RpcError, ServerRequest, ThreadStart, TurnStatus, Usage,
};
use crate::llm::cli_agent::manager::{OnDelta, SessionHandle};
use crate::llm::cli_agent::process_tree::ProcessTree;
use crate::llm::cli_agent::protocol::{classify_error, AgentErrorKind, McpServerState, ToolResult, ToolUse, TurnResult};
use crate::llm::cli_agent::session::{
    encode_activity, encode_tool_result, failed_server_names, nothing_usable, strip_marker, AgentError, InitInfo,
    SessionTimeouts, THINKING_SIGNAL,
};
use crate::llm::provider::CancelToken;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
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
    readable_dirs: Vec<PathBuf>,
    cwd: PathBuf,
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
}

impl Shared {
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
        let approvals = Arc::new(Approvals {
            policy: launch.policy.clone(),
            readable_dirs: launch.readable_dirs.clone(),
            cwd: launch.cwd.clone(),
        });
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
        match tokio::time::timeout(timeouts.init + MCP_STARTUP_WAIT, session.prime(&launch)).await.unwrap_or(Err(AgentError::Timeout)) {
            Ok(()) => Ok(session),
            Err(e) => {
                session.close().await;
                Err(e)
            }
        }
    }

    /// `initialize`, sign-in check, `thread/start`, and (for NexQ's own MCP
    /// servers) the wait for their startup.
    async fn prime(&mut self, launch: &CodexLaunch) -> Result<(), AgentError> {
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

        let developer = developer_instructions(&launch.readable_dirs);
        let start = ThreadStart {
            cwd: launch.cwd.to_string_lossy().into_owned(),
            model: launch.model.clone(),
            base_instructions: launch.system_prompt.clone(),
            developer_instructions: developer,
            config: launch.thread_config(),
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
        }
        let info = InitInfo { tools: Vec::new(), mcp_servers: self.shared.mcp.lock().unwrap().clone() };
        for server in info.mcp_servers.iter().filter(|s| !expected.contains(&s.name)) {
            // The user's own servers are switched off: one starting means the
            // config changed under us. Worth a line, not a failed session.
            log::warn!("codex: unexpected MCP server `{}` ({})", server.name, server.status);
        }
        *self.init.lock().unwrap() = info.clone();
        if !expected.is_empty() && nothing_usable(!launch.readable_dirs.is_empty(), &info) {
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
                _ = cancel.cancelled() => return Err(AgentError::Cancelled),
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
}

/// The developer message that names the notes folders (and nothing else: the
/// system prompt is the thread's base instructions).
fn developer_instructions(dirs: &[PathBuf]) -> String {
    if dirs.is_empty() {
        return "You have no files to read. Answer from the conversation and your tools only. Never run commands that change anything.".to_string();
    }
    let list: Vec<String> = dirs.iter().map(|d| format!("- {}", d.display())).collect();
    format!(
        "You may read and search files only inside these notes folders:\n{}\nUse read-only commands there (list, read, search) and nothing else. Never read anywhere else, and never write, delete or run anything that changes a file.",
        list.join("\n")
    )
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

/// An activity chip for a command Codex classifies as reading notes: the same
/// `Read` / `Grep` / `Glob` tool uses a Claude session reports.
fn command_tool_use(id: &str, actions: &[CommandAction]) -> Option<ToolUse> {
    let action = actions.first()?;
    let (name, input) = match action {
        CommandAction::Read { path } => ("Read", json!({ "file_path": path })),
        CommandAction::Search { query, path } => ("Grep", json!({ "pattern": query, "path": path })),
        CommandAction::ListFiles { path } => ("Glob", json!({ "pattern": path.as_deref().unwrap_or("*") })),
        CommandAction::Unknown => return None,
    };
    Some(ToolUse { id: id.to_string(), name: name.to_string(), input })
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
                            let _ = tx.send(TurnMsg::Tool(ToolUse {
                                id,
                                name: format!("mcp__{server}__{tool}"),
                                input: arguments,
                            }));
                        }
                        Item::CommandExecution { id, actions, .. } => {
                            if let Some(tool) = command_tool_use(&id, &actions) {
                                open_tools.insert(id);
                                let _ = tx.send(TurnMsg::Tool(tool));
                            }
                        }
                        _ => {}
                    },
                    Notification::ItemCompleted { turn_id: t, item } if t == turn_id => match item {
                        Item::AgentMessage { id, text, phase } => {
                            if phase.as_deref() != Some("commentary") && !commentary.contains(&id) && !text.is_empty() {
                                final_text = Some(strip_marker(text));
                            }
                        }
                        Item::McpToolCall { id, status, .. } | Item::CommandExecution { id, status, .. }
                            if open_tools.remove(&id) =>
                        {
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
                    let verdict = decide(&request, &approvals.policy, &approvals.readable_dirs, &approvals.cwd);
                    log::info!("codex asked ({}): {:?}", request_name(&request), verdict);
                    let reply = protocol::reply_for(&request, verdict.is_allow());
                    out_shared.send_line(protocol::reply_line(&id, &reply));
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
    fn mcp_startup_words_match_the_claude_ones() {
        assert_eq!(mcp_status("ready", None), "connected");
        assert_eq!(mcp_status("starting", None), "pending");
        assert_eq!(mcp_status("failed", Some("spawn error")), "failed");
        assert_eq!(mcp_status("failed", Some("The context7 MCP server is not logged in")), "needs-auth");
    }

    #[test]
    fn a_command_that_reads_notes_shows_as_a_read_chip() {
        let read = command_tool_use("c1", &[CommandAction::Read { path: "D:\\notes\\a.md".into() }]).unwrap();
        assert_eq!((read.name.as_str(), read.id.as_str()), ("Read", "c1"));
        assert_eq!(read.input["file_path"], "D:\\notes\\a.md");
        let grep =
            command_tool_use("c2", &[CommandAction::Search { query: Some("budget".into()), path: None }]).unwrap();
        assert_eq!(grep.name, "Grep");
        assert_eq!(grep.input["pattern"], "budget");
        assert_eq!(command_tool_use("c3", &[CommandAction::ListFiles { path: None }]).unwrap().name, "Glob");
        assert!(command_tool_use("c4", &[CommandAction::Unknown]).is_none());
        assert!(command_tool_use("c5", &[]).is_none());
    }

    #[test]
    fn the_developer_message_names_the_notes_folders() {
        let none = developer_instructions(&[]);
        assert!(none.contains("no files"));
        let some = developer_instructions(&[PathBuf::from("D:\\notes"), PathBuf::from("D:\\wiki")]);
        assert!(some.contains("- D:\\notes"));
        assert!(some.contains("- D:\\wiki"));
    }

    #[test]
    fn default_timeouts_are_longer_than_claudes_for_thinking() {
        let t = default_timeouts();
        assert!(t.inactivity >= SessionTimeouts::default().inactivity);
    }
}
