//! Cutting sources into passages: transcripts on speaker turns (with start and
//! end times), documents and talking points by paragraph and sentence, and
//! Markdown by heading. Sizes are counted in units (Latin words, CJK
//! characters).

use super::cjk::{chunk_text, estimate_tokens, is_mostly_cjk, unit_count};
use super::PassageKind;

pub const MIN_UNITS: usize = 120;
pub const MAX_UNITS: usize = 220;
/// Hard cap per source so one pathological file cannot flood the index.
pub const MAX_PASSAGES_PER_SOURCE: usize = 3000;
/// Longest passage text in bytes.
pub const MAX_PASSAGE_BYTES: usize = 16_000;
/// Markdown sections smaller than this are merged with the next one.
const SMALL_SECTION_UNITS: usize = 60;

#[derive(Debug, Clone, PartialEq)]
pub struct NewPassage {
    pub kind: PassageKind,
    pub ref_id: String,
    pub sub_ref: Option<String>,
    pub title: String,
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
    pub text: String,
    pub tokens: usize,
    pub occurred_at: Option<i64>,
    pub cjk: bool,
}

/// One saved final line of a meeting.
#[derive(Debug, Clone, PartialEq)]
pub struct SegmentInput {
    pub speaker: String,
    pub text: String,
    pub start_ms: i64,
}

fn make(
    kind: PassageKind,
    ref_id: &str,
    sub_ref: Option<&str>,
    title: &str,
    text: String,
    start_ms: Option<i64>,
    end_ms: Option<i64>,
    occurred_at: Option<i64>,
) -> NewPassage {
    // a single unbroken token (minified data, base64) must not make a giant passage
    let text = if text.len() > MAX_PASSAGE_BYTES {
        let mut cut = MAX_PASSAGE_BYTES;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text[..cut].to_string()
    } else {
        text
    };
    NewPassage {
        kind,
        ref_id: ref_id.to_string(),
        sub_ref: sub_ref.map(|s| s.to_string()),
        title: title.to_string(),
        tokens: estimate_tokens(&text),
        cjk: is_mostly_cjk(&text),
        text,
        start_ms,
        end_ms,
        occurred_at,
    }
}

fn clean(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n").replace('\0', "")
}

/// Rough speaking time of a line (400 ms a word, 250 ms a CJK character).
fn estimate_duration_ms(text: &str) -> i64 {
    let cjk = text.chars().filter(|c| super::cjk::is_cjk(*c)).count() as i64;
    let words = unit_count(text) as i64 - cjk;
    (words * 400 + cjk * 250).max(800)
}

struct Piece {
    speaker: String,
    text: String,
    start: i64,
    end: i64,
}

