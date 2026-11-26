use rusqlite::{params, Connection};
use serde::Serialize;

/// A chunk record for batch insertion.
///
/// Used by both the file indexer (RagManager::index_file) and the
/// transcript indexer (TranscriptIndexer::flush).
pub struct ChunkRecord {
    pub chunk_id: String,
    pub file_id: String,
    pub chunk_index: i64,
    pub text: String,
    pub token_count: i64,
    pub source_type: String,
}

/// Summary of the RAG index state.
#[derive(Debug, Clone, Serialize)]
pub struct RagIndexStatus {
    pub total_files: usize,
    pub indexed_files: usize,
    pub total_chunks: usize,
    pub total_tokens: usize,
    pub last_indexed_at: Option<String>,
}

// ── Chunk CRUD ───────────────────────────────────────────────────────────────

/// Insert multiple chunks into the rag_chunks table in a single transaction.
pub fn insert_chunks_batch(conn: &Connection, chunks: &[ChunkRecord]) -> Result<(), String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("Failed to begin transaction: {}", e))?;

    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO rag_chunks (chunk_id, file_id, chunk_index, text, token_count, source_type, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))",
            )
            .map_err(|e| format!("Failed to prepare insert statement: {}", e))?;

        for chunk in chunks {
            stmt.execute(params![
                chunk.chunk_id,
                chunk.file_id,
                chunk.chunk_index,
                chunk.text,
                chunk.token_count,
                chunk.source_type,
            ])
            .map_err(|e| format!("Failed to insert chunk {}: {}", chunk.chunk_id, e))?;
        }
    }

    tx.commit()
        .map_err(|e| format!("Failed to commit chunk batch: {}", e))?;

    Ok(())
}

/// Delete all chunks and their embeddings for a specific file.
pub fn delete_chunks_by_file(conn: &Connection, file_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM rag_embeddings WHERE chunk_id IN (SELECT chunk_id FROM rag_chunks WHERE file_id = ?1)",
        params![file_id],
    )
    .map_err(|e| format!("Failed to delete embeddings for file {}: {}", file_id, e))?;

    conn.execute(
        "DELETE FROM rag_chunks WHERE file_id = ?1",
        params![file_id],
    )
    .map_err(|e| format!("Failed to delete chunks for file {}: {}", file_id, e))?;

    Ok(())
}

/// Delete all chunks and embeddings from the RAG index.
pub fn clear_all_chunks(conn: &Connection) -> Result<(), String> {
    conn.execute("DELETE FROM rag_embeddings", [])
        .map_err(|e| format!("Failed to delete all embeddings: {}", e))?;

    conn.execute("DELETE FROM rag_chunks", [])
        .map_err(|e| format!("Failed to delete all chunks: {}", e))?;

    Ok(())
}

// ── Embedding CRUD ───────────────────────────────────────────────────────────

/// Insert or replace an embedding for a given chunk.
pub fn store_embedding(
    conn: &Connection,
    chunk_id: &str,
    embedding_bytes: &[u8],
) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO rag_embeddings (chunk_id, embedding) VALUES (?1, ?2)",
        params![chunk_id, embedding_bytes],
    )
    .map_err(|e| format!("Failed to store embedding for chunk {}: {}", chunk_id, e))?;

    Ok(())
}

/// Retrieve all embeddings as (chunk_id, raw_bytes) pairs.
///
/// The caller is responsible for converting raw bytes to f32 vectors
/// via `vector_store::bytes_to_f32_vec`.
pub fn get_all_embeddings(conn: &Connection) -> Result<Vec<(String, Vec<u8>)>, String> {
    let mut stmt = conn
        .prepare("SELECT chunk_id, embedding FROM rag_embeddings")
        .map_err(|e| format!("Failed to prepare get_all_embeddings query: {}", e))?;

    let rows = stmt
        .query_map([], |row| {
            let chunk_id: String = row.get(0)?;
            let blob: Vec<u8> = row.get(1)?;
            Ok((chunk_id, blob))
        })
        .map_err(|e| format!("Failed to query embeddings: {}", e))?;

    let mut results = Vec::new();
    for row in rows {
        let pair = row.map_err(|e| format!("Failed to read embedding row: {}", e))?;
        results.push(pair);
    }

    Ok(results)
}

/// The embeddings of the chunks of `files` only, as (chunk_id, raw_bytes).
pub fn get_embeddings_for_files(conn: &Connection, files: &[String]) -> Result<Vec<(String, Vec<u8>)>, String> {
    let allowed = serde_json::to_string(files).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT e.chunk_id, e.embedding FROM rag_embeddings e
             JOIN rag_chunks c ON c.chunk_id = e.chunk_id
             WHERE c.file_id IN (SELECT value FROM json_each(?1))",
        )
        .map_err(|e| format!("Failed to prepare the embeddings query: {}", e))?;
    let rows = stmt
        .query_map(params![allowed], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?)))
        .map_err(|e| format!("Failed to query embeddings: {}", e))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| format!("Failed to read embedding row: {}", e))
}

// ── Index status ─────────────────────────────────────────────────────────────

/// Get the current RAG index status (chunk counts, file counts, etc.).
///
/// Uses rag_chunks as the source of truth for indexed state, not the
/// context_resources.index_status column (which depends on ALTER TABLE
/// migration success).
pub fn get_index_status(conn: &Connection) -> Result<RagIndexStatus, String> {
    let total_chunks: usize = conn
        .query_row("SELECT COUNT(*) FROM rag_chunks", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|e| format!("Failed to count chunks: {}", e))? as usize;

    let total_tokens: usize = conn
        .query_row(
            "SELECT COALESCE(SUM(token_count), 0) FROM rag_chunks",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| format!("Failed to sum tokens: {}", e))? as usize;

    // total_files = all context resources loaded by the user
    let total_files: usize = conn
        .query_row(
            "SELECT COUNT(*) FROM context_resources",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0) as usize;

    // indexed_files = files that actually have chunks in rag_chunks
    let indexed_files: usize = conn
        .query_row(
            "SELECT COUNT(DISTINCT file_id) FROM rag_chunks",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0) as usize;

    // last_indexed_at from rag_chunks.created_at (reliable, no ALTER TABLE dependency)
    let last_indexed_at: Option<String> = conn
        .query_row(
            "SELECT MAX(created_at) FROM rag_chunks",
            [],
            |row| row.get::<_, Option<String>>(0),
        )
        .unwrap_or(None);

    Ok(RagIndexStatus {
        total_files,
        indexed_files,
        total_chunks,
        total_tokens,
        last_indexed_at,
    })
}

/// Update the index_status and last_indexed_at for a context resource.
pub fn update_index_status(
    conn: &Connection,
    file_id: &str,
    status: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE context_resources SET index_status = ?1, last_indexed_at = datetime('now') WHERE id = ?2",
        params![status, file_id],
    )
    .map_err(|e| format!("Failed to update index status: {}", e))?;

    Ok(())
}
