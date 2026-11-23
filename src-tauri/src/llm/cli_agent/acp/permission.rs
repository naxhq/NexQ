//! Answering `session/request_permission`: a pure policy.
//!
//! The AI must never write files, run commands or reach the web through the
//! CLI. It may read and search inside the user's enabled notes folders, and
//! call the MCP tools the user allowed. So a request is allowed only when
//!
//! - its kind is `read` or `search`, it names at least one path, and every path
//!   it names (`locations`, and any path-like field of `rawInput`/`args`) lies
//!   inside an allowed folder, or
//! - the tool is an allowed MCP tool of an enabled server (and not a denied one).
//!
//! Everything else (execute, edit, delete, move, fetch, think, a read with no
//! path, an unknown kind) gets the reject option, or `cancelled` when the agent
//! offered none. Fail closed: a path that cannot be understood is outside.
//!
//! Path rules (all checked without trusting the agent's spelling): `\` and `/`
//! are the same, `.`/`..` are resolved (a `..` above the root is outside),
//! `\\?\`, `file://` URIs (percent-decoded) and Antigravity's `/C:/x` form are
//! understood, a relative path or a `C:x` drive-relative path is outside, so is
//! a name with an alternate data stream (`:`) or a trailing dot or space (Win32
//! ignores those), and on Windows case does not matter. A path that exists must
//! also resolve (symlinks, junctions) to somewhere inside an allowed folder.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// One allowed (or denied) MCP tool: `tool == None` means every tool of `server`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpToolRule {
    /// The server key (the `name` NexQ gave it in `session/new`).
    pub server: String,
    pub tool: Option<String>,
}

impl McpToolRule {
    pub fn tool(server: &str, tool: &str) -> Self {
        Self { server: server.to_string(), tool: Some(tool.to_string()) }
    }

    pub fn whole_server(server: &str) -> Self {
        Self { server: server.to_string(), tool: None }
    }

    /// Does the agent's tool `name` (`mcp_<server>_<tool>`, which
    /// Antigravity uses; `mcp__<server>__<tool>` and
    /// `<server>__<tool>` are accepted too) name a tool this rule covers?
    pub fn matches(&self, name: &str) -> bool {
        let s = &self.server;
        [format!("mcp_{s}_"), format!("mcp__{s}__"), format!("{s}__")]
            .iter()
            .filter_map(|prefix| name.strip_prefix(prefix.as_str()))
            .any(|rest| match &self.tool {
                Some(tool) => rest == tool,
                None => !rest.is_empty(),
            })
    }
}

/// A notes folder in the two spellings the check compares against.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Folder {
    /// Normalized, as configured.
    lexical: String,
    /// Normalized after resolving symlinks (when the folder exists).
    resolved: Option<String>,
}

/// What the agent may touch.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PermissionPolicy {
    folders: Vec<Folder>,
    allow_mcp: Vec<McpToolRule>,
    deny_mcp: Vec<McpToolRule>,
}

impl PermissionPolicy {
    /// `folders`: the enabled notes folders (a relative or unreadable one is
    /// dropped: it can never allow anything). `allow_mcp`/`deny_mcp`: tool
    /// rules; a denied tool is refused even when a rule allows it.
    pub fn new(folders: &[PathBuf], allow_mcp: Vec<McpToolRule>, deny_mcp: Vec<McpToolRule>) -> Self {
        let folders = folders
            .iter()
            .filter_map(|f| {
                let lexical = normalize_path(&f.to_string_lossy())?;
                let resolved = std::fs::canonicalize(f)
                    .ok()
                    .and_then(|c| normalize_path(&c.to_string_lossy()))
                    .map(|n| n.key);
                Some(Folder { lexical: lexical.key, resolved })
            })
            .collect();
        Self { folders, allow_mcp, deny_mcp }
    }

    /// A policy that allows nothing.
    pub fn deny_all() -> Self {
        Self::default()
    }

    fn mcp_allowed(&self, name: &str) -> bool {
        !self.deny_mcp.iter().any(|r| r.matches(name)) && self.allow_mcp.iter().any(|r| r.matches(name))
    }

