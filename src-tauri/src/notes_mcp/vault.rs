//! The notes folders as the notes server sees them: list, search and read,
//! with every path checked by Rust itself.
//!
//! Containment is the whole point, so the rules are few and plain:
//!
//! - A request names a path relative to one allowed folder (`<folder>/<sub path>`,
//!   the folder name optional when there is only one folder) or an absolute
//!   `X:\...` path. A path that starts with `\\` or `//` (UNC, `\\?\`, `\\.\`) is
//!   refused.
//! - Every segment is checked on its own: no `..`, nothing hidden (`.obsidian`,
//!   `.git`, `.trash`, `$RECYCLE.BIN`), no `:` (alternate data streams, drive
//!   letters in the middle), no wildcard or control characters, no trailing dot
//!   or space (Win32 ignores them), no device names (`CON`, `NUL`, `COM1` ...).
//! - The joined path is then resolved by the file system (`canonicalize`), and
//!   the result must lie inside the canonical allowed folder. A junction or
//!   symlink that leaves the folder fails here; one that stays inside is fine.
//! - Files with the Windows hidden or system attribute are never listed or
//!   read, and the walk never enters a reparse point.
//!
//! Only `.md`, `.markdown` and `.txt` files are listed, searched or read.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// File types the server serves.
pub const NOTE_EXTENSIONS: [&str; 3] = ["md", "markdown", "txt"];
/// `read_note` returns at most this many bytes of a file.
pub const MAX_READ_BYTES: usize = 200 * 1024;
/// `list_notes` shows at most this many entries.
pub const MAX_LIST_ENTRIES: usize = 200;
/// `search_notes` returns at most this many matches.
pub const MAX_SEARCH_RESULTS: usize = 40;
/// ... and at most this many bytes of text.
pub const MAX_SEARCH_OUTPUT_BYTES: usize = 24 * 1024;
/// Files larger than this are not searched.
const MAX_SEARCH_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// A search looks at no more than this many files, this deep, for this long.
const MAX_SEARCH_FILES: usize = 20_000;
const MAX_DEPTH: usize = 16;
const SEARCH_BUDGET: Duration = Duration::from_secs(10);
/// A search query is cut to this many characters.
const MAX_QUERY_CHARS: usize = 200;
const SNIPPET_CHARS: usize = 240;

type Res<T> = Result<T, String>;

/// One allowed folder.
#[derive(Debug, Clone)]
struct Root {
    /// What the model calls it (the folder's own name, made unique).
    label: String,
    /// The canonical path, without a `\\?\` prefix.
    path: PathBuf,
    /// `path` as a comparable string.
    key: String,
}

/// The allowed folders.
#[derive(Debug, Clone, Default)]
pub struct Notes {
    roots: Vec<Root>,
}

impl Notes {
    /// The folders that exist and are allowed to be notes folders
    /// (`sources::launch::folder_problem`). The second value says why each
    /// other one was left out.
    pub fn open(dirs: &[PathBuf]) -> (Notes, Vec<String>) {
        Self::open_with(dirs, &|p| crate::sources::launch::folder_problem(p))
    }

