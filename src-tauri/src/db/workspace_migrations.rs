//! Migrations for workspaces and everything built on them (v9 and later).
//!
//! All pending steps run in ONE transaction after v8: a failure rolls them all
//! back, records the error (shown to the user) and the app keeps running as it
//! did before, with workspaces unavailable. Every step is idempotent and the
//! applied ones are listed in `schema_steps`, so a kill midway leaves nothing
//! half done and a step added later still runs.
//!
//! To add a step (v10 search, v11 chat, v12 notes), write its function in its
//! own file and add one line to [`STEPS`].

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use rusqlite::{params, Connection};

/// One migration: its version, a name for the log, and the function.
pub struct Step {
    pub version: i64,
    pub name: &'static str,
    pub run: fn(&Connection) -> rusqlite::Result<()>,
}

/// The steps in version order. Add a line here for each new step.
pub const STEPS: &[Step] = &[
    Step { version: 9, name: "workspaces", run: v9_workspaces },
    Step { version: 10, name: "search", run: crate::workspace_search::migrate::migrate_conn },
    Step { version: 11, name: "chat", run: crate::workspace_chat::migrate::migrate },
    Step { version: 12, name: "notes", run: crate::live_notes::migrate::migrate_notes_conn },
    Step { version: 13, name: "talking_points", run: v13_talking_points },
    Step { version: 14, name: "brief", run: v14_brief },
    Step { version: 15, name: "memory", run: v15_memory },
];

const BACKUP_NAME: &str = "nexq-before-workspaces.db";
const BACKUP_KEEP: Duration = Duration::from_secs(14 * 24 * 3600);
const ERROR_KEY: &str = "workspace_migration_error";

static AVAILABLE: AtomicBool = AtomicBool::new(false);
static TABLES_STATE: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);
static LAST_ERROR: Mutex<Option<String>> = Mutex::new(None);

/// Whether the workspace tables are in place in this run.
pub fn available() -> bool {
    AVAILABLE.load(Ordering::SeqCst)
}

/// Whether the workspaces table is known to be in the database.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TablesState {
    /// Not looked at yet, or the look failed: treated as "may exist".
    Unknown,
    /// The query worked and the table is not there: workspaces never ran.
    Absent,
    /// The table is there.
    Present,
}

impl TablesState {
    fn code(self) -> u8 {
        match self {
            TablesState::Unknown => 0,
            TablesState::Absent => 1,
            TablesState::Present => 2,
        }
    }

    fn from_code(code: u8) -> Self {
        match code {
            1 => TablesState::Absent,
            2 => TablesState::Present,
            _ => TablesState::Unknown,
        }
    }
}

/// The state recorded by the last migration run (Unknown until one ran).
pub fn tables_state() -> TablesState {
    TablesState::from_code(TABLES_STATE.load(Ordering::SeqCst))
}

