// Held-out set 2, authored blind (no implementation read).
import type { Blk, Step, Scenario } from "./heldout-set1.fixtures";

const B = (arr: string[], p: string): Blk[] => arr.map((text, i) => ({ id: p + (i + 1), text }));
type SayStep = Extract<Step, { t: "say" }>;
const say = (text: string, b: number, extra: Partial<SayStep> = {}): Step => ({ t: "say", text, b, f0: 0, f1: 1, ...extra });
const jmp = (text: string, b: number): Step => say(text, b, { jump: true });
const off = (text: string): Step => ({ t: "off", text });
const verb = (bl: Blk[], idx: number[]): Step[] => idx.map((i) => say(bl[i].text, i));
const S = (name: string, lang: string, blocks: Blk[], steps: Step[], said: string[], notSaid?: string[], extra: Partial<Scenario> = {}): Scenario =>
  ({ name, lang, blocks, steps, said, notSaid, ...extra });

// ---------- Topic A: interview
const A = B([
  "I led a team of eight engineers at Stripe for three years",
  "We migrated the billing system from Ruby to Go",
  "Latency dropped forty percent after the migration",
  "I mentored four junior developers who were later promoted",
  "My biggest weakness is delegating too slowly",
  "I want this role because of the focus on payments infrastructure",
], "i");
// ---------- Topic B: sales
const SB = B([
  "Our platform reduces onboarding time by half",
  "Pricing starts at twelve dollars per seat per month",
  "We integrate with Salesforce and HubSpot out of the box",
  "Every plan includes twenty four seven phone support",
  "Annual contracts get a fifteen percent discount",
  "We can start a pilot with your team next week",
], "s");

export const scenarios2: Scenario[] = [
  S("A1-interview-paraphrase", "en", A, [
    say("so I was leading a group of about eight engineers over at Stripe and that lasted three years", 0),
    say("one big thing we did was move the billing system over from Ruby into Go", 1),
    say("after that migration our latency went down by around forty percent", 2),
    say("I also coached four junior developers and they all got promoted later", 3),
    say("if I had to name a weakness it would be that I delegate too slowly", 4),
    say("and I want this job because I care about payments infrastructure", 5),
  ], ["i1", "i2", "i3", "i4", "i5", "i6"]),
  S("A2-offscript-borrow-team", "en", A, [
    ...verb(A, [0, 1]),
    off("and how did the team feel about moving from Ruby to Go"),
    off("honestly some of the engineers were nervous about the migration at first because they had been on Ruby for years but a few junior developers were excited to learn Go"),
    say(A[2].text, 2),
  ], ["i1", "i2", "i3"], ["i4", "i5", "i6"]),
  S("A3-offscript-outage-jump-fwd", "en", A, [
    ...verb(A, [0, 1, 2]),
    off("what was the worst billing outage you handled"),
    off("there was one night where latency spiked and I had to lead the team through it with eight engineers on a call for three hours before the migration rollback"),
    jmp(A[4].text, 4),
    say(A[5].text, 5),
  ], ["i1", "i2", "i3", "i5", "i6"], ["i4"]),
  S("A4-jump-back-reworded", "en", A, [
    ...verb(A, [0, 1, 2, 3]),
    jmp("let me add one thing about the migration we actually moved billing from ruby to go in about six months", 1),
    say(A[4].text, 4, { jump: true }),
  ], ["i1", "i2", "i3", "i4", "i5"], ["i6"]),
  S("A5-far-jump-and-return", "en", A, [
    ...verb(A, [0]),
    jmp(A[5].text, 5),
    jmp("coming back to what I built at Stripe we moved the billing system from Ruby to Go", 1),
  ], ["i1", "i6", "i2"], ["i3", "i4", "i5"]),
  S("A6-skip-two-restarts", "en", A, [
    say("so I I led a a team of eight engineers at stripe for for three years", 0),
    say("um latency dropped forty percent after the the migration", 2, { jump: true }),
    say("my my biggest weakness is um delegating too slowly", 4, { jump: true }),
  ], ["i1", "i3", "i5"], ["i2", "i4", "i6"]),

  S("B1-objection-price", "en", SB, [
    say(SB[0].text, 0),
    off("that seems expensive compared to what we pay now"),
    off("I understand price matters and the per seat cost looks high at first but when onboarding time is cut by half your team saves months and support is included"),
    say(SB[1].text, 1),
    say(SB[2].text, 2),
  ], ["s1", "s2", "s3"], ["s4", "s5", "s6"]),
  S("B2-objection-integration", "en", SB, [
    ...verb(SB, [0, 1, 2]),
    off("do you work with Microsoft Dynamics or only Salesforce"),
    off("we do not support Dynamics today but Salesforce and tools like HubSpot work out of the box and we can look at a pilot with your team"),
    jmp(SB[4].text, 4),
  ], ["s1", "s2", "s3", "s5"], ["s4", "s6"]),
  S("B3-competitor-smalltalk", "en", SB, [
    say(SB[0].text, 0),
    off("we tried a similar platform last year and onboarding took twice as long their pricing was thirty dollars a seat and support was only on weekdays"),
    off("so we are wary of annual contracts and discounts and pilots honestly"),
    jmp(SB[3].text, 3),
  ], ["s1", "s4"], ["s2", "s3", "s5", "s6"]),
  S("B4-jump-back-reworded", "en", SB, [
    ...verb(SB, [0, 1, 2, 3, 4]),
    jmp("sorry going back to pricing it's twelve bucks a seat every month", 1),
    say(SB[5].text, 5, { jump: true }),
  ], ["s1", "s2", "s3", "s4", "s5", "s6"]),
  S("B5-sales-paraphrase", "en", SB, [
    say("what we do is cut your onboarding time roughly in half", 0),
    say("pricing starts at about twelve dollars for each seat every month", 1),
    say("it plugs into Salesforce and HubSpot with no extra work", 2),
    say("all plans come with phone support around the clock", 3),
    say("if you sign for a year we take fifteen percent off", 4),
    say("we could kick off a pilot with your team next week", 5),
  ], ["s1", "s2", "s3", "s4", "s5", "s6"]),
];

