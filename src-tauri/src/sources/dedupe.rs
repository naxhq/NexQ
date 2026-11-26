//! One server (and one notes folder) exists once in Settings; workspaces only
//! link to it. What counts as "the same" lives here, for adding (a new server
//! that matches a saved one is not created) and for the one-time repair of
//! duplicates an older version let through.
//!
//! Identity is deliberately strict: two servers are the same only when they
//! start the same thing the same way. Anything that differs (an env value, a
//! secret's name, a header) keeps both.

use std::collections::HashMap;

use super::config::{McpServer, McpTransport, NotesFolder, PersonalSourcesConfig};
use super::mcp_json::{credential_id, header_credential_id};

/// A path as text, compared on Windows: slashes unified, no trailing slash,
/// case folded.
pub fn normalize_path_text(text: &str) -> String {
    let unified = text.trim().replace('\\', "/");
    unified.trim_end_matches('/').to_lowercase()
}

/// Does this argument or value look like a file path? (A URL does not: its
/// case may matter.)
fn looks_like_path(text: &str) -> bool {
    let t = text.trim();
    if t.contains("://") {
        return false;
    }
    let drive = {
        let mut chars = t.chars();
        matches!((chars.next(), chars.next()), (Some(c), Some(':')) if c.is_ascii_alphabetic())
    };
    drive || t.contains('/') || t.contains('\\')
}

/// An argument or environment value: a path is compared as a path, anything
/// else exactly.
fn normalize_value(text: &str) -> String {
    if looks_like_path(text) {
        normalize_path_text(text)
    } else {
        text.trim().to_string()
    }
}

/// An http(s) address: scheme and host are not case sensitive, a trailing
/// slash is nothing.
fn normalize_url(url: &str) -> String {
    let u = url.trim();
    match u.split_once("://") {
        Some((scheme, rest)) => {
            let (host, path) = match rest.find('/') {
                Some(i) => (&rest[..i], &rest[i..]),
                None => (rest, ""),
            };
            format!("{}://{}{}", scheme.to_lowercase(), host.to_lowercase(), path.trim_end_matches('/'))
        }
        None => u.trim_end_matches('/').to_lowercase(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum Launch {
    Stdio { command: String, args: Vec<String> },
    Http { url: String },
}

/// Everything that makes a server "that server": where it starts, its plain
/// environment (names compared like Windows does, values as text or paths),
/// and which secrets and headers it takes (by name; the values are never here).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ServerIdentity {
    launch: Launch,
    plain_env: Vec<(String, String)>,
    secret_names: Vec<String>,
    header_names: Vec<String>,
}

impl McpServer {
    /// `None` when there is nothing to compare (no command, no URL): such a
    /// server is never merged with another.
    pub fn identity(&self) -> Option<ServerIdentity> {
        let mut header_names: Vec<String> = Vec::new();
        let launch = match &self.transport {
            McpTransport::Stdio { command, args } => {
                if command.trim().is_empty() {
                    return None;
                }
                Launch::Stdio { command: normalize_path_text(command), args: args.iter().map(|a| normalize_value(a)).collect() }
            }
            McpTransport::Http { url, header_names: names } => {
                if url.trim().is_empty() {
                    return None;
                }
                header_names = names.iter().map(|h| h.trim().to_ascii_uppercase()).collect();
                Launch::Http { url: normalize_url(url) }
            }
        };
        let mut plain_env: Vec<(String, String)> = self
            .env
            .iter()
            .filter(|v| !v.secret)
            .map(|v| (v.name.trim().to_ascii_uppercase(), normalize_value(v.value.as_deref().unwrap_or_default())))
            .collect();
        let mut secret_names: Vec<String> =
            self.env.iter().filter(|v| v.secret).map(|v| v.name.trim().to_ascii_uppercase()).collect();
        plain_env.sort();
        secret_names.sort();
        header_names.sort();
        Some(ServerIdentity { launch, plain_env, secret_names, header_names })
    }
}

/// The server among `known` that `server` duplicates, if any.
pub fn find_duplicate<'a>(server: &McpServer, known: &'a [McpServer]) -> Option<&'a McpServer> {
    let identity = server.identity()?;
    known.iter().find(|k| k.id != server.id && k.identity().as_ref() == Some(&identity))
}

/// A notes folder's identity: its path as the system compares it.
pub fn folder_identity(path: &str) -> Option<String> {
    let n = normalize_path_text(path);
    (!n.is_empty()).then_some(n)
}

// ── Repair of duplicates already saved ──────────────────────────────────────

/// A secret to carry from a dropped server to the one kept (only when the kept
/// one has no value of its own).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretMove {
    pub from: String,
    pub to: String,
}

