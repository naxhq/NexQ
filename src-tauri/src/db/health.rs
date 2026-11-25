//! Opening the database safely. When the file can't be used (damaged, written
//! by a newer NexQ, in use by another program), nothing is created, upgraded or
//! overwritten: the app starts without it, says why, and offers the copies it
//! already has. A recovery puts the old files aside under new names (it never
//! deletes) and is finished on the next start even if the power went out
//! between its steps.

use std::fs;
use std::io::Read;
use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};

pub const DB_NAME: &str = "nexq.db";
const MARKER: &str = "nexq.db.pending-restore";
const RESTORE_TMP: &str = "nexq.db.restore-tmp";
const MAGIC: &[u8; 16] = b"SQLite format 3\0";
const PROBE_WAIT: Duration = Duration::from_millis(500);

/// Why the database could not be opened (`db.kind` of `get_workspaces_status`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProblemKind {
    Unreadable,
    Newer,
    UpgradeFailed,
    Locked,
}

/// A database copy the app can restore from (opened read-only and checked first).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackupInfo {
    pub name: String,
    /// When the copy was made (epoch ms).
    pub created_at: i64,
    pub bytes: u64,
    /// How many meetings it holds (None when that can't be told).
    pub meetings: Option<i64>,
}

/// The database did not open: why, where it is, and what can be restored.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DbProblem {
    pub kind: ProblemKind,
    pub message: String,
    pub path: String,
    pub backups: Vec<BackupInfo>,
}

/// The version number of the newest schema step this build knows.
pub fn top_version() -> i64 {
    super::workspace_migrations::STEPS.iter().map(|s| s.version).max().unwrap_or(0)
}

fn map_sqlite(e: &rusqlite::Error) -> ProblemKind {
    match e.sqlite_error_code() {
        Some(rusqlite::ErrorCode::DatabaseBusy) | Some(rusqlite::ErrorCode::DatabaseLocked) => ProblemKind::Locked,
        _ => ProblemKind::Unreadable,
    }
}

/// The header of an SQLite file says it is whole: the right magic, and the
/// file at least as long as the page count it records.
fn header_problem(path: &Path, len: u64) -> Option<String> {
    let mut head = [0u8; 100];
    let read = fs::File::open(path).and_then(|mut f| f.read_exact(&mut head));
    if read.is_err() {
        return Some("The file is too short to be a database.".to_string());
    }
    if &head[..16] != MAGIC {
        return Some("The file is not an SQLite database.".to_string());
    }
    let page_size = match u16::from_be_bytes([head[16], head[17]]) {
        1 => 65_536u64,
        n => n as u64,
    };
    let pages = u32::from_be_bytes([head[28], head[29], head[30], head[31]]) as u64;
    // The page count is only trusted when the header says it is current.
    let current = head[24..28] == head[92..96];
    // A stop during a checkpoint leaves a short file whose missing pages are
    // still in the -wal: SQLite completes it, so that is not a damaged file.
    let has_wal = fs::metadata(path.with_file_name(format!("{}-wal", path.file_name().unwrap_or_default().to_string_lossy())))
        .map(|m| m.len() > 0)
        .unwrap_or(false);
    if !has_wal && current && pages > 0 && len < pages * page_size {
        return Some("The file is cut short: part of it is missing.".to_string());
    }
    None
}

/// Looks at the file without changing it: `Ok` when it is absent (a first
/// start), empty, or an SQLite database this build can use.
pub fn probe(path: &Path) -> Result<(), (ProblemKind, String)> {
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err((ProblemKind::Locked, format!("The file can't be read: {e}."))),
    };
    if meta.len() == 0 {
        // A first start that stopped early, unless there were meetings before.
        let had_meetings = path.parent().map(|d| list_backups(d).iter().any(|b| b.meetings.unwrap_or(0) > 0)).unwrap_or(false);
        if had_meetings {
            return Err((ProblemKind::Unreadable, "The file is empty.".to_string()));
        }
        return Ok(());
    }
    if let Some(why) = header_problem(path, meta.len()) {
        return Err((ProblemKind::Unreadable, why));
    }
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|e| (map_sqlite(&e), format!("The database can't be opened: {e}.")))?;
    conn.busy_timeout(PROBE_WAIT).map_err(|e| (map_sqlite(&e), e.to_string()))?;
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| (map_sqlite(&e), format!("The database can't be read: {e}.")))?;
    conn.query_row("SELECT COUNT(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0))
        .map_err(|e| (map_sqlite(&e), format!("The database can't be read: {e}.")))?;
    if version > top_version() {
        return Err((
            ProblemKind::Newer,
            format!("Your meetings were saved by a newer NexQ (data version {version}; this one understands up to {})", top_version()),
        ));
    }
    Ok(())
}

