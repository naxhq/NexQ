use rusqlite::{params, Connection};

/// Perform a BM25-scored keyword search against the `rag_fts` FTS5 table.
///
/// - `conn`: SQLite connection with the `rag_fts` and `rag_chunks` tables
/// - `query`: raw search query text (will be sanitized for FTS5)
/// - `limit`: maximum number of results
/// - `files`: only chunks of these files may match (None = every chunk). The
///   filter is part of the query, so `limit` counts allowed chunks only.
///
/// Returns Vec of (chunk_id, bm25_score) ordered by relevance (lower BM25 = more relevant,
/// so we negate for ascending sort).
pub fn search_keywords(
    conn: &Connection,
    query: &str,
    limit: usize,
    files: Option<&[String]>,
) -> Result<Vec<(String, f64)>, String> {
    let fts_query = prepare_fts_query(query);
    if fts_query.is_empty() {
        return Ok(Vec::new());
    }

    let sql = "
        SELECT c.chunk_id, bm25(rag_fts) AS score
        FROM rag_fts f
        JOIN rag_chunks c ON c.rowid = f.rowid
        WHERE rag_fts MATCH ?1
          AND (?3 IS NULL OR c.file_id IN (SELECT value FROM json_each(?3)))
        ORDER BY score
        LIMIT ?2
    ";
    let allowed = match files {
        Some(files) => Some(serde_json::to_string(files).map_err(|e| e.to_string())?),
        None => None,
    };

    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| format!("FTS query prepare failed: {}", e))?;

    let rows = stmt
        .query_map(params![fts_query, limit as i64, allowed], |row| {
            let chunk_id: String = row.get(0)?;
            let score: f64 = row.get(1)?;
            Ok((chunk_id, score))
        })
        .map_err(|e| format!("FTS query execution failed: {}", e))?;

    let mut results = Vec::new();
    for row in rows {
        let (chunk_id, score) = row.map_err(|e| format!("FTS row read error: {}", e))?;
        // BM25 returns negative scores (more negative = more relevant);
        // negate to get positive scores where higher = more relevant
        results.push((chunk_id, -score));
    }

    Ok(results)
}

/// Prepare a raw query string for FTS5 MATCH syntax.
///
/// Splits on whitespace, wraps each word in double quotes (escaping any
/// internal double quotes), and joins with " OR ".
fn prepare_fts_query(raw: &str) -> String {
    let words: Vec<String> = raw
        .split_whitespace()
        .filter(|w| !w.is_empty())
        .map(|w| {
            let escaped = w.replace('"', "\"\"");
            format!("\"{}\"", escaped)
        })
        .collect();

    words.join(" OR ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_prepare_fts_query_basic() {
        let result = prepare_fts_query("hello world");
        assert_eq!(result, "\"hello\" OR \"world\"");
    }

    #[test]
    fn test_prepare_fts_query_single_word() {
        let result = prepare_fts_query("test");
        assert_eq!(result, "\"test\"");
    }

    #[test]
    fn test_prepare_fts_query_empty() {
        let result = prepare_fts_query("");
        assert_eq!(result, "");
    }

    #[test]
    fn test_prepare_fts_query_with_quotes() {
        let result = prepare_fts_query("say \"hello\"");
        assert_eq!(result, "\"say\" OR \"\"\"hello\"\"\"");
    }

    #[test]
    fn test_prepare_fts_query_extra_spaces() {
        let result = prepare_fts_query("  foo   bar  ");
        assert_eq!(result, "\"foo\" OR \"bar\"");
    }
}