/// What a repair of the saved sources decided. Nothing has been changed yet.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SourcesRepair {
    /// The config without the duplicates.
    pub config: PersonalSourcesConfig,
    /// `(dropped id, kept id)` for servers.
    pub server_map: Vec<(String, String)>,
    /// `(dropped id, kept id)` for notes folders.
    pub folder_map: Vec<(String, String)>,
    pub secret_moves: Vec<SecretMove>,
    /// Credential ids of the dropped servers, forgotten once the moves are done.
    pub secret_drops: Vec<String>,
}

impl SourcesRepair {
    pub fn is_empty(&self) -> bool {
        self.server_map.is_empty() && self.folder_map.is_empty()
    }
}

/// Which of two servers to keep: checked OK and on first, then checked OK, then
/// on, then the one with more tools; the earlier one on a tie.
fn keep_rank(s: &McpServer) -> (bool, bool, bool, usize) {
    let ok = s.last_check.as_ref().is_some_and(|c| c.ok);
    (ok && s.enabled, ok, s.enabled, s.tools.len())
}

fn secret_moves(dropped: &McpServer, kept: &McpServer) -> (Vec<SecretMove>, Vec<String>) {
    let mut moves = Vec::new();
    let mut drops = Vec::new();
    for var in dropped.env.iter().filter(|e| e.secret) {
        let from = credential_id(&dropped.key, &var.name);
        if let Some(to_var) = kept.env.iter().find(|e| e.secret && e.name.trim().eq_ignore_ascii_case(var.name.trim())) {
            moves.push(SecretMove { from: from.clone(), to: credential_id(&kept.key, &to_var.name) });
        }
        drops.push(from);
    }
    if let (McpTransport::Http { header_names: from_names, .. }, McpTransport::Http { header_names: to_names, .. }) =
        (&dropped.transport, &kept.transport)
    {
        for name in from_names {
            let from = header_credential_id(&dropped.key, name);
            if let Some(to_name) = to_names.iter().find(|n| n.trim().eq_ignore_ascii_case(name.trim())) {
                moves.push(SecretMove { from: from.clone(), to: header_credential_id(&kept.key, to_name) });
            }
            drops.push(from);
        }
    }
    (moves, drops)
}

/// Groups of equal items (by `identity`) among `items`, each group as indexes
/// in their original order. Only groups of two or more, in first-seen order.
fn groups<T, K: std::hash::Hash + Eq + Clone>(items: &[T], identity: impl Fn(&T) -> Option<K>) -> Vec<Vec<usize>> {
    let mut by: HashMap<K, Vec<usize>> = HashMap::new();
    let mut order: Vec<K> = Vec::new();
    for (i, item) in items.iter().enumerate() {
        if let Some(k) = identity(item) {
            if !by.contains_key(&k) {
                order.push(k.clone());
            }
            by.entry(k).or_default().push(i);
        }
    }
    order.into_iter().filter_map(|k| by.remove(&k)).filter(|g| g.len() > 1).collect()
}

