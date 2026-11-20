//! Personal sources settings: notes folders and MCP servers.
//!
//! Mirrors `PersonalSourcesConfig` in `src/lib/types.ts` field for field.
//! Secret values never live here: a secret env var or header has
//! `value: None` and sits in Credential Manager under
//! `mcp_json::credential_id` / `header_credential_id`.

use serde::{Deserialize, Serialize};

/// Everything the user set up under "Personal sources".
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PersonalSourcesConfig {
    pub notes_folders: Vec<NotesFolder>,
    pub mcp_servers: Vec<McpServer>,
    /// The one-time note about tool permissions was shown.
    pub mcp_notice_seen: bool,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct NotesFolder {
    pub id: String,
    pub label: String,
    pub path: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct McpServer {
    pub id: String,
    /// Fixed at creation: the server's name in the generated mcp-config and in
    /// `mcp__<key>__<tool>`. Only `[a-z0-9-]`, never `__`.
    pub key: String,
    pub label: String,
    pub transport: McpTransport,
    pub enabled: bool,
    pub env: Vec<EnvVar>,
    pub tools: Vec<McpTool>,
    pub last_check: Option<McpCheckStatus>,
    pub needs_sign_in: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum McpTransport {
    Stdio {
        #[serde(default)]
        command: String,
        #[serde(default)]
        args: Vec<String>,
    },
    Http {
        #[serde(default)]
        url: String,
        /// Header names only: every header value is a secret in Credential
        /// Manager.
        #[serde(default)]
        header_names: Vec<String>,
    },
}

impl Default for McpTransport {
    fn default() -> Self {
        McpTransport::Stdio { command: String::new(), args: Vec::new() }
    }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct EnvVar {
    pub name: String,
    /// `None` exactly when `secret`.
    pub value: Option<String>,
    pub secret: bool,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct McpTool {
    /// The server's own tool name, e.g. `kb_search`.
    pub name: String,
    /// `mcp__<key>__<name>`.
    pub full_name: String,
    pub allowed: bool,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct McpCheckStatus {
    pub ok: bool,
    pub tool_count: usize,
    pub error: Option<String>,
    pub checked_at_ms: u64,
}

/// The two overlay pills: which sources this one answer may use.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SourceToggles {
    pub notes: bool,
    pub tools: bool,
}

/// A tool's full name as it may go into `--allowedTools` and
/// `--disallowedTools`: exactly `mcp__<key>__<name>` for this server, with a
/// name of letters, digits, `_` and `-` only. Anything else (an `--add-dir`
/// style string, a bare `Bash`, another server's tool) is not a tool of this
/// server, and never reaches the command line.
pub fn is_valid_tool_full_name(key: &str, full_name: &str) -> bool {
    let Some(name) = full_name.strip_prefix("mcp__").and_then(|r| r.strip_prefix(key)).and_then(|r| r.strip_prefix("__"))
    else {
        return false;
    };
    !key.is_empty()
        && !name.is_empty()
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

impl McpServer {
    /// Tools the user left switched on.
    pub fn allowed_tools(&self) -> impl Iterator<Item = &McpTool> {
        self.tools.iter().filter(|t| t.allowed)
    }
}

impl PersonalSourcesConfig {
    pub fn enabled_folders(&self) -> Vec<&NotesFolder> {
        self.notes_folders.iter().filter(|f| f.enabled).collect()
    }

    /// Enabled, not waiting for a sign-in, with at least one allowed tool.
    pub fn usable_servers(&self) -> Vec<&McpServer> {
        self.mcp_servers
            .iter()
            .filter(|s| s.enabled && !s.needs_sign_in && s.allowed_tools().next().is_some())
            .collect()
    }

    /// Anything a with-sources session could use.
    pub fn has_enabled(&self) -> bool {
        !self.enabled_folders().is_empty() || !self.usable_servers().is_empty()
    }

    /// Stable over everything that changes launch args or the system prompt;
    /// ignores disabled items, `last_check` and `mcp_notice_seen`. Secret
    /// values are not in the config, so a changed secret does not change it.
    pub fn launch_fingerprint(&self) -> String {
        let folders: Vec<_> = self
            .enabled_folders()
            .iter()
            .map(|f| serde_json::json!([f.label, f.path]))
            .collect();
        let servers: Vec<_> = self
            .usable_servers()
            .iter()
            .map(|s| {
                let tools: Vec<_> = s.tools.iter().map(|t| (&t.full_name, t.allowed)).collect();
                serde_json::json!({
                    "key": s.key,
                    "label": s.label,
                    "transport": s.transport,
                    "env": s.env,
                    "tools": tools,
                })
            })
            .collect();
        serde_json::json!({ "folders": folders, "servers": servers }).to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(key: &str, tools: &[(&str, bool)]) -> McpServer {
        McpServer {
            id: key.into(),
            key: key.into(),
            label: key.to_uppercase(),
            enabled: true,
            tools: tools
                .iter()
                .map(|(n, a)| McpTool {
                    name: (*n).into(),
                    full_name: format!("mcp__{key}__{n}"),
                    allowed: *a,
                })
                .collect(),
            ..Default::default()
        }
    }

    fn folder(path: &str, enabled: bool) -> NotesFolder {
        NotesFolder { id: path.into(), label: "Vault".into(), path: path.into(), enabled }
    }

    #[test]
    fn old_or_empty_config_loads_as_defaults() {
        let c: PersonalSourcesConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(c, PersonalSourcesConfig::default());
        let s: McpServer =
            serde_json::from_str(r#"{"id":"a","key":"mira","label":"Mira"}"#).unwrap();
        assert!(!s.enabled && s.tools.is_empty() && s.last_check.is_none());
    }

    #[test]
    fn transport_uses_a_snake_case_type_tag() {
        let t: McpTransport = serde_json::from_str(r#"{"type":"http","url":"https://h/mcp"}"#).unwrap();
        assert_eq!(t, McpTransport::Http { url: "https://h/mcp".into(), header_names: vec![] });
        let s = serde_json::to_string(&McpTransport::Stdio { command: "node".into(), args: vec![] }).unwrap();
        assert!(s.contains(r#""type":"stdio""#), "{s}");
    }

    #[test]
    fn usable_servers_need_enabled_signed_in_and_an_allowed_tool() {
        let mut cfg = PersonalSourcesConfig::default();
        cfg.mcp_servers = vec![
            server("ok", &[("kb_search", true)]),
            McpServer { enabled: false, ..server("off", &[("a", true)]) },
            McpServer { needs_sign_in: true, ..server("auth", &[("a", true)]) },
            server("none", &[("add_task", false)]),
            server("unchecked", &[]),
        ];
        let keys: Vec<_> = cfg.usable_servers().iter().map(|s| s.key.clone()).collect();
        assert_eq!(keys, ["ok"]);
        assert!(cfg.has_enabled());
        assert!(!PersonalSourcesConfig::default().has_enabled());
    }

    #[test]
    fn tool_full_names_must_be_this_servers_mcp_names() {
        for ok in ["mcp__mira__kb_search", "mcp__my-wiki__Get-Note_2"] {
            let key = ok.split("__").nth(1).unwrap();
            assert!(is_valid_tool_full_name(key, ok), "{ok}");
        }
        for bad in [
            "--add-dir",
            r"--add-dir=C:\Users",
            "-x",
            "Bash",
            "mcp__mira__",
            "mcp__mira__a b",
            "mcp__mira__a;b",
            "mcp__mira__a(*)",
            "mcp__mira__../x",
            "mcp__mira__*",
            "mcp__other__kb_search",
            "mcp__mira2__kb_search",
            "mcp__mira__a
b",
            "",
        ] {
            assert!(!is_valid_tool_full_name("mira", bad), "{bad}");
        }
        assert!(!is_valid_tool_full_name("", "mcp____x"));
    }

    #[test]
    fn has_enabled_counts_folders() {
        let mut cfg = PersonalSourcesConfig::default();
        cfg.notes_folders = vec![folder("D:/v", false)];
        assert!(!cfg.has_enabled());
        cfg.notes_folders[0].enabled = true;
        assert!(cfg.has_enabled());
    }

    #[test]
    fn fingerprint_changes_with_launch_inputs_only() {
        let mut cfg = PersonalSourcesConfig::default();
        cfg.notes_folders = vec![folder("D:/v", true), folder("D:/off", false)];
        cfg.mcp_servers = vec![server("m", &[("kb_search", true), ("add_task", false)])];
        let base = cfg.launch_fingerprint();
        assert_eq!(base, cfg.clone().launch_fingerprint());

        let changed = |f: &dyn Fn(&mut PersonalSourcesConfig)| {
            let mut c = cfg.clone();
            f(&mut c);
            c.launch_fingerprint()
        };
        // Launch inputs.
        assert_ne!(base, changed(&|c| c.notes_folders[0].enabled = false));
        assert_ne!(base, changed(&|c| c.notes_folders[1].enabled = true));
        assert_ne!(base, changed(&|c| c.mcp_servers[0].tools[1].allowed = true));
        assert_ne!(base, changed(&|c| c.mcp_servers[0].enabled = false));
        assert_ne!(base, changed(&|c| c.notes_folders[0].path = "D:/other".into()));
        assert_ne!(base, changed(&|c| c.mcp_servers[0].env.push(EnvVar { name: "MODE".into(), value: Some("ro".into()), secret: false })));
        // Not launch inputs.
        assert_eq!(base, changed(&|c| c.notes_folders[1].label = "Renamed".into()));
        assert_eq!(base, changed(&|c| c.mcp_notice_seen = true));
        assert_eq!(
            base,
            changed(&|c| c.mcp_servers[0].last_check =
                Some(McpCheckStatus { ok: true, tool_count: 2, error: None, checked_at_ms: 9 }))
        );
    }
}
