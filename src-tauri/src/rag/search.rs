use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::HashMap;

use super::config::RagConfig;
use super::fts_store;
use super::vector_store;

/// A search result with chunk text, score, and source metadata.
#[derive(Debug, Clone, Serialize)]
pub struct ScoredChunk {
    pub chunk_id: String,
    pub text: String,
    pub score: f64,
    pub normalized_score: f64,
    pub source_file: String,
    pub chunk_index: usize,
    pub source_type: String,
}

/// Normalize scores to 0-1 range and filter by similarity threshold.
/// Formula: normalized = raw / max. Guard: if max == 0, return empty.
fn normalize_and_filter(mut chunks: Vec<ScoredChunk>, threshold: f64) -> Vec<ScoredChunk> {
    if chunks.is_empty() {
        return chunks;
    }
    let max_score = chunks.iter().map(|c| c.score).fold(f64::NEG_INFINITY, f64::max);
    if max_score <= 0.0 {
        return Vec::new();
    }
    for chunk in &mut chunks {
        chunk.normalized_score = chunk.score / max_score;
    }
    chunks.retain(|c| c.normalized_score >= threshold);
    chunks
}

/// Perform hybrid search combining semantic and keyword results via RRF.
///
/// - `conn`: SQLite connection
/// - `query_embedding`: the embedded query vector
/// - `query_text`: the raw query text for keyword search
/// - `config`: RAG configuration
/// - `embeddings`: in-memory (chunk_id, embedding) pairs for vector search
///   (already limited to the allowed files)
/// - `files`: the files whose chunks may match (None = all); applied inside
///   the keyword query, before the top candidates are taken
pub fn hybrid_search(
    conn: &Connection,
    query_embedding: &[f32],
    query_text: &str,
    config: &RagConfig,
    embeddings: &[(String, Vec<f32>)],
    files: Option<&[String]>,
) -> Result<Vec<ScoredChunk>, String> {
    let top_candidates = config.top_k * 400; // 2K for top_k=5

    // Semantic search
    let semantic_results = vector_store::search_similar(query_embedding, embeddings, top_candidates);

    // Keyword search
    let keyword_results = fts_store::search_keywords(conn, query_text, top_candidates, files)?;

    // RRF merge
    let keyword_weight = 1.0 - config.semantic_weight;
    let merged = rrf_merge(
        &semantic_results,
        &keyword_results,
        config.semantic_weight as f64,
        keyword_weight as f64,
    );

    // Take top-K results, then normalize and filter by threshold.
    let mut results: Vec<ScoredChunk> = Vec::new();
    for (chunk_id, score) in merged.iter().take(config.top_k) {
        match get_chunk_detail(conn, chunk_id) {
            Ok((text, source_file, chunk_index, source_type)) => {
                results.push(ScoredChunk {
                    chunk_id: chunk_id.clone(),
                    text,
                    score: *score,
                    normalized_score: 0.0,
                    source_file,
                    chunk_index,
                    source_type,
                });
            }
            Err(e) => {
                log::warn!("Failed to get chunk detail for {}: {}", chunk_id, e);
            }
        }
    }

    Ok(normalize_and_filter(results, config.similarity_threshold as f64))
}

/// Perform semantic-only search using vector similarity.
pub fn semantic_only_search(
    conn: &Connection,
    query_embedding: &[f32],
    config: &RagConfig,
    embeddings: &[(String, Vec<f32>)],
) -> Result<Vec<ScoredChunk>, String> {
    let results = vector_store::search_similar(query_embedding, embeddings, config.top_k);

    let mut scored_chunks: Vec<ScoredChunk> = Vec::new();
    for (chunk_id, score) in results {
        match get_chunk_detail(conn, &chunk_id) {
            Ok((text, source_file, chunk_index, source_type)) => {
                scored_chunks.push(ScoredChunk {
                    chunk_id,
                    text,
                    score: score as f64,
                    normalized_score: 0.0,
                    source_file,
                    chunk_index,
                    source_type,
                });
            }
            Err(e) => {
                log::warn!("Failed to get chunk detail for {}: {}", chunk_id, e);
            }
        }
    }

    Ok(normalize_and_filter(scored_chunks, config.similarity_threshold as f64))
}

/// Perform keyword-only search using FTS5.
pub fn keyword_only_search(
    conn: &Connection,
    query_text: &str,
    config: &RagConfig,
    files: Option<&[String]>,
) -> Result<Vec<ScoredChunk>, String> {
    let results = fts_store::search_keywords(conn, query_text, config.top_k, files)?;

    let mut scored_chunks: Vec<ScoredChunk> = Vec::new();
    for (chunk_id, score) in results {
        match get_chunk_detail(conn, &chunk_id) {
            Ok((text, source_file, chunk_index, source_type)) => {
                scored_chunks.push(ScoredChunk {
                    chunk_id,
                    text,
                    score,
                    normalized_score: 0.0,
                    source_file,
                    chunk_index,
                    source_type,
                });
            }
            Err(e) => {
                log::warn!("Failed to get chunk detail for {}: {}", chunk_id, e);
            }
        }
    }

    Ok(normalize_and_filter(scored_chunks, config.similarity_threshold as f64))
}

/// Reciprocal Rank Fusion (RRF) merge of two ranked result lists.
///
/// Uses the standard RRF formula: score = weight / (k + rank)
/// where k = 60 is the standard RRF constant.
///
/// - `semantic`: Vec of (chunk_id, similarity_score) from vector search
/// - `keyword`: Vec of (chunk_id, bm25_score) from keyword search
/// - `sem_weight`: weight for semantic results
/// - `kw_weight`: weight for keyword results
///
/// Returns Vec of (chunk_id, rrf_score) sorted descending by score.
fn rrf_merge(
    semantic: &[(String, f32)],
    keyword: &[(String, f64)],
    sem_weight: f64,
    kw_weight: f64,
) -> Vec<(String, f64)> {
    const K: f64 = 60.0;
    let mut scores: HashMap<String, f64> = HashMap::new();

    // Add semantic scores by rank
    for (rank, (id, _score)) in semantic.iter().enumerate() {
        let rrf_score = sem_weight / (K + (rank + 1) as f64);
        *scores.entry(id.clone()).or_insert(0.0) += rrf_score;
    }

    // Add keyword scores by rank
    for (rank, (id, _score)) in keyword.iter().enumerate() {
        let rrf_score = kw_weight / (K + (rank + 1) as f64);
        *scores.entry(id.clone()).or_insert(0.0) += rrf_score;
    }

    // Sort by RRF score descending
    let mut merged: Vec<(String, f64)> = scores.into_iter().collect();
    merged.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    merged
}

/// Retrieve chunk text and source metadata from the database.
///
/// Joins `rag_chunks` with `context_resources` to get file name and type.
fn get_chunk_detail(
    conn: &Connection,
    chunk_id: &str,
) -> Result<(String, String, usize, String), String> {
    let sql = "
        SELECT c.text, COALESCE(r.name, c.file_id), c.chunk_index, c.source_type
        FROM rag_chunks c
        LEFT JOIN context_resources r ON r.id = c.file_id
        WHERE c.chunk_id = ?1
    ";

    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| format!("Chunk detail query failed: {}", e))?;

    stmt.query_row(params![chunk_id], |row| {
        let text: String = row.get(0)?;
        let source_file: String = row.get(1)?;
        let chunk_index: usize = row.get::<_, i64>(2)? as usize;
        let source_type: String = row.get(3)?;
        Ok((text, source_file, chunk_index, source_type))
    })
    .map_err(|e| format!("Chunk {} not found: {}", chunk_id, e))
}
