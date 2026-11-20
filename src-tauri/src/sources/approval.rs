//! The user's OK before NexQ runs an MCP server's command for the first time.
//!
//! A server is identified by what would actually execute (its [`fingerprint`]):
//! the command and arguments, or the URL, plus the names of its secret
//! variables and headers. Change any of that and the old approval no longer
//! applies. The label, the key and the tool switches are not part of it.
//!
//! Approved fingerprints live here, in the backend, in a file next to the
//! private session files. Nothing the webview can call records one: the only
//! way in is [`Approvals::ensure`], which records after the `ask` closure
//! (the native dialog) answered yes, and hands back an [`ApprovedServer`], the
//! proof the code that starts a server must hold. A session launch never asks
//! (it may happen in a meeting): it only reads [`Approvals::is_approved`].

use super::config::{McpServer, McpTransport};
use sha2::{Digest, Sha256};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// What a denied Check says on the card and in the Add dialog.
pub const NOT_APPROVED_TEXT: &str = "Not approved. Run Check to review it again.";

/// Most approvals kept; the oldest go first.
const APPROVALS_MAX: usize = 500;

/// Everything that decides what runs, as text that two different servers
/// can't share. Secret values are not in the config, so they cannot get in;
/// a plain environment variable is (its value changes what runs), a secret one
/// goes in by name only.
fn identity(server: &McpServer) -> String {
    let mut env: Vec<(&str, Option<&str>)> = server
        .env
        .iter()
        .map(|v| (v.name.as_str(), if v.secret { None } else { Some(v.value.as_deref().unwrap_or("")) }))
        .collect();
    env.sort();
    let value = match &server.transport {
        McpTransport::Stdio { command, args } => {
            serde_json::json!({ "v": 1, "stdio": { "command": command, "args": args, "env": env } })
        }
        McpTransport::Http { url, header_names } => {
            let mut names: Vec<&str> = header_names.iter().map(String::as_str).collect();
            names.sort();
            serde_json::json!({ "v": 1, "http": { "url": url, "headers": names, "env": env } })
        }
    };
    value.to_string()
}

