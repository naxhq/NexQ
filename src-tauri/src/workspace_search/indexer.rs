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
use super::crawler::{crawl_folder, still_allowed, CrawlFile, CrawlOptions};
use super::passages::{
    build_markdown_passages, build_text_passages, build_transcript_passages, NewPassage, SegmentInput,
    MAX_PASSAGES_PER_FILE, MAX_SOURCE_CHARS,
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
///
/// A read that fails is an `Err`, never an empty list: an empty list means
/// "there is nothing" and would delete what was indexed.
pub trait IndexProvider: Send + Sync {
    fn documents(&self) -> Result<Vec<DocInput>, String> {
        Ok(Vec::new())
    }
    fn folders(&self) -> Result<Vec<FolderInput>, String> {
        Ok(Vec::new())
    }
    fn talking_points(&self) -> Result<Vec<TalkingPointInput>, String> {
        Ok(Vec::new())
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
    /// Set when a targeted request is waiting: a full pass in flight stops at
    /// its next unit (it is resumable) so the request runs within moments.
    priority: Arc<AtomicBool>,
    honor_priority: bool,
    /// Pause between units so the pass stays out of the way.
    pub pace: Duration,
}

impl RunControl {
    pub fn new(meeting_active: Arc<dyn Fn() -> bool + Send + Sync>) -> Self {
        RunControl {
            stop: Arc::new(AtomicBool::new(false)),
            pass_cancel: Arc::new(AtomicBool::new(false)),
            meeting_active,
            priority: Arc::new(AtomicBool::new(false)),
            honor_priority: false,
            pace: Duration::ZERO,
        }
    }
    /// The control a full pass runs under: it gives way to targeted requests.
    pub fn for_full_pass(&self) -> RunControl {
        RunControl { honor_priority: true, ..self.clone() }
    }
    pub fn request_priority(&self) {
        self.priority.store(true, Ordering::SeqCst);
    }
    pub fn clear_priority(&self) {
        self.priority.store(false, Ordering::SeqCst);
    }
    pub fn priority_requested(&self) -> bool {
        self.priority.load(Ordering::SeqCst)
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
        if self.honor_priority && self.priority_requested() {
            return false;
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
        // `+ TIME_CONTRACT_SIG`: transcripts indexed before times were made relative to the meeting start read as changed once
        |r| Ok((r.get(0)?, r.get::<_, i64>(1)? + TIME_CONTRACT_SIG)),
    )
}

const TIME_CONTRACT_SIG: i64 = 7;

fn has_speaker_tag(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('transcript_segments') WHERE name = 'speaker_tag'",
        [],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n > 0)
    .unwrap_or(false)
}

fn load_segments(conn: &Connection, id: &str, start: Option<i64>) -> rusqlite::Result<Vec<SegmentInput>> {
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
    let mut segs = rows.collect::<rusqlite::Result<Vec<SegmentInput>>>()?;
    // times since the meeting started, whatever the speech provider stamped
    let base = crate::live_common::base_ms(start, segs.iter().map(|s| s.start_ms));
    for s in &mut segs {
        s.start_ms = crate::live_common::rel_ms(s.start_ms, base) as i64;
    }
    segs.sort_by_key(|s| s.start_ms);
    Ok(segs)
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
        let segs = load_segments(conn, &m.id, parse_ms(&m.start_time)).map_err(e)?;
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
                load_segments(conn, &m.id, parse_ms(&m.start_time)).map_err(e)?
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

/// Read a file once without following links (it must lie inside
/// `canon_root`), hash the bytes and extract the text from them. Extractor
/// panics are caught; the text is cut at [`MAX_SOURCE_CHARS`].
fn read_file(file: &CrawlFile, canon_root: &std::path::Path, max_bytes: u64) -> Result<(String, String), String> {
    let read = crate::workspace_search::safe_open::read_confined(&file.abs_path, canon_root, max_bytes)?;
    let hash = sha_hex(&read.bytes);
    let bytes = &read.bytes;
    let text = match file.ext.as_str() {
        "md" | "txt" => decode_text(bytes),
        "pdf" => catch_unwind(AssertUnwindSafe(|| {
            crate::context::pdf_extractor::extract_text_from_pdf_bytes(bytes, MAX_SOURCE_CHARS)
        }))
        .map_err(|_| "could not read this PDF".to_string())??,
        "docx" => catch_unwind(AssertUnwindSafe(|| crate::rag::file_processor::extract_docx_text_bytes(bytes)))
            .map_err(|_| "could not read this Word file".to_string())??,
        other => return Err(format!("unsupported type .{other}")),
    };
    let text = crate::workspace_search::cjk::truncate_chars(&text, MAX_SOURCE_CHARS);
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

/// Delete everything indexed for a folder right now (opt-out or removal).
pub fn remove_folder_index(conn: &Connection, folder_id: &str) -> rusqlite::Result<()> {
    store::remove_ref(conn, PassageKind::Folder, folder_id)
}

fn index_folder(
    conn: &mut Connection,
    folder: &FolderInput,
    ctl: &RunControl,
    on_file: &mut dyn FnMut(&str, usize),
) -> Result<FolderReport, String> {
    index_folder_with(conn, folder, ctl, &CrawlOptions::default(), on_file)
}

pub(crate) fn index_folder_with(
    conn: &mut Connection,
    folder: &FolderInput,
    ctl: &RunControl,
    opts: &CrawlOptions,
    on_file: &mut dyn FnMut(&str, usize),
) -> Result<FolderReport, String> {
    let e = |x: rusqlite::Error| x.to_string();
    let mut rep = FolderReport::default();
    let crawl = crawl_folder(&folder.path, opts, &|| ctl.cancelled())?;
    if crawl.aborted {
        rep.cancelled = true;
        return Ok(rep);
    }
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
        let same_stat = |r: &store::SourceRow| r.mtime == f.mtime_ms && r.size == f.size as i64;
        if prev.map_or(false, |r| r.status == "ok" && same_stat(r)) {
            rep.unchanged += 1;
            continue;
        }
        // Being read when the app died: do not read it again until it changes.
        if prev.map_or(false, |r| (r.status == "in_progress" || r.status == "crashed") && same_stat(r)) {
            store::upsert_source(
                conn, PassageKind::Folder, &folder.id, &f.rel_path, "", f.mtime_ms, f.size as i64, "crashed",
                Some("NexQ stopped while reading this file, so it is skipped until the file changes"),
            )
            .map_err(e)?;
            rep.failed += 1;
            continue;
        }
        store::upsert_source(
            conn, PassageKind::Folder, &folder.id, &f.rel_path, "", f.mtime_ms, f.size as i64, "in_progress",
            Some("being read"),
        )
        .map_err(e)?;
        let work = catch_unwind(AssertUnwindSafe(|| -> Result<Option<(String, Vec<NewPassage>)>, String> {
            let (hash, text) = read_file(f, &crawl.canon_root, opts.max_file_bytes)?;
            if prev.map_or(false, |r| r.status == "ok" && r.content_hash == hash) {
                return Ok(None);
            }
            let stem = f.rel_path.rsplit('/').next().unwrap_or(&f.rel_path).to_string();
            let mut p = if f.ext == "md" {
                build_markdown_passages(&folder.id, &f.rel_path, &text, Some(f.mtime_ms))
            } else {
                build_text_passages(PassageKind::Folder, &folder.id, Some(&f.rel_path), &stem, &text, Some(f.mtime_ms))
            };
            p.truncate(MAX_PASSAGES_PER_FILE);
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

    // Files seen before but not in this walk. A complete walk says they are
    // gone; a walk cut short by a limit cannot, so each one is checked directly.
    for (sub, _) in existing.iter().filter(|(k, _)| !seen.contains(*k)) {
        let remove = !crawl.truncated || !still_allowed(&crawl.canon_root, sub, opts);
        if !remove {
            continue;
        }
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

/// Which folders a pass covers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FolderSel {
    All,
    None,
    One(String),
}

/// What a pass covers: everything, or one kind of source (a targeted pass).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PassScope {
    pub meetings: bool,
    pub documents: bool,
    pub points: bool,
    pub folders: FolderSel,
}

impl PassScope {
    pub fn all() -> Self {
        PassScope { meetings: true, documents: true, points: true, folders: FolderSel::All }
    }
    pub fn documents() -> Self {
        PassScope { meetings: false, documents: true, points: false, folders: FolderSel::None }
    }
    pub fn points() -> Self {
        PassScope { meetings: false, documents: false, points: true, folders: FolderSel::None }
    }
    pub fn folder(id: &str) -> Self {
        PassScope { meetings: false, documents: false, points: false, folders: FolderSel::One(id.to_string()) }
    }
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
    run_pass_scoped(conn, provider, ctl, progress, &PassScope::all())
}

/// A pass over part of the sources (the rest is left exactly as it is).
pub fn run_pass_scoped(
    conn: &mut Connection,
    provider: &dyn IndexProvider,
    ctl: &RunControl,
    progress: &dyn Fn(IndexProgress),
    scope: &PassScope,
) -> PassReport {
    let mut rep = PassReport::default();
    // Each list is read; one that can't be read is reported and its part of the
    // pass is skipped, including the removal of what is indexed for it.
    let mut meetings_ok = scope.meetings;
    let meetings = if !scope.meetings {
        Vec::new()
    } else {
        match list_meetings(conn) {
            Ok(m) => m,
            Err(e) => {
                rep.errors.push(format!("list meetings: {e}"));
                meetings_ok = false;
                Vec::new()
            }
        }
    };
    let mut docs_ok = scope.documents;
    let docs = if scope.documents {
        match provider.documents() {
            Ok(d) => d,
            Err(e) => {
                rep.errors.push(format!("documents: {e}"));
                docs_ok = false;
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };
    let mut points_ok = scope.points;
    let points: Vec<TalkingPointInput> = if scope.points {
        match provider.talking_points() {
            Ok(p) => p.into_iter().filter(|p| p.in_context).collect(),
            Err(e) => {
                rep.errors.push(format!("talking points: {e}"));
                points_ok = false;
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };
    let mut folders_ok = !matches!(scope.folders, FolderSel::None);
    let folders: Vec<FolderInput> = match &scope.folders {
        FolderSel::None => Vec::new(),
        sel => match provider.folders() {
            Ok(all) => match sel {
                FolderSel::One(id) => all.into_iter().filter(|f| &f.id == id).collect(),
                _ => all,
            },
            Err(e) => {
                rep.errors.push(format!("folders: {e}"));
                folders_ok = false;
                Vec::new()
            }
        },
    };

    let mut done = 0usize;
    let mut total = meetings.len() + docs.len() + points.len() + folders.len();
    let mut skipped = 0usize;
    let tick = |done: usize, total: usize, current: &str, skipped: usize| {
        progress(IndexProgress { done, total, current: current.to_string(), skipped });
    };

    // stale sources: only when the list they are compared with was read
    let stale = |conn: &Connection, kind: PassageKind, keep: &HashSet<&str>| -> Vec<String> {
        match store::list_refs(conn, kind) {
            Ok(refs) => refs.into_iter().filter(|r| !keep.contains(r.as_str())).collect(),
            Err(_) => Vec::new(),
        }
    };
    if meetings_ok {
        let live: HashSet<&str> = meetings.iter().map(|m| m.id.as_str()).collect();
        for g in stale(conn, PassageKind::Transcript, &live) {
            if store::remove_meeting(conn, &g).is_ok() {
                rep.removed += 1;
            }
        }
    }
    if docs_ok {
        let doc_ids: HashSet<&str> = docs.iter().map(|d| d.id.as_str()).collect();
        for g in stale(conn, PassageKind::Document, &doc_ids) {
            if store::remove_ref(conn, PassageKind::Document, &g).is_ok() {
                rep.removed += 1;
            }
        }
    }
    if points_ok {
        let point_ids: HashSet<&str> = points.iter().map(|d| d.id.as_str()).collect();
        for g in stale(conn, PassageKind::TalkingPoint, &point_ids) {
            if store::remove_ref(conn, PassageKind::TalkingPoint, &g).is_ok() {
                rep.removed += 1;
            }
        }
    }
    let folder_ids: HashSet<&str> = folders.iter().filter(|f| f.index_enabled).map(|f| f.id.as_str()).collect();
    if folders_ok {
        match &scope.folders {
            FolderSel::All => {
                for g in stale(conn, PassageKind::Folder, &folder_ids) {
                    if store::remove_ref(conn, PassageKind::Folder, &g).is_ok() {
                        rep.removed += 1;
                    }
                }
            }
            FolderSel::One(id) => {
                // opted out, switched off or gone: its passages go now
                if !folder_ids.contains(id.as_str()) && store::remove_ref(conn, PassageKind::Folder, id).is_ok() {
                    rep.removed += 1;
                }
            }
            FolderSel::None => {}
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
            Err(_) => {
                // a meeting that panics every time still counts as done, with its reason
                rep.errors.push(format!("meeting {}: indexing panicked", m.id));
                let _ = store::upsert_source(conn, PassageKind::Transcript, &m.id, "", "", -1, -1, "error", Some("indexing failed unexpectedly"));
            }
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

/// One targeted request. Runs under the plain control (it waits out a
/// meeting, never gives way to another request).
fn run_command(conn: &mut Connection, provider: &dyn IndexProvider, ctl: &RunControl, progress: &dyn Fn(IndexProgress), cmd: Cmd) {
    let log_errors = |r: PassReport| {
        for e in &r.errors {
            log::warn!("search indexer: {e}");
        }
    };
    match cmd {
        Cmd::Meeting(id) => {
            if ctl.checkpoint() {
                if let Err(e) = catch_unwind(AssertUnwindSafe(|| index_meeting(conn, &id))).unwrap_or_else(|_| Err("panicked".into())) {
                    log::warn!("search indexer: meeting {id}: {e}");
                }
            }
        }
        Cmd::RemoveMeeting(id) => {
            let _ = store::remove_meeting(conn, &id);
        }
        Cmd::RemoveFolder(id) => {
            let _ = remove_folder_index(conn, &id);
        }
        Cmd::Folder(id) => log_errors(run_pass_scoped(conn, provider, ctl, progress, &PassScope::folder(&id))),
        Cmd::Documents => log_errors(run_pass_scoped(conn, provider, ctl, progress, &PassScope::documents())),
        Cmd::Points => log_errors(run_pass_scoped(conn, provider, ctl, progress, &PassScope::points())),
        Cmd::Rescan | Cmd::Stop => {}
    }
}

enum Cmd {
    Rescan,
    Meeting(String),
    RemoveMeeting(String),
    RemoveFolder(String),
    /// Index (or drop) one folder now.
    Folder(String),
    Documents,
    Points,
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
    /// Watch every folder the provider lists as indexed and index it again this long after its
    /// files stop changing (None: no watching; the periodic pass is all there is).
    pub watch_debounce: Option<Duration>,
    /// Asked before a timer-driven pass (None: always). The timer is for
    /// while a workspace is open; explicit requests always run.
    pub timer_enabled: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
}

pub struct IndexerService {
    tx: mpsc::Sender<Cmd>,
    ctl: RunControl,
    passes: Arc<AtomicU64>,
    commands: Arc<AtomicU64>,
    handle: std::sync::Mutex<Option<std::thread::JoinHandle<()>>>,
    watching: super::watch::WatchStatus,
}

/// Watch the folders the provider says are indexed, and no others: a folder that was linked starts,
/// one that was unlinked or switched off stops. A failed read leaves the watchers as they are.
fn sync_watches(watchers: &mut Option<super::watch::FolderWatchers>, provider: &dyn IndexProvider) {
    let Some(w) = watchers.as_mut() else { return };
    match provider.folders() {
        Ok(list) => {
            let wanted: Vec<(String, PathBuf)> = list.into_iter().filter(|f| f.index_enabled).map(|f| (f.id, f.path)).collect();
            w.sync(&wanted);
        }
        Err(e) => log::warn!("search indexer: the folders could not be read to watch them: {e}"),
    }
}

impl IndexerService {
    pub fn start(cfg: IndexerConfig) -> Result<Self, String> {
        let mut conn = open_search_connection(&cfg.db_path)?;
        let ctl = RunControl { pace: Duration::from_millis(2), ..RunControl::new(cfg.meeting_active.clone()) };
        let (tx, rx) = mpsc::channel::<Cmd>();
        // A change seen in a watched folder asks for that folder to be indexed, like the user would.
        let mut watchers = cfg.watch_debounce.map(|debounce| {
            let (tx_w, ctl_w) = (tx.clone(), ctl.clone());
            super::watch::FolderWatchers::new(
                debounce,
                Arc::new(move |id: &str| {
                    let _ = tx_w.send(Cmd::Folder(id.to_string()));
                    ctl_w.request_priority();
                }),
            )
        });
        let watching = watchers.as_ref().map(|w| w.status()).unwrap_or_default();
        let passes = Arc::new(AtomicU64::new(0));
        let commands = Arc::new(AtomicU64::new(0));
        let (ctl2, passes2, commands2) = (ctl.clone(), passes.clone(), commands.clone());
        let handle = std::thread::Builder::new()
            .name("nexq-search-indexer".into())
            .spawn(move || {
                use std::collections::VecDeque;
                let full_ctl = ctl2.for_full_pass();
                let mut backlog: VecDeque<Cmd> = VecDeque::new();
                let mut full_pending = cfg.initial_scan;
                sync_watches(&mut watchers, cfg.provider.as_ref());
                loop {
                    if ctl2.stop.load(Ordering::SeqCst) {
                        break;
                    }
                    // Everything sent so far is taken in; nothing is dropped. Repeated
                    // rescans collapse into one, every other request is kept in order.
                    let take = |c: Cmd, backlog: &mut VecDeque<Cmd>, full_pending: &mut bool| -> bool {
                        match c {
                            Cmd::Stop => return true,
                            Cmd::Rescan => *full_pending = true,
                            other => backlog.push_back(other),
                        }
                        false
                    };
                    while let Ok(c) = rx.try_recv() {
                        if take(c, &mut backlog, &mut full_pending) {
                            return;
                        }
                    }
                    if let Some(cmd) = backlog.pop_front() {
                        let folders_changed = matches!(cmd, Cmd::Folder(_) | Cmd::RemoveFolder(_));
                        run_command(&mut conn, cfg.provider.as_ref(), &ctl2, &*cfg.on_progress, cmd);
                        if folders_changed {
                            sync_watches(&mut watchers, cfg.provider.as_ref());
                        }
                        commands2.fetch_add(1, Ordering::SeqCst);
                        continue;
                    }
                    // Nothing targeted is waiting. Clear the flag first and look again, so a
                    // request that arrives after this line either is seen now or raises it again.
                    ctl2.clear_priority();
                    let mut late = false;
                    while let Ok(c) = rx.try_recv() {
                        if take(c, &mut backlog, &mut full_pending) {
                            return;
                        }
                        late = true;
                    }
                    if late {
                        continue;
                    }
                    if full_pending {
                        full_pending = false;
                        full_ctl.reset_cancel();
                        let r = run_pass(&mut conn, cfg.provider.as_ref(), &full_ctl, &*cfg.on_progress);
                        sync_watches(&mut watchers, cfg.provider.as_ref());
                        for e in &r.errors {
                            log::warn!("search indexer: {e}");
                        }
                        if r.cancelled && ctl2.priority_requested() && !ctl2.cancelled() {
                            full_pending = true; // gave way to a request: finish afterwards
                        } else {
                            passes2.fetch_add(1, Ordering::SeqCst);
                        }
                        continue;
                    }
                    match rx.recv_timeout(cfg.rescan_interval) {
                        Ok(c) => {
                            if take(c, &mut backlog, &mut full_pending) {
                                return;
                            }
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            if cfg.timer_enabled.as_ref().map_or(true, |f| f()) {
                                full_pending = true;
                            }
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
            })
            .map_err(|e| format!("start indexer: {e}"))?;
        Ok(IndexerService { tx, ctl, passes, commands, handle: std::sync::Mutex::new(Some(handle)), watching })
    }

    /// Queue a request and raise the flag that makes a full pass in flight
    /// give way (send first, then flag: see the loop).
    fn send_priority(&self, c: Cmd) {
        let _ = self.tx.send(c);
        self.ctl.request_priority();
    }

    /// Index one folder now (the user opted in, or it changed).
    pub fn index_folder(&self, id: &str) {
        self.send_priority(Cmd::Folder(id.to_string()));
    }
    /// Documents were added, changed or removed.
    pub fn index_documents(&self) {
        self.send_priority(Cmd::Documents);
    }
    /// A talking point was saved.
    pub fn index_talking_points(&self) {
        self.send_priority(Cmd::Points);
    }
    /// The folders being watched for changes right now.
    pub fn watched_folders(&self) -> Vec<String> {
        self.watching.folders()
    }
    /// Requests handled so far (targeted ones; for tests and status).
    pub fn commands_completed(&self) -> u64 {
        self.commands.load(Ordering::SeqCst)
    }
    pub fn wait_for_commands(&self, n: u64, timeout: Duration) -> bool {
        let t = Instant::now();
        while t.elapsed() < timeout {
            if self.commands_completed() >= n {
                return true;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        false
    }

    /// Ask for a full pass (collapses with others queued).
    pub fn rescan(&self) {
        let _ = self.tx.send(Cmd::Rescan);
    }
    /// Index one meeting (e.g. right after it ended).
    pub fn index_meeting(&self, id: &str) {
        self.send_priority(Cmd::Meeting(id.to_string()));
    }
    /// Drop a deleted meeting from the index.
    pub fn remove_meeting(&self, id: &str) {
        self.send_priority(Cmd::RemoveMeeting(id.to_string()));
    }
    /// Delete a folder's passages now (the user opted out or removed it).
    pub fn remove_folder(&self, id: &str) {
        self.send_priority(Cmd::RemoveFolder(id.to_string()));
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
        /// Reads fail (the database could not be read).
        fail: AtomicBool,
    }
    impl Prov {
        fn new() -> Arc<Self> {
            Arc::new(Prov { docs: Mutex::new(vec![]), folders: Mutex::new(vec![]), points: Mutex::new(vec![]), fail: AtomicBool::new(false) })
        }
    }
    impl IndexProvider for Prov {
        fn documents(&self) -> Result<Vec<DocInput>, String> {
            if self.fail.load(Ordering::SeqCst) {
                return Err("the database is busy".into());
            }
            Ok(self.docs.lock().unwrap().clone())
        }
        fn folders(&self) -> Result<Vec<FolderInput>, String> {
            if self.fail.load(Ordering::SeqCst) {
                return Err("the database is busy".into());
            }
            Ok(self.folders.lock().unwrap().clone())
        }
        fn talking_points(&self) -> Result<Vec<TalkingPointInput>, String> {
            if self.fail.load(Ordering::SeqCst) {
                return Err("the database is busy".into());
            }
            Ok(self.points.lock().unwrap().clone())
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
            watch_debounce: None,
            timer_enabled: None,
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
            watch_debounce: None,
            timer_enabled: None,
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
            watch_debounce: None,
            timer_enabled: None,
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

    fn docx_bytes(xml: &[u8]) -> Vec<u8> {
        use std::io::Write;
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buf);
            let o = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            zip.start_file("word/document.xml", o).unwrap();
            zip.write_all(xml).unwrap();
            zip.finish().unwrap();
        }
        buf.into_inner()
    }

    #[test]
    fn a_decompression_bomb_is_refused_and_the_rest_still_indexes() {
        let (root, prov) = folder_fixture("idx-bomb");
        let bomb = docx_bytes(&vec![b'a'; 40 * 1024 * 1024]);
        assert!(bomb.len() < 2 * 1024 * 1024);
        fs::write(root.join("bomb.docx"), &bomb).unwrap();
        let mut conn = mem_db();
        let t = Instant::now();
        let r = run(&mut conn, prov.as_ref());
        assert!(t.elapsed() < Duration::from_secs(30));
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        let problems = store::list_problem_sources(&conn, PassageKind::Folder, "f1").unwrap();
        let p = problems.iter().find(|p| p.sub_ref == "bomb.docx").expect("listed");
        assert_eq!(p.status, "error");
        assert!(p.error.as_deref().unwrap().contains("too much"), "{:?}", p.error);
        let scope = SearchScope { folder_ids: vec!["f1".into()], ..Default::default() };
        assert_eq!(q(&conn, &scope, "ibex"), vec!["f1"]);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_file_that_was_in_progress_when_the_app_died_is_not_read_again_until_it_changes() {
        let (root, prov) = folder_fixture("idx-crash");
        let mut conn = mem_db();
        run(&mut conn, prov.as_ref());
        // simulate a crash while reading notes.txt: the row says in_progress with its current stat
        let md = fs::metadata(root.join("sub/notes.txt")).unwrap();
        let mtime = md.modified().unwrap().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
        store::delete_passages(&conn, PassageKind::Folder, "f1", Some("sub/notes.txt")).unwrap();
        store::upsert_source(&conn, PassageKind::Folder, "f1", "sub/notes.txt", "", mtime, md.len() as i64, "in_progress", Some("being read")).unwrap();
        let scope = SearchScope { folder_ids: vec!["f1".into()], ..Default::default() };
        let r = run(&mut conn, prov.as_ref());
        assert_eq!(r.files_indexed, 0);
        assert!(q(&conn, &scope, "capybara").is_empty(), "not read again");
        let row = store::get_source(&conn, PassageKind::Folder, "f1", "sub/notes.txt").unwrap().unwrap();
        assert_eq!(row.status, "crashed");
        assert!(row.error.unwrap().contains("stopped"));
        // still skipped on the next pass
        run(&mut conn, prov.as_ref());
        assert!(q(&conn, &scope, "capybara").is_empty());
        // changed: tried again
        std::thread::sleep(Duration::from_millis(30));
        fs::write(root.join("sub/notes.txt"), "Remember the capybara demo, now with extra words on Friday.").unwrap();
        let r = run(&mut conn, prov.as_ref());
        assert_eq!(r.files_indexed, 1);
        assert_eq!(q(&conn, &scope, "capybara"), vec!["f1"]);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_walk_cut_short_still_removes_files_that_are_gone_or_no_longer_allowed() {
        let root = temp_dir("idx-trunc");
        for i in 0..6 {
            fs::write(root.join(format!("n{i}.md")), format!("note number {i} about the quokka{i} plan")).unwrap();
        }
        let folder = FolderInput { id: "f".into(), path: root.clone(), index_enabled: true };
        let mut conn = mem_db();
        let ctl = RunControl::idle();
        let full = CrawlOptions::default();
        index_folder_with(&mut conn, &folder, &ctl, &full, &mut |_, _| {}).unwrap();
        let scope = SearchScope { folder_ids: vec!["f".into()], ..Default::default() };
        assert_eq!(store::counts(&conn, PassageKind::Folder, "f").unwrap().0, 6);
        // one file goes, one becomes secret-looking, while the next walk is limited to 2 files
        fs::remove_file(root.join("n5.md")).unwrap();
        fs::rename(root.join("n4.md"), root.join("n4 secret.md")).unwrap();
        let limited = CrawlOptions { max_files: 2, ..Default::default() };
        let rep = index_folder_with(&mut conn, &folder, &ctl, &limited, &mut |_, _| {}).unwrap();
        assert!(rep.truncated);
        assert!(q(&conn, &scope, "quokka5").is_empty(), "deleted file removed");
        assert!(q(&conn, &scope, "quokka4").is_empty(), "now secret-looking: removed");
        // files still allowed but beyond the limit keep their rows
        assert_eq!(q(&conn, &scope, "quokka3"), vec!["f"]);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn an_aborted_walk_changes_nothing() {
        let (root, prov) = folder_fixture("idx-abort");
        let mut conn = mem_db();
        run(&mut conn, prov.as_ref());
        let before = store::counts(&conn, PassageKind::Folder, "f1").unwrap();
        let ctl = RunControl::idle();
        ctl.cancel();
        let f = prov.folders.lock().unwrap()[0].clone();
        let rep = index_folder_with(&mut conn, &f, &ctl, &CrawlOptions::default(), &mut |_, _| {}).unwrap();
        assert!(rep.cancelled);
        assert_eq!(store::counts(&conn, PassageKind::Folder, "f1").unwrap(), before);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn opting_out_or_removing_a_folder_deletes_its_passages_at_once() {
        let (root, prov) = folder_fixture("idx-optout");
        let mut conn = mem_db();
        run(&mut conn, prov.as_ref());
        let scope = SearchScope { folder_ids: vec!["f1".into()], ..Default::default() };
        assert_eq!(q(&conn, &scope, "ibex"), vec!["f1"]);
        remove_folder_index(&conn, "f1").unwrap();
        assert!(q(&conn, &scope, "ibex").is_empty());
        assert_eq!(store::counts(&conn, PassageKind::Folder, "f1").unwrap(), (0, 0));
        let fts: i64 = conn.query_row("SELECT COUNT(*) FROM search_fts WHERE search_fts MATCH 'ibex'", [], |r| r.get(0)).unwrap();
        assert_eq!(fts, 0);
        // through the running service too
        let dir = temp_dir("idx-optout2");
        let db = file_db(&dir);
        let svc = IndexerService::start(IndexerConfig {
            db_path: db.clone(),
            provider: prov.clone(),
            meeting_active: Arc::new(|| false),
            on_progress: Arc::new(|_| {}),
            rescan_interval: Duration::from_secs(600),
            initial_scan: true,
            watch_debounce: None,
            timer_enabled: None,
        })
        .unwrap();
        assert!(svc.wait_for_passes(1, Duration::from_secs(20)));
        let reader = open_search_connection(&db).unwrap();
        assert_eq!(q(&reader, &scope, "ibex"), vec!["f1"]);
        prov.folders.lock().unwrap().clear();
        svc.remove_folder("f1");
        let t = Instant::now();
        while !q(&reader, &scope, "ibex").is_empty() && t.elapsed() < Duration::from_secs(10) {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(q(&reader, &scope, "ibex").is_empty());
        svc.shutdown();
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_timer_pass_waits_for_an_open_workspace() {
        let dir = temp_dir("idx-timer");
        let db = file_db(&dir);
        let open = Arc::new(AtomicBool::new(false));
        let o2 = open.clone();
        let svc = IndexerService::start(IndexerConfig {
            db_path: db,
            provider: Arc::new(MeetingsOnly),
            meeting_active: Arc::new(|| false),
            on_progress: Arc::new(|_| {}),
            rescan_interval: Duration::from_millis(60),
            initial_scan: false,
            watch_debounce: None,
            timer_enabled: Some(Arc::new(move || o2.load(Ordering::SeqCst))),
        })
        .unwrap();
        std::thread::sleep(Duration::from_millis(400));
        assert_eq!(svc.passes_completed(), 0);
        open.store(true, Ordering::SeqCst);
        assert!(svc.wait_for_passes(1, Duration::from_secs(5)));
        svc.shutdown();
        fs::remove_dir_all(&dir).ok();
    }

    fn service(db: &std::path::Path, prov: Arc<Prov>, initial_scan: bool) -> IndexerService {
        IndexerService::start(IndexerConfig {
            db_path: db.to_path_buf(),
            provider: prov,
            meeting_active: Arc::new(|| false),
            on_progress: Arc::new(|_| {}),
            rescan_interval: Duration::from_secs(600),
            initial_scan,
            watch_debounce: None,
            timer_enabled: None,
        })
        .unwrap()
    }

    /// A service that watches its folders and sweeps only every 10 minutes: what it learns in the
    /// seconds a test waits, it learns from the watchers.
    fn watching_service(db: &std::path::Path, prov: Arc<Prov>, debounce: Duration) -> IndexerService {
        IndexerService::start(IndexerConfig {
            db_path: db.to_path_buf(),
            provider: prov,
            meeting_active: Arc::new(|| false),
            on_progress: Arc::new(|_| {}),
            rescan_interval: Duration::from_secs(600),
            initial_scan: true,
            watch_debounce: Some(debounce),
            timer_enabled: None,
        })
        .unwrap()
    }

    #[test]
    fn a_file_added_edited_and_deleted_in_a_watched_folder_is_searchable_within_seconds_and_unlinking_stops_it() {
        let dir = temp_dir("idx-watch");
        let db = file_db(&dir);
        let root = dir.join("notes");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("first.md"), "# First
The quokka plan.").unwrap();
        let prov = Prov::new();
        prov.folders.lock().unwrap().push(FolderInput { id: "f1".into(), path: root.clone(), index_enabled: true });
        let svc = watching_service(&db, prov.clone(), Duration::from_millis(200));
        assert!(svc.wait_for_passes(1, Duration::from_secs(10)));
        assert_eq!(svc.watched_folders(), vec!["f1"], "linked and indexed: watched");
        let reader = open_search_connection(&db).unwrap();
        let scope = SearchScope { folder_ids: vec!["f1".into()], ..Default::default() };
        let found = |w: &str| search(&reader, &scope, w, &[PassageKind::Folder], 5).unwrap().iter().map(|p| p.title.clone()).collect::<Vec<_>>();
        assert_eq!(found("quokka").len(), 1);
        let passes = svc.passes_completed();

        // added
        let took = { fs::write(root.join("second.md"), "# Second
The wombat budget.").unwrap(); wait_until("the added file", 8, || !found("wombat").is_empty()) };
        assert!(took < Duration::from_secs(6), "within seconds: {took:?}");
        // edited: the new words appear and the old ones go
        fs::write(root.join("second.md"), "# Second
The numbat budget.").unwrap();
        wait_until("the edit", 8, || !found("numbat").is_empty() && found("wombat").is_empty());
        // renamed
        fs::rename(root.join("second.md"), root.join("renamed.md")).unwrap();
        wait_until("the rename", 8, || found("numbat").iter().any(|t| t.contains("renamed")));
        // deleted
        fs::remove_file(root.join("renamed.md")).unwrap();
        wait_until("the delete", 8, || found("numbat").is_empty());
        assert_eq!(found("quokka").len(), 1, "the other file is untouched");
        assert_eq!(svc.passes_completed(), passes, "no full pass was needed: the watchers did it");

        // a hidden file and a secret-looking one are never indexed, watched or not
        fs::write(root.join(".hidden.md"), "# Hidden
The ocelot secret.").unwrap();
        fs::write(root.join("password list.md"), "# Pw
The ocelot token.").unwrap();
        std::thread::sleep(Duration::from_millis(1_200));
        assert!(found("ocelot").is_empty());

        // unlinked: it stops being watched, its text goes, and a new file is not picked up
        prov.folders.lock().unwrap().clear();
        svc.remove_folder("f1");
        wait_until("it stops being watched", 8, || svc.watched_folders().is_empty());
        wait_until("its text goes", 8, || found("quokka").is_empty());
        fs::write(root.join("late.md"), "# Late
The pangolin note.").unwrap();
        std::thread::sleep(Duration::from_millis(1_000));
        assert!(found("pangolin").is_empty());
        svc.shutdown();
        fs::remove_dir_all(&dir).ok();
    }

    fn wait_until(what: &str, secs: u64, f: impl Fn() -> bool) -> Duration {
        let t = Instant::now();
        while !f() {
            assert!(t.elapsed() < Duration::from_secs(secs), "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(10));
        }
        t.elapsed()
    }

    #[test]
    fn an_opt_in_is_indexed_within_two_seconds_while_a_long_pass_is_running() {
        let dir = temp_dir("idx-prio");
        let db = file_db(&dir);
        {
            let c = Connection::open(&db).unwrap();
            for i in 0..900 {
                add_meeting(&c, &format!("m{i}"), "T", &format!("2026-01-{:02}T10:00:00Z", 1 + i % 28), None, &[("You", "some words about things", 0)]);
            }
        }
        let (root, prov) = folder_fixture("idx-prio-f");
        prov.folders.lock().unwrap()[0].index_enabled = false;
        let svc = service(&db, prov.clone(), true); // the first full pass starts at once
        std::thread::sleep(Duration::from_millis(150)); // it is under way
        assert_eq!(svc.passes_completed(), 0);
        // the user opts the folder in
        prov.folders.lock().unwrap()[0].index_enabled = true;
        let reader = open_search_connection(&db).unwrap();
        let scope = SearchScope { folder_ids: vec!["f1".into()], ..Default::default() };
        svc.index_folder("f1");
        let took = wait_until("the folder", 20, || !q(&reader, &scope, "ibex").is_empty());
        assert!(took < Duration::from_secs(2), "took {took:?}");
        assert_eq!(svc.passes_completed(), 0, "the long pass was still running: the request did not wait for it");
        // the interrupted pass resumes and finishes: every meeting is indexed
        assert!(svc.wait_for_passes(1, Duration::from_secs(120)));
        let n: i64 = reader.query_row("SELECT COUNT(DISTINCT ref_id) FROM search_sources WHERE kind = 'transcript'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 900);
        svc.shutdown();
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn when_idle_every_kind_of_change_is_followed_within_two_seconds() {
        let dir = temp_dir("idx-idle");
        let db = file_db(&dir);
        let (root, prov) = folder_fixture("idx-idle-f");
        prov.folders.lock().unwrap()[0].index_enabled = false;
        let svc = service(&db, prov.clone(), false);
        let reader = open_search_connection(&db).unwrap();
        let writer = Connection::open(&db).unwrap();
        let all = SearchScope {
            meetings: MeetingScope::Ids(vec!["m-new".into()]),
            document_ids: vec!["d1".into()],
            folder_ids: vec!["f1".into()],
            talking_point_ids: vec!["t1".into()],
            ..Default::default()
        };
        // opt-in
        prov.folders.lock().unwrap()[0].index_enabled = true;
        svc.index_folder("f1");
        assert!(wait_until("folder", 5, || !q(&reader, &all, "ibex").is_empty()) < Duration::from_secs(2));
        // document add
        prov.docs.lock().unwrap().push(DocInput { id: "d1".into(), name: "Guide".into(), text: "The quokka handbook".into() });
        svc.index_documents();
        assert!(wait_until("document", 5, || !q(&reader, &all, "quokka").is_empty()) < Duration::from_secs(2));
        // talking point save
        prov.points.lock().unwrap().push(TalkingPointInput { id: "t1".into(), title: "Open".into(), plain_text: "Greet the aardvark".into(), in_context: true });
        svc.index_talking_points();
        assert!(wait_until("point", 5, || !q(&reader, &all, "aardvark").is_empty()) < Duration::from_secs(2));
        // meeting end
        add_meeting(&writer, "m-new", "New", "2026-02-02T10:00:00Z", None, &[("You", "The lynx launch is ready", 0)]);
        svc.index_meeting("m-new");
        assert!(wait_until("meeting", 5, || !q(&reader, &all, "lynx").is_empty()) < Duration::from_secs(2));
        // opt-out
        prov.folders.lock().unwrap()[0].index_enabled = false;
        svc.index_folder("f1");
        assert!(wait_until("opt-out", 5, || q(&reader, &all, "ibex").is_empty()) < Duration::from_secs(2));
        svc.shutdown();
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_burst_of_requests_loses_none_and_rescans_collapse() {
        let dir = temp_dir("idx-burst");
        let db = file_db(&dir);
        {
            let c = Connection::open(&db).unwrap();
            for i in 0..300 {
                add_meeting(&c, &format!("m{i}"), "T", "2026-01-05T10:00:00Z", None, &[("You", "plain words", 0)]);
            }
            add_meeting(&c, "m-late", "Late", "2026-03-01T10:00:00Z", None, &[("You", "The marmot report", 0)]);
        }
        let (root, prov) = folder_fixture("idx-burst-f");
        prov.docs.lock().unwrap().push(DocInput { id: "d1".into(), name: "G".into(), text: "The numbat guide".into() });
        prov.points.lock().unwrap().push(TalkingPointInput { id: "t1".into(), title: "T".into(), plain_text: "Greet the ocelot".into(), in_context: true });
        let svc = service(&db, prov.clone(), true);
        // everything at once, while the first pass is running
        for _ in 0..3 {
            svc.rescan();
        }
        svc.index_documents();
        svc.index_talking_points();
        svc.index_folder("f1");
        svc.index_meeting("m-late");
        svc.rescan();
        svc.index_documents();
        let reader = open_search_connection(&db).unwrap();
        let all = SearchScope {
            meetings: MeetingScope::Ids(vec!["m-late".into()]),
            document_ids: vec!["d1".into()],
            folder_ids: vec!["f1".into()],
            talking_point_ids: vec!["t1".into()],
            ..Default::default()
        };
        for word in ["marmot", "numbat", "ocelot", "ibex"] {
            wait_until(word, 30, || !q(&reader, &all, word).is_empty());
        }
        assert!(svc.wait_for_commands(4, Duration::from_secs(30)), "the requests are all handled");
        assert!(svc.wait_for_passes(1, Duration::from_secs(120)));
        // the repeated rescans did not queue a pass each
        assert!(svc.passes_completed() <= 3, "{}", svc.passes_completed());
        svc.shutdown();
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_read_that_fails_never_deletes_what_is_indexed() {
        let (root, prov) = folder_fixture("idx-readfail");
        prov.docs.lock().unwrap().push(DocInput { id: "d1".into(), name: "G".into(), text: "The numbat guide".into() });
        prov.points.lock().unwrap().push(TalkingPointInput { id: "t1".into(), title: "T".into(), plain_text: "Greet the ocelot".into(), in_context: true });
        let mut conn = mem_db();
        add_meeting(&conn, "m1", "T", "2026-01-05T10:00:00Z", None, &[("You", "The marmot report", 0)]);
        run(&mut conn, prov.as_ref());
        let all = SearchScope {
            meetings: MeetingScope::Ids(vec!["m1".into()]),
            document_ids: vec!["d1".into()],
            folder_ids: vec!["f1".into()],
            talking_point_ids: vec!["t1".into()],
            ..Default::default()
        };
        for word in ["marmot", "numbat", "ocelot", "ibex"] {
            assert!(!q(&conn, &all, word).is_empty(), "{word} is indexed");
        }
        // the provider can't read: errors are reported, nothing is removed
        prov.fail.store(true, Ordering::SeqCst);
        let r = run(&mut conn, prov.as_ref());
        assert!(r.errors.len() >= 3, "{:?}", r.errors);
        assert_eq!(r.removed, 0);
        for word in ["marmot", "numbat", "ocelot", "ibex"] {
            assert!(!q(&conn, &all, word).is_empty(), "{word} survives a failed read");
        }
        // a targeted pass over one folder behaves the same
        let r = run_pass_scoped(&mut conn, prov.as_ref(), &RunControl::idle(), &|_| {}, &PassScope::folder("f1"));
        assert!(!r.errors.is_empty() && r.removed == 0);
        assert!(!q(&conn, &all, "ibex").is_empty());
        // and once it can read again, a really removed document goes
        prov.fail.store(false, Ordering::SeqCst);
        prov.docs.lock().unwrap().clear();
        let r = run(&mut conn, prov.as_ref());
        assert_eq!(r.removed, 1);
        assert!(q(&conn, &all, "numbat").is_empty());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn transcript_times_are_since_the_meeting_start_whatever_the_stamps() {
        // wall-clock stamps (some speech providers), relative stamps (others), before-start and a missing start
        let start: i64 = 1_767_348_000_000; // 2026-01-02T10:00:00Z
        let mut conn = mem_db();
        add_meeting(&conn, "e", "Epoch", "2026-01-02T10:00:00Z", None, &[("You", "epochquokka said hello", start + 3_000), ("Them", "second epochwombat line", start + 65_000)]);
        add_meeting(&conn, "r", "Relative", "2026-01-02T10:00:00Z", None, &[("You", "relquokka said hello", 3_000), ("Them", "second relwombat line", 65_000)]);
        add_meeting(&conn, "b", "Before", "2026-01-02T10:00:00Z", None, &[("You", "beforequokka said hello", start - 9_000)]);
        add_meeting(&conn, "n", "NoStart", "not a date", None, &[("You", "nostartquokka said hello", start + 5_000), ("Them", "nostartwombat second", start + 20_000)]);
        run(&mut conn, &MeetingsOnly);
        let all = SearchScope::with_meetings(["e", "r", "b", "n"]);
        let first = |word: &str| search(&conn, &all, word, &[], 5).unwrap().into_iter().next().unwrap_or_else(|| panic!("no hit for {word}"));
        // the passage that holds both lines starts at the first line's time
        assert_eq!(first("epochquokka").start_ms, Some(3_000), "epoch stamps");
        assert_eq!(first("relquokka").start_ms, Some(3_000), "relative stamps");
        assert_eq!(first("beforequokka").start_ms, Some(0), "before the start is 0");
        assert_eq!(first("nostartquokka").start_ms, Some(0), "no start time: the first stamp is 0");
        for p in ["epochwombat", "relwombat", "nostartwombat"] {
            let hit = first(p);
            assert!(hit.start_ms.unwrap() < 3_600_000 && hit.end_ms.unwrap() < 3_600_000, "{p}: {:?}", (hit.start_ms, hit.end_ms));
        }
    }
}
