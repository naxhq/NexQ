/** Labelled cases for "Go to ..." suggestions (development set). */
import type { NoteBlock } from "../tokenize";
import { NOTES, corrupt } from "./notes-and-runner";
import { EXTRA_NOTES } from "./extra-notes";

const mk = (prefix: string, texts: string[]): NoteBlock[] => texts.map((text, i) => ({ id: `${prefix}${i + 1}`, text }));

export const SUGGEST_NOTES: Record<string, NoteBlock[]> = {
  en: NOTES.en,
  es: NOTES.es,
  de: NOTES.de,
  ja: NOTES.ja,
  zh: EXTRA_NOTES.zh,
  ko: EXTRA_NOTES.ko,
  fr: mk("fr", [
    "Bienvenue à tous, aujourd'hui je présente les résultats du trimestre et le plan de recrutement.",
    "Le chiffre d'affaires a progressé de 20 pour cent grâce aux renouvellements des grands comptes.",
    "Le taux de départ des clients est passé de 4,5 pour cent à 3 pour cent après la refonte de l'intégration.",
    "Notre principal risque est la dépendance à un seul fournisseur cloud pour l'inférence.",
    "Pour l'atténuer, nous migrerons vers une architecture multicloud avant septembre 2026.",
    "La feuille de route repose sur trois piliers : fiabilité, rapidité et collaboration.",
    "Nous allons recruter 12 ingénieurs et 4 designers avant la fin de l'année.",
    "Merci, je partagerai les diapositives et l'enregistrement de la démo demain matin.",
  ]),
  pt: mk("pt", [
    "Bem-vindos, hoje apresento os resultados do trimestre e o plano de contratação.",
    "A receita cresceu 20 por cento graças às renovações de grandes clientes.",
    "A taxa de cancelamento caiu de 4,5 por cento para 3 por cento depois de reconstruirmos a integração.",
    "O maior risco é a dependência de um único fornecedor de nuvem para a inferência.",
    "Para mitigar, vamos migrar para uma arquitetura multinuvem antes de setembro de 2026.",
    "O roteiro tem três pilares: confiabilidade, velocidade e colaboração.",
    "Vamos contratar 12 engenheiros e 4 designers antes do fim do ano.",
    "Obrigado, compartilharei os slides e a gravação da demonstração amanhã de manhã.",
  ]),
  ar: mk("ar", [
    "مرحبا بالجميع، اليوم سأعرض نتائج الربع وخطة التوظيف.",
    "نمت الإيرادات بنسبة 20 بالمئة بفضل تجديد عقود العملاء الكبار.",
    "انخفض معدل فقدان العملاء من 4.5 بالمئة إلى 3 بالمئة بعد إعادة بناء تجربة الانضمام.",
    "أكبر مخاطرنا هو الاعتماد على مزود سحابي واحد للاستدلال.",
    "للتخفيف سننتقل إلى بنية متعددة السحابات قبل سبتمبر 2026.",
    "خارطة الطريق لها ثلاثة أركان: الموثوقية والسرعة والتعاون.",
    "نخطط لتوظيف 12 مهندسا و4 مصممين قبل نهاية العام.",
    "شكرا لكم، سنشارك الشرائح وتسجيل العرض غدا صباحا.",
  ]),
};

export interface SuggestCase {
  name: string;
  lang: string;
  /** How speech is cut into interim chunks. */
  cut: "words" | "chars";
  /** 1-based blocks read word for word before the line. */
  setup: number[];
  say: string;
  /** 1-based block that should be offered, or null when nothing should be. */
  expect: number | null;
}

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, k) => a + k);

const cases: SuggestCase[] = [];
const add = (lang: string, name: string, setup: number[], say: string, expect: number | null) =>
  cases.push({ name: `${lang} ${name}`, lang, cut: lang === "ja" || lang === "zh" ? "chars" : "words", setup, say, expect });

