//! Shared pure helpers for live notes, the live brief and workspace memory:
//! clock, LLM trait, token estimates, content terms and similarity, a tolerant
//! JSON reader, and the run guard (cap, failures, pause) both engines use.
//!
//! Nothing here touches the network, the database or the wall clock.

#![allow(dead_code)]

use async_trait::async_trait;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

// ---------------------------------------------------------------- clock

pub trait Clock: Send + Sync {
    fn now_ms(&self) -> u64;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        chrono::Utc::now().timestamp_millis().max(0) as u64
    }
}

/// Settable clock for tests and simulations. Clones share the same time.
#[derive(Clone, Default)]
pub struct FakeClock(Arc<AtomicU64>);

impl FakeClock {
    pub fn new(ms: u64) -> Self {
        Self(Arc::new(AtomicU64::new(ms)))
    }
    pub fn set(&self, ms: u64) {
        self.0.store(ms, Ordering::SeqCst);
    }
    pub fn advance(&self, ms: u64) {
        self.0.fetch_add(ms, Ordering::SeqCst);
    }
}

impl Clock for FakeClock {
    fn now_ms(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}

// ---------------------------------------------------------------- LLM

#[derive(Debug, Clone)]
pub struct LlmRequest {
    pub system: String,
    pub user: String,
    pub max_output_tokens: u32,
    /// "notes" | "brief" | "memory" (for usage records and logs).
    pub purpose: &'static str,
}

#[derive(Debug, Clone, Default)]
pub struct LlmReply {
    pub text: String,
    pub input_tokens: Option<u32>,
    pub output_tokens: Option<u32>,
    pub cached_input_tokens: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LlmErrorKind {
    /// Subscription or plan limit: pause with the reason, do not retry.
    PlanLimit,
    Failed,
    /// Cancelled by the caller (a live answer took priority). Not a failure.
    Cancelled,
}

#[derive(Debug, Clone)]
pub struct LlmError {
    pub kind: LlmErrorKind,
    pub message: String,
}

impl LlmError {
    pub fn failed(msg: impl Into<String>) -> Self {
        Self { kind: LlmErrorKind::Failed, message: msg.into() }
    }
    pub fn plan_limit(msg: impl Into<String>) -> Self {
        Self { kind: LlmErrorKind::PlanLimit, message: msg.into() }
    }
    pub fn cancelled() -> Self {
        Self { kind: LlmErrorKind::Cancelled, message: "cancelled".into() }
    }
}

/// One model call. The real implementation is the shared `ai_runs` service.
#[async_trait]
pub trait LlmCall: Send + Sync {
    async fn call(&self, req: &LlmRequest) -> Result<LlmReply, LlmError>;
}

// ---------------------------------------------------------------- text sizes

/// Han, Hiragana, Katakana (scripts written without spaces).
pub fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3040..=0x30FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0xFF66..=0xFF9F)
}

fn is_hiragana(c: char) -> bool {
    matches!(c as u32, 0x3040..=0x309F)
}

fn is_han(c: char) -> bool {
    matches!(c as u32, 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF)
}

/// Rough token count: CJK characters at 1.5 chars per token, everything else
/// at 4 chars per token.
pub fn estimate_tokens(s: &str) -> u32 {
    let mut cjk = 0u32;
    let mut other = 0u32;
    for c in s.chars() {
        if is_cjk(c) {
            cjk += 1;
        } else {
            other += 1;
        }
    }
    ((cjk as f32 / 1.5) + (other as f32 / 4.0)).ceil() as u32
}

/// Speech volume in half-words: whitespace-separated words count 2, each CJK
/// character counts 1 (so two CJK characters are one "word").
pub fn speech_units_x2(s: &str) -> u32 {
    let mut units = 0u32;
    let mut in_word = false;
    for c in s.chars() {
        if is_cjk(c) {
            units += 1;
            in_word = false;
        } else if c.is_alphanumeric() {
            if !in_word {
                units += 2;
                in_word = true;
            }
        } else {
            in_word = false;
        }
    }
    units
}

/// mm:ss (or h:mm:ss from one hour on).
pub fn fmt_clock(ms: u64) -> String {
    let s = ms / 1000;
    if s >= 3600 {
        format!("{}:{:02}:{:02}", s / 3600, (s / 60) % 60, s % 60)
    } else {
        format!("{:02}:{:02}", s / 60, s % 60)
    }
}

