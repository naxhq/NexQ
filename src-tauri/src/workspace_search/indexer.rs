//! The background indexer. `run_pass` is a plain synchronous function over a
//! connection that the caller owns (testable without threads);
//! [`IndexerService`] wraps it in a low-priority thread with its own SQLite
//! connection (WAL, 5 s busy timeout).
//!
//! Properties: newest meetings first; idempotent (a source is re-indexed only
//! when its signature or hash changed); small transactions (one per source);
//! paused while a meeting is active; cancellable; resumable (progress lives
//! in `search_sources`); one bad file or one panic never stops the pass.

use super::cards::{build_card, card_is_current, card_key, put_card};
use super::cjk::unit_count;
use super::crawler::{crawl_folder, CrawlFile, CrawlOptions};
use super::passages::{
    build_markdown_passages, build_text_passages, build_transcript_passages, NewPassage, SegmentInput,
};
use super::store::{self, sha_hex};
use super::PassageKind;
use rusqlite::{params, Connection, TransactionBehavior};
use std::collections::{HashMap, HashSet};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

// ── inputs ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct DocInput {
    pub id: String,
    pub name: String,
    pub text: String,
}

#[derive(Debug, Clone)]
pub struct FolderInput {
    pub id: String,
    pub path: PathBuf,
    /// The user's opt-in for this folder's text. Off: nothing is indexed and
    /// anything indexed before is removed.
    pub index_enabled: bool,
}

#[derive(Debug, Clone)]
pub struct TalkingPointInput {
    pub id: String,
    pub title: String,
    pub plain_text: String,
    pub in_context: bool,
}

/// What the indexer needs besides meetings (which it reads from the database
/// itself). Implemented by the workspaces layer.
pub trait IndexProvider: Send + Sync {
    fn documents(&self) -> Vec<DocInput> {
        Vec::new()
    }
    fn folders(&self) -> Vec<FolderInput> {
        Vec::new()
    }
    fn talking_points(&self) -> Vec<TalkingPointInput> {
        Vec::new()
    }
}

/// A provider with nothing but meetings.
pub struct MeetingsOnly;
impl IndexProvider for MeetingsOnly {}

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct IndexProgress {
    pub done: usize,
    pub total: usize,
    pub current: String,
    pub skipped: usize,
}

// ── control ─────────────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct RunControl {
    stop: Arc<AtomicBool>,
    pass_cancel: Arc<AtomicBool>,
    meeting_active: Arc<dyn Fn() -> bool + Send + Sync>,
    /// Pause between units so the pass stays out of the way.
    pub pace: Duration,
}

impl RunControl {
    pub fn new(meeting_active: Arc<dyn Fn() -> bool + Send + Sync>) -> Self {
        RunControl {
            stop: Arc::new(AtomicBool::new(false)),
            pass_cancel: Arc::new(AtomicBool::new(false)),
            meeting_active,
            pace: Duration::ZERO,
        }
    }
    pub fn idle() -> Self {
        Self::new(Arc::new(|| false))
    }
    pub fn cancelled(&self) -> bool {
        self.stop.load(Ordering::SeqCst) || self.pass_cancel.load(Ordering::SeqCst)
    }
    pub fn cancel(&self) {
        self.pass_cancel.store(true, Ordering::SeqCst);
    }
    pub fn reset_cancel(&self) {
        self.pass_cancel.store(false, Ordering::SeqCst);
    }
    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }
    /// Wait while a meeting is active. Returns false when cancelled.
    pub fn checkpoint(&self) -> bool {
        while (self.meeting_active)() {
            if self.cancelled() {
                return false;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        if !self.pace.is_zero() {
            std::thread::sleep(self.pace);
        }
        !self.cancelled()
    }
}

// ── connection ──────────────────────────────────────────────────────────────

/// A connection for search and indexing: WAL, 5 s busy timeout, normal sync.
pub fn open_search_connection(path: &std::path::Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| format!("open search database: {e}"))?;
    conn.busy_timeout(Duration::from_secs(5)).map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")
        .map_err(|e| format!("search database pragmas: {e}"))?;
    Ok(conn)
}

// ── meetings ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct MeetingRow {
    id: String,
    title: String,
    start_time: String,
    duration_s: Option<i64>,
    summary: Option<String>,
}

fn parse_ms(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis())
}

fn list_meetings(conn: &Connection) -> rusqlite::Result<Vec<MeetingRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, start_time, duration_seconds, summary FROM meetings ORDER BY start_time DESC, id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(MeetingRow {
            id: r.get(0)?,
            title: r.get(1)?,
            start_time: r.get(2)?,
            duration_s: r.get(3)?,
            summary: r.get(4)?,
        })
    })?;
    rows.collect()
}

fn meeting_row(conn: &Connection, id: &str) -> rusqlite::Result<Option<MeetingRow>> {
    use rusqlite::OptionalExtension;
    conn.query_row(
        "SELECT id, title, start_time, duration_seconds, summary FROM meetings WHERE id = ?1",
        params![id],
        |r| {
            Ok(MeetingRow {
                id: r.get(0)?,
                title: r.get(1)?,
                start_time: r.get(2)?,
                duration_s: r.get(3)?,
                summary: r.get(4)?,
            })
        },
    )
    .optional()
}

fn meeting_sig(conn: &Connection, id: &str) -> rusqlite::Result<(i64, i64)> {
    conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(LENGTH(text)), 0) FROM transcript_segments
         WHERE meeting_id = ?1 AND is_final = 1 AND TRIM(text) != ''",
        params![id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
}

fn has_speaker_tag(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('transcript_segments') WHERE name = 'speaker_tag'",
        [],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n > 0)
    .unwrap_or(false)
}

