//! Settings commands for personal sources: notes folders, MCP servers (pasted
//! JSON, a form, Claude Code import), the tool check, saved secrets and
//! opening a note.
//!
//! Secret values (secret env vars, every HTTP header value) go to Credential
//! Manager under `mcp_json::credential_id` / `header_credential_id` and never
//! come back over IPC: a returned `McpServer` holds only names.
//!
//! The webview has no CSP, so anything it sends is untrusted. Backend state
//! (`AppState::personal_sources`, set by `set_personal_sources`) is the source
//! of truth: a server is looked up there by id, keys are derived against the
//! keys saved there, and a stored secret is only ever handed to the server
//! that was saved with it (same command, arguments, URL and plain
//! environment). Change any of those and the secrets must be typed again.

use crate::credentials::CredentialManager;
use crate::llm::cli_agent::mcp_check::list_server_tools;
use crate::sources::config::{
    is_valid_tool_full_name, EnvVar, McpCheckStatus, McpServer, McpTransport, PersonalSourcesConfig,
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
use std::sync::atomic::Ordering;
use tauri::{command, AppHandle, State};

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

/// A saved secret by credential id, for building a session's launch.
pub(crate) fn saved_secret(id: &str) -> Option<String> {
    SystemSecrets::new().get(id)
}

/// A new server starts with no secrets: whatever an earlier server of the same
/// key left under these ids goes before the new values are stored.
fn forget_leftovers(store: &dyn SecretStore, secrets: &[SecretValue]) {
    for secret in secrets {
        store.delete(&secret.credential_id);
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

/// A server key the generated mcp-config and the credential ids can trust:
/// lowercase letters, digits and `-` only (so never `__`, `:` or a path).
pub fn is_valid_key(key: &str) -> bool {
    !key.is_empty() && key.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Everything a stored secret is tied to: where the server starts (command
/// and arguments, or URL), its plain environment, and which secret variables
/// and headers it takes (by name). A changed target must not receive the old
/// secrets, so adding, removing or renaming a secret variable or header counts.
#[derive(Debug, PartialEq)]
struct LaunchTarget {
    transport: McpTransport,
    plain_env: Vec<(String, String)>,
    secret_names: Vec<String>,
    header_names: Vec<String>,
}

fn launch_target(transport: &McpTransport, env: &[EnvVar]) -> LaunchTarget {
    let mut headers: Vec<String> = Vec::new();
    let transport = match transport {
        McpTransport::Http { url, header_names } => {
            headers = header_names.iter().map(|h| h.to_ascii_uppercase()).collect();
            McpTransport::Http { url: url.clone(), header_names: Vec::new() }
        }
        other => other.clone(),
    };
    let mut plain_env: Vec<(String, String)> = env
        .iter()
        .filter(|v| !v.secret)
        .map(|v| (v.name.to_ascii_uppercase(), v.value.clone().unwrap_or_default()))
        .collect();
    let mut secret_names: Vec<String> =
        env.iter().filter(|v| v.secret).map(|v| v.name.to_ascii_uppercase()).collect();
    plain_env.sort();
    secret_names.sort();
    headers.sort();
    LaunchTarget { transport, plain_env, secret_names, header_names: headers }
}

/// Does `new` start somewhere other than the saved `old`?
fn target_changed(old: &McpServer, new_transport: &McpTransport, new_env: &[EnvVar]) -> bool {
    launch_target(&old.transport, &old.env) != launch_target(new_transport, new_env)
}

/// Shown when an edit moved a server and its secrets must be typed again.
const SECRETS_RESET: &str = "Enter the secrets again: the server's command, URL, environment or secret names changed";

/// Most servers kept in `AppState::pending_servers`.
const PENDING_SERVERS_MAX: usize = 32;
/// How long a server the webview has not saved yet keeps its key reserved.
const PENDING_KEY_HOLD: std::time::Duration = std::time::Duration::from_secs(60);

/// The saved server with this id (backend state, never the frontend's copy):
/// one the webview has saved, else one it was just handed and has not saved yet.
fn saved_server(state: &AppState, id: &str) -> Option<McpServer> {
    let saved = state.personal_sources.read().ok()?.mcp_servers.iter().find(|s| s.id == id).cloned();
    saved.or_else(|| state.pending_servers.lock().ok()?.iter().find(|(s, _)| s.id == id).map(|(s, _)| s.clone()))
}

/// Make `server` known to backend state before the webview saves its config,
/// so a Check or an edit finds it. A server already saved is replaced there; a
/// new one waits in `pending_servers`, and reserves its key for a short while.
fn upsert_saved(state: &AppState, server: &McpServer) {
    if let Ok(mut cfg) = state.personal_sources.write() {
        if let Some(slot) = cfg.mcp_servers.iter_mut().find(|s| s.id == server.id) {
            *slot = server.clone();
            return;
        }
    }
    if let Ok(mut pending) = state.pending_servers.lock() {
        pending.retain(|(s, _)| s.id != server.id);
        pending.push((server.clone(), std::time::Instant::now()));
        let excess = pending.len().saturating_sub(PENDING_SERVERS_MAX);
        pending.drain(..excess);
    }
}

/// The webview dropped these servers without saving them: forget them and free
/// their keys.
#[command]
pub fn discard_pending_mcp_servers(ids: Vec<String>, state: State<'_, AppState>) -> Result<(), String> {
    if let Ok(mut pending) = state.pending_servers.lock() {
        pending.retain(|(s, _)| !ids.contains(&s.id));
    }
    Ok(())
}

/// Keys a new server must not take: the saved servers' keys, and those of
/// servers handed to the webview within the last [`PENDING_KEY_HOLD`] (several
/// added together, before any is saved).
fn taken_keys_at(state: &AppState, now: std::time::Instant) -> Vec<String> {
    let mut keys: Vec<String> = state
        .personal_sources
        .read()
        .map(|c| c.mcp_servers.iter().map(|s| s.key.clone()).collect())
        .unwrap_or_default();
    if let Ok(pending) = state.pending_servers.lock() {
        keys.extend(
            pending
                .iter()
                .filter(|(_, at)| now.saturating_duration_since(*at) < PENDING_KEY_HOLD)
                .map(|(s, _)| s.key.clone()),
        );
    }
    keys
}

fn saved_keys(state: &AppState) -> Vec<String> {
    taken_keys_at(state, std::time::Instant::now())
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

/// Which of these environment variable names hold a secret (their values go to
/// Credential Manager, and the form hides them). The one place that decides.
#[command]
pub fn classify_secret_names(names: Vec<String>) -> Vec<bool> {
    names.iter().map(|n| is_secret_name(n.trim())).collect()
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
    forget_leftovers(store, &secrets);
    store_secrets(store, &secrets)?;
    Ok(servers)
}

fn import_json(store: &dyn SecretStore, json: &str, taken_keys: &[String]) -> Result<Vec<McpServer>, String> {
    add_servers(store, parse_mcp_json(json)?, taken_keys)
}

/// Add the servers in pasted `mcpServers` JSON. Secret values are stored in
/// Credential Manager and are not in the returned servers. New keys avoid the
/// keys NexQ has saved (not a list the webview sends).
#[command]
pub fn import_mcp_servers_json(json: String, state: State<'_, AppState>) -> Result<Vec<McpServer>, String> {
    let servers = import_json(&SystemSecrets::new(), &json, &saved_keys(&state))?;
    servers.iter().for_each(|s| upsert_saved(&state, s));
    Ok(servers)
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
    state: State<'_, AppState>,
) -> Result<Vec<McpServer>, String> {
    let text = read_claude_json()?.ok_or("Claude Code's config wasn't found on this PC")?;
    let servers = import_claude_code(&SystemSecrets::new(), &text, &names, &saved_keys(&state))?;
    servers.iter().for_each(|s| upsert_saved(&state, s));
    Ok(servers)
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
    /// Ignored: an edit keeps the saved server's key and a new server's key is
    /// derived from its name. Kept so the form shape stays the same.
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

/// A form turned into a server.
#[derive(Debug)]
struct FormBuild {
    server: McpServer,
    /// The secrets the form typed (blank ones that keep a stored value are not here).
    secrets: Vec<SecretValue>,
    /// The edit moved the server: the old secrets are not kept.
    target_changed: bool,
}

/// Check the form and build the server it describes plus the secrets to store.
/// `old` is the saved server being edited, from backend state: its key stays
/// (the form's own `key` is ignored), and so do its tool switches and on/off
/// state; it counts as unchecked again. `taken_keys` are the saved servers'
/// keys, for a new server's key. `stored` says whether a secret is saved; it
/// is not consulted when the edit changes where the server starts, so every
/// secret must then be typed again.
fn build_form_server(
    form: &McpServerForm,
    taken_keys: &[String],
    old: Option<&McpServer>,
    stored: &dyn Fn(&str) -> bool,
) -> Result<FormBuild, String> {
    let label = form.label.trim();
    if label.is_empty() {
        return Err("Give the server a name".to_string());
    }
    let key = match old {
        Some(old) => old.key.clone(),
        None => unique_key(label, taken_keys),
    };
    if !is_valid_key(&key) {
        return Err("This server's key isn't valid".to_string());
    }

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
    let changed = old.is_some_and(|o| target_changed(o, &transport, &env));
    // Only the server being edited may keep a stored secret: a new server never
    // picks up a leftover one under its key.
    let secrets = form_secrets(&for_secrets, &key, &|id| old.is_some() && !changed && stored(id)).map_err(|e| {
        if changed {
            format!("{SECRETS_RESET} ({e})")
        } else {
            e
        }
    })?;

    let server = McpServer {
        id: old.map(|o| o.id.clone()).unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        key,
        label: label.to_string(),
        transport,
        // A new server starts off, and so does one an edit moved: it is
        // checked (again) first, then switched on.
        enabled: old.is_some_and(|o| o.enabled) && !changed,
        env,
        tools: old.map(|o| o.tools.clone()).unwrap_or_default(),
        last_check: None,
        needs_sign_in: false,
    };
    Ok(FormBuild { server, secrets, target_changed: changed })
}

/// Save a form against the saved server `old` (backend state): store what was
/// typed, then forget the secrets the edit no longer keeps. On any error
/// nothing is changed.
fn save_form(
    store: &dyn SecretStore,
    form: &McpServerForm,
    taken_keys: &[String],
    old: Option<&McpServer>,
) -> Result<McpServer, String> {
    let build = build_form_server(form, taken_keys, old, &|id| store.get(id).is_some())?;
    if old.is_none() {
        forget_leftovers(store, &build.secrets);
    }
    store_secrets(store, &build.secrets)?;
    if let Some(old) = old {
        // After a move every secret was typed again, so what is stale is only
        // what the new form dropped.
        for id in stale_credential_ids(old, &build.server) {
            store.delete(&id);
        }
    }
    Ok(build.server)
}

/// Save the add/edit form: builds the server, stores its secrets in
/// Credential Manager and drops the ones an edit removed. The returned server
/// holds names only. An edit (`form.id`) must name a server NexQ has saved: its
/// key, tool switches and on/off state come from that server. If the edit
/// changes the command, arguments, URL or plain environment, the stored
/// secrets are not kept and must be typed in the form again (the error says
/// so). A new server's key avoids the saved servers' keys.
#[command]
pub fn save_mcp_server_form(
    form: McpServerForm,
    state: State<'_, AppState>,
) -> Result<McpServer, String> {
    let old = match &form.id {
        Some(id) => Some(saved_server(&state, id).ok_or(
            "NexQ doesn't have this server saved yet. Save your sources first, then edit it.",
        )?),
        None => None,
    };
    let server = save_form(&SystemSecrets::new(), &form, &saved_keys(&state), old.as_ref())?;
    upsert_saved(&state, &server);
    // Saved secrets of a server that can run changed: its session must restart.
    if server.enabled && !server.needs_sign_in {
        state.sources_secrets_rev.fetch_add(1, Ordering::SeqCst);
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

/// What a check runs: the server to start and where its secrets come from.
struct CheckPlan {
    server: McpServer,
    /// Secrets typed in the request, by credential id.
    typed: std::collections::HashMap<String, String>,
    /// Saved secrets may be used: the server is the saved one, unchanged.
    use_stored: bool,
}

/// Decide what to check from backend state, never from a server object the
/// webview made up. `saved` is the saved server with the requested id. With no
/// `draft` the saved server is checked with its stored secrets. With a draft
/// (an unsaved or edited form) the draft is checked with the secrets typed in
/// it; stored secrets are used only when the draft starts the same thing as
/// the saved server.
fn plan_check(
    saved: Option<&McpServer>,
    draft: Option<&McpServerForm>,
    taken_keys: &[String],
    stored: &dyn Fn(&str) -> bool,
) -> Result<CheckPlan, String> {
    match draft {
        None => {
            let saved = saved.ok_or("NexQ doesn't have this server saved yet. Save your sources first.")?;
            Ok(CheckPlan { server: saved.clone(), typed: Default::default(), use_stored: true })
        }
        Some(form) => {
            let build = build_form_server(form, taken_keys, saved, stored)?;
            Ok(CheckPlan {
                use_stored: saved.is_some() && !build.target_changed,
                typed: build.secrets.into_iter().map(|s| (s.credential_id, s.value)).collect(),
                server: build.server,
            })
        }
    }
}

/// Where a check looks a secret up: typed values first, then (only when
/// allowed) the saved ones.
fn check_secret(plan: &CheckPlan, store: &dyn SecretStore, id: &str) -> Option<String> {
    plan.typed.get(id).cloned().or_else(|| plan.use_stored.then(|| store.get(id)).flatten())
}

/// Start a server the way a session would and list its tools (up to 60 s).
/// `server_id` names a saved server, found in backend state. `draft` checks an
/// unsaved or edited form instead (with `server_id` set to the server being
/// edited, if any), using the secrets typed in it. Never an `Err` for a server
/// that fails to start: the returned server says so in `last_check`
/// (`ok: false`, with `error`).
#[command]
pub async fn check_mcp_server(
    server_id: Option<String>,
    draft: Option<McpServerForm>,
    state: State<'_, AppState>,
) -> Result<McpServer, String> {
    let saved = match &server_id {
        Some(id) => Some(saved_server(&state, id).ok_or("NexQ doesn't have this server saved yet. Save your sources first.")?),
        None => None,
    };
    let store = SystemSecrets::new();
    let plan = plan_check(saved.as_ref(), draft.as_ref(), &saved_keys(&state), &|id| store.get(id).is_some())?;
    let secret = |id: &str| check_secret(&plan, &store, id);
    let found = list_server_tools(&plan.server, &secret).await;
    Ok(apply_check(&plan.server, found, now_ms()))
}

/// Forget the saved secrets of a saved server that is being removed. The
/// server is found in backend state by id: call this before the removal is
/// saved with `set_personal_sources`.
#[command]
pub fn delete_mcp_secrets(server_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let store = SystemSecrets::new();
    if let Some(server) = saved_server(&state, &server_id) {
        for id in secret_ids(&server) {
            store.delete(&id);
        }
    }
    if let Ok(mut pending) = state.pending_servers.lock() {
        pending.retain(|(s, _)| s.id != server_id);
    }
    Ok(())
}

// ── Saving the sources, restarting sessions ─────────────────────────────────

/// Do the running with-sources sessions have to be restarted for `new`?
/// `applied` is what they were started for. Anything in the launch args or
/// the system prompt counts (see `PersonalSourcesConfig::launch_fingerprint`),
/// a changed label on an enabled folder included; `last_check` and the
/// one-time notice flag do not.
pub fn needs_sources_restart(applied: &PersonalSourcesConfig, new: &PersonalSourcesConfig) -> bool {
    applied.launch_fingerprint() != new.launch_fingerprint()
}

/// The saved secrets of servers that lost them: one missing from `new`, and
/// one that now starts somewhere else than the saved server with its key did
/// (the secrets were saved for the old target only). A server in `pending`
/// (just handed to the webview) is never dropped for being missing: an older
/// config can arrive after it was imported. A change made through
/// `save_mcp_server_form` is already in `old`, so it does not count here.
fn secrets_to_drop(old: &PersonalSourcesConfig, new: &PersonalSourcesConfig, pending: &[McpServer]) -> Vec<String> {
    let mut ids = Vec::new();
    for old_server in &old.mcp_servers {
        let lost = match new.mcp_servers.iter().find(|s| s.key == old_server.key) {
            None => !pending.iter().any(|p| p.id == old_server.id),
            Some(kept) => target_changed(old_server, &kept.transport, &kept.env),
        };
        if lost {
            ids.extend(secret_ids(old_server));
        }
    }
    ids
}

/// What the webview's config must satisfy before it is saved: keys that are
/// safe, unique and not shared by two servers.
fn validate_sources(cfg: &PersonalSourcesConfig) -> Result<(), String> {
    let mut seen: Vec<&str> = Vec::new();
    for server in &cfg.mcp_servers {
        if !is_valid_key(&server.key) {
            return Err(format!("The server \"{}\" has an invalid key", server.label));
        }
        if seen.contains(&server.key.as_str()) {
            return Err(format!("Two servers share the key \"{}\"", server.key));
        }
        seen.push(&server.key);
        if let Some(tool) = server.tools.iter().find(|t| !is_valid_tool_full_name(&server.key, &t.full_name)) {
            return Err(format!(
                "The server \"{}\" has a tool with an invalid name ({})",
                server.label, tool.full_name
            ));
        }
    }
    Ok(())
}

/// Give the backend the sources the user set up. Call it at startup and after
/// every change (the webview owns the saved copy). It becomes the saved
/// config every other command looks servers up in. Saved secrets of a server
/// that was removed, or that now starts something else, are forgotten. When
/// something that goes into a with-sources session changed (or a secret of an
/// enabled server did), the with-sources sessions close, and the live meeting's
/// Fast one starts again in the background; the plain sessions are untouched.
#[command]
pub fn set_personal_sources(
    config: PersonalSourcesConfig,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    validate_sources(&config)?;
    let old = {
        let mut slot = state
            .personal_sources
            .write()
            .map_err(|_| "Couldn't save your sources".to_string())?;
        std::mem::replace(&mut *slot, config.clone())
    };
    let store = SystemSecrets::new();
    let pending: Vec<McpServer> = state
        .pending_servers
        .lock()
        .map(|p| p.iter().map(|(s, _)| s.clone()).collect())
        .unwrap_or_default();
    for id in secrets_to_drop(&old, &config, &pending) {
        store.delete(&id);
    }

    let restart = {
        let rev = state.sources_secrets_rev.load(Ordering::SeqCst);
        let mut applied = state.sources_applied.lock().map_err(|_| "Couldn't save your sources".to_string())?;
        let restart = needs_sources_restart(&applied.0, &config) || (applied.1 != rev && config.has_enabled());
        *applied = (config, rev);
        restart
    };
    if restart {
        crate::commands::meeting_commands::restart_sources_sessions(&app);
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
        let FormBuild { server, secrets, .. } = build_form_server(&form, &["my-mira".into()], None, &|_| false).unwrap();
        assert_eq!(server.key, "my-mira-2");
        assert_eq!(server.label, "My Mira");
        assert!(!server.enabled && server.tools.is_empty() && server.last_check.is_none());
        // A new server arrives off: it is checked, then switched on.
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
        let FormBuild { server, secrets, .. } = build_form_server(&form, &[], None, &|_| false).unwrap();
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
            env: vec![FormPair { name: "API_KEY".into(), value: "typed".into() }],
            headers: vec![],
        };
        let FormBuild { server, secrets, target_changed } =
            build_form_server(&form, &["other".into()], Some(&old), &|id| id == "mcp:mira:API_KEY").unwrap();
        // OLD_TOKEN was dropped: the secret names changed, so API_KEY was typed again.
        assert!(target_changed);
        assert_eq!(secrets.len(), 1);
        assert_eq!((server.key.as_str(), server.id.as_str(), server.enabled), ("mira", "id1", false));
        assert_eq!(server.tools, old.tools);
        assert!(server.last_check.is_none(), "an edited server is unchecked again");
        assert_eq!(stale_credential_ids(&old, &server), vec!["mcp:mira:OLD_TOKEN".to_string()]);
    }

    #[test]
    fn an_edit_that_moves_an_enabled_server_switches_it_off_until_checked() {
        let mut old = saved_mira();
        old.enabled = true;
        let mut form = mira_form("node", None, "typed");
        form.id = Some("id1".into());
        let same = build_form_server(&form, &[], Some(&old), &|_| true).unwrap();
        assert!(same.server.enabled && !same.target_changed);
        let mut moved = form.clone();
        moved.transport = McpTransport::Stdio { command: "other".into(), args: vec![] };
        let moved = build_form_server(&moved, &[], Some(&old), &|_| true).unwrap();
        assert!(moved.target_changed && !moved.server.enabled);
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
        assert!(!hdr.enabled && !hdr.needs_sign_in);
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

    // ── backend state is the source of truth ────────────────────────────────

    fn saved_mira() -> McpServer {
        McpServer {
            id: "id1".into(),
            key: "mira".into(),
            label: "Mira".into(),
            transport: McpTransport::Stdio { command: "node".into(), args: vec!["s.js".into()] },
            enabled: true,
            env: vec![
                EnvVar { name: "API_KEY".into(), value: None, secret: true },
                EnvVar { name: "MODE".into(), value: Some("ro".into()), secret: false },
            ],
            ..Default::default()
        }
    }

    fn mira_form(command: &str, key_claim: Option<&str>, api_key: &str) -> McpServerForm {
        McpServerForm {
            id: Some("id1".into()),
            key: key_claim.map(str::to_string),
            label: "Mira".into(),
            transport: McpTransport::Stdio { command: command.into(), args: vec!["s.js".into()] },
            env: vec![
                FormPair { name: "API_KEY".into(), value: api_key.into() },
                FormPair { name: "MODE".into(), value: "ro".into() },
            ],
            headers: vec![],
        }
    }

    fn store_with_mira_secret() -> MemoryStore {
        let store = MemoryStore::default();
        store.set("mcp:mira:API_KEY", "stored-secret").unwrap();
        store
    }

    #[test]
    fn an_edit_cannot_change_the_key() {
        let old = saved_mira();
        // The form claims another server's key: ignored, the saved key stays.
        let form = mira_form("node", Some("other-server"), "");
        let build = build_form_server(&form, &["mira".into(), "other-server".into()], Some(&old), &|_| true).unwrap();
        assert_eq!(build.server.key, "mira");
        assert_eq!(build.server.id, "id1");
        // A form's id never gives a new server a chosen id either.
        let mut new_form = mira_form("node", Some("mira"), "k");
        new_form.id = None;
        let new = build_form_server(&new_form, &["mira".into()], None, &|_| false).unwrap();
        assert_eq!(new.server.key, "mira-2");
    }

    #[test]
    fn a_new_key_avoids_the_keys_saved_in_the_backend() {
        let mut form = mira_form("node", None, "k");
        form.id = None;
        let saved = vec!["mira".to_string(), "mira-2".to_string()];
        let build = build_form_server(&form, &saved, None, &|_| false).unwrap();
        assert_eq!(build.server.key, "mira-3");
        assert!(is_valid_key(&build.server.key));
        for bad in ["", "A", "a b", "a__b", "a:b", "../x", "ünï"] {
            assert!(!is_valid_key(bad), "{bad}");
        }
        assert!(is_valid_key("my-server-2"));
    }

    #[test]
    fn a_changed_command_clears_the_secrets_and_they_must_be_typed_again() {
        let old = saved_mira();
        let store = store_with_mira_secret();

        // Blank secret on a moved server: refused with a clear message, nothing changed.
        let err = save_form(&store, &mira_form("evil.exe", None, ""), &["mira".into()], Some(&old)).unwrap_err();
        assert!(err.contains("Enter the secrets again"), "{err}");
        assert!(err.contains("API_KEY"), "{err}");
        assert_eq!(store.get("mcp:mira:API_KEY").as_deref(), Some("stored-secret"));

        // Typed again: the new value replaces the old one.
        let saved = save_form(&store, &mira_form("evil.exe", None, "typed"), &["mira".into()], Some(&old)).unwrap();
        assert_eq!(saved.key, "mira");
        assert_eq!(store.get("mcp:mira:API_KEY").as_deref(), Some("typed"));

        // Same command: a blank secret keeps the stored one.
        let store = store_with_mira_secret();
        save_form(&store, &mira_form("node", None, ""), &["mira".into()], Some(&old)).unwrap();
        assert_eq!(store.get("mcp:mira:API_KEY").as_deref(), Some("stored-secret"));
    }

    #[test]
    fn changed_arguments_url_or_plain_environment_also_reset_the_secrets() {
        let old = saved_mira();
        let stored = |_: &str| true;
        let moved = |f: McpServerForm| build_form_server(&f, &[], Some(&old), &stored).unwrap_err();
        let mut args = mira_form("node", None, "");
        args.transport = McpTransport::Stdio { command: "node".into(), args: vec!["evil.js".into()] };
        assert!(moved(args).contains("Enter the secrets again"));
        let mut env = mira_form("node", None, "");
        env.env[1].value = "--require evil.js".into();
        assert!(moved(env).contains("Enter the secrets again"));

        let http = McpServer {
            transport: McpTransport::Http { url: "https://a/mcp".into(), header_names: vec!["Authorization".into()] },
            env: vec![],
            ..saved_mira()
        };
        let http_form = |url: &str, value: &str| McpServerForm {
            id: Some("id1".into()),
            key: None,
            label: "Mira".into(),
            transport: McpTransport::Http { url: url.into(), header_names: vec![] },
            env: vec![],
            headers: vec![FormPair { name: "Authorization".into(), value: value.into() }],
        };
        assert!(build_form_server(&http_form("https://a/mcp", ""), &[], Some(&http), &stored).is_ok());
        let err = build_form_server(&http_form("https://evil/mcp", ""), &[], Some(&http), &stored).unwrap_err();
        assert!(err.contains("Enter the secrets again"), "{err}");
    }

    #[test]
    fn check_with_a_tampered_command_or_url_gets_no_stored_secrets() {
        let saved = saved_mira();
        let store = store_with_mira_secret();
        let stored = |id: &str| store.get(id).is_some();

        // No draft: the saved server, with its stored secrets.
        let plan = plan_check(Some(&saved), None, &["mira".into()], &stored).unwrap();
        assert_eq!(check_secret(&plan, &store, "mcp:mira:API_KEY").as_deref(), Some("stored-secret"));

        // A draft that moved the server and typed nothing: refused before anything starts.
        assert!(plan_check(Some(&saved), Some(&mira_form("evil.exe", None, "")), &["mira".into()], &stored).is_err());

        // A moved draft with a typed secret: only the typed value, never the stored one.
        let plan = plan_check(Some(&saved), Some(&mira_form("evil.exe", None, "typed")), &["mira".into()], &stored).unwrap();
        assert!(!plan.use_stored);
        assert_eq!(check_secret(&plan, &store, "mcp:mira:API_KEY").as_deref(), Some("typed"));
        assert_eq!(check_secret(&plan, &store, "mcp:other:API_KEY"), None);
        assert_eq!(plan.server.transport, McpTransport::Stdio { command: "evil.exe".into(), args: vec!["s.js".into()] });

        // The same draft with a blank secret and an unchanged command may use the stored one.
        let plan = plan_check(Some(&saved), Some(&mira_form("node", None, "")), &["mira".into()], &stored).unwrap();
        assert!(plan.use_stored);
        assert_eq!(check_secret(&plan, &store, "mcp:mira:API_KEY").as_deref(), Some("stored-secret"));

        // A brand-new draft claiming a saved server's key gets a fresh key and no stored secrets.
        let mut fresh = mira_form("node", Some("mira"), "typed");
        fresh.id = None;
        let plan = plan_check(None, Some(&fresh), &["mira".into()], &stored).unwrap();
        assert_eq!(plan.server.key, "mira-2");
        assert_eq!(check_secret(&plan, &store, "mcp:mira:API_KEY"), None, "nothing stored under another key");
        assert_eq!(check_secret(&plan, &store, "mcp:mira-2:API_KEY").as_deref(), Some("typed"));

        // Without a draft the server must be a saved one.
        assert!(plan_check(None, None, &[], &stored).is_err());
    }

    #[test]
    fn secret_names_are_part_of_the_servers_identity() {
        let old = saved_mira();
        let stored = |_: &str| true;
        let moved = |f: McpServerForm| build_form_server(&f, &[], Some(&old), &stored).unwrap_err();

        // Same command, but a new secret variable (blank, "keep what is stored"): refused.
        let mut added = mira_form("node", None, "");
        added.env.push(FormPair { name: "EXTRA_TOKEN".into(), value: "".into() });
        assert!(moved(added).contains("Enter the secrets again"));

        // A secret variable renamed.
        let mut renamed = mira_form("node", None, "");
        renamed.env[0].name = "OTHER_KEY".into();
        assert!(moved(renamed).contains("Enter the secrets again"));

        // A secret variable dropped: nothing left to type, but it counts as a change.
        let mut dropped = mira_form("node", None, "");
        dropped.env.remove(0);
        assert!(build_form_server(&dropped, &[], Some(&old), &stored).unwrap().target_changed);

        // Typing the values again is how it goes through.
        let mut typed = mira_form("node", None, "typed");
        typed.env.push(FormPair { name: "EXTRA_TOKEN".into(), value: "x".into() });
        assert!(build_form_server(&typed, &[], Some(&old), &stored).unwrap().target_changed);

        // A secret moved to a different header, same URL.
        let http = McpServer {
            transport: McpTransport::Http { url: "https://a/mcp".into(), header_names: vec!["Authorization".into()] },
            env: vec![],
            ..saved_mira()
        };
        let form = |header: &str, value: &str| McpServerForm {
            id: Some("id1".into()),
            key: None,
            label: "Mira".into(),
            transport: McpTransport::Http { url: "https://a/mcp".into(), header_names: vec![] },
            env: vec![],
            headers: vec![FormPair { name: header.into(), value: value.into() }],
        };
        assert!(!build_form_server(&form("authorization", ""), &[], Some(&http), &stored).unwrap().target_changed);
        let err = build_form_server(&form("X-Api-Key", ""), &[], Some(&http), &stored).unwrap_err();
        assert!(err.contains("Enter the secrets again"), "{err}");

        // A check of such a draft never reads the stored values.
        let store = store_with_mira_secret();
        let has = |id: &str| store.get(id).is_some();
        let mut draft = mira_form("node", None, "typed");
        draft.env.push(FormPair { name: "EXTRA_TOKEN".into(), value: "x".into() });
        let plan = plan_check(Some(&old), Some(&draft), &["mira".into()], &has).unwrap();
        assert!(!plan.use_stored);
        assert_eq!(check_secret(&plan, &store, "mcp:mira:API_KEY").as_deref(), Some("typed"));
        let mut blank = mira_form("node", None, "");
        blank.env.push(FormPair { name: "EXTRA_TOKEN".into(), value: "".into() });
        assert!(plan_check(Some(&old), Some(&blank), &["mira".into()], &has).is_err());
    }

    // ── saving the sources ──────────────────────────────────────────────────

    #[test]
    fn sources_restart_needed_only_when_fingerprint_changes() {
        let folder_cfg = PersonalSourcesConfig {
            notes_folders: vec![NotesFolder { id: "f".into(), label: "Vault".into(), path: "D:/v".into(), enabled: true }],
            mcp_servers: vec![McpServer {
                tools: vec![McpTool { name: "kb".into(), full_name: "mcp__m__kb".into(), allowed: true }],
                ..saved_mira()
            }],
            ..Default::default()
        };
        let mut renamed = folder_cfg.clone();
        renamed.notes_folders[0].label = "Renamed".into(); // it is in the system prompt
        assert!(needs_sources_restart(&folder_cfg, &renamed));
        let mut checked = folder_cfg.clone();
        checked.mcp_servers[0].last_check =
            Some(McpCheckStatus { ok: true, tool_count: 1, error: None, checked_at_ms: 3 });
        checked.mcp_notice_seen = true;
        assert!(!needs_sources_restart(&folder_cfg, &checked));
        let mut switched = folder_cfg.clone();
        switched.mcp_servers[0].tools[0].allowed = false;
        assert!(needs_sources_restart(&folder_cfg, &switched));
        assert!(!needs_sources_restart(&folder_cfg, &folder_cfg.clone()));
    }

    #[test]
    fn secrets_follow_the_saved_server_they_were_saved_for() {
        let old = PersonalSourcesConfig { mcp_servers: vec![saved_mira()], ..Default::default() };
        // Same server (label and tools may change): nothing dropped.
        let mut same = old.clone();
        same.mcp_servers[0].label = "Mira 2".into();
        assert!(secrets_to_drop(&old, &same, &[]).is_empty());
        // Removed: its secrets go.
        assert_eq!(
            secrets_to_drop(&old, &PersonalSourcesConfig::default(), &[]),
            vec!["mcp:mira:API_KEY".to_string()]
        );
        // Missing from an older push while it is a just-imported (pending) server: they stay.
        assert!(secrets_to_drop(&old, &PersonalSourcesConfig::default(), &[saved_mira()]).is_empty());
        // Pointed somewhere else behind the form's back: its secrets go.
        let mut moved = old.clone();
        moved.mcp_servers[0].transport = McpTransport::Stdio { command: "evil.exe".into(), args: vec![] };
        assert_eq!(secrets_to_drop(&old, &moved, &[]), vec!["mcp:mira:API_KEY".to_string()]);
    }

    #[test]
    fn saved_tools_must_be_this_servers_mcp_names() {
        use crate::sources::config::McpTool;
        let mut cfg = PersonalSourcesConfig { mcp_servers: vec![saved_mira()], ..Default::default() };
        cfg.mcp_servers[0].tools =
            vec![McpTool { name: "kb".into(), full_name: "mcp__mira__kb".into(), allowed: true }];
        assert!(validate_sources(&cfg).is_ok());
        for bad in ["--add-dir", "--add-dir=C:\\Users", "Bash", "mcp__other__kb", "mcp__mira__a b"] {
            cfg.mcp_servers[0].tools[0].full_name = bad.into();
            assert!(validate_sources(&cfg).is_err(), "{bad}");
        }
    }

    #[test]
    fn secret_names_are_classified_here() {
        assert_eq!(
            classify_secret_names(vec!["API_KEY".into(), " token ".into(), "MODE".into(), "".into()]),
            vec![true, true, false, false]
        );
    }

    #[test]
    fn saved_config_keys_must_be_safe_and_unique() {
        let with = |keys: &[&str]| PersonalSourcesConfig {
            mcp_servers: keys.iter().map(|k| McpServer { key: (*k).into(), label: (*k).into(), ..Default::default() }).collect(),
            ..Default::default()
        };
        assert!(validate_sources(&with(&["mira", "wiki-2"])).is_ok());
        assert!(validate_sources(&with(&["mira", "mira"])).is_err());
        assert!(validate_sources(&with(&["Mira"])).is_err());
        assert!(validate_sources(&with(&["a:b"])).is_err());
        assert!(validate_sources(&with(&[""])).is_err());
    }

    #[test]
    fn two_pending_servers_never_share_a_key_and_a_discarded_one_frees_its_key() {
        let state = AppState::new();
        let server = saved_mira();
        upsert_saved(&state, &server);
        assert_eq!(saved_server(&state, "id1").unwrap().label, "Mira");
        // Reserved against the next server added before this one is saved.
        assert_eq!(saved_keys(&state), vec!["mira".to_string()]);
        assert_eq!(unique_key("Mira", &saved_keys(&state)), "mira-2");
        // One the webview never saved stops reserving its key after a while.
        let later = std::time::Instant::now() + PENDING_KEY_HOLD + std::time::Duration::from_secs(1);
        assert!(taken_keys_at(&state, later).is_empty());
        // The webview saves it: now its key is taken for good, and the saved copy is the one used.
        state.personal_sources.write().unwrap().mcp_servers.push(server.clone());
        assert_eq!(taken_keys_at(&state, later), vec!["mira".to_string()]);
        let mut renamed = server.clone();
        renamed.label = "Mira 2".into();
        upsert_saved(&state, &renamed);
        assert_eq!(state.personal_sources.read().unwrap().mcp_servers.len(), 1);
        assert_eq!(saved_server(&state, "id1").unwrap().label, "Mira 2");
        assert!(saved_server(&state, "nope").is_none());
    }

    #[test]
    fn a_new_server_never_picks_up_a_leftover_secret_under_its_key() {
        let store = MemoryStore::default();
        store.set("mcp:mira:API_KEY", "left-by-an-old-server").unwrap();
        let mut form = mira_form("node", None, "");
        form.id = None;
        // Nothing typed: the leftover is not accepted in its place.
        let err = save_form(&store, &form, &[], None).unwrap_err();
        assert!(err.contains("needs a value"), "{err}");
        assert_eq!(store.get("mcp:mira:API_KEY").as_deref(), Some("left-by-an-old-server"));
        // Typed: it replaces the leftover.
        form.env[0].value = "fresh".into();
        save_form(&store, &form, &[], None).unwrap();
        assert_eq!(store.get("mcp:mira:API_KEY").as_deref(), Some("fresh"));
        // An import clears what an earlier server of that key left, too.
        store.set("mcp:imp:API_KEY", "left").unwrap();
        let servers = import_json(&store, r#"{"imp":{"command":"x","env":{"API_KEY":"new"}}}"#, &[]).unwrap();
        assert_eq!(servers[0].key, "imp");
        assert_eq!(store.get("mcp:imp:API_KEY").as_deref(), Some("new"));
    }

    #[test]
    fn pending_servers_are_capped() {
        let state = AppState::new();
        for i in 0..(PENDING_SERVERS_MAX + 5) {
            upsert_saved(&state, &McpServer { id: format!("p{i}"), key: format!("k{i}"), ..Default::default() });
        }
        assert!(saved_server(&state, "p0").is_none());
        assert!(saved_server(&state, &format!("p{}", PENDING_SERVERS_MAX + 4)).is_some());
    }
}
