//! Applies the model's operations to the document. Every rule that protects
//! the user's notes is enforced here, in code, whatever the model wrote.

use crate::live_common::similarity;
use crate::live_notes::doc::{normalize_tags, Block, BlockKind, NoteDoc};
use crate::live_notes::ops::{OpKind, RawOp};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DropReason {
    TooManyOps,
    Empty,
    UnknownId,
    /// The block was edited or pinned by the user.
    Locked,
    /// Not in the last two topics.
    NotUpdatable,
    Duplicate,
    /// The update would not change anything.
    Unchanged,
    BadParent,
    BlockLimit,
    MissingField,
}

#[derive(Debug, Clone)]
pub struct ReduceLimits {
    pub max_ops: usize,
    pub max_blocks: usize,
    /// Near-duplicate threshold for new blocks.
    pub dup_threshold: f32,
    /// Stricter threshold for the title of a new topic.
    pub topic_dup_threshold: f32,
}

impl Default for ReduceLimits {
    fn default() -> Self {
        Self { max_ops: 12, max_blocks: 500, dup_threshold: 0.8, topic_dup_threshold: 0.75 }
    }
}

/// Time range of the transcript lines that were sent (ms).
#[derive(Debug, Clone, Copy)]
pub struct ReduceCtx {
    pub range_start_ms: u64,
    pub range_end_ms: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ReduceReport {
    pub added: u32,
    pub updated: u32,
    pub moved: u32,
    pub dropped: BTreeMap<DropReason, u32>,
    /// Timestamps pulled back into the sent range.
    pub clamped: u32,
    /// Blocks attached to the latest topic because their parent was missing or old.
    pub reparented: u32,
    pub changed_ids: Vec<String>,
}

impl ReduceReport {
    pub fn applied(&self) -> u32 {
        self.added + self.updated + self.moved
    }
    pub fn dropped_total(&self) -> u32 {
        self.dropped.values().sum()
    }
    fn drop(&mut self, r: DropReason) {
        *self.dropped.entry(r).or_insert(0) += 1;
    }
}

/// Plain text for a block: no control characters or list markers, one line,
/// well-formed entity tags, within the cap of its kind.
pub fn clean_text(kind: BlockKind, raw: &str) -> String {
    let mut s: String = raw.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    loop {
        let t = s.trim_start();
        let stripped = ["- ", "* ", "• ", "## ", "# ", "[] ", "[ ] ", "[x] ", "! ", "? ", "> "]
            .iter()
            .find_map(|p| t.strip_prefix(p));
        match stripped {
            Some(rest) => s = rest.to_string(),
            None => break,
        }
    }
    s = normalize_tags(s.trim());
    let max = kind.max_chars();
    if s.chars().count() > max {
        let mut cut: String = s.chars().take(max - 1).collect();
        if let Some(pos) = cut.rfind(char::is_whitespace) {
            if cut.chars().count().saturating_sub(cut[..pos].chars().count()) <= 24 {
                cut.truncate(pos);
            }
        }
        s = normalize_tags(cut.trim_end());
        s.push('…');
    }
    s.trim().to_string()
}

struct Reducer<'a> {
    doc: &'a mut NoteDoc,
    ctx: ReduceCtx,
    limits: &'a ReduceLimits,
    alias: HashMap<String, String>,
    report: ReduceReport,
}

impl<'a> Reducer<'a> {
    fn resolve(&self, id: &str) -> Option<String> {
        if self.doc.get(id).is_some() {
            return Some(id.to_string());
        }
        self.alias.get(id).cloned()
    }

    fn updatable(&self, b: &Block) -> bool {
        let recent = self.doc.recent_topic_ids();
        match b.kind {
            BlockKind::Topic => recent.contains(&b.id),
            BlockKind::Summary if b.parent.is_none() => true,
            _ => b.parent.as_ref().map(|p| recent.contains(p)).unwrap_or(false),
        }
    }

