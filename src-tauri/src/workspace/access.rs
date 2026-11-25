//! What a meeting or chat could use at a moment, and whether a change took
//! something away. A change that only adds or edits material is a grant; one
//! after which anything that was there is not is a revocation. The kind is
//! computed from the two views, never declared by the caller, so it can't be
//! misdeclared.

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::Connection;

use std::hash::{Hash, Hasher};

use rusqlite::params;

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
    /// Folders the user opted in to index (opting out takes access away).
    pub opted_folders: BTreeSet<String>,
    /// The live scope fingerprint of a meeting (see [`live_parts`]); empty for a chat.
    pub fingerprint: String,
    /// The meetings it may use: its home workspace's, minus the ones switched
    /// off (for a chat: the ones the chat includes).
    pub meetings: BTreeSet<String>,
    /// The scope has instructions of its own.
    pub instructions: bool,
    /// Content hashes: instructions, each talking point (with the meeting's own
    /// edit), each document's cached text version, each saved memory text and
    /// each opted-in folder's index. A changed or removed one is an edit of
    /// something the dependent already used.
    pub hashes: BTreeMap<String, u64>,
}

/// A restart caused by a grant waits (it may be coalesced); one caused by a
/// revocation happens at once.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Grant,
    /// Something it already used changed its content (a note edit, a reloaded
    /// document, a memory text): restarts soon, at most once per 5 s.
    Edit,
    Revoke,
}

/// What a read of a dependent's access found.
#[derive(Debug, Clone, PartialEq)]
pub enum ViewState {
    Present(AccessView),
    /// It does not exist (any more).
    Gone,
    /// It could not be read: treated as a revocation.
    Unreadable,
}

fn h64(parts: &[&str]) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    parts.hash(&mut h);
    h.finish()
}

/// Content hashes of what the scope's prompts carry (see `AccessView::hashes`).
fn content_hashes(conn: &Connection, scope: &EffectiveScope, folders: &[String], meeting_id: Option<&str>) -> BTreeMap<String, u64> {
    let mut out = BTreeMap::new();
    if !scope.instructions.trim().is_empty() {
        out.insert("instructions".to_string(), h64(&[&scope.instructions]));
    }
    for id in &scope.talking_point_ids {
        let text: String = conn.query_row("SELECT plain_text FROM talking_points WHERE id = ?1", params![id], |r| r.get(0)).unwrap_or_default();
        let edit: String = meeting_id
            .and_then(|m| conn.query_row("SELECT doc_json FROM talking_point_edits WHERE meeting_id = ?1 AND point_id = ?2", params![m, id], |r| r.get(0)).ok())
            .unwrap_or_default();
        out.insert(format!("tp:{id}"), h64(&[&text, &edit]));
    }
    for id in &scope.document_ids {
        // the cached text version: when it was loaded and what it was called
        let v: String = conn
            .query_row("SELECT loaded_at || '|' || name FROM context_resources WHERE id = ?1", params![id], |r| r.get(0))
            .unwrap_or_default();
        out.insert(format!("doc:{id}"), h64(&[&v]));
    }
    for m in memory::saved_for_scope(conn, scope).unwrap_or_default() {
        out.insert(format!("mem:{}", m.id), h64(&[&m.kind, &m.title, &m.text]));
    }
    for id in folders {
        let v: String = conn
            .prepare("SELECT group_concat(sub_ref || ':' || content_hash || ':' || status) FROM search_sources WHERE kind = 'folder' AND ref_id = ?1")
            .and_then(|mut s| s.query_row(params![id], |r| r.get::<_, Option<String>>(0)))
            .ok()
            .flatten()
            .unwrap_or_default();
        out.insert(format!("folder-index:{id}"), h64(&[&v]));
    }
    out
}

fn view_from(conn: &Connection, scope: &EffectiveScope, folders: Vec<String>, meetings: BTreeSet<String>, fingerprint: String, meeting_id: Option<&str>) -> AccessView {
    let hashes = content_hashes(conn, scope, &folders, meeting_id);
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
        opted_folders: folders.into_iter().collect(),
        fingerprint,
        meetings,
        instructions: !scope.instructions.trim().is_empty(),
        hashes,
    }
}