fn load_segments(conn: &Connection, id: &str) -> rusqlite::Result<Vec<SegmentInput>> {
    let tag = if has_speaker_tag(conn) { "speaker_tag" } else { "NULL" };
    let sql = format!(
        "SELECT speaker, {tag}, text, timestamp_ms FROM transcript_segments
         WHERE meeting_id = ?1 AND is_final = 1 AND TRIM(text) != '' ORDER BY timestamp_ms, id"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![id], |r| {
        let speaker: String = r.get(0)?;
        let tag: Option<String> = r.get(1)?;
        let label = match (speaker.as_str(), tag.as_deref()) {
            ("Them", Some(t)) if !t.is_empty() => crate::db::meetings::default_remote_speaker_name(t),
            _ => speaker,
        };
        Ok(SegmentInput { speaker: label, text: r.get(2)?, start_ms: r.get(3)? })
    })?;
    rows.collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Indexed,
    Unchanged,
    Removed,
}

fn segments_hash(segs: &[SegmentInput]) -> String {
    let mut buf = String::new();
    for s in segs {
        buf.push_str(&s.speaker);
        buf.push('\u{1}');
        buf.push_str(&s.start_ms.to_string());
        buf.push('\u{1}');
        buf.push_str(&s.text);
        buf.push('\u{2}');
    }
    sha_hex(buf.as_bytes())
}

/// Index (or refresh) one meeting and its card.
fn index_meeting_row(conn: &mut Connection, m: &MeetingRow) -> Result<Outcome, String> {
    let e = |x: rusqlite::Error| x.to_string();
    let (count, len) = meeting_sig(conn, &m.id).map_err(e)?;
    let existing = store::get_source(conn, PassageKind::Transcript, &m.id, "").map_err(e)?;
    let sig_same = existing.as_ref().map_or(false, |s| s.status == "ok" && s.mtime == count && s.size == len);
    let mut outcome = Outcome::Unchanged;
    let mut loaded: Option<Vec<SegmentInput>> = None;
    if !sig_same {
        let segs = load_segments(conn, &m.id).map_err(e)?;
        let hash = segments_hash(&segs);
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(e)?;
        if existing.as_ref().map_or(false, |s| s.status == "ok" && s.content_hash == hash) {
            store::upsert_source(&tx, PassageKind::Transcript, &m.id, "", &hash, count, len, "ok", None).map_err(e)?;
        } else {
            let total_ms = m.duration_s.map(|d| d * 1000);
            let p = build_transcript_passages(&m.id, &m.title, parse_ms(&m.start_time), &segs, total_ms);
            store::replace_source(&tx, PassageKind::Transcript, &m.id, None, &p, &hash, count, len).map_err(e)?;
            outcome = Outcome::Indexed;
        }
        tx.commit().map_err(e)?;
        loaded = Some(segs);
    }
    // a rename only touches the stored titles
    store::rename_meeting_passages(conn, &m.id, &m.title).map_err(e)?;

    // card
    let key = card_key(&m.title, m.summary.as_deref(), count, len, m.duration_s);
    if !card_is_current(conn, &m.id, &key).map_err(e)? {
        let segs = match loaded {
            Some(s) => s,
            None if m.summary.as_deref().map_or(true, |s| s.trim().is_empty()) => {
                load_segments(conn, &m.id).map_err(e)?
            }
            None => Vec::new(),
        };
        let card = build_card(
            &super::cards::CardInput {
                meeting_id: &m.id,
                title: &m.title,
                started_at_ms: parse_ms(&m.start_time),
                duration_s: m.duration_s,
                summary: m.summary.as_deref(),
                lines: &segs,
            },
            &key,
        );
        put_card(conn, &card).map_err(e)?;
    }
    Ok(outcome)
}

/// Index one meeting by id (called when a meeting ends). Removes it from the
/// index when the meeting no longer exists.
pub fn index_meeting(conn: &mut Connection, meeting_id: &str) -> Result<Outcome, String> {
    match meeting_row(conn, meeting_id).map_err(|e| e.to_string())? {
        Some(m) => index_meeting_row(conn, &m),
        None => {
            store::remove_meeting(conn, meeting_id).map_err(|e| e.to_string())?;
            Ok(Outcome::Removed)
        }
    }
}

// ── documents, talking points ───────────────────────────────────────────────

fn index_text_source(
    conn: &mut Connection,
    kind: PassageKind,
    id: &str,
    title: &str,
    text: &str,
) -> Result<Outcome, String> {
    let e = |x: rusqlite::Error| x.to_string();
    let hash = sha_hex(format!("{title}\u{1}{text}").as_bytes());
    let existing = store::get_source(conn, kind, id, "").map_err(e)?;
    if existing.as_ref().map_or(false, |s| s.status == "ok" && s.content_hash == hash) {
        return Ok(Outcome::Unchanged);
    }
    let p = build_text_passages(kind, id, None, title, text, None);
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(e)?;
    store::replace_source(&tx, kind, id, None, &p, &hash, 0, text.len() as i64).map_err(e)?;
    tx.commit().map_err(e)?;
    Ok(Outcome::Indexed)
}

// ── folders ─────────────────────────────────────────────────────────────────

fn decode_text(bytes: &[u8]) -> String {
    let payload = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    match std::str::from_utf8(payload) {
        Ok(s) => s.to_string(),
        Err(_) => encoding_rs::WINDOWS_1252.decode(payload).0.into_owned(),
    }
}

/// Read a file, hash it, extract its text. Panics in extractors are caught.
fn read_file(file: &CrawlFile) -> Result<(String, String), String> {
    let bytes = std::fs::read(&file.abs_path).map_err(|e| format!("not readable ({})", e.kind()))?;
    let hash = sha_hex(&bytes);
    let path_str = file.abs_path.to_string_lossy().into_owned();
    let text = match file.ext.as_str() {
        "md" | "txt" => decode_text(&bytes),
        "pdf" => catch_unwind(AssertUnwindSafe(|| crate::context::pdf_extractor::extract_text_from_pdf(&path_str)))
            .map_err(|_| "could not read this PDF".to_string())??,
        "docx" => catch_unwind(AssertUnwindSafe(|| crate::rag::file_processor::extract_docx_text(&path_str)))
            .map_err(|_| "could not read this Word file".to_string())??,
        other => return Err(format!("unsupported type .{other}")),
    };
    let nuls = text.chars().take(4096).filter(|c| *c == '\0').count();
    if nuls > 8 {
        return Err("looks like a binary file".into());
    }
    Ok((hash, text))
}

