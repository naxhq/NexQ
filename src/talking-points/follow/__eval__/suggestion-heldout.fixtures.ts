// Held-out "Go to ..." suggestion cases, authored blind (suggestion-cases.ts was not read).
import type { NoteBlock } from "../tokenize";
import type { SuggestCase } from "./suggestion-cases";

export interface Group { notes: NoteBlock[]; cases: SuggestCase[] }
type Row = [name: string, setup: number[], say: string, expect: number | null];

const nb = (p: string, texts: string[]): NoteBlock[] => texts.map((text, i) => ({ id: `${p}${i + 1}`, text }));
const grp = (lang: string, cut: "words" | "chars", notes: NoteBlock[], rows: Row[]): Group => ({
  notes,
  cases: rows.map(([name, setup, say, expect]) => ({ name: `${lang}:${name}`, lang, cut, setup, say, expect })),
});
const r = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, k) => a + k);

// ------------------------------------------------------------------ English
const EA = nb("ea", [
  "Welcome and agenda for the quarterly all hands",
  "Revenue grew twelve percent compared to last quarter",
  "Customer churn fell to two point one percent",
  "We launched the new billing dashboard in March",
  "Engineering shipped the offline sync feature",
  "Hiring plan: six engineers and two designers by September",
  "Office move to the Rotterdam building happens in October",
  "Security audit passed with no critical findings",
  "Marketing campaign targets mid-size logistics companies",
  "Partnership with Northwind opens the Nordic market",
  "Support response time improved to under four hours",
  "Budget for next year is frozen until the board meets",
  "New parental leave policy starts in January",
  "Employee survey scored eighty one percent satisfaction",
  "Open questions from the team",
  "Thank you and see you at the summer party",
]);
const EB = nb("eb", [
  "Goals for the pilot",
  "Week one: install the sensors in the warehouse",
  "Week two: train the night shift staff",
  "Week three: compare error rates with the old scanners",
  "Decision point: roll out to all sites or stop",
  "Budget cap is forty thousand dollars",
]);
const EC = nb("ec", [
  "Section one: Getting started", "Create an account with your work email", "Verify the address using the link we send you",
  "Section two: Billing", "Invoices are issued on the first of every month", "Late payments incur a two percent fee", "You can download receipts as PDF files",
  "Section three: Security", "Two factor authentication is required for admins", "Passwords must be at least fourteen characters", "Sessions expire after thirty minutes of inactivity",
  "Section four: Integrations", "Connect Slack to receive alerts in your channel", "The calendar integration supports Google and Outlook", "Webhooks retry failed deliveries three times",
  "Section five: Troubleshooting", "If sync stops, restart the desktop client", "Clear the cache from the advanced settings page", "Contact support with the log bundle attached",
  "Section six: Limits", "Free plans allow up to five projects", "Team plans allow unlimited projects and fifty guests", "File uploads are capped at two gigabytes",
  "Section seven: Roadmap",
]);
const ED = nb("ed", [
  "Phase one pilots the scanner in Hamburg", "Phase two pilots the scanner in Rotterdam", "Phase three pilots the scanner in Antwerp",
  "Hamburg results are due in March", "Rotterdam results are due in May", "Antwerp results are due in July",
  "The steering committee meets after phase three", "Final report goes to the board in September",
]);

