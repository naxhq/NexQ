//! Deterministic scripted conversations (English, Spanish, Japanese) for the
//! topic detector, the engines' simulations and the evals. Topic words come
//! from small real vocabularies; "noise" words (small talk, names, odd terms)
//! come from a larger generated pool, so a topic never repeats itself too
//! cleanly.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    En,
    Es,
    Ja,
}

pub const ALL_LANGS: [Lang; 3] = [Lang::En, Lang::Es, Lang::Ja];

#[derive(Debug, Clone)]
pub struct Utter {
    /// Start of the line.
    pub ms: u64,
    pub text: String,
    /// Index into the script (which topic block this line belongs to).
    pub topic: usize,
}

pub struct Rng(pub u64);

impl Rng {
    pub fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (self.0 >> 33) as u32
    }
    pub fn below(&mut self, n: usize) -> usize {
        (self.next() as usize) % n.max(1)
    }
    pub fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }
}

const EN_TOPICS: [&str; 4] = [
    "budget forecast revenue margin invoice quarter spending payroll expense audit ledger cashflow vendor contract pricing discount subscription renewal",
    "candidate interview recruiter salary offer onboarding engineer manager referral headcount probation mentor benefits relocation applicant resume hiring screening",
    "release feature beta rollout bugfix deployment roadmap sprint backlog testing staging server latency migration rollback checklist feedback changelog",
    "flight hotel offsite venue catering agenda keynote workshop booking visa itinerary shuttle conference reservation teambuilding dinner airport luggage",
];
const EN_FUNC: &str = "we need to the and that this about think should really just maybe going also have been with they what";

const ES_TOPICS: [&str; 4] = [
    "presupuesto previsión ingresos margen factura trimestre gastos nómina auditoría proveedor contrato precios descuento suscripción renovación facturación",
    "candidato entrevista reclutador salario oferta incorporación ingeniero gerente referido plantilla contratación beneficios reubicación solicitante currículum",
    "lanzamiento función versión despliegue errores hoja ruta sprint pruebas servidor latencia migración reversión lista comentarios cambios",
    "vuelo hotel evento sede catering agenda ponencia taller reserva visado itinerario transporte conferencia reservación cena aeropuerto equipaje",
];
const ES_FUNC: &str = "necesitamos que los las para con una pero como esto entonces bueno creo ahora también sobre muy hay vamos";

const JA_TOPICS: [&str; 4] = [
    "予算 売上 利益 請求書 四半期 支出 給与 監査 取引先 契約 価格 割引 更新 経費 決算 見積",
    "候補者 面接 採用 給与 内定 研修 技術者 管理職 紹介 人員 試用期間 福利厚生 転勤 応募者 履歴書 選考",
    "リリース 機能 ベータ 展開 バグ修正 計画 スプリント 試験 サーバー 遅延 移行 巻き戻し 確認表 改善 変更履歴 開発",
    "航空券 ホテル 合宿 会場 ケータリング 日程 基調講演 研修会 予約 査証 旅程 送迎 会議 夕食 空港 荷物",
];
const JA_PARTICLES: [&str; 6] = ["の", "を", "は", "が", "に", "で"];
const JA_ENDINGS: [&str; 4] = ["です。", "ます。", "ですね。", "でした。"];

fn syllable_word(r: &mut Rng, lang: Lang) -> String {
    let cons = ["b", "d", "f", "g", "k", "l", "m", "n", "p", "r", "s", "t", "v", "z", "ch", "st", "br"];
    let vows = ["a", "e", "i", "o", "u"];
    let syll = match lang {
        Lang::Es => 3,
        _ => 2,
    } + r.below(2);
    let mut w = String::new();
    for _ in 0..syll {
        w.push_str(r.pick(&cons));
        w.push_str(r.pick(&vows));
    }
    if lang == Lang::En && r.below(2) == 0 {
        w.push_str(r.pick(&["n", "r", "s", "t", "l"]));
    }
    w
}