// ---------- numbers, dates, acronyms (10)
const PRE = "Let us review the key figures for this project";
const POST = "That covers the main points for the week";
const num = (name: string, target: string, spoken: string): Scenario => {
  const bl = B([PRE, target, POST], "m");
  return S(name, "en", bl, [say(PRE, 0), say(spoken, 1), say(POST, 2)], ["m1", "m2", "m3"]);
};
scenarios2.push(
  num("N1-date", "Launch on 03/14/2027", "launch is on march fourteenth twenty twenty seven"),
  num("N2-money", "Budget is $1.2M", "the budget is one point two million dollars"),
  num("N3-percent", "Headcount grows 15% in H2", "headcount grows fifteen percent in the second half"),
  num("N4-latency", "API p99 under 250ms", "api p ninety nine is under two hundred fifty milliseconds"),
  num("N5-compliance", "HIPAA and GDPR compliant", "we are H I P A A and G D P R compliant"),
  num("N6-okr", "Q4 OKRs due Dec 5", "quarter four O K R s are due december fifth"),
  num("N7-version", "Version 3.1.4 ships Tuesday", "version three point one point four ships on tuesday"),
  num("N8-phone", "Call 555-0142 ext. 7", "call five five five oh one four two extension seven"),
  num("N9-multiple", "10x faster than v1", "it is ten times faster than version one"),
  num("N10-nps", "NPS rose from 41 to 58", "net promoter score rose from forty one to fifty eight"),
);