fn millis(t: std::time::SystemTime) -> i64 {
    t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Opens a copy read-only and checks it; `Some(meetings)` when it is whole and
/// of a version this build understands.
fn inspect(path: &Path) -> Option<Option<i64>> {
    let len = fs::metadata(path).ok()?.len();
    if len == 0 || header_problem(path, len).is_some() {
        return None;
    }
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).ok()?;
    conn.busy_timeout(PROBE_WAIT).ok()?;
    let check: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0)).ok()?;
    if check != "ok" {
        return None;
    }
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).ok()?;
    if version > top_version() {
        return None;
    }
    Some(conn.query_row("SELECT COUNT(*) FROM meetings", [], |r| r.get::<_, i64>(0)).ok())
}

fn is_copy_name(name: &str) -> bool {
    if name == RESTORE_TMP || name.ends_with("-wal") || name.ends_with("-shm") {
        return false;
    }
    ((name.starts_with("nexq-before-") || name.starts_with("nexq-backup-")) && name.ends_with(".db"))
        || name.starts_with("nexq.db.damaged-")
}

/// The copies of the database in `dir` that open and check out, newest first.
pub fn list_backups(dir: &Path) -> Vec<BackupInfo> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<BackupInfo> = entries
        .filter_map(Result::ok)
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if !is_copy_name(&name) || !e.path().is_file() {
                return None;
            }
            let meta = e.metadata().ok()?;
            let meetings = inspect(&e.path())?;
            Some(BackupInfo { name, created_at: meta.modified().map(millis).unwrap_or(0), bytes: meta.len(), meetings })
        })
        .collect();
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(a.name.cmp(&b.name)));
    out
}

/// What the app shows for a database that did not open.
pub fn problem(kind: ProblemKind, message: String, dir: &Path) -> DbProblem {
    DbProblem { kind, message, path: dir.join(DB_NAME).to_string_lossy().to_string(), backups: list_backups(dir) }
}

// ── Recovery: put aside, then restore or start new ───────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Pending {
    /// `restore` or `new`.
    action: String,
    /// The copy to restore (a name in the data folder).
    source: Option<String>,
    stamp: u64,
}

fn aside_name(stamp: u64, suffix: &str) -> String {
    format!("{DB_NAME}.damaged-{stamp}{suffix}")
}

/// Restores from the copy `name`, which must be one the app lists. The old
/// files are put aside, not deleted. Finishing is idempotent (see
/// [`resume_pending`]); the app restarts afterwards.
pub fn restore_copy(dir: &Path, name: &str, stamp: u64) -> Result<(), String> {
    if !list_backups(dir).iter().any(|b| b.name == name) {
        return Err("That copy is not one NexQ can restore from".to_string());
    }
    write_marker(dir, &Pending { action: "restore".into(), source: Some(name.to_string()), stamp })?;
    resume_pending(dir).map(|_| ())
}

/// Puts the old files aside and lets the next start make an empty database.
pub fn start_new(dir: &Path, stamp: u64) -> Result<(), String> {
    write_marker(dir, &Pending { action: "new".into(), source: None, stamp })?;
    resume_pending(dir).map(|_| ())
}

fn write_marker(dir: &Path, pending: &Pending) -> Result<(), String> {
    if dir.join(MARKER).exists() {
        return Err("An earlier recovery is still being finished. Restart NexQ".to_string());
    }
    let text = serde_json::to_string(pending).map_err(|e| e.to_string())?;
    crate::store_guard::write_atomic(&dir.join(MARKER), text.as_bytes()).map_err(|e| format!("Couldn't start the recovery: {e}"))
}

