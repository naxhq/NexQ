//! How `codex app-server` is started: the binary, the exact argv, the child's
//! environment, and what is switched off.
//!
//! The user's `~/.codex/config.toml` must not leak into a meeting. Findings
//! with Codex CLI 0.171.0 (the app-server has no `--ignore-user-config`, and
//! `CODEX_HOME` cannot move because auth lives there):
//!
//! - `-c mcp_servers={}` does nothing: config tables merge, they do not
//!   replace. Each of the user's servers is switched off by name with
//!   `-c mcp_servers.<name>.enabled=false`. The names come from
//!   `codex mcp list --json` (see [`discover_user_mcp_servers`]), because
//!   naming a server that does not exist is a startup error.
//! - Plugins (which bring MCP servers, skills and hooks of their own), apps,
//!   hooks, memories, computer use, browser use, image generation, the image
//!   viewer (reads any local image path without asking) and goals are feature
//!   flags: `--disable <name>`.
//! - **The shell tool** (`exec_command`, and `write_stdin`) is always off:
//!   `--disable shell_tool` removes it from what the model is offered at all
//!   (checked against a mock Responses server: with real models the tool
//!   surface is a JavaScript `exec` whose nested tools lose `exec_command` and
//!   `write_stdin`). The read-only sandbox can read the whole disk and the
//!   approval policy cannot tell a harmless command from a harmful one in
//!   every shell, so NexQ never has commands to judge. The notes folders are
//!   served by NexQ's own MCP server instead (`nexq_notes`, see `notes_mcp`),
//!   added to the thread's config like any other server of NexQ's. If a command
//!   or file change item starts anyway, the session ends (`session.rs`).
//! - `notify=[]` drops the user's notify hook, `skills.include_instructions=false`
//!   keeps the roughly 40 000 characters of skill descriptions out of the prompt.
//!
//! Measured on this machine (user config with four MCP servers and 30 plugins):
//! default `initialize` + `thread/start` took 1.9 to 3.2 s and started 10 MCP
//! servers; with the overrides below 0.25 s to the thread and no server starts.

use super::super::detect::find_on_path;
use super::policy::CodexPolicy;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Everything `CodexSession::spawn` needs.
#[derive(Clone)]
pub struct CodexLaunch {
    /// The native `codex.exe` (or `node` when only the npm script exists).
    pub program: PathBuf,
    /// Args before `app-server` (the script path when `program` is `node`).
    pub prefix_args: Vec<String>,
    /// Working directory: the NexQ agent sandbox (`command::sandbox_dir`).
    pub cwd: PathBuf,
    /// Model slug, e.g. `gpt-6.2-sol`. Empty: the account default.
    pub model: String,
    /// Reasoning effort (`low` .. `max`). `None`: the model's default.
    pub effort: Option<String>,
    /// NexQ's system prompt; replaces Codex's own coding-agent prompt.
    pub system_prompt: String,
    /// Extra `key=value` pairs for `-c`. No secrets: the command line is
    /// visible to other processes (NexQ's MCP servers go in `mcp_servers`).
    pub mcp_overrides: Vec<String>,
    /// NexQ's own MCP servers by key, each a Codex config table
    /// (`{command, args, env, enabled_tools}` or `{url, http_headers, ..}`),
    /// sent in `thread/start`'s `config`, so their secrets never reach the
    /// command line. A key must not collide with a server the user already
    /// has: a collision is merged into the user's entry.
    pub mcp_servers: serde_json::Map<String, serde_json::Value>,
    /// Are there notes folders (served by the `nexq_notes` server in
    /// `mcp_servers`)? Only for the developer message and the start-up check.
    pub has_notes: bool,
    /// Which approval requests are answered yes.
    pub policy: CodexPolicy,
    /// Extra env vars to remove from the child (on top of
    /// [`STRIPPED_ENV`] and the Claude ones in `command::STRIPPED_ENV`).
    pub env_remove: Vec<String>,
    /// The user's own MCP servers to switch off. `None`: ask Codex
    /// (`codex mcp list`, about 1.5 s). A caller that already knows the list
    /// passes it and saves that time.
    pub user_mcp_servers: Option<Vec<String>>,
}

