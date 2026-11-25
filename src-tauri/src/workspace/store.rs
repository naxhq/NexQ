//! Workspace rows and their items: create, change, clone, archive, delete,
//! default, order. Plain SQL over one connection; the commands call these.

use std::collections::HashMap;
use std::path::PathBuf;

use rusqlite::{params, Connection, OptionalExtension, Row};

use super::purge;
use super::rules;
use super::types::*;

pub use crate::db::workspace_migrations::now_ms;

const COLUMNS: &str = "id, name, icon, color, description, instructions, include_general, keep_separate, \
                       default_scenario, recaps_with_ai, suggest_memory, brief_default, is_default, pinned, \
                       archived, sort, created_at, updated_at";

fn read_workspace(row: &Row<'_>) -> rusqlite::Result<Workspace> {
    Ok(Workspace {
        id: row.get(0)?,
        name: row.get(1)?,
        icon: row.get(2)?,
        color: row.get(3)?,
        description: row.get(4)?,
        instructions: row.get(5)?,
        include_general: row.get(6)?,
        keep_separate: row.get(7)?,
        default_scenario: row.get(8)?,
        recaps_with_ai: row.get(9)?,
        suggest_memory: row.get(10)?,
        brief_default: row.get(11)?,
        is_default: row.get(12)?,
        pinned: row.get(13)?,
        archived: row.get(14)?,
        sort: row.get(15)?,
        created_at: row.get(16)?,
        updated_at: row.get(17)?,
    })
}

fn db_err(what: &str, e: rusqlite::Error) -> String {
    format!("{what}: {e}")
}

/// The workspace `id`, if there is one.
pub fn find_workspace(conn: &Connection, id: &str) -> Result<Option<Workspace>, String> {
    conn.query_row(&format!("SELECT {COLUMNS} FROM workspaces WHERE id = ?1"), params![id], read_workspace)
        .optional()
        .map_err(|e| db_err("Couldn't read the workspace", e))
}

/// The workspace `id`, or an error saying it is gone.
pub fn get_workspace(conn: &Connection, id: &str) -> Result<Workspace, String> {
    find_workspace(conn, id)?.ok_or_else(|| "This workspace no longer exists".to_string())
}

/// The default workspace's id (General when none is marked or it is archived).
pub fn default_workspace_id(conn: &Connection) -> String {
    conn.query_row(
        "SELECT id FROM workspaces WHERE is_default = 1 AND archived = 0 LIMIT 1",
        [],
        |row| row.get(0),
    )
    .unwrap_or_else(|_| GENERAL_ID.to_string())
}

fn table_exists(conn: &Connection, name: &str) -> bool {
    conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1", params![name], |r| r.get::<_, i64>(0))
        .map(|n| n > 0)
        .unwrap_or(false)
}

/// Chats per workspace and the newest chat edit (the chat feature may not be
/// installed yet: then none).
fn chat_stats(conn: &Connection) -> HashMap<String, (i64, i64)> {
    if !table_exists(conn, "workspace_chats") {
        return HashMap::new();
    }
    let Ok(mut stmt) = conn.prepare("SELECT workspace_id, COUNT(*), COALESCE(MAX(updated_at), 0) FROM workspace_chats GROUP BY workspace_id") else {
        return HashMap::new();
    };
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, (row.get::<_, i64>(1)?, row.get::<_, i64>(2)?))));
    rows.map(|rows| rows.filter_map(Result::ok).collect()).unwrap_or_default()
}

/// The summary of a workspace row with its counts.
fn summarize(w: Workspace, meetings: i64, items: i64, latest_meeting: Option<String>, chats: (i64, i64)) -> WorkspaceSummary {
    let activity = latest_meeting
        .and_then(|t| chrono::DateTime::parse_from_rfc3339(&t).ok())
        .map(|t| t.timestamp_millis())
        .into_iter()
        .chain([w.updated_at, chats.1])
        .max();
    WorkspaceSummary {
        id: w.id,
        name: w.name,
        icon: w.icon,
        color: w.color,
        description: w.description,
        include_general: w.include_general,
        keep_separate: w.keep_separate,
        default_scenario: w.default_scenario,
        is_default: w.is_default,
        pinned: w.pinned,
        archived: w.archived,
        sort: w.sort,
        meeting_count: meetings,
        chat_count: chats.0,
        item_count: items,
        last_activity: activity,
        created_at: w.created_at,
        updated_at: w.updated_at,
    }
}

/// Where a meeting asked to start is filed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartHome {
    /// In this workspace.
    Home(String),
    /// A workspace was asked for and cannot be used: the meeting starts filed nowhere (no workspace material).
    Unfiled,
}

