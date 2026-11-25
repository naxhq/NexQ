//! Deleting and moving leave nothing behind: everything a meeting or workspace
//! owns goes with it (rows in every table, cached translations, recordings on
//! disk). Tables that belong to other features may not exist yet; they are
//! skipped.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, ToSql};

fn table_exists(conn: &Connection, table: &str) -> bool {
    conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1", params![table], |row| {
        row.get::<_, i64>(0)
    })
    .map(|n| n > 0)
    .unwrap_or(false)
}

/// Runs `sql` when `table` exists.
fn run_if_table(conn: &Connection, table: &str, sql: &str, args: &[&dyn ToSql]) -> Result<(), String> {
    if !table_exists(conn, table) {
        return Ok(());
    }
    conn.execute(sql, args).map(|_| ()).map_err(|e| format!("Couldn't clean up {table}: {e}"))
}

/// Deletes a meeting and everything about it. Returns the recording and
/// waveform files to delete once the transaction is committed.
pub fn purge_meeting(conn: &Connection, meeting_id: &str) -> Result<Vec<PathBuf>, String> {
    let files = recording_files(conn, meeting_id);
    let home: Option<String> = conn
        .query_row("SELECT workspace_id FROM meetings WHERE id = ?1", params![meeting_id], |row| row.get(0))
        .ok();
    let id = &meeting_id as &dyn ToSql;

    run_if_table(conn, "transcript_translations", "DELETE FROM transcript_translations WHERE meeting_id = ?1", &[id])?;
    run_if_table(conn, "meeting_borrowed", "DELETE FROM meeting_borrowed WHERE meeting_id = ?1", &[id])?;
    run_if_table(conn, "talking_point_edits", "DELETE FROM talking_point_edits WHERE meeting_id = ?1", &[id])?;
    run_if_table(conn, "talking_point_progress", "DELETE FROM talking_point_progress WHERE meeting_id = ?1", &[id])?;
    run_if_table(conn, "meeting_briefs", "DELETE FROM meeting_briefs WHERE meeting_id = ?1", &[id])?;
    run_if_table(conn, "meeting_notes", "DELETE FROM meeting_notes WHERE meeting_id = ?1", &[id])?;
    run_if_table(conn, "meeting_cards", "DELETE FROM meeting_cards WHERE meeting_id = ?1", &[id])?;
    run_if_table(conn, "workspace_meeting_prefs", "DELETE FROM workspace_meeting_prefs WHERE meeting_id = ?1", &[id])?;
    purge_search_rows(conn, meeting_id)?;
    crate::workspace_chat::store::redact_deleted_meeting(conn, meeting_id)?;
    if let Some(home) = home {
        detach_from_workspace(conn, meeting_id, &home)?;
    }
    crate::db::meetings::delete_meeting(conn, meeting_id).map_err(|e| format!("Couldn't delete the meeting: {e}"))?;
    Ok(files)
}

/// The search index of the meeting's transcript.
fn purge_search_rows(conn: &Connection, meeting_id: &str) -> Result<(), String> {
    let id = &meeting_id as &dyn ToSql;
    run_if_table(
        conn,
        "search_embeddings",
        "DELETE FROM search_embeddings WHERE passage_id IN
            (SELECT id FROM search_passages WHERE kind = 'transcript' AND ref_id = ?1)",
        &[id],
    )?;
    run_if_table(conn, "search_passages", "DELETE FROM search_passages WHERE kind = 'transcript' AND ref_id = ?1", &[id])?;
    run_if_table(conn, "search_sources", "DELETE FROM search_sources WHERE kind = 'transcript' AND ref_id = ?1", &[id])
}

