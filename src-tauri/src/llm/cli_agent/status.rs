//! Installation, login and model list of every CLI agent, read without a model
//! call (nothing here uses tokens).
//!
//! - Claude: `claude --version` and `claude auth status` (see `detect.rs`).
//! - Codex: `codex --version`, `codex login status` (ChatGPT = subscription,
//!   API key = not on a subscription, else logged out), plus the email and plan
//!   from the id token's claims. Models from `codex debug models`.
//! - Antigravity: `agy --version`; logged in means `agy acp` opens a session
//!   (`initialize` + `session/new`), which also lists the models. It exposes
//!   no email or plan.
//!
//! Tokens never leave the CLIs: the only account data read are an email
//! address and a plan name.

use super::acp::{antigravity_args, find_agy, probe_models as acp_probe_models};
use super::codex::launch::run_probe;
use super::codex::{find_codex, login_status, probe_models as codex_probe_models, CodexLogin, CodexModel};
use super::detect::{
    claude_auth_status, claude_too_old, claude_version, find_claude_binary, find_current_claude, find_npm_claude,
    format_version, is_too_old, parse_claude_version, ClaudeAuthStatus, ClaudeBinaryError, ClaudeLogin, API_BILLED_NOTE,
    MIN_CLAUDE_VERSION,
};
use super::models::{probe_models as claude_probe_models, ClaudeModelInfo};
use super::protocol::AgentErrorKind;
use super::session::AgentError;
use super::CliAgentKind;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Installation and login state of one CLI agent. For Claude the fields are
/// those of the old `ClaudeCliStatus`, with `kind` added.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CliAgentStatus {
    pub kind: CliAgentKind,
    pub installed: bool,
    pub binary_path: Option<String>,
    /// `None` when not installed or the `--version` probe failed.
    pub version: Option<String>,
    /// `None` when not installed or the login probe failed. `login` says how
    /// the account is billed; `auth_method`, `subscription_type` (the plan) and
    /// `email` are filled where the CLI tells.
    pub auth: Option<ClaudeAuthStatus>,
    /// Claude only: not installed, but an npm install (`claude.cmd`) was found:
    /// NexQ needs the native installer's `claude.exe`.
    pub npm_only: bool,
    /// Claude only: `Some("2.1.259")` (the oldest Claude Code NexQ can launch)
    /// when it is installed, its version is known and older than that. `None`
    /// otherwise, and always for Codex and Antigravity.
    pub required_version: Option<String>,
}

impl CliAgentStatus {
    fn not_installed(kind: CliAgentKind, npm_only: bool) -> Self {
        Self { kind, installed: false, binary_path: None, version: None, auth: None, npm_only, required_version: None }
    }
}

/// The minimum Claude Code version as the status reports it, when `version`
/// (the `--version` output) names an older one. Unknown or unreadable
/// versions, and the other CLIs, report nothing.
pub fn required_version_for(kind: CliAgentKind, version: Option<&str>) -> Option<String> {
    if kind != CliAgentKind::Claude {
        return None;
    }
    let found = parse_claude_version(version?)?;
    is_too_old(found).then(|| format_version(MIN_CLAUDE_VERSION))
}

/// Shown where an API-key Codex login would otherwise read as connected.
pub const CODEX_API_KEY_NOTE: &str =
    "This Codex login uses an API key, not your ChatGPT subscription. Run `codex login` and choose Sign in with ChatGPT.";

/// `agy.exe`, `codex` (and the args that go before `app-server`/`--version`):
/// a program NexQ can spawn.
pub fn find_binary(kind: CliAgentKind) -> Option<(PathBuf, Vec<String>)> {
    match kind {
        CliAgentKind::Claude => find_claude_binary().map(|p| (p, Vec::new())),
        CliAgentKind::Antigravity => find_agy().map(|p| (p, Vec::new())),
        CliAgentKind::Codex => find_codex(),
    }
}

/// The version number in `--version` output: the last whitespace-separated word
/// that starts with a digit (`codex-cli 0.171.0` -> `0.171.0`, `1.5.14`).
pub fn parse_version(output: &str) -> Option<String> {
    output
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())?
        .split_whitespace()
        .rev()
        .find(|w| w.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .map(str::to_string)
}

