//! A meeting's place in workspaces: where it is filed, which workspaces it
//! borrows, moving it, and listing a workspace's meetings.

use rusqlite::{params, Connection};

use super::rules;
use super::store::{self, borrowed_of, get_workspace, home_of, now_ms};
use super::types::*;
use crate::db::meetings::MeetingSummary;

fn err(what: &str, e: rusqlite::Error) -> String {
    format!("{what}: {e}")
}

/// Creates a meeting and files it in `home` in one transaction: if filing
/// fails, no meeting row is left behind. `None`: workspaces are unavailable and
/// the meeting is created as before.
pub fn create_meeting_in(conn: &Connection, title: &str, home: Option<&str>) -> Result<crate::db::meetings::Meeting, String> {
    let tx = conn.unchecked_transaction().map_err(|e| err("Couldn't start the meeting", e))?;
    let mut meeting = crate::db::meetings::create_meeting(&tx, title).map_err(|e| format!("Failed to create meeting: {e}"))?;
    if let Some(home) = home {
        set_home(&tx, &meeting.id, home)?;
        meeting.workspace_id = home.to_string();
    }
    tx.commit().map_err(|e| err("Couldn't start the meeting", e))?;
    Ok(meeting)
}

/// Files a new meeting in `home`.
pub fn set_home(conn: &Connection, meeting_id: &str, home: &str) -> Result<(), String> {
    conn.execute("UPDATE meetings SET workspace_id = ?2 WHERE id = ?1", params![meeting_id, home])
        .map(|_| ())
        .map_err(|e| err("Couldn't file the meeting", e))
}

/// A meeting's home and what it borrows, with every workspace whose material it uses.
pub fn get_meeting_scope(conn: &Connection, meeting_id: &str) -> Result<MeetingScope, String> {
    let home = home_of(conn, meeting_id)?.ok_or_else(|| "This meeting no longer exists".to_string())?;
    let borrowed = borrowed_of(conn, meeting_id)?;
    let scope = super::scope::scope_for_home(conn, &home, &borrowed)?;
    Ok(MeetingScope {
        meeting_id: meeting_id.to_string(),
        home,
        borrowed,
        effective: scope.material_workspaces,
    })
}

/// Replaces the workspaces a meeting borrows. A workspace taken out is "not
/// used from now on" (its row is kept with the time). Refuses a combination
/// where either side is kept separate, saying which.
pub fn set_meeting_scope(conn: &Connection, meeting_id: &str, borrowed: &[String]) -> Result<MeetingScope, String> {
    let home_id = home_of(conn, meeting_id)?.ok_or_else(|| "This meeting no longer exists".to_string())?;
    let home = get_workspace(conn, &home_id)?;
    let mut wanted: Vec<String> = Vec::new();
    for id in borrowed {
        if wanted.contains(id) {
            continue;
        }
        let other = get_workspace(conn, id)?;
        rules::may_borrow(&home, &other)?;
        wanted.push(other.id);
    }
    let current = borrowed_of(conn, meeting_id)?;
    let now = now_ms();
    let before = super::derived::snapshot(conn, &[meeting_id.to_string()]);
    let tx = conn.unchecked_transaction().map_err(|e| err("Couldn't save the scope", e))?;
    for id in current.iter().filter(|id| !wanted.contains(id)) {
        tx.execute(
            "UPDATE meeting_borrowed SET removed_at = ?3 WHERE meeting_id = ?1 AND workspace_id = ?2",
            params![meeting_id, id, now],
        )
        .map_err(|e| err("Couldn't save the scope", e))?;
    }
    for id in wanted.iter().filter(|id| !current.contains(id)) {
        tx.execute(
            "INSERT INTO meeting_borrowed (meeting_id, workspace_id, added_at, removed_at) VALUES (?1, ?2, ?3, NULL)
             ON CONFLICT(meeting_id, workspace_id) DO UPDATE SET added_at = excluded.added_at, removed_at = NULL",
            params![meeting_id, id, now],
        )
        .map_err(|e| err("Couldn't save the scope", e))?;
    }
    tx.commit().map_err(|e| err("Couldn't save the scope", e))?;
    // What came from a workspace that is no longer borrowed goes with it.
    super::derived::prune_after(conn, &before)?;
    get_meeting_scope(conn, meeting_id)
}

/// A workspace became kept separate: nothing it borrowed and no meeting that
/// borrowed it keeps the borrow.
pub fn end_borrows_involving(conn: &Connection, workspace_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE meeting_borrowed SET removed_at = ?2
         WHERE removed_at IS NULL
           AND (workspace_id = ?1 OR meeting_id IN (SELECT id FROM meetings WHERE workspace_id = ?1))",
        params![workspace_id, now_ms()],
    )
    .map(|_| ())
    .map_err(|e| err("Couldn't end the borrows", e))
}

