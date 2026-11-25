//! Schema v12: live notes. One idempotent function; the caller runs it inside
//! the shared migration transaction (a failure rolls the whole step back).

use rusqlite::Transaction;

pub const NOTES_SCHEMA_STEP: u32 = 12;

pub fn migrate_notes(tx: &Transaction) -> rusqlite::Result<()> {
    migrate_notes_conn(tx)
}

/// The step as `STEPS` runs it (inside the shared migration transaction).
pub fn migrate_notes_conn(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS meeting_notes (
            meeting_id   TEXT PRIMARY KEY NOT NULL,
            doc_json     TEXT NOT NULL,
            status       TEXT NOT NULL DEFAULT 'idle',
            tokens_used  INTEGER NOT NULL DEFAULT 0,
            cap          INTEGER NOT NULL DEFAULT 0,
            updated_at   INTEGER NOT NULL DEFAULT 0
        );
        ",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn creates_table_and_is_idempotent() {
        let mut conn = Connection::open_in_memory().unwrap();
        for _ in 0..2 {
            let tx = conn.transaction().unwrap();
            migrate_notes(&tx).unwrap();
            tx.commit().unwrap();
        }
        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(meeting_notes)")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(cols, ["meeting_id", "doc_json", "status", "tokens_used", "cap", "updated_at"]);
    }

    #[test]
    fn rolls_back_with_the_transaction() {
        let mut conn = Connection::open_in_memory().unwrap();
        {
            let tx = conn.transaction().unwrap();
            migrate_notes(&tx).unwrap();
            // dropped without commit
        }
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE name='meeting_notes'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }
}