/// Parses `mm:ss`, `h:mm:ss`, `[mm:ss]` or a plain number (seconds; from
/// 100000 up it is read as milliseconds).
pub fn parse_clock(s: &str) -> Option<u64> {
    let t = s.trim().trim_matches(|c| c == '[' || c == ']' || c == '(' || c == ')').trim();
    if t.is_empty() {
        return None;
    }
    if t.contains(':') {
        let parts: Vec<&str> = t.split(':').collect();
        if parts.len() > 3 || parts.iter().any(|p| p.is_empty() || !p.chars().all(|c| c.is_ascii_digit())) {
            return None;
        }
        let nums: Vec<u64> = parts.iter().filter_map(|p| p.parse().ok()).collect();
        if nums.len() != parts.len() {
            return None;
        }
        let secs = match nums.len() {
            2 => nums[0] * 60 + nums[1],
            3 => nums[0] * 3600 + nums[1] * 60 + nums[2],
            _ => return None,
        };
        return Some(secs * 1000);
    }
    let f: f64 = t.parse().ok()?;
    if !f.is_finite() || f < 0.0 {
        return None;
    }
    Some(if f >= 100_000.0 { f as u64 } else { (f * 1000.0) as u64 })
}

pub fn parse_clock_value(v: &Value) -> Option<u64> {
    match v {
        Value::Number(n) => {
            let f = n.as_f64()?;
            if !f.is_finite() || f < 0.0 {
                return None;
            }
            Some(if f >= 100_000.0 { f as u64 } else { (f * 1000.0) as u64 })
        }
        Value::String(s) => parse_clock(s),
        _ => None,
    }
}

// ---------------------------------------------------------------- terms

const STOPWORDS: &[&str] = &[
    // English
    "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "had", "her", "was", "one",
    "our", "out", "has", "have", "his", "how", "its", "may", "new", "now", "see", "two", "who", "did",
    "yes", "that", "this", "with", "from", "they", "will", "would", "there", "their", "what", "about",
    "which", "when", "your", "been", "were", "them", "then", "than", "some", "just", "like", "also",
    "into", "over", "more", "very", "much", "here", "okay", "yeah", "well", "going", "think", "know",
    "want", "need", "should", "could", "really", "because", "thing", "things", "actually", "maybe",
    "right", "let", "get", "got", "gonna", "don", "doesn", "didn", "isn", "was", "too", "say", "said",
    // Spanish
    "que", "los", "las", "una", "uno", "por", "con", "para", "del", "como", "pero", "mas", "más",
    "esto", "esta", "este", "eso", "esa", "ese", "muy", "son", "sus", "hay", "fue", "ser", "sobre",
    "entre", "cuando", "donde", "tiene", "tengo", "bueno", "entonces", "porque", "también", "vamos",
    "creo", "puede", "pues", "ahora", "todo", "nos", "algo", "sin", "mis", "tus",
    // French / German / Portuguese / Italian (a few of the most common)
    "les", "des", "une", "pour", "dans", "avec", "pas", "sur", "mais", "est", "sont", "nous", "vous",
    "der", "die", "das", "und", "ist", "nicht", "ein", "eine", "mit", "auf", "für", "den", "dem",
    "não", "uma", "com", "para", "mais", "são", "che", "per", "non", "una", "sono", "come",
];

fn stopwords() -> &'static HashSet<&'static str> {
    use std::sync::OnceLock;
    static SET: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SET.get_or_init(|| STOPWORDS.iter().copied().collect())
}

/// True for very common words (English, Spanish, French, German, Portuguese, Italian).
pub fn is_stopword(lower: &str) -> bool {
    stopwords().contains(lower)
}

const CJK_PARTICLES: &[char] = &['的', '了', '吗', '吧', '呢', '啊', '和', '也', '都', '就', '是', '在'];