/// Files a meeting in another workspace. What the old workspace learned from
/// it stays only as far as the meeting itself: memory items lose their source
/// link, chat summaries of the old workspace are dropped (they may quote it),
/// and borrows that no longer make sense end.
///
/// Not atomic by itself: call it inside a transaction, or use [`move_meeting_atomic`].
pub fn move_meeting(conn: &Connection, meeting_id: &str, workspace_id: &str) -> Result<(), String> {
    let old = home_of(conn, meeting_id)?.ok_or_else(|| "This meeting no longer exists".to_string())?;
    let target = get_workspace(conn, workspace_id)?;
    if target.archived {
        return Err(format!("\"{}\" is archived", target.name));
    }
    if old == workspace_id {
        return Ok(());
    }
    let before = super::derived::snapshot(conn, &[meeting_id.to_string()]);
    set_home(conn, meeting_id, workspace_id)?;
    // A borrow that is now the home, or that the new home may not have, ends.
    for id in borrowed_of(conn, meeting_id)? {
        let keep = get_workspace(conn, &id).ok().map(|w| rules::may_borrow(&target, &w).is_ok()).unwrap_or(false);
        if !keep {
            conn.execute(
                "UPDATE meeting_borrowed SET removed_at = ?3 WHERE meeting_id = ?1 AND workspace_id = ?2",
                params![meeting_id, id, now_ms()],
            )
            .map_err(|e| err("Couldn't move the meeting", e))?;
        }
    }
    super::purge::detach_from_workspace(conn, meeting_id, &old)?;
    // The brief, own versions and ticks that came from the old home's material go.
    super::derived::prune_after(conn, &before)?;
    store::touch(conn, &old);
    store::touch(conn, workspace_id);
    Ok(())
}

/// [`move_meeting`] in its own transaction.
pub fn move_meeting_atomic(conn: &Connection, meeting_id: &str, workspace_id: &str) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| err("Couldn't move the meeting", e))?;
    move_meeting(&tx, meeting_id, workspace_id)?;
    tx.commit().map_err(|e| err("Couldn't move the meeting", e))
}

/// A page of the meetings filed in a workspace, newest first, with how many
/// match in all. `query` matches the title, the summary and the transcript text.
pub fn list_workspace_meetings(
    conn: &Connection,
    workspace_id: &str,
    query: Option<&str>,
    limit: u32,
    offset: u32,
) -> Result<WorkspaceMeetingPage, String> {
    let pattern = query.map(str::trim).filter(|q| !q.is_empty()).map(|q| format!("%{}%", escape_like(q)));
    const FILTER: &str = "m.workspace_id = ?1
               AND (?2 IS NULL
                    OR m.title LIKE ?2 ESCAPE '\\'
                    OR m.summary LIKE ?2 ESCAPE '\\'
                    OR EXISTS (SELECT 1 FROM transcript_segments ts WHERE ts.meeting_id = m.id AND ts.text LIKE ?2 ESCAPE '\\'))";
    let total: i64 = conn
        .query_row(&format!("SELECT COUNT(*) FROM meetings m WHERE {FILTER}"), params![workspace_id, pattern], |row| row.get(0))
        .map_err(|e| err("Couldn't list the meetings", e))?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT m.id, m.title, m.start_time, m.end_time, m.duration_seconds,
                    (SELECT COUNT(*) FROM transcript_segments ts WHERE ts.meeting_id = m.id),
                    CASE WHEN m.summary IS NOT NULL AND m.summary != '' THEN 1 ELSE 0 END,
                    m.audio_mode, m.ai_scenario, m.workspace_id
             FROM meetings m WHERE {FILTER}
             ORDER BY m.start_time DESC
             LIMIT ?3 OFFSET ?4"
        ))
        .map_err(|e| err("Couldn't list the meetings", e))?;
    let rows = stmt
        .query_map(params![workspace_id, pattern, limit.min(500), offset], |row| {
            Ok(MeetingSummary {
                id: row.get(0)?,
                title: row.get(1)?,
                start_time: row.get(2)?,
                end_time: row.get(3)?,
                duration_seconds: row.get(4)?,
                segment_count: row.get(5)?,
                has_summary: row.get::<_, i32>(6)? != 0,
                audio_mode: row.get::<_, String>(7).unwrap_or_else(|_| "online".to_string()),
                ai_scenario: row.get::<_, String>(8).unwrap_or_else(|_| "team_meeting".to_string()),
                workspace_id: row.get(9)?,
            })
        })
        .map_err(|e| err("Couldn't list the meetings", e))?;
    let meetings = rows.collect::<Result<Vec<_>, _>>().map_err(|e| err("Couldn't list the meetings", e))?;
    Ok(WorkspaceMeetingPage { meetings, total })
}

