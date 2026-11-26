//! Settings files that can't be read are never silently replaced by defaults.
//!
//! The webview keeps its settings in a few JSON files in the app data folder
//! (the store plugin). When one of them is not valid JSON (a crash while it was
//! written, a disk error) the plugin starts from defaults and the next save
//! overwrites it: onboarding, sources and the provider are gone. This runs
//! before the plugin loads anything:
//!
//! - a valid file is never touched;
//! - a file that is not valid is moved to `<name>.corrupt-<timestamp>` (the
//!   newest three are kept), and the last good copy `<name>.bak` is put back if
//!   there is one (written atomically);
//! - a good copy is made from a valid file at most every 10 minutes;
//! - what was found is reported once to the UI.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;

/// The settings files the app keeps in its data folder.
pub const STORES: &[&str] = &["config.json", "nexq-settings.json", "translation-config.json"];
/// How many unreadable copies are kept per file.
pub const KEEP_CORRUPT: usize = 3;
/// The least time between two good copies of one file.
pub const BACKUP_EVERY: Duration = Duration::from_secs(10 * 60);

/// What happened to one settings file at start.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StoreRecovery {
    /// The file, e.g. `config.json`.
    pub file: String,
    /// The unreadable file was put aside under this name.
    pub kept_as: Option<String>,
    /// The last good copy was put back (else the app starts from defaults).
    pub restored: bool,
}

fn is_valid_store(text: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text).map(|v| v.is_object()).unwrap_or(false)
}

