//! The per-session mcp-config files, which hold each server's own secret
//! values inline (stdio servers inherit the whole `claude.exe` environment, so
//! secrets must not go in the process env).
//!
//! The folder is `%LOCALAPPDATA%\NexQ\agent-private`: inside the user's own
//! profile (the default ACL there is user, SYSTEM and administrators only) and
//! deliberately NOT under `agent-sandbox`, which is the CLI's working directory
//! and so readable by the model's Read, Grep and Glob tools.
//!
//! Files are named `nexq-mcp-<pid>-<uuid>.json`, written when a session starts,
//! deleted as soon as the CLI's `system/init` arrives (it keeps the config in
//! memory from then on; close and drop delete it too if init never came), and
//! any a crashed run left behind are deleted at app start. Their content is never logged or returned over IPC.

use std::io::Write;
use std::path::{Path, PathBuf};

const PREFIX: &str = "nexq-mcp-";
const SUFFIX: &str = ".json";

/// `%LOCALAPPDATA%\NexQ\agent-private`.
pub fn private_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("NexQ").join("agent-private")
}

/// Write `content` to a new, uniquely named file in `dir` (created if missing).
pub fn write_private_file(dir: &Path, content: &str) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(format!(
        "{PREFIX}{}-{}{SUFFIX}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&path)?;
    if let Err(e) = file.write_all(content.as_bytes()).and_then(|_| file.flush()) {
        drop(file);
        let _ = std::fs::remove_file(&path);
        return Err(e);
    }
    Ok(path)
}

/// Delete one private file; a missing file is fine.
pub fn remove_private_file(path: &Path) {
    if let Err(e) = std::fs::remove_file(path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            log::warn!("cannot remove a private session file: {e}");
        }
    }
}

/// App start: delete files whose owning NexQ process is gone (a crash or a
/// kill left them). Files of this process and of another running NexQ stay.
/// Returns how many were deleted.
pub fn cleanup_leftovers(dir: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    let me = std::process::id();
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(pid) = owner_pid(&name) else { continue };
        if pid == me || pid_alive(pid) {
            continue;
        }
        if std::fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// The pid in `nexq-mcp-<pid>-<uuid>.json`.
fn owner_pid(file_name: &str) -> Option<u32> {
    let rest = file_name.strip_prefix(PREFIX)?.strip_suffix(SUFFIX)?;
    rest.split('-').next()?.parse().ok()
}

#[cfg(windows)]
fn pid_alive(pid: u32) -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    const STILL_ACTIVE: u32 = 259;
    // SAFETY: plain Win32 calls; the handle is closed before returning.
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return false;
        };
        let mut code = 0u32;
        let alive = GetExitCodeProcess(handle, &mut code).is_ok() && code == STILL_ACTIVE;
        let _ = CloseHandle(handle);
        alive
    }
}

#[cfg(not(windows))]
fn pid_alive(_pid: u32) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("nexq-private-{name}-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn private_dir_is_beside_the_sandbox_not_inside_it() {
        let private = private_dir();
        let sandbox = crate::llm::cli_agent::command::sandbox_dir();
        assert!(!private.starts_with(&sandbox), "{private:?} is readable by the model");
    }

    #[test]
    fn write_then_remove() {
        let dir = temp_dir("write");
        let a = write_private_file(&dir, "{\"x\":1}").unwrap();
        let b = write_private_file(&dir, "{}").unwrap();
        assert_ne!(a, b);
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "{\"x\":1}");
        remove_private_file(&a);
        assert!(!a.exists() && b.exists());
        remove_private_file(&a); // already gone: no panic
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn leftovers_of_dead_processes_are_deleted_and_live_ones_kept() {
        let dir = temp_dir("cleanup");
        let mine = write_private_file(&dir, "mine").unwrap();
        let dead = dir.join(format!("{PREFIX}{}-abc{SUFFIX}", u32::MAX));
        std::fs::write(&dead, "stale").unwrap();
        let unrelated = dir.join("notes.txt");
        std::fs::write(&unrelated, "x").unwrap();
        assert_eq!(cleanup_leftovers(&dir), 1);
        assert!(mine.exists() && unrelated.exists() && !dead.exists());
        assert_eq!(cleanup_leftovers(&dir.join("missing")), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn owner_pid_reads_the_file_name() {
        assert_eq!(owner_pid("nexq-mcp-1234-abc-def.json"), Some(1234));
        assert_eq!(owner_pid("nexq-mcp-x-abc.json"), None);
        assert_eq!(owner_pid("other.json"), None);
    }
}
