//! Recovery when the database did not open: restore a copy, start with a new
//! one, open the data folder, restart. All of them refuse when the database
//! opened normally, and none of them ever deletes a file (see `db::health`).

use tauri::{command, AppHandle, State};

use crate::db::health::{self, ProblemKind};
use crate::state::AppState;

/// The state a recovery may start from: the database did not open, and no
/// meeting or recording is in progress.
fn recovery_allowed(state: &AppState) -> Result<health::ProblemKind, String> {
    if state.database.is_some() {
        return Err("The meetings file opened normally, so there is nothing to recover".to_string());
    }
    let Some(problem) = &state.db_problem else {
        return Err("The meetings file isn't open yet".to_string());
    };
    if state.meeting_active.load(std::sync::atomic::Ordering::SeqCst)
        || state.recording_jobs.load(std::sync::atomic::Ordering::SeqCst) > 0
    {
        return Err("A meeting or a recording is in progress. Finish it first".to_string());
    }
    Ok(problem.kind)
}

/// Whether `kind` may be recovered from at all: a file another program holds is
/// left alone (it may be fine).
fn check_kind_for_restore(kind: ProblemKind) -> Result<(), String> {
    if kind == ProblemKind::Locked {
        return Err("Another program is using the meetings file. Close it and restart NexQ".to_string());
    }
    Ok(())
}

/// Restores the database from one of the copies listed in `get_workspaces_status`
/// (by name only). The damaged files are put aside as `nexq.db.damaged-<time>*`,
/// never deleted. NexQ must restart afterwards (`restart_app`).
#[command]
pub async fn restore_database_copy(name: String, state: State<'_, AppState>) -> Result<(), String> {
    let kind = recovery_allowed(&state)?;
    check_kind_for_restore(kind)?;
    let dir = crate::app_paths::data_dir();
    health::restore_copy(&dir, &name, health::stamp_now(), kind)?;
    crate::db::integrity::forget(&dir);
    Ok(())
}

/// Puts the unreadable database aside and starts with an empty one on restart.
/// Only when the file could not be read.
#[command]
pub async fn start_with_new_database(state: State<'_, AppState>) -> Result<(), String> {
    let kind = recovery_allowed(&state)?;
    if kind != ProblemKind::Unreadable {
        return Err("Starting with a new database is only offered when the file can't be read".to_string());
    }
    let dir = crate::app_paths::data_dir();
    health::start_new(&dir, health::stamp_now(), kind)?;
    crate::db::integrity::forget(&dir);
    Ok(())
}

/// What `retry_open_database` found.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct RetryOpenResult {
    /// The file can be opened now.
    pub ok: bool,
    /// The open database cannot be swapped into the running app (every part of it was
    /// started against "no database"), so NexQ must restart to use the file.
    pub needs_restart: bool,
}

/// Looks at the file again, read-only. `Ok` with `ok: false` while another program still
/// holds it; an error (in words) when it is now damaged or newer, which a retry cannot fix.
fn retry_probe(dir: &std::path::Path) -> Result<RetryOpenResult, String> {
    match health::probe(&dir.join(health::DB_NAME)) {
        Ok(()) => Ok(RetryOpenResult { ok: true, needs_restart: true }),
        Err((ProblemKind::Locked, _)) => Ok(RetryOpenResult { ok: false, needs_restart: false }),
        Err((_, why)) => Err(why),
    }
}

/// The locked case's "Try again": looks at the file again and says whether NexQ can use it
/// now. The running app has no database slot to fill after start (`AppState` is built once),
/// so a file that opens is reported with `needs_restart` and nothing is initialised halfway.
#[command]
pub async fn retry_open_database(state: State<'_, AppState>) -> Result<RetryOpenResult, String> {
    let kind = recovery_allowed(&state)?;
    if kind != ProblemKind::Locked {
        return Err("Only a file that was in use can be opened again".to_string());
    }
    let dir = crate::app_paths::data_dir();
    // The look waits for a busy file for a moment: keep it off the async runtime.
    tokio::task::spawn_blocking(move || retry_probe(&dir)).await.map_err(|e| e.to_string())?
}

