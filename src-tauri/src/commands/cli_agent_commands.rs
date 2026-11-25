//! CLI agent providers (Claude, Antigravity, Codex): detection, model lists,
//! model settings and the login terminal, one set of commands for all of them.
//! `kind` is the provider id string (`claude_cli`, `antigravity_cli`,
//! `codex_cli`). The old `claude_cli_*` commands are thin wrappers over these.

use std::path::{Path, PathBuf};
use tauri::{command, State};

use crate::llm::cli_agent::manager::ClaudeCliConfig;
use crate::llm::cli_agent::models::{ClaudeModelInfo, CODEX_EFFORTS, EFFORTS};
use crate::llm::cli_agent::status::{self, CliAgentStatus};
use crate::llm::cli_agent::CliAgentKind;
use crate::llm::ProviderType;
use crate::state::AppState;

/// Detect the CLI, its version and login state (no model call). For
/// Antigravity the login check also lists the models, which fill its catalog.
#[command]
pub async fn cli_agent_status(kind: CliAgentKind, refresh: Option<bool>, state: State<'_, AppState>) -> Result<CliAgentStatus, String> {
    cli_agent_status_force(kind, refresh.unwrap_or(false), &state).await
}

pub(crate) async fn cli_agent_status_impl(kind: CliAgentKind, state: &AppState) -> Result<CliAgentStatus, String> {
    cli_agent_status_force(kind, false, state).await
}

/// A status younger than a minute is reused unless `force` (an explicit "check again").
async fn cli_agent_status_force(kind: CliAgentKind, force: bool, state: &AppState) -> Result<CliAgentStatus, String> {
    if force {
        status::forget_statuses();
    }
    let (status, models) = status::cli_agent_status_cached(kind, force).await;
    if let Some(models) = models.filter(|m| !m.is_empty()) {
        state.cli_settings.catalog(kind).set(models);
    }
    Ok(status)
}

/// The models the CLI offers (no model call). Returns the cached catalog unless
/// `refresh` is set or none is cached yet; a successful probe replaces the
/// cache (sessions clamp the effort and replace a retired model from it).
#[command]
pub async fn cli_agent_models(
    kind: CliAgentKind,
    refresh: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Vec<ClaudeModelInfo>, String> {
    cli_agent_models_impl(kind, refresh.unwrap_or(false), &state).await
}

pub(crate) async fn cli_agent_models_impl(
    kind: CliAgentKind,
    refresh: bool,
    state: &AppState,
) -> Result<Vec<ClaudeModelInfo>, String> {
    let catalog = state.cli_settings.catalog(kind);
    if !refresh {
        if let Some(models) = catalog.get() {
            return Ok(models);
        }
    }
    let models = status::fetch_models(kind).await?;
    catalog.set(models.clone());
    Ok(models)
}

/// Seed the backend catalog of `kind` with the list the app saved last time,
/// unless a probe already filled it. Returns whether it seeded.
#[command]
pub async fn seed_cli_agent_models(
    kind: CliAgentKind,
    models: Vec<ClaudeModelInfo>,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    Ok(state.cli_settings.catalog(kind).seed(models))
}

/// A model alias or id (`haiku`, `claude-haiku-4-5-20251001`, `opus[1m]`,
/// `gemini-3.8-flash-low`, `gpt-6.2-sol`). Rejecting a leading `-` keeps it
/// from being read as a CLI flag.
fn valid_model(model: &str) -> bool {
    !model.is_empty()
        && !model.starts_with('-')
        && model.chars().all(|c| c.is_ascii_alphanumeric() || "-._:[]".contains(c))
}

/// The efforts a kind's configuration may hold.
fn efforts_of(kind: CliAgentKind) -> &'static [&'static str] {
    match kind {
        CliAgentKind::Codex => &CODEX_EFFORTS,
        // Antigravity's effort is part of the model id and ignored, but kept valid.
        CliAgentKind::Claude | CliAgentKind::Antigravity => &EFFORTS,
    }
}

