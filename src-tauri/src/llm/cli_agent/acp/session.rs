//! `AcpSession`: one persistent, hidden ACP agent process (`agy acp`)
//! behind the same [`SessionHandle`] seam as `ClaudeSession`.
//!
//! Same shape as `session.rs`: three threads own the pipes (stdin writer fed by
//! a channel, stdout reader, stderr reader keeping a short tail for crash
//! reasons) and turns are serialized FIFO by a fair `tokio` mutex around the
//! event receiver. Differences that come from the protocol:
//!
//! - Every stdout line is JSON-RPC. Responses and `session/update`
//!   notifications go to the event channel in order, so a turn sees all its
//!   updates before the `session/prompt` response.
//! - The agent sends requests too. `session/request_permission` is answered
//!   right on the reader thread from the pure policy in [`super::permission`]
//!   (only MCP tools are ever allowed); any other request (`fs/*`,
//!   `terminal/*`, ...) gets a JSON-RPC "Method not found" so the agent never
//!   waits for a reply that never comes.
//! - Fail closed: Antigravity auto-allows some tools without asking (a read or
//!   a write in its working directory, a web search). A tool call that
//!   completes without NexQ having allowed it cancels the turn, kills the
//!   process and fails the turn.
//! - There is no "append without a model call": `append_context` queues the
//!   text and the next `ask` sends it in front of its prompt.
//! - The system prompt travels in `session/new`'s `_meta` when the agent
//!   advertises it (Antigravity), else as an `## Instructions` block in front
//!   of the first prompt.

use super::permission::{self, PermissionPolicy};
use super::protocol::{self as acp, AgentInit, Incoming, RpcError, Update};
use crate::llm::cli_agent::command::{configure_command, sandbox_dir};
use crate::llm::cli_agent::manager::{OnDelta, SessionHandle};
use crate::llm::cli_agent::process_tree::ProcessTree;
use crate::llm::cli_agent::protocol::{AgentErrorKind, ToolResult, TurnResult};
use crate::llm::cli_agent::session::{
    encode_activity, encode_tool_result, strip_marker, AgentError, SessionTimeouts, THINKING_SIGNAL,
};
use crate::llm::provider::CancelToken;
use async_trait::async_trait;
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc as std_mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, Mutex as AsyncMutex, OwnedMutexGuard};

const CLOSE_GRACE: Duration = Duration::from_secs(2);
const STDERR_TAIL_LINES: usize = 20;

/// Env vars removed from the child on top of the Claude ones
/// (`command::STRIPPED_ENV`): an API key or a Vertex/ADC switch in NexQ's
/// environment must never turn a subscription session into paid API billing.
pub const ACP_STRIPPED_ENV: [&str; 8] = [
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "CODEX_API_KEY",
];

/// Everything needed to start one ACP agent.
#[derive(Clone)]
pub struct AcpLaunch {
    /// The executable (`agy.exe`, see `launch::find_agy`).
    pub program: PathBuf,
    pub args: Vec<String>,
    /// The process cwd and the session's `cwd`: an empty folder of NexQ's.
    pub cwd: PathBuf,
    /// Delete `cwd` (with whatever the agent put in it) when the session ends.
    /// Set for a folder made for this one session.
    pub remove_cwd_on_close: bool,
    /// Model id for `session/set_model`; empty keeps the agent's default.
    pub model: String,
    pub system_prompt: String,
    /// `session/new`'s `mcpServers`: `{name, command, args, env:[{name,value}]}`
    /// (stdio) or `{type, name, url, headers}`, NexQ's `nexq_notes` server
    /// included. They hold secrets: never logged.
    pub mcp_servers: Vec<Value>,
    pub policy: PermissionPolicy,
    /// Extra env vars to remove, beyond [`ACP_STRIPPED_ENV`] and the Claude ones.
    pub env_remove: Vec<String>,
}

impl std::fmt::Debug for AcpLaunch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AcpLaunch")
            .field("program", &self.program)
            .field("args", &self.args)
            .field("cwd", &self.cwd)
            .field("model", &self.model)
            .field("system_prompt_len", &self.system_prompt.len())
            .field("mcp_servers", &format_args!("<redacted, {}>", self.mcp_servers.len()))
            .field("env_remove", &self.env_remove)
            .finish()
    }
}

