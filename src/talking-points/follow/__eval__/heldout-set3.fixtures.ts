// Held-out set 3, authored blind (no implementation read).
import type { Blk, Step, Scenario } from "./heldout.fixtures";

const B = (arr: string[], p: string): Blk[] => arr.map((text, i) => ({ id: p + (i + 1), text }));
type SayStep = Extract<Step, { t: "say" }>;
const say = (text: string, b: number, extra: Partial<SayStep> = {}): Step => ({ t: "say", text, b, f0: 0, f1: 1, ...extra });
const jmp = (text: string, b: number): Step => say(text, b, { jump: true });
const off = (text: string): Step => ({ t: "off", text });
const vb = (bl: Blk[], idx: number[]): Step[] => idx.map((i) => say(bl[i].text, i));
const S = (name: string, lang: string, blocks: Blk[], steps: Step[], said: string[], notSaid?: string[], extra: Partial<Scenario> = {}): Scenario =>
  ({ name, lang, blocks, steps, said, notSaid, ...extra });
const ids = (p: string, n = 4) => Array.from({ length: n }, (_, i) => p + (i + 1));
const seq = (sp: string[]) => sp.map((t, i) => say(t, i));

const R = B([
  "We are rebuilding the search engine with vector indexing",
  "The beta opens to fifty customers in June",
  "Mobile offline mode is planned for the autumn",
  "We will retire the legacy API at the end of the year",
  "Support hours extend to weekends starting in July",
  "Pricing for the new tier will be announced in August",
], "r");
const H = B([
  "The role reports to the head of engineering",
  "Compensation includes equity and a yearly bonus",
  "We offer remote work from anywhere in Europe",
  "The first ninety days focus on learning the codebase",
  "Interviews have four rounds over two weeks",
], "h");
const T = B([
  "Module one covers basic safety rules",
  "Module two covers handling chemical spills",
  "Module three covers first aid for burns",
  "Module four covers fire evacuation routes",
  "The final exam has thirty questions",
  "You need eighty percent to pass",
], "t");

export const scenarios3: Scenario[] = [
  // ---- off-script that restates bullets (19 segments)
  S("O1-beta-legacy", "en", R, [...vb(R, [0, 1]), off("will the beta include the legacy API"), off("the beta is for fifty customers and it will not include the legacy API since we retire it at the end of the year"), say(R[2].text, 2)], ["r1", "r2", "r3"], ["r4"]),
  S("O2-offline-mode", "en", R, [say(R[0].text, 0), off("is offline mode coming to mobile in the autumn"), off("we are still thinking about mobile offline mode and the autumn is only a plan"), say(R[1].text, 1)], ["r1", "r2"], ["r3"]),
  S("O3-support-hours", "en", R, [...vb(R, [0, 1, 2]), off("when will support hours extend"), off("support hours on weekends are planned but pricing for the new tier in August is separate"), say(R[3].text, 3)], ["r1", "r2", "r3", "r4"], ["r5", "r6"]),
  S("O4-start-mid-rebuild", "en", R, [say(R[1].text, 1), off("what about the search engine rebuild"), off("the rebuild of the search engine with vector indexing will take us until June so the beta uses the old one"), say(R[2].text, 2)], ["r2", "r3"], ["r1"]),
  S("O5-legacy-pricing", "en", R, [...vb(R, [3, 4]), off("so will you retire the legacy API before the pricing is announced"), off("the legacy API retires at the end of the year and pricing for the new tier will be announced in August"), say(R[5].text, 5)], ["r4", "r5", "r6"], ["r1", "r2", "r3"]),
  S("O6-rebuild-again", "en", R, [...vb(R, [0, 1, 2]), off("so are you rebuilding the search engine from scratch"), off("yes we are rebuilding the search engine with vector indexing from scratch"), ...vb(R, [3, 4])], ["r1", "r2", "r3", "r4", "r5"], ["r6"]),
  S("O7-remote", "en", H, [...vb(H, [0, 1]), off("can I work remotely"), off("remote work from anywhere in Europe is possible and equity and a yearly bonus apply the same"), jmp(H[3].text, 3)], ["h1", "h2", "h4"], ["h3", "h5"]),
  S("O8-first-days", "en", H, [say(H[0].text, 0), off("what happens in the first ninety days"), off("in the first ninety days you learn the codebase but we also run four rounds of interviews over two weeks before that"), say(H[1].text, 1)], ["h1", "h2"], ["h4", "h5"]),
  S("O9-interviews", "en", H, [...vb(H, [1, 2, 3]), off("how many interviews are there"), off("the interviews have four rounds over two weeks and the role reports to the head of engineering"), say(H[4].text, 4)], ["h2", "h3", "h4", "h5"], ["h1"]),
  S("O10-skip-then-q", "en", R, [...vb(R, [0, 1, 2]), jmp(R[4].text, 4), off("does anyone have questions about the legacy API"), off("we will retire the legacy API at the end of the year yes and the beta opens to fifty customers in June"), say(R[5].text, 5)], ["r1", "r2", "r3", "r5", "r6"], ["r4"]),
  // ---- jumps (8)
  S("J1-skip-two", "en", T, [...vb(T, [0, 1]), jmp(T[4].text, 4), say(T[5].text, 5)], ["t1", "t2", "t5", "t6"], ["t3", "t4"]),
  S("J2-back-reworded", "en", T, [...vb(T, [0, 1, 2, 3]), jmp("so remember the chemical spill module two is about handling spills", 1), say(T[4].text, 4, { jump: true })], ["t1", "t2", "t3", "t4", "t5"], ["t6"]),
  S("J3-far-and-back", "en", T, [say(T[0].text, 0), jmp(T[5].text, 5), jmp(T[1].text, 1)], ["t1", "t6", "t2"], ["t3", "t4", "t5"]),
  S("J4-back-from-3", "en", T, [say(T[2].text, 2), jmp(T[0].text, 0), say(T[1].text, 1)], ["t3", "t1", "t2"], ["t4", "t5", "t6"]),
  S("J5-return-after-all", "en", T, [...vb(T, [0, 1, 2, 3, 4, 5]), jmp("one more word on burns first aid is important", 2)], ids("t", 6)),
  S("J6-start-late", "en", T, [say(T[4].text, 4), say(T[5].text, 5), jmp(T[0].text, 0), say(T[1].text, 1)], ["t5", "t6", "t1", "t2"], ["t3", "t4"]),
  S("J7-reworded-forward", "en", T, [say(T[0].text, 0), jmp("the exam at the end has thirty questions in total", 4)], ["t1", "t5"], ["t2", "t3", "t4", "t6"]),
  S("J8-short-hops", "en", T, [say(T[1].text, 1), jmp(T[3].text, 3), jmp(T[2].text, 2)], ["t2", "t4", "t3"], ["t1", "t5", "t6"]),
];

