//! Launch arguments and process hygiene for the `claude` child process.

use super::CliAgentKind;
use std::path::{Path, PathBuf};

/// Model/effort/system prompt for one session.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionConfig {
    /// Which CLI agent the session is for. The Claude launch args below
    /// ignore it; the spawner dispatches on it.
    pub kind: CliAgentKind,
    pub model: String,
    /// `None` for a model that takes no effort: `--effort` is left out.
    pub effort: Option<String>,
    pub system_prompt: String,
    /// Extended thinking (Claude only). Off sets [`DISABLE_THINKING_ENV`] on
    /// the process: the first words then come far sooner (Haiku thinks on
    /// every turn).
    pub thinking: bool,
    /// Personal sources for a with-sources session; `None` for the plain one.
    pub sources: Option<SourcesLaunch>,
    /// Per-call tool approval: only a workspace chat session has it (see
    /// `approval.rs`). `None` keeps every other session exactly as it was.
    pub approvals: Option<super::approval::ChatApprovals>,
}

/// Built-in tools a with-sources session gets when a notes folder is enabled.
pub const SOURCES_BUILTIN_TOOLS: &str = "Read,Grep,Glob";

/// What a with-sources session adds to the plain launch: notes folders, the
/// MCP servers and which of their tools are allowed.
#[derive(Clone, PartialEq, Default)]
pub struct SourcesLaunch {
    /// One `--add-dir` per folder, each one argv entry.
    pub add_dirs: Vec<PathBuf>,
    /// The mcp-config file text, with each server's own secret values inline.
    /// Written to a private per-session file and deleted once the session's
    /// `system/init` arrived (or when it closes, if it never did). Never log it
    /// or send it over IPC.
    pub mcp_config_json: Option<String>,
    /// `--allowedTools`: the read-only built-ins and the allowed MCP tools.
    pub allowed_tools: Vec<String>,
    /// `--disallowedTools`: the MCP tools the user switched off.
    pub disallowed_tools: Vec<String>,
    /// `(server key, label)` of each included server, for activity lines.
    pub server_labels: Vec<(String, String)>,
    /// Appended to the system prompt by the caller.
    pub system_prompt_addition: String,
    /// Sources left out at build time, with the reason (missing folder, missing
    /// saved secret).
    pub left_out: Vec<String>,
    /// `MCP_TIMEOUT` (ms) for this session; `None` is [`MCP_STARTUP_TIMEOUT_MS`].
    /// Only a Check sets it: a first `npx`/`uvx` run downloads the server.
    pub mcp_startup_timeout_ms: Option<u32>,
}

impl std::fmt::Debug for SourcesLaunch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let config = self
            .mcp_config_json
            .as_ref()
            .map(|c| format!("<redacted, {} bytes>", c.len()));
        f.debug_struct("SourcesLaunch")
            .field("add_dirs", &self.add_dirs)
            .field("mcp_config_json", &config)
            .field("allowed_tools", &self.allowed_tools)
            .field("disallowed_tools", &self.disallowed_tools)
            .field("server_labels", &self.server_labels)
            .field("system_prompt_addition_len", &self.system_prompt_addition.len())
            .field("left_out", &self.left_out)
            .field("mcp_startup_timeout_ms", &self.mcp_startup_timeout_ms)
            .finish()
    }
}

/// Env var that turns off extended thinking in the `claude` CLI.
pub const DISABLE_THINKING_ENV: &str = "CLAUDE_CODE_DISABLE_THINKING";

/// Env vars removed from the child so a stray API key / provider switch can
/// never override the user's own `claude` login.
pub const STRIPPED_ENV: [&str; 7] = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
];

/// How long the CLI waits for an MCP server to start (`MCP_TIMEOUT`, ms) in a
/// meeting session: `system/init` waits at most this long for a server that
/// does not answer. The Check alone waits longer
/// (`mcp_check::CHECK_MCP_TIMEOUT_MS`).
pub const MCP_STARTUP_TIMEOUT_MS: &str = "20000";
/// How long one MCP tool call may take (`MCP_TOOL_TIMEOUT`, ms). A hung tool
/// ends the call with an error instead of holding the answer for minutes.
pub const MCP_TOOL_TIMEOUT_MS: &str = "20000";
/// Most tokens one MCP tool result may bring (`MAX_MCP_OUTPUT_TOKENS`); a live
/// answer has no use for more, and a huge result is slow to read.
pub const MCP_MAX_OUTPUT_TOKENS: &str = "10000";

