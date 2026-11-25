//! Access that is checked while an answer runs and when a stored answer is
//! reused. Both use [`provenance::allowed`]: the run stops, and old answers are
//! left out, as soon as anything they rest on stops being part of the chat's
//! scope (a meeting moved, deleted or switched off, a source taken off the
//! workspace, a folder opted out, a memory item forgotten, a server removed,
//! General turned off ...). The check reads the database itself, so it does not
//! depend on which command made the change or on whether the chat has a CLI
//! session. A full check is cheap and runs only when another connection
//! committed since the last look (`PRAGMA data_version`), so it can run for
//! every streamed token. Any read that fails counts as "not allowed".

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use rusqlite::Connection;

use super::provenance::{allowed, Provenance, Universe};
use super::scope_adapter::{self, ChatScope};
use super::store;
use super::types::WorkspaceMessage;

/// The chat's current scope as a set of entries, or None when it can't be read.
pub fn universe_now(conn: &Connection, chat_id: &str) -> Option<(ChatScope, Universe)> {
    let row = store::get_chat(conn, chat_id).ok()??;
    let scope = scope_adapter::chat_scope(conn, &row).ok()?;
    let memory = crate::workspace::memory::saved_for_scope(conn, &scope.eff).ok()?;
    let universe = Universe::of(&scope, memory.into_iter().map(|m| m.id));
    Some((scope, universe))
}

fn still_allowed(conn: &Connection, chat_id: &str, prov: &Provenance) -> bool {
    universe_now(conn, chat_id).map_or(false, |(_, u)| allowed(prov, &u))
}

/// Stored answers checked against one reading of the scope.
pub struct Reuse {
    universe: Universe,
    prov: HashMap<i64, Provenance>,
}

impl Reuse {
    pub fn new(conn: &Connection, chat_id: &str) -> Result<Reuse, String> {
        let (_, universe) = universe_now(conn, chat_id).ok_or_else(|| "Couldn't read what this chat may use".to_string())?;
        Ok(Reuse { universe, prov: store::provenance_of_chat(conn, chat_id)? })
    }

    /// An assistant answer may be sent again (or saved) only with a record
    /// that is still allowed. Questions are the user's own words.
    pub fn reusable(&self, m: &WorkspaceMessage) -> bool {
        if m.role != "assistant" {
            return true;
        }
        self.prov.get(&m.id).map_or(false, |p| allowed(p, &self.universe))
    }

    pub fn provenance(&self, id: i64) -> Option<&Provenance> {
        self.prov.get(&id)
    }

    pub fn allows(&self, p: &Provenance) -> bool {
        allowed(p, &self.universe)
    }

    pub fn universe(&self) -> &Universe {
        &self.universe
    }
}

struct Inner {
    conn: Connection,
    last_version: Option<i64>,
}

pub struct AccessGuard {
    chat_id: String,
    prov: Provenance,
    inner: Mutex<Inner>,
    revoked: AtomicBool,
}

fn data_version(conn: &Connection) -> Option<i64> {
    conn.query_row("PRAGMA data_version", [], |r| r.get::<_, i64>(0)).ok()
}

/// Why a guarded write did not happen.
#[derive(Debug, PartialEq)]
pub enum WriteError {
    /// What it was made from is no longer allowed: nothing was written.
    Revoked,
    Failed(String),
}

/// `check` and `write` on one connection inside `BEGIN IMMEDIATE`: nobody else
/// can commit between the two, so a revocation either lands first (and nothing
/// is written) or after the commit. Keep `write` short and database-only.
pub fn atomically<T>(
    conn: &Connection,
    check: impl FnOnce(&Connection) -> bool,
    write: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, WriteError> {
    conn.execute_batch("BEGIN IMMEDIATE").map_err(|e| WriteError::Failed(format!("Couldn't save: {e}")))?;
    if !check(conn) {
        let _ = conn.execute_batch("ROLLBACK");
        return Err(WriteError::Revoked);
    }
    match write(conn) {
        Ok(v) => match conn.execute_batch("COMMIT") {
            Ok(()) => Ok(v),
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(WriteError::Failed(format!("Couldn't save: {e}")))
            }
        },
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(WriteError::Failed(e))
        }
    }
}

/// An answer that may be reused or saved: it has a record and everything in it
/// is still allowed.
pub fn answer_is_clean(conn: &Connection, m: &WorkspaceMessage) -> bool {
    match Reuse::new(conn, &m.chat_id) {
        Ok(r) => r.reusable(m),
        Err(_) => false,
    }
}

impl AccessGuard {
    pub fn new(conn: Connection, chat_id: &str, prov: Provenance) -> Self {
        AccessGuard {
            chat_id: chat_id.to_string(),
            prov,
            inner: Mutex::new(Inner { conn, last_version: None }),
            revoked: AtomicBool::new(false),
        }
    }

    /// Write something the answer produced, only if everything it used is still
    /// allowed at the moment of writing (one transaction, see [`atomically`]).
    pub fn check_and_write<T>(&self, write: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, WriteError> {
        let inner = self.inner.lock().map_err(|_| WriteError::Failed("busy".into()))?;
        let r = atomically(&inner.conn, |c| still_allowed(c, &self.chat_id, &self.prov), write);
        if matches!(r, Err(WriteError::Revoked)) {
            self.revoked.store(true, Ordering::SeqCst);
        }
        r
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
        let ok = still_allowed(&inner.conn, &self.chat_id, &self.prov);
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