impl AcpLaunch {
    /// A launch with no MCP servers and a policy that allows nothing.
    pub fn new(program: PathBuf, args: Vec<String>, cwd: PathBuf) -> Self {
        Self {
            program,
            args,
            cwd,
            remove_cwd_on_close: false,
            model: String::new(),
            system_prompt: String::new(),
            mcp_servers: Vec::new(),
            policy: PermissionPolicy::deny_all(),
            env_remove: Vec::new(),
        }
    }

    /// The `name` of each MCP server, to recognise `mcp_<server>_<tool>` calls.
    fn server_names(&self) -> Vec<String> {
        self.mcp_servers.iter().filter_map(|s| s["name"].as_str().map(str::to_string)).collect()
    }
}

/// Default timeouts: like Claude's, but the first start may take longer
/// (a cold start can be slow), so `init` is 30 s.
pub fn default_timeouts() -> SessionTimeouts {
    SessionTimeouts { init: Duration::from_secs(30), ..SessionTimeouts::default() }
}

enum Event {
    /// The `update` of a `session/update` notification.
    Update(Value),
    Response { id: u64, result: Result<Value, RpcError> },
    /// Any other line: proves the agent is alive for the inactivity watchdog.
    Tick,
}

/// State shared with the pipe threads and turn drivers.
struct Shared {
    child: Mutex<Option<Child>>,
    tree: Mutex<Option<ProcessTree>>,
    /// `None` once closed; dropping the sender closes the child's stdin.
    stdin_tx: Mutex<Option<std_mpsc::Sender<String>>>,
    alive: AtomicBool,
    /// Set by `close`/drop so in-flight turns report a deliberate shutdown.
    closed: AtomicBool,
    stderr_tail: Mutex<VecDeque<String>>,
    stderr_done: AtomicBool,
    exit_status: Mutex<Option<String>>,
    /// Short name of the agent for messages (`agy`).
    label: String,
    /// `toolCallId` -> whether NexQ allowed it (an answered permission request).
    decisions: Mutex<HashMap<String, bool>>,
    /// A folder made for this session, deleted with the process.
    owned_dir: Option<PathBuf>,
}

impl Shared {
    fn send_line(&self, line: String) -> bool {
        match self.stdin_tx.lock().unwrap().as_ref() {
            Some(tx) => tx.send(line).is_ok(),
            None => false,
        }
    }

    /// Readable reason for an unexpected exit: exit status + last stderr lines.
    fn crash_reason(&self) -> String {
        if self.closed.load(Ordering::SeqCst) {
            return "session closed".to_string();
        }
        let status = self.exit_status.lock().unwrap().clone().unwrap_or_else(|| "pipe closed".to_string());
        let tail: Vec<String> = self.stderr_tail.lock().unwrap().iter().cloned().collect();
        if tail.is_empty() {
            format!("{} exited unexpectedly ({status})", self.label)
        } else {
            format!("{} exited unexpectedly ({status}): {}", self.label, tail.join(" | "))
        }
    }

    /// The error for a dead process: `Crashed`, unless stderr names a known
    /// cause (not logged in, out of quota), which keeps its own kind.
    fn crash_error(&self) -> AgentError {
        let reason = self.crash_reason();
        match acp::classify_acp_error(None, &reason) {
            AgentErrorKind::NotLoggedIn => AgentError::Cli(AgentErrorKind::NotLoggedIn, reason),
            AgentErrorKind::RateLimited => AgentError::Cli(AgentErrorKind::RateLimited, reason),
            _ => AgentError::Crashed(reason),
        }
    }

