//! `ClaudeSession`: one persistent, hidden `claude.exe` process speaking
//! `stream-json`, with turns serialized FIFO.
//!
//! Three dedicated threads own the pipes (same shape as `stt/sherpa_sidecar.rs`):
//! a stdin writer fed by a channel, a stdout reader that parses JSONL into a
//! tokio channel of [`AgentEvent`]s, and a stderr reader that logs lines (and
//! keeps a short tail for crash reasons).
//!
//! The turn lock is a fair (FIFO) `tokio::sync::Mutex` around the event
//! receiver: whoever holds it owns the current turn and its events. Each turn
//! runs in a spawned driver task that holds the lock until the turn's `result`
//! arrives, so a cancelled or dropped `ask` never leaves stale events behind for
//! the next turn.

use super::command::{
    build_args, configure_session_command, configure_sources_env, sandbox_dir, SessionConfig,
};
use super::protocol::{
    classify_error, parse_line, user_message, user_message_with_images, AgentErrorKind, AgentEvent,
    ImageAttachment, McpServerState, ToolResult, ToolUse, TurnResult,
};
use crate::llm::provider::CancelToken;
use crate::sources::private_files::{private_dir, remove_private_file, write_private_file};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc as std_mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, Mutex as AsyncMutex, OwnedMutexGuard};

const CLOSE_GRACE: Duration = Duration::from_secs(2);
const STDERR_TAIL_LINES: usize = 20;

/// Passed to `ask`'s `on_delta` once per turn when the model starts thinking
/// before any text. Empty, so callers that only want text skip it; real
/// text deltas are never empty.
pub const THINKING_SIGNAL: &str = "";

/// Starts an `on_delta` token that is a tool use, not text. The `\u{1}`
/// control characters never occur in model text, and callers that only want
/// text check [`is_activity`] and skip it.
pub const ACTIVITY_PREFIX: &str = "\u{1}nexq-tool\u{1}";

/// Starts an `on_delta` token that says how a tool call ended.
pub const RESULT_PREFIX: &str = "\u{1}nexq-result\u{1}";

/// A tool result as an `on_delta` token.
pub fn encode_tool_result(r: &ToolResult) -> String {
    format!("{RESULT_PREFIX}{}", serde_json::json!({ "id": r.tool_use_id, "is_error": r.is_error }))
}

/// The tool result in an [`encode_tool_result`] token; `None` for anything else.
pub fn decode_tool_result(token: &str) -> Option<ToolResult> {
    let v: serde_json::Value = serde_json::from_str(token.strip_prefix(RESULT_PREFIX)?).ok()?;
    Some(ToolResult {
        tool_use_id: v["id"].as_str()?.to_string(),
        is_error: v["is_error"].as_bool().unwrap_or(true),
    })
}

/// Model text with the control character U+0001 removed, so it can never
/// start (or imitate) an [`ACTIVITY_PREFIX`] token.
pub fn strip_marker(text: String) -> String {
    if text.contains('\u{1}') {
        text.replace('\u{1}', "")
    } else {
        text
    }
}

/// A tool use as an `on_delta` token.
pub fn encode_activity(t: &ToolUse) -> String {
    format!(
        "{ACTIVITY_PREFIX}{}",
        serde_json::json!({ "id": t.id, "name": t.name, "input": t.input })
    )
}

/// The tool use in an [`encode_activity`] token; `None` for anything else.
pub fn decode_activity(token: &str) -> Option<ToolUse> {
    let v: serde_json::Value = serde_json::from_str(token.strip_prefix(ACTIVITY_PREFIX)?).ok()?;
    Some(ToolUse {
        id: v["id"].as_str().unwrap_or_default().to_string(),
        name: v["name"].as_str()?.to_string(),
        input: v.get("input").cloned().unwrap_or(serde_json::Value::Null),
    })
}

/// Is this `on_delta` token a tool use or tool result rather than text or a
/// thinking signal?
pub fn is_activity(token: &str) -> bool {
    token.starts_with(ACTIVITY_PREFIX) || token.starts_with(RESULT_PREFIX)
}

/// What `system/init` told us: every tool and each MCP server's status.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct InitInfo {
    pub tools: Vec<String>,
    pub mcp_servers: Vec<McpServerState>,
}

/// Names of the MCP servers that did not start (`failed`, or `needs-auth`:
/// NexQ cannot sign in). A server still `pending` is not counted.
pub fn failed_mcp_servers(info: &InitInfo) -> Vec<String> {
    info.mcp_servers
        .iter()
        .filter(|s| matches!(s.status.as_str(), "failed" | "needs-auth"))
        .map(|s| s.name.clone())
        .collect()
}