    /// [`open`](Self::open) with the folder check passed in (tests).
    pub fn open_with(dirs: &[PathBuf], problem: &dyn Fn(&Path) -> Option<String>) -> (Notes, Vec<String>) {
        let mut notes = Notes::default();
        let mut skipped = Vec::new();
        for dir in dirs {
            if let Some(why) = problem(dir) {
                skipped.push(format!("{}: {why}", dir.display()));
                continue;
            }
            let Ok(real) = std::fs::canonicalize(dir) else {
                skipped.push(format!("{}: folder not found", dir.display()));
                continue;
            };
            let real = plain(real);
            if !real.is_dir() {
                skipped.push(format!("{}: not a folder", dir.display()));
                continue;
            }
            let base = real
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| "notes".to_string());
            let mut label = base.clone();
            let mut n = 2;
            while notes.roots.iter().any(|r| r.label.eq_ignore_ascii_case(&label)) {
                label = format!("{base}-{n}");
                n += 1;
            }
            let key = comparable(&real);
            if notes.roots.iter().any(|r| r.key == key) {
                continue;
            }
            notes.roots.push(Root { label, path: real, key });
        }
        (notes, skipped)
    }

    /// The names of the folders, for messages.
    pub fn labels(&self) -> Vec<&str> {
        self.roots.iter().map(|r| r.label.as_str()).collect()
    }

    pub fn is_empty(&self) -> bool {
        self.roots.is_empty()
    }

    // ---- list ---------------------------------------------------------

    /// `list_notes`: the folders (no argument, several folders), or the
    /// entries of one folder or sub folder.
    pub fn list(&self, folder: Option<&str>, subpath: Option<&str>) -> Res<String> {
        if self.roots.is_empty() {
            return Err("No notes folders are available.".into());
        }
        let folder = folder.map(str::trim).filter(|f| !f.is_empty());
        let subpath = subpath.map(str::trim).filter(|s| !s.is_empty());
        if folder.is_none() && subpath.is_none() && self.roots.len() > 1 {
            let mut out = String::from("Notes folders (pass one as `folder`):\n");
            for r in &self.roots {
                out.push_str(&format!("- {}\n", r.label));
            }
            return Ok(out);
        }
        let (root, rel) = match folder {
            Some(f) => (self.root_named(f)?, subpath.unwrap_or("").to_string()),
            None if self.roots.len() == 1 => (&self.roots[0], subpath.unwrap_or("").to_string()),
            None => return Err(format!("Pass `folder`, one of: {}.", self.labels().join(", "))),
        };
        let dir = self.resolve_in(root, &rel)?;
        if !dir.is_dir() {
            return Err("That is a file, not a folder. Use read_note.".into());
        }
        let mut entries: Vec<(bool, String, u64)> = Vec::new();
        for entry in std::fs::read_dir(&dir).map_err(|e| format!("Can't list this folder: {e}"))?.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if segment_problem(&name).is_some() {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if hidden_or_link(&meta) {
                continue;
            }
            if meta.is_dir() {
                entries.push((true, name, 0));
            } else if meta.is_file() && is_note_name(&name) {
                entries.push((false, name, meta.len()));
            }
        }
        entries.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.to_lowercase().cmp(&b.1.to_lowercase())));
        let shown = display(root, &dir);
        let mut out = format!("{shown}/ ({} entries)\n", entries.len());
        for (is_dir, name, size) in entries.iter().take(MAX_LIST_ENTRIES) {
            if *is_dir {
                out.push_str(&format!("dir   {shown}/{name}/\n"));
            } else {
                out.push_str(&format!("file  {shown}/{name}  ({size} bytes)\n"));
            }
        }
        if entries.len() > MAX_LIST_ENTRIES {
            out.push_str(&format!("... {} more not shown; open a sub folder or search.\n", entries.len() - MAX_LIST_ENTRIES));
        }
        Ok(out)
    }

    // ---- search -------------------------------------------------------

    /// `search_notes`: case-insensitive substring over the note files of one
    /// folder (or all), as `path:line: snippet`, capped in count and size.
    pub fn search(&self, query: &str, folder: Option<&str>) -> Res<String> {
        if self.roots.is_empty() {
            return Err("No notes folders are available.".into());
        }
        let query: String = query.trim().chars().take(MAX_QUERY_CHARS).collect();
        if query.is_empty() {
            return Err("`query` is empty.".into());
        }
        let needle = query.to_lowercase();
        let roots: Vec<&Root> = match folder.map(str::trim).filter(|f| !f.is_empty()) {
            Some(f) => vec![self.root_named(f)?],
            None => self.roots.iter().collect(),
        };
        let started = Instant::now();
        let mut out = String::new();
        let mut found = 0usize;
        let mut files_seen = 0usize;
        let mut stopped: Option<&str> = None;
        'roots: for root in roots {
            let mut stack: Vec<(PathBuf, usize)> = vec![(root.path.clone(), 0)];
            while let Some((dir, depth)) = stack.pop() {
                let Ok(read) = std::fs::read_dir(&dir) else { continue };
                let mut entries: Vec<_> = read.flatten().collect();
                entries.sort_by_key(|e| e.file_name().to_string_lossy().to_lowercase());
                let mut subdirs = Vec::new();
                for entry in entries {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if segment_problem(&name).is_some() {
                        continue;
                    }
                    let Ok(meta) = entry.metadata() else { continue };
                    if hidden_or_link(&meta) {
                        continue;
                    }
                    if meta.is_dir() {
                        if depth < MAX_DEPTH {
                            subdirs.push((entry.path(), depth + 1));
                        }
                        continue;
                    }
                    if !meta.is_file() || !is_note_name(&name) {
                        continue;
                    }
                    files_seen += 1;
                    if files_seen > MAX_SEARCH_FILES {
                        stopped = Some("too many files");
                        break 'roots;
                    }
                    if started.elapsed() > SEARCH_BUDGET {
                        stopped = Some("out of time");
                        break 'roots;
                    }
                    let shown = display(root, &entry.path());
                    let mut hits: Vec<String> = Vec::new();
                    if name.to_lowercase().contains(&needle) {
                        hits.push(format!("{shown}: (file name matches)\n"));
                    }
                    if meta.len() <= MAX_SEARCH_FILE_BYTES && self.inside_root(root, &entry.path()) {
                        if let Ok(bytes) = std::fs::read(entry.path()) {
                            let text = String::from_utf8_lossy(&bytes);
                            for (i, line) in text.lines().enumerate() {
                                if line.to_lowercase().contains(&needle) {
                                    hits.push(format!("{shown}:{}: {}\n", i + 1, snippet(line)));
                                }
                            }
                        }
                    }
                    for hit in hits {
                        if found >= MAX_SEARCH_RESULTS || out.len() + hit.len() > MAX_SEARCH_OUTPUT_BYTES {
                            stopped = Some("result limit reached");
                            break 'roots;
                        }
                        found += 1;
                        out.push_str(&hit);
                    }
                }
                // Visit sub folders in name order.
                subdirs.reverse();
                stack.extend(subdirs);
            }
        }
        if found == 0 && stopped.is_none() {
            return Ok(format!("No matches for \"{query}\"."));
        }
        if let Some(why) = stopped {
            out.push_str(&format!("(search stopped: {why}; narrow the query or pass `folder`)\n"));
        }
        Ok(out)
    }

    // ---- read ---------------------------------------------------------

    /// `read_note`: the text of one note file, cut at [`MAX_READ_BYTES`].
    pub fn read(&self, path: &str) -> Res<String> {
        if self.roots.is_empty() {
            return Err("No notes folders are available.".into());
        }
        let real = self.resolve_file(path)?;
        let meta = std::fs::metadata(&real).map_err(|e| format!("Can't read this note: {e}"))?;
        if !meta.is_file() {
            return Err("That is a folder, not a note. Use list_notes.".into());
        }
        if !is_note_name(&real.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()) {
            return Err("Only .md, .markdown and .txt notes can be read.".into());
        }
        let mut buf = Vec::new();
        {
            use std::io::Read;
            let file = std::fs::File::open(&real).map_err(|e| format!("Can't read this note: {e}"))?;
            file.take(MAX_READ_BYTES as u64 + 1).read_to_end(&mut buf).map_err(|e| format!("Can't read this note: {e}"))?;
        }
        let cut = buf.len() > MAX_READ_BYTES;
        buf.truncate(MAX_READ_BYTES);
        let mut text = String::from_utf8_lossy(&buf).into_owned();
        if let Some(rest) = text.strip_prefix('\u{feff}') {
            text = rest.to_string();
        }
        if cut {
            text.push_str(&format!("\n\n[Cut at {} KB; the note is {} bytes long.]\n", MAX_READ_BYTES / 1024, meta.len()));
        }
        Ok(text)
    }

    // ---- containment --------------------------------------------------

    fn root_named(&self, name: &str) -> Res<&Root> {
        self.roots
            .iter()
            .find(|r| r.label.eq_ignore_ascii_case(name.trim()))
            .ok_or_else(|| format!("No notes folder named \"{name}\". Folders: {}.", self.labels().join(", ")))
    }

    /// The canonical path of the file `input` names, inside an allowed folder.
    fn resolve_file(&self, input: &str) -> Res<PathBuf> {
        // Not trimmed: a trailing space is part of the name, and refused as such.
        if input.trim().is_empty() || input.contains('\0') {
            return Err("`path` is empty.".into());
        }
        if is_absolute_input(input) {
            let rest = absolute_check(input)?;
            let real = real_path(Path::new(&rest))?;
            let key = comparable(&real);
            let root = self
                .roots
                .iter()
                .find(|r| is_inside(&key, &r.key))
                .ok_or_else(|| "That path is outside the notes folders.".to_string())?;
            self.check_below(root, &real)?;
            return Ok(real);
        }
        let segments = split_segments(input)?;
        let (root, rest): (&Root, Vec<&str>) = match segments.first().and_then(|f| self.roots.iter().find(|r| r.label.eq_ignore_ascii_case(f))) {
            Some(root) => (root, segments[1..].to_vec()),
            None if self.roots.len() == 1 => (&self.roots[0], segments.clone()),
            None => return Err(format!("Start the path with a folder name: {}.", self.labels().join(", "))),
        };
        self.resolve_in(root, &rest.join("/"))
    }

    /// `rel` (segments checked) below `root`, resolved and checked inside it.
    fn resolve_in(&self, root: &Root, rel: &str) -> Res<PathBuf> {
        let segments = split_segments(rel)?;
        let mut joined = root.path.clone();
        for seg in &segments {
            joined.push(seg);
        }
        let real = real_path(&joined)?;
        self.check_below(root, &real)?;
        Ok(real)
    }

    /// `real` (canonical) must be inside `root`, and neither it nor a folder
    /// above it (below the root) may be hidden or a system item.
    fn check_below(&self, root: &Root, real: &Path) -> Res<()> {
        let key = comparable(real);
        if !is_inside(&key, &root.key) {
            return Err("That path is outside the notes folders.".into());
        }
        let rel = real.strip_prefix(&root.path).map_err(|_| "That path is outside the notes folders.".to_string())?;
        let mut cur = root.path.clone();
        for comp in rel.components() {
            cur.push(comp);
            let name = comp.as_os_str().to_string_lossy();
            if let Some(why) = segment_problem(&name) {
                return Err(format!("\"{name}\" is not available: {why}."));
            }
            if let Ok(meta) = std::fs::metadata(&cur) {
                if is_hidden_attr(&meta) {
                    return Err(format!("\"{name}\" is not available: it is hidden."));
                }
            }
        }
        Ok(())
    }

    /// Is `path` (an existing item found by the walk) still inside `root`
    /// after the file system resolves it?
    fn inside_root(&self, root: &Root, path: &Path) -> bool {
        std::fs::canonicalize(path).map(|p| is_inside(&comparable(&plain(p)), &root.key)).unwrap_or(false)
    }
}