/// Plan the removal of duplicate servers and notes folders from `cfg`. Servers
/// with no id or no comparable launch, and any whose details differ, are never
/// touched. Pure: nothing is changed until the caller applies the plan.
pub fn plan_repair(cfg: &PersonalSourcesConfig) -> SourcesRepair {
    let mut out = SourcesRepair { config: cfg.clone(), ..Default::default() };

    let mut drop_servers: Vec<usize> = Vec::new();
    for group in groups(&cfg.mcp_servers, |s| if s.id.is_empty() { None } else { s.identity() }) {
        let mut keep = group[0];
        for &i in &group[1..] {
            if keep_rank(&cfg.mcp_servers[i]) > keep_rank(&cfg.mcp_servers[keep]) {
                keep = i;
            }
        }
        let kept_id = cfg.mcp_servers[keep].id.clone();
        let mut merged = cfg.mcp_servers[keep].clone();
        for &i in group.iter().filter(|&&i| i != keep) {
            let dropped = &cfg.mcp_servers[i];
            if dropped.id == kept_id {
                continue;
            }
            merged.enabled = merged.enabled || dropped.enabled;
            let (moves, drops) = secret_moves(dropped, &merged);
            out.secret_moves.extend(moves);
            out.secret_drops.extend(drops);
            out.server_map.push((dropped.id.clone(), kept_id.clone()));
            drop_servers.push(i);
        }
        out.config.mcp_servers[keep] = merged;
    }
    let mut at = 0;
    out.config.mcp_servers.retain(|_| {
        let keep = !drop_servers.contains(&at);
        at += 1;
        keep
    });

    let mut drop_folders: Vec<usize> = Vec::new();
    for group in groups(&cfg.notes_folders, |f: &NotesFolder| if f.id.is_empty() { None } else { folder_identity(&f.path) }) {
        // The one that is on, else the first.
        let keep = group.iter().copied().find(|&i| cfg.notes_folders[i].enabled).unwrap_or(group[0]);
        let kept_id = cfg.notes_folders[keep].id.clone();
        let mut merged = cfg.notes_folders[keep].clone();
        for &i in group.iter().filter(|&&i| i != keep) {
            let dropped = &cfg.notes_folders[i];
            if dropped.id == kept_id {
                continue;
            }
            merged.enabled = merged.enabled || dropped.enabled;
            out.folder_map.push((dropped.id.clone(), kept_id.clone()));
            drop_folders.push(i);
        }
        out.config.notes_folders[keep] = merged;
    }
    let mut at = 0;
    out.config.notes_folders.retain(|_| {
        let keep = !drop_folders.contains(&at);
        at += 1;
        keep
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sources::config::{EnvVar, McpCheckStatus, McpTool};

    fn stdio(id: &str, key: &str, command: &str, args: &[&str]) -> McpServer {
        McpServer {
            id: id.into(),
            key: key.into(),
            label: key.into(),
            transport: McpTransport::Stdio { command: command.into(), args: args.iter().map(|a| a.to_string()).collect() },
            ..Default::default()
        }
    }

    fn plain(name: &str, value: &str) -> EnvVar {
        EnvVar { name: name.into(), value: Some(value.into()), secret: false }
    }

    fn secret(name: &str) -> EnvVar {
        EnvVar { name: name.into(), value: None, secret: true }
    }

    fn checked(ok: bool) -> Option<McpCheckStatus> {
        Some(McpCheckStatus { ok, tool_count: 1, error: None, checked_at_ms: 1 })
    }

    #[test]
    fn paths_are_compared_without_case_or_slash_style() {
        let a = stdio("a", "mira", r"C:\Program Files\nodejs\node.exe", &[r"D:\Vault\Mira\index.js", "--port=80"]);
        let b = stdio("b", "mira-2", "c:/program files/NodeJS/node.exe", &["d:/vault/mira/index.js/", "--port=80"]);
        assert_eq!(a.identity(), b.identity());
        assert!(find_duplicate(&b, std::slice::from_ref(&a)).is_some());
    }

    #[test]
    fn other_arguments_and_commands_differ() {
        let base = stdio("a", "k", "node", &["s.js", "--token=AbC"]);
        for other in [
            stdio("b", "k", "node", &["s.js", "--token=abc"]),
            stdio("b", "k", "node", &["s.js"]),
            stdio("b", "k", "node.exe", &["s.js", "--token=AbC"]),
            stdio("b", "k", "node", &["t.js", "--token=AbC"]),
        ] {
            assert_ne!(base.identity(), other.identity(), "{:?}", other.transport);
        }
        // A URL argument keeps its case.
        let u1 = stdio("a", "k", "npx", &["mcp-remote", "https://H.example/Mcp"]);
        let u2 = stdio("b", "k", "npx", &["mcp-remote", "https://H.example/mcp"]);
        assert_ne!(u1.identity(), u2.identity());
    }

    #[test]
    fn environment_counts_but_secret_values_do_not_exist() {
        let mut a = stdio("a", "k", "node", &["s.js"]);
        a.env = vec![plain("Mode", "ro"), secret("API_KEY")];
        let mut same = stdio("b", "k2", "node", &["s.js"]);
        same.env = vec![secret("api_key"), plain("MODE", "ro")];
        assert_eq!(a.identity(), same.identity());
        let mut value = same.clone();
        value.env = vec![secret("api_key"), plain("MODE", "rw")];
        assert_ne!(a.identity(), value.identity(), "a different plain value is another server");
        let mut no_secret = same.clone();
        no_secret.env = vec![plain("MODE", "ro")];
        assert_ne!(a.identity(), no_secret.identity(), "a secret that is missing is another server");
        let mut paths = stdio("c", "k", "node", &["s.js"]);
        paths.env = vec![plain("ROOT", r"D:\Notes\")];
        let mut paths2 = paths.clone();
        paths2.env = vec![plain("root", "d:/notes")];
        assert_eq!(paths.identity(), paths2.identity());
    }

    #[test]
    fn http_servers_compare_by_url_and_header_names() {
        let http = |url: &str, headers: &[&str]| McpServer {
            transport: McpTransport::Http { url: url.into(), header_names: headers.iter().map(|h| h.to_string()).collect() },
            ..Default::default()
        };
        assert_eq!(
            http("HTTPS://Wiki.Example.com/mcp/", &["Authorization"]).identity(),
            http("https://wiki.example.com/mcp", &["authorization"]).identity()
        );
        assert_ne!(
            http("https://wiki.example.com/mcp", &[]).identity(),
            http("https://wiki.example.com/mcp", &["Authorization"]).identity()
        );
        assert_ne!(http("https://wiki.example.com/mcp", &[]).identity(), http("https://wiki.example.com/other", &[]).identity());
        assert_ne!(http("https://a.example.com/Mcp", &[]).identity(), http("https://a.example.com/mcp", &[]).identity(), "a path keeps its case");
    }

    #[test]
    fn a_server_with_nothing_to_compare_never_matches() {
        let empty = stdio("a", "k", "  ", &[]);
        assert!(empty.identity().is_none());
        assert!(find_duplicate(&empty, &[empty.clone()]).is_none());
        assert!(find_duplicate(&stdio("a", "k", "node", &[]), &[stdio("a", "k", "node", &[])]).is_none(), "never itself");
    }

    fn mira(id: &str, key: &str) -> McpServer {
        let mut s = stdio(id, key, r"C:\Program Files\nodejs\node.exe", &[r"D:\x\mira.js"]);
        s.env = vec![secret("API_KEY"), plain("MODE", "ro")];
        s
    }

    #[test]
    fn repair_keeps_the_checked_and_enabled_one_and_merges_the_rest() {
        let mut ok = mira("ok", "mira");
        ok.enabled = true;
        ok.last_check = checked(true);
        ok.tools = vec![McpTool { name: "t".into(), full_name: "mcp__mira__t".into(), allowed: true, ..Default::default() }];
        let mut fresh = mira("fresh", "mira-2");
        fresh.enabled = false;
        let cfg = PersonalSourcesConfig { mcp_servers: vec![fresh, ok.clone()], ..Default::default() };
        let plan = plan_repair(&cfg);
        assert_eq!(plan.server_map, vec![("fresh".to_string(), "ok".to_string())]);
        assert_eq!(plan.config.mcp_servers, vec![ok]);
        assert_eq!(plan.secret_moves, vec![SecretMove { from: "mcp:mira-2:API_KEY".into(), to: "mcp:mira:API_KEY".into() }]);
        assert_eq!(plan.secret_drops, vec!["mcp:mira-2:API_KEY".to_string()]);
    }

    #[test]
    fn repair_switches_the_kept_one_on_when_only_a_dropped_one_was() {
        let mut a = mira("a", "mira");
        a.last_check = checked(true);
        a.enabled = false;
        let mut b = mira("b", "mira-2");
        b.enabled = true;
        let plan = plan_repair(&PersonalSourcesConfig { mcp_servers: vec![a, b], ..Default::default() });
        assert_eq!(plan.server_map, vec![("b".to_string(), "a".to_string())]);
        assert!(plan.config.mcp_servers[0].enabled, "on if any was on");
        assert_eq!(plan.config.mcp_servers.len(), 1);
    }

    #[test]
    fn repair_never_touches_servers_that_differ() {
        let a = mira("a", "mira");
        let mut b = mira("b", "mira-2");
        b.env[1] = plain("MODE", "rw");
        let c = stdio("c", "other", "node", &["x.js"]);
        let cfg = PersonalSourcesConfig { mcp_servers: vec![a, b, c], ..Default::default() };
        let plan = plan_repair(&cfg);
        assert!(plan.is_empty());
        assert_eq!(plan.config, cfg);
    }

    #[test]
    fn repair_is_idempotent() {
        let cfg = PersonalSourcesConfig {
            mcp_servers: vec![mira("a", "mira"), mira("b", "mira-2"), mira("c", "mira-3")],
            notes_folders: vec![
                NotesFolder { id: "f1".into(), label: "A".into(), path: r"D:\Notes".into(), enabled: false },
                NotesFolder { id: "f2".into(), label: "B".into(), path: "d:/notes/".into(), enabled: true },
            ],
            ..Default::default()
        };
        let once = plan_repair(&cfg);
        assert_eq!(once.server_map.len(), 2);
        assert_eq!(once.folder_map, vec![("f1".to_string(), "f2".to_string())], "the enabled folder stays");
        let twice = plan_repair(&once.config);
        assert!(twice.is_empty());
        assert_eq!(twice.config, once.config);
    }

    #[test]
    fn folders_with_the_same_path_merge_and_others_do_not() {
        assert_eq!(folder_identity(r"D:\Notes\"), folder_identity("d:/NOTES"));
        assert_ne!(folder_identity(r"D:\Notes"), folder_identity(r"D:\Notes2"));
        assert_eq!(folder_identity("  "), None);
    }
}
