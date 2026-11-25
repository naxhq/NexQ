//! The notes engine: ties the trigger, prompt, parser and reducer together.
//! The model call, the clock, the events and the saving are all injected, so
//! the whole loop runs in tests with a scripted model and a fake clock.
//!
//! Two ways to drive it:
//! * `tick().await` does poll, prepare, call and complete in one go;
//! * `poll()` / `prepare()` / `complete()` let an actor keep feeding lines
//!   while the call is in flight (lines queue, one run at a time).

use crate::live_common::{PauseReason, estimate_tokens, speech_units_x2, Clock, LlmCall, LlmError, LlmErrorKind, LlmReply, LlmRequest, RunState};
use crate::live_notes::doc::NoteDoc;
use crate::live_notes::ops::{parse_ops, ParseMode};
use crate::live_notes::prompts::{notes_system, notes_user, transcript_line, NotesPromptOptions};
use crate::live_notes::reducer::{apply_ops, ReduceCtx, ReduceLimits, ReduceReport};
use crate::live_notes::trigger::{Decision, NotesTrigger, NotesTriggerConfig, RunReason, Taken};
use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq)]
pub struct TranscriptLine {
    pub ms: u64,
    /// "You", "Them", "S2"...
    pub speaker: String,
    pub text: String,
}

#[derive(Debug, Clone)]
pub struct NotesConfig {
    pub trigger: NotesTriggerConfig,
    pub prompt: NotesPromptOptions,
    pub reduce: ReduceLimits,
    /// Outline sent with each run (spec: at most 900 tokens).
    pub outline_budget: u32,
    /// Transcript tokens per run; a long backlog is sent over several runs.
    pub max_lines_tokens: u32,
    /// The final pass never delays ending a meeting by more than this.
    pub final_timeout: Duration,
}

