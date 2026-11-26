//! Local topic-change detector: no model, no network. Compares the content
//! words of the last minute with those of the three minutes before it. Works
//! on any script (space-separated words, CJK bigrams).

use crate::live_common::content_terms;
use std::collections::{HashMap, HashSet, VecDeque};

#[derive(Debug, Clone)]
pub struct TopicConfig {
    pub recent_ms: u64,
    pub prior_ms: u64,
    /// Distinct content words needed in the recent window / the prior window.
    pub min_recent_terms: usize,
    pub min_prior_terms: usize,
    /// Speech must reach back this far before a verdict is given.
    pub min_history_ms: u64,
    /// Share of the recent words that never appeared before, to call a change.
    pub change_at: f32,
    /// After a change, the share must fall below this before another can fire.
    pub rearm_below: f32,
    pub cooldown_ms: u64,
}

impl Default for TopicConfig {
    fn default() -> Self {
        Self {
            recent_ms: 60_000,
            prior_ms: 180_000,
            min_recent_terms: 8,
            min_prior_terms: 25,
            min_history_ms: 150_000,
            change_at: 0.45,
            rearm_below: 0.3,
            cooldown_ms: 60_000,
        }
    }
}

#[derive(Debug, Clone)]
pub struct TopicDetector {
    cfg: TopicConfig,
    lines: VecDeque<(u64, Vec<String>)>,
    armed: bool,
    last_change_ms: Option<u64>,
}

impl TopicDetector {
    pub fn new(cfg: TopicConfig) -> Self {
        Self { cfg, lines: VecDeque::new(), armed: true, last_change_ms: None }
    }

    /// A finished transcript line spoken at `ms`.
    pub fn push(&mut self, ms: u64, text: &str) {
        let terms = content_terms(text);
        if !terms.is_empty() {
            self.lines.push_back((ms, terms));
        }
        let keep_from = ms.saturating_sub(self.cfg.recent_ms + self.cfg.prior_ms + 1_000);
        while self.lines.front().map(|(t, _)| *t < keep_from).unwrap_or(false) {
            self.lines.pop_front();
        }
    }

    /// Share (0..=1) of the words the last minute keeps coming back to (heard
    /// at least twice) that were not heard in the three minutes before.
    /// One-off words (small talk, names in passing) are ignored: a topic is
    /// what is repeated. None while there is too little speech to tell.
    pub fn novelty(&self, now: u64) -> Option<f32> {
        let recent_from = now.saturating_sub(self.cfg.recent_ms);
        let prior_from = recent_from.saturating_sub(self.cfg.prior_ms);
        let first = self.lines.front().map(|(t, _)| *t)?;
        if now.saturating_sub(first) < self.cfg.min_history_ms {
            return None;
        }
        let mut recent: HashMap<&str, u32> = HashMap::new();
        let mut prior: HashSet<&str> = HashSet::new();
        for (t, terms) in &self.lines {
            if *t > now {
                continue;
            }
            if *t >= recent_from {
                for w in terms {
                    *recent.entry(w.as_str()).or_insert(0) += 1;
                }
            } else if *t >= prior_from {
                prior.extend(terms.iter().map(|s| s.as_str()));
            }
        }
        let recurring: Vec<&str> = recent.iter().filter(|(_, c)| **c >= 2).map(|(w, _)| *w).collect();
        if recurring.len() < self.cfg.min_recent_terms || prior.len() < self.cfg.min_prior_terms {
            return None;
        }
        let novel = recurring.iter().filter(|t| !prior.contains(**t)).count();
        Some(novel as f32 / recurring.len() as f32)
    }

    /// True once per topic change.
    pub fn poll(&mut self, now: u64) -> bool {
        let Some(n) = self.novelty(now) else { return false };
        if !self.armed {
            if n < self.cfg.rearm_below {
                self.armed = true;
            }
            return false;
        }
        if let Some(t) = self.last_change_ms {
            if now.saturating_sub(t) < self.cfg.cooldown_ms {
                return false;
            }
        }
        if n >= self.cfg.change_at {
            self.armed = false;
            self.last_change_ms = Some(now);
            return true;
        }
        false
    }

