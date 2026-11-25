//! Talking points: the user's own formatted notes, their "this meeting only"
//! edits and what was said per meeting. No AI here.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::Value;

use super::scope::EffectiveScope;
use super::store::{get_workspace, now_ms, touch};
use super::types::{
    PointProgress, PointSaid, TalkingContent, TalkingPoint, TalkingPointPatch, CONFLICT, NOT_FOUND,
};

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

fn plain_from(doc_json: &str) -> String {
    serde_json::from_str::<Value>(doc_json).map(|d| plain_text_of_doc(&d)).unwrap_or_default()
}

/// Hidden characters out of a text (and nothing else: the writing is stored as written).
fn clean_text(text: &str) -> String {
    crate::prompt_data::strip_hidden(text)
}

fn strip_value(v: &mut Value, changed: &mut bool) {
    match v {
        Value::String(s) => {
            let clean = clean_text(s);
            if clean != *s {
                *s = clean;
                *changed = true;
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|x| strip_value(x, changed)),
        Value::Object(map) => map.iter_mut().for_each(|(_, x)| strip_value(x, changed)),
        _ => {}
    }
}

/// The document with hidden characters taken out of its text; a document that has none is returned as it is.
fn clean_doc(doc: &str) -> String {
    match serde_json::from_str::<Value>(doc) {
        Ok(mut value) => {
            let mut changed = false;
            strip_value(&mut value, &mut changed);
            if changed { value.to_string() } else { doc.to_string() }
        }
        Err(_) => clean_text(doc),
    }
}

fn insert_point(
    conn: &Connection,
    workspace_id: &str,
    title: &str,
    doc_json: &str,
    markdown: &str,
    plain_text: &str,
    in_context: bool,
) -> Result<TalkingPoint, String> {
    get_workspace(conn, workspace_id)?;
    let (title, doc_json, markdown, plain_text) = (clean_text(title), clean_doc(doc_json), clean_text(markdown), clean_text(plain_text));
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();
    let sort: i64 = conn
        .query_row("SELECT COALESCE(MAX(sort), 0) + 1 FROM talking_points WHERE workspace_id = ?1", params![workspace_id], |r| r.get(0))
        .unwrap_or(1);
    conn.execute(
        "INSERT INTO talking_points (id, workspace_id, title, doc_json, markdown, plain_text, in_context, sort, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        params![id, workspace_id, title, doc_json, markdown, plain_text, in_context, sort, now],
    )
    .map_err(|e| err("Couldn't create the talking point", e))?;
    touch(conn, workspace_id);
    get_talking_point(conn, &id)?.ok_or_else(|| "The talking point was not saved".to_string())
}

/// Creates a talking point with a new id, its content and "use as AI context"
/// in one insert. The plain text is read from the document when not given.
pub fn create_talking_point(
    conn: &Connection,
    workspace_id: &str,
    title: Option<String>,
    content: TalkingContent,
) -> Result<TalkingPoint, String> {
    let doc = content.doc_json.filter(|d| !d.trim().is_empty()).unwrap_or_else(|| "{}".to_string());
    let plain = content.plain_text.unwrap_or_else(|| plain_from(&doc));
    insert_point(
        conn,
        workspace_id,
        title.as_deref().unwrap_or(""),
        &doc,
        content.markdown.as_deref().unwrap_or(""),
        &plain,
        content.in_context,
    )
}

/// Changes the fields present in `patch` of a point that exists. A missing
/// (or deleted) id fails with `not_found`: a late save never brings it back. A
/// change of the content (title, document, Markdown, plain text) made on a
/// version older than `expected_updated_at` fails with `conflict` (read the
/// current row with `get_talking_point`). `in_context` changes only when
/// present, and never conflicts.
pub fn patch_talking_point(
    conn: &Connection,
    id: &str,
    patch: TalkingPointPatch,
    expected_updated_at: Option<i64>,
) -> Result<TalkingPoint, String> {
    let point = get_talking_point(conn, id)?.ok_or_else(|| NOT_FOUND.to_string())?;
    let content_changes = patch.title.is_some()
        || patch.doc_json.is_some()
        || patch.markdown.is_some()
        || patch.plain_text.is_some();
    if content_changes && expected_updated_at.is_some_and(|at| at != point.updated_at) {
        return Err(CONFLICT.to_string());
    }
    let doc = patch.doc_json.clone().filter(|d| !d.trim().is_empty()).unwrap_or(point.doc_json.clone());
    let plain = match (&patch.plain_text, &patch.doc_json) {
        (Some(p), _) => p.clone(),
        (None, Some(_)) => plain_from(&doc),
        (None, None) => point.plain_text.clone(),
    };
    conn.execute(
        "UPDATE talking_points SET title = ?2, doc_json = ?3, markdown = ?4, plain_text = ?5, in_context = ?6, updated_at = ?7
         WHERE id = ?1",
        params![
            id,
            clean_text(patch.title.as_deref().unwrap_or(&point.title)),
            clean_doc(&doc),
            clean_text(patch.markdown.as_deref().unwrap_or(&point.markdown)),
            clean_text(&plain),
            patch.in_context.unwrap_or(point.in_context),
            // The version only moves with the content: a context toggle must not
            // make a save made on the old version look stale.
            if content_changes { now_ms().max(point.updated_at + 1) } else { point.updated_at }
        ],
    )
    .map_err(|e| err("Couldn't save the talking point", e))?;
    touch(conn, &point.workspace_id);
    get_talking_point(conn, id)?.ok_or_else(|| NOT_FOUND.to_string())
}

/// Deletes a talking point with its per-meeting edits and progress.
pub fn delete_talking_point(conn: &Connection, id: &str) -> Result<(), String> {
    let tx = crate::db::immediate_tx(conn).map_err(|e| err("Couldn't delete", e))?;
    for sql in [
        "DELETE FROM talking_point_edits WHERE point_id = ?1",
        "DELETE FROM talking_point_progress WHERE point_id = ?1",
        "DELETE FROM talking_points WHERE id = ?1",
    ] {
        tx.execute(sql, params![id]).map_err(|e| err("Couldn't delete the talking point", e))?;
    }
    super::purge::purge_search_rows(&tx, "talking_point", id)?;
    tx.commit().map_err(|e| err("Couldn't delete the talking point", e))
}

/// A copy of a point in another workspace (or the same one).
pub fn copy_talking_point(conn: &Connection, id: &str, workspace_id: &str) -> Result<TalkingPoint, String> {
    let source = get_talking_point(conn, id)?.ok_or_else(|| "This talking point no longer exists".to_string())?;
    insert_point(conn, workspace_id, &source.title, &source.doc_json, &source.markdown, &source.plain_text, source.in_context)
}

/// Puts a workspace's points in the order of `ids`.
pub fn reorder_talking_points(conn: &Connection, workspace_id: &str, ids: &[String]) -> Result<(), String> {
    let tx = crate::db::immediate_tx(conn).map_err(|e| err("Couldn't reorder", e))?;
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
    for point in list_talking_points(conn, workspace_id)? {
        super::purge::purge_search_rows(conn, "talking_point", &point.id)?;
    }
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

    fn make(conn: &Connection, ws: &str, title: &str, text: &str, ctx: bool) -> TalkingPoint {
        create_talking_point(
            conn,
            ws,
            Some(title.to_string()),
            TalkingContent {
                doc_json: Some(doc(text).to_string()),
                markdown: Some(format!("# Plan\n{text}")),
                plain_text: None,
                in_context: ctx,
            },
        )
        .unwrap()
    }

    fn blank_content(ctx: bool) -> TalkingContent {
        TalkingContent { doc_json: None, markdown: None, plain_text: None, in_context: ctx }
    }

    #[test]
    fn plain_text_keeps_blocks_on_their_own_lines() {
        assert_eq!(plain_text_of_doc(&doc("Ship it")), "Plan\nShip it now\none\ntwo");
        assert_eq!(plain_text_of_doc(&Value::Null), "");
    }

    #[test]
    fn points_are_created_patched_ordered_copied_and_deleted_with_their_meeting_data() {
        let conn = memory_db();
        let a = new_ws(&conn, "A", false, false);
        let p1 = make(&conn, &a, "First", "alpha", true);
        let p2 = make(&conn, &a, "Second", "beta", false);
        assert!(p1.sort < p2.sort);
        assert_eq!(p1.plain_text, "Plan\nalpha now\none\ntwo");
        let blank = create_talking_point(&conn, &a, None, blank_content(false)).unwrap();
        assert!(!blank.in_context && blank.title.is_empty());
        let edited = patch_talking_point(
            &conn,
            &p1.id,
            TalkingPointPatch { title: Some("First!".into()), doc_json: Some(doc("gamma").to_string()), ..Default::default() },
            Some(p1.updated_at),
        )
        .unwrap();
        assert_eq!((edited.title.as_str(), edited.in_context), ("First!", true));
        assert!(edited.plain_text.contains("gamma"), "plain text follows the document");
        assert!(edited.updated_at > p1.updated_at);
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
    fn creating_needs_in_context_and_a_copy_carries_the_sources_value_in_its_insert() {
        // in_context is required by the shape: a request without it does not parse.
        assert!(serde_json::from_str::<TalkingContent>(r#"{"doc_json":"{}"}"#).is_err());
        assert!(serde_json::from_str::<TalkingContent>(r#"{"in_context":false}"#).is_ok());
        let conn = memory_db();
        let a = new_ws(&conn, "A", false, false);
        let off = make(&conn, &a, "Off", "text", false);
        let copy = copy_talking_point(&conn, &off.id, "general").unwrap();
        assert!(!copy.in_context, "never on first and then off");
        let on = make(&conn, &a, "On", "text", true);
        assert!(copy_talking_point(&conn, &on.id, "general").unwrap().in_context);
    }

    #[test]
    fn a_late_save_of_a_deleted_point_fails_and_does_not_bring_it_back() {
        let conn = memory_db();
        let a = new_ws(&conn, "A", false, false);
        let point = make(&conn, &a, "Gone", "text", true);
        delete_talking_point(&conn, &point.id).unwrap();
        let late = patch_talking_point(&conn, &point.id, TalkingPointPatch { title: Some("x".into()), ..Default::default() }, None);
        assert_eq!(late, Err("not_found".to_string()));
        assert!(get_talking_point(&conn, &point.id).unwrap().is_none());
        assert_eq!(patch_talking_point(&conn, "never-existed", TalkingPointPatch::default(), None), Err("not_found".to_string()));
    }

    #[test]
    fn a_content_change_on_an_old_version_conflicts_but_a_context_toggle_does_not() {
        let conn = memory_db();
        let a = new_ws(&conn, "A", false, false);
        let point = make(&conn, &a, "T", "text", true);
        let newer = patch_talking_point(&conn, &point.id, TalkingPointPatch { markdown: Some("v2".into()), ..Default::default() }, Some(point.updated_at)).unwrap();
        // A second writer still holding the first version.
        let stale = patch_talking_point(&conn, &point.id, TalkingPointPatch { markdown: Some("v3".into()), ..Default::default() }, Some(point.updated_at));
        assert_eq!(stale, Err("conflict".to_string()));
        assert_eq!(get_talking_point(&conn, &point.id).unwrap().unwrap().markdown, "v2");
        // in_context changes only when present, never conflicts, and leaves the version.
        let toggled = patch_talking_point(&conn, &point.id, TalkingPointPatch { in_context: Some(false), ..Default::default() }, Some(point.updated_at)).unwrap();
        assert!(!toggled.in_context);
        assert_eq!((toggled.markdown.as_str(), toggled.updated_at), ("v2", newer.updated_at));
        // A patch without in_context leaves it alone.
        let kept = patch_talking_point(&conn, &point.id, TalkingPointPatch { title: Some("n".into()), ..Default::default() }, Some(newer.updated_at)).unwrap();
        assert!(!kept.in_context);
    }

    #[test]
    fn the_context_text_uses_only_flagged_points_of_the_scope_and_the_meetings_own_edit() {
        let conn = memory_db();
        let a = new_ws(&conn, "A", false, false);
        let b = new_ws(&conn, "B", false, false);
        let flagged = make(&conn, &a, "Flagged", "CANARY_FLAGGED", true);
        make(&conn, &a, "Hidden", "CANARY_NOT_CONTEXT", false);
        make(&conn, &b, "Other", "CANARY_OTHER_WORKSPACE", true);
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