/// Content words of a text, language-agnostic:
/// * space-separated scripts: lowercase alphanumeric words of 3+ chars that are
///   not stop words;
/// * CJK: character bigrams over each run, dropping bigrams that contain
///   hiragana (particles, endings) or touch a common Chinese particle.
pub fn content_terms(s: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut word = String::new();
    let mut run: Vec<char> = Vec::new();
    let flush_word = |word: &mut String, out: &mut Vec<String>| {
        if word.chars().count() >= 3 {
            let w = word.to_lowercase();
            if !stopwords().contains(w.as_str()) {
                out.push(w);
            }
        }
        word.clear();
    };
    let flush_run = |run: &mut Vec<char>, out: &mut Vec<String>| {
        if run.len() >= 2 {
            for pair in run.windows(2) {
                if pair.iter().any(|c| is_hiragana(*c)) {
                    continue;
                }
                if CJK_PARTICLES.contains(&pair[0]) || CJK_PARTICLES.contains(&pair[1]) {
                    continue;
                }
                out.push(pair.iter().collect());
            }
        }
        run.clear();
    };
    for c in s.chars() {
        if is_cjk(c) {
            flush_word(&mut word, &mut out);
            run.push(c);
        } else if c.is_alphanumeric() {
            flush_run(&mut run, &mut out);
            word.push(c);
        } else {
            flush_word(&mut word, &mut out);
            flush_run(&mut run, &mut out);
        }
    }
    flush_word(&mut word, &mut out);
    flush_run(&mut run, &mut out);
    out
}

pub fn term_set(s: &str) -> HashSet<String> {
    content_terms(s).into_iter().collect()
}

/// Lowercase, punctuation to spaces, whitespace collapsed.
pub fn normalize(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_space = true;
    for c in s.chars() {
        if c.is_alphanumeric() {
            out.extend(c.to_lowercase());
            last_space = false;
        } else if !last_space {
            out.push(' ');
            last_space = true;
        }
    }
    out.trim().to_string()
}

/// 0..=1. Jaccard over content terms; very short texts without terms fall back
/// to normalized equality; containment of a longer text counts as similar.
pub fn similarity(a: &str, b: &str) -> f32 {
    let na = normalize(a);
    let nb = normalize(b);
    if na.is_empty() || nb.is_empty() {
        return 0.0;
    }
    if na == nb {
        return 1.0;
    }
    let ta = term_set(a);
    let tb = term_set(b);
    if ta.is_empty() || tb.is_empty() {
        return 0.0;
    }
    let inter = ta.intersection(&tb).count() as f32;
    let union = (ta.len() + tb.len()) as f32 - inter;
    let jaccard = inter / union;
    // One text nearly inside the other ("Ship Friday" vs "Ship the beta on Friday").
    let smaller = ta.len().min(tb.len()) as f32;
    let contain = inter / smaller;
    if smaller >= 3.0 && contain >= 0.95 {
        return jaccard.max(0.85);
    }
    jaccard
}

// ---------------------------------------------------------------- tolerant JSON

/// Finds the end of the JSON-ish value starting at `start` (`{` or `[`).
/// String aware for both quote styles. Returns (end exclusive, complete).
fn balanced_end(chars: &[char], start: usize) -> (usize, bool) {
    let mut depth = 0i32;
    let mut quote: Option<char> = None;
    let mut i = start;
    while i < chars.len() {
        let c = chars[i];
        if let Some(q) = quote {
            if c == '\\' {
                i += 2;
                continue;
            }
            if c == q {
                quote = None;
            }
        } else {
            match c {
                '"' | '\'' => quote = Some(c),
                '{' | '[' => depth += 1,
                '}' | ']' => {
                    depth -= 1;
                    if depth == 0 {
                        return (i + 1, true);
                    }
                }
                _ => {}
            }
        }
        i += 1;
    }
    (chars.len(), false)
}

