use tauri::{command, AppHandle, State};

use crate::db::meetings::{
    self, MeetingActionItem, MeetingBookmark, MeetingSpeaker, MeetingTopicSection,
    MeetingUpdate, TranscriptSegment,
};
use crate::state::AppState;

#[command]
pub async fn save_meeting_ai_interactions(
    meeting_id: String,
    ai_interactions_json: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;

    let ai_interactions: serde_json::Value = serde_json::from_str(&ai_interactions_json)
        .map_err(|e| format!("Failed to parse AI interactions: {}", e))?;

    let update = MeetingUpdate {
        title: None,
        end_time: None,
        duration_seconds: None,
        transcript: None,
        ai_interactions: Some(ai_interactions),
        summary: None,
        config_snapshot: None,
        recording_path: None,
        recording_size: None,
        waveform_path: None,
        recording_offset_ms: None,
    };

    meetings::update_meeting(db.connection(), &meeting_id, &update)
        .map_err(|e| format!("Failed to save AI interactions: {}", e))
}

#[command]
pub async fn start_meeting(
    title: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;

    let title = title.unwrap_or_else(|| {
        format!(
            "Meeting {}",
            chrono::Local::now().format("%Y-%m-%d %H:%M")
        )
    });

    let meeting = meetings::create_meeting(db.connection(), &title)
        .map_err(|e| format!("Failed to create meeting: {}", e))?;

    // Clear per-meeting state so the new meeting starts fresh.
    // The intelligence buffer and last detected question persist across
    // meetings otherwise, leaking the previous meeting's transcript into
    // the first AI call of the new meeting.
    drop(db); // release DB lock before acquiring other locks
    if let Some(intel_arc) = state.intelligence.as_ref() {
        if let Ok(mut engine) = intel_arc.lock() {
            engine.clear_session();
        }
    }
    if let Some(rag_arc) = state.rag.as_ref() {
        if let Ok(mut rag_mgr) = rag_arc.lock() {
            if let Some(indexer) = rag_mgr.transcript_indexer_mut() {
                indexer.reset();
            }
        }
    }

    serde_json::to_string(&meeting).map_err(|e| format!("Failed to serialize meeting: {}", e))
}

#[command]
pub async fn end_meeting(
    meeting_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let db_arc = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?
        .clone();

    let (meeting_start_time, end_time, duration_seconds) = {
        let db = db_arc
            .lock()
            .map_err(|e| format!("Failed to lock database: {}", e))?;

        // Get the meeting to calculate duration + extract start_time for offset calc
        let meeting = meetings::get_meeting(db.connection(), &meeting_id)
            .map_err(|e| format!("Failed to get meeting: {}", e))?;

        let end_time = chrono::Utc::now().to_rfc3339();

        // Calculate duration
        let duration_seconds = chrono::DateTime::parse_from_rfc3339(&end_time)
            .ok()
            .and_then(|end| {
                chrono::DateTime::parse_from_rfc3339(&meeting.start_time)
                    .ok()
                    .map(|start| (end - start).num_seconds())
            });

        let update = MeetingUpdate {
            title: None,
            end_time: Some(end_time.clone()),
            duration_seconds,
            transcript: None,
            ai_interactions: None,
            summary: None,
            config_snapshot: None,
            recording_path: None,
            recording_size: None,
            waveform_path: None,
            recording_offset_ms: None,
        };

        meetings::update_meeting(db.connection(), &meeting_id, &update)
            .map_err(|e| format!("Failed to end meeting: {}", e))?;

        (meeting.start_time, end_time, duration_seconds)
    };

    // ── Post-meeting recording pipeline ───────────────────────────────────────
    // Take the pending recording info stored by stop_capture (if any).
    // This is populated when recording_enabled was true for this meeting.
    let pending = {
        let mut lock = state
            .pending_recording
            .lock()
            .map_err(|_| "Pending recording lock poisoned".to_string())?;
        lock.take()
    };

    if let Some(recording) = pending {
        // Calculate offset: how many ms into the meeting did recording start?
        // meeting_start_epoch_ms is parsed from the ISO 8601 start_time.
        let recording_offset_ms: i64 = chrono::DateTime::parse_from_rfc3339(&meeting_start_time)
            .ok()
            .map(|start| {
                let start_ms = start.timestamp_millis();
                recording.start_time_ms as i64 - start_ms
            })
            .unwrap_or(0)
            .max(0); // clamp to 0 if recording started before the meeting (shouldn't happen)

        log::info!(
            "Spawning post-meeting pipeline for meeting {} (offset={}ms)",
            meeting_id,
            recording_offset_ms
        );

        // Spawn the pipeline — don't await, return the IPC response immediately
        tokio::spawn(crate::audio::process_recording(
            recording.wav_path,
            meeting_id,
            recording_offset_ms,
            db_arc,
            app,
        ));
    } else {
        log::info!(
            "Meeting {} ended with no pending recording (recording not enabled or already consumed)",
            meeting_id
        );
    }

    let _ = (end_time, duration_seconds); // suppress unused warnings
    Ok(())
}