/// Looks for the workspaces table. A failing query is Unknown, never Absent.
pub fn probe_tables(conn: &Connection) -> TablesState {
    classify(conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'", [], |r| r.get::<_, i64>(0)))
}

/// The state an answer to "how many workspaces tables?" means: only a
/// successful zero is Absent.
fn classify(answer: rusqlite::Result<i64>) -> TablesState {
    match answer {
        Ok(0) => TablesState::Absent,
        Ok(_) => TablesState::Present,
        Err(_) => TablesState::Unknown,
    }
}

/// Whether the workspaces table exists in `conn`.
pub fn tables_present(conn: &Connection) -> bool {
    probe_tables(conn) == TablesState::Present
}

/// Why the last migration failed, if it did.
pub fn last_error() -> Option<String> {
    LAST_ERROR.lock().ok().and_then(|e| e.clone())
}

/// Runs the pending steps of [`STEPS`] and records whether workspaces are
/// available in this run. `db_path` is where the pre-upgrade copy goes.
pub fn run(conn: &Connection, db_path: Option<&Path>) -> Result<(), String> {
    let result = run_steps(conn, db_path, STEPS);
    AVAILABLE.store(result.is_ok(), Ordering::SeqCst);
    TABLES_STATE.store(probe_tables(conn).code(), Ordering::SeqCst);
    if let Ok(mut slot) = LAST_ERROR.lock() {
        *slot = result.as_ref().err().cloned();
    }
    result
}

/// Runs the pending `steps` in one transaction (see the module notes).
pub fn run_steps(conn: &Connection, db_path: Option<&Path>, steps: &[Step]) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_steps (
            version    INTEGER PRIMARY KEY NOT NULL,
            name       TEXT NOT NULL,
            applied_at INTEGER NOT NULL
        );",
    )
    .map_err(|e| format!("Couldn't prepare the upgrade: {e}"))?;

    let applied = applied_versions(conn)?;
    let mut pending: Vec<&Step> = steps.iter().filter(|s| !applied.contains(&s.version)).collect();
    pending.sort_by_key(|s| s.version);
    if pending.is_empty() {
        return Ok(());
    }

    if pending.iter().any(|s| s.version == 9) {
        if let Some(path) = db_path {
            backup_before_workspaces(conn, path);
        }
    }

    match apply(conn, &pending) {
        Ok(()) => {
            clear_error(conn);
            Ok(())
        }
        Err(e) => {
            let message = format!("The upgrade for workspaces didn't finish: {e}");
            record_error(conn, &message);
            Err(message)
        }
    }
}