    fn clamp_t(&mut self, t: Option<u64>) -> u64 {
        let (s, e) = (self.ctx.range_start_ms, self.ctx.range_end_ms.max(self.ctx.range_start_ms));
        match t {
            Some(t) if t >= s && t <= e => t,
            Some(t) => {
                self.report.clamped += 1;
                t.clamp(s, e)
            }
            None => e,
        }
    }

    /// Blocks a new or changed block is compared against.
    fn pool(&self, skip: Option<&str>) -> Vec<(String, String)> {
        let recent = self.doc.recent_topic_ids();
        self.doc
            .blocks
            .iter()
            .filter(|b| b.kind != BlockKind::Topic)
            .filter(|b| match &b.parent {
                None => true,
                Some(p) => recent.contains(p),
            })
            .filter(|b| Some(b.id.as_str()) != skip)
            .map(|b| (b.id.clone(), b.text.clone()))
            .collect()
    }

    fn latest_topic(&self) -> Option<String> {
        self.doc.topics().last().map(|b| b.id.clone())
    }

    /// Where a new non-topic block goes: the requested topic if it is one of
    /// the last two, else the latest topic.
    fn pick_parent(&mut self, wanted: Option<&str>) -> Option<String> {
        let recent = self.doc.recent_topic_ids();
        if let Some(w) = wanted {
            if let Some(real) = self.resolve(w) {
                if let Some(b) = self.doc.get(&real) {
                    let candidate = if b.kind == BlockKind::Topic { Some(real.clone()) } else { b.parent.clone() };
                    if let Some(c) = candidate {
                        if recent.contains(&c) {
                            return Some(c);
                        }
                    }
                }
            }
            let latest = self.latest_topic();
            if latest.is_some() {
                self.report.reparented += 1;
            }
            return latest;
        }
        self.latest_topic()
    }

    fn add(&mut self, op: RawOp) {
        let kind = op.kind.unwrap_or(BlockKind::Bullet);
        let text = match op.text.as_deref().map(|t| clean_text(kind, t)) {
            Some(t) if !t.is_empty() => t,
            Some(_) => return self.report.drop(DropReason::Empty),
            None => return self.report.drop(DropReason::MissingField),
        };
        if self.doc.blocks.len() >= self.limits.max_blocks {
            return self.report.drop(DropReason::BlockLimit);
        }
        let alias = op.id.clone().filter(|a| self.doc.get(a).is_none());
        let t = self.clamp_t(op.t_ms);

        if kind == BlockKind::Topic {
            let recent = self.doc.recent_topic_ids();
            let dup = self
                .doc
                .blocks
                .iter()
                .filter(|b| recent.contains(&b.id))
                .find(|b| similarity(&b.text, &text) >= self.limits.topic_dup_threshold)
                .map(|b| b.id.clone());
            if let Some(existing) = dup {
                if let Some(a) = alias {
                    self.alias.insert(a, existing);
                }
                return self.report.drop(DropReason::Duplicate);
            }
        } else if self.pool(None).iter().any(|(_, other)| similarity(other, &text) >= self.limits.dup_threshold) {
            return self.report.drop(DropReason::Duplicate);
        }

        let parent = if kind == BlockKind::Topic { None } else { self.pick_parent(op.parent.as_deref()) };
        let id = self.doc.alloc_id();
        let order = self.doc.next_order();
        if let Some(p) = &parent {
            if let Some(pb) = self.doc.get_mut(p) {
                pb.end_ms = pb.end_ms.max(t);
            }
        }
        self.doc.blocks.push(Block {
            id: id.clone(),
            kind,
            parent,
            text,
            start_ms: t,
            end_ms: t,
            edited: false,
            pinned: false,
            order,
        });
        if let Some(a) = alias {
            self.alias.insert(a, id.clone());
        }
        self.report.added += 1;
        self.report.changed_ids.push(id);
    }