#[command]
pub async fn list_meetings(
    limit: Option<u32>,
    offset: Option<u32>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;

    let limit = limit.unwrap_or(50);
    let offset = offset.unwrap_or(0);

    let summaries = meetings::list_meetings(db.connection(), limit, offset)
        .map_err(|e| format!("Failed to list meetings: {}", e))?;

    serde_json::to_string(&summaries).map_err(|e| format!("Failed to serialize meetings: {}", e))
}

#[command]
pub async fn get_meeting(
    meeting_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;

    let meeting = meetings::get_meeting(db.connection(), &meeting_id)
        .map_err(|e| format!("Failed to get meeting: {}", e))?;

    serde_json::to_string(&meeting).map_err(|e| format!("Failed to serialize meeting: {}", e))
}

#[command]
pub async fn delete_meeting(
    meeting_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;

    meetings::delete_meeting(db.connection(), &meeting_id)
        .map_err(|e| format!("Failed to delete meeting: {}", e))
}

#[command]
pub async fn search_meetings(
    query: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;

    let results = meetings::search_meetings(db.connection(), &query)
        .map_err(|e| format!("Failed to search meetings: {}", e))?;

    serde_json::to_string(&results).map_err(|e| format!("Failed to serialize results: {}", e))
}

#[command]
pub async fn rename_meeting(
    meeting_id: String,
    new_title: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;

    let update = MeetingUpdate {
        title: Some(new_title),
        end_time: None,
        duration_seconds: None,
        transcript: None,
        ai_interactions: None,
        summary: None,
        config_snapshot: None,
        recording_path: None,
        recording_size: None,
        waveform_path: None,
        recording_offset_ms: None,
    };

    meetings::update_meeting(db.connection(), &meeting_id, &update)
        .map_err(|e| format!("Failed to rename meeting: {}", e))
}

#[command]
pub async fn update_meeting_summary(
    meeting_id: String,
    summary: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;

    let update = MeetingUpdate {
        title: None,
        end_time: None,
        duration_seconds: None,
        transcript: None,
        ai_interactions: None,
        summary: Some(summary),
        config_snapshot: None,
        recording_path: None,
        recording_size: None,
        waveform_path: None,
        recording_offset_ms: None,
    };

    meetings::update_meeting(db.connection(), &meeting_id, &update)
        .map_err(|e| format!("Failed to update meeting summary: {}", e))
}

#[command]
pub async fn append_transcript_segment(
    meeting_id: String,
    segment: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;

    // Parse the frontend segment (which may lack meeting_id and created_at)
    let partial: serde_json::Value = serde_json::from_str(&segment)
        .map_err(|e| format!("Failed to parse transcript segment: {}", e))?;

    let full_segment = TranscriptSegment {
        id: partial["id"].as_str().unwrap_or("unknown").to_string(),
        meeting_id: meeting_id.clone(),
        text: partial["text"].as_str().unwrap_or("").to_string(),
        speaker: partial["speaker"].as_str().unwrap_or("Unknown").to_string(),
        speaker_id: partial["speaker_id"].as_str().map(|s| s.to_string()),
        timestamp_ms: partial["timestamp_ms"].as_i64().unwrap_or(0),
        is_final: partial["is_final"].as_bool().unwrap_or(true),
        confidence: partial["confidence"].as_f64().unwrap_or(0.0),
        created_at: chrono::Utc::now().to_rfc3339(),
    };

    meetings::append_transcript_segment(db.connection(), &meeting_id, &full_segment)
        .map_err(|e| format!("Failed to append transcript segment: {}", e))
}

