//! What a meeting or chat could use at a moment, and whether a change took
//! something away. A change that only adds or edits material is a grant; one
//! after which anything that was there is not is a revocation. The kind is
//! computed from the two views, never declared by the caller, so it can't be
//! misdeclared.

use std::collections::BTreeSet;

use rusqlite::Connection;

use super::scope::{scope_for, EffectiveScope, ScopeOwner};
use super::{memory, types::GENERAL_ID};

/// Everything a meeting or chat may use: the workspaces whose material it
/// shares, each document, folder, server and context talking point, and each
/// saved memory item. (Instructions and the text inside an item are edits, not
/// access.)
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AccessView {
    pub material: BTreeSet<String>,
    pub items: BTreeSet<String>,
    pub memory: BTreeSet<String>,
}

/// A restart caused by a grant waits (it may be coalesced); one caused by a
/// revocation happens at once.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Grant,
    Revoke,
}

fn view_from(conn: &Connection, scope: &EffectiveScope) -> AccessView {
    let mut items = BTreeSet::new();
    for (kind, ids) in [
        ("document", &scope.document_ids),
        ("folder", &scope.folder_ids),
        ("server", &scope.server_ids),
        ("talking_point", &scope.talking_point_ids),
    ] {
        items.extend(ids.iter().map(|id| format!("{kind}:{id}")));
    }
    AccessView {
        material: scope.material_workspaces.iter().cloned().collect(),
        items,
        memory: memory::saved_for_scope(conn, scope).map(|m| m.into_iter().map(|i| i.id).collect()).unwrap_or_default(),
    }
}

/// What `meeting_id` may use now (None when it does not exist).
pub fn view_of_meeting(conn: &Connection, meeting_id: &str) -> Option<AccessView> {
    let exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM meetings WHERE id = ?1)", [meeting_id], |r| r.get(0)).ok()?;
    if !exists {
        return None;
    }
    scope_for(conn, ScopeOwner::Meeting(meeting_id)).ok().map(|s| view_from(conn, &s))
}

/// What the chat `chat_id` may use now (None when it does not exist).
pub fn view_of_chat(conn: &Connection, chat_id: &str) -> Option<AccessView> {
    scope_for(conn, ScopeOwner::Chat(chat_id)).ok().map(|s| view_from(conn, &s))
}

/// Whether something the first view allowed is not allowed by the second.
pub fn is_revoke(before: &AccessView, after: &AccessView) -> bool {
    !before.material.is_subset(&after.material) || !before.items.is_subset(&after.items) || !before.memory.is_subset(&after.memory)
}

/// The kind of a change from what one dependent could use before and after.
pub fn kind_of(before: &AccessView, after: &AccessView) -> Kind {
    if is_revoke(before, after) { Kind::Revoke } else { Kind::Grant }
}

