//! Meeting cards: a short recap per meeting for the context ladder. The
//! recap is the saved summary when there is one, else a local extract
//! (title, date, length, distinctive terms and two or three salient lines).
//! A card is rebuilt only when its source hash changes.

use super::cjk::{estimate_tokens, is_cjk, split_sentences, unit_count};
use super::passages::SegmentInput;
use super::store::sha_hex;
use super::now_ms;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const SUMMARY_CAP_CHARS: usize = 900;
const LINE_CAP_CHARS: usize = 170;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CardOrigin {
    Summary,
    Extract,
    Ai,
}

impl CardOrigin {
    pub fn as_str(&self) -> &'static str {
        match self {
            CardOrigin::Summary => "summary",
            CardOrigin::Extract => "extract",
            CardOrigin::Ai => "ai",
        }
    }
    pub fn parse(s: &str) -> Self {
        match s {
            "summary" => CardOrigin::Summary,
            "ai" => CardOrigin::Ai,
            _ => CardOrigin::Extract,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Card {
    pub meeting_id: String,
    pub recap: String,
    pub origin: CardOrigin,
    pub source_hash: String,
    pub tokens: usize,
    pub updated_at: i64,
}

pub struct CardInput<'a> {
    pub meeting_id: &'a str,
    pub title: &'a str,
    pub started_at_ms: Option<i64>,
    pub duration_s: Option<i64>,
    pub summary: Option<&'a str>,
    pub lines: &'a [SegmentInput],
}

/// Cheap fingerprint of everything a card depends on (no transcript load).
pub fn card_key(title: &str, summary: Option<&str>, segment_count: i64, text_len: i64, duration_s: Option<i64>) -> String {
    sha_hex(
        format!(
            "{}\u{1}{}\u{1}{}\u{1}{}\u{1}{}",
            title,
            summary.unwrap_or(""),
            segment_count,
            text_len,
            duration_s.unwrap_or(-1)
        )
        .as_bytes(),
    )
}

const COMMON: &[&str] = &[
    "that", "this", "with", "have", "from", "they", "what", "about", "would", "there", "their",
    "will", "just", "like", "think", "know", "going", "really", "right", "okay", "yeah", "because",
    "could", "should", "other", "some", "then", "than", "also", "into", "more", "been", "were",
    "when", "your", "them", "these", "those", "which", "thing", "things", "something", "want",
    "need", "make", "well", "here", "actually", "maybe", "little", "still", "very", "much", "even",
    "back", "over", "only", "come", "take", "look", "good", "time", "people", "said", "does",
    "doing", "done", "kind", "sure", "great", "first", "next", "week", "today", "yes", "thanks",
    "thank", "need", "needs", "let", "lets", "said", "says", "say", "talk", "meeting", "call",
    "work", "working", "different", "another", "everyone", "anything", "anyone", "where", "while",
    "being", "many", "most", "such", "each", "same", "after", "before", "again", "going", "gonna",
    "wanna", "mean", "means", "point", "part", "sort", "stuff", "lot", "bit", "try", "trying",
    "give", "gave", "tell", "told", "ask", "asked", "see", "seen", "get", "got", "getting",
];

const SIGNAL_WORDS: &[&str] = &[
    "decided", "agreed", "deadline", "budget", "launch", "approve", "approved", "must", "risk",
    "blocked", "owner", "deliver", "release", "contract", "price", "pricing", "priority",
    "milestone", "action", "follow", "schedule", "due", "決定", "期限", "予算", "承認", "合意",
    "確認", "契約", "确定", "截止", "预算", "批准", "合同", "决定",
];

fn is_katakana(c: char) -> bool {
    matches!(c as u32, 0x30A1..=0x30FF)
}
fn is_han(c: char) -> bool {
    matches!(c as u32, 0x3400..=0x4DBF | 0x4E00..=0x9FFF)
}

fn distinctive_terms(lines: &[SegmentInput], limit: usize) -> Vec<String> {
    let mut counts: HashMap<String, (usize, bool)> = HashMap::new();
    for l in lines {
        let mut prev_end = true; // previous token ended a sentence
        let mut tok = String::new();
        let mut was_first = true;
        let chars: Vec<char> = l.text.chars().collect();
        let mut i = 0;
        while i <= chars.len() {
            let c = chars.get(i).copied();
            if let Some(ch) = c.filter(|c| c.is_alphanumeric() && !is_cjk(*c)) {
                if tok.is_empty() {
                    was_first = prev_end;
                }
                tok.push(ch);
            } else {
                if tok.chars().count() >= 4 {
                    let lower = tok.to_lowercase();
                    if !COMMON.contains(&lower.as_str()) && !super::search::is_stopword(&lower) {
                        let proper = tok.chars().next().map_or(false, |c| c.is_uppercase()) && !was_first;
                        let e = counts.entry(lower).or_insert((0, false));
                        e.0 += 1;
                        e.1 |= proper;
                    }
                }
                if !tok.is_empty() {
                    prev_end = false;
                }
                tok.clear();
                if matches!(c, Some('.') | Some('!') | Some('?')) {
                    prev_end = true;
                }
            }
            i += 1;
        }
    }
    let mut scored: Vec<(String, f64)> = counts
        .into_iter()
        .filter(|(w, (n, proper))| *n >= 2 || (*proper && w.len() >= 4) || w.chars().any(|c| c.is_ascii_digit()))
        .map(|(w, (n, proper))| {
            let s = n as f64 * if proper { 2.0 } else { 1.0 } + (w.len().min(12) as f64) * 0.05;
            (w, s)
        })
        .collect();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0)));
    let mut out: Vec<String> = scored.into_iter().take(limit).map(|x| x.0).collect();

    // CJK: katakana words and Han compounds that repeat
    let mut cjk_counts: HashMap<String, usize> = HashMap::new();
    for l in lines {
        let mut cur = String::new();
        let mut kind = 0u8;
        let flush = |cur: &mut String, kind: u8, m: &mut HashMap<String, usize>| {
            let n = cur.chars().count();
            if (kind == 1 && n >= 3) || (kind == 2 && (2..=6).contains(&n)) {
                *m.entry(std::mem::take(cur)).or_insert(0) += 1;
            } else {
                cur.clear();
            }
        };
        for c in l.text.chars() {
            let k = if is_katakana(c) { 1 } else if is_han(c) { 2 } else { 0 };
            if k != kind {
                flush(&mut cur, kind, &mut cjk_counts);
                kind = k;
            }
            if k != 0 {
                cur.push(c);
            }
        }
        flush(&mut cur, kind, &mut cjk_counts);
    }
    let mut cj: Vec<(String, usize)> = cjk_counts.into_iter().filter(|(_, n)| *n >= 2).collect();
    cj.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    out.extend(cj.into_iter().take(4).map(|x| x.0));
    out.truncate(limit);
    out
}