    /// End the process and everything it started, and delete its own folder.
    fn kill_process(&self) {
        let child = self.child.lock().unwrap().take();
        let tree = self.tree.lock().unwrap().take();
        match (child, tree) {
            (Some(mut child), Some(tree)) => tree.kill(&mut child),
            (Some(mut child), None) => {
                let _ = child.kill();
                let _ = child.wait();
            }
            (None, _) => return,
        }
        if let Some(dir) = &self.owned_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    /// Did NexQ allow this tool call? (Never, for one it was not asked about.)
    fn was_allowed(&self, tool_call_id: &str) -> bool {
        self.decisions.lock().unwrap().get(tool_call_id).copied().unwrap_or(false)
    }

    /// Kill an unresponsive process; `reason` becomes its crash reason.
    fn terminate(&self, reason: &str) {
        log::warn!("{} session unresponsive ({reason}); killing it", self.label);
        *self.exit_status.lock().unwrap() = Some(reason.to_string());
        self.alive.store(false, Ordering::SeqCst);
        self.kill_process();
    }
}

enum TurnMsg {
    Delta(String),
    Tool(crate::llm::cli_agent::protocol::ToolUse),
    ToolDone(ToolResult),
    Thinking,
    Done(Result<TurnResult, AgentError>),
}

pub struct AcpSession {
    model: String,
    shared: Arc<Shared>,
    next_id: AtomicU64,
    /// The FIFO turn lock; the holder owns the current turn's events.
    turn: Arc<AsyncMutex<mpsc::UnboundedReceiver<Event>>>,
    session_id: String,
    /// Ids of the modes `session/new` offered (what Antigravity gives, for the record).
    modes: Vec<String>,
    timeouts: SessionTimeouts,
    /// Text from `append_context`, sent in front of the next prompt.
    pending_context: Mutex<Vec<String>>,
    /// The system prompt, until it has gone out in front of the first prompt
    /// (`None` when it travelled in `session/new` or there is none).
    instructions: Mutex<Option<String>>,
    /// MCP server keys, to name `mcp_<server>_<tool>` calls.
    servers: Arc<Vec<String>>,
    agent: AgentInit,
    models: Vec<(String, String)>,
}

impl AcpSession {
    /// Start the agent, `initialize`, open a session (`session/new`) and select
    /// the model, all within 30 s.
    pub async fn spawn(launch: AcpLaunch) -> Result<AcpSession, AgentError> {
        Self::spawn_with_timeouts(launch, default_timeouts()).await
    }

    /// [`spawn`](Self::spawn) with custom hang guards (tests use short ones).
    pub async fn spawn_with_timeouts(
        launch: AcpLaunch,
        timeouts: SessionTimeouts,
    ) -> Result<AcpSession, AgentError> {
        let servers = Arc::new(launch.server_names());
        let policy = Arc::new(launch.policy.clone());
        let (program, args, cwd, env_remove) =
            (launch.program.clone(), launch.args.clone(), launch.cwd.clone(), launch.env_remove.clone());
        let owned = launch.remove_cwd_on_close.then(|| launch.cwd.clone());
        let (shared, mut events) =
            tokio::task::spawn_blocking(move || start_process(&program, &args, &cwd, &env_remove, policy, owned))
                .await
                .map_err(|e| AgentError::Spawn(format!("spawn task failed: {e}")))??;
        let next_id = AtomicU64::new(1);

        let hello = Handshake {
            cwd: &launch.cwd,
            mcp_servers: &launch.mcp_servers,
            system_prompt: &launch.system_prompt,
            model: &launch.model,
        };
        let opened = tokio::time::timeout(timeouts.init, handshake(&shared, &mut events, &next_id, &hello))
            .await
            .unwrap_or_else(|_| {
                shared.terminate(&format!("no session within {} s", timeouts.init.as_secs()));
                Err(AgentError::Timeout)
            });
        let opened = match opened {
            Ok(o) => o,
            Err(e) => {
                shared.closed.store(true, Ordering::SeqCst);
                shared.stdin_tx.lock().unwrap().take();
                shared.alive.store(false, Ordering::SeqCst);
                shared.kill_process();
                return Err(e);
            }
        };
        log::info!(
            "{} ACP session {} ready (agent {} {}, model {})",
            shared.label, opened.session.session_id, opened.agent.name, opened.agent.version,
            if launch.model.is_empty() { opened.session.current_model.clone().unwrap_or_default() } else { launch.model.clone() }
        );

        let instructions = (!opened.system_prompt_in_meta && !launch.system_prompt.trim().is_empty())
            .then(|| launch.system_prompt.clone());
        Ok(AcpSession {
            model: launch.model,
            shared,
            next_id,
            turn: Arc::new(AsyncMutex::new(events)),
            session_id: opened.session.session_id,
            modes: opened.session.modes,
            timeouts,
            pending_context: Mutex::new(Vec::new()),
            instructions: Mutex::new(instructions),
            servers,
            agent: opened.agent,
            models: opened.session.models,
        })
    }

