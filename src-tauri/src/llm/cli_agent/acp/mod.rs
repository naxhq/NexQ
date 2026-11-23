//! Agent Client Protocol client for Antigravity CLI (`agy acp`) sessions.
//!
//! - [`protocol`]: JSON-RPC message building and parsing (pure).
//! - [`permission`]: the pure policy that answers `session/request_permission`.
//! - [`launch`]: Antigravity's launch arguments and where `agy` lives.
//! - [`session`]: [`AcpSession`], a `SessionHandle` over a long-lived agent process.
//!
//! Verified against `agy acp` 1.5.14 (live probes, lines saved in `testdata/`).

pub mod launch;
pub mod permission;
pub mod protocol;
pub mod session;

pub use launch::{antigravity_args, find_agy};
pub use permission::{decide, McpToolRule, Outcome, PermissionPolicy, PermissionRequest};
pub use protocol::models_from_session_new;
pub use session::{probe_models, AcpLaunch, AcpSession, ACP_STRIPPED_ENV};