fn salient_lines(lines: &[SegmentInput], n: usize) -> Vec<String> {
    let mut scored: Vec<(usize, f64, String)> = Vec::new();
    let mut idx = 0usize;
    for l in lines {
        for s in split_sentences(&l.text) {
            let s = s.trim();
            let chars = s.chars().count();
            let cjk = s.chars().filter(|c| is_cjk(*c)).count() * 2 > chars;
            let (lo, hi) = if cjk { (10, 90) } else { (30, 220) };
            idx += 1;
            if chars < lo || chars > hi {
                continue;
            }
            let lower = s.to_lowercase();
            let mut score = 0.0;
            if s.chars().any(|c| c.is_ascii_digit() || ('０'..='９').contains(&c)) {
                score += 2.0;
            }
            score += 2.0 * SIGNAL_WORDS.iter().filter(|w| lower.contains(*w)).count().min(2) as f64;
            let units = unit_count(s) as f64;
            score += (units / 30.0).min(1.0);
            for filler in ["yeah", "okay", "ok ", "so ", "um", "uh", "right,"] {
                if lower.starts_with(filler) {
                    score -= 1.0;
                }
            }
            scored.push((idx, score, s.to_string()));
        }
    }
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0)));
    let mut top: Vec<(usize, String)> = scored.into_iter().filter(|x| x.1 > 0.0).take(n).map(|x| (x.0, x.2)).collect();
    top.sort_by_key(|x| x.0);
    top.into_iter()
        .map(|(_, s)| {
            if s.chars().count() > LINE_CAP_CHARS {
                format!("{}…", s.chars().take(LINE_CAP_CHARS).collect::<String>().trim_end())
            } else {
                s
            }
        })
        .collect()
}

