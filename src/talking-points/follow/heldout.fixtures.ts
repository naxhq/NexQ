// Held-out scenarios, authored by hand without looking at the implementation.
export type Blk = { id: string; text: string };
export type Step =
  | { t: "say"; text: string; b: number; f0: number; f1: number; mode?: "stream" | "final"; interims?: string[]; jump?: boolean }
  | { t: "off"; text: string }
  | { t: "pause"; ms: number };
export interface Scenario {
  name: string; lang: string; blocks: Blk[]; steps: Step[];
  said: string[]; notSaid?: string[]; neg?: boolean; wer?: number;
}
const B = (arr: string[], p = "b"): Blk[] => arr.map((text, i) => ({ id: p + (i + 1), text }));
type SayStep = Extract<Step, { t: "say" }>;
const say = (text: string, b: number, f0 = 0, f1 = 1, extra: Partial<SayStep> = {}): Step => ({ t: "say", text, b, f0, f1, ...extra });
const off = (text: string): Step => ({ t: "off", text });
const pause = (ms: number): Step => ({ t: "pause", ms });
const verb = (blocks: Blk[], idx: number[]): Step[] => idx.map((i) => say(blocks[i].text, i));

export const N1 = B([
  "Welcome everyone and thanks for joining today",
  "Quarter three revenue grew twelve percent year over year",
  "Our new mobile app launches on March 14th",
  "The team is hiring five engineers in Berlin",
  "Key risk is the supply chain delay from our vendor",
  "Next steps are a pilot with Acme Corp and a budget review",
]);
const ALL6 = ["b1", "b2", "b3", "b4", "b5", "b6"];

const paraphraseSteps: Step[] = [
  say("okay hi everybody good to see you all thanks so much for joining us today", 0),
  say("so looking at the third quarter our revenue went up around twelve percent compared to the same time last year which is great", 1),
  say("and then the new mobile application is going to launch on the fourteenth of march so mark your calendars", 2),
  say("we are also hiring about five engineers over in Berlin", 3),
  say("the main risk really is that our vendor has delayed the supply chain", 4),
  say("so next we will run a pilot with Acme Corp and then do a budget review", 5),
];

const NI = B([
  "Revenue grew twelve percent in Europe this quarter",
  "Revenue grew twelve percent in Asia this quarter",
  "Margins improved two points in Europe",
  "Margins improved two points in Asia",
], "n");
const NUM = B(["ARR hit $4.2M in Q3", "SOC 2 audit completes by 11/30", "GPT-4o latency under 300 ms", "Roadmap v2.0 ships in H1 2027"], "k");
const SHORT = B(["Team: 5 people", "Demo starts at noon", "Questions?", "Thank you"], "s");
const HEAD = B([
  "Agenda", "Pricing", "Starter plan costs nine dollars per month", "Pro plan costs twenty nine dollars per month",
  "Security", "Data is encrypted at rest and in transit", "We pass a SOC 2 audit every year",
], "h");
const PUNCT = B([
  "Welcome, everyone! Thanks for joining us, today we will cover three topics.",
  "First: pricing, which is simple, nine dollars a month.",
  "Second: the roadmap, including v2.0 (Q3).",
  "Third: support, 24/7 chat and e-mail.",
], "p");

const en = (name: string, blocks: Blk[], steps: Step[], said: string[], notSaid?: string[], extra: Partial<Scenario> = {}): Scenario =>
  ({ name, lang: "en", blocks, steps, said, notSaid, ...extra });

const neg = (name: string, text: string): Scenario =>
  ({ name, lang: "en", blocks: N1, steps: [off(text)], said: [], neg: true });

const verbatimSteps = verb(N1, [0, 1, 2, 3, 4, 5]);