// ------------------------------------------------------------------ the other languages share one script
const FR = nb("fr", [
  "Bienvenue à la réunion trimestrielle de l'équipe", "Le chiffre d'affaires a augmenté de douze pour cent", "Le taux de désabonnement est tombé à deux pour cent",
  "Nous avons lancé le nouveau tableau de bord en mars", "L'équipe technique a livré la synchronisation hors ligne", "Le plan de recrutement prévoit six ingénieurs avant septembre",
  "Le déménagement vers le bâtiment de Lyon aura lieu en octobre", "L'audit de sécurité n'a révélé aucune faille critique", "La campagne marketing vise les entreprises de logistique",
  "Le partenariat avec Northwind ouvre le marché nordique",
]);
const ES = nb("es", [
  "Bienvenidos a la reunión trimestral del equipo", "Los ingresos crecieron un doce por ciento", "La cancelación de clientes bajó al dos por ciento",
  "Lanzamos el nuevo panel de facturación en marzo", "Ingeniería entregó la sincronización sin conexión", "El plan de contratación incluye seis ingenieros antes de septiembre",
  "La mudanza al edificio de Valencia será en octubre", "La auditoría de seguridad no encontró fallos críticos", "La campaña de marketing apunta a empresas de logística",
  "La alianza con Northwind abre el mercado nórdico",
]);
const DE = nb("de", [
  "Willkommen zum vierteljährlichen Teamtreffen", "Der Umsatz ist um zwölf Prozent gestiegen", "Die Kündigungsrate sank auf zwei Prozent",
  "Im März haben wir das neue Abrechnungsdashboard gestartet", "Das Entwicklungsteam hat die Offline-Synchronisierung geliefert", "Der Einstellungsplan sieht sechs Entwickler bis September vor",
  "Der Umzug in das Gebäude in Köln findet im Oktober statt", "Das Sicherheitsaudit ergab keine kritischen Mängel", "Die Marketingkampagne richtet sich an Logistikunternehmen",
  "Die Partnerschaft mit Northwind öffnet den nordischen Markt",
]);
const PT = nb("pt", [
  "Bem-vindos à reunião trimestral da equipe", "A receita cresceu doze por cento", "O cancelamento de clientes caiu para dois por cento",
  "Lançamos o novo painel de faturamento em março", "A engenharia entregou a sincronização offline", "O plano de contratação prevê seis engenheiros até setembro",
  "A mudança para o prédio de Lisboa será em outubro", "A auditoria de segurança não encontrou falhas críticas", "A campanha de marketing mira empresas de logística",
  "A parceria com a Northwind abre o mercado nórdico",
]);
const AR = nb("ar", [
  "مرحبا بكم في الاجتماع الفصلي للفريق", "ارتفعت الإيرادات بنسبة اثني عشر في المئة", "انخفض معدل إلغاء العملاء إلى اثنين في المئة",
  "أطلقنا لوحة الفوترة الجديدة في مارس", "سلم فريق الهندسة ميزة المزامنة دون اتصال", "تتضمن خطة التوظيف ستة مهندسين قبل سبتمبر",
  "سيتم الانتقال إلى مبنى دبي في أكتوبر", "لم يجد تدقيق الأمان أي ثغرات حرجة",
]);
const FA = nb("fa", [
  "به نشست فصلی تیم خوش آمدید", "درآمد دوازده درصد افزایش یافت", "نرخ ریزش مشتریان به دو درصد کاهش یافت",
  "داشبورد جدید صورتحساب را در ماه مارس راه اندازی کردیم", "تیم مهندسی قابلیت همگام سازی آفلاین را تحویل داد", "برنامه استخدام شامل شش مهندس تا سپتامبر است",
  "جابجایی به ساختمان جدید در تهران در ماه اکتبر انجام می شود", "ممیزی امنیتی هیچ ضعف بحرانی پیدا نکرد",
]);
const JA = nb("ja", [
  "四半期チームミーティングへようこそ", "売上は前四半期比で十二パーセント増加しました", "解約率は二パーセントまで低下しました",
  "三月に新しい請求ダッシュボードを公開しました", "開発チームはオフライン同期機能を提供しました", "採用計画では九月までにエンジニア六名を採用します",
  "十月に大阪の新しいビルへ移転します", "セキュリティ監査で重大な問題は見つかりませんでした",
]);
const ZH = nb("zh", [
  "欢迎参加季度团队会议", "收入比上季度增长了百分之十二", "客户流失率下降到百分之二",
  "三月份我们发布了新的账单仪表板", "工程团队交付了离线同步功能", "招聘计划是九月前招六名工程师",
  "十月份将搬到上海的新大楼", "安全审计没有发现严重漏洞",
]);
const KO = nb("ko", [
  "분기 팀 회의에 오신 것을 환영합니다", "매출이 전 분기보다 12퍼센트 늘었습니다", "고객 이탈률이 2퍼센트로 떨어졌습니다",
  "3월에 새 청구 대시보드를 출시했습니다", "개발팀이 오프라인 동기화 기능을 제공했습니다", "채용 계획은 9월까지 엔지니어 여섯 명입니다",
  "10월에 부산의 새 건물로 이전합니다", "보안 감사에서 심각한 문제는 발견되지 않았습니다",
]);