/// Where a meeting asked to start is filed, and a sentence when that is not where it was asked for.
/// No id means the default workspace (General when none is usable). An id that is unknown,
/// archived or unreadable is never swapped for another workspace, whose material the person did
/// not choose: the meeting starts unfiled and the sentence says so.
pub fn home_for_start(conn: &Connection, requested: Option<&str>) -> (StartHome, Option<String>) {
    let Some(asked) = requested.filter(|id| !id.is_empty()) else {
        return (StartHome::Home(default_workspace_id(conn)), None);
    };
    let unfiled = |why: String| {
        (
            StartHome::Unfiled,
            Some(format!("{why}, so this meeting is not filed in a workspace and uses none of their material. Pick one from the island to file it")),
        )
    };
    match find_workspace(conn, asked) {
        Ok(Some(ws)) if !ws.archived => (StartHome::Home(ws.id), None),
        Ok(Some(ws)) => unfiled(format!("\"{}\" is archived", ws.name)),
        Ok(None) => unfiled("That workspace is no longer available".to_string()),
        Err(_) => unfiled("That workspace couldn't be read".to_string()),
    }
}

/// Every workspace with counts and last activity, in the user's order.
pub fn list_summaries(conn: &Connection) -> Result<Vec<WorkspaceSummary>, String> {
    let chats = chat_stats(conn);
    let sql = format!(
        "SELECT {cols},
            (SELECT COUNT(*) FROM meetings m WHERE m.workspace_id = w.id),
            (SELECT COUNT(*) FROM workspace_items i WHERE i.workspace_id = w.id),
            (SELECT MAX(m.start_time) FROM meetings m WHERE m.workspace_id = w.id)
         FROM workspaces w ORDER BY w.sort, w.created_at",
        cols = COLUMNS.split(", ").map(|c| format!("w.{c}")).collect::<Vec<_>>().join(", ")
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| db_err("Couldn't list the workspaces", e))?;
    let rows = stmt
        .query_map([], |row| {
            let workspace = read_workspace(row)?;
            let chat = chats.get(&workspace.id).copied().unwrap_or((0, 0));
            Ok(summarize(workspace, row.get(18)?, row.get(19)?, row.get(20)?, chat))
        })
        .map_err(|e| db_err("Couldn't list the workspaces", e))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| db_err("Couldn't list the workspaces", e))
}

/// One workspace as a summary.
pub fn get_summary(conn: &Connection, id: &str) -> Result<WorkspaceSummary, String> {
    list_summaries(conn)?
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| "This workspace no longer exists".to_string())
}

fn clean_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Give the workspace a name".to_string());
    }
    if name.chars().count() > 80 {
        return Err("Keep the name under 80 characters".to_string());
    }
    Ok(name.to_string())
}

/// The id of a new workspace: the caller's when it is a UUID v4 that nothing
/// uses (and not "general"), a fresh one when none was given.
pub fn chosen_id(conn: &Connection, wanted: Option<&str>) -> Result<String, String> {
    let Some(wanted) = wanted else {
        return Ok(uuid::Uuid::new_v4().to_string());
    };
    let parsed = uuid::Uuid::parse_str(wanted).ok().filter(|u| u.get_version() == Some(uuid::Version::Random));
    let Some(parsed) = parsed else {
        return Err("A workspace id must be a UUID v4".to_string());
    };
    // Only the canonical lower-case form is stored, so one id has one spelling.
    let id = parsed.hyphenated().to_string();
    if id != wanted || id == GENERAL_ID || find_workspace(conn, &id)?.is_some() {
        return Err("This workspace id can't be used".to_string());
    }
    Ok(id)
}

fn clean_opt(value: Option<String>) -> Option<String> {
    value.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn next_sort(conn: &Connection) -> i64 {
    conn.query_row("SELECT COALESCE(MAX(sort), 0) + 1 FROM workspaces", [], |row| row.get(0)).unwrap_or(1)
}

/// Creates a workspace. It uses General only when asked, and never when kept
/// separate.
pub fn create_workspace(conn: &Connection, input: CreateWorkspaceInput) -> Result<Workspace, String> {
    let name = clean_name(&input.name)?;
    let id = chosen_id(conn, input.id.as_deref())?;
    let (include_general, keep_separate) = rules::normalize_flags(&id, input.include_general, input.keep_separate)?;
    let now = now_ms();
    conn.execute(
        "INSERT INTO workspaces (id, name, icon, color, description, instructions, include_general,
            keep_separate, default_scenario, is_default, pinned, archived, sort, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, 0, 0, ?10, ?11, ?11)",
        params![
            id,
            name,
            clean_opt(input.icon),
            clean_opt(input.color),
            input.description.trim(),
            crate::prompt_data::strip_hidden(&input.instructions),
            include_general,
            keep_separate,
            clean_opt(input.default_scenario),
            next_sort(conn),
            now
        ],
    )
    .map_err(|e| db_err("Couldn't create the workspace", e))?;
    get_workspace(conn, &id)
}

