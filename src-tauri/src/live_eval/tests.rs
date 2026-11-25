use super::score::*;
use super::scripted::{Lang, ALL_LANGS};
use super::sim::{simulate_brief, simulate_notes};
use crate::live_notes::doc::{Block, BlockKind, NoteDoc};
use crate::live_notes::prompts::Detail;

#[test]
fn notes_fixtures_parse_and_never_break_a_rule() {
    eprintln!("{}", report());
    let mut parsed = 0;
    let mut total = 0;
    for lang in ALL_LANGS {
        let lines = transcript(lang);
        for size in SIZES {
            let (doc, s) = score_notes(&lines, notes_output(lang, size), &NoteDoc::new());
            total += 1;
            if s.parsed {
                parsed += 1;
            }
            assert!(s.violations.is_empty(), "{lang:?} {size}: {:?}", s.violations);
            assert!(doc.blocks.len() <= 12, "max ops per run");
            if size == "large" {
                assert!(s.parsed && s.applied >= 8, "{lang:?} large applied {}", s.applied);
                assert!(s.support_rate() >= 0.95, "{lang:?} large support {}", s.support_rate());
            }
            if size == "medium" || size == "small" {
                assert!(s.parsed && s.applied >= 5, "{lang:?} {size}");
                assert!(s.support_rate() >= 0.7, "{lang:?} {size} support {}", s.support_rate());
            }
        }
    }
    assert!(parsed >= 11, "parsed {parsed}/{total}");
}

#[test]
fn tiny_models_hallucinate_and_the_score_shows_it() {
    let lines = transcript(Lang::En);
    let (_, s) = score_notes(&lines, notes_output(Lang::En, "tiny"), &NoteDoc::new());
    assert!(s.parsed);
    assert!(s.support_rate() < 0.7, "tiny support {}", s.support_rate());
    let (_, es) = score_notes(&transcript(Lang::Es), notes_output(Lang::Es, "tiny"), &NoteDoc::new());
    assert!(!es.parsed, "a refusal is not notes");
}

fn guarded_doc() -> NoteDoc {
    let b = |id: &str, kind: BlockKind, parent: Option<&str>, text: &str, order: u32, pinned: bool, edited: bool| Block {
        id: id.into(),
        kind,
        parent: parent.map(|s| s.into()),
        text: text.into(),
        start_ms: 5_000,
        end_ms: 5_000,
        edited,
        pinned,
        order,
    };
    NoteDoc {
        version: 1,
        next_id: 8,
        uncovered: None,
        blocks: vec![
            b("b4", BlockKind::Topic, None, "Old topic", 0, false, false),
            b("b5", BlockKind::Bullet, Some("b4"), "Old topic child", 1, false, false),
            b("b6", BlockKind::Topic, None, "Middle topic", 2, false, false),
            b("b1", BlockKind::Topic, None, "Q3 budget", 4, true, false),
            b("b2", BlockKind::Bullet, Some("b1"), "Pinned bullet", 5, true, false),
            b("b3", BlockKind::Bullet, Some("b1"), "Edited by me", 6, false, true),
            b("b7", BlockKind::Topic, None, "Latest topic", 7, false, false),
        ],
    }
}

#[test]
fn adversarial_output_cannot_touch_locked_or_old_blocks() {
    let before = guarded_doc();
    let (after, s) = score_notes(&transcript(Lang::En), adversarial_output(), &before);
    assert!(s.parsed, "tolerant parse finds the JSON after the injected prose");
    assert!(s.violations.is_empty(), "{:?}", s.violations);
    for id in ["b1", "b2", "b3", "b4", "b5"] {
        assert_eq!(after.get(id).unwrap().text, before.get(id).unwrap().text, "{id}");
    }
    assert_eq!(after.get("b2").unwrap().parent.as_deref(), Some("b1"));
    assert!(s.applied <= 12);
    assert!(after.blocks.iter().all(|b| b.text.chars().count() <= b.kind.max_chars()));
    // the injected tag stays inert text inside a note
    assert!(after.blocks.iter().filter(|b| b.text.contains("</transcript>")).all(|b| b.start_ms <= 185_000));
}

#[test]
fn brief_fixtures_support() {
    let mut shown_unsupported = 0;
    for lang in ALL_LANGS {
        for size in SIZES {
            if let Some(raw) = brief_output(lang, size) {
                let s = score_brief(raw, &brief_passages(lang));
                shown_unsupported += s.shown_unsupported;
                assert!(s.parsed, "{lang:?} {size}");
                if size == "large" {
                    assert_eq!(s.facts_shown, s.facts_in_answer, "{lang:?} large");
                    assert!(s.facts_shown >= 3);
                }
                if size == "medium" || size == "small" {
                    assert!(s.dropped_unsupported >= 1, "{lang:?} {size} should have unsupported claims dropped");
                    assert!(s.raw_support_rate() < 1.0);
                }
            }
        }
    }
    assert_eq!(shown_unsupported, 0, "nothing unsupported is ever shown");
}

#[test]
fn one_hour_of_notes_costs_and_rules() {
    let mut lines = vec![];
    for (detail, name) in [(Detail::Brief, "brief"), (Detail::Standard, "standard"), (Detail::Detailed, "detailed")] {
        let s = simulate_notes(detail, 11, 3600);
        eprintln!(
            "notes 1h {name}: runs={} failed={} counted={} sent={} max_outline={} max_user={} applied={} dropped={} blocks={} violations={}",
            s.runs, s.failed, s.counted_tokens, s.sent_tokens, s.max_outline_tokens, s.max_user_tokens, s.applied_ops, s.dropped_ops, s.blocks, s.violations.len()
        );
        assert!(s.violations.is_empty(), "{name}: {:?}", &s.violations[..s.violations.len().min(5)]);
        assert_eq!(s.failed, 0);
        assert!(s.runs >= 50 && s.runs <= 100, "{name} runs {}", s.runs);
        assert!(s.max_outline_tokens <= 920, "{name} outline {}", s.max_outline_tokens);
        assert!(s.counted_tokens < 120_000, "{name}: the default cap of 120k is not reached in an hour ({})", s.counted_tokens);
        lines.push(s.counted_tokens);
    }
    assert!(lines[0] < lines[1] && lines[1] < lines[2], "{lines:?}");
}

#[test]
fn one_hour_of_brief() {
    for drift in [0u32, 4] {
        let s = simulate_brief(5, 3600, drift);
        eprintln!(
            "brief 1h drift_every={drift}: searches={} calls={} failed={} topic_changes={} counted={} sent={} facts={}",
            s.searches, s.calls, s.failed, s.topic_changes, s.counted_tokens, s.sent_tokens, s.facts_shown
        );
        assert_eq!(s.failed, 0);
        assert!(s.topic_changes >= 10 && s.topic_changes <= 16, "{}", s.topic_changes);
        assert!(s.calls >= s.topic_changes.min(10));
        assert!(s.counted_tokens < 120_000);
    }
}