// ---------- near-identical sibling groups (6)
const G1 = B(["Plan A includes ten users and email support", "Plan B includes twenty users and email support", "Plan C includes fifty users and phone support"], "g");
const G2 = B(["We will hire two designers in Q1", "We will hire two designers in Q2", "We will hire two designers in Q3", "We will hire two designers in Q4"], "q");
const G3 = B(["On Monday we review the backlog", "On Tuesday we review the roadmap", "On Wednesday we review the budget", "On Thursday we review the risks"], "d");
const G4 = B(["Sales in Africa grew nine percent", "Sales in Europe grew nine percent", "Sales in Asia grew nine percent", "Sales in Americas grew nine percent"], "r");
const G5 = B(["Anna owns the design review by Friday", "Marco owns the design review by Monday", "Priya owns the design review by Wednesday"], "o");
const G6 = B(["Customer feedback was positive this month", "Next step is to schedule a follow up call", "Engineering is on track for the release", "Next step is to schedule a follow up call"], "u");
scenarios2.push(
  S("G1-skip-plan-a", "en", G1, [say("plan B includes twenty users and email support", 1), say("plan C includes fifty users and phone support", 2)], ["g2", "g3"], ["g1"]),
  S("G2-quarters-back", "en", G2, [say("we will hire two designers in Q3", 2), jmp("and we will hire two designers in Q1", 0)], ["q3", "q1"], ["q2", "q4"]),
  S("G3-days", "en", G3, [say("on Wednesday we review the budget", 2), say("on Thursday we review the risks", 3)], ["d3", "d4"], ["d1", "d2"]),
  S("G4-regions", "en", G4, [say("sales in Africa grew nine percent", 0), jmp("sales in Europe grew nine percent", 1), say("sales in Americas grew nine percent", 3, { jump: true })], ["r1", "r2", "r4"], ["r3"]),
  S("G5-names-back", "en", G5, [say("Priya owns the design review by Wednesday", 2), jmp("Anna owns the design review by Friday", 0)], ["o3", "o1"], ["o2"]),
  S("G6-duplicate-bullets", "en", G6, [...verb(G6, [0, 1, 2, 3])], ["u1", "u2", "u3", "u4"]),
);

// ---------- CJK / Korean natural-speech paraphrases (10)
const JAa = B(["新製品の発売日は5月20日", "初年度の売上目標は10億円", "営業チームを20名に増員する", "来月から全国で試験販売を開始"], "ja");
const JAb = B(["顧客満足度は先月より5ポイント向上", "サポートの応答時間を半分に短縮", "新しい料金プランは月額980円", "解約率は2パーセント未満を維持"], "jb");
const ZHa = B(["下个季度的目标是增长百分之二十", "我们将在上海开设新办公室", "客户满意度达到九十分", "产品下个月正式发布"], "za");
const ZHb = B(["预算总额为五百万元", "项目周期为六个月", "团队共有十二名成员", "风险主要来自供应链延迟"], "zb");
const KOa = B(["다음 분기 목표는 매출 20퍼센트 성장", "서울에 새 사무실을 열 예정입니다", "고객 만족도는 90점입니다", "제품은 다음 달에 정식 출시됩니다"], "ka");
const KOb = B(["예산은 총 5억 원입니다", "프로젝트 기간은 6개월입니다", "팀원은 모두 12명입니다", "가장 큰 위험은 공급망 지연입니다"], "kb");
const jaaSp = ["えっと新しい製品なんですが発売は五月二十日を予定しています", "最初の年の売上は十億円を目指しています", "営業のチームも二十人まで増やす計画です", "来月から全国でテスト販売を始めます"];
const zhaSp = ["下个季度我们想要增长百分之二十左右", "我们准备在上海开一个新的办公室", "客户的满意度已经到了九十分", "产品下个月就会正式发布了"];
const kaSp = ["다음 분기에는 매출을 이십 퍼센트 정도 늘리는 게 목표예요", "서울에 새로운 사무실을 하나 열려고 합니다", "고객 만족도는 구십 점이 나왔어요", "제품은 다음 달에 정식으로 나옵니다"];
const kbSp = ["예산은 전부 오억 원 정도입니다", "프로젝트는 육 개월 동안 진행됩니다", "팀에는 열두 명이 있습니다", "제일 큰 리스크는 공급망이 늦어지는 거예요"];
const seq = (sp: string[]) => sp.map((t, i) => say(t, i));
const ids = (p: string, n = 4) => Array.from({ length: n }, (_, i) => p + (i + 1));
scenarios2.push(
  S("JA-a-paraphrase", "ja", JAa, seq(jaaSp), ids("ja")),
  S("JA-b-paraphrase", "ja", JAb, seq(["お客様の満足度は先月と比べて五ポイントほど上がりました", "サポートの返事までの時間を半分にしました", "新しい料金プランは月九百八十円になります", "解約する人は二パーセントより少ないままです"]), ids("jb")),
  S("JA-c-skip", "ja", JAa, [say(jaaSp[0], 0), jmp(jaaSp[3], 3)], ["ja1", "ja4"], ["ja2", "ja3"]),
  S("ZH-a-paraphrase", "zh", ZHa, seq(zhaSp), ids("za")),
  S("ZH-b-paraphrase", "zh", ZHb, seq(["整个预算大概是五百万元", "这个项目一共要做六个月", "团队里面一共有十二个人", "最大的风险就是供应链会延迟"]), ids("zb")),
  S("ZH-c-back", "zh", ZHa, [say(zhaSp[0], 0), say(zhaSp[1], 1), say(zhaSp[2], 2), jmp("刚才说的上海办公室我再补充一下我们会在上海开新办公室", 1), say(zhaSp[3], 3, { jump: true })], ids("za")),
  S("KO-a-paraphrase", "ko", KOa, seq(kaSp), ids("ka")),
  S("KO-b-paraphrase", "ko", KOb, seq(kbSp), ids("kb")),
  S("KO-c-skip-back", "ko", KOa, [say(kaSp[0], 0), jmp(kaSp[3], 3), jmp(kaSp[1], 1)], ["ka1", "ka4", "ka2"], ["ka3"]),
  S("KO-d-offscript", "ko", KOb, [say(kbSp[0], 0), say(kbSp[1], 1), off("프로젝트 팀원이 부족하면 예산이 늘어날 수도 있어요"), off("그리고 가장 큰 위험은 아니지만 기간이 길어지면 팀원 비용이 커집니다"), jmp(kbSp[3], 3)], ["kb1", "kb2", "kb4"], ["kb3"]),
);

