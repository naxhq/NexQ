//! Folders and servers live in the webview's plugin store and are pushed to
//! the backend by `set_personal_sources`. The first push after the upgrade
//! files every folder and server in General (once, with a marker), so the
//! upgrade changes nothing for someone who never touches workspaces. After
//! that a new item stays unfiled unless the user's own action files it (the
//! push says which workspace). A push never removes a membership: an item the
//! push lacks (a default config, a failed load) shows as missing, and only the
//! explicit removal of an item (`remove_library_item`) deletes its memberships.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::db::workspace_migrations::now_ms;
use crate::sources::config::PersonalSourcesConfig;

use super::types::{ItemKind, GENERAL_ID};

const MARKER: &str = "workspaces_sources_seeded";

fn err(what: &str, e: impl std::fmt::Display) -> String {
    format!("{what}: {e}")
}

fn tx_err(e: impl std::fmt::Display) -> String {
    err("Couldn't update the workspaces", e)
}

/// Seeds General once (marker) from the first pushed config. Nothing else
/// happens on a push: memberships are never removed here.
pub fn sync_with_config(conn: &Connection, cfg: &PersonalSourcesConfig) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(tx_err)?;
    let seeded: bool = tx
        .query_row("SELECT EXISTS(SELECT 1 FROM app_state WHERE key = ?1)", params![MARKER], |row| row.get(0))
        .map_err(tx_err)?;
    if !seeded {
        let now = now_ms();
        for (kind, id) in config_ids(cfg) {
            tx.execute(
                "INSERT OR IGNORE INTO workspace_items (workspace_id, kind, ref_id, added_at) VALUES (?1, ?2, ?3, ?4)",
                params![GENERAL_ID, kind.as_str(), id, now],
            )
            .map_err(tx_err)?;
        }
        tx.execute("INSERT OR REPLACE INTO app_state (key, value) VALUES (?1, '1')", params![MARKER]).map_err(tx_err)?;
    }
    tx.commit().map_err(tx_err)
}

fn config_ids(cfg: &PersonalSourcesConfig) -> Vec<(ItemKind, String)> {
    let folders = cfg.notes_folders.iter().map(|f| (ItemKind::Folder, f.id.clone()));
    let servers = cfg.mcp_servers.iter().map(|s| (ItemKind::Server, s.id.clone()));
    folders.chain(servers).filter(|(_, id)| !id.is_empty()).collect()
}

/// What the user's own action asks to file: the workspace and the ids of the
/// items just added (never inferred from the config).
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Filing {
    pub workspace_id: String,
    pub items: Vec<FilingItem>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FilingItem {
    pub kind: ItemKind,
    pub ref_id: String,
}

/// Refuses a filing whose workspace is unknown or archived (checked before
/// anything is saved).
pub fn check_filing(conn: &Connection, filing: &Filing) -> Result<(), String> {
    let ws = super::store::get_workspace(conn, &filing.workspace_id)?;
    if ws.archived {
        return Err(format!("\"{}\" is archived", ws.name));
    }
    Ok(())
}

/// Files the listed folders and servers in the workspace. Only an id that is in
/// `cfg` and has no membership anywhere is filed; every other id is ignored
/// (an unknown id, one already in a workspace, a document). Returns how many
/// were filed.
pub fn file_explicit(conn: &Connection, cfg: &PersonalSourcesConfig, filing: &Filing) -> Result<usize, String> {
    check_filing(conn, filing)?;
    let mut filed = 0;
    for item in &filing.items {
        if item.kind == ItemKind::Document || !is_configured(cfg, item.kind, &item.ref_id) {
            continue;
        }
        let has_membership: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM workspace_items WHERE kind = ?1 AND ref_id = ?2)",
                params![item.kind.as_str(), item.ref_id],
                |row| row.get(0),
            )
            .map_err(tx_err)?;
        if has_membership {
            continue;
        }
        super::store::add_item(conn, &filing.workspace_id, item.kind, &item.ref_id, None)?;
        filed += 1;
    }
    Ok(filed)
}

