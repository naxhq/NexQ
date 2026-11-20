//! Settings commands for personal sources: notes folders, MCP servers (pasted
//! JSON, a form, Claude Code import), the tool check, saved secrets and
//! opening a note.
//!
//! Secret values (secret env vars, every HTTP header value) go to Credential
//! Manager under `mcp_json::credential_id` / `header_credential_id` and never
//! come back over IPC: a returned `McpServer` holds only names.

use crate::credentials::CredentialManager;
use crate::llm::cli_agent::mcp_check::list_server_tools;
use crate::sources::config::{
    EnvVar, McpCheckStatus, McpServer, McpTransport, PersonalSourcesConfig,
};
use crate::sources::launch::folder_problem;
use crate::sources::mcp_json::{
    credential_id, header_credential_id, into_server, is_secret_name, merge_checked_tools,
    parse_mcp_json, read_claude_code_entries, unique_key, RawServer, SecretValue,
};
use crate::sources::notes::{inspect_folder, NotesFolderInfo};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::{command, State};

// ── Secret storage ──────────────────────────────────────────────────────────

/// Where saved secret values live (Credential Manager in the app, memory in
/// tests).
pub trait SecretStore {
    fn get(&self, id: &str) -> Option<String>;
    fn set(&self, id: &str, value: &str) -> Result<(), String>;
    fn delete(&self, id: &str);
}

/// Windows Credential Manager through [`CredentialManager`].
struct SystemSecrets(CredentialManager);

impl SystemSecrets {
    fn new() -> Self {
        Self(CredentialManager::new())
    }
}

impl SecretStore for SystemSecrets {
    fn get(&self, id: &str) -> Option<String> {
        self.0.get_key(id).ok().flatten()
    }

    fn set(&self, id: &str, value: &str) -> Result<(), String> {
        self.0.store_key(id, value)
    }

    fn delete(&self, id: &str) {
        if let Err(e) = self.0.delete_key(id) {
            log::warn!("could not delete a saved server secret ({id}): {e}");
        }
    }
}

/// Store every secret, or none: a failure puts back what this call changed.
fn store_secrets(store: &dyn SecretStore, secrets: &[SecretValue]) -> Result<(), String> {
    let mut done: Vec<(&str, Option<String>)> = Vec::new();
    for secret in secrets {
        let previous = store.get(&secret.credential_id);
        if let Err(e) = store.set(&secret.credential_id, &secret.value) {
            for (id, previous) in done.into_iter().rev() {
                match previous {
                    Some(value) => {
                        let _ = store.set(id, &value);
                    }
                    None => store.delete(id),
                }
            }
            return Err(format!("Couldn't save a secret in Windows Credential Manager: {e}"));
        }
        done.push((&secret.credential_id, previous));
    }
    Ok(())
}

/// Credential ids of every secret `server` keeps: its secret env vars and each
/// header.
pub fn secret_ids(server: &McpServer) -> Vec<String> {
    let mut ids: Vec<String> = server
        .env
        .iter()
        .filter(|e| e.secret)
        .map(|e| credential_id(&server.key, &e.name))
        .collect();
    if let McpTransport::Http { header_names, .. } = &server.transport {
        ids.extend(header_names.iter().map(|h| header_credential_id(&server.key, h)));
    }
    ids
}

/// Secrets `old` kept that `new` no longer does.
fn stale_credential_ids(old: &McpServer, new: &McpServer) -> Vec<String> {
    let kept = secret_ids(new);
    secret_ids(old).into_iter().filter(|id| !kept.contains(id)).collect()
}

// ── Notes folders ───────────────────────────────────────────────────────────

/// Does the folder exist, how many notes does it hold, and may it be a notes
/// folder at all (`problem`). Called when a folder is added and when a card
/// is shown.
#[command]
pub async fn inspect_notes_folder(path: String) -> Result<NotesFolderInfo, String> {
    tokio::task::spawn_blocking(move || {
        let path = Path::new(&path);
        let mut info = inspect_folder(path);
        info.problem = folder_problem(path);
        info
    })
    .await
    .map_err(|e| format!("Couldn't look at the folder: {e}"))
}

