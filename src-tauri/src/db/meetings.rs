use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::DatabaseError;

// ── Data structures ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Meeting {
    pub id: String,
    pub title: String,
    pub start_time: String,
    pub end_time: Option<String>,
    pub duration_seconds: Option<i64>,
    pub transcript: serde_json::Value,
    pub ai_interactions: serde_json::Value,
    pub summary: Option<String>,
    pub config_snapshot: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub speakers: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub bookmarks: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub action_items: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub topic_sections: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub recording_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub recording_size: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub waveform_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub recording_offset_ms: Option<i64>,
    /// The workspace the meeting is filed in.
    #[serde(default = "general_workspace")]
    pub workspace_id: String,
}

fn general_workspace() -> String {
    "general".to_string()
}

/// Response struct that maps MeetingSpeaker back to frontend SpeakerIdentity format.
#[derive(Debug, Clone, Serialize)]
pub struct MeetingSpeakerResponse {
    pub id: String,           // This is speaker_id (e.g. "speaker_0"), NOT the record UUID
    pub display_name: String,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    pub stats: SpeakerStatsResponse,
}

#[derive(Debug, Clone, Serialize)]
pub struct SpeakerStatsResponse {
    pub segment_count: i64,
    pub word_count: i64,
    pub talk_time_ms: i64,
    pub last_spoke_ms: i64,
}

