//! Chats, messages and the per-meeting "include" choices in the database.

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension};

use super::provenance::Provenance;
use super::types::*;
use crate::db::workspace_migrations::now_ms;

fn err(what: &str, e: impl std::fmt::Display) -> String {
    format!("{what}: {e}")
}

/// A chat with what is stored beside its public fields.
#[derive(Debug, Clone)]
pub struct ChatRow {
    pub chat: WorkspaceChat,
    pub condensed: Option<String>,
    /// What the condensed history rests on.
    pub condensed_prov: Option<Provenance>,
    /// The chat's own marker token for retrieved text (see `context_plan`).
    pub nonce: String,
}

const CHAT_COLS: &str = "id, workspace_id, title, provider, model, effort, depth, include_meetings, condensed, condensed_upto, nonce, created_at, updated_at,
    (SELECT COUNT(*) FROM workspace_messages m WHERE m.chat_id = workspace_chats.id),
    condensed_prov";

fn read_chat(row: &rusqlite::Row) -> rusqlite::Result<ChatRow> {
    Ok(ChatRow {
        chat: WorkspaceChat {
            id: row.get(0)?,
            workspace_id: row.get(1)?,
            title: row.get(2)?,
            provider: row.get(3)?,
            model: row.get(4)?,
            effort: row.get(5)?,
            depth: row.get(6)?,
            include_meetings: row.get::<_, i64>(7)? != 0,
            condensed_upto: row.get(9)?,
            message_count: row.get(13)?,
            created_at: row.get(11)?,
            updated_at: row.get(12)?,
        },
        condensed: row.get(8)?,
        condensed_prov: row.get::<_, Option<String>>(14)?.and_then(|j| serde_json::from_str(&j).ok()),
        nonce: row.get(10)?,
    })
}

pub fn clean_depth(depth: &str) -> &'static str {
    match depth {
        "lean" => "lean",
        "deep" => "deep",
        _ => "balanced",
    }
}

pub fn create_chat(
    conn: &Connection,
    workspace_id: &str,
    provider: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
) -> Result<WorkspaceChat, String> {
    crate::workspace::store::get_workspace(conn, workspace_id)?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();
    conn.execute(
        "INSERT INTO workspace_chats (id, workspace_id, title, provider, model, effort, depth, include_meetings, nonce, created_at, updated_at)
         VALUES (?1, ?2, '', ?3, ?4, ?5, 'balanced', 1, ?6, ?7, ?7)",
        params![id, workspace_id, provider, model, effort, crate::workspace_search::context_plan::new_nonce(), now],
    )
    .map_err(|e| err("Couldn't start the chat", e))?;
    Ok(get_chat(conn, &id)?.expect("just inserted").chat)
}

pub fn get_chat(conn: &Connection, id: &str) -> Result<Option<ChatRow>, String> {
    conn.query_row(&format!("SELECT {CHAT_COLS} FROM workspace_chats WHERE id = ?1"), params![id], read_chat)
        .optional()
        .map_err(|e| err("Couldn't read the chat", e))
}

pub fn require_chat(conn: &Connection, id: &str) -> Result<ChatRow, String> {
    get_chat(conn, id)?.ok_or_else(|| "This chat no longer exists".to_string())
}

pub fn list_chats(conn: &Connection, workspace_id: &str) -> Result<Vec<WorkspaceChat>, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT {CHAT_COLS} FROM workspace_chats WHERE workspace_id = ?1 ORDER BY updated_at DESC, id"))
        .map_err(|e| err("Couldn't list the chats", e))?;
    let rows = stmt.query_map(params![workspace_id], read_chat).map_err(|e| err("Couldn't list the chats", e))?;
    rows.map(|r| r.map(|c| c.chat)).collect::<Result<_, _>>().map_err(|e| err("Couldn't list the chats", e))
}

pub fn update_chat(conn: &Connection, id: &str, patch: WorkspaceChatPatch) -> Result<WorkspaceChat, String> {
    let mut row = require_chat(conn, id)?;
    let c = &mut row.chat;
    if let Some(t) = patch.title {
        c.title = t.trim().chars().take(120).collect();
    }
    if let Some(v) = patch.provider {
        c.provider = v.filter(|s| !s.trim().is_empty());
    }
    if let Some(v) = patch.model {
        c.model = v.filter(|s| !s.trim().is_empty());
    }
    if let Some(v) = patch.effort {
        c.effort = v.filter(|s| !s.trim().is_empty());
    }
    if let Some(d) = patch.depth {
        c.depth = clean_depth(&d).to_string();
    }
    if let Some(b) = patch.include_meetings {
        c.include_meetings = b;
    }
    conn.execute(
        "UPDATE workspace_chats SET title = ?2, provider = ?3, model = ?4, effort = ?5, depth = ?6, include_meetings = ?7, updated_at = ?8 WHERE id = ?1",
        params![id, c.title, c.provider, c.model, c.effort, c.depth, c.include_meetings as i64, now_ms()],
    )
    .map_err(|e| err("Couldn't save the chat", e))?;
    Ok(get_chat(conn, id)?.expect("exists").chat)
}

