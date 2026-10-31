//! Claude CLI (subscription) provider: detection, model settings, session
//! status and the login terminal.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{command, State};

use crate::llm::cli_agent::detect::{
    claude_auth_status, claude_version, find_claude_binary, find_npm_claude, ClaudeAuthStatus,
};
use crate::llm::cli_agent::manager::{AgentSessionStatus, ClaudeCliConfig};
use crate::llm::cli_agent::models::{probe_models, ClaudeModelInfo, EFFORTS};
use crate::llm::ProviderType;
use crate::state::AppState;

/// Installation and login state of the local `claude` CLI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeCliStatus {
    pub installed: bool,
    pub binary_path: Option<String>,
    /// `None` when not installed or the `--version` probe failed.
    pub version: Option<String>,
    /// `None` when not installed or the `auth status` probe failed.
    pub auth: Option<ClaudeAuthStatus>,
    /// Not installed, but an npm install (`claude.cmd`) was found: NexQ
    /// needs the native installer's `claude.exe`.
    pub npm_only: bool,
}

async fn resolve_binary() -> Option<PathBuf> {
    tokio::task::spawn_blocking(find_claude_binary)
        .await
        .ok()
        .flatten()
}

/// Detect `claude.exe`, its version and login state (no model call). The two
/// probes run independently, so one failing keeps the other's answer.
#[command]
pub async fn claude_cli_status() -> Result<ClaudeCliStatus, String> {
    let Some(bin) = resolve_binary().await else {
        let npm_only = tokio::task::spawn_blocking(find_npm_claude)
            .await
            .ok()
            .flatten()
            .is_some();
        return Ok(ClaudeCliStatus {
            installed: false,
            binary_path: None,
            version: None,
            auth: None,
            npm_only,
        });
    };
    let (version, auth) = tokio::join!(claude_version(&bin), claude_auth_status(&bin));
    let version = version
        .map_err(|e| log::warn!("Claude CLI version probe failed: {e}"))
        .ok();
    let auth = auth
        .map_err(|e| log::warn!("Claude CLI auth probe failed: {e}"))
        .ok();
    Ok(ClaudeCliStatus {
        installed: true,
        binary_path: Some(bin.to_string_lossy().into_owned()),
        version,
        auth,
        npm_only: false,
    })
}