fn clean_summary(summary: &str) -> String {
    let mut out = String::new();
    for line in summary.lines() {
        let t = line.trim().trim_start_matches('#').trim().trim_start_matches(['-', '*', '•']).trim();
        let t = t.replace("**", "").replace('`', "");
        if t.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&t);
        if out.chars().count() > SUMMARY_CAP_CHARS {
            break;
        }
    }
    if out.chars().count() > SUMMARY_CAP_CHARS {
        let cut: String = out.chars().take(SUMMARY_CAP_CHARS).collect();
        // end at the last sentence end when there is one in the second half
        let end = cut
            .rfind(|c| matches!(c, '.' | '!' | '?' | '。' | '！' | '？'))
            .filter(|i| *i > cut.len() / 2)
            .map(|i| i + cut[i..].chars().next().map_or(1, |c| c.len_utf8()))
            .unwrap_or(cut.len());
        return format!("{}…", cut[..end].trim_end());
    }
    out
}

fn header(input: &CardInput) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(ms) = input.started_at_ms {
        if let Some(dt) = chrono::DateTime::from_timestamp_millis(ms) {
            parts.push(dt.format("%Y-%m-%d").to_string());
        }
    }
    if let Some(d) = input.duration_s.filter(|d| *d > 0) {
        parts.push(format!("{} min", (d + 30) / 60));
    }
    if parts.is_empty() {
        input.title.to_string()
    } else {
        format!("{} ({})", input.title, parts.join(", "))
    }
}

/// Build the card text. `key` is the value of [`card_key`] for this meeting.
pub fn build_card(input: &CardInput, key: &str) -> Card {
    let head = header(input);
    let (recap, origin) = match input.summary.map(clean_summary).filter(|s| !s.is_empty()) {
        Some(s) => (format!("{head}. {s}"), CardOrigin::Summary),
        None => {
            let terms = distinctive_terms(input.lines, 8);
            let lines = salient_lines(input.lines, 3);
            let mut r = format!("{head}.");
            if !terms.is_empty() {
                r.push_str(&format!(" Key terms: {}.", terms.join(", ")));
            }
            if !lines.is_empty() {
                r.push_str(&format!(" Highlights: {}", lines.iter().map(|l| format!("\"{l}\"")).collect::<Vec<_>>().join(" ")));
            }
            (r, CardOrigin::Extract)
        }
    };
    Card {
        meeting_id: input.meeting_id.to_string(),
        tokens: estimate_tokens(&recap),
        recap,
        origin,
        source_hash: key.to_string(),
        updated_at: now_ms(),
    }
}

pub fn get_card(conn: &Connection, meeting_id: &str) -> rusqlite::Result<Option<Card>> {
    conn.query_row(
        "SELECT meeting_id, recap, origin, source_hash, tokens, updated_at FROM meeting_cards WHERE meeting_id = ?1",
        params![meeting_id],
        |r| {
            Ok(Card {
                meeting_id: r.get(0)?,
                recap: r.get(1)?,
                origin: CardOrigin::parse(&r.get::<_, String>(2)?),
                source_hash: r.get(3)?,
                tokens: r.get::<_, i64>(4)? as usize,
                updated_at: r.get(5)?,
            })
        },
    )
    .optional()
}

/// Meetings whose AI recap the user deleted: no new one is written for them.
pub fn recap_declined(conn: &Connection, meeting_id: &str) -> bool {
    conn.query_row("SELECT 1 FROM meeting_recap_off WHERE meeting_id = ?1", params![meeting_id], |_| Ok(())).is_ok()
}

