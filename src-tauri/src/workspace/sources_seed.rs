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

/// Seeds General once (marker) from the first push that is real: one with
/// something in it, or one the webview says came after its store finished
/// loading (`loaded`). A default or failed-load push (empty, not loaded) sets
/// nothing, so the real config that follows is still seeded. Nothing else
/// happens on a push: memberships are never removed here.
pub fn sync_with_config(conn: &Connection, cfg: &PersonalSourcesConfig, loaded: bool) -> Result<(), String> {
    let tx = crate::db::immediate_tx(conn).map_err(tx_err)?;
    let seeded: bool = tx
        .query_row("SELECT EXISTS(SELECT 1 FROM app_state WHERE key = ?1)", params![MARKER], |row| row.get(0))
        .map_err(tx_err)?;
    let real = loaded || !config_ids(cfg).is_empty();
    if !seeded && real {
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
/// `cfg` is filed; every other id is ignored (an unknown id, a document). An
/// item already in another workspace is linked here too: a server or folder
/// exists once in Settings, and adding what is already there only links it.
/// Returns how many were newly filed here.
pub fn file_explicit(conn: &Connection, cfg: &PersonalSourcesConfig, filing: &Filing) -> Result<usize, String> {
    check_filing(conn, filing)?;
    let mut filed = 0;
    for item in &filing.items {
        if item.kind == ItemKind::Document || !is_configured(cfg, item.kind, &item.ref_id) {
            continue;
        }
        let here: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM workspace_items WHERE workspace_id = ?1 AND kind = ?2 AND ref_id = ?3)",
                params![filing.workspace_id, item.kind.as_str(), item.ref_id],
                |row| row.get(0),
            )
            .map_err(tx_err)?;
        if here {
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
    super::store::remove_memberships(conn, kind, ref_id)?;
    // What was indexed from a folder that is gone goes with it.
    if kind == ItemKind::Folder {
        super::purge::purge_search_rows(conn, "folder", ref_id)?;
    }
    Ok(())
}

/// Repair of duplicates (see `sources::dedupe`): every membership and per-chat
/// choice that names a dropped item moves to the one kept, in one transaction.
/// Two memberships that become the same row in one workspace are merged (pinned
/// and "search its text" win, the kept label is kept unless it has none). What
/// was indexed from a dropped folder goes; the kept one's index stays.
/// Idempotent. Returns how many rows moved or merged.
pub fn repoint_duplicates(conn: &Connection, kind: ItemKind, map: &[(String, String)]) -> Result<usize, String> {
    if map.is_empty() || kind == ItemKind::Document {
        return Ok(0);
    }
    let tx = crate::db::immediate_tx(conn).map_err(tx_err)?;
    let kind_text = kind.as_str();
    let mut changed = 0;
    for (dropped, kept) in map {
        if dropped == kept {
            continue;
        }
        let rows: Vec<(String, Option<String>, i64, i64, i64)> = {
            let mut stmt = tx
                .prepare("SELECT workspace_id, label, pinned, index_opt_in, added_at FROM workspace_items WHERE kind = ?1 AND ref_id = ?2")
                .map_err(tx_err)?;
            let found = stmt
                .query_map(params![kind_text, dropped], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
                .map_err(tx_err)?;
            found.collect::<Result<_, _>>().map_err(tx_err)?
        };
        for (workspace_id, label, pinned, opt_in, added_at) in rows {
            let has_kept: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM workspace_items WHERE workspace_id = ?1 AND kind = ?2 AND ref_id = ?3)",
                    params![workspace_id, kind_text, kept],
                    |r| r.get(0),
                )
                .map_err(tx_err)?;
            if has_kept {
                tx.execute(
                    "UPDATE workspace_items SET label = COALESCE(label, ?4), pinned = MAX(pinned, ?5),
                        index_opt_in = MAX(index_opt_in, ?6), added_at = MIN(added_at, ?7)
                     WHERE workspace_id = ?1 AND kind = ?2 AND ref_id = ?3",
                    params![workspace_id, kind_text, kept, label, pinned, opt_in, added_at],
                )
                .map_err(tx_err)?;
                tx.execute(
                    "DELETE FROM workspace_items WHERE workspace_id = ?1 AND kind = ?2 AND ref_id = ?3",
                    params![workspace_id, kind_text, dropped],
                )
                .map_err(tx_err)?;
            } else {
                tx.execute(
                    "UPDATE workspace_items SET ref_id = ?4 WHERE workspace_id = ?1 AND kind = ?2 AND ref_id = ?3",
                    params![workspace_id, kind_text, dropped, kept],
                )
                .map_err(tx_err)?;
            }
            changed += 1;
        }
        if kind == ItemKind::Folder {
            // A chat's pin or exclude of a folder follows the folder that stays.
            let has_prefs: bool = tx
                .query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspace_chat_item_prefs')", [], |r| r.get(0))
                .map_err(tx_err)?;
            if has_prefs {
                changed += tx
                    .execute(
                        "UPDATE OR IGNORE workspace_chat_item_prefs SET ref_id = ?1 WHERE kind = 'folder' AND ref_id = ?2",
                        params![kept, dropped],
                    )
                    .map_err(tx_err)?;
                tx.execute("DELETE FROM workspace_chat_item_prefs WHERE kind = 'folder' AND ref_id = ?1", params![dropped])
                    .map_err(tx_err)?;
            }
            super::purge::purge_search_rows(&tx, "folder", dropped)?;
        }
    }
    tx.commit().map_err(tx_err)?;
    Ok(changed)
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
        sync_with_config(&conn, &cfg(&["f1"], &["s1"]), false).unwrap();
        assert_eq!(members(&conn).len(), 2);
        sync_with_config(&conn, &cfg(&["f1", "f2"], &["s1"]), true).unwrap();
        assert_eq!(members(&conn).len(), 2, "f2 is not filed on its own");
    }

    #[test]
    fn a_default_push_before_the_store_loaded_seeds_nothing_and_the_real_one_still_does() {
        let conn = memory_db();
        // The webview's default (empty, not loaded): no marker, nothing filed.
        sync_with_config(&conn, &PersonalSourcesConfig::default(), false).unwrap();
        assert!(members(&conn).is_empty());
        // The loaded config arrives: General is seeded once.
        sync_with_config(&conn, &cfg(&["f1"], &["s1"]), true).unwrap();
        assert_eq!(members(&conn).len(), 2);
        // After the marker, a loaded empty push seeds nothing more.
        sync_with_config(&conn, &cfg(&["f1", "f2"], &["s1"]), true).unwrap();
        assert_eq!(members(&conn).len(), 2);
    }

    #[test]
    fn a_loaded_empty_config_sets_the_marker_so_later_items_stay_unfiled() {
        let conn = memory_db();
        sync_with_config(&conn, &PersonalSourcesConfig::default(), true).unwrap();
        sync_with_config(&conn, &cfg(&["f1"], &[]), true).unwrap();
        assert!(members(&conn).is_empty(), "an item added after the first loaded push is not seeded");
    }

    #[test]
    fn an_empty_push_then_the_real_one_leaves_every_membership_intact() {
        let conn = memory_db();
        let real = cfg(&["f1"], &["s1"]);
        sync_with_config(&conn, &real, true).unwrap();
        let a = new_ws(&conn, "A", false, false);
        file(&conn, &a, "folder", "f1");
        let before = members(&conn);
        // A webview default or a failed load pushes nothing, then the real config comes.
        sync_with_config(&conn, &PersonalSourcesConfig::default(), false).unwrap();
        assert_eq!(members(&conn), before);
        sync_with_config(&conn, &real, true).unwrap();
        assert_eq!(members(&conn), before);
    }

    #[test]
    fn only_an_explicit_removal_deletes_memberships_and_only_for_an_item_gone_from_the_config() {
        let conn = memory_db();
        sync_with_config(&conn, &cfg(&["f1", "f2"], &[]), true).unwrap();
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
    fn explicit_filing_files_configured_ids_and_links_ones_filed_elsewhere() {
        let conn = memory_db();
        let a = new_ws(&conn, "A", false, false);
        // f1 is seeded into General (adding it again links it here too); f2, s1 are new;
        // "ghost" is not configured; a document is ignored.
        sync_with_config(&conn, &cfg(&["f1"], &[]), true).unwrap();
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
        assert_eq!(file_explicit(&conn, &config, &filing).unwrap(), 3);
        let mine: Vec<_> = members(&conn).into_iter().filter(|m| m.0 == a).map(|m| m.2).collect();
        assert_eq!(mine, vec!["f1", "f2", "s1"]);
        assert!(members(&conn).contains(&("general".into(), "folder".into(), "f1".into())), "General keeps it");
        // Filing again changes nothing.
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
    fn a_dropped_duplicate_is_replaced_by_the_one_kept_in_every_workspace() {
        let conn = memory_db();
        let (a, b) = (new_ws(&conn, "A", false, false), new_ws(&conn, "B", false, false));
        file(&conn, &a, "server", "keep");
        file(&conn, &a, "server", "drop");
        file(&conn, &b, "server", "drop");
        file(&conn, &b, "folder", "drop");
        let map = vec![("drop".to_string(), "keep".to_string())];
        assert_eq!(repoint_duplicates(&conn, ItemKind::Server, &map).unwrap(), 2);
        let all = members(&conn);
        assert!(all.iter().all(|m| !(m.1 == "server" && m.2 == "drop")));
        assert!(all.contains(&(a.clone(), "server".into(), "keep".into())) && all.contains(&(b.clone(), "server".into(), "keep".into())));
        assert_eq!(all.iter().filter(|m| m.0 == a && m.1 == "server").count(), 1, "two rows became one");
        assert!(all.contains(&(b, "folder".into(), "drop".into())), "another kind is not touched");
        // Again: nothing moves.
        assert_eq!(repoint_duplicates(&conn, ItemKind::Server, &map).unwrap(), 0);
    }

    #[test]
    fn documents_are_not_touched_by_a_push() {
        let conn = memory_db();
        file(&conn, "general", "document", "d");
        sync_with_config(&conn, &cfg(&[], &[]), true).unwrap();
        assert_eq!(members(&conn).len(), 1);
    }
}
