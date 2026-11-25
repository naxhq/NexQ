//! Folders and servers live in the webview's plugin store and are pushed to
//! the backend by `set_personal_sources`. The first push after the upgrade
//! files every folder and server in General (once, with a marker), so the
//! upgrade changes nothing for someone who never touches workspaces. After
//! that a new item stays unfiled until it is added inside a workspace. Items
//! removed from the config leave their workspaces.

use rusqlite::{params, Connection};

use crate::db::workspace_migrations::now_ms;
use crate::sources::config::PersonalSourcesConfig;

use super::types::{ItemKind, GENERAL_ID};

const MARKER: &str = "workspaces_sources_seeded";

fn err(what: &str, e: impl std::fmt::Display) -> String {
    format!("{what}: {e}")
}

/// Applies a pushed config to the memberships: seeds General once, then drops
/// the memberships of folders and servers that are no longer configured.
pub fn sync_with_config(conn: &Connection, cfg: &PersonalSourcesConfig) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| err("Couldn't update the workspaces", e))?;
    let seeded: bool = tx
        .query_row("SELECT EXISTS(SELECT 1 FROM app_state WHERE key = ?1)", params![MARKER], |row| row.get(0))
        .map_err(|e| err("Couldn't update the workspaces", e))?;
    if !seeded {
        let now = now_ms();
        let folders = cfg.notes_folders.iter().map(|f| (ItemKind::Folder, &f.id));
        let servers = cfg.mcp_servers.iter().map(|s| (ItemKind::Server, &s.id));
        for (kind, id) in folders.chain(servers).filter(|(_, id)| !id.is_empty()) {
            tx.execute(
                "INSERT OR IGNORE INTO workspace_items (workspace_id, kind, ref_id, added_at) VALUES (?1, ?2, ?3, ?4)",
                params![GENERAL_ID, kind.as_str(), id, now],
            )
            .map_err(|e| err("Couldn't update the workspaces", e))?;
        }
        tx.execute("INSERT OR REPLACE INTO app_state (key, value) VALUES (?1, '1')", params![MARKER])
            .map_err(|e| err("Couldn't update the workspaces", e))?;
    }
    prune(&tx, ItemKind::Folder, cfg.notes_folders.iter().map(|f| f.id.as_str()).collect())?;
    prune(&tx, ItemKind::Server, cfg.mcp_servers.iter().map(|s| s.id.as_str()).collect())?;
    tx.commit().map_err(|e| err("Couldn't update the workspaces", e))
}

/// Removes the memberships of `kind` whose item is not in `keep`.
fn prune(conn: &Connection, kind: ItemKind, keep: Vec<&str>) -> Result<(), String> {
    let keep = serde_json::to_string(&keep).map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM workspace_items WHERE kind = ?1 AND ref_id NOT IN (SELECT value FROM json_each(?2))",
        params![kind.as_str(), keep],
    )
    .map(|_| ())
    .map_err(|e| err("Couldn't update the workspaces", e))
}

/// Whether a folder or server is known by a workspace's items (used by the
/// commands to refuse an unknown id).
pub fn is_configured(cfg: &PersonalSourcesConfig, kind: ItemKind, id: &str) -> bool {
    match kind {
        ItemKind::Folder => cfg.notes_folders.iter().any(|f| f.id == id),
        ItemKind::Server => cfg.mcp_servers.iter().any(|s| s.id == id),
        ItemKind::Document => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sources::config::{McpServer, NotesFolder};
    use crate::workspace::test_support::*;

    fn cfg(folders: &[&str], servers: &[&str]) -> PersonalSourcesConfig {
        PersonalSourcesConfig {
            notes_folders: folders.iter().map(|id| NotesFolder { id: (*id).into(), label: (*id).into(), path: "x".into(), enabled: true }).collect(),
            mcp_servers: servers.iter().map(|id| McpServer { id: (*id).into(), key: (*id).into(), label: (*id).into(), enabled: true, ..Default::default() }).collect(),
            ..Default::default()
        }
    }

    fn members(conn: &Connection) -> Vec<(String, String, String)> {
        let mut stmt = conn.prepare("SELECT workspace_id, kind, ref_id FROM workspace_items ORDER BY kind, ref_id").unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap().map(Result::unwrap).collect()
    }

    #[test]
    fn the_first_push_files_everything_in_general_and_later_pushes_leave_new_items_unfiled() {
        let conn = memory_db();
        sync_with_config(&conn, &cfg(&["f1"], &["s1"])).unwrap();
        assert_eq!(members(&conn).len(), 2);
        // A folder added later is not filed anywhere.
        sync_with_config(&conn, &cfg(&["f1", "f2"], &["s1"])).unwrap();
        assert_eq!(members(&conn).len(), 2);
        // A removed one leaves its workspaces.
        sync_with_config(&conn, &cfg(&["f2"], &[])).unwrap();
        assert!(members(&conn).is_empty());
        // Even if the user took everything out of General, a push never refills it.
        sync_with_config(&conn, &cfg(&["f1", "f2"], &["s1"])).unwrap();
        assert!(members(&conn).is_empty());
    }

    #[test]
    fn documents_are_not_touched_by_a_push() {
        let conn = memory_db();
        file(&conn, "general", "document", "d");
        sync_with_config(&conn, &cfg(&[], &[])).unwrap();
        assert_eq!(members(&conn).len(), 1);
    }
}