// ---- sibling groups (5)
const S1 = B(["Shift one starts at six and ends at two", "Shift two starts at two and ends at ten", "Shift three starts at ten and ends at six"], "a");
const S2 = B(["Tier Bronze includes basic reports and weekly backups", "Tier Silver includes basic reports and daily backups", "Tier Gold includes advanced reports and daily backups"], "b");
const S3 = B(["Alice covers the front desk on Friday", "Bob covers the front desk on Friday", "Carla covers the front desk on Friday", "Dev covers the front desk on Friday"], "c");
const S4 = B(["Room 101 seats twelve people", "Room 102 seats twelve people", "Room 103 seats twenty people"], "d");
const S5 = B(["Chapter one introduces the problem", "Chapter two introduces the method", "Chapter three introduces the results", "Chapter four introduces the conclusion"], "e");
scenarios3.push(
  S("S1-shifts", "en", S1, [...vb(S1, [1, 2]), jmp(S1[0].text, 0)], ["a1", "a2", "a3"]),
  S("S2-tiers", "en", S2, [...vb(S2, [1, 2])], ["b2", "b3"], ["b1"]),
  S("S3-names-back", "en", S3, [say(S3[2].text, 2), jmp(S3[1].text, 1)], ["c3", "c2"], ["c1", "c4"]),
  S("S4-rooms", "en", S4, [say(S4[1].text, 1), say(S4[2].text, 2)], ["d2", "d3"], ["d1"]),
  S("S5-chapters", "en", S5, vb(S5, [0, 1, 2, 3]), ["e1", "e2", "e3", "e4"]),
);

