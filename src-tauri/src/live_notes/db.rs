//! Saving and loading the notes of a meeting (table from `migrate_notes`).

use crate::live_notes::doc::NoteDoc;
use rusqlite::{params, Connection, OptionalExtension};

#[derive(Debug, Clone, PartialEq)]
pub struct StoredNotes {
    pub doc: NoteDoc,
    pub status: String,
    pub tokens_used: u64,
    pub cap: u64,
    pub updated_at: i64,
}

pub fn save_notes(conn: &Connection, meeting_id: &str, doc: &NoteDoc, status: &str, tokens_used: u64, cap: u64, now_ms: i64) -> rusqlite::Result<()> {
    let json = serde_json::to_string(doc).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
    conn.execute(
        "INSERT INTO meeting_notes (meeting_id, doc_json, status, tokens_used, cap, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(meeting_id) DO UPDATE SET
            doc_json = excluded.doc_json, status = excluded.status,
            tokens_used = excluded.tokens_used, cap = excluded.cap, updated_at = excluded.updated_at",
        params![meeting_id, json, status, tokens_used as i64, cap as i64, now_ms],
    )?;
    Ok(())
}

/// A row whose JSON cannot be read is treated as missing (never panics).
pub fn load_notes(conn: &Connection, meeting_id: &str) -> rusqlite::Result<Option<StoredNotes>> {
    let row = conn
        .query_row(
            "SELECT doc_json, status, tokens_used, cap, updated_at FROM meeting_notes WHERE meeting_id = ?1",
            params![meeting_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?, r.get::<_, i64>(4)?)),
        )
        .optional()?;
    Ok(row.and_then(|(json, status, used, cap, updated_at)| {
        serde_json::from_str::<NoteDoc>(&json).ok().map(|doc| StoredNotes {
            doc,
            status,
            tokens_used: used.max(0) as u64,
            cap: cap.max(0) as u64,
            updated_at,
        })
    }))
}

pub fn delete_notes(conn: &Connection, meeting_id: &str) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM meeting_notes WHERE meeting_id = ?1", params![meeting_id])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::live_notes::doc::BlockKind;
    use crate::live_notes::migrate::migrate_notes;

    fn conn() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        let tx = c.transaction().unwrap();
        migrate_notes(&tx).unwrap();
        tx.commit().unwrap();
        c
    }

    #[test]
    fn save_load_update_delete() {
        let c = conn();
        assert!(load_notes(&c, "m1").unwrap().is_none());
        let mut d = NoteDoc::new();
        let t = d.user_add(BlockKind::Topic, None, "Plan {{o:Acme}}", 10).unwrap();
        d.user_add(BlockKind::Bullet, Some(&t), "Né 来月", 20).unwrap();
        save_notes(&c, "m1", &d, "running", 1234, 120_000, 99).unwrap();
        let got = load_notes(&c, "m1").unwrap().unwrap();
        assert_eq!(got.doc, d);
        assert_eq!((got.status.as_str(), got.tokens_used, got.cap, got.updated_at), ("running", 1234, 120_000, 99));
        save_notes(&c, "m1", &d, "done", 2000, 120_000, 100).unwrap();
        assert_eq!(load_notes(&c, "m1").unwrap().unwrap().status, "done");
        assert_eq!(delete_notes(&c, "m1").unwrap(), 1);
        assert!(load_notes(&c, "m1").unwrap().is_none());
    }

    #[test]
    fn corrupt_row_reads_as_missing() {
        let c = conn();
        c.execute("INSERT INTO meeting_notes (meeting_id, doc_json) VALUES ('m2', '{not json')", []).unwrap();
        assert!(load_notes(&c, "m2").unwrap().is_none());
    }
}