/// Delete a chat with its messages and its meeting choices.
pub fn delete_chat(conn: &Connection, id: &str) -> Result<(), String> {
    let tx = crate::db::immediate_tx(conn).map_err(|e| err("Couldn't delete the chat", e))?;
    tx.execute("DELETE FROM workspace_provenance WHERE chat_id = ?1", params![id]).map_err(|e| err("Couldn't delete the chat", e))?;
    tx.execute("DELETE FROM workspace_messages WHERE chat_id = ?1", params![id]).map_err(|e| err("Couldn't delete the chat", e))?;
    tx.execute("DELETE FROM workspace_meeting_prefs WHERE chat_id = ?1", params![id]).map_err(|e| err("Couldn't delete the chat", e))?;
    tx.execute("DELETE FROM workspace_chat_item_prefs WHERE chat_id = ?1", params![id]).map_err(|e| err("Couldn't delete the chat", e))?;
    tx.execute("DELETE FROM workspace_chats WHERE id = ?1", params![id]).map_err(|e| err("Couldn't delete the chat", e))?;
    tx.commit().map_err(|e| err("Couldn't delete the chat", e))
}

fn read_message(row: &rusqlite::Row) -> rusqlite::Result<WorkspaceMessage> {
    let citations: String = row.get(5)?;
    let context: Option<String> = row.get(6)?;
    Ok(WorkspaceMessage {
        id: row.get(0)?,
        chat_id: row.get(1)?,
        role: row.get(2)?,
        content: row.get(3)?,
        model: row.get(4)?,
        citations: serde_json::from_str(&citations).unwrap_or_default(),
        context: context.and_then(|c| serde_json::from_str(&c).ok()),
        input_tokens: row.get(7)?,
        output_tokens: row.get(8)?,
        created_at: row.get(9)?,
    })
}

const MSG_COLS: &str = "id, chat_id, role, content, model, citations_json, context_json, input_tokens, output_tokens, created_at";

pub fn list_messages(conn: &Connection, chat_id: &str) -> Result<Vec<WorkspaceMessage>, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT {MSG_COLS} FROM workspace_messages WHERE chat_id = ?1 ORDER BY id"))
        .map_err(|e| err("Couldn't read the messages", e))?;
    let rows = stmt.query_map(params![chat_id], read_message).map_err(|e| err("Couldn't read the messages", e))?;
    rows.collect::<Result<_, _>>().map_err(|e| err("Couldn't read the messages", e))
}

pub fn get_message(conn: &Connection, id: i64) -> Result<Option<WorkspaceMessage>, String> {
    conn.query_row(&format!("SELECT {MSG_COLS} FROM workspace_messages WHERE id = ?1"), params![id], read_message)
        .optional()
        .map_err(|e| err("Couldn't read the message", e))
}

/// An answered question: both messages are saved together or not at all.
pub struct Answer<'a> {
    pub question: &'a str,
    pub text: &'a str,
    pub model: &'a str,
    pub citations: &'a [WorkspaceCitation],
    pub context: &'a ContextReport,
    pub input_tokens: i64,
    pub output_tokens: i64,
    /// What the answer rests on (none: an answer that uses nothing).
    pub provenance: Option<&'a Provenance>,
}

/// An answered pair, saved in one transaction of its own.
pub fn save_answer(conn: &Connection, chat_id: &str, a: Answer) -> Result<WorkspaceMessage, String> {
    let tx = crate::db::immediate_tx(conn).map_err(|e| err("Couldn't save the answer", e))?;
    let saved = save_answer_in_tx(&tx, chat_id, a)?;
    tx.commit().map_err(|e| err("Couldn't save the answer", e))?;
    Ok(saved)
}