// ---------- ordinary talks en/es/fr/de/pt/ar (12), onboarding topic
const OEN = B(["New hires start on the first Monday of each month", "Laptops are shipped to your home a week before", "Your manager will schedule a welcome lunch", "Benefits enrollment closes after thirty days"], "oe");
const OES = B(["Los nuevos empleados empiezan el primer lunes de cada mes", "El portátil se envía a casa una semana antes", "Tu jefe organizará un almuerzo de bienvenida", "La inscripción a beneficios cierra a los treinta días"], "os");
const OFR = B(["Les nouveaux arrivants commencent le premier lundi de chaque mois", "L'ordinateur portable est envoyé à la maison une semaine avant", "Votre manager organisera un déjeuner de bienvenue", "L'inscription aux avantages ferme après trente jours"], "of");
const ODE = B(["Neue Mitarbeiter starten am ersten Montag jedes Monats", "Der Laptop wird eine Woche vorher nach Hause geschickt", "Ihr Vorgesetzter lädt Sie zu einem Willkommensessen ein", "Die Anmeldung für Zusatzleistungen endet nach dreißig Tagen"], "od");
const OPT = B(["Os novos contratados começam na primeira segunda-feira de cada mês", "O notebook é enviado para casa uma semana antes", "Seu gestor vai marcar um almoço de boas-vindas", "A inscrição nos benefícios fecha após trinta dias"], "op");
const OAR = B(["يبدأ الموظفون الجدد في أول يوم اثنين من كل شهر", "يتم شحن الحاسوب المحمول إلى المنزل قبل أسبوع", "سينظم مديرك غداء ترحيبيا", "يغلق التسجيل في المزايا بعد ثلاثين يوما"], "oa");
scenarios2.push(
  S("O-en-paraphrase", "en", OEN, seq(["people who are new start on the first monday of every month", "we send the laptop to your house about a week ahead", "your manager is going to set up a welcome lunch for you", "you have thirty days and then benefits enrollment closes"]), ids("oe")),
  S("O-en-restarts-nopunct", "en", OEN, [say("new hires uh start on on the first monday of each month", 0, { mode: "final" }), say("laptops are shipped to your home a week before", 1, { mode: "final" }), say("your manager will will schedule a welcome lunch", 2, { mode: "final" }), say("benefits enrollment closes after thirty days", 3, { mode: "final" })], ids("oe")),
  S("O-es-paraphrase", "es", OES, seq(["los empleados nuevos empiezan el primer lunes de cada mes", "te mandamos el portátil a casa una semana antes", "tu jefe va a organizar un almuerzo para darte la bienvenida", "tienes treinta días y después se cierra la inscripción a los beneficios"]), ids("os")),
  S("O-es-offscript", "es", OES, [...verb(OES, [0, 1]), off("y si mi portátil llega tarde"), off("si llega tarde no pasa nada podéis empezar el lunes y el jefe os da uno temporal antes de enviar"), jmp(OES[3].text, 3)], ["os1", "os2", "os4"], ["os3"]),
  S("O-fr-paraphrase", "fr", OFR, seq(["les nouveaux commencent le premier lundi de chaque mois", "on vous envoie l'ordinateur à la maison une semaine avant", "votre manager organisera un déjeuner pour vous accueillir", "les inscriptions aux avantages ferment au bout de trente jours"]), ids("of")),
  S("O-fr-verbatim-back", "fr", OFR, [...verb(OFR, [0, 1, 2, 3]), jmp(OFR[1].text, 1)], ids("of")),
  S("O-de-paraphrase", "de", ODE, seq(["neue Leute fangen immer am ersten Montag im Monat an", "der Laptop kommt eine Woche vorher per Post zu euch nach Hause", "euer Chef organisiert ein Willkommensessen", "nach dreißig Tagen ist die Anmeldung für die Zusatzleistungen zu Ende"]), ids("od")),
  S("O-de-verbatim", "de", ODE, verb(ODE, [0, 1, 2, 3]), ids("od")),
  S("O-pt-paraphrase", "pt", OPT, seq(["quem entra começa na primeira segunda de cada mês", "a gente manda o notebook pra sua casa uma semana antes", "o seu gestor vai marcar um almoço pra te receber", "você tem trinta dias e depois a inscrição nos benefícios fecha"]), ids("op")),
  S("O-pt-skip-offscript", "pt", OPT, [say(OPT[0].text, 0), off("e se eu já tiver um notebook em casa posso usar o meu"), jmp(OPT[3].text, 3)], ["op1", "op4"], ["op2", "op3"]),
  S("O-ar-paraphrase", "ar", OAR, seq(["الموظفون الجدد يبدؤون في أول اثنين من كل شهر", "نرسل لك الحاسوب إلى بيتك قبل أسبوع", "مديرك سيرتب لك غداء ترحيبيا", "عندك ثلاثين يوما ثم يغلق التسجيل في المزايا"]), ids("oa")),
  S("O-ar-verbatim", "ar", OAR, verb(OAR, [0, 1, 2, 3]), ids("oa")),
);

