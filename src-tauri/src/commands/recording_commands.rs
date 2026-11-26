use serde::Serialize;
use std::fs;
use tauri::{command, State};

use crate::audio::waveform::{downsample_waveform, WaveformData};
use crate::state::AppState;

/// Maximum waveform peaks returned to the frontend.
const MAX_WAVEFORM_PEAKS: usize = 4000;

#[derive(Debug, Serialize)]
pub struct RecordingInfo {
    pub path: String,
    pub size_bytes: i64,
    pub duration_ms: u64,
    pub waveform_path: String,
    pub offset_ms: i64,
    pub waveform_data: Option<WaveformData>,
}

/// Query recording metadata for a meeting.
/// Returns Some(RecordingInfo) only when all four recording columns are present.
/// Reads the waveform JSON file to extract duration_ms.
#[command]
pub async fn get_recording_info(
    meeting_id: String,
    state: State<'_, AppState>,
) -> Result<Option<RecordingInfo>, String> {
    let db = state
        .database
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let db = db
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))?;

    let conn = db.connection();

    let result: rusqlite::Result<(Option<String>, Option<i64>, Option<String>, Option<i64>)> =
        conn.query_row(
            "SELECT recording_path, recording_size, waveform_path, recording_offset_ms \
             FROM meetings WHERE id = ?1",
            rusqlite::params![meeting_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                ))
            },
        );

    match result {
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
        Err(e) => return Err(format!("Failed to query recording info: {}", e)),
        Ok((Some(path), Some(size_bytes), Some(waveform_path), Some(offset_ms))) => {
            // Read and parse the full waveform JSON (includes peaks + duration_ms)
            let waveform_json = fs::read_to_string(&waveform_path)
                .map_err(|e| format!("Failed to read waveform file: {}", e))?;

            let waveform_data: WaveformData = serde_json::from_str(&waveform_json)
                .map_err(|e| format!("Failed to parse waveform JSON: {}", e))?;

            let duration_ms = waveform_data.duration_ms;
            // Cap what crosses IPC: the canvas never needs more than this.
            let waveform_data = downsample_waveform(waveform_data, MAX_WAVEFORM_PEAKS);

            Ok(Some(RecordingInfo {
                path,
                size_bytes,
                duration_ms,
                waveform_path,
                offset_ms,
                waveform_data: Some(waveform_data),
            }))
        }
        Ok(_) => {
            // One or more fields are NULL — no complete recording yet
            Ok(None)
        }
    }
}

/// Return the absolute filesystem path of the recording file.
/// The frontend uses convertFileSrc() to convert this to a WebView-accessible URL.
#[command]
pub async fn get_recording_file_url(
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

    let conn = db.connection();

    let path: Option<String> = conn
        .query_row(
            "SELECT recording_path FROM meetings WHERE id = ?1",
            rusqlite::params![meeting_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to query recording path: {}", e))?;

    path.ok_or_else(|| format!("No recording found for meeting {}", meeting_id))
}

/// Delete recording and waveform files from disk and clear recording columns in DB.
#[command]
pub async fn delete_recording(
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

    let conn = db.connection();

    // Fetch paths before clearing
    let paths: (Option<String>, Option<String>) = conn
        .query_row(
            "SELECT recording_path, waveform_path FROM meetings WHERE id = ?1",
            rusqlite::params![meeting_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| format!("Failed to query recording paths: {}", e))?;

    // Delete files from disk, but only ones inside NexQ's recordings folder
    // (a path the database names elsewhere is never touched).
    let files: Vec<std::path::PathBuf> = [&paths.0, &paths.1].into_iter().flatten().map(std::path::PathBuf::from).collect();
    if let Some(dir) = crate::workspace::purge::recordings_dir() {
        crate::workspace::purge::delete_files_inside(&dir, &files);
    }

    // Clear all recording columns in DB
    conn.execute(
        "UPDATE meetings SET recording_path = NULL, recording_size = NULL, \
         waveform_path = NULL, recording_offset_ms = NULL WHERE id = ?1",
        rusqlite::params![meeting_id],
    )
    .map_err(|e| format!("Failed to clear recording columns: {}", e))?;

    Ok(())
}
