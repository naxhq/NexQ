//! Workspace memory: facts the user approved for a workspace. Suggestions
//! are only proposals until saved. Memory is data, never instructions, and
//! reaches another workspace only through the scope (borrowed or General).

use rusqlite::{params, Connection, OptionalExtension, Row};

use super::scope::EffectiveScope;
use super::store::{get_workspace, now_ms, touch};
use super::types::{MemoryItem, MemoryPatch, MEMORY_KINDS, MEMORY_STATUSES};

const COLUMNS: &str = "id, workspace_id, kind, title, text, source_meeting, source_ms, status, created_at, updated_at";

fn err(what: &str, e: rusqlite::Error) -> String {
    format!("{what}: {e}")
}

fn read_item(row: &Row<'_>) -> rusqlite::Result<MemoryItem> {
    Ok(MemoryItem {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        kind: row.get(2)?,
        title: row.get(3)?,
        text: row.get(4)?,
        source_meeting: row.get(5)?,
        source_ms: row.get(6)?,
        status: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn check_kind(kind: &str) -> Result<(), String> {
    if MEMORY_KINDS.contains(&kind) { Ok(()) } else { Err(format!("Unknown memory kind: {kind}")) }
}

fn check_status(status: &str) -> Result<(), String> {
    if MEMORY_STATUSES.contains(&status) { Ok(()) } else { Err(format!("Unknown memory status: {status}")) }
}

/// One item.
pub fn get_memory(conn: &Connection, id: &str) -> Result<Option<MemoryItem>, String> {
    conn.query_row(&format!("SELECT {COLUMNS} FROM workspace_memory WHERE id = ?1"), params![id], read_item)
        .optional()
        .map_err(|e| err("Couldn't read the memory", e))
}

/// The saved and suggested items of a workspace, newest first (dismissed ones stay hidden).
pub fn list_memory(conn: &Connection, workspace_id: &str) -> Result<Vec<MemoryItem>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {COLUMNS} FROM workspace_memory
             WHERE workspace_id = ?1 AND status != 'dismissed' ORDER BY updated_at DESC, id"
        ))
        .map_err(|e| err("Couldn't read the memory", e))?;
    let rows = stmt.query_map(params![workspace_id], read_item).map_err(|e| err("Couldn't read the memory", e))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| err("Couldn't read the memory", e))
}

/// Saves an item: one whose id is already stored is changed, any other is
/// added (under the given id, or a new one when it is empty). The times are the
/// database's own.
pub fn save_memory(conn: &Connection, input: MemoryItem) -> Result<MemoryItem, String> {
    get_workspace(conn, &input.workspace_id)?;
    check_kind(&input.kind)?;
    check_status(&input.status)?;
    if input.text.trim().is_empty() && input.title.trim().is_empty() {
        return Err("Write what to remember".to_string());
    }
    let now = now_ms();
    let id = if !input.id.is_empty() && get_memory(conn, &input.id)?.is_some() {
        conn.execute(
            "UPDATE workspace_memory SET kind = ?2, title = ?3, text = ?4, status = ?5, updated_at = ?6 WHERE id = ?1",
            params![input.id, input.kind, input.title.trim(), input.text.trim(), input.status, now],
        )
        .map_err(|e| err("Couldn't save the memory", e))?;
        input.id
    } else {
        let id = if input.id.is_empty() { uuid::Uuid::new_v4().to_string() } else { input.id };
        conn.execute(
            "INSERT INTO workspace_memory (id, workspace_id, kind, title, text, source_meeting, source_ms, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
            params![id, input.workspace_id, input.kind, input.title.trim(), input.text.trim(), input.source_meeting, input.source_ms, input.status, now],
        )
        .map_err(|e| err("Couldn't save the memory", e))?;
        id
    };
    touch(conn, &input.workspace_id);
    get_memory(conn, &id)?.ok_or_else(|| "The memory was not saved".to_string())
}

/// Forgets an item.
pub fn delete_memory(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM workspace_memory WHERE id = ?1", params![id])
        .map(|_| ())
        .map_err(|e| err("Couldn't forget the memory", e))
}

