//! Content made FROM a workspace's material must not outlive the access to it.
//! When a meeting's scope narrows (it moved, a borrow ended, General or a
//! borrowed workspace was switched off or kept separate), what was derived from
//! the material that left goes too: the meeting's brief, its own versions of
//! talking points and the "said" ticks of points that are no longer in scope,
//! and the chat citations of material a workspace no longer uses.

use std::collections::BTreeSet;

use rusqlite::{params, Connection, ToSql};

use super::scope::{scope_for, ScopeOwner};

/// The workspaces whose material each meeting used at some moment.
pub type Snapshot = Vec<(String, BTreeSet<String>)>;

fn err(what: &str, e: impl std::fmt::Display) -> String {
    format!("{what}: {e}")
}

fn meeting_exists(conn: &Connection, id: &str) -> Result<bool, String> {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM meetings WHERE id = ?1)", params![id], |r| r.get(0))
        .map_err(|e| err("Couldn't read the meeting", e))
}

/// What each of `meetings` may use from, right now. A meeting that does not
/// exist is left out; any other failure aborts, so a change never goes ahead
/// without knowing what it takes away.
pub fn snapshot(conn: &Connection, meetings: &[String]) -> Result<Snapshot, String> {
    let mut out = Vec::new();
    for m in meetings {
        if !meeting_exists(conn, m)? {
            continue;
        }
        let scope = scope_for(conn, ScopeOwner::Meeting(m))?;
        out.push((m.clone(), scope.material_workspaces.into_iter().collect()));
    }
    Ok(out)
}

/// Drops the condensed summary of every chat of a workspace: it may quote
/// material the workspace no longer has (the chat's own messages stay).
pub fn clear_condensed(conn: &Connection, workspace_id: &str) -> Result<(), String> {
    let exists: bool = conn
        .query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspace_chats')", [], |r| r.get(0))
        .map_err(|e| err("Couldn't clean up the chats", e))?;
    if !exists {
        return Ok(());
    }
    conn.execute(
        "UPDATE workspace_chats SET condensed = NULL, condensed_upto = NULL WHERE workspace_id = ?1",
        params![workspace_id],
    )
    .map(|_| ())
    .map_err(|e| err("Couldn't clean up the chats", e))
}

/// Meetings homed in `workspace_id` or borrowing it now.
pub fn meetings_involving(conn: &Connection, workspace_id: &str) -> Vec<String> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT id FROM meetings WHERE workspace_id = ?1
         UNION SELECT meeting_id FROM meeting_borrowed WHERE workspace_id = ?1 AND removed_at IS NULL",
    ) else {
        return Vec::new();
    };
    stmt.query_map(params![workspace_id], |r| r.get::<_, String>(0))
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
}

/// After a change: for every meeting of `before`, delete what was derived from
/// material that is no longer in its scope.
pub fn prune_after(conn: &Connection, before: &Snapshot) -> Result<(), String> {
    for (meeting, was) in before {
        // A meeting that is gone has nothing left to prune; any other failure aborts.
        if !meeting_exists(conn, meeting)? {
            continue;
        }
        let scope = scope_for(conn, ScopeOwner::Meeting(meeting))?;
        let now: BTreeSet<String> = scope.material_workspaces.iter().cloned().collect();
        let now_json = serde_json::to_string(&scope.material_workspaces).map_err(|e| e.to_string())?;
        let (m, n) = (meeting as &dyn ToSql, &now_json as &dyn ToSql);
        // The brief summarises whatever the workspace held: if anything left, it goes.
        if !was.is_subset(&now) {
            conn.execute("DELETE FROM meeting_briefs WHERE meeting_id = ?1", params![meeting])
                .map_err(|e| err("Couldn't clear the brief", e))?;
            // The home's chats may have condensed text that quotes what left.
            clear_condensed(conn, &scope.home)?;
        }
        // This meeting's own versions and ticks of points that are not in scope any more.
        for table in ["talking_point_edits", "talking_point_progress"] {
            conn.execute(
                &format!(
                    "DELETE FROM {table} WHERE meeting_id = ?1 AND point_id IN
                       (SELECT id FROM talking_points WHERE workspace_id NOT IN (SELECT value FROM json_each(?2)))"
                ),
                [m, n],
            )
            .map_err(|e| err("Couldn't clear what came from a workspace that left", e))?;
        }
    }
    Ok(())
}

