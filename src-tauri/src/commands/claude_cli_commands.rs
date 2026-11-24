//! The Claude-named commands the frontend already calls. They are thin
//! wrappers over `cli_agent_commands`, which serves every CLI agent
//! (`cli_agent_status(kind)`, ...), plus the session list.

use tauri::{command, State};

use crate::commands::cli_agent_commands::{
    cli_agent_models_impl, cli_agent_status_impl, open_cli_login_terminal, set_cli_agent_config_impl,
};
use crate::llm::cli_agent::manager::{AgentSessionStatus, ClaudeCliConfig};
use crate::llm::cli_agent::models::ClaudeModelInfo;
use crate::llm::cli_agent::status::CliAgentStatus;
use crate::llm::cli_agent::CliAgentKind;
use crate::state::AppState;

/// The status of the Claude CLI (`cli_agent_status("claude_cli")`).
pub type ClaudeCliStatus = CliAgentStatus;

/// Detect `claude.exe`, its version and login state (no model call).
#[command]
pub async fn claude_cli_status(state: State<'_, AppState>) -> Result<ClaudeCliStatus, String> {
    cli_agent_status_impl(CliAgentKind::Claude, &state).await
}

/// The models the Claude CLI offers (`cli_agent_models("claude_cli", ..)`).
#[command]
pub async fn claude_cli_models(
    refresh: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Vec<ClaudeModelInfo>, String> {
    cli_agent_models_impl(CliAgentKind::Claude, refresh.unwrap_or(false), &state).await
}

/// Seed the Claude catalog with the list the app saved last time.
#[command]
pub async fn seed_claude_cli_models(
    models: Vec<ClaudeModelInfo>,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    Ok(state.cli_settings.catalog(CliAgentKind::Claude).seed(models))
}

/// Replace the Claude CLI model settings (`set_cli_agent_config("claude_cli", ..)`).
#[command]
pub async fn set_claude_cli_config(
    config: ClaudeCliConfig,
    state: State<'_, AppState>,
) -> Result<(), String> {
    set_cli_agent_config_impl(CliAgentKind::Claude, config, &state)
}

/// Status of every open CLI agent session.
#[command]
pub async fn get_agent_sessions(
    state: State<'_, AppState>,
) -> Result<Vec<AgentSessionStatus>, String> {
    Ok(state.agent_sessions.snapshot())
}

/// Open a visible terminal running `claude` so the user can log in.
#[command]
pub async fn open_claude_login_terminal() -> Result<(), String> {
    open_cli_login_terminal(CliAgentKind::Claude).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::cli_agent::detect::{ClaudeAuthStatus, ClaudeLogin};

    #[test]
    fn claude_cli_status_serializes_snake_case() {
        let status = ClaudeCliStatus {
            kind: CliAgentKind::Claude,
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
            required_version: None,
        };
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["kind"], "claude_cli");
        assert_eq!(json["binary_path"], "c");
        assert_eq!(json["auth"]["logged_in"], true);
        assert_eq!(json["auth"]["subscription_type"], "max");
        assert_eq!(json["auth"]["login"], "subscription");
        assert_eq!(json["npm_only"], false);
        assert!(json["required_version"].is_null());
        let outdated = ClaudeCliStatus { required_version: Some("2.1.259".into()), ..status };
        assert_eq!(serde_json::to_value(&outdated).unwrap()["required_version"], "2.1.259");
    }
}