/// SHA-256 (hex) of [`identity`].
pub fn fingerprint(server: &McpServer) -> String {
    let digest = Sha256::digest(identity(server).as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// The text of the native dialog.
#[derive(Debug, Clone, PartialEq)]
pub struct ApprovalPrompt {
    pub title: String,
    pub body: String,
}

/// Longest command line or URL the dialog shows in full.
const SHOWN_MAX: usize = 1200;

fn shown(text: &str) -> String {
    if text.chars().count() <= SHOWN_MAX {
        return text.to_string();
    }
    let cut: String = text.chars().take(SHOWN_MAX).collect();
    format!("{cut}… ({} more characters)", text.chars().count() - SHOWN_MAX)
}

/// `node "my server.js" --flag`: an argument with a space is quoted.
fn command_line(command: &str, args: &[String]) -> String {
    std::iter::once(command)
        .chain(args.iter().map(String::as_str))
        .map(|p| if p.is_empty() || p.contains(char::is_whitespace) { format!("\"{p}\"") } else { p.to_string() })
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn prompt_for(server: &McpServer) -> ApprovalPrompt {
    // Plain values are shown (they change what runs, e.g. NODE_OPTIONS);
    // secret values never are.
    let mut env_names: Vec<String> = server
        .env
        .iter()
        .map(|v| match (&v.value, v.secret) {
            (Some(value), false) => shown(&format!("{}={}", v.name, value)),
            _ => v.name.clone(),
        })
        .collect();
    env_names.sort();
    let env_line = if env_names.is_empty() {
        String::new()
    } else {
        format!("\n\nIt starts with these variables set: {}.", env_names.join(", "))
    };
    let body = match &server.transport {
        McpTransport::Stdio { command, args } => format!(
            "NexQ will run:\n{}\n\nfor the server \"{}\".{env_line}\n\nOnly allow commands you trust.",
            shown(&command_line(command, args)),
            server.label
        ),
        McpTransport::Http { url, .. } => format!(
            "NexQ will connect to:\n{}\n\nfor the server \"{}\". It sends the headers you set up.\n\nOnly allow servers you trust.",
            shown(url),
            server.label
        ),
    };
    ApprovalPrompt { title: "Run this MCP server?".to_string(), body }
}

/// The user's answer was no (or the dialog never answered).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NotApproved;

/// A server the user approved: what the code that starts a server takes, so a
/// server can't be started without going through [`Approvals::ensure`].
#[derive(Debug)]
pub struct ApprovedServer<'a>(&'a McpServer);

impl<'a> ApprovedServer<'a> {
    pub fn server(&self) -> &'a McpServer {
        self.0
    }

    /// For tests of code that needs the proof but not the dialog.
    #[cfg(test)]
    pub fn for_test(server: &'a McpServer) -> Self {
        Self(server)
    }
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct ApprovalsFile {
    #[serde(default)]
    approved: Vec<String>,
}

/// The approved fingerprints, in memory and (when it has a path) on disk.
#[derive(Default)]
pub struct Approvals {
    path: Option<PathBuf>,
    approved: Mutex<Vec<String>>,
    /// One dialog at a time: a second Check of the same server waits, then
    /// finds it approved.
    asking: tokio::sync::Mutex<()>,
}

/// `%LOCALAPPDATA%\NexQ\agent-private\approved-mcp-servers.json`: in the folder
/// the notes tools are denied and notes folders may not contain.
pub fn default_path() -> PathBuf {
    super::private_files::private_dir().join("approved-mcp-servers.json")
}

impl Approvals {
    /// Kept in memory only (tests, and the state before the app sets it up).
    pub fn in_memory() -> Self {
        Self::default()
    }

    /// Read `path`. A missing or damaged file means nothing is approved yet.
    pub fn load(path: &Path) -> Self {
        let approved = std::fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str::<ApprovalsFile>(&text).ok())
            .map(|f| f.approved)
            .unwrap_or_default();
        Self { path: Some(path.to_path_buf()), approved: Mutex::new(approved), ..Default::default() }
    }

    pub fn is_approved(&self, server: &McpServer) -> bool {
        let fp = fingerprint(server);
        self.approved.lock().map(|a| a.contains(&fp)).unwrap_or(false)
    }

    /// Ask unless approved already. `ask` shows the dialog and says whether the
    /// user chose Allow; only then is the approval recorded.
    pub async fn ensure<'a, F, Fut>(&self, server: &'a McpServer, ask: F) -> Result<ApprovedServer<'a>, NotApproved>
    where
        F: FnOnce(ApprovalPrompt) -> Fut,
        Fut: Future<Output = bool>,
    {
        if self.is_approved(server) {
            return Ok(ApprovedServer(server));
        }
        let _one_at_a_time = self.asking.lock().await;
        if self.is_approved(server) {
            return Ok(ApprovedServer(server));
        }
        if !ask(prompt_for(server)).await {
            return Err(NotApproved);
        }
        self.record(fingerprint(server));
        Ok(ApprovedServer(server))
    }

    fn record(&self, fp: String) {
        let snapshot = {
            let Ok(mut approved) = self.approved.lock() else { return };
            if !approved.contains(&fp) {
                approved.push(fp);
            }
            let excess = approved.len().saturating_sub(APPROVALS_MAX);
            approved.drain(..excess);
            approved.clone()
        };
        if let Some(path) = &self.path {
            if let Err(e) = write_atomic(path, &snapshot) {
                // Still approved for this run; it asks again after a restart.
                log::warn!("could not save the approved MCP servers: {e}");
            }
        }
    }
}