    /// Is `raw` inside an allowed folder?
    fn path_allowed(&self, raw: &str) -> bool {
        let Some(path) = normalize_path(raw) else { return false };
        let inside_lexical = self.folders.iter().any(|f| is_inside(&path.key, &f.lexical));
        if !inside_lexical {
            return false;
        }
        // An existing path must also resolve to an allowed place: a junction or
        // symlink inside the folder cannot lead out of it. A path that is not
        // there (yet) is judged by its deepest existing parent. A path whose
        // resolution fails for any other reason (no access, a link loop, a name
        // that cannot be resolved) is refused: we cannot tell where it leads.
        let Some(real) = resolve_with(Path::new(&path.fs), &|p| std::fs::canonicalize(p)) else { return false };
        match normalize_path(&real.to_string_lossy()) {
            Some(real) => self.folders.iter().any(|f| {
                is_inside(&real.key, &f.lexical) || f.resolved.as_deref().is_some_and(|r| is_inside(&real.key, r))
            }),
            None => false,
        }
    }
}

/// The real location of `path` through `canonicalize`: the path itself when it
/// exists, else its deepest existing ancestor (a file that does not exist yet
/// is judged by its folder). `None` when resolving fails with anything but
/// "not found": the caller must refuse.
fn resolve_with(
    path: &Path,
    canonicalize: &dyn Fn(&Path) -> std::io::Result<PathBuf>,
) -> Option<PathBuf> {
    let mut current = path;
    loop {
        match canonicalize(current) {
            Ok(real) => return Some(real),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => current = current.parent()?,
            Err(_) => return None,
        }
    }
}

/// A normalized absolute path: `fs` keeps the case (for the file system),
/// `key` is what paths are compared by (lowercase on Windows).
#[derive(Debug, Clone, PartialEq, Eq)]
struct NormPath {
    fs: String,
    key: String,
}

/// See the module docs. `None` for anything that is not a clean absolute path.
fn normalize_path(raw: &str) -> Option<NormPath> {
    let mut s = raw.to_string();
    if s.is_empty() || s.contains('\0') {
        return None;
    }
    if let Some(rest) = s.strip_prefix("file://") {
        // file:///C:/x -> /C:/x ; file://host/share/x -> //host/share/x
        s = percent_decode(rest)?;
        if !s.starts_with('/') {
            s = format!("//{s}");
        }
    }
    s = s.replace('\\', "/");
    if let Some(rest) = s.strip_prefix("//?/UNC/").or_else(|| s.strip_prefix("//?/unc/")) {
        s = format!("//{rest}");
    } else if let Some(rest) = s.strip_prefix("//?/").or_else(|| s.strip_prefix("//./")) {
        s = rest.to_string();
    }
    // `/C:/x` (Antigravity's locations) is `C:/x`.
    let bytes = s.as_bytes();
    if bytes.len() >= 3 && bytes[0] == b'/' && bytes[1].is_ascii_alphabetic() && bytes[2] == b':' {
        s.remove(0);
    }

    let bytes = s.as_bytes();
    let (prefix, rest): (String, &str) = if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        // `C:` must be followed by a separator (or nothing): `C:x` is drive-relative.
        match s[2..].chars().next() {
            None | Some('/') => (s[..2].to_string(), &s[2..]),
            Some(_) => return None,
        }
    } else if let Some(unc) = s.strip_prefix("//") {
        let mut parts = unc.splitn(3, '/');
        let (host, share) = (parts.next()?, parts.next()?);
        if host.is_empty() || share.is_empty() {
            return None;
        }
        (format!("//{host}/{share}"), parts.next().unwrap_or(""))
    } else if s.starts_with('/') {
        (String::new(), s.as_str())
    } else {
        return None; // relative
    };

    let mut parts: Vec<&str> = Vec::new();
    for seg in rest.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop()?; // above the root: outside
            }
            seg => {
                if seg.contains(':') || seg.ends_with('.') || seg.ends_with(' ') {
                    return None;
                }
                parts.push(seg);
            }
        }
    }
    let fs = format!("{prefix}/{}", parts.join("/"));
    let fs = if parts.is_empty() && !prefix.is_empty() { prefix.clone() } else { fs };
    let key = if cfg!(windows) { fs.to_lowercase() } else { fs.clone() };
    Some(NormPath { fs, key })
}

