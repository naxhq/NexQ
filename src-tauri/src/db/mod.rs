pub mod context;
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
