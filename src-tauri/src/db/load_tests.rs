//! Load test for the live path: a recording meeting appends transcript segments while the
//! person types in the workspace rail and the brief searches the workspace, on a database
//! with 200 chats, 100 meetings and a 5,000-file folder in the index.
//!
//! The reads run on read-only connections (`ReaderPool`), so the writer never waits for
//! them. The same load with the reads on the writer's own connection (what the app did
//! before) is measured as well and printed, to show what the readers buy.
//!
//! Run: `cargo test --lib -q db::load_tests -- --nocapture`

use super::meetings::{append_transcript_segment, create_meeting, TranscriptSegment};
use super::readers::ReaderPool;
use super::DatabaseManager;
use crate::workspace_search::passages::{build_text_passages, build_transcript_passages, SegmentInput};
use crate::workspace_search::{search, store as wstore, MeetingScope, PassageKind, SearchScope};
use rusqlite::Connection;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const CHATS: usize = 200;
const MEETINGS: usize = 100;
const FILES: usize = 5_000;
const APPENDS: usize = 600;

fn percentile(mut v: Vec<f64>, p: f64) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[((v.len() as f64 * p).ceil() as usize).saturating_sub(1).min(v.len() - 1)]
}

fn seed(dir: &std::path::Path) -> (DatabaseManager, String) {
    let mgr = DatabaseManager::new(dir.to_path_buf()).expect("database");
    let conn = mgr.connection();
    for _ in 0..CHATS {
        crate::workspace_chat::store::create_chat(conn, "general", None, None, None).expect("chat");
    }
    let tx = conn.unchecked_transaction().unwrap();
    let mut live = String::new();
    for m in 0..MEETINGS {
        let meeting = create_meeting(&tx, &format!("Weekly sync {m}")).unwrap();
        let segs: Vec<SegmentInput> = (0..40)
            .map(|i| SegmentInput { speaker: "Them".into(), text: format!("budget forecast item {i} for quarter {m} and the renewal"), start_ms: i * 4000 })
            .collect();
        let p = build_transcript_passages(&meeting.id, &meeting.title, Some(1_700_000_000_000), &segs, None);
        wstore::replace_source(&tx, PassageKind::Transcript, &meeting.id, None, &p, "h", 0, 0).unwrap();
        live = meeting.id;
    }
    for f in 0..FILES {
        let rel = format!("notes/{}/file-{f}.md", f % 50);
        let text = format!("Project note {f}. The budget review covers vendor {f}, renewal terms, headcount and the forecast for the next quarter. ").repeat(5);
        let p = build_text_passages(PassageKind::Folder, "f1", Some(&rel), &format!("file-{f}"), &text, Some(1_700_000_000_000));
        wstore::replace_source(&tx, PassageKind::Folder, "f1", Some(&rel), &p, "h", 0, 0).unwrap();
    }
    tx.commit().unwrap();
    (mgr, live)
}

fn segment(meeting_id: &str, i: usize) -> TranscriptSegment {
    TranscriptSegment {
        id: format!("live-{i}"),
        meeting_id: meeting_id.to_string(),
        text: format!("and the budget forecast moves again, line {i}"),
        speaker: "Them".into(),
        speaker_id: None,
        speaker_tag: None,
        timestamp_ms: i as i64 * 1500,
        is_final: true,
        confidence: 0.9,
        created_at: chrono::Utc::now().to_rfc3339(),
    }
}

fn scope() -> SearchScope {
    SearchScope { meetings: MeetingScope::HomeWorkspace("general".into()), folder_ids: vec!["f1".into()], ..Default::default() }
}

/// What one reader does per round: a rail query as the person types, then a brief search.
fn reader_round(conn: &Connection, round: usize) {
    let typed = ["b", "bu", "bud", "budg", "budge", "budget"][round % 6];
    let _ = crate::workspace::meetings::list_workspace_meetings(conn, "general", Some(typed), 50, 0);
    let kinds = [PassageKind::Transcript, PassageKind::Folder];
    let _ = search::search(conn, &scope(), "budget forecast renewal", &kinds, 8);
}

struct Run {
    appends_ms: Vec<f64>,
    rounds: usize,
}