impl From<MeetingSpeaker> for MeetingSpeakerResponse {
    fn from(s: MeetingSpeaker) -> Self {
        MeetingSpeakerResponse {
            id: s.speaker_id,
            display_name: s.display_name,
            source: s.source,
            color: s.color,
            stats: SpeakerStatsResponse {
                segment_count: s.segment_count,
                word_count: s.word_count,
                talk_time_ms: s.talk_time_ms,
                last_spoke_ms: 0,
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingSummary {
    pub id: String,
    pub title: String,
    pub start_time: String,
    pub end_time: Option<String>,
    pub duration_seconds: Option<i64>,
    pub segment_count: i64,
    pub has_summary: bool,
    pub audio_mode: String,
    pub ai_scenario: String,
    /// The workspace the meeting is filed in.
    #[serde(default = "general_workspace")]
    pub workspace_id: String,
}

/// Fills in the workspace of each meeting (one indexed query), when workspaces
/// are available; otherwise they all stay in General.
fn fill_workspace_ids(conn: &Connection, items: &mut [MeetingSummary]) {
    if items.is_empty() || !super::workspace_migrations::available() {
        return;
    }
    let ids: Vec<&str> = items.iter().map(|m| m.id.as_str()).collect();
    let Ok(ids) = serde_json::to_string(&ids) else { return };
    let Ok(mut stmt) = conn.prepare(
        "SELECT id, workspace_id FROM meetings WHERE id IN (SELECT value FROM json_each(?1))",
    ) else {
        return;
    };
    let Ok(rows) = stmt.query_map(params![ids], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))) else {
        return;
    };
    let homes: std::collections::HashMap<String, String> = rows.filter_map(Result::ok).collect();
    for item in items {
        if let Some(home) = homes.get(&item.id) {
            item.workspace_id = home.clone();
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptSegment {
    pub id: String,
    pub meeting_id: String,
    pub text: String,
    pub speaker: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speaker_id: Option<String>,
    /// Diarization tag of a remote-party line ("S1"); `speaker` stays "Them".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker_tag: Option<String>,
    pub timestamp_ms: i64,
    pub is_final: bool,
    pub confidence: f64,
    pub created_at: String,
}

/// The `meeting_speakers` id under which a remote speaker tag's name is
/// kept ("them:S1").
pub fn remote_speaker_id(tag: &str) -> String {
    format!("them:{tag}")
}

/// Label of a remote speaker tag that was never renamed ("S2" → "Speaker 2").
pub fn default_remote_speaker_name(tag: &str) -> String {
    match tag.strip_prefix('S') {
        Some(n) if !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()) => format!("Speaker {n}"),
        _ => tag.to_string(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingUpdate {
    pub title: Option<String>,
    pub end_time: Option<String>,
    pub duration_seconds: Option<i64>,
    pub transcript: Option<serde_json::Value>,
    pub ai_interactions: Option<serde_json::Value>,
    pub summary: Option<String>,
    pub config_snapshot: Option<serde_json::Value>,
    pub recording_path: Option<String>,
    pub recording_size: Option<i64>,
    pub waveform_path: Option<String>,
    pub recording_offset_ms: Option<i64>,
}

// ── CRUD operations ──────────────────────────────────────────────────────────

/// Create a new meeting with a UUID and the current timestamp.
pub fn create_meeting(conn: &Connection, title: &str) -> Result<Meeting, DatabaseError> {
    let id = Uuid::new_v4().to_string();
    let start_time = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO meetings (id, title, start_time, transcript, ai_interactions)
         VALUES (?1, ?2, ?3, '[]', '[]')",
        params![id, title, start_time],
    )?;

    Ok(Meeting {
        id,
        title: title.to_string(),
        start_time,
        end_time: None,
        duration_seconds: None,
        transcript: serde_json::json!([]),
        ai_interactions: serde_json::json!([]),
        summary: None,
        config_snapshot: None,
        speakers: None,
        bookmarks: None,
        action_items: None,
        topic_sections: None,
        recording_path: None,
        recording_size: None,
        waveform_path: None,
        recording_offset_ms: None,
        workspace_id: general_workspace(),
    })
}

/// Get a single meeting by ID, with its transcript segments joined in.
pub fn get_meeting(conn: &Connection, id: &str) -> Result<Meeting, DatabaseError> {
    let mut stmt = conn.prepare(
        "SELECT id, title, start_time, end_time, duration_seconds,
                transcript, ai_interactions, summary, config_snapshot,
                recording_path, recording_size, waveform_path, recording_offset_ms
         FROM meetings WHERE id = ?1",
    )?;

    let meeting = stmt
        .query_row(params![id], |row| {
            let transcript_str: String = row.get(5)?;
            let ai_str: String = row.get(6)?;
            let summary: Option<String> = row.get(7)?;
            let config_str: Option<String> = row.get(8)?;

            Ok(Meeting {
                id: row.get(0)?,
                title: row.get(1)?,
                start_time: row.get(2)?,
                end_time: row.get(3)?,
                duration_seconds: row.get(4)?,
                transcript: serde_json::from_str(&transcript_str).unwrap_or(serde_json::json!([])),
                ai_interactions: serde_json::from_str(&ai_str).unwrap_or(serde_json::json!([])),
                summary,
                config_snapshot: config_str
                    .and_then(|s| serde_json::from_str(&s).ok()),
                speakers: None,
                bookmarks: None,
                action_items: None,
                topic_sections: None,
                recording_path: row.get(9)?,
                recording_size: row.get(10)?,
                waveform_path: row.get(11)?,
                recording_offset_ms: row.get(12)?,
                workspace_id: general_workspace(),
            })
        })
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                DatabaseError::NotFound(format!("Meeting {} not found", id))
            }
            other => DatabaseError::Query(other.to_string()),
        })?;

    // Also fetch and merge transcript segments into the transcript array
    let segments = list_transcript_segments(conn, id)?;
    let mut meeting = meeting;
    if super::workspace_migrations::available() {
        if let Ok(home) = conn.query_row("SELECT workspace_id FROM meetings WHERE id = ?1", params![id], |row| row.get(0)) {
            meeting.workspace_id = home;
        }
    }
    if !segments.is_empty() {
        meeting.transcript = serde_json::to_value(&segments).unwrap_or(serde_json::json!([]));
    }

    // Load feature tables
    let speakers = list_meeting_speakers(conn, id)?;
    if !speakers.is_empty() {
        let speaker_responses: Vec<MeetingSpeakerResponse> =
            speakers.into_iter().map(|s| s.into()).collect();
        meeting.speakers = Some(serde_json::to_value(&speaker_responses).unwrap_or(serde_json::json!([])));
    }

    let bookmarks = list_meeting_bookmarks(conn, id)?;
    if !bookmarks.is_empty() {
        meeting.bookmarks = Some(serde_json::to_value(&bookmarks).unwrap_or(serde_json::json!([])));
    }

    let action_items = list_meeting_action_items(conn, id)?;
    if !action_items.is_empty() {
        meeting.action_items = Some(serde_json::to_value(&action_items).unwrap_or(serde_json::json!([])));
    }

    let topic_sections = list_meeting_topic_sections(conn, id)?;
    if !topic_sections.is_empty() {
        meeting.topic_sections = Some(serde_json::to_value(&topic_sections).unwrap_or(serde_json::json!([])));
    }

    Ok(meeting)
}

/// List meetings with pagination, ordered by start_time descending.
pub fn list_meetings(
    conn: &Connection,
    limit: u32,
    offset: u32,
) -> Result<Vec<MeetingSummary>, DatabaseError> {
    let mut stmt = conn.prepare(
        "SELECT m.id, m.title, m.start_time, m.end_time, m.duration_seconds,
                (SELECT COUNT(*) FROM transcript_segments ts WHERE ts.meeting_id = m.id) AS segment_count,
                CASE WHEN m.summary IS NOT NULL AND m.summary != '' THEN 1 ELSE 0 END AS has_summary,
                m.audio_mode, m.ai_scenario
         FROM meetings m
         ORDER BY m.start_time DESC
         LIMIT ?1 OFFSET ?2",
    )?;

    let rows = stmt.query_map(params![limit, offset], |row| {
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
            workspace_id: general_workspace(),
        })
    })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    fill_workspace_ids(conn, &mut results);
    Ok(results)
}

/// Update specific fields of a meeting.
pub fn update_meeting(
    conn: &Connection,
    id: &str,
    updates: &MeetingUpdate,
) -> Result<(), DatabaseError> {
    // Build dynamic SET clause
    let mut sets: Vec<String> = Vec::new();
    let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(ref title) = updates.title {
        sets.push(format!("title = ?{}", sets.len() + 1));
        param_values.push(Box::new(title.clone()));
    }
    if let Some(ref end_time) = updates.end_time {
        sets.push(format!("end_time = ?{}", sets.len() + 1));
        param_values.push(Box::new(end_time.clone()));
    }
    if let Some(duration) = updates.duration_seconds {
        sets.push(format!("duration_seconds = ?{}", sets.len() + 1));
        param_values.push(Box::new(duration));
    }
    if let Some(ref transcript) = updates.transcript {
        sets.push(format!("transcript = ?{}", sets.len() + 1));
        param_values.push(Box::new(transcript.to_string()));
    }
    if let Some(ref ai) = updates.ai_interactions {
        sets.push(format!("ai_interactions = ?{}", sets.len() + 1));
        param_values.push(Box::new(ai.to_string()));
    }
    if let Some(ref summary) = updates.summary {
        sets.push(format!("summary = ?{}", sets.len() + 1));
        param_values.push(Box::new(summary.clone()));
    }
    if let Some(ref config) = updates.config_snapshot {
        sets.push(format!("config_snapshot = ?{}", sets.len() + 1));
        param_values.push(Box::new(config.to_string()));
    }
    if let Some(ref recording_path) = updates.recording_path {
        sets.push(format!("recording_path = ?{}", sets.len() + 1));
        param_values.push(Box::new(recording_path.clone()));
    }
    if let Some(recording_size) = updates.recording_size {
        sets.push(format!("recording_size = ?{}", sets.len() + 1));
        param_values.push(Box::new(recording_size));
    }
    if let Some(ref waveform_path) = updates.waveform_path {
        sets.push(format!("waveform_path = ?{}", sets.len() + 1));
        param_values.push(Box::new(waveform_path.clone()));
    }
    if let Some(recording_offset_ms) = updates.recording_offset_ms {
        sets.push(format!("recording_offset_ms = ?{}", sets.len() + 1));
        param_values.push(Box::new(recording_offset_ms));
    }

    if sets.is_empty() {
        return Ok(());
    }

    // Add the id as the last parameter
    let id_param_idx = sets.len() + 1;
    let sql = format!(
        "UPDATE meetings SET {} WHERE id = ?{}",
        sets.join(", "),
        id_param_idx
    );
    param_values.push(Box::new(id.to_string()));

    let param_refs: Vec<&dyn rusqlite::types::ToSql> =
        param_values.iter().map(|p| p.as_ref()).collect();

    let rows_affected = conn.execute(&sql, param_refs.as_slice())?;
    if rows_affected == 0 {
        return Err(DatabaseError::NotFound(format!(
            "Meeting {} not found",
            id
        )));
    }

    Ok(())
}

/// Update recording-related fields on a meeting after post-processing completes.
pub fn update_meeting_recording(
    conn: &Connection,
    id: &str,
    recording_path: &str,
    recording_size: i64,
    waveform_path: &str,
    recording_offset_ms: i64,
) -> Result<(), DatabaseError> {
    let rows = conn.execute(
        "UPDATE meetings SET recording_path = ?1, recording_size = ?2, waveform_path = ?3, recording_offset_ms = ?4 WHERE id = ?5",
        params![recording_path, recording_size, waveform_path, recording_offset_ms, id],
    )?;

    if rows == 0 {
        return Err(DatabaseError::NotFound(format!(
            "Meeting {} not found",
            id
        )));
    }

    Ok(())
}

/// Delete a meeting and all its related data (feature tables + segments).
pub fn delete_meeting(conn: &Connection, id: &str) -> Result<(), DatabaseError> {
    // Delete from feature tables first
    conn.execute("DELETE FROM meeting_speakers WHERE meeting_id = ?1", params![id])?;
    conn.execute("DELETE FROM meeting_bookmarks WHERE meeting_id = ?1", params![id])?;
    conn.execute("DELETE FROM meeting_action_items WHERE meeting_id = ?1", params![id])?;
    conn.execute("DELETE FROM meeting_topic_sections WHERE meeting_id = ?1", params![id])?;
    super::meeting_chat::delete_chat_messages(conn, id)?;
    // Cached translations of the transcript go with it.
    super::translation::delete_meeting_translations(conn, id)?;

    // Then existing deletes (segments + meeting)
    conn.execute(
        "DELETE FROM transcript_segments WHERE meeting_id = ?1",
        params![id],
    )?;

    let rows = conn.execute("DELETE FROM meetings WHERE id = ?1", params![id])?;
    if rows == 0 {
        return Err(DatabaseError::NotFound(format!(
            "Meeting {} not found",
            id
        )));
    }

    Ok(())
}

/// Search meetings by title and transcript segment text.
pub fn search_meetings(
    conn: &Connection,
    query: &str,
) -> Result<Vec<MeetingSummary>, DatabaseError> {
    let search_pattern = format!("%{}%", query);

    let mut stmt = conn.prepare(
        "SELECT DISTINCT m.id, m.title, m.start_time, m.end_time, m.duration_seconds,
                (SELECT COUNT(*) FROM transcript_segments ts WHERE ts.meeting_id = m.id) AS segment_count,
                CASE WHEN m.summary IS NOT NULL AND m.summary != '' THEN 1 ELSE 0 END AS has_summary,
                m.audio_mode, m.ai_scenario
         FROM meetings m
         LEFT JOIN transcript_segments ts ON ts.meeting_id = m.id
         WHERE m.title LIKE ?1
            OR ts.text LIKE ?1
            OR m.summary LIKE ?1
         ORDER BY m.start_time DESC
         LIMIT 50",
    )?;

    let rows = stmt.query_map(params![search_pattern], |row| {
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
            workspace_id: general_workspace(),
        })
    })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    fill_workspace_ids(conn, &mut results);
    Ok(results)
}

