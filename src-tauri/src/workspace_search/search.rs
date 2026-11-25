//! Scoped search: BM25 over the porter index (and the trigram index for
//! CJK), the scope filter applied in SQL before ranking, recency for
//! transcripts, a relevance floor and MMR-style diversity.
//!
//! The query text never reaches FTS5 as syntax: it is cut into plain
//! alphanumeric terms that are each quoted.

use super::cjk::{is_cjk, is_mostly_cjk};
use super::{now_ms, MeetingScope, Passage, PassageKind, SearchScope};
use rusqlite::{types::Value, Connection, ToSql};
use std::collections::{HashMap, HashSet};

const STOPWORDS: &[&str] = &[
    "a", "an", "the", "and", "or", "but", "if", "of", "to", "in", "on", "at", "by", "for", "with",
    "about", "as", "is", "are", "was", "were", "be", "been", "being", "am", "do", "does", "did",
    "done", "have", "has", "had", "it", "its", "this", "that", "these", "those", "i", "me", "my",
    "we", "our", "us", "you", "your", "he", "she", "they", "them", "their", "what", "which",
    "who", "whom", "when", "where", "why", "how", "can", "could", "would", "should", "will",
    "shall", "may", "might", "must", "not", "no", "so", "than", "then", "there", "from", "into",
    "over", "any", "some", "all", "up", "out", "just", "also", "tell", "say", "said", "talk",
    "talked", "discuss", "discussed", "please",
];

pub fn is_stopword(w: &str) -> bool {
    STOPWORDS.contains(&w)
}

const MAX_WORDS: usize = 24;
const MAX_WORD_CHARS: usize = 48;
const MAX_CJK_RUNS: usize = 8;
const MAX_CJK_RUN_CHARS: usize = 60;
const MAX_TRIGRAM_WINDOWS: usize = 40;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ParsedQuery {
    /// Lowercased alphanumeric terms (stopwords and one-letter words removed).
    pub words: Vec<String>,
    /// Runs of CJK characters.
    pub cjk_runs: Vec<String>,
}

/// Cut a free-text query into safe terms.
pub fn parse_query(q: &str) -> ParsedQuery {
    let mut words: Vec<String> = Vec::new();
    let mut runs: Vec<String> = Vec::new();
    let (mut word, mut run) = (String::new(), String::new());
    let flush_word = |word: &mut String, words: &mut Vec<String>| {
        if word.is_empty() {
            return;
        }
        let w = std::mem::take(word).to_lowercase();
        let n = w.chars().count();
        let digits = w.chars().all(|c| c.is_ascii_digit());
        if n <= MAX_WORD_CHARS && (n >= 2 || digits) && !STOPWORDS.contains(&w.as_str()) && !words.contains(&w) {
            words.push(w);
        }
    };
    let flush_run = |run: &mut String, runs: &mut Vec<String>| {
        if run.is_empty() {
            return;
        }
        let r: String = std::mem::take(run).chars().take(MAX_CJK_RUN_CHARS).collect();
        if !runs.contains(&r) {
            runs.push(r);
        }
    };
    for c in q.chars() {
        if is_cjk(c) {
            flush_word(&mut word, &mut words);
            run.push(c);
        } else if c.is_alphanumeric() {
            flush_run(&mut run, &mut runs);
            word.push(c);
        } else {
            flush_word(&mut word, &mut words);
            flush_run(&mut run, &mut runs);
        }
    }
    flush_word(&mut word, &mut words);
    flush_run(&mut run, &mut runs);
    words.truncate(MAX_WORDS);
    runs.truncate(MAX_CJK_RUNS);
    ParsedQuery { words, cjk_runs: runs }
}

/// FTS5 expression for the porter index: every term quoted, joined by OR.
pub fn fts_expr(words: &[String]) -> Option<String> {
    if words.is_empty() {
        return None;
    }
    Some(
        words
            .iter()
            .map(|w| format!("\"{}\"", w.replace('"', "")))
            .collect::<Vec<_>>()
            .join(" OR "),
    )
}

/// Three-character windows of the CJK runs (at most 40 in all).
pub fn trigram_windows(runs: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for r in runs {
        let chars: Vec<char> = r.chars().collect();
        if chars.len() < 3 {
            continue;
        }
        for w in chars.windows(3) {
            let s: String = w.iter().collect();
            if !out.contains(&s) {
                out.push(s);
            }
        }
    }
    if out.len() > MAX_TRIGRAM_WINDOWS {
        let step = out.len() as f64 / MAX_TRIGRAM_WINDOWS as f64;
        out = (0..MAX_TRIGRAM_WINDOWS).map(|i| out[(i as f64 * step) as usize].clone()).collect();
    }
    out
}