// ---- pure helpers -------------------------------------------------------

/// `path` without the `\\?\` prefix (`\\?\UNC\a\b` becomes `\\a\b`).
fn plain(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path
    }
}

/// `canonicalize`, plain.
fn real_path(path: &Path) -> Res<PathBuf> {
    match std::fs::canonicalize(path) {
        Ok(p) => Ok(plain(p)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err("Not found.".into()),
        Err(e) => Err(format!("Can't open that path: {e}")),
    }
}

/// The form two paths are compared in: backslashes, lowercase on Windows.
fn comparable(path: &Path) -> String {
    let text = path.to_string_lossy().replace('/', "\\");
    let text = text.trim_end_matches('\\').to_string();
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text
    }
}

/// Is `path` the folder or below it (both from [`comparable`])?
fn is_inside(path: &str, folder: &str) -> bool {
    path == folder || path.strip_prefix(folder).is_some_and(|rest| rest.starts_with('\\'))
}

/// `X:\...` or `X:/...`, or a path that starts with a separator.
fn is_absolute_input(input: &str) -> bool {
    let b = input.as_bytes();
    (b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':') || input.starts_with('/') || input.starts_with('\\')
}

/// An absolute input is accepted only as `X:\dir\file` or `X:/dir/file`, with
/// every segment passing [`segment_problem`]. UNC and device paths, `C:file`
/// and a bare `\dir` are refused.
fn absolute_check(input: &str) -> Res<String> {
    let b = input.as_bytes();
    let drive_form = b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/');
    if !drive_form {
        return Err("Use a path inside a notes folder (`<folder>/<file>`).".into());
    }
    for seg in input[3..].split(['\\', '/']).filter(|s| !s.is_empty() && *s != ".") {
        if let Some(why) = segment_problem(seg) {
            return Err(format!("\"{seg}\" is not allowed: {why}."));
        }
    }
    Ok(input.to_string())
}