/// Is `path` a file inside one of the enabled notes folders? Both sides are
/// resolved first, so `..` and links cannot lead out. A path that doesn't
/// exist is never inside.
pub fn is_inside_enabled_folder(path: &Path, cfg: &PersonalSourcesConfig) -> bool {
    let Ok(real) = std::fs::canonicalize(path) else {
        return false;
    };
    cfg.enabled_folders().iter().any(|folder| {
        std::fs::canonicalize(&folder.path)
            .map(|root| real.starts_with(root))
            .unwrap_or(false)
    })
}

/// Extensions a note chip may open. Anything that could run (`.exe`, `.bat`,
/// `.lnk`, scripts) or that renders active content (`.html`) is not here.
const OPENABLE_EXTENSIONS: [&str; 22] = [
    "md", "markdown", "txt", "text", "org", "rtf", "pdf", "png", "jpg", "jpeg", "gif", "webp", "csv",
    "tsv", "json", "yaml", "yml", "docx", "xlsx", "pptx", "odt", "ods",
];

fn is_openable_note(path: &Path) -> bool {
    path.is_file()
        && path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| OPENABLE_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

/// Open a note with the system's default app, only if it is inside an enabled
/// notes folder (and is a kind of file that shows rather than runs).
#[command]
pub fn open_source_file(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let cfg = state
        .personal_sources
        .read()
        .map_err(|_| "Couldn't read your sources".to_string())?
        .clone();
    let target = Path::new(&path);
    if !is_inside_enabled_folder(target, &cfg) {
        return Err("That file isn't inside one of your enabled notes folders.".to_string());
    }
    if !is_openable_note(target) {
        return Err("NexQ only opens notes and documents from here, not other kinds of file.".to_string());
    }
    #[cfg(target_os = "windows")]
    let program = "explorer";
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let program = "xdg-open";
    std::process::Command::new(program)
        .arg(target)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Couldn't open {path}: {e}"))
}

// ── MCP servers: import ─────────────────────────────────────────────────────

/// Servers added from raw entries: unique keys (also among the servers added
/// in this call), secrets split out and stored.
fn add_servers(
    store: &dyn SecretStore,
    entries: Vec<(String, RawServer)>,
    taken_keys: &[String],
) -> Result<Vec<McpServer>, String> {
    let mut taken = taken_keys.to_vec();
    let mut servers = Vec::new();
    let mut secrets: Vec<SecretValue> = Vec::new();
    for (name, raw) in entries {
        let (server, server_secrets) = into_server(&name, raw, &taken);
        taken.push(server.key.clone());
        secrets.extend(server_secrets);
        servers.push(server);
    }
    store_secrets(store, &secrets)?;
    Ok(servers)
}

fn import_json(store: &dyn SecretStore, json: &str, taken_keys: &[String]) -> Result<Vec<McpServer>, String> {
    add_servers(store, parse_mcp_json(json)?, taken_keys)
}

/// Add the servers in pasted `mcpServers` JSON. Secret values are stored in
/// Credential Manager and are not in the returned servers.
#[command]
pub fn import_mcp_servers_json(json: String, taken_keys: Vec<String>) -> Result<Vec<McpServer>, String> {
    import_json(&SystemSecrets::new(), &json, &taken_keys)
}

/// A server in Claude Code's own config, for the import picker.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClaudeCodeMcpServer {
    pub name: String,
    /// `node s.js`, or the URL.
    pub summary: String,
    /// `"stdio"` | `"http"`; `"unsupported"` when it cannot be imported.
    pub transport: String,
    /// An HTTP server Claude Code signs in to itself (OAuth): imported off.
    pub needs_sign_in: bool,
    /// Why it can't be imported at all (SSE, a malformed entry).
    pub unsupported: Option<String>,
}

fn summarize(raw: &RawServer) -> (String, &'static str) {
    match &raw.transport {
        McpTransport::Stdio { command, args } => {
            let mut parts = vec![command.clone()];
            parts.extend(args.iter().cloned());
            (parts.join(" "), "stdio")
        }
        McpTransport::Http { url, .. } => (url.clone(), "http"),
    }
}