/// Changes the given fields of a workspace. Becoming kept separate ends every
/// borrow that involves it.
pub fn update_workspace(conn: &Connection, id: &str, patch: WorkspacePatch) -> Result<Workspace, String> {
    // The change and the cleanup of what it takes away are one transaction.
    let tx = crate::db::immediate_tx(conn).map_err(|e| db_err("Couldn't save the workspace", e))?;
    let updated = update_workspace_in(&tx, id, patch)?;
    tx.commit().map_err(|e| db_err("Couldn't save the workspace", e))?;
    Ok(updated)
}

fn update_workspace_in(conn: &Connection, id: &str, patch: WorkspacePatch) -> Result<Workspace, String> {
    let mut ws = get_workspace(conn, id)?;
    if let Some(name) = patch.name {
        ws.name = clean_name(&name)?;
    }
    if let Some(icon) = patch.icon {
        ws.icon = clean_opt(icon);
    }
    if let Some(color) = patch.color {
        ws.color = clean_opt(color);
    }
    if let Some(description) = patch.description {
        ws.description = description.trim().to_string();
    }
    if let Some(instructions) = patch.instructions {
        // what the model reads is what the person can see: hidden characters never reach the stored text
        ws.instructions = crate::prompt_data::strip_hidden(&instructions);
    }
    if let Some(scenario) = patch.default_scenario {
        ws.default_scenario = clean_opt(scenario);
    }
    if let Some(pinned) = patch.pinned {
        ws.pinned = pinned;
    }
    if let Some(v) = patch.recaps_with_ai {
        ws.recaps_with_ai = v;
    }
    if let Some(v) = patch.suggest_memory {
        ws.suggest_memory = v;
    }
    if let Some(v) = patch.brief_enabled {
        ws.brief_default = v;
    }
    let was_separate = ws.keep_separate;
    let had_general = ws.include_general;
    let (include_general, keep_separate) = rules::normalize_flags(
        id,
        patch.include_general.unwrap_or(ws.include_general),
        patch.keep_separate.unwrap_or(ws.keep_separate),
    )?;
    ws.include_general = include_general;
    ws.keep_separate = keep_separate;
    // Access narrows when General is switched off or the workspace is kept
    // separate: what the meetings involved derived from it must go too.
    let general_off = had_general && !include_general;
    let narrows = general_off || (keep_separate && !was_separate);
    let before = if narrows {
        let involved = super::derived::meetings_involving(conn, id);
        Some(super::derived::snapshot(conn, &involved)?)
    } else {
        None
    };
    conn.execute(
        "UPDATE workspaces SET name = ?2, icon = ?3, color = ?4, description = ?5, instructions = ?6,
            include_general = ?7, keep_separate = ?8, default_scenario = ?9, pinned = ?10, updated_at = ?11,
            recaps_with_ai = ?12, suggest_memory = ?13, brief_default = ?14
         WHERE id = ?1",
        params![
            id, ws.name, ws.icon, ws.color, ws.description, ws.instructions, ws.include_general,
            ws.keep_separate, ws.default_scenario, ws.pinned, now_ms(), ws.recaps_with_ai, ws.suggest_memory,
            ws.brief_default
        ],
    )
    .map_err(|e| db_err("Couldn't save the workspace", e))?;
    if keep_separate && !was_separate {
        super::meetings::end_borrows_involving(conn, id)?;
    }
    if let Some(before) = before {
        super::derived::prune_after(conn, &before)?;
    }
    if general_off {
        // Its chats' summaries may quote General's material, and their citations
        // of it say it is no longer used.
        super::derived::clear_condensed(conn, id)?;
        let lost = super::derived::material_lost(conn, &[GENERAL_ID.to_string()], &[id.to_string()]);
        crate::workspace_chat::store::redact_material_in_workspace(
            conn,
            id,
            &lost,
            "General is no longer used by this workspace",
        )?;
    }
    get_workspace(conn, id)
}

/// A copy with the same name look, instructions, settings, library items and
/// talking points; not the meetings, chats, memory or secrets.
pub fn clone_workspace(conn: &Connection, id: &str, name: &str, new_id: Option<String>) -> Result<Workspace, String> {
    let source = get_workspace(conn, id)?;
    let tx = crate::db::immediate_tx(conn).map_err(|e| db_err("Couldn't copy the workspace", e))?;
    let copy = create_workspace(
        &tx,
        CreateWorkspaceInput {
            id: new_id,
            name: name.to_string(),
            icon: source.icon.clone(),
            color: source.color.clone(),
            description: source.description.clone(),
            instructions: source.instructions.clone(),
            include_general: source.include_general,
            keep_separate: source.keep_separate,
            default_scenario: source.default_scenario.clone(),
        },
    )?;
    tx.execute(
        "INSERT INTO workspace_items (workspace_id, kind, ref_id, label, pinned, added_at)
         SELECT ?2, kind, ref_id, label, pinned, ?3 FROM workspace_items WHERE workspace_id = ?1",
        params![id, copy.id, now_ms()],
    )
    .map_err(|e| db_err("Couldn't copy the library items", e))?;
    super::talking_points::copy_all(&tx, id, &copy.id)?;
    tx.commit().map_err(|e| db_err("Couldn't copy the workspace", e))?;
    Ok(copy)
}