    fn update(&mut self, op: RawOp) {
        let Some(raw_id) = op.id.as_deref() else { return self.report.drop(DropReason::MissingField) };
        let Some(id) = self.resolve(raw_id) else { return self.report.drop(DropReason::UnknownId) };
        let Some(block) = self.doc.get(&id).cloned() else { return self.report.drop(DropReason::UnknownId) };
        if block.locked() {
            return self.report.drop(DropReason::Locked);
        }
        if !self.updatable(&block) {
            return self.report.drop(DropReason::NotUpdatable);
        }
        let Some(raw_text) = op.text.as_deref() else { return self.report.drop(DropReason::MissingField) };
        let text = clean_text(block.kind, raw_text);
        if text.is_empty() {
            return self.report.drop(DropReason::Empty);
        }
        if crate::live_common::normalize(&text) == crate::live_common::normalize(&block.text) {
            return self.report.drop(DropReason::Unchanged);
        }
        if block.kind != BlockKind::Topic
            && self.pool(Some(&id)).iter().any(|(_, other)| similarity(other, &text) >= self.limits.dup_threshold)
        {
            return self.report.drop(DropReason::Duplicate);
        }
        if let Some(b) = self.doc.get_mut(&id) {
            b.text = text;
        }
        self.report.updated += 1;
        self.report.changed_ids.push(id);
    }

    fn move_block(&mut self, op: RawOp) {
        let (Some(raw_id), Some(raw_parent)) = (op.id.as_deref(), op.parent.as_deref()) else {
            return self.report.drop(DropReason::MissingField);
        };
        let Some(id) = self.resolve(raw_id) else { return self.report.drop(DropReason::UnknownId) };
        let Some(block) = self.doc.get(&id).cloned() else { return self.report.drop(DropReason::UnknownId) };
        if block.locked() {
            return self.report.drop(DropReason::Locked);
        }
        if block.kind == BlockKind::Topic || !self.updatable(&block) {
            return self.report.drop(DropReason::NotUpdatable);
        }
        let Some(target) = self.resolve(raw_parent) else { return self.report.drop(DropReason::BadParent) };
        let recent = self.doc.recent_topic_ids();
        let ok = self.doc.get(&target).map(|b| b.kind == BlockKind::Topic).unwrap_or(false) && recent.contains(&target);
        if !ok {
            return self.report.drop(DropReason::BadParent);
        }
        if block.parent.as_deref() == Some(target.as_str()) {
            return self.report.drop(DropReason::Unchanged);
        }
        if let Some(b) = self.doc.get_mut(&id) {
            b.parent = Some(target.clone());
        }
        if let Some(t) = self.doc.get_mut(&target) {
            t.end_ms = t.end_ms.max(block.end_ms);
        }
        self.report.moved += 1;
        self.report.changed_ids.push(id);
    }
}

pub fn apply_ops(doc: &mut NoteDoc, ops: Vec<RawOp>, ctx: ReduceCtx, limits: &ReduceLimits) -> ReduceReport {
    let mut r = Reducer { doc, ctx, limits, alias: HashMap::new(), report: ReduceReport::default() };
    for (i, op) in ops.into_iter().enumerate() {
        if i >= limits.max_ops {
            r.report.drop(DropReason::TooManyOps);
            continue;
        }
        match op.op {
            OpKind::Add => r.add(op),
            OpKind::Update => r.update(op),
            OpKind::Move => r.move_block(op),
        }
    }
    r.report
}