export const scenarios: Scenario[] = [
  en("en-verbatim", N1, verbatimSteps, ALL6),
  en("en-paraphrase-ramble", N1, paraphraseSteps, ALL6),
  en("en-restarts", N1, [
    say(N1[0].text, 0),
    say("I uh so what I what we did was uh quarter three revenue revenue grew twelve percent year over year", 1),
    say("our new our new mobile app launches launches on March 14th", 2),
    say("the team is um hiring hiring five engineers in in Berlin", 3),
  ], ["b1", "b2", "b3", "b4"], ["b5", "b6"]),
  en("en-pause-interrupt", N1, [
    ...verb(N1, [0, 1]), pause(300000),
    off("sorry about that where was I"),
    ...verb(N1, [2, 3]),
  ], ["b1", "b2", "b3", "b4"], ["b5", "b6"]),
  en("en-go-back", N1, [
    ...verb(N1, [0, 1, 2, 3]),
    say("going back to the revenue point for a second quarter three revenue grew twelve percent that was year over year", 1, 0, 1, { jump: true }),
    say(N1[4].text, 4),
  ], ["b1", "b2", "b3", "b4", "b5"], ["b6"]),
  en("en-skip-three", N1, [
    ...verb(N1, [0]),
    say(N1[4].text, 4, 0, 1, { jump: true }),
    say(N1[5].text, 5),
  ], ["b1", "b5", "b6"], ["b2", "b3", "b4"]),
  en("en-near-identical", NI, verb(NI, [0, 1, 2, 3]), ["n1", "n2", "n3", "n4"]),
  en("en-near-identical-skip-first", NI, [
    say("revenue grew twelve percent in Asia this quarter", 1),
    say("margins improved two points in Asia", 3),
  ], ["n2", "n4"], ["n1", "n3"]),
  en("en-numbers-acronyms", NUM, [
    say("annual recurring revenue hit four point two million dollars in quarter three", 0),
    say("our sock two audit completes by november thirtieth", 1),
    say("G P T four o latency is under three hundred milliseconds", 2),
    say("version two point oh of the roadmap ships in the first half of twenty twenty seven", 3),
  ], ["k1", "k2", "k3", "k4"]),
  en("en-offscript-question", N1, [
    ...verb(N1, [0, 1, 2]),
    off("do you think hiring more engineers will fix the supply chain delay"),
    off("well hiring is not really the issue the supply chain problem is with the vendor and they will take more time but five engineers in Berlin would not change that"),
    say(N1[5].text, 5, 0, 1, { jump: true }),
  ], ["b1", "b2", "b3", "b6"], ["b4", "b5"]),
  en("en-short-bullets", SHORT, [
    say("our team is five people", 0),
    say("the demo starts at noon", 1),
    say("any questions", 2),
    say("thank you", 3),
  ], ["s1", "s2", "s3", "s4"]),
  en("en-headings", HEAD, [
    say("starter plan costs nine dollars per month", 2),
    say("and the pro plan costs twenty nine dollars per month", 3),
    say("now on security", 4),
    say("all data is encrypted at rest and in transit", 5),
    say("and we pass a sock two audit every year", 6),
  ], ["h3", "h4", "h6", "h7"]),
  en("en-merged-final-60w", N1, [
    say("welcome everyone and thanks for joining today so quarter three revenue grew twelve percent year over year and our new mobile app launches on March 14th and also the team is hiring five engineers in Berlin which we are really excited about as you can imagine", 3, 0, 1, { mode: "final" }),
    say("key risk is the supply chain delay from our vendor and next steps are a pilot with Acme Corp and a budget review so that is basically everything", 5, 0, 1, { mode: "final" }),
  ], ALL6),
  en("en-no-punctuation-finals", PUNCT, [
    say("welcome everyone thanks for joining us today we will cover three topics", 0, 0, 1, { mode: "final" }),
    say("first pricing which is simple nine dollars a month", 1, 0, 1, { mode: "final" }),
    say("second the roadmap including version two point oh in quarter three", 2, 0, 1, { mode: "final" }),
    say("third support twenty four seven chat and email", 3, 0, 1, { mode: "final" }),
  ], ["p1", "p2", "p3", "p4"]),
  en("en-interim-revision", N1, [
    say(N1[0].text, 0),
    say("quarter three revenue grew twelve percent year over year", 1, 0, 1, { interims: ["the heart of", "the heart of it grew welve", "quarter three revenue grew twelve percent"] }),
    say("our new mobile app launches on March 14th", 2, 0, 1, { interims: ["our new mobile app launched in", "our new mobile app launches on march"] }),
  ], ["b1", "b2", "b3"], ["b4", "b5", "b6"]),
  en("en-homophones-accent", N1, [
    say("welcome every one and thanks for joining two day", 0),
    say("quarter tree revenue grew twelve per cent year over year", 1),
    say("our knew mobile app lunches on March fourteenth", 2),
    say("the team is hiring five engineers in Burlin", 3),
    say("key risk is the supply chain delay from our vender", 4),
    say("next steps are a pilot with Acme Core and a budget review", 5),
  ], ALL6),
  // WER variants (corrupted at run time by the seeded corrupter)
  ...[0.05, 0.15, 0.25].flatMap((w): Scenario[] => [
    en(`en-verbatim-wer${w * 100}`, N1, verbatimSteps, ALL6, undefined, { wer: w }),
    en(`en-paraphrase-wer${w * 100}`, N1, paraphraseSteps, ALL6, undefined, { wer: w }),
  ]),
  // negative controls
  neg("neg-small-talk", "so how was everyone's weekend did anybody watch the game last night it was amazing we should do that again sometime"),
  neg("neg-recipe", "first you chop the onions and let them soften in butter then add the garlic and a little salt and stir for five minutes"),
  neg("neg-stopwords", "and the of to in that is it for with as on this and the of to in that is it for with as on this"),
  neg("neg-counting", "one two three four five six seven eight nine ten eleven twelve"),
  neg("neg-spanish-vs-english", "bienvenidos a todos muchas gracias por conectarse hoy los ingresos crecieron mucho"),
  neg("neg-dates-numbers", "on the fourteenth of july the temperature was twelve degrees and about three percent of people came"),
  neg("neg-tech-support", "can you hear me is my screen shared let me mute my mic the app is frozen again hold on one second"),
  neg("neg-backchannel", "yeah okay mm hmm right sure yeah okay got it"),
  neg("neg-legal", "the parties agree that this agreement shall be governed by the laws of the state and any dispute shall be resolved by arbitration"),
  neg("neg-same-topic-diff-facts", "revenue fell thirty percent in quarter two and we are laying off staff in Paris after the vendor cancelled the order"),
];