/// The documents, folders, servers and talking points of `from` that a
/// workspace whose own material is `keep` can no longer reach: (kind, ref id).
pub fn material_lost(conn: &Connection, from: &[String], keep: &[String]) -> Vec<(String, String)> {
    let query = |ids: &[String]| -> BTreeSet<(String, String)> {
        let json = serde_json::to_string(ids).unwrap_or_else(|_| "[]".into());
        let mut out = BTreeSet::new();
        if let Ok(mut stmt) = conn.prepare(
            "SELECT kind, ref_id FROM workspace_items WHERE workspace_id IN (SELECT value FROM json_each(?1))
             UNION SELECT 'talking_point', id FROM talking_points WHERE workspace_id IN (SELECT value FROM json_each(?1))
             UNION SELECT 'memory', id FROM workspace_memory WHERE status = 'saved' AND workspace_id IN (SELECT value FROM json_each(?1))",
        ) {
            if let Ok(rows) = stmt.query_map(params![json], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) {
                out.extend(rows.filter_map(Result::ok));
            }
        }
        out
    };
    let kept = query(keep);
    query(from).difference(&kept).cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::meetings::{move_meeting, set_meeting_scope};
    use crate::workspace::store;
    use crate::workspace::test_support::*;
    use crate::workspace::types::WorkspacePatch;

    fn seed(conn: &Connection, meeting: &str, home: &str) {
        conn.execute("INSERT INTO meetings (id, title, start_time, workspace_id) VALUES (?1, 't', 'x', ?2)", params![meeting, home]).unwrap();
        conn.execute("INSERT INTO meeting_briefs (meeting_id, sheet_json, updated_at) VALUES (?1, 'CANARY_BRIEF', 0)", params![meeting]).unwrap();
    }

    fn point(conn: &Connection, id: &str, ws: &str) {
        conn.execute("INSERT INTO talking_points (id, workspace_id, title, created_at, updated_at) VALUES (?1, ?2, 't', 0, 0)", params![id, ws]).unwrap();
    }

    fn mark(conn: &Connection, meeting: &str, point: &str) {
        conn.execute("INSERT INTO talking_point_edits (meeting_id, point_id, doc_json) VALUES (?1, ?2, 'CANARY_EDIT')", params![meeting, point]).unwrap();
        conn.execute("INSERT INTO talking_point_progress (meeting_id, point_id, said_json) VALUES (?1, ?2, '[]')", params![meeting, point]).unwrap();
    }

    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn ending_a_borrow_removes_the_brief_and_what_came_from_the_workspace_that_left() {
        let conn = memory_db();
        let a = new_ws(&conn, "A", false, false);
        let b = new_ws(&conn, "B", false, false);
        seed(&conn, "m", &a);
        point(&conn, "own", &a);
        point(&conn, "borrowed", &b);
        set_meeting_scope(&conn, "m", &[b.clone()]).unwrap();
        mark(&conn, "m", "own");
        mark(&conn, "m", "borrowed");
        set_meeting_scope(&conn, "m", &[]).unwrap();
        assert_eq!(count(&conn, "meeting_briefs"), 0, "the brief came from material that left");
        let left: Vec<String> = conn.prepare("SELECT point_id FROM talking_point_edits").unwrap().query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
        assert_eq!(left, vec!["own"], "only the point of the home workspace stays");
        assert_eq!(count(&conn, "talking_point_progress"), 1);
    }

    #[test]
    fn adding_a_borrow_keeps_everything() {
        let conn = memory_db();
        let a = new_ws(&conn, "A", false, false);
        let b = new_ws(&conn, "B", false, false);
        seed(&conn, "m", &a);
        point(&conn, "own", &a);
        mark(&conn, "m", "own");
        set_meeting_scope(&conn, "m", &[b]).unwrap();
        assert_eq!((count(&conn, "meeting_briefs"), count(&conn, "talking_point_edits")), (1, 1));
    }

    #[test]
    fn moving_a_meeting_removes_what_came_from_the_old_home() {
        let conn = memory_db();
        let a = new_ws(&conn, "A", false, false);
        let b = new_ws(&conn, "B", false, false);
        seed(&conn, "m", &a);
        point(&conn, "from_a", &a);
        mark(&conn, "m", "from_a");
        move_meeting(&conn, "m", &b).unwrap();
        assert_eq!((count(&conn, "meeting_briefs"), count(&conn, "talking_point_edits"), count(&conn, "talking_point_progress")), (0, 0, 0));
    }

    #[test]
    fn switching_general_off_or_keeping_a_workspace_separate_removes_what_came_from_it() {
        let conn = memory_db();
        let a = new_ws(&conn, "A", true, false);
        let b = new_ws(&conn, "B", false, false);
        seed(&conn, "m", &a);
        point(&conn, "general_point", "general");
        mark(&conn, "m", "general_point");
        // Switching General off for A.
        store::update_workspace(&conn, &a, WorkspacePatch { include_general: Some(false), ..Default::default() }).unwrap();
        assert_eq!((count(&conn, "meeting_briefs"), count(&conn, "talking_point_edits")), (0, 0));
        // Keeping a borrowed workspace separate.
        seed(&conn, "n", &a);
        point(&conn, "b_point", &b);
        set_meeting_scope(&conn, "n", &[b.clone()]).unwrap();
        mark(&conn, "n", "b_point");
        store::update_workspace(&conn, &b, WorkspacePatch { keep_separate: Some(true), ..Default::default() }).unwrap();
        assert_eq!((count(&conn, "meeting_briefs"), count(&conn, "talking_point_edits")), (0, 0));
    }

    #[test]
    fn a_change_that_removes_nothing_from_a_scope_removes_nothing() {
        let conn = memory_db();
        let a = new_ws(&conn, "A", false, false);
        seed(&conn, "m", &a);
        point(&conn, "own", &a);
        mark(&conn, "m", "own");
        store::update_workspace(&conn, &a, WorkspacePatch { include_general: Some(false), name: Some("Renamed".into()), ..Default::default() }).unwrap();
        assert_eq!((count(&conn, "meeting_briefs"), count(&conn, "talking_point_edits")), (1, 1));
    }

    #[test]
    fn deleting_a_workspace_clears_what_borrowing_meetings_got_from_it() {
        let conn = memory_db();
        let a = new_ws(&conn, "A", false, false);
        let b = new_ws(&conn, "B", false, false);
        seed(&conn, "m", &a);
        point(&conn, "b_point", &b);
        set_meeting_scope(&conn, "m", &[b.clone()]).unwrap();
        mark(&conn, "m", "b_point");
        store::delete_workspace(&conn, &b, crate::workspace::types::DeleteMode::Move).unwrap();
        assert_eq!((count(&conn, "meeting_briefs"), count(&conn, "talking_point_edits")), (0, 0));
    }

    #[test]
    fn material_lost_also_names_saved_memory_and_the_condensed_text_is_cleared() {
        let conn = memory_db();
        let a = new_ws(&conn, "A", true, false);
        conn.execute("INSERT INTO workspace_memory (id, workspace_id, kind, status, created_at, updated_at) VALUES ('mem', 'general', 'fact', 'saved', 0, 0)", []).unwrap();
        conn.execute("INSERT INTO workspace_memory (id, workspace_id, kind, status, created_at, updated_at) VALUES ('sug', 'general', 'fact', 'suggested', 0, 0)", []).unwrap();
        let lost = material_lost(&conn, &["general".to_string()], &[a.clone()]);
        assert_eq!(lost, vec![("memory".to_string(), "mem".to_string())], "saved only, never a suggestion");
        conn.execute("INSERT INTO workspace_chats (id, workspace_id, condensed, condensed_upto, created_at, updated_at) VALUES ('c', ?1, 'quotes CANARY', 5, 0, 0)", params![a]).unwrap();
        // Switching General off for A clears its chats' condensed text.
        store::update_workspace(&conn, &a, WorkspacePatch { include_general: Some(false), ..Default::default() }).unwrap();
        let (text, upto): (Option<String>, Option<i64>) = conn.query_row("SELECT condensed, condensed_upto FROM workspace_chats WHERE id = 'c'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((text, upto), (None, None));
    }

    #[test]
    fn a_failure_while_pruning_rolls_the_whole_change_back() {
        let conn = memory_db();
        let a = new_ws(&conn, "A", false, false);
        let b = new_ws(&conn, "B", false, false);
        seed(&conn, "m", &a);
        set_meeting_scope(&conn, "m", &[b.clone()]).unwrap();
        // Deleting the brief fails, as a disk error would.
        conn.execute_batch("CREATE TRIGGER no_brief_delete BEFORE DELETE ON meeting_briefs BEGIN SELECT RAISE(ABORT, 'disk'); END;").unwrap();
        assert!(set_meeting_scope(&conn, "m", &[]).is_err());
        assert_eq!(crate::workspace::store::borrowed_of(&conn, "m").unwrap(), vec![b.clone()], "the borrow was not ended");
        assert_eq!(count(&conn, "meeting_briefs"), 1);
        // The same for a workspace switch: General stays on when the cleanup can't run.
        let c = new_ws(&conn, "C", true, false);
        seed(&conn, "n", &c);
        point(&conn, "gp", "general");
        mark(&conn, "n", "gp");
        conn.execute_batch("DROP TRIGGER no_brief_delete; CREATE TRIGGER no_edit_delete BEFORE DELETE ON talking_point_edits BEGIN SELECT RAISE(ABORT, 'disk'); END;").unwrap();
        assert!(store::update_workspace(&conn, &c, WorkspacePatch { include_general: Some(false), ..Default::default() }).is_err());
        assert!(store::get_workspace(&conn, &c).unwrap().include_general, "the switch was rolled back");
        assert_eq!((count(&conn, "meeting_briefs"), count(&conn, "talking_point_edits")), (2, 1));
    }

    #[test]
    fn material_lost_names_only_what_the_workspace_can_no_longer_reach() {
        let conn = memory_db();
        let a = new_ws(&conn, "A", true, false);
        file(&conn, "general", "document", "only_general");
        file(&conn, "general", "document", "also_in_a");
        file(&conn, &a, "document", "also_in_a");
        point(&conn, "gp", "general");
        let lost = material_lost(&conn, &["general".to_string()], &[a]);
        assert_eq!(lost, vec![("document".to_string(), "only_general".to_string()), ("talking_point".to_string(), "gp".to_string())]);
    }
}