impl std::fmt::Debug for CodexLaunch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CodexLaunch")
            .field("program", &self.program)
            .field("prefix_args", &self.prefix_args)
            .field("cwd", &self.cwd)
            .field("model", &self.model)
            .field("effort", &self.effort)
            .field("system_prompt_len", &self.system_prompt.len())
            .field("mcp_overrides", &self.mcp_overrides)
            // The tables hold the servers' secrets.
            .field("mcp_servers", &format_args!("<redacted, {}>", self.mcp_servers.len()))
            .field("has_notes", &self.has_notes)
            .field("policy", &self.policy)
            .finish()
    }
}

impl CodexLaunch {
    /// The keys of NexQ's own MCP servers (from `mcp_servers` and from
    /// `mcp_servers.<key>.` overrides), each once.
    pub fn server_keys(&self) -> Vec<String> {
        let mut keys = override_server_keys(&self.mcp_overrides);
        for key in self.mcp_servers.keys() {
            if !keys.contains(key) {
                keys.push(key.clone());
            }
        }
        keys
    }

    /// `thread/start`'s `config`: NexQ's own MCP servers, with every fixed
    /// override and disabled feature of the command line repeated. `None`
    /// without any server (the command line's settings then stand alone).
    ///
    /// A thread's config makes Codex read the user's config again, and the
    /// command line's `-c mcp_servers.<name>.enabled=false` and `-c notify=[]`
    /// do not carry over: with NexQ's servers in it, all of the user's own
    /// servers started anyway (seen with Codex 0.171.0: mira, node_repl, pencil
    /// and web_search came up next to `nexq_notes`). So each of `user_servers`
    /// is switched off here as well, and so is everything else the command
    /// line switches off: web search, the notify hook, skill instructions,
    /// history, analytics and the disabled features.
    pub fn thread_config(&self, user_servers: &[String]) -> Option<serde_json::Value> {
        if self.mcp_servers.is_empty() {
            return None;
        }
        let mut servers = self.mcp_servers.clone();
        for name in user_servers {
            servers.entry(name.clone()).or_insert_with(|| serde_json::json!({ "enabled": false }));
        }
        let mut config = fixed_config();
        config.insert("mcp_servers".into(), serde_json::Value::Object(servers));
        Some(serde_json::Value::Object(config))
    }

    /// A launch with the defaults a plain (no sources) session uses.
    pub fn new(program: PathBuf, prefix_args: Vec<String>, cwd: PathBuf, model: String) -> Self {
        CodexLaunch {
            program,
            prefix_args,
            cwd,
            model,
            effort: None,
            system_prompt: String::new(),
            mcp_overrides: Vec::new(),
            mcp_servers: serde_json::Map::new(),
            has_notes: false,
            policy: CodexPolicy::default(),
            env_remove: STRIPPED_ENV.iter().map(|s| s.to_string()).collect(),
            user_mcp_servers: None,
        }
    }
}

/// Env vars removed from every Codex child so a stray key can never turn a
/// subscription session into a paid API call (nor leak to the CLI): OpenAI and
/// Codex keys, plus the Google and Anthropic ones this app strips elsewhere.
pub const STRIPPED_ENV: [&str; 12] = [
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_ORG_ID",
    "OPENAI_PROJECT",
    "CODEX_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "GOOGLE_CLOUD_PROJECT",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
];

/// `--disable <feature>`: features that start things, load the user's
/// extensions or add tools a meeting answer has no use for.
pub const DISABLED_FEATURES: [&str; 11] = [
    // `exec_command` and `write_stdin`: a shell. Never on, with or without notes.
    "shell_tool",
    "plugins",
    "apps",
    "hooks",
    "memories",
    "computer_use",
    "browser_use",
    "image_generation",
    "multi_agent",
    // `view_image` opens any local image path with no approval request.
    "view_image",
    "goals",
];

/// `-c key=value` overrides applied to every session.
pub const FIXED_OVERRIDES: [&str; 5] = [
    // The user's notify hook (an external program run after each turn).
    "notify=[]",
    // The skill list: about 40 000 characters of the user's own skills.
    "skills.include_instructions=false",
    // The model's own web search: a meeting answer comes from the user's sources only.
    "web_search=\"disabled\"",
    // Nothing of a meeting goes into the user's Codex history.
    "history.persistence=\"none\"",
    // Turn-ended hooks and similar stay off even if a plugin sneaks one in.
    "analytics.enabled=false",
];