/// The failed servers of `info` by the name the user gave them (`labels` maps a
/// key to it; the key itself when unknown), as "Mira", "Mira and Wiki" or
/// "A, B and C".
pub fn failed_server_names(info: &InitInfo, labels: &[(String, String)]) -> String {
    let names: Vec<String> = failed_mcp_servers(info)
        .into_iter()
        .map(|key| labels.iter().find(|(k, _)| *k == key).map(|(_, l)| l.clone()).unwrap_or(key))
        .collect();
    match names.split_last() {
        Some((last, rest)) if !rest.is_empty() => format!("{} and {last}", rest.join(", ")),
        _ => names.join(""),
    }
}

/// Is a with-sources session that started with `info` useless? True when some
/// MCP server failed and nothing else is left: no notes folder, and no server
/// that is connected (or still connecting). A session whose servers all start,
/// or that still has a folder or another server, is usable: the failed
/// servers' tools are simply absent.
pub fn nothing_usable(has_folders: bool, info: &InitInfo) -> bool {
    let failed = failed_mcp_servers(info);
    if failed.is_empty() || has_folders {
        return false;
    }
    info.mcp_servers.iter().all(|s| failed.contains(&s.name))
}

/// Turns the CLI's cumulative `total_cost_usd` (per process) into per-turn
/// costs. One per process, so it starts over when a session (re)starts.
#[derive(Debug, Default)]
pub struct CostTracker {
    last_total: f64,
}

impl CostTracker {
    /// This turn's cost from the cumulative `total`; never negative.
    pub fn per_turn(&mut self, total: f64) -> f64 {
        let cost = (total - self.last_total).max(0.0);
        self.last_total = self.last_total.max(total);
        cost
    }
}

/// Guards against a hung `claude` process. A session that hits `append`,
/// `inactivity` or `drain` is killed (reported dead), so the next `ensure`
/// starts a fresh one instead of every request hanging behind it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionTimeouts {
    /// Spawn until `system/init` and the priming `result`.
    pub init: Duration,
    /// Whole `append_context` turn (`shouldQuery:false` answers at once).
    pub append: Duration,
    /// Longest gap between two events while a turn is running.
    pub inactivity: Duration,
    /// After a cancelled `ask`, how long its turn may take to reach `result`.
    pub drain: Duration,
}

impl Default for SessionTimeouts {
    fn default() -> Self {
        Self {
            init: Duration::from_secs(20),
            append: Duration::from_secs(30),
            inactivity: Duration::from_secs(90),
            drain: Duration::from_secs(60),
        }
    }
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum AgentError {
    /// The process could not be started (binary missing, bad path, ...).
    #[error("could not start Claude: {0}")]
    Spawn(String),
    /// The process exited (or its pipes broke) while it was needed.
    #[error("Claude session crashed: {0}")]
    Crashed(String),
    #[error("Claude did not respond in time")]
    Timeout,
    /// Stopped mid-turn: the prompt reached Claude.
    #[error("cancelled")]
    Cancelled,
    /// Stopped while waiting for the turn: the prompt never reached Claude.
    #[error("cancelled")]
    CancelledBeforeSend,
    /// A `result` with `is_error: true`, classified from its text.
    #[error("{1}")]
    Cli(AgentErrorKind, String),
    /// A with-sources session came up with nothing usable: no notes folder and
    /// every MCP server failed. `info` is its `system/init` (server statuses),
    /// so a caller such as the server check reads them instead of parsing
    /// `message`.
    #[error("{message}")]
    NoUsableSources { message: String, info: InitInfo },
}

impl AgentError {
    /// Stopped by the caller (before or during the turn).
    pub fn is_cancel(&self) -> bool {
        matches!(self, AgentError::Cancelled | AgentError::CancelledBeforeSend)
    }

    /// Coarse kind for status reasons and fallback decisions. A missing binary
    /// (`io::ErrorKind::NotFound` at spawn) is always `NotInstalled`; crash text
    /// that names a known cause (e.g. "not logged in" on stderr) keeps it.
    pub fn kind(&self) -> AgentErrorKind {
        match self {
            AgentError::Spawn(msg) => classify_error(msg),
            AgentError::Crashed(msg) => match classify_error(msg) {
                AgentErrorKind::Other => AgentErrorKind::Crashed,
                kind => kind,
            },
            AgentError::Timeout | AgentError::Cancelled | AgentError::CancelledBeforeSend => {
                AgentErrorKind::Other
            }
            AgentError::Cli(kind, _) => *kind,
            AgentError::NoUsableSources { .. } => AgentErrorKind::Other,
        }
    }
}

/// State shared with the pipe threads and turn drivers.
struct Shared {
    child: Mutex<Option<Child>>,
    alive: AtomicBool,
    /// Set by `close`/drop so in-flight turns report a deliberate shutdown.
    closed: AtomicBool,
    stderr_tail: Mutex<VecDeque<String>>,
    stderr_done: AtomicBool,
    exit_status: Mutex<Option<String>>,
    cost: Mutex<CostTracker>,
    /// The latest `system/init`.
    init: Mutex<InitInfo>,
}

impl Shared {
    /// Fill `result.cost_usd` with this turn's share of the process total.
    fn settle_cost(&self, mut result: TurnResult) -> TurnResult {
        result.cost_usd = self.cost.lock().unwrap().per_turn(result.total_cost_usd);
        result
    }