/// Archives or restores a workspace. General and the default one stay.
pub fn archive_workspace(conn: &Connection, id: &str, archived: bool) -> Result<Workspace, String> {
    let ws = get_workspace(conn, id)?;
    if archived && ws.id == GENERAL_ID {
        return Err("General can't be archived".to_string());
    }
    if archived && ws.is_default {
        return Err("This is the default workspace. Make another one the default first".to_string());
    }
    conn.execute("UPDATE workspaces SET archived = ?2, updated_at = ?3 WHERE id = ?1", params![id, archived, now_ms()])
        .map_err(|e| db_err("Couldn't archive the workspace", e))?;
    get_workspace(conn, id)
}

/// Makes `id` the default workspace (the one the shortcut, tray and detection use).
pub fn set_default_workspace(conn: &Connection, id: &str) -> Result<(), String> {
    let ws = get_workspace(conn, id)?;
    if ws.archived {
        return Err("An archived workspace can't be the default".to_string());
    }
    let tx = crate::db::immediate_tx(conn).map_err(|e| db_err("Couldn't set the default", e))?;
    tx.execute("UPDATE workspaces SET is_default = (id = ?1)", params![id])
        .map_err(|e| db_err("Couldn't set the default", e))?;
    tx.commit().map_err(|e| db_err("Couldn't set the default", e))
}

/// Puts the workspaces in the order of `ids`; any not listed follow in their old order.
pub fn reorder_workspaces(conn: &Connection, ids: &[String]) -> Result<(), String> {
    let tx = crate::db::immediate_tx(conn).map_err(|e| db_err("Couldn't reorder", e))?;
    let mut order: Vec<String> = ids.to_vec();
    let rest: Vec<String> = {
        let mut stmt = tx.prepare("SELECT id FROM workspaces ORDER BY sort, created_at").map_err(|e| db_err("Couldn't reorder", e))?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0)).map_err(|e| db_err("Couldn't reorder", e))?;
        rows.filter_map(Result::ok).filter(|id| !ids.contains(id)).collect()
    };
    order.extend(rest);
    for (index, id) in order.iter().enumerate() {
        tx.execute("UPDATE workspaces SET sort = ?2 WHERE id = ?1", params![id, index as i64])
            .map_err(|e| db_err("Couldn't reorder", e))?;
    }
    tx.commit().map_err(|e| db_err("Couldn't reorder", e))
}

/// What deleting a workspace left to do on disk.
#[derive(Debug, Default)]
pub struct Deleted {
    /// Recording and waveform files of the deleted meetings (delete them
    /// with [`purge::delete_files_inside`] once the commit is done).
    pub files: Vec<PathBuf>,
    pub meetings: usize,
}

/// Deletes a workspace. Its meetings, chats and talking points move to General
/// or are deleted with it; memory goes with it; documents stay in the library.
pub fn delete_workspace(conn: &Connection, id: &str, mode: DeleteMode) -> Result<Deleted, String> {
    let ws = get_workspace(conn, id)?;
    if ws.id == GENERAL_ID {
        return Err("General can't be deleted".to_string());
    }
    if ws.is_default {
        return Err("This is the default workspace. Make another one the default first".to_string());
    }
    let tx = crate::db::immediate_tx(conn).map_err(|e| db_err("Couldn't delete the workspace", e))?;
    let meeting_ids: Vec<String> = {
        let mut stmt = tx.prepare("SELECT id FROM meetings WHERE workspace_id = ?1").map_err(|e| db_err("Couldn't delete", e))?;
        let rows = stmt.query_map(params![id], |row| row.get::<_, String>(0)).map_err(|e| db_err("Couldn't delete", e))?;
        rows.filter_map(Result::ok).collect()
    };
    let mut report = Deleted { meetings: meeting_ids.len(), ..Deleted::default() };
    // Meetings of other workspaces that borrowed this one lose what came from it.
    let borrowers: Vec<String> = super::derived::meetings_involving(&tx, id).into_iter().filter(|m| !meeting_ids.contains(m)).collect();
    let before = super::derived::snapshot(&tx, &borrowers)?;
    match mode {
        DeleteMode::Move => {
            for meeting_id in &meeting_ids {
                super::meetings::move_meeting(&tx, meeting_id, GENERAL_ID)?;
            }
            super::talking_points::move_all(&tx, id, GENERAL_ID)?;
            purge::move_chats(&tx, id, GENERAL_ID)?;
        }
        DeleteMode::Delete => {
            for meeting_id in &meeting_ids {
                report.files.extend(purge::purge_meeting(&tx, meeting_id)?);
            }
            super::talking_points::delete_all(&tx, id)?;
            purge::delete_chats(&tx, id)?;
        }
    }
    purge::delete_workspace_rows(&tx, id)?;
    super::derived::prune_after(&tx, &before)?;
    tx.commit().map_err(|e| db_err("Couldn't delete the workspace", e))?;
    Ok(report)
}

