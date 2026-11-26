//! One-hour simulations (150 words per minute) of the notes engine at each
//! detail level and of the brief engine, with a synthetic model whose answers
//! have a realistic size. They measure how many tokens an hour costs and check
//! the rules on every single run.

use crate::live_brief::engine::{BriefConfig, BriefEngine, BriefLine, NullBriefSink, NullBriefStore};
use crate::live_brief::search::Passage;
use crate::live_common::{estimate_tokens, FakeClock, LlmCall, LlmError, LlmReply, LlmRequest};
use crate::live_eval::scripted::{conversation, topic_words, Lang};
use crate::live_notes::engine::{NotesConfig, NotesEngine, NullSink, NullStore, TranscriptLine};
use crate::live_notes::prompts::Detail;
use crate::live_notes::reducer::{check_invariants, ReduceCtx};
use crate::live_notes::trigger::Decision;
use async_trait::async_trait;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

/// A model that answers with ops condensed from the lines it was sent.
pub struct SynthNotesLlm {
    pub detail: Detail,
    pub calls: AtomicU32,
}

impl SynthNotesLlm {
    pub fn new(detail: Detail) -> Self {
        Self { detail, calls: AtomicU32::new(0) }
    }
}

fn transcript_lines(user: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut inside = false;
    for l in user.lines() {
        if l.starts_with("[[DATA transcript") {
            inside = true;
            continue;
        }
        if l.starts_with("[[END transcript") {
            break;
        }
        if inside {
            if let Some(rest) = l.strip_prefix('[') {
                if let Some(end) = rest.find(']') {
                    let text = rest[end + 1..].trim();
                    let text = text.splitn(2, ": ").nth(1).unwrap_or(text);
                    out.push((rest[..end].to_string(), text.to_string()));
                }
            }
        }
    }
    out
}

#[async_trait]
impl LlmCall for SynthNotesLlm {
    async fn call(&self, req: &LlmRequest) -> Result<LlmReply, LlmError> {
        let k = self.calls.fetch_add(1, Ordering::SeqCst);
        let lines = transcript_lines(&req.user);
        let n_ops = match self.detail {
            Detail::Brief => 1 + (k % 3) as usize,
            Detail::Standard => 3 + (k % 4) as usize,
            Detail::Detailed => 5 + (k % 6) as usize,
        };
        let kinds = ["bullet", "bullet", "decision", "task", "question", "bullet"];
        let mut ops = Vec::new();
        if k % 4 == 0 {
            if let Some((t, text)) = lines.first() {
                let title: String = text.split_whitespace().take(5).collect::<Vec<_>>().join(" ");
                ops.push(serde_json::json!({"op":"add","id":"nt","type":"topic","text":title,"t":t}));
            }
        }
        for i in 0..n_ops.min(lines.len().max(1)) {
            if lines.is_empty() {
                break;
            }
            let (t, text) = &lines[i * lines.len() / n_ops.max(1) % lines.len()];
            let mut text: String = text.chars().take(140).collect();
            text = format!("{} #{}", text.trim_end_matches('.'), k * 20 + i as u32);
            ops.push(serde_json::json!({"op":"add","type":kinds[i % kinds.len()],"text":text,"t":t}));
        }
        let body = serde_json::json!({ "ops": ops }).to_string();
        let sys = estimate_tokens(&req.system);
        Ok(LlmReply {
            input_tokens: Some(sys + estimate_tokens(&req.user)),
            cached_input_tokens: Some(sys),
            output_tokens: Some(estimate_tokens(&body)),
            text: body,
        })
    }
}

#[derive(Debug, Clone, Default)]
pub struct NotesSim {
    pub runs: u32,
    pub failed: u32,
    /// Tokens charged against the cap (new input plus output).
    pub counted_tokens: u64,
    /// All tokens the calls used (system, outline, lines, output).
    pub sent_tokens: u64,
    pub max_outline_tokens: u32,
    pub applied_ops: u32,
    pub dropped_ops: u32,
    pub blocks: usize,
    pub violations: Vec<String>,
    pub max_user_tokens: u32,
}

/// 150 wpm for one hour: 15-word lines every 6 s (4 s of speech, 2 s pause).
pub fn simulate_notes(detail: Detail, seed: u64, hours_secs: u64) -> NotesSim {
    let topics = [0usize, 1, 2, 3];
    let blocks: Vec<(usize, u64)> = (0..(hours_secs / 240 + 1)).map(|i| (topics[i as usize % 4], 240)).collect();
    let utt = conversation(Lang::En, seed, &blocks, 6, 15);
    let clock = FakeClock::new(0);
    let cfg = NotesConfig { prompt: crate::live_notes::prompts::NotesPromptOptions { detail, ..Default::default() }, ..Default::default() };
    let limits = cfg.reduce.clone();
    let mut e = NotesEngine::new(SynthNotesLlm::new(detail), clock.clone(), cfg, Arc::new(NullSink), Arc::new(NullStore));
    let synth = SynthNotesLlm::new(detail);
    let mut sim = NotesSim::default();
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    rt.block_on(async {
        for u in utt.iter().filter(|u| u.ms < hours_secs * 1000) {
            for (offset, feed) in [(4_000u64, true), (6_000u64, false)] {
                clock.set(u.ms + offset);
                if feed {
                    e.feed(TranscriptLine { ms: u.ms, speaker: "Them".into(), text: u.text.clone() });
                }
                while let Decision::Run(reason) = e.poll() {
                    let before = e.doc().clone();
                    let Some(p) = e.prepare(reason) else { break };
                    let user_tokens = estimate_tokens(&p.request.user);
                    sim.max_user_tokens = sim.max_user_tokens.max(user_tokens);
                    let outline = p.request.user.split("[[END notes").next().unwrap_or("");
                    sim.max_outline_tokens = sim.max_outline_tokens.max(estimate_tokens(outline));
                    let (from, to) = (p.from_ms, p.to_ms);
                    let res = synth.call(&p.request).await;
                    let out = e.complete(p, res);
                    clock.advance(3_000);
                    sim.runs += 1;
                    if !out.ok {
                        sim.failed += 1;
                    }
                    sim.counted_tokens += out.counted_tokens;
                    sim.sent_tokens += out.sent_tokens;
                    if let Some(r) = &out.report {
                        sim.applied_ops += r.applied();
                        sim.dropped_ops += r.dropped_total();
                    }
                    let v = check_invariants(&before, e.doc(), ReduceCtx { range_start_ms: from, range_end_ms: to }, &limits);
                    sim.violations.extend(v);
                }
            }
        }
        let _ = e.finish().await;
    });
    sim.blocks = e.doc().blocks.len();
    sim
}

