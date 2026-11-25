pub mod config;
pub mod chunker;
pub mod embedder;
pub mod vector_store;
pub mod fts_store;
pub mod search;
pub mod prompt_builder;
pub mod file_processor;
pub mod transcript_indexer;

#[cfg(test)]
mod isolation_tests;

use std::sync::{Arc, Mutex};
use config::RagConfig;
use embedder::OllamaEmbedder;
use search::ScoredChunk;
use transcript_indexer::TranscriptIndexer;
use crate::db::rag as rag_db;
use crate::db::DatabaseManager;
use rusqlite::Connection;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

/// Progress event payload emitted during file indexing.
#[derive(Debug, Clone, serde::Serialize)]
struct IndexProgress {
    file_id: String,
    file_name: String,
    chunks_total: usize,
    chunks_embedded: usize,
    status: String,
}

/// Central orchestrator for the RAG pipeline.
///
/// Owns the configuration, embedding client, and optional transcript indexer.
/// Provides methods for indexing files, searching, and managing the index.
pub struct RagManager {
    config: RagConfig,
    embedder: OllamaEmbedder,
    transcript_indexer: Option<TranscriptIndexer>,
}

impl RagManager {
    /// Create a new RagManager from a configuration.
    ///
    /// Sets up the Ollama embedder and optionally creates a TranscriptIndexer
    /// if `config.include_transcript` is true.
    pub fn new(config: RagConfig) -> Self {
        let embedder = OllamaEmbedder::new(&config.ollama_url);
        let transcript_indexer = if config.include_transcript {
            Some(TranscriptIndexer::new(config.chunk_size))
        } else {
            None
        };
        Self {
            config,
            embedder,
            transcript_indexer,
        }
    }

    /// Get a reference to the current configuration.
    pub fn config(&self) -> &RagConfig {
        &self.config
    }

    /// Get the Ollama base URL.
    pub fn embedder_url(&self) -> String {
        self.embedder.base_url().to_string()
    }

    /// Get the configured embedding model name.
    pub fn embedding_model(&self) -> String {
        self.config.embedding_model.clone()
    }

    /// Update the configuration. Recreates the embedder and toggles
    /// the transcript indexer as needed.
    pub fn update_config(&mut self, config: RagConfig) {
        self.embedder = OllamaEmbedder::new(&config.ollama_url);
        if config.include_transcript && self.transcript_indexer.is_none() {
            self.transcript_indexer = Some(TranscriptIndexer::new(config.chunk_size));
        } else if !config.include_transcript {
            self.transcript_indexer = None;
        }
        self.config = config;
    }

    /// The file id of the running transcript's chunks, when the transcript is indexed.
    pub fn transcript_file_id(&self) -> Option<String> {
        self.transcript_indexer.as_ref().map(|t| t.file_id().to_string())
    }

    /// Get a mutable reference to the transcript indexer, if enabled.
    pub fn transcript_indexer_mut(&mut self) -> Option<&mut TranscriptIndexer> {
        self.transcript_indexer.as_mut()
    }

    /// Index a file: chunk the text, insert chunk records, embed in batches,
    /// store embeddings, and update the resource index status.
    ///
    /// This is a static async method — extract config from RagManager under lock,
    /// then call this without holding any MutexGuard across awaits.
    ///
    /// Emits "rag_index_progress" events via the Tauri app handle.
    ///
    /// Returns the total number of chunks created.
    pub async fn index_file_async(
        db: &Arc<Mutex<DatabaseManager>>,
        file_id: &str,
        text: &str,
        file_name: &str,
        app_handle: &AppHandle,
        config: &RagConfig,
        embedder_url: &str,
    ) -> Result<usize, String> {
        let embedder = OllamaEmbedder::new(embedder_url);

        // Phase 1: Chunk the text (no DB needed)
        let chunks = chunker::chunk_text(
            text,
            config.chunk_size,
            config.chunk_overlap,
            &config.splitting_strategy,
        );

        if chunks.is_empty() {
            return Ok(0);
        }

        let total_chunks = chunks.len();

        let _ = app_handle.emit(
            "rag_index_progress",
            &IndexProgress {
                file_id: file_id.to_string(),
                file_name: file_name.to_string(),
                chunks_total: total_chunks,
                chunks_embedded: 0,
                status: "chunking".to_string(),
            },
        );

        // Build ChunkRecords
        let chunk_records: Vec<rag_db::ChunkRecord> = chunks
            .iter()
            .map(|c| rag_db::ChunkRecord {
                chunk_id: Uuid::new_v4().to_string(),
                file_id: file_id.to_string(),
                chunk_index: c.index as i64,
                text: c.text.clone(),
                token_count: c.token_count as i64,
                source_type: "file".to_string(),
            })
            .collect();

        // Phase 2: Insert chunks into DB (brief lock, no await)
        {
            let db_guard = db.lock().map_err(|e| format!("DB lock failed: {}", e))?;
            rag_db::insert_chunks_batch(db_guard.connection(), &chunk_records)
                .map_err(|e| format!("Failed to insert chunks for {}: {}", file_name, e))?;
        } // lock released before async work

        // Phase 3: Embed in batches (async, no DB lock held)
        let mut chunks_embedded: usize = 0;
        let mut batch_embeddings: Vec<(String, Vec<u8>)> = Vec::new();

        for batch_start in (0..chunk_records.len()).step_by(config.batch_size) {
            let batch_end = (batch_start + config.batch_size).min(chunk_records.len());
            let batch = &chunk_records[batch_start..batch_end];

            let texts: Vec<String> = batch.iter().map(|c| c.text.clone()).collect();
            let embeddings = embedder
                .embed_documents(texts, &config.embedding_model)
                .await?;

            for (record, embedding) in batch.iter().zip(embeddings.iter()) {
                let embedding_bytes = vector_store::f32_vec_to_bytes(embedding);
                batch_embeddings.push((record.chunk_id.clone(), embedding_bytes));
            }

            chunks_embedded += batch.len();

            let _ = app_handle.emit(
                "rag_index_progress",
                &IndexProgress {
                    file_id: file_id.to_string(),
                    file_name: file_name.to_string(),
                    chunks_total: total_chunks,
                    chunks_embedded,
                    status: "embedding".to_string(),
                },
            );
        }

        // Phase 4: Store all embeddings + update status (brief lock, no await)
        {
            let db_guard = db.lock().map_err(|e| format!("DB lock failed: {}", e))?;
            let conn = db_guard.connection();
            for (chunk_id, embedding_bytes) in &batch_embeddings {
                rag_db::store_embedding(conn, chunk_id, embedding_bytes)
                    .map_err(|e| format!("Failed to store embedding: {}", e))?;
            }
            rag_db::update_index_status(conn, file_id, "indexed")
                .map_err(|e| format!("Failed to update index status: {}", e))?;
        }

        let _ = app_handle.emit(
            "rag_index_progress",
            &IndexProgress {
                file_id: file_id.to_string(),
                file_name: file_name.to_string(),
                chunks_total: total_chunks,
                chunks_embedded: total_chunks,
                status: "complete".to_string(),
            },
        );

        log::info!(
            "Indexed file '{}' ({} chunks, {} embeddings)",
            file_name,
            total_chunks,
            chunks_embedded
        );

        Ok(total_chunks)
    }

