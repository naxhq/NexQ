//! Memory suggestions for a finished meeting: one call per chunk of the
//! transcript (a long meeting is split to fit the budget), proposals merged,
//! stored as `suggested` and never as `saved`.

use crate::ai_runs::AiPurpose;
use crate::live_common::{estimate_tokens, similarity};
use crate::live_notes::prompts::OutputLanguage;
use crate::live_runtime::llm::Selection;
use crate::live_runtime::{LiveRuntimes, Deps};
use crate::workspace::types::MemoryItem;
use crate::workspace_memory::{suggest_memory, MemLine, MemoryConfig, MemoryInput, Proposal, MAX_SUGGESTIONS};
use serde_json::json;
use std::sync::Arc;

/// Longest transcript chunk sent in one call (tokens) and most chunks per meeting.
pub const CHUNK_TOKENS: u32 = 10_000;
pub const MAX_CHUNKS: usize = 4;

/// Splits lines into chunks of at most `budget` tokens; a meeting needing more
/// than `max_chunks` keeps its start and end (the middle is dropped).
pub fn chunk_lines(lines: &[MemLine], budget: u32, max_chunks: usize) -> Vec<Vec<MemLine>> {
    let mut chunks: Vec<Vec<MemLine>> = Vec::new();
    let mut cur: Vec<MemLine> = Vec::new();
    let mut used = 0u32;
    for l in lines {
        let t = estimate_tokens(&l.text) + 8;
        if used + t > budget && !cur.is_empty() {
            chunks.push(std::mem::take(&mut cur));
            used = 0;
        }
        used += t;
        cur.push(l.clone());
    }
    if !cur.is_empty() {
        chunks.push(cur);
    }
    if chunks.len() > max_chunks {
        let tail = max_chunks / 2;
        let head = max_chunks - tail;
        let n = chunks.len();
        let mut kept: Vec<Vec<MemLine>> = chunks.drain(..head).collect();
        let mut rest = chunks;
        kept.extend(rest.split_off(rest.len() - tail));
        let _ = n;
        return kept;
    }
    chunks
}

fn merge(all: Vec<Proposal>) -> Vec<Proposal> {
    let mut out: Vec<Proposal> = Vec::new();
    for p in all {
        let both = format!("{}. {}", p.title, p.text);
        if out.iter().any(|o| o.kind == p.kind && similarity(&format!("{}. {}", o.title, o.text), &both) >= 0.8) {
            continue;
        }
        if out.len() < MAX_SUGGESTIONS {
            out.push(p);
        }
    }
    out
}

impl LiveRuntimes {
    /// `suggest_memory(workspaceId, meetingId)`: only after the meeting ended.
    pub async fn suggest_memory(&self, workspace_id: &str, meeting_id: &str) -> Result<Vec<MemoryItem>, String> {
        suggest(self.deps(), workspace_id, meeting_id).await
    }
}

pub async fn suggest(deps: &Deps, workspace_id: &str, meeting_id: &str) -> Result<Vec<MemoryItem>, String> {
    if (deps.live_meeting)().as_deref() == Some(meeting_id) {
        return Err("Memory is suggested after the meeting ends".into());
    }
    let (lines, len_ms) = deps.db.meeting_lines(meeting_id);
    if lines.is_empty() {
        return Ok(Vec::new());
    }
    let saved = deps.db.saved_memory(workspace_id);
    let settings: crate::live_runtime::settings::NotetakerSettings =
        deps.db.kv_get(crate::live_runtime::settings::NOTETAKER_KEY).and_then(|j| serde_json::from_str(&j).ok()).unwrap_or_default();
    let selection = Selection { provider: settings.provider.clone(), model: settings.model.clone(), effort: settings.effort.clone() };
    let slot = deps.factory.make(AiPurpose::Memory, meeting_id, &selection)?;
    let mut proposals: Vec<Proposal> = Vec::new();
    let mut last_err: Option<String> = None;
    let mut ok_calls = 0;
    for chunk in chunk_lines(&lines, CHUNK_TOKENS, MAX_CHUNKS) {
        let input = MemoryInput {
            lines: chunk,
            meeting_len_ms: len_ms,
            // notes text never enters another prompt
            notes_outline: None,
            saved: saved.clone(),
            language: OutputLanguage::Meeting,
        };
        match suggest_memory(&*slot.llm, &input, &MemoryConfig::default()).await {
            Ok(o) => {
                ok_calls += 1;
                proposals.extend(o.suggestions.proposals);
            }
            Err(e) => last_err = Some(e.message),
        }
    }
    if ok_calls == 0 {
        return Err(last_err.unwrap_or_else(|| "The suggestion failed".into()));
    }
    let now = crate::live_runtime::db::now_ms();
    let items: Vec<MemoryItem> = merge(proposals)
        .into_iter()
        .map(|p| MemoryItem {
            id: String::new(),
            workspace_id: workspace_id.to_string(),
            kind: p.kind.as_str().to_string(),
            title: p.title,
            text: p.text,
            source_meeting: Some(meeting_id.to_string()),
            source_ms: Some(p.source_ms as i64),
            status: "suggested".into(),
            created_at: now,
            updated_at: now,
        })
        .collect();
    let stored = deps.db.save_suggestions(items);
    deps.emitter.emit("memory_changed", json!({"workspace_id": workspace_id}));
    Ok(stored)
}

/// After a meeting: suggest on its own when the workspace turned it on.
pub fn auto_suggest_after(deps: Arc<Deps>, meeting_id: String, delay: std::time::Duration) {
    tokio::spawn(async move {
        tokio::time::sleep(delay).await;
        let Some(home) = deps.db.meeting_home(&meeting_id) else { return };
        if !deps.db.suggest_flag(&home) {
            return;
        }
        if let Err(e) = suggest(&deps, &home, &meeting_id).await {
            log::info!("Automatic memory suggestions failed: {e}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(n: usize) -> Vec<MemLine> {
        (0..n).map(|i| MemLine { ms: i as u64 * 1000, speaker: "Them".into(), text: format!("line {i} {}", "word ".repeat(50)) }).collect()
    }

    #[test]
    fn short_meeting_is_one_chunk_long_one_is_split_and_bounded() {
        assert_eq!(chunk_lines(&lines(20), CHUNK_TOKENS, MAX_CHUNKS).len(), 1);
        let long = lines(2_000);
        let chunks = chunk_lines(&long, CHUNK_TOKENS, MAX_CHUNKS);
        assert_eq!(chunks.len(), MAX_CHUNKS);
        assert_eq!(chunks[0][0].ms, 0);
        assert_eq!(chunks.last().unwrap().last().unwrap().ms, 1_999_000);
        for c in &chunks {
            let t: u32 = c.iter().map(|l| estimate_tokens(&l.text) + 8).sum();
            assert!(t <= CHUNK_TOKENS + 100);
        }
        assert!(chunk_lines(&[], 100, 4).is_empty());
    }
}
