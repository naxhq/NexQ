//! A quiet look at the live database's own consistency (`PRAGMA quick_check`), read-only.
//!
//! * After start, in the background, at most once a day (remembered in `db-integrity.json`
//!   in the data folder, never in the database that may be the damaged one).
//! * Never during a meeting or while a recording is saved: not started then, and a running
//!   check is interrupted when one begins (it is tried again later, nothing is recorded).
//! * On damage: logged, `db_integrity_problem` emitted, `get_db_integrity` answers. Nothing is
//!   changed or repaired; the notice only says the file has damage and where the copies are.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};

use super::health::{self, BackupInfo};

/// One full check a day.
pub const EVERY_MS: i64 = 24 * 60 * 60 * 1000;
/// After start, so the check never competes with startup.
pub const START_DELAY: Duration = Duration::from_secs(120);

/// A check is wanted now: the first pass runs without the usual delay and without the daily memo.
static CHECK_SOON: AtomicBool = AtomicBool::new(false);

/// Asks for a check right after start (an open that SQLite had to make sense of).
pub fn check_soon() {
    CHECK_SOON.store(true, Ordering::SeqCst);
}
/// How often a skipped check (a meeting was running) is looked at again.
pub const RETRY_EVERY: Duration = Duration::from_secs(30 * 60);
const MEMO_FILE: &str = "db-integrity.json";
const MAX_DETAIL_LINES: usize = 5;

/// What the check found, as the launcher shows it. `get_db_integrity` and the
/// `db_integrity_problem` event carry this.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IntegrityFinding {
    /// One plain sentence.
    pub message: String,
    /// The first lines SQLite reported.
    pub details: Vec<String>,
    /// Epoch ms of the check.
    pub checked_at: i64,
    /// The data folder, where the file and its copies are.
    pub folder: String,
    /// Copies that open and check out.
    pub copies: Vec<BackupInfo>,
}

/// What is remembered between starts.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Memo {
    /// Epoch ms of the last completed check.
    pub checked_at: i64,
    /// The finding of that check; `None` when the file was fine.
    pub finding: Option<IntegrityFinding>,
}

static CURRENT: Mutex<Option<IntegrityFinding>> = Mutex::new(None);

/// The damage found this run (or remembered from the last check), if any.
pub fn current() -> Option<IntegrityFinding> {
    CURRENT.lock().ok().and_then(|f| f.clone())
}

fn set_current(finding: Option<IntegrityFinding>) {
    if let Ok(mut f) = CURRENT.lock() {
        *f = finding;
    }
}

pub fn load_memo(dir: &Path) -> Option<Memo> {
    let text = std::fs::read_to_string(dir.join(MEMO_FILE)).ok()?;
    serde_json::from_str(&text).ok()
}

fn save_memo(dir: &Path, memo: &Memo) {
    if let Ok(text) = serde_json::to_string_pretty(memo) {
        if let Err(e) = std::fs::write(dir.join(MEMO_FILE), text) {
            log::warn!("The database check could not be remembered: {e}");
        }
    }
}

/// A restore or a new database makes what was remembered stale.
pub fn forget(dir: &Path) {
    let _ = std::fs::remove_file(dir.join(MEMO_FILE));
    set_current(None);
}

/// Whether a check is due: none yet, or the last one is a day old (a clock that went
/// back counts as due).
pub fn due(memo: Option<&Memo>, now_ms: i64) -> bool {
    match memo {
        None => true,
        Some(m) => m.checked_at > now_ms || now_ms - m.checked_at >= EVERY_MS,
    }
}

