//! CLI agent providers: drive a locally installed, already-logged-in coding
//! agent CLI as a long-lived streaming process.
//!
//! Claude uses its stream-json protocol (`session.rs`); Antigravity uses the
//! Agent Client Protocol (`acp/`); Codex uses `codex app-server` (`codex/`).
//! [`spawner`] picks the session type for a [`CliAgentKind`].

pub mod acp;
pub mod codex;
pub mod command;
pub mod context;
pub mod detect;
pub mod manager;
pub mod mcp_check;
pub mod mcp_diagnose;
pub mod models;
pub mod process_tree;
pub mod protocol;
pub mod provider;
pub mod routing;
pub mod session;
pub mod settings;
pub mod sources_convert;
pub mod spawner;
pub mod status;

/// Which CLI agent a session talks to. Serialised as the provider id
/// (`claude_cli`, `antigravity_cli`, `codex_cli`), the string the frontend uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize, serde::Deserialize)]
pub enum CliAgentKind {
    #[serde(rename = "claude_cli")]
    Claude,
    /// Antigravity CLI (`agy acp`), over the Agent Client Protocol.
    #[serde(rename = "antigravity_cli")]
    Antigravity,
    /// Codex CLI (`codex app-server`).
    #[serde(rename = "codex_cli")]
    Codex,
}

impl CliAgentKind {
    pub const ALL: [CliAgentKind; 3] = [CliAgentKind::Claude, CliAgentKind::Antigravity, CliAgentKind::Codex];

    /// The provider id (`ProviderType::as_str`).
    pub fn provider_id(self) -> &'static str {
        match self {
            CliAgentKind::Claude => "claude_cli",
            CliAgentKind::Antigravity => "antigravity_cli",
            CliAgentKind::Codex => "codex_cli",
        }
    }

    pub fn from_provider_id(id: &str) -> Option<CliAgentKind> {
        CliAgentKind::ALL.into_iter().find(|k| k.provider_id() == id)
    }

    /// The provider's display name (`ProviderType::display_name`).
    pub fn display_name(self) -> &'static str {
        match self {
            CliAgentKind::Claude => "Claude (subscription)",
            CliAgentKind::Antigravity => "Antigravity (subscription)",
            CliAgentKind::Codex => "Codex (subscription)",
        }
    }

    /// What the product is called in messages ("Claude can't read images").
    pub fn short_name(self) -> &'static str {
        match self {
            CliAgentKind::Claude => "Claude",
            CliAgentKind::Antigravity => "Antigravity",
            CliAgentKind::Codex => "Codex",
        }
    }

    /// The program's name (`claude`, `agy`, `codex`).
    pub fn binary_name(self) -> &'static str {
        match self {
            CliAgentKind::Claude => "claude",
            CliAgentKind::Antigravity => "agy",
            CliAgentKind::Codex => "codex",
        }
    }

    pub fn provider_type(self) -> crate::llm::ProviderType {
        match self {
            CliAgentKind::Claude => crate::llm::ProviderType::ClaudeCli,
            CliAgentKind::Antigravity => crate::llm::ProviderType::AntigravityCli,
            CliAgentKind::Codex => crate::llm::ProviderType::CodexCli,
        }
    }

    /// Only Claude sessions take image attachments.
    pub fn supports_images(self) -> bool {
        matches!(self, CliAgentKind::Claude)
    }

    /// Only Claude has a thinking toggle (Antigravity encodes it in the model
    /// id, Codex in the effort).
    pub fn supports_thinking_toggle(self) -> bool {
        matches!(self, CliAgentKind::Claude)
    }

    /// Antigravity has one model entry per effort level, so it takes no
    /// separate effort.
    pub fn has_effort_param(self) -> bool {
        !matches!(self, CliAgentKind::Antigravity)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_round_trip_through_their_provider_id() {
        for kind in CliAgentKind::ALL {
            assert_eq!(CliAgentKind::from_provider_id(kind.provider_id()), Some(kind));
            assert_eq!(kind.provider_type().as_str(), kind.provider_id());
            assert_eq!(kind.provider_type().display_name(), kind.display_name());
            assert_eq!(kind.provider_type().cli_agent_kind(), Some(kind));
            let json = serde_json::to_string(&kind).unwrap();
            assert_eq!(json, format!("\"{}\"", kind.provider_id()));
            assert_eq!(serde_json::from_str::<CliAgentKind>(&json).unwrap(), kind);
        }
        assert_eq!(CliAgentKind::from_provider_id("gemini_cli"), None);
        assert_eq!(CliAgentKind::from_provider_id("ollama"), None);
    }

    #[test]
    fn only_claude_takes_images_and_the_thinking_toggle() {
        assert!(CliAgentKind::Claude.supports_images() && CliAgentKind::Claude.supports_thinking_toggle());
        for kind in [CliAgentKind::Antigravity, CliAgentKind::Codex] {
            assert!(!kind.supports_images() && !kind.supports_thinking_toggle());
        }
        assert!(!CliAgentKind::Antigravity.has_effort_param());
        assert!(CliAgentKind::Codex.has_effort_param() && CliAgentKind::Claude.has_effort_param());
    }
}
