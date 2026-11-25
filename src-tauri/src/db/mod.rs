pub mod context;
pub mod health;
pub mod meeting_chat;
pub mod meetings;
pub mod migrations;
pub mod rag;
pub mod translation;
pub mod workspace_migrations;

use rusqlite::{Connection, OpenFlags};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// How long a connection waits for another writer before it gives up.
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// Database manager with rusqlite connection and auto-migration.
pub struct DatabaseManager {
    conn: Connection,
    path: PathBuf,
}

impl DatabaseManager {
    /// Opens (or creates) the SQLite database at the standard app data path
    /// and runs all migrations.
    pub fn new(app_data_dir: PathBuf) -> Result<Self, DatabaseError> {
        // Ensure directory exists
        std::fs::create_dir_all(&app_data_dir).map_err(|e| {
            DatabaseError::Init(format!("Failed to create data directory: {}", e))
        })?;

        let db_path = app_data_dir.join("nexq.db");
        log::info!("Opening database at: {}", db_path.display());

        let conn = Connection::open(&db_path).map_err(|e| {
            DatabaseError::Init(format!("Failed to open database: {}", e))
        })?;

        // Run migrations
        migrations::run(&conn).map_err(|e| {
            DatabaseError::Migration(format!("Migration failed: {}", e))
        })?;

        // Workspaces and what follows. A failure rolls back, is recorded and
        // shown, and the app keeps running as before.
        workspace_migrations::cleanup_old_backup(&db_path);
        if let Err(e) = workspace_migrations::run(&conn, Some(&db_path)) {
            log::error!("Workspace migrations failed, running without them: {}", e);
        }

        Ok(Self { conn, path: db_path })
    }

    /// Returns a reference to the underlying SQLite connection.
    pub fn connection(&self) -> &Connection {
        &self.conn
    }

    /// Where the database file is.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// A read-only connection of its own for heavy readers (search, the
    /// indexer's scans): it never waits for the shared connection's lock.
    pub fn open_reader(&self) -> Result<Connection, DatabaseError> {
        open_reader(&self.path)
    }

    /// A read-write connection of its own for background writers (an
    /// indexer); writers still take turns inside SQLite (WAL, busy timeout).
    pub fn open_writer(&self) -> Result<Connection, DatabaseError> {
        open_writer(&self.path)
    }
}

/// Opens the database in `app_data_dir` the safe way: a recovery a previous run
/// began is finished first; the file is looked at without changing it; and if it
/// can't be used (damaged, newer, in use, or its upgrade fails) nothing is
/// created, upgraded or overwritten. The app then runs without it and says why.
pub fn open_or_problem(app_data_dir: PathBuf) -> Result<DatabaseManager, health::DbProblem> {
    use health::{problem, ProblemKind};
    if let Err(e) = std::fs::create_dir_all(&app_data_dir) {
        return Err(problem(ProblemKind::Locked, format!("The data folder can't be used: {e}."), &app_data_dir));
    }
    if let Err(e) = health::resume_pending(&app_data_dir) {
        return Err(problem(ProblemKind::Unreadable, e, &app_data_dir));
    }
    if let Err((kind, why)) = health::probe(&app_data_dir.join(health::DB_NAME)) {
        return Err(problem(kind, why, &app_data_dir));
    }
    DatabaseManager::new(app_data_dir.clone())
        .map_err(|e| problem(ProblemKind::UpgradeFailed, format!("Bringing your meetings up to date didn't finish: {e}"), &app_data_dir))
}

/// A read-only connection to the database file at `path` (WAL, busy timeout).
pub fn open_reader(path: &Path) -> Result<Connection, DatabaseError> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| DatabaseError::Init(format!("Failed to open a reader: {}", e)))?;
    conn.busy_timeout(BUSY_TIMEOUT)?;
    conn.execute_batch("PRAGMA query_only=ON;")?;
    Ok(conn)
}

/// A read-write connection to the database file at `path` (WAL, busy timeout).
pub fn open_writer(path: &Path) -> Result<Connection, DatabaseError> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| DatabaseError::Init(format!("Failed to open a writer: {}", e)))?;
    conn.busy_timeout(BUSY_TIMEOUT)?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
    Ok(conn)
}

