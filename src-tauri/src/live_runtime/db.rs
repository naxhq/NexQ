//! Everything the live runtimes read and write in SQLite, behind one small
//! provider trait so tests use an in-memory database and the app its shared
//! connection (locked only for the length of one statement group).
//!
//! `LiveScope` is the ONE description of what a meeting may use: search, the
//! brief, memory and every fingerprint comparison are made from it.

use crate::live_brief::search::Passage;
use crate::live_brief::sheet::Sheet;
use crate::live_notes::db as notes_db;
use crate::live_notes::doc::NoteDoc;
use crate::workspace::memory as ws_memory;
use crate::workspace::store;
use crate::workspace::types::{MemoryCreate, MemoryItem};
use crate::workspace_memory::{MemLine, MemoryKind, SavedItem};
use crate::workspace_search::{self as wsearch, MeetingScope, PassageKind, SearchScope};
use rusqlite::{params, Connection, OptionalExtension};
use std::sync::{Arc, Mutex};

/// Gives a closure the shared connection. False when it could not be had.
pub trait ConnProvider: Send + Sync {
    fn with_conn(&self, f: &mut dyn FnMut(&Connection)) -> bool;
}

impl ConnProvider for Arc<Mutex<crate::db::DatabaseManager>> {
    fn with_conn(&self, f: &mut dyn FnMut(&Connection)) -> bool {
        match self.lock() {
            Ok(g) => {
                f(g.connection());
                true
            }
            Err(_) => false,
        }
    }
}

impl ConnProvider for Mutex<Connection> {
    fn with_conn(&self, f: &mut dyn FnMut(&Connection)) -> bool {
        match self.lock() {
            Ok(g) => {
                f(&g);
                true
            }
            Err(_) => false,
        }
    }
}

/// What one meeting may search and which memory it may see.
#[derive(Debug, Clone, PartialEq)]
pub struct LiveScope {
    /// The AI run service's generation of the meeting's scope when this was
    /// resolved (filled in by the runtime, 0 from the database).
    pub generation: u64,
    /// Changes whenever anything below does (home, material workspaces,
    /// documents, opted-in folders, talking points, memory, excluded meetings).
    pub fingerprint: String,
    pub home: String,
    /// Exactly what search uses.
    pub search: SearchScope,
    /// Saved memory of the scope, newest first, at most about 300 tokens, one item per line.
    pub memory_text: String,
    /// The home workspace has the brief on.
    pub brief_enabled: bool,
}

#[derive(Debug, Clone)]
pub struct StoredBrief {
    pub sheet: Option<Sheet>,
    pub status: String,
    pub tokens_used: u64,
    pub cap: u64,
    /// The scope fingerprint the sheet was made under.
    pub fingerprint: String,
}

#[derive(Clone)]
pub struct LiveDb {
    conn: Arc<dyn ConnProvider>,
    /// Read-only connections for the reads of the live path, so they never wait for the
    /// shared connection the transcript writer uses. None in tests (one in-memory connection).
    reader: Option<Arc<crate::db::readers::ReaderPool>>,
}

