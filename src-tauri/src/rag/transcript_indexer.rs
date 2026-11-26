use super::chunker::chunk_text;
use super::embedder::OllamaEmbedder;
use super::vector_store;
use crate::context::token_counter::count_tokens;
use crate::db::rag as rag_db;
use rusqlite::Connection;
use uuid::Uuid;

/// The file id of a transcript session of `owner`.
fn file_id_for(owner: Option<&str>) -> String {
    match owner {
        Some(meeting) => format!("transcript_{}_{}", meeting, Uuid::new_v4()),
        None => format!("transcript_{}", Uuid::new_v4()),
    }
}

/// The `LIKE` pattern (with `\` as the escape) of every file id of `meeting`'s transcript.
pub fn file_id_pattern(meeting: &str) -> String {
    let escaped = meeting.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    format!("transcript\\_{escaped}\\_%")
}

/// Accumulates live transcript segments and indexes them into the RAG store
/// when the buffer reaches the configured chunk size threshold.
pub struct TranscriptIndexer {
    /// Accumulated transcript text waiting to be chunked and indexed.
    buffer: String,
    /// Current approximate token count of the buffer.
    buffer_tokens: usize,
    /// Target chunk size in tokens (triggers flush when exceeded).
    chunk_size: usize,
    /// Number of segments pushed since last flush.
    segments_since_flush: usize,
    /// Unique file ID for the current transcript session. It names the owning
    /// meeting (`transcript_<meeting>_<uuid>`), so one meeting's chunks can be
    /// found and deleted without touching another's.
    file_id: String,
    /// The meeting whose transcript this is; only that meeting's requests may
    /// search the chunks.
    owner: Option<String>,
}

impl TranscriptIndexer {
    /// Create a new transcript indexer with the given chunk size threshold.
    pub fn new(chunk_size: usize) -> Self {
        Self {
            buffer: String::new(),
            buffer_tokens: 0,
            chunk_size,
            segments_since_flush: 0,
            file_id: format!("transcript_{}", Uuid::new_v4()),
            owner: None,
        }
    }

    /// The meeting this transcript belongs to (None between meetings). Starts a
    /// fresh file id that names it.
    pub fn set_owner(&mut self, owner: Option<String>) {
        self.file_id = file_id_for(owner.as_deref());
        self.owner = owner;
    }

    pub fn owner(&self) -> Option<&str> {
        self.owner.as_deref()
    }

    /// Push a new transcript segment into the buffer.
    ///
    /// - `text`: the transcribed text
    /// - `speaker`: speaker identifier
    /// - `_timestamp_ms`: timestamp in milliseconds (reserved for future use)
    pub fn push_segment(&mut self, text: &str, speaker: &str, _timestamp_ms: u64) {
        let line = format!("[{}]: {}\n", speaker, text);
        self.buffer_tokens += count_tokens(&line);
        self.buffer.push_str(&line);
        self.segments_since_flush += 1;
    }

    /// Check whether the buffer has accumulated enough tokens to warrant flushing.
    pub fn should_flush(&self) -> bool {
        self.buffer_tokens >= self.chunk_size
    }

    /// Flush the buffer: chunk the accumulated text, create database records,
    /// generate embeddings, and store everything.
    ///
    /// Returns the number of chunks created.
    pub async fn flush(
        &mut self,
        conn: &Connection,
        embedder: &OllamaEmbedder,
        model: &str,
    ) -> Result<usize, String> {
        if self.buffer.is_empty() {
            return Ok(0);
        }

        let text = self.buffer.clone();
        let chunks = chunk_text(&text, self.chunk_size, 0, "recursive");

        if chunks.is_empty() {
            self.buffer.clear();
            self.buffer_tokens = 0;
            self.segments_since_flush = 0;
            return Ok(0);
        }

        // Build ChunkRecords for database insertion
        let chunk_records: Vec<rag_db::ChunkRecord> = chunks
            .iter()
            .map(|c| rag_db::ChunkRecord {
                chunk_id: Uuid::new_v4().to_string(),
                file_id: self.file_id.clone(),
                chunk_index: c.index as i64,
                text: c.text.clone(),
                token_count: c.token_count as i64,
                source_type: "transcript".to_string(),
            })
            .collect();

        // Insert chunks into database
        rag_db::insert_chunks_batch(conn, &chunk_records)
            .map_err(|e| format!("Failed to insert transcript chunks: {}", e))?;

        // Generate embeddings
        let texts: Vec<String> = chunk_records.iter().map(|c| c.text.clone()).collect();
        let embeddings = embedder.embed_documents(texts, model).await?;

        // Store embeddings
        for (record, embedding) in chunk_records.iter().zip(embeddings.iter()) {
            let embedding_bytes = vector_store::f32_vec_to_bytes(embedding);
            rag_db::store_embedding(conn, &record.chunk_id, &embedding_bytes)
                .map_err(|e| format!("Failed to store transcript embedding: {}", e))?;
        }

        let num_chunks = chunk_records.len();

        // Clear buffer
        self.buffer.clear();
        self.buffer_tokens = 0;
        self.segments_since_flush = 0;

        log::info!(
            "Transcript indexer flushed {} chunks for {}",
            num_chunks,
            self.file_id
        );

        Ok(num_chunks)
    }

    /// Get the current transcript session file ID.
    pub fn file_id(&self) -> &str {
        &self.file_id
    }

    /// Reset the indexer: clears the buffer and generates a new file ID
    /// for a fresh transcript session.
    pub fn reset(&mut self) {
        self.buffer.clear();
        self.buffer_tokens = 0;
        self.segments_since_flush = 0;
        self.file_id = file_id_for(self.owner.as_deref());
    }
}
