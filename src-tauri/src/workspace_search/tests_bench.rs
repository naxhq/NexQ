//! Search latency benchmark: 500 meetings of 10,000 words each (about 30k
//! passages) in a WAL file database, searched through a 250-meeting scope.
//!
//! Ignored by default (it takes a while to build the corpus). Run with
//! `cargo test --lib bench_ -- --ignored --nocapture`; for release-like
//! numbers compile SQLite optimised, e.g.
//! `--config profile.test.package.libsqlite3-sys.opt-level=3`.

use super::indexer::open_search_connection;
use super::passages::{build_transcript_passages, SegmentInput};
use super::search::search;
use super::test_support::{migrate, temp_dir};
use super::{store, PassageKind, SearchScope};
use std::time::Instant;

struct Lcg(u64);
impl Lcg {
    fn next_f(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((self.0 >> 11) as f64) / ((1u64 << 53) as f64)
    }
}

const VOCAB: usize = 20_000;

fn word(rank: usize) -> String {
    const C: &[u8] = b"bcdfghjklmnprstvwz";
    const V: &[u8] = b"aeiou";
    let mut n = rank + 90; // at least two syllables
    let mut s = String::new();
    while n > 0 {
        let d = n % 90;
        s.push(C[d / 5] as char);
        s.push(V[d % 5] as char);
        n /= 90;
    }
    s
}

/// Zipf-like: log-uniform rank, so frequency falls off as 1/rank.
fn sample_rank(rng: &mut Lcg) -> usize {
    ((VOCAB as f64).powf(rng.next_f()) as usize).saturating_sub(1).min(VOCAB - 1)
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    sorted[((sorted.len() - 1) as f64 * p).round() as usize]
}

#[test]
#[ignore]
fn bench_search_500_meetings_10k_words() {
    let dir = temp_dir("bench");
    let path = dir.join("bench.db");
    let mut conn = open_search_connection(&path).unwrap();
    conn.execute_batch("CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT, start_time TEXT);").unwrap();
    migrate(&mut conn);
    let mut rng = Lcg(7);
    let words: Vec<String> = (0..VOCAB).map(word).collect();

    let t = Instant::now();
    let mut ids: Vec<String> = Vec::new();
    let mut total_passages = 0usize;
    for m in 0..500 {
        let id = format!("bm{m:03}");
        let mut segs: Vec<SegmentInput> = Vec::new();
        for line in 0..(10_000 / 14) {
            let text = (0..14).map(|_| words[sample_rank(&mut rng)].as_str()).collect::<Vec<_>>().join(" ");
            segs.push(SegmentInput { speaker: if line % 2 == 0 { "You" } else { "Them" }.into(), text, start_ms: line as i64 * 5000 });
        }
        let occurred = 1_700_000_000_000i64 + m as i64 * 86_400_000;
        let p = build_transcript_passages(&id, &format!("Meeting {m}"), Some(occurred), &segs, None);
        total_passages += p.len();
        let tx = conn.transaction().unwrap();
        store::replace_source(&tx, PassageKind::Transcript, &id, None, &p, "h", 0, 0).unwrap();
        tx.commit().unwrap();
        ids.push(id);
    }
    let build = t.elapsed();
    eprintln!("bench: indexed 500 meetings x 10k words = {total_passages} passages in {:.1}s", build.as_secs_f64());

    // 24 queries of 3 to 6 words, from common to rare
    let mut queries: Vec<String> = Vec::new();
    for q in 0..24 {
        let n = 3 + q % 4;
        let lo = if q < 6 { 0 } else if q < 14 { 30 } else { 400 };
        let hi = if q < 6 { 40 } else if q < 14 { 600 } else { 6000 };
        let q: Vec<&str> = (0..n).map(|_| words[lo + (rng.next_f() * (hi - lo) as f64) as usize].as_str()).collect();
        queries.push(q.join(" "));
    }
    let scope = SearchScope::with_meetings(ids.iter().step_by(2).cloned());
    // warm up
    for q in &queries {
        let _ = search(&conn, &scope, q, &[], 20).unwrap();
    }
    let mut times: Vec<f64> = Vec::new();
    for _ in 0..5 {
        for q in &queries {
            let t = Instant::now();
            let r = search(&conn, &scope, q, &[], 20).unwrap();
            times.push(t.elapsed().as_secs_f64() * 1000.0);
            assert!(r.len() <= 20);
        }
    }
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    eprintln!(
        "bench: search over {} passages / 250-meeting scope: p50 {:.1} ms, p95 {:.1} ms, max {:.1} ms ({} runs)",
        total_passages,
        percentile(&times, 0.5),
        percentile(&times, 0.95),
        times.last().unwrap(),
        times.len()
    );
    if std::env::var("NEXQ_BENCH_STRICT").is_ok() {
        assert!(percentile(&times, 0.95) < 150.0);
    }
    std::fs::remove_dir_all(&dir).ok();
}