/// Approves (`save`) or dismisses a suggestion, with the user's edits.
pub fn resolve_memory(conn: &Connection, id: &str, action: &str, patch: Option<MemoryPatch>) -> Result<MemoryItem, String> {
    let mut item = get_memory(conn, id)?.ok_or_else(|| "This memory no longer exists".to_string())?;
    let status = match action {
        "save" => "saved",
        "dismiss" => "dismissed",
        other => return Err(format!("Unknown memory action: {other}")),
    };
    if let Some(patch) = patch {
        if let Some(kind) = patch.kind {
            check_kind(&kind)?;
            item.kind = kind;
        }
        if let Some(title) = patch.title {
            item.title = title.trim().to_string();
        }
        if let Some(text) = patch.text {
            item.text = text.trim().to_string();
        }
    }
    conn.execute(
        "UPDATE workspace_memory SET kind = ?2, title = ?3, text = ?4, status = ?5, updated_at = ?6 WHERE id = ?1",
        params![id, item.kind, item.title, item.text, status, now_ms()],
    )
    .map_err(|e| err("Couldn't update the memory", e))?;
    touch(conn, &item.workspace_id);
    get_memory(conn, id)?.ok_or_else(|| "The memory was not saved".to_string())
}

/// The saved memory of every workspace in the scope, home first.
pub fn saved_for_scope(conn: &Connection, scope: &EffectiveScope) -> Result<Vec<MemoryItem>, String> {
    let ids = serde_json::to_string(&scope.material_workspaces).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {COLUMNS} FROM workspace_memory
             WHERE status = 'saved' AND workspace_id IN (SELECT value FROM json_each(?1))
             ORDER BY updated_at DESC, id"
        ))
        .map_err(|e| err("Couldn't read the memory", e))?;
    let rows = stmt.query_map(params![ids], read_item).map_err(|e| err("Couldn't read the memory", e))?;
    let mut items = rows.collect::<Result<Vec<_>, _>>().map_err(|e| err("Couldn't read the memory", e))?;
    items.sort_by_key(|i| i.workspace_id != scope.home);
    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::test_support::*;

    fn input(ws: &str, text: &str) -> MemoryItem {
        MemoryItem {
            id: String::new(),
            created_at: 0,
            updated_at: 0,
            workspace_id: ws.into(),
            kind: "fact".into(),
            title: "t".into(),
            text: text.into(),
            source_meeting: None,
            source_ms: None,
            status: "saved".into(),
        }
    }

    #[test]
    fn memory_is_saved_edited_resolved_and_forgotten() {
        let conn = memory_db();
        let a = new_ws(&conn, "A", false, false);
        let saved = save_memory(&conn, input(&a, "Erin owns billing")).unwrap();
        assert_eq!(saved.status, "saved");
        let suggested = save_memory(&conn, MemoryItem { status: "suggested".into(), ..input(&a, "Launch is May") }).unwrap();
        assert_eq!(list_memory(&conn, &a).unwrap().len(), 2);
        let approved = resolve_memory(
            &conn,
            &suggested.id,
            "save",
            Some(MemoryPatch { text: Some("Launch is in May".into()), kind: Some("decision".into()), ..Default::default() }),
        )
        .unwrap();
        assert_eq!((approved.status.as_str(), approved.kind.as_str(), approved.text.as_str()), ("saved", "decision", "Launch is in May"));
        resolve_memory(&conn, &saved.id, "dismiss", None).unwrap();
        assert_eq!(list_memory(&conn, &a).unwrap().len(), 1);
        assert!(save_memory(&conn, MemoryItem { kind: "nonsense".into(), ..input(&a, "x") }).is_err());
        assert!(save_memory(&conn, MemoryItem { title: String::new(), ..input(&a, "  ") }).is_err());
        delete_memory(&conn, &approved.id).unwrap();
        assert!(list_memory(&conn, &a).unwrap().is_empty());
    }

    #[test]
    fn saved_memory_reaches_only_the_scope() {
        let conn = memory_db();
        let a = new_ws(&conn, "A", false, false);
        let b = new_ws(&conn, "B", false, false);
        save_memory(&conn, input(&a, "CANARY_MEMORY_A")).unwrap();
        save_memory(&conn, input(&b, "CANARY_MEMORY_B")).unwrap();
        save_memory(&conn, MemoryItem { status: "suggested".into(), ..input(&a, "CANARY_SUGGESTED") }).unwrap();
        let alone = crate::workspace::scope::scope_for_home(&conn, &a, &[]).unwrap();
        let texts: Vec<String> = saved_for_scope(&conn, &alone).unwrap().into_iter().map(|m| m.text).collect();
        assert_eq!(texts, vec!["CANARY_MEMORY_A"]);
        let borrowing = crate::workspace::scope::scope_for_home(&conn, &a, &[b]).unwrap();
        assert_eq!(saved_for_scope(&conn, &borrowing).unwrap().len(), 2);
    }
}