/// `a/b\c` as checked segments (`.` and empty ones dropped).
fn split_segments(rel: &str) -> Res<Vec<&str>> {
    let mut out = Vec::new();
    for seg in rel.split(['\\', '/']) {
        let seg = if seg == "." { "" } else { seg };
        if seg.is_empty() {
            continue;
        }
        if let Some(why) = segment_problem(seg) {
            return Err(format!("\"{seg}\" is not allowed: {why}."));
        }
        out.push(seg);
    }
    Ok(out)
}

/// Why a single name can't be used, or `None`.
pub fn segment_problem(seg: &str) -> Option<&'static str> {
    if seg == ".." {
        return Some("`..` is not allowed");
    }
    if seg.starts_with('.') {
        return Some("hidden names are not available");
    }
    if seg.starts_with('$') {
        return Some("system names are not available");
    }
    if seg.chars().any(|c| c.is_control() || matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|')) {
        return Some("it has a character that is not allowed in a name");
    }
    if seg.ends_with('.') || seg.ends_with(' ') {
        return Some("a name can't end in a dot or a space");
    }
    if is_device_name(seg) {
        return Some("it is a Windows device name");
    }
    None
}

/// `CON`, `PRN`, `AUX`, `NUL`, `COM1`..`COM9`, `LPT1`..`LPT9` (also with the
/// superscript digits Windows treats the same, and with any extension).
fn is_device_name(seg: &str) -> bool {
    let stem = seg.split('.').next().unwrap_or("").trim_end().to_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$") {
        return true;
    }
    for prefix in ["COM", "LPT"] {
        if let Some(rest) = stem.strip_prefix(prefix) {
            let mut chars = rest.chars();
            if let (Some(c), None) = (chars.next(), chars.next()) {
                if matches!(c, '0'..='9' | '\u{b9}' | '\u{b2}' | '\u{b3}') {
                    return true;
                }
            }
        }
    }
    false
}

