//! Access that is checked while an answer runs. An answer is built from a
//! set of meetings, documents, folders, talking points and memory items; if
//! any of them stops being part of the chat's scope (a meeting moved out or
//! deleted, an item taken off the workspace, a folder opted out, a memory item
//! forgotten) the run stops and nothing is shown or saved from then on.
//!
//! The guard looks at the database itself, so it does not depend on which
//! command made the change or on whether the chat has a CLI session. A full
//! check is cheap and runs only when another connection committed since the
//! last look (`PRAGMA data_version`), so it can run for every streamed token.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use rusqlite::Connection;

use super::scope_adapter;
use super::store;
use crate::workspace_search::context_plan::ContextPlan;

/// What one answer was built from.
#[derive(Debug, Clone, Default)]
pub struct Used {
    pub meetings: BTreeSet<String>,
    pub documents: BTreeSet<String>,
    pub folders: BTreeSet<String>,
    pub points: BTreeSet<String>,
    pub memory: BTreeSet<String>,
}

impl Used {
    pub fn of_plan(plan: &ContextPlan) -> Used {
        let mut u = Used::default();
        for it in &plan.items {
            let set = match it.kind.as_str() {
                "transcript" | "meeting" => &mut u.meetings,
                "document" => &mut u.documents,
                "folder" => &mut u.folders,
                "talking_point" => &mut u.points,
                _ => continue,
            };
            set.insert(it.ref_id.clone());
        }
        for m in &plan.memory {
            u.memory.insert(m.id.clone());
        }
        u
    }
}

struct Inner {
    conn: Connection,
    last_version: Option<i64>,
}

pub struct AccessGuard {
    chat_id: String,
    used: Used,
    inner: Mutex<Inner>,
    revoked: AtomicBool,
}

fn data_version(conn: &Connection) -> Option<i64> {
    conn.query_row("PRAGMA data_version", [], |r| r.get::<_, i64>(0)).ok()
}

/// Everything the answer used is still part of the chat's scope. A read that
/// fails counts as "no": an unreadable scope never lets anything through.
fn still_allowed(conn: &Connection, chat_id: &str, used: &Used) -> bool {
    let Ok(Some(row)) = store::get_chat(conn, chat_id) else { return false };
    let Ok(scope) = scope_adapter::chat_scope(conn, &row) else { return false };
    let meetings: BTreeSet<&str> = scope.meetings.iter().map(|m| m.id.as_str()).collect();
    if !used.meetings.iter().all(|m| meetings.contains(m.as_str())) {
        return false;
    }
    if !used.documents.iter().all(|d| scope.eff.document_ids.contains(d)) {
        return false;
    }
    if !used.folders.iter().all(|f| scope.folder_ids.contains(f)) {
        return false;
    }
    if !used.points.iter().all(|p| scope.eff.talking_point_ids.contains(p)) {
        return false;
    }
    if !used.memory.is_empty() {
        let Ok(saved) = crate::workspace::memory::saved_for_scope(conn, &scope.eff) else { return false };
        let saved: BTreeSet<&str> = saved.iter().map(|m| m.id.as_str()).collect();
        if !used.memory.iter().all(|m| saved.contains(m.as_str())) {
            return false;
        }
    }
    true
}

impl AccessGuard {
    pub fn new(conn: Connection, chat_id: &str, used: Used) -> Self {
        AccessGuard {
            chat_id: chat_id.to_string(),
            used,
            inner: Mutex::new(Inner { conn, last_version: None }),
            revoked: AtomicBool::new(false),
        }
    }

    /// True while everything the answer used is still allowed. Once false it
    /// stays false.
    pub fn ok(&self) -> bool {
        if self.revoked.load(Ordering::SeqCst) {
            return false;
        }
        let mut inner = match self.inner.lock() {
            Ok(i) => i,
            Err(_) => {
                self.revoked.store(true, Ordering::SeqCst);
                return false;
            }
        };
        let version = data_version(&inner.conn);
        if version.is_some() && version == inner.last_version {
            return true; // nothing was committed by anyone else since the last look
        }
        let ok = still_allowed(&inner.conn, &self.chat_id, &self.used);
        inner.last_version = version;
        if !ok {
            self.revoked.store(true, Ordering::SeqCst);
        }
        ok
    }

    pub fn revoked(&self) -> bool {
        self.revoked.load(Ordering::SeqCst)
    }
}

/// The message shown when an answer was stopped for this reason.
pub const STOPPED: &str =
    "Something this answer was using was taken away from the chat (a meeting was moved or deleted, or a source was removed), so the answer was stopped and nothing was saved. Ask again.";