/// What `meeting_id` may use now: present, gone, or unreadable.
pub fn read_meeting_view(conn: &Connection, meeting_id: &str) -> ViewState {
    match conn.query_row("SELECT EXISTS(SELECT 1 FROM meetings WHERE id = ?1)", [meeting_id], |r| r.get::<_, bool>(0)) {
        Ok(false) => return ViewState::Gone,
        Err(_) => return ViewState::Unreadable,
        Ok(true) => {}
    }
    let Ok(scope) = scope_for(conn, ScopeOwner::Meeting(meeting_id)) else { return ViewState::Unreadable };
    let parts = live_parts_from(conn, &scope, meeting_id);
    let meetings: BTreeSet<String> = match conn
        .prepare("SELECT id FROM meetings WHERE workspace_id = ?1")
        .and_then(|mut s| s.query_map([&scope.home], |r| r.get::<_, String>(0)).and_then(|r| r.collect::<Result<Vec<_>, _>>()))
    {
        Ok(ids) => ids.into_iter().filter(|m| m != meeting_id && !parts.excluded_meetings.contains(m)).collect(),
        Err(_) => return ViewState::Unreadable,
    };
    ViewState::Present(view_from(conn, &scope, parts.folder_ids.clone(), meetings, parts.fingerprint, Some(meeting_id)))
}

/// What the chat `chat_id` may use now: its workspace's scope after the chat's
/// own exclusions and meeting choices.
pub fn read_chat_view(conn: &Connection, chat_id: &str) -> ViewState {
    let chat = match crate::workspace_chat::store::get_chat(conn, chat_id) {
        Ok(Some(c)) => c,
        Ok(None) => return ViewState::Gone,
        Err(_) => return ViewState::Unreadable,
    };
    let Ok(cs) = crate::workspace_chat::scope_adapter::chat_scope(conn, &chat) else { return ViewState::Unreadable };
    let meetings: BTreeSet<String> = cs.meetings.iter().map(|m| m.id.clone()).collect();
    ViewState::Present(view_from(conn, &cs.eff, cs.folder_ids.clone(), meetings, String::new(), None))
}

/// What `meeting_id` may use now (None when it does not exist or can't be read).
pub fn view_of_meeting(conn: &Connection, meeting_id: &str) -> Option<AccessView> {
    match read_meeting_view(conn, meeting_id) {
        ViewState::Present(v) => Some(v),
        _ => None,
    }
}

/// What the chat `chat_id` may use now (None when it does not exist or can't be read).
pub fn view_of_chat(conn: &Connection, chat_id: &str) -> Option<AccessView> {
    match read_chat_view(conn, chat_id) {
        ViewState::Present(v) => Some(v),
        _ => None,
    }
}

/// Whether anything a view's prompts carried changed or went (content hashes).
pub fn is_edit(before: &AccessView, after: &AccessView) -> bool {
    before.hashes.iter().any(|(k, v)| after.hashes.get(k) != Some(v))
}

/// Whether something the first view allowed is not allowed by the second.
pub fn is_revoke(before: &AccessView, after: &AccessView) -> bool {
    !before.material.is_subset(&after.material) || !before.items.is_subset(&after.items) || !before.memory.is_subset(&after.memory)
        || !before.opted_folders.is_subset(&after.opted_folders)
        || !before.meetings.is_subset(&after.meetings)
        || (before.instructions && !after.instructions)
}

/// Everything the live notes, brief and answers of a meeting are scoped by:
/// the ONE place the live fingerprint is made. Any difference in any part is a
/// different scope.
#[derive(Debug, Clone, PartialEq)]
pub struct LiveParts {
    pub fingerprint: String,
    pub home: String,
    pub document_ids: Vec<String>,
    /// Only folders the user opted in to index.
    pub folder_ids: Vec<String>,
    pub talking_point_ids: Vec<String>,
    /// The meeting itself and the ones switched off for the whole workspace.
    pub excluded_meetings: Vec<String>,
    /// Saved memory of the scope, newest first, about 300 tokens at most.
    pub memory_text: String,
    pub brief_enabled: bool,
}

