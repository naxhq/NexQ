//! Talking points: the user's own formatted notes, their "this meeting only"
//! edits and what was said per meeting. No AI here.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::Value;

use super::scope::EffectiveScope;
use super::store::{get_workspace, now_ms, touch};
use super::types::{PointProgress, PointSaid, TalkingPoint};

const COLUMNS: &str = "id, workspace_id, title, doc_json, markdown, plain_text, in_context, sort, created_at, updated_at";

fn err(what: &str, e: rusqlite::Error) -> String {
    format!("{what}: {e}")
}

fn read_point(row: &Row<'_>) -> rusqlite::Result<TalkingPoint> {
    let doc: String = row.get(3)?;
    Ok(TalkingPoint {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        title: row.get(2)?,
        doc_json: doc,
        markdown: row.get(4)?,
        plain_text: row.get(5)?,
        in_context: row.get(6)?,
        sort: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

/// The plain text of a TipTap document: blocks on their own lines.
pub fn plain_text_of_doc(doc: &Value) -> String {
    fn walk(node: &Value, out: &mut String) {
        let kind = node.get("type").and_then(Value::as_str).unwrap_or("");
        if kind == "text" {
            out.push_str(node.get("text").and_then(Value::as_str).unwrap_or(""));
            return;
        }
        if kind == "hardBreak" {
            out.push('\n');
            return;
        }
        if let Some(children) = node.get("content").and_then(Value::as_array) {
            for child in children {
                walk(child, out);
            }
        }
        if matches!(kind, "paragraph" | "heading" | "listItem" | "codeBlock" | "blockquote") && !out.ends_with('\n') {
            out.push('\n');
        }
    }
    let mut out = String::new();
    walk(doc, &mut out);
    let lines: Vec<&str> = out.lines().map(str::trim_end).collect();
    lines.join("\n").trim().to_string()
}

/// The talking points of a workspace in the user's order.
pub fn list_talking_points(conn: &Connection, workspace_id: &str) -> Result<Vec<TalkingPoint>, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT {COLUMNS} FROM talking_points WHERE workspace_id = ?1 ORDER BY sort, created_at"))
        .map_err(|e| err("Couldn't read the talking points", e))?;
    let rows = stmt.query_map(params![workspace_id], read_point).map_err(|e| err("Couldn't read the talking points", e))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| err("Couldn't read the talking points", e))
}

/// One talking point.
pub fn get_talking_point(conn: &Connection, id: &str) -> Result<Option<TalkingPoint>, String> {
    conn.query_row(&format!("SELECT {COLUMNS} FROM talking_points WHERE id = ?1"), params![id], read_point)
        .optional()
        .map_err(|e| err("Couldn't read the talking point", e))
}

/// Saves a talking point: one whose id is stored is changed, any other is
/// added (under its id, or a new one when empty). The plain text is derived
/// from the document when the caller sent none.
pub fn save_talking_point(conn: &Connection, input: TalkingPoint) -> Result<TalkingPoint, String> {
    get_workspace(conn, &input.workspace_id)?;
    let plain = if input.plain_text.trim().is_empty() {
        serde_json::from_str::<Value>(&input.doc_json).map(|d| plain_text_of_doc(&d)).unwrap_or_default()
    } else {
        input.plain_text.clone()
    };
    let doc = if input.doc_json.trim().is_empty() { "{}".to_string() } else { input.doc_json.clone() };
    let now = now_ms();
    let id = if !input.id.is_empty() && get_talking_point(conn, &input.id)?.is_some() {
        conn.execute(
            "UPDATE talking_points SET title = ?2, doc_json = ?3, markdown = ?4, plain_text = ?5,
                in_context = ?6, updated_at = ?7 WHERE id = ?1",
            params![input.id, input.title, doc, input.markdown, plain, input.in_context, now],
        )
        .map_err(|e| err("Couldn't save the talking point", e))?;
        input.id
    } else {
        let id = if input.id.is_empty() { uuid::Uuid::new_v4().to_string() } else { input.id };
        let sort: i64 = conn
            .query_row("SELECT COALESCE(MAX(sort), 0) + 1 FROM talking_points WHERE workspace_id = ?1", params![input.workspace_id], |r| r.get(0))
            .unwrap_or(1);
        conn.execute(
            "INSERT INTO talking_points (id, workspace_id, title, doc_json, markdown, plain_text, in_context, sort, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
            params![id, input.workspace_id, input.title, doc, input.markdown, plain, input.in_context, sort, now],
        )
        .map_err(|e| err("Couldn't save the talking point", e))?;
        id
    };
    touch(conn, &input.workspace_id);
    get_talking_point(conn, &id)?.ok_or_else(|| "The talking point was not saved".to_string())
}

/// Deletes a talking point with its per-meeting edits and progress.
pub fn delete_talking_point(conn: &Connection, id: &str) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| err("Couldn't delete", e))?;
    for sql in [
        "DELETE FROM talking_point_edits WHERE point_id = ?1",
        "DELETE FROM talking_point_progress WHERE point_id = ?1",
        "DELETE FROM talking_points WHERE id = ?1",
    ] {
        tx.execute(sql, params![id]).map_err(|e| err("Couldn't delete the talking point", e))?;
    }
    tx.commit().map_err(|e| err("Couldn't delete the talking point", e))
}