/// The models the CLI offers, from its `initialize` answer (no model call).
/// Returns the cached catalog unless `refresh` is set or none is cached yet;
/// a successful probe replaces the cache (sessions clamp `--effort` to it).
#[command]
pub async fn claude_cli_models(
    refresh: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Vec<ClaudeModelInfo>, String> {
    if !refresh.unwrap_or(false) {
        if let Some(models) = state.claude_models.get() {
            return Ok(models);
        }
    }
    let bin = resolve_binary()
        .await
        .ok_or_else(|| "Claude CLI is not installed".to_string())?;
    let models = probe_models(&bin).await?;
    state.claude_models.set(models.clone());
    Ok(models)
}

/// Seed the backend catalog with the list the app saved last time, unless a
/// probe already filled it: sessions then clamp `--effort` from the first
/// spawn, even when the startup probe fails. Returns whether it seeded.
#[command]
pub async fn seed_claude_cli_models(
    models: Vec<ClaudeModelInfo>,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    Ok(state.claude_models.seed(models))
}

/// A model alias or id (`haiku`, `claude-haiku-4-5-20251001`, `opus[1m]`).
/// Rejecting a leading `-` keeps it from being read as a CLI flag.
fn valid_model(model: &str) -> bool {
    !model.is_empty()
        && !model.starts_with('-')
        && model
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-._:[]".contains(c))
}

fn validate_config(config: &ClaudeCliConfig) -> Result<(), String> {
    for (tier, model, effort) in [
        ("Fast", &config.fast_model, &config.fast_effort),
        ("Deep", &config.deep_model, &config.deep_effort),
    ] {
        if !valid_model(model) {
            return Err(format!("Invalid {tier} model: {model:?}"));
        }
        if !EFFORTS.contains(&effort.as_str()) {
            return Err(format!("Invalid {tier} effort: {effort:?}"));
        }
    }
    if let Some(fallback) = &config.fallback_provider {
        match ProviderType::from_str(fallback) {
            Ok(ProviderType::ClaudeCli) => {
                return Err("Claude CLI cannot be its own fallback provider".to_string())
            }
            Ok(_) => {}
            Err(_) => return Err(format!("Unknown fallback provider: {fallback:?}")),
        }
    }
    Ok(())
}

/// Replace the Claude CLI model settings. Running sessions keep their model;
/// the change applies to sessions started afterwards.
#[command]
pub async fn set_claude_cli_config(
    config: ClaudeCliConfig,
    state: State<'_, AppState>,
) -> Result<(), String> {
    validate_config(&config)?;
    let mut current = state
        .claude_cli_config
        .write()
        .map_err(|_| "Claude CLI config lock poisoned".to_string())?;
    *current = config;
    Ok(())
}

/// Status of every open Claude session.
#[command]
pub async fn get_agent_sessions(
    state: State<'_, AppState>,
) -> Result<Vec<AgentSessionStatus>, String> {
    Ok(state.agent_sessions.snapshot())
}

/// How to launch the login terminal: the working directory and the
/// `cmd.exe` command line. `start` opens a new console window running
/// `claude` (kept open by `/k` so the user sees the result). The binary's
/// folder becomes the working directory and the command names it as
/// `.\claude.exe`, so the path (which may contain `&`, `%` or spaces) never
/// goes through cmd's parser. Without a resolved binary, `claude` comes from
/// PATH.
fn login_launch(bin: Option<&Path>) -> (Option<PathBuf>, String) {
    let dir = bin
        .and_then(Path::parent)
        .filter(|d| !d.as_os_str().is_empty());
    let exe = if dir.is_some() { r".\claude.exe" } else { "claude" };
    (
        dir.map(Path::to_path_buf),
        format!(r#"/d /c start "Claude login" cmd.exe /k {exe}"#),
    )
}

/// Open a visible terminal running `claude` so the user can log in. NexQ
/// reads nothing from it; credentials stay between the user and the CLI.
#[command]
pub async fn open_claude_login_terminal() -> Result<(), String> {
    let bin = resolve_binary().await;
    let (dir, command_line) = login_launch(bin.as_deref());
    let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
    let mut cmd = std::process::Command::new(comspec);
    if let Some(dir) = dir {
        cmd.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Exact quoting for cmd.exe; this outer cmd has no window of its own
        // (CREATE_NO_WINDOW), `start` gives `claude` a fresh visible console.
        cmd.raw_arg(command_line).creation_flags(0x0800_0000);
    }
    #[cfg(not(windows))]
    cmd.arg(command_line);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open a terminal: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::cli_agent::detect::ClaudeLogin;

    #[test]
    fn claude_cli_config_validation() {
        assert!(validate_config(&ClaudeCliConfig::default()).is_ok());
        let full_id = ClaudeCliConfig {
            deep_model: "claude-opus-4-1[1m]".into(),
            deep_effort: "xhigh".into(),
            ..Default::default()
        };
        assert!(validate_config(&full_id).is_ok());
        for bad in [
            ClaudeCliConfig { fast_model: "".into(), ..Default::default() },
            ClaudeCliConfig { fast_model: "--bare".into(), ..Default::default() },
            ClaudeCliConfig { deep_model: "son net".into(), ..Default::default() },
            ClaudeCliConfig { fast_effort: "ultra".into(), ..Default::default() },
        ] {
            assert!(validate_config(&bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn claude_cli_config_validates_fallback() {
        let with = |p: &str| ClaudeCliConfig {
            fallback_provider: Some(p.into()),
            ..Default::default()
        };
        assert!(validate_config(&with("ollama")).is_ok());
        assert!(validate_config(&with("claude_cli")).is_err());
        assert!(validate_config(&with("nope")).is_err());
        assert!(validate_config(&with("")).is_err());
    }

    // Uses Windows path syntax (`C:\...`); on other OSes `Path` does not split
    // on `\`, so the test only makes sense on Windows.
    #[cfg(windows)]
    #[test]
    fn claude_cli_login_launch_keeps_path_out_of_cmd() {
        let bin = Path::new(r"C:\Users\Tom&Jerry 100%\.local\bin\claude.exe");
        let (dir, line) = login_launch(Some(bin));
        assert_eq!(
            dir.as_deref(),
            Some(Path::new(r"C:\Users\Tom&Jerry 100%\.local\bin"))
        );
        assert_eq!(line, r#"/d /c start "Claude login" cmd.exe /k .\claude.exe"#);
        assert!(!line.contains('&') && !line.contains('%'));

        let (dir, line) = login_launch(None);
        assert_eq!(dir, None);
        assert_eq!(line, r#"/d /c start "Claude login" cmd.exe /k claude"#);
    }

    #[test]
    fn claude_cli_status_serializes_snake_case() {
        let status = ClaudeCliStatus {
            installed: true,
            binary_path: Some("c".into()),
            version: Some("2.1".into()),
            auth: Some(ClaudeAuthStatus {
                logged_in: true,
                auth_method: "claude.ai".into(),
                subscription_type: Some("max".into()),
                email: None,
                login: ClaudeLogin::Subscription,
            }),
            npm_only: false,
        };
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["binary_path"], "c");
        assert_eq!(json["auth"]["logged_in"], true);
        assert_eq!(json["auth"]["subscription_type"], "max");
        assert_eq!(json["auth"]["login"], "subscription");
        assert_eq!(json["npm_only"], false);
    }
}