fn applied_versions(conn: &Connection) -> Result<Vec<i64>, String> {
    let mut stmt = conn
        .prepare("SELECT version FROM schema_steps")
        .map_err(|e| format!("Couldn't read the upgrade state: {e}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, i64>(0))
        .map_err(|e| format!("Couldn't read the upgrade state: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| format!("Couldn't read the upgrade state: {e}"))
}

/// The pending steps in one transaction; dropping it on error rolls back.
fn apply(conn: &Connection, pending: &[&Step]) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut top = 0;
    for step in pending {
        (step.run)(&tx).map_err(|e| format!("step v{} ({}): {e}", step.version, step.name))?;
        tx.execute(
            "INSERT INTO schema_steps (version, name, applied_at) VALUES (?1, ?2, ?3)",
            params![step.version, step.name, now_ms()],
        )
        .map_err(|e| e.to_string())?;
        top = top.max(step.version);
    }
    let marker = current_user_version(&tx).max(top);
    tx.execute_batch(&format!("PRAGMA user_version = {marker};")).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

fn current_user_version(conn: &Connection) -> i64 {
    conn.query_row("PRAGMA user_version", [], |row| row.get(0)).unwrap_or(0)
}

fn record_error(conn: &Connection, message: &str) {
    let _ = conn.execute(
        "INSERT OR REPLACE INTO app_state (key, value) VALUES (?1, ?2)",
        params![ERROR_KEY, message],
    );
}

fn clear_error(conn: &Connection) {
    let _ = conn.execute("DELETE FROM app_state WHERE key = ?1", params![ERROR_KEY]);
}

/// The error a previous run recorded (it stays until a migration succeeds).
pub fn recorded_error(conn: &Connection) -> Option<String> {
    conn.query_row("SELECT value FROM app_state WHERE key = ?1", params![ERROR_KEY], |row| row.get(0)).ok()
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

// ── Pre-upgrade copy ─────────────────────────────────────────────────────────

fn backup_path(db_path: &Path) -> PathBuf {
    db_path.with_file_name(BACKUP_NAME)
}

fn has_user_data(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM meetings) OR EXISTS(SELECT 1 FROM context_resources)",
        [],
        |row| row.get::<_, bool>(0),
    )
    .unwrap_or(false)
}

/// Copies the database beside itself once, before v9 first runs on a database
/// that holds something. It goes to a temporary name and is renamed when
/// complete. A failure is logged and the upgrade goes on: the changes only add.
fn backup_before_workspaces(conn: &Connection, db_path: &Path) {
    let target = backup_path(db_path);
    if target.exists() || !has_user_data(conn) {
        return;
    }
    let tmp = target.with_extension("db.tmp");
    let _ = std::fs::remove_file(&tmp);
    let copied = conn
        .execute("VACUUM INTO ?1", params![tmp.to_string_lossy()])
        .map_err(|e| e.to_string())
        .and_then(|_| std::fs::rename(&tmp, &target).map_err(|e| e.to_string()));
    match copied {
        Ok(()) => log::info!("Copied the database to {} before the upgrade", target.display()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            log::warn!("Couldn't copy the database before the upgrade, going on: {e}");
        }
    }
}

/// Deletes the pre-upgrade copy 14 days after it was made (it keeps
/// transcripts the user may have deleted since).
pub fn cleanup_old_backup(db_path: &Path) {
    let target = backup_path(db_path);
    let _ = std::fs::remove_file(target.with_extension("db.tmp"));
    let Ok(modified) = std::fs::metadata(&target).and_then(|m| m.modified()) else {
        return;
    };
    let age = SystemTime::now().duration_since(modified).unwrap_or_default();
    if age >= BACKUP_KEEP {
        match std::fs::remove_file(&target) {
            Ok(()) => log::info!("Removed the pre-upgrade database copy (older than 14 days)"),
            Err(e) => log::warn!("Couldn't remove the old database copy: {e}"),
        }
    }
}

// ── Steps ────────────────────────────────────────────────────────────────────

fn column_exists(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name = ?2",
        params![table, column],
        |row| row.get::<_, i64>(0),
    )
    .map(|n| n > 0)
}

/// v9: workspaces, their items, the meeting's home and borrowed workspaces,
/// the cached text of documents. General is seeded once (marker) with every
/// document in the library.
fn v9_workspaces(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS workspaces (
            id               TEXT PRIMARY KEY NOT NULL,
            name             TEXT NOT NULL,
            icon             TEXT,
            color            TEXT,
            description      TEXT NOT NULL DEFAULT '',
            instructions     TEXT NOT NULL DEFAULT '',
            include_general  INTEGER NOT NULL DEFAULT 1,
            keep_separate    INTEGER NOT NULL DEFAULT 0,
            default_scenario TEXT,
            recaps_with_ai   INTEGER NOT NULL DEFAULT 0,
            suggest_memory   INTEGER NOT NULL DEFAULT 0,
            brief_default    INTEGER NOT NULL DEFAULT 0,
            is_default       INTEGER NOT NULL DEFAULT 0,
            pinned           INTEGER NOT NULL DEFAULT 0,
            archived         INTEGER NOT NULL DEFAULT 0,
            sort             INTEGER NOT NULL DEFAULT 0,
            created_at       INTEGER NOT NULL,
            updated_at       INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS workspace_items (
            workspace_id TEXT NOT NULL,
            kind         TEXT NOT NULL CHECK(kind IN ('document','folder','server')),
            ref_id       TEXT NOT NULL,
            label        TEXT,
            pinned       INTEGER NOT NULL DEFAULT 0,
            index_opt_in INTEGER NOT NULL DEFAULT 0,
            added_at     INTEGER NOT NULL,
            PRIMARY KEY (workspace_id, kind, ref_id)
        );
        CREATE INDEX IF NOT EXISTS idx_workspace_items_ref ON workspace_items(kind, ref_id);

        CREATE TABLE IF NOT EXISTS meeting_borrowed (
            meeting_id   TEXT NOT NULL,
            workspace_id TEXT NOT NULL,
            added_at     INTEGER NOT NULL,
            removed_at   INTEGER,
            PRIMARY KEY (meeting_id, workspace_id)
        );

        CREATE TABLE IF NOT EXISTS document_text (
            resource_id  TEXT PRIMARY KEY NOT NULL,
            text         TEXT NOT NULL DEFAULT '',
            token_count  INTEGER NOT NULL DEFAULT 0,
            status       TEXT NOT NULL DEFAULT 'ready',
            error        TEXT,
            extracted_at INTEGER NOT NULL
        );
        ",
    )?;

    if !column_exists(conn, "meetings", "workspace_id")? {
        conn.execute_batch("ALTER TABLE meetings ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'general'")?;
    }
    conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_meetings_workspace ON meetings(workspace_id, start_time)")?;

    seed_general_once(conn)
}

/// General exists from the first run of v9 and never again gains items on its
/// own: a document added later and filed nowhere stays unfiled.
fn seed_general_once(conn: &Connection) -> rusqlite::Result<()> {
    let seeded: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM app_state WHERE key = 'workspaces_seeded')",
        [],
        |row| row.get(0),
    )?;
    if seeded {
        return Ok(());
    }
    let now = now_ms();
    conn.execute(
        "INSERT OR IGNORE INTO workspaces
            (id, name, description, instructions, include_general, keep_separate, is_default, sort, created_at, updated_at)
         VALUES ('general', 'General', '', '', 1, 0, 1, 0, ?1, ?1)",
        params![now],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO workspace_items (workspace_id, kind, ref_id, added_at)
         SELECT 'general', 'document', id, ?1 FROM context_resources",
        params![now],
    )?;
    conn.execute("INSERT OR REPLACE INTO app_state (key, value) VALUES ('workspaces_seeded', '1')", [])?;
    Ok(())
}

