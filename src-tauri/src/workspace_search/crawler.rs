//! Folder crawler. Finds the files of a user's notes folder that may be
//! indexed and lists the ones that were skipped, with the reason.
//!
//! Rules (spec section 4): `.md .txt .pdf .docx` only; no hidden or system
//! entries, no `node_modules`; no secret-looking names (`.env*`, `*.pem`,
//! `*.key`, `id_*`, names holding credential, secret, token or password);
//! files over 2 MB skipped; at most 5,000 files; symbolic links, reparse
//! points and junctions are never followed; every path's canonical form must
//! stay inside the canonical root.

use std::fs;
use std::path::{Path, PathBuf};

pub const SUPPORTED_EXTENSIONS: &[&str] = &["md", "txt", "pdf", "docx"];

#[derive(Debug, Clone)]
pub struct CrawlOptions {
    pub max_file_bytes: u64,
    pub max_files: usize,
    pub max_dirs: usize,
    pub max_depth: usize,
    /// Cap on the number of skipped entries kept in the list.
    pub max_skipped_listed: usize,
}

impl Default for CrawlOptions {
    fn default() -> Self {
        CrawlOptions {
            max_file_bytes: 2 * 1024 * 1024,
            max_files: 5_000,
            max_dirs: 20_000,
            max_depth: 24,
            max_skipped_listed: 500,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CrawlFile {
    /// Path below the root with forward slashes.
    pub rel_path: String,
    pub abs_path: PathBuf,
    pub ext: String,
    pub size: u64,
    pub mtime_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkippedFile {
    pub rel_path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default)]
pub struct CrawlResult {
    pub files: Vec<CrawlFile>,
    pub skipped: Vec<SkippedFile>,
    /// Entries with other extensions (counted, not listed).
    pub unsupported: usize,
    /// True when a limit stopped the walk early.
    pub truncated: bool,
}

const SKIP_DIR_NAMES: &[&str] = &[
    "node_modules",
    "$recycle.bin",
    "system volume information",
    "__pycache__",
];

const SECRET_EXTENSIONS: &[&str] = &["pem", "key", "pfx", "p12", "ppk", "keystore", "jks", "kdbx"];
const SECRET_WORDS: &[&str] = &["credential", "secret", "token", "password"];

/// True for names that look like they hold secrets.
pub fn is_secret_like(name: &str) -> bool {
    let lower = name.to_lowercase();
    if lower == ".env" || lower.starts_with(".env.") || lower.starts_with(".env-") {
        return true;
    }
    if lower.starts_with("id_") || lower.starts_with("id-rsa") {
        return true;
    }
    if let Some((_, ext)) = lower.rsplit_once('.') {
        if SECRET_EXTENSIONS.contains(&ext) {
            return true;
        }
    }
    SECRET_WORDS.iter().any(|w| lower.contains(w))
}

#[cfg(windows)]
fn attr_flags(md: &fs::Metadata) -> (bool, bool, bool) {
    use std::os::windows::fs::MetadataExt;
    let a = md.file_attributes();
    (a & 0x2 != 0, a & 0x4 != 0, a & 0x400 != 0) // hidden, system, reparse point
}

#[cfg(not(windows))]
fn attr_flags(_md: &fs::Metadata) -> (bool, bool, bool) {
    (false, false, false)
}

fn mtime_ms(md: &fs::Metadata) -> i64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn rel_string(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

/// Walk `root`. `should_stop` is polled between directories so a cancelled
/// indexer returns promptly (the partial result is marked truncated).
pub fn crawl_folder(
    root: &Path,
    opts: &CrawlOptions,
    should_stop: &dyn Fn() -> bool,
) -> Result<CrawlResult, String> {
    let root_md = fs::symlink_metadata(root).map_err(|e| format!("Folder not readable: {e}"))?;
    if !root_md.is_dir() {
        return Err("Not a folder".into());
    }
    let canon_root = fs::canonicalize(root).map_err(|e| format!("Folder not readable: {e}"))?;

    let mut res = CrawlResult::default();
    let skip = |res: &mut CrawlResult, rel: String, reason: &str| {
        if res.skipped.len() < opts.max_skipped_listed {
            res.skipped.push(SkippedFile { rel_path: rel, reason: reason.to_string() });
        }
    };

    let mut stack: Vec<(PathBuf, usize)> = vec![(canon_root.clone(), 0)];
    let mut dirs_seen = 0usize;
    while let Some((dir, depth)) = stack.pop() {
        if should_stop() {
            res.truncated = true;
            break;
        }
        dirs_seen += 1;
        if dirs_seen > opts.max_dirs {
            res.truncated = true;
            skip(&mut res, rel_string(&canon_root, &dir), "too many folders; the rest is not indexed");
            break;
        }
        let rd = match fs::read_dir(&dir) {
            Ok(r) => r,
            Err(e) => {
                skip(&mut res, rel_string(&canon_root, &dir), &format!("folder not readable ({})", e.kind()));
                continue;
            }
        };
        let mut entries: Vec<fs::DirEntry> = rd.filter_map(|e| e.ok()).collect();
        entries.sort_by_key(|e| e.file_name());
        let mut sub_dirs: Vec<PathBuf> = Vec::new();
        for entry in entries {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            let rel = rel_string(&canon_root, &path);
            let md = match fs::symlink_metadata(&path) {
                Ok(m) => m,
                Err(e) => {
                    skip(&mut res, rel, &format!("not readable ({})", e.kind()));
                    continue;
                }
            };
            let (hidden_attr, system_attr, reparse) = attr_flags(&md);
            if md.file_type().is_symlink() || reparse {
                skip(&mut res, rel, "link or junction; not followed");
                continue;
            }
            if name.starts_with('.') || hidden_attr || system_attr {
                // hidden entries: a secret-looking one is reported as such
                if is_secret_like(&name) {
                    skip(&mut res, rel, "looks like a secret");
                }
                continue;
            }
            if md.is_dir() {
                let lower = name.to_lowercase();
                if SKIP_DIR_NAMES.contains(&lower.as_str()) {
                    continue;
                }
                if is_secret_like(&name) {
                    skip(&mut res, rel, "folder looks like it holds secrets");
                    continue;
                }
                if depth + 1 > opts.max_depth {
                    skip(&mut res, rel, "too deep");
                    res.truncated = true;
                    continue;
                }
                sub_dirs.push(path);
                continue;
            }
            if !md.is_file() {
                continue;
            }
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_lowercase())
                .unwrap_or_default();
            if is_secret_like(&name) {
                skip(&mut res, rel, "looks like a secret");
                continue;
            }
            if !SUPPORTED_EXTENSIONS.contains(&ext.as_str()) {
                res.unsupported += 1;
                continue;
            }
            if md.len() > opts.max_file_bytes {
                skip(&mut res, rel, "over 2 MB");
                continue;
            }
            // The real location must stay inside the folder.
            match fs::canonicalize(&path) {
                Ok(c) if c.starts_with(&canon_root) => {}
                Ok(_) => {
                    skip(&mut res, rel, "resolves outside the folder");
                    continue;
                }
                Err(e) => {
                    skip(&mut res, rel, &format!("not readable ({})", e.kind()));
                    continue;
                }
            }
            if res.files.len() >= opts.max_files {
                res.truncated = true;
                skip(&mut res, rel, "folder has more than 5,000 files; the rest is not indexed");
                // keep counting nothing more: stop the whole walk
                stack.clear();
                sub_dirs.clear();
                break;
            }
            res.files.push(CrawlFile {
                rel_path: rel,
                abs_path: path,
                ext,
                size: md.len(),
                mtime_ms: mtime_ms(&md),
            });
        }
        // depth-first in name order
        for d in sub_dirs.into_iter().rev() {
            stack.push((d, depth + 1));
        }
    }
    res.files.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_search::test_support::temp_dir;

    fn write(root: &Path, rel: &str, body: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }

    fn crawl(root: &Path) -> CrawlResult {
        crawl_folder(root, &CrawlOptions::default(), &|| false).unwrap()
    }

    fn rels(r: &CrawlResult) -> Vec<&str> {
        r.files.iter().map(|f| f.rel_path.as_str()).collect()
    }

    #[test]
    fn finds_supported_files_and_lists_skips() {
        let root = temp_dir("crawl1");
        write(&root, "notes/a.md", "# A");
        write(&root, "notes/deep/b.TXT", "b");
        write(&root, "c.docx", "not really");
        write(&root, "image.png", "x");
        write(&root, ".hidden/d.md", "hidden dir");
        write(&root, "node_modules/pkg/readme.md", "x");
        write(&root, ".env", "KEY=1");
        write(&root, "id_rsa", "key");
        write(&root, "server.pem", "x");
        write(&root, "my-credentials.md", "x");
        write(&root, "API Token notes.txt", "x");
        write(&root, "secrets/inside.md", "x");
        write(&root, "ok.md", "ok");
        let r = crawl(&root);
        assert_eq!(rels(&r), vec!["c.docx", "notes/a.md", "notes/deep/b.TXT", "ok.md"]);
        let reasons: Vec<_> = r.skipped.iter().map(|s| (s.rel_path.as_str(), s.reason.as_str())).collect();
        for name in [".env", "id_rsa", "server.pem", "my-credentials.md", "API Token notes.txt", "secrets"] {
            assert!(reasons.iter().any(|(p, _)| *p == name), "{name} not listed: {reasons:?}");
        }
        assert_eq!(r.unsupported, 1);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn big_files_are_skipped_with_a_reason() {
        let root = temp_dir("crawl2");
        write(&root, "small.txt", "hi");
        write(&root, "huge.txt", &"x".repeat(2 * 1024 * 1024 + 1));
        let r = crawl(&root);
        assert_eq!(rels(&r), vec!["small.txt"]);
        assert!(r.skipped.iter().any(|s| s.rel_path == "huge.txt" && s.reason == "over 2 MB"));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn file_count_limit_truncates_and_says_so() {
        let root = temp_dir("crawl3");
        for i in 0..30 {
            write(&root, &format!("f{i:02}.md"), "x");
        }
        let opts = CrawlOptions { max_files: 10, ..Default::default() };
        let r = crawl_folder(&root, &opts, &|| false).unwrap();
        assert_eq!(r.files.len(), 10);
        assert!(r.truncated);
        assert!(r.skipped.iter().any(|s| s.reason.contains("5,000")));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn depth_limit_stops_deep_trees() {
        let root = temp_dir("crawl4");
        let mut rel = String::new();
        for i in 0..8 {
            rel.push_str(&format!("d{i}/"));
        }
        write(&root, &format!("{rel}deep.md"), "x");
        write(&root, "top.md", "x");
        let opts = CrawlOptions { max_depth: 3, ..Default::default() };
        let r = crawl_folder(&root, &opts, &|| false).unwrap();
        assert_eq!(rels(&r), vec!["top.md"]);
        assert!(r.truncated);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn pathological_names_do_not_break_the_walk() {
        let root = temp_dir("crawl5");
        write(&root, "ünïcödé 日本語/メモ.md", "x");
        write(&root, "with space/  spaced name .md", "x");
        write(&root, "dots/a..b.md", "x");
        write(&root, &format!("long/{}.md", "n".repeat(120)), "x");
        let r = crawl(&root);
        assert_eq!(r.files.len(), 4, "{:?}", rels(&r));
        assert!(r.files.iter().any(|f| f.rel_path == "ünïcödé 日本語/メモ.md"));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn missing_or_file_root_is_an_error() {
        let root = temp_dir("crawl6");
        assert!(crawl_folder(&root.join("nope"), &CrawlOptions::default(), &|| false).is_err());
        write(&root, "f.md", "x");
        assert!(crawl_folder(&root.join("f.md"), &CrawlOptions::default(), &|| false).is_err());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn stop_flag_ends_the_walk_early() {
        let root = temp_dir("crawl7");
        write(&root, "a/x.md", "x");
        let r = crawl_folder(&root, &CrawlOptions::default(), &|| true).unwrap();
        assert!(r.truncated);
        assert!(r.files.is_empty());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn secret_name_rules() {
        for n in [".env", ".env.local", "id_rsa", "id_ed25519.pub", "a.PEM", "x.key", "My Secret.md", "oauth-token.txt", "credentials.txt"] {
            assert!(is_secret_like(n), "{n}");
        }
        for n in ["notes.md", "envoy.md", "ideas.md", "monkey.txt", "keynote.md"] {
            assert!(!is_secret_like(n), "{n}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn junctions_and_symlinks_are_not_followed_and_nothing_outside_leaks() {
        let outside = temp_dir("crawl-out");
        write(&outside, "leak.md", "OUTSIDE CANARY");
        let root = temp_dir("crawl8");
        write(&root, "ok.md", "ok");
        // junction (no admin rights needed)
        let junction = root.join("jct");
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&junction)
            .arg(&outside)
            .output();
        let made_junction = status.map(|o| o.status.success()).unwrap_or(false);
        // symlink (may need privileges)
        let made_symlink = std::os::windows::fs::symlink_dir(&outside, root.join("sym")).is_ok();
        let r = crawl(&root);
        assert_eq!(rels(&r), vec!["ok.md"], "junction={made_junction} symlink={made_symlink}");
        if made_junction {
            assert!(r.skipped.iter().any(|s| s.rel_path == "jct"));
        }
        // remove the link itself, never the target
        if made_junction {
            let _ = fs::remove_dir(&junction);
        }
        if made_symlink {
            let _ = fs::remove_dir(root.join("sym"));
        }
        assert!(outside.join("leak.md").exists());
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside).ok();
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_not_followed() {
        let outside = temp_dir("crawl-out");
        write(&outside, "leak.md", "OUTSIDE CANARY");
        let root = temp_dir("crawl8");
        write(&root, "ok.md", "ok");
        std::os::unix::fs::symlink(&outside, root.join("sym")).unwrap();
        std::os::unix::fs::symlink(outside.join("leak.md"), root.join("leak.md")).unwrap();
        let r = crawl(&root);
        assert_eq!(rels(&r), vec!["ok.md"]);
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside).ok();
    }
}