/// Finishes a recovery a previous run began (or this one just recorded):
/// every step checks what is already done, so it can be run again after a stop
/// anywhere. Returns whether there was one.
pub fn resume_pending(dir: &Path) -> Result<bool, String> {
    run_pending(dir, None)
}

/// Steps of a recovery, numbered so a test can stop after one.
fn run_pending(dir: &Path, stop_after: Option<u8>) -> Result<bool, String> {
    let marker = dir.join(MARKER);
    let Ok(text) = fs::read_to_string(&marker) else { return Ok(false) };
    let pending: Pending = match serde_json::from_str(&text) {
        Ok(p) => p,
        Err(e) => {
            // Notes are written whole, so nothing was begun under this one.
            // It is put aside, or every later start would stop here.
            log::error!("The recovery note can't be read: {e}");
            fs::rename(&marker, dir.join(format!("{MARKER}.bad-{}", stamp_now()))).map_err(|e| format!("Couldn't put the recovery note aside: {e}"))?;
            return Ok(false);
        }
    };
    let stopped = |step: u8| stop_after == Some(step);

    // 1. Put the old files aside (never deleted). The database itself goes
    //    last: once it is aside, what stands in its place is the new one, whose
    //    -wal and -shm are not touched if this runs again.
    if !dir.join(aside_name(pending.stamp, "")).exists() {
        for suffix in ["-wal", "-shm", ""] {
            let from = dir.join(format!("{DB_NAME}{suffix}"));
            let to = dir.join(aside_name(pending.stamp, suffix));
            if from.exists() && !to.exists() {
                fs::rename(&from, &to).map_err(|e| format!("Couldn't put {DB_NAME}{suffix} aside: {e}"))?;
            }
        }
    }
    if stopped(1) {
        return Err("stopped".into());
    }
    if pending.action == "restore" {
        let target = dir.join(DB_NAME);
        if !target.exists() {
            let source = pending.source.as_deref().ok_or("The recovery note names no copy")?;
            let tmp = dir.join(RESTORE_TMP);
            let _ = fs::remove_file(&tmp);
            // 2. A whole, consistent copy next to its destination.
            if let Err(e) = copy_whole(&dir.join(source), &tmp) {
                let _ = fs::remove_file(&tmp);
                rollback(dir, &pending);
                return Err(format!("Couldn't restore from {source}: {e}"));
            }
            if stopped(2) {
                return Err("stopped".into());
            }
            // 3. Into place in one step.
            fs::rename(&tmp, &target).map_err(|e| format!("Couldn't put the copy in place: {e}"))?;
            if stopped(3) {
                return Err("stopped".into());
            }
        }
    }
    // 4. Done.
    fs::remove_file(&marker).map_err(|e| format!("Couldn't finish the recovery: {e}"))?;
    Ok(true)
}

/// The old files go back where they were, and the recovery is dropped.
fn rollback(dir: &Path, pending: &Pending) {
    if !dir.join(DB_NAME).exists() {
        for suffix in ["", "-wal", "-shm"] {
            let from = dir.join(aside_name(pending.stamp, suffix));
            let to = dir.join(format!("{DB_NAME}{suffix}"));
            if from.exists() && !to.exists() {
                let _ = fs::rename(&from, &to);
            }
        }
    }
    let _ = fs::remove_file(dir.join(MARKER));
}

/// A consistent single-file copy of `source` (its own -wal included) at `dest`.
fn copy_whole(source: &Path, dest: &Path) -> Result<(), String> {
    if inspect(source).is_none() {
        return Err("it is not a whole database".to_string());
    }
    {
        let conn = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(|e| e.to_string())?;
        conn.busy_timeout(PROBE_WAIT).map_err(|e| e.to_string())?;
        conn.execute("VACUUM INTO ?1", [dest.to_string_lossy().as_ref()]).map_err(|e| e.to_string())?;
    }
    // Flushed to disk before it is renamed into place (a write handle: Windows needs one to flush).
    fs::OpenOptions::new().write(true).open(dest).and_then(|f| f.sync_all()).map_err(|e| e.to_string())?;
    if inspect(dest).is_none() {
        return Err("the copy did not check out".to_string());
    }
    Ok(())
}