// ---- English (the main set)
const en = NOTES.en;
const T = (i: number) => en[i - 1].text;
add("en", "verbatim 5", [1, 2], T(5), 5);
add("en", "verbatim 9", [1, 2], T(9), 9);
add("en", "paraphrase 6", [1, 2], "For mitigation we are going to move to a multi cloud setup with Kubernetes by September 2025", 6);
add("en", "paraphrase 10", [1, 2], "Collaboration is about shared workspaces and comments plus a public API that partners can use", 10);
add("en", "paraphrase 11", [1, 2], "We are planning to bring on twelve engineers and four designers before the end of 2026", 11);
add("en", "heading pricing", [1, 2], "now let us talk about pricing and the team plan", 13);
add("en", "heading budget", [1, 2], "let's move on to the hiring budget approved by the board", 12);
add("en", "back churn", range(1, 8), "going back to churn, it dropped from four point five percent to three percent after the onboarding rebuild", 4);
add("en", "back risk", range(1, 7), "just to repeat, our biggest risk is depending on one single cloud vendor for inference", 5);
add("en", "back agenda", range(1, 6), "so again the agenda is results, the roadmap and the hiring plan", 1);
add("en", "skip sections 8", [1], "reliability means ninety nine point nine percent uptime and automated failover", 8);
add("en", "skip sections 14", [1, 2, 3], "to wrap up the slides and the demo recording will be shared tomorrow morning", 14);
add("en", "off-script chat 1", [1, 2], "Okay let me just check that everyone can hear me before we begin, the sound seemed a bit off earlier.", null);
add("en", "off-script chat 2", [1, 2], "I made some coffee this morning and the machine in the kitchen is making a strange noise again", null);
add("en", "off-script trip", range(1, 5), "that reminds me of a trip last summer when we drove along the coast and stopped at a tiny bakery near the harbour", null);
add("en", "off-script board", range(1, 4), "the board meeting last year was long and the budget discussion took hours but we survived", null);
add("en", "off-script later", range(1, 4), "we should probably talk about it later, maybe next week, once everyone has had time to think", null);
add("en", "off-script quarter", range(1, 4), "honestly last year the weather was awful and nobody wanted to talk about quarter results at all", null);
add("en", "continues with next", [1, 2], T(3), null);
add("en", "continues two on", [1, 2, 3], T(4), null);
add("en", "repeats current", [1, 2, 3], "as I said revenue grew thirty five percent in the second quarter", null);

