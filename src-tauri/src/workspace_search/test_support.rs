//! Test helpers: an in-memory database with the pieces of the app schema the
//! search code reads (meetings, transcript_segments) plus the v10 tables.

use super::passages::{build_text_passages, build_transcript_passages, NewPassage, SegmentInput};
use super::{migrate_search, store, PassageKind};
use rusqlite::{params, Connection};

pub const APP_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS meetings (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT,
    duration_seconds INTEGER,
    transcript TEXT NOT NULL DEFAULT '[]',
    ai_interactions TEXT NOT NULL DEFAULT '[]',
    summary TEXT,
    config_snapshot TEXT
);
CREATE TABLE IF NOT EXISTS transcript_segments (
    id TEXT PRIMARY KEY NOT NULL,
    meeting_id TEXT NOT NULL,
    text TEXT NOT NULL,
    speaker TEXT NOT NULL DEFAULT 'Unknown',
    speaker_id TEXT,
    speaker_tag TEXT,
    timestamp_ms INTEGER NOT NULL,
    is_final BOOLEAN NOT NULL DEFAULT 0,
    confidence REAL NOT NULL DEFAULT 0.0,
    created_at TEXT NOT NULL
);
";

pub fn migrate(conn: &mut Connection) {
    let tx = conn.transaction().unwrap();
    migrate_search(&tx).unwrap();
    tx.commit().unwrap();
}

/// In-memory database with the app tables and the v10 schema.
pub fn mem_db() -> Connection {
    let mut conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(APP_SCHEMA).unwrap();
    migrate(&mut conn);
    conn
}

/// A file database (WAL-capable) in a fresh temp directory.
pub fn file_db(dir: &std::path::Path) -> std::path::PathBuf {
    let path = dir.join("nexq.db");
    let mut conn = Connection::open(&path).unwrap();
    conn.execute_batch(APP_SCHEMA).unwrap();
    migrate(&mut conn);
    path
}

pub fn temp_dir(tag: &str) -> std::path::PathBuf {
    static COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "nexq-ws-search-{}-{}-{}-{}",
        tag,
        std::process::id(),
        super::now_ms(),
        COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Insert a meeting row plus final transcript segments.
pub fn add_meeting(
    conn: &Connection,
    id: &str,
    title: &str,
    start_time: &str,
    summary: Option<&str>,
    lines: &[(&str, &str, i64)],
) {
    conn.execute(
        "INSERT OR REPLACE INTO meetings(id, title, start_time, duration_seconds, summary) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, title, start_time, lines.last().map(|l| l.2 / 1000 + 5).unwrap_or(0), summary],
    )
    .unwrap();
    for (i, (speaker, text, ts)) in lines.iter().enumerate() {
        conn.execute(
            "INSERT INTO transcript_segments(id, meeting_id, text, speaker, timestamp_ms, is_final, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)",
            params![format!("{id}-{i}"), id, text, speaker, ts, start_time],
        )
        .unwrap();
    }
}

/// Index passages for a transcript directly (no meetings table needed).
pub fn index_lines(conn: &Connection, id: &str, title: &str, occurred_at: i64, lines: &[(&str, &str, i64)]) {
    let segs: Vec<SegmentInput> = lines
        .iter()
        .map(|(s, t, ms)| SegmentInput { speaker: s.to_string(), text: t.to_string(), start_ms: *ms })
        .collect();
    let p: Vec<NewPassage> = build_transcript_passages(id, title, Some(occurred_at), &segs, None);
    store::replace_source(conn, PassageKind::Transcript, id, None, &p, "h", 0, 0).unwrap();
}

pub fn index_doc(conn: &Connection, id: &str, title: &str, text: &str) {
    let p = build_text_passages(PassageKind::Document, id, None, title, text, None);
    store::replace_source(conn, PassageKind::Document, id, None, &p, "h", 0, 0).unwrap();
}