    /// Remove all chunks and embeddings for a file from the index.
    pub fn remove_file_index(conn: &Connection, file_id: &str) -> Result<(), String> {
        rag_db::delete_chunks_by_file(conn, file_id)
            .map_err(|e| format!("Failed to remove file index: {}", e))?;
        rag_db::update_index_status(conn, file_id, "none")
            .map_err(|e| format!("Failed to update index status: {}", e))?;
        Ok(())
    }

    /// Clear the entire RAG index (all chunks, embeddings, and FTS data).
    pub fn clear_index(conn: &Connection) -> Result<(), String> {
        rag_db::clear_all_chunks(conn)
            .map_err(|e| format!("Failed to clear RAG index: {}", e))?;
        Ok(())
    }

    /// Perform an async search against the RAG index.
    ///
    /// Creates a temporary OllamaEmbedder for the query embedding, locks the
    /// database, loads stored embeddings, and dispatches to the appropriate
    /// search mode (hybrid, semantic, or keyword).
    ///
    /// `files` limits the search to the chunks of those files (None = all):
    /// the limit is applied before ranking, so the top results are all allowed.
    pub async fn search_async(
        db: &Arc<Mutex<DatabaseManager>>,
        query: &str,
        config: &RagConfig,
        embedder_url: &str,
        model: &str,
        files: Option<&[String]>,
    ) -> Result<Vec<ScoredChunk>, String> {
        let embedder = OllamaEmbedder::new(embedder_url);

        // Embed the query (needed for semantic and hybrid modes)
        let query_embedding = if config.search_mode != "keyword" {
            Some(embedder.embed_query(query, model).await?)
        } else {
            None
        };

        // Lock database and perform search
        let db_guard = db
            .lock()
            .map_err(|e| format!("Failed to acquire database lock: {}", e))?;
        let conn = db_guard.connection();

        match config.search_mode.as_str() {
            "hybrid" => {
                let query_emb = query_embedding
                    .as_ref()
                    .ok_or("Query embedding required for hybrid search")?;

                // Load all stored embeddings for vector search
                let stored = load_embeddings(conn, files)?;

                search::hybrid_search(conn, query_emb, query, config, &stored, files)
            }
            "semantic" => {
                let query_emb = query_embedding
                    .as_ref()
                    .ok_or("Query embedding required for semantic search")?;

                let stored = load_embeddings(conn, files)?;

                search::semantic_only_search(conn, query_emb, config, &stored)
            }
            "keyword" => search::keyword_only_search(conn, query, config, files),
            other => Err(format!("Unknown search mode: {}", other)),
        }
    }

    /// Get the current RAG index status (chunk counts, file counts, etc.).
    pub fn get_status(conn: &Connection) -> Result<rag_db::RagIndexStatus, String> {
        rag_db::get_index_status(conn)
            .map_err(|e| format!("Failed to get RAG index status: {}", e))
    }
}

/// Load the embeddings of the allowed files (all when `files` is None) into
/// memory for vector search.
///
/// Returns Vec of (chunk_id, embedding_vector) pairs.
pub fn load_embeddings(conn: &Connection, files: Option<&[String]>) -> Result<Vec<(String, Vec<f32>)>, String> {
    let rows = match files {
        Some(files) => rag_db::get_embeddings_for_files(conn, files),
        None => rag_db::get_all_embeddings(conn),
    }
    .map_err(|e| format!("Failed to load embeddings: {}", e))?;

    let embeddings: Vec<(String, Vec<f32>)> = rows
        .into_iter()
        .map(|(chunk_id, bytes)| {
            let vec = vector_store::bytes_to_f32_vec(&bytes);
            (chunk_id, vec)
        })
        .collect();

    Ok(embeddings)
}
