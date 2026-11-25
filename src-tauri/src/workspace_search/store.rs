//! Reads and writes of the v10 tables. Every write helper is meant to run
//! inside one small transaction on the indexer's own connection.

use super::passages::NewPassage;
use super::{now_ms, PassageKind, SourceStatus};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

pub fn sha_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut s = String::with_capacity(64);
    for b in digest.iter() {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

/// What was stored the last time a source was indexed.
#[derive(Debug, Clone, PartialEq)]
pub struct SourceRow {
    pub content_hash: String,
    pub mtime: i64,
    pub size: i64,
    pub status: String,
    pub error: Option<String>,
}

pub fn get_source(
    conn: &Connection,
    kind: PassageKind,
    ref_id: &str,
    sub_ref: &str,
) -> rusqlite::Result<Option<SourceRow>> {
    conn.query_row(
        "SELECT content_hash, mtime, size, status, error FROM search_sources
         WHERE kind = ?1 AND ref_id = ?2 AND sub_ref = ?3",
        params![kind.as_str(), ref_id, sub_ref],
        |r| {
            Ok(SourceRow {
                content_hash: r.get(0)?,
                mtime: r.get(1)?,
                size: r.get(2)?,
                status: r.get(3)?,
                error: r.get(4)?,
            })
        },
    )
    .optional()
}

/// Insert or update a source row (no passage changes).
pub fn upsert_source(
    conn: &Connection,
    kind: PassageKind,
    ref_id: &str,
    sub_ref: &str,
    content_hash: &str,
    mtime: i64,
    size: i64,
    status: &str,
    error: Option<&str>,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO search_sources(kind, ref_id, sub_ref, content_hash, mtime, size, status, error, indexed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(kind, ref_id, sub_ref) DO UPDATE SET
            content_hash = excluded.content_hash, mtime = excluded.mtime, size = excluded.size,
            status = excluded.status, error = excluded.error, indexed_at = excluded.indexed_at",
        params![kind.as_str(), ref_id, sub_ref, content_hash, mtime, size, status, error, now_ms()],
    )?;
    Ok(())
}

/// Delete the passages of one source (`sub_ref` of `None` means the
/// passages without a sub reference).
pub fn delete_passages(
    conn: &Connection,
    kind: PassageKind,
    ref_id: &str,
    sub_ref: Option<&str>,
) -> rusqlite::Result<usize> {
    conn.execute(
        "DELETE FROM search_passages WHERE kind = ?1 AND ref_id = ?2 AND sub_ref IS ?3",
        params![kind.as_str(), ref_id, sub_ref],
    )
}

/// Replace a source's passages and source row together.
pub fn replace_source(
    conn: &Connection,
    kind: PassageKind,
    ref_id: &str,
    sub_ref: Option<&str>,
    passages: &[NewPassage],
    content_hash: &str,
    mtime: i64,
    size: i64,
) -> rusqlite::Result<()> {
    delete_passages(conn, kind, ref_id, sub_ref)?;
    {
        let mut stmt = conn.prepare_cached(
            "INSERT INTO search_passages
                (kind, ref_id, sub_ref, title, start_ms, end_ms, text, tokens, occurred_at, cjk)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        )?;
        for p in passages {
            stmt.execute(params![
                p.kind.as_str(),
                p.ref_id,
                p.sub_ref,
                p.title,
                p.start_ms,
                p.end_ms,
                p.text,
                p.tokens as i64,
                p.occurred_at,
                p.cjk as i64
            ])?;
        }
    }
    upsert_source(conn, kind, ref_id, sub_ref.unwrap_or(""), content_hash, mtime, size, "ok", None)
}

/// Remove everything indexed for a reference: all passages, all source rows
/// (every sub reference), and a meeting's card. Used when a meeting,
/// document, folder or talking point is deleted.
pub fn remove_ref(conn: &Connection, kind: PassageKind, ref_id: &str) -> rusqlite::Result<()> {
    // The one purge (passages, embeddings, source rows, a meeting's card).
    crate::workspace::purge::purge_search_rows(conn, kind.as_str(), ref_id).map_err(rusqlite::Error::InvalidParameterName)
}

/// Public hook for `delete_meeting`: passages, source rows and the card.
pub fn remove_meeting(conn: &Connection, meeting_id: &str) -> rusqlite::Result<()> {
    remove_ref(conn, PassageKind::Transcript, meeting_id)
}

/// Sub references (file paths) currently indexed or skipped for a folder.
pub fn list_sub_refs(
    conn: &Connection,
    kind: PassageKind,
    ref_id: &str,
) -> rusqlite::Result<Vec<(String, SourceRow)>> {
    let mut stmt = conn.prepare(
        "SELECT sub_ref, content_hash, mtime, size, status, error FROM search_sources
         WHERE kind = ?1 AND ref_id = ?2",
    )?;
    let rows = stmt.query_map(params![kind.as_str(), ref_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            SourceRow {
                content_hash: r.get(1)?,
                mtime: r.get(2)?,
                size: r.get(3)?,
                status: r.get(4)?,
                error: r.get(5)?,
            },
        ))
    })?;
    rows.collect()
}

