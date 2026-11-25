//! From a chat's effective scope to what search and the ladder take:
//! meetings of the home workspace only (minus the ones switched off),
//! material (documents, opted-in folders, context talking points) of home,
//! borrowed and General as `scope_for` decides.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection};

use super::store::{self, ChatRow};
use crate::workspace::scope::{scope_for_home, EffectiveScope};
use crate::workspace_search::{MeetingScope, SearchScope};

#[derive(Debug, Clone)]
pub struct HomeMeeting {
    pub id: String,
    pub title: String,
    pub started_ms: Option<i64>,
    pub duration_s: Option<i64>,
    pub summary: bool,
}

pub struct ChatScope {
    /// Items the user pinned for this chat: (kind, ref_id).
    pub pins: Vec<(String, String)>,
    pub eff: EffectiveScope,
    pub search: SearchScope,
    /// Meetings the chat may use (home workspace, not switched off).
    pub meetings: Vec<HomeMeeting>,
    pub folder_ids: Vec<String>,
}

fn parse_ms(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis())
}

/// All meetings filed in a workspace, newest first.
pub fn home_meetings(conn: &Connection, workspace_id: &str) -> Result<Vec<HomeMeeting>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, title, start_time, duration_seconds,
                    CASE WHEN summary IS NOT NULL AND summary != '' THEN 1 ELSE 0 END
             FROM meetings WHERE workspace_id = ?1 ORDER BY start_time DESC, id",
        )
        .map_err(|e| format!("Couldn't read the meetings: {e}"))?;
    let rows = stmt
        .query_map(params![workspace_id], |r| {
            Ok(HomeMeeting {
                id: r.get(0)?,
                title: r.get(1)?,
                started_ms: parse_ms(&r.get::<_, String>(2)?),
                duration_s: r.get(3)?,
                summary: r.get::<_, i64>(4)? != 0,
            })
        })
        .map_err(|e| format!("Couldn't read the meetings: {e}"))?;
    rows.collect::<Result<_, _>>().map_err(|e| format!("Couldn't read the meetings: {e}"))
}

/// Folders of the scope the user opted in to index (in any workspace the
/// scope draws material from).
pub fn opted_in_folders(conn: &Connection, eff: &EffectiveScope) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for ws in &eff.material_workspaces {
        for item in crate::workspace::store::list_items(conn, ws)? {
            if item.kind == crate::workspace::types::ItemKind::Folder
                && item.index_opt_in
                && eff.allows_folder(&item.ref_id)
                && !out.contains(&item.ref_id)
            {
                out.push(item.ref_id);
            }
        }
    }
    Ok(out)
}

fn search_scope(eff: &EffectiveScope, meetings: &[String], folders: &[String], excluded: Vec<String>) -> SearchScope {
    SearchScope {
        meetings: if meetings.is_empty() { MeetingScope::None } else { MeetingScope::Ids(meetings.to_vec()) },
        document_ids: eff.document_ids.clone(),
        folder_ids: folders.to_vec(),
        talking_point_ids: eff.talking_point_ids.clone(),
        excluded_meeting_ids: excluded,
    }
}

/// The scope of a chat.
pub fn chat_scope(conn: &Connection, chat: &ChatRow) -> Result<ChatScope, String> {
    let eff = scope_for_home(conn, &chat.chat.workspace_id, &[])?;
    let choices: HashMap<String, bool> = store::meeting_choices(conn, &chat.chat.workspace_id, &chat.chat.id)?;
    let prefs = store::list_item_prefs(conn, &chat.chat.id)?;
    let mut eff = eff;
    let is_excluded = |kind: &str, id: &str| prefs.iter().any(|p| p.pref == "exclude" && p.kind == kind && p.ref_id == id);
    eff.document_ids.retain(|d| !is_excluded("document", d));
    eff.folder_ids.retain(|d| !is_excluded("folder", d));
    eff.talking_point_ids.retain(|d| !is_excluded("talking_point", d));
    let pins: Vec<(String, String)> =
        prefs.iter().filter(|p| p.pref == "pin").map(|p| (p.kind.clone(), p.ref_id.clone())).collect();
    let all = home_meetings(conn, &chat.chat.workspace_id)?;
    let mut excluded: Vec<String> = Vec::new();
    let mut meetings: Vec<HomeMeeting> = Vec::new();
    for m in all {
        let included = chat.chat.include_meetings && choices.get(&m.id).copied().unwrap_or(true) && !is_excluded("meeting", &m.id);
        if included {
            meetings.push(m);
        } else {
            excluded.push(m.id);
        }
    }
    let folder_ids = opted_in_folders(conn, &eff)?;
    let ids: Vec<String> = meetings.iter().map(|m| m.id.clone()).collect();
    let search = search_scope(&eff, &ids, &folder_ids, excluded);
    Ok(ChatScope { pins, eff, search, meetings, folder_ids })
}

/// The scope of a plain workspace search (its own meetings, nothing switched off).
pub fn workspace_search_scope(conn: &Connection, workspace_id: &str) -> Result<SearchScope, String> {
    let eff = scope_for_home(conn, workspace_id, &[])?;
    let ids: Vec<String> = home_meetings(conn, workspace_id)?.into_iter().map(|m| m.id).collect();
    let folders = opted_in_folders(conn, &eff)?;
    Ok(search_scope(&eff, &ids, &folders, Vec::new()))
}

/// Everything the ladder needs to know about the sources of a scope, from the
/// index: transcript tokens per meeting, and the other sources with sizes.
pub struct IndexedSizes {
    pub transcript_tokens: HashMap<String, usize>,
    pub materials: Vec<(String, String, Option<String>, String, usize)>,
    pub cards: HashMap<String, String>,
}

