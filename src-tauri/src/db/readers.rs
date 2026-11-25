//! A few read-only connections kept ready, so reads on the live path (search while a
//! meeting records, the workspace rail, change views) never wait for the shared
//! connection that the transcript writer uses. SQLite in WAL mode lets readers run
//! while it writes; they see what is committed.

use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::Mutex;

const KEEP_IDLE: usize = 4;

pub struct ReaderPool {
    path: PathBuf,
    idle: Mutex<Vec<Connection>>,
}

impl ReaderPool {
    pub fn new(path: PathBuf) -> Self {
        Self { path, idle: Mutex::new(Vec::new()) }
    }

    /// Runs `f` on a read-only connection. Err when none could be opened.
    pub fn with<T>(&self, f: impl FnOnce(&Connection) -> T) -> Result<T, String> {
        let kept = self.idle.lock().ok().and_then(|mut v| v.pop());
        let conn = match kept {
            Some(c) => c,
            None => super::open_reader(&self.path).map_err(|e| e.to_string())?,
        };
        let out = f(&conn);
        if let Ok(mut v) = self.idle.lock() {
            if v.len() < KEEP_IDLE {
                v.push(conn);
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_while_the_writer_holds_a_transaction_and_sees_only_committed_rows() {
        let dir = std::env::temp_dir().join(format!("nexq-readers-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.db");
        let w = super::super::open_writer(&path).unwrap_or_else(|_| {
            let c = Connection::open(&path).unwrap();
            c.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
            c
        });
        w.execute_batch("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);").unwrap();
        let pool = ReaderPool::new(path);
        w.execute_batch("BEGIN; INSERT INTO t VALUES (2);").unwrap();
        let n: i64 = pool.with(|c| c.query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0)).unwrap()).unwrap();
        assert_eq!(n, 1, "an open write is not visible and does not block");
        w.execute_batch("COMMIT;").unwrap();
        let n: i64 = pool.with(|c| c.query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0)).unwrap()).unwrap();
        assert_eq!(n, 2);
        assert!(pool.with(|c| c.execute("DELETE FROM t", [])).unwrap().is_err(), "readers cannot write");
        drop(pool);
        drop(w);
        let _ = std::fs::remove_dir_all(dir);
    }
}