/// Rewrites JSON-ish text into strict JSON: single quotes, unquoted keys,
/// Python literals, trailing commas, comments are not supported. Truncated
/// input is closed; when that does not parse, cut back to the last complete
/// element and close from there. Returns None when nothing parses.
pub fn repair_json(src: &str) -> Option<Value> {
    #[derive(Clone)]
    struct Snap {
        len: usize,
        stack: Vec<char>,
    }
    let chars: Vec<char> = src.chars().collect();
    let mut out = String::with_capacity(src.len() + 8);
    let mut stack: Vec<char> = Vec::new();
    let mut snaps: Vec<Snap> = Vec::new();
    let mut i = 0;
    let mut complete = false;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '"' | '\'' => {
                let q = c;
                out.push('"');
                i += 1;
                let mut closed = false;
                while i < chars.len() {
                    let d = chars[i];
                    if d == '\\' && i + 1 < chars.len() {
                        let n = chars[i + 1];
                        if n == '\'' {
                            out.push('\'');
                        } else {
                            out.push('\\');
                            out.push(n);
                        }
                        i += 2;
                        continue;
                    }
                    if d == q {
                        closed = true;
                        i += 1;
                        break;
                    }
                    match d {
                        '"' => out.push_str("\\\""),
                        '\n' => out.push_str("\\n"),
                        '\r' => {}
                        '\t' => out.push_str("\\t"),
                        c if (c as u32) < 0x20 => {}
                        _ => out.push(d),
                    }
                    i += 1;
                }
                out.push('"');
                if !closed {
                    // truncated inside a string; handled by the tail logic
                    i = chars.len();
                }
                continue;
            }
            '{' | '[' => {
                stack.push(if c == '{' { '}' } else { ']' });
                out.push(c);
            }
            '}' | ']' => {
                // trailing comma
                let trimmed = out.trim_end().len();
                if out[..trimmed].ends_with(',') {
                    out.truncate(trimmed - 1);
                }
                if stack.last() == Some(&c) {
                    stack.pop();
                    out.push(c);
                    snaps.push(Snap { len: out.len(), stack: stack.clone() });
                    if stack.is_empty() {
                        complete = true;
                        break;
                    }
                } else {
                    // mismatched closer: ignore
                }
            }
            ',' => {
                snaps.push(Snap { len: out.len(), stack: stack.clone() });
                out.push(',');
            }
            c if c.is_alphabetic() || c == '_' => {
                let mut j = i;
                let mut ident = String::new();
                while j < chars.len() && (chars[j].is_alphanumeric() || chars[j] == '_' || chars[j] == '-') {
                    ident.push(chars[j]);
                    j += 1;
                }
                let mut k = j;
                while k < chars.len() && chars[k].is_whitespace() {
                    k += 1;
                }
                if k < chars.len() && chars[k] == ':' {
                    out.push('"');
                    out.push_str(&ident);
                    out.push('"');
                } else {
                    match ident.as_str() {
                        "true" | "false" | "null" => out.push_str(&ident),
                        "True" => out.push_str("true"),
                        "False" => out.push_str("false"),
                        "None" | "undefined" | "NaN" => out.push_str("null"),
                        _ => out.push_str(&format!("\"{}\"", ident)),
                    }
                }
                i = j;
                continue;
            }
            _ => out.push(c),
        }
        i += 1;
    }

    let close = |mut text: String, stack: &[char]| -> String {
        let t = text.trim_end().len();
        text.truncate(t);
        while text.ends_with(',') {
            text.pop();
            let t = text.trim_end().len();
            text.truncate(t);
        }
        if text.ends_with(':') {
            text.push_str("null");
        }
        for c in stack.iter().rev() {
            text.push(*c);
        }
        text
    };

    if complete {
        return serde_json::from_str(&out).ok();
    }
    if let Ok(v) = serde_json::from_str::<Value>(&close(out.clone(), &stack)) {
        return Some(v);
    }
    for snap in snaps.iter().rev() {
        let mut text = out[..snap.len].to_string();
        text = close(text, &snap.stack);
        if let Ok(v) = serde_json::from_str::<Value>(&text) {
            return Some(v);
        }
    }
    None
}

/// Finds the first JSON object/array in `text` (fenced, surrounded by prose,
/// single quoted, trailing commas, truncated) that `accept` approves.
pub fn parse_loose_where(text: &str, accept: impl Fn(&Value) -> bool) -> Option<Value> {
    if let Ok(v) = serde_json::from_str::<Value>(text.trim()) {
        if accept(&v) {
            return Some(v);
        }
    }
    let chars: Vec<char> = text.chars().collect();
    let mut tries = 0;
    let mut i = 0;
    while i < chars.len() && tries < 24 {
        if chars[i] == '{' || chars[i] == '[' {
            tries += 1;
            let (end, _complete) = balanced_end(&chars, i);
            let span: String = chars[i..end].iter().collect();
            let parsed = serde_json::from_str::<Value>(&span).ok().or_else(|| repair_json(&span));
            if let Some(v) = parsed {
                if accept(&v) {
                    return Some(v);
                }
            }
        }
        i += 1;
    }
    None
}