// ── Items ────────────────────────────────────────────────────────────────────

fn read_item(row: &Row<'_>) -> rusqlite::Result<ItemRow> {
    let kind: String = row.get(0)?;
    Ok(ItemRow {
        kind: ItemKind::parse(&kind).unwrap_or(ItemKind::Document),
        ref_id: row.get(1)?,
        label: row.get(2)?,
        pinned: row.get(3)?,
        index_opt_in: row.get(4)?,
        added_at: row.get(5)?,
    })
}

/// The memberships of one workspace, pinned first.
pub fn list_items(conn: &Connection, workspace_id: &str) -> Result<Vec<ItemRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT kind, ref_id, label, pinned, index_opt_in, added_at FROM workspace_items
             WHERE workspace_id = ?1 ORDER BY pinned DESC, added_at, ref_id",
        )
        .map_err(|e| db_err("Couldn't read the items", e))?;
    let rows = stmt.query_map(params![workspace_id], read_item).map_err(|e| db_err("Couldn't read the items", e))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| db_err("Couldn't read the items", e))
}

/// Puts a library item in a workspace (again is fine).
pub fn add_item(conn: &Connection, workspace_id: &str, kind: ItemKind, ref_id: &str, label: Option<&str>) -> Result<(), String> {
    get_workspace(conn, workspace_id)?;
    if ref_id.trim().is_empty() {
        return Err("Nothing to add".to_string());
    }
    if kind == ItemKind::Document {
        let exists: bool = conn
            .query_row("SELECT EXISTS(SELECT 1 FROM context_resources WHERE id = ?1)", params![ref_id], |r| r.get(0))
            .map_err(|e| db_err("Couldn't find the document", e))?;
        if !exists {
            return Err("This document is no longer in the library".to_string());
        }
    }
    conn.execute(
        "INSERT OR IGNORE INTO workspace_items (workspace_id, kind, ref_id, label, pinned, added_at)
         VALUES (?1, ?2, ?3, ?4, 0, ?5)",
        params![workspace_id, kind.as_str(), ref_id, clean_opt(label.map(str::to_string)), now_ms()],
    )
    .map_err(|e| db_err("Couldn't add the item", e))?;
    touch(conn, workspace_id);
    Ok(())
}

/// Changes an item's label or pin.
pub fn update_item(conn: &Connection, workspace_id: &str, kind: ItemKind, ref_id: &str, patch: ItemPatch) -> Result<(), String> {
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM workspace_items WHERE workspace_id = ?1 AND kind = ?2 AND ref_id = ?3)",
            params![workspace_id, kind.as_str(), ref_id],
            |r| r.get(0),
        )
        .map_err(|e| db_err("Couldn't change the item", e))?;
    if !exists {
        // Changing an item never creates it: it may have been removed meanwhile.
        return Err(NOT_FOUND.to_string());
    }
    if let Some(label) = patch.label {
        conn.execute(
            "UPDATE workspace_items SET label = ?4 WHERE workspace_id = ?1 AND kind = ?2 AND ref_id = ?3",
            params![workspace_id, kind.as_str(), ref_id, clean_opt(label)],
        )
        .map_err(|e| db_err("Couldn't change the item", e))?;
    }
    if let Some(pinned) = patch.pinned {
        conn.execute(
            "UPDATE workspace_items SET pinned = ?4 WHERE workspace_id = ?1 AND kind = ?2 AND ref_id = ?3",
            params![workspace_id, kind.as_str(), ref_id, pinned],
        )
        .map_err(|e| db_err("Couldn't change the item", e))?;
    }
    if let Some(opt_in) = patch.index_opt_in {
        conn.execute(
            "UPDATE workspace_items SET index_opt_in = ?4 WHERE workspace_id = ?1 AND kind = ?2 AND ref_id = ?3",
            params![workspace_id, kind.as_str(), ref_id, opt_in],
        )
        .map_err(|e| db_err("Couldn't change the item", e))?;
    }
    touch(conn, workspace_id);
    Ok(())
}

/// Takes an item out of a workspace (it stays in the library).
pub fn remove_item(conn: &Connection, workspace_id: &str, kind: ItemKind, ref_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM workspace_items WHERE workspace_id = ?1 AND kind = ?2 AND ref_id = ?3",
        params![workspace_id, kind.as_str(), ref_id],
    )
    .map_err(|e| db_err("Couldn't remove the item", e))?;
    touch(conn, workspace_id);
    Ok(())
}