pub(crate) fn validate_config(kind: CliAgentKind, config: &ClaudeCliConfig) -> Result<(), String> {
    for (tier, model, effort) in [
        ("Fast", &config.fast_model, &config.fast_effort),
        ("Deep", &config.deep_model, &config.deep_effort),
    ] {
        // An empty model means "the first one the CLI lists" (Codex's default);
        // Claude always names one.
        let empty_ok = kind != CliAgentKind::Claude && model.is_empty();
        if !empty_ok && !valid_model(model) {
            return Err(format!("Invalid {tier} model: {model:?}"));
        }
        if !efforts_of(kind).contains(&effort.as_str()) {
            return Err(format!("Invalid {tier} effort: {effort:?}"));
        }
    }
    if let Some(fallback) = &config.fallback_provider {
        match ProviderType::from_str(fallback) {
            Ok(p) if p.is_cli_agent() => {
                return Err(format!("{} cannot be a fallback provider; choose an API or local one", p.display_name()))
            }
            Ok(_) => {}
            Err(_) => return Err(format!("Unknown fallback provider: {fallback:?}")),
        }
    }
    Ok(())
}

/// Replace the model settings of one CLI agent. Running sessions keep their
/// model; the change applies to sessions started afterwards.
#[command]
pub async fn set_cli_agent_config(
    kind: CliAgentKind,
    config: ClaudeCliConfig,
    state: State<'_, AppState>,
) -> Result<(), String> {
    set_cli_agent_config_impl(kind, config, &state)
}

pub(crate) fn set_cli_agent_config_impl(kind: CliAgentKind, config: ClaudeCliConfig, state: &AppState) -> Result<(), String> {
    validate_config(kind, &config)?;
    state.cli_settings.set_config(kind, config);
    // a changed path or setting can change what the status says
    status::forget_statuses();
    Ok(())
}

