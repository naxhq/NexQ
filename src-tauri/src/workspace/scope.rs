//! The effective scope of a meeting or chat: the one place that decides
//! which documents, folders, servers and talking points an answer may use.
//! Every consumer filters by it before ranking or assembling anything.
//!
//! Home + borrowed + General (only when the home includes it and is not kept
//! separate) share *material*. Meetings and chats come from the home only.
//! An item that is in no workspace is in no scope.

use std::collections::{BTreeSet, HashSet};
use std::hash::{Hash, Hasher};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use super::rules;
use super::store;
use super::types::{Workspace, GENERAL_ID};

/// What one meeting or chat may use.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct EffectiveScope {
    /// Where it is filed.
    pub home: String,
    /// Home, borrowed workspaces and General when the home includes it.
    pub material_workspaces: Vec<String>,
    pub document_ids: Vec<String>,
    pub folder_ids: Vec<String>,
    pub server_ids: Vec<String>,
    /// Talking points marked "use as AI context".
    pub talking_point_ids: Vec<String>,
    /// The home's instructions (not shared with borrowed workspaces).
    pub instructions: String,
    /// Workspaces are unavailable in this run: nothing is filtered, as before
    /// workspaces existed.
    #[serde(skip)]
    pub unrestricted: bool,
}

impl EffectiveScope {
    /// No filtering at all (workspaces unavailable, or no database).
    pub fn unrestricted() -> Self {
        Self { home: GENERAL_ID.to_string(), unrestricted: true, ..Self::default() }
    }

    pub fn allows_document(&self, id: &str) -> bool {
        self.unrestricted || self.document_ids.iter().any(|d| d == id)
    }

    pub fn allows_folder(&self, id: &str) -> bool {
        self.unrestricted || self.folder_ids.iter().any(|d| d == id)
    }

    pub fn allows_server(&self, id: &str) -> bool {
        self.unrestricted || self.server_ids.iter().any(|d| d == id)
    }

    /// The allowed document ids as a set for `contains` lookups; None when
    /// nothing is filtered.
    pub fn document_set(&self) -> Option<HashSet<&str>> {
        (!self.unrestricted).then(|| self.document_ids.iter().map(String::as_str).collect())
    }

    /// The allowed document ids as a filter for a search (None = unfiltered).
    pub fn document_filter(&self) -> Option<Vec<String>> {
        (!self.unrestricted).then(|| self.document_ids.clone())
    }

    /// Changes whenever anything a session or cache was built from changes.
    pub fn fingerprint(&self) -> String {
        if self.unrestricted {
            return "unrestricted".to_string();
        }
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        self.home.hash(&mut hasher);
        self.document_ids.hash(&mut hasher);
        self.folder_ids.hash(&mut hasher);
        self.server_ids.hash(&mut hasher);
        self.talking_point_ids.hash(&mut hasher);
        self.instructions.hash(&mut hasher);
        format!("{}:{:x}", self.home, hasher.finish())
    }
}