fn escape_like(text: &str) -> String {
    text.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::test_support::*;

    fn meeting(conn: &Connection, id: &str, home: &str) {
        conn.execute(
            "INSERT INTO meetings (id, title, start_time, workspace_id) VALUES (?1, ?1, '2026-01-01T00:00:00Z', ?2)",
            params![id, home],
        )
        .unwrap();
    }

    #[test]
    fn a_meeting_and_its_home_are_made_together_or_not_at_all() {
        let conn = memory_db();
        let a = new_ws(&conn, "A", false, false);
        let made = create_meeting_in(&conn, "Call", Some(&a)).unwrap();
        assert_eq!(made.workspace_id, a);
        assert_eq!(home_of(&conn, &made.id).unwrap().unwrap(), a);
        // Filing fails: no orphan row stays in General.
        conn.execute_batch(
            "CREATE TRIGGER refuse_filing BEFORE UPDATE OF workspace_id ON meetings BEGIN SELECT RAISE(ABORT, 'no'); END;",
        )
        .unwrap();
        let before: i64 = conn.query_row("SELECT COUNT(*) FROM meetings", [], |r| r.get(0)).unwrap();
        assert!(create_meeting_in(&conn, "Second", Some(&a)).is_err());
        let after: i64 = conn.query_row("SELECT COUNT(*) FROM meetings", [], |r| r.get(0)).unwrap();
        assert_eq!(before, after);
        // Without workspaces it is created as before.
        conn.execute_batch("DROP TRIGGER refuse_filing").unwrap();
        assert_eq!(create_meeting_in(&conn, "Plain", None).unwrap().workspace_id, "general");
    }

    #[test]
    fn borrowing_is_refused_for_separate_workspaces_with_a_clear_message() {
        let conn = memory_db();
        let a = new_ws(&conn, "Alpha", false, false);
        let s = new_ws(&conn, "Secret", false, true);
        meeting(&conn, "m", &a);
        let e = set_meeting_scope(&conn, "m", &[s.clone()]).unwrap_err();
        assert!(e.contains("Secret") && e.contains("kept separate"), "{e}");
        meeting(&conn, "n", &s);
        let e = set_meeting_scope(&conn, "n", &[a]).unwrap_err();
        assert!(e.contains("Secret") && e.contains("kept separate"), "{e}");
        assert!(get_meeting_scope(&conn, "m").unwrap().borrowed.is_empty());
    }

    #[test]
    fn scope_replaces_keeps_history_and_reactivates() {
        let conn = memory_db();
        let a = new_ws(&conn, "A", false, false);
        let b = new_ws(&conn, "B", false, false);
        let c = new_ws(&conn, "C", false, false);
        meeting(&conn, "m", &a);
        set_meeting_scope(&conn, "m", &[b.clone(), c.clone()]).unwrap();
        let s = set_meeting_scope(&conn, "m", &[c.clone()]).unwrap();
        assert_eq!(s.borrowed, vec![c.clone()]);
        let removed: i64 = conn.query_row("SELECT COUNT(*) FROM meeting_borrowed WHERE removed_at IS NOT NULL", [], |r| r.get(0)).unwrap();
        assert_eq!(removed, 1);
        let s = set_meeting_scope(&conn, "m", &[b.clone(), c.clone()]).unwrap();
        assert_eq!(s.borrowed.len(), 2);
        assert!(set_meeting_scope(&conn, "m", &[a.clone()]).is_err());
        assert!(s.effective.contains(&a));
    }

    #[test]
    fn moving_a_meeting_ends_borrows_the_new_home_cannot_have() {
        let conn = memory_db();
        let a = new_ws(&conn, "A", false, false);
        let b = new_ws(&conn, "B", false, false);
        let sep = new_ws(&conn, "Sep", false, true);
        meeting(&conn, "m", &a);
        set_meeting_scope(&conn, "m", &[b.clone()]).unwrap();
        move_meeting(&conn, "m", &sep).unwrap();
        assert_eq!(home_of(&conn, "m").unwrap().unwrap(), sep);
        assert!(borrowed_of(&conn, "m").unwrap().is_empty());
        move_meeting(&conn, "m", &b).unwrap();
        assert!(move_meeting(&conn, "m", "nope").is_err());
    }

    #[test]
    fn listing_filters_by_workspace_and_searches_title_summary_and_transcript() {
        let conn = memory_db();
        let a = new_ws(&conn, "A", false, false);
        meeting(&conn, "one", &a);
        meeting(&conn, "two", "general");
        conn.execute(
            "INSERT INTO transcript_segments (id, meeting_id, text, timestamp_ms, created_at) VALUES ('s', 'one', 'the budget is 50% more', 0, 'x')",
            [],
        )
        .unwrap();
        let all = list_workspace_meetings(&conn, &a, None, 50, 0).unwrap();
        assert_eq!((all.meetings.len(), all.total), (1, 1));
        assert_eq!(all.meetings[0].workspace_id, a);
        assert_eq!(list_workspace_meetings(&conn, &a, Some("budget"), 50, 0).unwrap().meetings.len(), 1);
        assert_eq!(list_workspace_meetings(&conn, &a, Some("50%"), 50, 0).unwrap().meetings.len(), 1);
        assert_eq!(list_workspace_meetings(&conn, &a, Some("5_%"), 50, 0).unwrap().meetings.len(), 0);
        assert_eq!(list_workspace_meetings(&conn, &a, Some("two"), 50, 0).unwrap().meetings.len(), 0);
        assert_eq!(list_workspace_meetings(&conn, "general", None, 50, 0).unwrap().meetings.len(), 1);
    }
}
