//! v10 migration: search passages, two external-content FTS5 indexes, the
//! sources table, meeting cards and period digests. Idempotent.
//!
//! * `search_fts` (porter + unicode61) indexes every passage.
//! * `search_fts_tri` (trigram) indexes only passages that are mostly CJK
//!   (`search_passages.cjk = 1`), because unicode61 cannot split Japanese or
//!   Chinese into words. Queries shorter than three characters fall back to a
//!   scoped LIKE scan (see `search.rs`).
//!
//! `search_passages.cjk` is an addition to the spec's column list.

use rusqlite::Transaction;

pub const SEARCH_SCHEMA_VERSION: i64 = 10;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS search_passages (
    id          INTEGER PRIMARY KEY,
    kind        TEXT NOT NULL CHECK(kind IN ('transcript','document','folder','talking_point')),
    ref_id      TEXT NOT NULL,
    sub_ref     TEXT NULL,
    title       TEXT NOT NULL DEFAULT '',
    start_ms    INTEGER NULL,
    end_ms      INTEGER NULL,
    text        TEXT NOT NULL,
    tokens      INTEGER NOT NULL DEFAULT 0,
    occurred_at INTEGER NULL,
    cjk         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_search_passages_src ON search_passages(kind, ref_id, sub_ref);
CREATE INDEX IF NOT EXISTS idx_search_passages_cjk ON search_passages(cjk) WHERE cjk = 1;

CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
    text, title,
    content='search_passages', content_rowid='id',
    tokenize='porter unicode61 remove_diacritics 2'
);
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts_tri USING fts5(
    text, title,
    content='search_passages', content_rowid='id',
    tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS search_passages_ai AFTER INSERT ON search_passages BEGIN
    INSERT INTO search_fts(rowid, text, title) VALUES (new.id, new.text, new.title);
    INSERT INTO search_fts_tri(rowid, text, title) SELECT new.id, new.text, new.title WHERE new.cjk = 1;
END;
CREATE TRIGGER IF NOT EXISTS search_passages_ad AFTER DELETE ON search_passages BEGIN
    INSERT INTO search_fts(search_fts, rowid, text, title) VALUES ('delete', old.id, old.text, old.title);
    INSERT INTO search_fts_tri(search_fts_tri, rowid, text, title)
        SELECT 'delete', old.id, old.text, old.title WHERE old.cjk = 1;
END;
CREATE TRIGGER IF NOT EXISTS search_passages_au AFTER UPDATE OF text, title, cjk ON search_passages BEGIN
    INSERT INTO search_fts(search_fts, rowid, text, title) VALUES ('delete', old.id, old.text, old.title);
    INSERT INTO search_fts_tri(search_fts_tri, rowid, text, title)
        SELECT 'delete', old.id, old.text, old.title WHERE old.cjk = 1;
    INSERT INTO search_fts(rowid, text, title) VALUES (new.id, new.text, new.title);
    INSERT INTO search_fts_tri(rowid, text, title) SELECT new.id, new.text, new.title WHERE new.cjk = 1;
END;

CREATE TABLE IF NOT EXISTS search_sources (
    kind         TEXT NOT NULL,
    ref_id       TEXT NOT NULL,
    sub_ref      TEXT NOT NULL DEFAULT '',
    content_hash TEXT NOT NULL DEFAULT '',
    mtime        INTEGER NOT NULL DEFAULT 0,
    size         INTEGER NOT NULL DEFAULT 0,
    status       TEXT NOT NULL DEFAULT 'ok',
    error        TEXT NULL,
    indexed_at   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (kind, ref_id, sub_ref)
);

CREATE TABLE IF NOT EXISTS search_embeddings (
    passage_id INTEGER PRIMARY KEY,
    model      TEXT NOT NULL,
    dims       INTEGER NOT NULL,
    vec        BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS meeting_cards (
    meeting_id  TEXT PRIMARY KEY,
    recap       TEXT NOT NULL DEFAULT '',
    origin      TEXT NOT NULL CHECK(origin IN ('summary','extract','ai')),
    source_hash TEXT NOT NULL DEFAULT '',
    tokens      INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS period_digests (
    workspace_id TEXT NOT NULL,
    period       TEXT NOT NULL,
    text         TEXT NOT NULL DEFAULT '',
    source_hash  TEXT NOT NULL DEFAULT '',
    tokens       INTEGER NOT NULL DEFAULT 0,
    updated_at   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace_id, period)
);
";

/// Creates every v10 object. Safe to run again.
pub fn migrate_search(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(SCHEMA)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn migration_is_idempotent_and_creates_the_objects() {
        let mut conn = Connection::open_in_memory().unwrap();
        for _ in 0..2 {
            let tx = conn.transaction().unwrap();
            migrate_search(&tx).unwrap();
            tx.commit().unwrap();
        }
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name IN
                 ('search_passages','search_fts','search_fts_tri','search_sources',
                  'search_embeddings','meeting_cards','period_digests',
                  'search_passages_ai','search_passages_ad','search_passages_au')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 10);
    }

    #[test]
    fn triggers_keep_both_indexes_in_step() {
        let mut conn = Connection::open_in_memory().unwrap();
        let tx = conn.transaction().unwrap();
        migrate_search(&tx).unwrap();
        tx.commit().unwrap();
        conn.execute(
            "INSERT INTO search_passages(kind, ref_id, title, text, cjk) VALUES ('document','d1','t','pricing review',0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO search_passages(kind, ref_id, title, text, cjk) VALUES ('document','d2','t','来月の契約更新について',1)",
            [],
        )
        .unwrap();
        let hits = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
        assert_eq!(hits("SELECT COUNT(*) FROM search_fts WHERE search_fts MATCH 'pricing'"), 1);
        assert_eq!(hits("SELECT COUNT(*) FROM search_fts_tri WHERE search_fts_tri MATCH '\"契約更\"'"), 1);
        conn.execute("UPDATE search_passages SET text = 'budget memo' WHERE ref_id = 'd1'", []).unwrap();
        assert_eq!(hits("SELECT COUNT(*) FROM search_fts WHERE search_fts MATCH 'pricing'"), 0);
        assert_eq!(hits("SELECT COUNT(*) FROM search_fts WHERE search_fts MATCH 'budget'"), 1);
        conn.execute("DELETE FROM search_passages WHERE ref_id = 'd2'", []).unwrap();
        assert_eq!(hits("SELECT COUNT(*) FROM search_fts_tri WHERE search_fts_tri MATCH '\"契約更\"'"), 0);
        // integrity of the external-content indexes
        conn.execute("INSERT INTO search_fts(search_fts) VALUES('integrity-check')", []).unwrap();
        conn.execute("INSERT INTO search_fts_tri(search_fts_tri) VALUES('integrity-check')", []).unwrap();
    }
}