/// Transcript passages of 120 to 220 units on speaker-turn boundaries.
/// Consecutive lines of one speaker are merged into a turn; a turn longer
/// than a passage is cut at sentence ends with its times shared out by size.
pub fn build_transcript_passages(
    meeting_id: &str,
    title: &str,
    occurred_at: Option<i64>,
    segments: &[SegmentInput],
    total_ms: Option<i64>,
) -> Vec<NewPassage> {
    let mut segs: Vec<&SegmentInput> = segments.iter().filter(|s| !s.text.trim().is_empty()).collect();
    segs.sort_by_key(|s| s.start_ms);

    struct Turn {
        speaker: String,
        text: String,
        start: i64,
        end: i64,
    }
    let mut turns: Vec<Turn> = Vec::new();
    for (i, s) in segs.iter().enumerate() {
        let text = clean(s.text.trim());
        let est = estimate_duration_ms(&text);
        let cap = est.max(10_000);
        let mut end = match segs.get(i + 1) {
            Some(n) if n.start_ms > s.start_ms => n.start_ms.min(s.start_ms + cap),
            _ => s.start_ms + est,
        };
        if let Some(t) = total_ms {
            if t > s.start_ms {
                end = end.min(t);
            }
        }
        end = end.max(s.start_ms);
        match turns.last_mut() {
            Some(t) if t.speaker == s.speaker => {
                t.text.push(' ');
                t.text.push_str(&text);
                t.end = end;
            }
            _ => turns.push(Turn { speaker: s.speaker.clone(), text, start: s.start_ms, end }),
        }
    }

    // Split oversized turns into pieces of at most MAX_UNITS.
    let mut pieces: Vec<Piece> = Vec::new();
    for t in turns {
        let units = unit_count(&t.text);
        if units <= MAX_UNITS {
            pieces.push(Piece { speaker: t.speaker, text: t.text, start: t.start, end: t.end });
            continue;
        }
        let chunks = chunk_text(&t.text, MAX_UNITS);
        let total_u: usize = chunks.iter().map(|c| unit_count(c)).sum::<usize>().max(1);
        let span = (t.end - t.start).max(0);
        let mut done = 0usize;
        for c in chunks {
            let u = unit_count(&c);
            let s = t.start + span * done as i64 / total_u as i64;
            done += u;
            let e = t.start + span * done as i64 / total_u as i64;
            pieces.push(Piece { speaker: t.speaker.clone(), text: c, start: s, end: e });
        }
    }

    // Pack pieces.
    struct Acc {
        lines: Vec<String>,
        units: usize,
        start: i64,
        end: i64,
    }
    let flush = |a: Acc, out: &mut Vec<NewPassage>| {
        out.push(make(
            PassageKind::Transcript,
            meeting_id,
            None,
            title,
            a.lines.join("\n"),
            Some(a.start),
            Some(a.end),
            occurred_at,
        ));
    };
    let mut out: Vec<NewPassage> = Vec::new();
    let mut acc: Option<Acc> = None;
    let mut last_units = 0usize;
    for p in pieces {
        let u = unit_count(&p.text);
        let line = format!("{}: {}", p.speaker, p.text);
        match acc.as_mut() {
            Some(a) if a.units + u <= MAX_UNITS => {
                a.lines.push(line);
                a.units += u;
                a.end = p.end.max(a.end);
            }
            _ => {
                if let Some(a) = acc.take() {
                    last_units = a.units;
                    flush(a, &mut out);
                }
                acc = Some(Acc { lines: vec![line], units: u, start: p.start, end: p.end });
            }
        }
        if out.len() >= MAX_PASSAGES_PER_SOURCE {
            return out;
        }
    }
    if let Some(a) = acc.take() {
        // Merge a tiny tail into the previous passage when it still fits.
        if a.units < 40 && last_units > 0 && last_units + a.units <= MAX_UNITS + 40 {
            if let Some(prev) = out.last_mut() {
                prev.text.push('\n');
                prev.text.push_str(&a.lines.join("\n"));
                prev.end_ms = Some(a.end.max(prev.end_ms.unwrap_or(a.end)));
                prev.tokens = estimate_tokens(&prev.text);
                prev.cjk = is_mostly_cjk(&prev.text);
            }
        } else {
            flush(a, &mut out);
        }
    }
    out.truncate(MAX_PASSAGES_PER_SOURCE);
    out
}

/// Plain text (documents, talking points) in passages of about 220 units.
pub fn build_text_passages(
    kind: PassageKind,
    ref_id: &str,
    sub_ref: Option<&str>,
    title: &str,
    text: &str,
    occurred_at: Option<i64>,
) -> Vec<NewPassage> {
    let text = clean(text);
    let mut out: Vec<NewPassage> = chunk_text(&text, MAX_UNITS)
        .into_iter()
        .map(|c| make(kind, ref_id, sub_ref, title, c, None, None, occurred_at))
        .collect();
    out.truncate(MAX_PASSAGES_PER_SOURCE);
    out
}