/// A Codex login as the account block of the status.
pub fn codex_auth(login: &CodexLogin) -> Option<ClaudeAuthStatus> {
    Some(match login {
        CodexLogin::ChatGpt { email, plan } => ClaudeAuthStatus {
            logged_in: true,
            auth_method: "chatgpt".into(),
            subscription_type: Some(plan.clone().unwrap_or_else(|| "ChatGPT".into())),
            email: email.clone(),
            login: ClaudeLogin::Subscription,
        },
        // Codex sessions refuse an API-key login (a ChatGPT login is required),
        // so it reads as not usable: the UI offers the login terminal and
        // Check again. `auth_method` stays "api_key" so the UI can say why.
        CodexLogin::ApiKey => ClaudeAuthStatus {
            logged_in: false,
            auth_method: "api_key".into(),
            subscription_type: None,
            email: None,
            login: ClaudeLogin::LoggedOut,
        },
        CodexLogin::LoggedOut => ClaudeAuthStatus {
            logged_in: false,
            auth_method: String::new(),
            subscription_type: None,
            email: None,
            login: ClaudeLogin::LoggedOut,
        },
        CodexLogin::Unavailable(_) => return None,
    })
}

/// What Antigravity's session probe says about the login: a session opened
/// means signed in; a login error means signed out; anything else (a timeout,
/// a crash) says nothing (`None`).
pub fn antigravity_auth<T>(probe: &Result<T, AgentError>) -> Option<ClaudeAuthStatus> {
    match probe {
        Ok(_) => Some(ClaudeAuthStatus {
            logged_in: true,
            auth_method: "google".into(),
            subscription_type: None,
            email: None,
            login: ClaudeLogin::Subscription,
        }),
        Err(e) if e.kind() == AgentErrorKind::NotLoggedIn => Some(ClaudeAuthStatus {
            logged_in: false,
            auth_method: String::new(),
            subscription_type: None,
            email: None,
            login: ClaudeLogin::LoggedOut,
        }),
        Err(_) => None,
    }
}

/// `--version` of a binary.
async fn version_of(program: &std::path::Path, prefix_args: &[String]) -> Option<String> {
    let (ok, stdout, _) = run_probe(program, prefix_args, &["--version"]).await?;
    ok.then(|| parse_version(&stdout)).flatten()
}

/// Detect the binary, its version and the login (no model call). The probes
/// run independently, so one failing keeps the other's answer. For Antigravity
/// the login probe also lists the models, which are returned for the caller's
/// catalog.
pub async fn cli_agent_status(kind: CliAgentKind) -> (CliAgentStatus, Option<Vec<ClaudeModelInfo>>) {
    let found = tokio::task::spawn_blocking(move || find_binary(kind)).await.ok().flatten();
    let Some((program, prefix_args)) = found else {
        let npm_only = kind == CliAgentKind::Claude
            && tokio::task::spawn_blocking(find_npm_claude).await.ok().flatten().is_some();
        return (CliAgentStatus::not_installed(kind, npm_only), None);
    };
    let binary_path = Some(program.to_string_lossy().into_owned());
    let (version, auth, models) = match kind {
        CliAgentKind::Claude => {
            let (version, auth) = tokio::join!(claude_version(&program), claude_auth_status(&program));
            (
                version.map_err(|e| log::warn!("Claude CLI version probe failed: {e}")).ok(),
                auth.map_err(|e| log::warn!("Claude CLI auth probe failed: {e}")).ok(),
                None,
            )
        }
        CliAgentKind::Codex => {
            let (version, login) = tokio::join!(version_of(&program, &prefix_args), login_status(&program, &prefix_args));
            if let CodexLogin::Unavailable(why) = &login {
                log::warn!("Codex login probe failed: {why}");
            }
            (version, codex_auth(&login), None)
        }
        CliAgentKind::Antigravity => {
            let (version, probe) =
                tokio::join!(version_of(&program, &prefix_args), acp_probe_models(program.clone(), antigravity_args()));
            let auth = antigravity_auth(&probe);
            if auth.is_none() {
                if let Err(e) = &probe {
                    log::warn!("Antigravity login probe failed: {e}");
                }
            }
            (version, auth, probe.ok().map(|m| acp_models(&m)))
        }
    };
    let required_version = required_version_for(kind, version.as_deref());
    (CliAgentStatus { kind, installed: true, binary_path, version, auth, npm_only: false, required_version }, models)
}

/// `agy`'s `(id, name)` models as catalog entries: one entry per model id, no
/// effort (it is part of the id).
pub fn acp_models(models: &[(String, String)]) -> Vec<ClaudeModelInfo> {
    models
        .iter()
        .map(|(id, name)| ClaudeModelInfo {
            value: id.clone(),
            resolved_model: id.clone(),
            display_name: name.clone(),
            description: String::new(),
            supports_effort: false,
            effort_levels: Vec::new(),
            default_effort: None,
        })
        .collect()
}

