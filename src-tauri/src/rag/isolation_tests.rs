//! A document outside the allowed set never reaches a result, however well it
//! ranks: the filter is applied before the top candidates are taken.

use rusqlite::{params, Connection};

use super::config::RagConfig;
use super::{fts_store, load_embeddings, search, vector_store};
use crate::db::migrations;

fn index() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    migrations::run(&conn).unwrap();
    conn
}

fn chunk(conn: &Connection, id: &str, file: &str, text: &str, vector: &[f32]) {
    conn.execute(
        "INSERT INTO rag_chunks (chunk_id, file_id, chunk_index, text, token_count, source_type, created_at)
         VALUES (?1, ?2, 0, ?3, 5, 'file', 'now')",
        params![id, file, text],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO rag_embeddings (chunk_id, embedding) VALUES (?1, ?2)",
        params![id, vector_store::f32_vec_to_bytes(vector)],
    )
    .unwrap();
}

/// Two documents: the other one ranks first for the query on every measure.
fn two_documents() -> Connection {
    let conn = index();
    chunk(&conn, "allowed", "doc-a", "budget notes CANARY_ALLOWED", &[0.6, 0.8, 0.0]);
    chunk(&conn, "other", "doc-b", "budget budget budget budget CANARY_OTHER", &[1.0, 0.0, 0.0]);
    conn
}

fn config(top_k: usize) -> RagConfig {
    RagConfig { top_k, similarity_threshold: 0.0, ..RagConfig::default() }
}

fn files(ids: &[&str]) -> Vec<String> {
    ids.iter().map(|s| s.to_string()).collect()
}

#[test]
fn keyword_search_is_filtered_before_the_top_candidates() {
    let conn = two_documents();
    let all = fts_store::search_keywords(&conn, "budget", 1, None).unwrap();
    assert_eq!(all[0].0, "other", "the other document ranks first unfiltered");
    let allowed = files(&["doc-a"]);
    let found = fts_store::search_keywords(&conn, "budget", 1, Some(&allowed)).unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].0, "allowed");
    assert!(fts_store::search_keywords(&conn, "budget", 5, Some(&[])).unwrap().is_empty());
}

#[test]
fn semantic_search_with_fake_vectors_never_returns_a_document_outside_the_set() {
    let conn = two_documents();
    let query = [1.0, 0.0, 0.0];
    let everything = load_embeddings(&conn, None).unwrap();
    let unfiltered = search::semantic_only_search(&conn, &query, &config(1), &everything).unwrap();
    assert!(unfiltered[0].text.contains("CANARY_OTHER"));

    let allowed = files(&["doc-a"]);
    let stored = load_embeddings(&conn, Some(&allowed)).unwrap();
    assert_eq!(stored.len(), 1);
    let found = search::semantic_only_search(&conn, &query, &config(1), &stored).unwrap();
    assert_eq!(found.len(), 1);
    assert!(found[0].text.contains("CANARY_ALLOWED") && !found[0].text.contains("CANARY_OTHER"));
}

#[test]
fn hybrid_search_uses_the_filter_in_both_halves() {
    let conn = two_documents();
    let query = [1.0, 0.0, 0.0];
    let allowed = files(&["doc-a"]);
    let stored = load_embeddings(&conn, Some(&allowed)).unwrap();
    let found = search::hybrid_search(&conn, &query, "budget", &config(5), &stored, Some(&allowed)).unwrap();
    assert!(!found.is_empty());
    assert!(found.iter().all(|c| c.text.contains("CANARY_ALLOWED")));
    // With both documents allowed, both can be found.
    let both = files(&["doc-a", "doc-b"]);
    let stored = load_embeddings(&conn, Some(&both)).unwrap();
    let found = search::hybrid_search(&conn, &query, "budget", &config(5), &stored, Some(&both)).unwrap();
    assert_eq!(found.len(), 2);
    // A document that is in no scope is never found.
    let none: Vec<String> = Vec::new();
    let stored = load_embeddings(&conn, Some(&none)).unwrap();
    assert!(search::hybrid_search(&conn, &query, "budget", &config(5), &stored, Some(&none)).unwrap().is_empty());
}

#[test]
fn live_transcript_chunks_pass_only_when_their_file_is_allowed() {
    let conn = index();
    conn.execute(
        "INSERT INTO rag_chunks (chunk_id, file_id, chunk_index, text, token_count, source_type, created_at)
         VALUES ('t', 'transcript_abc', 0, 'budget talk CANARY_TRANSCRIPT', 5, 'transcript', 'now')",
        [],
    )
    .unwrap();
    let docs = files(&["doc-a"]);
    assert!(fts_store::search_keywords(&conn, "budget", 5, Some(&docs)).unwrap().is_empty());
    let with_transcript = files(&["doc-a", "transcript_abc"]);
    assert_eq!(fts_store::search_keywords(&conn, "budget", 5, Some(&with_transcript)).unwrap().len(), 1);
}