// ---- other languages: verbatim far, paraphrase far, back reference, skip, two off-script lines
interface Lx {
  p6: string;
  back2: string;
  neg: [string, string];
}
const LX: Record<string, Lx> = {
  es: {
    p6: "La hoja de ruta se apoya en tres pilares: fiabilidad, velocidad y colaboración.",
    back2: "Volviendo a los ingresos, crecieron un 20 por ciento gracias a las renovaciones de grandes clientes.",
    neg: ["Por cierto, ayer vi el partido y el árbitro fue una vergüenza total, no entiendo cómo siguen así.", "Déjame comprobar que todos me oyen antes de empezar, voy a por un café."],
  },
  de: {
    p6: "Die Roadmap steht auf drei Säulen: Zuverlässigkeit, Geschwindigkeit und Zusammenarbeit.",
    back2: "Zurück zum Umsatz: Er ist im ersten Quartal um 20 Prozent gestiegen, getrieben von Verlängerungen bei Großkunden.",
    neg: ["Übrigens, haben Sie gestern das Spiel gesehen? Der Schiedsrichter war wirklich schwach, das kann man nicht anders sagen.", "Lassen Sie mich kurz prüfen, ob mich alle hören, bevor wir anfangen, ich hole einen Kaffee."],
  },
  ja: {
    p6: "ロードマップは、信頼性と速度と共同作業という三つの柱で構成されます。",
    back2: "売上の話に戻ると、第一四半期に20パーセント増加して、大口顧客の契約更新が牽引しました。",
    neg: ["ところで昨日の試合を見ましたか、審判の判定がひどくて本当に驚きました、あれはないですよね。", "始める前に皆さんに声が聞こえているか確認させてください、コーヒーを取ってきます。"],
  },
  zh: {
    p6: "路线图主要围绕三个支柱，也就是可靠性、速度还有协作。",
    back2: "回到收入，第一季度增长了20%，主要得益于大客户续约。",
    neg: ["对了，你昨晚看比赛了吗，裁判真的很差，而且今天天气很冷。", "让我先确认大家都能听到我说话，然后我去倒杯咖啡。"],
  },
  ko: {
    p6: "로드맵은 안정성과 속도, 그리고 협업이라는 세 가지 축으로 되어 있습니다.",
    back2: "매출로 돌아가면 대기업 고객의 계약 갱신 덕분에 첫 번째 분기 매출이 20퍼센트 성장했습니다.",
    neg: ["그런데 어제 경기 보셨어요, 심판이 정말 형편없었고 오늘은 날씨도 춥네요.", "시작하기 전에 다들 제 목소리가 들리는지 확인하고 커피를 가져올게요."],
  },
  fr: {
    p6: "Notre feuille de route s'appuie sur trois piliers, la fiabilité, la rapidité et la collaboration.",
    back2: "Pour revenir au chiffre d'affaires, il a progressé de 20 pour cent grâce aux renouvellements de grands comptes.",
    neg: ["Au fait, tu as vu le match hier soir, l'arbitre était vraiment nul et il fait froid dehors.", "Laissez-moi vérifier que tout le monde m'entend avant de commencer, je prends un café."],
  },
  pt: {
    p6: "Nosso roteiro se apoia em três pilares: confiabilidade, velocidade e colaboração.",
    back2: "Voltando à receita, ela cresceu 20 por cento graças às renovações dos grandes clientes.",
    neg: ["A propósito, você viu o jogo ontem à noite, o árbitro foi péssimo e está frio hoje.", "Deixe-me confirmar que todos me ouvem antes de começar, vou buscar um café."],
  },
  ar: {
    p6: "تقوم خارطة الطريق على ثلاثة أركان هي الموثوقية والسرعة والتعاون.",
    back2: "عودة إلى الإيرادات، فقد نمت بنسبة 20 بالمئة بسبب تجديد عقود كبار العملاء.",
    neg: ["بالمناسبة هل شاهدتم المباراة أمس كان الحكم سيئا جدا والطقس بارد اليوم.", "دعوني أتأكد أن الجميع يسمعني قبل أن نبدأ سأحضر كوب قهوة."],
  },
};
for (const [lang, x] of Object.entries(LX)) {
  const n = SUGGEST_NOTES[lang];
  add(lang, "verbatim 5", [1, 2], n[4].text, 5);
  add(lang, "paraphrase 6", [1, 2], x.p6, 6);
  add(lang, "back 2", range(1, 5), x.back2, 2);
  add(lang, "skip 7", [1, 2, 3], n[6].text, 7);
  add(lang, "off-script 1", [1, 2], x.neg[0], null);
  add(lang, "off-script 2", range(1, 4), x.neg[1], null);
  add(lang, "continues next", [1, 2], n[2].text, null);
}

// ---- harder: ASR errors (15% WER) and half a line only
for (const lang of ["en", "es", "de", "fr", "pt"]) {
  const n = SUGGEST_NOTES[lang];
  const l = lang === "en" || lang === "es" || lang === "de" ? lang : "en";
  add(lang, "noisy verbatim 5", [1, 2], corrupt(n[4].text, 0.15, 11, l), 5);
  add(lang, "noisy skip 7", [1, 2, 3], corrupt(n[6].text, 0.15, 12, l), 7);
  const words = n[5].text.split(" ");
  add(lang, "half a line 6", [1, 2], words.slice(Math.floor(words.length / 2)).join(" "), 6);
}
add("en", "noisy heading", [1, 2], corrupt("let us talk about pricing and the team plan", 0.15, 5, "en"), 13);
add("en", "noisy back", range(1, 8), corrupt("going back to churn, it dropped from four point five percent to three percent after the onboarding rebuild", 0.15, 7, "en"), 4);

export const SUGGEST_CASES: SuggestCase[] = cases;
