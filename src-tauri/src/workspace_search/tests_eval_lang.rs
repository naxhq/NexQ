//! A small recall eval for German, Spanish and French (Chinese and Japanese
//! are in `tests_eval`): one index with all three languages and their filler,
//! natural-language questions with their question words and accents, and a few
//! asked without accents. Every question must find its meeting in the first 8.

use super::search::search;
use super::test_support::{index_lines, mem_db};
use super::{PassageKind, SearchScope};

struct Case {
    id: &'static str,
    fact: &'static str,
    question: &'static str,
}

const DE: [Case; 4] = [
    Case { id: "de1", fact: "Das Budget für das Projekt Adler wurde auf vierzigtausend Euro festgelegt.", question: "Wie hoch ist das Budget für das Projekt Adler?" },
    Case { id: "de2", fact: "Der Vertrag mit dem Lieferanten Müller läuft im Oktober aus und muss erneuert werden.", question: "Wann läuft der Vertrag mit dem Lieferanten Müller aus?" },
    Case { id: "de3", fact: "Die Schulung der neuen Mitarbeiter findet im März in Hamburg statt.", question: "Wo findet die Schulung der neuen Mitarbeiter statt?" },
    Case { id: "de4", fact: "Wir haben beschlossen, den Server in Frankfurt auf die neue Version zu aktualisieren.", question: "Was wurde über den Server in Frankfurt beschlossen?" },
];
const ES: [Case; 4] = [
    Case { id: "es1", fact: "El presupuesto del proyecto Colibrí se fijó en cincuenta mil euros.", question: "¿Cuál es el presupuesto del proyecto Colibrí?" },
    Case { id: "es2", fact: "El contrato con el proveedor Rodríguez vence en noviembre y hay que renovarlo.", question: "¿Cuándo vence el contrato con el proveedor Rodríguez?" },
    Case { id: "es3", fact: "La formación de los nuevos empleados será en abril en Valencia.", question: "¿Dónde será la formación de los nuevos empleados?" },
    Case { id: "es4", fact: "Decidimos migrar la base de datos de Sevilla a la nueva plataforma.", question: "¿Qué se decidió sobre la base de datos de Sevilla?" },
];
const FR: [Case; 4] = [
    Case { id: "fr1", fact: "Le budget du projet Hirondelle a été fixé à soixante mille euros.", question: "Quel est le budget du projet Hirondelle ?" },
    Case { id: "fr2", fact: "Le contrat avec le fournisseur Lefèvre expire en décembre et doit être renouvelé.", question: "Quand expire le contrat avec le fournisseur Lefèvre ?" },
    Case { id: "fr3", fact: "La formation des nouveaux employés aura lieu en mai à Lyon.", question: "Où aura lieu la formation des nouveaux employés ?" },
    Case { id: "fr4", fact: "Nous avons décidé de migrer le serveur de Bordeaux vers la nouvelle plateforme.", question: "Qu'est-ce qui a été décidé pour le serveur de Bordeaux ?" },
];

const FILLER_DE: [&str; 5] = [
    "Wir sollten das Budget später noch einmal prüfen.",
    "Der Vertrag ist noch offen und wird bald besprochen.",
    "Die Schulung wurde im Team kurz erwähnt.",
    "Der Server läuft im Moment stabil, es gibt nichts Neues.",
    "Bitte schickt die Unterlagen nach dem Treffen an alle.",
];
const FILLER_ES: [&str; 5] = [
    "Deberíamos revisar el presupuesto más adelante.",
    "El contrato sigue abierto y se hablará pronto.",
    "La formación se mencionó brevemente en el equipo.",
    "La base de datos funciona bien por ahora, sin novedades.",
    "Por favor, enviad los documentos después de la reunión.",
];
const FILLER_FR: [&str; 5] = [
    "Nous devrions revoir le budget plus tard.",
    "Le contrat est encore ouvert et sera discuté bientôt.",
    "La formation a été mentionnée brièvement dans l'équipe.",
    "Le serveur fonctionne bien pour l'instant, rien de nouveau.",
    "Merci d'envoyer les documents après la réunion.",
];

fn lines_of(fact: &str, filler: &[&str; 5], salt: usize) -> Vec<(String, String, i64)> {
    let mut out: Vec<(String, String, i64)> = Vec::new();
    for i in 0..14 {
        let t = if i == 6 { fact.to_string() } else { filler[(i + salt) % 5].to_string() };
        out.push((if i % 2 == 0 { "You" } else { "Them" }.to_string(), t, i as i64 * 5000));
    }
    out
}