fn core_memory(conn: &Connection, scope: &EffectiveScope) -> String {
    let mut items = memory::saved_for_scope(conn, scope).unwrap_or_default();
    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    let mut out = String::new();
    let mut used = 0u32;
    for m in items {
        let line = format!("- {}: {}
", crate::prompt_data::clean_line_max(&m.title, 80), crate::prompt_data::clean_line_max(&m.text, 240));
        let t = crate::live_common::estimate_tokens(&line);
        if used + t > 300 {
            break;
        }
        used += t;
        out.push_str(&line);
    }
    out.trim_end().to_string()
}

pub fn live_parts_from(conn: &Connection, scope: &EffectiveScope, meeting_id: &str) -> LiveParts {
    let brief_enabled = super::store::get_workspace(conn, &scope.home).map(|w| w.brief_default).unwrap_or(false);
    let mut folders = crate::workspace_chat::scope_adapter::opted_in_folders(conn, scope).unwrap_or_default();
    folders.sort();
    let mut excluded = vec![meeting_id.to_string()];
    if let Ok(mut stmt) = conn.prepare("SELECT meeting_id FROM workspace_meeting_prefs WHERE workspace_id = ?1 AND chat_id = '' AND included = 0") {
        if let Ok(rows) = stmt.query_map(params![scope.home], |r| r.get::<_, String>(0)) {
            excluded.extend(rows.filter_map(Result::ok));
        }
    }
    excluded.sort();
    excluded.dedup();
    let memory_text = core_memory(conn, scope);
    let mut docs = scope.document_ids.clone();
    docs.sort();
    let mut points = scope.talking_point_ids.clone();
    points.sort();
    let mut material = scope.material_workspaces.clone();
    material.sort();
    let mut parts = vec![scope.home.clone(), format!("brief={brief_enabled}"), memory_text.clone()];
    for (tag, list) in [("m", &material), ("d", &docs), ("f", &folders), ("t", &points), ("x", &excluded)] {
        parts.push(format!("{tag}:{}", list.join(",")));
    }
    let mut h = std::collections::hash_map::DefaultHasher::new();
    parts.hash(&mut h);
    LiveParts {
        fingerprint: format!("{}:{:x}", scope.home, h.finish()),
        home: scope.home.clone(),
        document_ids: docs,
        folder_ids: folders,
        talking_point_ids: points,
        excluded_meetings: excluded,
        memory_text,
        brief_enabled,
    }
}

/// The live parts of a meeting (None when workspaces cannot say: unrestricted or unknown).
pub fn live_parts(conn: &Connection, meeting_id: &str) -> Option<LiveParts> {
    let scope = scope_for(conn, ScopeOwner::Meeting(meeting_id)).ok()?;
    if scope.unrestricted {
        return None;
    }
    Some(live_parts_from(conn, &scope, meeting_id))
}

/// The kind of a change from what one dependent could use before and after.
pub fn kind_of(before: &AccessView, after: &AccessView) -> Kind {
    if is_revoke(before, after) {
        Kind::Revoke
    } else if is_edit(before, after) {
        Kind::Edit
    } else {
        Kind::Grant
    }
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
        assert_eq!(kind_after(&conn, "m", || { conn.execute("UPDATE talking_points SET plain_text = 'edited' WHERE id = 'p'", []).unwrap(); }), Kind::Edit);
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
            MemoryCreate { workspace_id: a.clone(), kind: "fact".into(), title: "t".into(), text: "x".into(), source_meeting: None, source_ms: None, status: None, unsupported: false },
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

    /// Every attribute that reduces what a meeting or chat may use: flipped off
    /// it is a revocation, flipped back on a grant.
    #[test]
    fn each_access_attribute_flipped_off_is_a_revocation_and_back_on_a_grant() {
        let conn = memory_db();
        let a = new_ws(&conn, "A", true, false);
        meeting(&conn, "m", &a);
        meeting(&conn, "other", &a);
        file(&conn, &a, "document", "d1");
        file(&conn, &a, "folder", "f1");
        conn.execute("UPDATE workspace_items SET index_opt_in = 1 WHERE ref_id = 'f1'", []).unwrap();
        conn.execute("INSERT INTO talking_points (id, workspace_id, title, in_context, created_at, updated_at) VALUES ('p', ?1, 't', 1, 0, 0)", params![a]).unwrap();
        let mem = crate::workspace::memory::create_memory(
            &conn,
            MemoryCreate { workspace_id: a.clone(), kind: "fact".into(), title: "t".into(), text: "x".into(), source_meeting: None, source_ms: None, status: None, unsupported: false },
        )
        .unwrap();
        store::update_workspace(&conn, &a, WorkspacePatch { instructions: Some("be brief".into()), ..Default::default() }).unwrap();
        conn.execute("INSERT INTO workspace_chats (id, workspace_id, created_at, updated_at) VALUES ('c', ?1, 0, 0)", params![a]).unwrap();
        let both = |conn: &Connection| (view_of_meeting(conn, "m").unwrap(), view_of_chat(conn, "c").unwrap());
        // (name, turn it off, turn it back on)
        type Flip<'a> = (&'a str, Box<dyn Fn(&Connection) + 'a>, Box<dyn Fn(&Connection) + 'a>);
        let flips: Vec<Flip> = vec![
            ("folder opt-in", Box::new(|c| { c.execute("UPDATE workspace_items SET index_opt_in = 0 WHERE ref_id = 'f1'", []).unwrap(); }), Box::new(|c| { c.execute("UPDATE workspace_items SET index_opt_in = 1 WHERE ref_id = 'f1'", []).unwrap(); })),
            ("talking point in context", Box::new(|c| { c.execute("UPDATE talking_points SET in_context = 0", []).unwrap(); }), Box::new(|c| { c.execute("UPDATE talking_points SET in_context = 1", []).unwrap(); })),
            ("document in the workspace", Box::new(|c| { c.execute("DELETE FROM workspace_items WHERE ref_id = 'd1'", []).unwrap(); }), Box::new(|c| { file(c, &a, "document", "d1"); })),
            ("memory saved", Box::new(|c| { crate::workspace::memory::update_memory(c, &mem.id, crate::workspace::types::MemoryUpdate { status: Some("dismissed".into()), ..Default::default() }).unwrap(); }), Box::new(|c| { crate::workspace::memory::update_memory(c, &mem.id, crate::workspace::types::MemoryUpdate { status: Some("saved".into()), ..Default::default() }).unwrap(); })),
            ("instructions", Box::new(|c| { store::update_workspace(c, &a, WorkspacePatch { instructions: Some(String::new()), ..Default::default() }).unwrap(); }), Box::new(|c| { store::update_workspace(c, &a, WorkspacePatch { instructions: Some("be brief".into()), ..Default::default() }).unwrap(); })),
            ("General included", Box::new(|c| { store::update_workspace(c, &a, WorkspacePatch { include_general: Some(false), ..Default::default() }).unwrap(); }), Box::new(|c| { store::update_workspace(c, &a, WorkspacePatch { include_general: Some(true), ..Default::default() }).unwrap(); })),
            ("meeting included for the workspace", Box::new(|c| { crate::workspace_chat::store::set_meeting_included(c, &a, None, "other", false).unwrap(); }), Box::new(|c| { crate::workspace_chat::store::set_meeting_included(c, &a, None, "other", true).unwrap(); })),
            ("item excluded in the chat", Box::new(|c| { crate::workspace_chat::store::set_item_pref(c, "c", "document", "d1", Some("exclude")).unwrap(); }), Box::new(|c| { crate::workspace_chat::store::set_item_pref(c, "c", "document", "d1", None).unwrap(); })),
        ];
        for (name, off, on) in &flips {
            let before = both(&conn);
            off(&conn);
            let after_off = both(&conn);
            let revoked = is_revoke(&before.0, &after_off.0) || is_revoke(&before.1, &after_off.1);
            assert!(revoked, "{name}: turned off must be a revocation");
            on(&conn);
            let after_on = both(&conn);
            assert!(!is_revoke(&after_off.0, &after_on.0) && !is_revoke(&after_off.1, &after_on.1), "{name}: turned back on must be a grant");
            assert_eq!(kind_of(&after_off.0, &after_on.0), Kind::Grant, "{name}");
        }
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