fn list_claude_code(claude_json: &str) -> Result<Vec<ClaudeCodeMcpServer>, String> {
    Ok(read_claude_code_entries(claude_json)?
        .into_iter()
        .map(|(name, parsed)| match parsed {
            Ok(raw) => {
                let (summary, transport) = summarize(&raw);
                ClaudeCodeMcpServer {
                    name,
                    summary,
                    transport: transport.to_string(),
                    needs_sign_in: raw.oauth,
                    unsupported: None,
                }
            }
            Err(reason) => ClaudeCodeMcpServer {
                name,
                summary: String::new(),
                transport: "unsupported".to_string(),
                needs_sign_in: false,
                unsupported: Some(reason),
            },
        })
        .collect())
}

fn import_claude_code(
    store: &dyn SecretStore,
    claude_json: &str,
    names: &[String],
    taken_keys: &[String],
) -> Result<Vec<McpServer>, String> {
    let all = read_claude_code_entries(claude_json)?;
    let mut picked = Vec::new();
    for name in names {
        match all.iter().find(|(n, _)| n == name) {
            Some((n, Ok(raw))) => picked.push((n.clone(), raw.clone())),
            Some((_, Err(reason))) => return Err(reason.clone()),
            None => return Err(format!("Claude Code has no server named \"{name}\"")),
        }
    }
    add_servers(store, picked, taken_keys)
}

/// `%USERPROFILE%\.claude.json`, read only when asked.
fn read_claude_json() -> Result<Option<String>, String> {
    let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) else {
        return Ok(None);
    };
    let path = Path::new(&home).join(".claude.json");
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Couldn't read Claude Code's config: {e}")),
    }
}

/// The MCP servers set up in Claude Code (user scope), for the import picker.
/// Reads `%USERPROFILE%\.claude.json` only when called.
#[command]
pub fn list_claude_code_mcp_servers() -> Result<Vec<ClaudeCodeMcpServer>, String> {
    match read_claude_json()? {
        Some(text) => list_claude_code(&text),
        None => Ok(Vec::new()),
    }
}

/// Copy the named Claude Code servers into NexQ. A server that signs in with
/// OAuth comes back `needs_sign_in` and off; header values and secret env
/// values are stored in Credential Manager.
#[command]
pub fn import_claude_code_mcp_servers(
    names: Vec<String>,
    taken_keys: Vec<String>,
) -> Result<Vec<McpServer>, String> {
    let text = read_claude_json()?.ok_or("Claude Code's config wasn't found on this PC")?;
    import_claude_code(&SystemSecrets::new(), &text, &names, &taken_keys)
}

// ── MCP servers: the add/edit form ──────────────────────────────────────────

/// One name/value row of the form (an env var or an HTTP header).
#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct FormPair {
    pub name: String,
    /// A secret left blank on an existing server keeps its saved value.
    pub value: String,
}

impl std::fmt::Debug for FormPair {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FormPair").field("name", &self.name).field("value", &"<redacted>").finish()
    }
}

/// The add/edit server form.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct McpServerForm {
    /// `None` for a new server.
    pub id: Option<String>,
    /// The existing server's key (never changes); `None` for a new server.
    pub key: Option<String>,
    pub label: String,
    /// For HTTP only the `url` is read: header names come from `headers`.
    pub transport: McpTransport,
    pub env: Vec<FormPair>,
    pub headers: Vec<FormPair>,
}

/// The secrets a form brings: every non-blank secret env value and header
/// value. A blank one is skipped when `has_stored(credential id)` (the saved
/// value stays), else it is an error.
pub fn form_secrets(
    form: &McpServerForm,
    key: &str,
    has_stored: &dyn Fn(&str) -> bool,
) -> Result<Vec<SecretValue>, String> {
    let mut secrets = Vec::new();
    let mut take = |id: String, what: String, value: &str| -> Result<(), String> {
        if !value.is_empty() {
            secrets.push(SecretValue { credential_id: id, value: value.to_string() });
        } else if !has_stored(&id) {
            return Err(format!("{what} needs a value"));
        }
        Ok(())
    };
    for pair in form.env.iter().filter(|p| is_secret_name(p.name.trim())) {
        let name = pair.name.trim();
        take(credential_id(key, name), name.to_string(), &pair.value)?;
    }
    if matches!(form.transport, McpTransport::Http { .. }) {
        for pair in &form.headers {
            let name = pair.name.trim();
            take(header_credential_id(key, name), format!("The {name} header"), &pair.value)?;
        }
    }
    Ok(secrets)
}