/// Whose scope: a meeting (home + its borrowed workspaces) or a workspace
/// chat (the chat's workspace only).
#[derive(Debug, Clone, Copy)]
pub enum ScopeOwner<'a> {
    Meeting(&'a str),
    Chat(&'a str),
}

/// The scope of a meeting or chat (see the module notes).
pub fn scope_for(conn: &Connection, owner: ScopeOwner<'_>) -> Result<EffectiveScope, String> {
    match owner {
        ScopeOwner::Meeting(id) => {
            let home = store::home_of(conn, id)?.unwrap_or_else(|| store::default_workspace_id(conn));
            let borrowed = store::borrowed_of(conn, id)?;
            scope_for_home(conn, &home, &borrowed)
        }
        ScopeOwner::Chat(id) => {
            let home: String = conn
                .query_row("SELECT workspace_id FROM workspace_chats WHERE id = ?1", params![id], |row| row.get(0))
                .map_err(|e| format!("Couldn't find the chat: {e}"))?;
            scope_for_home(conn, &home, &[])
        }
    }
}

/// The scope of work filed in `home` that also uses `borrowed`.
pub fn scope_for_home(conn: &Connection, home_id: &str, borrowed_ids: &[String]) -> Result<EffectiveScope, String> {
    // A meeting filed nowhere uses nothing: no material, no instructions, no borrowed workspace.
    if super::types::is_unfiled(home_id) {
        return Ok(EffectiveScope { home: home_id.to_string(), ..EffectiveScope::default() });
    }
    let home = store::find_workspace(conn, home_id)?
        .map(Ok)
        .unwrap_or_else(|| store::get_workspace(conn, GENERAL_ID))?;
    let mut borrowed = Vec::new();
    for id in borrowed_ids {
        if let Some(w) = store::find_workspace(conn, id)? {
            borrowed.push(w);
        }
    }
    let mut material: Vec<String> = vec![home.id.clone()];
    for b in rules::usable_borrowed(&home, &borrowed) {
        material.push(b.id.clone());
    }
    if rules::includes_general(&home) {
        material.push(GENERAL_ID.to_string());
    }
    let mut seen = HashSet::new();
    material.retain(|id| seen.insert(id.clone()));
    material_scope(conn, &home, material)
}

/// The material of `workspaces` with `home`'s instructions.
fn material_scope(conn: &Connection, home: &Workspace, workspaces: Vec<String>) -> Result<EffectiveScope, String> {
    let ids_json = serde_json::to_string(&workspaces).map_err(|e| e.to_string())?;
    let mut docs = BTreeSet::new();
    let mut folders = BTreeSet::new();
    let mut servers = BTreeSet::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT kind, ref_id FROM workspace_items
                 WHERE workspace_id IN (SELECT value FROM json_each(?1))",
            )
            .map_err(|e| format!("Couldn't read the workspace items: {e}"))?;
        let rows = stmt
            .query_map(params![ids_json], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (kind, ref_id) = row.map_err(|e| e.to_string())?;
            match kind.as_str() {
                "document" => docs.insert(ref_id),
                "folder" => folders.insert(ref_id),
                _ => servers.insert(ref_id),
            };
        }
    }
    let mut points: Vec<String> = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT id FROM talking_points
                 WHERE in_context = 1 AND workspace_id IN (SELECT value FROM json_each(?1))
                 ORDER BY sort, created_at",
            )
            .map_err(|e| format!("Couldn't read the talking points: {e}"))?;
        let rows = stmt.query_map(params![ids_json], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
        for row in rows {
            points.push(row.map_err(|e| e.to_string())?);
        }
    }
    Ok(EffectiveScope {
        home: home.id.clone(),
        material_workspaces: workspaces,
        document_ids: docs.into_iter().collect(),
        folder_ids: folders.into_iter().collect(),
        server_ids: servers.into_iter().collect(),
        talking_point_ids: points,
        instructions: home.instructions.clone(),
        unrestricted: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::test_support::*;

    #[test]
    fn a_workspace_that_does_not_include_general_sees_only_its_own_material() {
        let conn = memory_db();
        file(&conn, "general", "document", "doc-general");
        let a = new_ws(&conn, "A", false, false);
        file(&conn, &a, "document", "doc-a");
        file(&conn, &a, "folder", "folder-a");
        file(&conn, &a, "server", "server-a");
        conn.execute("INSERT INTO meetings (id, title, start_time, workspace_id) VALUES ('m', 't', 'x', ?1)", params![a]).unwrap();
        let scope = scope_for(&conn, ScopeOwner::Meeting("m")).unwrap();
        assert_eq!(scope.home, a);
        assert_eq!(scope.document_ids, vec!["doc-a"]);
        assert_eq!(scope.folder_ids, vec!["folder-a"]);
        assert_eq!(scope.server_ids, vec!["server-a"]);
        assert!(!scope.allows_document("doc-general"));
    }

    #[test]
    fn including_general_adds_its_material_and_keep_separate_removes_it() {
        let conn = memory_db();
        file(&conn, "general", "document", "doc-general");
        let a = new_ws(&conn, "A", true, false);
        file(&conn, &a, "document", "doc-a");
        let scope = scope_for_home(&conn, &a, &[]).unwrap();
        assert_eq!(scope.document_ids, vec!["doc-a", "doc-general"]);
        assert_eq!(scope.material_workspaces, vec![a.clone(), "general".to_string()]);
        // Kept separate: the flag is ignored and General is out.
        conn.execute("UPDATE workspaces SET keep_separate = 1 WHERE id = ?1", params![a]).unwrap();
        let scope = scope_for_home(&conn, &a, &[]).unwrap();
        assert_eq!(scope.document_ids, vec!["doc-a"]);
    }

    #[test]
    fn borrowed_workspaces_share_material_but_not_instructions_and_a_removed_one_is_gone() {
        let conn = memory_db();
        let a = new_ws(&conn, "A", false, false);
        let b = new_ws(&conn, "B", false, false);
        file(&conn, &a, "document", "doc-a");
        file(&conn, &b, "document", "doc-b");
        conn.execute("UPDATE workspaces SET instructions = 'only A' WHERE id = ?1", params![a]).unwrap();
        conn.execute("UPDATE workspaces SET instructions = 'only B' WHERE id = ?1", params![b]).unwrap();
        conn.execute("INSERT INTO meetings (id, title, start_time, workspace_id) VALUES ('m', 't', 'x', ?1)", params![a]).unwrap();
        conn.execute("INSERT INTO meeting_borrowed (meeting_id, workspace_id, added_at) VALUES ('m', ?1, 1)", params![b]).unwrap();
        let scope = scope_for(&conn, ScopeOwner::Meeting("m")).unwrap();
        assert_eq!(scope.document_ids, vec!["doc-a", "doc-b"]);
        assert_eq!(scope.instructions, "only A");
        conn.execute("UPDATE meeting_borrowed SET removed_at = 5", []).unwrap();
        let scope = scope_for(&conn, ScopeOwner::Meeting("m")).unwrap();
        assert_eq!(scope.document_ids, vec!["doc-a"]);
    }

    #[test]
    fn a_workspace_that_became_separate_is_not_used_even_if_still_borrowed() {
        let conn = memory_db();
        let a = new_ws(&conn, "A", false, false);
        let b = new_ws(&conn, "B", false, true);
        file(&conn, &b, "document", "doc-b");
        let scope = scope_for_home(&conn, &a, &[b.clone()]).unwrap();
        assert!(scope.document_ids.is_empty());
        // And a separate home borrows nothing.
        let scope = scope_for_home(&conn, &b, &[a]).unwrap();
        assert_eq!(scope.document_ids, vec!["doc-b"]);
    }

    #[test]
    fn unfiled_items_are_in_no_scope_and_the_default_home_is_general() {
        let conn = memory_db();
        conn.execute(
            "INSERT INTO context_resources (id, name, file_type, file_path, loaded_at) VALUES ('unfiled', 'u', 'txt', 'x', 'now')",
            [],
        )
        .unwrap();
        // A meeting that does not exist is homed in the default workspace.
        let scope = scope_for(&conn, ScopeOwner::Meeting("nope")).unwrap();
        assert_eq!(scope.home, "general");
        assert!(!scope.allows_document("unfiled"));
    }

    #[test]
    fn talking_points_reach_the_scope_only_when_marked_as_context() {
        let conn = memory_db();
        let a = new_ws(&conn, "A", false, false);
        for (id, ctx) in [("tp1", 1), ("tp2", 0)] {
            conn.execute(
                "INSERT INTO talking_points (id, workspace_id, title, in_context, sort, created_at, updated_at)
                 VALUES (?1, ?2, 't', ?3, 0, 0, 0)",
                params![id, a, ctx],
            )
            .unwrap();
        }
        let scope = scope_for_home(&conn, &a, &[]).unwrap();
        assert_eq!(scope.talking_point_ids, vec!["tp1"]);
    }

    #[test]
    fn the_fingerprint_changes_with_the_material() {
        let conn = memory_db();
        let a = new_ws(&conn, "A", false, false);
        let before = scope_for_home(&conn, &a, &[]).unwrap().fingerprint();
        file(&conn, &a, "document", "doc-a");
        let after = scope_for_home(&conn, &a, &[]).unwrap().fingerprint();
        assert_ne!(before, after);
        assert_eq!(after, scope_for_home(&conn, &a, &[]).unwrap().fingerprint());
    }
}