#[derive(Debug, Clone, Default)]
pub struct FolderReport {
    pub indexed: usize,
    pub unchanged: usize,
    pub skipped: usize,
    pub failed: usize,
    pub removed: usize,
    pub truncated: bool,
    pub cancelled: bool,
}

fn index_folder(
    conn: &mut Connection,
    folder: &FolderInput,
    ctl: &RunControl,
    on_file: &mut dyn FnMut(&str, usize),
) -> Result<FolderReport, String> {
    let e = |x: rusqlite::Error| x.to_string();
    let mut rep = FolderReport::default();
    let crawl = crawl_folder(&folder.path, &CrawlOptions::default(), &|| ctl.cancelled())?;
    rep.truncated = crawl.truncated;
    let existing: HashMap<String, store::SourceRow> =
        store::list_sub_refs(conn, PassageKind::Folder, &folder.id).map_err(e)?.into_iter().collect();
    let mut seen: HashSet<String> = HashSet::new();
    on_file("", crawl.files.len());

    for sk in &crawl.skipped {
        seen.insert(sk.rel_path.clone());
        let unchanged = existing.get(&sk.rel_path).map_or(false, |r| r.status == "skipped" && r.error.as_deref() == Some(&sk.reason));
        if !unchanged {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(e)?;
            store::delete_passages(&tx, PassageKind::Folder, &folder.id, Some(&sk.rel_path)).map_err(e)?;
            store::upsert_source(&tx, PassageKind::Folder, &folder.id, &sk.rel_path, "", 0, 0, "skipped", Some(&sk.reason)).map_err(e)?;
            tx.commit().map_err(e)?;
        }
        rep.skipped += 1;
    }

    for f in &crawl.files {
        if !ctl.checkpoint() {
            rep.cancelled = true;
            return Ok(rep);
        }
        seen.insert(f.rel_path.clone());
        on_file(&f.rel_path, 0);
        let prev = existing.get(&f.rel_path);
        if prev.map_or(false, |r| r.status == "ok" && r.mtime == f.mtime_ms && r.size == f.size as i64) {
            rep.unchanged += 1;
            continue;
        }
        let work = catch_unwind(AssertUnwindSafe(|| -> Result<Option<(String, Vec<NewPassage>)>, String> {
            let (hash, text) = read_file(f)?;
            if prev.map_or(false, |r| r.status == "ok" && r.content_hash == hash) {
                return Ok(None);
            }
            let stem = f.rel_path.rsplit('/').next().unwrap_or(&f.rel_path).to_string();
            let p = if f.ext == "md" {
                build_markdown_passages(&folder.id, &f.rel_path, &text, Some(f.mtime_ms))
            } else {
                build_text_passages(PassageKind::Folder, &folder.id, Some(&f.rel_path), &stem, &text, Some(f.mtime_ms))
            };
            Ok(Some((hash, p)))
        }));
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(e)?;
        match work {
            Ok(Ok(Some((hash, passages)))) => {
                store::replace_source(&tx, PassageKind::Folder, &folder.id, Some(&f.rel_path), &passages, &hash, f.mtime_ms, f.size as i64).map_err(e)?;
                rep.indexed += 1;
            }
            Ok(Ok(None)) => {
                let hash = prev.map(|r| r.content_hash.clone()).unwrap_or_default();
                store::upsert_source(&tx, PassageKind::Folder, &folder.id, &f.rel_path, &hash, f.mtime_ms, f.size as i64, "ok", None).map_err(e)?;
                rep.unchanged += 1;
            }
            Ok(Err(msg)) => {
                store::delete_passages(&tx, PassageKind::Folder, &folder.id, Some(&f.rel_path)).map_err(e)?;
                store::upsert_source(&tx, PassageKind::Folder, &folder.id, &f.rel_path, "", f.mtime_ms, f.size as i64, "error", Some(&msg)).map_err(e)?;
                rep.failed += 1;
            }
            Err(_) => {
                store::delete_passages(&tx, PassageKind::Folder, &folder.id, Some(&f.rel_path)).map_err(e)?;
                store::upsert_source(&tx, PassageKind::Folder, &folder.id, &f.rel_path, "", f.mtime_ms, f.size as i64, "error", Some("could not read this file")).map_err(e)?;
                rep.failed += 1;
            }
        }
        tx.commit().map_err(e)?;
    }

    // files that disappeared (only when the walk saw everything)
    if !crawl.truncated {
        for (sub, _) in existing.iter().filter(|(k, _)| !seen.contains(*k)) {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(e)?;
            store::delete_passages(&tx, PassageKind::Folder, &folder.id, Some(sub)).map_err(e)?;
            tx.execute(
                "DELETE FROM search_sources WHERE kind = 'folder' AND ref_id = ?1 AND sub_ref = ?2",
                params![folder.id, sub],
            )
            .map_err(e)?;
            tx.commit().map_err(e)?;
            rep.removed += 1;
        }
    }
    Ok(rep)
}

// ── the pass ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default)]
pub struct PassReport {
    pub meetings_indexed: usize,
    pub meetings_unchanged: usize,
    pub documents_indexed: usize,
    pub points_indexed: usize,
    pub files_indexed: usize,
    pub files_skipped: usize,
    pub files_failed: usize,
    pub removed: usize,
    pub errors: Vec<String>,
    pub cancelled: bool,
}