pub fn indexed_sizes(conn: &Connection, scope: &SearchScope) -> Result<IndexedSizes, String> {
    let e = |x: rusqlite::Error| format!("Couldn't read the index: {x}");
    let mut transcript_tokens = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT ref_id, COALESCE(SUM(tokens), 0) FROM search_passages WHERE kind = 'transcript' GROUP BY ref_id")
            .map_err(e)?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as usize))).map_err(e)?;
        for r in rows {
            let (k, v) = r.map_err(e)?;
            transcript_tokens.insert(k, v);
        }
    }
    let mut cards = HashMap::new();
    {
        let mut stmt = conn.prepare("SELECT meeting_id, recap FROM meeting_cards").map_err(e)?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(e)?;
        for r in rows {
            let (k, v) = r.map_err(e)?;
            cards.insert(k, v);
        }
    }
    let json = |v: &[String]| serde_json::to_string(v).unwrap_or_else(|_| "[]".into());
    let mut materials = Vec::new();
    let mut stmt = conn
        .prepare(
            "SELECT kind, ref_id, sub_ref, MIN(title), COALESCE(SUM(tokens), 0) FROM search_passages
             WHERE (kind = 'document' AND ref_id IN (SELECT value FROM json_each(?1)))
                OR (kind = 'folder' AND ref_id IN (SELECT value FROM json_each(?2)))
                OR (kind = 'talking_point' AND ref_id IN (SELECT value FROM json_each(?3)))
             GROUP BY kind, ref_id, sub_ref",
        )
        .map_err(e)?;
    let rows = stmt
        .query_map(params![json(&scope.document_ids), json(&scope.folder_ids), json(&scope.talking_point_ids)], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, String>(3)?, r.get::<_, i64>(4)? as usize))
        })
        .map_err(e)?;
    for r in rows {
        materials.push(r.map_err(e)?);
    }
    Ok(IndexedSizes { transcript_tokens, materials, cards })
}

/// The indexed text of one source, in order (what the `full` strategy sends).
pub fn indexed_text(conn: &Connection, kind: &str, ref_id: &str, sub_ref: Option<&str>) -> Option<String> {
    let mut stmt = conn
        .prepare("SELECT text FROM search_passages WHERE kind = ?1 AND ref_id = ?2 AND sub_ref IS ?3 ORDER BY id")
        .ok()?;
    let rows = stmt.query_map(params![kind, ref_id, sub_ref], |r| r.get::<_, String>(0)).ok()?;
    let parts: Vec<String> = rows.filter_map(|r| r.ok()).collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n\n"))
    }
}

/// How many of these meetings the index already holds, and how many there
/// are: `(indexed, total)`. A meeting counts as indexed once the indexer has
/// recorded it (also when it has no text or could not be read).
pub fn meeting_backlog(conn: &Connection, meetings: &[HomeMeeting]) -> (usize, usize) {
    let total = meetings.len();
    if total == 0 {
        return (0, 0);
    }
    let ids = serde_json::to_string(&meetings.iter().map(|m| m.id.as_str()).collect::<Vec<_>>()).unwrap_or_else(|_| "[]".into());
    let indexed: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM search_sources WHERE kind = 'transcript' AND sub_ref = ''
             AND status IN ('ok', 'error') AND ref_id IN (SELECT value FROM json_each(?1))",
            params![ids],
            |r| r.get(0),
        )
        .unwrap_or(0);
    ((indexed as usize).min(total), total)
}

/// Ids of the meetings in `scope` that are indexed (for the fingerprint).
pub fn meeting_signature(conn: &Connection, ids: &[String]) -> String {
    let mut set: Vec<&String> = ids.iter().collect();
    set.sort();
    let mut parts = String::new();
    let mut stmt = match conn.prepare("SELECT mtime, size, content_hash FROM search_sources WHERE kind = 'transcript' AND ref_id = ?1 AND sub_ref = ''") {
        Ok(s) => s,
        Err(_) => return String::new(),
    };
    for id in set {
        let row: Option<(i64, i64, String)> = stmt.query_row(params![id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).ok();
        parts.push_str(&format!("{id}:{:?};", row));
    }
    crate::workspace_search::store::sha_hex(parts.as_bytes())
}

/// Unique ids helper.
pub fn unique(v: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    v.into_iter().filter(|x| seen.insert(x.clone())).collect()
}

#[cfg(test)]
mod scope_tests {
    use super::*;
    use crate::workspace::test_support::*;

    #[test]
    fn a_workspaces_chat_sees_the_meetings_filed_in_it_and_not_those_that_only_borrow_its_material() {
        let conn = memory_db();
        let a = new_ws(&conn, "A", false, false);
        let b = new_ws(&conn, "B", false, false);
        for (id, home) in [("m1", &a), ("m2", &b)] {
            conn.execute(
                "INSERT INTO meetings (id, title, start_time, workspace_id) VALUES (?1, ?1, '2026-01-01T00:00:00Z', ?2)",
                params![id, home],
            )
            .unwrap();
        }
        crate::workspace::meetings::set_meeting_scope(&conn, "m2", &[a.clone()]).unwrap();
        let ids = |ws: &str| home_meetings(&conn, ws).unwrap().into_iter().map(|m| m.id).collect::<Vec<_>>();
        assert_eq!(ids(&a), vec!["m1".to_string()], "B's meeting uses A's material but is not part of A");
        assert_eq!(ids(&b), vec!["m2".to_string()]);
    }
}