/// The pair, written on a connection whose caller owns the transaction (see
/// `guard::atomically`).
pub fn save_answer_in_tx(conn: &Connection, chat_id: &str, a: Answer) -> Result<WorkspaceMessage, String> {
    let now = now_ms();
    conn.execute(
        "INSERT INTO workspace_messages (chat_id, role, content, created_at) VALUES (?1, 'user', ?2, ?3)",
        params![chat_id, a.question, now],
    )
    .map_err(|e| err("Couldn't save the answer", e))?;
    conn.execute(
        "INSERT INTO workspace_messages (chat_id, role, content, model, citations_json, context_json, input_tokens, output_tokens, created_at)
         VALUES (?1, 'assistant', ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            chat_id,
            a.text,
            a.model,
            serde_json::to_string(a.citations).unwrap_or_else(|_| "[]".into()),
            serde_json::to_string(a.context).ok(),
            a.input_tokens,
            a.output_tokens,
            now
        ],
    )
    .map_err(|e| err("Couldn't save the answer", e))?;
    let id = conn.last_insert_rowid();
    let prov = a.provenance.cloned().unwrap_or_default();
    conn.execute(
        "INSERT INTO workspace_provenance (message_id, chat_id, prov_json) VALUES (?1, ?2, ?3)",
        params![id, chat_id, serde_json::to_string(&prov).map_err(|e| err("Couldn't save the answer", e))?],
    )
    .map_err(|e| err("Couldn't save the answer", e))?;
    // the title comes from the first question, locally
    let title: String = conn
        .query_row("SELECT title FROM workspace_chats WHERE id = ?1", params![chat_id], |r| r.get(0))
        .map_err(|e| err("Couldn't save the answer", e))?;
    if title.trim().is_empty() {
        conn.execute("UPDATE workspace_chats SET title = ?2 WHERE id = ?1", params![chat_id, title_from(a.question)])
            .map_err(|e| err("Couldn't save the answer", e))?;
    }
    conn.execute("UPDATE workspace_chats SET updated_at = ?2 WHERE id = ?1", params![chat_id, now])
        .map_err(|e| err("Couldn't save the answer", e))?;
    Ok(get_message(conn, id)?.expect("just inserted"))
}

/// A short title from a first question (no AI): its first line, cut at a word.
pub fn title_from(question: &str) -> String {
    let question = &crate::prompt_data::strip_hidden(question);
    let line = question.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("New chat");
    let flat: String = line.chars().filter(|c| !c.is_control()).collect();
    if flat.chars().count() <= 60 {
        return flat;
    }
    let cut: String = flat.chars().take(60).collect();
    match cut.rfind(' ') {
        Some(i) if i > 25 => format!("{}…", cut[..i].trim_end()),
        _ => format!("{}…", cut.trim_end()),
    }
}

/// The provenance of every answer of a chat, by message id.
pub fn provenance_of_chat(conn: &Connection, chat_id: &str) -> Result<HashMap<i64, Provenance>, String> {
    let mut stmt = conn
        .prepare("SELECT message_id, prov_json FROM workspace_provenance WHERE chat_id = ?1")
        .map_err(|e| err("Couldn't read what the answers rest on", e))?;
    let rows = stmt
        .query_map(params![chat_id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| err("Couldn't read what the answers rest on", e))?;
    let mut out = HashMap::new();
    for r in rows {
        let (id, json) = r.map_err(|e| err("Couldn't read what the answers rest on", e))?;
        // a record that can't be read is left out: the answer then has none and is not reused
        if let Ok(p) = serde_json::from_str::<Provenance>(&json) {
            out.insert(id, p);
        }
    }
    Ok(out)
}

/// Forget the condensed history (what it was made from changed).
pub fn clear_condensed(conn: &Connection, chat_id: &str) -> Result<(), String> {
    conn.execute("UPDATE workspace_chats SET condensed = NULL, condensed_upto = NULL, condensed_prov = NULL WHERE id = ?1", params![chat_id])
        .map(|_| ())
        .map_err(|e| err("Couldn't clear the condensed history", e))
}

pub fn set_condensed(conn: &Connection, chat_id: &str, text: &str, upto: i64, prov: Option<&Provenance>) -> Result<(), String> {
    let prov_json = serde_json::to_string(&prov.cloned().unwrap_or_default()).map_err(|e| err("Couldn't save the condensed history", e))?;
    conn.execute(
        "UPDATE workspace_chats SET condensed = ?2, condensed_upto = ?3, condensed_prov = ?4 WHERE id = ?1",
        params![chat_id, text, upto, prov_json],
    )
    .map(|_| ())
    .map_err(|e| err("Couldn't save the condensed history", e))
}

// ── which meetings a chat includes ───────────────────────────────────────────

/// Include or exclude one meeting for a whole workspace (`chat_id` None) or
/// for one chat.
pub fn set_meeting_included(
    conn: &Connection,
    workspace_id: &str,
    chat_id: Option<&str>,
    meeting_id: &str,
    included: bool,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO workspace_meeting_prefs (workspace_id, chat_id, meeting_id, included) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(workspace_id, chat_id, meeting_id) DO UPDATE SET included = excluded.included",
        params![workspace_id, chat_id.unwrap_or(""), meeting_id, included as i64],
    )
    .map(|_| ())
    .map_err(|e| err("Couldn't save the choice", e))
}