/// A copy of a point in another workspace (or the same one).
pub fn copy_talking_point(conn: &Connection, id: &str, workspace_id: &str) -> Result<TalkingPoint, String> {
    let source = get_talking_point(conn, id)?.ok_or_else(|| "This talking point no longer exists".to_string())?;
    save_talking_point(conn, TalkingPoint { id: String::new(), workspace_id: workspace_id.to_string(), ..source })
}

/// Puts a workspace's points in the order of `ids`.
pub fn reorder_talking_points(conn: &Connection, workspace_id: &str, ids: &[String]) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| err("Couldn't reorder", e))?;
    let mut order = ids.to_vec();
    for point in list_talking_points(&tx, workspace_id)? {
        if !order.contains(&point.id) {
            order.push(point.id);
        }
    }
    for (index, id) in order.iter().enumerate() {
        tx.execute("UPDATE talking_points SET sort = ?3 WHERE id = ?1 AND workspace_id = ?2", params![id, workspace_id, index as i64])
            .map_err(|e| err("Couldn't reorder", e))?;
    }
    tx.commit().map_err(|e| err("Couldn't reorder", e))
}

/// Copies every point of `from` into `to` (cloning a workspace).
pub fn copy_all(conn: &Connection, from: &str, to: &str) -> Result<(), String> {
    for point in list_talking_points(conn, from)? {
        copy_talking_point(conn, &point.id, to)?;
    }
    Ok(())
}

/// Moves every point of `from` to `to` (deleting a workspace with "move").
pub fn move_all(conn: &Connection, from: &str, to: &str) -> Result<(), String> {
    conn.execute("UPDATE talking_points SET workspace_id = ?2 WHERE workspace_id = ?1", params![from, to])
        .map(|_| ())
        .map_err(|e| err("Couldn't move the talking points", e))
}

/// Deletes every point of a workspace with its edits and progress.
pub fn delete_all(conn: &Connection, workspace_id: &str) -> Result<(), String> {
    for sql in [
        "DELETE FROM talking_point_edits WHERE point_id IN (SELECT id FROM talking_points WHERE workspace_id = ?1)",
        "DELETE FROM talking_point_progress WHERE point_id IN (SELECT id FROM talking_points WHERE workspace_id = ?1)",
        "DELETE FROM talking_points WHERE workspace_id = ?1",
    ] {
        conn.execute(sql, params![workspace_id]).map_err(|e| err("Couldn't delete the talking points", e))?;
    }
    Ok(())
}

// ── Per meeting ──────────────────────────────────────────────────────────────

