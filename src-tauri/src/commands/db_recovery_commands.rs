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
    health::restore_copy(&dir, &name, health::stamp_now())
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
    health::start_new(&dir, health::stamp_now())
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

    #[test]
    fn a_locked_file_is_never_restored_over_and_a_new_database_is_only_for_an_unreadable_one() {
        assert!(check_kind_for_restore(ProblemKind::Locked).is_err());
        for kind in [ProblemKind::Unreadable, ProblemKind::Newer, ProblemKind::UpgradeFailed] {
            assert!(check_kind_for_restore(kind).is_ok());
        }
    }
}
