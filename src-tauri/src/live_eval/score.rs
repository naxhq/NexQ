//! Deterministic scorer for live notes and the live brief, and the fixtures it
//! runs on: short synthetic transcripts (English, Spanish, Japanese) and
//! recorded-style outputs of four model sizes written for them.
//!
//! Measures: parse success, rule violations (must be 0: checked by
//! `check_invariants`, not by the reducer that enforces them), and support
//! (how much of what the model wrote is grounded in the transcript or passage).

use crate::live_brief::sheet::{parse_sheet, unsupported, FactDrop, SentPassage};
use crate::live_common::{content_terms, parse_clock};
use crate::live_eval::scripted::Lang;
use crate::live_notes::doc::{strip_tags, NoteDoc};
use crate::live_notes::engine::TranscriptLine;
use crate::live_notes::ops::{parse_ops, ParseMode};
use crate::live_notes::reducer::{apply_ops, check_invariants, ReduceCtx, ReduceLimits};
use std::collections::HashSet;

pub const SIZES: [&str; 4] = ["tiny", "small", "medium", "large"];

fn lang_key(l: Lang) -> &'static str {
    match l {
        Lang::En => "en",
        Lang::Es => "es",
        Lang::Ja => "ja",
    }
}

pub fn transcript(lang: Lang) -> Vec<TranscriptLine> {
    let raw = match lang {
        Lang::En => include_str!("fixtures/transcript_en.txt"),
        Lang::Es => include_str!("fixtures/transcript_es.txt"),
        Lang::Ja => include_str!("fixtures/transcript_ja.txt"),
    };
    raw.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            let mut p = l.splitn(3, '|');
            let t = p.next().unwrap_or("");
            let speaker = p.next().unwrap_or("").to_string();
            let text = p.next().unwrap_or("").to_string();
            TranscriptLine { ms: parse_clock(t).unwrap_or(0), speaker, text }
        })
        .collect()
}

pub fn notes_output(lang: Lang, size: &str) -> &'static str {
    match (lang_key(lang), size) {
        ("en", "tiny") => include_str!("fixtures/notes_en_tiny.txt"),
        ("en", "small") => include_str!("fixtures/notes_en_small.txt"),
        ("en", "medium") => include_str!("fixtures/notes_en_medium.txt"),
        ("en", "large") => include_str!("fixtures/notes_en_large.txt"),
        ("es", "tiny") => include_str!("fixtures/notes_es_tiny.txt"),
        ("es", "small") => include_str!("fixtures/notes_es_small.txt"),
        ("es", "medium") => include_str!("fixtures/notes_es_medium.txt"),
        ("es", "large") => include_str!("fixtures/notes_es_large.txt"),
        ("ja", "tiny") => include_str!("fixtures/notes_ja_tiny.txt"),
        ("ja", "small") => include_str!("fixtures/notes_ja_small.txt"),
        ("ja", "medium") => include_str!("fixtures/notes_ja_medium.txt"),
        ("ja", "large") => include_str!("fixtures/notes_ja_large.txt"),
        _ => "",
    }
}

pub fn adversarial_output() -> &'static str {
    include_str!("fixtures/notes_adversarial.txt")
}

pub fn brief_output(lang: Lang, size: &str) -> Option<&'static str> {
    Some(match (lang_key(lang), size) {
        ("en", "tiny") => include_str!("fixtures/brief_en_tiny.txt"),
        ("en", "small") => include_str!("fixtures/brief_en_small.txt"),
        ("en", "medium") => include_str!("fixtures/brief_en_medium.txt"),
        ("en", "large") => include_str!("fixtures/brief_en_large.txt"),
        ("es", "small") => include_str!("fixtures/brief_es_small.txt"),
        ("es", "large") => include_str!("fixtures/brief_es_large.txt"),
        ("ja", "small") => include_str!("fixtures/brief_ja_small.txt"),
        ("ja", "large") => include_str!("fixtures/brief_ja_large.txt"),
        _ => return None,
    })
}

/// The three passages the brief fixtures cite.
pub fn brief_passages(lang: Lang) -> Vec<SentPassage> {
    let (a, b, c, titles): (&str, &str, &str, [&str; 3]) = match lang {
        Lang::En => (
            "Marketing asked for 12% more budget, about $48,000, for the Lisbon product launch. Finance will review the request in July.",
            "Maria confirmed the launch is on September 14. Acme will handle the printing of the brochures.",
            "The Globex contract renews in November and the price goes up 5%. Legal holds the old contract.",
            ["Pricing.pdf", "Launch plan.docx", "Vendors.xlsx"],
        ),
        Lang::Es => (
            "Marketing pidió un 12 por ciento más de presupuesto, unos 48.000 euros, para el lanzamiento en Lisboa.",
            "María confirmó que el lanzamiento es el 14 de septiembre. Acme se encarga de la impresión.",
            "El contrato con Globex se renueva en noviembre y el precio sube un 5 por ciento. Legal tiene el contrato anterior.",
            ["Precios.pdf", "Plan.docx", "Proveedores.xlsx"],
        ),
        Lang::Ja => (
            "マーケティング部は12％増、約4万8000ユーロの追加をリスボンでの発売のために要求。財務は7月に確認する。",
            "マリアさんが9月14日の発売を確認。印刷はアクメ社が担当する。",
            "グロベックス社との契約は11月に更新で、価格が5％上がる。旧契約書は法務が保管。",
            ["予算.pdf", "計画.docx", "取引先.xlsx"],
        ),
    };
    [a, b, c]
        .iter()
        .enumerate()
        .map(|(i, t)| SentPassage { label: format!("P{}", i + 1), id: format!("doc:{}#0", i + 1), title: titles[i].to_string(), text: t.to_string(), start_ms: None })
        .collect()
}