/// A library item was removed: it leaves every workspace.
pub fn remove_memberships(conn: &Connection, kind: ItemKind, ref_id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM workspace_items WHERE kind = ?1 AND ref_id = ?2", params![kind.as_str(), ref_id])
        .map(|_| ())
        .map_err(|e| db_err("Couldn't update the workspaces", e))
}

/// Which workspaces point to each library item.
pub fn memberships(conn: &Connection) -> Result<HashMap<(ItemKind, String), Vec<String>>, String> {
    let mut stmt = conn
        .prepare("SELECT kind, ref_id, workspace_id FROM workspace_items ORDER BY added_at")
        .map_err(|e| db_err("Couldn't read the library", e))?;
    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)))
        .map_err(|e| db_err("Couldn't read the library", e))?;
    let mut map: HashMap<(ItemKind, String), Vec<String>> = HashMap::new();
    for row in rows {
        let (kind, ref_id, ws) = row.map_err(|e| db_err("Couldn't read the library", e))?;
        if let Some(kind) = ItemKind::parse(&kind) {
            map.entry((kind, ref_id)).or_default().push(ws);
        }
    }
    Ok(map)
}

/// The workspace was touched (its last activity moves).
pub fn touch(conn: &Connection, workspace_id: &str) {
    let _ = conn.execute("UPDATE workspaces SET updated_at = ?2 WHERE id = ?1", params![workspace_id, now_ms()]);
}

/// A meeting's home workspace, if the meeting exists.
pub fn home_of(conn: &Connection, meeting_id: &str) -> Result<Option<String>, String> {
    conn.query_row("SELECT workspace_id FROM meetings WHERE id = ?1", params![meeting_id], |row| row.get(0))
        .optional()
        .map_err(|e| db_err("Couldn't read the meeting", e))
}