#[derive(Debug, thiserror::Error)]
pub enum DatabaseError {
    #[error("Database initialization error: {0}")]
    Init(String),
    #[error("Migration error: {0}")]
    Migration(String),
    #[error("Query error: {0}")]
    Query(String),
    #[error("Not found: {0}")]
    NotFound(String),
}

impl From<rusqlite::Error> for DatabaseError {
    fn from(e: rusqlite::Error) -> Self {
        DatabaseError::Query(e.to_string())
    }
}

#[cfg(test)]
mod open_tests {
    use super::health::{self, ProblemKind};
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nexq-open-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir).unwrap().filter_map(Result::ok).map(|e| e.file_name().to_string_lossy().to_string()).collect();
        v.sort();
        v
    }

    #[test]
    fn a_damaged_database_is_reported_with_its_copies_and_nothing_is_created_or_changed() {
        let d = dir("damaged");
        std::fs::write(d.join("nexq.db"), vec![7u8; 6000]).unwrap();
        // A good copy from an earlier upgrade.
        let copy = Connection::open(d.join("nexq-before-workspaces.db")).unwrap();
        copy.execute_batch("CREATE TABLE meetings (id TEXT); INSERT INTO meetings VALUES ('a'),('b'); PRAGMA user_version = 8;").unwrap();
        drop(copy);
        let before = names(&d);
        let problem = match open_or_problem(d.clone()) {
            Err(p) => p,
            Ok(_) => panic!("a damaged file must not open"),
        };
        assert_eq!(problem.kind, ProblemKind::Unreadable);
        assert!(problem.path.ends_with("nexq.db"));
        assert_eq!(problem.backups.len(), 1);
        assert_eq!((problem.backups[0].name.as_str(), problem.backups[0].meetings), ("nexq-before-workspaces.db", Some(2)));
        assert_eq!(std::fs::read(d.join("nexq.db")).unwrap(), vec![7u8; 6000], "not a byte changed");
        assert_eq!(names(&d), before, "no new file: no -wal, no copy, no migration");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn a_database_from_a_newer_version_is_left_alone() {
        let d = dir("newer");
        let conn = Connection::open(d.join("nexq.db")).unwrap();
        conn.execute_batch(&format!("CREATE TABLE t (x); PRAGMA user_version = {};", health::top_version() + 3)).unwrap();
        drop(conn);
        let before = std::fs::read(d.join("nexq.db")).unwrap();
        let problem = open_or_problem(d.clone()).err().expect("newer must not open");
        assert_eq!(problem.kind, ProblemKind::Newer);
        assert_eq!(std::fs::read(d.join("nexq.db")).unwrap(), before);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn a_normal_start_opens_and_puts_nothing_aside() {
        let d = dir("normal");
        let first = open_or_problem(d.clone()).ok().expect("a first start opens");
        drop(first);
        let again = open_or_problem(d.clone()).ok().expect("and so does the next one");
        drop(again);
        assert!(!names(&d).iter().any(|n| n.contains(".damaged-") || n.contains("pending-restore") || n.contains("restore-tmp")), "{:?}", names(&d));
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn a_recovery_cut_short_by_a_power_loss_is_finished_by_the_next_start() {
        let d = dir("resume");
        // The old file is already aside, the note says what to restore, and nexq.db is not there.
        let good = Connection::open(d.join("nexq-before-workspaces.db")).unwrap();
        migrations::run(&good).unwrap();
        good.execute("INSERT INTO meetings (id, title, start_time) VALUES ('only', 't', 'x')", []).unwrap();
        good.execute_batch("PRAGMA journal_mode = DELETE").unwrap();
        drop(good);
        std::fs::write(d.join("nexq.db.damaged-5"), b"damaged").unwrap();
        std::fs::write(
            d.join("nexq.db.pending-restore"),
            r#"{"action":"restore","source":"nexq-before-workspaces.db","stamp":5}"#,
        )
        .unwrap();
        let mgr = open_or_problem(d.clone()).ok().expect("the start finishes the restore and opens it");
        let n: i64 = mgr.connection().query_row("SELECT COUNT(*) FROM meetings", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1, "the restored meetings, not an empty database");
        assert_eq!(std::fs::read(d.join("nexq.db.damaged-5")).unwrap(), b"damaged");
        assert!(!d.join("nexq.db.pending-restore").exists());
        drop(mgr);
        let _ = std::fs::remove_dir_all(d);
    }
}