    /// Queue `text` as context: it goes in front of the next `ask`'s prompt (no
    /// model call now). Fails only when the agent is gone.
    pub async fn append_context(&self, text: &str) -> Result<(), AgentError> {
        if !self.is_alive() {
            return Err(self.shared.crash_error());
        }
        if !text.trim().is_empty() {
            self.pending_context.lock().unwrap().push(text.to_string());
        }
        Ok(())
    }

    /// Ask one question; answer text goes to `on_delta` as it streams,
    /// [`THINKING_SIGNAL`] once if the model thinks before its first text, and
    /// tool use as activity tokens. Turns are FIFO per session. When `cancel`
    /// fires, deltas stop at once, `session/cancel` is sent and this returns
    /// `Err(Cancelled)`; the turn is drained in the background until the
    /// agent answers, and only then may the next turn start.
    pub async fn ask(
        &self,
        prompt: &str,
        on_delta: OnDelta,
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
                    None => return Err(self.shared.crash_error()),
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

    /// Close stdin, give the process 2 s to exit, then kill it (and anything it
    /// started). Idempotent.
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
        self.shared.alive.store(false, Ordering::SeqCst);
        self.shared.kill_process();
    }

    /// The model this session was started with (as configured).
    pub fn model(&self) -> &str {
        &self.model
    }

    /// `(id, name)` of the models `session/new` offered.
    pub fn models(&self) -> &[(String, String)] {
        &self.models
    }

    /// The ids of the modes the agent offered in `session/new`.
    pub fn modes(&self) -> &[String] {
        &self.modes
    }

    /// What `initialize` said about the agent.
    pub fn agent(&self) -> &AgentInit {
        &self.agent
    }

    /// Prompt text: the instructions (once), the queued context, then `prompt`.
    fn compose_prompt(&self, prompt: &str) -> String {
        let mut parts: Vec<String> = Vec::new();
        if let Some(instructions) = self.instructions.lock().unwrap().take() {
            parts.push(format!("## Instructions\n\n{instructions}"));
        }
        parts.append(&mut self.pending_context.lock().unwrap());
        parts.push(prompt.to_string());
        parts.join("\n\n")
    }

    /// Take the turn lock (FIFO), send `session/prompt` and spawn the driver
    /// that forwards this turn's events until its response, holding the lock.
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
            return Err(self.shared.crash_error());
        }
        let text = self.compose_prompt(prompt);
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        if !self.shared.send_line(acp::request(id, "session/prompt", acp::prompt_params(&self.session_id, &text))) {
            return Err(self.shared.crash_error());
        }
        let (tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(drive_turn(
            guard,
            tx,
            self.shared.clone(),
            self.session_id.clone(),
            id,
            self.timeouts,
            self.servers.clone(),
        ));
        Ok(rx)
    }
}

impl Drop for AcpSession {
    fn drop(&mut self) {
        self.shared.closed.store(true, Ordering::SeqCst);
        self.shared.stdin_tx.lock().unwrap().take();
        self.shared.alive.store(false, Ordering::SeqCst);
        self.shared.kill_process();
    }
}

#[async_trait]
impl SessionHandle for AcpSession {
    async fn append_context(&self, text: &str) -> Result<(), AgentError> {
        AcpSession::append_context(self, text).await
    }

    async fn ask(
        &self,
        prompt: &str,
        on_delta: OnDelta,
        cancel: Arc<CancelToken>,
    ) -> Result<TurnResult, AgentError> {
        AcpSession::ask(self, prompt, on_delta, cancel).await
    }

    fn is_alive(&self) -> bool {
        AcpSession::is_alive(self)
    }

    async fn close(&self) {
        AcpSession::close(self).await
    }

    fn model(&self) -> String {
        AcpSession::model(self).to_string()
    }
}

