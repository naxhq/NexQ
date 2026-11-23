//! What NexQ lets a Codex session do when the app-server asks.
//!
//! Pure decisions (the only I/O is `canonicalize` on paths, to see through
//! symlinks and junctions): the session's reader thread calls [`decide`] for
//! every [`ServerRequest`] and answers at once, so a turn can never stall on
//! an approval nobody sees.
//!
//! - Commands: refused, with one exception: a plain read of the user's notes.
//!   (Only reached for commands Codex asks about at all: NexQ keeps the shell
//!   tool switched off unless notes folders are enabled, see `launch.rs`.)
//!   Codex's own classification (`commandActions`) is not trusted alone. The
//!   command line itself must tokenize into an allowlisted program (`type`,
//!   `cat`, `Get-Content`, `dir`, `ls`, `Get-ChildItem`, `rg`, `findstr`,
//!   `Select-String`, by bare name) with only flags from that program's safe
//!   list (exec-capable ones such as `--pre`, `-exec`, `--search-zip`,
//!   `-Command` are refused by name as well), no shell operators, and every
//!   path argument (and every path Codex reports) inside an enabled notes
//!   folder, both as written and after resolving symlinks and junctions.
//!   Anything that does not parse that way is refused. With no notes folders
//!   nothing runs.
//! - File changes and extra permissions: always refused.
//! - MCP tool calls: allowed only for tools in the allowed set.
//! - Everything else (questions to the user, dynamic tools, token refresh):
//!   refused.

use super::protocol::{CommandAction, ServerRequest};
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// The session's approval policy.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CodexPolicy {
    /// MCP tools a call may use, as `mcp__<server key>__<tool>` (the names the
    /// Claude sessions use) or `mcp__<server key>__*` for a whole server.
    pub allowed_tools: HashSet<String>,
}

/// The answer to one request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Allow,
    Deny(&'static str),
}

impl Verdict {
    pub fn is_allow(&self) -> bool {
        matches!(self, Verdict::Allow)
    }
}

/// Decide `req`. `readable_dirs` are the enabled notes folders; `cwd` is the
/// session's working directory (the base of relative paths).
pub fn decide(
    req: &ServerRequest,
    policy: &CodexPolicy,
    readable_dirs: &[impl AsRef<Path>],
    cwd: &Path,
) -> Verdict {
    match req {
        ServerRequest::CommandApproval { command, cwd: req_cwd, actions, .. } => {
            // The base of relative paths is the session's own directory. A
            // command that claims to run somewhere else is refused rather than
            // trusted: its relative paths could point anywhere.
            if let Some(req_cwd) = req_cwd.as_deref() {
                if components(Path::new(req_cwd), None) != components(cwd, None) {
                    return Verdict::Deny("commands are not allowed");
                }
            }
            if reads_only_inside(command, actions, cwd, readable_dirs) {
                Verdict::Allow
            } else {
                Verdict::Deny("commands are not allowed")
            }
        }
        ServerRequest::FileChangeApproval { .. } => Verdict::Deny("file changes are not allowed"),
        ServerRequest::PermissionsApproval => Verdict::Deny("extra permissions are not allowed"),
        ServerRequest::McpElicitation { server, message, meta } => decide_mcp(server, message, meta, policy),
        ServerRequest::UserInput => Verdict::Deny("no one to ask"),
        ServerRequest::DynamicToolCall => Verdict::Deny("no client tools"),
        ServerRequest::AuthTokensRefresh => Verdict::Deny("NexQ does not manage Codex sign-in"),
        ServerRequest::Unknown { .. } => Verdict::Deny("unknown request"),
    }
}

/// Is `mcp__<server>__<tool>` (or the whole server) in the allowed set?
pub fn tool_allowed(allowed: &HashSet<String>, server: &str, tool: &str) -> bool {
    !server.is_empty()
        && !tool.is_empty()
        && (allowed.contains(&format!("mcp__{server}__{tool}")) || allowed.contains(&format!("mcp__{server}__*")))
}

/// Codex asks before an MCP tool call through an elicitation whose `_meta`
/// says `codex_approval_kind: "mcp_tool_call"`; the tool is named in the
/// message (`Allow the <server> MCP server to run tool "<tool>"?`) and in
/// `_meta.tool_title`. Anything that does not clearly name an allowed tool of
/// the asking server is refused (a form from a server is never answered).
fn decide_mcp(server: &str, message: &str, meta: &Value, policy: &CodexPolicy) -> Verdict {
    if meta.get("codex_approval_kind").and_then(Value::as_str) != Some("mcp_tool_call") {
        return Verdict::Deny("not a tool approval");
    }
    let mut candidates: Vec<String> = Vec::new();
    for key in ["tool_name", "tool", "tool_title"] {
        if let Some(name) = meta.get(key).and_then(Value::as_str) {
            candidates.push(name.to_string());
        }
    }
    candidates.extend(quoted(message));
    if candidates.iter().any(|tool| tool_allowed(&policy.allowed_tools, server, tool)) {
        Verdict::Allow
    } else {
        Verdict::Deny("tool not allowed")
    }
}