/// Explicit choices for a chat: the workspace's, overridden by the chat's.
pub fn meeting_choices(conn: &Connection, workspace_id: &str, chat_id: &str) -> Result<HashMap<String, bool>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT meeting_id, included, chat_id FROM workspace_meeting_prefs
             WHERE workspace_id = ?1 AND (chat_id = '' OR chat_id = ?2) ORDER BY chat_id",
        )
        .map_err(|e| err("Couldn't read the choices", e))?;
    let rows = stmt
        .query_map(params![workspace_id, chat_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? != 0)))
        .map_err(|e| err("Couldn't read the choices", e))?;
    let mut out = HashMap::new();
    for r in rows {
        let (m, inc) = r.map_err(|e| err("Couldn't read the choices", e))?;
        out.insert(m, inc); // '' sorts first, the chat's own row wins
    }
    Ok(out)
}

/// The explicit include/exclude choices for a chat (workspace-wide ones
/// overridden by the chat's own).
pub fn list_meeting_prefs(conn: &Connection, workspace_id: &str, chat_id: Option<&str>) -> Result<Vec<MeetingPref>, String> {
    let map = match chat_id {
        Some(c) => meeting_choices(conn, workspace_id, c)?,
        None => {
            let mut stmt = conn
                .prepare("SELECT meeting_id, included FROM workspace_meeting_prefs WHERE workspace_id = ?1 AND chat_id = ''")
                .map_err(|e| err("Couldn't read the choices", e))?;
            let rows = stmt
                .query_map(params![workspace_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? != 0)))
                .map_err(|e| err("Couldn't read the choices", e))?;
            rows.filter_map(|r| r.ok()).collect()
        }
    };
    let mut out: Vec<MeetingPref> = map.into_iter().map(|(meeting_id, included)| MeetingPref { meeting_id, included }).collect();
    out.sort_by(|a, b| a.meeting_id.cmp(&b.meeting_id));
    Ok(out)
}

/// Pin or exclude one item for one chat (`None` clears the choice).
pub fn set_item_pref(conn: &Connection, chat_id: &str, kind: &str, ref_id: &str, pref: Option<&str>) -> Result<(), String> {
    if !matches!(kind, "meeting" | "document" | "folder" | "talking_point") {
        return Err("That kind of item can't be pinned or excluded.".into());
    }
    match pref {
        None => conn
            .execute("DELETE FROM workspace_chat_item_prefs WHERE chat_id = ?1 AND kind = ?2 AND ref_id = ?3", params![chat_id, kind, ref_id])
            .map(|_| ()),
        Some("default") => conn
            .execute("DELETE FROM workspace_chat_item_prefs WHERE chat_id = ?1 AND kind = ?2 AND ref_id = ?3", params![chat_id, kind, ref_id])
            .map(|_| ()),
        Some(p) if p == "pin" || p == "exclude" => conn
            .execute(
                "INSERT INTO workspace_chat_item_prefs (chat_id, kind, ref_id, pref) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(chat_id, kind, ref_id) DO UPDATE SET pref = excluded.pref",
                params![chat_id, kind, ref_id, p],
            )
            .map(|_| ()),
        Some(_) => return Err("Choose pin or exclude.".into()),
    }
    .map_err(|e| err("Couldn't save the choice", e))
}

pub fn list_item_prefs(conn: &Connection, chat_id: &str) -> Result<Vec<ItemPref>, String> {
    let mut stmt = conn
        .prepare("SELECT kind, ref_id, pref FROM workspace_chat_item_prefs WHERE chat_id = ?1 ORDER BY kind, ref_id")
        .map_err(|e| err("Couldn't read the choices", e))?;
    let rows = stmt
        .query_map(params![chat_id], |r| Ok(ItemPref { kind: r.get(0)?, ref_id: r.get(1)?, pref: r.get(2)?, title: String::new() }))
        .map_err(|e| err("Couldn't read the choices", e))?;
    let mut prefs: Vec<ItemPref> = rows.collect::<Result<_, _>>().map_err(|e| err("Couldn't read the choices", e))?;
    for p in &mut prefs {
        p.title = item_title(conn, &p.kind, &p.ref_id);
    }
    Ok(prefs)
}

/// The name of a pinned or excluded item, empty when it is gone.
fn item_title(conn: &Connection, kind: &str, ref_id: &str) -> String {
    let sql = match kind {
        "document" => "SELECT name FROM context_resources WHERE id = ?1",
        "talking_point" => "SELECT title FROM talking_points WHERE id = ?1",
        "meeting" => "SELECT title FROM meetings WHERE id = ?1",
        "folder" => "SELECT label FROM workspace_items WHERE ref_id = ?1 AND kind = 'folder' AND label IS NOT NULL LIMIT 1",
        _ => return String::new(),
    };
    conn.query_row(sql, [ref_id], |r| r.get::<_, String>(0)).unwrap_or_default()
}