export const groups: Group[] = [
  grp("en", "words", EA, [
    ["fwd-audit", [1, 2, 3], "now moving on to the security audit we passed it with no critical findings", 8],
    ["back-churn", r(1, 6), "going back to churn for a second it fell to about two percent", 3],
    ["far-parental", [1, 2], "the new parental leave policy begins in january", 13],
    ["office-move", [1, 2, 3], "let's talk about the office move to rotterdam in october", 7],
    ["partial-nordic", r(1, 4), "the partnership with Northwind and the Nordic market", 10],
    ["hiring-skip4", [1], "hiring plan six engineers and two designers by september", 6],
    ["survey", r(1, 8), "the employee survey came back at eighty one percent satisfaction", 14],
    ["support-time", [1, 2], "support response time is now under four hours", 11],
    ["noisy-marketing", [1, 2, 3], "marketing campain targets mid size logistic companies", 9],
    ["noisy-budget", r(1, 5), "budget for next year is frozen until the board meats", 12],
    ["neg-question", [1, 2, 3], "that is a great question and I think we can come back to it after the break", null],
    ["neg-stock", [2, 3], "speaking of revenue my cousin thinks the stock market will grow twelve percent next year but who knows", null],
    ["neg-current-restate", [4, 5], "we talked about the dashboard last week with the customer and she said the billing screens were confusing", null],
    ["neg-next-block", r(1, 5), "and now the hiring plan six engineers and two designers by September", null],
    ["neg-filler", [2, 3], "so uh yeah okay um let me see where was I um yeah", null],
    ["neg-smalltalk", [6, 7], "thanks john yes I can hear you now the screen share is working fine", null],
    ["neg-borrowed-audit", [8], "the security guard at the old office never checked the audit trail of the visitors log anyway", null],
    ["neg-other-team-numbers", [3, 4], "the other team's marketing numbers show campaign spending of two point one million for logistics software", null],
    ["neg-answer-nordic", [9, 10], "can you repeat the question about the Nordic market and who from Northwind is attending", null],
    ["neg-rotterdam-containers", [11, 12], "our customers in the Rotterdam office complained that their shipping container arrived with broken pallets", null],
    ["neg-rotterdam-weather", [4], "yes the weather in Rotterdam in October is usually rainy so bring a jacket", null],
    ["neg-survey-story", [10, 11], "in my previous job the survey results were never shared with anyone and satisfaction was terrible", null],
    ["neg-finance-other-person", [2, 3], "yes and on my side the finance team asks whether revenue recognition will change with the new accounting standard next year", null],
    ["neg-wrapup", [5, 6], "okay so that is it for this slide any thoughts anybody no okay great", null],
  ]),
  grp("en", "words", EB, [
    ["wk3-compare", [1], "week three we compare error rates with the old scanners", 4],
    ["back-wk1", r(1, 4), "back to the install in the warehouse week one sensors", 2],
    ["budget-first", [], "the budget cap is forty thousand dollars", 6],
    ["neg-coffee", [1, 2], "I need a coffee before we start week three of the other project because the old scanners at the other site were awful", null],
    ["neg-garage", [1, 2], "installing sensors in my own garage was easy last weekend so I guess warehouse is similar", null],
  ]),
  grp("en", "words", EC, [
    ["heading-billing", [1, 2, 3], "now the billing section", 4],
    ["late-fee", r(1, 4), "late payments cost you a two percent fee", 6],
    ["sessions-skip3", r(2, 7), "sessions expire after thirty minutes if you are inactive", 11],
    ["back-passwords", r(12, 15), "back to security passwords need fourteen characters at least", 10],
    ["sync-skip2sections", [1, 2, 3], "if the sync stops just restart the desktop client", 17],
    ["limits-free", [16, 17], "on the limits free plans are up to five projects", 21],
  ]),
  grp("en", "words", ED, [
    ["phase3", [1], "phase three pilots the scanner in Antwerp", 3],
    ["rotterdam-back", [1, 2, 3], "going back the Rotterdam results are due in May", 5],
    ["antwerp-results", [1, 2], "Antwerp results are due in July", 6],
    ["neg-brussels", [1, 2], "the committee in Brussels also meets after every phase and the board report goes out in September for them as well", null],
    ["neg-hamburg-trip", [4], "hamburg is a lovely city I visited it in march years ago and ate fish sandwiches by the harbour", null],
  ]),
  grp("fr", "words", FR, [
    ["fwd-audit", [1, 2], "passons à l'audit de sécurité il n'y a eu aucune faille critique", 8],
    ["back-churn", r(1, 6), "pour revenir au taux de désabonnement il est tombé à deux pour cent", 3],
    ["lyon", [1, 2], "le déménagement à Lyon se fera en octobre", 7],
    ["northwind", [1], "le partenariat avec Northwind nous ouvre le marché nordique", 10],
    ["hiring-skip2", [1, 2, 3], "nous allons recruter six ingénieurs avant le mois de septembre", 6],
    ["marketing", r(1, 5), "la campagne de marketing cible les sociétés de logistique", 9],
    ["noisy-sync", [1, 2, 3], "l'équipe technique a livré la sincronisation hor ligne", 5],
    ["back-dashboard", r(2, 7), "le tableau de bord lancé en mars", 4],
    ["nordic-skip1", r(1, 8), "et le partenariat nordique avec Northwind", 10],
    ["neg-question", [2, 3], "c'est une excellente question on y reviendra après la pause si vous voulez bien", null],
    ["neg-lyon-sister", [3, 4], "ma sœur travaille à Lyon et elle dit que le déménagement de son entreprise en octobre a été un cauchemar", null],
    ["neg-filler", [5, 6], "euh oui alors voilà je cherche mes notes une seconde euh voilà", null],
    ["neg-other-team", [1, 2], "dans l'autre équipe le chiffre d'affaires a baissé de trente pour cent à cause du marché", null],
    ["neg-next-block", [4, 5], "ensuite le plan de recrutement six ingénieurs avant septembre", null],
    ["neg-smalltalk", [1, 2], "est ce que vous m'entendez bien le partage d'écran fonctionne ou pas je ne vois rien", null],
  ]),
  grp("es", "words", ES, [
    ["fwd-audit", [1, 2], "pasemos a la auditoría de seguridad no hubo fallos críticos", 8],
    ["back-churn", r(1, 6), "volviendo a la cancelación de clientes bajó al dos por ciento", 3],
    ["valencia", [1, 2], "la mudanza a Valencia será en octubre", 7],
    ["northwind", [1], "la alianza con Northwind abre el mercado nórdico", 10],
    ["hiring-skip2", [1, 2, 3], "vamos a contratar seis ingenieros antes de septiembre", 6],
    ["marketing", r(1, 5), "la campaña de marketing apunta a empresas de logistica", 9],
    ["noisy-sync", [1, 2, 3], "ingenieria entrego la sincronisacion sin conecsion", 5],
    ["back-panel", r(2, 7), "el nuevo panel de facturación de marzo", 4],
    ["nordic-skip1", r(1, 8), "y la alianza nórdica con Northwind", 10],
    ["neg-question", [2, 3], "esa es una muy buena pregunta lo vemos después del descanso", null],
    ["neg-valencia-sister", [3, 4], "mi hermana vive en Valencia y dice que la mudanza de su empresa en octubre fue una pesadilla", null],
    ["neg-filler", [5, 6], "eh sí bueno a ver déjame buscar mis notas un segundo eh listo", null],
    ["neg-other-team", [1, 2], "en el otro equipo los ingresos bajaron treinta por ciento por el mercado", null],
    ["neg-next-block", [4, 5], "ahora el plan de contratación seis ingenieros antes de septiembre", null],
    ["neg-smalltalk", [1, 2], "me oyen bien funciona el audio o no veo nada en la pantalla", null],
  ]),
  grp("de", "words", DE, [
    ["fwd-audit", [1, 2], "weiter mit dem Sicherheitsaudit es gab keine kritischen Mängel", 8],
    ["back-churn", r(1, 6), "zurück zur Kündigungsrate sie ist auf zwei Prozent gesunken", 3],
    ["koeln", [1, 2], "der Umzug nach Köln ist im Oktober", 7],
    ["northwind", [1], "die Partnerschaft mit Northwind öffnet uns den nordischen Markt", 10],
    ["hiring-skip2", [1, 2, 3], "wir stellen bis September sechs Entwickler ein", 6],
    ["marketing", r(1, 5), "die Marketingkampagne zielt auf Logistikunternehmen", 9],
    ["noisy-sync", [1, 2, 3], "das Entwicklungsteam hat die Ofline Sinchronisierung geliefert", 5],
    ["back-dashboard", r(2, 7), "das neue Dashboard für die Abrechnung im März", 4],
    ["nordic-skip1", r(1, 8), "und die nordische Partnerschaft mit Northwind", 10],
    ["neg-question", [2, 3], "das ist eine gute Frage darauf kommen wir nach der Pause zurück", null],
    ["neg-koeln-sister", [3, 4], "meine Schwester wohnt in Köln und sagt der Umzug ihrer Firma im Oktober war ein Albtraum", null],
    ["neg-filler", [5, 6], "äh ja also moment ich suche kurz meine Notizen äh genau", null],
    ["neg-other-team", [1, 2], "im anderen Team ist der Umsatz um dreißig Prozent gesunken wegen des Marktes", null],
    ["neg-next-block", [4, 5], "als nächstes der Einstellungsplan sechs Entwickler bis September", null],
    ["neg-smalltalk", [1, 2], "hört ihr mich gut funktioniert die Bildschirmfreigabe oder sehe nur ich nichts", null],
  ]),
  grp("pt", "words", PT, [
    ["fwd-audit", [1, 2], "vamos para a auditoria de segurança não houve falhas críticas", 8],
    ["back-churn", r(1, 6), "voltando ao cancelamento de clientes ele caiu para dois por cento", 3],
    ["lisboa", [1, 2], "a mudança para Lisboa será em outubro", 7],
    ["northwind", [1], "a parceria com a Northwind abre o mercado nórdico", 10],
    ["hiring-skip2", [1, 2, 3], "vamos contratar seis engenheiros até setembro", 6],
    ["marketing", r(1, 5), "a campanha de marketing mira empresas de logistica", 9],
    ["noisy-sync", [1, 2, 3], "a engenharia entregou a sincronisacao ofline", 5],
    ["back-painel", r(2, 7), "o novo painel de faturamento de março", 4],
    ["nordic-skip1", r(1, 8), "e a parceria nórdica com a Northwind", 10],
    ["neg-question", [2, 3], "essa é uma ótima pergunta a gente volta nela depois do intervalo", null],
    ["neg-lisboa-sister", [3, 4], "minha irmã mora em Lisboa e diz que a mudança da empresa dela em outubro foi um pesadelo", null],
    ["neg-filler", [5, 6], "é bom então deixa eu achar minhas anotações um segundo é pronto", null],
    ["neg-other-team", [1, 2], "na outra equipe a receita caiu trinta por cento por causa do mercado", null],
    ["neg-next-block", [4, 5], "agora o plano de contratação seis engenheiros até setembro", null],
    ["neg-smalltalk", [1, 2], "vocês estão me ouvindo bem o compartilhamento de tela funciona ou não vejo nada", null],
  ]),
  grp("ar", "words", AR, [
    ["fwd-audit", [1, 2], "ننتقل الآن إلى تدقيق الأمان لم يجد أي ثغرات حرجة", 8],
    ["back-churn", r(1, 5), "نعود إلى معدل إلغاء العملاء انخفض إلى اثنين في المئة", 3],
    ["dubai", [1, 2], "الانتقال إلى مبنى دبي سيكون في أكتوبر", 7],
    ["hiring-skip2", [1, 2, 3], "خطة التوظيف ستة مهندسين قبل سبتمبر", 6],
    ["sync-skip1", [1, 2, 3], "فريق الهندسة سلم المزامنة دون اتصال", 5],
    ["noisy-dashboard", [1, 2], "اطلقنا لوحه الفوترة الجديده في مارس", 4],
    ["neg-question", [2, 3], "هذا سؤال ممتاز وسنعود إليه بعد الاستراحة", null],
    ["neg-dubai-sister", [3, 4], "أختي تعمل في دبي وتقول إن انتقال شركتها في أكتوبر كان كابوسا", null],
    ["neg-filler", [4, 5], "اه نعم لحظة من فضلكم سأبحث عن ملاحظاتي", null],
    ["neg-other-team", [1, 2], "في الفريق الآخر انخفضت الإيرادات بنسبة ثلاثين في المئة بسبب السوق", null],
  ]),
  grp("fa", "words", FA, [
    ["fwd-audit", [1, 2], "برویم سراغ ممیزی امنیتی هیچ ضعف بحرانی پیدا نشد", 8],
    ["back-churn", r(1, 5), "برگردیم به نرخ ریزش مشتریان که به دو درصد کاهش یافت", 3],
    ["tehran", [1, 2], "جابجایی به ساختمان تهران در ماه اکتبر است", 7],
    ["hiring-skip2", [1, 2, 3], "برنامه استخدام شش مهندس تا سپتامبر", 6],
    ["sync-skip1", [1, 2, 3], "تیم مهندسی همگام سازی آفلاین را تحویل داد", 5],
    ["dashboard", [1, 2], "داشبورد جدید صورتحساب در مارس راه اندازی شد", 4],
    ["neg-question", [2, 3], "سوال خیلی خوبی است بعد از استراحت به آن برمی گردیم", null],
    ["neg-tehran-sister", [3, 4], "خواهر من در تهران کار می کند و می گوید جابجایی شرکتش در اکتبر کابوس بود", null],
    ["neg-filler", [4, 5], "ببخشید یک لحظه صبر کنید یادداشت هایم را پیدا کنم", null],
    ["neg-other-team", [1, 2], "در تیم دیگر درآمد سی درصد کاهش یافت به خاطر بازار", null],
  ]),
  grp("ja", "chars", JA, [
    ["fwd-audit", [1, 2], "次にセキュリティ監査ですが重大な問題は見つかりませんでした", 8],
    ["back-churn", r(1, 5), "解約率に戻りますと二パーセントまで下がりました", 3],
    ["osaka", [1, 2], "十月に大阪のビルへ引っ越す予定です", 7],
    ["hiring-skip2", [1, 2, 3], "九月までにエンジニアを六人採用する計画です", 6],
    ["sync-skip1", [1, 2, 3], "開発チームがオフラインで同期できる機能を出しました", 5],
    ["dashboard", [1, 2], "三月に新しい請求のダッシュボードを公開しました", 4],
    ["neg-question", [2, 3], "いい質問ですね休憩のあとでお答えします", null],
    ["neg-osaka-sister", [3, 4], "姉が大阪で働いていて会社の十月の引っ越しは大変だったと言っていました", null],
    ["neg-filler", [4, 5], "ええとちょっと待ってくださいメモを探しますえーと", null],
    ["neg-other-team", [1, 2], "別のチームでは市場の影響で売上が三十パーセント減りました", null],
  ]),
  grp("zh", "chars", ZH, [
    ["fwd-audit", [1, 2], "接下来是安全审计没有发现任何严重漏洞", 8],
    ["back-churn", r(1, 5), "回到客户流失率已经降到百分之二了", 3],
    ["shanghai", [1, 2], "十月份我们会搬到上海的新大楼", 7],
    ["hiring-skip2", [1, 2, 3], "九月之前要招六个工程师", 6],
    ["sync-skip1", [1, 2, 3], "工程团队把离线同步功能做好了", 5],
    ["dashboard", [1, 2], "三月份发布了新的账单仪表板", 4],
    ["neg-question", [2, 3], "这个问题问得很好休息之后我们再回答", null],
    ["neg-shanghai-sister", [3, 4], "我姐姐在上海工作她说公司十月份搬家特别麻烦", null],
    ["neg-filler", [4, 5], "嗯稍等一下我找一下我的笔记嗯好了", null],
    ["neg-other-team", [1, 2], "另一个团队因为市场原因收入下降了百分之三十", null],
  ]),
  grp("ko", "words", KO, [
    ["fwd-audit", [1, 2], "다음은 보안 감사인데 심각한 문제는 발견되지 않았습니다", 8],
    ["back-churn", r(1, 5), "고객 이탈률로 돌아가면 이 퍼센트로 떨어졌어요", 3],
    ["busan", [1, 2], "시월에 부산의 새 건물로 이전합니다", 7],
    ["hiring-skip2", [1, 2, 3], "구월까지 엔지니어를 여섯 명 채용할 계획입니다", 6],
    ["sync-skip1", [1, 2, 3], "개발팀이 오프라인 동기화 기능을 내놓았습니다", 5],
    ["dashboard", [1, 2], "삼월에 새로운 청구 대시보드를 출시했어요", 4],
    ["neg-question", [2, 3], "좋은 질문이네요 쉬는 시간 후에 답변드릴게요", null],
    ["neg-busan-sister", [3, 4], "제 누나가 부산에서 일하는데 회사가 시월에 이사해서 너무 힘들었대요", null],
    ["neg-filler", [4, 5], "음 잠깐만요 제 메모를 찾아볼게요 음 됐어요", null],
    ["neg-other-team", [1, 2], "다른 팀은 시장 때문에 매출이 삼십 퍼센트 줄었습니다", null],
  ]),
];