/// Exact launch args (never `--bare`). The system prompt travels via file.
///
/// A plain session (`cfg.sources == None`) is `--safe-mode`, no tools, every
/// tool denied. A with-sources session swaps `--safe-mode` for `--restricted`
/// (safe mode drops `--mcp-config` servers and does not confine `Read`; see the
/// table in `sources/mod.rs`) and adds the sources flags. Each value is its own argv entry.
pub fn build_args(
    cfg: &SessionConfig,
    system_prompt_file: &Path,
    mcp_config_file: Option<&Path>,
) -> Vec<String> {
    let s = |x: &str| x.to_string();
    let sources = cfg.sources.as_ref();
    let mut args = vec![
        s("-p"),
        s("--input-format"),
        s("stream-json"),
        s("--output-format"),
        s("stream-json"),
        s("--verbose"),
        s("--include-partial-messages"),
        s(if sources.is_some() { "--restricted" } else { "--safe-mode" }),
        s("--tools"),
        s(match sources {
            Some(src) if !src.add_dirs.is_empty() => SOURCES_BUILTIN_TOOLS,
            _ => "",
        }),
    ];
    match sources {
        None => args.extend([s("--disallowedTools"), s("*")]),
        Some(src) if !src.disallowed_tools.is_empty() => {
            args.push(s("--disallowedTools"));
            args.extend(src.disallowed_tools.iter().cloned());
        }
        Some(_) => {}
    }
    // A workspace chat that can ask hands its prompts to NexQ (`host`: the CLI
    // sends a `can_use_tool` control request); everyone else is never asked.
    let ask = cfg.approvals.as_ref().filter(|a| a.can_ask && sources.is_some());
    args.extend([s("--permission-prompts"), s(if ask.is_some() { "host" } else { "none" }), s("--no-session-persistence")]);
    if let Some(src) = sources {
        // A tool that asks is left out of the allow list: only then does the CLI ask.
        let asks: std::collections::HashSet<String> =
            ask.map(|a| a.policy.ask_tools().into_iter().collect()).unwrap_or_default();
        let allowed: Vec<&String> = src.allowed_tools.iter().filter(|t| !asks.contains(*t)).collect();
        if !allowed.is_empty() {
            args.push(s("--allowedTools"));
            args.extend(allowed.into_iter().cloned());
        }
        args.push(s("--strict-mcp-config"));
        if let Some(file) = mcp_config_file {
            args.extend([s("--mcp-config"), file.to_string_lossy().into_owned()]);
        }
        for dir in &src.add_dirs {
            args.extend([s("--add-dir"), dir.to_string_lossy().into_owned()]);
        }
    }
    args.extend([s("--model"), cfg.model.clone()]);
    if let Some(effort) = &cfg.effort {
        args.extend([s("--effort"), effort.clone()]);
    }
    args.extend([
        s("--system-prompt-file"),
        system_prompt_file.to_string_lossy().into_owned(),
    ]);
    args
}

/// `%LOCALAPPDATA%\NexQ\agent-sandbox`: the empty cwd the agent runs in.
pub fn sandbox_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("NexQ").join("agent-sandbox")
}