// ---- other languages: two scenarios each
const mk = (lang: string, blocks: Blk[], verbSpoken: string[] | null, para: string[], custom?: Step[], paraSaid?: string[], paraNot?: string[]): Scenario[] => {
  const id = blocks.map((b) => b.id);
  return [
    { name: `${lang}-verbatim`, lang, blocks, steps: (verbSpoken ?? blocks.map((b) => b.text)).map((t, i) => say(t, i)), said: id },
    { name: `${lang}-paraphrase`, lang, blocks, steps: custom ?? para.map((t, i) => say(t, i)), said: paraSaid ?? id, notSaid: paraNot },
  ];
};

const ES = B(["Bienvenidos a todos y gracias por conectarse hoy", "Los ingresos del tercer trimestre crecieron un doce por ciento", "Lanzaremos la nueva aplicación móvil el catorce de marzo", "El equipo contratará cinco ingenieros en Madrid"], "e");
const FR = B(["Bonjour à tous et merci de vous être connectés", "Le chiffre d'affaires du troisième trimestre a augmenté de douze pour cent", "Notre nouvelle application mobile sort le quatorze mars", "L'équipe recrute cinq ingénieurs à Lyon"], "f");
const DE = B(["Willkommen zusammen und danke fürs Dabeisein", "Der Umsatz im dritten Quartal stieg um zwölf Prozent", "Unsere neue mobile App startet am vierzehnten März", "Das Team stellt fünf Entwickler in Berlin ein"], "d");
const PT = B(["Bem-vindos a todos e obrigado por participarem hoje", "A receita do terceiro trimestre cresceu doze por cento", "O novo aplicativo móvel será lançado em catorze de março", "A equipe vai contratar cinco engenheiros em Lisboa"], "t");
const JA = B(["皆さん、本日はご参加ありがとうございます", "第3四半期の売上は前年比12パーセント増加しました", "新しいモバイルアプリは3月14日に公開されます", "ベルリンでエンジニアを5人採用します"], "j");
const ZH = B(["欢迎大家，感谢今天的参加", "第三季度收入同比增长百分之十二", "新的移动应用将于三月十四日发布", "团队将在柏林招聘五名工程师"], "z");
const KO = B(["여러분 환영합니다 오늘 참석해 주셔서 감사합니다", "3분기 매출은 전년 대비 12퍼센트 증가했습니다", "새 모바일 앱은 3월 14일에 출시됩니다", "베를린에서 엔지니어 5명을 채용합니다"], "o");
const AR = B(["مرحبا بالجميع وشكرا لانضمامكم اليوم", "ارتفعت إيرادات الربع الثالث بنسبة اثني عشر في المئة", "سيتم إطلاق تطبيق الجوال الجديد في الرابع عشر من مارس", "سيوظف الفريق خمسة مهندسين في برلين"], "a");