/// What the workspace the meeting leaves (or is deleted from) still holds of
/// it: suggestions made from it go, saved memory keeps the fact but loses the
/// link, its chats' condensed summaries (they may quote it) are dropped, and
/// the "include in chat" choices end.
pub fn detach_from_workspace(conn: &Connection, meeting_id: &str, workspace_id: &str) -> Result<(), String> {
    let (m, w) = (&meeting_id as &dyn ToSql, &workspace_id as &dyn ToSql);
    run_if_table(
        conn,
        "workspace_memory",
        "DELETE FROM workspace_memory WHERE source_meeting = ?1 AND status != 'saved'",
        &[m],
    )?;
    run_if_table(
        conn,
        "workspace_memory",
        "UPDATE workspace_memory SET source_meeting = NULL, source_ms = NULL WHERE source_meeting = ?1",
        &[m],
    )?;
    run_if_table(
        conn,
        "workspace_meeting_prefs",
        "DELETE FROM workspace_meeting_prefs WHERE meeting_id = ?1 AND workspace_id = ?2",
        &[m, w],
    )?;
    crate::workspace_chat::store::redact_meeting_in_workspace(conn, meeting_id, workspace_id)?;
    run_if_table(
        conn,
        "workspace_chats",
        "UPDATE workspace_chats SET condensed = NULL, condensed_upto = NULL WHERE workspace_id = ?1",
        &[w],
    )
}

/// The recording and waveform files of a meeting, as the database names them.
fn recording_files(conn: &Connection, meeting_id: &str) -> Vec<PathBuf> {
    conn.query_row(
        "SELECT recording_path, waveform_path FROM meetings WHERE id = ?1",
        params![meeting_id],
        |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?)),
    )
    .map(|(rec, wave)| [rec, wave].into_iter().flatten().filter(|p| !p.is_empty()).map(PathBuf::from).collect())
    .unwrap_or_default()
}

/// Deletes `paths`, but only files that really are inside `dir` (symlinks and
/// `..` are resolved first), and returns how many went. A path outside NexQ's
/// recordings folder is never touched, whatever the database says.
pub fn delete_files_inside(dir: &Path, paths: &[PathBuf]) -> usize {
    let Ok(root) = std::fs::canonicalize(dir) else {
        return 0;
    };
    let mut deleted = 0;
    for path in paths {
        let Ok(real) = std::fs::canonicalize(path) else {
            continue; // already gone
        };
        if real.starts_with(&root) && real != root && real.is_file() {
            match std::fs::remove_file(&real) {
                Ok(()) => deleted += 1,
                Err(e) => log::warn!("Couldn't delete {}: {e}", real.display()),
            }
        } else {
            log::warn!("Not deleting {}: it is not inside the recordings folder", path.display());
        }
    }
    deleted
}

/// NexQ's recordings folder (where the recorder writes).
pub fn recordings_dir() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(PathBuf::from).map(|p| p.join("com.nexq.app").join("recordings"))
}

/// A workspace's chats move to another workspace (their summaries are dropped).
pub fn move_chats(conn: &Connection, from: &str, to: &str) -> Result<(), String> {
    let (f, t) = (&from as &dyn ToSql, &to as &dyn ToSql);
    run_if_table(
        conn,
        "workspace_chats",
        "UPDATE workspace_chats SET workspace_id = ?2, condensed = NULL, condensed_upto = NULL WHERE workspace_id = ?1",
        &[f, t],
    )?;
    run_if_table(conn, "workspace_meeting_prefs", "UPDATE OR IGNORE workspace_meeting_prefs SET workspace_id = ?2 WHERE workspace_id = ?1", &[f, t])
}

/// A workspace's chats and their messages are deleted.
pub fn delete_chats(conn: &Connection, workspace_id: &str) -> Result<(), String> {
    let w = &workspace_id as &dyn ToSql;
    run_if_table(
        conn,
        "workspace_messages",
        "DELETE FROM workspace_messages WHERE chat_id IN (SELECT id FROM workspace_chats WHERE workspace_id = ?1)",
        &[w],
    )?;
    run_if_table(conn, "workspace_chats", "DELETE FROM workspace_chats WHERE workspace_id = ?1", &[w])?;
    run_if_table(conn, "workspace_meeting_prefs", "DELETE FROM workspace_meeting_prefs WHERE workspace_id = ?1", &[w])
}

