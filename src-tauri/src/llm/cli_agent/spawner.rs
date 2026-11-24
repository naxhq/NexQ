//! `CliSpawner`: starts the session of whichever CLI agent
//! [`SessionConfig::kind`] names. The binary is looked up on every spawn, so
//! a fresh install is picked up without restarting NexQ.
//!
//! - Claude: `claude.exe` and its stream-json protocol (`ClaudeSession`).
//! - Antigravity: `agy acp` (`AcpSession`). It is given no folder of the user's:
//!   its cwd is a new empty folder under NexQ's agent sandbox, deleted with the
//!   session, and the notes come through NexQ's `nexq_notes` MCP server (one of
//!   the `mcpServers` of `session/new`). Its data lives in NexQ's own
//!   `--gemini-dir`, so none of the user's MCP servers or plugins load.
//! - Codex: `codex app-server` (`CodexSession`). Effort is passed as resolved
//!   by the manager (clamped to the model's own levels); the MCP servers
//!   (`nexq_notes` included) go in the thread's config so their secrets stay
//!   off the command line. The shell tool is always off.
//!
//! What each kind turns off of the user's own setup is documented in
//! `acp/launch.rs`, `codex/launch.rs` and `command.rs`.

use super::acp::{antigravity_args, find_agy, session::default_timeouts as acp_timeouts, AcpLaunch, AcpSession};
use super::codex::{find_codex, CodexLaunch, CodexSession};
use super::command::{sandbox_dir, SessionConfig};
use super::detect::{find_current_claude, ClaudeBinaryError};
use super::manager::{SessionHandle, SessionSpawner, SOURCES_INIT_TIMEOUT};
use super::session::{AgentError, ClaudeSession, SessionTimeouts};
use super::sources_convert::{acp_sources, adapt_system_prompt, codex_sources};
use super::CliAgentKind;
use async_trait::async_trait;
use std::sync::Arc;

/// The spawner the app uses.
pub struct CliSpawner;

#[async_trait]
impl SessionSpawner for CliSpawner {
    async fn spawn(&self, cfg: SessionConfig) -> Result<Arc<dyn SessionHandle>, AgentError> {
        match cfg.kind {
            CliAgentKind::Claude => spawn_claude(cfg).await,
            CliAgentKind::Antigravity => spawn_antigravity(cfg).await,
            CliAgentKind::Codex => spawn_codex(cfg).await,
        }
    }
}

async fn spawn_claude(cfg: SessionConfig) -> Result<Arc<dyn SessionHandle>, AgentError> {
    let bin = claude_binary_for_spawn(tokio::task::spawn_blocking(find_current_claude).await.ok())?;
    let timeouts = if cfg.sources.is_some() {
        SessionTimeouts { init: SOURCES_INIT_TIMEOUT, ..SessionTimeouts::default() }
    } else {
        SessionTimeouts::default()
    };
    Ok(Arc::new(ClaudeSession::spawn_with_timeouts(bin, cfg, timeouts).await?))
}

/// The binary of a Claude session, or why none is started: missing, or too old
/// (no process is launched for it, see `detect::MIN_CLAUDE_VERSION`).
fn claude_binary_for_spawn(found: Option<Result<std::path::PathBuf, ClaudeBinaryError>>) -> Result<std::path::PathBuf, AgentError> {
    match found {
        Some(Ok(bin)) => Ok(bin),
        Some(Err(ClaudeBinaryError::TooOld(message))) => Err(AgentError::Spawn(message)),
        Some(Err(ClaudeBinaryError::NotFound)) | None => {
            Err(AgentError::Spawn("Claude CLI not installed: claude.exe not found".into()))
        }
    }
}

/// A new empty working folder for one Antigravity session, `acp-<id>` in the
/// agent sandbox. Antigravity may write there (it auto-allows that), so it is
/// never shared and is deleted when the session ends.
pub fn session_dir() -> std::path::PathBuf {
    sandbox_dir().join(format!("acp-{}", uuid::Uuid::new_v4()))
}