/// Runs `PRAGMA quick_check` on `path`, read-only. `Ok(lines)` is what SQLite said (`["ok"]` when whole);
/// `Err(None)` when it was stopped by `stop` (try later), `Err(Some(why))` when it could not be run.
pub fn quick_check(path: &Path, stop: &AtomicBool) -> Result<Vec<String>, Option<String>> {
    if stop.load(Ordering::SeqCst) {
        return Err(None);
    }
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|e| Some(e.to_string()))?;
    conn.busy_timeout(Duration::from_secs(2)).map_err(|e| Some(e.to_string()))?;
    let handle = conn.get_interrupt_handle();
    let done = AtomicBool::new(false);
    let result = std::thread::scope(|scope| {
        // Interrupts the check as soon as `stop` is set (a meeting began).
        scope.spawn(|| {
            while !done.load(Ordering::SeqCst) {
                if stop.load(Ordering::SeqCst) {
                    handle.interrupt();
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        });
        let run = (|| -> rusqlite::Result<Vec<String>> {
            let mut stmt = conn.prepare("PRAGMA quick_check")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            rows.collect()
        })();
        done.store(true, Ordering::SeqCst);
        run
    });
    match result {
        Ok(lines) => Ok(lines),
        Err(_) if stop.load(Ordering::SeqCst) => Err(None),
        // Real damage often stops the check with an error instead of listing rows: that is the finding.
        Err(e) if matches!(e.sqlite_error_code(), Some(rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase)) => {
            Ok(vec![e.to_string()])
        }
        Err(e) => Err(Some(e.to_string())),
    }
}

/// The finding for `lines`, or `None` when SQLite said `ok`.
pub fn finding_of(lines: &[String], dir: &Path, now_ms: i64) -> Option<IntegrityFinding> {
    if lines.len() == 1 && lines[0] == "ok" {
        return None;
    }
    Some(IntegrityFinding {
        message: "A check of your meetings file found damage.".to_string(),
        details: lines.iter().take(MAX_DETAIL_LINES).cloned().collect(),
        checked_at: now_ms,
        folder: dir.to_string_lossy().to_string(),
        copies: health::list_backups(dir),
    })
}

/// What one pass did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Pass {
    /// Not due, or a meeting or recording is running: nothing was looked at.
    Skipped,
    /// Stopped by a meeting, or SQLite could not run it: nothing recorded, tried again later.
    Incomplete,
    /// Done: the damage found, or `None` when the file is whole. Remembered for a day.
    Checked(Option<IntegrityFinding>),
}

/// One pass: skip when not due or `busy`, else check and remember.
pub fn run_once(dir: &Path, now_ms: i64, busy: &AtomicBool) -> Pass {
    if !(CHECK_SOON.load(Ordering::SeqCst) || due(load_memo(dir).as_ref(), now_ms)) || busy.load(Ordering::SeqCst) {
        return Pass::Skipped;
    }
    match quick_check(&dir.join(health::DB_NAME), busy) {
        Ok(lines) => {
            let finding = finding_of(&lines, dir, now_ms);
            match &finding {
                Some(f) => log::error!("The database check found damage: {:?}", f.details),
                None => log::info!("The database check passed"),
            }
            save_memo(dir, &Memo { checked_at: now_ms, finding: finding.clone() });
            CHECK_SOON.store(false, Ordering::SeqCst);
            Pass::Checked(finding)
        }
        Err(None) => {
            log::info!("The database check was stopped (a meeting began); it will run later");
            Pass::Incomplete
        }
        Err(Some(why)) => {
            log::warn!("The database check could not run: {why}");
            Pass::Incomplete
        }
    }
}

