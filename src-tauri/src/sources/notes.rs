//! Looking at a notes folder before it is used: does it exist, how many
//! Markdown files does it hold.

use serde::{Deserialize, Serialize};
use std::path::Path;

/// Entries visited before the count stops (a huge or synced tree).
const MAX_ENTRIES: usize = 200_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotesFolderInfo {
    pub exists: bool,
    pub md_count: usize,
    /// The walk stopped at the entry limit; `md_count` is a lower bound.
    pub truncated: bool,
    /// Why this folder can't be a notes folder (a whole drive, NexQ's private
    /// files, the user's home); set by the command, not by [`inspect_folder`].
    #[serde(default)]
    pub problem: Option<String>,
}

/// Count `.md` files (any case) below `path`, skipping names that start with `.`
/// (`.obsidian`, `.git`, ...). Symlinked folders are not followed.
pub fn inspect_folder(path: &Path) -> NotesFolderInfo {
    if !path.is_dir() {
        return NotesFolderInfo { exists: false, md_count: 0, truncated: false, problem: None };
    }
    let mut md_count = 0;
    let mut visited = 0;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            visited += 1;
            if visited > MAX_ENTRIES {
                return NotesFolderInfo { exists: true, md_count, truncated: true, problem: None };
            }
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                stack.push(entry.path());
            } else if kind.is_file()
                && entry
                    .path()
                    .extension()
                    .is_some_and(|e| e.eq_ignore_ascii_case("md"))
            {
                md_count += 1;
            }
        }
    }
    NotesFolderInfo { exists: true, md_count, truncated: false, problem: None }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_tree(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("nexq-notes-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn inspect_folder_counts_md_and_reports_missing() {
        let dir = temp_tree("count");
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::create_dir_all(dir.join(".obsidian")).unwrap();
        std::fs::write(dir.join("a.md"), "x").unwrap();
        std::fs::write(dir.join("sub").join("b.MD"), "x").unwrap();
        std::fs::write(dir.join("c.txt"), "x").unwrap();
        std::fs::write(dir.join(".obsidian").join("x.md"), "x").unwrap();
        std::fs::write(dir.join(".hidden.md"), "x").unwrap();
        let info = inspect_folder(&dir);
        assert_eq!(info, NotesFolderInfo { exists: true, md_count: 2, truncated: false, problem: None });
        let _ = std::fs::remove_dir_all(&dir);

        let gone = inspect_folder(&dir);
        assert_eq!(gone, NotesFolderInfo { exists: false, md_count: 0, truncated: false, problem: None });
    }

    #[test]
    fn a_file_is_not_a_notes_folder() {
        let dir = temp_tree("file");
        let file = dir.join("a.md");
        std::fs::write(&file, "x").unwrap();
        assert!(!inspect_folder(&file).exists);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