/// [`FIXED_OVERRIDES`] and [`DISABLED_FEATURES`] as the nested config object
/// `thread/start` takes (`--disable x` is `features.x=false`).
pub(crate) fn fixed_config() -> serde_json::Map<String, serde_json::Value> {
    use serde_json::{json, Map, Value};
    let mut config = Map::new();
    let mut set = |path: &[&str], value: Value| {
        let mut table = &mut config;
        for key in &path[..path.len() - 1] {
            table = table
                .entry(key.to_string())
                .or_insert_with(|| Value::Object(Map::new()))
                .as_object_mut()
                .expect("a table");
        }
        table.insert(path[path.len() - 1].to_string(), value);
    };
    for pair in FIXED_OVERRIDES {
        let (key, value) = pair.split_once('=').expect("key=value");
        let path: Vec<&str> = key.split('.').collect();
        set(&path, serde_json::from_str(value).unwrap_or_else(|_| json!(value)));
    }
    for feature in DISABLED_FEATURES {
        set(&["features", feature], json!(false));
    }
    config
}

/// A TOML key as a dotted-path segment: bare when it can be, else quoted.
pub(crate) fn toml_key(name: &str) -> String {
    if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        name.to_string()
    } else {
        format!("\"{}\"", name.replace('\\', "\\\\").replace('"', "\\\""))
    }
}

/// The server key of a `mcp_servers.<key>.<field>=...` override (bare or quoted).
pub fn override_server_key(pair: &str) -> Option<String> {
    let rest = pair.strip_prefix("mcp_servers.")?;
    if let Some(quoted) = rest.strip_prefix('"') {
        let mut key = String::new();
        let mut chars = quoted.chars();
        while let Some(c) = chars.next() {
            match c {
                '\\' => key.push(chars.next()?),
                '"' => return Some(key),
                c => key.push(c),
            }
        }
        None
    } else {
        let end = rest.find(['.', '='])?;
        Some(rest[..end].to_string())
    }
}

/// The keys of the MCP servers `mcp_overrides` defines, each once, in order.
pub fn override_server_keys(overrides: &[String]) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    for pair in overrides {
        if let Some(key) = override_server_key(pair) {
            if !keys.contains(&key) {
                keys.push(key);
            }
        }
    }
    keys
}

/// The full argv: `prefix_args`, `app-server`, the feature switches, then every
/// `-c` override. `user_servers` are switched off unless NexQ defines a server
/// of the same name itself.
pub fn build_args(launch: &CodexLaunch, user_servers: &[String]) -> Vec<String> {
    let mut args: Vec<String> = launch.prefix_args.clone();
    args.push("app-server".into());
    for feature in DISABLED_FEATURES {
        args.push("--disable".into());
        args.push(feature.into());
    }
    let mut overrides: Vec<String> = FIXED_OVERRIDES.iter().map(|s| s.to_string()).collect();
    let own = launch.server_keys();
    for name in user_servers.iter().filter(|n| !own.contains(n)) {
        overrides.push(format!("mcp_servers.{}.enabled=false", toml_key(name)));
    }
    overrides.extend(launch.mcp_overrides.iter().cloned());
    for pair in overrides {
        args.push("-c".into());
        args.push(pair);
    }
    args
}

/// Apply cwd (created if missing), the stripped environment and CREATE_NO_WINDOW.
pub fn configure_command(cmd: &mut std::process::Command, launch: &CodexLaunch) {
    if let Err(e) = std::fs::create_dir_all(&launch.cwd) {
        log::warn!("codex: cannot create working dir {}: {e}", launch.cwd.display());
    }
    cmd.current_dir(&launch.cwd);
    for key in STRIPPED_ENV
        .iter()
        .copied()
        .chain(super::super::command::STRIPPED_ENV.iter().copied())
        .chain(launch.env_remove.iter().map(String::as_str))
    {
        cmd.env_remove(key);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
}

/// Same as [`configure_command`] for the short one-shot probes (`mcp list`,
/// `login status`, `debug models`) that have no launch.
pub fn configure_probe_command(cmd: &mut std::process::Command) {
    for key in STRIPPED_ENV {
        cmd.env_remove(key);
    }
    cmd.stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
}

/// How long a one-shot probe may take.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

/// Run `program prefix_args... args...` to completion (no window, no stdin,
/// stripped env) and return `(success, stdout, stderr)`. `None` when it cannot
/// start or runs past [`PROBE_TIMEOUT`].
pub async fn run_probe(
    program: &Path,
    prefix_args: &[String],
    args: &[&str],
) -> Option<(bool, String, String)> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(prefix_args).args(args).kill_on_drop(true);
    cmd.stdin(std::process::Stdio::null());
    for key in STRIPPED_ENV {
        cmd.env_remove(key);
    }
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let out = tokio::time::timeout(PROBE_TIMEOUT, cmd.output()).await.ok()?.ok()?;
    Some((
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    ))
}