/// `readers`: how the readers get their connection. The writer appends at a steady pace.
fn run(writer: Arc<Mutex<Connection>>, meeting: &str, appends: usize, reads: impl Fn(usize) + Send + Sync + 'static) -> Run {
    let stop = Arc::new(AtomicBool::new(false));
    let reads = Arc::new(reads);
    let rounds = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let threads: Vec<_> = (0..2)
        .map(|_| {
            let (stop, reads, rounds) = (stop.clone(), reads.clone(), rounds.clone());
            std::thread::spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    reads(rounds.fetch_add(1, Ordering::Relaxed));
                }
            })
        })
        .collect();
    let mut appends_ms = Vec::with_capacity(appends);
    let deadline = Instant::now() + Duration::from_secs(25);
    for i in 0..appends {
        if Instant::now() > deadline {
            break;
        }
        let start = Instant::now();
        {
            let g = writer.lock().unwrap();
            append_transcript_segment(&g, meeting, &segment(meeting, i)).unwrap();
        }
        appends_ms.push(start.elapsed().as_secs_f64() * 1000.0);
        std::thread::sleep(Duration::from_millis(5));
    }
    stop.store(true, Ordering::Relaxed);
    for t in threads {
        t.join().unwrap();
    }
    Run { appends_ms, rounds: rounds.load(Ordering::Relaxed) }
}

/// With readers on their own connections; `compare` also measures the old way (shared connection).
fn scenario(compare: bool, limit_ms: f64) {
    let dir = std::env::temp_dir().join(format!("nexq-load-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let t0 = Instant::now();
    let (mgr, meeting) = seed(&dir);
    println!("seeded {CHATS} chats, {MEETINGS} meetings, {FILES} files in {:.1} s", t0.elapsed().as_secs_f64());
    let path = mgr.path().to_path_buf();
    drop(mgr);
    let writer = Arc::new(Mutex::new(super::open_writer(&path).unwrap()));
    {
        let probe = ReaderPool::new(path.clone());
        let started = Instant::now();
        probe.with(|c| reader_round(c, 5)).unwrap();
        println!("one rail query + one brief search alone: {:.1} ms", started.elapsed().as_secs_f64() * 1000.0);
    }

    // Before: the reads share the writer's connection (and so its lock).
    let before = compare.then(|| {
        let shared = writer.clone();
        // few appends: with the reads in the way each one waits a very long time
        run(writer.clone(), &meeting, 40, move |round| {
            let g = shared.lock().unwrap();
            reader_round(&g, round);
        })
    });
    // After: the reads run on read-only connections of their own.
    let pool = Arc::new(ReaderPool::new(path));
    let after = run(writer.clone(), &meeting, APPENDS, move |round| {
        let _ = pool.with(|c| reader_round(c, round));
    });

    let report = |name: &str, r: &Run| {
        let (p50, p99, max) = (percentile(r.appends_ms.clone(), 0.5), percentile(r.appends_ms.clone(), 0.99), percentile(r.appends_ms.clone(), 1.0));
        println!("{name}: append p50 {p50:.2} ms, p99 {p99:.2} ms, max {max:.2} ms over {} appends; {} read rounds", r.appends_ms.len(), r.rounds);
        p99
    };
    let p99_before = before.as_ref().map(|b| report("reads on the shared connection", b));
    let p99_after = report("reads on reader connections  ", &after);
    let _ = std::fs::remove_dir_all(&dir);
    assert!(p99_after < limit_ms, "append p99 was {p99_after:.2} ms with readers (before: {p99_before:?} ms)");
}

// Waiting for whole reads takes seconds. The limit leaves room for a busy build
// machine; the measured target (20 ms) is in the ignored test.
#[test]
fn appending_segments_does_not_wait_for_the_rail_and_the_brief_to_read() {
    scenario(false, 500.0);
}

#[test]
#[ignore = "also measures the old way, where an append waits for whole reads (about a minute): cargo test --lib -q db::load_tests -- --ignored --nocapture"]
fn the_same_load_on_the_shared_connection_for_comparison() {
    scenario(true, 20.0);
}
