//! Retrieval eval: 42 synthetic meetings (32 English, 6 Japanese, 4 Chinese)
//! and 30 questions, each with one gold meeting. Reports hit@1 and hit@8 and
//! fails under the threshold. The English meetings share a pool of generic
//! filler sentences (budget, deadline, contract, owner...) so lexical
//! overlap between meetings is high; the gold facts are the only place where
//! the entity and topic words meet.
//!
//! Run with `--nocapture` to see the numbers.

use super::indexer::{run_pass, MeetingsOnly, RunControl};
use super::search::search;
use super::test_support::{add_meeting, mem_db};
use super::{PassageKind, SearchScope};

const ENTITIES: [&str; 32] = [
    "Kestrel", "Halvorsen", "Bluefin", "Orchid", "Tamarack", "Zephyr", "Marigold", "Obsidian", "Quasar",
    "Saffron", "Juniper", "Lodestar", "Mercury", "Nimbus", "Paragon", "Redwood", "Sapphire", "Tundra",
    "Umbra", "Vesper", "Wisteria", "Xylem", "Yarrow", "Zenith", "Aurora", "Basalt", "Cinder", "Drumlin",
    "Ember", "Fathom", "Garnet", "Harbor",
];
const TOPICS: [&str; 32] = [
    "freight contract", "security audit", "pilot cohort", "tender deadline", "onboarding flow",
    "data retention", "pricing tier", "office lease", "vendor invoice", "launch checklist",
    "training budget", "support rota", "warehouse migration", "partner webinar", "compliance review",
    "mobile release", "hiring plan", "demo environment", "cloud spend", "brand refresh",
    "outage postmortem", "loyalty program", "sales kickoff", "legal hold", "patch window",
    "customer survey", "api deprecation", "budget forecast", "design sprint", "insurance renewal",
    "reseller agreement", "capacity plan",
];
const OWNERS: [&str; 8] = ["Dana", "Ravi", "Mei", "Tomas", "Aisha", "Lars", "Priya", "Jonas"];
const MONTHS: [&str; 8] = ["January", "March", "April", "June", "August", "September", "October", "December"];

const FILLER: [&str; 24] = [
    "Let us go through the agenda and make sure everyone has the latest numbers.",
    "I think the budget is mostly fine but we should double check the assumptions.",
    "The deadline feels tight so we need clear owners for every open item.",
    "Can we revisit the contract language before the end of the quarter?",
    "Thanks for the update, that helps a lot with planning for the next sprint.",
    "We still need feedback from the customer success team on this proposal.",
    "There is some risk around the timeline but nothing blocking at the moment.",
    "Please send the slides after the meeting so the rest of the team can review.",
    "The vendor mentioned a possible price change, so keep an eye on the invoice.",
    "Let us park that topic and come back to it in the next planning session.",
    "Everyone agrees the priority is shipping something small and learning fast.",
    "The numbers from last month look better than expected, which is good news.",
    "We should write down the decision so nobody has to ask again next week.",
    "I will follow up by email with the details and the updated schedule.",
    "Does anyone have concerns about the approach or the resourcing for it?",
    "The legal team needs two weeks to review anything that touches the contract.",
    "Our main goal this quarter is reducing cost without hurting the roadmap.",
    "We could ask the platform team to help if the workload gets too heavy.",
    "Quick reminder that the all hands is on Thursday afternoon this week.",
    "Let us make sure the support rota covers the holiday period properly.",
    "Marketing wants an early look at the launch plan and the demo material.",
    "That is a fair point, we should measure it before making any changes.",
    "The security checklist is almost done, only a few items are left to confirm.",
    "Finance asked for an updated forecast so please share your estimates soon.",
];

const JP_FILLER: [&str; 8] = [
    "今日の議題について確認します。",
    "次回の会議までに資料を準備してください。",
    "予算と期限について少し話しました。",
    "契約の内容を確認する必要があります。",
    "担当者は後ほど連絡をお願いします。",
    "スケジュールに大きな問題はありません。",
    "ご意見があればお知らせください。",
    "進捗は順調ですが、注意が必要です。",
];

const ZH_FILLER: [&str; 6] = [
    "今天我们先确认一下议程。",
    "请大家在下次会议前准备好材料。",
    "关于预算和时间安排我们简单聊了一下。",
    "合同的内容还需要再确认。",
    "负责人会在稍后联系大家。",
    "整体进度正常，但需要注意风险。",
];