/// How to launch the login terminal: the working directory and the `cmd.exe`
/// command line. `start` opens a new console window running the CLI (kept open
/// by `/k` so the user sees the result).
///
/// - Claude and Antigravity run their `.exe` from its own folder as
///   `.\claude.exe` / `.\agy.exe`, so the path (which may contain `&`, `%` or
///   spaces) never goes through cmd's parser. Without a resolved binary the
///   bare name comes from PATH.
/// - Codex is an npm shim (`codex.cmd`) the terminal resolves from PATH:
///   `codex login`, which asks Sign in with ChatGPT.
/// - Antigravity runs `agy` interactively: it asks for the Google sign-in the
///   first time.
pub fn login_launch(kind: CliAgentKind, bin: Option<&Path>) -> (Option<PathBuf>, String) {
    let title = format!("{} login", kind.short_name());
    if kind == CliAgentKind::Codex {
        return (None, format!(r#"/d /c start "{title}" cmd.exe /k codex login"#));
    }
    let dir = bin.and_then(Path::parent).filter(|d| !d.as_os_str().is_empty());
    let exe = match (dir.is_some(), kind) {
        (true, CliAgentKind::Claude) => r".\claude.exe",
        (true, _) => r".\agy.exe",
        (false, k) => k.binary_name(),
    };
    (dir.map(Path::to_path_buf), format!(r#"/d /c start "{title}" cmd.exe /k {exe}"#))
}

/// Open a visible terminal running the CLI so the user can log in. NexQ reads
/// nothing from it; credentials stay between the user and the CLI.
#[command]
pub async fn open_cli_login_terminal(kind: CliAgentKind) -> Result<(), String> {
    // the account is about to change: the next status is a fresh one
    status::forget_statuses();
    let bin = tokio::task::spawn_blocking(move || status::find_binary(kind).map(|(p, _)| p))
        .await
        .ok()
        .flatten();
    let (dir, command_line) = login_launch(kind, bin.as_deref());
    let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
    let mut cmd = std::process::Command::new(comspec);
    if let Some(dir) = dir {
        cmd.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Exact quoting for cmd.exe; this outer cmd has no window of its own
        // (CREATE_NO_WINDOW), `start` gives the CLI a fresh visible console.
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

    #[test]
    fn claude_config_validation() {
        let k = CliAgentKind::Claude;
        assert!(validate_config(k, &ClaudeCliConfig::default()).is_ok());
        let full_id = ClaudeCliConfig {
            deep_model: "claude-opus-4-1[1m]".into(),
            deep_effort: "xhigh".into(),
            ..Default::default()
        };
        assert!(validate_config(k, &full_id).is_ok());
        for bad in [
            ClaudeCliConfig { fast_model: "".into(), ..Default::default() },
            ClaudeCliConfig { fast_model: "--bare".into(), ..Default::default() },
            ClaudeCliConfig { deep_model: "son net".into(), ..Default::default() },
            ClaudeCliConfig { fast_effort: "ultra".into(), ..Default::default() },
        ] {
            assert!(validate_config(k, &bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn the_other_kinds_validate_their_own_defaults_and_efforts() {
        for kind in CliAgentKind::ALL {
            assert!(validate_config(kind, &ClaudeCliConfig::default_for(kind)).is_ok(), "{kind:?}");
        }
        // Codex's default names no model ("first listed") and takes `ultra`.
        let ultra = ClaudeCliConfig { deep_effort: "ultra".into(), ..ClaudeCliConfig::default_for(CliAgentKind::Codex) };
        assert!(validate_config(CliAgentKind::Codex, &ultra).is_ok());
        assert!(validate_config(CliAgentKind::Antigravity, &ultra).is_err());
        let bad_model = ClaudeCliConfig { fast_model: "--flag".into(), ..ClaudeCliConfig::default_for(CliAgentKind::Codex) };
        assert!(validate_config(CliAgentKind::Codex, &bad_model).is_err());
        let bad_effort = ClaudeCliConfig { fast_effort: "extreme".into(), ..ClaudeCliConfig::default_for(CliAgentKind::Codex) };
        assert!(validate_config(CliAgentKind::Codex, &bad_effort).is_err());
    }

    #[test]
    fn config_validates_the_fallback_provider() {
        let with = |p: &str| ClaudeCliConfig { fallback_provider: Some(p.into()), ..Default::default() };
        for kind in CliAgentKind::ALL {
            assert!(validate_config(kind, &with("ollama")).is_ok());
            // A CLI agent is never a fallback (it needs its own sessions).
            for cli in ["claude_cli", "antigravity_cli", "codex_cli"] {
                assert!(validate_config(kind, &with(cli)).is_err(), "{kind:?} -> {cli}");
            }
            assert!(validate_config(kind, &with("nope")).is_err());
            assert!(validate_config(kind, &with("")).is_err());
        }
    }

    #[cfg(windows)]
    #[test]
    fn claude_login_launch_keeps_path_out_of_cmd() {
        let bin = Path::new(r"C:\Users\Tom&Jerry 100%\.local\bin\claude.exe");
        let (dir, line) = login_launch(CliAgentKind::Claude, Some(bin));
        assert_eq!(dir.as_deref(), Some(Path::new(r"C:\Users\Tom&Jerry 100%\.local\bin")));
        assert_eq!(line, r#"/d /c start "Claude login" cmd.exe /k .\claude.exe"#);
        assert!(!line.contains('&') && !line.contains('%'));

        let (dir, line) = login_launch(CliAgentKind::Claude, None);
        assert_eq!(dir, None);
        assert_eq!(line, r#"/d /c start "Claude login" cmd.exe /k claude"#);
    }

    #[cfg(windows)]
    #[test]
    fn antigravity_and_codex_login_launches() {
        let bin = Path::new(r"C:\Users\a b\AppData\Local\agy\bin\agy.exe");
        let (dir, line) = login_launch(CliAgentKind::Antigravity, Some(bin));
        assert_eq!(dir.as_deref(), Some(Path::new(r"C:\Users\a b\AppData\Local\agy\bin")));
        assert_eq!(line, r#"/d /c start "Antigravity login" cmd.exe /k .\agy.exe"#);
        assert_eq!(login_launch(CliAgentKind::Antigravity, None).1, r#"/d /c start "Antigravity login" cmd.exe /k agy"#);
        // Codex: `codex login` from PATH, whatever was found.
        let (dir, line) = login_launch(CliAgentKind::Codex, Some(Path::new(r"C:\x\codex.exe")));
        assert_eq!(dir, None);
        assert_eq!(line, r#"/d /c start "Codex login" cmd.exe /k codex login"#);
    }
}