/// The `"..."` substrings of `text`.
fn quoted(text: &str) -> Vec<String> {
    text.split('"').skip(1).step_by(2).map(str::to_string).filter(|s| !s.is_empty()).collect()
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Characters that chain, redirect, substitute, group or expand: a command
/// that has any is never treated as a plain read.
///
/// Also refused: `~` (home, 8.3 short names), `,` (PowerShell array
/// arguments), `@` (splatting, array subexpressions), `[` and `]` (wildcard
/// classes, indexing).
const SHELL_OPERATORS: &[char] =
    &['&', '|', ';', '>', '<', '`', '$', '\n', '\r', '(', ')', '{', '}', '^', '%', '~', ',', '@', '[', ']'];

/// Flags that make a read tool run something else or unpack archives. Refused
/// by name (and by prefix for `--pre*`) before any allowlist is consulted.
const DENIED_FLAGS: &[&str] = &[
    "--pre",
    "--pre-glob",
    "-exec",
    "-execdir",
    "-ok",
    "-okdir",
    "--search-zip",
    "-z",
    "-command",
    "-encodedcommand",
];

/// What a program may be called with.
struct Spec {
    /// Flags without a value.
    flags: &'static [&'static str],
    /// Flags followed by one non-negative integer.
    numeric: &'static [&'static str],
    /// The first positional argument is a search pattern, not a path (unless
    /// one of `files_flags` is present).
    pattern_first: bool,
    files_flags: &'static [&'static str],
}

fn spec_for(program: &str) -> Option<Spec> {
    Some(match program {
        "type" => Spec { flags: &[], numeric: &[], pattern_first: false, files_flags: &[] },
        "cat" | "get-content" | "gc" => Spec {
            flags: &["-raw"],
            numeric: &["-tail", "-totalcount", "-first", "-head"],
            pattern_first: false,
            files_flags: &[],
        },
        "dir" | "ls" | "get-childitem" | "gci" => Spec {
            flags: &["-recurse", "-name", "-file", "-directory", "-force", "/s", "/b"],
            numeric: &["-depth"],
            pattern_first: false,
            files_flags: &[],
        },
        "rg" => Spec {
            flags: &[
                "-i", "-n", "-l", "-c", "-w", "-F", "-S", "--ignore-case", "--line-number", "--files-with-matches",
                "--count", "--word-regexp", "--fixed-strings", "--smart-case", "--no-heading", "--files",
            ],
            numeric: &["-m", "--max-count", "-A", "-B", "-C"],
            pattern_first: true,
            files_flags: &["--files"],
        },
        "findstr" => Spec {
            flags: &["/i", "/n", "/s", "/m", "/l"],
            numeric: &[],
            pattern_first: true,
            files_flags: &[],
        },
        "select-string" | "sls" => Spec {
            flags: &["-simplematch", "-casesensitive", "-list"],
            numeric: &[],
            pattern_first: true,
            files_flags: &[],
        },
        _ => return None,
    })
}

/// Characters PowerShell reads as quotes, dashes or separators though this
/// tokenizer does not: typographic quotes and dashes (U+2010..U+201F) and any
/// whitespace other than space and tab (no-break space, em space, ...).
fn shell_lookalike(c: char) -> bool {
    ('\u{2010}'..='\u{201F}').contains(&c) || (c.is_whitespace() && c != ' ' && c != '\t')
}

/// Split a command line into words: whitespace separates, single or double
/// quotes group (and are removed), nothing escapes (backslash is a path
/// character on Windows). `None` for an unbalanced quote or an empty word.
fn tokenize(command: &str) -> Option<Vec<String>> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_word = false;
    let mut quote: Option<char> = None;
    for c in command.chars() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => current.push(c),
            None if c == '"' || c == '\'' => {
                quote = Some(c);
                in_word = true;
            }
            None if c.is_whitespace() => {
                if in_word {
                    if current.is_empty() {
                        return None;
                    }
                    tokens.push(std::mem::take(&mut current));
                    in_word = false;
                }
            }
            None => {
                current.push(c);
                in_word = true;
            }
        }
    }
    if quote.is_some() {
        return None;
    }
    if in_word {
        if current.is_empty() {
            return None;
        }
        tokens.push(current);
    }
    Some(tokens)
}