/// A name for the put-aside files: milliseconds since 1970.
pub fn stamp_now() -> u64 {
    millis(std::time::SystemTime::now()).max(0) as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nexq-health-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// A real database file with `n` meetings (no WAL), at `user_version`.
    fn make_db(path: &Path, meetings: i64, version: i64) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch("CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT, pad TEXT)").unwrap();
        for i in 0..meetings {
            conn.execute("INSERT INTO meetings VALUES (?1, 't', ?2)", rusqlite::params![format!("m{i}"), "x".repeat(2000)]).unwrap();
        }
        conn.execute_batch(&format!("PRAGMA user_version = {version}")).unwrap();
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir).unwrap().filter_map(Result::ok).map(|e| e.file_name().to_string_lossy().to_string()).collect();
        v.sort();
        v
    }

    #[test]
    fn a_missing_empty_or_normal_database_passes_and_is_left_untouched() {
        let d = dir("normal");
        let path = d.join(DB_NAME);
        assert!(probe(&path).is_ok(), "a first start");
        fs::write(&path, b"").unwrap();
        assert!(probe(&path).is_ok(), "an empty file is a valid empty database");
        fs::remove_file(&path).unwrap();
        make_db(&path, 3, 15);
        let before = fs::read(&path).unwrap();
        let listing = names(&d);
        assert!(probe(&path).is_ok());
        assert_eq!(fs::read(&path).unwrap(), before, "not a byte changed");
        assert_eq!(names(&d), listing, "nothing was created beside it");
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn random_bytes_a_wrong_header_and_a_truncated_file_are_unreadable() {
        let d = dir("bad");
        let path = d.join(DB_NAME);
        let noise: Vec<u8> = (0..8192u32).map(|i| (i.wrapping_mul(2654435761) >> 13) as u8).collect();
        fs::write(&path, &noise).unwrap();
        assert_eq!(probe(&path).unwrap_err().0, ProblemKind::Unreadable);
        // Too short to hold a header.
        fs::write(&path, b"SQLite format 3\0abc").unwrap();
        assert_eq!(probe(&path).unwrap_err().0, ProblemKind::Unreadable);
        // A database whose first bytes were overwritten.
        fs::remove_file(&path).unwrap();
        make_db(&path, 20, 15);
        let mut bytes = fs::read(&path).unwrap();
        bytes[..16].copy_from_slice(b"NOT a database\0\0");
        fs::write(&path, &bytes).unwrap();
        assert_eq!(probe(&path).unwrap_err().0, ProblemKind::Unreadable);
        // A database cut short.
        fs::remove_file(&path).unwrap();
        make_db(&path, 40, 15);
        let whole = fs::read(&path).unwrap();
        fs::write(&path, &whole[..whole.len() / 2]).unwrap();
        let (kind, why) = probe(&path).unwrap_err();
        assert_eq!(kind, ProblemKind::Unreadable);
        assert!(why.contains("cut short"), "{why}");
        // None of this changed the file or made another one.
        assert_eq!(fs::read(&path).unwrap().len(), whole.len() / 2);
        assert_eq!(names(&d), vec![DB_NAME]);
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn a_database_from_a_newer_version_is_reported_and_not_touched() {
        let d = dir("newer");
        let path = d.join(DB_NAME);
        make_db(&path, 2, top_version() + 5);
        let before = fs::read(&path).unwrap();
        let (kind, why) = probe(&path).unwrap_err();
        assert_eq!(kind, ProblemKind::Newer);
        assert!(why.contains("newer NexQ"));
        assert_eq!(fs::read(&path).unwrap(), before);
        make_db(&d.join("ok.db"), 1, top_version());
        assert!(probe(&d.join("ok.db")).is_ok(), "the same version is fine");
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn a_database_held_by_another_program_is_locked() {
        let d = dir("locked");
        let path = d.join(DB_NAME);
        make_db(&path, 2, 15);
        let holder = Connection::open(&path).unwrap();
        holder.execute_batch("BEGIN EXCLUSIVE").unwrap();
        let (kind, _) = probe(&path).unwrap_err();
        assert_eq!(kind, ProblemKind::Locked);
        holder.execute_batch("ROLLBACK").unwrap();
        assert!(probe(&path).is_ok(), "free again");
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn only_copies_that_check_out_are_offered_newest_first() {
        let d = dir("list");
        make_db(&d.join("nexq-before-workspaces.db"), 7, 8);
        make_db(&d.join("nexq-backup-2026.db"), 3, top_version());
        // Damaged copies are not offered: noise, a cut-short copy, one from a newer version.
        fs::write(d.join("nexq-before-broken.db"), vec![9u8; 5000]).unwrap();
        make_db(&d.join("nexq-backup-cut.db"), 40, 8);
        let whole = fs::read(d.join("nexq-backup-cut.db")).unwrap();
        fs::write(d.join("nexq-backup-cut.db"), &whole[..whole.len() / 3]).unwrap();
        make_db(&d.join("nexq-backup-future.db"), 1, top_version() + 1);
        // A copy whose pages are damaged inside (the quick check fails).
        make_db(&d.join("nexq-backup-rot.db"), 60, 8);
        let mut rot = fs::read(d.join("nexq-backup-rot.db")).unwrap();
        for b in rot[4096..8192].iter_mut() {
            *b = 0xAB;
        }
        fs::write(d.join("nexq-backup-rot.db"), &rot).unwrap();
        // Not copies at all.
        fs::write(d.join("nexq.db"), b"live").unwrap();
        fs::write(d.join("notes.db"), b"x").unwrap();
        let offered: Vec<String> = list_backups(&d).into_iter().map(|b| b.name).collect();
        let mut sorted = offered.clone();
        sorted.sort();
        assert_eq!(sorted, vec!["nexq-backup-2026.db", "nexq-before-workspaces.db"], "{offered:?}");
        let info = list_backups(&d).into_iter().find(|b| b.name == "nexq-before-workspaces.db").unwrap();
        assert_eq!(info.meetings, Some(7));
        assert!(info.bytes > 0 && info.created_at > 0);
        // No copies at all: nothing offered.
        assert!(list_backups(&dir("none")).is_empty());
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn restoring_puts_all_three_files_aside_and_brings_the_copy_in() {
        let d = dir("restore");
        fs::write(d.join(DB_NAME), b"damaged main").unwrap();
        fs::write(d.join("nexq.db-wal"), b"damaged wal").unwrap();
        fs::write(d.join("nexq.db-shm"), b"damaged shm").unwrap();
        make_db(&d.join("nexq-before-workspaces.db"), 5, 8);
        restore_copy(&d, "nexq-before-workspaces.db", 1234).unwrap();
        // The old files are all kept, under one stamp.
        assert_eq!(fs::read(d.join("nexq.db.damaged-1234")).unwrap(), b"damaged main");
        assert_eq!(fs::read(d.join("nexq.db.damaged-1234-wal")).unwrap(), b"damaged wal");
        assert_eq!(fs::read(d.join("nexq.db.damaged-1234-shm")).unwrap(), b"damaged shm");
        assert!(!d.join("nexq.db-wal").exists() && !d.join("nexq.db-shm").exists());
        // The copy is in as nexq.db, whole, and the source copy is still there.
        assert!(probe(&d.join(DB_NAME)).is_ok());
        let meetings: i64 = Connection::open(d.join(DB_NAME)).unwrap().query_row("SELECT COUNT(*) FROM meetings", [], |r| r.get(0)).unwrap();
        assert_eq!(meetings, 5);
        assert!(d.join("nexq-before-workspaces.db").exists());
        assert!(!d.join(MARKER).exists() && !d.join(RESTORE_TMP).exists(), "nothing half done is left");
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn only_a_listed_name_can_be_restored_never_a_path() {
        let d = dir("names");
        fs::write(d.join(DB_NAME), b"damaged").unwrap();
        make_db(&d.join("nexq-before-workspaces.db"), 1, 8);
        for bad in ["../nexq-before-workspaces.db", "nexq-before-nothing.db", "nexq.db", "C:\\Windows\\x.db", "", "nexq-before-workspaces.db/.."] {
            assert!(restore_copy(&d, bad, 1).is_err(), "{bad:?}");
        }
        // A damaged copy is refused too, and the damaged file stayed where it was.
        fs::write(d.join("nexq-backup-bad.db"), b"junk").unwrap();
        assert!(restore_copy(&d, "nexq-backup-bad.db", 1).is_err());
        assert_eq!(fs::read(d.join(DB_NAME)).unwrap(), b"damaged");
        assert!(!d.join(MARKER).exists());
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn a_stop_between_any_two_steps_is_finished_on_the_next_start_exactly_once() {
        for stop in [1u8, 2, 3] {
            let d = dir(&format!("cut{stop}"));
            fs::write(d.join(DB_NAME), b"damaged main").unwrap();
            fs::write(d.join("nexq.db-wal"), b"damaged wal").unwrap();
            make_db(&d.join("nexq-before-workspaces.db"), 4, 8);
            write_marker(&d, &Pending { action: "restore".into(), source: Some("nexq-before-workspaces.db".into()), stamp: 99 }).unwrap();
            assert!(run_pending(&d, Some(stop)).is_err(), "stopped after step {stop}");
            // The next start finishes it, and finishing again changes nothing.
            assert_eq!(resume_pending(&d), Ok(true));
            assert_eq!(resume_pending(&d), Ok(false));
            let count: i64 = Connection::open(d.join(DB_NAME)).unwrap().query_row("SELECT COUNT(*) FROM meetings", [], |r| r.get(0)).unwrap();
            assert_eq!(count, 4, "stop {stop}");
            assert_eq!(fs::read(d.join("nexq.db.damaged-99")).unwrap(), b"damaged main", "stop {stop}");
            assert_eq!(fs::read(d.join("nexq.db.damaged-99-wal")).unwrap(), b"damaged wal");
            let asides = names(&d).into_iter().filter(|n| n.contains(".damaged-")).count();
            assert_eq!(asides, 2, "put aside once, never twice (stop {stop})");
            assert!(!d.join(MARKER).exists() && !d.join(RESTORE_TMP).exists());
            let _ = fs::remove_dir_all(d);
        }
    }

    #[test]
    fn a_copy_that_disappears_before_the_restore_finishes_puts_the_old_files_back() {
        let d = dir("gone");
        fs::write(d.join(DB_NAME), b"damaged main").unwrap();
        make_db(&d.join("nexq-before-workspaces.db"), 2, 8);
        write_marker(&d, &Pending { action: "restore".into(), source: Some("nexq-before-workspaces.db".into()), stamp: 5 }).unwrap();
        assert!(run_pending(&d, Some(1)).is_err());
        fs::remove_file(d.join("nexq-before-workspaces.db")).unwrap();
        assert!(resume_pending(&d).is_err());
        assert_eq!(fs::read(d.join(DB_NAME)).unwrap(), b"damaged main", "back where it was");
        assert!(!d.join(MARKER).exists() && !d.join("nexq.db.damaged-5").exists());
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn starting_new_puts_everything_aside_and_leaves_no_database_for_the_next_start_to_create() {
        let d = dir("new");
        fs::write(d.join(DB_NAME), b"damaged main").unwrap();
        fs::write(d.join("nexq.db-shm"), b"shm").unwrap();
        start_new(&d, 321).unwrap();
        assert!(!d.join(DB_NAME).exists() && !d.join("nexq.db-shm").exists());
        assert_eq!(fs::read(d.join("nexq.db.damaged-321")).unwrap(), b"damaged main");
        assert_eq!(fs::read(d.join("nexq.db.damaged-321-shm")).unwrap(), b"shm");
        assert!(!d.join(MARKER).exists());
        // A stop in the middle is finished the same way.
        let e = dir("new-cut");
        fs::write(e.join(DB_NAME), b"main").unwrap();
        fs::write(e.join("nexq.db-wal"), b"wal").unwrap();
        write_marker(&e, &Pending { action: "new".into(), source: None, stamp: 8 }).unwrap();
        assert!(run_pending(&e, Some(1)).is_err());
        assert_eq!(resume_pending(&e), Ok(true));
        assert!(!e.join(DB_NAME).exists() && e.join("nexq.db.damaged-8-wal").exists());
        let _ = fs::remove_dir_all(d);
        let _ = fs::remove_dir_all(e);
    }

    #[test]
    fn a_restore_includes_what_a_copys_own_wal_holds() {
        let d = dir("wal");
        let copy = d.join("nexq.db.damaged-1");
        make_db(&copy, 1, 8);
        {
            // A write that only lives in the copy's -wal (named like its aside set).
            let conn = Connection::open(&copy).unwrap();
            conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;").unwrap();
            conn.execute("INSERT INTO meetings VALUES ('late', 't', '')", []).unwrap();
            std::mem::forget(conn); // leave the -wal in place, as a crash would
        }
        let shown = list_backups(&d);
        assert_eq!(shown.len(), 1);
        assert_eq!(shown[0].meetings, Some(2), "the copy is read with its -wal");
        fs::write(d.join(DB_NAME), b"damaged").unwrap();
        restore_copy(&d, "nexq.db.damaged-1", 2).unwrap();
        let n: i64 = Connection::open(d.join(DB_NAME)).unwrap().query_row("SELECT COUNT(*) FROM meetings", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2);
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn a_short_file_with_its_wal_is_left_to_sqlite() {
        let d = dir("short-wal");
        let db = d.join(DB_NAME);
        make_db(&db, 40, top_version());
        let len = fs::metadata(&db).unwrap().len();
        assert!(header_problem(&db, len).is_none());
        assert!(header_problem(&db, len - 4096).is_some(), "short with no wal");
        fs::write(d.join(format!("{DB_NAME}-wal")), [1u8; 64]).unwrap();
        assert!(header_problem(&db, len - 4096).is_none(), "its missing pages may be in the wal");
    }

    #[test]
    fn running_a_finished_recovery_again_never_touches_the_new_files() {
        let d = dir("again");
        fs::write(d.join(DB_NAME), b"garbage").unwrap();
        let pending = Pending { action: "new".into(), source: None, stamp: 7 };
        let note = serde_json::to_string(&pending).unwrap();
        fs::write(d.join(MARKER), &note).unwrap();
        assert_eq!(resume_pending(&d), Ok(true));
        // the note came back (its removal was lost) and the new database has a wal by now
        fs::write(d.join(MARKER), &note).unwrap();
        fs::write(d.join(DB_NAME), b"new").unwrap();
        fs::write(d.join(format!("{DB_NAME}-wal")), b"new wal").unwrap();
        assert_eq!(resume_pending(&d), Ok(true));
        assert_eq!(fs::read(d.join(DB_NAME)).unwrap(), b"new");
        assert_eq!(fs::read(d.join(format!("{DB_NAME}-wal"))).unwrap(), b"new wal");
    }

    #[test]
    fn a_note_that_cannot_be_read_does_not_stop_every_start() {
        let d = dir("bad-note");
        fs::write(d.join(MARKER), b"{").unwrap();
        assert_eq!(resume_pending(&d), Ok(false));
        assert!(!d.join(MARKER).exists());
        assert!(names(&d).iter().any(|n| n.contains(".bad-")), "kept aside");
    }

    #[test]
    fn an_empty_file_is_a_first_start_only_when_there_were_no_meetings() {
        let d = dir("empty");
        fs::write(d.join(DB_NAME), b"").unwrap();
        assert!(probe(&d.join(DB_NAME)).is_ok());
        make_db(&d.join("nexq-before-workspaces.db"), 3, top_version());
        assert_eq!(probe(&d.join(DB_NAME)).unwrap_err().0, ProblemKind::Unreadable);
    }
}
