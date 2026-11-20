//! CLI agent providers: drive a locally installed, already-logged-in coding
//! agent CLI as a long-lived streaming process.
//!
//! Only `Claude` has spawning code; `Gemini` and `Codex` are placeholders.

pub mod command;
pub mod context;
pub mod detect;
pub mod manager;
pub mod mcp_check;
pub mod models;
pub mod protocol;
pub mod provider;
pub mod routing;
pub mod session;

/// Which CLI agent a session talks to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CliAgentKind {
    Claude,
    /// Placeholder: no spawning code yet.
    Gemini,
    /// Placeholder: no spawning code yet.
    Codex,
}