/// The workspace's own rows: itself, its items, its memory, the borrows of it,
/// and its digests.
pub fn delete_workspace_rows(conn: &Connection, workspace_id: &str) -> Result<(), String> {
    let w = &workspace_id as &dyn ToSql;
    run_if_table(conn, "workspace_items", "DELETE FROM workspace_items WHERE workspace_id = ?1", &[w])?;
    run_if_table(conn, "workspace_memory", "DELETE FROM workspace_memory WHERE workspace_id = ?1", &[w])?;
    run_if_table(conn, "meeting_borrowed", "DELETE FROM meeting_borrowed WHERE workspace_id = ?1", &[w])?;
    run_if_table(conn, "period_digests", "DELETE FROM period_digests WHERE workspace_id = ?1", &[w])?;
    run_if_table(conn, "workspaces", "DELETE FROM workspaces WHERE id = ?1", &[w])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::test_support::*;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nexq-purge-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn only_files_inside_the_recordings_folder_are_deleted() {
        let root = dir("rec");
        let recordings = root.join("recordings");
        std::fs::create_dir_all(&recordings).unwrap();
        let inside = recordings.join("m.ogg");
        let wave = recordings.join("m.waveform.json");
        let outside = root.join("precious.txt");
        for f in [&inside, &wave, &outside] {
            std::fs::write(f, b"x").unwrap();
        }
        // A path that climbs out of the folder, and the folder itself.
        let sneaky = recordings.join("..").join("precious.txt");
        let n = delete_files_inside(&recordings, &[inside.clone(), wave.clone(), outside.clone(), sneaky, recordings.clone(), root.join("none")]);
        assert_eq!(n, 2);
        assert!(!inside.exists() && !wave.exists());
        assert!(outside.exists() && recordings.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    /// Makes `link` a directory link to `target`: a symlink on unix, a junction
    /// on Windows (no privilege needed). False when the system refused.
    fn link_dir(link: &Path, target: &Path) -> bool {
        #[cfg(windows)]
        {
            std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
    }

    #[test]
    fn a_junction_or_symlink_that_leads_outside_is_refused() {
        let root = dir("links");
        let recordings = root.join("recordings");
        let outside = root.join("outside");
        std::fs::create_dir_all(&recordings).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let secret = outside.join("secret.txt");
        std::fs::write(&secret, b"x").unwrap();
        let link = recordings.join("sneaky");
        assert!(link_dir(&link, &outside), "the test needs to make a directory link");
        // The database says the recording is "inside" the folder, through the link.
        let through = link.join("secret.txt");
        assert!(through.exists());
        let n = delete_files_inside(&recordings, &[through, link.clone()]);
        assert_eq!(n, 0);
        assert!(secret.exists(), "the file outside the folder must survive");
        assert!(outside.exists());
        // The recordings folder itself being a link to elsewhere deletes nothing there either.
        let elsewhere = root.join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        let precious = elsewhere.join("m.ogg");
        std::fs::write(&precious, b"x").unwrap();
        let fake_dir = root.join("fake_recordings");
        assert!(link_dir(&fake_dir, &elsewhere));
        // A real file inside a folder that resolves to its own target is "inside" it;
        // what matters is a path outside the resolved folder is refused.
        let unrelated = outside.join("secret.txt");
        assert_eq!(delete_files_inside(&fake_dir, &[unrelated]), 0);
        assert!(secret.exists());
        // Remove the links first so cleanup never follows them.
        #[cfg(windows)]
        {
            let _ = std::fs::remove_dir(&link);
            let _ = std::fs::remove_dir(&fake_dir);
        }
        #[cfg(unix)]
        {
            let _ = std::fs::remove_file(&link);
            let _ = std::fs::remove_file(&fake_dir);
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_file_symlink_to_outside_is_refused_where_the_system_allows_making_one() {
        let root = dir("filelink");
        let recordings = root.join("recordings");
        std::fs::create_dir_all(&recordings).unwrap();
        let outside = root.join("precious.txt");
        std::fs::write(&outside, b"x").unwrap();
        let link = recordings.join("m.ogg");
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(&outside, &link).is_ok();
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(&outside, &link).is_ok();
        if made {
            assert_eq!(delete_files_inside(&recordings, &[link]), 0);
            assert!(outside.exists());
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn purging_a_meeting_removes_everything_it_owns() {
        let conn = memory_db();
        let a = new_ws(&conn, "A", false, false);
        conn.execute(
            "INSERT INTO meetings (id, title, start_time, workspace_id, recording_path, waveform_path)
             VALUES ('m', 't', 'x', ?1, 'C:/r/m.ogg', 'C:/r/m.waveform.json')",
            params![a],
        )
        .unwrap();
        conn.execute("INSERT INTO meetings (id, title, start_time, workspace_id) VALUES ('keep', 't', 'x', ?1)", params![a]).unwrap();
        for sql in [
            "INSERT INTO transcript_segments (id, meeting_id, text, timestamp_ms, created_at) VALUES ('s', 'm', 'hello', 0, 'x')",
            "INSERT INTO transcript_translations (id, segment_id, meeting_id, source_lang, target_lang, original_text, translated_text, provider) VALUES ('t', 's', 'm', 'en', 'fr', 'hello', 'salut', 'p')",
            "INSERT INTO meeting_chat (id, meeting_id, role, content, created_at) VALUES ('c', 'm', 'user', 'q', 0)",
            "INSERT INTO meeting_borrowed (meeting_id, workspace_id, added_at) VALUES ('m', 'general', 0)",
            "INSERT INTO talking_point_edits (meeting_id, point_id, doc_json) VALUES ('m', 'p', '{}')",
            "INSERT INTO talking_point_progress (meeting_id, point_id) VALUES ('m', 'p')",
            "INSERT INTO meeting_briefs (meeting_id, updated_at) VALUES ('m', 0)",
            "INSERT INTO talking_point_progress (meeting_id, point_id) VALUES ('keep', 'p')",
        ] {
            conn.execute(sql, []).unwrap();
        }
        for (id, status, meeting) in [("saved", "saved", "m"), ("sugg", "suggested", "m"), ("other", "saved", "keep")] {
            conn.execute(
                "INSERT INTO workspace_memory (id, workspace_id, kind, status, source_meeting, source_ms, created_at, updated_at)
                 VALUES (?1, ?2, 'fact', ?3, ?4, 5, 0, 0)",
                params![id, a, status, meeting],
            )
            .unwrap();
        }
        let files = purge_meeting(&conn, "m").unwrap();
        assert_eq!(files.len(), 2);
        for table in ["meetings", "transcript_segments", "transcript_translations", "meeting_chat", "meeting_borrowed", "talking_point_edits", "meeting_briefs"] {
            let col = if table == "meetings" { "id" } else { "meeting_id" };
            let n: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM {table} WHERE {col} = 'm'"), [], |r| r.get(0)).unwrap();
            assert_eq!(n, 0, "{table}");
        }
        // The other meeting is untouched, and so is its progress.
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM talking_point_progress", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        // The suggestion from it is gone; the saved fact stays without a source.
        let ids: Vec<String> = conn.prepare("SELECT id FROM workspace_memory ORDER BY id").unwrap().query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
        assert_eq!(ids, vec!["other", "saved"]);
        let source: Option<String> = conn.query_row("SELECT source_meeting FROM workspace_memory WHERE id = 'saved'", [], |r| r.get(0)).unwrap();
        assert_eq!(source, None);
    }

    #[test]
    fn purging_tolerates_tables_of_features_that_do_not_exist_yet_and_cleans_search_rows_when_they_do() {
        let conn = memory_db();
        conn.execute("INSERT INTO meetings (id, title, start_time) VALUES ('m', 't', 'x')", []).unwrap();
        assert!(purge_meeting(&conn, "m").is_ok());
        conn.execute("INSERT INTO meetings (id, title, start_time) VALUES ('m2', 't', 'x')", []).unwrap();
        conn.execute_batch(
            "INSERT INTO search_passages (id, kind, ref_id, text) VALUES (1, 'transcript', 'm2', 'a'), (2, 'document', 'm2', 'b'), (3, 'transcript', 'other', 'c');
             INSERT INTO search_embeddings (passage_id, model, dims, vec) VALUES (1, 'm', 1, x'00'), (3, 'm', 1, x'00');
             INSERT INTO meeting_cards (meeting_id, recap, origin) VALUES ('m2', 'r', 'extract');",
        )
        .unwrap();
        purge_meeting(&conn, "m2").unwrap();
        let passages: Vec<i64> = conn.prepare("SELECT id FROM search_passages ORDER BY id").unwrap().query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
        assert_eq!(passages, vec![2, 3]);
        let embeddings: i64 = conn.query_row("SELECT COUNT(*) FROM search_embeddings", [], |r| r.get(0)).unwrap();
        assert_eq!(embeddings, 1);
        let cards: i64 = conn.query_row("SELECT COUNT(*) FROM meeting_cards", [], |r| r.get(0)).unwrap();
        assert_eq!(cards, 0);
    }

    #[test]
    fn deleting_a_workspace_with_delete_removes_meetings_points_memory_and_keeps_documents() {
        use crate::workspace::store::*;
        use crate::workspace::types::DeleteMode;
        let conn = memory_db();
        let a = new_ws(&conn, "A", false, false);
        conn.execute("INSERT INTO context_resources (id, name, file_type, file_path, loaded_at) VALUES ('d', 'd', 'txt', 'x', 'now')", []).unwrap();
        file(&conn, &a, "document", "d");
        conn.execute("INSERT INTO meetings (id, title, start_time, workspace_id) VALUES ('m', 't', 'x', ?1)", params![a]).unwrap();
        conn.execute("INSERT INTO talking_points (id, workspace_id, title, created_at, updated_at) VALUES ('tp', ?1, 't', 0, 0)", params![a]).unwrap();
        conn.execute("INSERT INTO workspace_memory (id, workspace_id, kind, status, created_at, updated_at) VALUES ('x', ?1, 'fact', 'saved', 0, 0)", params![a]).unwrap();
        let report = delete_workspace(&conn, &a, DeleteMode::Delete).unwrap();
        assert_eq!(report.meetings, 1);
        for table in ["meetings", "talking_points", "workspace_memory", "workspace_items"] {
            let n: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0)).unwrap();
            assert_eq!(n, 0, "{table}");
        }
        let docs: i64 = conn.query_row("SELECT COUNT(*) FROM context_resources", [], |r| r.get(0)).unwrap();
        assert_eq!(docs, 1);
        assert!(find_workspace(&conn, &a).unwrap().is_none());
    }

    #[test]
    fn deleting_a_workspace_with_move_sends_meetings_and_points_to_general() {
        use crate::workspace::store::*;
        use crate::workspace::types::DeleteMode;
        let conn = memory_db();
        let a = new_ws(&conn, "A", false, false);
        conn.execute("INSERT INTO meetings (id, title, start_time, workspace_id) VALUES ('m', 't', 'x', ?1)", params![a]).unwrap();
        conn.execute("INSERT INTO talking_points (id, workspace_id, title, created_at, updated_at) VALUES ('tp', ?1, 't', 0, 0)", params![a]).unwrap();
        delete_workspace(&conn, &a, DeleteMode::Move).unwrap();
        let home: String = conn.query_row("SELECT workspace_id FROM meetings WHERE id = 'm'", [], |r| r.get(0)).unwrap();
        assert_eq!(home, "general");
        let ws: String = conn.query_row("SELECT workspace_id FROM talking_points WHERE id = 'tp'", [], |r| r.get(0)).unwrap();
        assert_eq!(ws, "general");
    }
}