/// Every complete `{...}` object found in `text`, in order, repairing each one.
/// Objects nested in an accepted object are not returned separately. Used when
/// the whole output does not parse.
pub fn salvage_objects(text: &str) -> Vec<Value> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '{' {
            let (end, complete) = balanced_end(&chars, i);
            let span: String = chars[i..end].iter().collect();
            let v = serde_json::from_str::<Value>(&span).ok().or_else(|| repair_json(&span));
            match v {
                Some(v @ Value::Object(_)) if complete => {
                    out.push(v);
                    i = end;
                    continue;
                }
                _ => {}
            }
        }
        i += 1;
    }
    out
}

pub fn str_field<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a str> {
    for k in keys {
        if let Some(Value::String(s)) = v.get(*k) {
            return Some(s.as_str());
        }
    }
    None
}

// ---------------------------------------------------------------- run guard

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PauseReason {
    User,
    PlanLimit,
    Failures,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "state", content = "reason", rename_all = "snake_case")]
pub enum RunState {
    Running,
    Paused(PauseReason),
    /// Token cap reached: waits for "Keep going" or "Stop".
    CapReached,
    Stopped,
}

/// Cap, failure streak, pause and the one-at-a-time rule shared by the notes
/// and brief triggers.
#[derive(Debug, Clone)]
pub struct RunGuard {
    pub state: RunState,
    pub in_flight: bool,
    pub failures: u32,
    pub max_failures: u32,
    pub used: u64,
    pub cap: u64,
    base_cap: u64,
    /// Closed while a live answer is generating.
    pub gate_open: bool,
}

impl RunGuard {
    pub fn new(cap: u64, max_failures: u32) -> Self {
        Self {
            state: RunState::Running,
            in_flight: false,
            failures: 0,
            max_failures,
            used: 0,
            cap,
            base_cap: cap,
            gate_open: true,
        }
    }

    /// True when a scheduled (automatic) run may start now.
    pub fn can_start(&self) -> bool {
        self.state == RunState::Running && !self.in_flight && self.gate_open
    }

    /// Manual "Update now" works while paused, but never over the cap, after
    /// stop, during a run or while a live answer is generating.
    pub fn can_start_manual(&self) -> bool {
        !self.in_flight
            && self.gate_open
            && matches!(self.state, RunState::Running | RunState::Paused(_))
    }

    /// The final pass ignores the gate and the pause, but not stop or the cap.
    pub fn can_start_final(&self) -> bool {
        !self.in_flight && matches!(self.state, RunState::Running | RunState::Paused(PauseReason::User))
    }

    pub fn begin(&mut self) {
        self.in_flight = true;
    }

    /// Returns true when this run pushed usage over the cap.
    pub fn end_ok(&mut self, counted_tokens: u64) -> bool {
        self.in_flight = false;
        self.failures = 0;
        self.used += counted_tokens;
        if self.state == RunState::Running && self.used >= self.cap {
            self.state = RunState::CapReached;
            return true;
        }
        false
    }

    /// Output that could not be used or a transport error. Tokens still count.
    pub fn end_failed(&mut self, counted_tokens: u64) {
        self.in_flight = false;
        self.used += counted_tokens;
        self.failures += 1;
        if self.failures >= self.max_failures && self.state == RunState::Running {
            self.state = RunState::Paused(PauseReason::Failures);
        }
    }

    pub fn end_plan_limit(&mut self) {
        self.in_flight = false;
        if self.state == RunState::Running {
            self.state = RunState::Paused(PauseReason::PlanLimit);
        }
    }

    pub fn end_cancelled(&mut self) {
        self.in_flight = false;
    }

    pub fn pause(&mut self) {
        if self.state == RunState::Running {
            self.state = RunState::Paused(PauseReason::User);
        }
    }

    pub fn resume(&mut self) {
        if let RunState::Paused(r) = self.state {
            if r == PauseReason::Failures {
                self.failures = 0;
            }
            self.state = RunState::Running;
        }
    }

    /// "Keep going": adds the same amount as the original cap.
    pub fn keep_going(&mut self) {
        if self.state == RunState::CapReached {
            self.cap += self.base_cap;
            self.state = RunState::Running;
        }
    }