    /// Readable reason for an unexpected exit: exit status + last stderr lines.
    fn crash_reason(&self) -> String {
        if self.closed.load(Ordering::SeqCst) {
            return "session closed".to_string();
        }
        let status = self
            .exit_status
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| "pipe closed".to_string());
        let tail: Vec<String> = self.stderr_tail.lock().unwrap().iter().cloned().collect();
        if tail.is_empty() {
            format!("claude exited unexpectedly ({status})")
        } else {
            format!(
                "claude exited unexpectedly ({status}): {}",
                tail.join(" | ")
            )
        }
    }

    /// Kill an unresponsive process; `reason` becomes its crash reason.
    fn terminate(&self, reason: &str) {
        log::warn!("claude session unresponsive ({reason}); killing it");
        *self.exit_status.lock().unwrap() = Some(reason.to_string());
        self.alive.store(false, Ordering::SeqCst);
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

enum TurnMsg {
    Delta(String),
    Tool(ToolUse),
    ToolDone(ToolResult),
    Thinking,
    Done(Result<TurnResult, AgentError>),
}

pub struct ClaudeSession {
    model: String,
    shared: Arc<Shared>,
    /// `None` once closed; dropping the sender closes the child's stdin.
    stdin_tx: Mutex<Option<std_mpsc::Sender<String>>>,
    /// The FIFO turn lock; the holder owns the current turn's events.
    turn: Arc<AsyncMutex<mpsc::UnboundedReceiver<AgentEvent>>>,
    prompt_file: PathBuf,
    /// The private mcp-config file (holds secrets): deleted when `system/init`
    /// arrives, and on close and drop if it never did.
    mcp_config_file: Option<PathBuf>,
    timeouts: SessionTimeouts,
}

impl ClaudeSession {
    /// Start `bin` with the exact launch args, the system prompt written to a
    /// unique temp file (deleted on close/drop), and wait up to 20 s for
    /// `system/init`. The caller resolves `bin` (detection is synchronous).
    ///
    /// The CLI prints `system/init` only after it reads its first stdin message
    /// (and again at the start of every turn), so the session is primed with an
    /// empty `shouldQuery:false` message: no model call, just init + an empty
    /// `result`.
    pub async fn spawn(bin: PathBuf, cfg: SessionConfig) -> Result<ClaudeSession, AgentError> {
        Self::spawn_with_timeouts(bin, cfg, SessionTimeouts::default()).await
    }

    /// [`spawn`](Self::spawn) with custom hang guards (tests use short ones).
    pub async fn spawn_with_timeouts(
        bin: PathBuf,
        cfg: SessionConfig,
        timeouts: SessionTimeouts,
    ) -> Result<ClaudeSession, AgentError> {
        let prompt_file =
            std::env::temp_dir().join(format!("nexq-claude-sp-{}.txt", uuid::Uuid::new_v4()));
        std::fs::write(&prompt_file, &cfg.system_prompt).map_err(|e| {
            AgentError::Spawn(format!(
                "cannot write system prompt file {}: {e}",
                prompt_file.display()
            ))
        })?;

        // The mcp-config holds each server's own secret values, so it goes in
        // the private folder (never the sandbox the model can read) and never
        // in the process env.
        let mcp_config_file = match cfg.sources.as_ref().and_then(|s| s.mcp_config_json.as_deref()) {
            Some(json) => match write_private_file(&private_dir(), json) {
                Ok(path) => Some(path),
                Err(e) => {
                    let _ = std::fs::remove_file(&prompt_file);
                    return Err(AgentError::Spawn(format!("cannot write the sources config: {e}")));
                }
            },
            None => None,
        };
        let args = build_args(&cfg, &prompt_file, mcp_config_file.as_deref());
        let thinking = cfg.thinking;
        // `None` for a plain session, else whether a notes folder is among its sources.
        let sources_folders = cfg.sources.as_ref().map(|s| !s.add_dirs.is_empty());
        let server_labels = cfg.sources.as_ref().map(|s| s.server_labels.clone()).unwrap_or_default();
        // `Some(MCP_TIMEOUT override)` for a with-sources session.
        let with_sources = cfg.sources.as_ref().map(|s| s.mcp_startup_timeout_ms);
        let started = tokio::task::spawn_blocking(move || start_process(&bin, &args, thinking, with_sources))
            .await
            .map_err(|e| AgentError::Spawn(format!("spawn task failed: {e}")))
            .and_then(|r| r);
        let (shared, stdin_tx, events) = match started {
            Ok(parts) => parts,
            Err(e) => {
                let _ = std::fs::remove_file(&prompt_file);
                if let Some(file) = &mcp_config_file {
                    remove_private_file(file);
                }
                return Err(e);
            }
        };

        let session = ClaudeSession {
            model: cfg.model,
            shared,
            stdin_tx: Mutex::new(Some(stdin_tx)),
            turn: Arc::new(AsyncMutex::new(events)),
            prompt_file,
            mcp_config_file,
            timeouts,
        };

        let init = tokio::time::timeout(timeouts.init, session.prime())
            .await
            .unwrap_or(Err(AgentError::Timeout));

        // A with-sources session whose MCP servers all failed (and has no notes
        // folder) has nothing to offer: report that, with the statuses. If
        // something is left it starts, and the failed servers' tools are
        // absent (the caller tells the user which ones).
        let init = init.and_then(|()| match sources_folders {
            Some(has_folders) => {
                let info = session.init_info();
                if nothing_usable(has_folders, &info) {
                    Err(AgentError::NoUsableSources {
                        message: format!("{} didn't start", failed_server_names(&info, &server_labels)),
                        info,
                    })
                } else {
                    Ok(())
                }
            }
            None => Ok(()),
        });

        match init {
            Ok(()) => Ok(session),
            Err(e) => {
                session.close().await;
                Err(e)
            }
        }
    }

    /// Append `text` to the session context without a model call
    /// (`shouldQuery:false`) and wait for its empty `result`.
    pub async fn append_context(&self, text: &str) -> Result<(), AgentError> {
        let mut rx = self.start_turn(text, false, &[], None).await?;
        let wait = async {
            loop {
                match rx.recv().await {
                    Some(TurnMsg::Delta(_)) | Some(TurnMsg::Tool(_)) | Some(TurnMsg::ToolDone(_)) | Some(TurnMsg::Thinking) => {}
                    Some(TurnMsg::Done(r)) => return r,
                    None => return Err(AgentError::Crashed(self.shared.crash_reason())),
                }
            }
        };
        let result = match tokio::time::timeout(self.timeouts.append, wait).await {
            Ok(result) => result,
            Err(_) => {
                self.shared.terminate(&format!(
                    "no reply to context message within {} s",
                    self.timeouts.append.as_secs()
                ));
                Err(AgentError::Timeout)
            }
        };
        into_outcome(result).map(|_| ())
    }

    /// Ask one question; text deltas go to `on_delta` as they stream, and
    /// [`THINKING_SIGNAL`] once if the model thinks before its first text.
    /// Turns are FIFO per session. When `cancel` fires, deltas stop at once
    /// and this returns `Err(Cancelled)`; the turn is drained in the
    /// background until its `result`, and only then may the next turn start.
    pub async fn ask(
        &self,
        prompt: &str,
        on_delta: Box<dyn Fn(&str) + Send + Sync>,
        cancel: Arc<CancelToken>,
    ) -> Result<TurnResult, AgentError> {
        self.ask_with_images(prompt, &[], on_delta, cancel).await
    }

    /// [`ClaudeSession::ask`] with `images` sent along with the question.
    pub async fn ask_with_images(
        &self,
        prompt: &str,
        images: &[ImageAttachment],
        on_delta: Box<dyn Fn(&str) + Send + Sync>,
        cancel: Arc<CancelToken>,
    ) -> Result<TurnResult, AgentError> {
        let mut rx = self.start_turn(prompt, true, images, Some(&cancel)).await?;
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
                        // Tool use means the model is working: no thinking signal after it.
                        quiet = true;
                        on_delta(&encode_activity(&tool));
                    }
                    Some(TurnMsg::ToolDone(result)) => on_delta(&encode_tool_result(&result)),
                    Some(TurnMsg::Done(result)) => return into_outcome(result),
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

    /// Close stdin, give the process 2 s to exit, then kill it. Idempotent.
    pub async fn close(&self) {
        self.shared.closed.store(true, Ordering::SeqCst);
        self.stdin_tx.lock().unwrap().take();
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
        if let Some(mut child) = self.shared.child.lock().unwrap().take() {
            if matches!(child.try_wait(), Ok(None)) {
                log::warn!("claude session did not exit within 2 s of stdin close; killing");
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        self.shared.alive.store(false, Ordering::SeqCst);
        remove_prompt_file(&self.prompt_file);
        if let Some(file) = &self.mcp_config_file {
            remove_private_file(file);
        }
    }

    /// The tools and MCP server states of the latest `system/init`.
    pub fn init_info(&self) -> InitInfo {
        self.shared.init.lock().unwrap().clone()
    }

    /// Where this session's private mcp-config file is (only the path: its
    /// content holds secrets). `None` for a session without MCP servers.
    pub fn mcp_config_path(&self) -> Option<&Path> {
        self.mcp_config_file.as_deref()
    }

    /// The model this session was started with (as configured, e.g. `haiku`).
    pub fn model(&self) -> &str {
        &self.model
    }

    /// Send the priming message and wait for `system/init` and its `result`.
    async fn prime(&self) -> Result<(), AgentError> {
        let mut events = self.turn.lock().await;
        self.send_line(user_message("", false))?;
        let mut init_seen = false;
        loop {
            match events.recv().await {
                Some(AgentEvent::Init { session_id, model, tools, mcp_servers }) => {
                    log::info!("claude session {session_id} ready (model {model})");
                    *self.shared.init.lock().unwrap() = InitInfo { tools, mcp_servers };
                    init_seen = true;
                    // The CLI keeps its MCP config in memory from here on (it
                    // restarts a dead server without re-reading the file), so
                    // the file with the secrets in it goes now, not at close.
                    if let Some(file) = &self.mcp_config_file {
                        remove_private_file(file);
                    }
                }
                Some(AgentEvent::TurnComplete(result)) if init_seen => {
                    return into_outcome(Ok(self.shared.settle_cost(result))).map(|_| ());
                }
                Some(AgentEvent::TurnComplete(_)) => {
                    return Err(AgentError::Spawn(
                        "claude sent a result before system/init".into(),
                    ));
                }
                Some(_) => {}
                None => return Err(AgentError::Crashed(self.shared.crash_reason())),
            }
        }
    }

    fn send_line(&self, line: String) -> Result<(), AgentError> {
        let sent = match self.stdin_tx.lock().unwrap().as_ref() {
            Some(tx) => tx.send(line).is_ok(),
            None => false,
        };
        if sent {
            Ok(())
        } else {
            Err(AgentError::Crashed(self.shared.crash_reason()))
        }
    }

    /// Take the turn lock (FIFO), send one user message and spawn the driver
    /// that forwards this turn's events until its `result`, holding the lock.
    async fn start_turn(
        &self,
        text: &str,
        query: bool,
        images: &[ImageAttachment],
        cancel: Option<&CancelToken>,
    ) -> Result<mpsc::UnboundedReceiver<TurnMsg>, AgentError> {
        let guard = match cancel {
            Some(token) => tokio::select! {
                biased;
                _ = token.cancelled() => return Err(AgentError::CancelledBeforeSend),
                guard = self.turn.clone().lock_owned() => guard,
            },
            None => self.turn.clone().lock_owned().await,
        };
        if cancel.is_some_and(CancelToken::is_cancelled) {
            return Err(AgentError::CancelledBeforeSend);
        }
        if !self.is_alive() {
            return Err(AgentError::Crashed(self.shared.crash_reason()));
        }
        self.send_line(user_message_with_images(text, query, images))?;
        let (tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(drive_turn(guard, tx, self.shared.clone(), self.timeouts));
        Ok(rx)
    }
}

impl Drop for ClaudeSession {
    fn drop(&mut self) {
        self.shared.closed.store(true, Ordering::SeqCst);
        self.stdin_tx.lock().unwrap().take();
        if let Some(mut child) = self.shared.child.lock().unwrap().take() {
            if matches!(child.try_wait(), Ok(None)) {
                let _ = child.kill();
            }
        }
        self.shared.alive.store(false, Ordering::SeqCst);
        remove_prompt_file(&self.prompt_file);
        if let Some(file) = &self.mcp_config_file {
            remove_private_file(file);
        }
    }
}

/// Forward one turn's deltas until its `result` (or process exit), then
/// release the turn lock. Keeps draining after the receiver is gone (a
/// cancelled `ask`), but at most `timeouts.drain`. No event for
/// `timeouts.inactivity`, or a drain that runs out, kills the process and
/// ends the turn with `Timeout`.
async fn drive_turn(
    mut events: OwnedMutexGuard<mpsc::UnboundedReceiver<AgentEvent>>,
    tx: mpsc::UnboundedSender<TurnMsg>,
    shared: Arc<Shared>,
    timeouts: SessionTimeouts,
) {
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
                Ok(Some(AgentEvent::TextDelta(text))) => {
                    // Model text can't carry the activity marker: a tool line
                    // or a source chip only ever comes from a real tool use.
                    let text = strip_marker(text);
                    if !text.is_empty() {
                        let _ = tx.send(TurnMsg::Delta(text));
                    }
                }
                Ok(Some(AgentEvent::ThinkingDelta)) => {
                    let _ = tx.send(TurnMsg::Thinking);
                }
                Ok(Some(AgentEvent::ToolUses(uses))) => {
                    for tool in uses {
                        let _ = tx.send(TurnMsg::Tool(tool));
                    }
                }
                Ok(Some(AgentEvent::ToolResults(results))) => {
                    for result in results {
                        let _ = tx.send(TurnMsg::ToolDone(result));
                    }
                }
                Ok(Some(AgentEvent::TurnComplete(result))) => break Ok(shared.settle_cost(result)),
                Ok(Some(_)) => {}
                Ok(None) => break Err(AgentError::Crashed(shared.crash_reason())),
                Err(_) => {
                    let drained_out = drain_deadline
                        .is_some_and(|deadline| tokio::time::Instant::now() >= deadline);
                    shared.terminate(&if drained_out {
                        format!(
                            "cancelled turn did not finish within {} s",
                            timeouts.drain.as_secs()
                        )
                    } else {
                        format!("no output for {} s", timeouts.inactivity.as_secs())
                    });
                    break Err(AgentError::Timeout);
                }
            },
            _ = tx.closed(), if drain_deadline.is_none() => {
                drain_deadline = Some(tokio::time::Instant::now() + timeouts.drain);
            }
        }
    };
    let _ = tx.send(TurnMsg::Done(outcome));
}

fn into_outcome(result: Result<TurnResult, AgentError>) -> Result<TurnResult, AgentError> {
    let result = result?;
    if result.is_error {
        Err(AgentError::Cli(classify_error(&result.text), result.text))
    } else {
        Ok(result)
    }
}

fn remove_prompt_file(path: &Path) {
    if let Err(e) = std::fs::remove_file(path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            log::warn!("cannot remove system prompt file {}: {e}", path.display());
        }
    }
}

type Started = (
    Arc<Shared>,
    std_mpsc::Sender<String>,
    mpsc::UnboundedReceiver<AgentEvent>,
);

/// Spawn the child (no shell, no window, sandbox cwd, stripped env) and its
/// three pipe threads. Blocking; run on a blocking thread.
fn start_process(
    bin: &Path,
    args: &[String],
    thinking: bool,
    with_sources: Option<Option<u32>>,
) -> Result<Started, AgentError> {
    let mut cmd = Command::new(bin);
    cmd.args(args);
    configure_session_command(&mut cmd, &sandbox_dir(), thinking);
    if let Some(startup_timeout_ms) = with_sources {
        configure_sources_env(&mut cmd, startup_timeout_ms);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AgentError::Spawn(format!("Claude CLI not installed: {} ({e})", bin.display()))
        } else {
            AgentError::Spawn(format!("failed to start {}: {e}", bin.display()))
        }
    })?;
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");

    let shared = Arc::new(Shared {
        child: Mutex::new(Some(child)),
        alive: AtomicBool::new(true),
        closed: AtomicBool::new(false),
        stderr_tail: Mutex::new(VecDeque::new()),
        stderr_done: AtomicBool::new(false),
        exit_status: Mutex::new(None),
        cost: Mutex::new(CostTracker::default()),
        init: Mutex::new(InitInfo::default()),
    });
    let (stdin_tx, stdin_rx) = std_mpsc::channel::<String>();
    let (event_tx, event_rx) = mpsc::unbounded_channel();

    // A pipe thread that fails to start must not leave the child running.
    let kill_shared = shared.clone();
    let spawn_thread = move |name: &str, f: Box<dyn FnOnce() + Send>| {
        std::thread::Builder::new()
            .name(name.to_string())
            .spawn(f)
            .map(|_| ())
            .map_err(|e| {
                if let Some(mut child) = kill_shared.child.lock().unwrap().take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                kill_shared.alive.store(false, Ordering::SeqCst);
                AgentError::Spawn(format!("cannot start {name} thread: {e}"))
            })
    };

    spawn_thread(
        "claude-stdin",
        Box::new(move || {
            let mut stdin = stdin;
            for line in stdin_rx {
                let written = stdin
                    .write_all(line.as_bytes())
                    .and_then(|_| stdin.write_all(b"\n"))
                    .and_then(|_| stdin.flush());
                if let Err(e) = written {
                    log::warn!("claude stdin write failed: {e}");
                    break;
                }
            }
            // Dropping `stdin` here closes the pipe, which ends the process.
        }),
    )?;

    let err_shared = shared.clone();
    spawn_thread(
        "claude-stderr",
        Box::new(move || {
            let _ = for_each_line(stderr, |line| {
                let line = line.trim_end();
                if line.is_empty() {
                    return;
                }
                log::debug!("claude stderr: {line}");
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
        "claude-stdout",
        Box::new(move || {
            // `Other` events (status, thinking token counts, ...) are forwarded too:
            // turn drivers ignore them, but they prove the CLI is still alive
            // for the inactivity watchdog during long thinking phases.
            let read = for_each_line(stdout, |line| match parse_line(line) {
                Ok(event) => {
                    let _ = event_tx.send(event);
                }
                Err(e) => log::warn!("claude stdout: skipping unparseable line ({e})"),
            });
            if let Err(e) = read {
                log::warn!("claude stdout read failed: {e}");
            }
            // Dead as of stdout EOF, before the bounded wait for the exit status,
            // so `is_alive` never reports a dying session as usable.
            out_shared.alive.store(false, Ordering::SeqCst);
            record_exit(&out_shared);
            // `event_tx` drops here: pending turns see the channel close.
        }),
    )?;

    Ok((shared, stdin_tx, event_rx))
}

/// Call `f` with every line of `reader` (without the line ending) until EOF.
/// Invalid UTF-8 is replaced rather than ending the stream, so one bad byte
/// never stops a pipe from being drained.
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
    fn kind_maps_spawn_crash_and_cli_errors() {
        assert_eq!(
            AgentError::Spawn("Claude CLI not installed: C:\\x\\claude.exe".into()).kind(),
            AgentErrorKind::NotInstalled
        );
        assert_eq!(
            AgentError::Crashed("claude exited unexpectedly (exit code 1)".into()).kind(),
            AgentErrorKind::Crashed
        );
        assert_eq!(
            AgentError::Crashed("claude exited unexpectedly (exit code 1): Not logged in".into())
                .kind(),
            AgentErrorKind::NotLoggedIn
        );
        assert_eq!(
            AgentError::Cli(AgentErrorKind::RateLimited, "x".into()).kind(),
            AgentErrorKind::RateLimited
        );
    }

    #[test]
    fn cost_tracker_turns_cumulative_totals_into_per_turn_costs() {
        // The CLI's `total_cost_usd` over a priming message and three turns.
        let mut costs = CostTracker::default();
        let per_turn: Vec<f64> = [0.0, 0.0049, 0.0100, 0.0193]
            .into_iter()
            .map(|total| costs.per_turn(total))
            .collect();
        let rounded: Vec<f64> = per_turn.iter().map(|c| (c * 1e6).round() / 1e6).collect();
        assert_eq!(rounded, vec![0.0, 0.0049, 0.0051, 0.0093]);
        // Never negative, even if the total goes backwards.
        assert_eq!(costs.per_turn(0.01), 0.0);
        // A new process starts over.
        assert_eq!(CostTracker::default().per_turn(0.002), 0.002);
    }

    #[test]
    fn settle_cost_uses_the_real_result_line() {
        let shared = Shared {
            child: Mutex::new(None),
            alive: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            stderr_tail: Mutex::new(VecDeque::new()),
            stderr_done: AtomicBool::new(true),
            exit_status: Mutex::new(None),
            cost: Mutex::new(CostTracker::default()),
            init: Mutex::new(InitInfo::default()),
        };
        let first = shared.settle_cost(TurnResult { total_cost_usd: 0.0100, ..Default::default() });
        assert_eq!(first.cost_usd, 0.0100);
        let AgentEvent::TurnComplete(real) =
            parse_line(crate::llm::cli_agent::protocol::tests::REAL_RESULT).unwrap()
        else {
            panic!("not a result");
        };
        let second = shared.settle_cost(real);
        assert!((second.cost_usd - 0.00933).abs() < 1e-9, "{}", second.cost_usd);
        assert_eq!(second.total_cost_usd, 0.01933);
    }

    #[test]
    fn activity_round_trips_and_is_never_text() {
        let t = ToolUse { id: "toolu_1".into(), name: "Read".into(), input: serde_json::json!({"file_path": "D:\\V\\a b.md"}) };
        let enc = encode_activity(&t);
        assert!(is_activity(&enc) && !enc.is_empty());
        assert_eq!(decode_activity(&enc), Some(t.clone()));
        assert_eq!(decode_activity("plain text"), None);
        assert_eq!(decode_activity(&format!("{ACTIVITY_PREFIX}not json")), None);
        assert!(!is_activity("") && !is_activity("hello"));
        let done = ToolResult { tool_use_id: "toolu_1".into(), is_error: true };
        let enc = encode_tool_result(&done);
        assert!(is_activity(&enc));
        assert_eq!(decode_tool_result(&enc), Some(done));
        assert_eq!(decode_tool_result(&encode_activity(&t)), None);
        assert_eq!(decode_activity(&enc), None);
    }

    #[test]
    fn nothing_usable_needs_a_failed_server_and_nothing_else() {
        let state = |name: &str, status: &str| McpServerState { name: name.into(), status: status.into() };
        let info = |servers: Vec<McpServerState>| InitInfo { tools: vec![], mcp_servers: servers };
        // Nothing failed.
        assert!(!nothing_usable(false, &info(vec![state("a", "connected")])));
        assert!(!nothing_usable(false, &info(vec![])));
        // The only server failed.
        assert!(nothing_usable(false, &info(vec![state("a", "failed")])));
        assert!(nothing_usable(false, &info(vec![state("a", "failed"), state("b", "needs-auth")])));
        // A folder, a connected server or one still connecting is left.
        assert!(!nothing_usable(true, &info(vec![state("a", "failed")])));
        assert!(!nothing_usable(false, &info(vec![state("a", "failed"), state("b", "connected")])));
        assert!(!nothing_usable(false, &info(vec![state("a", "failed"), state("b", "pending")])));
    }

    #[test]
    fn model_text_cannot_carry_the_activity_marker() {
        let spoof = format!("{ACTIVITY_PREFIX}{{\"name\":\"mcp__mira__x\",\"input\":{{}}}}");
        let clean = strip_marker(spoof);
        assert!(!is_activity(&clean) && !clean.contains('\u{1}'), "{clean:?}");
        assert_eq!(strip_marker("plain answer".to_string()), "plain answer");
        assert_eq!(strip_marker("\u{1}".to_string()), "");
    }

    #[test]
    fn failed_server_names_use_labels() {
        let st = |n: &str, s: &str| McpServerState { name: n.into(), status: s.into() };
        let info = InitInfo { tools: vec![], mcp_servers: vec![st("mira", "failed"), st("wiki", "needs-auth"), st("c", "failed"), st("ok", "connected")] };
        let labels = vec![("mira".to_string(), "Mira".to_string()), ("wiki".to_string(), "Wiki".to_string())];
        assert_eq!(failed_server_names(&info, &labels), "Mira, Wiki and c");
        let one = InitInfo { tools: vec![], mcp_servers: vec![st("mira", "failed")] };
        assert_eq!(failed_server_names(&one, &labels), "Mira");
    }

    #[test]
    fn failed_servers_from_init() {
        let AgentEvent::Init { tools, mcp_servers, .. } =
            parse_line(include_str!("testdata/init_mcp_failed.json")).unwrap()
        else {
            panic!("not an init");
        };
        let info = InitInfo { tools, mcp_servers };
        assert_eq!(failed_mcp_servers(&info), vec!["broken".to_string()]);
        let AgentEvent::Init { tools, mcp_servers, .. } =
            parse_line(include_str!("testdata/init_with_mcp.json")).unwrap()
        else {
            panic!("not an init");
        };
        assert!(failed_mcp_servers(&InitInfo { tools, mcp_servers }).is_empty());
        let auth = InitInfo {
            tools: vec![],
            mcp_servers: vec![
                McpServerState { name: "a".into(), status: "needs-auth".into() },
                McpServerState { name: "b".into(), status: "pending".into() },
            ],
        };
        assert_eq!(failed_mcp_servers(&auth), vec!["a".to_string()]);
    }

    #[test]
    fn line_reader_survives_invalid_utf8() {
        let mut lines = Vec::new();
        for_each_line(&b"a\n\xff\xfeb\r\n{\"x\":1}"[..], |l| {
            lines.push(l.to_string())
        })
        .unwrap();
        assert_eq!(lines, vec!["a", "\u{FFFD}\u{FFFD}b", "{\"x\":1}"]);
    }

    #[test]
    fn error_result_becomes_classified_cli_error() {
        let r = TurnResult {
            text: "Not logged in · Please run /login".into(),
            is_error: true,
            ..Default::default()
        };
        assert_eq!(
            into_outcome(Ok(r)),
            Err(AgentError::Cli(
                AgentErrorKind::NotLoggedIn,
                "Not logged in · Please run /login".into()
            ))
        );
    }
}