/// v13: talking points, "this meeting only" edits, and what was said per meeting.
fn v13_talking_points(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS talking_points (
            id           TEXT PRIMARY KEY NOT NULL,
            workspace_id TEXT NOT NULL,
            title        TEXT NOT NULL DEFAULT '',
            doc_json     TEXT NOT NULL DEFAULT '{}',
            markdown     TEXT NOT NULL DEFAULT '',
            plain_text   TEXT NOT NULL DEFAULT '',
            in_context   INTEGER NOT NULL DEFAULT 1,
            sort         INTEGER NOT NULL DEFAULT 0,
            created_at   INTEGER NOT NULL,
            updated_at   INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_talking_points_ws ON talking_points(workspace_id, sort);

        CREATE TABLE IF NOT EXISTS talking_point_edits (
            meeting_id TEXT NOT NULL,
            point_id   TEXT NOT NULL,
            doc_json   TEXT NOT NULL,
            PRIMARY KEY (meeting_id, point_id)
        );

        CREATE TABLE IF NOT EXISTS talking_point_progress (
            meeting_id TEXT NOT NULL,
            point_id   TEXT NOT NULL,
            said_json  TEXT NOT NULL DEFAULT '[]',
            PRIMARY KEY (meeting_id, point_id)
        );
        ",
    )
}

/// v14: the brief of a meeting.
fn v14_brief(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS meeting_briefs (
            meeting_id  TEXT PRIMARY KEY NOT NULL,
            sheet_json  TEXT NOT NULL DEFAULT '{}',
            status      TEXT NOT NULL DEFAULT 'idle',
            tokens_used INTEGER NOT NULL DEFAULT 0,
            cap         INTEGER NOT NULL DEFAULT 0,
            updated_at  INTEGER NOT NULL,
            fingerprint TEXT NOT NULL DEFAULT ''
        );
        ",
    )?;
    add_column_if_missing(conn, "meeting_briefs", "fingerprint", "TEXT NOT NULL DEFAULT ''")
}

/// v15: workspace memory.
fn v15_memory(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS workspace_memory (
            id             TEXT PRIMARY KEY NOT NULL,
            workspace_id   TEXT NOT NULL,
            kind           TEXT NOT NULL CHECK(kind IN ('person','decision','open_item','fact','preference')),
            title          TEXT NOT NULL DEFAULT '',
            text           TEXT NOT NULL DEFAULT '',
            source_meeting TEXT,
            source_ms      INTEGER,
            status         TEXT NOT NULL CHECK(status IN ('suggested','saved','dismissed')),
            created_at     INTEGER NOT NULL,
            updated_at     INTEGER NOT NULL,
            unsupported    INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_workspace_memory_ws ON workspace_memory(workspace_id, status);
        ",
    )?;
    add_column_if_missing(conn, "workspace_memory", "unsupported", "INTEGER NOT NULL DEFAULT 0")
}