const frPara = ["bonjour tout le monde et merci d'être connectés", "au troisième trimestre le chiffre d'affaires a progressé d'environ douze pour cent", "notre nouvelle appli mobile sortira le quatorze mars", "on recrute cinq ingénieurs sur Lyon"];
const ptPara = ["olá a todos obrigado por participarem hoje", "a receita do terceiro trimestre cresceu doze por cento", "o novo aplicativo móvel será lançado no dia catorze de março", "a equipe vai contratar cinco engenheiros em Lisboa"];

scenarios.push(
  ...mk("es", ES, null, ["hola a todos muchas gracias por estar aquí conectados hoy", "en el tercer trimestre los ingresos subieron más o menos un doce por ciento", "la nueva app móvil sale el catorce de marzo", "vamos a contratar a cinco ingenieros en Madrid"]),
  ...mk("fr", FR, null, frPara, [say(frPara[0], 0), say(frPara[3], 3, 0, 1, { jump: true })], ["f1", "f4"], ["f2", "f3"]),
  ...mk("de", DE, null, ["hallo zusammen schön dass ihr da seid", "im dritten Quartal ist unser Umsatz um etwa zwölf Prozent gestiegen", "die neue App kommt am vierzehnten März raus", "wir stellen fünf Entwickler in Berlin ein"]),
  ...mk("pt", PT, null, ptPara, [say(ptPara[0], 0), say(ptPara[1], 1), say(ptPara[2], 2), say("voltando à receita ela cresceu doze por cento no terceiro trimestre", 1, 0, 1, { jump: true }), say(ptPara[3], 3)]),
  ...mk("ja", JA, ["皆さん、本日はご参加ありがとうございます", "第三四半期の売上は前年比十二パーセント増加しました", "新しいモバイルアプリは三月十四日に公開されます", "ベルリンでエンジニアを五人採用します"],
    ["皆さんこんにちは今日は集まっていただきありがとうございます", "第三四半期は売上が去年より約十二パーセント伸びました", "新しいアプリは三月十四日にリリースします", "ベルリンでエンジニアを五人雇う予定です"]),
  ...mk("zh", ZH, null, ["大家好谢谢大家今天来参加", "第三季度我们的收入比去年同期增长了大约百分之十二", "新的手机应用会在三月十四号上线", "我们打算在柏林招五个工程师"]),
  ...mk("ko", KO, null, ["안녕하세요 여러분 오늘 와 주셔서 감사합니다", "삼 분기 매출은 작년 대비 십이 퍼센트 늘었습니다", "새로운 모바일 앱은 삼월 십사일에 나옵니다", "베를린에서 엔지니어 다섯 명을 뽑을 예정입니다"]),
  ...mk("ar", AR, null, ["أهلا بكم جميعا وشكرا على حضوركم اليوم", "في الربع الثالث زادت إيراداتنا بحوالي اثنا عشر بالمئة", "سنطلق التطبيق الجديد للجوال في الرابع عشر من شهر مارس", "سنوظف خمسة مهندسين جدد في برلين"]),
);