/// The path arguments of a command that is a plain read, or `None` when it is
/// anything else (unknown program, unlisted flag, bad value, not parseable).
/// No path argument at all yields an empty list: the program then works in its
/// current directory.
fn safe_read_paths(command: &str) -> Option<Vec<String>> {
    if command.contains(SHELL_OPERATORS) || command.chars().any(shell_lookalike) {
        return None;
    }
    let tokens = tokenize(command)?;
    // No `..` at all: a parser difference between this tokenizer and the
    // real shell must not be able to turn into a climb out of a folder.
    if tokens.iter().any(|t| t.split(['/', '\\']).any(|seg| seg == "..")) {
        return None;
    }
    let (program, args) = tokens.split_first()?;
    // A bare name only: `C:\evil\cat.exe` is not `cat`.
    if program.contains(['/', '\\', ':']) {
        return None;
    }
    let program = program.to_lowercase();
    let program = program.strip_suffix(".exe").unwrap_or(&program);
    let spec = spec_for(program)?;

    let mut positional: Vec<String> = Vec::new();
    let mut files_mode = false;
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        let lower = arg.to_lowercase();
        if DENIED_FLAGS.contains(&lower.as_str()) || lower.starts_with("--pre") {
            return None;
        }
        if arg.starts_with('-') || arg.starts_with('/') {
            // ripgrep's short flags are case sensitive (`-S` is not `-s`); the
            // PowerShell and cmd tools ignore case.
            let is = |list: &[&str]| list.iter().any(|f| if program == "rg" { f == arg } else { f.eq_ignore_ascii_case(arg) });
            if is(spec.flags) {
                if spec.files_flags.contains(&lower.as_str()) {
                    files_mode = true;
                }
            } else if is(spec.numeric) {
                i += 1;
                if !args.get(i).is_some_and(|v| !v.is_empty() && v.chars().all(|c| c.is_ascii_digit())) {
                    return None;
                }
            } else {
                return None;
            }
        } else {
            positional.push(arg.clone());
        }
        i += 1;
    }
    if spec.pattern_first && !files_mode {
        if positional.is_empty() {
            return None;
        }
        positional.remove(0);
    }
    if !positional.iter().all(|p| path_token_ok(p)) {
        return None;
    }
    Some(positional)
}

/// Is `token` a plain file system path? Refused: `~` anywhere, a `:` other
/// than the one of a leading drive letter (`env:`, `HKCU:`, `function:` are
/// PowerShell provider paths; `file.md:stream` an alternate data stream), and
/// a `*` or `?` anywhere but the last segment (a wildcard in the middle could
/// match a junction that leads out).
pub(crate) fn path_token_ok(token: &str) -> bool {
    let token = token.strip_prefix(r"\\?\").unwrap_or(token);
    if token.contains('~') {
        return false;
    }
    let bytes = token.as_bytes();
    let after_drive = if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' { &token[2..] } else { token };
    if after_drive.contains(':') {
        return false;
    }
    let segments: Vec<&str> = token.split(['/', '\\']).collect();
    segments.iter().rev().skip(1).all(|seg| !seg.contains(['*', '?']))
}

/// Does the command read only inside `dirs`?
fn reads_only_inside(
    command: &str,
    actions: &[CommandAction],
    base: &Path,
    dirs: &[impl AsRef<Path>],
) -> bool {
    if dirs.is_empty() || actions.is_empty() {
        return false;
    }
    let Some(arg_paths) = safe_read_paths(command) else { return false };
    // Every path to check: the command's own arguments, else the directory it
    // runs in; plus every path Codex reports (which must agree).
    let mut paths: Vec<PathBuf> = arg_paths.iter().map(PathBuf::from).collect();
    if paths.is_empty() {
        paths.push(base.to_path_buf());
    }
    for action in actions {
        let reported = match action {
            CommandAction::Read { path } => Some(path.as_str()),
            CommandAction::ListFiles { path } | CommandAction::Search { path, .. } => path.as_deref(),
            CommandAction::Unknown => None,
        };
        if !reported.is_none_or(path_token_ok) {
            return false;
        }
        match action {
            CommandAction::Read { path } => paths.push(PathBuf::from(path)),
            CommandAction::ListFiles { path } | CommandAction::Search { path, .. } => {
                paths.push(path.as_deref().map(PathBuf::from).unwrap_or_else(|| base.to_path_buf()))
            }
            CommandAction::Unknown => return false,
        }
    }
    let lexical_dirs: Vec<Vec<String>> = dirs.iter().map(|d| components(d.as_ref(), None)).collect();
    // A folder that cannot be resolved (gone, no access) allows nothing.
    let real_dirs: Vec<Vec<String>> =
        dirs.iter().filter_map(|d| std::fs::canonicalize(d.as_ref()).ok()).map(|c| components(&c, None)).collect();
    paths.iter().all(|path| {
        let parts = components(path, Some(base));
        contained(&parts, &lexical_dirs) && real_path(&parts).is_some_and(|real| contained(&real, &real_dirs))
    })
}

/// Is `parts` at or below one of `dirs`?
fn contained(parts: &[String], dirs: &[Vec<String>]) -> bool {
    dirs.iter().any(|dir| !dir.is_empty() && parts.len() >= dir.len() && parts[..dir.len()] == dir[..])
}

/// `path` as comparable parts: separators unified, `.` and `..` resolved
/// lexically, the `\\?\` prefix dropped, lower-cased on Windows. A relative
/// path is taken from `base`.
fn components(path: &Path, base: Option<&Path>) -> Vec<String> {
    raw_components(path, base)
        .into_iter()
        .map(|p| if cfg!(windows) { p.to_lowercase() } else { p })
        .collect()
}

/// [`components`] with the case kept (for asking the file system).
fn raw_components(path: &Path, base: Option<&Path>) -> Vec<String> {
    let text = path.to_string_lossy().replace('\\', "/");
    let text = text.strip_prefix("//?/").unwrap_or(&text).to_string();
    let absolute = text.starts_with('/') || text.as_bytes().get(1) == Some(&b':');
    let full = match (absolute, base) {
        (false, Some(base)) => {
            let b = base.to_string_lossy().replace('\\', "/");
            let b = b.strip_prefix("//?/").unwrap_or(&b).to_string();
            format!("{b}/{text}")
        }
        _ => text,
    };
    let mut parts: Vec<String> = Vec::new();
    for part in full.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            p => parts.push(p.to_string()),
        }
    }
    parts
}