/// (fact sentences, question) per CJK meeting.
const JP: [(&str, &str, &str); 6] = [
    ("来月のゴールドマン案件の契約更新は三月十日までに完了する予定です。", "", "ゴールドマン案件の契約更新はいつまでですか？"),
    ("新しい物流倉庫の移転は第四四半期に延期され、予算は八百万円です。", "", "物流倉庫の移転はいつに延期されましたか？"),
    ("セキュリティ監査の担当者は田中さんで、報告書は五月末が期限です。", "", "セキュリティ監査の担当は誰ですか？"),
    ("採用面接の日程は来週の火曜日と木曜日に調整しました。", "", "採用面接はいつ行いますか？"),
    ("顧客満足度調査の結果は平均四点二でした。", "", "顧客満足度調査の結果はどうでしたか？"),
    ("新製品のベータ版リリースは七月十五日に決まりました。", "", "ベータ版のリリース日はいつですか？"),
];
const ZH: [(&str, &str); 4] = [
    ("供应商审核将在四月完成，预算上限是二十万元。", "供应商审核什么时候完成？"),
    ("新产品的发布日期推迟到六月十二日。", "新产品发布日期是什么时候？"),
    ("客户培训计划由王芳负责，下个月开始。", "客户培训计划谁负责？"),
    ("服务器迁移需要在周末停机四个小时。", "服务器迁移要停机多久？"),
];

struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 33
    }
    fn pick(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

pub struct Fixture {
    pub conn: rusqlite::Connection,
    pub meetings: Vec<String>,
    /// (question, gold meeting id)
    pub questions: Vec<(String, String)>,
}

pub fn build_fixture() -> Fixture {
    let mut conn = mem_db();
    let mut rng = Lcg(42);
    let mut meetings = Vec::new();
    let mut questions: Vec<(String, String)> = Vec::new();

    for i in 0..32 {
        let id = format!("en{i:02}");
        let (entity, topic) = (ENTITIES[i], TOPICS[i]);
        let owner = OWNERS[i % OWNERS.len()];
        let month = MONTHS[(i * 3) % MONTHS.len()];
        let amount = 12 + (i * 7) % 90;
        let f1 = format!("{owner} will own the {entity} {topic} and the deadline is {month} {}.", 3 + i % 25);
        let f2 = format!("We agreed the {entity} {topic} budget is {amount}000 dollars.");
        let mut lines: Vec<String> = (0..60).map(|_| FILLER[rng.pick(FILLER.len())].to_string()).collect();
        // decoy: another meeting's topic phrase without its entity
        let decoy_topic = TOPICS[(i + 5) % 32];
        lines[7] = format!("Someone should look at the {decoy_topic} at some point.");
        lines[20] = f1;
        lines[41] = f2;
        let rows: Vec<(String, String, i64)> = lines
            .into_iter()
            .enumerate()
            .map(|(n, t)| ((if n % 2 == 0 { "You" } else { "Them" }).to_string(), t, n as i64 * 6000))
            .collect();
        let refs: Vec<(&str, &str, i64)> = rows.iter().map(|(s, t, ms)| (s.as_str(), t.as_str(), *ms)).collect();
        let day = 1 + (i * 11) % 28;
        add_meeting(&conn, &id, &format!("Sync {i}"), &format!("2026-0{}-{day:02}T10:00:00Z", 1 + i % 9), None, &refs);
        // question styles rotate: entity+topic, topic only, entity only paraphrase
        if i < 16 {
            let q = match i % 4 {
                0 => format!("Who owns the {entity} {topic} and when is it due?"),
                1 => format!("How much money was approved for the {topic} on {entity}?"),
                2 => format!("What is the deadline for the {topic}?"),
                _ => format!("Remind me what we decided regarding {entity} and the {topic}."),
            };
            questions.push((q, id.clone()));
        }
        meetings.push(id);
    }
    for (i, (fact, _, q)) in JP.iter().enumerate() {
        let id = format!("jp{i}");
        let mut lines: Vec<String> = (0..40).map(|_| JP_FILLER[rng.pick(JP_FILLER.len())].to_string()).collect();
        lines[15] = fact.to_string();
        let rows: Vec<(String, String, i64)> = lines
            .into_iter()
            .enumerate()
            .map(|(n, t)| ((if n % 2 == 0 { "You" } else { "Them" }).to_string(), t, n as i64 * 6000))
            .collect();
        let refs: Vec<(&str, &str, i64)> = rows.iter().map(|(s, t, ms)| (s.as_str(), t.as_str(), *ms)).collect();
        add_meeting(&conn, &id, &format!("会議{i}"), &format!("2026-0{}-15T10:00:00Z", 1 + i), None, &refs);
        questions.push((q.to_string(), id.clone()));
        meetings.push(id);
    }
    for (i, (fact, q)) in ZH.iter().enumerate() {
        let id = format!("zh{i}");
        let mut lines: Vec<String> = (0..40).map(|_| ZH_FILLER[rng.pick(ZH_FILLER.len())].to_string()).collect();
        lines[22] = fact.to_string();
        let rows: Vec<(String, String, i64)> = lines
            .into_iter()
            .enumerate()
            .map(|(n, t)| ((if n % 2 == 0 { "You" } else { "Them" }).to_string(), t, n as i64 * 6000))
            .collect();
        let refs: Vec<(&str, &str, i64)> = rows.iter().map(|(s, t, ms)| (s.as_str(), t.as_str(), *ms)).collect();
        add_meeting(&conn, &id, &format!("会议{i}"), &format!("2026-0{}-20T10:00:00Z", 1 + i), None, &refs);
        questions.push((q.to_string(), id.clone()));
        meetings.push(id);
    }
    // more English questions to reach 20 (second-fact phrasing for the last ones)
    for i in 20..24 {
        let (entity, topic) = (ENTITIES[i], TOPICS[i]);
        questions.push((format!("what was the budget for {entity} {topic}?"), format!("en{i:02}")));
    }
    let r = run_pass(&mut conn, &MeetingsOnly, &RunControl::idle(), &|_| {});
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    Fixture { conn, meetings, questions }
}

pub fn evaluate(f: &Fixture, k: usize) -> (f64, f64, Vec<String>) {
    let scope = SearchScope::with_meetings(f.meetings.clone());
    let (mut hit_k, mut hit_1) = (0usize, 0usize);
    let mut misses = Vec::new();
    for (q, gold) in &f.questions {
        let r = search(&f.conn, &scope, q, &[PassageKind::Transcript], k).unwrap();
        if r.iter().any(|p| &p.ref_id == gold) {
            hit_k += 1;
        } else {
            misses.push(format!("{q} (gold {gold}; got {:?})", r.iter().map(|p| p.ref_id.clone()).collect::<Vec<_>>()));
        }
        if r.first().map_or(false, |p| &p.ref_id == gold) {
            hit_1 += 1;
        }
    }
    let n = f.questions.len() as f64;
    (hit_k as f64 / n, hit_1 as f64 / n, misses)
}

#[test]
fn retrieval_eval_hit_at_8_is_at_least_90_percent() {
    let f = build_fixture();
    assert_eq!(f.meetings.len(), 42);
    assert_eq!(f.questions.len(), 30);
    let (h8, h1, misses) = evaluate(&f, 8);
    eprintln!("retrieval eval: {} meetings, {} questions, hit@1 = {:.3}, hit@8 = {:.3}", f.meetings.len(), f.questions.len(), h1, h8);
    for m in &misses {
        eprintln!("  miss: {m}");
    }
    assert!(h8 >= 0.9, "hit@8 {h8:.3} below 0.9; misses: {misses:?}");
    assert!(h1 >= 0.7, "hit@1 {h1:.3} below 0.7");
}

#[test]
fn eval_scope_filter_still_holds_inside_the_corpus() {
    let f = build_fixture();
    // restrict to Japanese meetings only: English questions find nothing, Japanese ones are found
    let scope = SearchScope::with_meetings(["jp0", "jp1", "jp2"]);
    let r = search(&f.conn, &scope, "Who owns the Kestrel freight contract?", &[], 8).unwrap();
    assert!(r.is_empty(), "{:?}", r.iter().map(|p| &p.ref_id).collect::<Vec<_>>());
    let r = search(&f.conn, &scope, "ゴールドマン案件の契約更新はいつまですか", &[], 8).unwrap();
    assert_eq!(r[0].ref_id, "jp0");
}