// ---------------------------------------------------------------- brief

struct SynthBriefLlm;

#[async_trait]
impl LlmCall for SynthBriefLlm {
    async fn call(&self, req: &LlmRequest) -> Result<LlmReply, LlmError> {
        // cite the first sentence of the first four passages
        let mut facts = Vec::new();
        let mut label = String::new();
        let mut next_is_text = false;
        for l in req.user.lines() {
            if let Some(rest) = l.strip_prefix("[P") {
                if let Some(end) = rest.find(']') {
                    label = format!("P{}", &rest[..end]);
                    next_is_text = true;
                    continue;
                }
            }
            if next_is_text {
                next_is_text = false;
                let first: String = l.split('.').next().unwrap_or(l).chars().take(110).collect();
                if facts.len() < 4 && !first.trim().is_empty() {
                    facts.push(serde_json::json!({"text": first.trim(), "source": label}));
                }
            }
        }
        let body = serde_json::json!({"now":"Discussion in progress","facts":facts,"earlier":["Earlier topic"]}).to_string();
        let sys = estimate_tokens(&req.system);
        Ok(LlmReply { input_tokens: Some(sys + estimate_tokens(&req.user)), cached_input_tokens: Some(sys), output_tokens: Some(estimate_tokens(&body)), text: body })
    }
}

#[derive(Debug, Clone, Default)]
pub struct BriefSim {
    pub searches: u32,
    pub calls: u32,
    pub failed: u32,
    pub topic_changes: u32,
    pub counted_tokens: u64,
    pub sent_tokens: u64,
    pub facts_shown: usize,
}

fn passage_for(topic: usize, i: usize) -> Passage {
    let words = topic_words(Lang::En, topic);
    let mut text = format!("Summary {i} of the notes. ");
    for s in 0..8 {
        let sent: Vec<&str> = (0..12).map(|k| words[(i * 7 + s * 5 + k) % words.len()]).collect();
        text.push_str(&sent.join(" "));
        text.push_str(". ");
    }
    Passage { id: format!("t{topic}p{i}"), title: format!("Doc {topic}-{i}"), text, start_ms: None }
}

/// `drift_every`: the index returns a slightly different top list every N
/// searches (new documents arriving, wording changing); 0 = never.
pub fn simulate_brief(seed: u64, hours_secs: u64, drift_every: u32) -> BriefSim {
    let topics = [0usize, 1, 2, 3];
    let blocks: Vec<(usize, u64)> = (0..(hours_secs / 240 + 1)).map(|i| (topics[i as usize % 4], 240)).collect();
    let utt = conversation(Lang::En, seed, &blocks, 5, 12);
    let clock = FakeClock::new(0);
    let current = Arc::new(AtomicU32::new(0));
    let count = Arc::new(AtomicU32::new(0));
    let (cur2, cnt2) = (current.clone(), count.clone());
    let search = move |_q: &str, _t: u32, _m: usize| -> Vec<Passage> {
        let n = cnt2.fetch_add(1, Ordering::SeqCst);
        let topic = cur2.load(Ordering::SeqCst) as usize;
        let drift = if drift_every == 0 { 0 } else { (n / drift_every) as usize };
        (0..6).map(|i| passage_for(topic, i + drift)).collect()
    };
    let mut e = BriefEngine::new(SynthBriefLlm, clock.clone(), search, "ws", BriefConfig::default(), Arc::new(NullBriefSink), Arc::new(NullBriefStore));
    let mut sim = BriefSim::default();
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    rt.block_on(async {
        for u in utt.iter().filter(|u| u.ms < hours_secs * 1000) {
            current.store(blocks[u.topic].0 as u32, Ordering::SeqCst);
            clock.set(u.ms + 4_000);
            e.feed(BriefLine { start_ms: u.ms, end_ms: Some(u.ms + 4_000), text: u.text.clone() });
            let t = e.tick().await;
            if t.topic_changed {
                sim.topic_changes += 1;
            }
            if t.searched {
                sim.searches += 1;
            }
            if let Some(c) = t.call {
                sim.calls += 1;
                if !c.ok {
                    sim.failed += 1;
                }
                sim.counted_tokens += c.counted_tokens;
                sim.sent_tokens += c.sent_tokens;
                sim.facts_shown += c.facts_shown;
            }
        }
    });
    sim
}