/// What was said of a point in a meeting; None when nothing was saved.
pub fn get_point_progress(conn: &Connection, meeting_id: &str, point_id: &str) -> Result<Option<PointProgress>, String> {
    let said: Option<String> = conn
        .query_row(
            "SELECT said_json FROM talking_point_progress WHERE meeting_id = ?1 AND point_id = ?2",
            params![meeting_id, point_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| err("Couldn't read the progress", e))?;
    Ok(said.map(|text| PointProgress {
        meeting_id: meeting_id.to_string(),
        point_id: point_id.to_string(),
        said: serde_json::from_str(&text).unwrap_or_default(),
    }))
}

/// Saves what was said of a point in a meeting.
pub fn save_point_progress(conn: &Connection, meeting_id: &str, point_id: &str, said: &[PointSaid]) -> Result<(), String> {
    let text = serde_json::to_string(said).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO talking_point_progress (meeting_id, point_id, said_json) VALUES (?1, ?2, ?3)
         ON CONFLICT(meeting_id, point_id) DO UPDATE SET said_json = excluded.said_json",
        params![meeting_id, point_id, text],
    )
    .map(|_| ())
    .map_err(|e| err("Couldn't save the progress", e))
}

/// The "this meeting only" version of a point (TipTap JSON text), if the user made one.
pub fn get_meeting_point_edit(conn: &Connection, meeting_id: &str, point_id: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT doc_json FROM talking_point_edits WHERE meeting_id = ?1 AND point_id = ?2",
        params![meeting_id, point_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(|e| err("Couldn't read the edit", e))
}

/// Saves the "this meeting only" version of a point; `None` goes back to the saved one.
pub fn save_meeting_point_edit(conn: &Connection, meeting_id: &str, point_id: &str, doc: Option<&str>) -> Result<(), String> {
    match doc {
        Some(doc) => conn.execute(
            "INSERT INTO talking_point_edits (meeting_id, point_id, doc_json) VALUES (?1, ?2, ?3)
             ON CONFLICT(meeting_id, point_id) DO UPDATE SET doc_json = excluded.doc_json",
            params![meeting_id, point_id, doc],
        ),
        None => conn.execute(
            "DELETE FROM talking_point_edits WHERE meeting_id = ?1 AND point_id = ?2",
            params![meeting_id, point_id],
        ),
    }
    .map(|_| ())
    .map_err(|e| err("Couldn't save the edit", e))
}

/// A talking point as the AI gets it: its title and plain text.
#[derive(Debug, Clone, PartialEq)]
pub struct PointText {
    pub title: String,
    pub text: String,
}

/// The plain text of the scope's context-flagged talking points, using the
/// meeting's own edit of a point where there is one.
pub fn context_texts(conn: &Connection, meeting_id: Option<&str>, scope: &EffectiveScope) -> Result<Vec<PointText>, String> {
    let mut out = Vec::new();
    for id in &scope.talking_point_ids {
        let Some(point) = get_talking_point(conn, id)? else { continue };
        let edited = match meeting_id {
            Some(m) => get_meeting_point_edit(conn, m, id)?
                .and_then(|doc| serde_json::from_str::<Value>(&doc).ok())
                .map(|doc| plain_text_of_doc(&doc)),
            None => None,
        };
        let text = edited.unwrap_or(point.plain_text);
        if !text.trim().is_empty() {
            out.push(PointText { title: point.title, text });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::test_support::*;
    use serde_json::json;

    fn doc(text: &str) -> Value {
        json!({"type":"doc","content":[
            {"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Plan"}]},
            {"type":"paragraph","content":[{"type":"text","text":text},{"type":"text","marks":[{"type":"bold"}],"text":" now"}]},
            {"type":"bulletList","content":[
                {"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"one"}]}]},
                {"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"two"}]}]}]}]})
    }

    fn input(ws: &str, title: &str, text: &str, ctx: bool) -> TalkingPoint {
        TalkingPoint {
            id: String::new(),
            workspace_id: ws.into(),
            title: title.into(),
            doc_json: doc(text).to_string(),
            markdown: format!("# Plan\n{text}"),
            plain_text: String::new(),
            in_context: ctx,
            sort: 0,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn plain_text_keeps_blocks_on_their_own_lines() {
        assert_eq!(plain_text_of_doc(&doc("Ship it")), "Plan\nShip it now\none\ntwo");
        assert_eq!(plain_text_of_doc(&Value::Null), "");
    }

    #[test]
    fn points_save_update_order_copy_and_delete_with_their_meeting_data() {
        let conn = memory_db();
        let a = new_ws(&conn, "A", false, false);
        let p1 = save_talking_point(&conn, input(&a, "First", "alpha", true)).unwrap();
        let p2 = save_talking_point(&conn, input(&a, "Second", "beta", false)).unwrap();
        assert!(p1.sort < p2.sort);
        assert_eq!(p1.plain_text, "Plan\nalpha now\none\ntwo");
        let edited = save_talking_point(&conn, TalkingPoint { id: p1.id.clone(), ..input(&a, "First!", "gamma", true) }).unwrap();
        assert_eq!(edited.title, "First!");
        assert_eq!(list_talking_points(&conn, &a).unwrap().len(), 2);
        reorder_talking_points(&conn, &a, &[p2.id.clone(), p1.id.clone()]).unwrap();
        assert_eq!(list_talking_points(&conn, &a).unwrap()[0].id, p2.id);

        let said = |id: &str| PointSaid { block_id: id.into(), by: "voice".into(), ticked: true };
        save_point_progress(&conn, "m", &p1.id, &[said("b1")]).unwrap();
        save_point_progress(&conn, "m", &p1.id, &[said("b1"), said("b2")]).unwrap();
        assert_eq!(get_point_progress(&conn, "m", &p1.id).unwrap().unwrap().said.len(), 2);
        assert!(get_point_progress(&conn, "m", "none").unwrap().is_none());
        save_meeting_point_edit(&conn, "m", &p1.id, Some(&doc("only here").to_string())).unwrap();
        assert!(get_meeting_point_edit(&conn, "m", &p1.id).unwrap().is_some());

        let copy = copy_talking_point(&conn, &p1.id, "general").unwrap();
        assert_ne!(copy.id, p1.id);
        assert_eq!(copy.workspace_id, "general");

        delete_talking_point(&conn, &p1.id).unwrap();
        assert!(get_point_progress(&conn, "m", &p1.id).unwrap().is_none());
        assert!(get_meeting_point_edit(&conn, "m", &p1.id).unwrap().is_none());
        assert!(get_talking_point(&conn, &p1.id).unwrap().is_none());
    }

    #[test]
    fn the_context_text_uses_only_flagged_points_of_the_scope_and_the_meetings_own_edit() {
        let conn = memory_db();
        let a = new_ws(&conn, "A", false, false);
        let b = new_ws(&conn, "B", false, false);
        let flagged = save_talking_point(&conn, input(&a, "Flagged", "CANARY_FLAGGED", true)).unwrap();
        save_talking_point(&conn, input(&a, "Hidden", "CANARY_NOT_CONTEXT", false)).unwrap();
        save_talking_point(&conn, input(&b, "Other", "CANARY_OTHER_WORKSPACE", true)).unwrap();
        let scope = crate::workspace::scope::scope_for_home(&conn, &a, &[]).unwrap();
        let texts = context_texts(&conn, None, &scope).unwrap();
        assert_eq!(texts.len(), 1);
        assert!(texts[0].text.contains("CANARY_FLAGGED"));
        let joined: String = texts.iter().map(|t| t.text.clone()).collect();
        assert!(!joined.contains("CANARY_NOT_CONTEXT") && !joined.contains("CANARY_OTHER_WORKSPACE"));
        // This meeting only: its own version replaces the saved one.
        save_meeting_point_edit(&conn, "m", &flagged.id, Some(&doc("CANARY_MEETING_EDIT").to_string())).unwrap();
        let texts = context_texts(&conn, Some("m"), &scope).unwrap();
        assert!(texts[0].text.contains("CANARY_MEETING_EDIT") && !texts[0].text.contains("CANARY_FLAGGED"));
        // And the edit is gone when cleared.
        save_meeting_point_edit(&conn, "m", &flagged.id, None).unwrap();
        assert!(context_texts(&conn, Some("m"), &scope).unwrap()[0].text.contains("CANARY_FLAGGED"));
    }
}