/// Remove chats that were created and never used, untouched for `older_than_ms`.
pub fn prune_empty_chats(conn: &Connection, older_than_ms: i64) -> Result<usize, String> {
    let cutoff = now_ms() - older_than_ms;
    let ids: Vec<String> = conn
        .prepare(
            "SELECT id FROM workspace_chats WHERE updated_at < ?1
             AND NOT EXISTS (SELECT 1 FROM workspace_messages m WHERE m.chat_id = workspace_chats.id)",
        )
        .and_then(|mut s| s.query_map(params![cutoff], |r| r.get::<_, String>(0)).map(|rows| rows.filter_map(|r| r.ok()).collect()))
        .map_err(|e| err("Couldn't tidy the chats", e))?;
    for id in &ids {
        delete_chat(conn, id)?;
    }
    Ok(ids.len())
}

// ── purge: nothing dangles ────────────────────────────────────────────────

const GONE: &str = "Deleted meeting";

fn redact_text_of(conn: &Connection, meeting_id: &str, workspace_id: Option<&str>) -> Result<(), String> {
    let has_tables: i64 = conn
        .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('workspace_messages', 'workspace_chats')", [], |r| r.get(0))
        .unwrap_or(0);
    if has_tables < 2 {
        return Ok(());
    }
    let like = format!("%{}%", meeting_id.replace('%', "").replace('_', ""));
    let mut stmt = conn
        .prepare(
            "SELECT m.id, m.citations_json, m.context_json, c.workspace_id FROM workspace_messages m
             JOIN workspace_chats c ON c.id = m.chat_id
             WHERE (m.citations_json LIKE ?1 OR m.context_json LIKE ?1)",
        )
        .map_err(|e| err("Couldn't clean up the chats", e))?;
    let rows: Vec<(i64, String, Option<String>, String)> = stmt
        .query_map(params![like], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .map_err(|e| err("Couldn't clean up the chats", e))?
        .filter_map(|r| r.ok())
        .collect();
    for (id, cites, ctx, ws) in rows {
        if workspace_id.map_or(false, |w| w != ws) {
            continue;
        }
        let mut citations: Vec<WorkspaceCitation> = serde_json::from_str(&cites).unwrap_or_default();
        let mut changed = false;
        for c in citations.iter_mut().filter(|c| c.ref_id == meeting_id) {
            c.ref_id = String::new();
            c.sub_ref = None;
            c.title = GONE.to_string();
            c.start_ms = None;
            c.snippet = String::new();
            changed = true;
        }
        let mut context = ctx.as_deref().and_then(|c| serde_json::from_str::<ContextReport>(c).ok());
        if let Some(r) = context.as_mut() {
            for b in r.bars.iter_mut().filter(|b| b.id == format!("meeting:{meeting_id}")) {
                b.id = "meeting:".to_string();
                b.title = GONE.to_string();
                changed = true;
            }
        }
        if changed {
            conn.execute(
                "UPDATE workspace_messages SET citations_json = ?2, context_json = ?3 WHERE id = ?1",
                params![
                    id,
                    serde_json::to_string(&citations).unwrap_or_else(|_| "[]".into()),
                    context.as_ref().and_then(|c| serde_json::to_string(c).ok())
                ],
            )
            .map_err(|e| err("Couldn't clean up the chats", e))?;
        }
    }
    Ok(())
}

/// A meeting was deleted: every citation and context bar of it in any chat
/// becomes "Deleted meeting" without text or location.
pub fn redact_deleted_meeting(conn: &Connection, meeting_id: &str) -> Result<(), String> {
    redact_text_of(conn, meeting_id, None)
}

/// A meeting left a workspace: the same for that workspace's chats.
pub fn redact_meeting_in_workspace(conn: &Connection, meeting_id: &str, workspace_id: &str) -> Result<(), String> {
    redact_text_of(conn, meeting_id, Some(workspace_id))
}

/// Material (kind, ref id) a workspace no longer uses: its chats' citations and
/// context bars of it lose their title, text and place, and say why in plain
/// words. Returns how many messages changed.
pub fn redact_material_in_workspace(conn: &Connection, workspace_id: &str, refs: &[(String, String)], why: &str) -> Result<usize, String> {
    const REMOVED: &str = "Removed source";
    if refs.is_empty() {
        return Ok(0);
    }
    let has_tables: i64 = conn
        .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('workspace_messages', 'workspace_chats')", [], |r| r.get(0))
        .unwrap_or(0);
    if has_tables < 2 {
        return Ok(0);
    }
    let gone = |kind: &str, ref_id: &str| refs.iter().any(|(k, r)| r == ref_id && (kind.is_empty() || k == kind));
    let mut stmt = conn
        .prepare(
            "SELECT m.id, m.citations_json, m.context_json FROM workspace_messages m
             JOIN workspace_chats c ON c.id = m.chat_id WHERE c.workspace_id = ?1",
        )
        .map_err(|e| err("Couldn't clean up the chats", e))?;
    let rows: Vec<(i64, String, Option<String>)> = stmt
        .query_map(params![workspace_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| err("Couldn't clean up the chats", e))?
        .filter_map(|r| r.ok())
        .collect();
    let mut changed_messages = 0;
    for (id, cites, ctx) in rows {
        let mut citations: Vec<WorkspaceCitation> = serde_json::from_str(&cites).unwrap_or_default();
        let mut changed = false;
        for c in citations.iter_mut().filter(|c| !c.ref_id.is_empty() && gone(&c.kind, &c.ref_id)) {
            c.ref_id = String::new();
            c.sub_ref = None;
            c.title = REMOVED.to_string();
            c.start_ms = None;
            c.snippet = why.to_string();
            changed = true;
        }
        let mut context = ctx.as_deref().and_then(|c| serde_json::from_str::<ContextReport>(c).ok());
        if let Some(r) = context.as_mut() {
            for b in r.bars.iter_mut() {
                let mut parts = b.id.split(':');
                let (_, ref_id) = (parts.next(), parts.next().unwrap_or(""));
                if !ref_id.is_empty() && gone("", ref_id) {
                    b.id = "removed:".to_string();
                    b.title = format!("{REMOVED}. {why}");
                    changed = true;
                }
            }
        }
        if changed {
            conn.execute(
                "UPDATE workspace_messages SET citations_json = ?2, context_json = ?3 WHERE id = ?1",
                params![
                    id,
                    serde_json::to_string(&citations).unwrap_or_else(|_| "[]".into()),
                    context.as_ref().and_then(|c| serde_json::to_string(c).ok())
                ],
            )
            .map_err(|e| err("Couldn't clean up the chats", e))?;
            changed_messages += 1;
        }
    }
    Ok(changed_messages)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::test_support::*;

    #[test]
    fn material_a_workspace_no_longer_uses_is_redacted_in_its_chats_only_and_says_why() {
        let conn = memory_db();
        let a = new_ws(&conn, "A", true, false);
        let b = new_ws(&conn, "B", true, false);
        let (ca, cb) = (create_chat(&conn, &a, None, None, None).unwrap(), create_chat(&conn, &b, None, None, None).unwrap());
        let doc = |id: &str, tag: &str| WorkspaceCitation { tag: tag.into(), kind: "document".into(), ref_id: id.into(), sub_ref: None, title: format!("Title of {id}"), start_ms: None, snippet: format!("CANARY text of {id}") };
        let r = ContextReport {
            bars: vec![ContextBar { id: "document:general_doc".into(), layer: "documents".into(), title: "Title of general_doc".into(), tokens: 5, relevance: 0.5, pinned: false, included: true, ..Default::default() }],
            ..report()
        };
        for c in [&ca, &cb] {
            save_answer(&conn, &c.id, Answer { question: "q", text: "a", model: "x", citations: &[doc("general_doc", "S1"), doc("own_doc", "S2")], context: &r, input_tokens: 0, output_tokens: 0, provenance: None }).unwrap();
        }
        let why = "General is no longer used by this workspace";
        let n = redact_material_in_workspace(&conn, &a, &[("document".to_string(), "general_doc".to_string())], why).unwrap();
        assert_eq!(n, 1);
        let m = &list_messages(&conn, &ca.id).unwrap()[1];
        assert_eq!((m.citations[0].title.as_str(), m.citations[0].snippet.as_str(), m.citations[0].ref_id.as_str()), ("Removed source", why, ""));
        assert_eq!(m.citations[1].ref_id, "own_doc", "what is still used stays");
        assert!(m.context.as_ref().unwrap().bars[0].title.contains(why));
        let raw: String = conn.query_row("SELECT citations_json || context_json FROM workspace_messages WHERE chat_id = ?1 AND role = 'assistant'", [&ca.id], |r| r.get(0)).unwrap();
        assert!(!raw.contains("CANARY text of general_doc") && !raw.contains("Title of general_doc"));
        // Another workspace's chats keep theirs.
        assert_eq!(list_messages(&conn, &cb.id).unwrap()[1].citations[0].title, "Title of general_doc");
        assert_eq!(redact_material_in_workspace(&conn, &a, &[], why).unwrap(), 0);
    }

    fn report() -> ContextReport {
        ContextReport {
            strategy: "ladder".into(),
            depth: "balanced".into(),
            budget: 100,
            window: 1000,
            used: 10,
            bars: vec![ContextBar { id: "meeting:m1".into(), layer: "meetings".into(), title: "Budget talk".into(), tokens: 5, relevance: 0.5, pinned: false, included: true, ..Default::default() }],
            omitted: 0,
            notices: vec![],
            estimate: false,
            ..Default::default()
        }
    }

    fn cite(m: &str) -> WorkspaceCitation {
        WorkspaceCitation { tag: "S1".into(), kind: "transcript".into(), ref_id: m.into(), sub_ref: None, title: "Budget talk".into(), start_ms: Some(5000), snippet: "the budget is 5k".into() }
    }

    #[test]
    fn chats_messages_and_titles() {
        let conn = memory_db();
        let ws = new_ws(&conn, "W", false, false);
        let c = create_chat(&conn, &ws, Some("openai"), Some("gpt"), None).unwrap();
        assert_eq!(c.depth, "balanced");
        assert!(create_chat(&conn, "nope", None, None, None).is_err());
        let r = report();
        let m = save_answer(&conn, &c.id, Answer { question: "What was decided about the very long budget topic that keeps going on and on and on?", text: "5k [S1]", model: "gpt", citations: &[cite("m1")], context: &r, input_tokens: 10, output_tokens: 3, provenance: None }).unwrap();
        assert_eq!(m.role, "assistant");
        assert_eq!(m.citations.len(), 1);
        assert_eq!(m.context.as_ref().unwrap().used, 10);
        let msgs = list_messages(&conn, &c.id).unwrap();
        assert_eq!(msgs.iter().map(|m| m.role.as_str()).collect::<Vec<_>>(), vec!["user", "assistant"]);
        let chat = get_chat(&conn, &c.id).unwrap().unwrap().chat;
        assert!(chat.title.ends_with('…') && chat.title.chars().count() <= 61, "{}", chat.title);
        let p = update_chat(&conn, &c.id, WorkspaceChatPatch { depth: Some("deep".into()), provider: Some(None), include_meetings: Some(false), ..Default::default() }).unwrap();
        assert_eq!((p.depth.as_str(), p.provider.clone(), p.include_meetings), ("deep", None, false));
        assert_eq!(p.model.as_deref(), Some("gpt"));
        assert_eq!(get_chat(&conn, &c.id).unwrap().unwrap().chat.message_count, 2);
        delete_chat(&conn, &c.id).unwrap();
        assert!(get_chat(&conn, &c.id).unwrap().is_none());
        assert!(list_messages(&conn, &c.id).unwrap().is_empty());
    }

    #[test]
    fn a_title_the_user_or_ui_set_is_never_overwritten() {
        let conn = memory_db();
        let ws = new_ws(&conn, "W", false, false);
        let c = create_chat(&conn, &ws, None, None, None).unwrap();
        update_chat(&conn, &c.id, WorkspaceChatPatch { title: Some("My plan".into()), ..Default::default() }).unwrap();
        let r = report();
        save_answer(&conn, &c.id, Answer { question: "something else entirely", text: "a", model: "x", citations: &[], context: &r, input_tokens: 0, output_tokens: 0, provenance: None }).unwrap();
        assert_eq!(get_chat(&conn, &c.id).unwrap().unwrap().chat.title, "My plan");
    }

    #[test]
    fn item_prefs_and_meeting_prefs_list_back() {
        let conn = memory_db();
        let ws = new_ws(&conn, "W", false, false);
        let c = create_chat(&conn, &ws, None, None, None).unwrap();
        set_item_pref(&conn, &c.id, "document", "d1", Some("pin")).unwrap();
        set_item_pref(&conn, &c.id, "meeting", "m1", Some("exclude")).unwrap();
        set_item_pref(&conn, &c.id, "document", "d1", Some("exclude")).unwrap();
        assert!(set_item_pref(&conn, &c.id, "memory", "x", Some("pin")).is_err());
        assert!(set_item_pref(&conn, &c.id, "document", "d1", Some("bogus")).is_err());
        let prefs = list_item_prefs(&conn, &c.id).unwrap();
        assert_eq!(prefs.len(), 2);
        assert_eq!(prefs[0], ItemPref { kind: "document".into(), ref_id: "d1".into(), pref: "exclude".into(), title: String::new() });
        set_item_pref(&conn, &c.id, "document", "d1", None).unwrap();
        assert_eq!(list_item_prefs(&conn, &c.id).unwrap().len(), 1);
        set_meeting_included(&conn, &ws, None, "m2", false).unwrap();
        set_meeting_included(&conn, &ws, Some(&c.id), "m3", true).unwrap();
        let all = list_meeting_prefs(&conn, &ws, Some(&c.id)).unwrap();
        assert_eq!(all, vec![MeetingPref { meeting_id: "m2".into(), included: false }, MeetingPref { meeting_id: "m3".into(), included: true }]);
        assert_eq!(list_meeting_prefs(&conn, &ws, None).unwrap().len(), 1);
        delete_chat(&conn, &c.id).unwrap();
        assert!(list_item_prefs(&conn, &c.id).unwrap().is_empty());
    }

    #[test]
    fn only_old_untouched_empty_chats_are_pruned() {
        let conn = memory_db();
        let ws = new_ws(&conn, "W", false, false);
        let old_empty = create_chat(&conn, &ws, None, None, None).unwrap();
        let old_used = create_chat(&conn, &ws, None, None, None).unwrap();
        let fresh = create_chat(&conn, &ws, None, None, None).unwrap();
        let r = report();
        save_answer(&conn, &old_used.id, Answer { question: "q", text: "a", model: "x", citations: &[], context: &r, input_tokens: 0, output_tokens: 0, provenance: None }).unwrap();
        conn.execute("UPDATE workspace_chats SET updated_at = 1 WHERE id IN (?1, ?2)", params![old_empty.id, old_used.id]).unwrap();
        assert_eq!(prune_empty_chats(&conn, 24 * 3600 * 1000).unwrap(), 1);
        assert!(get_chat(&conn, &old_empty.id).unwrap().is_none());
        assert!(get_chat(&conn, &old_used.id).unwrap().is_some());
        assert!(get_chat(&conn, &fresh.id).unwrap().is_some());
    }

    #[test]
    fn title_from_is_local_and_short() {
        assert_eq!(title_from("  \n Hello there  \n more"), "Hello there");
        assert_eq!(title_from(""), "New chat");
    }

    #[test]
    fn meeting_choices_chat_overrides_workspace() {
        let conn = memory_db();
        let ws = new_ws(&conn, "W", false, false);
        let c = create_chat(&conn, &ws, None, None, None).unwrap();
        set_meeting_included(&conn, &ws, None, "m1", false).unwrap();
        set_meeting_included(&conn, &ws, None, "m2", false).unwrap();
        set_meeting_included(&conn, &ws, Some(&c.id), "m2", true).unwrap();
        let ch = meeting_choices(&conn, &ws, &c.id).unwrap();
        assert_eq!(ch.get("m1"), Some(&false));
        assert_eq!(ch.get("m2"), Some(&true));
        let other = create_chat(&conn, &ws, None, None, None).unwrap();
        assert_eq!(meeting_choices(&conn, &ws, &other.id).unwrap().get("m2"), Some(&false));
    }

    #[test]
    fn deleting_a_meeting_turns_its_citations_into_a_deleted_meeting_without_text() {
        let conn = memory_db();
        let ws = new_ws(&conn, "W", false, false);
        let c = create_chat(&conn, &ws, None, None, None).unwrap();
        let r = report();
        let m = save_answer(&conn, &c.id, Answer { question: "q", text: "a [S1]", model: "x", citations: &[cite("m1"), WorkspaceCitation { ref_id: "m2".into(), tag: "S2".into(), title: "Other".into(), snippet: "other text".into(), ..cite("m2") }], context: &r, input_tokens: 0, output_tokens: 0, provenance: None }).unwrap();
        redact_deleted_meeting(&conn, "m1").unwrap();
        let after = get_message(&conn, m.id).unwrap().unwrap();
        assert_eq!(after.citations[0].title, "Deleted meeting");
        assert_eq!(after.citations[0].snippet, "");
        assert_eq!(after.citations[0].ref_id, "");
        assert_eq!(after.citations[0].start_ms, None);
        assert_eq!(after.citations[1].ref_id, "m2", "other citations stay");
        assert_eq!(after.context.unwrap().bars[0].title, "Deleted meeting");
        let raw: String = conn.query_row("SELECT citations_json || context_json FROM workspace_messages WHERE id = ?1", [m.id], |r| r.get(0)).unwrap();
        assert!(!raw.contains("the budget is 5k") && !raw.contains("Budget talk"));
    }

    #[test]
    fn moving_a_meeting_out_redacts_only_that_workspaces_chats() {
        let conn = memory_db();
        let a = new_ws(&conn, "A", false, false);
        let b = new_ws(&conn, "B", false, false);
        let ca = create_chat(&conn, &a, None, None, None).unwrap();
        let cb = create_chat(&conn, &b, None, None, None).unwrap();
        let r = report();
        for c in [&ca, &cb] {
            save_answer(&conn, &c.id, Answer { question: "q", text: "a", model: "x", citations: &[cite("m1")], context: &r, input_tokens: 0, output_tokens: 0, provenance: None }).unwrap();
        }
        redact_meeting_in_workspace(&conn, "m1", &a).unwrap();
        assert_eq!(list_messages(&conn, &ca.id).unwrap()[1].citations[0].title, "Deleted meeting");
        assert_eq!(list_messages(&conn, &cb.id).unwrap()[1].citations[0].title, "Budget talk");
    }
}