// ---- languages (12)
const JA = B(["来週月曜日にシステムを切り替えます", "旧システムは三か月間並行運用します", "データ移行は今週末に完了予定", "問題があれば担当者に連絡してください"], "ja");
const ZH = B(["下周一切换新系统", "旧系统并行运行三个月", "数据迁移本周末完成", "遇到问题请联系负责人"], "zh");
const KO = B(["다음 주 월요일에 시스템을 전환합니다", "기존 시스템은 3개월간 병행 운영합니다", "데이터 이전은 이번 주말에 끝납니다", "문제가 생기면 담당자에게 연락하세요"], "ko");
const ES = B(["El lunes cambiamos al nuevo sistema", "El sistema antiguo seguirá activo tres meses", "La migración de datos termina este fin de semana", "Si hay problemas contacta al responsable"], "es");
const DE = B(["Am Montag wechseln wir zum neuen System", "Das alte System läuft drei Monate parallel", "Die Datenmigration endet dieses Wochenende", "Bei Problemen wenden Sie sich an den Verantwortlichen"], "de");
const FR = B(["Lundi nous passons au nouveau système", "L'ancien système reste actif trois mois", "La migration des données se termine ce week-end", "En cas de problème contactez le responsable"], "fr");
const PT = B(["Na segunda-feira mudamos para o novo sistema", "O sistema antigo continua ativo por três meses", "A migração de dados termina neste fim de semana", "Em caso de problemas contacte o responsável"], "pt");
const AR = B(["سننتقل إلى النظام الجديد يوم الاثنين", "سيبقى النظام القديم يعمل ثلاثة أشهر", "تنتهي عملية نقل البيانات في نهاية هذا الأسبوع", "عند حدوث مشكلة تواصل مع المسؤول"], "ar");
const jaSp = ["来週の月曜日にシステムの切り替えをします", "古いシステムはしばらく三か月ほど並行して動かします", "データの移行は今週末には終わる予定です", "何か問題があったら担当の人に連絡してください"];
const koSp = ["다음 주 월요일에 시스템을 바꿀 거예요", "기존 시스템은 삼 개월 동안 같이 돌립니다", "데이터 옮기는 건 이번 주말에 끝나요", "문제가 생기면 담당자한테 연락해 주세요"];
const zhSp = ["我们下周一就会切换到新系统", "旧的系统还会并行运行三个月左右", "数据迁移这个周末就能完成", "要是遇到问题就联系负责的人"];
const esSp = ["el próximo lunes pasamos al sistema nuevo", "el sistema viejo se queda activo tres meses más", "los datos se migran y eso acaba este fin de semana", "si hay algún problema habla con el responsable"];
scenarios3.push(
  S("L-ja-paraphrase", "ja", JA, seq(jaSp), ids("ja")),
  S("L-ja-offscript", "ja", JA, [say(jaSp[0], 0), say(jaSp[1], 1), off("並行運用するならデータ移行はいつまでですか"), off("データ移行は今週末までですが旧システムは並行運用で動かし続けます"), jmp(jaSp[3], 3)], ["ja1", "ja2", "ja4"], ["ja3"]),
  S("L-zh-paraphrase", "zh", ZH, seq(zhSp), ids("zh")),
  S("L-zh-back", "zh", ZH, [...seq(zhSp).slice(0, 3), jmp("旧系统会并行运行三个月这一点我再说一下", 1), say(zhSp[3], 3, { jump: true })], ids("zh")),
  S("L-ko-paraphrase", "ko", KO, seq(koSp), ids("ko")),
  S("L-ko-offscript", "ko", KO, [say(koSp[0], 0), say(koSp[1], 1), off("병행 운영하면 데이터 이전은 언제 끝나요"), off("데이터 이전은 이번 주말에 끝나고 기존 시스템은 계속 병행 운영합니다"), jmp("혹시 문제가 생기면 담당자에게 바로 연락해 주세요", 3)], ["ko1", "ko2", "ko4"], ["ko3"]),
  S("L-es-paraphrase", "es", ES, seq(esSp), ids("es")),
  S("L-es-offscript", "es", ES, [say(esSp[0], 0), say(esSp[1], 1), off("y el sistema antiguo cuánto tiempo seguirá activo"), off("el sistema antiguo seguirá activo tres meses y la migración de datos termina este fin de semana"), jmp(esSp[3], 3)], ["es1", "es2", "es4"], ["es3"]),
  S("L-de-paraphrase", "de", DE, seq(["am kommenden Montag stellen wir auf das neue System um", "das alte System läuft noch drei Monate nebenher", "die Daten sind bis zum Wochenende migriert", "wenn es Probleme gibt meldet euch beim Verantwortlichen"]), ids("de")),
  S("L-fr-paraphrase", "fr", FR, seq(["lundi on bascule sur le nouveau système", "l'ancien système reste actif encore trois mois", "la migration des données sera finie ce week-end", "s'il y a un problème contactez le responsable"]), ids("fr")),
  S("L-pt-paraphrase", "pt", PT, seq(["na segunda a gente troca para o sistema novo", "o sistema velho continua ligado por mais três meses", "a migração dos dados acaba neste fim de semana", "se tiver algum problema fale com o responsável"]), ids("pt")),
  S("L-ar-paraphrase", "ar", AR, seq(["يوم الاثنين سننتقل إلى النظام الجديد", "النظام القديم سيظل شغالا لمدة ثلاثة أشهر", "ننتهي من نقل البيانات في نهاية الأسبوع", "إذا ظهرت مشكلة اتصل بالمسؤول"]), ids("ar")),
);

// ---- negatives (3) and ordinary (2)
const neg = (name: string, text: string, blocks: Blk[] = R, lang = "en"): Scenario => ({ name, lang, blocks, steps: [off(text)], said: [], neg: true });
scenarios3.push(
  neg("X1-lunch", "so where should we go for lunch there is a new place near the station that does great noodles and the lines are short"),
  neg("X2-other-roadmap", "we are retiring the old billing portal and the beta for twenty customers starts in March with weekend support in autumn"),
  neg("X3-korean-unrelated", "어제는 친구들이랑 영화를 보고 집에 와서 일찍 잤어요", KO, "ko"),
  S("N1-roadmap-paraphrase", "en", R, seq(["right now we are rebuilding search around vector indexing", "fifty customers get into the beta in June", "offline mode for mobile is something we plan for autumn", "the legacy API is going away at the end of this year", "from July we will have support on weekends too", "and in August we will announce pricing for the new tier"]), ids("r", 6)),
  S("N2-hiring-restarts", "en", H, [say("the the role reports to the head of of engineering", 0), say("compensation um includes equity and and a yearly bonus", 1), say("we offer remote work from anywhere in in Europe", 2)], ["h1", "h2", "h3"], ["h4", "h5"]),
);