/// Every reference of a kind that has a source row.
pub fn list_refs(conn: &Connection, kind: PassageKind) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT DISTINCT ref_id FROM search_sources WHERE kind = ?1")?;
    let rows = stmt.query_map(params![kind.as_str()], |r| r.get::<_, String>(0))?;
    rows.collect()
}

/// Skipped and failed files of a folder, with the reason.
pub fn list_problem_sources(
    conn: &Connection,
    kind: PassageKind,
    ref_id: &str,
) -> rusqlite::Result<Vec<SourceStatus>> {
    let mut stmt = conn.prepare(
        "SELECT kind, ref_id, sub_ref, status, error, indexed_at FROM search_sources
         WHERE kind = ?1 AND ref_id = ?2 AND status != 'ok' ORDER BY sub_ref",
    )?;
    let rows = stmt.query_map(params![kind.as_str(), ref_id], |r| {
        Ok(SourceStatus {
            kind: r.get(0)?,
            ref_id: r.get(1)?,
            sub_ref: r.get(2)?,
            status: r.get(3)?,
            error: r.get(4)?,
            indexed_at: r.get(5)?,
        })
    })?;
    rows.collect()
}

/// Counts for the status page: (sources ok, passages).
pub fn counts(conn: &Connection, kind: PassageKind, ref_id: &str) -> rusqlite::Result<(i64, i64)> {
    let sources: i64 = conn.query_row(
        "SELECT COUNT(*) FROM search_sources WHERE kind = ?1 AND ref_id = ?2 AND status = 'ok'",
        params![kind.as_str(), ref_id],
        |r| r.get(0),
    )?;
    let passages: i64 = conn.query_row(
        "SELECT COUNT(*) FROM search_passages WHERE kind = ?1 AND ref_id = ?2",
        params![kind.as_str(), ref_id],
        |r| r.get(0),
    )?;
    Ok((sources, passages))
}

/// Update only the title of a meeting's passages (rename).
pub fn rename_meeting_passages(conn: &Connection, meeting_id: &str, title: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE search_passages SET title = ?2 WHERE kind = 'transcript' AND ref_id = ?1 AND title != ?2",
        params![meeting_id, title],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_search::passages::build_text_passages;
    use crate::workspace_search::test_support::mem_db;

    #[test]
    fn sha_hex_matches_the_standard_vector() {
        assert_eq!(
            sha_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn replace_then_remove_leaves_nothing_behind() {
        let conn = mem_db();
        let p = build_text_passages(PassageKind::Document, "d1", None, "Doc", "alpha beta gamma", None);
        replace_source(&conn, PassageKind::Document, "d1", None, &p, "h1", 0, 16).unwrap();
        assert_eq!(counts(&conn, PassageKind::Document, "d1").unwrap(), (1, 1));
        // replacing does not duplicate
        replace_source(&conn, PassageKind::Document, "d1", None, &p, "h2", 0, 16).unwrap();
        assert_eq!(counts(&conn, PassageKind::Document, "d1").unwrap(), (1, 1));
        assert_eq!(get_source(&conn, PassageKind::Document, "d1", "").unwrap().unwrap().content_hash, "h2");
        remove_ref(&conn, PassageKind::Document, "d1").unwrap();
        assert_eq!(counts(&conn, PassageKind::Document, "d1").unwrap(), (0, 0));
        let fts: i64 = conn
            .query_row("SELECT COUNT(*) FROM search_fts WHERE search_fts MATCH 'alpha'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fts, 0);
    }
}