/// Check the form and build the server it describes plus the secrets to store.
/// `old` is the saved server being edited (its tool switches and on/off state
/// stay; it counts as unchecked again).
fn build_form_server(
    form: &McpServerForm,
    taken_keys: &[String],
    old: Option<&McpServer>,
    has_stored: &dyn Fn(&str) -> bool,
) -> Result<(McpServer, Vec<SecretValue>), String> {
    let label = form.label.trim();
    if label.is_empty() {
        return Err("Give the server a name".to_string());
    }
    let key = match (&form.key, old) {
        (Some(key), _) => key.clone(),
        (None, Some(old)) => old.key.clone(),
        (None, None) => unique_key(label, taken_keys),
    };

    let transport = match &form.transport {
        McpTransport::Stdio { command, args } => {
            let command = command.trim();
            if command.is_empty() {
                return Err("Enter the command that starts the server".to_string());
            }
            McpTransport::Stdio {
                command: command.to_string(),
                args: args.iter().map(|a| a.trim().to_string()).filter(|a| !a.is_empty()).collect(),
            }
        }
        McpTransport::Http { url, .. } => {
            let url = url.trim();
            if !(url.starts_with("http://") || url.starts_with("https://")) {
                return Err("The URL must start with http:// or https://".to_string());
            }
            let mut names: Vec<String> = Vec::new();
            for pair in &form.headers {
                let name = pair.name.trim();
                if name.is_empty() {
                    return Err("A header needs a name".to_string());
                }
                if names.iter().any(|n| n.eq_ignore_ascii_case(name)) {
                    return Err(format!("The {name} header is listed twice"));
                }
                names.push(name.to_string());
            }
            McpTransport::Http { url: url.to_string(), header_names: names }
        }
    };

    let mut env: Vec<EnvVar> = Vec::new();
    if matches!(transport, McpTransport::Stdio { .. }) {
        for pair in &form.env {
            let name = pair.name.trim();
            if name.is_empty() {
                return Err("An environment variable needs a name".to_string());
            }
            if name.contains('=') || name.contains(char::is_whitespace) {
                return Err(format!("\"{name}\" isn't a valid environment variable name"));
            }
            if env.iter().any(|e| e.name.eq_ignore_ascii_case(name)) {
                return Err(format!("{name} is listed twice"));
            }
            env.push(if is_secret_name(name) {
                EnvVar { name: name.to_string(), value: None, secret: true }
            } else {
                EnvVar { name: name.to_string(), value: Some(pair.value.clone()), secret: false }
            });
        }
    }

    // Only what the saved transport kind actually uses is read for secrets.
    let for_secrets = McpServerForm {
        transport: transport.clone(),
        env: form.env.iter().filter(|_| matches!(transport, McpTransport::Stdio { .. })).cloned().collect(),
        ..form.clone()
    };
    let secrets = form_secrets(&for_secrets, &key, has_stored)?;

    let server = McpServer {
        id: form
            .id
            .clone()
            .or_else(|| old.map(|o| o.id.clone()))
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        key,
        label: label.to_string(),
        transport,
        enabled: old.map(|o| o.enabled).unwrap_or(true),
        env,
        tools: old.map(|o| o.tools.clone()).unwrap_or_default(),
        last_check: None,
        needs_sign_in: false,
    };
    Ok((server, secrets))
}

/// Save the add/edit form: builds the server, stores its secrets in
/// Credential Manager and drops the ones an edit removed. The returned server
/// holds names only. For an edit, tool switches and the on/off state come from
/// the server NexQ already has under that id.
#[command]
pub fn save_mcp_server_form(
    form: McpServerForm,
    taken_keys: Vec<String>,
    state: State<'_, AppState>,
) -> Result<McpServer, String> {
    let store = SystemSecrets::new();
    let old = form.id.as_ref().and_then(|id| {
        state
            .personal_sources
            .read()
            .ok()
            .and_then(|cfg| cfg.mcp_servers.iter().find(|s| &s.id == id).cloned())
    });
    let (server, secrets) =
        build_form_server(&form, &taken_keys, old.as_ref(), &|id| store.get(id).is_some())?;
    store_secrets(&store, &secrets)?;
    if let Some(old) = &old {
        for id in stale_credential_ids(old, &server) {
            store.delete(&id);
        }
    }
    Ok(server)
}