/// Names of the MCP servers the user's own config defines
/// (`codex mcp list --json`, run with plugins and apps off so their servers
/// are not listed). Fails (`None`) when Codex cannot answer: the caller must
/// not start a session then, or the user's servers would load.
pub async fn discover_user_mcp_servers(program: &Path, prefix_args: &[String]) -> Option<Vec<String>> {
    let (ok, stdout, _) = run_probe(
        program,
        prefix_args,
        &["--disable", "plugins", "--disable", "apps", "mcp", "list", "--json"],
    )
    .await?;
    if !ok {
        return None;
    }
    parse_mcp_list(&stdout)
}

/// Server names out of `codex mcp list --json` (an array of `{name, ...}`; the
/// transport, which may hold secrets, is not read).
pub fn parse_mcp_list(json: &str) -> Option<Vec<String>> {
    let v: serde_json::Value = serde_json::from_str(json.trim()).ok()?;
    let items = v.as_array()?;
    Some(items.iter().filter_map(|i| i.get("name")?.as_str().map(str::to_string)).collect())
}

/// The program and leading args to run for a `codex` found on PATH.
///
/// NexQ never spawns through a shell, and an npm global install is a `.cmd`
/// shim. Next to the shim sits the package; the native `codex.exe` inside its
/// platform package is used when present, otherwise `node` runs the package's
/// `bin/codex.js`.
pub fn resolve_program(shim_or_exe: &Path) -> Option<(PathBuf, Vec<String>)> {
    let is_cmd = shim_or_exe
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("ps1"))
        .unwrap_or(false);
    if !is_cmd {
        // Only a real executable: npm also drops an extensionless shell script
        // next to the .cmd shim, which CreateProcess cannot run.
        let is_exe = shim_or_exe.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("exe"));
        return (is_exe && shim_or_exe.is_file()).then(|| (shim_or_exe.to_path_buf(), Vec::new()));
    }
    let package = shim_or_exe.parent()?.join("node_modules").join("@openai").join("codex");
    if !package.is_dir() {
        return None;
    }
    let (platform, triple) = if cfg!(target_arch = "aarch64") {
        ("codex-win32-arm64", "aarch64-pc-windows-msvc")
    } else {
        ("codex-win32-x64", "x86_64-pc-windows-msvc")
    };
    let native = package
        .join("node_modules")
        .join("@openai")
        .join(platform)
        .join("vendor")
        .join(triple)
        .join("bin")
        .join("codex.exe");
    if native.is_file() {
        return Some((native, Vec::new()));
    }
    let script = package.join("bin").join("codex.js");
    if script.is_file() {
        let node = shim_or_exe.parent()?.join("node.exe");
        let node = if node.is_file() { node } else { PathBuf::from("node") };
        return Some((node, vec![script.to_string_lossy().into_owned()]));
    }
    None
}