    /// Forget the past (scope change).
    pub fn reset(&mut self) {
        self.lines.clear();
        self.armed = true;
        self.last_change_ms = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::live_eval::scripted::{conversation, Lang, ALL_LANGS};

    struct Score {
        false_triggers: u32,
        missed: u32,
        late_ms: Vec<u64>,
    }

    /// Plays a script: topic changes at the block boundaries. A trigger is
    /// right when it falls within `window` of a boundary.
    fn play(lang: Lang, seed: u64, blocks: &[(usize, u64)], cfg: TopicConfig, window_ms: u64) -> Score {
        let utt = conversation(lang, seed, blocks, 5, 12);
        let mut d = TopicDetector::new(cfg);
        let mut boundaries = Vec::new();
        let mut t = 0;
        for (_, secs) in blocks {
            boundaries.push(t);
            t += secs * 1000;
        }
        let mut hits: Vec<u64> = Vec::new();
        for u in &utt {
            d.push(u.ms, &u.text);
            if d.poll(u.ms + 4_000) {
                hits.push(u.ms + 4_000);
            }
        }
        let mut s = Score { false_triggers: 0, missed: 0, late_ms: vec![] };
        for h in &hits {
            if !boundaries.iter().skip(1).any(|b| *h >= *b && *h <= *b + window_ms) {
                s.false_triggers += 1;
            }
        }
        for b in boundaries.iter().skip(1) {
            match hits.iter().find(|h| **h >= *b && **h <= *b + window_ms) {
                Some(h) => s.late_ms.push(h - b),
                None => s.missed += 1,
            }
        }
        s
    }

    const SCRIPT: &[(usize, u64)] = &[(0, 300), (1, 300), (2, 300), (3, 300), (0, 300), (2, 300)];

    #[test]
    fn scripted_conversations_in_three_languages() {
        let mut total_false = 0;
        let mut total_missed = 0;
        let mut lates: Vec<u64> = Vec::new();
        let mut n = 0;
        for lang in ALL_LANGS {
            for seed in 1..=8u64 {
                let s = play(lang, seed, SCRIPT, TopicConfig::default(), 90_000);
                total_false += s.false_triggers;
                total_missed += s.missed;
                lates.extend(s.late_ms);
                n += 1;
            }
        }
        lates.sort();
        let median = lates[lates.len() / 2];
        let p90 = lates[lates.len() * 9 / 10];
        eprintln!("topic detector: runs={n} false={total_false} missed={total_missed} median_late={median}ms p90_late={p90}ms");
        assert_eq!(total_false, 0, "false triggers");
        assert_eq!(total_missed, 0, "missed changes");
        assert!(median <= 60_000, "median {median}");
    }

    #[test]
    fn long_single_topic_does_not_trigger() {
        for lang in ALL_LANGS {
            for seed in 1..=5u64 {
                let s = play(lang, seed, &[(1, 1800)], TopicConfig::default(), 90_000);
                assert_eq!(s.false_triggers, 0, "{lang:?} seed {seed}");
            }
        }
    }

    #[test]
    fn quick_back_and_forth_fires_once_per_change() {
        // A->B->A with 150 s blocks: each real change is detected at most once
        let script: &[(usize, u64)] = &[(0, 240), (1, 150), (0, 150), (1, 150)];
        for lang in ALL_LANGS {
            let s = play(lang, 3, script, TopicConfig::default(), 90_000);
            assert_eq!(s.false_triggers, 0, "{lang:?}");
        }
    }

    #[test]
    fn too_little_speech_says_nothing() {
        let mut d = TopicDetector::new(TopicConfig::default());
        d.push(0, "hello there");
        d.push(70_000, "completely different words appear now");
        assert_eq!(d.novelty(75_000), None);
        assert!(!d.poll(75_000));
    }

    #[test]
    fn reset_forgets() {
        let mut d = TopicDetector::new(TopicConfig::default());
        for u in conversation(Lang::En, 1, &[(0, 240)], 5, 12) {
            d.push(u.ms, &u.text);
        }
        assert!(d.novelty(239_000).is_some());
        d.reset();
        assert!(d.novelty(239_000).is_none());
    }

    #[test]
    fn cjk_only_chinese_works_too() {
        let mut d = TopicDetector::new(TopicConfig::default());
        let a = ["预算 收入 利润 发票 季度 支出 工资 审计 供应商 合同 价格 折扣 成本 利率 预测 账单 报销 采购 税务 融资 折旧 库存 汇率 结算", "候选人 面试 招聘 薪水 录用 培训 工程师 经理 推荐 人数 福利 简历 入职 考核 晋升 招募 简报 猎头 实习 试用 面谈 离职 调岗 编制"];
        let mut r = crate::live_eval::scripted::Rng(5);
        let mut fired = Vec::new();
        for i in 0..120u64 {
            let t = i * 5_000;
            let words: Vec<&str> = a[if t < 300_000 { 0 } else { 1 }].split(' ').collect();
            let line: String = (0..6).map(|_| words[r.below(words.len())]).collect::<Vec<_>>().join("的");
            d.push(t, &line);
            if d.poll(t + 4_000) {
                fired.push(t);
            }
        }
        assert_eq!(fired.len(), 1, "{fired:?}");
        assert!(fired[0] >= 300_000 && fired[0] <= 390_000);
    }
}