fn trigram_expr(windows: &[String]) -> Option<String> {
    if windows.is_empty() {
        return None;
    }
    Some(windows.iter().map(|w| format!("\"{}\"", w.replace('"', ""))).collect::<Vec<_>>().join(" OR "))
}

#[derive(Debug, Clone)]
pub struct SearchOptions {
    pub now_ms: i64,
    /// Passages below this absolute relevance are dropped.
    pub min_relevance: f32,
    /// Passages below this share of the best score are dropped.
    pub relative_floor: f32,
    pub max_per_source: usize,
    pub recency: bool,
}

impl Default for SearchOptions {
    fn default() -> Self {
        SearchOptions { now_ms: now_ms(), min_relevance: 0.12, relative_floor: 0.25, max_per_source: 3, recency: true }
    }
}

struct ScopeSql {
    sql: String,
    params: Vec<(&'static str, Value)>,
}

fn json_list(items: &[String]) -> Value {
    Value::Text(serde_json::to_string(items).unwrap_or_else(|_| "[]".into()))
}

fn scope_sql(scope: &SearchScope, kinds: &[PassageKind]) -> Option<ScopeSql> {
    let mut alts: Vec<String> = Vec::new();
    let mut params: Vec<(&'static str, Value)> = Vec::new();
    match &scope.meetings {
        MeetingScope::None => {}
        MeetingScope::Ids(ids) if ids.is_empty() => {}
        MeetingScope::Ids(ids) => {
            alts.push("(p.kind = 'transcript' AND p.ref_id IN (SELECT value FROM json_each(:mids)))".into());
            params.push((":mids", json_list(ids)));
        }
        MeetingScope::HomeWorkspace(ws) => {
            alts.push("(p.kind = 'transcript' AND p.ref_id IN (SELECT id FROM meetings WHERE workspace_id = :mws))".into());
            params.push((":mws", Value::Text(ws.clone())));
        }
    }
    if !scope.document_ids.is_empty() {
        alts.push("(p.kind = 'document' AND p.ref_id IN (SELECT value FROM json_each(:dids)))".into());
        params.push((":dids", json_list(&scope.document_ids)));
    }
    if !scope.folder_ids.is_empty() {
        alts.push("(p.kind = 'folder' AND p.ref_id IN (SELECT value FROM json_each(:fids)))".into());
        params.push((":fids", json_list(&scope.folder_ids)));
    }
    if !scope.talking_point_ids.is_empty() {
        alts.push("(p.kind = 'talking_point' AND p.ref_id IN (SELECT value FROM json_each(:tids)))".into());
        params.push((":tids", json_list(&scope.talking_point_ids)));
    }
    if alts.is_empty() {
        return None;
    }
    let mut sql = format!("({})", alts.join(" OR "));
    if !scope.excluded_meeting_ids.is_empty() {
        sql.push_str(" AND NOT (p.kind = 'transcript' AND p.ref_id IN (SELECT value FROM json_each(:xids)))");
        params.push((":xids", json_list(&scope.excluded_meeting_ids)));
    }
    if !kinds.is_empty() {
        let list = kinds.iter().map(|k| format!("'{}'", k.as_str())).collect::<Vec<_>>().join(",");
        sql.push_str(&format!(" AND p.kind IN ({list})"));
    }
    Some(ScopeSql { sql, params })
}

#[derive(Clone)]
struct Cand {
    p: Passage,
    rel: f32,
}

const COLS: &str = "p.id, p.kind, p.ref_id, p.sub_ref, p.title, p.start_ms, p.end_ms, p.text, p.tokens, p.occurred_at";

fn row_passage(r: &rusqlite::Row) -> rusqlite::Result<(Passage, f64)> {
    Ok((
        Passage {
            id: r.get(0)?,
            kind: r.get(1)?,
            ref_id: r.get(2)?,
            sub_ref: r.get(3)?,
            title: r.get(4)?,
            start_ms: r.get(5)?,
            end_ms: r.get(6)?,
            text: r.get(7)?,
            tokens: r.get::<_, i64>(8)? as usize,
            occurred_at: r.get(9)?,
            score: 0.0,
            relevance: 0.0,
            snippet: String::new(),
            match_ranges: Vec::new(),
        },
        r.get::<_, f64>(10)?,
    ))
}

fn run_query(
    conn: &Connection,
    sql: &str,
    scope: &ScopeSql,
    extra: Vec<(&'static str, Value)>,
) -> Result<Vec<(Passage, f64)>, String> {
    let mut stmt = conn.prepare_cached(sql).map_err(|e| format!("search prepare: {e}"))?;
    let mut named: Vec<(&str, &dyn ToSql)> = scope.params.iter().map(|(k, v)| (*k, v as &dyn ToSql)).collect();
    for (k, v) in &extra {
        named.push((*k, v as &dyn ToSql));
    }
    let rows = stmt
        .query_map(named.as_slice(), row_passage)
        .map_err(|e| format!("search query: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| format!("search row: {e}"))
}

fn stem(w: &str) -> String {
    let mut s = w.to_string();
    for suf in ["ing", "ed", "es", "ly", "s", "e", "d"] {
        if s.len() > suf.len() + 2 && s.ends_with(suf) {
            s.truncate(s.len() - suf.len());
            break;
        }
    }
    s
}

/// Byte spans of the alphanumeric (non-CJK) words of a text.
fn word_spans(text: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut start: Option<usize> = None;
    for (i, c) in text.char_indices() {
        let w = c.is_alphanumeric() && !is_cjk(c);
        match (w, start) {
            (true, None) => start = Some(i),
            (false, Some(s)) => {
                out.push((s, i));
                start = None;
            }
            _ => {}
        }
    }
    if let Some(s) = start {
        out.push((s, text.len()));
    }
    out
}

fn lexical_coverage(words: &[String], stems: &[String], text_words: &[String]) -> f32 {
    if words.is_empty() {
        return 0.0;
    }
    let covered = stems
        .iter()
        .filter(|st| text_words.iter().any(|t| t.starts_with(st.as_str())))
        .count();
    covered as f32 / words.len() as f32
}

fn lower_words(text: &str) -> Vec<String> {
    word_spans(text).into_iter().map(|(a, b)| text[a..b].to_lowercase()).collect()
}

fn recency_factor(p: &Passage, now: i64) -> f32 {
    if p.kind != "transcript" {
        return 1.0;
    }
    match p.occurred_at {
        Some(t) => {
            let age_days = ((now - t).max(0) as f64) / 86_400_000.0;
            1.0 + 0.25 * 0.5f64.powf(age_days / 60.0) as f32
        }
        None => 1.0,
    }
}

/// Search with default options.
pub fn search(
    conn: &Connection,
    scope: &SearchScope,
    query: &str,
    kinds: &[PassageKind],
    limit: usize,
) -> Result<Vec<Passage>, String> {
    search_with(conn, scope, query, kinds, limit, &SearchOptions::default())
}

pub fn search_with(
    conn: &Connection,
    scope: &SearchScope,
    query: &str,
    kinds: &[PassageKind],
    limit: usize,
    opts: &SearchOptions,
) -> Result<Vec<Passage>, String> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let parsed = parse_query(query);
    let sc = match scope_sql(scope, kinds) {
        Some(s) => s,
        None => return Ok(Vec::new()),
    };
    let cand_n = (limit * 8).clamp(60, 400) as i64;
    let mut cands: HashMap<i64, Cand> = HashMap::new();
    let keep = |c: Cand, cands: &mut HashMap<i64, Cand>| {
        cands
            .entry(c.p.id)
            .and_modify(|e| {
                if c.rel > e.rel {
                    e.rel = c.rel;
                }
            })
            .or_insert(c);
    };

    // 1. porter index
    if let Some(expr) = fts_expr(&parsed.words) {
        let sql = format!(
            "SELECT {COLS}, -bm25(search_fts, 1.0, 3.0) AS s
             FROM search_fts JOIN search_passages p ON p.id = search_fts.rowid
             WHERE search_fts MATCH :q AND {}
             ORDER BY s DESC LIMIT :lim",
            sc.sql
        );
        let rows = run_query(
            conn,
            &sql,
            &sc,
            vec![(":q", Value::Text(expr)), (":lim", Value::Integer(cand_n))],
        )?;
        let stems: Vec<String> = parsed.words.iter().map(|w| stem(w)).collect();
        for (p, s) in rows {
            let tw = lower_words(&p.text);
            // FTS matched at least one term, even when the prefix test misses a stemmed form
            let cov = lexical_coverage(&parsed.words, &stems, &tw).max(1.0 / parsed.words.len() as f32);
            let strength = 1.0 - (-(s.max(0.0)) / 6.0).exp();
            let rel = cov * (0.5 + 0.5 * strength as f32);
            keep(Cand { p, rel }, &mut cands);
        }
    }

    // 2. trigram index for CJK runs of three or more characters
    let windows = trigram_windows(&parsed.cjk_runs);
    if let Some(expr) = trigram_expr(&windows) {
        let sql = format!(
            "SELECT {COLS}, -bm25(search_fts_tri, 1.0, 3.0) AS s
             FROM search_fts_tri JOIN search_passages p ON p.id = search_fts_tri.rowid
             WHERE search_fts_tri MATCH :q AND {}
             ORDER BY s DESC LIMIT :lim",
            sc.sql
        );
        let rows = run_query(
            conn,
            &sql,
            &sc,
            vec![(":q", Value::Text(expr)), (":lim", Value::Integer(cand_n))],
        )?;
        let smax = rows.iter().map(|r| r.1).fold(0.0f64, f64::max).max(1e-9);
        for (p, s) in rows {
            let present = windows.iter().filter(|w| p.text.contains(w.as_str())).count();
            let cov = present as f32 / windows.len() as f32;
            let rel = cov * (0.5 + 0.5 * (s.max(0.0) / smax) as f32);
            keep(Cand { p, rel }, &mut cands);
        }
    }

    // 3. short CJK runs (one or two characters): scoped scan of CJK passages
    for run in parsed.cjk_runs.iter().filter(|r| r.chars().count() == 2).take(4) {
        let sql = format!(
            "SELECT {COLS},
                    CAST((length(p.text) - length(replace(p.text, :run, ''))) AS REAL) / length(:run) AS s
             FROM search_passages p
             WHERE p.cjk = 1 AND instr(p.text, :run) > 0 AND {}
             ORDER BY s DESC LIMIT :lim",
            sc.sql
        );
        let rows = run_query(
            conn,
            &sql,
            &sc,
            vec![(":run", Value::Text(run.clone())), (":lim", Value::Integer(cand_n))],
        )?;
        for (p, s) in rows {
            let rel = (0.35 + 0.15 * (1.0 + s.max(0.0)).ln() as f32).min(0.9);
            keep(Cand { p, rel }, &mut cands);
        }
    }

    // 4. score, floor, diversity
    let mut list: Vec<Cand> = cands.into_values().collect();
    for c in &mut list {
        c.p.relevance = c.rel;
        c.p.score = c.rel * if opts.recency { recency_factor(&c.p, opts.now_ms) } else { 1.0 };
    }
    list.sort_by(|a, b| b.p.score.partial_cmp(&a.p.score).unwrap_or(std::cmp::Ordering::Equal).then(a.p.id.cmp(&b.p.id)));
    let top = list.first().map(|c| c.p.score).unwrap_or(0.0);
    list.retain(|c| c.p.relevance >= opts.min_relevance && c.p.score >= opts.relative_floor * top);

    let mut picked = mmr_pick(list, limit, opts.max_per_source);
    for p in &mut picked {
        decorate(p, &parsed);
    }
    Ok(picked)
}

fn shingles(text: &str) -> HashSet<String> {
    let mut set = HashSet::new();
    for w in lower_words(text) {
        set.insert(w);
    }
    let cjk: Vec<char> = text.chars().filter(|c| is_cjk(*c)).collect();
    for w in cjk.windows(2) {
        set.insert(w.iter().collect());
    }
    set
}

fn jaccard(a: &HashSet<String>, b: &HashSet<String>) -> f32 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let inter = a.iter().filter(|x| b.contains(*x)).count();
    inter as f32 / (a.len() + b.len() - inter) as f32
}

/// MMR-style selection: best score first, minus a penalty for similarity to
/// what is already chosen; at most `max_per_source` per source; near
/// duplicates (Jaccard > 0.85) skipped.
fn mmr_pick(list: Vec<Cand>, limit: usize, max_per_source: usize) -> Vec<Passage> {
    let sets: Vec<HashSet<String>> = list.iter().map(|c| shingles(&c.p.text)).collect();
    let mut max_sim = vec![0.0f32; list.len()];
    let mut taken = vec![false; list.len()];
    let mut per_source: HashMap<(String, String, Option<String>), usize> = HashMap::new();
    let mut out: Vec<Passage> = Vec::new();
    while out.len() < limit {
        let mut best: Option<(usize, f32)> = None;
        for (i, c) in list.iter().enumerate() {
            if taken[i] || max_sim[i] > 0.85 {
                continue;
            }
            let key = (c.p.kind.clone(), c.p.ref_id.clone(), c.p.sub_ref.clone());
            if per_source.get(&key).copied().unwrap_or(0) >= max_per_source {
                continue;
            }
            let mmr = c.p.score - 0.15 * max_sim[i];
            if best.map_or(true, |(_, b)| mmr > b) {
                best = Some((i, mmr));
            }
        }
        let Some((bi, _)) = best else { break };
        taken[bi] = true;
        let c = &list[bi];
        *per_source.entry((c.p.kind.clone(), c.p.ref_id.clone(), c.p.sub_ref.clone())).or_insert(0) += 1;
        for j in 0..list.len() {
            if !taken[j] {
                let s = jaccard(&sets[bi], &sets[j]);
                if s > max_sim[j] {
                    max_sim[j] = s;
                }
            }
        }
        out.push(c.p.clone());
    }
    out
}

/// Match ranges inside the whole passage text (byte offsets).
fn match_spans(text: &str, q: &ParsedQuery) -> Vec<(usize, usize)> {
    let mut spans: Vec<(usize, usize)> = Vec::new();
    let stems: Vec<String> = q.words.iter().map(|w| stem(w)).collect();
    for (a, b) in word_spans(text) {
        let tok = text[a..b].to_lowercase();
        if q.words.iter().zip(&stems).any(|(w, st)| tok == *w || (st.len() >= 3 && tok.starts_with(st.as_str()))) {
            spans.push((a, b));
        }
    }
    for run in &q.cjk_runs {
        let chars: Vec<char> = run.chars().collect();
        let mut needles: Vec<String> = Vec::new();
        if chars.len() <= 3 {
            needles.push(run.clone());
        } else {
            for w in chars.windows(3) {
                needles.push(w.iter().collect());
            }
        }
        for n in needles {
            for (i, m) in text.match_indices(n.as_str()) {
                spans.push((i, i + m.len()));
            }
        }
    }
    spans.sort();
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for s in spans {
        match merged.last_mut() {
            Some(l) if s.0 <= l.1 => l.1 = l.1.max(s.1),
            _ => merged.push(s),
        }
    }
    merged
}

fn decorate(p: &mut Passage, q: &ParsedQuery) {
    let text = &p.text;
    let spans = match_spans(text, q);
    let budget = if is_mostly_cjk(text) { 110 } else { 260 };
    let first = spans.first().map(|s| s.0).unwrap_or(0);
    // window start: a quarter of the budget before the first match, in chars
    let before: Vec<(usize, char)> = text[..first].char_indices().collect();
    let back = budget / 4;
    let mut start = if before.len() > back { before[before.len() - back].0 } else { 0 };
    if start > 0 {
        // move to a word start when the cut is inside a Latin word
        if let Some(rel) = text[start..].find(|c: char| c.is_whitespace()) {
            if rel < 12 && !text[start..start + rel].chars().any(is_cjk) {
                start += rel + text[start + rel..].chars().next().map_or(0, |c| c.len_utf8());
            }
        }
    }
    let end = text[start..]
        .char_indices()
        .nth(budget)
        .map(|(i, _)| start + i)
        .unwrap_or(text.len());
    let prefix = if start > 0 { "…" } else { "" };
    let suffix = if end < text.len() { "…" } else { "" };
    p.snippet = format!("{prefix}{}{suffix}", text[start..end].trim_end());
    let base = prefix.encode_utf16().count() as u32;
    p.match_ranges = spans
        .iter()
        .filter(|(a, b)| *a >= start && *b <= end)
        .map(|(a, b)| {
            let from = base + text[start..*a].encode_utf16().count() as u32;
            let len = text[*a..*b].encode_utf16().count() as u32;
            (from, from + len)
        })
        .collect();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_search::test_support::*;

    fn day_ms(d: i64) -> i64 {
        d * 86_400_000
    }

    fn corpus() -> Connection {
        let conn = mem_db();
        index_lines(&conn, "m-acme", "Acme pricing call", day_ms(100), &[
            ("You", "Let us review the pricing proposal for Acme.", 0),
            ("Them", "We can accept a discount of fifteen percent if the contract runs two years.", 5000),
        ]);
        index_lines(&conn, "m-hr", "Hiring sync", day_ms(100), &[
            ("You", "The recruiter will schedule interviews for the backend engineer role.", 0),
        ]);
        index_doc(&conn, "d-policy", "Travel policy", "Employees book flights through the portal. Hotels are capped at 200 dollars per night.");
        conn
    }

    fn all_scope() -> SearchScope {
        SearchScope {
            meetings: MeetingScope::Ids(vec!["m-acme".into(), "m-hr".into()]),
            document_ids: vec!["d-policy".into()],
            ..Default::default()
        }
    }

    #[test]
    fn parse_drops_stopwords_and_syntax() {
        let q = parse_query("What did we decide about the \"pricing\" AND (NEAR/3 title:foo) -bar *");
        assert_eq!(q.words, vec!["decide", "pricing", "near", "3", "title", "foo", "bar"]);
        assert!(q.cjk_runs.is_empty());
        let e = fts_expr(&q.words).unwrap();
        assert!(e.starts_with("\"decide\" OR"));
    }

    #[test]
    fn parse_splits_cjk_runs_from_words() {
        let q = parse_query("契約更新 deadline は いつ");
        assert_eq!(q.words, vec!["deadline"]);
        assert_eq!(q.cjk_runs, vec!["契約更新", "は", "いつ"]);
    }

    #[test]
    fn finds_the_right_meeting_and_highlights() {
        let conn = corpus();
        let r = search(&conn, &all_scope(), "discount for the contract", &[], 5).unwrap();
        assert_eq!(r[0].ref_id, "m-acme");
        assert!(!r[0].match_ranges.is_empty());
        let (a, b) = r[0].match_ranges[0];
        let units: Vec<u16> = r[0].snippet.encode_utf16().collect();
        let hit = String::from_utf16(&units[a as usize..b as usize]).unwrap().to_lowercase();
        assert!(["discount", "contract"].contains(&hit.as_str()), "{hit}");
        assert!(r[0].start_ms.is_some());
    }

    #[test]
    fn stemming_matches_inflections() {
        let conn = corpus();
        let r = search(&conn, &all_scope(), "interviewing engineers", &[], 5).unwrap();
        assert_eq!(r[0].ref_id, "m-hr");
    }

    #[test]
    fn injection_attempts_are_harmless() {
        let conn = corpus();
        let scope = all_scope();
        let nasty = [
            "\"; DROP TABLE search_passages; --",
            "pricing OR 1=1",
            "NEAR(pricing discount, 2)",
            "text:pricing*",
            "title: \"unterminated",
            "(((",
            "*",
            "^pricing",
            "pricing -discount",
            "' OR '1'='1",
            "{text}: pricing",
            "\u{0}pricing\u{0}",
        ];
        for q in nasty {
            let r = search(&conn, &scope, q, &[], 5);
            assert!(r.is_ok(), "query {q:?} failed: {:?}", r.err());
        }
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM search_passages", [], |r| r.get(0)).unwrap();
        assert!(n >= 3);
        // the quoted words still search normally
        let r = search(&conn, &scope, "pricing OR 1=1", &[], 5).unwrap();
        assert_eq!(r[0].ref_id, "m-acme");
    }

    #[test]
    fn enormous_queries_are_bounded() {
        let conn = corpus();
        let long = "pricing ".repeat(20_000) + &"契約更新".repeat(5_000);
        assert!(search(&conn, &all_scope(), &long, &[], 5).is_ok());
        let many: String = (0..3000).map(|i| format!("w{i} ")).collect();
        assert!(search(&conn, &all_scope(), &many, &[], 5).is_ok());
        let q = parse_query(&many);
        assert!(q.words.len() <= 24);
    }

    #[test]
    fn empty_scope_and_empty_query_return_nothing() {
        let conn = corpus();
        assert!(search(&conn, &SearchScope::default(), "pricing", &[], 5).unwrap().is_empty());
        assert!(search(&conn, &all_scope(), "   ", &[], 5).unwrap().is_empty());
        assert!(search(&conn, &all_scope(), "the of and", &[], 5).unwrap().is_empty());
        assert!(search(&conn, &all_scope(), "pricing", &[], 0).unwrap().is_empty());
    }

    #[test]
    fn scope_never_leaks_canaries() {
        let conn = mem_db();
        index_lines(&conn, "m-in", "In scope", day_ms(10), &[("You", "The zebracanary plan is approved.", 0)]);
        index_lines(&conn, "m-out", "Other workspace", day_ms(10), &[("You", "zebracanary secret roadmap leak", 0)]);
        index_lines(&conn, "m-excl", "Excluded", day_ms(10), &[("You", "zebracanary excluded meeting", 0)]);
        index_doc(&conn, "d-in", "Doc in", "zebracanary documentation");
        index_doc(&conn, "d-out", "Doc out", "zebracanary hidden documentation");
        let tp = crate::workspace_search::passages::build_text_passages(
            PassageKind::TalkingPoint, "t-out", None, "Point", "zebracanary talking point", None);
        crate::workspace_search::store::replace_source(&conn, PassageKind::TalkingPoint, "t-out", None, &tp, "h", 0, 0).unwrap();
        let scope = SearchScope {
            meetings: MeetingScope::Ids(vec!["m-in".into(), "m-excl".into()]),
            document_ids: vec!["d-in".into()],
            excluded_meeting_ids: vec!["m-excl".into()],
            ..Default::default()
        };
        let r = search(&conn, &scope, "zebracanary", &[], 20).unwrap();
        let ids: HashSet<_> = r.iter().map(|p| p.ref_id.as_str()).collect();
        assert_eq!(ids, HashSet::from(["m-in", "d-in"]), "{ids:?}");
        // kinds filter
        let r = search(&conn, &scope, "zebracanary", &[PassageKind::Document], 20).unwrap();
        assert!(r.iter().all(|p| p.kind == "document"));
        assert_eq!(r.len(), 1);
    }

    #[test]
    fn home_workspace_predicate_filters_by_column() {
        let conn = mem_db();
        conn.execute_batch("ALTER TABLE meetings ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'general';").unwrap();
        add_meeting(&conn, "ma", "A", "2026-01-01T00:00:00Z", None, &[]);
        add_meeting(&conn, "mb", "B", "2026-01-01T00:00:00Z", None, &[]);
        conn.execute("UPDATE meetings SET workspace_id = 'w1' WHERE id = 'ma'", []).unwrap();
        index_lines(&conn, "ma", "A", day_ms(10), &[("You", "hedgehog alpha", 0)]);
        index_lines(&conn, "mb", "B", day_ms(10), &[("You", "hedgehog beta", 0)]);
        let scope = SearchScope { meetings: MeetingScope::HomeWorkspace("w1".into()), ..Default::default() };
        let r = search(&conn, &scope, "hedgehog", &[], 10).unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].ref_id, "ma");
    }

    #[test]
    fn recency_prefers_newer_transcripts_up_to_25_percent() {
        let conn = mem_db();
        let now = day_ms(1000);
        index_lines(&conn, "old", "Old", now - day_ms(400), &[("You", "kestrel budget review notes from last year", 0)]);
        index_lines(&conn, "new", "New", now - day_ms(1), &[("You", "kestrel budget review notes plus action items", 0)]);
        index_doc(&conn, "doc", "Doc", "kestrel budget review notes in the handbook");
        let scope = SearchScope {
            meetings: MeetingScope::Ids(vec!["old".into(), "new".into()]),
            document_ids: vec!["doc".into()],
            ..Default::default()
        };
        let opts = SearchOptions { now_ms: now, ..Default::default() };
        let r = search_with(&conn, &scope, "kestrel budget", &[], 5, &opts).unwrap();
        assert_eq!(r.len(), 3);
        let factor = |id: &str| {
            let p = r.iter().find(|p| p.ref_id == id).unwrap();
            p.score / p.relevance
        };
        assert!(factor("new") > factor("old"));
        assert!(factor("new") <= 1.2501 && factor("new") > 1.24, "{}", factor("new"));
        assert!(factor("old") < 1.01, "400 days old: {}", factor("old"));
        assert!((factor("doc") - 1.0).abs() < 1e-6, "documents get no recency");
    }

    #[test]
    fn max_three_passages_per_source() {
        let conn = mem_db();
        let long: Vec<(String, i64)> =
            (0..40).map(|i| (format!("alpha budget topic number{i} {}", "filler ".repeat(60)), i * 1000)).collect();
        let lines: Vec<(&str, &str, i64)> = long.iter().map(|(t, ms)| ("Them", t.as_str(), *ms)).collect();
        index_lines(&conn, "big", "Big", day_ms(1), &lines);
        let scope = SearchScope::with_meetings(["big"]);
        let r = search(&conn, &scope, "alpha budget topic", &[], 10).unwrap();
        assert_eq!(r.len(), 3, "got {}", r.len());
    }

    #[test]
    fn relevance_floor_drops_weak_matches() {
        let conn = corpus();
        // "portal" appears once in a doc; query with many unrelated words should not pull weak partials
        let r = search(&conn, &all_scope(), "quantum entanglement cryptography portal", &[], 5).unwrap();
        for p in &r {
            assert!(p.relevance >= 0.12);
        }
        let r2 = search(&conn, &all_scope(), "quantum entanglement cryptography", &[], 5).unwrap();
        assert!(r2.is_empty());
    }

    #[test]
    fn japanese_three_plus_characters_use_the_trigram_index() {
        let conn = mem_db();
        index_lines(&conn, "jp1", "契約会議", day_ms(10), &[
            ("You", "来月のゴールドマン案件の契約更新は三月十日までに完了する予定です。", 0),
            ("Them", "了解しました。法務部のレビューも必要ですね。", 4000),
        ]);
        index_lines(&conn, "jp2", "採用面接", day_ms(10), &[("You", "新卒採用の面接日程を調整します。エンジニア職の募集を増やします。", 0)]);
        let scope = SearchScope::with_meetings(["jp1", "jp2"]);
        let r = search(&conn, &scope, "ゴールドマン案件の契約更新はいつまで", &[], 5).unwrap();
        assert_eq!(r[0].ref_id, "jp1");
        assert!(!r[0].match_ranges.is_empty());
        let r = search(&conn, &scope, "面接日程", &[], 5).unwrap();
        assert_eq!(r[0].ref_id, "jp2");
        // porter-only search could not find these
        let tri: i64 = conn.query_row("SELECT COUNT(*) FROM search_fts_tri WHERE search_fts_tri MATCH '\"契約更\"'", [], |r| r.get(0)).unwrap();
        assert_eq!(tri, 1);
    }

    #[test]
    fn japanese_two_character_queries_fall_back_to_a_scoped_scan() {
        let conn = mem_db();
        index_lines(&conn, "jp1", "会議", day_ms(10), &[("You", "来月の契約について話しました。契約の更新は重要です。", 0)]);
        index_lines(&conn, "jp2", "雑談", day_ms(10), &[("You", "昨日の天気はとても良かったですね。", 0)]);
        let scope = SearchScope::with_meetings(["jp1", "jp2"]);
        let r = search(&conn, &scope, "契約", &[], 5).unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].ref_id, "jp1");
        // scope applies to the scan as well
        let scope = SearchScope::with_meetings(["jp2"]);
        assert!(search(&conn, &scope, "契約", &[], 5).unwrap().is_empty());
    }

    #[test]
    fn chinese_queries_work_with_two_and_longer_runs() {
        let conn = mem_db();
        index_lines(&conn, "zh1", "供应商会议", day_ms(10), &[("You", "供应商审核将在四月完成，预算上限是二十万元。", 0)]);
        index_lines(&conn, "zh2", "产品会议", day_ms(10), &[("You", "新产品的发布日期推迟到六月。", 0)]);
        let scope = SearchScope::with_meetings(["zh1", "zh2"]);
        let r = search(&conn, &scope, "供应商审核什么时候完成", &[], 5).unwrap();
        assert_eq!(r[0].ref_id, "zh1");
        let r = search(&conn, &scope, "预算", &[], 5).unwrap();
        assert_eq!(r[0].ref_id, "zh1");
        let r = search(&conn, &scope, "发布日期", &[], 5).unwrap();
        assert_eq!(r[0].ref_id, "zh2");
    }

    #[test]
    fn mixed_latin_and_cjk_queries_use_both_paths() {
        let conn = mem_db();
        index_lines(&conn, "mx", "Mixed", day_ms(10), &[("You", "The Tokyo office のレビューは来週です。", 0)]);
        let scope = SearchScope::with_meetings(["mx"]);
        assert_eq!(search(&conn, &scope, "tokyo", &[], 5).unwrap().len(), 1);
        assert_eq!(search(&conn, &scope, "レビューは来週", &[], 5).unwrap().len(), 1);
    }

    #[test]
    fn unicode_words_and_diacritics_match() {
        let conn = mem_db();
        index_doc(&conn, "d1", "Café", "Réunion sur le café et la crème brûlée à Zürich");
        let scope = SearchScope { document_ids: vec!["d1".into()], ..Default::default() };
        assert_eq!(search(&conn, &scope, "creme brulee zurich", &[], 5).unwrap().len(), 1);
        assert_eq!(search(&conn, &scope, "CAFÉ", &[], 5).unwrap().len(), 1);
    }
}