/// Apply cwd (created if missing), stripped env and CREATE_NO_WINDOW.
pub fn configure_command(cmd: &mut std::process::Command, sandbox: &Path) {
    if let Err(e) = std::fs::create_dir_all(sandbox) {
        log::warn!("cli_agent: cannot create sandbox dir {}: {e}", sandbox.display());
    }
    cmd.current_dir(sandbox);
    for key in STRIPPED_ENV {
        cmd.env_remove(key);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
}

/// [`configure_command`] plus the session's own env: thinking off sets
/// [`DISABLE_THINKING_ENV`], thinking on removes any inherited value.
pub fn configure_session_command(cmd: &mut std::process::Command, sandbox: &Path, thinking: bool) {
    configure_command(cmd, sandbox);
    if thinking {
        cmd.env_remove(DISABLE_THINKING_ENV);
    } else {
        cmd.env(DISABLE_THINKING_ENV, "1");
    }
}

/// The limits a with-sources session runs its MCP servers under (see the
/// constants above); a plain session has no MCP servers and gets none.
pub fn configure_sources_env(cmd: &mut std::process::Command, startup_timeout_ms: Option<u32>) {
    let startup = startup_timeout_ms.map(|ms| ms.to_string());
    cmd.env("MCP_TIMEOUT", startup.as_deref().unwrap_or(MCP_STARTUP_TIMEOUT_MS))
        .env("MCP_TOOL_TIMEOUT", MCP_TOOL_TIMEOUT_MS)
        .env("MAX_MCP_OUTPUT_TOKENS", MCP_MAX_OUTPUT_TOKENS);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_with_sources_session_limits_its_mcp_servers() {
        let mut cmd = std::process::Command::new("claude.exe");
        configure_sources_env(&mut cmd, None);
        let env = |cmd: &std::process::Command, key: &str| {
            cmd.get_envs().find(|(k, _)| *k == key).and_then(|(_, v)| v.map(|v| v.to_string_lossy().into_owned()))
        };
        assert_eq!(env(&cmd, "MCP_TIMEOUT").as_deref(), Some("20000"));
        // A Check waits longer, for a first download.
        let mut check = std::process::Command::new("claude.exe");
        configure_sources_env(&mut check, Some(60_000));
        assert_eq!(env(&check, "MCP_TIMEOUT").as_deref(), Some("60000"));
        assert_eq!(env(&check, "MCP_TOOL_TIMEOUT").as_deref(), Some("20000"));
        assert_eq!(env(&cmd, "MCP_TOOL_TIMEOUT").as_deref(), Some("20000"));
        assert_eq!(env(&cmd, "MAX_MCP_OUTPUT_TOKENS").as_deref(), Some("10000"));
    }

    fn cfg() -> SessionConfig {
        SessionConfig {
            kind: CliAgentKind::Claude,
            model: "haiku".into(),
            effort: Some("low".into()),
            system_prompt: "sp".into(),
            thinking: true,
            sources: None,
            approvals: None,
        }
    }

    fn env_of(cmd: &std::process::Command, key: &str) -> Option<Option<String>> {
        cmd.get_envs()
            .find(|(k, _)| *k == key)
            .map(|(_, v)| v.map(|v| v.to_string_lossy().into_owned()))
    }

    #[test]
    fn session_env_disables_thinking_iff_off() {
        assert!(!STRIPPED_ENV.contains(&DISABLE_THINKING_ENV));
        let dir = std::env::temp_dir().join("nexq-cli-agent-test-thinking");
        let mut off = std::process::Command::new("claude.exe");
        configure_session_command(&mut off, &dir, false);
        assert_eq!(env_of(&off, DISABLE_THINKING_ENV), Some(Some("1".into())));
        let mut on = std::process::Command::new("claude.exe");
        configure_session_command(&mut on, &dir, true);
        // Removed, so a value inherited from the user's env can't turn it off.
        assert_eq!(env_of(&on, DISABLE_THINKING_ENV), Some(None));
        for cmd in [&off, &on] {
            assert!(STRIPPED_ENV.iter().all(|k| env_of(cmd, k) == Some(None)));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn build_args_exact() {
        let args = build_args(&cfg(), Path::new("C:\\t\\sp.txt"), None);
        let joined = args.join("\u{1}");
        assert_eq!(args[0], "-p");
        for seq in [
            vec!["--input-format", "stream-json"],
            vec!["--output-format", "stream-json"],
            vec!["--tools", ""],
            vec!["--disallowedTools", "*"],
            vec!["--permission-prompts", "none"],
            vec!["--model", "haiku"],
            vec!["--effort", "low"],
            vec!["--system-prompt-file", "C:\\t\\sp.txt"],
        ] {
            assert!(joined.contains(&seq.join("\u{1}")), "missing {seq:?}");
        }
        for flag in ["--verbose", "--include-partial-messages", "--safe-mode", "--no-session-persistence"] {
            assert!(args.iter().any(|a| a == flag), "missing {flag}");
        }
        assert!(!args.iter().any(|a| a == "--bare"));
        let pos = |f: &str| args.iter().position(|a| a == f).unwrap();
        assert!(pos("--model") < pos("--effort") && pos("--effort") < pos("--system-prompt-file"));
    }

    fn sources() -> SourcesLaunch {
        SourcesLaunch {
            add_dirs: vec!["D:\\Vault\\@ObsidianVault\\DePaul notes".into()],
            mcp_config_json: Some("{}".into()),
            allowed_tools: vec!["Read".into(), "Grep".into(), "Glob".into(), "mcp__mira__kb_search".into()],
            disallowed_tools: vec!["mcp__mira__add_task".into()],
            ..Default::default()
        }
    }

    fn after(args: &[String], flag: &str) -> String {
        args[args.iter().position(|a| a == flag).unwrap() + 1].clone()
    }

    #[test]
    fn plain_args_are_unchanged_by_the_sources_field() {
        let args = build_args(&cfg(), Path::new("C:\\t\\sp.txt"), Some(Path::new("C:\\t\\ignored.json")));
        let expected = [
            "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
            "--include-partial-messages", "--safe-mode", "--tools", "", "--disallowedTools", "*",
            "--permission-prompts", "none", "--no-session-persistence", "--model", "haiku",
            "--effort", "low", "--system-prompt-file", "C:\\t\\sp.txt",
        ];
        assert_eq!(args, expected);
    }

    #[test]
    fn sources_args_notes_and_tools() {
        let args = build_args(
            &SessionConfig { sources: Some(sources()), ..cfg() },
            Path::new("C:\\t\\sp.txt"),
            Some(Path::new("C:\\t\\mcp.json")),
        );
        assert_eq!(after(&args, "--tools"), "Read,Grep,Glob");
        // A path with spaces and `@` is a single argv entry.
        assert_eq!(after(&args, "--add-dir"), "D:\\Vault\\@ObsidianVault\\DePaul notes");
        assert_eq!(after(&args, "--mcp-config"), "C:\\t\\mcp.json");
        assert_eq!(after(&args, "--disallowedTools"), "mcp__mira__add_task");
        assert_eq!(after(&args, "--allowedTools"), "Read");
        assert!(args.iter().any(|a| a == "--restricted"));
        assert!(!args.iter().any(|a| a == "--safe-mode"));
        assert!(args.iter().any(|a| a == "--strict-mcp-config"));
        assert!(args.iter().any(|a| a == "--permission-prompts") && args.iter().any(|a| a == "--no-session-persistence"));
        assert!(args.iter().any(|a| a == "mcp__mira__kb_search") && args.iter().any(|a| a == "mcp__mira__add_task"));
        assert!(!args.iter().any(|a| a == "*" || a == "--bare" || a.contains("dangerously") || a.contains("bypass")));
        let pos = |f: &str| args.iter().position(|a| a == f).unwrap();
        assert!(pos("--no-session-persistence") < pos("--allowedTools"));
        assert!(pos("--add-dir") < pos("--model") && pos("--model") < pos("--system-prompt-file"));
    }

    #[test]
    fn sources_args_tools_only_keeps_builtins_off() {
        let src = SourcesLaunch {
            add_dirs: vec![],
            allowed_tools: vec!["mcp__mira__kb_search".into()],
            disallowed_tools: vec![],
            ..sources()
        };
        let args = build_args(&SessionConfig { sources: Some(src), ..cfg() }, Path::new("C:\\t\\sp.txt"), Some(Path::new("C:\\t\\mcp.json")));
        assert_eq!(after(&args, "--tools"), "");
        assert!(!args.iter().any(|a| a == "--add-dir"));
        // Nothing switched off: no deny list, and never `*`.
        assert!(!args.iter().any(|a| a == "--disallowedTools" || a == "*"));
    }

    #[test]
    fn sources_args_notes_only_has_no_mcp_config() {
        let src = SourcesLaunch { mcp_config_json: None, disallowed_tools: vec![], ..sources() };
        let args = build_args(&SessionConfig { sources: Some(src), ..cfg() }, Path::new("C:\\t\\sp.txt"), None);
        assert!(!args.iter().any(|a| a == "--mcp-config"));
        // Still strict, so no other MCP server loads.
        assert!(args.iter().any(|a| a == "--strict-mcp-config"));
    }

    #[test]
    fn each_folder_gets_its_own_add_dir() {
        let src = SourcesLaunch { add_dirs: vec!["D:\\a b".into(), "E:\\c".into()], ..sources() };
        let args = build_args(&SessionConfig { sources: Some(src), ..cfg() }, Path::new("C:\\t\\sp.txt"), None);
        let dirs: Vec<&String> = args.windows(2).filter(|w| w[0] == "--add-dir").map(|w| &w[1]).collect();
        assert_eq!(dirs, ["D:\\a b", "E:\\c"]);
    }

    #[test]
    fn sources_launch_debug_redacts_secrets() {
        let src = SourcesLaunch {
            mcp_config_json: Some(r#"{"mcpServers":{"a":{"env":{"API_KEY":"sk-live-123"}}}}"#.into()),
            ..Default::default()
        };
        let shown = format!("{src:?}");
        assert!(shown.contains("redacted") && !shown.contains("sk-live-123"), "{shown}");
        let cfg = SessionConfig { sources: Some(src), ..cfg() };
        assert!(!format!("{cfg:?}").contains("sk-live-123"));
    }

    #[test]
    fn build_args_omits_effort_when_unsupported() {
        let no_effort = SessionConfig { effort: None, ..cfg() };
        let args = build_args(&no_effort, Path::new("C:\\t\\sp.txt"), None);
        assert!(!args.iter().any(|a| a == "--effort"), "{args:?}");
        assert!(args.windows(2).any(|w| w[0] == "--model" && w[1] == "haiku"));
        assert!(args.iter().any(|a| a == "--system-prompt-file"));
    }

    #[test]
    fn configure_command_strips_env() {
        std::env::set_var("ANTHROPIC_API_KEY", "sk-test");
        let dir = std::env::temp_dir().join("nexq-cli-agent-test-sandbox");
        let mut cmd = std::process::Command::new("claude.exe");
        configure_command(&mut cmd, &dir);
        for key in STRIPPED_ENV {
            assert!(
                cmd.get_envs().any(|(k, v)| k == key && v.is_none()),
                "{key} not stripped"
            );
        }
        assert_eq!(cmd.get_current_dir(), Some(dir.as_path()));
        assert!(dir.is_dir());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_a_chat_that_can_ask_launches_with_host_prompts_and_its_asking_tools_left_out_of_the_allow_list() {
        use crate::llm::cli_agent::approval::{ApprovalPolicy, ChatApprovals, WorkspaceApprovals};
        use crate::sources::config::{McpServer, McpTool};
        let tool = |n: &str, ro: Option<bool>| McpTool {
            name: n.into(),
            full_name: format!("mcp__m__{n}"),
            allowed: true,
            read_only_hint: ro,
            destructive_hint: None,
        };
        let policy = ApprovalPolicy::from_servers(
            &[McpServer { key: "m".into(), tools: vec![tool("kb_search", Some(true)), tool("send_mail", None)], ..Default::default() }],
            vec![],
        );
        let src = SourcesLaunch {
            add_dirs: vec!["C:\\t".into()],
            allowed_tools: vec!["mcp__m__kb_search".into(), "mcp__m__send_mail".into(), "Read".into()],
            ..Default::default()
        };
        let value_of = |args: &[String], flag: &str| args.iter().position(|a| a == flag).map(|i| args[i + 1].clone());
        let approvals = |can_ask| ChatApprovals {
            can_ask,
            chat_id: "c".into(),
            broker: std::sync::Arc::new(WorkspaceApprovals::new()),
            policy: std::sync::Arc::new(policy.clone()),
        };
        let build = |a: Option<ChatApprovals>| {
            build_args(&SessionConfig { sources: Some(src.clone()), approvals: a, ..cfg() }, Path::new("sp.txt"), None)
        };

        let asking = build(Some(approvals(true)));
        assert_eq!(value_of(&asking, "--permission-prompts").as_deref(), Some("host"));
        let at = asking.iter().position(|a| a == "--allowedTools").unwrap();
        assert!(asking[at + 1..].contains(&"mcp__m__kb_search".to_string()) && asking[at + 1..].contains(&"Read".to_string()));
        assert!(!asking.contains(&"mcp__m__send_mail".to_string()), "a tool that asks must not be pre-allowed");

        // Everyone else: exactly as before.
        for other in [build(None), build(Some(approvals(false)))] {
            assert_eq!(value_of(&other, "--permission-prompts").as_deref(), Some("none"));
            assert!(other.contains(&"mcp__m__send_mail".to_string()));
        }
        // A plain session (no sources) never asks, whatever it is given.
        let plain = build_args(&SessionConfig { approvals: Some(approvals(true)), ..cfg() }, Path::new("sp.txt"), None);
        assert_eq!(value_of(&plain, "--permission-prompts").as_deref(), Some("none"));
    }
}