// ---------- negatives (9)
const neg = (name: string, text: string, blocks: Blk[] = A, lang = "en"): Scenario => ({ name, lang, blocks, steps: [off(text)], said: [], neg: true });
scenarios2.push(
  neg("X1-weather", "it looks like it is going to rain all weekend so I think we should move the picnic to the following saturday"),
  neg("X2-sports", "did you see the final last night the goalkeeper made three saves in the second half and they won on penalties"),
  neg("X3-french-vs-english", "bonjour tout le monde je voudrais commander un café et un croissant s'il vous plaît", A),
  neg("X4-news-numbers", "the central bank raised rates by a quarter point and inflation stayed at three percent for the third month in a row"),
  neg("X5-line-check", "hello hello can you hear me I think you are on mute can you try again hello"),
  neg("X6-other-interview", "I managed a team of four at Google for two years we moved the search system from Java to C plus plus and traffic grew ten percent"),
  neg("X7-other-product", "our tool cuts reporting time by a third and plans start at nine dollars per user and include email support on weekdays", SB),
  neg("X8-spanish-unrelated", "mañana va a llover y tengo que comprar leche y pan en el supermercado antes de recoger a los niños", OES, "es"),
  neg("X9-japanese-unrelated", "昨日の夜は友達と映画を見に行って帰りにラーメンを食べました", JAa, "ja"),
);