fn is_inside(path: &str, folder: &str) -> bool {
    let folder = folder.trim_end_matches('/');
    path == folder || path.strip_prefix(folder).is_some_and(|rest| rest.starts_with('/'))
}

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

// ---- the request ------------------------------------------------------

/// One option of a permission request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionOption {
    pub id: String,
    /// `allow_once`, `allow_always`, `reject_once`, `reject_always`.
    pub kind: String,
}

/// A parsed `session/request_permission`.
#[derive(Debug, Clone, PartialEq)]
pub struct PermissionRequest {
    /// The agent's tool name (`read_file`, `run_command`, `mcp_srv_tool`, ...).
    pub tool_name: String,
    /// `read`, `search`, `edit`, `execute`, `fetch`, `other`, ... (lowercase).
    pub kind: String,
    /// Every path the call names: `locations[].path`, path-like fields of the
    /// input, and any absolute-looking path value.
    pub paths: Vec<String>,
    pub options: Vec<PermissionOption>,
}

/// Parse the params of `session/request_permission`.
pub fn parse_request(params: &Value) -> PermissionRequest {
    let info = super::protocol::parse_tool_call(&params["toolCall"]);
    let mut paths = info.locations.clone();
    collect_paths(&params["toolCall"]["rawInput"], 0, &mut paths);
    collect_paths(&params["toolCall"]["args"], 0, &mut paths);
    let options = params["options"]
        .as_array()
        .map(|o| {
            o.iter()
                .filter_map(|o| {
                    Some(PermissionOption {
                        id: o["optionId"].as_str()?.to_string(),
                        kind: o["kind"].as_str().unwrap_or_default().to_lowercase(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    PermissionRequest { tool_name: info.name, kind: info.kind, paths, options }
}

const PATH_KEY_PARTS: [&str; 11] = [
    "path", "file", "dir", "folder", "cwd", "uri", "url", "root", "target", "source", "dest",
];

fn path_like_key(key: &str) -> bool {
    let k = key.to_lowercase();
    PATH_KEY_PARTS.iter().any(|p| k.contains(p))
}

/// A value that is plainly an absolute path whatever its key is.
fn absolute_looking(s: &str) -> bool {
    let b = s.as_bytes();
    (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/'))
        || s.starts_with("\\\\")
        || s.starts_with("//")
        || s.starts_with("file://")
        || (b.len() >= 4 && b[0] == b'/' && b[1].is_ascii_alphabetic() && b[2] == b':')
}

fn collect_paths(v: &Value, depth: usize, out: &mut Vec<String>) {
    if depth > 6 {
        return;
    }
    match v {
        Value::Object(map) => {
            for (key, val) in map {
                match val {
                    Value::String(s) if !s.is_empty() && (path_like_key(key) || absolute_looking(s)) => {
                        out.push(s.clone());
                    }
                    Value::Array(items) if path_like_key(key) => {
                        for item in items {
                            match item {
                                Value::String(s) if !s.is_empty() => out.push(s.clone()),
                                other => collect_paths(other, depth + 1, out),
                            }
                        }
                    }
                    other => collect_paths(other, depth + 1, out),
                }
            }
        }
        Value::Array(items) => items.iter().for_each(|i| collect_paths(i, depth + 1, out)),
        _ => {}
    }
}

/// Tool names that reach the web or a browser, refused even when they claim to be
/// a read or a search (Antigravity's `search_web` is kind `search`).
fn reaches_the_web(tool_name: &str) -> bool {
    let n = tool_name.to_lowercase();
    ["web", "fetch", "browser", "http", "url", "internet", "download"].iter().any(|w| n.contains(w))
}

// ---- the decision -----------------------------------------------------

/// What to answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Selected(String),
    Cancelled,
}

impl Outcome {
    /// The JSON-RPC `result` of the permission request.
    pub fn to_result(&self) -> Value {
        match self {
            Outcome::Selected(id) => json!({ "outcome": { "outcome": "selected", "optionId": id } }),
            Outcome::Cancelled => json!({ "outcome": { "outcome": "cancelled" } }),
        }
    }

    pub fn is_allow(&self, req: &PermissionRequest) -> bool {
        match self {
            Outcome::Selected(id) => req.options.iter().any(|o| &o.id == id && o.kind.starts_with("allow")),
            Outcome::Cancelled => false,
        }
    }
}

/// Is the call allowed by `policy` (ignoring which options the agent offered)?
pub fn is_allowed(req: &PermissionRequest, policy: &PermissionPolicy) -> bool {
    if policy.mcp_allowed(&req.tool_name) {
        return true;
    }
    matches!(req.kind.as_str(), "read" | "search")
        && !reaches_the_web(&req.tool_name)
        && !req.paths.is_empty()
        && req.paths.iter().all(|p| policy.path_allowed(p))
}

/// Allow with `allow_once` (never `allow_always`: that would make the agent
/// remember a grant NexQ did not give) when the policy allows the call; every
/// other call gets `reject_once`, else `reject_always`, else `cancelled`.
pub fn decide(req: &PermissionRequest, policy: &PermissionPolicy) -> Outcome {
    let find = |kind: &str| req.options.iter().find(|o| o.kind == kind).map(|o| o.id.clone());
    if is_allowed(req, policy) {
        if let Some(id) = find("allow_once") {
            return Outcome::Selected(id);
        }
    }
    match find("reject_once").or_else(|| find("reject_always")) {
        Some(id) => Outcome::Selected(id),
        None => Outcome::Cancelled,
    }
}

/// [`parse_request`] and [`decide`] in one step.
pub fn decide_params(params: &Value, policy: &PermissionPolicy) -> (PermissionRequest, Outcome) {
    let req = parse_request(params);
    let outcome = decide(&req, policy);
    (req, outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALLOW_DENY: [(&str, &str); 2] = [("allow", "allow_once"), ("deny", "reject_once")];

    fn options(pairs: &[(&str, &str)]) -> Value {
        Value::Array(pairs.iter().map(|(id, kind)| json!({"optionId": id, "name": id, "kind": kind})).collect())
    }

    fn req(kind: &str, name: &str, paths: &[&str], input: Value) -> PermissionRequest {
        let params = json!({
            "sessionId": "s",
            "toolCall": {
                "toolCallId": "c1", "name": name, "kind": kind, "title": name,
                "locations": paths.iter().map(|p| json!({"path": p})).collect::<Vec<_>>(),
                "rawInput": input,
            },
            "options": options(&ALLOW_DENY),
        });
        parse_request(&params)
    }

    /// A temp notes folder with a note and a sibling outside it.
    struct Fixture {
        root: PathBuf,
        notes: PathBuf,
    }

    impl Fixture {
        fn new(name: &str) -> Self {
            let root = std::env::temp_dir().join(format!("nexq-acp-perm-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            let notes = root.join("notes");
            std::fs::create_dir_all(notes.join("sub")).unwrap();
            std::fs::create_dir_all(root.join("secret")).unwrap();
            std::fs::write(notes.join("a.md"), "a").unwrap();
            std::fs::write(root.join("secret").join("s.md"), "s").unwrap();
            // Windows canonical paths carry the `\\?\` prefix; the agent does not send it.
            let plain = |p: PathBuf| {
                PathBuf::from(p.to_string_lossy().trim_start_matches(r"\\?\").to_string())
            };
            Self {
                root: plain(std::fs::canonicalize(&root).unwrap()),
                notes: plain(std::fs::canonicalize(&notes).unwrap()),
            }
        }

        fn policy(&self) -> PermissionPolicy {
            PermissionPolicy::new(std::slice::from_ref(&self.notes), vec![], vec![])
        }

        fn p(&self, rel: &str) -> String {
            self.notes.join(rel).to_string_lossy().into_owned()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn selected(o: &Outcome) -> &str {
        match o {
            Outcome::Selected(id) => id,
            Outcome::Cancelled => "<cancelled>",
        }
    }

    #[test]
    fn read_inside_the_folder_is_allowed() {
        let f = Fixture::new("read");
        let r = req("read", "read_file", &[&f.p("a.md")], json!({"Path": f.p("a.md")}));
        let o = decide(&r, &f.policy());
        assert_eq!(selected(&o), "allow");
        assert!(o.is_allow(&r));
        // A file that does not exist yet (a search hit) and a sub folder: fine.
        let r = req("search", "grep", &[&f.p("sub/new.md")], json!({}));
        assert_eq!(selected(&decide(&r, &f.policy())), "allow");
        let r = req("read", "list_directory", &[&f.p("sub")], json!({"dir_path": f.p("sub")}));
        assert_eq!(selected(&decide(&r, &f.policy())), "allow");
        // The folder itself.
        let r = req("search", "grep", &[&f.notes.to_string_lossy()], json!({}));
        assert_eq!(selected(&decide(&r, &f.policy())), "allow");
    }

    #[test]
    fn execute_edit_and_other_kinds_are_rejected_even_inside_the_folder() {
        let f = Fixture::new("kinds");
        for kind in ["execute", "edit", "delete", "move", "fetch", "think", "other", "switch_mode", "weird", ""] {
            let r = req(kind, "tool", &[&f.p("a.md")], json!({"Path": f.p("a.md")}));
            assert_eq!(selected(&decide(&r, &f.policy())), "deny", "kind {kind:?}");
        }
        // A run_command whose cwd is inside the folder is still a command.
        let r = req("execute", "run_command", &[], json!({"CommandLine": "echo hi > out.txt", "Cwd": f.p("")}));
        assert_eq!(selected(&decide(&r, &f.policy())), "deny");
    }

    #[test]
    fn paths_outside_the_folder_are_rejected() {
        let f = Fixture::new("outside");
        let outside = [
            "C:\\Windows\\win.ini".to_string(),
            "C:/Windows/win.ini".to_string(),
            "/C:/Windows/win.ini".to_string(),
            f.root.join("secret").join("s.md").to_string_lossy().into_owned(),
            // A sibling that merely starts with the folder's name.
            format!("{}-evil\\a.md", f.notes.display()),
            f.root.to_string_lossy().into_owned(),
        ];
        for p in &outside {
            let r = req("read", "read_file", &[p], json!({}));
            assert_eq!(selected(&decide(&r, &f.policy())), "deny", "{p}");
        }
    }

    #[test]
    fn path_traversal_is_rejected() {
        let f = Fixture::new("traversal");
        let secret = "..\\secret\\s.md";
        for p in [
            format!("{}\\{secret}", f.notes.display()),
            format!("{}/../secret/s.md", f.notes.display()),
            format!("{}\\sub\\..\\..\\secret\\s.md", f.notes.display()),
            format!("{}\\..\\..\\..\\..\\..\\..\\..\\..\\Windows\\win.ini", f.notes.display()),
            "..\\..\\Windows\\win.ini".to_string(),
        ] {
            let r = req("read", "read_file", &[&p], json!({}));
            assert_eq!(selected(&decide(&r, &f.policy())), "deny", "{p}");
        }
        // `..` that stays inside is fine, and is normalized.
        let r = req("read", "read_file", &[&format!("{}\\sub\\..\\a.md", f.notes.display())], json!({}));
        assert_eq!(selected(&decide(&r, &f.policy())), "allow");
    }

    #[test]
    fn missing_or_unreadable_paths_are_rejected() {
        let f = Fixture::new("missing");
        let none = req("read", "read_file", &[], json!({}));
        assert_eq!(selected(&decide(&none, &f.policy())), "deny");
        let empty = req("search", "grep", &[], json!({"pattern": "x", "dir_path": ""}));
        assert_eq!(selected(&decide(&empty, &f.policy())), "deny");
        // Web search is kind `search` with no path.
        let web = req("search", "search_web", &[], json!({"query": "x"}));
        assert_eq!(selected(&decide(&web, &f.policy())), "deny");
        // Relative, drive-relative and malformed paths are outside.
        for p in ["a.md", "notes\\a.md", "C:a.md", "~\\notes", "\\\\", "", "http://example.com/x"] {
            let r = req("read", "read_file", &[p], json!({}));
            assert_eq!(selected(&decide(&r, &f.policy())), "deny", "{p:?}");
        }
        // No notes folder at all: nothing is inside.
        let r = req("read", "read_file", &[&f.p("a.md")], json!({}));
        assert_eq!(selected(&decide(&r, &PermissionPolicy::deny_all())), "deny");
        // A relative folder in the settings can never allow anything.
        let rel = PermissionPolicy::new(&[PathBuf::from("notes")], vec![], vec![]);
        assert_eq!(selected(&decide(&r, &rel)), "deny");
    }

    #[test]
    fn every_path_must_be_inside() {
        let f = Fixture::new("every");
        // Inside location, outside in the input.
        let r = req("read", "read_file", &[&f.p("a.md")], json!({"file_path": "C:\\Windows\\win.ini"}));
        assert_eq!(selected(&decide(&r, &f.policy())), "deny");
        // Path hidden under an odd key, a nested object, or an array.
        for input in [
            json!({"Path": "C:\\Windows\\win.ini"}),
            json!({"args": {"nested": {"dir_path": "C:\\Windows"}}}),
            json!({"paths": [f.p("a.md"), "C:\\Windows\\win.ini"]}),
            json!({"pattern": "C:\\Windows\\win.ini"}),
            json!({"uri": "file:///C:/Windows/win.ini"}),
        ] {
            let r = req("read", "read_file", &[&f.p("a.md")], input.clone());
            assert_eq!(selected(&decide(&r, &f.policy())), "deny", "{input}");
        }
        // Both inside: allowed.
        let r = req("read", "read_many_files", &[&f.p("a.md")], json!({"paths": [f.p("a.md"), f.p("sub")]}));
        assert_eq!(selected(&decide(&r, &f.policy())), "allow");
    }

    #[test]
    fn antigravity_and_uri_spellings_are_understood() {
        let f = Fixture::new("spelling");
        let note = f.p("a.md");
        let slash = note.replace('\\', "/");
        for p in [
            format!("/{slash}"),                       // /C:/Users/.../a.md
            slash.clone(),                             // C:/Users/.../a.md
            format!("file:///{}", slash.replace(' ', "%20")), // file:///C:/...
            format!("\\\\?\\{note}"),                  // \\?\C:\...
            note.to_uppercase(),                       // case does not matter on Windows
        ] {
            let r = req("read", "read_file", &[&p], json!({}));
            let expect = if cfg!(windows) || p == note { "allow" } else { "deny" };
            assert_eq!(selected(&decide(&r, &f.policy())), expect, "{p}");
        }
        // Percent-encoded traversal in a URI.
        let r = req("read", "read_file", &[&format!("file:///{slash}/%2e%2e/%2e%2e/secret/s.md")], json!({}));
        assert_eq!(selected(&decide(&r, &f.policy())), "deny");
        // Trailing dots and spaces, and alternate data streams, are not trusted.
        for p in [format!("{note}."), format!("{note} "), format!("{note}:stream"), format!("{}\\sub.\\a.md", f.notes.display())] {
            let r = req("read", "read_file", &[&p], json!({}));
            assert_eq!(selected(&decide(&r, &f.policy())), "deny", "{p}");
        }
    }

    #[test]
    fn web_tools_are_rejected_even_with_a_path() {
        let f = Fixture::new("web");
        for name in ["search_web", "google_web_search", "web_fetch", "browser_open", "fetch_url"] {
            let r = req("search", name, &[&f.p("a.md")], json!({}));
            assert_eq!(selected(&decide(&r, &f.policy())), "deny", "{name}");
        }
    }

    #[test]
    fn mcp_tools_follow_the_allow_and_deny_rules() {
        let policy = PermissionPolicy::new(
            &[],
            vec![McpToolRule::tool("mira", "search_notes"), McpToolRule::whole_server("wiki")],
            vec![McpToolRule::tool("wiki", "delete_page")],
        );
        let mcp = |name: &str| decide(&req("other", name, &[], json!({"q": "x"})), &policy);
        assert_eq!(selected(&mcp("mcp_mira_search_notes")), "allow");
        assert_eq!(selected(&mcp("mcp__mira__search_notes")), "allow");
        assert_eq!(selected(&mcp("mira__search_notes")), "allow");
        assert_eq!(selected(&mcp("mcp_mira_delete_note")), "deny");
        assert_eq!(selected(&mcp("mcp_wiki_get_page")), "allow");
        assert_eq!(selected(&mcp("mcp_wiki_delete_page")), "deny", "denied beats the whole-server allow");
        assert_eq!(selected(&mcp("mcp_other_search_notes")), "deny");
        assert_eq!(selected(&mcp("mcp_mira_")), "deny");
        assert_eq!(selected(&mcp("run_command")), "deny");
        assert_eq!(selected(&mcp("read_file")), "deny");
        // A server key with a hyphen, like the one captured from Antigravity.
        let policy = PermissionPolicy::new(&[], vec![McpToolRule::tool("probe-srv", "get_secret_word")], vec![]);
        let fixture: Value = serde_json::from_str(include_str!("testdata/agy_permission_mcp.json")).unwrap();
        let (r, o) = decide_params(&fixture["params"], &policy);
        assert_eq!(r.tool_name, "mcp_probe-srv_get_secret_word");
        assert_eq!(selected(&o), "allow");
    }

    #[test]
    fn captured_requests() {
        let f = Fixture::new("captured");
        let policy = f.policy();
        let parse = |s: &str| -> Value { serde_json::from_str::<Value>(s).unwrap()["params"].clone() };
        let (r, o) = decide_params(&parse(include_str!("testdata/agy_permission_run_command.json")), &policy);
        assert_eq!((r.kind.as_str(), r.tool_name.as_str()), ("execute", "run_command"));
        assert_eq!(selected(&o), "deny");
        let (r, o) = decide_params(&parse(include_str!("testdata/agy_permission_read_outside.json")), &policy);
        assert_eq!(r.kind, "read");
        assert!(r.paths.iter().any(|p| p.contains("win.ini")));
        assert_eq!(selected(&o), "deny");
    }

    #[test]
    fn options_decide_the_reply() {
        let f = Fixture::new("options");
        let policy = f.policy();
        let with = |kind: &str, pairs: &[(&str, &str)]| {
            let mut r = req(kind, "read_file", &[&f.p("a.md")], json!({}));
            r.options = pairs.iter().map(|(id, k)| PermissionOption { id: id.to_string(), kind: k.to_string() }).collect();
            decide(&r, &policy)
        };
        // allow_once only: never allow_always.
        assert_eq!(with("read", &[("a", "allow_always"), ("b", "allow_once")]), Outcome::Selected("b".into()));
        assert_eq!(with("read", &[("a", "allow_always"), ("r", "reject_once")]), Outcome::Selected("r".into()));
        // Rejecting: reject_once first, reject_always next, else cancelled.
        assert_eq!(with("execute", &[("y", "allow_once"), ("n", "reject_always"), ("m", "reject_once")]), Outcome::Selected("m".into()));
        assert_eq!(with("execute", &[("y", "allow_once"), ("n", "reject_always")]), Outcome::Selected("n".into()));
        assert_eq!(with("execute", &[("y", "allow_once"), ("a", "allow_always")]), Outcome::Cancelled);
        assert_eq!(with("execute", &[]), Outcome::Cancelled);
        // The JSON-RPC result shapes.
        assert_eq!(Outcome::Selected("x".into()).to_result(), json!({"outcome": {"outcome": "selected", "optionId": "x"}}));
        assert_eq!(Outcome::Cancelled.to_result(), json!({"outcome": {"outcome": "cancelled"}}));
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_inside_the_folder_cannot_lead_out() {
        let f = Fixture::new("junction");
        let link = f.notes.join("escape");
        let status = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(f.root.join("secret"))
            .output();
        if !status.map(|o| o.status.success()).unwrap_or(false) {
            eprintln!("cannot create a junction here; skipping");
            return;
        }
        let r = req("read", "read_file", &[&f.p("escape\\s.md")], json!({}));
        assert_eq!(selected(&decide(&r, &f.policy())), "deny");
    }

    #[test]
    fn normalize_handles_roots_and_unc() {
        assert_eq!(normalize_path("C:\\").unwrap().fs, "C:");
        assert_eq!(normalize_path("C:/a/./b//c").unwrap().fs, "C:/a/b/c");
        assert_eq!(normalize_path("/home/x/../y").unwrap().fs, "/home/y");
        assert_eq!(normalize_path("\\\\srv\\share\\a\\..\\b").unwrap().fs, "//srv/share/b");
        assert!(normalize_path("\\\\srv").is_none());
        assert!(normalize_path("C:\\..").is_none());
        assert!(is_inside("c:/notes/a", "c:/notes"));
        assert!(is_inside("c:/notes", "c:/notes"));
        assert!(!is_inside("c:/notes2/a", "c:/notes"));
        assert!(is_inside("c:/x", "c:"));
    }

    #[test]
    fn a_path_that_exists_but_cannot_be_resolved_is_refused() {
        use std::io::{Error, ErrorKind};
        let p = Path::new(r"D:\notes\a.md");
        // Not found: judged by the deepest parent that does resolve.
        let fake = |q: &Path| -> std::io::Result<PathBuf> {
            if q == Path::new(r"D:\notes") {
                Ok(PathBuf::from(r"D:\notes"))
            } else {
                Err(Error::from(ErrorKind::NotFound))
            }
        };
        assert_eq!(resolve_with(p, &fake), Some(PathBuf::from(r"D:\notes")));
        // Any other failure (access denied, a link loop, an unresolvable name): refuse.
        for kind in [ErrorKind::PermissionDenied, ErrorKind::InvalidInput, ErrorKind::Other, ErrorKind::TimedOut] {
            let failing = move |_: &Path| -> std::io::Result<PathBuf> { Err(Error::from(kind)) };
            assert_eq!(resolve_with(p, &failing), None, "{kind:?}");
        }
        // A parent that fails with something other than not-found is refused too.
        let deny_parent = |q: &Path| -> std::io::Result<PathBuf> {
            if q == p { Err(Error::from(ErrorKind::NotFound)) } else { Err(Error::from(ErrorKind::PermissionDenied)) }
        };
        assert_eq!(resolve_with(p, &deny_parent), None);
        // Nothing exists all the way up: refuse.
        let none = |_: &Path| -> std::io::Result<PathBuf> { Err(Error::from(ErrorKind::NotFound)) };
        assert_eq!(resolve_with(p, &none), None);
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_loop_inside_the_folder_is_refused() {
        let f = Fixture::new("loop");
        let a = f.notes.join("loop-a");
        let b = f.notes.join("loop-b");
        let mk = |link: &Path, target: &Path| {
            std::process::Command::new("cmd").args(["/c", "mklink", "/J"]).arg(link).arg(target).output().map(|o| o.status.success()).unwrap_or(false)
        };
        std::fs::create_dir_all(&b).unwrap();
        if !mk(&a, &b) {
            eprintln!("cannot create a junction here; skipping");
            return;
        }
        std::fs::remove_dir(&b).unwrap();
        if !mk(&b, &a) {
            eprintln!("cannot create a junction here; skipping");
            return;
        }
        let r = req("read", "read_file", &[&f.p("loop-a/x.md")], json!({}));
        assert_ne!(selected(&decide(&r, &f.policy())), "allow");
        let r = req("read", "read_file", &[&f.p("a.md")], json!({}));
        assert_eq!(selected(&decide(&r, &f.policy())), "allow");
    }
}