/// One full pass: meetings (newest first), documents, talking points, then
/// folders. Safe to run again at any time; interrupted passes resume because
/// every source is recorded as it completes.
pub fn run_pass(
    conn: &mut Connection,
    provider: &dyn IndexProvider,
    ctl: &RunControl,
    progress: &dyn Fn(IndexProgress),
) -> PassReport {
    let mut rep = PassReport::default();
    let meetings = match list_meetings(conn) {
        Ok(m) => m,
        Err(e) => {
            rep.errors.push(format!("list meetings: {e}"));
            Vec::new()
        }
    };
    let docs = provider.documents();
    let points: Vec<TalkingPointInput> = provider.talking_points().into_iter().filter(|p| p.in_context).collect();
    let folders = provider.folders();

    let mut done = 0usize;
    let mut total = meetings.len() + docs.len() + points.len() + folders.len();
    let mut skipped = 0usize;
    let tick = |done: usize, total: usize, current: &str, skipped: usize| {
        progress(IndexProgress { done, total, current: current.to_string(), skipped });
    };

    // stale sources
    let live: HashSet<&str> = meetings.iter().map(|m| m.id.as_str()).collect();
    let gone: Vec<String> = store::list_refs(conn, PassageKind::Transcript)
        .unwrap_or_default()
        .into_iter()
        .filter(|r| !live.contains(r.as_str()))
        .collect();
    for g in gone {
        if store::remove_meeting(conn, &g).is_ok() {
            rep.removed += 1;
        }
    }
    let doc_ids: HashSet<&str> = docs.iter().map(|d| d.id.as_str()).collect();
    for g in store::list_refs(conn, PassageKind::Document).unwrap_or_default().into_iter().filter(|r| !doc_ids.contains(r.as_str())) {
        if store::remove_ref(conn, PassageKind::Document, &g).is_ok() {
            rep.removed += 1;
        }
    }
    let point_ids: HashSet<&str> = points.iter().map(|d| d.id.as_str()).collect();
    for g in store::list_refs(conn, PassageKind::TalkingPoint).unwrap_or_default().into_iter().filter(|r| !point_ids.contains(r.as_str())) {
        if store::remove_ref(conn, PassageKind::TalkingPoint, &g).is_ok() {
            rep.removed += 1;
        }
    }
    let folder_ids: HashSet<&str> = folders.iter().filter(|f| f.index_enabled).map(|f| f.id.as_str()).collect();
    for g in store::list_refs(conn, PassageKind::Folder).unwrap_or_default().into_iter().filter(|r| !folder_ids.contains(r.as_str())) {
        if store::remove_ref(conn, PassageKind::Folder, &g).is_ok() {
            rep.removed += 1;
        }
    }

    // meetings, newest first
    for m in &meetings {
        if !ctl.checkpoint() {
            rep.cancelled = true;
            return rep;
        }
        let r = catch_unwind(AssertUnwindSafe(|| index_meeting_row(conn, m)));
        match r {
            Ok(Ok(Outcome::Indexed)) => rep.meetings_indexed += 1,
            Ok(Ok(_)) => rep.meetings_unchanged += 1,
            Ok(Err(e)) => {
                rep.errors.push(format!("meeting {}: {e}", m.id));
                let _ = store::upsert_source(conn, PassageKind::Transcript, &m.id, "", "", -1, -1, "error", Some(&e));
            }
            Err(_) => rep.errors.push(format!("meeting {}: indexing panicked", m.id)),
        }
        done += 1;
        tick(done, total, &m.title, skipped);
    }

    for (kind, items) in [
        (PassageKind::Document, docs.iter().map(|d| (d.id.clone(), d.name.clone(), d.text.clone())).collect::<Vec<_>>()),
        (PassageKind::TalkingPoint, points.iter().map(|p| (p.id.clone(), p.title.clone(), p.plain_text.clone())).collect()),
    ] {
        for (id, title, text) in items {
            if !ctl.checkpoint() {
                rep.cancelled = true;
                return rep;
            }
            match catch_unwind(AssertUnwindSafe(|| index_text_source(conn, kind, &id, &title, &text))) {
                Ok(Ok(Outcome::Indexed)) => {
                    if kind == PassageKind::Document {
                        rep.documents_indexed += 1
                    } else {
                        rep.points_indexed += 1
                    }
                }
                Ok(Ok(_)) => {}
                Ok(Err(e)) => rep.errors.push(format!("{} {id}: {e}", kind.as_str())),
                Err(_) => rep.errors.push(format!("{} {id}: indexing panicked", kind.as_str())),
            }
            done += 1;
            tick(done, total, &title, skipped);
        }
    }

    for f in &folders {
        if !f.index_enabled {
            done += 1;
            continue;
        }
        if !ctl.checkpoint() {
            rep.cancelled = true;
            return rep;
        }
        let name = f.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let before = (done, total, skipped);
        let mut file_count = 0usize;
        let mut file_done = 0usize;
        let r = {
            let mut cb = |rel: &str, n: usize| {
                if n > 0 || rel.is_empty() {
                    file_count = n;
                    total += n;
                } else {
                    file_done += 1;
                    done += 1;
                    progress(IndexProgress { done, total, current: rel.to_string(), skipped });
                }
            };
            catch_unwind(AssertUnwindSafe(|| index_folder(conn, f, ctl, &mut cb)))
        };
        let _ = (before, file_count, file_done);
        match r {
            Ok(Ok(fr)) => {
                rep.files_indexed += fr.indexed;
                rep.files_skipped += fr.skipped;
                rep.files_failed += fr.failed;
                rep.removed += fr.removed;
                skipped += fr.skipped + fr.failed;
                if fr.cancelled {
                    rep.cancelled = true;
                    return rep;
                }
            }
            Ok(Err(e)) => rep.errors.push(format!("folder {name}: {e}")),
            Err(_) => rep.errors.push(format!("folder {name}: indexing panicked")),
        }
        done += 1;
        tick(done, total, &name, skipped);
    }
    tick(total.max(done), total.max(done), "", skipped);
    rep
}

/// Units of text in a document, for callers that want a rough size.
pub fn text_units(text: &str) -> usize {
    unit_count(text)
}

// ── service ─────────────────────────────────────────────────────────────────

enum Cmd {
    Rescan,
    Meeting(String),
    RemoveMeeting(String),
    Stop,
}

pub struct IndexerConfig {
    pub db_path: PathBuf,
    pub provider: Arc<dyn IndexProvider>,
    pub meeting_active: Arc<dyn Fn() -> bool + Send + Sync>,
    pub on_progress: Arc<dyn Fn(IndexProgress) + Send + Sync>,
    /// Rescan period (spec: every 10 minutes while a workspace is open).
    pub rescan_interval: Duration,
    pub initial_scan: bool,
}