/// The first `codex` on PATH that NexQ can spawn.
pub fn find_codex() -> Option<(PathBuf, Vec<String>)> {
    find_on_path("codex").iter().find_map(|p| resolve_program(p))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn launch() -> CodexLaunch {
        CodexLaunch::new(PathBuf::from("codex.exe"), vec![], PathBuf::from("C:\\sandbox"), "gpt-6.2-sol".into())
    }

    #[test]
    fn args_start_the_app_server_and_switch_off_the_users_extensions() {
        let args = build_args(&launch(), &[]);
        assert_eq!(args[0], "app-server");
        for feature in DISABLED_FEATURES {
            let at = args.iter().position(|a| a == feature).unwrap_or_else(|| panic!("{feature}"));
            assert_eq!(args[at - 1], "--disable");
        }
        for pair in FIXED_OVERRIDES {
            let at = args.iter().position(|a| a == pair).unwrap_or_else(|| panic!("{pair}"));
            assert_eq!(args[at - 1], "-c");
        }
        assert!(args.contains(&"notify=[]".to_string()));
    }

    fn features_disabled(args: &[String]) -> Vec<&str> {
        args.windows(2).filter(|w| w[0] == "--disable").map(|w| w[1].as_str()).collect()
    }

    #[test]
    fn the_shell_tool_is_off_with_or_without_notes() {
        let none = launch();
        let args = build_args(&none, &[]);
        assert!(features_disabled(&args).contains(&"shell_tool"));
        // The image viewer reads any local image without an approval.
        assert!(features_disabled(&args).contains(&"view_image"));
        // Notes (an MCP server) and other servers do not bring it back.
        let mut with = launch();
        with.has_notes = true;
        with.mcp_servers.insert("nexq_notes".into(), serde_json::json!({ "command": "nexq.exe" }));
        with.mcp_servers.insert("mira".into(), serde_json::json!({ "command": "x" }));
        let args = build_args(&with, &["other".to_string()]);
        assert!(features_disabled(&args).contains(&"shell_tool"));
        assert!(features_disabled(&args).contains(&"view_image"));
        assert!(!args.iter().any(|a| a.contains("shell_tool=true") || a.contains("features.shell_tool")), "{args:?}");
    }

    #[test]
    fn servers_with_secrets_go_in_the_thread_config_not_on_the_command_line() {
        let mut l = launch();
        assert_eq!(l.thread_config(&["mira".to_string()]), None);
        l.mcp_servers.insert(
            "mira".into(),
            serde_json::json!({ "command": "node", "args": ["s.js"], "env": { "TOKEN": "s3cret" }, "enabled_tools": ["kb_search"] }),
        );
        let cfg = l.thread_config(&["mira".to_string(), "other".to_string()]).unwrap();
        // The user's servers are switched off in the thread's config too, ours are not.
        assert_eq!(cfg["mcp_servers"]["other"], serde_json::json!({ "enabled": false }));
        assert_eq!(cfg["mcp_servers"]["mira"]["command"], "node");
        assert_eq!(cfg["mcp_servers"]["mira"]["env"]["TOKEN"], "s3cret");
        assert_eq!(cfg["mcp_servers"]["mira"]["enabled_tools"][0], "kb_search");
        let args = build_args(&l, &["mira".to_string(), "other".to_string()]);
        assert!(args.iter().all(|a| !a.contains("s3cret")), "a secret reached argv");
        // The user's own `mira` is not switched off (ours has the same key), `other` is.
        assert!(!args.contains(&"mcp_servers.mira.enabled=false".to_string()));
        assert!(args.contains(&"mcp_servers.other.enabled=false".to_string()));
        assert_eq!(l.server_keys(), ["mira"]);
        assert!(!format!("{l:?}").contains("s3cret"), "Debug leaked a secret");
    }

    #[test]
    fn the_thread_config_repeats_everything_the_command_line_switches_off() {
        let mut l = launch();
        l.mcp_servers.insert("nexq_notes".into(), serde_json::json!({ "command": "nexq", "args": ["--notes-mcp"] }));
        let cfg = l.thread_config(&["mira".to_string()]).unwrap();
        // The values the thread must carry (a thread config re-reads the user's config).
        assert_eq!(cfg["web_search"], "disabled");
        assert_eq!(cfg["notify"], serde_json::json!([]));
        assert_eq!(cfg["skills"]["include_instructions"], false);
        assert_eq!(cfg["history"]["persistence"], "none");
        assert_eq!(cfg["analytics"]["enabled"], false);
        for feature in DISABLED_FEATURES {
            assert_eq!(cfg["features"][feature], false, "{feature}");
        }
        assert_eq!(cfg["mcp_servers"]["mira"], serde_json::json!({ "enabled": false }));
        // Every fixed override of the command line is in there, whatever new one is added.
        for pair in FIXED_OVERRIDES {
            let (key, value) = pair.split_once('=').unwrap();
            let mut at = &cfg;
            for part in key.split('.') {
                at = &at[part];
            }
            assert_eq!(*at, serde_json::from_str::<serde_json::Value>(value).unwrap(), "{pair}");
        }
        // Without servers there is no thread config at all (the command line stands alone).
        assert_eq!(launch().thread_config(&["mira".to_string()]), None);
    }

    #[test]
    fn prefix_args_come_before_app_server() {
        let mut l = launch();
        l.program = PathBuf::from("node.exe");
        l.prefix_args = vec!["C:\\npm\\codex.js".into()];
        let args = build_args(&l, &[]);
        assert_eq!(&args[..2], ["C:\\npm\\codex.js", "app-server"]);
    }

    #[test]
    fn each_user_server_is_switched_off_by_name() {
        let args = build_args(&launch(), &["mira".to_string(), "web search".to_string()]);
        assert!(args.contains(&"mcp_servers.mira.enabled=false".to_string()));
        // A name that is not a bare TOML key is quoted.
        assert!(args.contains(&"mcp_servers.\"web search\".enabled=false".to_string()));
    }

    #[test]
    fn nexqs_own_servers_are_added_and_never_switched_off() {
        let mut l = launch();
        l.mcp_overrides = vec![
            "mcp_servers.nexq-notes.command=\"npx\"".into(),
            "mcp_servers.nexq-notes.args=[\"-y\",\"x\"]".into(),
        ];
        // The user happens to have a server of the same name.
        let args = build_args(&l, &["nexq-notes".to_string(), "mira".to_string()]);
        assert!(!args.contains(&"mcp_servers.nexq-notes.enabled=false".to_string()));
        assert!(args.contains(&"mcp_servers.mira.enabled=false".to_string()));
        assert!(args.contains(&"mcp_servers.nexq-notes.command=\"npx\"".to_string()));
        // Each override is its own `-c` value.
        let at = args.iter().position(|a| a == "mcp_servers.nexq-notes.command=\"npx\"").unwrap();
        assert_eq!(args[at - 1], "-c");
    }

    #[test]
    fn override_keys_are_read_bare_or_quoted() {
        assert_eq!(override_server_key("mcp_servers.mira.command=\"x\"").as_deref(), Some("mira"));
        assert_eq!(override_server_key("mcp_servers.\"a.b\".enabled=true").as_deref(), Some("a.b"));
        assert_eq!(override_server_key("notify=[]"), None);
        let keys = override_server_keys(&[
            "mcp_servers.a.command=\"x\"".into(),
            "mcp_servers.a.args=[]".into(),
            "mcp_servers.b.command=\"y\"".into(),
        ]);
        assert_eq!(keys, ["a", "b"]);
    }

    #[test]
    fn the_child_never_sees_an_api_key() {
        let mut l = launch();
        l.env_remove.push("MY_EXTRA".into());
        let mut cmd = std::process::Command::new("codex.exe");
        cmd.env("OPENAI_API_KEY", "sk-test").env("CODEX_API_KEY", "x").env("MY_EXTRA", "1");
        configure_command(&mut cmd, &l);
        let envs: Vec<_> = cmd.get_envs().collect();
        for key in ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "MY_EXTRA"] {
            let entry = envs.iter().find(|(k, _)| *k == key).unwrap_or_else(|| panic!("{key}"));
            assert!(entry.1.is_none(), "{key} must be removed, not set");
        }
    }

    #[test]
    fn mcp_list_names_are_read_without_the_transport() {
        let json = r#"[{"name":"mira","enabled":true,"transport":{"type":"stdio","command":"x","env":{"TOKEN":"secret"}}},{"name":"node_repl","enabled":false}]"#;
        assert_eq!(parse_mcp_list(json).unwrap(), ["mira", "node_repl"]);
        assert_eq!(parse_mcp_list("[]").unwrap(), Vec::<String>::new());
        assert!(parse_mcp_list("not json").is_none());
    }

    #[test]
    fn a_missing_shim_resolves_to_nothing() {
        assert!(resolve_program(Path::new("C:\\no\\such\\dir\\codex.cmd")).is_none());
        assert!(resolve_program(Path::new("C:\\no\\such\\codex.exe")).is_none());
    }
}