impl Default for NotesConfig {
    fn default() -> Self {
        Self {
            trigger: NotesTriggerConfig::default(),
            prompt: NotesPromptOptions::default(),
            reduce: ReduceLimits::default(),
            outline_budget: 900,
            max_lines_tokens: 2_500,
            final_timeout: Duration::from_secs(20),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct NotesStatus {
    pub state: RunState,
    pub in_flight: bool,
    pub tokens_used: u64,
    pub cap: u64,
    pub failures: u32,
    pub pending_words: u32,
    pub last_error: Option<String>,
    pub last_run_ms: Option<u64>,
    pub done: bool,
}

pub trait NotesSink: Send + Sync {
    fn status(&self, status: &NotesStatus);
    fn doc(&self, doc: &NoteDoc, report: &ReduceReport);
    /// Cap reached: the panel asks "Keep taking notes?".
    fn cap_reached(&self);
}

pub struct NullSink;
impl NotesSink for NullSink {
    fn status(&self, _: &NotesStatus) {}
    fn doc(&self, _: &NoteDoc, _: &ReduceReport) {}
    fn cap_reached(&self) {}
}

#[derive(Debug, Clone)]
pub struct NotesSnapshot {
    pub doc: NoteDoc,
    /// running | paused | cap_reached | stopped | done
    pub status: String,
    pub tokens_used: u64,
    pub cap: u64,
}

pub trait NotesStore: Send + Sync {
    fn save(&self, snap: &NotesSnapshot) -> Result<(), String>;
}

pub struct NullStore;
impl NotesStore for NullStore {
    fn save(&self, _: &NotesSnapshot) -> Result<(), String> {
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct PreparedRun {
    pub request: LlmRequest,
    pub reason: RunReason,
    pub from_ms: u64,
    pub to_ms: u64,
    lines: Vec<TranscriptLine>,
    taken: Taken,
    lines_tokens: u32,
    outline_tokens: u32,
    system_tokens: u32,
}

#[derive(Debug, Clone)]
pub struct RunOutcome {
    pub reason: RunReason,
    pub ok: bool,
    pub mode: ParseMode,
    pub report: Option<ReduceReport>,
    /// Tokens charged against the cap (new input plus output).
    pub counted_tokens: u64,
    /// Everything the call used (system, outline, lines, output), for cost.
    pub sent_tokens: u64,
    pub error: Option<String>,
    pub cap_reached: bool,
}

pub struct NotesEngine<L: LlmCall, C: Clock> {
    llm: L,
    clock: C,
    cfg: NotesConfig,
    trigger: NotesTrigger,
    doc: NoteDoc,
    pending: Vec<TranscriptLine>,
    sink: Arc<dyn NotesSink>,
    store: Arc<dyn NotesStore>,
    last_error: Option<String>,
    /// The error code of the last failure (`no_key` ...).
    last_code: &'static str,
    /// What the end-of-meeting pass did, when it had to decide (shown in the state).
    pub final_note: Option<String>,
    done: bool,
    /// Lines dropped because more than `MAX_PENDING_WORDS` were waiting (the
    /// oldest go first). Stays 0 in any normal meeting.
    pub dropped_lines: u64,
    /// Everything the calls used so far (system, outline, lines, output).
    pub sent_tokens_total: u64,
    pending_words: usize,
    /// Random code fencing data blocks in this meeting's prompts.
    pub nonce: String,
}

/// A safety bound on lines waiting while notes are paused or capped.
pub const MAX_PENDING_WORDS: usize = 40_000;

impl<L: LlmCall, C: Clock> NotesEngine<L, C> {
    pub fn new(llm: L, clock: C, cfg: NotesConfig, sink: Arc<dyn NotesSink>, store: Arc<dyn NotesStore>) -> Self {
        let trigger = NotesTrigger::new(cfg.trigger.clone());
        Self { llm, clock, cfg, trigger, doc: NoteDoc::new(), pending: Vec::new(), sink, store, last_error: None, last_code: "", final_note: None, done: false, dropped_lines: 0, sent_tokens_total: 0, pending_words: 0, nonce: crate::prompt_data::new_nonce() }
    }

    /// Continue from saved notes (app restart, resumed meeting).
    pub fn resume_from(&mut self, doc: NoteDoc, tokens_used: u64, cap: u64) {
        self.doc = doc;
        self.trigger.guard.restore(tokens_used, cap);
    }

    pub fn doc(&self) -> &NoteDoc {
        &self.doc
    }

    /// The user's own edits go through here (pin, edit, delete, add).
    pub fn doc_mut(&mut self) -> &mut NoteDoc {
        &mut self.doc
    }

    pub fn state(&self) -> RunState {
        self.trigger.state()
    }

    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }

    pub fn failures(&self) -> u32 {
        self.trigger.guard.failures
    }

    pub fn status(&self) -> NotesStatus {
        NotesStatus {
            state: self.trigger.guard.state,
            in_flight: self.trigger.guard.in_flight,
            tokens_used: self.trigger.guard.used,
            cap: self.trigger.guard.cap,
            failures: self.trigger.guard.failures,
            pending_words: self.trigger.pending_words(),
            last_error: self.last_error.clone(),
            last_run_ms: None,
            done: self.done,
        }
    }

    // ---- inputs

    /// A finished transcript line (never partial text).
    pub fn feed(&mut self, line: TranscriptLine) {
        self.trigger.on_line(self.clock.now_ms(), &line.text);
        let units = speech_units_x2(&line.text) as usize;
        if units > 0 {
            self.pending_words += units / 2;
            self.pending.push(line);
            while self.pending_words > MAX_PENDING_WORDS && self.pending.len() > 1 {
                let old = self.pending.remove(0);
                self.pending_words = self.pending_words.saturating_sub(speech_units_x2(&old.text) as usize / 2);
                self.dropped_lines += 1;
            }
        }
    }

    pub fn request_manual(&mut self) {
        self.trigger.request_manual();
    }

    /// Closed while a live answer is generating.
    pub fn set_gate(&mut self, open: bool) {
        self.trigger.set_gate(open);
    }

    pub fn pause(&mut self) {
        self.trigger.pause();
        self.emit_status();
    }

    pub fn resume(&mut self) {
        self.trigger.resume();
        self.emit_status();
    }

    pub fn keep_going(&mut self) {
        self.trigger.keep_going();
        self.emit_status();
    }

    pub fn stop(&mut self) {
        self.trigger.stop();
        self.save("stopped");
        self.emit_status();
    }

    // ---- one run

    pub fn poll(&mut self) -> Decision {
        self.trigger.poll(self.clock.now_ms())
    }

    /// Builds the request for a run the trigger approved and marks it in flight.
    pub fn prepare(&mut self, reason: RunReason) -> Option<PreparedRun> {
        if self.pending.is_empty() {
            return None;
        }
        let now = self.clock.now_ms();
        let total = self.trigger.begin_run(now);

        // take lines up to the per-run token budget (at least one)
        let mut take = 0usize;
        let mut tokens = 0u32;
        for l in &self.pending {
            let t = estimate_tokens(&l.text) + 6;
            if take > 0 && tokens + t > self.cfg.max_lines_tokens {
                break;
            }
            tokens += t;
            take += 1;
        }
        let lines: Vec<TranscriptLine> = self.pending.drain(..take).collect();
        let taken_words: usize = lines.iter().map(|l| speech_units_x2(&l.text) as usize / 2).sum();
        self.pending_words = self.pending_words.saturating_sub(taken_words);
        let leftover_units: u32 = self.pending.iter().map(|l| speech_units_x2(&l.text)).sum();
        if leftover_units > 0 {
            self.trigger.give_back(leftover_units);
        }
        let taken = Taken { units_x2: total.units_x2.saturating_sub(leftover_units) };

        let from_ms = lines.first().map(|l| l.ms / 1000 * 1000).unwrap_or(0);
        let to_ms = lines.last().map(|l| l.ms).unwrap_or(from_ms).max(from_ms);
        let outline = self.doc.outline(self.cfg.outline_budget);
        let rendered: Vec<String> = lines.iter().map(|l| transcript_line(l.ms, &l.speaker, &l.text)).collect();
        let system = notes_system(&self.cfg.prompt, &self.nonce);
        let user = notes_user(&self.nonce, &outline, &rendered, from_ms, to_ms);
        let lines_tokens: u32 = rendered.iter().map(|r| estimate_tokens(r)).sum();
        let request = LlmRequest {
            system: system.clone(),
            user,
            max_output_tokens: self.cfg.prompt.detail.max_output_tokens(),
            purpose: "notes",
        };
        Some(PreparedRun {
            request,
            reason,
            from_ms,
            to_ms,
            lines,
            taken,
            lines_tokens,
            outline_tokens: estimate_tokens(&outline),
            system_tokens: estimate_tokens(&system),
        })
    }

    fn counted(&self, reply: &LlmReply, p: &PreparedRun) -> (u64, u64) {
        let out = reply.output_tokens.unwrap_or_else(|| estimate_tokens(&reply.text)) as u64;
        let counted_in = match reply.input_tokens {
            Some(i) => {
                let cached = reply.cached_input_tokens.unwrap_or(0);
                (i.saturating_sub(cached).saturating_sub(p.outline_tokens + p.system_tokens)).max(p.lines_tokens) as u64
            }
            None => p.lines_tokens as u64,
        };
        let sent = reply.input_tokens.map(|i| i as u64).unwrap_or((p.system_tokens + p.outline_tokens + p.lines_tokens) as u64) + out;
        (counted_in + out, sent)
    }

    fn restore(&mut self, mut lines: Vec<TranscriptLine>) {
        self.pending_words += lines.iter().map(|l| speech_units_x2(&l.text) as usize / 2).sum::<usize>();
        lines.append(&mut self.pending);
        self.pending = lines;
    }

    /// Gives a prepared run up without applying anything (the scope changed
    /// under it, the meeting was deleted): its lines go back to the queue.
    pub fn abort(&mut self, p: PreparedRun) {
        self.trigger.end_err(LlmErrorKind::Cancelled, p.taken, 0);
        self.restore(p.lines);
    }

    /// Applies the model's answer (or error) of a prepared run.
    pub fn complete(&mut self, p: PreparedRun, result: Result<LlmReply, LlmError>) -> RunOutcome {
        let outcome = match result {
            Ok(reply) => {
                let (counted, sent) = self.counted(&reply, &p);
                let text_empty = reply.text.trim().is_empty();
                let parsed = parse_ops(&reply.text);
                if parsed.ops.is_empty() && !parsed.explicit_empty && !text_empty {
                    self.trigger.end_err(LlmErrorKind::Failed, p.taken, counted);
                    self.restore(p.lines);
                    let msg = "The model's answer could not be read as notes".to_string();
                    self.last_error = Some(msg.clone());
                    RunOutcome { reason: p.reason, ok: false, mode: ParseMode::None, report: None, counted_tokens: counted, sent_tokens: sent, error: Some(msg), cap_reached: false }
                } else {
                    let ctx = ReduceCtx { range_start_ms: p.from_ms, range_end_ms: p.to_ms };
                    let report = apply_ops(&mut self.doc, parsed.ops, ctx, &self.cfg.reduce);
                    let cap = self.trigger.end_ok(counted);
                    self.last_error = None;
                    self.sink.doc(&self.doc, &report);
                    if cap {
                        self.sink.cap_reached();
                    }
                    RunOutcome { reason: p.reason, ok: true, mode: parsed.mode, report: Some(report), counted_tokens: counted, sent_tokens: sent, error: None, cap_reached: cap }
                }
            }
            Err(e) => {
                self.trigger.end_err(e.kind, p.taken, 0);
                if e.kind != LlmErrorKind::Cancelled {
                    self.last_error = Some(e.message.clone());
                    self.last_code = e.code;
                }
                self.restore(p.lines);
                RunOutcome {
                    reason: p.reason,
                    ok: false,
                    mode: ParseMode::None,
                    report: None,
                    counted_tokens: 0,
                    sent_tokens: 0,
                    error: Some(e.message),
                    cap_reached: false,
                }
            }
        };
        self.sent_tokens_total += outcome.sent_tokens;
        self.save(self.status_word());
        self.emit_status();
        outcome
    }

    fn status_word(&self) -> &'static str {
        if self.done {
            return "done";
        }
        match self.trigger.guard.state {
            RunState::Running => "running",
            RunState::Paused(_) => "paused",
            RunState::CapReached => "cap_reached",
            RunState::Stopped => "stopped",
        }
    }

    /// Saves the notes as they are now (after a user edit).
    pub fn save_now(&self) {
        self.save(self.status_word());
    }

    fn save(&self, status: &str) {
        let snap = NotesSnapshot {
            doc: self.doc.clone(),
            status: status.to_string(),
            tokens_used: self.trigger.guard.used,
            cap: self.trigger.guard.cap,
        };
        if let Err(e) = self.store.save(&snap) {
            log::warn!("live notes: save failed: {e}");
        }
    }

    fn emit_status(&self) {
        self.sink.status(&self.status());
    }

    /// Poll, run if due, apply. None when nothing was due.
    pub async fn tick(&mut self) -> Option<RunOutcome> {
        let Decision::Run(reason) = self.poll() else { return None };
        let prepared = self.prepare(reason)?;
        let result = self.llm.call(&prepared.request).await;
        Some(self.complete(prepared, result))
    }

    /// Meeting ended: one last pass over what is still unsent, bounded by
    /// `final_timeout`, then the notes are saved as done.
    pub async fn finish(&mut self) -> Option<RunOutcome> {
        // After three failures one bounded last try is made, unless the cause
        // cannot be fixed by trying (no key); a plan limit is not retried either.
        let mut retried = false;
        match self.trigger.guard.state {
            RunState::Paused(PauseReason::Failures) if self.last_code != "no_key" => {
                self.trigger.guard.allow_final_retry();
                retried = true;
            }
            RunState::Paused(PauseReason::Failures) => {
                self.final_note = Some("Not tried again at the end: the provider needs a key or a sign-in".into());
            }
            RunState::Paused(PauseReason::PlanLimit) => {
                self.final_note = Some("Not tried again at the end: the plan's usage limit was reached".into());
            }
            _ => {}
        }
        self.trigger.request_final();
        let mut outcome = None;
        if let Decision::Run(reason) = self.poll() {
            if let Some(prepared) = self.prepare(reason) {
                let result = match tokio::time::timeout(self.cfg.final_timeout, self.llm.call(&prepared.request)).await {
                    Ok(r) => r,
                    Err(_) => Err(LlmError::cancelled()),
                };
                outcome = Some(self.complete(prepared, result));
            }
        }
        if retried {
            self.final_note = Some(match &outcome {
                Some(o) if o.ok => "Tried once more at the end after earlier errors: it worked".to_string(),
                Some(o) => format!("Tried once more at the end after earlier errors: {}", o.error.clone().unwrap_or_else(|| "it failed".into())),
                None => "Nothing was left to send at the end".to_string(),
            });
        }
        self.done = true;
        self.trigger.stop();
        self.save("done");
        self.emit_status();
        outcome
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use async_trait::async_trait;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    pub struct MockLlm {
        pub replies: Mutex<VecDeque<Result<LlmReply, LlmError>>>,
        pub requests: Mutex<Vec<LlmRequest>>,
        pub delay: Duration,
    }

    impl MockLlm {
        pub fn new(replies: Vec<Result<LlmReply, LlmError>>) -> Self {
            Self { replies: Mutex::new(replies.into()), requests: Mutex::new(vec![]), delay: Duration::ZERO }
        }
    }

    pub fn reply(text: &str) -> Result<LlmReply, LlmError> {
        Ok(LlmReply { text: text.into(), ..Default::default() })
    }

    #[async_trait]
    impl LlmCall for MockLlm {
        async fn call(&self, req: &LlmRequest) -> Result<LlmReply, LlmError> {
            self.requests.lock().unwrap().push(req.clone());
            if !self.delay.is_zero() {
                tokio::time::sleep(self.delay).await;
            }
            self.replies.lock().unwrap().pop_front().unwrap_or_else(|| Ok(LlmReply { text: "{\"ops\":[]}".into(), ..Default::default() }))
        }
    }

    #[derive(Default)]
    pub struct RecSink {
        pub statuses: Mutex<Vec<NotesStatus>>,
        pub docs: Mutex<u32>,
        pub caps: Mutex<u32>,
    }
    impl NotesSink for RecSink {
        fn status(&self, s: &NotesStatus) {
            self.statuses.lock().unwrap().push(s.clone());
        }
        fn doc(&self, _: &NoteDoc, _: &ReduceReport) {
            *self.docs.lock().unwrap() += 1;
        }
        fn cap_reached(&self) {
            *self.caps.lock().unwrap() += 1;
        }
    }

    #[derive(Default)]
    pub struct RecStore {
        pub saves: Mutex<Vec<NotesSnapshot>>,
    }
    impl NotesStore for RecStore {
        fn save(&self, s: &NotesSnapshot) -> Result<(), String> {
            self.saves.lock().unwrap().push(s.clone());
            Ok(())
        }
    }

    pub fn line(ms: u64, text: &str) -> TranscriptLine {
        TranscriptLine { ms, speaker: "Them".into(), text: text.into() }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    use crate::live_common::FakeClock;
    use crate::live_notes::doc::BlockKind;

    fn words(n: usize) -> String {
        (0..n).map(|i| format!("w{i}")).collect::<Vec<_>>().join(" ")
    }

    fn engine(replies: Vec<Result<LlmReply, LlmError>>) -> (NotesEngine<MockLlm, FakeClock>, FakeClock, Arc<RecSink>, Arc<RecStore>) {
        let clock = FakeClock::new(0);
        let sink = Arc::new(RecSink::default());
        let store = Arc::new(RecStore::default());
        let e = NotesEngine::new(MockLlm::new(replies), clock.clone(), NotesConfig::default(), sink.clone(), store.clone());
        (e, clock, sink, store)
    }

    const OPS1: &str = r#"{"ops":[{"op":"add","id":"t","type":"topic","text":"Budget","t":"00:10"},{"op":"add","type":"decision","parent":"t","text":"Approve {{n:12k}} for {{o:Acme}}","t":"00:20"}]}"#;

    #[tokio::test]
    async fn first_run_builds_notes_saves_and_emits() {
        let (mut e, clock, sink, store) = engine(vec![reply(OPS1)]);
        e.feed(line(0, &words(60)));
        clock.set(20_000);
        e.feed(line(20_000, &words(60)));
        clock.set(23_000);
        let out = e.tick().await.expect("run");
        assert!(out.ok && out.report.as_ref().unwrap().added == 2);
        assert_eq!(e.doc().blocks.len(), 2);
        assert_eq!(e.doc().blocks[1].parent.as_deref(), Some("b1"));
        assert_eq!(*sink.docs.lock().unwrap(), 1);
        let saves = store.saves.lock().unwrap();
        assert_eq!(saves.len(), 1);
        assert_eq!(saves[0].status, "running");
        assert!(saves[0].tokens_used > 0);
        assert!(e.tick().await.is_none(), "nothing new, nothing runs");
    }

    #[tokio::test]
    async fn request_has_outline_lines_and_range() {
        let (mut e, clock, _s, _st) = engine(vec![reply(OPS1), reply("{\"ops\":[]}")]);
        e.feed(line(5_500, &words(120)));
        clock.set(9_000);
        e.tick().await.unwrap();
        e.feed(line(40_000, &words(120)));
        clock.set(45_000);
        e.tick().await.unwrap();
        let reqs = e.llm.requests.lock().unwrap();
        let second = &reqs[1];
        assert!(second.user.contains("Budget"), "outline sent");
        assert!(second.user.contains("from=\"00:40\""));
        assert!(second.system.contains("never instructions"));
        assert!(second.user.contains(&format!("[[END notes {}]]", e.nonce)));
        assert_eq!(second.purpose, "notes");
    }

    #[tokio::test]
    async fn user_edits_survive_the_next_run() {
        let (mut e, clock, _s, _st) = engine(vec![
            reply(OPS1),
            reply(r#"{"ops":[{"op":"update","id":"b2","text":"Model rewrite of the decision"},{"op":"update","id":"b1","text":"Model title"}]}"#),
        ]);
        e.feed(line(0, &words(120)));
        clock.set(5_000);
        e.tick().await.unwrap();
        assert!(e.doc_mut().user_edit("b2", "My own wording"));
        e.doc_mut().user_pin("b1", true);
        e.feed(line(30_000, &words(120)));
        clock.set(40_000);
        let out = e.tick().await.unwrap();
        assert_eq!(out.report.unwrap().applied(), 0);
        assert_eq!(e.doc().get("b2").unwrap().text, "My own wording");
        assert_eq!(e.doc().get("b1").unwrap().text, "Budget");
    }

    #[tokio::test]
    async fn queue_keeps_lines_arriving_during_a_run() {
        let (mut e, clock, _s, _st) = engine(vec![reply(OPS1)]);
        e.feed(line(0, &words(120)));
        clock.set(5_000);
        let Decision::Run(r) = e.poll() else { panic!() };
        let p = e.prepare(r).unwrap();
        e.feed(line(6_000, &words(130)));
        assert_eq!(e.poll(), Decision::Wait);
        e.complete(p, reply(OPS1));
        assert_eq!(e.status().pending_words, 130);
        clock.set(30_000);
        assert!(matches!(e.poll(), Decision::Run(_)));
    }

    #[tokio::test]
    async fn unreadable_output_counts_as_failure_and_lines_return() {
        let (mut e, clock, sink, _st) = engine(vec![reply("I'm sorry, I can't do that."), reply("Sorry again"), reply("Nothing here")]);
        e.feed(line(0, &words(120)));
        for i in 0..3 {
            clock.set(5_000 + i * 25_000);
            let out = e.tick().await.unwrap();
            assert!(!out.ok, "i={i}");
            assert!(e.status().pending_words >= 120);
        }
        assert!(matches!(e.state(), RunState::Paused(crate::live_common::PauseReason::Failures)));
        clock.set(200_000);
        assert!(e.tick().await.is_none());
        assert!(sink.statuses.lock().unwrap().last().unwrap().last_error.is_some());
        e.resume();
        assert!(matches!(e.state(), RunState::Running));
    }

    #[tokio::test]
    async fn empty_answer_is_fine_and_lines_are_consumed() {
        let (mut e, clock, _s, _st) = engine(vec![reply("")]);
        e.feed(line(0, &words(120)));
        clock.set(5_000);
        let out = e.tick().await.unwrap();
        assert!(out.ok);
        assert_eq!(e.status().pending_words, 0);
    }

    #[tokio::test]
    async fn plan_limit_pauses_and_error_is_kept() {
        let (mut e, clock, sink, _st) = engine(vec![Err(LlmError::plan_limit("Usage limit reached"))]);
        e.feed(line(0, &words(120)));
        clock.set(5_000);
        e.tick().await.unwrap();
        assert!(matches!(e.state(), RunState::Paused(crate::live_common::PauseReason::PlanLimit)));
        assert_eq!(sink.statuses.lock().unwrap().last().unwrap().last_error.as_deref(), Some("Usage limit reached"));
        assert_eq!(e.status().pending_words, 120);
    }

    #[tokio::test]
    async fn cap_event_then_keep_going() {
        let clock = FakeClock::new(0);
        let sink = Arc::new(RecSink::default());
        let mut cfg = NotesConfig::default();
        cfg.trigger.cap_tokens = 50;
        let llm = MockLlm::new(vec![Ok(LlmReply { text: OPS1.into(), input_tokens: Some(2000), output_tokens: Some(100), cached_input_tokens: Some(1000) })]);
        let mut e = NotesEngine::new(llm, clock.clone(), cfg, sink.clone(), Arc::new(NullStore));
        e.feed(line(0, &words(150)));
        clock.set(5_000);
        let out = e.tick().await.unwrap();
        assert!(out.cap_reached);
        assert_eq!(*sink.caps.lock().unwrap(), 1);
        assert_eq!(e.state(), RunState::CapReached);
        e.feed(line(10_000, &words(150)));
        clock.set(60_000);
        assert!(e.tick().await.is_none());
        e.keep_going();
        assert!(e.status().cap > 100);
        assert!(e.tick().await.is_some());
    }

    #[tokio::test]
    async fn counted_tokens_exclude_cached_and_outline() {
        let (mut e, clock, _s, _st) = engine(vec![]);
        e.llm.replies.lock().unwrap().push_back(Ok(LlmReply { text: OPS1.into(), input_tokens: Some(1500), output_tokens: Some(80), cached_input_tokens: Some(1200) }));
        e.feed(line(0, &words(120)));
        clock.set(5_000);
        let out = e.tick().await.unwrap();
        // 1500 - 1200 cached = 300 minus system+outline (~300) -> floored at the new lines
        assert!(out.counted_tokens >= 80 && out.counted_tokens < 600, "{}", out.counted_tokens);
        assert_eq!(out.sent_tokens, 1580);
    }

    #[tokio::test]
    async fn backlog_is_sent_in_pieces() {
        let (mut e, clock, _s, _st) = engine(vec![]);
        for i in 0..400u64 {
            e.feed(line(i * 1000, &words(20)));
        }
        clock.set(500_000);
        let p = match e.poll() {
            Decision::Run(r) => e.prepare(r).unwrap(),
            _ => panic!(),
        };
        assert!(estimate_tokens(&p.request.user) < 3_800, "{}", estimate_tokens(&p.request.user));
        assert!(e.status().pending_words > 0, "rest stays queued");
        e.complete(p, reply("{\"ops\":[]}"));
    }

    #[tokio::test]
    async fn final_pass_runs_saves_done_and_is_bounded() {
        let (mut e, clock, _s, store) = engine(vec![reply(OPS1)]);
        e.feed(line(0, &words(10)));
        clock.set(500);
        assert!(e.tick().await.is_none(), "below thresholds");
        let out = e.finish().await.expect("final pass");
        assert!(out.ok && out.reason == RunReason::Final);
        assert_eq!(store.saves.lock().unwrap().last().unwrap().status, "done");
        // a model that never answers in time does not hold up the end
        let clock2 = FakeClock::new(0);
        let mut llm = MockLlm::new(vec![reply(OPS1)]);
        llm.delay = Duration::from_millis(300);
        let cfg = NotesConfig { final_timeout: Duration::from_millis(20), ..Default::default() };
        let mut e2 = NotesEngine::new(llm, clock2, cfg, Arc::new(NullSink), Arc::new(NullStore));
        e2.feed(line(0, &words(10)));
        let t0 = std::time::Instant::now();
        let out = e2.finish().await.unwrap();
        assert!(!out.ok && t0.elapsed() < Duration::from_millis(250));
        assert!(e2.status().done);
    }

    #[tokio::test]
    async fn gate_blocks_until_live_answer_ends() {
        let (mut e, clock, _s, _st) = engine(vec![reply(OPS1)]);
        e.feed(line(0, &words(150)));
        clock.set(5_000);
        e.set_gate(false);
        assert!(e.tick().await.is_none());
        e.set_gate(true);
        assert!(e.tick().await.is_some());
        let _ = BlockKind::Topic;
    }

    #[tokio::test]
    async fn the_final_pass_tries_once_after_errors_unless_the_cause_cannot_change() {
        // three failures, then the end of the meeting: one bounded try, and the state says so
        let (mut e, clock, _s, _st) = engine(vec![
            Err(LlmError::failed("boom")),
            Err(LlmError::failed("boom")),
            Err(LlmError::failed("boom")),
            reply(OPS1),
        ]);
        e.feed(line(0, &words(120)));
        for i in 0..3 {
            clock.set(5_000 + i * 25_000);
            e.tick().await.unwrap();
        }
        assert!(matches!(e.state(), RunState::Paused(crate::live_common::PauseReason::Failures)));
        let out = e.finish().await.expect("one last try");
        assert!(out.ok && out.reason == RunReason::Final);
        assert!(e.final_note.as_deref().unwrap().contains("it worked"), "{:?}", e.final_note);
        assert_eq!(e.llm.requests.lock().unwrap().len(), 4);
        // no key: not tried again, and it says why
        let (mut k, clock, _s, _st) = engine(vec![]);
        let no_key = || Err(LlmError { kind: LlmErrorKind::Failed, message: "no key".into(), code: "no_key" });
        k.llm.replies.lock().unwrap().extend([no_key(), no_key(), no_key()]);
        k.feed(line(0, &words(120)));
        for i in 0..3 {
            clock.set(5_000 + i * 25_000);
            k.tick().await.unwrap();
        }
        assert!(k.finish().await.is_none());
        assert!(k.final_note.as_deref().unwrap().contains("key"));
        assert_eq!(k.llm.requests.lock().unwrap().len(), 3);
        // plan limit: not tried again
        let (mut p, clock, _s, _st) = engine(vec![Err(LlmError::plan_limit("limit"))]);
        p.feed(line(0, &words(120)));
        clock.set(5_000);
        p.tick().await.unwrap();
        assert!(p.finish().await.is_none());
        assert!(p.final_note.as_deref().unwrap().contains("limit"));
    }
}