/// The user removed a folder or server: it leaves every workspace. Refused
/// while it is still in the saved config, so a stale call can't strip an item
/// the user still has.
pub fn remove_item_everywhere(
    conn: &Connection,
    cfg: &PersonalSourcesConfig,
    kind: ItemKind,
    ref_id: &str,
) -> Result<(), String> {
    if kind != ItemKind::Document && is_configured(cfg, kind, ref_id) {
        return Err("This item is still in your sources".to_string());
    }
    super::store::remove_memberships(conn, kind, ref_id)
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
    fn the_first_push_seeds_general_once_and_later_items_stay_unfiled() {
        let conn = memory_db();
        sync_with_config(&conn, &cfg(&["f1"], &["s1"])).unwrap();
        assert_eq!(members(&conn).len(), 2);
        sync_with_config(&conn, &cfg(&["f1", "f2"], &["s1"])).unwrap();
        assert_eq!(members(&conn).len(), 2, "f2 is not filed on its own");
    }

    #[test]
    fn an_empty_push_then_the_real_one_leaves_every_membership_intact() {
        let conn = memory_db();
        let real = cfg(&["f1"], &["s1"]);
        sync_with_config(&conn, &real).unwrap();
        let a = new_ws(&conn, "A", false, false);
        file(&conn, &a, "folder", "f1");
        let before = members(&conn);
        // A webview default or a failed load pushes nothing, then the real config comes.
        sync_with_config(&conn, &PersonalSourcesConfig::default()).unwrap();
        assert_eq!(members(&conn), before);
        sync_with_config(&conn, &real).unwrap();
        assert_eq!(members(&conn), before);
    }

    #[test]
    fn only_an_explicit_removal_deletes_memberships_and_only_for_an_item_gone_from_the_config() {
        let conn = memory_db();
        sync_with_config(&conn, &cfg(&["f1", "f2"], &[])).unwrap();
        // Still configured: refused.
        assert!(remove_item_everywhere(&conn, &cfg(&["f1", "f2"], &[]), ItemKind::Folder, "f1").is_err());
        assert_eq!(members(&conn).len(), 2);
        remove_item_everywhere(&conn, &cfg(&["f2"], &[]), ItemKind::Folder, "f1").unwrap();
        assert_eq!(members(&conn), vec![("general".into(), "folder".into(), "f2".into())]);
    }

    fn item(kind: ItemKind, id: &str) -> FilingItem {
        FilingItem { kind, ref_id: id.into() }
    }

    #[test]
    fn explicit_filing_files_only_configured_ids_with_no_membership() {
        let conn = memory_db();
        let a = new_ws(&conn, "A", false, false);
        // f1 is seeded into General; f2, s1 are new; "ghost" is not configured; a document is ignored.
        sync_with_config(&conn, &cfg(&["f1"], &[])).unwrap();
        let config = cfg(&["f1", "f2"], &["s1"]);
        let filing = Filing {
            workspace_id: a.clone(),
            items: vec![
                item(ItemKind::Folder, "f1"),
                item(ItemKind::Folder, "f2"),
                item(ItemKind::Server, "s1"),
                item(ItemKind::Folder, "ghost"),
                item(ItemKind::Document, "d1"),
            ],
        };
        assert_eq!(file_explicit(&conn, &config, &filing).unwrap(), 2);
        let mine: Vec<_> = members(&conn).into_iter().filter(|m| m.0 == a).map(|m| m.2).collect();
        assert_eq!(mine, vec!["f2", "s1"]);
        // Filing again changes nothing: they now have a membership.
        assert_eq!(file_explicit(&conn, &config, &filing).unwrap(), 0);
    }

    #[test]
    fn an_item_not_named_by_the_user_is_never_filed_even_if_new_in_the_config() {
        let conn = memory_db();
        let a = new_ws(&conn, "A", false, false);
        let config = cfg(&["f1", "f2"], &[]);
        let filing = Filing { workspace_id: a.clone(), items: vec![item(ItemKind::Folder, "f1")] };
        file_explicit(&conn, &config, &filing).unwrap();
        assert!(members(&conn).iter().all(|m| m.2 != "f2"));
    }

    #[test]
    fn filing_into_an_unknown_or_archived_workspace_is_refused() {
        let conn = memory_db();
        let a = new_ws(&conn, "Old", false, false);
        crate::workspace::store::archive_workspace(&conn, &a, true).unwrap();
        let config = cfg(&["f1"], &[]);
        for ws in [a, "nope".to_string()] {
            let filing = Filing { workspace_id: ws, items: vec![item(ItemKind::Folder, "f1")] };
            assert!(file_explicit(&conn, &config, &filing).is_err());
            assert!(check_filing(&conn, &filing).is_err());
        }
        assert!(members(&conn).is_empty());
    }

    #[test]
    fn the_filing_shape_matches_what_the_webview_sends() {
        let filing: Filing = serde_json::from_str(r#"{"workspace_id":"w","items":[{"kind":"folder","ref_id":"f"}]}"#).unwrap();
        assert_eq!((filing.workspace_id.as_str(), filing.items.len()), ("w", 1));
    }

    #[test]
    fn documents_are_not_touched_by_a_push() {
        let conn = memory_db();
        file(&conn, "general", "document", "d");
        sync_with_config(&conn, &cfg(&[], &[])).unwrap();
        assert_eq!(members(&conn).len(), 1);
    }
}