/// Append a single transcript segment (used for incremental 30s saves).
pub fn append_transcript_segment(
    conn: &Connection,
    meeting_id: &str,
    segment: &TranscriptSegment,
) -> Result<(), DatabaseError> {
    conn.execute(
        "INSERT OR REPLACE INTO transcript_segments
            (id, meeting_id, text, speaker, speaker_id, timestamp_ms, is_final, confidence, created_at, speaker_tag)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            segment.id,
            meeting_id,
            segment.text,
            segment.speaker,
            segment.speaker_id,
            segment.timestamp_ms,
            segment.is_final,
            segment.confidence,
            segment.created_at,
            segment.speaker_tag,
        ],
    )?;

    Ok(())
}

/// List all transcript segments for a given meeting, ordered by timestamp.
fn list_transcript_segments(
    conn: &Connection,
    meeting_id: &str,
) -> Result<Vec<TranscriptSegment>, DatabaseError> {
    let mut stmt = conn.prepare(
        "SELECT id, meeting_id, text, speaker, speaker_id, timestamp_ms, is_final, confidence, created_at, speaker_tag
         FROM transcript_segments
         WHERE meeting_id = ?1
         ORDER BY timestamp_ms ASC",
    )?;

    let rows = stmt.query_map(params![meeting_id], |row| {
        Ok(TranscriptSegment {
            id: row.get(0)?,
            meeting_id: row.get(1)?,
            text: row.get(2)?,
            speaker: row.get(3)?,
            speaker_id: row.get(4)?,
            timestamp_ms: row.get(5)?,
            is_final: row.get(6)?,
            confidence: row.get(7)?,
            created_at: row.get(8)?,
            speaker_tag: row.get(9)?,
        })
    })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

// ── Meeting speakers CRUD ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingSpeaker {
    pub id: String,
    pub meeting_id: String,
    pub speaker_id: String,
    pub display_name: String,
    pub source: String,
    pub color: Option<String>,
    pub segment_count: i64,
    pub word_count: i64,
    pub talk_time_ms: i64,
}