#[test]
fn german_spanish_and_french_questions_find_their_meeting() {
    let conn = mem_db();
    let mut ids: Vec<String> = Vec::new();
    let mut questions: Vec<(String, String)> = Vec::new();
    for (cases, filler) in [(&DE, &FILLER_DE), (&ES, &FILLER_ES), (&FR, &FILLER_FR)] {
        for (n, c) in cases.iter().enumerate() {
            let rows = lines_of(c.fact, filler, n);
            let refs: Vec<(&str, &str, i64)> = rows.iter().map(|(s, t, ms)| (s.as_str(), t.as_str(), *ms)).collect();
            index_lines(&conn, c.id, c.id, 1_700_000_000_000, &refs);
            ids.push(c.id.to_string());
            questions.push((c.question.to_string(), c.id.to_string()));
        }
        // meetings with filler only
        for k in 0..4 {
            let id = format!("{}-filler{k}", cases[0].id);
            let rows = lines_of("Nichts Besonderes.", filler, k + 1);
            let refs: Vec<(&str, &str, i64)> = rows.iter().map(|(s, t, ms)| (s.as_str(), t.as_str(), *ms)).collect();
            index_lines(&conn, &id, &id, 1_700_000_000_000, &refs);
            ids.push(id);
        }
    }
    // a few asked without the accents
    questions.push(("Wann lauft der Vertrag mit dem Lieferanten Muller aus?".into(), "de2".into()));
    questions.push(("Cuando vence el contrato con el proveedor Rodriguez?".into(), "es2".into()));
    questions.push(("Quand expire le contrat avec le fournisseur Lefevre ?".into(), "fr2".into()));
    // and a keyword query
    questions.push(("Hirondelle budget".into(), "fr1".into()));
    questions.push(("Colibri presupuesto".into(), "es1".into()));

    let scope = SearchScope::with_meetings(ids);
    let mut hits = 0;
    let mut misses = Vec::new();
    for (q, gold) in &questions {
        let r = search(&conn, &scope, q, &[PassageKind::Transcript], 8).unwrap();
        if r.iter().any(|p| &p.ref_id == gold) {
            hits += 1;
        } else {
            misses.push(format!("{q} (gold {gold}; got {:?})", r.iter().map(|p| p.ref_id.clone()).collect::<Vec<_>>()));
        }
    }
    let recall = hits as f64 / questions.len() as f64;
    eprintln!("language eval: {} questions, hit@8 = {:.3}", questions.len(), recall);
    for m in &misses {
        eprintln!("  miss: {m}");
    }
    assert!(recall >= 0.9, "hit@8 {recall:.3}; misses: {misses:?}");
}

#[test]
fn a_word_that_is_common_in_one_language_is_not_lost_from_a_short_query() {
    use super::search::parse_query;
    // "war" is a German stopword and an English content word; "die" and "son" likewise
    assert_eq!(parse_query("war").words, vec!["war"]);
    assert_eq!(parse_query("die son").words, vec!["die", "son"]);
    // a long question is thinned of the question words of all four languages
    let q = parse_query("Wie hoch ist das Budget für das Projekt Adler");
    assert_eq!(q.words, vec!["hoch", "budget", "projekt", "adler"]);
    let q = parse_query("¿Cuál es el presupuesto del proyecto Colibrí?");
    assert_eq!(q.words, vec!["presupuesto", "proyecto", "colibrí"]);
}

const FILLER_ZH: [&str; 5] = [
    "今天我们先确认一下议程。",
    "请大家在下次会议前准备好材料。",
    "关于预算和时间安排我们简单聊了一下。",
    "合同的内容还需要再确认。",
    "整体进度正常，但需要注意风险。",
];
const FILLER_JA: [&str; 5] = [
    "今日はまず議題を確認しましょう。",
    "次回の会議までに資料を準備してください。",
    "予算とスケジュールについて簡単に話しました。",
    "契約の内容はもう一度確認が必要です。",
    "全体の進捗は順調ですが、リスクに注意が必要です。",
];
const ZH: [Case; 3] = [
    Case { id: "zh1", fact: "供应商审核将在四月完成，预算上限是二十万元。", question: "供应商审核什么时候完成？" },
    Case { id: "zh2", fact: "新产品的发布日期推迟到六月十二日。", question: "新产品发布日期是什么时候？" },
    Case { id: "zh3", fact: "客户培训计划由王芳负责，下个月开始。", question: "客户培训计划谁负责？" },
];
const JA: [Case; 3] = [
    Case { id: "ja1", fact: "来月のゴールドマン案件の契約更新は三月十日までに完了する予定です。", question: "ゴールドマン案件の契約更新はいつまでですか？" },
    Case { id: "ja2", fact: "セキュリティ監査の担当者は田中さんで、報告書は五月末が期限です。", question: "セキュリティ監査の担当は誰ですか？" },
    Case { id: "ja3", fact: "新製品のベータ版リリースは七月十五日に決まりました。", question: "ベータ版のリリース日はいつですか？" },
];

#[test]
fn chinese_and_japanese_questions_find_their_meeting_in_a_mixed_index() {
    let conn = mem_db();
    let mut ids: Vec<String> = Vec::new();
    let mut questions: Vec<(String, String)> = Vec::new();
    // the Latin-script languages sit in the same index, as they do for a real user
    for (cases, filler) in [(&DE, &FILLER_DE), (&FR, &FILLER_FR)] {
        for (n, c) in cases.iter().enumerate() {
            let rows = lines_of(c.fact, filler, n);
            let refs: Vec<(&str, &str, i64)> = rows.iter().map(|(s, t, ms)| (s.as_str(), t.as_str(), *ms)).collect();
            index_lines(&conn, c.id, c.id, 1_700_000_000_000, &refs);
            ids.push(c.id.to_string());
        }
    }
    for (cases, filler) in [(&ZH, &FILLER_ZH), (&JA, &FILLER_JA)] {
        for (n, c) in cases.iter().enumerate() {
            let rows = lines_of(c.fact, filler, n);
            let refs: Vec<(&str, &str, i64)> = rows.iter().map(|(s, t, ms)| (s.as_str(), t.as_str(), *ms)).collect();
            index_lines(&conn, c.id, c.id, 1_700_000_000_000, &refs);
            ids.push(c.id.to_string());
            questions.push((c.question.to_string(), c.id.to_string()));
        }
    }
    let scope = SearchScope::with_meetings(ids);
    let mut misses = Vec::new();
    for (q, gold) in &questions {
        let r = search(&conn, &scope, q, &[PassageKind::Transcript], 8).unwrap();
        if !r.iter().any(|p| &p.ref_id == gold) {
            misses.push(format!("{q} (gold {gold}; got {:?})", r.iter().map(|p| p.ref_id.clone()).collect::<Vec<_>>()));
        }
    }
    assert!(misses.is_empty(), "zh/ja hit@8 below 1.0: {misses:?}");
}