/// Delete the AI recap of a meeting and remember not to write another. The card goes
/// back to the plain extract the next indexing pass builds.
pub fn decline_recap(conn: &Connection, meeting_id: &str) -> rusqlite::Result<()> {
    conn.execute("INSERT OR IGNORE INTO meeting_recap_off(meeting_id) VALUES (?1)", params![meeting_id])?;
    conn.execute("DELETE FROM meeting_cards WHERE meeting_id = ?1 AND origin = 'ai'", params![meeting_id])?;
    Ok(())
}

/// A recap that could not be written, remembered with the transcript it failed for: the
/// same meeting is not tried again until its transcript changes or the user rescans.
pub fn record_recap_failure(conn: &Connection, meeting_id: &str, source_hash: &str, reason: &str) {
    let _ = conn.execute(
        "INSERT INTO meeting_recap_failed(meeting_id, source_hash, reason, failed_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(meeting_id) DO UPDATE SET source_hash = excluded.source_hash, reason = excluded.reason, failed_at = excluded.failed_at",
        params![meeting_id, source_hash, reason, now_ms()],
    );
}

pub fn recap_failed(conn: &Connection, meeting_id: &str, source_hash: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM meeting_recap_failed WHERE meeting_id = ?1 AND source_hash = ?2",
        params![meeting_id, source_hash],
        |_| Ok(()),
    )
    .is_ok()
}

pub fn clear_recap_failure(conn: &Connection, meeting_id: &str) {
    let _ = conn.execute("DELETE FROM meeting_recap_failed WHERE meeting_id = ?1", params![meeting_id]);
}

/// Forget the failures of a workspace's meetings (an explicit rescan tries them again).
pub fn clear_recap_failures_of(conn: &Connection, workspace_id: &str) {
    let _ = conn.execute(
        "DELETE FROM meeting_recap_failed WHERE meeting_id IN (SELECT id FROM meetings WHERE workspace_id = ?1)",
        params![workspace_id],
    );
}

/// How many meetings of a workspace have a failed recap, and the latest short reason.
pub fn recap_failures_of(conn: &Connection, workspace_id: &str) -> (usize, Option<String>) {
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM meeting_recap_failed f JOIN meetings m ON m.id = f.meeting_id WHERE m.workspace_id = ?1",
            params![workspace_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let reason: Option<String> = conn
        .query_row(
            "SELECT f.reason FROM meeting_recap_failed f JOIN meetings m ON m.id = f.meeting_id WHERE m.workspace_id = ?1 ORDER BY f.failed_at DESC LIMIT 1",
            params![workspace_id],
            |r| r.get(0),
        )
        .ok();
    (n.max(0) as usize, reason)
}

pub fn put_card(conn: &Connection, c: &Card) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO meeting_cards(meeting_id, recap, origin, source_hash, tokens, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(meeting_id) DO UPDATE SET recap = excluded.recap, origin = excluded.origin,
            source_hash = excluded.source_hash, tokens = excluded.tokens, updated_at = excluded.updated_at",
        params![c.meeting_id, c.recap, c.origin.as_str(), c.source_hash, c.tokens as i64, c.updated_at],
    )?;
    Ok(())
}

