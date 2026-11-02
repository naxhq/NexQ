// src-tauri/src/db/translation.rs
use rusqlite::{params, Connection};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct TranslationRow {
    pub id: String,
    pub segment_id: String,
    pub meeting_id: String,
    pub source_lang: String,
    pub target_lang: String,
    pub original_text: String,
    pub translated_text: String,
    pub provider: String,
    pub created_at: String,
}

/// Upsert a translation (insert or replace if segment+lang already exists).
pub fn save_translation(
    conn: &Connection,
    segment_id: &str,
    meeting_id: &str,
    source_lang: &str,
    target_lang: &str,
    original_text: &str,
    translated_text: &str,
    provider: &str,
) -> Result<String, rusqlite::Error> {
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO transcript_translations (id, segment_id, meeting_id, source_lang, target_lang, original_text, translated_text, provider)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(segment_id, target_lang) DO UPDATE SET
            original_text = excluded.original_text,
            translated_text = excluded.translated_text,
            provider = excluded.provider,
            source_lang = excluded.source_lang,
            created_at = datetime('now')",
        params![id, segment_id, meeting_id, source_lang, target_lang, original_text, translated_text, provider],
    )?;
    Ok(id)
}

/// Load all translations for a meeting + target language.
pub fn get_meeting_translations(
    conn: &Connection,
    meeting_id: &str,
    target_lang: &str,
) -> Result<Vec<TranslationRow>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, segment_id, meeting_id, source_lang, target_lang, original_text, translated_text, provider, created_at
         FROM transcript_translations
         WHERE meeting_id = ?1 AND target_lang = ?2",
    )?;
    let rows = stmt
        .query_map(params![meeting_id, target_lang], |row| {
            Ok(TranslationRow {
                id: row.get(0)?,
                segment_id: row.get(1)?,
                meeting_id: row.get(2)?,
                source_lang: row.get(3)?,
                target_lang: row.get(4)?,
                original_text: row.get(5)?,
                translated_text: row.get(6)?,
                provider: row.get(7)?,
                created_at: row.get(8)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Load ALL translations for a meeting (all languages).
pub fn get_all_meeting_translations(
    conn: &Connection,
    meeting_id: &str,
) -> Result<Vec<TranslationRow>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, segment_id, meeting_id, source_lang, target_lang, original_text, translated_text, provider, created_at
         FROM transcript_translations
         WHERE meeting_id = ?1
         ORDER BY created_at DESC",
    )?;
    let rows = stmt
        .query_map(params![meeting_id], |row| {
            Ok(TranslationRow {
                id: row.get(0)?,
                segment_id: row.get(1)?,
                meeting_id: row.get(2)?,
                source_lang: row.get(3)?,
                target_lang: row.get(4)?,
                original_text: row.get(5)?,
                translated_text: row.get(6)?,
                provider: row.get(7)?,
                created_at: row.get(8)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Get a single segment's translation.
pub fn get_segment_translation(
    conn: &Connection,
    segment_id: &str,
    target_lang: &str,
) -> Result<Option<TranslationRow>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, segment_id, meeting_id, source_lang, target_lang, original_text, translated_text, provider, created_at
         FROM transcript_translations
         WHERE segment_id = ?1 AND target_lang = ?2",
    )?;
    let mut rows = stmt.query_map(params![segment_id, target_lang], |row| {
        Ok(TranslationRow {
            id: row.get(0)?,
            segment_id: row.get(1)?,
            meeting_id: row.get(2)?,
            source_lang: row.get(3)?,
            target_lang: row.get(4)?,
            original_text: row.get(5)?,
            translated_text: row.get(6)?,
            provider: row.get(7)?,
            created_at: row.get(8)?,
        })
    })?;
    Ok(rows.next().transpose()?)
}

/// Delete all translations for a meeting.
pub fn delete_meeting_translations(
    conn: &Connection,
    meeting_id: &str,
) -> Result<usize, rusqlite::Error> {
    conn.execute(
        "DELETE FROM transcript_translations WHERE meeting_id = ?1",
        params![meeting_id],
    )
}

/// Count translations for a meeting + language (for progress tracking).
pub fn count_meeting_translations(
    conn: &Connection,
    meeting_id: &str,
    target_lang: &str,
) -> Result<usize, rusqlite::Error> {
    conn.query_row(
        "SELECT COUNT(*) FROM transcript_translations WHERE meeting_id = ?1 AND target_lang = ?2",
        params![meeting_id, target_lang],
        |row| row.get::<_, i64>(0),
    )
    .map(|count| count as usize)
}