/// Forward one turn's updates until the `session/prompt` response (or process
/// exit), then release the turn lock. Keeps draining after the receiver is
/// gone (a cancelled `ask`, which also sends `session/cancel`), but at most
/// `timeouts.drain`. No event for `timeouts.inactivity`, or a drain that runs
/// out, kills the process and ends the turn with `Timeout`.
async fn drive_turn(
    mut events: OwnedMutexGuard<mpsc::UnboundedReceiver<Event>>,
    tx: mpsc::UnboundedSender<TurnMsg>,
    shared: Arc<Shared>,
    session_id: String,
    prompt_id: u64,
    timeouts: SessionTimeouts,
    servers: Arc<Vec<String>>,
) {
    let started = Instant::now();
    let mut text = String::new();
    let mut announced: HashSet<String> = HashSet::new();
    let mut tool_names: HashMap<String, String> = HashMap::new();
    let mut finished: HashSet<String> = HashSet::new();
    let mut drain_deadline: Option<tokio::time::Instant> = None;
    let outcome = loop {
        let wait = match drain_deadline {
            Some(deadline) => timeouts
                .inactivity
                .min(deadline.saturating_duration_since(tokio::time::Instant::now())),
            None => timeouts.inactivity,
        };
        tokio::select! {
            event = tokio::time::timeout(wait, events.recv()) => match event {
                Ok(Some(Event::Update(update))) => match acp::parse_update(&update) {
                    Update::MessageChunk(chunk) => {
                        // Model text can't carry the activity marker: a tool line
                        // or a source chip only ever comes from a real tool call.
                        let chunk = strip_marker(chunk);
                        if !chunk.is_empty() {
                            text.push_str(&chunk);
                            let _ = tx.send(TurnMsg::Delta(chunk));
                        }
                    }
                    Update::ThoughtChunk => {
                        let _ = tx.send(TurnMsg::Thinking);
                    }
                    Update::ToolCall(info) | Update::ToolCallUpdate(info) => {
                        // Later updates may carry no name: keep the first one.
                        if !info.name.is_empty() {
                            tool_names.entry(info.id.clone()).or_insert_with(|| info.name.clone());
                        } else if !info.title.is_empty() {
                            tool_names.entry(info.id.clone()).or_insert_with(|| info.title.clone());
                        }
                        // A tool that ran (it completed) without NexQ allowing it:
                        // the agent auto-allowed it. Kill the process (a cancel
                        // would only ask the agent to stop itself).
                        if info.status.as_deref() == Some("completed") && !shared.was_allowed(&info.id) {
                            let tool = tool_names.get(&info.id).cloned().unwrap_or_else(|| "unknown".to_string());
                            shared.terminate(&format!("the agent ran {tool} without NexQ's approval"));
                            break Err(AgentError::Cli(
                                AgentErrorKind::Other,
                                format!(
                                    "Antigravity used its own {tool} tool, which NexQ does not allow. The session was closed."
                                ),
                            ));
                        }
                        if announced.insert(info.id.clone()) {
                            let _ = tx.send(TurnMsg::Tool(acp::tool_use_for_activity(&info, &servers)));
                        }
                        if info.finished() && finished.insert(info.id.clone()) {
                            let _ = tx.send(TurnMsg::ToolDone(ToolResult {
                                tool_use_id: info.id.clone(),
                                is_error: info.failed(),
                            }));
                        }
                    }
                    Update::Other => {}
                },
                Ok(Some(Event::Response { id, result })) if id == prompt_id => {
                    break finish_turn(result, std::mem::take(&mut text), started, drain_deadline.is_some());
                }
                Ok(Some(_)) => {}
                Ok(None) => break Err(shared.crash_error()),
                Err(_) => {
                    let drained_out = drain_deadline
                        .is_some_and(|deadline| tokio::time::Instant::now() >= deadline);
                    shared.terminate(&if drained_out {
                        format!("cancelled turn did not finish within {} s", timeouts.drain.as_secs())
                    } else {
                        format!("no output for {} s", timeouts.inactivity.as_secs())
                    });
                    break Err(AgentError::Timeout);
                }
            },
            _ = tx.closed(), if drain_deadline.is_none() => {
                let _ = shared.send_line(acp::notification("session/cancel", acp::cancel_params(&session_id)));
                drain_deadline = Some(tokio::time::Instant::now() + timeouts.drain);
            }
        }
    };
    let _ = tx.send(TurnMsg::Done(outcome));
}

/// The `session/prompt` response as the turn's outcome.
fn finish_turn(
    result: Result<Value, RpcError>,
    text: String,
    started: Instant,
    cancelled: bool,
) -> Result<TurnResult, AgentError> {
    match result {
        Err(_) if cancelled => Err(AgentError::Cancelled),
        Err(e) => Err(rpc_error(&e)),
        Ok(v) => {
            let end = acp::parse_prompt_end(&v);
            match end.stop_reason.as_str() {
                "cancelled" => Err(AgentError::Cancelled),
                "refusal" => Err(AgentError::Cli(
                    AgentErrorKind::Other,
                    "The model refused to answer this request".to_string(),
                )),
                // `end_turn`, and `max_tokens` / `max_turn_requests`: the text so far is the answer.
                _ => Ok(end.into_turn_result(text, started.elapsed().as_millis() as u64)),
            }
        }
    }
}