/// Codex's models as catalog entries: its own effort levels per model.
pub fn codex_models(models: &[CodexModel]) -> Vec<ClaudeModelInfo> {
    models
        .iter()
        .map(|m| ClaudeModelInfo {
            value: m.slug.clone(),
            resolved_model: m.slug.clone(),
            display_name: m.display_name.clone(),
            description: String::new(),
            supports_effort: !m.efforts.is_empty(),
            effort_levels: m.efforts.clone(),
            default_effort: Some(m.default_effort.clone()).filter(|e| !e.is_empty()),
        })
        .collect()
}

/// The models the CLI offers (no model call). Antigravity needs a signed-in
/// agent (the list comes with the session).
pub async fn fetch_models(kind: CliAgentKind) -> Result<Vec<ClaudeModelInfo>, String> {
    // A Claude that is too old is not launched, not even for the list.
    if kind == CliAgentKind::Claude {
        match tokio::task::spawn_blocking(find_current_claude).await {
            Ok(Err(ClaudeBinaryError::TooOld(message))) => return Err(message),
            Ok(Ok(program)) => return claude_probe_models(&program).await,
            _ => return Err(format!("{} CLI is not installed", kind.short_name())),
        }
    }
    let (program, prefix_args) = tokio::task::spawn_blocking(move || find_binary(kind))
        .await
        .ok()
        .flatten()
        .ok_or_else(|| format!("{} CLI is not installed", kind.short_name()))?;
    match kind {
        CliAgentKind::Claude => unreachable!("handled above"),
        CliAgentKind::Codex => codex_probe_models(&program, &prefix_args).await.map(|m| codex_models(&m)),
        CliAgentKind::Antigravity => acp_probe_models(program, antigravity_args())
            .await
            .map(|m| acp_models(&m))
            .map_err(|e| e.to_string()),
    }
}