/// Replace all speakers for a meeting (delete + insert).
pub fn save_meeting_speakers(
    conn: &Connection,
    meeting_id: &str,
    speakers: &[MeetingSpeaker],
) -> Result<(), DatabaseError> {
    conn.execute(
        "DELETE FROM meeting_speakers WHERE meeting_id = ?1",
        params![meeting_id],
    )?;

    let mut stmt = conn.prepare(
        "INSERT INTO meeting_speakers
            (id, meeting_id, speaker_id, display_name, source, color, segment_count, word_count, talk_time_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
    )?;

    for s in speakers {
        stmt.execute(params![
            s.id,
            meeting_id,
            s.speaker_id,
            s.display_name,
            s.source,
            s.color,
            s.segment_count,
            s.word_count,
            s.talk_time_ms,
        ])?;
    }

    Ok(())
}

/// Rename a single speaker within a meeting. A remote speaker tag
/// ("them:S1") that has no row yet gets one, so its name persists.
pub fn rename_speaker(
    conn: &Connection,
    meeting_id: &str,
    speaker_id: &str,
    new_name: &str,
) -> Result<(), DatabaseError> {
    let updated = conn.execute(
        "UPDATE meeting_speakers SET display_name = ?1 WHERE meeting_id = ?2 AND speaker_id = ?3",
        params![new_name, meeting_id, speaker_id],
    )?;
    if updated == 0 && speaker_id.starts_with("them:") {
        conn.execute(
            "INSERT INTO meeting_speakers (id, meeting_id, speaker_id, display_name, source)
             VALUES (?1, ?2, ?3, ?4, 'remote_tag')",
            params![Uuid::new_v4().to_string(), meeting_id, speaker_id, new_name],
        )?;
    }
    Ok(())
}

/// List all speakers for a given meeting.
pub fn list_meeting_speakers(
    conn: &Connection,
    meeting_id: &str,
) -> Result<Vec<MeetingSpeaker>, DatabaseError> {
    let mut stmt = conn.prepare(
        "SELECT id, meeting_id, speaker_id, display_name, source, color, segment_count, word_count, talk_time_ms
         FROM meeting_speakers WHERE meeting_id = ?1",
    )?;

    let rows = stmt.query_map(params![meeting_id], |row| {
        Ok(MeetingSpeaker {
            id: row.get(0)?,
            meeting_id: row.get(1)?,
            speaker_id: row.get(2)?,
            display_name: row.get(3)?,
            source: row.get(4)?,
            color: row.get(5)?,
            segment_count: row.get(6)?,
            word_count: row.get(7)?,
            talk_time_ms: row.get(8)?,
        })
    })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

// ── Meeting bookmarks CRUD ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingBookmark {
    pub id: String,
    pub meeting_id: String,
    pub timestamp_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub segment_id: Option<String>,
    pub note: Option<String>,
    pub created_at: String,
}

/// Replace all bookmarks for a meeting (delete + insert).
pub fn save_meeting_bookmarks(
    conn: &Connection,
    meeting_id: &str,
    bookmarks: &[MeetingBookmark],
) -> Result<(), DatabaseError> {
    conn.execute(
        "DELETE FROM meeting_bookmarks WHERE meeting_id = ?1",
        params![meeting_id],
    )?;

    let mut stmt = conn.prepare(
        "INSERT INTO meeting_bookmarks (id, meeting_id, timestamp_ms, segment_id, note, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )?;

    for b in bookmarks {
        stmt.execute(params![
            b.id,
            meeting_id,
            b.timestamp_ms,
            b.segment_id,
            b.note,
            b.created_at,
        ])?;
    }

    Ok(())
}

/// List all bookmarks for a given meeting, ordered by timestamp.
pub fn list_meeting_bookmarks(
    conn: &Connection,
    meeting_id: &str,
) -> Result<Vec<MeetingBookmark>, DatabaseError> {
    let mut stmt = conn.prepare(
        "SELECT id, meeting_id, timestamp_ms, segment_id, note, created_at
         FROM meeting_bookmarks WHERE meeting_id = ?1 ORDER BY timestamp_ms ASC",
    )?;

    let rows = stmt.query_map(params![meeting_id], |row| {
        Ok(MeetingBookmark {
            id: row.get(0)?,
            meeting_id: row.get(1)?,
            timestamp_ms: row.get(2)?,
            segment_id: row.get(3)?,
            note: row.get(4)?,
            created_at: row.get(5)?,
        })
    })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

/// Add a single bookmark to a meeting.
pub fn add_meeting_bookmark(
    conn: &Connection,
    bookmark: &MeetingBookmark,
) -> Result<(), DatabaseError> {
    conn.execute(
        "INSERT INTO meeting_bookmarks (id, meeting_id, timestamp_ms, segment_id, note, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            bookmark.id,
            bookmark.meeting_id,
            bookmark.timestamp_ms,
            bookmark.segment_id,
            bookmark.note,
            bookmark.created_at,
        ],
    )?;
    Ok(())
}

/// Update a bookmark's note.
pub fn update_meeting_bookmark_note(
    conn: &Connection,
    bookmark_id: &str,
    note: Option<&str>,
) -> Result<(), DatabaseError> {
    conn.execute(
        "UPDATE meeting_bookmarks SET note = ?1 WHERE id = ?2",
        params![note, bookmark_id],
    )?;
    Ok(())
}

/// Delete a single bookmark.
pub fn delete_meeting_bookmark(
    conn: &Connection,
    bookmark_id: &str,
) -> Result<(), DatabaseError> {
    conn.execute(
        "DELETE FROM meeting_bookmarks WHERE id = ?1",
        params![bookmark_id],
    )?;
    Ok(())
}

// ── Meeting action items CRUD ───────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingActionItem {
    pub id: String,
    pub meeting_id: String,
    pub text: String,
    pub assignee_speaker_id: Option<String>,
    pub timestamp_ms: i64,
    pub completed: bool,
}

/// Replace all action items for a meeting (delete + insert).
pub fn save_meeting_action_items(
    conn: &Connection,
    meeting_id: &str,
    items: &[MeetingActionItem],
) -> Result<(), DatabaseError> {
    conn.execute(
        "DELETE FROM meeting_action_items WHERE meeting_id = ?1",
        params![meeting_id],
    )?;

    let mut stmt = conn.prepare(
        "INSERT INTO meeting_action_items (id, meeting_id, text, assignee_speaker_id, timestamp_ms, completed)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )?;

    for item in items {
        stmt.execute(params![
            item.id,
            meeting_id,
            item.text,
            item.assignee_speaker_id,
            item.timestamp_ms,
            item.completed as i32,
        ])?;
    }

    Ok(())
}

/// List all action items for a given meeting, ordered by timestamp.
pub fn list_meeting_action_items(
    conn: &Connection,
    meeting_id: &str,
) -> Result<Vec<MeetingActionItem>, DatabaseError> {
    let mut stmt = conn.prepare(
        "SELECT id, meeting_id, text, assignee_speaker_id, timestamp_ms, completed
         FROM meeting_action_items WHERE meeting_id = ?1 ORDER BY timestamp_ms ASC",
    )?;

    let rows = stmt.query_map(params![meeting_id], |row| {
        Ok(MeetingActionItem {
            id: row.get(0)?,
            meeting_id: row.get(1)?,
            text: row.get(2)?,
            assignee_speaker_id: row.get(3)?,
            timestamp_ms: row.get(4)?,
            completed: row.get(5)?,
        })
    })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

/// Update completion status of a single action item.
pub fn update_action_item_completed(
    conn: &Connection,
    item_id: &str,
    completed: bool,
) -> Result<(), DatabaseError> {
    conn.execute(
        "UPDATE meeting_action_items SET completed = ?1 WHERE id = ?2",
        params![completed as i32, item_id],
    )?;
    Ok(())
}

/// Delete a single action item.
pub fn delete_action_item(
    conn: &Connection,
    item_id: &str,
) -> Result<(), DatabaseError> {
    conn.execute(
        "DELETE FROM meeting_action_items WHERE id = ?1",
        params![item_id],
    )?;
    Ok(())
}

// ── Meeting topic sections CRUD ─────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingTopicSection {
    pub id: String,
    pub meeting_id: String,
    pub title: String,
    pub start_ms: i64,
    pub end_ms: Option<i64>,
}

/// Replace all topic sections for a meeting (delete + insert).
pub fn save_meeting_topic_sections(
    conn: &Connection,
    meeting_id: &str,
    sections: &[MeetingTopicSection],
) -> Result<(), DatabaseError> {
    conn.execute(
        "DELETE FROM meeting_topic_sections WHERE meeting_id = ?1",
        params![meeting_id],
    )?;

    let mut stmt = conn.prepare(
        "INSERT INTO meeting_topic_sections (id, meeting_id, title, start_ms, end_ms)
         VALUES (?1, ?2, ?3, ?4, ?5)",
    )?;

    for sec in sections {
        stmt.execute(params![
            sec.id,
            meeting_id,
            sec.title,
            sec.start_ms,
            sec.end_ms,
        ])?;
    }

    Ok(())
}

/// List all topic sections for a given meeting, ordered by start time.
pub fn list_meeting_topic_sections(
    conn: &Connection,
    meeting_id: &str,
) -> Result<Vec<MeetingTopicSection>, DatabaseError> {
    let mut stmt = conn.prepare(
        "SELECT id, meeting_id, title, start_ms, end_ms
         FROM meeting_topic_sections WHERE meeting_id = ?1 ORDER BY start_ms ASC",
    )?;

    let rows = stmt.query_map(params![meeting_id], |row| {
        Ok(MeetingTopicSection {
            id: row.get(0)?,
            meeting_id: row.get(1)?,
            title: row.get(2)?,
            start_ms: row.get(3)?,
            end_ms: row.get(4)?,
        })
    })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrations::run(&conn).unwrap();
        conn
    }

    fn segment(meeting_id: &str, id: &str, text: &str, tag: Option<&str>, ts: i64) -> TranscriptSegment {
        TranscriptSegment {
            id: id.into(),
            meeting_id: meeting_id.into(),
            text: text.into(),
            speaker: "Them".into(),
            speaker_id: Some("them".into()),
            speaker_tag: tag.map(str::to_string),
            timestamp_ms: ts,
            is_final: true,
            confidence: 0.9,
            created_at: "2026-10-22T10:00:00Z".into(),
        }
    }

    #[test]
    fn segments_keep_speaker_tag_and_latest_text() {
        let conn = db();
        migrations::run(&conn).unwrap(); // the v8 column migration is idempotent
        let meeting = create_meeting(&conn, "Sync").unwrap();
        append_transcript_segment(&conn, &meeting.id, &segment(&meeting.id, "p1", "We ship", Some("S2"), 1)).unwrap();
        append_transcript_segment(&conn, &meeting.id, &segment(&meeting.id, "p2", "Ok", None, 2)).unwrap();
        // The paragraph grew after it was first saved: saving it again replaces it.
        append_transcript_segment(&conn, &meeting.id, &segment(&meeting.id, "p1", "We ship on Friday", Some("S2"), 1)).unwrap();

        let loaded = list_transcript_segments(&conn, &meeting.id).unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!((loaded[0].text.as_str(), loaded[0].speaker_tag.as_deref()), ("We ship on Friday", Some("S2")));
        assert_eq!(loaded[1].speaker_tag, None);
        let json = get_meeting(&conn, &meeting.id).unwrap().transcript;
        assert_eq!(json[0]["speaker_tag"], "S2");
        assert!(json[1].get("speaker_tag").is_none(), "untagged lines omit the field");
    }

    #[test]
    fn renaming_a_remote_tag_creates_its_speaker_row_once() {
        let conn = db();
        let meeting = create_meeting(&conn, "Sync").unwrap();
        rename_speaker(&conn, &meeting.id, &remote_speaker_id("S1"), "Erin").unwrap();
        rename_speaker(&conn, &meeting.id, &remote_speaker_id("S1"), "Erin K").unwrap();
        // Other speakers are only renamed when they exist.
        rename_speaker(&conn, &meeting.id, "speaker_3", "Nobody").unwrap();
        let speakers = list_meeting_speakers(&conn, &meeting.id).unwrap();
        assert_eq!(speakers.len(), 1);
        assert_eq!(
            (speakers[0].speaker_id.as_str(), speakers[0].display_name.as_str(), speakers[0].source.as_str()),
            ("them:S1", "Erin K", "remote_tag")
        );
    }

    #[test]
    fn default_remote_speaker_names() {
        assert_eq!(default_remote_speaker_name("S1"), "Speaker 1");
        assert_eq!(default_remote_speaker_name("S12"), "Speaker 12");
        assert_eq!(default_remote_speaker_name("X"), "X");
    }
}