pub struct IndexerService {
    tx: mpsc::Sender<Cmd>,
    ctl: RunControl,
    passes: Arc<AtomicU64>,
    handle: std::sync::Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl IndexerService {
    pub fn start(cfg: IndexerConfig) -> Result<Self, String> {
        let mut conn = open_search_connection(&cfg.db_path)?;
        let ctl = RunControl { pace: Duration::from_millis(2), ..RunControl::new(cfg.meeting_active.clone()) };
        let (tx, rx) = mpsc::channel::<Cmd>();
        let passes = Arc::new(AtomicU64::new(0));
        let (ctl2, passes2) = (ctl.clone(), passes.clone());
        let handle = std::thread::Builder::new()
            .name("nexq-search-indexer".into())
            .spawn(move || {
                let pass = |conn: &mut Connection| {
                    ctl2.reset_cancel();
                    let r = run_pass(conn, cfg.provider.as_ref(), &ctl2, &*cfg.on_progress);
                    for e in &r.errors {
                        log::warn!("search indexer: {e}");
                    }
                    passes2.fetch_add(1, Ordering::SeqCst);
                };
                if cfg.initial_scan {
                    pass(&mut conn);
                }
                loop {
                    if ctl2.stop.load(Ordering::SeqCst) {
                        break;
                    }
                    match rx.recv_timeout(cfg.rescan_interval) {
                        Ok(Cmd::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        Ok(Cmd::Rescan) | Err(mpsc::RecvTimeoutError::Timeout) => {
                            // collapse a burst of rescan requests
                            while let Ok(c) = rx.try_recv() {
                                if let Cmd::Stop = c {
                                    return;
                                }
                            }
                            pass(&mut conn);
                        }
                        Ok(Cmd::Meeting(id)) => {
                            if ctl2.checkpoint() {
                                if let Err(e) = catch_unwind(AssertUnwindSafe(|| index_meeting(&mut conn, &id)))
                                    .unwrap_or_else(|_| Err("panicked".into()))
                                {
                                    log::warn!("search indexer: meeting {id}: {e}");
                                }
                            }
                        }
                        Ok(Cmd::RemoveMeeting(id)) => {
                            let _ = store::remove_meeting(&conn, &id);
                        }
                    }
                }
            })
            .map_err(|e| format!("start indexer: {e}"))?;
        Ok(IndexerService { tx, ctl, passes, handle: std::sync::Mutex::new(Some(handle)) })
    }

    /// Ask for a full pass (collapses with others queued).
    pub fn rescan(&self) {
        let _ = self.tx.send(Cmd::Rescan);
    }
    /// Index one meeting (e.g. right after it ended).
    pub fn index_meeting(&self, id: &str) {
        let _ = self.tx.send(Cmd::Meeting(id.to_string()));
    }
    /// Drop a deleted meeting from the index.
    pub fn remove_meeting(&self, id: &str) {
        let _ = self.tx.send(Cmd::RemoveMeeting(id.to_string()));
    }
    /// Abort the pass in flight; the service keeps running.
    pub fn cancel_pass(&self) {
        self.ctl.cancel();
    }
    pub fn passes_completed(&self) -> u64 {
        self.passes.load(Ordering::SeqCst)
    }
    /// Block until `n` passes have finished or the timeout passes.
    pub fn wait_for_passes(&self, n: u64, timeout: Duration) -> bool {
        let t = Instant::now();
        while t.elapsed() < timeout {
            if self.passes_completed() >= n {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        false
    }
    /// Stop the thread and wait for it.
    pub fn shutdown(&self) {
        self.ctl.stop();
        let _ = self.tx.send(Cmd::Stop);
        if let Some(h) = self.handle.lock().ok().and_then(|mut g| g.take()) {
            let _ = h.join();
        }
    }
}

impl Drop for IndexerService {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_search::search::search;
    use crate::workspace_search::test_support::*;
    use crate::workspace_search::{MeetingScope, SearchScope};
    use std::fs;
    use std::sync::Mutex;

    struct Prov {
        docs: Mutex<Vec<DocInput>>,
        folders: Mutex<Vec<FolderInput>>,
        points: Mutex<Vec<TalkingPointInput>>,
    }
    impl Prov {
        fn new() -> Arc<Self> {
            Arc::new(Prov { docs: Mutex::new(vec![]), folders: Mutex::new(vec![]), points: Mutex::new(vec![]) })
        }
    }
    impl IndexProvider for Prov {
        fn documents(&self) -> Vec<DocInput> {
            self.docs.lock().unwrap().clone()
        }
        fn folders(&self) -> Vec<FolderInput> {
            self.folders.lock().unwrap().clone()
        }
        fn talking_points(&self) -> Vec<TalkingPointInput> {
            self.points.lock().unwrap().clone()
        }
    }

    fn run(conn: &mut Connection, p: &dyn IndexProvider) -> PassReport {
        run_pass(conn, p, &RunControl::idle(), &|_| {})
    }

    fn q(conn: &Connection, scope: &SearchScope, query: &str) -> Vec<String> {
        search(conn, scope, query, &[], 20).unwrap().into_iter().map(|p| p.ref_id).collect()
    }

    #[test]
    fn indexes_meetings_idempotently_and_reindexes_on_change() {
        let mut conn = mem_db();
        add_meeting(&conn, "m1", "Pricing call", "2026-01-02T10:00:00Z", None, &[
            ("You", "We should discuss the platypus pricing tier.", 0),
            ("Them", "Agreed, platypus pricing needs a review.", 5000),
        ]);
        let r = run(&mut conn, &MeetingsOnly);
        assert_eq!(r.meetings_indexed, 1);
        let scope = SearchScope::with_meetings(["m1"]);
        assert_eq!(q(&conn, &scope, "platypus"), vec!["m1"]);
        let n1: i64 = conn.query_row("SELECT COUNT(*) FROM search_passages", [], |r| r.get(0)).unwrap();
        // second pass: nothing to do, nothing duplicated
        let r = run(&mut conn, &MeetingsOnly);
        assert_eq!((r.meetings_indexed, r.meetings_unchanged), (0, 1));
        let n2: i64 = conn.query_row("SELECT COUNT(*) FROM search_passages", [], |r| r.get(0)).unwrap();
        assert_eq!(n1, n2);
        // change the text
        conn.execute(
            "INSERT INTO transcript_segments(id, meeting_id, text, speaker, timestamp_ms, is_final, created_at)
             VALUES ('x', 'm1', 'Also the wombat rollout is delayed.', 'You', 9000, 1, 'now')",
            [],
        )
        .unwrap();
        let r = run(&mut conn, &MeetingsOnly);
        assert_eq!(r.meetings_indexed, 1);
        assert_eq!(q(&conn, &scope, "wombat"), vec!["m1"]);
        // non-final lines are never indexed
        conn.execute(
            "INSERT INTO transcript_segments(id, meeting_id, text, speaker, timestamp_ms, is_final, created_at)
             VALUES ('y', 'm1', 'interimquokka text', 'You', 9500, 0, 'now')",
            [],
        )
        .unwrap();
        run(&mut conn, &MeetingsOnly);
        assert!(q(&conn, &scope, "interimquokka").is_empty());
    }

    #[test]
    fn newest_meetings_are_indexed_first() {
        let mut conn = mem_db();
        for (i, d) in ["2025-01-01", "2026-03-01", "2025-06-01"].iter().enumerate() {
            add_meeting(&conn, &format!("m{i}"), "T", &format!("{d}T10:00:00Z"), None, &[("You", "hello world words", 0)]);
        }
        let order = std::cell::RefCell::new(Vec::new());
        run_pass(&mut conn, &MeetingsOnly, &RunControl::idle(), &|p| order.borrow_mut().push(p.current.clone()));
        assert_eq!(order.borrow().len(), 4); // three units plus the final tick
        let ids: Vec<String> = conn
            .prepare("SELECT ref_id FROM search_sources ORDER BY indexed_at, rowid")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(ids, vec!["m1", "m2", "m0"]);
    }

    #[test]
    fn rename_summary_and_delete_are_followed() {
        let mut conn = mem_db();
        add_meeting(&conn, "m1", "Old title", "2026-01-02T10:00:00Z", None, &[("You", "The narwhal budget is fixed.", 0)]);
        run(&mut conn, &MeetingsOnly);
        let scope = SearchScope::with_meetings(["m1"]);
        assert_eq!(search(&conn, &scope, "narwhal", &[], 5).unwrap()[0].title, "Old title");
        let card = crate::workspace_search::cards::get_card(&conn, "m1").unwrap().unwrap();
        assert_eq!(card.origin, crate::workspace_search::CardOrigin::Extract);
        conn.execute("UPDATE meetings SET title = 'New title', summary = 'The narwhal budget was fixed at 5k.' WHERE id = 'm1'", []).unwrap();
        run(&mut conn, &MeetingsOnly);
        assert_eq!(search(&conn, &scope, "narwhal", &[], 5).unwrap()[0].title, "New title");
        let card = crate::workspace_search::cards::get_card(&conn, "m1").unwrap().unwrap();
        assert_eq!(card.origin, crate::workspace_search::CardOrigin::Summary);
        assert!(card.recap.contains("New title"));
        // delete the meeting: the pass removes everything
        conn.execute("DELETE FROM transcript_segments WHERE meeting_id = 'm1'", []).unwrap();
        conn.execute("DELETE FROM meetings WHERE id = 'm1'", []).unwrap();
        let r = run(&mut conn, &MeetingsOnly);
        assert_eq!(r.removed, 1);
        assert!(q(&conn, &scope, "narwhal").is_empty());
        assert!(crate::workspace_search::cards::get_card(&conn, "m1").unwrap().is_none());
        let left: i64 = conn.query_row("SELECT COUNT(*) FROM search_sources", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn explicit_remove_meeting_cleans_everything() {
        let mut conn = mem_db();
        add_meeting(&conn, "m1", "T", "2026-01-02T10:00:00Z", None, &[("You", "The okapi launch is Tuesday.", 0)]);
        run(&mut conn, &MeetingsOnly);
        store::remove_meeting(&conn, "m1").unwrap();
        assert!(q(&conn, &SearchScope::with_meetings(["m1"]), "okapi").is_empty());
        let fts: i64 = conn.query_row("SELECT COUNT(*) FROM search_fts WHERE search_fts MATCH 'okapi'", [], |r| r.get(0)).unwrap();
        assert_eq!(fts, 0);
        // index_meeting on a vanished id is a clean no-op
        conn.execute("DELETE FROM meetings WHERE id = 'm1'", []).unwrap();
        assert_eq!(index_meeting(&mut conn, "m1").unwrap(), Outcome::Removed);
    }

    #[test]
    fn documents_and_talking_points_follow_the_provider() {
        let mut conn = mem_db();
        let prov = Prov::new();
        prov.docs.lock().unwrap().push(DocInput { id: "d1".into(), name: "Handbook".into(), text: "Employees get a quokka day off.".into() });
        prov.points.lock().unwrap().extend([
            TalkingPointInput { id: "t1".into(), title: "Opening".into(), plain_text: "Greet with the aardvark joke.".into(), in_context: true },
            TalkingPointInput { id: "t2".into(), title: "Private".into(), plain_text: "pangolin plan".into(), in_context: false },
        ]);
        let r = run(&mut conn, prov.as_ref());
        assert_eq!((r.documents_indexed, r.points_indexed), (1, 1));
        let scope = SearchScope {
            document_ids: vec!["d1".into()],
            talking_point_ids: vec!["t1".into(), "t2".into()],
            ..Default::default()
        };
        assert_eq!(q(&conn, &scope, "quokka"), vec!["d1"]);
        assert_eq!(q(&conn, &scope, "aardvark"), vec!["t1"]);
        assert!(q(&conn, &scope, "pangolin").is_empty(), "not in_context");
        // edit, then remove
        prov.docs.lock().unwrap()[0].text = "Employees get a numbat day off.".into();
        run(&mut conn, prov.as_ref());
        assert!(q(&conn, &scope, "quokka").is_empty());
        assert_eq!(q(&conn, &scope, "numbat"), vec!["d1"]);
        prov.docs.lock().unwrap().clear();
        prov.points.lock().unwrap()[0].in_context = false;
        let r = run(&mut conn, prov.as_ref());
        assert_eq!(r.removed, 2);
        assert!(q(&conn, &scope, "numbat").is_empty());
        assert!(q(&conn, &scope, "aardvark").is_empty());
    }

    fn folder_fixture(tag: &str) -> (PathBuf, Arc<Prov>) {
        let root = temp_dir(tag);
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("plan.md"), "# Plan\n\nThe ibex migration starts in May.\n\n## Risks\n\nVendor delays around the gazelle contract.\n").unwrap();
        fs::write(root.join("sub/notes.txt"), "Remember the capybara demo on Friday.").unwrap();
        fs::write(root.join(".env"), "API_KEY=zebracanary-secret").unwrap();
        fs::write(root.join("my secret notes.md"), "zebracanary leaked").unwrap();
        let prov = Prov::new();
        prov.folders.lock().unwrap().push(FolderInput { id: "f1".into(), path: root.clone(), index_enabled: true });
        (root, prov)
    }

    #[test]
    fn folders_index_only_after_opt_in_and_skip_secrets() {
        let (root, prov) = folder_fixture("idx-f1");
        let mut conn = mem_db();
        prov.folders.lock().unwrap()[0].index_enabled = false;
        let r = run(&mut conn, prov.as_ref());
        assert_eq!(r.files_indexed, 0);
        let scope = SearchScope { folder_ids: vec!["f1".into()], ..Default::default() };
        assert!(q(&conn, &scope, "ibex").is_empty(), "opt-in is off");
        prov.folders.lock().unwrap()[0].index_enabled = true;
        let r = run(&mut conn, prov.as_ref());
        assert_eq!(r.files_indexed, 2);
        assert_eq!(q(&conn, &scope, "ibex migration"), vec!["f1"]);
        let hit = &search(&conn, &scope, "gazelle", &[], 3).unwrap()[0];
        assert_eq!(hit.sub_ref.as_deref(), Some("plan.md"));
        assert!(hit.title.contains("Risks"));
        assert!(q(&conn, &scope, "zebracanary").is_empty());
        let problems = store::list_problem_sources(&conn, PassageKind::Folder, "f1").unwrap();
        let names: Vec<&str> = problems.iter().map(|p| p.sub_ref.as_str()).collect();
        assert!(names.contains(&".env") && names.contains(&"my secret notes.md"), "{names:?}");
        // turning opt-in off removes what was indexed
        prov.folders.lock().unwrap()[0].index_enabled = false;
        run(&mut conn, prov.as_ref());
        assert!(q(&conn, &scope, "ibex").is_empty());
        assert_eq!(store::counts(&conn, PassageKind::Folder, "f1").unwrap(), (0, 0));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn folder_changes_are_found_by_mtime_size_then_hash() {
        let (root, prov) = folder_fixture("idx-f2");
        let mut conn = mem_db();
        let scope = SearchScope { folder_ids: vec!["f1".into()], ..Default::default() };
        run(&mut conn, prov.as_ref());
        // untouched: nothing re-read
        let r = run(&mut conn, prov.as_ref());
        assert_eq!(r.files_indexed, 0);
        // touch only (same content, new mtime): hash matches, no re-index
        let content = fs::read(root.join("sub/notes.txt")).unwrap();
        std::thread::sleep(Duration::from_millis(30));
        fs::write(root.join("sub/notes.txt"), &content).unwrap();
        let r = run(&mut conn, prov.as_ref());
        assert_eq!(r.files_indexed, 0);
        // change content
        fs::write(root.join("sub/notes.txt"), "Remember the wallaby demo on Monday afternoon.").unwrap();
        let r = run(&mut conn, prov.as_ref());
        assert_eq!(r.files_indexed, 1);
        assert_eq!(q(&conn, &scope, "wallaby"), vec!["f1"]);
        assert!(q(&conn, &scope, "capybara").is_empty());
        // delete a file
        fs::remove_file(root.join("sub/notes.txt")).unwrap();
        run(&mut conn, prov.as_ref());
        assert!(q(&conn, &scope, "wallaby").is_empty());
        // a file that becomes secret-looking disappears from the index
        fs::rename(root.join("plan.md"), root.join("token plan.md")).unwrap();
        run(&mut conn, prov.as_ref());
        assert!(q(&conn, &scope, "ibex").is_empty());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_corrupt_file_never_stops_the_pass() {
        let (root, prov) = folder_fixture("idx-f3");
        fs::write(root.join("broken.pdf"), b"%PDF-1.4 this is not a pdf at all \x00\x01\x02").unwrap();
        fs::write(root.join("broken.docx"), b"PK\x03\x04 garbage").unwrap();
        fs::write(root.join("binary.txt"), vec![0u8; 5000]).unwrap();
        fs::write(root.join("latin1.txt"), b"Caf\xe9 meeting about the tapir budget").unwrap();
        let mut conn = mem_db();
        let r = run(&mut conn, prov.as_ref());
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert!(r.files_failed >= 3, "failed {}", r.files_failed);
        let scope = SearchScope { folder_ids: vec!["f1".into()], ..Default::default() };
        assert_eq!(q(&conn, &scope, "ibex"), vec!["f1"], "good files still indexed");
        assert_eq!(q(&conn, &scope, "tapir"), vec!["f1"], "latin-1 decoded");
        let problems = store::list_problem_sources(&conn, PassageKind::Folder, "f1").unwrap();
        assert!(problems.iter().any(|p| p.sub_ref == "broken.pdf" && p.status == "error"));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_huge_file_is_skipped_and_a_big_allowed_one_is_capped() {
        let root = temp_dir("idx-huge");
        fs::write(root.join("huge.txt"), "word ".repeat(500_000)).unwrap(); // 2.5 MB
        fs::write(root.join("big.txt"), "alpha beta gamma delta. ".repeat(75_000)).unwrap(); // 1.8 MB
        let prov = Prov::new();
        prov.folders.lock().unwrap().push(FolderInput { id: "f".into(), path: root.clone(), index_enabled: true });
        let mut conn = mem_db();
        let t = Instant::now();
        let r = run(&mut conn, prov.as_ref());
        assert_eq!(r.files_indexed, 1);
        assert_eq!(r.files_skipped, 1);
        let (_, passages) = store::counts(&conn, PassageKind::Folder, "f").unwrap();
        assert!(passages > 100 && passages <= 3000, "{passages}");
        assert!(t.elapsed() < Duration::from_secs(120));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn cancelling_leaves_a_consistent_resumable_index() {
        let mut conn = mem_db();
        for i in 0..6 {
            add_meeting(&conn, &format!("m{i}"), "T", &format!("2026-01-0{}T10:00:00Z", i + 1), None, &[("You", &format!("okapi{i} planning words"), 0)]);
        }
        let ctl = RunControl::idle();
        let c2 = ctl.clone();
        let count = std::cell::Cell::new(0);
        let r = run_pass(&mut conn, &MeetingsOnly, &ctl, &|_| {
            count.set(count.get() + 1);
            if count.get() == 2 {
                c2.cancel();
            }
        });
        assert!(r.cancelled);
        assert_eq!(r.meetings_indexed, 2);
        ctl.reset_cancel();
        let r = run_pass(&mut conn, &MeetingsOnly, &ctl, &|_| {});
        assert!(!r.cancelled);
        assert_eq!((r.meetings_indexed, r.meetings_unchanged), (4, 2), "resumed, no rework");
    }

    #[test]
    fn indexing_pauses_while_a_meeting_is_active() {
        let dir = temp_dir("idx-pause");
        let db = file_db(&dir);
        {
            let c = Connection::open(&db).unwrap();
            add_meeting(&c, "m1", "T", "2026-01-02T10:00:00Z", None, &[("You", "The ocelot plan is ready.", 0)]);
        }
        let active = Arc::new(AtomicBool::new(true));
        let a2 = active.clone();
        let progress = Arc::new(AtomicU64::new(0));
        let p2 = progress.clone();
        let svc = IndexerService::start(IndexerConfig {
            db_path: db.clone(),
            provider: Arc::new(MeetingsOnly),
            meeting_active: Arc::new(move || a2.load(Ordering::SeqCst)),
            on_progress: Arc::new(move |_| {
                p2.fetch_add(1, Ordering::SeqCst);
            }),
            rescan_interval: Duration::from_secs(600),
            initial_scan: true,
        })
        .unwrap();
        std::thread::sleep(Duration::from_millis(500));
        let conn = Connection::open(&db).unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM search_passages", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "nothing indexed during a meeting");
        assert_eq!(svc.passes_completed(), 0);
        active.store(false, Ordering::SeqCst);
        assert!(svc.wait_for_passes(1, Duration::from_secs(10)));
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM search_passages", [], |r| r.get(0)).unwrap();
        assert!(n > 0);
        assert!(progress.load(Ordering::SeqCst) >= 1);
        svc.shutdown();
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn service_handles_rescan_meeting_end_remove_and_shutdown() {
        let dir = temp_dir("idx-svc");
        let db = file_db(&dir);
        {
            let c = Connection::open(&db).unwrap();
            add_meeting(&c, "m1", "T", "2026-01-02T10:00:00Z", None, &[("You", "first meeting about the lynx.", 0)]);
        }
        let svc = IndexerService::start(IndexerConfig {
            db_path: db.clone(),
            provider: Arc::new(MeetingsOnly),
            meeting_active: Arc::new(|| false),
            on_progress: Arc::new(|_| {}),
            rescan_interval: Duration::from_secs(600),
            initial_scan: true,
        })
        .unwrap();
        assert!(svc.wait_for_passes(1, Duration::from_secs(10)));
        let reader = open_search_connection(&db).unwrap();
        let scope = SearchScope { meetings: MeetingScope::Ids(vec!["m1".into(), "m2".into()]), ..Default::default() };
        assert_eq!(q(&reader, &scope, "lynx"), vec!["m1"]);
        // a meeting ends: indexed through the single-meeting path while readers keep working
        {
            let c = Connection::open(&db).unwrap();
            c.busy_timeout(Duration::from_secs(5)).unwrap();
            add_meeting(&c, "m2", "T2", "2026-02-02T10:00:00Z", None, &[("You", "second meeting about the jackal.", 0)]);
        }
        svc.index_meeting("m2");
        let t = Instant::now();
        while q(&reader, &scope, "jackal").is_empty() && t.elapsed() < Duration::from_secs(10) {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(q(&reader, &scope, "jackal"), vec!["m2"]);
        svc.remove_meeting("m2");
        let t = Instant::now();
        while !q(&reader, &scope, "jackal").is_empty() && t.elapsed() < Duration::from_secs(10) {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(q(&reader, &scope, "jackal").is_empty());
        svc.rescan();
        svc.rescan();
        svc.shutdown();
        svc.shutdown(); // idempotent
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rescan_again_after_new_meeting_in_database() {
        let dir = temp_dir("idx-rescan");
        let db = file_db(&dir);
        let svc = IndexerService::start(IndexerConfig {
            db_path: db.clone(),
            provider: Arc::new(MeetingsOnly),
            meeting_active: Arc::new(|| false),
            on_progress: Arc::new(|_| {}),
            rescan_interval: Duration::from_secs(600),
            initial_scan: true,
        })
        .unwrap();
        assert!(svc.wait_for_passes(1, Duration::from_secs(10)));
        {
            let c = Connection::open(&db).unwrap();
            add_meeting(&c, "m9", "T", "2026-02-02T10:00:00Z", None, &[("You", "late arrival about the marmot.", 0)]);
        }
        svc.rescan();
        assert!(svc.wait_for_passes(2, Duration::from_secs(10)));
        let reader = open_search_connection(&db).unwrap();
        assert_eq!(q(&reader, &SearchScope::with_meetings(["m9"]), "marmot"), vec!["m9"]);
        drop(svc);
        fs::remove_dir_all(&dir).ok();
    }
}
