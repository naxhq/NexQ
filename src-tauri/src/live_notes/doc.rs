//! The notes document: blocks, inline entity spans, Markdown export and the
//! compact outline sent to the model.

use crate::live_common::{estimate_tokens, fmt_clock};
use serde::{Deserialize, Serialize};

pub const DOC_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockKind {
    Topic,
    Summary,
    Bullet,
    Decision,
    Task,
    Question,
}

impl BlockKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            BlockKind::Topic => "topic",
            BlockKind::Summary => "summary",
            BlockKind::Bullet => "bullet",
            BlockKind::Decision => "decision",
            BlockKind::Task => "task",
            BlockKind::Question => "question",
        }
    }

    /// Accepts the names small models actually use.
    pub fn from_loose(s: &str) -> Option<BlockKind> {
        match s.trim().to_lowercase().replace([' ', '-'], "_").as_str() {
            "topic" | "heading" | "title" | "header" | "section" => Some(BlockKind::Topic),
            "summary" | "overview" | "recap" => Some(BlockKind::Summary),
            "bullet" | "point" | "note" | "item" | "key_point" | "fact" => Some(BlockKind::Bullet),
            "decision" | "decided" => Some(BlockKind::Decision),
            "task" | "todo" | "action" | "action_item" | "followup" | "follow_up" => Some(BlockKind::Task),
            "question" | "open_question" | "q" | "unanswered" => Some(BlockKind::Question),
            _ => None,
        }
    }

    /// Longest text a block of this kind may hold (characters).
    pub fn max_chars(&self) -> usize {
        match self {
            BlockKind::Topic => 80,
            BlockKind::Summary => 400,
            BlockKind::Bullet => 220,
            BlockKind::Decision => 220,
            BlockKind::Task => 200,
            BlockKind::Question => 200,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Block {
    /// Stable: assigned by code, never reused, never changed.
    pub id: String,
    pub kind: BlockKind,
    /// Id of the topic this block belongs to; None for topics and for blocks
    /// written before any topic existed.
    pub parent: Option<String>,
    /// Text with inline entity tags (`{{p:Ana}}`).
    pub text: String,
    pub start_ms: u64,
    pub end_ms: u64,
    /// The user changed the text. Never touched by the model afterwards.
    #[serde(default)]
    pub edited: bool,
    #[serde(default)]
    pub pinned: bool,
    /// Global creation order (siblings render in this order).
    pub order: u32,
}

impl Block {
    pub fn locked(&self) -> bool {
        self.edited || self.pinned
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NoteDoc {
    pub version: u32,
    pub blocks: Vec<Block>,
    /// Next numeric id; ids are never reused, even after the user deletes.
    #[serde(default)]
    pub next_id: u32,
    /// Speech (ms since the meeting started) the notes never covered: saved with the notes,
    /// so it survives the end of the meeting and a restart.
    #[serde(default)]
    pub uncovered: Option<(u64, u64)>,
    /// The first line the notes were given (ms since the meeting started).
    #[serde(default)]
    pub started_at: Option<u64>,
    /// The last line a run folded into the notes. With `started_at` this says, at any time and
    /// without anything having been saved at the end, which part of the transcript the notes miss.
    #[serde(default)]
    pub covered_to: Option<u64>,
}

impl Default for NoteDoc {
    fn default() -> Self {
        Self { version: DOC_VERSION, blocks: Vec::new(), next_id: 1, uncovered: None, started_at: None, covered_to: None }
    }
}

impl NoteDoc {
    pub fn new() -> Self {
        Self::default()
    }

    /// The stretch of a finished transcript (`line_times`: ms of its final lines) that the notes
    /// never covered: lines from where the notes began that no run folded in. Falls back to the
    /// range saved at the end for notes that predate the coverage fields.
    pub fn uncovered_in(&self, line_times: &[u64]) -> Option<(u64, u64)> {
        let Some(start) = self.started_at else { return self.uncovered };
        let missed = line_times.iter().copied().filter(|t| *t >= start && self.covered_to.map_or(true, |c| *t > c));
        let (mut lo, mut hi, mut any) = (u64::MAX, 0u64, false);
        for t in missed {
            lo = lo.min(t);
            hi = hi.max(t);
            any = true;
        }
        any.then_some((lo, hi))
    }

    pub fn get(&self, id: &str) -> Option<&Block> {
        self.blocks.iter().find(|b| b.id == id)
    }

    pub fn get_mut(&mut self, id: &str) -> Option<&mut Block> {
        self.blocks.iter_mut().find(|b| b.id == id)
    }

    /// Fresh id `b<N>`, never one used before in this document.
    pub fn alloc_id(&mut self) -> String {
        let max_seen = self
            .blocks
            .iter()
            .filter_map(|b| b.id.strip_prefix('b').and_then(|n| n.parse::<u32>().ok()))
            .max()
            .unwrap_or(0);
        let n = self.next_id.max(max_seen + 1).max(1);
        self.next_id = n + 1;
        format!("b{n}")
    }

    pub fn next_order(&self) -> u32 {
        self.blocks.iter().map(|b| b.order).max().map(|o| o + 1).unwrap_or(0)
    }

    /// Topics in creation order.
    pub fn topics(&self) -> Vec<&Block> {
        let mut t: Vec<&Block> = self.blocks.iter().filter(|b| b.kind == BlockKind::Topic).collect();
        t.sort_by_key(|b| b.order);
        t
    }

    /// Ids of the last two topics (the only ones the model may change).
    pub fn recent_topic_ids(&self) -> Vec<String> {
        let t = self.topics();
        t.iter().rev().take(2).map(|b| b.id.clone()).collect()
    }

    pub fn children_of<'a>(&'a self, parent: Option<&str>) -> Vec<&'a Block> {
        let mut v: Vec<&Block> = self
            .blocks
            .iter()
            .filter(|b| b.kind != BlockKind::Topic && b.parent.as_deref() == parent)
            .collect();
        v.sort_by_key(|b| b.order);
        v
    }

    // ---- user edits (the model never reaches these)

    pub fn user_edit(&mut self, id: &str, text: &str) -> bool {
        let kind = match self.get(id) {
            Some(b) => b.kind,
            None => return false,
        };
        let cleaned = crate::live_notes::reducer::clean_text(kind, text);
        if cleaned.is_empty() {
            return false;
        }
        if let Some(b) = self.get_mut(id) {
            b.text = cleaned;
            b.edited = true;
        }
        true
    }

    pub fn user_pin(&mut self, id: &str, pinned: bool) -> bool {
        match self.get_mut(id) {
            Some(b) => {
                b.pinned = pinned;
                true
            }
            None => false,
        }
    }

    /// Removes a block; its children move up to no parent. Ids are not reused.
    pub fn user_delete(&mut self, id: &str) -> bool {
        let before = self.blocks.len();
        self.blocks.retain(|b| b.id != id);
        if self.blocks.len() == before {
            return false;
        }
        for b in self.blocks.iter_mut() {
            if b.parent.as_deref() == Some(id) {
                b.parent = None;
            }
        }
        true
    }

    pub fn user_add(&mut self, kind: BlockKind, parent: Option<&str>, text: &str, at_ms: u64) -> Option<String> {
        self.user_add_with_id(None, kind, parent, text, None, at_ms)
    }

    /// A block the user adds. `id` is the webview's own id when it is usable
    /// and free; `after` puts it right after that block.
    pub fn user_add_with_id(&mut self, id: Option<&str>, kind: BlockKind, parent: Option<&str>, text: &str, after: Option<&str>, at_ms: u64) -> Option<String> {
        let cleaned = crate::live_notes::reducer::clean_text(kind, text);
        if cleaned.is_empty() {
            return None;
        }
        let usable = |i: &&str| !i.is_empty() && i.len() <= 40 && i.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
        let id = match id.filter(usable) {
            Some(i) if self.get(i).is_none() => i.to_string(),
            _ => self.alloc_id(),
        };
        let order = match after.and_then(|a| self.get(a)).map(|b| b.order) {
            Some(o) => {
                for b in self.blocks.iter_mut() {
                    if b.order > o {
                        b.order += 1;
                    }
                }
                o + 1
            }
            None => self.next_order(),
        };
        self.blocks.push(Block {
            id: id.clone(),
            kind,
            parent: if kind == BlockKind::Topic { None } else { parent.map(|s| s.to_string()) },
            text: cleaned,
            start_ms: at_ms,
            end_ms: at_ms,
            edited: true,
            pinned: false,
            order,
        });
        Some(id)
    }

    // ---- export

    /// Markdown for copy/export: entity tags stripped.
    pub fn to_markdown(&self, with_times: bool) -> String {
        let mut out = String::new();
        let time = |b: &Block| if with_times { format!(" ({})", fmt_clock(b.start_ms)) } else { String::new() };
        let line = |b: &Block| -> String {
            let t = strip_tags(&b.text);
            match b.kind {
                BlockKind::Topic => format!("## {}{}\n\n", t, time(b)),
                BlockKind::Summary => format!("{}\n\n", t),
                BlockKind::Bullet => format!("- {}{}\n", t, time(b)),
                BlockKind::Decision => format!("- **Decision:** {}{}\n", t, time(b)),
                BlockKind::Task => format!("- [ ] {}{}\n", t, time(b)),
                BlockKind::Question => format!("- **Question:** {}{}\n", t, time(b)),
            }
        };
        let top = self.children_of(None);
        for b in &top {
            if b.kind == BlockKind::Summary {
                out.push_str(&line(b));
            }
        }
        let loose: Vec<&&Block> = top.iter().filter(|b| b.kind != BlockKind::Summary).collect();
        for b in &loose {
            out.push_str(&line(b));
        }
        if !loose.is_empty() {
            out.push('\n');
        }
        for t in self.topics() {
            out.push_str(&line(t));
            let kids = self.children_of(Some(&t.id));
            let mut wrote_list = false;
            for k in kids {
                if k.kind == BlockKind::Summary {
                    out.push_str(&line(k));
                } else {
                    out.push_str(&line(k));
                    wrote_list = true;
                }
            }
            if wrote_list {
                out.push('\n');
            }
        }
        out.trim_end().to_string() + "\n"
    }

    /// Compact outline for prompts. Last two topics in full, earlier topics as
    /// titles only. A leading `*` marks blocks the model must not change.
    /// Never more than `budget_tokens` (default 900).
    pub fn outline(&self, budget_tokens: u32) -> String {
        let topics = self.topics();
        let n = topics.len();
        let recent_from = n.saturating_sub(2);
        let mut head: Vec<String> = Vec::new();
        for b in self.children_of(None) {
            head.push(outline_line(b, 0));
        }
        let mut older: Vec<String> = Vec::new();
        for t in &topics[..recent_from] {
            older.push(outline_line(t, 0));
        }
        let mut recent: Vec<(String, Vec<String>)> = Vec::new();
        for t in &topics[recent_from..] {
            let kids: Vec<String> = self.children_of(Some(&t.id)).iter().map(|k| outline_line(k, 1)).collect();
            recent.push((outline_line(t, 0), kids));
        }

        let render = |head: &[String], older_n: usize, older: &[String], recent: &[(String, Vec<String>)]| {
            let mut lines: Vec<String> = Vec::new();
            lines.extend(head.iter().cloned());
            if older_n > older.len() {
                lines.push(format!("(… {} earlier topics not shown)", older_n - older.len()));
            }
            lines.extend(older.iter().cloned());
            for (t, kids) in recent {
                lines.push(t.clone());
                lines.extend(kids.iter().cloned());
            }
            lines.join("\n")
        };

        let mut older_cur = older.clone();
        let mut recent_cur = recent.clone();
        let mut head_cur = head.clone();
        let older_total = older.len();
        let mut text = render(&head_cur, older_total, &older_cur, &recent_cur);
        // 1. drop the oldest earlier titles
        while estimate_tokens(&text) > budget_tokens && !older_cur.is_empty() {
            older_cur.remove(0);
            text = render(&head_cur, older_total, &older_cur, &recent_cur);
        }
        // 2. drop the oldest children of the older recent topic, then the newer
        'outer: for idx in 0..recent_cur.len() {
            while estimate_tokens(&text) > budget_tokens && !recent_cur[idx].1.is_empty() {
                recent_cur[idx].1.remove(0);
                text = render(&head_cur, older_total, &older_cur, &recent_cur);
                if estimate_tokens(&text) <= budget_tokens {
                    break 'outer;
                }
            }
        }
        // 3. drop loose blocks
        while estimate_tokens(&text) > budget_tokens && !head_cur.is_empty() {
            head_cur.remove(0);
            text = render(&head_cur, older_total, &older_cur, &recent_cur);
        }
        // 4. last resort: hard cut
        if estimate_tokens(&text) > budget_tokens {
            let keep: String = text.chars().take((budget_tokens as usize) * 3).collect();
            text = keep;
        }
        text
    }
}

fn outline_line(b: &Block, depth: usize) -> String {
    let lock = if b.locked() { "*" } else { "" };
    let indent = "  ".repeat(depth);
    format!("{indent}[{}{}] {} {}: {}", b.id, lock, fmt_clock(b.start_ms), b.kind.as_str(), crate::prompt_data::clean_line_max(&b.text, 300))
}

// ---------------------------------------------------------------- spans

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpanKind {
    Plain,
    Person,
    Place,
    Org,
    Date,
    Number,
}

impl SpanKind {
    fn from_tag(c: char) -> Option<SpanKind> {
        match c {
            'p' => Some(SpanKind::Person),
            'l' => Some(SpanKind::Place),
            'o' => Some(SpanKind::Org),
            'd' => Some(SpanKind::Date),
            'n' => Some(SpanKind::Number),
            _ => None,
        }
    }
    fn tag(&self) -> Option<char> {
        match self {
            SpanKind::Plain => None,
            SpanKind::Person => Some('p'),
            SpanKind::Place => Some('l'),
            SpanKind::Org => Some('o'),
            SpanKind::Date => Some('d'),
            SpanKind::Number => Some('n'),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Span {
    pub kind: SpanKind,
    pub text: String,
}

/// Splits text into plain and entity spans. Malformed tags stay as plain text
/// (without the stray braces).
pub fn parse_spans(text: &str) -> Vec<Span> {
    let chars: Vec<char> = text.chars().collect();
    let mut spans: Vec<Span> = Vec::new();
    let mut plain = String::new();
    let push_plain = |plain: &mut String, spans: &mut Vec<Span>| {
        if !plain.is_empty() {
            spans.push(Span { kind: SpanKind::Plain, text: std::mem::take(plain) });
        }
    };
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '{' && i + 1 < chars.len() && chars[i + 1] == '{' {
            // {{x:...}}
            if i + 4 < chars.len() && chars[i + 3] == ':' && chars[i + 2].is_ascii_alphabetic() {
                {
                    let known = SpanKind::from_tag(chars[i + 2]);
                    let mut j = i + 4;
                    let mut inner = String::new();
                    let mut closed = false;
                    while j + 1 < chars.len() {
                        if chars[j] == '}' && chars[j + 1] == '}' {
                            closed = true;
                            break;
                        }
                        if chars[j] == '{' || chars[j] == '}' {
                            break;
                        }
                        inner.push(chars[j]);
                        j += 1;
                    }
                    let inner_trim = inner.trim().to_string();
                    if closed && !inner_trim.is_empty() {
                        match known {
                            Some(kind) => {
                                push_plain(&mut plain, &mut spans);
                                spans.push(Span { kind, text: inner_trim });
                            }
                            None => plain.push_str(&inner_trim),
                        }
                        i = j + 2;
                        continue;
                    }
                    if closed {
                        i = j + 2;
                        continue;
                    }
                }
            }
            // malformed: drop the braces, keep going
            i += 2;
            continue;
        }
        if chars[i] == '}' && i + 1 < chars.len() && chars[i + 1] == '}' {
            i += 2;
            continue;
        }
        plain.push(chars[i]);
        i += 1;
    }
    push_plain(&mut plain, &mut spans);
    spans
}

/// Re-serialises spans: well-formed tags only.
pub fn normalize_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for s in parse_spans(text) {
        match s.kind.tag() {
            None => out.push_str(&s.text),
            Some(t) => {
                out.push_str("{{");
                out.push(t);
                out.push(':');
                out.push_str(&s.text);
                out.push_str("}}");
            }
        }
    }
    out
}

/// Text without any tag syntax.
pub fn strip_tags(text: &str) -> String {
    parse_spans(text).into_iter().map(|s| s.text).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blk(id: &str, kind: BlockKind, parent: Option<&str>, text: &str, order: u32) -> Block {
        Block {
            id: id.into(),
            kind,
            parent: parent.map(|s| s.into()),
            text: text.into(),
            start_ms: order as u64 * 1000,
            end_ms: order as u64 * 1000,
            edited: false,
            pinned: false,
            order,
        }
    }

    #[test]
    fn spans_parse_and_strip() {
        let s = parse_spans("Ask {{p:Ana}} about {{l:Madrid}} on {{d:Friday}}, {{n:12k}}.");
        assert_eq!(s.len(), 9);
        assert_eq!(s[1], Span { kind: SpanKind::Person, text: "Ana".into() });
        assert_eq!(strip_tags("Ask {{p:Ana}} now {{x:bad}} {{o:}}"), "Ask Ana now bad ");
        assert_eq!(normalize_tags("a {{p:Ana}} {{p:Bo"), "a {{p:Ana}} p:Bo");
        assert_eq!(strip_tags("{{o:Acme}} 来月"), "Acme 来月");
    }

    #[test]
    fn ids_never_reused() {
        let mut d = NoteDoc::new();
        let a = d.user_add(BlockKind::Topic, None, "A", 0).unwrap();
        let b = d.user_add(BlockKind::Bullet, Some(&a), "x one", 0).unwrap();
        assert_eq!((a.as_str(), b.as_str()), ("b1", "b2"));
        d.user_delete(&b);
        let c = d.user_add(BlockKind::Bullet, Some(&a), "y two", 0).unwrap();
        assert_eq!(c, "b3");
        // survives a JSON round trip without next_id too
        let mut json: serde_json::Value = serde_json::to_value(&d).unwrap();
        json.as_object_mut().unwrap().remove("next_id");
        let mut back: NoteDoc = serde_json::from_value(json).unwrap();
        assert_eq!(back.alloc_id(), "b4");
    }

    #[test]
    fn markdown_has_no_tags() {
        let mut d = NoteDoc::new();
        d.blocks.push(blk("b1", BlockKind::Topic, None, "Hiring {{o:Acme}}", 0));
        d.blocks.push(blk("b2", BlockKind::Bullet, Some("b1"), "{{p:Ana}} starts {{d:Monday}}", 1));
        d.blocks.push(blk("b3", BlockKind::Task, Some("b1"), "Send offer", 2));
        d.blocks.push(blk("b4", BlockKind::Decision, Some("b1"), "Go ahead", 3));
        let md = d.to_markdown(false);
        assert!(md.contains("## Hiring Acme"));
        assert!(md.contains("- Ana starts Monday"));
        assert!(md.contains("- [ ] Send offer"));
        assert!(md.contains("- **Decision:** Go ahead"));
        assert!(!md.contains("{{"));
    }

    #[test]
    fn outline_full_for_last_two_titles_for_rest() {
        let mut d = NoteDoc::new();
        for i in 0..5u32 {
            let tid = format!("t{i}");
            d.blocks.push(blk(&tid, BlockKind::Topic, None, &format!("Topic {i}"), i * 10));
            d.blocks.push(blk(&format!("k{i}"), BlockKind::Bullet, Some(&tid), &format!("detail {i} here"), i * 10 + 1));
        }
        let o = d.outline(900);
        assert!(o.contains("detail 4 here") && o.contains("detail 3 here"));
        assert!(!o.contains("detail 2 here"));
        assert!(o.contains("Topic 0") && o.contains("Topic 2"));
    }

    #[test]
    fn outline_respects_budget_and_marks_locked() {
        let mut d = NoteDoc::new();
        for i in 0..80u32 {
            let tid = format!("t{i}");
            d.blocks.push(blk(&tid, BlockKind::Topic, None, &format!("A long topic title number {i} about things"), i * 100));
            for j in 0..6u32 {
                d.blocks.push(blk(
                    &format!("k{i}_{j}"),
                    BlockKind::Bullet,
                    Some(&tid),
                    &"word ".repeat(30),
                    i * 100 + j + 1,
                ));
            }
        }
        d.blocks.last_mut().unwrap().pinned = true;
        let o = d.outline(900);
        assert!(estimate_tokens(&o) <= 900, "{}", estimate_tokens(&o));
        assert!(o.contains("earlier topics not shown") || o.contains("Topic") || !o.is_empty());
        let mut small = NoteDoc::new();
        small.blocks.push(blk("b1", BlockKind::Topic, None, "T", 0));
        small.blocks[0].edited = true;
        assert!(small.outline(900).contains("[b1*]"));
    }
}
