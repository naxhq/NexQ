//! The brief engine. Local search and the topic detector run all the time;
//! the model is called only when the trigger says so. Model, search, clock,
//! events and saving are injected.

use crate::live_brief::prompts::{brief_system, brief_user, pack_passages};
use crate::live_brief::search::{LocalSearch, Passage};
use crate::live_brief::sheet::{parse_sheet_with, Sheet, SheetHolder, SheetView, SentPassage};
use crate::live_brief::topic::{TopicConfig, TopicDetector};
use crate::live_brief::trigger::{BriefAction, BriefTrigger, BriefTriggerConfig, CallReason, ModelDecision};
use crate::live_common::{content_terms, estimate_tokens, speech_units_x2, Clock, LlmCall, LlmError, LlmErrorKind, LlmReply, LlmRequest, RunState};
use crate::live_notes::prompts::OutputLanguage;
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::Arc;

#[derive(Debug, Clone)]
pub struct BriefConfig {
    pub trigger: BriefTriggerConfig,
    pub topic: TopicConfig,
    pub language: OutputLanguage,
    /// Tokens of passages sent per call (spec: 2.5k).
    pub passages_budget: u32,
    pub max_search_results: usize,
    pub recent_ms: u64,
    pub recent_tokens: u32,
    pub memory_tokens: u32,
    pub max_output_tokens: u32,
}

impl Default for BriefConfig {
    fn default() -> Self {
        Self {
            trigger: BriefTriggerConfig::default(),
            topic: TopicConfig::default(),
            language: OutputLanguage::Meeting,
            passages_budget: 2_500,
            max_search_results: 10,
            recent_ms: 60_000,
            recent_tokens: 300,
            memory_tokens: 400,
            max_output_tokens: 450,
        }
    }
}

