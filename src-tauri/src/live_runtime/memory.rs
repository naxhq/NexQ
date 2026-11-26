//! Memory suggestions for a finished meeting: one call per chunk of the
//! transcript (a long meeting is split to fit the budget), proposals merged,
//! stored as `suggested` and never as `saved`.

use crate::ai_runs::AiPurpose;
use crate::live_common::{estimate_tokens, similarity};
use crate::live_notes::prompts::OutputLanguage;
use crate::live_runtime::llm::Selection;
use crate::live_runtime::{LiveRuntimes, Deps};
use crate::workspace::types::{MemoryCreate, MemoryItem};
use crate::workspace_memory::{suggest_memory, MemLine, MemoryConfig, MemoryInput, Proposal, MAX_SUGGESTIONS};
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crate::llm::provider::CancelToken;

/// Suggestion runs in flight, so a deleted or moved meeting, or a switch turned off,
/// can cancel the call that is running instead of waiting for its result to be dropped.
struct RunEntry {
    id: u64,
    meeting: String,
    workspace: String,
    automatic: bool,
    cancel: Arc<CancelToken>,
}

static RUNS: Mutex<Vec<RunEntry>> = Mutex::new(Vec::new());
static NEXT_RUN: AtomicU64 = AtomicU64::new(1);

struct RunGuard(u64);

impl Drop for RunGuard {
    fn drop(&mut self) {
        if let Ok(mut r) = RUNS.lock() {
            r.retain(|e| e.id != self.0);
        }
    }
}

fn register_run(meeting: &str, workspace: &str, automatic: bool, cancel: Arc<CancelToken>) -> RunGuard {
    let id = NEXT_RUN.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut r) = RUNS.lock() {
        r.push(RunEntry { id, meeting: meeting.to_string(), workspace: workspace.to_string(), automatic, cancel });
    }
    RunGuard(id)
}

/// Cancel every run for which `stop(meeting, workspace, automatic)` says so.
pub(crate) fn cancel_runs_where(stop: impl Fn(&str, &str, bool) -> bool) {
    if let Ok(r) = RUNS.lock() {
        for e in r.iter().filter(|e| stop(&e.meeting, &e.workspace, e.automatic)) {
            e.cancel.cancel();
        }
    }
}

/// Register a run (tests drive the central cancel rule with one).
#[cfg(test)]
pub(crate) fn register_test_run(meeting: &str, workspace: &str, automatic: bool) -> (Arc<CancelToken>, impl Drop) {
    let token = Arc::new(CancelToken::new());
    let guard = register_run(meeting, workspace, automatic, token.clone());
    (token, guard)
}

/// The meeting was deleted or moved (or its access changed): its suggestion runs stop.
pub fn cancel_runs_of_meeting(meeting_id: &str) {
    if let Ok(r) = RUNS.lock() {
        for e in r.iter().filter(|e| e.meeting == meeting_id) {
            e.cancel.cancel();
        }
    }
}

/// The workspace's "suggest memory" switch went off (or it was archived or deleted):
/// the runs nobody asked for stop. A person's own request is not touched.
pub fn cancel_automatic_runs_of(workspace_id: &str) {
    if let Ok(r) = RUNS.lock() {
        for e in r.iter().filter(|e| e.automatic && e.workspace == workspace_id) {
            e.cancel.cancel();
        }
    }
}

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
        suggest(self.deps(), workspace_id, meeting_id, None).await
    }
}