/// The damage the background check of the open database found, if any (see `db::integrity`).
/// The launcher shows a calm notice for it; nothing is changed automatically.
#[command]
pub async fn get_db_integrity() -> Option<crate::db::integrity::IntegrityFinding> {
    crate::db::integrity::current()
}

/// Opens NexQ's data folder in the file manager.
#[command]
pub async fn open_data_folder() -> Result<(), String> {
    crate::workspace::reveal::open_directory(&crate::app_paths::data_dir())
}

/// Restarts NexQ (after a recovery). Refused while a meeting is active or a
/// recording is still being saved.
#[command]
pub async fn restart_app(state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    if state.meeting_active.load(std::sync::atomic::Ordering::SeqCst)
        || state.recording_jobs.load(std::sync::atomic::Ordering::SeqCst) > 0
    {
        return Err("A meeting or a recording is in progress. Finish it first".to_string());
    }
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::health::DbProblem;

    fn problem(kind: ProblemKind) -> DbProblem {
        DbProblem { kind, message: "x".into(), path: "p".into(), backups: Vec::new() }
    }

    #[test]
    fn nothing_is_recovered_when_the_database_opened() {
        let state = AppState::new();
        assert!(recovery_allowed(&state).is_err(), "no database and no problem: not a recovery either");
        let mut with_problem = AppState::new();
        with_problem.db_problem = Some(problem(ProblemKind::Unreadable));
        assert_eq!(recovery_allowed(&with_problem), Ok(ProblemKind::Unreadable));
    }

    #[test]
    fn a_meeting_or_a_saving_recording_blocks_a_recovery() {
        let mut state = AppState::new();
        state.db_problem = Some(problem(ProblemKind::Unreadable));
        state.meeting_active.store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(recovery_allowed(&state).unwrap_err().contains("in progress"));
        state.meeting_active.store(false, std::sync::atomic::Ordering::SeqCst);
        state.recording_jobs.store(1, std::sync::atomic::Ordering::SeqCst);
        assert!(recovery_allowed(&state).is_err());
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("nexq-retry-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_file_that_opens_again_needs_a_restart_and_is_not_touched() {
        let d = temp_dir("free");
        let path = d.join(health::DB_NAME);
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE meetings (id TEXT); INSERT INTO meetings VALUES ('m1');").unwrap();
        drop(conn);
        let before = std::fs::read(&path).unwrap();
        assert_eq!(retry_probe(&d), Ok(RetryOpenResult { ok: true, needs_restart: true }));
        assert_eq!(std::fs::read(&path).unwrap(), before, "a retry only looks");
        crate::assert_contract!("retry_open_database_result", retry_probe(&d).unwrap());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn a_file_another_program_still_holds_is_reported_as_in_use() {
        let d = temp_dir("held");
        let path = d.join(health::DB_NAME);
        let holder = rusqlite::Connection::open(&path).unwrap();
        holder.execute_batch("PRAGMA journal_mode=DELETE; CREATE TABLE meetings (id TEXT);").unwrap();
        holder.execute_batch("BEGIN EXCLUSIVE; INSERT INTO meetings VALUES ('m1');").unwrap();
        assert_eq!(retry_probe(&d), Ok(RetryOpenResult { ok: false, needs_restart: false }));
        holder.execute_batch("COMMIT;").unwrap();
        drop(holder);
        assert_eq!(retry_probe(&d), Ok(RetryOpenResult { ok: true, needs_restart: true }), "once released it opens");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn a_file_that_is_now_damaged_is_an_error_in_words_not_a_silent_failure() {
        let d = temp_dir("damaged");
        std::fs::write(d.join(health::DB_NAME), vec![7u8; 6000]).unwrap();
        assert!(retry_probe(&d).is_err());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn a_locked_file_is_never_restored_over_and_a_new_database_is_only_for_an_unreadable_one() {
        assert!(check_kind_for_restore(ProblemKind::Locked).is_err());
        for kind in [ProblemKind::Unreadable, ProblemKind::Newer, ProblemKind::UpgradeFailed] {
            assert!(check_kind_for_restore(kind).is_ok());
        }
    }
}