const KANJI: &str = "山川田森林空海風雨雪花草石金木水火土日月星雲朝夜春夏秋冬犬猫鳥魚馬牛羊虫道駅橋店窓机椅本紙筆音色光影";

fn kanji_word(r: &mut Rng) -> String {
    let k: Vec<char> = KANJI.chars().collect();
    let n = 2 + r.below(2);
    (0..n).map(|_| k[r.below(k.len())]).collect()
}

/// The vocabulary of one topic.
pub fn topic_words(lang: Lang, topic: usize) -> Vec<&'static str> {
    let src = match lang {
        Lang::En => EN_TOPICS[topic % 4],
        Lang::Es => ES_TOPICS[topic % 4],
        Lang::Ja => JA_TOPICS[topic % 4],
    };
    src.split_whitespace().collect()
}

/// One utterance of about `words` words (Japanese: about words*0.6 items).
pub fn utterance(lang: Lang, topic: usize, noise: &[String], r: &mut Rng, words: usize) -> String {
    let topic_words = topic_words(lang, topic);
    match lang {
        Lang::Ja => {
            let mut s = String::new();
            let n = (words * 6 / 10).max(3);
            for i in 0..n {
                let roll = r.below(100);
                if roll < 60 {
                    s.push_str(r.pick(&topic_words));
                } else {
                    s.push_str(r.pick(noise));
                }
                if i + 1 < n {
                    s.push_str(r.pick(&JA_PARTICLES));
                }
            }
            s.push_str(r.pick(&JA_ENDINGS));
            s
        }
        _ => {
            let func: Vec<&str> = if lang == Lang::En { EN_FUNC } else { ES_FUNC }.split_whitespace().collect();
            let mut out: Vec<String> = Vec::new();
            for _ in 0..words {
                let roll = r.below(100);
                let w = if roll < 45 {
                    r.pick(&topic_words).to_string()
                } else if roll < 65 {
                    r.pick(noise).clone()
                } else {
                    r.pick(&func).to_string()
                };
                out.push(w);
            }
            let mut s = out.join(" ");
            if let Some(c) = s.get(0..1) {
                let up = c.to_uppercase();
                s.replace_range(0..1, &up);
            }
            s.push('.');
            s
        }
    }
}

pub fn noise_pool(lang: Lang, r: &mut Rng, size: usize) -> Vec<String> {
    (0..size).map(|_| if lang == Lang::Ja { kanji_word(r) } else { syllable_word(r, lang) }).collect()
}

/// A conversation as consecutive blocks `(topic, seconds)`, one line every
/// `line_secs` seconds of about `words_per_line` words (150 wpm = 12.5 per 5 s).
pub fn conversation(lang: Lang, seed: u64, blocks: &[(usize, u64)], line_secs: u64, words_per_line: usize) -> Vec<Utter> {
    let mut r = Rng(seed ^ 0xA5A5_5A5A_1234_4321);
    let noise = noise_pool(lang, &mut r, 70);
    let mut out = Vec::new();
    let mut t = 0u64;
    for (bi, (topic, secs)) in blocks.iter().enumerate() {
        let end = t + secs * 1000;
        while t < end {
            out.push(Utter { ms: t, text: utterance(lang, *topic, &noise, &mut r, words_per_line), topic: bi });
            t += line_secs * 1000;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_and_sized() {
        let a = conversation(Lang::En, 7, &[(0, 60), (1, 60)], 5, 12);
        let b = conversation(Lang::En, 7, &[(0, 60), (1, 60)], 5, 12);
        assert_eq!(a.len(), 24);
        assert_eq!(a.iter().map(|u| &u.text).collect::<Vec<_>>(), b.iter().map(|u| &u.text).collect::<Vec<_>>());
        let ja = conversation(Lang::Ja, 7, &[(2, 30)], 5, 12);
        assert!(ja[0].text.contains('。'));
        let words: usize = a.iter().map(|u| u.text.split_whitespace().count()).sum();
        assert_eq!(words, 24 * 12);
    }
}