fn rpc_error(e: &RpcError) -> AgentError {
    let text = e.text();
    AgentError::Cli(acp::classify_acp_error(Some(e.code), &text), text)
}

// ---- startup ----------------------------------------------------------

struct Handshake<'a> {
    cwd: &'a Path,
    mcp_servers: &'a [Value],
    system_prompt: &'a str,
    /// Empty: keep the agent's default model.
    model: &'a str,
}

struct Opened {
    agent: AgentInit,
    session: acp::NewSession,
    /// The system prompt went out in `session/new`'s `_meta`.
    system_prompt_in_meta: bool,
}

/// One request and its response, skipping updates and other lines.
async fn rpc(
    shared: &Shared,
    events: &mut mpsc::UnboundedReceiver<Event>,
    next_id: &AtomicU64,
    method: &str,
    params: Value,
) -> Result<Value, AgentError> {
    let id = next_id.fetch_add(1, Ordering::SeqCst);
    if !shared.send_line(acp::request(id, method, params)) {
        return Err(shared.crash_error());
    }
    loop {
        match events.recv().await {
            Some(Event::Response { id: rid, result }) if rid == id => return result.map_err(|e| rpc_error(&e)),
            Some(_) => {}
            None => return Err(shared.crash_error()),
        }
    }
}

/// `initialize`, `session/new`, and `session/set_model` when a model was chosen.
async fn handshake(
    shared: &Shared,
    events: &mut mpsc::UnboundedReceiver<Event>,
    next_id: &AtomicU64,
    h: &Handshake<'_>,
) -> Result<Opened, AgentError> {
    let init = rpc(shared, events, next_id, "initialize", acp::initialize_params()).await?;
    let agent = acp::parse_initialize(&init);
    let in_meta = agent.system_prompt_append && !h.system_prompt.trim().is_empty();
    let params = acp::session_new_params(h.cwd, h.mcp_servers, in_meta.then_some(h.system_prompt));
    let new = rpc(shared, events, next_id, "session/new", params).await?;
    let session = acp::parse_session_new(&new).map_err(|e| AgentError::Cli(AgentErrorKind::Other, e))?;
    log::info!(
        "{} offers modes {:?} (current {:?})",
        shared.label, session.modes, session.current_mode
    );
    if let Some(mode) = session.safer_mode() {
        // A refusal is not fatal: the permission policy and the watch over tool
        // calls hold in any mode.
        if let Err(e) = rpc(shared, events, next_id, "session/set_mode", acp::set_mode_params(&session.session_id, &mode)).await {
            log::warn!("{} would not switch to mode {mode}: {e}", shared.label);
        }
    }
    if !h.model.is_empty() && session.current_model.as_deref() != Some(h.model) {
        rpc(shared, events, next_id, "session/set_model", acp::set_model_params(&session.session_id, h.model))
            .await
            .map_err(|e| match e {
                AgentError::Cli(kind, msg) => AgentError::Cli(kind, format!("model {} not available: {msg}", h.model)),
                other => other,
            })?;
    }
    Ok(Opened { agent, session, system_prompt_in_meta: in_meta })
}

/// Start `program`, `initialize`, open a session and return the models it
/// offers (`models.availableModels`), then end it. No prompt is sent, so no
/// tokens are used. Also the login check for Antigravity: an agent that is not
/// logged in fails `session/new` (`AgentError::kind() == NotLoggedIn`).
pub async fn probe_models(program: PathBuf, args: Vec<String>) -> Result<Vec<(String, String)>, AgentError> {
    let cwd = sandbox_dir();
    let (p, a, c) = (program.clone(), args, cwd.clone());
    let (shared, mut events) = tokio::task::spawn_blocking(move || {
        start_process(&p, &a, &c, &[], Arc::new(PermissionPolicy::deny_all()), None)
    })
    .await
    .map_err(|e| AgentError::Spawn(format!("spawn task failed: {e}")))??;
    let next_id = AtomicU64::new(1);
    let hello = Handshake { cwd: &cwd, mcp_servers: &[], system_prompt: "", model: "" };
    let opened = tokio::time::timeout(
        default_timeouts().init,
        handshake(&shared, &mut events, &next_id, &hello),
    )
    .await
    .unwrap_or(Err(AgentError::Timeout));
    shared.closed.store(true, Ordering::SeqCst);
    shared.stdin_tx.lock().unwrap().take();
    shared.alive.store(false, Ordering::SeqCst);
    shared.kill_process();
    opened.map(|o| o.session.models)
}