/// Markdown by heading: each passage's title carries the heading path
/// (`file > H1 > H2`); tiny sections are merged with the next.
pub fn build_markdown_passages(
    folder_id: &str,
    rel_path: &str,
    text: &str,
    occurred_at: Option<i64>,
) -> Vec<NewPassage> {
    let text = clean(text);
    let stem = rel_path
        .rsplit('/')
        .next()
        .unwrap_or(rel_path)
        .rsplit_once('.')
        .map(|(s, _)| s)
        .unwrap_or(rel_path)
        .to_string();

    struct Section {
        path: Vec<String>,
        body: String,
    }
    let mut sections: Vec<Section> = vec![Section { path: Vec::new(), body: String::new() }];
    let mut stack: Vec<(usize, String)> = Vec::new();
    let mut in_fence = false;
    for line in text.lines() {
        let t = line.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            in_fence = !in_fence;
        }
        let indent_ok = line.len() - t.len() <= 3;
        let hashes = t.chars().take_while(|c| *c == '#').count();
        let is_heading = !in_fence
            && indent_ok
            && (1..=6).contains(&hashes)
            && t[hashes..].starts_with(' ')
            && !t[hashes..].trim().is_empty();
        if is_heading {
            let name = t[hashes..].trim().trim_end_matches('#').trim().to_string();
            while stack.last().map_or(false, |(l, _)| *l >= hashes) {
                stack.pop();
            }
            stack.push((hashes, name));
            sections.push(Section {
                path: stack.iter().map(|(_, n)| n.clone()).collect(),
                body: format!("{}\n", t.trim_end()),
            });
        } else if let Some(s) = sections.last_mut() {
            s.body.push_str(line);
            s.body.push('\n');
        }
    }

    // Merge small sections forward.
    let mut merged: Vec<Section> = Vec::new();
    let mut pending: Option<Section> = None;
    for sec in sections {
        if sec.body.trim().is_empty() {
            continue;
        }
        match pending.take() {
            Some(p) => {
                if unit_count(&p.body) < SMALL_SECTION_UNITS
                    && unit_count(&p.body) + unit_count(&sec.body) <= MAX_UNITS
                {
                    // the small section's text joins the next one, which keeps its own title
                    let mut body = p.body;
                    body.push('\n');
                    body.push_str(&sec.body);
                    pending = Some(Section { path: sec.path, body });
                } else {
                    merged.push(p);
                    pending = Some(sec);
                }
            }
            None => pending = Some(sec),
        }
    }
    if let Some(p) = pending {
        merged.push(p);
    }

    let mut out = Vec::new();
    for sec in merged {
        let title = if sec.path.is_empty() {
            stem.clone()
        } else {
            format!("{} > {}", stem, sec.path.join(" > "))
        };
        for c in chunk_text(&sec.body, MAX_UNITS) {
            out.push(make(
                PassageKind::Folder,
                folder_id,
                Some(rel_path),
                &title,
                c,
                None,
                None,
                occurred_at,
            ));
            if out.len() >= MAX_PASSAGES_PER_SOURCE {
                return out;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(speaker: &str, text: &str, start_ms: i64) -> SegmentInput {
        SegmentInput { speaker: speaker.into(), text: text.into(), start_ms }
    }

    fn words(n: usize, tag: &str) -> String {
        (0..n).map(|i| format!("{tag}{i}")).collect::<Vec<_>>().join(" ")
    }

    #[test]
    fn transcript_passages_are_120_to_220_units_with_times() {
        let mut segs = Vec::new();
        for i in 0..60 {
            let speaker = if i % 2 == 0 { "You" } else { "Them" };
            segs.push(seg(speaker, &words(30, &format!("s{i}x")), i * 10_000));
        }
        let p = build_transcript_passages("m1", "Weekly", Some(1), &segs, Some(600_000));
        assert!(p.len() >= 7, "{}", p.len());
        for (i, x) in p.iter().enumerate() {
            let u = unit_count(&x.text);
            // speaker labels add one unit per line; allow slack
            assert!(u <= MAX_UNITS + 20, "passage {i} has {u}");
            if i + 1 < p.len() {
                assert!(u >= MIN_UNITS - 5, "passage {i} has only {u}");
            }
            assert!(x.start_ms.unwrap() <= x.end_ms.unwrap());
            assert_eq!(x.title, "Weekly");
        }
        assert_eq!(p[0].start_ms, Some(0));
        assert!(p.windows(2).all(|w| w[0].start_ms <= w[1].start_ms));
    }

    #[test]
    fn same_speaker_lines_merge_into_one_turn() {
        let segs = vec![
            seg("You", "hello there", 0),
            seg("You", "how are you", 2000),
            seg("Them", "fine thanks", 4000),
        ];
        let p = build_transcript_passages("m", "t", None, &segs, None);
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].text, "You: hello there how are you\nThem: fine thanks");
    }

    #[test]
    fn one_huge_turn_is_split_with_shared_out_times() {
        let text = (0..160).map(|i| format!("Sentence number {i} is here.")).collect::<Vec<_>>().join(" ");
        let p = build_transcript_passages("m", "t", None, &[seg("Them", &text, 0), seg("You", "ok", 120_000)], None);
        assert!(p.len() >= 3);
        assert!(p.iter().all(|x| unit_count(&x.text) <= MAX_UNITS + 5));
        let ends: Vec<_> = p.iter().map(|x| x.end_ms.unwrap()).collect();
        assert!(ends.windows(2).all(|w| w[0] <= w[1]));
    }

    #[test]
    fn japanese_transcript_counts_characters() {
        let line = "来月の契約更新について確認します。".repeat(30); // 17 chars x 30 = 510
        let p = build_transcript_passages("m", "会議", None, &[seg("You", &line, 0)], None);
        assert!(p.len() >= 2);
        assert!(p.iter().all(|x| x.cjk));
        assert!(p.iter().all(|x| unit_count(&x.text) <= MAX_UNITS + 10));
        // chars / 1.5
        assert!(p[0].tokens >= unit_count(&p[0].text) * 2 / 3);
    }

    #[test]
    fn empty_and_blank_segments_give_no_passages() {
        assert!(build_transcript_passages("m", "t", None, &[], None).is_empty());
        assert!(build_transcript_passages("m", "t", None, &[seg("You", "   ", 0)], None).is_empty());
    }

    #[test]
    fn markdown_is_split_by_heading_and_titles_carry_the_path() {
        let md = format!(
            "# Guide\nintro text\n\n## Setup\n{}\n\n## Usage\n{}\n\n```\n# not a heading\n```\n",
            words(100, "setup"),
            words(100, "usage")
        );
        let p = build_markdown_passages("f1", "docs/guide.md", &md, None);
        assert!(p.iter().any(|x| x.title == "guide > Guide > Setup"), "{:?}", p.iter().map(|x| &x.title).collect::<Vec<_>>());
        assert!(p.iter().any(|x| x.title == "guide > Guide > Usage"));
        assert!(p.iter().all(|x| x.sub_ref.as_deref() == Some("docs/guide.md")));
        assert!(p.iter().any(|x| x.text.contains("# not a heading")));
    }

    #[test]
    fn tiny_markdown_sections_are_merged() {
        let md = "# A\none\n# B\ntwo\n# C\nthree\n";
        let p = build_markdown_passages("f", "a.md", md, None);
        assert_eq!(p.len(), 1);
        assert!(p[0].text.contains("three"));
    }

    #[test]
    fn a_single_giant_token_cannot_make_a_giant_passage() {
        let blob = "A1b2".repeat(200_000); // 800 KB without a space
        let p = build_text_passages(PassageKind::Document, "d", None, "Blob", &blob, None);
        assert!(!p.is_empty());
        assert!(p.iter().all(|x| x.text.len() <= MAX_PASSAGE_BYTES));
        let jp = "あ".repeat(100_000);
        let p = build_text_passages(PassageKind::Document, "d", None, "JP", &jp, None);
        assert!(p.iter().all(|x| x.text.len() <= MAX_PASSAGE_BYTES));
    }

    #[test]
    fn text_passages_cap_the_count() {
        let big = (0..(MAX_UNITS * (MAX_PASSAGES_PER_SOURCE + 5)))
            .map(|_| "w")
            .collect::<Vec<_>>()
            .join(" ");
        let p = build_text_passages(PassageKind::Document, "d", None, "Doc", &big, None);
        assert_eq!(p.len(), MAX_PASSAGES_PER_SOURCE);
    }
}