/// Delete session folders a crash left behind (older than a day).
pub fn remove_stale_session_dirs() {
    let Ok(entries) = std::fs::read_dir(sandbox_dir()) else { return };
    let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(24 * 3600);
    for entry in entries.flatten() {
        let is_ours = entry.file_name().to_string_lossy().starts_with("acp-");
        let old = entry.metadata().and_then(|m| m.modified()).map(|t| t < cutoff).unwrap_or(false);
        if is_ours && old {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// The launch of an Antigravity session (everything but the binary).
pub fn antigravity_launch(program: std::path::PathBuf, cfg: &SessionConfig) -> AcpLaunch {
    let sources = acp_sources(cfg.sources.as_ref());
    let has_notes = cfg.sources.as_ref().is_some_and(|s| !s.add_dirs.is_empty());
    let mut launch = AcpLaunch::new(program, antigravity_args(), session_dir());
    launch.remove_cwd_on_close = true;
    launch.model = cfg.model.clone();
    launch.system_prompt = adapt_system_prompt(&cfg.system_prompt, has_notes);
    launch.mcp_servers = sources.mcp_servers;
    launch.policy = sources.policy;
    launch
}

async fn spawn_antigravity(cfg: SessionConfig) -> Result<Arc<dyn SessionHandle>, AgentError> {
    let program = tokio::task::spawn_blocking(find_agy)
        .await
        .ok()
        .flatten()
        .ok_or_else(|| AgentError::Spawn("Antigravity CLI not installed: agy.exe not found".into()))?;
    let launch = antigravity_launch(program, &cfg);
    // The folder is created here: agy takes it as its working directory.
    let cwd = launch.cwd.clone();
    tokio::task::spawn_blocking(move || {
        remove_stale_session_dirs();
        std::fs::create_dir_all(&cwd)
    })
    .await
    .map_err(|e| AgentError::Spawn(format!("spawn task failed: {e}")))?
    .map_err(|e| AgentError::Spawn(format!("cannot create the session folder: {e}")))?;
    let mut timeouts = acp_timeouts();
    if cfg.sources.is_some() {
        timeouts.init = SOURCES_INIT_TIMEOUT;
    }
    Ok(Arc::new(AcpSession::spawn_with_timeouts(launch, timeouts).await?))
}

/// The launch of a Codex session (everything but the binary).
pub fn codex_launch(program: std::path::PathBuf, prefix_args: Vec<String>, cfg: &SessionConfig) -> CodexLaunch {
    let sources = codex_sources(cfg.sources.as_ref());
    let mut launch = CodexLaunch::new(program, prefix_args, sandbox_dir(), cfg.model.clone());
    launch.effort = cfg.effort.clone();
    launch.system_prompt = adapt_system_prompt(&cfg.system_prompt, sources.has_notes);
    launch.mcp_servers = sources.mcp_servers;
    launch.has_notes = sources.has_notes;
    launch.policy = sources.policy;
    launch
}

async fn spawn_codex(cfg: SessionConfig) -> Result<Arc<dyn SessionHandle>, AgentError> {
    let (program, prefix_args) = tokio::task::spawn_blocking(find_codex)
        .await
        .ok()
        .flatten()
        .ok_or_else(|| AgentError::Spawn("Codex CLI not installed: codex not found".into()))?;
    Ok(Arc::new(CodexSession::spawn(codex_launch(program, prefix_args, &cfg)).await?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::cli_agent::command::SourcesLaunch;
    use serde_json::json;
    use std::path::PathBuf;

    fn cfg(kind: CliAgentKind, sources: Option<SourcesLaunch>) -> SessionConfig {
        SessionConfig {
            kind,
            model: "some-model".into(),
            effort: Some("medium".into()),
            system_prompt: "sp".into(),
            thinking: true,
            sources,
        }
    }

    fn sources() -> SourcesLaunch {
        SourcesLaunch {
            add_dirs: vec![PathBuf::from("C:\\Notes")],
            mcp_config_json: Some(
                json!({ "mcpServers": { "mira": { "command": "node", "args": ["s.js"], "env": { "K": "s3cret" } } } }).to_string(),
            ),
            allowed_tools: vec!["mcp__mira__kb_search".into()],
            ..Default::default()
        }
    }

    #[test]
    fn an_antigravity_session_gets_the_acp_form_of_its_sources() {
        let launch = antigravity_launch(PathBuf::from("C:\\agy\\agy.exe"), &cfg(CliAgentKind::Antigravity, Some(sources())));
        assert_eq!(launch.args, antigravity_args());
        assert!(launch.args.contains(&"--gemini-dir".to_string()), "its own data folder, not the user's");
        assert_eq!(launch.model, "some-model");
        assert!(launch.system_prompt.starts_with("sp"));
        // An empty folder of its own, not the shared sandbox, and none of the user's folders.
        assert!(launch.cwd.starts_with(sandbox_dir()) && launch.cwd != sandbox_dir(), "{:?}", launch.cwd);
        assert!(launch.cwd.file_name().unwrap().to_string_lossy().starts_with("acp-"));
        assert!(launch.remove_cwd_on_close);
        assert_ne!(launch.cwd, session_dir(), "a new folder per session");
        let names: Vec<&str> = launch.mcp_servers.iter().map(|s| s["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["mira", "nexq_notes"]);
        assert_eq!(launch.mcp_servers[0]["env"][0]["value"], "s3cret");
        assert_eq!(launch.mcp_servers[1]["args"], json!(["--notes-mcp"]));
        assert!(!format!("{launch:?}").contains("s3cret"));
        // A plain session has no servers and a policy that allows nothing.
        let plain = antigravity_launch(PathBuf::from("agy.exe"), &cfg(CliAgentKind::Antigravity, None));
        assert!(plain.mcp_servers.is_empty());
        assert_eq!(plain.policy, crate::llm::cli_agent::acp::PermissionPolicy::deny_all());
    }

    #[test]
    fn a_codex_session_gets_the_codex_form_of_its_sources() {
        let launch = codex_launch(PathBuf::from("codex.exe"), vec!["x.js".into()], &cfg(CliAgentKind::Codex, Some(sources())));
        assert_eq!(launch.prefix_args, vec!["x.js"]);
        assert_eq!((launch.model.as_str(), launch.effort.as_deref()), ("some-model", Some("medium")));
        assert_eq!(launch.cwd, sandbox_dir());
        assert!(launch.has_notes);
        assert_eq!(launch.mcp_servers["mira"]["env"]["K"], "s3cret");
        assert_eq!(launch.mcp_servers["mira"]["enabled_tools"], json!(["kb_search"]));
        assert_eq!(launch.mcp_servers["nexq_notes"]["args"], json!(["--notes-mcp"]));
        assert!(launch.policy.allowed_tools.contains("mcp__mira__kb_search"));
        assert!(launch.policy.allowed_tools.contains("mcp__nexq_notes__read_note"));
        // Nothing of a secret is on the command line, and the shell is off.
        let args = crate::llm::cli_agent::codex::launch::build_args(&launch, &[]);
        assert!(args.iter().all(|a| !a.contains("s3cret")));
        assert!(args.windows(2).any(|w| w[0] == "--disable" && w[1] == "shell_tool"));
        // A plain session: no notes and no servers; the shell is still off.
        let plain = codex_launch(PathBuf::from("codex.exe"), vec![], &cfg(CliAgentKind::Codex, None));
        assert!(!plain.has_notes && plain.mcp_servers.is_empty());
        let args = crate::llm::cli_agent::codex::launch::build_args(&plain, &[]);
        assert!(args.windows(2).any(|w| w[0] == "--disable" && w[1] == "shell_tool"));
    }

    #[test]
    fn a_claude_that_is_too_old_is_refused_with_its_versions_and_reads_as_outdated() {
        use crate::llm::cli_agent::detect::outdated_message;
        use crate::llm::cli_agent::protocol::AgentErrorKind;
        let refusal = outdated_message((2, 1, 206));
        let err = claude_binary_for_spawn(Some(Err(ClaudeBinaryError::TooOld(refusal.clone())))).unwrap_err();
        assert_eq!(err.kind(), AgentErrorKind::Outdated);
        assert!(err.to_string().contains("Claude Code 2.1.206 is too old for NexQ. Update it to 2.1.259 or newer."), "{err}");
        // Missing stays not installed; a usable binary passes.
        let missing = claude_binary_for_spawn(Some(Err(ClaudeBinaryError::NotFound))).unwrap_err();
        assert_eq!(missing.kind(), AgentErrorKind::NotInstalled);
        assert_eq!(claude_binary_for_spawn(None).unwrap_err().kind(), AgentErrorKind::NotInstalled);
        assert_eq!(claude_binary_for_spawn(Some(Ok(PathBuf::from("claude.exe")))), Ok(PathBuf::from("claude.exe")));
    }

    #[test]
    fn session_folders_are_new_and_stale_ones_are_cleaned_up() {
        let a = session_dir();
        std::fs::create_dir_all(&a).unwrap();
        // A fresh folder survives the cleanup; it is not touched.
        remove_stale_session_dirs();
        assert!(a.is_dir());
        let _ = std::fs::remove_dir_all(&a);
    }
}