    pub fn stop(&mut self) {
        self.state = RunState::Stopped;
    }

    pub fn set_gate(&mut self, open: bool) {
        self.gate_open = open;
    }
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_and_units() {
        assert_eq!(estimate_tokens("abcd"), 1);
        assert_eq!(estimate_tokens("あいう"), 2);
        assert_eq!(speech_units_x2("hello big world"), 6);
        assert_eq!(speech_units_x2("来月の予算"), 5);
        assert_eq!(speech_units_x2("   "), 0);
    }

    #[test]
    fn clock_formats() {
        assert_eq!(fmt_clock(65_000), "01:05");
        assert_eq!(fmt_clock(3_725_000), "1:02:05");
        assert_eq!(parse_clock("12:30"), Some(750_000));
        assert_eq!(parse_clock("[01:02:03]"), Some(3_723_000));
        assert_eq!(parse_clock("90"), Some(90_000));
        assert_eq!(parse_clock("120000"), Some(120_000));
        assert_eq!(parse_clock("1:xx"), None);
        assert_eq!(parse_clock(""), None);
    }

    #[test]
    fn terms_cover_scripts() {
        let t = content_terms("The budget for Madrid was approved");
        assert!(t.contains(&"budget".to_string()) && t.contains(&"madrid".to_string()));
        assert!(!t.contains(&"the".to_string()));
        let es = content_terms("Necesitamos aprobar el presupuesto de Madrid");
        assert!(es.contains(&"presupuesto".to_string()));
        let ja = content_terms("来月の予算を承認します");
        assert!(ja.contains(&"予算".to_string()), "{ja:?}");
        assert!(!ja.iter().any(|t| t.chars().all(|c| is_hiragana(c))));
        let zh = content_terms("我们的预算已经批准了");
        assert!(zh.contains(&"预算".to_string()), "{zh:?}");
    }

    #[test]
    fn similarity_levels() {
        assert!(similarity("Ship the beta on Friday", "ship the beta friday") > 0.8);
        assert!(similarity("Ship the beta on Friday", "Hire two engineers in Q3") < 0.2);
        assert!(similarity("来月の予算を承認", "来月の予算を承認する") > 0.6);
        assert_eq!(similarity("", "x"), 0.0);
    }

    #[test]
    fn loose_json_cases() {
        let ok = |s: &str| parse_loose_where(s, |v| v.is_object() || v.is_array());
        assert!(ok(r#"{"a":1}"#).is_some());
        assert!(ok("```json\n{\"a\":1,}\n```").is_some());
        assert!(ok("Sure! Here you go: {'a': 'it\\'s', b: [1,2,],} Hope it helps").is_some());
        let v = ok(r#"{"ops":[{"op":"add","text":"x"},{"op":"add","te"#).unwrap();
        assert!(!v["ops"].as_array().unwrap().is_empty());
        let v = ok(r#"{"a":1,"a":2}"#).unwrap();
        assert_eq!(v["a"], 2);
        assert!(ok("no json here").is_none());
        let objs = salvage_objects(r#"junk {"op":"add"} more {"op":"update", "id":"b1"} {"x":"#);
        assert_eq!(objs.len(), 2);
    }

    #[test]
    fn guard_cap_failures_and_gate() {
        let mut g = RunGuard::new(100, 3);
        assert!(g.can_start());
        g.set_gate(false);
        assert!(!g.can_start() && !g.can_start_manual());
        g.set_gate(true);
        g.begin();
        assert!(!g.can_start());
        assert!(g.end_ok(60) == false);
        g.begin();
        assert!(g.end_ok(60));
        assert_eq!(g.state, RunState::CapReached);
        assert!(!g.can_start() && !g.can_start_manual() && !g.can_start_final());
        g.keep_going();
        assert_eq!(g.cap, 200);
        assert_eq!(g.state, RunState::Running);
        for _ in 0..3 {
            g.begin();
            g.end_failed(0);
        }
        assert_eq!(g.state, RunState::Paused(PauseReason::Failures));
        assert!(g.can_start_manual() && !g.can_start());
        g.resume();
        assert_eq!(g.failures, 0);
        g.begin();
        g.end_plan_limit();
        assert_eq!(g.state, RunState::Paused(PauseReason::PlanLimit));
    }
}