/// The parts of the real location of the path `parts` names: symlinks and
/// junctions resolved. A part that does not exist yet is kept as written below
/// its deepest existing parent (which is resolved). `None` when something
/// exists but cannot be resolved (no access, not a directory in the way): the
/// caller refuses.
fn real_path(parts: &[String]) -> Option<Vec<String>> {
    // A wildcard may only end the path (`notes*.md`): one in the middle could
    // match a junction that leads out. The part with it is kept as written.
    let is_wild = |p: &String| p.contains(['*', '?']);
    if parts.iter().rev().skip(1).any(is_wild) {
        return None;
    }
    let mut tail: Vec<&String> = Vec::new();
    let mut end = parts.len();
    if parts.last().is_some_and(is_wild) {
        tail.push(&parts[end - 1]);
        end -= 1;
    }
    while end > 0 {
        let candidate = path_from_parts(&parts[..end]);
        match std::fs::canonicalize(&candidate) {
            Ok(real) => {
                let mut real = components(&real, None);
                real.extend(tail.iter().rev().map(|p| if cfg!(windows) { p.to_lowercase() } else { (*p).clone() }));
                return Some(real);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                tail.push(&parts[end - 1]);
                end -= 1;
            }
            Err(_) => return None,
        }
    }
    None
}

/// A path from `components` (a drive part like `d:` becomes `d:\`).
fn path_from_parts(parts: &[String]) -> PathBuf {
    let mut p = String::new();
    for (i, part) in parts.iter().enumerate() {
        if i == 0 {
            if part.ends_with(':') {
                p.push_str(part);
                p.push('\\');
                continue;
            }
            p.push(if cfg!(windows) { '\\' } else { '/' });
        } else {
            p.push(if cfg!(windows) { '\\' } else { '/' });
        }
        p.push_str(part);
    }
    PathBuf::from(p)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A real notes folder (`<root>/notes`, with `a.md`) and a folder beside it
    /// that is not a notes folder.
    struct Tree {
        root: PathBuf,
        notes: PathBuf,
        secret: PathBuf,
    }

    impl Tree {
        fn new(tag: &str) -> Tree {
            let base = std::env::temp_dir();
            // Long-name form without the `\\?\` prefix: a short 8.3 temp path
            // (`VAHID~1`) holds a `~`, which the policy refuses.
            let base = std::fs::canonicalize(&base).unwrap_or(base);
            let base = PathBuf::from(base.to_string_lossy().trim_start_matches(r"\\?\").to_string());
            let root = base.join(format!("nexq-codex-policy-{tag}-{}", uuid::Uuid::new_v4()));
            let notes = root.join("notes");
            let secret = root.join("secret");
            std::fs::create_dir_all(notes.join("sub")).unwrap();
            std::fs::create_dir_all(&secret).unwrap();
            std::fs::write(notes.join("a.md"), "a").unwrap();
            std::fs::write(notes.join("sub").join("b.md"), "b").unwrap();
            std::fs::write(secret.join("s.md"), "s").unwrap();
            Tree { root, notes, secret }
        }

        /// A path inside the notes folder, as a string.
        fn n(&self, rel: &str) -> String {
            self.notes.join(rel).to_string_lossy().into_owned()
        }
    }

    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn cmd(command: &str, actions: Vec<CommandAction>) -> ServerRequest {
        ServerRequest::CommandApproval { legacy: false, command: command.into(), cwd: None, actions }
    }

    fn read(path: &str) -> CommandAction {
        CommandAction::Read { path: path.into() }
    }

    fn verdict_in(req: &ServerRequest, dirs: &[&Path], cwd: &Path) -> Verdict {
        decide(req, &CodexPolicy::default(), dirs, cwd)
    }

    fn ok(t: &Tree, command: &str, actions: Vec<CommandAction>) -> bool {
        verdict_in(&cmd(command, actions), &[&t.notes], &t.root).is_allow()
    }

    #[test]
    fn a_command_is_refused_when_there_are_no_notes_folders() {
        let t = Tree::new("none");
        let req = cmd(&format!("type {}", t.n("a.md")), vec![read(&t.n("a.md"))]);
        let none: [&Path; 0] = [];
        assert_eq!(verdict_in(&req, &none, &t.root), Verdict::Deny("commands are not allowed"));
    }

    #[test]
    fn plain_reads_inside_a_notes_folder_run() {
        let t = Tree::new("plain");
        let a = t.n("a.md");
        assert!(ok(&t, &format!("type {a}"), vec![read(&a)]));
        assert!(ok(&t, &format!("cat \"{a}\""), vec![read(&a)]));
        assert!(ok(&t, &format!("Get-Content -TotalCount 20 {a}"), vec![read(&a)]));
        assert!(ok(&t, &format!("get-content -Raw '{a}'"), vec![read(&a)]));
        let notes = t.notes.to_string_lossy().into_owned();
        assert!(ok(&t, &format!("dir {notes}"), vec![CommandAction::ListFiles { path: Some(notes.clone()) }]));
        assert!(ok(&t, &format!("Get-ChildItem -Recurse -Name {notes}"), vec![CommandAction::ListFiles { path: Some(notes.clone()) }]));
        let search = |q: &str| vec![CommandAction::Search { query: Some(q.into()), path: Some(notes.clone()) }];
        assert!(ok(&t, &format!("rg -n -i budget {notes}"), search("budget")));
        assert!(ok(&t, &format!("rg -A 3 --max-count 5 \"two words\" {notes}"), search("two words")));
        assert!(ok(&t, &format!("rg --files {notes}"), search("")));
        assert!(ok(&t, &format!("findstr /i /s budget {}", t.n("*.md")), search("budget")));
        assert!(ok(&t, &format!("Select-String -SimpleMatch budget {a}"), vec![read(&a)]));
    }

    #[test]
    fn typographic_quotes_dashes_odd_spaces_and_dot_dot_are_refused() {
        let t = Tree::new("lookalike");
        let a = t.n("a.md");
        let s = t.secret.join("s.md").to_string_lossy().into_owned();
        // PowerShell reads these as quotes, dashes or separators; we don't.
        for c in ['\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}', '\u{2013}', '\u{2014}', '\u{00A0}', '\u{2003}'] {
            assert!(!ok(&t, &format!("type {a}{c}{s}"), vec![read(&a)]), "{:?}", c);
        }
        let up = t.n("sub/../a.md");
        assert!(!ok(&t, &format!("type {up}"), vec![read(&up)]));
        assert!(!ok(&t, &format!("type {}", t.n("..\\secret\\s.md")), vec![read(&a)]));
        assert!(ok(&t, &format!("type {a}"), vec![read(&a)]), "a plain read still runs");
    }

    #[test]
    fn a_search_without_a_path_uses_the_session_directory_and_a_foreign_cwd_is_refused() {
        let t = Tree::new("cwd");
        let search = vec![CommandAction::Search { query: Some("x".into()), path: None }];
        let at = |req_cwd: Option<&Path>, session_cwd: &Path| {
            let mut req = cmd("rg x", search.clone());
            if let ServerRequest::CommandApproval { cwd: c, .. } = &mut req {
                *c = req_cwd.map(|p| p.to_string_lossy().into_owned());
            }
            verdict_in(&req, &[&t.notes], session_cwd).is_allow()
        };
        // No cwd in the request: the session's directory is the base.
        assert!(at(None, &t.notes));
        assert!(!at(None, &t.root));
        // A cwd equal to the session's (spelling aside) is fine...
        assert!(at(Some(&t.notes), &t.notes));
        let messy = PathBuf::from(format!("{}/./SUB/..", t.notes.to_string_lossy().to_uppercase().replace('\\', "/")));
        assert!(at(Some(&messy), &t.notes) || !cfg!(windows));
        // ...a different one is refused even when it lies inside the notes.
        assert!(!at(Some(&t.notes.join("sub")), &t.notes));
        assert!(!at(Some(&t.notes), &t.root));
        assert!(!at(Some(&t.secret), &t.notes));
    }

    #[test]
    fn slashes_case_and_dot_segments_do_not_matter() {
        let t = Tree::new("norm");
        let messy = format!("{}/./SUB/B.md", t.notes.to_string_lossy().replace('\\', "/"));
        assert!(ok(&t, &format!("type \"{messy}\""), vec![read(&messy)]));
    }

    #[test]
    fn a_path_outside_the_notes_folders_is_refused() {
        let t = Tree::new("outside");
        let s = t.secret.join("s.md").to_string_lossy().into_owned();
        assert!(!ok(&t, &format!("type {s}"), vec![read(&s)]));
        // A sibling whose name only starts the same, and a dot-dot escape.
        let sibling = format!("{}-private\\a.md", t.notes.display());
        assert!(!ok(&t, &format!("type {sibling}"), vec![read(&sibling)]));
        let escape = format!("{}\\..\\secret\\s.md", t.notes.display());
        assert!(!ok(&t, &format!("type {escape}"), vec![read(&escape)]));
    }

    #[test]
    fn one_path_outside_spoils_the_whole_command() {
        let t = Tree::new("two");
        let (a, s) = (t.n("a.md"), t.secret.join("s.md").to_string_lossy().into_owned());
        // Codex reports only the first; the command line has both.
        assert!(!ok(&t, &format!("type {a} {s}"), vec![read(&a)]));
        // Codex reports both.
        assert!(!ok(&t, &format!("type {a}"), vec![read(&a), read(&s)]));
    }

    #[test]
    fn shell_operators_are_refused() {
        let t = Tree::new("ops");
        let a = t.n("a.md");
        for command in [
            format!("type {a} > {}", t.n("b.md")),
            format!("type {a} | findstr x"),
            format!("type {a}; del x"),
            format!("type {a} && del x"),
            "cat $(whoami)".to_string(),
            "cat `x`".to_string(),
            format!("cat (gc {a})"),
            "cat %USERPROFILE%\\x".to_string(),
            format!("cat {a}\r\ndel x"),
        ] {
            assert!(!ok(&t, &command, vec![read(&a)]), "{command}");
        }
    }

    #[test]
    fn unclassified_and_unparseable_commands_are_refused() {
        let t = Tree::new("odd");
        let a = t.n("a.md");
        assert!(!ok(&t, &format!("del {a}"), vec![CommandAction::Unknown]));
        assert!(!ok(&t, &format!("type {a}"), vec![]));
        // Codex says "read" but the program is not a reader.
        assert!(!ok(&t, &format!("del {a}"), vec![read(&a)]));
        assert!(!ok(&t, &format!("curl {a}"), vec![read(&a)]));
        // Not parseable: unbalanced quote, empty word, empty command.
        assert!(!ok(&t, &format!("type \"{a}"), vec![read(&a)]));
        assert!(!ok(&t, &format!("type \"\" {a}"), vec![read(&a)]));
        assert!(!ok(&t, "", vec![read(&a)]));
    }

    #[test]
    fn a_program_must_be_a_bare_allowlisted_name() {
        let t = Tree::new("prog");
        let a = t.n("a.md");
        for command in [
            format!("C:\\evil\\cat.exe {a}"),
            format!("..\\cat {a}"),
            format!("./rg x {a}"),
            format!("powershell -Command Get-Content {a}"),
            "powershell.exe -EncodedCommand AAAA".to_string(),
            format!("cmd /c type {a}"),
            format!("node -e 1 {a}"),
            format!("git show {a}"),
        ] {
            assert!(!ok(&t, &command, vec![read(&a)]), "{command}");
        }
        // `.exe` on an allowlisted name is fine.
        assert!(ok(&t, &format!("rg.exe x {}", t.notes.display()), vec![CommandAction::Search { query: None, path: Some(t.notes.to_string_lossy().into_owned()) }]));
    }

    #[test]
    fn exec_capable_and_unlisted_flags_are_refused() {
        let t = Tree::new("flags");
        let n = t.notes.to_string_lossy().into_owned();
        let a = t.n("a.md");
        let search = vec![CommandAction::Search { query: Some("x".into()), path: Some(n.clone()) }];
        for command in [
            format!("rg --pre calc.exe x {n}"),
            format!("rg --pre=calc.exe x {n}"),
            format!("rg --pre-glob *.md x {n}"),
            format!("rg --preprocessor x x {n}"),
            format!("rg --search-zip x {n}"),
            format!("rg -z x {n}"),
            format!("rg --hidden x {n}"),
            format!("rg -g *.md x {n}"),
            format!("rg --max-count=5 x {n}"),
            format!("rg -m five x {n}"),
            "rg -m".to_string(),
            format!("findstr /f:list.txt x {a}"),
            format!("findstr /g:list.txt x {a}"),
            format!("findstr /c:x {a}"),
            format!("Get-ChildItem -Exec calc {n}"),
            "Get-ChildItem -Path C:\\ -Recurse".to_string(),
            format!("ls -execdir x {n}"),
            format!("ls -ok x {n}"),
            format!("Get-Content -Command x {a}"),
            format!("Get-Content -EncodedCommand AAAA {a}"),
            format!("Get-Content -Path C:\\secret.txt {a}"),
            format!("Get-Content -Wait {a}"),
            format!("Select-String -Pattern x -Path {a}"),
            format!("type /x {a}"),
            format!("cat - {a}"),
        ] {
            assert!(!ok(&t, &command, search.clone()), "{command}");
        }
        // The same tools with only safe flags are fine.
        assert!(ok(&t, &format!("rg -m 5 x {n}"), search.clone()));
    }

    #[test]
    fn the_pattern_is_not_a_path_but_everything_after_it_is() {
        let t = Tree::new("pattern");
        let n = t.notes.to_string_lossy().into_owned();
        let s = t.secret.to_string_lossy().into_owned();
        let search = |p: &str| vec![CommandAction::Search { query: Some("x".into()), path: Some(p.into()) }];
        // A pattern that looks like an outside path is still just a pattern.
        assert!(ok(&t, &format!("rg \"{s}\" {n}"), search(&n)));
        // But a second path argument is checked.
        assert!(!ok(&t, &format!("rg x {n} {s}"), search(&n)));
    }

    #[test]
    fn relative_paths_are_taken_from_the_session_directory() {
        let t = Tree::new("rel");
        // The session runs in the notes folder: `a.md` is inside it.
        let req = cmd("type a.md", vec![read("a.md")]);
        assert!(verdict_in(&req, &[&t.notes], &t.notes).is_allow());
        // A request that names that folder as its cwd while the session runs
        // elsewhere is refused, not trusted.
        let mut req = cmd("type a.md", vec![read("a.md")]);
        if let ServerRequest::CommandApproval { cwd, .. } = &mut req {
            *cwd = Some(t.notes.to_string_lossy().into_owned());
        }
        assert!(!verdict_in(&req, &[&t.notes], &t.root).is_allow());
        // From the sandbox directory the same command reads nothing of the notes.
        let req = cmd("type a.md", vec![read("a.md")]);
        assert!(!verdict_in(&req, &[&t.notes], &t.root).is_allow());
    }

    #[test]
    fn home_commas_splats_and_brackets_are_refused_anywhere() {
        let t = Tree::new("chars");
        let a = t.n("a.md");
        for command in [
            r"type ~\.ssh\id_rsa".to_string(),
            format!("type {a} ~"),
            format!(r"Get-Content {a},C:\secret.txt"),
            format!("Get-Content @({a})"),
            "Get-Content @args".to_string(),
            format!("type {}[a].md", t.notes.display()),
            format!("type {a}]"),
            format!("rg a,b {}", t.notes.display()),
            format!("rg user@host {}", t.notes.display()),
            format!("rg \"~\" {}", t.notes.display()),
        ] {
            assert!(!ok(&t, &command, vec![read(&a)]), "{command}");
        }
    }

    #[test]
    fn a_wildcard_is_only_allowed_in_the_last_path_segment() {
        let t = Tree::new("wild");
        let n = t.notes.to_string_lossy().into_owned();
        let a = t.n("a.md");
        assert!(ok(&t, &format!("findstr /i x {}", t.n("*.md")), vec![read(&a)]));
        assert!(ok(&t, &format!("dir {}", t.n("a?.md")), vec![CommandAction::ListFiles { path: Some(t.n("a?.md")) }]));
        for bad in [format!(r"{n}\*\a.md"), format!(r"{n}\s?b\b.md"), format!(r"{n}\su*\b.md")] {
            assert!(!ok(&t, &format!("type {bad}"), vec![read(&a)]), "{bad}");
            // Reported by Codex rather than typed: the same.
            assert!(!ok(&t, &format!("type {a}"), vec![read(&bad)]), "{bad}");
        }
        // A wildcard in the pattern is not a path.
        let search = vec![CommandAction::Search { query: Some("a.*b".into()), path: Some(n.clone()) }];
        assert!(ok(&t, &format!("rg \"a.*b\" {n}"), search));
    }

    #[test]
    fn provider_paths_and_streams_are_refused() {
        let t = Tree::new("providers");
        let a = t.n("a.md");
        for bad in [
            "env:USERPROFILE",
            "Env:",
            r"HKCU:\Software",
            r"HKLM:\SAM",
            "function:",
            "variable:x",
            "alias:",
            r"cert:\CurrentUser",
            "C:foo",
            r"C:\a:b.md",
            "a.md:secret",
            r"\server\share\x:y",
        ] {
            for command in [format!("Get-Content {bad}"), format!("Get-ChildItem {bad}"), format!("dir {bad}"), format!("type {bad}")] {
                assert!(!ok(&t, &command, vec![read(&a)]), "{command}");
            }
            assert!(!ok(&t, &format!("type {a}"), vec![read(bad)]), "reported {bad}");
        }
        // A normal drive path is still a path.
        assert!(path_token_ok(r"C:\notes\a.md"));
        assert!(path_token_ok("d:/notes/a.md"));
        assert!(path_token_ok(r"relative\a.md"));
        assert!(path_token_ok(r"\\?\C:\notes\a.md"));
        assert!(!path_token_ok(r"~\x"));
        assert!(!path_token_ok(r"a\~1\x"));
    }

    #[test]
    fn a_file_that_does_not_exist_yet_is_judged_by_its_folder() {
        let t = Tree::new("missing");
        let missing = t.n("new\\deep\\x.md");
        assert!(ok(&t, &format!("type {missing}"), vec![read(&missing)]));
        let outside = format!("{}\\nope\\x.md", t.secret.display());
        assert!(!ok(&t, &format!("type {outside}"), vec![read(&outside)]));
    }

    #[test]
    fn a_notes_folder_that_cannot_be_resolved_allows_nothing() {
        let t = Tree::new("gone");
        let gone = t.root.join("gone");
        let a = gone.join("a.md").to_string_lossy().into_owned();
        let req = cmd(&format!("type {a}"), vec![read(&a)]);
        assert!(!verdict_in(&req, &[&gone], &t.root).is_allow());
    }

    #[cfg(windows)]
    fn junction(link: &Path, target: &Path) -> bool {
        std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_inside_the_folder_cannot_lead_out() {
        let t = Tree::new("junction");
        let link = t.notes.join("escape");
        if !junction(&link, &t.secret) {
            eprintln!("cannot create a junction here; skipping");
            return;
        }
        // An existing file behind the junction, a file that is not there, and
        // the junction itself: all lead outside.
        for rel in ["escape\\s.md", "escape\\new.md", "escape"] {
            let p = t.n(rel);
            assert!(!ok(&t, &format!("type {p}"), vec![read(&p)]), "{rel}");
            assert!(!ok(&t, &format!("dir {p}"), vec![CommandAction::ListFiles { path: Some(p.clone()) }]), "{rel}");
        }
        // The real files of the notes folder still read fine.
        let a = t.n("a.md");
        assert!(ok(&t, &format!("type {a}"), vec![read(&a)]));
    }

    #[cfg(windows)]
    #[test]
    fn a_notes_folder_that_is_itself_a_junction_reads_through_it() {
        let t = Tree::new("junction-root");
        let link = t.root.join("linked-notes");
        if !junction(&link, &t.notes) {
            eprintln!("cannot create a junction here; skipping");
            return;
        }
        let a = link.join("a.md").to_string_lossy().into_owned();
        let req = cmd(&format!("type {a}"), vec![read(&a)]);
        assert!(verdict_in(&req, &[&link], &t.root).is_allow());
        // Reaching the sibling folder through it is still refused.
        let s = link.join("..\\secret\\s.md").to_string_lossy().into_owned();
        let req = cmd(&format!("type {s}"), vec![read(&s)]);
        assert!(!verdict_in(&req, &[&link], &t.root).is_allow());
    }

    #[test]
    fn tokenizing_follows_quotes() {
        assert_eq!(tokenize("a  \"b c\" 'd e' f").unwrap(), ["a", "b c", "d e", "f"]);
        assert_eq!(tokenize("rg \"x y\"z").unwrap(), ["rg", "x yz"]);
        assert!(tokenize("a \"b").is_none());
        assert!(tokenize("a '' b").is_none());
        assert_eq!(tokenize("   ").unwrap(), Vec::<String>::new());
    }

    #[test]
    fn file_changes_permissions_and_questions_are_always_refused() {
        let none: [&str; 0] = [];
        let policy = CodexPolicy::default();
        let cwd = Path::new("C:\\sandbox");
        for req in [
            ServerRequest::FileChangeApproval { legacy: false },
            ServerRequest::FileChangeApproval { legacy: true },
            ServerRequest::PermissionsApproval,
            ServerRequest::UserInput,
            ServerRequest::DynamicToolCall,
            ServerRequest::AuthTokensRefresh,
            ServerRequest::Unknown { method: "x".into() },
        ] {
            assert!(!decide(&req, &policy, &none, cwd).is_allow(), "{req:?}");
        }
    }

    fn elicitation(server: &str, message: &str, meta: Value) -> ServerRequest {
        ServerRequest::McpElicitation { server: server.into(), message: message.into(), meta }
    }

    fn policy(tools: &[&str]) -> CodexPolicy {
        CodexPolicy { allowed_tools: tools.iter().map(|t| t.to_string()).collect() }
    }

    fn verdict(req: &ServerRequest, p: &CodexPolicy) -> Verdict {
        let none: [&str; 0] = [];
        decide(req, p, &none, Path::new("C:\\sandbox"))
    }

    #[test]
    fn an_allowed_mcp_tool_is_approved() {
        let req = elicitation(
            "mira",
            "Allow the mira MCP server to run tool \"kb_search\"?",
            json!({ "codex_approval_kind": "mcp_tool_call", "tool_title": "kb_search" }),
        );
        assert_eq!(verdict(&req, &policy(&["mcp__mira__kb_search"])), Verdict::Allow);
        // A whole server.
        assert_eq!(verdict(&req, &policy(&["mcp__mira__*"])), Verdict::Allow);
    }

    #[test]
    fn a_tool_that_is_not_allowed_is_refused() {
        let req = elicitation(
            "mira",
            "Allow the mira MCP server to run tool \"send_mail\"?",
            json!({ "codex_approval_kind": "mcp_tool_call", "tool_title": "send_mail" }),
        );
        assert!(!verdict(&req, &policy(&["mcp__mira__kb_search", "mcp__other__*"])).is_allow());
        assert!(!verdict(&req, &CodexPolicy::default()).is_allow());
    }

    #[test]
    fn the_allowed_tool_must_belong_to_the_asking_server() {
        let req = elicitation(
            "evil",
            "Allow the evil MCP server to run tool \"kb_search\"?",
            json!({ "codex_approval_kind": "mcp_tool_call" }),
        );
        assert!(!verdict(&req, &policy(&["mcp__mira__kb_search"])).is_allow());
    }

    #[test]
    fn a_form_from_a_server_is_never_answered() {
        let req = elicitation("mira", "Please enter your password", json!({}));
        assert!(!verdict(&req, &policy(&["mcp__mira__*"])).is_allow());
        let other_kind = elicitation("mira", "\"kb_search\"", json!({ "codex_approval_kind": "something_else" }));
        assert!(!verdict(&other_kind, &policy(&["mcp__mira__*"])).is_allow());
    }

    #[test]
    fn no_tool_name_means_no() {
        let req = elicitation("mira", "Allow it?", json!({ "codex_approval_kind": "mcp_tool_call" }));
        assert!(!verdict(&req, &policy(&["mcp__mira__*"])).is_allow());
    }
}