/// `cap`: the most tokens the calls may send (automatic runs follow the notes cap; a person asking is not capped).
pub async fn suggest(deps: &Deps, workspace_id: &str, meeting_id: &str, cap: Option<u64>) -> Result<Vec<MemoryItem>, String> {
    if (deps.live_meeting)().as_deref() == Some(meeting_id) {
        return Err("Memory is suggested after the meeting ends".into());
    }
    // A meeting filed in no workspace has nowhere for memory to go: refused before any call.
    if !deps.db.meeting_is_filed(meeting_id) {
        return Err("This meeting is not filed in a workspace. File it in one first, then ask for suggestions.".into());
    }
    // The workspace asked about must be the meeting's home, now and again when saving.
    if deps.db.meeting_home(meeting_id).as_deref() != Some(workspace_id) {
        return Err("This meeting does not belong to that workspace".into());
    }
    // A run nobody asked for (`cap` is set) needs the workspace's switch on when each
    // call is sent and again when its result is saved; a person asking is consent enough.
    let automatic = cap.is_some();
    if automatic && !deps.db.suggest_flag(workspace_id) {
        return Ok(Vec::new());
    }
    let (lines, len_ms) = deps.db.meeting_lines(meeting_id);
    if lines.is_empty() {
        return Ok(Vec::new());
    }
    let saved = deps.db.saved_memory(workspace_id);
    let settings: crate::live_runtime::settings::MemorySettings =
        deps.db.kv_get(crate::live_runtime::settings::MEMORY_KEY).and_then(|j| serde_json::from_str(&j).ok()).unwrap_or_default();
    let selection = Selection { provider: settings.provider.clone(), model: settings.model.clone(), effort: settings.effort.clone() };
    // resolved again before every chunk: a provider or model that changed applies to the next call
    let slot = crate::live_runtime::llm::SwapLlm::new(deps.factory.clone(), AiPurpose::Memory, meeting_id, selection)?;
    let stop = slot.stop_token();
    let _registered = register_run(meeting_id, workspace_id, automatic, stop.clone());
    let mut proposals: Vec<Proposal> = Vec::new();
    let mut last_err: Option<String> = None;
    let mut ok_calls = 0;
    let mut sent: u64 = 0;
    for chunk in chunk_lines(&lines, CHUNK_TOKENS, MAX_CHUNKS) {
        let chunk_tokens: u64 = chunk.iter().map(|l| u64::from(estimate_tokens(&l.text)) + 8).sum();
        if let Some(cap) = cap {
            if sent + chunk_tokens > cap {
                last_err = Some("The token cap for automatic runs was reached, so some of the meeting was not read".into());
                break;
            }
        }
        sent += chunk_tokens;
        // Every run needs the meeting to still exist and still be filed here; only a run
        // nobody asked for also needs the workspace's switch.
        if stop.is_cancelled()
            || (automatic && !deps.db.suggest_flag(workspace_id))
            || deps.db.meeting_home(meeting_id).as_deref() != Some(workspace_id)
            || deps.deleted.lock().unwrap().contains(meeting_id)
        {
            return Ok(Vec::new()); // consent ended: nothing more is sent
        }
        let input = MemoryInput {
            lines: chunk,
            meeting_len_ms: len_ms,
            // notes text never enters another prompt
            notes_outline: None,
            saved: saved.clone(),
            language: OutputLanguage::Meeting,
        };
        match suggest_memory(&*slot, &input, &MemoryConfig::default()).await {
            Ok(o) => {
                ok_calls += 1;
                proposals.extend(o.suggestions.proposals);
            }
            Err(e) => {
                let stop = e.code == "no_provider";
                last_err = Some(e.message);
                if stop {
                    break;
                }
            }
        }
    }
    if stop.is_cancelled() {
        return Ok(Vec::new()); // cancelled because consent ended: the result is dropped
    }
    if ok_calls == 0 {
        return Err(last_err.unwrap_or_else(|| "The suggestion failed".into()));
    }
    if deps.deleted.lock().unwrap().contains(meeting_id) {
        return Ok(Vec::new());
    }
    let items: Vec<MemoryCreate> = merge(proposals)
        .into_iter()
        .map(|p| MemoryCreate {
            workspace_id: workspace_id.to_string(),
            kind: p.kind.as_str().to_string(),
            title: p.title,
            text: p.text,
            source_meeting: Some(meeting_id.to_string()),
            source_ms: Some(p.source_ms as i64),
            status: Some("suggested".into()),
            unsupported: p.unsupported,
        })
        .collect();
    // one transaction that re-checks the meeting and its home
    let stored = deps.db.save_suggestions(meeting_id, workspace_id, items, automatic);
    if !stored.is_empty() {
        deps.emitter.emit("memory_changed", json!({"workspace_id": workspace_id}));
    }
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
        let cap = deps
            .db
            .kv_get(crate::live_runtime::settings::NOTETAKER_KEY)
            .and_then(|j| serde_json::from_str::<crate::live_runtime::settings::NotetakerSettings>(&j).ok())
            .map(|n| n.cap)
            .unwrap_or(crate::live_runtime::settings::DEFAULT_CAP);
        if let Err(e) = suggest(&deps, &home, &meeting_id, Some(cap)).await {
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