// ---------------------------------------------------------------- notes

#[derive(Debug, Clone)]
pub struct NotesScore {
    pub parsed: bool,
    pub mode: ParseMode,
    pub ops: usize,
    pub dropped_unparsed: u32,
    pub applied: u32,
    pub dropped_by_rules: u32,
    pub violations: Vec<String>,
    pub new_blocks: usize,
    pub supported_blocks: usize,
}

impl NotesScore {
    pub fn support_rate(&self) -> f32 {
        if self.new_blocks == 0 {
            1.0
        } else {
            self.supported_blocks as f32 / self.new_blocks as f32
        }
    }
}

fn numbers_of(s: &str) -> HashSet<String> {
    crate::live_brief::sheet::numbers_in(s).into_iter().collect()
}

/// Runs one model output over a transcript the way the engine does and scores it.
pub fn score_notes(lines: &[TranscriptLine], raw: &str, before: &NoteDoc) -> (NoteDoc, NotesScore) {
    let from = lines.first().map(|l| l.ms / 1000 * 1000).unwrap_or(0);
    let to = lines.last().map(|l| l.ms).unwrap_or(0).max(from);
    let ctx = ReduceCtx { range_start_ms: from, range_end_ms: to };
    let limits = ReduceLimits::default();
    let parsed = parse_ops(raw);
    let ok = parsed.mode != ParseMode::None || parsed.explicit_empty;
    let mut doc = before.clone();
    let ops_n = parsed.ops.len();
    let report = apply_ops(&mut doc, parsed.ops, ctx, &limits);
    let violations = check_invariants(before, &doc, ctx, &limits);

    let all: String = lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>().join(" ");
    let terms: HashSet<String> = content_terms(&all).into_iter().collect();
    let nums = numbers_of(&all);
    let mut new_blocks = 0;
    let mut supported = 0;
    for b in doc.blocks.iter().filter(|b| before.get(&b.id).is_none()) {
        new_blocks += 1;
        let plain = strip_tags(&b.text);
        let bt = content_terms(&plain);
        let ratio = if bt.is_empty() { 1.0 } else { bt.iter().filter(|t| terms.contains(*t)).count() as f32 / bt.len() as f32 };
        let nums_ok = numbers_of(&plain).iter().all(|n| nums.contains(n));
        if ratio >= 0.5 && nums_ok {
            supported += 1;
        }
    }
    (
        doc,
        NotesScore {
            parsed: ok,
            mode: parsed.mode,
            ops: ops_n,
            dropped_unparsed: parsed.dropped,
            applied: report.applied(),
            dropped_by_rules: report.dropped_total(),
            violations,
            new_blocks,
            supported_blocks: supported,
        },
    )
}

// ---------------------------------------------------------------- brief

#[derive(Debug, Clone)]
pub struct BriefScore {
    pub parsed: bool,
    pub facts_in_answer: usize,
    pub facts_shown: usize,
    /// Dropped because a number or name was not in the cited passage, or the
    /// citation was missing or unknown.
    pub dropped_unsupported: usize,
    /// Shown facts that fail an independent check. Must be 0.
    pub shown_unsupported: usize,
}

impl BriefScore {
    /// Share of what the model claimed that was supported.
    pub fn raw_support_rate(&self) -> f32 {
        if self.facts_in_answer == 0 {
            1.0
        } else {
            self.facts_shown as f32 / self.facts_in_answer as f32
        }
    }
}

pub fn score_brief(raw: &str, sent: &[SentPassage]) -> BriefScore {
    let r = parse_sheet(raw, sent);
    let unsup = r
        .dropped
        .iter()
        .filter(|(_, why)| matches!(why, FactDrop::NoSource | FactDrop::UnknownSource | FactDrop::NumberNotInPassage | FactDrop::NameNotInPassage))
        .count();
    let (shown, bad) = match &r.sheet {
        Some(s) => {
            let bad = s
                .facts
                .iter()
                .filter(|f| match sent.iter().find(|p| p.label == f.source) {
                    Some(p) => unsupported(&f.text, &p.text).is_some(),
                    None => true,
                })
                .count();
            (s.facts.len(), bad)
        }
        None => (0, 0),
    };
    BriefScore { parsed: r.sheet.is_some(), facts_in_answer: shown + unsup, facts_shown: shown, dropped_unsupported: unsup, shown_unsupported: bad }
}

/// A readable table of every fixture, printed by the eval tests.
pub fn report() -> String {
    use crate::live_eval::scripted::ALL_LANGS;
    let mut out = String::from("notes: lang size mode ops applied dropped(parse/rules) violations support\n");
    for lang in ALL_LANGS {
        let lines = transcript(lang);
        for size in SIZES {
            let (_, s) = score_notes(&lines, notes_output(lang, size), &NoteDoc::new());
            out.push_str(&format!(
                "  {:?} {:6} {:?} ops={} applied={} dropped={}/{} violations={} support={:.2}\n",
                lang, size, s.mode, s.ops, s.applied, s.dropped_unparsed, s.dropped_by_rules, s.violations.len(), s.support_rate()
            ));
        }
    }
    out.push_str("brief: lang size parsed facts shown dropped shown_unsupported raw_support\n");
    for lang in ALL_LANGS {
        for size in SIZES {
            if let Some(raw) = brief_output(lang, size) {
                let s = score_brief(raw, &brief_passages(lang));
                out.push_str(&format!(
                    "  {:?} {:6} parsed={} facts={} shown={} dropped={} shown_unsupported={} raw_support={:.2}\n",
                    lang, size, s.parsed, s.facts_in_answer, s.facts_shown, s.dropped_unsupported, s.shown_unsupported, s.raw_support_rate()
                ));
            }
        }
    }
    out
}