fn write_atomic(path: &Path, approved: &[String]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let text = serde_json::to_string(&ApprovalsFile { approved: approved.to_vec() })?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sources::config::EnvVar;

    fn stdio(command: &str, args: &[&str], env: Vec<EnvVar>) -> McpServer {
        McpServer {
            id: "id".into(),
            key: "mira".into(),
            label: "Mira".into(),
            transport: McpTransport::Stdio { command: command.into(), args: args.iter().map(|a| a.to_string()).collect() },
            env,
            enabled: true,
            ..Default::default()
        }
    }

    fn http(url: &str, headers: &[&str]) -> McpServer {
        McpServer {
            key: "web".into(),
            label: "Web".into(),
            transport: McpTransport::Http { url: url.into(), header_names: headers.iter().map(|h| h.to_string()).collect() },
            ..Default::default()
        }
    }

    fn secret(name: &str) -> EnvVar {
        EnvVar { name: name.into(), value: None, secret: true }
    }

    fn plain(name: &str, value: &str) -> EnvVar {
        EnvVar { name: name.into(), value: Some(value.into()), secret: false }
    }

    #[test]
    fn the_fingerprint_is_stable_and_hex() {
        let a = fingerprint(&stdio("node", &["s.js"], vec![secret("KEY")]));
        assert_eq!(a, fingerprint(&stdio("node", &["s.js"], vec![secret("KEY")])));
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn what_runs_changes_the_fingerprint() {
        let base = fingerprint(&stdio("node", &["s.js"], vec![secret("KEY")]));
        assert_ne!(base, fingerprint(&stdio("deno", &["s.js"], vec![secret("KEY")])));
        assert_ne!(base, fingerprint(&stdio("node", &["t.js"], vec![secret("KEY")])));
        assert_ne!(base, fingerprint(&stdio("node", &["s.js", "--x"], vec![secret("KEY")])));
        assert_ne!(base, fingerprint(&stdio("node", &["s.js"], vec![secret("OTHER")])));
        assert_ne!(base, fingerprint(&stdio("node", &["s.js"], vec![])));
        // A plain variable's value is part of what runs.
        assert_ne!(
            fingerprint(&stdio("node", &["s.js"], vec![plain("NODE_OPTIONS", "--a")])),
            fingerprint(&stdio("node", &["s.js"], vec![plain("NODE_OPTIONS", "--b")])),
        );
        // Arguments can't be glued together into another list.
        assert_ne!(
            fingerprint(&stdio("node", &["a b"], vec![])),
            fingerprint(&stdio("node", &["a", "b"], vec![])),
        );
        let url = fingerprint(&http("https://x.test/mcp", &["Authorization"]));
        assert_ne!(url, fingerprint(&http("https://y.test/mcp", &["Authorization"])));
        assert_ne!(url, fingerprint(&http("https://x.test/mcp", &["X-Key"])));
        assert_ne!(url, fingerprint(&http("https://x.test/mcp", &[])));
        assert_ne!(
            fingerprint(&stdio("https://x.test/mcp", &[], vec![])),
            fingerprint(&http("https://x.test/mcp", &[])),
        );
    }

    #[test]
    fn a_new_name_tool_switch_or_check_keeps_the_fingerprint() {
        let base = stdio("node", &["s.js"], vec![secret("B"), secret("A")]);
        let mut other = base.clone();
        other.label = "Renamed".into();
        other.id = "another-id".into();
        other.enabled = false;
        other.needs_sign_in = true;
        other.last_check = Some(Default::default());
        other.tools = vec![crate::sources::config::McpTool { name: "t".into(), full_name: "mcp__mira__t".into(), allowed: true }];
        other.env.reverse();
        assert_eq!(fingerprint(&base), fingerprint(&other));
    }

    #[test]
    fn a_secret_value_never_reaches_the_fingerprint_input() {
        // A secret variable has no value in the config; even if a value were
        // set on it, only its name counts.
        let with_value = EnvVar { name: "KEY".into(), value: Some("hunter2-secret".into()), secret: true };
        let server = stdio("node", &[], vec![with_value]);
        assert!(!identity(&server).contains("hunter2-secret"));
        assert_eq!(fingerprint(&server), fingerprint(&stdio("node", &[], vec![secret("KEY")])));
    }

    #[test]
    fn the_dialog_names_the_command_or_the_address() {
        let p = prompt_for(&stdio("node", &["my server.js", "--x"], vec![secret("KEY")]));
        assert_eq!(p.title, "Run this MCP server?");
        assert!(p.body.starts_with("NexQ will run:\nnode \"my server.js\" --x\n\nfor the server \"Mira\"."));
        assert!(p.body.contains("KEY"));
        assert!(p.body.contains("Only allow commands you trust."));
        let p = prompt_for(&http("https://x.test/mcp", &["Authorization"]));
        assert!(p.body.starts_with("NexQ will connect to:\nhttps://x.test/mcp\n\nfor the server \"Web\"."));
        assert!(p.body.contains("sends the headers"));
        let leaked = EnvVar { name: "API_KEY".into(), value: Some("hunter2".into()), secret: true };
        let p = prompt_for(&stdio("node", &[], vec![plain("NODE_OPTIONS", "--require x.js"), leaked]));
        assert!(p.body.contains("NODE_OPTIONS=--require x.js"), "a plain value changes what runs, so it is shown");
        assert!(p.body.contains("API_KEY") && !p.body.contains("hunter2"), "a secret value never is");
    }

    #[test]
    fn a_very_long_command_line_is_cut_and_says_so() {
        let long = "a".repeat(SHOWN_MAX + 50);
        let p = prompt_for(&stdio("node", &[&long], vec![]));
        assert!(p.body.contains("55 more characters"));
    }

    #[tokio::test]
    async fn allow_records_and_deny_does_not() {
        let approvals = Approvals::in_memory();
        let server = stdio("node", &["s.js"], vec![]);
        let denied = approvals.ensure(&server, |_| async { false }).await;
        assert!(denied.is_err());
        assert!(!approvals.is_approved(&server));

        let allowed = approvals.ensure(&server, |_| async { true }).await;
        assert_eq!(allowed.unwrap().server().key, "mira");
        assert!(approvals.is_approved(&server));

        // Already approved: no dialog at all.
        let again = approvals.ensure(&server, |_| async { panic!("asked again") }).await;
        assert!(again.is_ok());

        // A changed command asks again.
        let moved = stdio("node", &["evil.js"], vec![]);
        assert!(!approvals.is_approved(&moved));
        assert!(approvals.ensure(&moved, |_| async { false }).await.is_err());
    }

    #[tokio::test]
    async fn the_dialog_gets_the_prompt_for_that_server() {
        let approvals = Approvals::in_memory();
        let server = http("https://x.test/mcp", &[]);
        let seen = std::sync::Mutex::new(None);
        let _ = approvals
            .ensure(&server, |p| {
                *seen.lock().unwrap() = Some(p);
                async { false }
            })
            .await;
        assert_eq!(seen.lock().unwrap().clone(), Some(prompt_for(&server)));
    }

    #[test]
    fn approvals_survive_a_restart_and_a_damaged_file_approves_nothing() {
        let dir = std::env::temp_dir().join(format!("nexq-approvals-{}", uuid::Uuid::new_v4()));
        let path = dir.join("approved.json");
        let server = stdio("node", &["s.js"], vec![]);
        let first = Approvals::load(&path);
        assert!(!first.is_approved(&server));
        first.record(fingerprint(&server));
        first.record(fingerprint(&server));
        assert!(Approvals::load(&path).is_approved(&server));
        assert!(!Approvals::load(&path).is_approved(&stdio("node", &["other.js"], vec![])));
        // No secret value or command text is written, only the hash.
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("node") && !text.contains("s.js"));
        assert_eq!(text.matches(&fingerprint(&server)).count(), 1);

        std::fs::write(&path, "not json").unwrap();
        assert!(!Approvals::load(&path).is_approved(&server));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_oldest_approvals_go_first() {
        let approvals = Approvals::in_memory();
        for i in 0..(APPROVALS_MAX + 3) {
            approvals.record(format!("fp{i}"));
        }
        let kept = approvals.approved.lock().unwrap();
        assert_eq!(kept.len(), APPROVALS_MAX);
        assert_eq!(kept[0], "fp3");
    }
}