// ── MCP servers: check, forget ──────────────────────────────────────────────

/// `server` after a check: the tool list merged (earlier switches kept, new
/// tools take the read-only default, vanished ones dropped) and a fresh
/// status. A failed check keeps the tools and says why.
fn apply_check(server: &McpServer, found: Result<Vec<String>, String>, now_ms: u64) -> McpServer {
    let mut out = server.clone();
    match found {
        Ok(full_names) => {
            out.tools = merge_checked_tools(&server.tools, &full_names, &server.key);
            out.last_check = Some(McpCheckStatus {
                ok: true,
                tool_count: out.tools.len(),
                error: None,
                checked_at_ms: now_ms,
            });
        }
        Err(error) => {
            out.last_check = Some(McpCheckStatus {
                ok: false,
                tool_count: 0,
                error: Some(error),
                checked_at_ms: now_ms,
            });
        }
    }
    out
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Start the server the way a session would and list its tools (up to 60 s).
/// Never an `Err` for a server that fails: the returned server says so in
/// `last_check` (`ok: false`, with `error`).
#[command]
pub async fn check_mcp_server(server: McpServer) -> Result<McpServer, String> {
    let store = SystemSecrets::new();
    let secret = |id: &str| store.get(id);
    let found = list_server_tools(&server, &secret).await;
    Ok(apply_check(&server, found, now_ms()))
}

/// Forget the saved secrets of a server that is being removed.
#[command]
pub fn delete_mcp_secrets(server: McpServer) -> Result<(), String> {
    let store = SystemSecrets::new();
    for id in secret_ids(&server) {
        store.delete(&id);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sources::config::{McpTool, NotesFolder};
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MemoryStore {
        values: Mutex<HashMap<String, String>>,
        /// `set` fails for this id.
        fail_on: Option<String>,
    }

    impl SecretStore for MemoryStore {
        fn get(&self, id: &str) -> Option<String> {
            self.values.lock().unwrap().get(id).cloned()
        }

        fn set(&self, id: &str, value: &str) -> Result<(), String> {
            if self.fail_on.as_deref() == Some(id) {
                return Err("denied".into());
            }
            self.values.lock().unwrap().insert(id.into(), value.into());
            Ok(())
        }

        fn delete(&self, id: &str) {
            self.values.lock().unwrap().remove(id);
        }
    }

    fn temp_tree(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("nexq-src-cmd-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn folder(path: &Path, enabled: bool) -> NotesFolder {
        NotesFolder { id: "f".into(), label: "Vault".into(), path: path.to_string_lossy().into(), enabled }
    }

    #[test]
    fn open_path_must_be_inside_an_enabled_folder() {
        // A name with a space and an @, like an Obsidian vault.
        let root = temp_tree("open");
        let vault = root.join("@Vault notes");
        std::fs::create_dir_all(vault.join("sub")).unwrap();
        std::fs::write(vault.join("sub").join("a.md"), "x").unwrap();
        std::fs::write(root.join("outside.md"), "x").unwrap();
        let cfg = |enabled| PersonalSourcesConfig { notes_folders: vec![folder(&vault, enabled)], ..Default::default() };

        let inside = vault.join("sub").join("a.md");
        assert!(is_inside_enabled_folder(&inside, &cfg(true)));
        // `..` cannot lead out.
        assert!(!is_inside_enabled_folder(&vault.join("..").join("outside.md"), &cfg(true)));
        assert!(!is_inside_enabled_folder(&root.join("outside.md"), &cfg(true)));
        // Disabled folder, a path that doesn't exist, no folders at all.
        assert!(!is_inside_enabled_folder(&inside, &cfg(false)));
        assert!(!is_inside_enabled_folder(&vault.join("nope.md"), &cfg(true)));
        assert!(!is_inside_enabled_folder(&inside, &PersonalSourcesConfig::default()));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn only_notes_and_documents_open() {
        let dir = temp_tree("kinds");
        for (name, ok) in [("a.md", true), ("b.PDF", true), ("c.exe", false), ("d.bat", false), ("e.lnk", false), ("f.html", false), ("g", false)] {
            let p = dir.join(name);
            std::fs::write(&p, "x").unwrap();
            assert_eq!(is_openable_note(&p), ok, "{name}");
        }
        assert!(!is_openable_note(&dir), "a folder is not a note");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn form_secret_left_blank_keeps_the_stored_one() {
        let form = McpServerForm {
            id: Some("i".into()),
            key: Some("mira".into()),
            label: "Mira".into(),
            transport: McpTransport::Stdio { command: "node".into(), args: vec![] },
            env: vec![
                FormPair { name: "API_KEY".into(), value: "".into() },
                FormPair { name: "MODE".into(), value: "ro".into() },
            ],
            headers: vec![],
        };
        let stored = |id: &str| id == "mcp:mira:API_KEY";
        assert_eq!(form_secrets(&form, "mira", &stored).unwrap(), vec![]);
        // A blank secret with nothing saved is an error that names it.
        let err = form_secrets(&form, "mira", &|_| false).unwrap_err();
        assert!(err.contains("API_KEY"), "{err}");
        // A typed value replaces the saved one.
        let mut typed = form.clone();
        typed.env[0].value = "new".into();
        let got = form_secrets(&typed, "mira", &stored).unwrap();
        assert_eq!(got, vec![SecretValue { credential_id: "mcp:mira:API_KEY".into(), value: "new".into() }]);
        // Non-secret values are never secrets.
        assert!(got.iter().all(|s| !s.credential_id.ends_with("MODE")));
    }

    #[test]
    fn form_builds_stdio_server_with_split_secrets() {
        let form = McpServerForm {
            id: None,
            key: None,
            label: " My Mira ".into(),
            transport: McpTransport::Stdio { command: " node ".into(), args: vec!["s.js".into(), "  ".into()] },
            env: vec![
                FormPair { name: "API_KEY".into(), value: "k".into() },
                FormPair { name: "MODE".into(), value: "ro".into() },
            ],
            headers: vec![FormPair { name: "Ignored".into(), value: "v".into() }],
        };
        let (server, secrets) = build_form_server(&form, &["my-mira".into()], None, &|_| false).unwrap();
        assert_eq!(server.key, "my-mira-2");
        assert_eq!(server.label, "My Mira");
        assert!(server.enabled && server.tools.is_empty() && server.last_check.is_none());
        assert_eq!(server.transport, McpTransport::Stdio { command: "node".into(), args: vec!["s.js".into()] });
        assert_eq!(server.env, vec![
            EnvVar { name: "API_KEY".into(), value: None, secret: true },
            EnvVar { name: "MODE".into(), value: Some("ro".into()), secret: false },
        ]);
        assert_eq!(secrets.len(), 1, "stdio ignores header rows: {secrets:?}");
        assert!(!serde_json::to_string(&server).unwrap().contains("\"k\""));
    }

    #[test]
    fn form_http_headers_are_all_secrets() {
        let form = McpServerForm {
            id: None,
            key: None,
            label: "Wiki".into(),
            transport: McpTransport::Http { url: "https://h/mcp".into(), header_names: vec!["stale".into()] },
            env: vec![FormPair { name: "API_KEY".into(), value: "ignored".into() }],
            headers: vec![FormPair { name: "Authorization".into(), value: "Bearer t".into() }],
        };
        let (server, secrets) = build_form_server(&form, &[], None, &|_| false).unwrap();
        assert_eq!(server.transport, McpTransport::Http { url: "https://h/mcp".into(), header_names: vec!["Authorization".into()] });
        assert!(server.env.is_empty());
        assert_eq!(secrets, vec![SecretValue { credential_id: "mcp:wiki:header:Authorization".into(), value: "Bearer t".into() }]);
        assert!(!serde_json::to_string(&server).unwrap().contains("Bearer"));
    }

    #[test]
    fn form_rejects_bad_input() {
        let base = McpServerForm {
            id: None,
            key: None,
            label: "A".into(),
            transport: McpTransport::Stdio { command: "node".into(), args: vec![] },
            env: vec![],
            headers: vec![],
        };
        let check = |f: McpServerForm| build_form_server(&f, &[], None, &|_| false).unwrap_err();
        assert!(check(McpServerForm { label: " ".into(), ..base.clone() }).contains("name"));
        assert!(check(McpServerForm { transport: McpTransport::Stdio { command: " ".into(), args: vec![] }, ..base.clone() }).contains("command"));
        assert!(check(McpServerForm { transport: McpTransport::Http { url: "ftp://x".into(), header_names: vec![] }, ..base.clone() }).contains("http"));
        assert!(check(McpServerForm { env: vec![FormPair { name: "A B".into(), value: "".into() }], ..base.clone() }).contains("valid"));
        assert!(check(McpServerForm { env: vec![FormPair { name: "X".into(), value: "1".into() }, FormPair { name: "x".into(), value: "2".into() }], ..base }).contains("twice"));
    }

    #[test]
    fn editing_keeps_key_tools_and_enabled_and_drops_removed_secrets() {
        let old = McpServer {
            id: "id1".into(),
            key: "mira".into(),
            label: "Mira".into(),
            transport: McpTransport::Stdio { command: "node".into(), args: vec![] },
            enabled: false,
            env: vec![
                EnvVar { name: "API_KEY".into(), value: None, secret: true },
                EnvVar { name: "OLD_TOKEN".into(), value: None, secret: true },
            ],
            tools: vec![McpTool { name: "kb".into(), full_name: "mcp__mira__kb".into(), allowed: true }],
            last_check: Some(McpCheckStatus { ok: true, tool_count: 1, error: None, checked_at_ms: 5 }),
            ..Default::default()
        };
        let form = McpServerForm {
            id: Some("id1".into()),
            key: Some("mira".into()),
            label: "Mira 2".into(),
            transport: old.transport.clone(),
            env: vec![FormPair { name: "API_KEY".into(), value: "".into() }],
            headers: vec![],
        };
        let (server, secrets) = build_form_server(&form, &["other".into()], Some(&old), &|id| id == "mcp:mira:API_KEY").unwrap();
        assert!(secrets.is_empty());
        assert_eq!((server.key.as_str(), server.id.as_str(), server.enabled), ("mira", "id1", false));
        assert_eq!(server.tools, old.tools);
        assert!(server.last_check.is_none(), "an edited server is unchecked again");
        assert_eq!(stale_credential_ids(&old, &server), vec!["mcp:mira:OLD_TOKEN".to_string()]);
    }

    #[test]
    fn import_json_stores_secrets_and_keeps_them_out_of_the_result() {
        let store = MemoryStore::default();
        let json = r#"{"mcpServers":{"mira":{"command":"x","env":{"API_KEY":"k1"}},"Mira":{"command":"y","env":{"API_KEY":"k2"}}}}"#;
        let servers = import_json(&store, json, &["mira".into()]).unwrap();
        let keys: Vec<_> = servers.iter().map(|s| s.key.clone()).collect();
        assert_eq!(keys.len(), 2);
        assert!(keys.iter().all(|k| k != "mira"), "{keys:?}");
        assert_ne!(keys[0], keys[1]);
        // Each server's own secret under its own id.
        let values: Vec<_> = keys.iter().map(|k| store.get(&format!("mcp:{k}:API_KEY")).unwrap()).collect();
        assert_eq!(values.len(), 2);
        assert!(values.contains(&"k1".to_string()) && values.contains(&"k2".to_string()));
        let text = serde_json::to_string(&servers).unwrap();
        assert!(!text.contains("k1") && !text.contains("k2"));
    }

    #[test]
    fn a_failed_secret_write_undoes_the_ones_before() {
        let store = MemoryStore { fail_on: Some("mcp:b:API_KEY".into()), ..Default::default() };
        store.set("mcp:a:API_KEY", "old").unwrap();
        let secrets = vec![
            SecretValue { credential_id: "mcp:a:API_KEY".into(), value: "new".into() },
            SecretValue { credential_id: "mcp:c:API_KEY".into(), value: "c".into() },
            SecretValue { credential_id: "mcp:b:API_KEY".into(), value: "b".into() },
        ];
        assert!(store_secrets(&store, &secrets).is_err());
        assert_eq!(store.get("mcp:a:API_KEY").as_deref(), Some("old"));
        assert_eq!(store.get("mcp:c:API_KEY"), None);
    }

    const CLAUDE_JSON: &str = r#"{"mcpServers":{
        "local":{"command":"node","args":["s.js","--x"]},
        "hdr":{"type":"http","url":"https://a/mcp","headers":{"X-Api-Key":"v"}},
        "oauth":{"type":"http","url":"https://b/mcp"},
        "old":{"type":"sse","url":"https://c/sse"}}}"#;

    #[test]
    fn summary_of_claude_code_server() {
        let list = list_claude_code(CLAUDE_JSON).unwrap();
        let by = |n: &str| list.iter().find(|s| s.name == n).unwrap().clone();
        assert_eq!((by("local").summary.as_str(), by("local").transport.as_str()), ("node s.js --x", "stdio"));
        assert_eq!((by("hdr").summary.as_str(), by("hdr").transport.as_str()), ("https://a/mcp", "http"));
        assert!(by("oauth").needs_sign_in && !by("hdr").needs_sign_in);
        // One unsupported entry doesn't hide the rest.
        assert!(by("old").unsupported.as_deref().unwrap().contains("SSE"));
        assert_eq!(list.len(), 4);
        assert_eq!(list_claude_code("{}").unwrap(), vec![]);
    }

    #[test]
    fn claude_code_import_copies_picked_servers_and_flags_oauth() {
        let store = MemoryStore::default();
        let got = import_claude_code(&store, CLAUDE_JSON, &["hdr".into(), "oauth".into()], &[]).unwrap();
        assert_eq!(got.len(), 2);
        let hdr = got.iter().find(|s| s.label == "hdr").unwrap();
        assert_eq!(store.get("mcp:hdr:header:X-Api-Key").as_deref(), Some("v"));
        assert!(hdr.enabled && !hdr.needs_sign_in);
        let oauth = got.iter().find(|s| s.label == "oauth").unwrap();
        assert!(oauth.needs_sign_in && !oauth.enabled);
        assert!(import_claude_code(&store, CLAUDE_JSON, &["nope".into()], &[]).is_err());
        assert!(import_claude_code(&store, CLAUDE_JSON, &["old".into()], &[]).unwrap_err().contains("SSE"));
    }

    #[test]
    fn check_result_merges_tools_and_a_failure_keeps_them() {
        let server = McpServer {
            key: "m".into(),
            tools: vec![McpTool { name: "kb_search".into(), full_name: "mcp__m__kb_search".into(), allowed: false }],
            ..Default::default()
        };
        let ok = apply_check(&server, Ok(vec!["mcp__m__kb_search".into(), "mcp__m__delete_note".into()]), 7);
        assert_eq!(ok.tools.len(), 2);
        assert!(!ok.tools[0].allowed, "an earlier switch is kept");
        assert!(!ok.tools[1].allowed, "a write-looking new tool starts off");
        assert_eq!(ok.last_check, Some(McpCheckStatus { ok: true, tool_count: 2, error: None, checked_at_ms: 7 }));

        let failed = apply_check(&ok, Err("The server failed to start.".into()), 9);
        assert_eq!(failed.tools, ok.tools);
        let status = failed.last_check.unwrap();
        assert!(!status.ok && status.error.unwrap().contains("failed"));
    }

    #[test]
    fn secret_ids_cover_env_secrets_and_headers() {
        let server = McpServer {
            key: "a".into(),
            transport: McpTransport::Http { url: "https://h".into(), header_names: vec!["Authorization".into()] },
            env: vec![
                EnvVar { name: "API_KEY".into(), value: None, secret: true },
                EnvVar { name: "MODE".into(), value: Some("ro".into()), secret: false },
            ],
            ..Default::default()
        };
        assert_eq!(secret_ids(&server), vec!["mcp:a:API_KEY".to_string(), "mcp:a:header:Authorization".to_string()]);
    }
}