/// Adds a column to a table made by an earlier build of an unreleased step.
fn add_column_if_missing(conn: &Connection, table: &str, column: &str, ddl: &str) -> rusqlite::Result<()> {
    let has: bool = conn
        .prepare(&format!("PRAGMA table_info({table})"))?
        .query_map([], |r| r.get::<_, String>(1))?
        .filter_map(Result::ok)
        .any(|c| c == column);
    if has {
        Ok(())
    } else {
        conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {ddl}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nexq-wsmig-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A database as v8 left it, with a meeting and two documents in it.
    fn v8_database(dir: &Path) -> (Connection, PathBuf) {
        let path = dir.join("nexq.db");
        let conn = Connection::open(&path).unwrap();
        migrations::run(&conn).unwrap();
        conn.execute(
            "INSERT INTO meetings (id, title, start_time) VALUES ('m1', 'Old call', '2026-01-01T10:00:00Z')",
            [],
        )
        .unwrap();
        for id in ["d1", "d2"] {
            conn.execute(
                "INSERT INTO context_resources (id, name, file_type, file_path, loaded_at)
                 VALUES (?1, ?1, 'txt', 'x', 'now')",
                params![id],
            )
            .unwrap();
        }
        (conn, path)
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    fn table_exists(conn: &Connection, name: &str) -> bool {
        count(conn, &format!("SELECT COUNT(*) FROM sqlite_master WHERE name = '{name}'")) > 0
    }

    #[test]
    fn upgrades_a_v8_database_and_keeps_everything() {
        let dir = temp_dir("up");
        let (conn, path) = v8_database(&dir);
        run_steps(&conn, Some(&path), STEPS).unwrap();

        for table in ["workspaces", "workspace_items", "meeting_borrowed", "talking_points", "meeting_briefs", "workspace_memory", "meeting_notes"] {
            assert!(table_exists(&conn, table), "{table} missing");
        }
        assert_eq!(count(&conn, "PRAGMA user_version"), 15);
        // General is the default and holds every existing document.
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM workspaces WHERE id = 'general' AND is_default = 1"), 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM workspace_items WHERE workspace_id = 'general' AND kind = 'document'"), 2);
        // The old meeting is in General.
        let home: String = conn.query_row("SELECT workspace_id FROM meetings WHERE id = 'm1'", [], |r| r.get(0)).unwrap();
        assert_eq!(home, "general");
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM meetings"), 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM context_resources"), 2);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn running_twice_changes_nothing_and_never_reseeds() {
        let dir = temp_dir("twice");
        let (conn, path) = v8_database(&dir);
        run_steps(&conn, Some(&path), STEPS).unwrap();
        // The user takes a document out of General and adds an unfiled one.
        conn.execute("DELETE FROM workspace_items WHERE ref_id = 'd2'", []).unwrap();
        conn.execute(
            "INSERT INTO context_resources (id, name, file_type, file_path, loaded_at) VALUES ('d3', 'd3', 'txt', 'x', 'now')",
            [],
        )
        .unwrap();
        run_steps(&conn, Some(&path), STEPS).unwrap();
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM workspace_items"), 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM workspaces"), 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM schema_steps"), STEPS.len() as i64);
        // Even with the steps forgotten, running them again is harmless and does not reseed.
        conn.execute("DELETE FROM schema_steps", []).unwrap();
        run_steps(&conn, Some(&path), STEPS).unwrap();
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM workspace_items"), 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM workspaces"), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    fn failing_step(_: &Connection) -> rusqlite::Result<()> {
        Err(rusqlite::Error::InvalidQuery)
    }

    #[test]
    fn a_failure_rolls_everything_back_and_records_the_error() {
        let dir = temp_dir("fail");
        let (conn, path) = v8_database(&dir);
        let broken = [
            Step { version: 9, name: "workspaces", run: v9_workspaces },
            Step { version: 13, name: "talking_points", run: v13_talking_points },
            Step { version: 16, name: "broken", run: failing_step },
        ];
        let err = run_steps(&conn, Some(&path), &broken).unwrap_err();
        assert!(err.contains("v16"), "{err}");
        assert!(!table_exists(&conn, "workspaces"));
        assert!(!table_exists(&conn, "talking_points"));
        assert!(!column_exists(&conn, "meetings", "workspace_id").unwrap());
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM schema_steps"), 0);
        assert_eq!(count(&conn, "PRAGMA user_version"), 0);
        assert!(recorded_error(&conn).unwrap().contains("didn't finish"));
        // The old data is untouched.
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM meetings"), 1);
        // A later run with the good steps works and clears the error.
        run_steps(&conn, Some(&path), STEPS).unwrap();
        assert!(table_exists(&conn, "workspaces"));
        assert!(recorded_error(&conn).is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_copy_is_made_once_without_a_leftover_temp_file() {
        let dir = temp_dir("copy");
        let (conn, path) = v8_database(&dir);
        run_steps(&conn, Some(&path), STEPS).unwrap();
        let backup = backup_path(&path);
        assert!(backup.exists());
        assert!(!backup.with_extension("db.tmp").exists());
        // The copy holds the data as it was before the upgrade.
        let copy = Connection::open(&backup).unwrap();
        assert_eq!(count(&copy, "SELECT COUNT(*) FROM meetings"), 1);
        assert!(!table_exists(&copy, "workspaces"));
        drop(copy);
        // A second pending v9 does not overwrite it.
        let stamp = std::fs::metadata(&backup).unwrap().modified().unwrap();
        conn.execute("DELETE FROM schema_steps", []).unwrap();
        run_steps(&conn, Some(&path), STEPS).unwrap();
        assert_eq!(std::fs::metadata(&backup).unwrap().modified().unwrap(), stamp);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_tables_are_found_after_v9_even_if_a_later_step_fails() {
        let dir = temp_dir("present");
        let (conn, path) = v8_database(&dir);
        assert!(!tables_present(&conn), "before v9 there are none");
        run_steps(&conn, Some(&path), STEPS).unwrap();
        assert!(tables_present(&conn));
        // A step added later fails: the earlier ones stay, and the tables are still there.
        let steps: Vec<Step> = STEPS
            .iter()
            .map(|s| Step { version: s.version, name: s.name, run: s.run })
            .chain([Step { version: 40, name: "broken", run: failing_step }])
            .collect();
        assert!(run_steps(&conn, Some(&path), &steps).is_err());
        assert!(tables_present(&conn));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_failing_look_is_unknown_never_absent() {
        let dir = temp_dir("probe");
        let (conn, _) = v8_database(&dir);
        assert_eq!(probe_tables(&conn), TablesState::Absent, "the query worked and there is no table");
        run_steps(&conn, None, STEPS).unwrap();
        assert_eq!(probe_tables(&conn), TablesState::Present);
        // A look that failed is Unknown, never Absent.
        assert_eq!(classify(Err(rusqlite::Error::InvalidQuery)), TablesState::Unknown);
        assert_eq!(classify(Ok(0)), TablesState::Absent);
        assert_eq!(classify(Ok(1)), TablesState::Present);
        assert_eq!(TablesState::from_code(TablesState::Unknown.code()), TablesState::Unknown);
        assert_eq!(TablesState::from_code(TablesState::Absent.code()), TablesState::Absent);
        assert_eq!(TablesState::from_code(TablesState::Present.code()), TablesState::Present);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// How long a start takes on the database side: the upgrade of a database with
    /// 60 meetings (the copy included), then a start on the upgraded one.
    #[test]
    fn starting_with_sixty_meetings_is_fast_on_the_first_upgrade_and_after() {
        let dir = temp_dir("timing");
        let path = dir.join("nexq.db");
        {
            let conn = Connection::open(&path).unwrap();
            migrations::run(&conn).unwrap();
            let tx = conn.unchecked_transaction().unwrap();
            for m in 0..60 {
                tx.execute(
                    "INSERT INTO meetings (id, title, start_time, transcript, summary) VALUES (?1, ?2, '2026-01-01T10:00:00Z', '[]', 'a summary')",
                    params![format!("m{m}"), format!("Meeting {m}")],
                )
                .unwrap();
                for i in 0..400 {
                    tx.execute(
                        "INSERT INTO transcript_segments (id, meeting_id, text, speaker, timestamp_ms, is_final, created_at)
                         VALUES (?1, ?2, 'we talked about the quarterly budget and the hiring plan for next year', 'Them', ?3, 1, 'x')",
                        params![format!("s{m}-{i}"), format!("m{m}"), i * 1000],
                    )
                    .unwrap();
                }
            }
            for d in 0..10 {
                tx.execute("INSERT INTO context_resources (id, name, file_type, file_path, loaded_at) VALUES (?1, ?1, 'txt', 'x', 'now')", params![format!("d{d}")]).unwrap();
            }
            tx.commit().unwrap();
        }
        // The first start after the upgrade: open, v1 to v8, the copy, v9 to v15.
        let first = std::time::Instant::now();
        let conn = Connection::open(&path).unwrap();
        migrations::run(&conn).unwrap();
        cleanup_old_backup(&path);
        run_steps(&conn, Some(&path), STEPS).unwrap();
        let upgrade = first.elapsed();
        assert!(backup_path(&path).exists());
        drop(conn);
        // The next start: nothing pending.
        let second = std::time::Instant::now();
        let conn = Connection::open(&path).unwrap();
        migrations::run(&conn).unwrap();
        cleanup_old_backup(&path);
        run_steps(&conn, Some(&path), STEPS).unwrap();
        let again = second.elapsed();
        let (meetings, segments): (i64, i64) =
            (count(&conn, "SELECT COUNT(*) FROM meetings"), count(&conn, "SELECT COUNT(*) FROM transcript_segments"));
        println!("startup timing: upgrade of {meetings} meetings / {segments} segments {upgrade:?}, next start {again:?}");
        assert_eq!((meetings, segments), (60, 24_000));
        assert!(upgrade < Duration::from_secs(10), "the upgrade took {upgrade:?}");
        assert!(again < Duration::from_secs(2), "the next start took {again:?}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_fresh_database_makes_no_copy() {
        let dir = temp_dir("fresh");
        let path = dir.join("nexq.db");
        let conn = Connection::open(&path).unwrap();
        migrations::run(&conn).unwrap();
        run_steps(&conn, Some(&path), STEPS).unwrap();
        assert!(!backup_path(&path).exists());
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM workspaces"), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_failed_copy_logs_and_the_upgrade_goes_on() {
        let dir = temp_dir("nocopy");
        let (conn, _) = v8_database(&dir);
        let missing_dir = dir.join("gone").join("nexq.db");
        run_steps(&conn, Some(&missing_dir), STEPS).unwrap();
        assert!(table_exists(&conn, "workspaces"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_copy_is_removed_after_14_days_only() {
        let dir = temp_dir("old");
        let path = dir.join("nexq.db");
        let backup = backup_path(&path);
        std::fs::write(&backup, b"x").unwrap();
        cleanup_old_backup(&path);
        assert!(backup.exists());
        let old = SystemTime::now() - Duration::from_secs(15 * 24 * 3600);
        std::fs::File::options().write(true).open(&backup).unwrap().set_modified(old).unwrap();
        cleanup_old_backup(&path);
        assert!(!backup.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_step_added_later_runs_alone() {
        let dir = temp_dir("later");
        let (conn, path) = v8_database(&dir);
        run_steps(&conn, Some(&path), STEPS).unwrap();
        fn v10(conn: &Connection) -> rusqlite::Result<()> {
            conn.execute_batch("CREATE TABLE IF NOT EXISTS later_thing (id TEXT)")
        }
        let mut with_v10: Vec<Step> = STEPS.iter().map(|s| Step { version: s.version, name: s.name, run: s.run }).collect();
        with_v10.push(Step { version: 20, name: "later", run: v10 });
        run_steps(&conn, Some(&path), &with_v10).unwrap();
        assert!(table_exists(&conn, "later_thing"));
        assert_eq!(count(&conn, "PRAGMA user_version"), 20);
        let _ = std::fs::remove_dir_all(dir);
    }
}