/// A view that holds General only (what a fresh meeting in General can use).
pub fn general_only() -> AccessView {
    AccessView { material: BTreeSet::from([GENERAL_ID.to_string()]), ..Default::default() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::meetings::set_meeting_scope;
    use crate::workspace::store;
    use crate::workspace::test_support::*;
    use crate::workspace::types::{MemoryCreate, WorkspacePatch};
    use rusqlite::params;

    fn meeting(conn: &Connection, id: &str, home: &str) {
        conn.execute("INSERT INTO meetings (id, title, start_time, workspace_id) VALUES (?1, 't', 'x', ?2)", params![id, home]).unwrap();
    }

    fn kind_after(conn: &Connection, id: &str, change: impl FnOnce()) -> Kind {
        let before = view_of_meeting(conn, id).unwrap();
        change();
        kind_of(&before, &view_of_meeting(conn, id).unwrap())
    }

    #[test]
    fn adding_or_editing_material_is_a_grant() {
        let conn = memory_db();
        let a = new_ws(&conn, "A", false, false);
        meeting(&conn, "m", &a);
        assert_eq!(kind_after(&conn, "m", || file(&conn, &a, "folder", "f1")), Kind::Grant);
        assert_eq!(kind_after(&conn, "m", || {}), Kind::Grant, "no change at all takes nothing away");
        // Editing a note's text keeps its id: access is the same.
        conn.execute("INSERT INTO talking_points (id, workspace_id, title, in_context, created_at, updated_at) VALUES ('p', ?1, 't', 1, 0, 0)", params![a]).unwrap();
        assert_eq!(kind_after(&conn, "m", || { conn.execute("UPDATE talking_points SET plain_text = 'edited' WHERE id = 'p'", []).unwrap(); }), Kind::Grant);
        let b = new_ws(&conn, "B", false, false);
        assert_eq!(kind_after(&conn, "m", || { set_meeting_scope(&conn, "m", &[b.clone()]).unwrap(); }), Kind::Grant, "a borrow added");
    }

    #[test]
    fn anything_taken_away_is_a_revocation() {
        let conn = memory_db();
        let a = new_ws(&conn, "A", true, false);
        let b = new_ws(&conn, "B", false, false);
        meeting(&conn, "m", &a);
        file(&conn, &a, "document", "d1");
        file(&conn, "general", "document", "dg");
        conn.execute("INSERT INTO talking_points (id, workspace_id, title, in_context, created_at, updated_at) VALUES ('p', ?1, 't', 1, 0, 0)", params![a]).unwrap();
        set_meeting_scope(&conn, "m", &[b.clone()]).unwrap();
        let mem = crate::workspace::memory::create_memory(
            &conn,
            MemoryCreate { workspace_id: a.clone(), kind: "fact".into(), title: "t".into(), text: "x".into(), source_meeting: None, source_ms: None, status: None },
        )
        .unwrap();
        assert_eq!(kind_after(&conn, "m", || { conn.execute("DELETE FROM workspace_items WHERE ref_id = 'd1'", []).unwrap(); }), Kind::Revoke, "an item removed");
        assert_eq!(kind_after(&conn, "m", || { conn.execute("UPDATE talking_points SET in_context = 0", []).unwrap(); }), Kind::Revoke, "in_context off");
        assert_eq!(kind_after(&conn, "m", || { crate::workspace::memory::delete_memory(&conn, &mem.id).unwrap(); }), Kind::Revoke, "memory forgotten");
        assert_eq!(kind_after(&conn, "m", || { set_meeting_scope(&conn, "m", &[]).unwrap(); }), Kind::Revoke, "un-borrowed");
        assert_eq!(
            kind_after(&conn, "m", || { store::update_workspace(&conn, &a, WorkspacePatch { include_general: Some(false), ..Default::default() }).unwrap(); }),
            Kind::Revoke,
            "General off"
        );
        let c = new_ws(&conn, "C", false, false);
        assert_eq!(kind_after(&conn, "m", || { crate::workspace::meetings::move_meeting(&conn, "m", &c).unwrap(); }), Kind::Revoke, "moved");
        assert_eq!(
            kind_after(&conn, "m", || { store::update_workspace(&conn, &c, WorkspacePatch { keep_separate: Some(true), ..Default::default() }).unwrap(); }),
            Kind::Grant,
            "a workspace kept separate loses nothing of its own"
        );
    }

    #[test]
    fn a_chat_view_follows_its_workspace_and_a_missing_one_has_none() {
        let conn = memory_db();
        let a = new_ws(&conn, "A", true, false);
        conn.execute("INSERT INTO workspace_chats (id, workspace_id, created_at, updated_at) VALUES ('c', ?1, 0, 0)", params![a]).unwrap();
        file(&conn, "general", "document", "dg");
        let before = view_of_chat(&conn, "c").unwrap();
        assert!(before.items.contains("document:dg"));
        store::update_workspace(&conn, &a, WorkspacePatch { include_general: Some(false), ..Default::default() }).unwrap();
        assert_eq!(kind_of(&before, &view_of_chat(&conn, "c").unwrap()), Kind::Revoke);
        assert!(view_of_chat(&conn, "nope").is_none() && view_of_meeting(&conn, "nope").is_none());
        assert_eq!(general_only().material.len(), 1);
    }
}