// ── In-person meeting mode commands ─────────────────────────────────────────

#[command]
pub async fn save_meeting_speakers(
    meeting_id: String,
    speakers_json: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;

    let speakers: Vec<MeetingSpeaker> = serde_json::from_str(&speakers_json)
        .map_err(|e| format!("Failed to parse speakers JSON: {}", e))?;

    meetings::save_meeting_speakers(db.connection(), &meeting_id, &speakers)
        .map_err(|e| format!("Failed to save meeting speakers: {}", e))
}

#[command]
pub async fn save_meeting_bookmarks(
    meeting_id: String,
    bookmarks_json: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;

    let bookmarks: Vec<MeetingBookmark> = serde_json::from_str(&bookmarks_json)
        .map_err(|e| format!("Failed to parse bookmarks JSON: {}", e))?;

    meetings::save_meeting_bookmarks(db.connection(), &meeting_id, &bookmarks)
        .map_err(|e| format!("Failed to save meeting bookmarks: {}", e))
}

#[command]
pub async fn add_meeting_bookmark(
    bookmark_json: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;

    let bookmark: MeetingBookmark = serde_json::from_str(&bookmark_json)
        .map_err(|e| format!("Failed to parse bookmark JSON: {}", e))?;

    meetings::add_meeting_bookmark(db.connection(), &bookmark)
        .map_err(|e| format!("Failed to add bookmark: {}", e))
}

#[command]
pub async fn update_meeting_bookmark(
    bookmark_id: String,
    note: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;

    meetings::update_meeting_bookmark_note(db.connection(), &bookmark_id, note.as_deref())
        .map_err(|e| format!("Failed to update bookmark: {}", e))
}

#[command]
pub async fn delete_meeting_bookmark(
    bookmark_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;

    meetings::delete_meeting_bookmark(db.connection(), &bookmark_id)
        .map_err(|e| format!("Failed to delete bookmark: {}", e))
}

#[command]
pub async fn save_meeting_action_items(
    meeting_id: String,
    items_json: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;

    let items: Vec<MeetingActionItem> = serde_json::from_str(&items_json)
        .map_err(|e| format!("Failed to parse action items JSON: {}", e))?;

    meetings::save_meeting_action_items(db.connection(), &meeting_id, &items)
        .map_err(|e| format!("Failed to save meeting action items: {}", e))
}

#[command]
pub async fn update_action_item(
    item_id: String,
    completed: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;

    meetings::update_action_item_completed(db.connection(), &item_id, completed)
        .map_err(|e| format!("Failed to update action item: {}", e))
}

#[command]
pub async fn delete_action_item(
    item_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;

    meetings::delete_action_item(db.connection(), &item_id)
        .map_err(|e| format!("Failed to delete action item: {}", e))
}

#[command]
pub async fn save_meeting_topic_sections(
    meeting_id: String,
    sections_json: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;

    let sections: Vec<MeetingTopicSection> = serde_json::from_str(&sections_json)
        .map_err(|e| format!("Failed to parse topic sections JSON: {}", e))?;

    meetings::save_meeting_topic_sections(db.connection(), &meeting_id, &sections)
        .map_err(|e| format!("Failed to save meeting topic sections: {}", e))
}

#[command]
pub async fn update_meeting_mode(
    meeting_id: String,
    audio_mode: String,
    ai_scenario: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;

    db.connection()
        .execute(
            "UPDATE meetings SET audio_mode = ?1, ai_scenario = ?2 WHERE id = ?3",
            rusqlite::params![audio_mode, ai_scenario, meeting_id],
        )
        .map_err(|e| format!("Failed to update meeting mode: {}", e))?;

    Ok(())
}

#[command]
pub async fn rename_speaker(
    meeting_id: String,
    speaker_id: String,
    new_name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;

    meetings::rename_speaker(db.connection(), &meeting_id, &speaker_id, &new_name)
        .map_err(|e| format!("Failed to rename speaker: {}", e))
}