/// Independent check of the rules, used by tests and the eval scorer. Returns
/// one message per violation; an empty list means the change is clean.
pub fn check_invariants(before: &NoteDoc, after: &NoteDoc, ctx: ReduceCtx, limits: &ReduceLimits) -> Vec<String> {
    let mut v = Vec::new();
    let recent: Vec<String> = before.recent_topic_ids();
    let mut changed = 0usize;
    for b in &before.blocks {
        match after.get(&b.id) {
            None => v.push(format!("{} removed", b.id)),
            Some(a) => {
                let same = a.text == b.text && a.kind == b.kind && a.parent == b.parent;
                if !same {
                    changed += 1;
                    if b.locked() {
                        v.push(format!("{} is locked but changed", b.id));
                    }
                    let in_recent = match b.kind {
                        BlockKind::Topic => recent.contains(&b.id),
                        BlockKind::Summary if b.parent.is_none() => true,
                        _ => b.parent.as_ref().map(|p| recent.contains(p)).unwrap_or(false),
                    };
                    if !in_recent {
                        v.push(format!("{} changed outside the last two topics", b.id));
                    }
                }
                if a.edited != b.edited || a.pinned != b.pinned || a.order != b.order || a.start_ms != b.start_ms || a.id != b.id {
                    v.push(format!("{} metadata changed", b.id));
                }
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    for a in &after.blocks {
        if !seen.insert(a.id.clone()) {
            v.push(format!("{} duplicated id", a.id));
        }
        if normalize_tags(&a.text) != a.text {
            v.push(format!("{} malformed tags", a.id));
        }
        if a.text.chars().count() > a.kind.max_chars() {
            v.push(format!("{} over length cap", a.id));
        }
        if let Some(p) = &a.parent {
            match after.get(p) {
                Some(pb) if pb.kind == BlockKind::Topic => {}
                _ => v.push(format!("{} orphan parent {}", a.id, p)),
            }
        }
        if before.get(&a.id).is_none() {
            changed += 1;
            if a.start_ms < ctx.range_start_ms || a.start_ms > ctx.range_end_ms.max(ctx.range_start_ms) {
                v.push(format!("{} timestamp outside range", a.id));
            }
            if a.edited || a.pinned {
                v.push(format!("{} new block flagged by model", a.id));
            }
        }
    }
    if changed > limits.max_ops {
        v.push(format!("{} blocks changed, max {}", changed, limits.max_ops));
    }
    // moves count: blocks whose parent changed are in `changed` already.
    // near duplicates among new non-topic blocks and the pool
    let pool_ids: std::collections::HashSet<String> = after
        .blocks
        .iter()
        .filter(|b| b.kind != BlockKind::Topic)
        .filter(|b| match &b.parent {
            None => true,
            Some(p) => after.recent_topic_ids().contains(p),
        })
        .map(|b| b.id.clone())
        .collect();
    let news: Vec<&Block> = after.blocks.iter().filter(|b| before.get(&b.id).is_none() && b.kind != BlockKind::Topic).collect();
    for n in &news {
        for o in after.blocks.iter().filter(|o| o.id != n.id && pool_ids.contains(&o.id)) {
            // only older blocks or earlier-created new ones count against n
            if o.order < n.order && similarity(&o.text, &n.text) >= limits.dup_threshold + 0.001 {
                v.push(format!("{} near-duplicates {}", n.id, o.id));
            }
        }
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> ReduceCtx {
        ReduceCtx { range_start_ms: 60_000, range_end_ms: 120_000 }
    }

    fn add(kind: BlockKind, text: &str) -> RawOp {
        RawOp { op: OpKind::Add, id: None, kind: Some(kind), parent: None, text: Some(text.into()), t_ms: Some(70_000) }
    }
    fn add_in(kind: BlockKind, text: &str, alias: &str, parent: &str) -> RawOp {
        RawOp { op: OpKind::Add, id: Some(alias.into()), kind: Some(kind), parent: Some(parent.into()), text: Some(text.into()), t_ms: Some(80_000) }
    }
    fn upd(id: &str, text: &str) -> RawOp {
        RawOp { op: OpKind::Update, id: Some(id.into()), kind: None, parent: None, text: Some(text.into()), t_ms: None }
    }
    fn mv(id: &str, parent: &str) -> RawOp {
        RawOp { op: OpKind::Move, id: Some(id.into()), kind: None, parent: Some(parent.into()), text: None, t_ms: None }
    }
    fn run(doc: &mut NoteDoc, ops: Vec<RawOp>) -> ReduceReport {
        let before = doc.clone();
        let l = ReduceLimits::default();
        let r = apply_ops(doc, ops, ctx(), &l);
        let viol = check_invariants(&before, doc, ctx(), &l);
        assert!(viol.is_empty(), "{viol:?}");
        r
    }

    fn doc_with_topics(n: usize) -> NoteDoc {
        let mut d = NoteDoc::new();
        for i in 0..n {
            let t = d.user_add(BlockKind::Topic, None, &format!("Topic number {i} alpha{i}"), 1000 * i as u64).unwrap();
            d.user_add(BlockKind::Bullet, Some(&t), &format!("point about subject{i} gamma{i}"), 1000 * i as u64).unwrap();
            for b in d.blocks.iter_mut() {
                b.edited = false;
            }
        }
        d
    }

    #[test]
    fn aliases_resolve_inside_a_run() {
        let mut d = NoteDoc::new();
        let r = run(
            &mut d,
            vec![
                RawOp { id: Some("t1".into()), ..add(BlockKind::Topic, "Quarterly budget") },
                add_in(BlockKind::Bullet, "Marketing gets twelve percent more", "x1", "t1"),
                add_in(BlockKind::Decision, "Freeze hiring until June", "x2", "t1"),
            ],
        );
        assert_eq!(r.added, 3);
        assert_eq!(d.blocks[1].parent.as_deref(), Some("b1"));
        assert_eq!(d.blocks[2].parent.as_deref(), Some("b1"));
        assert_eq!(d.blocks[0].end_ms, 80_000);
    }

    #[test]
    fn locked_blocks_are_never_changed() {
        let mut d = doc_with_topics(2);
        d.blocks[3].edited = true; // bullet of topic 2
        d.blocks[1].pinned = true; // bullet of topic 1
        let id_edit = d.blocks[3].id.clone();
        let id_pin = d.blocks[1].id.clone();
        let r = run(&mut d, vec![upd(&id_edit, "overwritten text here"), upd(&id_pin, "pinned overwritten"), mv(&id_edit, "b1")]);
        assert_eq!(r.applied(), 0);
        assert_eq!(r.dropped[&DropReason::Locked], 3);
        assert_eq!(d.get(&id_edit).unwrap().text, "point about subject1 gamma1");
    }

    #[test]
    fn only_last_two_topics_change() {
        let mut d = doc_with_topics(4);
        let old_topic = d.blocks[0].id.clone();
        let old_bullet = d.blocks[1].id.clone();
        let recent_bullet = d.blocks[7].id.clone();
        let r = run(
            &mut d,
            vec![upd(&old_topic, "Renamed old topic"), upd(&old_bullet, "Changed old bullet"), upd(&recent_bullet, "Changed recent bullet text")],
        );
        assert_eq!(r.updated, 1);
        assert_eq!(r.dropped[&DropReason::NotUpdatable], 2);
    }

    #[test]
    fn move_only_into_recent_topics() {
        let mut d = doc_with_topics(4);
        let b_recent = d.blocks[7].id.clone(); // bullet of topic 4 (b7?)
        let t_old = d.blocks[0].id.clone();
        let t3 = d.blocks[4].id.clone();
        let r = run(&mut d, vec![mv(&b_recent, &t_old), mv(&b_recent, &t3)]);
        assert_eq!(r.moved, 1);
        assert_eq!(r.dropped[&DropReason::BadParent], 1);
        assert_eq!(d.get(&b_recent).unwrap().parent.as_deref(), Some(t3.as_str()));
    }

    #[test]
    fn caps_ops_and_text() {
        let mut d = NoteDoc::new();
        let mut ops = vec![add(BlockKind::Topic, "Everything")];
        for i in 0..20 {
            ops.push(add(BlockKind::Bullet, &format!("distinct fact number{i} about widget{i} gizmo{i}")));
        }
        let r = run(&mut d, ops);
        assert_eq!(r.added, 12);
        assert_eq!(r.dropped[&DropReason::TooManyOps], 9);
        let long = "word ".repeat(200);
        let mut d2 = NoteDoc::new();
        run(&mut d2, vec![add(BlockKind::Topic, &long), add(BlockKind::Bullet, &long.replace("word", "other"))]);
        assert!(d2.blocks[0].text.chars().count() <= 80 && d2.blocks[0].text.ends_with('…'));
        assert!(d2.blocks[1].text.chars().count() <= 220);
        let cjk = "予算".repeat(300);
        let mut d3 = NoteDoc::new();
        run(&mut d3, vec![add(BlockKind::Bullet, &cjk)]);
        assert!(d3.blocks[0].text.chars().count() <= 220);
    }

    #[test]
    fn timestamps_pulled_into_range() {
        let mut d = NoteDoc::new();
        let mut a = add(BlockKind::Topic, "Early claim");
        a.t_ms = Some(5_000);
        let mut b = add(BlockKind::Bullet, "Late claim about the future");
        b.t_ms = Some(9_999_000);
        let mut c = add(BlockKind::Bullet, "No time given for this one");
        c.t_ms = None;
        let r = run(&mut d, vec![a, b, c]);
        assert_eq!(r.clamped, 2);
        assert_eq!(d.blocks[0].start_ms, 60_000);
        assert_eq!(d.blocks[1].start_ms, 120_000);
        assert_eq!(d.blocks[2].start_ms, 120_000);
    }

    #[test]
    fn duplicates_suppressed() {
        let mut d = NoteDoc::new();
        let r = run(
            &mut d,
            vec![
                add(BlockKind::Topic, "Release plan"),
                add(BlockKind::Bullet, "Ship the beta on Friday"),
                add(BlockKind::Bullet, "ship the beta friday"),
                add(BlockKind::Decision, "Ship the beta on Friday."),
                add(BlockKind::Topic, "The release plan"),
                RawOp { parent: Some("b1".into()), ..add(BlockKind::Bullet, "Hire two testers") },
            ],
        );
        assert_eq!(r.added, 3);
        assert_eq!(r.dropped[&DropReason::Duplicate], 3);
        // a later run does not re-add the same thing
        let r2 = run(&mut d, vec![add(BlockKind::Bullet, "Ship beta Friday")]);
        assert_eq!(r2.added, 0);
    }

    #[test]
    fn orphans_attach_to_latest_topic() {
        let mut d = doc_with_topics(4);
        let old_topic = d.blocks[0].id.clone();
        let r = run(
            &mut d,
            vec![
                RawOp { parent: Some("nope".into()), ..add(BlockKind::Bullet, "Orphan with a bad parent") },
                RawOp { parent: Some(old_topic), ..add(BlockKind::Task, "Child of an old topic") },
                add(BlockKind::Question, "Who owns the rollout"),
            ],
        );
        assert_eq!(r.added, 3);
        assert_eq!(r.reparented, 2);
        let latest = d.topics().last().unwrap().id.clone();
        for b in &d.blocks[d.blocks.len() - 3..] {
            assert_eq!(b.parent.as_deref(), Some(latest.as_str()));
        }
        // no topic at all: allowed without parent
        let mut e = NoteDoc::new();
        run(&mut e, vec![add(BlockKind::Bullet, "First thing said")]);
        assert!(e.blocks[0].parent.is_none());
    }

    #[test]
    fn ids_are_stable_and_existing_ids_are_not_taken_as_aliases() {
        let mut d = doc_with_topics(1);
        let r = run(&mut d, vec![RawOp { id: Some("b1".into()), ..add(BlockKind::Topic, "Totally different title") }]);
        assert_eq!(r.added, 1);
        assert_eq!(d.get("b1").unwrap().text, "Topic number 0 alpha0");
        assert_eq!(d.blocks.last().unwrap().id, "b3");
    }

    #[test]
    fn messy_text_is_cleaned() {
        assert_eq!(clean_text(BlockKind::Bullet, "  - hello\n  world {{p:Ana}} {{x"), "hello world {{p:Ana}} x");
        assert_eq!(clean_text(BlockKind::Task, "[] \u{0}send\tit"), "send it");
        assert_eq!(clean_text(BlockKind::Bullet, "   "), "");
    }

    #[test]
    fn unchanged_and_unknown_updates() {
        let mut d = doc_with_topics(1);
        let bullet = d.blocks[1].id.clone();
        let same = d.blocks[1].text.to_uppercase();
        let r = run(&mut d, vec![upd(&bullet, &same), upd("b99", "something else"), upd(&bullet, "   ")]);
        assert_eq!(r.dropped[&DropReason::Unchanged], 1);
        assert_eq!(r.dropped[&DropReason::UnknownId], 1);
        assert_eq!(r.dropped[&DropReason::Empty], 1);
    }

    #[test]
    fn summary_without_parent_can_be_rewritten() {
        let mut d = NoteDoc::new();
        run(&mut d, vec![add(BlockKind::Summary, "Short overview so far")]);
        let id = d.blocks[0].id.clone();
        run(&mut d, vec![add(BlockKind::Topic, "A topic"), upd(&id, "Longer overview of the whole call now")]);
        assert_eq!(d.get(&id).unwrap().text, "Longer overview of the whole call now");
    }

    #[test]
    fn random_ops_never_break_invariants() {
        // deterministic LCG; random ids (some real, some aliases, some junk), kinds, times
        let mut s: u64 = 0x9E3779B97F4A7C15;
        let mut next = move || {
            s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (s >> 33) as u32
        };
        let words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima", "mike", "november"];
        let kinds = [BlockKind::Topic, BlockKind::Summary, BlockKind::Bullet, BlockKind::Decision, BlockKind::Task, BlockKind::Question];
        let mut doc = NoteDoc::new();
        for round in 0..300 {
            let before = doc.clone();
            if round % 17 == 0 && !doc.blocks.is_empty() {
                let i = next() as usize % doc.blocks.len();
                if next() % 2 == 0 { doc.blocks[i].edited = true } else { doc.blocks[i].pinned = true }
            }
            let before_locked = doc.clone();
            let n = 1 + next() % 16;
            let mut ops = Vec::new();
            for _ in 0..n {
                let id_pick = if doc.blocks.is_empty() || next() % 5 == 0 {
                    format!("n{}", next() % 4)
                } else {
                    doc.blocks[next() as usize % doc.blocks.len()].id.clone()
                };
                let text: String = (0..(next() % 8)).map(|_| words[next() as usize % words.len()]).collect::<Vec<_>>().join(" ");
                let t = if next() % 3 == 0 { None } else { Some((next() % 300_000) as u64) };
                let op = match next() % 3 {
                    0 => OpKind::Add,
                    1 => OpKind::Update,
                    _ => OpKind::Move,
                };
                ops.push(RawOp {
                    op,
                    id: Some(id_pick),
                    kind: Some(kinds[next() as usize % 6]),
                    parent: if next() % 2 == 0 { Some(format!("n{}", next() % 4)) } else { doc.blocks.get(next() as usize % (doc.blocks.len() + 1)).map(|b| b.id.clone()) },
                    text: Some(text),
                    t_ms: t,
                });
            }
            let l = ReduceLimits::default();
            apply_ops(&mut doc, ops, ctx(), &l);
            let v = check_invariants(&before_locked, &doc, ctx(), &l);
            assert!(v.is_empty(), "round {round}: {v:?}");
            let _ = before;
        }
        assert!(doc.blocks.len() > 10);
    }
}