/// No-cost check that the CLI is installed and logged in to a subscription
/// (Claude: or, flagged in the UI, an API account). The health probe's check.
pub async fn probe_kind(kind: CliAgentKind) -> Result<(), AgentErrorKind> {
    let (program, prefix_args) = tokio::task::spawn_blocking(move || find_binary(kind))
        .await
        .ok()
        .flatten()
        .ok_or(AgentErrorKind::NotInstalled)?;
    match kind {
        CliAgentKind::Claude => {
            // Too old to launch: unavailable, so requests don't try it and the
            // probe keeps checking until it is updated.
            let probed = program.clone();
            if tokio::task::spawn_blocking(move || claude_too_old(&probed)).await.ok().flatten().is_some() {
                return Err(AgentErrorKind::Outdated);
            }
            let auth = claude_auth_status(&program).await.map_err(|_| AgentErrorKind::Other)?;
            match auth.login {
                ClaudeLogin::Subscription => Ok(()),
                ClaudeLogin::LoggedOut => Err(AgentErrorKind::NotLoggedIn),
                // Not blocked (the user may want it); Settings and the footer
                // chip flag it, so it never passes for the subscription.
                ClaudeLogin::ApiBilled => {
                    log::warn!("{API_BILLED_NOTE}");
                    Ok(())
                }
            }
        }
        CliAgentKind::Codex => match login_status(&program, &prefix_args).await {
            CodexLogin::ChatGpt { .. } => Ok(()),
            // Sessions refuse an API-key login, so it is not "available".
            CodexLogin::ApiKey => {
                log::warn!("{CODEX_API_KEY_NOTE}");
                Err(AgentErrorKind::NotLoggedIn)
            }
            CodexLogin::LoggedOut => Err(AgentErrorKind::NotLoggedIn),
            CodexLogin::Unavailable(_) => Err(AgentErrorKind::Other),
        },
        CliAgentKind::Antigravity => match acp_probe_models(program, antigravity_args()).await {
            Ok(_) => Ok(()),
            Err(e) => Err(match e.kind() {
                AgentErrorKind::NotLoggedIn => AgentErrorKind::NotLoggedIn,
                AgentErrorKind::NotInstalled => AgentErrorKind::NotInstalled,
                _ => AgentErrorKind::Other,
            }),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_are_read_from_the_first_line() {
        assert_eq!(parse_version("codex-cli 0.171.0\n").as_deref(), Some("0.171.0"));
        assert_eq!(parse_version("1.5.14\r\n").as_deref(), Some("1.5.14"));
        assert_eq!(parse_version("\n  \nclaude 2.1.0 (Claude Code)\n").as_deref(), Some("2.1.0"));
        assert_eq!(parse_version("no number here"), None);
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn only_a_known_older_claude_reports_a_required_version() {
        let claude = CliAgentKind::Claude;
        assert_eq!(required_version_for(claude, Some("2.1.206 (Claude Code)")).as_deref(), Some("2.1.259"));
        assert_eq!(required_version_for(claude, Some("2.1.99 (Claude Code)")).as_deref(), Some("2.1.259"));
        assert_eq!(required_version_for(claude, Some("2.1.259 (Claude Code)")), None);
        assert_eq!(required_version_for(claude, Some("2.1.330 (Claude Code)")), None);
        assert_eq!(required_version_for(claude, Some("3.0.0")), None);
        // Unknown or unreadable: nothing is claimed.
        assert_eq!(required_version_for(claude, None), None);
        assert_eq!(required_version_for(claude, Some("garbage")), None);
        // Never for the other CLIs, whatever their version looks like.
        assert_eq!(required_version_for(CliAgentKind::Codex, Some("0.1.0")), None);
        assert_eq!(required_version_for(CliAgentKind::Antigravity, Some("1.5.14")), None);
    }

    #[test]
    fn a_chatgpt_login_is_the_subscription() {
        let a = codex_auth(&CodexLogin::ChatGpt { email: Some("a@b.test".into()), plan: Some("plus".into()) }).unwrap();
        assert_eq!(a.login, ClaudeLogin::Subscription);
        assert!(a.logged_in);
        assert_eq!((a.email.as_deref(), a.subscription_type.as_deref(), a.auth_method.as_str()), (Some("a@b.test"), Some("plus"), "chatgpt"));
        // No claims readable: still the subscription.
        let bare = codex_auth(&CodexLogin::ChatGpt { email: None, plan: None }).unwrap();
        assert_eq!((bare.login, bare.subscription_type.as_deref()), (ClaudeLogin::Subscription, Some("ChatGPT")));
    }

    #[test]
    fn an_api_key_login_is_not_the_subscription() {
        let a = codex_auth(&CodexLogin::ApiKey).unwrap();
        // Sessions refuse it, so it is not usable: not "logged in", not api-billed.
        assert_eq!(a.login, ClaudeLogin::LoggedOut);
        assert!(!a.logged_in);
        assert_eq!(a.auth_method, "api_key");
        assert_eq!(a.email, None);
        let out = codex_auth(&CodexLogin::LoggedOut).unwrap();
        assert_eq!((out.logged_in, out.login), (false, ClaudeLogin::LoggedOut));
        assert!(codex_auth(&CodexLogin::Unavailable("x".into())).is_none());
    }

    #[test]
    fn antigravity_is_signed_in_when_a_session_opens() {
        let ok: Result<Vec<()>, AgentError> = Ok(vec![]);
        assert_eq!(antigravity_auth(&ok).unwrap().login, ClaudeLogin::Subscription);
        let out: Result<Vec<()>, AgentError> =
            Err(AgentError::Cli(AgentErrorKind::NotLoggedIn, "API key is missing".into()));
        let out = antigravity_auth(&out).unwrap();
        assert_eq!((out.logged_in, out.login), (false, ClaudeLogin::LoggedOut));
        // A timeout says nothing about the login.
        let slow: Result<Vec<()>, AgentError> = Err(AgentError::Timeout);
        assert!(antigravity_auth(&slow).is_none());
    }

    #[test]
    fn model_lists_share_one_shape() {
        let agy = acp_models(&[("gemini-4-neon-high".into(), "Gemini 4 Neon (High)".into())]);
        assert_eq!(agy[0].value, "gemini-4-neon-high");
        assert_eq!(agy[0].display_name, "Gemini 4 Neon (High)");
        assert!(!agy[0].supports_effort && agy[0].effort_levels.is_empty());
        let codex = codex_models(&[CodexModel {
            slug: "gpt-6.2-sol".into(),
            display_name: "GPT-6.2-Sol".into(),
            efforts: vec!["low".into(), "ultra".into()],
            default_effort: "low".into(),
        }]);
        assert_eq!(codex[0].value, "gpt-6.2-sol");
        assert!(codex[0].supports_effort);
        assert_eq!(codex[0].effort_levels, ["low", "ultra"]);
        assert_eq!(codex[0].default_effort.as_deref(), Some("low"));
        // A model that reports no default has none.
        let no_default = codex_models(&[CodexModel {
            slug: "m".into(),
            display_name: "m".into(),
            efforts: vec![],
            default_effort: String::new(),
        }]);
        assert_eq!(no_default[0].default_effort, None);
        assert!(!no_default[0].supports_effort);
    }

    #[test]
    fn the_status_serializes_with_its_kind_as_the_provider_id() {
        let s = CliAgentStatus::not_installed(CliAgentKind::Codex, false);
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["kind"], "codex_cli");
        assert_eq!(v["installed"], false);
        assert!(v["binary_path"].is_null() && v["auth"].is_null());
        let back: CliAgentStatus = serde_json::from_value(v).unwrap();
        assert_eq!(back, s);
    }
}