type Started = (Arc<Shared>, mpsc::UnboundedReceiver<Event>);

/// Spawn the child (no shell, no window, stripped env, in a job object) and its
/// three pipe threads. Blocking; run on a blocking thread.
fn start_process(
    program: &Path,
    args: &[String],
    cwd: &Path,
    env_remove: &[String],
    policy: Arc<PermissionPolicy>,
    owned_dir: Option<PathBuf>,
) -> Result<Started, AgentError> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    configure_command(&mut cmd, cwd);
    for key in ACP_STRIPPED_ENV {
        cmd.env_remove(key);
    }
    for key in env_remove {
        cmd.env_remove(key);
    }
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AgentError::Spawn(format!("CLI not installed: {} ({e})", program.display()))
        } else {
            AgentError::Spawn(format!("failed to start {}: {e}", program.display()))
        }
    })?;
    let tree = ProcessTree::adopt(&child);
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");

    let (stdin_tx, stdin_rx) = std_mpsc::channel::<String>();
    let (event_tx, event_rx) = mpsc::unbounded_channel();
    let shared = Arc::new(Shared {
        child: Mutex::new(Some(child)),
        tree: Mutex::new(Some(tree)),
        stdin_tx: Mutex::new(Some(stdin_tx)),
        alive: AtomicBool::new(true),
        closed: AtomicBool::new(false),
        stderr_tail: Mutex::new(VecDeque::new()),
        stderr_done: AtomicBool::new(false),
        exit_status: Mutex::new(None),
        label: label_of(program, args),
        decisions: Mutex::new(HashMap::new()),
        owned_dir,
    });

    // A pipe thread that fails to start must not leave the child running.
    let kill_shared = shared.clone();
    let spawn_thread = move |name: &str, f: Box<dyn FnOnce() + Send>| {
        std::thread::Builder::new().name(name.to_string()).spawn(f).map(|_| ()).map_err(|e| {
            kill_shared.alive.store(false, Ordering::SeqCst);
            kill_shared.kill_process();
            AgentError::Spawn(format!("cannot start {name} thread: {e}"))
        })
    };

    spawn_thread(
        "acp-stdin",
        Box::new(move || {
            let mut stdin = stdin;
            for line in stdin_rx {
                let written = stdin
                    .write_all(line.as_bytes())
                    .and_then(|_| stdin.write_all(b"\n"))
                    .and_then(|_| stdin.flush());
                if let Err(e) = written {
                    log::warn!("acp stdin write failed: {e}");
                    break;
                }
            }
            // Dropping `stdin` here closes the pipe, which ends the process.
        }),
    )?;

    let err_shared = shared.clone();
    spawn_thread(
        "acp-stderr",
        Box::new(move || {
            let _ = for_each_line(stderr, |line| {
                let line = line.trim_end();
                if line.is_empty() {
                    return;
                }
                log::debug!("{} stderr: {line}", err_shared.label);
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
        "acp-stdout",
        Box::new(move || {
            let read = for_each_line(stdout, |line| {
                if line.trim().is_empty() {
                    return;
                }
                match acp::parse_line(line) {
                    Ok(Incoming::Response { id, result }) => {
                        let _ = event_tx.send(Event::Response { id, result });
                    }
                    Ok(Incoming::Notification { method, params }) => {
                        let event = if method == "session/update" {
                            Event::Update(acp::update_of(&params).clone())
                        } else {
                            Event::Tick
                        };
                        let _ = event_tx.send(event);
                    }
                    Ok(Incoming::Request { id, method, params }) => {
                        answer_request(&out_shared, &policy, &id, &method, &params);
                        let _ = event_tx.send(Event::Tick);
                    }
                    Err(e) => log::warn!("{} stdout: skipping unparseable line ({e})", out_shared.label),
                }
            });
            if let Err(e) = read {
                log::warn!("{} stdout read failed: {e}", out_shared.label);
            }
            // Dead as of stdout EOF, before the bounded wait for the exit status,
            // so `is_alive` never reports a dying session as usable.
            out_shared.alive.store(false, Ordering::SeqCst);
            record_exit(&out_shared);
            // `event_tx` drops here: pending turns see the channel close.
        }),
    )?;

    Ok((shared, event_rx))
}

/// Reply to a request from the agent: permission requests from the policy,
/// everything else "Method not found" (the agent must never wait for us).
fn answer_request(shared: &Shared, policy: &PermissionPolicy, id: &Value, method: &str, params: &Value) {
    let line = if method == "session/request_permission" {
        let (req, outcome) = permission::decide_params(params, policy);
        let allowed = outcome.is_allow(&req);
        shared.decisions.lock().unwrap().insert(req.tool_call_id.clone(), allowed);
        log::info!(
            "{} permission: {} ({}) -> {}",
            shared.label,
            req.tool_name,
            req.kind,
            if allowed { "allowed" } else { "refused" }
        );
        acp::response_ok(id, outcome.to_result())
    } else {
        log::warn!("{}: unsupported request {method}", shared.label);
        acp::response_err(id, acp::METHOD_NOT_FOUND, "Method not found")
    };
    shared.send_line(line);
}

/// `agy`: the program's name, or for `node script.js` the script's.
fn label_of(program: &Path, args: &[String]) -> String {
    let stem = |p: &Path| p.file_stem().and_then(|s| s.to_str()).unwrap_or("agent").to_string();
    let program_stem = stem(program);
    if program_stem.eq_ignore_ascii_case("node") {
        if let Some(script) = args.first().filter(|a| !a.starts_with('-')) {
            return stem(Path::new(script));
        }
    }
    program_stem
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
    fn label_names_the_script_for_node_shims() {
        assert_eq!(label_of(Path::new("C:\\agy\\agy.exe"), &["acp".into()]), "agy");
        assert_eq!(
            label_of(Path::new("C:\\Program Files\\nodejs\\node.exe"), &["C:\\npm\\agent.js".into(), "--acp".into()]),
            "agent"
        );
        assert_eq!(label_of(Path::new("node"), &[]), "node");
    }

    #[test]
    fn launch_debug_hides_mcp_secrets() {
        let mut launch = AcpLaunch::new("agy".into(), vec![], "C:\\w".into());
        launch.mcp_servers = vec![serde_json::json!({"name": "mira", "env": [{"name": "KEY", "value": "hunter2"}]})];
        launch.system_prompt = "secret prompt".into();
        let shown = format!("{launch:?}");
        assert!(!shown.contains("hunter2") && !shown.contains("secret prompt"), "{shown}");
        assert_eq!(launch.server_names(), vec!["mira"]);
    }

    #[test]
    fn stripped_env_covers_paid_key_switches() {
        for key in ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_CLOUD_PROJECT", "GOOGLE_APPLICATION_CREDENTIALS", "OPENAI_API_KEY"] {
            assert!(ACP_STRIPPED_ENV.contains(&key), "{key}");
        }
    }

    #[test]
    fn finish_turn_maps_stop_reasons_and_errors() {
        let ok = |v: Value| finish_turn(Ok(v), "text".into(), Instant::now(), false);
        let r = ok(serde_json::json!({"stopReason": "end_turn", "usage": {"inputTokens": 5, "outputTokens": 2}})).unwrap();
        assert_eq!((r.text.as_str(), r.input_tokens, r.output_tokens), ("text", 5, 2));
        assert!(ok(serde_json::json!({"stopReason": "max_tokens"})).is_ok());
        assert!(matches!(ok(serde_json::json!({"stopReason": "cancelled"})), Err(AgentError::Cancelled)));
        assert_eq!(ok(serde_json::json!({"stopReason": "refusal"})).unwrap_err().kind(), AgentErrorKind::Other);
        let rpc = RpcError { code: 402, message: "Your prepayment credits are depleted".into(), data: None };
        let e = finish_turn(Err(rpc.clone()), String::new(), Instant::now(), false).unwrap_err();
        assert_eq!(e.kind(), AgentErrorKind::RateLimited);
        // An error after our own cancel is a cancel.
        assert!(matches!(finish_turn(Err(rpc), String::new(), Instant::now(), true), Err(AgentError::Cancelled)));
    }
}