#[derive(Debug, Clone)]
pub struct BriefLine {
    pub start_ms: u64,
    /// When unknown, the length is estimated from the words (400 ms each).
    pub end_ms: Option<u64>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct BriefStatus {
    pub state: RunState,
    pub in_flight: bool,
    pub tokens_used: u64,
    pub cap: u64,
    pub failures: u32,
    pub last_error: Option<String>,
}

pub trait BriefSink: Send + Sync {
    fn status(&self, status: &BriefStatus);
    fn sheet(&self, view: &SheetView);
    fn cap_reached(&self);
}

pub struct NullBriefSink;
impl BriefSink for NullBriefSink {
    fn status(&self, _: &BriefStatus) {}
    fn sheet(&self, _: &SheetView) {}
    fn cap_reached(&self) {}
}

#[derive(Debug, Clone)]
pub struct BriefSnapshot {
    pub sheet: Option<Sheet>,
    /// running | paused | cap_reached | stopped
    pub status: String,
    pub tokens_used: u64,
    pub cap: u64,
}

pub trait BriefStore: Send + Sync {
    fn save(&self, snap: &BriefSnapshot) -> Result<(), String>;
}

pub struct NullBriefStore;
impl BriefStore for NullBriefStore {
    fn save(&self, _: &BriefSnapshot) -> Result<(), String> {
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct PreparedBrief {
    pub request: LlmRequest,
    pub reason: CallReason,
    pub sent: Vec<SentPassage>,
    user_tokens: u32,
    epoch: u64,
}

#[derive(Debug, Clone)]
pub struct BriefOutcome {
    pub reason: CallReason,
    pub ok: bool,
    pub facts_shown: usize,
    pub facts_dropped: usize,
    pub counted_tokens: u64,
    pub sent_tokens: u64,
    pub error: Option<String>,
    pub cap_reached: bool,
}

#[derive(Debug, Clone, Default)]
pub struct BriefTick {
    pub searched: bool,
    pub topic_changed: bool,
    pub call: Option<BriefOutcome>,
}

pub struct BriefEngine<L: LlmCall, C: Clock, S: LocalSearch> {
    llm: L,
    clock: C,
    search: S,
    cfg: BriefConfig,
    trigger: BriefTrigger,
    detector: TopicDetector,
    holder: Arc<std::sync::Mutex<SheetHolder>>,
    lines: VecDeque<(u64, String)>,
    last_line_ms: u64,
    memory: String,
    sink: Arc<dyn BriefSink>,
    store: Arc<dyn BriefStore>,
    last_error: Option<String>,
    pub searches: u32,
    /// Random code fencing data blocks in this meeting's prompts.
    pub nonce: String,
    /// Bumped by a scope change; a call prepared earlier is discarded.
    epoch: u64,
}

impl<L: LlmCall, C: Clock, S: LocalSearch> BriefEngine<L, C, S> {
    pub fn new(llm: L, clock: C, search: S, scope: &str, cfg: BriefConfig, sink: Arc<dyn BriefSink>, store: Arc<dyn BriefStore>) -> Self {
        let trigger = BriefTrigger::new(cfg.trigger.clone());
        let detector = TopicDetector::new(cfg.topic.clone());
        Self {
            llm,
            clock,
            search,
            cfg,
            trigger,
            detector,
            holder: Arc::new(std::sync::Mutex::new(SheetHolder::new(scope))),
            lines: VecDeque::new(),
            last_line_ms: 0,
            memory: String::new(),
            sink,
            store,
            last_error: None,
            searches: 0,
            nonce: crate::prompt_data::new_nonce(),
            epoch: 0,
        }
    }

    /// The sheet holder, shared so live answers can read it without the engine.
    pub fn holder_handle(&self) -> Arc<std::sync::Mutex<SheetHolder>> {
        self.holder.clone()
    }

    pub fn scope(&self) -> String {
        self.holder.lock().unwrap().scope().to_string()
    }

    pub fn failures(&self) -> u32 {
        self.trigger.guard.failures
    }

    pub fn state(&self) -> RunState {
        self.trigger.state()
    }

    pub fn status(&self) -> BriefStatus {
        BriefStatus {
            state: self.trigger.guard.state,
            in_flight: self.trigger.guard.in_flight,
            tokens_used: self.trigger.guard.used,
            cap: self.trigger.guard.cap,
            failures: self.trigger.guard.failures,
            last_error: self.last_error.clone(),
        }
    }

    pub fn view(&self) -> SheetView {
        self.holder.lock().unwrap().view(self.clock.now_ms())
    }

    // ---- inputs

    /// Saved memory of the workspace (data for the prompt, trimmed).
    pub fn set_memory(&mut self, text: &str) {
        self.memory = crate::prompt_data::neutralise(text);
    }

    /// A finished transcript line.
    pub fn feed(&mut self, line: BriefLine) {
        let units = speech_units_x2(&line.text);
        if units == 0 {
            return;
        }
        let dur = match line.end_ms {
            Some(e) if e > line.start_ms => e - line.start_ms,
            _ => units as u64 * 200,
        };
        self.trigger.on_speech(dur);
        self.detector.push(line.start_ms, &line.text);
        self.last_line_ms = self.last_line_ms.max(line.start_ms);
        self.lines.push_back((line.start_ms, line.text));
        let keep_from = self.last_line_ms.saturating_sub(self.cfg.recent_ms * 3);
        while self.lines.front().map(|(t, _)| *t < keep_from).unwrap_or(false) {
            self.lines.pop_front();
        }
    }

    pub fn request_refresh(&mut self) {
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
        self.save();
        self.emit_status();
    }

    /// Meeting scope changed: the sheet, the sent passages and the topic
    /// history are dropped at once.
    pub fn set_scope(&mut self, scope: &str, memory: &str) {
        let changed = self.holder.lock().unwrap().set_scope(scope);
        self.memory = crate::prompt_data::neutralise(memory);
        if changed {
            self.epoch += 1;
            self.last_line_ms = 0;
            self.nonce = crate::prompt_data::new_nonce();
            self.trigger.reset_scope();
            self.detector.reset();
            self.lines.clear();
            self.save();
            self.sink.sheet(&self.view());
        }
    }

    // ---- what live answers use

    pub fn sheet_for_answer(&self, scope: &str) -> Option<String> {
        self.holder.lock().unwrap().sheet_for_answer(self.clock.now_ms(), scope)
    }

    /// For a running session: the sheet text only when it changed since the
    /// revision `last_sent`; returns the new revision to remember.
    pub fn sheet_for_session(&self, scope: &str, last_sent: Option<u64>) -> Option<(String, u64)> {
        self.holder.lock().unwrap().changed_since(self.clock.now_ms(), scope, last_sent)
    }

    // ---- one step

    fn recent_text(&self) -> String {
        let from = self.last_line_ms.saturating_sub(self.cfg.recent_ms);
        let mut parts: Vec<&str> = self.lines.iter().filter(|(t, _)| *t >= from).map(|(_, s)| s.as_str()).collect();
        // keep the end of the conversation when over budget
        let mut text = parts.join(" ");
        while estimate_tokens(&text) > self.cfg.recent_tokens && parts.len() > 1 {
            parts.remove(0);
            text = parts.join(" ");
        }
        text
    }

    /// The search query: the distinct content words of the last minute,
    /// newest first, so the end of the conversation weighs most.
    pub fn query(&self) -> String {
        let from = self.last_line_ms.saturating_sub(self.cfg.recent_ms);
        let mut seen = std::collections::HashSet::new();
        let mut out: Vec<String> = Vec::new();
        for (_, text) in self.lines.iter().rev().filter(|(t, _)| *t >= from) {
            for t in content_terms(text) {
                if seen.insert(t.clone()) {
                    out.push(t);
                }
            }
            if out.len() >= 24 {
                break;
            }
        }
        out.truncate(24);
        out.join(" ")
    }

    fn trim_memory(&self) -> String {
        let max_chars = (self.cfg.memory_tokens as usize) * 4;
        self.memory.chars().take(max_chars).collect()
    }

    pub fn prepare(&mut self, reason: CallReason, found: &[Passage]) -> Option<PreparedBrief> {
        let sent = pack_passages(found, self.cfg.passages_budget);
        if sent.is_empty() {
            return None;
        }
        let ids: Vec<String> = sent.iter().map(|p| p.id.clone()).collect();
        self.trigger.begin_call(self.clock.now_ms(), &ids);
        let user = brief_user(&self.nonce, &sent, &self.trim_memory(), &self.recent_text());
        let request = LlmRequest {
            system: brief_system(&self.cfg.language, &self.nonce),
            user: user.clone(),
            max_output_tokens: self.cfg.max_output_tokens,
            purpose: "brief",
        };
        Some(PreparedBrief { request, reason, sent, user_tokens: estimate_tokens(&user), epoch: self.epoch })
    }

    /// Gives a prepared call up without parsing or publishing anything.
    pub fn abort(&mut self, _p: PreparedBrief) {
        self.trigger.end_err(LlmErrorKind::Cancelled, 0);
    }

    pub fn complete(&mut self, p: PreparedBrief, result: Result<LlmReply, LlmError>) -> BriefOutcome {
        let now = self.clock.now_ms();
        // The scope changed while the call ran: whatever it says is about the old one.
        let result = if p.epoch != self.epoch { Err(LlmError::cancelled()) } else { result };
        let outcome = match result {
            Ok(reply) => {
                let out = reply.output_tokens.unwrap_or_else(|| estimate_tokens(&reply.text)) as u64;
                let counted_in = match reply.input_tokens {
                    Some(i) => i.saturating_sub(reply.cached_input_tokens.unwrap_or(0)).max(p.user_tokens) as u64,
                    None => p.user_tokens as u64,
                };
                let counted = counted_in + out;
                let sent_total = reply.input_tokens.map(|i| i as u64).unwrap_or((p.user_tokens + estimate_tokens(&p.request.system)) as u64) + out;
                let parsed = parse_sheet_with(&reply.text, &p.sent, &self.recent_text());
                match parsed.sheet {
                    Some(sheet) => {
                        let shown = sheet.facts.len();
                        let cap = self.trigger.end_ok(counted);
                        self.holder.lock().unwrap().set(sheet, now);
                        self.last_error = None;
                        self.sink.sheet(&self.view());
                        if cap {
                            self.sink.cap_reached();
                        }
                        BriefOutcome {
                            reason: p.reason,
                            ok: true,
                            facts_shown: shown,
                            facts_dropped: parsed.dropped.len(),
                            counted_tokens: counted,
                            sent_tokens: sent_total,
                            error: None,
                            cap_reached: cap,
                        }
                    }
                    None => {
                        self.trigger.end_err(LlmErrorKind::Failed, counted);
                        let msg = "The model's answer could not be used as a brief".to_string();
                        self.last_error = Some(msg.clone());
                        BriefOutcome {
                            reason: p.reason,
                            ok: false,
                            facts_shown: 0,
                            facts_dropped: parsed.dropped.len(),
                            counted_tokens: counted,
                            sent_tokens: sent_total,
                            error: Some(msg),
                            cap_reached: false,
                        }
                    }
                }
            }
            Err(e) => {
                self.trigger.end_err(e.kind, 0);
                if e.kind != LlmErrorKind::Cancelled {
                    self.last_error = Some(e.message.clone());
                }
                BriefOutcome {
                    reason: p.reason,
                    ok: false,
                    facts_shown: 0,
                    facts_dropped: 0,
                    counted_tokens: 0,
                    sent_tokens: 0,
                    error: Some(e.message),
                    cap_reached: false,
                }
            }
        };
        self.save();
        self.emit_status();
        outcome
    }

    fn save(&self) {
        let snap = BriefSnapshot {
            sheet: self.view().sheet,
            status: match self.trigger.guard.state {
                RunState::Running => "running",
                RunState::Paused(_) => "paused",
                RunState::CapReached => "cap_reached",
                RunState::Stopped => "stopped",
            }
            .to_string(),
            tokens_used: self.trigger.guard.used,
            cap: self.trigger.guard.cap,
        };
        if let Err(e) = self.store.save(&snap) {
            log::warn!("live brief: save failed: {e}");
        }
    }

    fn emit_status(&self) {
        self.sink.status(&self.status());
    }

    /// The synchronous half of a tick: topic check, search when due, the
    /// trigger's decision, and the prepared call when there is one. The caller
    /// makes the call (so it can keep feeding lines meanwhile) and `complete`s it.
    pub fn step(&mut self) -> (BriefTick, Option<PreparedBrief>) {
        let mut out = BriefTick::default();
        if self.detector.poll(self.last_line_ms) {
            out.topic_changed = true;
            self.holder.lock().unwrap().hide_on_topic_change();
            self.trigger.on_topic_change();
            self.sink.sheet(&self.view());
        }
        let now = self.clock.now_ms();
        let BriefAction::Search(_) = self.trigger.poll(now) else { return (out, None) };
        out.searched = true;
        self.searches += 1;
        let found = self.search.search(&self.query(), self.cfg.passages_budget, self.cfg.max_search_results);
        let top_ids: Vec<String> = found.iter().map(|p| p.id.clone()).collect();
        let ModelDecision::Call(reason) = self.trigger.after_search(now, &top_ids) else { return (out, None) };
        let prepared = self.prepare(reason, &found);
        (out, prepared)
    }

    /// One step of the loop, call included. Cheap when nothing is due.
    pub async fn tick(&mut self) -> BriefTick {
        let (mut out, prepared) = self.step();
        if let Some(prepared) = prepared {
            let result = self.llm.call(&prepared.request).await;
            out.call = Some(self.complete(prepared, result));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::live_common::FakeClock;
    use async_trait::async_trait;
    use std::sync::Mutex;

    struct Mock {
        replies: Mutex<VecDeque<Result<LlmReply, LlmError>>>,
        requests: Mutex<Vec<LlmRequest>>,
    }
    impl Mock {
        fn new(v: Vec<Result<LlmReply, LlmError>>) -> Self {
            Self { replies: Mutex::new(v.into()), requests: Mutex::new(vec![]) }
        }
    }
    #[async_trait]
    impl LlmCall for Mock {
        async fn call(&self, req: &LlmRequest) -> Result<LlmReply, LlmError> {
            self.requests.lock().unwrap().push(req.clone());
            self.replies.lock().unwrap().pop_front().unwrap_or(Ok(LlmReply { text: r#"{"now":"x","facts":[]}"#.into(), ..Default::default() }))
        }
    }

    fn reply(s: &str) -> Result<LlmReply, LlmError> {
        Ok(LlmReply { text: s.into(), ..Default::default() })
    }

    fn pass(id: &str, text: &str) -> Passage {
        Passage { id: id.into(), title: format!("Doc {id}"), text: text.into(), start_ms: None }
    }

    const GOOD: &str = r#"{"now":"Acme pricing","facts":[{"text":"Acme pays $1,200 per seat","source":"P1"},{"text":"Globex pays $900","source":"P1"}],"earlier":["Intro"]}"#;

    type Eng = BriefEngine<Mock, FakeClock, Box<dyn Fn(&str, u32, usize) -> Vec<Passage> + Send + Sync>>;

    #[derive(Default)]
    struct Rec {
        sheets: Mutex<u32>,
        caps: Mutex<u32>,
    }
    impl BriefSink for Rec {
        fn status(&self, _: &BriefStatus) {}
        fn sheet(&self, _: &SheetView) {
            *self.sheets.lock().unwrap() += 1;
        }
        fn cap_reached(&self) {
            *self.caps.lock().unwrap() += 1;
        }
    }

    fn engine(replies: Vec<Result<LlmReply, LlmError>>, results: Vec<Passage>) -> (Eng, FakeClock, Arc<Rec>) {
        let clock = FakeClock::new(1_000_000);
        let rec = Arc::new(Rec::default());
        let search: Box<dyn Fn(&str, u32, usize) -> Vec<Passage> + Send + Sync> = Box::new(move |_q, _t, _m| results.clone());
        let e = BriefEngine::new(Mock::new(replies), clock.clone(), search, "ws:a", BriefConfig::default(), rec.clone(), Arc::new(NullBriefStore));
        (e, clock, rec)
    }

    fn speak(e: &mut Eng, from_ms: u64, secs: u64) {
        let mut t = from_ms;
        while t < from_ms + secs * 1000 {
            e.feed(BriefLine { start_ms: t, end_ms: Some(t + 5_000), text: "we talk about the renewal pricing for the annual plan".into() });
            t += 5_000;
        }
    }

    #[tokio::test]
    async fn search_after_30s_then_call_and_sheet_for_answers() {
        let (mut e, _c, rec) = engine(vec![reply(GOOD)], vec![pass("a", "Acme renewed at $1,200 per seat, Globex was 800.")]);
        speak(&mut e, 0, 25);
        assert!(!e.tick().await.searched);
        speak(&mut e, 25_000, 10);
        let t = e.tick().await;
        assert!(t.searched);
        let o = t.call.unwrap();
        assert!(o.ok && o.facts_shown == 1 && o.facts_dropped == 2, "{o:?}");
        assert_eq!(e.searches, 1);
        let text = e.sheet_for_answer("ws:a").unwrap();
        assert!(text.contains("Acme pays $1,200") && !text.contains("Globex"));
        assert!(e.sheet_for_answer("ws:other").is_none());
        assert!(*rec.sheets.lock().unwrap() >= 1);
        let reqs = e.llm.requests.lock().unwrap();
        assert_eq!(reqs[0].purpose, "brief");
        assert!(reqs[0].user.contains("[P1] Doc a"));
        assert!(reqs[0].user.contains("DATA conversation"));
    }

    #[tokio::test]
    async fn same_passages_do_not_call_again() {
        let (mut e, c, _r) = engine(vec![reply(GOOD)], vec![pass("a", "Acme renewed at $1,200 per seat")]);
        speak(&mut e, 0, 35);
        assert!(e.tick().await.call.is_some());
        c.advance(60_000);
        speak(&mut e, 35_000, 35);
        let t = e.tick().await;
        assert!(t.searched && t.call.is_none(), "search is cheap, the call is not made");
        assert_eq!(e.llm.requests.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn manual_refresh_calls_even_when_nothing_changed() {
        let (mut e, c, _r) = engine(vec![reply(GOOD), reply(GOOD)], vec![pass("a", "Acme renewed at $1,200 per seat")]);
        speak(&mut e, 0, 35);
        assert!(e.tick().await.call.is_some());
        c.advance(1_000);
        e.request_refresh();
        let t = e.tick().await;
        assert!(matches!(t.call, Some(BriefOutcome { reason: CallReason::Manual, .. })));
    }

    #[tokio::test]
    async fn topic_change_hides_sheet_then_new_one_after_gap() {
        let (mut e, c, _r) = engine(vec![reply(GOOD), reply(r#"{"now":"Acme travel","facts":[]}"#)], vec![pass("a", "Acme renewed at $1,200 per seat")]);
        // 4 minutes of one topic, then another
        use crate::live_eval::scripted::{conversation, Lang};
        let utt = conversation(Lang::En, 3, &[(0, 240), (3, 240)], 5, 12);
        let mut hidden_at = None;
        let mut second_call_at = None;
        let mut calls = 0;
        for u in &utt {
            c.set(1_000_000 + u.ms);
            e.feed(BriefLine { start_ms: u.ms, end_ms: Some(u.ms + 5_000), text: u.text.clone() });
            let t = e.tick().await;
            if t.topic_changed && hidden_at.is_none() {
                hidden_at = Some(u.ms);
                if t.call.is_none() {
                    assert!(e.sheet_for_answer("ws:a").is_none(), "hidden at once");
                }
            }
            if t.call.is_some() {
                calls += 1;
                if calls == 2 {
                    second_call_at = Some(u.ms);
                }
            }
        }
        let h = hidden_at.expect("topic change seen");
        assert!(h >= 240_000 && h <= 330_000, "{h}");
        // the search results never changed, so only the topic change can trigger the second call
        let s = second_call_at.expect("call after topic change");
        assert!(s >= h && s - h <= 60_000, "{s} {h}");
        assert!(e.sheet_for_answer("ws:a").unwrap().contains("Acme travel"));
    }

    #[tokio::test]
    async fn scope_change_clears_everything() {
        let (mut e, _c, _r) = engine(vec![reply(GOOD)], vec![pass("a", "Acme renewed at $1,200 per seat")]);
        speak(&mut e, 0, 35);
        e.tick().await;
        assert!(e.sheet_for_answer("ws:a").is_some());
        e.set_scope("ws:b", "");
        assert!(e.sheet_for_answer("ws:a").is_none() && e.sheet_for_answer("ws:b").is_none());
        assert!(e.view().sheet.is_none());
        assert!(e.query().is_empty(), "transcript history cleared too");
    }

    #[tokio::test]
    async fn stale_sheet_is_not_given_to_answers() {
        let (mut e, c, _r) = engine(vec![reply(GOOD)], vec![pass("a", "Acme renewed at $1,200 per seat")]);
        speak(&mut e, 0, 35);
        e.tick().await;
        c.advance(239_000);
        assert!(e.sheet_for_answer("ws:a").is_some());
        c.advance(2_000);
        assert!(e.sheet_for_answer("ws:a").is_none());
    }

    #[tokio::test]
    async fn bad_output_and_errors_pause_after_three() {
        let (mut e, c, _r) = engine(vec![reply("nope"), Err(LlmError::failed("boom")), reply("still nope")], vec![pass("a", "Acme renewed at $1,200 per seat")]);
        for i in 0..3 {
            speak(&mut e, i * 40_000, 35);
            c.advance(50_000);
            let t = e.tick().await;
            assert!(!t.call.unwrap().ok);
        }
        assert!(matches!(e.state(), RunState::Paused(crate::live_common::PauseReason::Failures)));
        assert!(e.status().last_error.is_some());
        assert!(e.view().sheet.is_none());
    }

    #[tokio::test]
    async fn plan_limit_pauses() {
        let (mut e, _c, _r) = engine(vec![Err(LlmError::plan_limit("limit"))], vec![pass("a", "Acme renewed")]);
        speak(&mut e, 0, 35);
        e.tick().await;
        assert!(matches!(e.state(), RunState::Paused(crate::live_common::PauseReason::PlanLimit)));
    }

    #[tokio::test]
    async fn live_answer_gate_blocks_search_and_call() {
        let (mut e, _c, _r) = engine(vec![reply(GOOD)], vec![pass("a", "Acme renewed at $1,200 per seat")]);
        speak(&mut e, 0, 35);
        e.set_gate(false);
        assert!(!e.tick().await.searched);
        e.set_gate(true);
        assert!(e.tick().await.call.is_some());
    }

    #[tokio::test]
    async fn cap_reached_event() {
        let clock = FakeClock::new(0);
        let rec = Arc::new(Rec::default());
        let mut cfg = BriefConfig::default();
        cfg.trigger.cap_tokens = 10;
        let search: Box<dyn Fn(&str, u32, usize) -> Vec<Passage> + Send + Sync> = Box::new(|_, _, _| vec![pass("a", "Acme renewed at $1,200 per seat")]);
        let mut e = BriefEngine::new(Mock::new(vec![reply(GOOD)]), clock, search, "s", cfg, rec.clone(), Arc::new(NullBriefStore));
        speak(&mut e, 0, 35);
        assert!(e.tick().await.call.unwrap().cap_reached);
        assert_eq!(*rec.caps.lock().unwrap(), 1);
        assert_eq!(e.state(), RunState::CapReached);
    }

    #[tokio::test]
    async fn no_results_no_call_and_query_uses_recent_words() {
        let (mut e, _c, _r) = engine(vec![], vec![]);
        speak(&mut e, 0, 35);
        let t = e.tick().await;
        assert!(t.searched && t.call.is_none());
        let q = e.query();
        assert!(q.contains("renewal") && q.contains("pricing") && !q.contains("the"));
    }

    #[tokio::test]
    async fn sessions_see_a_changed_sheet_once() {
        let (mut e, _c, _r) = engine(vec![reply(GOOD)], vec![pass("a", "Acme renewed at $1,200 per seat")]);
        speak(&mut e, 0, 35);
        e.tick().await;
        let (_, rev) = e.sheet_for_session("ws:a", None).unwrap();
        assert!(e.sheet_for_session("ws:a", Some(rev)).is_none());
    }

    #[tokio::test]
    async fn scope_switch_discards_an_in_flight_reply_and_everything_old() {
        let (mut e, _c, _r) = engine(vec![], vec![pass("old1", "OLDSCOPE_PASSAGE Acme renewed at $1,200 per seat")]);
        e.set_memory("OLDSCOPE_MEMORY Ana is the CFO");
        speak(&mut e, 0, 35);
        // a call is prepared under the old scope...
        let found = vec![pass("old1", "OLDSCOPE_PASSAGE Acme renewed at $1,200 per seat")];
        let prepared = e.prepare(CallReason::Manual, &found).unwrap();
        assert!(prepared.request.user.contains("OLDSCOPE_MEMORY"));
        // ...the scope changes while it runs...
        e.set_scope("ws:b", "NEWSCOPE_MEMORY");
        // ...and the old reply arrives afterwards
        let out = e.complete(prepared, reply(GOOD));
        assert!(!out.ok);
        assert!(e.view().sheet.is_none());
        assert!(e.sheet_for_answer("ws:a").is_none() && e.sheet_for_answer("ws:b").is_none());
        assert_eq!(e.state(), RunState::Running, "a discarded run is not a failure");
        assert_eq!(e.status().failures, 0);
        // the next request carries nothing of the old scope
        speak(&mut e, 100_000, 35);
        let found2 = vec![pass("new1", "NEWSCOPE_PASSAGE a different thing")];
        let p2 = e.prepare(CallReason::Manual, &found2).unwrap();
        let all = format!("{}{}", p2.request.system, p2.request.user);
        assert!(!all.contains("OLDSCOPE") && all.contains("NEWSCOPE_MEMORY") && all.contains("NEWSCOPE_PASSAGE"));
        assert!(!p2.request.user.contains("renewal pricing for the annual plan") || e.query().contains("renewal"), "only new lines");
    }
}
