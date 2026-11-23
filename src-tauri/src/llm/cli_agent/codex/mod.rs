//! Codex CLI sessions over `codex app-server` (JSON-RPC over stdio).
//!
//! - [`launch`]: the binary, argv, environment and everything of the user's
//!   Codex config that is switched off.
//! - [`protocol`]: pure JSON-RPC builders and parsers, tested against fixtures
//!   in `testdata/`.
//! - [`policy`]: the pure decider that answers the server's approval requests.
//! - [`session`]: `CodexSession`, a `SessionHandle`.
//! - [`models`]: the model list and sign-in state, read without a model call.

pub mod launch;
pub mod models;
pub mod policy;
pub mod protocol;
pub mod session;

pub use launch::{find_codex, resolve_program, CodexLaunch};
pub use models::{login_status, probe_models, CodexLogin, CodexModel};
pub use policy::CodexPolicy;
pub use session::CodexSession;