fn run<T>(p: &dyn ConnProvider, f: impl FnOnce(&Connection) -> T) -> Option<T> {
    let mut f = Some(f);
    let mut out = None;
    p.with_conn(&mut |c| {
        if let Some(f) = f.take() {
            out = Some(f(c));
        }
    });
    out
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

impl LiveDb {
    pub fn new(conn: Arc<dyn ConnProvider>) -> Self {
        Self { conn, reader: None }
    }

    pub fn with_reader(mut self, reader: Option<Arc<crate::db::readers::ReaderPool>>) -> Self {
        self.reader = reader;
        self
    }

    /// A read: on a reader of its own when there is one (else on the shared connection).
    fn read<T>(&self, f: impl Fn(&Connection) -> T) -> Option<T> {
        if let Some(pool) = &self.reader {
            if let Ok(out) = pool.with(&f) {
                return Some(out);
            }
        }
        run(self.conn.as_ref(), f)
    }

    fn with<T>(&self, f: impl FnOnce(&Connection) -> T) -> Option<T> {
        run(self.conn.as_ref(), f)
    }

    // ---- settings (key/value)

    pub fn kv_get(&self, key: &str) -> Option<String> {
        self.read(|c| c.query_row("SELECT value FROM app_state WHERE key = ?1", params![key], |r| r.get::<_, Option<String>>(0)).optional().ok().flatten().flatten()).flatten()
    }

    pub fn kv_set(&self, key: &str, value: &str) -> Result<(), String> {
        self.with(|c| c.execute("INSERT INTO app_state (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![key, value]).map(|_| ()).map_err(|e| e.to_string()))
            .unwrap_or_else(|| Err("The database is busy".into()))
    }

    pub fn meeting_exists(&self, meeting_id: &str) -> bool {
        self.read(|c| c.query_row("SELECT 1 FROM meetings WHERE id = ?1", params![meeting_id], |_| Ok(())).optional().ok().flatten().is_some()).unwrap_or(false)
    }

    // ---- notes (a save never creates a row for a meeting that is gone)

    pub fn load_notes(&self, meeting_id: &str) -> Option<notes_db::StoredNotes> {
        self.read(|c| notes_db::load_notes(c, meeting_id).ok().flatten()).flatten()
    }

    pub fn save_notes(&self, meeting_id: &str, doc: &NoteDoc, status: &str, used: u64, cap: u64) -> Result<(), String> {
        self.with(|c| notes_db::save_notes(c, meeting_id, doc, status, used, cap, now_ms()).map_err(|e| e.to_string()))
            .unwrap_or_else(|| Err("The database is busy".into()))
    }

    // ---- brief

    pub fn load_brief(&self, meeting_id: &str) -> Option<StoredBrief> {
        self.read(|c| {
            c.query_row("SELECT sheet_json, status, tokens_used, cap, fingerprint FROM meeting_briefs WHERE meeting_id = ?1", params![meeting_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?, r.get::<_, String>(4)?))
            })
            .optional()
            .ok()
            .flatten()
            .map(|(json, status, used, cap, fingerprint)| StoredBrief {
                sheet: serde_json::from_str::<Sheet>(&json).ok(),
                status,
                tokens_used: used.max(0) as u64,
                cap: cap.max(0) as u64,
                fingerprint,
            })
        })
        .flatten()
    }

    pub fn save_brief(&self, meeting_id: &str, sheet: Option<&Sheet>, status: &str, used: u64, cap: u64, fingerprint: &str) -> Result<(), String> {
        let json = sheet.map(|s| serde_json::to_string(s).unwrap_or_else(|_| "{}".into())).unwrap_or_else(|| "{}".into());
        self.with(|c| {
            c.execute(
                "INSERT INTO meeting_briefs (meeting_id, sheet_json, status, tokens_used, cap, updated_at, fingerprint)
                 SELECT ?1,?2,?3,?4,?5,?6,?7 WHERE EXISTS (SELECT 1 FROM meetings WHERE id = ?1)
                 ON CONFLICT(meeting_id) DO UPDATE SET sheet_json=excluded.sheet_json, status=excluded.status,
                   tokens_used=excluded.tokens_used, cap=excluded.cap, updated_at=excluded.updated_at, fingerprint=excluded.fingerprint",
                params![meeting_id, json, status, used as i64, cap as i64, now_ms(), fingerprint],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
        })
        .unwrap_or_else(|| Err("The database is busy".into()))
    }

    /// A run that was `running` when the app died is `interrupted`: resumable.
    pub fn mark_interrupted(&self) -> usize {
        self.with(|c| {
            let a = c.execute("UPDATE meeting_notes SET status = 'interrupted' WHERE status = 'running'", []).unwrap_or(0);
            let b = c.execute("UPDATE meeting_briefs SET status = 'interrupted' WHERE status = 'running'", []).unwrap_or(0);
            a + b
        })
        .unwrap_or(0)
    }

    // ---- scope

    /// The meeting's scope, or why it can't be had (shown as the reason it stopped).
    pub fn scope_result(&self, meeting_id: &str) -> Result<LiveScope, String> {
        match self.read(|c| crate::workspace::access::live_parts(c, meeting_id)) {
            None => Err("the database is busy".to_string()),
            Some(None) => Err("workspaces are unavailable, or this meeting is gone".to_string()),
            Some(Some(_)) => self.scope(meeting_id).ok_or_else(|| "the scope could not be read".to_string()),
        }
    }

    pub fn scope(&self, meeting_id: &str) -> Option<LiveScope> {
        self.read(|c| {
            // the one place the live fingerprint is made
            let p = crate::workspace::access::live_parts(c, meeting_id)?;
            let search = SearchScope {
                meetings: MeetingScope::HomeWorkspace(p.home.clone()),
                document_ids: p.document_ids,
                folder_ids: p.folder_ids,
                talking_point_ids: p.talking_point_ids,
                excluded_meeting_ids: p.excluded_meetings,
            };
            Some(LiveScope { generation: 0, fingerprint: p.fingerprint, home: p.home, search, memory_text: p.memory_text, brief_enabled: p.brief_enabled })
        })
        .flatten()
    }

    /// The local search the brief uses (no tool calls), over exactly `scope.search`.
    pub fn search(&self, scope: &LiveScope, query: &str, max: usize) -> Vec<Passage> {
        if query.trim().is_empty() {
            return Vec::new();
        }
        let kinds = [PassageKind::Transcript, PassageKind::Document, PassageKind::Folder, PassageKind::TalkingPoint];
        self.read(|c| wsearch::search::search(c, &scope.search, query, &kinds, max).unwrap_or_default())
            .unwrap_or_default()
            .into_iter()
            .map(|p| Passage {
                id: format!("{}:{}#{}", p.kind, p.ref_id, p.id),
                title: p.title,
                text: p.text,
                start_ms: p.start_ms.and_then(|m| u64::try_from(m).ok()),
            })
            .collect()
    }

    // ---- memory

    pub fn meeting_home(&self, meeting_id: &str) -> Option<String> {
        self.read(|c| c.query_row("SELECT workspace_id FROM meetings WHERE id = ?1", params![meeting_id], |r| r.get::<_, String>(0)).ok()).flatten()
    }

    pub fn suggest_flag(&self, workspace_id: &str) -> bool {
        self.read(|c| store::get_workspace(c, workspace_id).map(|w| w.suggest_memory && !w.archived).unwrap_or(false)).unwrap_or(false)
    }

    /// When the meeting started (epoch ms), if its row has a usable start time.
    pub fn meeting_start_ms(&self, meeting_id: &str) -> Option<i64> {
        self.read(|c| {
            c.query_row("SELECT start_time FROM meetings WHERE id = ?1", params![meeting_id], |r| r.get::<_, Option<String>>(0))
                .ok()
                .flatten()
                .and_then(|s| crate::live_common::parse_start_ms(&s))
        })
        .flatten()
    }

    /// The final lines of a meeting (times since its start) and its length.
    pub fn meeting_lines(&self, meeting_id: &str) -> (Vec<MemLine>, u64) {
        let start = self.meeting_start_ms(meeting_id);
        self.read(|c| {
            let mut stmt = match c.prepare("SELECT speaker, text, timestamp_ms FROM transcript_segments WHERE meeting_id = ?1 AND is_final = 1 ORDER BY timestamp_ms, rowid") {
                Ok(s) => s,
                Err(_) => return (Vec::new(), 0),
            };
            let rows = stmt.query_map(params![meeting_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)));
            let raw: Vec<(String, String, i64)> = rows.map(|r| r.filter_map(|x| x.ok()).collect()).unwrap_or_default();
            let base = crate::live_common::base_ms(start, raw.iter().map(|x| x.2));
            let mut lines: Vec<MemLine> = raw.into_iter().map(|(speaker, text, ts)| MemLine { speaker, text, ms: crate::live_common::rel_ms(ts, base) }).collect();
            lines.sort_by_key(|l| l.ms);
            let len = lines.last().map(|l| l.ms).unwrap_or(0);
            (lines, len)
        })
        .unwrap_or_default()
    }

    pub fn saved_memory(&self, workspace_id: &str) -> Vec<SavedItem> {
        self.read(|c| {
            ws_memory::list_memory(c, workspace_id)
                .unwrap_or_default()
                .into_iter()
                .filter(|m| m.status == "saved")
                .filter_map(|m| Some(SavedItem { id: m.id, kind: MemoryKind::from_loose(&m.kind)?, title: m.title, text: m.text }))
                .collect()
        })
        .unwrap_or_default()
    }

    /// Stores proposals as `suggested`, in one transaction that first checks
    /// the meeting still exists and is still filed in `workspace_id`: a
    /// meeting that moved or went while the model worked gets nothing saved.
    pub fn save_suggestions(&self, meeting_id: &str, workspace_id: &str, items: Vec<MemoryCreate>, require_switch: bool) -> Vec<MemoryItem> {
        self.with(|c| {
            let Ok(tx) = crate::db::immediate_tx(c) else { return Vec::new() };
            let home: Option<String> = tx.query_row("SELECT workspace_id FROM meetings WHERE id = ?1", params![meeting_id], |r| r.get(0)).ok();
            if home.as_deref() != Some(workspace_id) {
                return Vec::new();
            }
            // an automatic run saves only while the workspace still has its switch on
            if require_switch && !store::get_workspace(&tx, workspace_id).map(|w| w.suggest_memory && !w.archived).unwrap_or(false) {
                return Vec::new();
            }
            let saved: Vec<MemoryItem> = items
                .into_iter()
                .filter(|i| i.workspace_id == workspace_id)
                .filter_map(|i| ws_memory::create_memory(&tx, i).ok())
                .collect();
            if tx.commit().is_err() {
                return Vec::new();
            }
            saved
        })
        .unwrap_or_default()
    }
}
