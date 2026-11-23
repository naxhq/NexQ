//! `CliSpawner`: starts the session of whichever CLI agent
//! [`SessionConfig::kind`] names. The binary is looked up on every spawn, so
//! a fresh install is picked up without restarting NexQ.
//!
//! - Claude: `claude.exe` and its stream-json protocol (`ClaudeSession`).
//! - Antigravity: `agy acp` (`AcpSession`). cwd is NexQ's empty agent
//!   sandbox; the notes folders go in `session/new`'s `additionalDirectories`
//!   and the MCP servers in its `mcpServers`.
//! - Codex: `codex app-server` (`CodexSession`). Effort is passed as resolved
//!   by the manager (clamped to the model's own levels); the MCP servers go
//!   in the thread's config so their secrets stay off the command line.
//!
//! What each kind turns off of the user's own setup is documented in
//! `acp/launch.rs`, `codex/launch.rs` and `command.rs`.

use super::acp::{antigravity_args, find_agy, session::default_timeouts as acp_timeouts, AcpLaunch, AcpSession};
use super::codex::{find_codex, CodexLaunch, CodexSession};
use super::command::{sandbox_dir, SessionConfig};
use super::detect::find_claude_binary;
use super::manager::{SessionHandle, SessionSpawner, SOURCES_INIT_TIMEOUT};
use super::session::{AgentError, ClaudeSession, SessionTimeouts};
use super::sources_convert::{acp_sources, codex_sources};
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
    let bin = tokio::task::spawn_blocking(find_claude_binary)
        .await
        .ok()
        .flatten()
        .ok_or_else(|| AgentError::Spawn("Claude CLI not installed: claude.exe not found".into()))?;
    let timeouts = if cfg.sources.is_some() {
        SessionTimeouts { init: SOURCES_INIT_TIMEOUT, ..SessionTimeouts::default() }
    } else {
        SessionTimeouts::default()
    };
    Ok(Arc::new(ClaudeSession::spawn_with_timeouts(bin, cfg, timeouts).await?))
}

/// The launch of an Antigravity session (everything but the binary).
pub fn antigravity_launch(program: std::path::PathBuf, cfg: &SessionConfig) -> AcpLaunch {
    let sources = acp_sources(cfg.sources.as_ref());
    let mut launch = AcpLaunch::new(program, antigravity_args(), sandbox_dir());
    launch.model = cfg.model.clone();
    launch.system_prompt = cfg.system_prompt.clone();
    launch.additional_dirs = sources.additional_dirs;
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
    launch.system_prompt = cfg.system_prompt.clone();
    launch.mcp_servers = sources.mcp_servers;
    launch.readable_dirs = sources.readable_dirs;
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
        assert_eq!(launch.model, "some-model");
        assert_eq!(launch.system_prompt, "sp");
        assert_eq!(launch.cwd, sandbox_dir());
        assert_eq!(launch.additional_dirs, vec![PathBuf::from("C:\\Notes")]);
        assert_eq!(launch.mcp_servers.len(), 1);
        assert_eq!(launch.mcp_servers[0]["name"], "mira");
        assert_eq!(launch.mcp_servers[0]["env"][0]["value"], "s3cret");
        assert!(!format!("{launch:?}").contains("s3cret"));
        // A plain session has no folders, no servers and a policy that allows nothing.
        let plain = antigravity_launch(PathBuf::from("agy.exe"), &cfg(CliAgentKind::Antigravity, None));
        assert!(plain.additional_dirs.is_empty() && plain.mcp_servers.is_empty());
        assert_eq!(plain.policy, crate::llm::cli_agent::acp::PermissionPolicy::deny_all());
    }

    #[test]
    fn a_codex_session_gets_the_codex_form_of_its_sources() {
        let launch = codex_launch(PathBuf::from("codex.exe"), vec!["x.js".into()], &cfg(CliAgentKind::Codex, Some(sources())));
        assert_eq!(launch.prefix_args, vec!["x.js"]);
        assert_eq!((launch.model.as_str(), launch.effort.as_deref()), ("some-model", Some("medium")));
        assert_eq!(launch.cwd, sandbox_dir());
        assert_eq!(launch.readable_dirs, vec![PathBuf::from("C:\\Notes")]);
        assert!(launch.shell_enabled());
        assert_eq!(launch.mcp_servers["mira"]["env"]["K"], "s3cret");
        assert_eq!(launch.mcp_servers["mira"]["enabled_tools"], json!(["kb_search"]));
        assert!(launch.policy.allowed_tools.contains("mcp__mira__kb_search"));
        // Nothing of a secret is on the command line.
        let args = crate::llm::cli_agent::codex::launch::build_args(&launch, &[]);
        assert!(args.iter().all(|a| !a.contains("s3cret")));
        // A plain session: no folders, so no shell tool, and no servers.
        let plain = codex_launch(PathBuf::from("codex.exe"), vec![], &cfg(CliAgentKind::Codex, None));
        assert!(!plain.shell_enabled() && plain.mcp_servers.is_empty() && plain.readable_dirs.is_empty());
    }
}