fn is_note_name(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| NOTE_EXTENSIONS.iter().any(|n| e.eq_ignore_ascii_case(n)))
}

#[cfg(windows)]
fn attributes(meta: &std::fs::Metadata) -> u32 {
    use std::os::windows::fs::MetadataExt;
    meta.file_attributes()
}

#[cfg(windows)]
fn is_hidden_attr(meta: &std::fs::Metadata) -> bool {
    const HIDDEN_OR_SYSTEM: u32 = 0x2 | 0x4;
    attributes(meta) & HIDDEN_OR_SYSTEM != 0
}

#[cfg(not(windows))]
fn is_hidden_attr(_meta: &std::fs::Metadata) -> bool {
    false
}

/// A hidden or system item, or a reparse point (junction, symlink): not
/// listed and never entered by a walk.
fn hidden_or_link(meta: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        const REPARSE_POINT: u32 = 0x400;
        if attributes(meta) & REPARSE_POINT != 0 {
            return true;
        }
    }
    meta.file_type().is_symlink() || is_hidden_attr(meta)
}

/// `Folder/sub/file.md` for `path` (below `root`), with forward slashes.
fn display(root: &Root, path: &Path) -> String {
    let rel = path.strip_prefix(&root.path).unwrap_or(path);
    let rel = rel.to_string_lossy().replace('\\', "/");
    if rel.is_empty() {
        root.label.clone()
    } else {
        format!("{}/{rel}", root.label)
    }
}