/// True when the stored card is missing or built from older material.
/// A card with origin `ai` is only replaced when the key changed too, never
/// by a local rebuild of the same key.
pub fn card_is_current(conn: &Connection, meeting_id: &str, key: &str) -> rusqlite::Result<bool> {
    Ok(get_card(conn, meeting_id)?.map_or(false, |c| c.source_hash == key))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_search::test_support::mem_db;

    fn line(speaker: &str, text: &str, ms: i64) -> SegmentInput {
        SegmentInput { speaker: speaker.into(), text: text.into(), start_ms: ms }
    }

    #[test]
    fn summary_wins_and_is_cleaned_and_capped() {
        let summary = format!("## Overview\n**We agreed** to ship the `v2` release on 3 March.\n- Budget is 40k.\n{}", "More detail here. ".repeat(100));
        let input = CardInput { meeting_id: "m", title: "Launch sync", started_at_ms: Some(1_700_000_000_000), duration_s: Some(1830), summary: Some(&summary), lines: &[] };
        let c = build_card(&input, "k");
        assert_eq!(c.origin, CardOrigin::Summary);
        assert!(c.recap.starts_with("Launch sync (2023-11-14, 31 min). Overview We agreed to ship the v2 release"));
        assert!(!c.recap.contains("**") && !c.recap.contains('`'));
        assert!(c.recap.chars().count() < 1000);
        assert_eq!(c.tokens, estimate_tokens(&c.recap));
    }

    #[test]
    fn extract_has_title_date_terms_and_salient_lines() {
        let lines = vec![
            line("You", "Okay so, yeah, let us start.", 0),
            line("Them", "We decided that the Kestrel migration deadline is 14 October and the budget is 40000 dollars.", 3000),
            line("You", "Kestrel needs the freight contract renewed before the migration starts.", 9000),
            line("Them", "The freight contract owner is Dana and she will confirm the renewal.", 15000),
            line("You", "Thanks everyone.", 20000),
        ];
        let input = CardInput { meeting_id: "m", title: "Warehouse planning", started_at_ms: Some(1_700_000_000_000), duration_s: Some(600), summary: None, lines: &lines };
        let c = build_card(&input, "k");
        assert_eq!(c.origin, CardOrigin::Extract);
        assert!(c.recap.starts_with("Warehouse planning (2023-11-14, 10 min)."));
        assert!(c.recap.contains("Key terms:"));
        assert!(c.recap.contains("kestrel"), "{}", c.recap);
        assert!(c.recap.contains("freight"));
        assert!(c.recap.contains("Highlights:"));
        assert!(c.recap.contains("14 October"));
        assert!(!c.recap.contains("Thanks everyone"));
    }

    #[test]
    fn japanese_extract_finds_katakana_terms_and_lines() {
        let lines = vec![
            line("You", "来月のゴールドマン案件の契約更新は三月十日までに完了する予定です。", 0),
            line("Them", "ゴールドマンの担当者に確認してから、予算の承認を取ります。", 5000),
        ];
        let input = CardInput { meeting_id: "m", title: "契約会議", started_at_ms: None, duration_s: None, summary: None, lines: &lines };
        let c = build_card(&input, "k");
        assert!(c.recap.contains("ゴールドマン"), "{}", c.recap);
        assert!(c.recap.contains("契約更新"));
    }

    #[test]
    fn empty_meeting_still_gets_a_card() {
        let input = CardInput { meeting_id: "m", title: "Empty", started_at_ms: None, duration_s: None, summary: None, lines: &[] };
        let c = build_card(&input, "k");
        assert_eq!(c.recap, "Empty.");
    }

    #[test]
    fn key_changes_invalidate_the_stored_card() {
        let conn = mem_db();
        let k1 = card_key("T", None, 3, 100, Some(60));
        let k2 = card_key("T", Some("now a summary"), 3, 100, Some(60));
        assert_ne!(k1, k2);
        assert_ne!(k1, card_key("T2", None, 3, 100, Some(60)));
        assert_ne!(k1, card_key("T", None, 4, 100, Some(60)));
        let input = CardInput { meeting_id: "m", title: "T", started_at_ms: None, duration_s: None, summary: None, lines: &[] };
        put_card(&conn, &build_card(&input, &k1)).unwrap();
        assert!(card_is_current(&conn, "m", &k1).unwrap());
        assert!(!card_is_current(&conn, "m", &k2).unwrap());
        let stored = get_card(&conn, "m").unwrap().unwrap();
        assert_eq!(stored.origin, CardOrigin::Extract);
        put_card(&conn, &build_card(&CardInput { summary: Some("S"), ..input }, &k2)).unwrap();
        assert_eq!(get_card(&conn, "m").unwrap().unwrap().origin, CardOrigin::Summary);
    }
}