/// Starts the background check: the last finding is shown at once, then a pass runs after
/// a delay and again every half hour until one completes, then daily while NexQ stays open.
/// `busy` is true during a meeting or while a recording is saved; `on_damage` announces a finding.
pub fn spawn(
    dir: std::path::PathBuf,
    busy: impl Fn() -> bool + Send + Sync + 'static,
    on_damage: impl Fn(&IntegrityFinding) + Send + Sync + 'static,
) {
    set_current(load_memo(&dir).and_then(|m| m.finding));
    tauri::async_runtime::spawn(async move {
        if !CHECK_SOON.load(Ordering::SeqCst) {
            tokio::time::sleep(START_DELAY).await;
        }
        let busy = std::sync::Arc::new(busy);
        loop {
            let (d, b) = (dir.clone(), busy.clone());
            let stop = std::sync::Arc::new(AtomicBool::new(b()));
            let flag = stop.clone();
            // A pass is quick to skip; a real check runs on a thread of its own and stops when a meeting starts.
            let watcher = tokio::spawn(async move {
                loop {
                    if b() {
                        flag.store(true, Ordering::SeqCst);
                    }
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
            });
            let d2 = d.clone();
            let flag = stop.clone();
            let pass = tokio::task::spawn_blocking(move || run_once(&d2, now_ms(), &flag)).await;
            watcher.abort();
            match pass {
                Ok(Pass::Checked(finding)) => {
                    if let Some(f) = &finding {
                        on_damage(f);
                    }
                    set_current(finding);
                }
                Ok(Pass::Incomplete) | Ok(Pass::Skipped) | Err(_) => {}
            }
            tokio::time::sleep(RETRY_EVERY).await;
        }
    });
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("nexq-integrity-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn whole_db(dir: &Path) {
        let conn = Connection::open(dir.join(health::DB_NAME)).unwrap();
        conn.execute_batch("CREATE TABLE meetings (id TEXT PRIMARY KEY, t TEXT); CREATE INDEX i ON meetings(t); INSERT INTO meetings VALUES ('a','x');")
            .unwrap();
    }

    /// An index whose root page does not exist: `quick_check` reports it.
    fn damage(dir: &Path) {
        let conn = Connection::open(dir.join(health::DB_NAME)).unwrap();
        conn.execute_batch("PRAGMA writable_schema=ON; UPDATE sqlite_master SET rootpage = 99 WHERE name = 'i';").unwrap();
    }

    #[test]
    fn due_once_a_day_and_when_the_clock_went_back() {
        assert!(due(None, 1_000));
        let m = Memo { checked_at: 1_000, finding: None };
        assert!(!due(Some(&m), 1_000 + EVERY_MS - 1));
        assert!(due(Some(&m), 1_000 + EVERY_MS));
        assert!(due(Some(&m), 500));
    }

    #[test]
    fn a_whole_file_passes_is_remembered_and_is_not_checked_again_the_same_day() {
        let d = temp_dir("whole");
        whole_db(&d);
        let busy = AtomicBool::new(false);
        assert_eq!(run_once(&d, 10_000, &busy), Pass::Checked(None));
        assert_eq!(load_memo(&d), Some(Memo { checked_at: 10_000, finding: None }));
        assert_eq!(run_once(&d, 10_000 + 60_000, &busy), Pass::Skipped, "once a day");
        assert!(matches!(run_once(&d, 10_000 + EVERY_MS, &busy), Pass::Checked(None)));
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn damage_is_found_remembered_and_changes_nothing() {
        let d = temp_dir("damaged");
        whole_db(&d);
        damage(&d);
        let before = std::fs::read(d.join(health::DB_NAME)).unwrap();
        let busy = AtomicBool::new(false);
        let Pass::Checked(Some(found)) = run_once(&d, 20_000, &busy) else { panic!("damage must be found") };
        assert!(found.message.contains("damage") && !found.details.is_empty());
        assert_eq!((found.checked_at, found.folder.as_str()), (20_000, d.to_string_lossy().as_ref()));
        assert_eq!(load_memo(&d).unwrap().finding, Some(found));
        assert_eq!(std::fs::read(d.join(health::DB_NAME)).unwrap(), before, "read-only: not a byte changed");
        // A restart inside the day does not check again; the remembered finding is there to show.
        assert_eq!(run_once(&d, 20_000 + 1_000, &busy), Pass::Skipped);
        assert!(load_memo(&d).and_then(|m| m.finding).is_some());
        forget(&d);
        assert!(load_memo(&d).is_none());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn nothing_runs_during_a_meeting() {
        let d = temp_dir("busy");
        whole_db(&d);
        let busy = AtomicBool::new(true);
        assert_eq!(run_once(&d, 30_000, &busy), Pass::Skipped);
        assert!(load_memo(&d).is_none(), "a skipped check records nothing");
        assert_eq!(quick_check(&d.join(health::DB_NAME), &busy), Err(None));
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn a_finding_has_the_agreed_shape() {
        let f = IntegrityFinding {
            message: "A check of your meetings file found damage.".into(),
            details: vec!["row 3 missing from index i".into()],
            checked_at: 1_700_000_000_000,
            folder: "C:/data".into(),
            copies: vec![BackupInfo { name: "nexq-before-workspaces.db".into(), created_at: 1_700_000_000_000, bytes: 1024, meetings: Some(3) }],
        };
        crate::assert_contract!("db_integrity_problem", f);
        crate::assert_contract!("get_db_integrity_result", Some(f));
    }
}