fn snippet(line: &str) -> String {
    let line = line.trim();
    let mut out: String = line.chars().take(SNIPPET_CHARS).collect();
    if line.chars().count() > SNIPPET_CHARS {
        out.push_str("...");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Tree(PathBuf);

    impl Tree {
        fn new(tag: &str) -> Tree {
            let dir = std::env::temp_dir().join(format!("nexq-vault-{tag}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(dir.join("notes").join("sub")).unwrap();
            std::fs::create_dir_all(dir.join("notes").join(".obsidian")).unwrap();
            std::fs::create_dir_all(dir.join("outside")).unwrap();
            std::fs::write(dir.join("notes").join("a.md"), "Alpha plan\nProject Falcon launches on March 3.\n").unwrap();
            std::fs::write(dir.join("notes").join("sub").join("b.txt"), "falcon budget is two million").unwrap();
            std::fs::write(dir.join("notes").join("sub").join("pic.png"), "x").unwrap();
            std::fs::write(dir.join("notes").join(".obsidian").join("app.md"), "falcon hidden").unwrap();
            std::fs::write(dir.join("notes").join(".hidden.md"), "falcon hidden").unwrap();
            std::fs::write(dir.join("outside").join("secret.md"), "falcon secret").unwrap();
            Tree(dir)
        }

        fn notes(&self) -> Notes {
            Notes::open_with(&[self.0.join("notes")], &|_| None).0
        }

        fn two(&self) -> Notes {
            std::fs::create_dir_all(self.0.join("wiki")).unwrap();
            std::fs::write(self.0.join("wiki").join("w.md"), "falcon wiki").unwrap();
            Notes::open_with(&[self.0.join("notes"), self.0.join("wiki")], &|_| None).0
        }
    }

    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_folder_that_fails_the_folder_check_or_is_missing_is_left_out() {
        let t = Tree::new("open");
        let (notes, skipped) = Notes::open_with(
            &[t.0.join("notes"), t.0.join("nope"), t.0.join("outside")],
            &|p| p.ends_with("outside").then(|| "private".to_string()),
        );
        assert_eq!(notes.labels(), ["notes"]);
        assert_eq!(skipped.len(), 2, "{skipped:?}");
        assert!(skipped.iter().any(|s| s.contains("private")) && skipped.iter().any(|s| s.contains("not found")));
        // A drive root is refused by the real folder check.
        let (none, why) = Notes::open(&[PathBuf::from("C:\\")]);
        assert!(none.is_empty() && !why.is_empty());
    }

    #[test]
    fn two_folders_with_the_same_name_get_distinct_labels() {
        let t = Tree::new("labels");
        std::fs::create_dir_all(t.0.join("x").join("notes")).unwrap();
        let (n, _) = Notes::open_with(&[t.0.join("notes"), t.0.join("x").join("notes")], &|_| None);
        assert_eq!(n.labels(), ["notes", "notes-2"]);
    }

    #[test]
    fn list_shows_notes_and_folders_but_not_hidden_or_other_files() {
        let t = Tree::new("list");
        let out = t.notes().list(None, None).unwrap();
        assert!(out.contains("file  notes/a.md"), "{out}");
        assert!(out.contains("dir   notes/sub/"), "{out}");
        assert!(!out.contains(".obsidian") && !out.contains(".hidden"), "{out}");
        let sub = t.notes().list(None, Some("sub")).unwrap();
        assert!(sub.contains("notes/sub/b.txt") && !sub.contains("pic.png"), "{sub}");
        // With several folders the folders are listed first.
        let two = t.two();
        assert!(two.list(None, None).unwrap().contains("- wiki"));
        assert!(two.list(Some("wiki"), None).unwrap().contains("wiki/w.md"));
        assert!(two.list(None, Some("sub")).is_err(), "which folder?");
        assert!(two.list(Some("nope"), None).is_err());
    }

    #[test]
    fn a_long_listing_is_capped() {
        let t = Tree::new("cap");
        for i in 0..MAX_LIST_ENTRIES + 5 {
            std::fs::write(t.0.join("notes").join(format!("n{i:04}.md")), "x").unwrap();
        }
        let out = t.notes().list(None, None).unwrap();
        assert!(out.contains("more not shown"), "{out}");
        assert!(out.lines().filter(|l| l.starts_with("file")).count() <= MAX_LIST_ENTRIES);
    }

    #[test]
    fn search_finds_lines_case_insensitively_and_skips_hidden_and_outside() {
        let t = Tree::new("search");
        let out = t.notes().search("FALCON", None).unwrap();
        assert!(out.contains("notes/a.md:2: Project Falcon launches on March 3."), "{out}");
        assert!(out.contains("notes/sub/b.txt:1:"), "{out}");
        assert!(!out.contains("hidden") && !out.contains("secret"), "{out}");
        assert!(t.notes().search("zzz-nothing", None).unwrap().contains("No matches"));
        assert!(t.notes().search("   ", None).is_err());
        // A file name counts too.
        assert!(t.notes().search("b.txt", None).unwrap().contains("file name matches"));
        // One folder of two.
        let two = t.two();
        let wiki = two.search("falcon", Some("wiki")).unwrap();
        assert!(wiki.contains("wiki/w.md") && !wiki.contains("notes/"), "{wiki}");
        assert!(two.search("falcon", None).unwrap().contains("notes/a.md"));
    }

    #[test]
    fn search_results_are_capped() {
        let t = Tree::new("searchcap");
        let many: String = (0..MAX_SEARCH_RESULTS * 3).map(|i| format!("line {i} needle\n")).collect();
        std::fs::write(t.0.join("notes").join("many.md"), many).unwrap();
        let out = t.notes().search("needle", None).unwrap();
        assert!(out.lines().filter(|l| l.contains(": line")).count() <= MAX_SEARCH_RESULTS, "{out}");
        assert!(out.contains("search stopped"), "{out}");
        assert!(out.len() <= MAX_SEARCH_OUTPUT_BYTES + 200);
    }

    #[test]
    fn read_returns_the_text_and_cuts_a_big_note() {
        let t = Tree::new("read");
        let n = t.notes();
        assert!(n.read("notes/a.md").unwrap().starts_with("Alpha plan"));
        // The folder name is optional with one folder; case and slashes do not matter.
        assert!(n.read("a.md").unwrap().starts_with("Alpha plan"));
        assert!(n.read("Notes\\SUB\\b.txt").unwrap().contains("two million"));
        assert!(n.read("./sub//b.txt").unwrap().contains("two million"));
        // An absolute path inside the folder is fine.
        let abs = t.0.join("notes").join("a.md");
        assert!(n.read(&abs.to_string_lossy()).unwrap().starts_with("Alpha plan"));
        std::fs::write(t.0.join("notes").join("big.md"), "x".repeat(MAX_READ_BYTES + 1000)).unwrap();
        let big = n.read("big.md").unwrap();
        assert!(big.contains("Cut at") && big.len() < MAX_READ_BYTES + 200);
        // A BOM is dropped, a folder or a non-note file is refused.
        std::fs::write(t.0.join("notes").join("bom.md"), "\u{feff}hello").unwrap();
        assert_eq!(n.read("bom.md").unwrap(), "hello");
        assert!(n.read("sub").is_err());
        assert!(n.read("sub/pic.png").is_err());
        assert!(n.read("missing.md").is_err());
        assert!(n.read("").is_err());
    }

    #[test]
    fn traversal_hidden_and_special_names_are_refused() {
        let t = Tree::new("names");
        let n = t.notes();
        for bad in [
            "../outside/secret.md",
            "notes/../outside/secret.md",
            "sub/../../outside/secret.md",
            "..\\outside\\secret.md",
            ".hidden.md",
            ".obsidian/app.md",
            "notes/.obsidian/app.md",
            "a.md:stream",
            "a.md::$DATA",
            "notes/a.md.",
            "notes/a.md ",
            "CON",
            "con.md",
            "sub/NUL.txt",
            "COM1.md",
            "LPT9",
            "COM\u{b9}.md",
            "a?.md",
            "*.md",
            "\\\\server\\share\\a.md",
            "//server/share/a.md",
            "\\\\?\\C:\\Windows\\win.ini",
            "\\\\.\\C:\\Windows\\win.ini",
            "C:a.md",
            "\\a.md",
            "$RECYCLE.BIN/x.md",
        ] {
            assert!(n.read(bad).is_err(), "{bad} must be refused");
        }
        // The same names are refused when listing and searching.
        assert!(n.list(Some("notes"), Some("..")).is_err());
        assert!(n.list(None, Some("../outside")).is_err());
        assert!(n.list(None, Some(".obsidian")).is_err());
        assert!(n.search("falcon", Some("../outside")).is_err());
    }

    #[test]
    fn an_absolute_path_outside_or_on_another_drive_is_refused() {
        let t = Tree::new("abs");
        let n = t.notes();
        let outside = t.0.join("outside").join("secret.md");
        assert!(n.read(&outside.to_string_lossy()).is_err());
        assert!(n.read("C:\\Windows\\win.ini").is_err());
        assert!(n.read("Z:\\notes\\a.md").is_err());
        assert!(n.read("C:/Windows/win.ini").is_err());
        // A sibling whose name starts like the folder's is not inside it.
        std::fs::create_dir_all(t.0.join("notes-extra")).unwrap();
        std::fs::write(t.0.join("notes-extra").join("x.md"), "x").unwrap();
        assert!(n.read(&t.0.join("notes-extra").join("x.md").to_string_lossy()).is_err());
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
    fn a_junction_cannot_lead_out_of_the_folder() {
        let t = Tree::new("junction");
        let link = t.0.join("notes").join("escape");
        if !junction(&link, &t.0.join("outside")) {
            eprintln!("cannot create a junction here; skipping");
            return;
        }
        let n = t.notes();
        // Read through the junction: the file system resolves it outside.
        assert!(n.read("escape/secret.md").is_err());
        assert!(n.read(&link.join("secret.md").to_string_lossy()).is_err());
        assert!(n.list(None, Some("escape")).is_err());
        assert!(n.search("secret", Some("notes")).unwrap().contains("No matches"));
        // And it is not listed at all.
        assert!(!n.list(None, None).unwrap().contains("escape"));
        // A junction that stays inside the folder reads fine but is not listed or walked.
        let inner = t.0.join("notes").join("inner");
        if junction(&inner, &t.0.join("notes").join("sub")) {
            assert!(n.read("inner/b.txt").unwrap().contains("two million"));
            assert!(!n.list(None, None).unwrap().contains("inner"));
        }
        let _ = std::fs::remove_dir(&link);
        let _ = std::fs::remove_dir(&inner);
    }

    #[cfg(windows)]
    #[test]
    fn hidden_and_system_attributes_hide_a_file() {
        let t = Tree::new("attr");
        let file = t.0.join("notes").join("quiet.md");
        std::fs::write(&file, "falcon quiet").unwrap();
        let ok = std::process::Command::new("attrib").arg("+h").arg(&file).output().map(|o| o.status.success()).unwrap_or(false);
        if !ok {
            return;
        }
        let n = t.notes();
        assert!(n.read("quiet.md").is_err());
        assert!(!n.list(None, None).unwrap().contains("quiet.md"));
        assert!(!n.search("quiet", None).unwrap().contains("quiet.md"));
    }

    #[test]
    fn device_names_are_recognised_with_extensions_and_case() {
        for name in ["CON", "con", "Nul.txt", "aux.tar.gz", "COM1", "lpt3.md", "COM0", "CONIN$"] {
            assert!(is_device_name(name), "{name}");
        }
        for name in ["console.md", "COM10", "com", "notes.md", "LPT", "nul2"] {
            assert!(!is_device_name(name), "{name}");
        }
    }

    #[test]
    fn nothing_is_available_without_folders() {
        let none = Notes::default();
        assert!(none.list(None, None).is_err() && none.search("x", None).is_err() && none.read("a.md").is_err());
    }
}