fn modified(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// Writes `bytes` to `path` so a reader sees the old file or the new one,
/// never half of one: a temporary file in the same folder, flushed, then renamed.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    fs::rename(&tmp, path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

fn corrupt_prefix(name: &str) -> String {
    format!("{name}.corrupt-")
}

/// Deletes all but the newest `KEEP_CORRUPT` unreadable copies of `name`.
fn trim_corrupt(dir: &Path, name: &str) {
    let prefix = corrupt_prefix(name);
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut copies: Vec<(String, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter_map(|e| {
            let file = e.file_name().to_string_lossy().to_string();
            file.starts_with(&prefix).then(|| (file, e.path()))
        })
        .collect();
    // Timestamps are zero-padded, so the names sort oldest first.
    copies.sort();
    let excess = copies.len().saturating_sub(KEEP_CORRUPT);
    for (_, path) in copies.into_iter().take(excess) {
        let _ = fs::remove_file(path);
    }
}

/// Looks at every settings file in `dir` before the store plugin does.
/// `stamp` names the unreadable copies (milliseconds since 1970).
pub fn guard(dir: &Path, stamp: u64) -> Vec<StoreRecovery> {
    let mut found = Vec::new();
    for name in STORES {
        let path = dir.join(name);
        let Ok(text) = fs::read(&path).map(|b| String::from_utf8_lossy(&b).to_string()) else {
            continue; // no file (first start) or not readable now: nothing to protect or judge
        };
        if is_valid_store(&text) {
            continue; // never touch a valid file
        }
        let kept = format!("{}{:020}", corrupt_prefix(name), stamp);
        // Put the unreadable file aside first: a copy that stays is the user's data.
        let kept_as = match fs::rename(&path, dir.join(&kept)) {
            Ok(()) => Some(kept),
            Err(e) => {
                log::error!("Couldn't put {name} aside: {e}");
                continue;
            }
        };
        trim_corrupt(dir, name);
        // The last good copy, if it is itself readable.
        let backup = dir.join(format!("{name}.bak"));
        let restored = match fs::read(&backup) {
            Ok(bytes) if is_valid_store(&String::from_utf8_lossy(&bytes)) => write_atomic(&path, &bytes).is_ok(),
            _ => false,
        };
        log::warn!("{name} could not be read; kept as {kept_as:?}, restored from the last good copy: {restored}");
        found.push(StoreRecovery { file: (*name).to_string(), kept_as, restored });
    }
    found
}

/// Makes a good copy of every valid settings file whose copy is missing or
/// older than [`BACKUP_EVERY`]. A file that is not valid is never copied, so a
/// good copy is never replaced by a bad one.
pub fn refresh_backups(dir: &Path, now: SystemTime) -> usize {
    let mut made = 0;
    for name in STORES {
        let path = dir.join(name);
        let Ok(bytes) = fs::read(&path) else { continue };
        if !is_valid_store(&String::from_utf8_lossy(&bytes)) {
            continue;
        }
        let backup = dir.join(format!("{name}.bak"));
        let due = modified(&backup).map_or(true, |t| now.duration_since(t).unwrap_or_default() >= BACKUP_EVERY);
        if due && write_atomic(&backup, &bytes).is_ok() {
            made += 1;
        }
    }
    made
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nexq-store-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    const GOOD: &str = r#"{"onboarding_done":true,"provider":"claude"}"#;
    const BAD: &str = r#"{"onboarding_done":tr"#;

    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir).unwrap().filter_map(Result::ok).map(|e| e.file_name().to_string_lossy().to_string()).collect();
        v.sort();
        v
    }

    #[test]
    fn a_valid_file_is_never_touched() {
        let d = dir("valid");
        fs::write(d.join("config.json"), GOOD).unwrap();
        let before = modified(&d.join("config.json"));
        assert!(guard(&d, 1).is_empty());
        assert_eq!(fs::read_to_string(d.join("config.json")).unwrap(), GOOD);
        assert_eq!(modified(&d.join("config.json")), before);
        assert_eq!(names(&d), vec!["config.json"], "no copy, no leftover");
        // A first start (no files at all) is fine too.
        assert!(guard(&dir("empty"), 1).is_empty());
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn an_unreadable_file_is_kept_aside_and_the_last_good_copy_comes_back() {
        let d = dir("restore");
        fs::write(d.join("config.json"), GOOD).unwrap();
        assert_eq!(refresh_backups(&d, SystemTime::now()), 1);
        fs::write(d.join("config.json"), BAD).unwrap();
        let found = guard(&d, 42);
        assert_eq!(found.len(), 1);
        assert!(found[0].restored && found[0].file == "config.json");
        assert_eq!(fs::read_to_string(d.join("config.json")).unwrap(), GOOD, "defaults did not replace it");
        let kept = found[0].kept_as.clone().unwrap();
        assert_eq!(fs::read_to_string(d.join(&kept)).unwrap(), BAD, "the unreadable bytes are kept for the user");
        assert!(kept.starts_with("config.json.corrupt-"));
        assert!(!names(&d).iter().any(|n| n.ends_with(".tmp")), "the restore was atomic");
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn with_no_good_copy_the_file_is_set_aside_and_reported_as_not_restored() {
        let d = dir("norestore");
        fs::write(d.join("nexq-settings.json"), "").unwrap(); // empty = unreadable
        let found = guard(&d, 7);
        assert_eq!(found[0].restored, false);
        assert!(!d.join("nexq-settings.json").exists());
        assert_eq!(fs::read_to_string(d.join(found[0].kept_as.clone().unwrap())).unwrap(), "");
        // A bad good copy is not used either, and valid JSON that is not an object is unreadable.
        fs::write(d.join("config.json"), "[]").unwrap();
        fs::write(d.join("config.json.bak"), BAD).unwrap();
        let found = guard(&d, 8);
        assert!(!found[0].restored);
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn only_the_newest_three_unreadable_copies_are_kept() {
        let d = dir("trim");
        for stamp in 1..=5u64 {
            fs::write(d.join("config.json"), BAD).unwrap();
            guard(&d, stamp);
        }
        let kept: Vec<String> = names(&d).into_iter().filter(|n| n.starts_with("config.json.corrupt-")).collect();
        assert_eq!(kept.len(), KEEP_CORRUPT);
        assert!(kept[0].ends_with("00000000000000000003") && kept[2].ends_with("00000000000000000005"), "{kept:?}");
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn a_good_copy_is_made_at_most_every_ten_minutes_and_never_from_a_bad_file() {
        let d = dir("backup");
        fs::write(d.join("config.json"), GOOD).unwrap();
        let t0 = SystemTime::now();
        assert_eq!(refresh_backups(&d, t0), 1);
        // Within ten minutes: nothing new.
        fs::write(d.join("config.json"), r#"{"changed":1}"#).unwrap();
        assert_eq!(refresh_backups(&d, t0 + Duration::from_secs(5 * 60)), 0);
        assert_eq!(fs::read_to_string(d.join("config.json.bak")).unwrap(), GOOD);
        // After ten minutes: refreshed.
        assert_eq!(refresh_backups(&d, t0 + BACKUP_EVERY + Duration::from_secs(1)), 1);
        assert_eq!(fs::read_to_string(d.join("config.json.bak")).unwrap(), r#"{"changed":1}"#);
        // A file that has gone bad never replaces the good copy, however old it is.
        fs::write(d.join("config.json"), BAD).unwrap();
        assert_eq!(refresh_backups(&d, t0 + Duration::from_secs(3600)), 0);
        assert_eq!(fs::read_to_string(d.join("config.json.bak")).unwrap(), r#"{"changed":1}"#);
        assert!(!names(&d).iter().any(|n| n.ends_with(".tmp")));
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn every_store_the_app_keeps_is_listed() {
        for name in ["config.json", "nexq-settings.json", "translation-config.json"] {
            assert!(STORES.contains(&name), "{name}");
        }
    }
}