/// The workspaces a meeting borrows now, oldest first.
pub fn borrowed_of(conn: &Connection, meeting_id: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT workspace_id FROM meeting_borrowed WHERE meeting_id = ?1 AND removed_at IS NULL ORDER BY added_at")
        .map_err(|e| db_err("Couldn't read the meeting", e))?;
    let rows = stmt.query_map(params![meeting_id], |row| row.get::<_, String>(0)).map_err(|e| db_err("Couldn't read the meeting", e))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| db_err("Couldn't read the meeting", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::test_support::*;

    fn list_talking_points_count(conn: &Connection, ws: &str) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM talking_points WHERE workspace_id = ?1", params![ws], |r| r.get(0)).unwrap()
    }

    fn input(name: &str) -> CreateWorkspaceInput {
        CreateWorkspaceInput { name: name.into(), ..Default::default() }
    }

    #[test]
    fn instructions_are_stored_without_hidden_characters_when_created_and_when_changed() {
        let conn = memory_db();
        let made = create_workspace(&conn, CreateWorkspaceInput { name: "A".into(), instructions: "Be brief\u{202e}\u{200b}.".into(), ..Default::default() }).unwrap();
        assert_eq!(made.instructions, "Be brief.");
        let persian = "\u{0645}\u{0646}\u{200c}\u{0645}\u{0627}";
        let patch = WorkspacePatch { instructions: Some(format!("Reply in Persian\u{202e}\u{200b}: {persian}")), ..Default::default() };
        let changed = update_workspace(&conn, &made.id, patch).unwrap();
        assert_eq!(changed.instructions, format!("Reply in Persian: {persian}"), "hidden characters out, real writing kept");
        assert_eq!(get_workspace(&conn, &made.id).unwrap().instructions, changed.instructions);
    }

    #[test]
    fn general_is_seeded_the_default_and_listed_with_counts() {
        let conn = memory_db();
        file(&conn, "general", "document", "d1");
        let all = list_summaries(&conn).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, "general");
        assert!(all[0].is_default);
        assert_eq!(all[0].item_count, 1);
        assert_eq!(default_workspace_id(&conn), "general");
    }

    #[test]
    fn a_meeting_asked_for_an_unusable_workspace_is_unfiled_and_never_given_another_ones_material() {
        let conn = memory_db();
        let a = new_ws(&conn, "Old", false, false);
        let home = |id: Option<&str>| home_for_start(&conn, id);
        assert_eq!(home(None), (StartHome::Home("general".into()), None));
        assert_eq!(home(Some("")), (StartHome::Home("general".into()), None));
        assert_eq!(home(Some(&a)), (StartHome::Home(a.clone()), None));
        let (h, notice) = home(Some("nope"));
        assert_eq!(h, StartHome::Unfiled);
        let notice = notice.unwrap();
        assert!(notice.contains("no longer available") && notice.contains("island"), "{notice}");
        archive_workspace(&conn, &a, true).unwrap();
        let (h, notice) = home(Some(&a));
        assert_eq!(h, StartHome::Unfiled);
        assert!(notice.unwrap().contains("\"Old\" is archived"));
    }

    #[test]
    fn an_unreadable_workspace_table_is_unfiled_not_general_and_no_id_still_gives_general() {
        let conn = Connection::open_in_memory().unwrap();
        let (h, notice) = home_for_start(&conn, Some("x"));
        assert_eq!(h, StartHome::Unfiled);
        assert!(notice.unwrap().contains("couldn't be read"));
        assert_eq!(home_for_start(&conn, None), (StartHome::Home("general".into()), None));
    }

    #[test]
    fn with_no_id_an_archived_default_gives_general() {
        let conn = memory_db();
        let a = new_ws(&conn, "Main", false, false);
        set_default_workspace(&conn, &a).unwrap();
        assert_eq!(home_for_start(&conn, None).0, StartHome::Home(a.clone()));
        conn.execute("UPDATE workspaces SET archived = 1 WHERE id = ?1", params![a]).unwrap();
        assert_eq!(home_for_start(&conn, None), (StartHome::Home("general".into()), None));
    }

    #[test]
    fn the_brief_switch_of_a_workspace_is_saved_in_its_patch() {
        let conn = memory_db();
        let a = new_ws(&conn, "A", false, false);
        assert!(!get_workspace(&conn, &a).unwrap().brief_default);
        update_workspace(&conn, &a, WorkspacePatch { brief_enabled: Some(true), ..Default::default() }).unwrap();
        assert!(get_workspace(&conn, &a).unwrap().brief_default);
        update_workspace(&conn, &a, WorkspacePatch { name: Some("B".into()), ..Default::default() }).unwrap();
        assert!(get_workspace(&conn, &a).unwrap().brief_default, "a patch without it leaves it");
    }

    #[test]
    fn a_caller_chosen_id_must_be_an_unused_uuid_v4_and_anything_else_is_refused() {
        let conn = memory_db();
        let id = uuid::Uuid::new_v4().to_string();
        let made = create_workspace(&conn, CreateWorkspaceInput { id: Some(id.clone()), ..input("Mine") }).unwrap();
        assert_eq!(made.id, id);
        for bad in [
            id.clone(),                                      // already used
            "general".to_string(),
            "not-a-uuid".to_string(),
            uuid::Uuid::nil().to_string(),                   // not v4
            "6F1E2D3C-AAAA-4BBB-8CCC-0123456789AB".to_string(), // not the canonical spelling
        ] {
            assert!(create_workspace(&conn, CreateWorkspaceInput { id: Some(bad.clone()), ..input("X") }).is_err(), "{bad}");
        }
        let copy_id = uuid::Uuid::new_v4().to_string();
        assert_eq!(clone_workspace(&conn, &id, "Copy", Some(copy_id.clone())).unwrap().id, copy_id);
        assert!(clone_workspace(&conn, &id, "Again", Some(copy_id)).is_err());
        assert_ne!(create_workspace(&conn, input("Generated")).unwrap().id, id);
    }

    #[test]
    fn a_new_workspace_does_not_use_general_unless_asked_and_never_when_separate() {
        let conn = memory_db();
        let plain = create_workspace(&conn, input("Plain")).unwrap();
        assert!(!plain.include_general);
        let with = create_workspace(&conn, CreateWorkspaceInput { include_general: true, ..input("With") }).unwrap();
        assert!(with.include_general);
        let separate = create_workspace(
            &conn,
            CreateWorkspaceInput { include_general: true, keep_separate: true, ..input("Sep") },
        )
        .unwrap();
        assert!(separate.keep_separate && !separate.include_general);
        assert!(create_workspace(&conn, input("  ")).is_err());
    }

    #[test]
    fn update_changes_given_fields_and_can_clear_a_nullable_one() {
        let conn = memory_db();
        let ws = create_workspace(&conn, CreateWorkspaceInput { color: Some("#aabbcc".into()), ..input("A") }).unwrap();
        let patch: WorkspacePatch = serde_json::from_str(r##"{"name":"B","color":null}"##).unwrap();
        let updated = update_workspace(&conn, &ws.id, patch).unwrap();
        assert_eq!(updated.name, "B");
        assert_eq!(updated.color, None);
        assert!(update_workspace(&conn, "general", WorkspacePatch { keep_separate: Some(true), ..Default::default() }).is_err());
    }

    #[test]
    fn becoming_separate_ends_borrows_and_clears_include_general() {
        let conn = memory_db();
        let a = new_ws(&conn, "A", true, false);
        let b = new_ws(&conn, "B", false, false);
        conn.execute("INSERT INTO meetings (id, title, start_time, workspace_id) VALUES ('m', 't', 'x', ?1)", params![a]).unwrap();
        conn.execute("INSERT INTO meeting_borrowed (meeting_id, workspace_id, added_at) VALUES ('m', ?1, 1)", params![b]).unwrap();
        let updated = update_workspace(&conn, &b, WorkspacePatch { keep_separate: Some(true), ..Default::default() }).unwrap();
        assert!(updated.keep_separate && !updated.include_general);
        assert!(borrowed_of(&conn, "m").unwrap().is_empty());
    }

    #[test]
    fn clone_copies_look_instructions_items_and_points_but_not_meetings_or_memory() {
        let conn = memory_db();
        let a = create_workspace(
            &conn,
            CreateWorkspaceInput { instructions: "be brief".into(), color: Some("#123456".into()), ..input("A") },
        )
        .unwrap();
        file(&conn, &a.id, "document", "doc-a");
        conn.execute("INSERT INTO meetings (id, title, start_time, workspace_id) VALUES ('m', 't', 'x', ?1)", params![a.id]).unwrap();
        conn.execute(
            "INSERT INTO workspace_memory (id, workspace_id, kind, status, created_at, updated_at) VALUES ('x', ?1, 'fact', 'saved', 0, 0)",
            params![a.id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO talking_points (id, workspace_id, title, created_at, updated_at) VALUES ('tp', ?1, 'pt', 0, 0)",
            params![a.id],
        )
        .unwrap();
        let copy = clone_workspace(&conn, &a.id, "A copy", None).unwrap();
        assert_eq!(copy.instructions, "be brief");
        assert_eq!(copy.color.as_deref(), Some("#123456"));
        let summary = get_summary(&conn, &copy.id).unwrap();
        assert_eq!(summary.item_count, 1);
        assert_eq!(summary.meeting_count, 0);
        assert_eq!(list_talking_points_count(&conn, &copy.id), 1);
        let memory: i64 = conn.query_row("SELECT COUNT(*) FROM workspace_memory WHERE workspace_id = ?1", params![copy.id], |r| r.get(0)).unwrap();
        assert_eq!(memory, 0);
    }

    #[test]
    fn general_and_the_default_cannot_be_archived_or_deleted() {
        let conn = memory_db();
        assert!(archive_workspace(&conn, "general", true).is_err());
        assert!(delete_workspace(&conn, "general", DeleteMode::Move).is_err());
        let a = new_ws(&conn, "A", false, false);
        set_default_workspace(&conn, &a).unwrap();
        assert_eq!(default_workspace_id(&conn), a);
        assert!(archive_workspace(&conn, &a, true).is_err());
        assert!(delete_workspace(&conn, &a, DeleteMode::Delete).is_err());
        set_default_workspace(&conn, "general").unwrap();
        archive_workspace(&conn, &a, true).unwrap();
        // An archived workspace is not a home for a new meeting.
        assert_eq!(home_for_start(&conn, Some(&a)).0, StartHome::Unfiled);
    }

    #[test]
    fn reorder_follows_the_given_ids_and_keeps_the_rest_after() {
        let conn = memory_db();
        let a = new_ws(&conn, "A", false, false);
        let b = new_ws(&conn, "B", false, false);
        reorder_workspaces(&conn, &[b.clone(), a.clone()]).unwrap();
        let ids: Vec<String> = list_summaries(&conn).unwrap().into_iter().map(|s| s.id).collect();
        assert_eq!(ids, vec![b, a, "general".to_string()]);
    }

    #[test]
    fn items_add_once_update_and_leave_with_the_library_item() {
        let conn = memory_db();
        let a = new_ws(&conn, "A", false, false);
        conn.execute(
            "INSERT INTO context_resources (id, name, file_type, file_path, loaded_at) VALUES ('d', 'd', 'txt', 'x', 'now')",
            [],
        )
        .unwrap();
        assert_eq!(update_item(&conn, &a, ItemKind::Document, "d", ItemPatch::default()), Err("not_found".to_string()));
        add_item(&conn, &a, ItemKind::Document, "d", Some("Brief")).unwrap();
        add_item(&conn, &a, ItemKind::Document, "d", None).unwrap();
        assert_eq!(list_items(&conn, &a).unwrap().len(), 1);
        assert!(add_item(&conn, &a, ItemKind::Document, "missing", None).is_err());
        update_item(&conn, &a, ItemKind::Document, "d", ItemPatch { pinned: Some(true), index_opt_in: Some(true), ..Default::default() }).unwrap();
        let item = &list_items(&conn, &a).unwrap()[0];
        assert!(item.pinned && item.index_opt_in);
        assert_eq!(item.label.as_deref(), Some("Brief"));
        add_item(&conn, "general", ItemKind::Document, "d", None).unwrap();
        remove_memberships(&conn, ItemKind::Document, "d").unwrap();
        assert!(memberships(&conn).unwrap().is_empty());
    }
}
