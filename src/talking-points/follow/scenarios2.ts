import { Scenario, Step, Lang } from "./fixtures";
import { EXTRA_NOTES } from "./fixtures2";

const v = (note: string, i: number, wer?: number): Step => ({ say: EXTRA_NOTES[note][i - 1].text, wer, truth: i, said: [i] });
const p = (i: number, say: string, wer?: number): Step => ({ say, wer, truth: i, said: [i] });
/** Off-script talk that borrows words (and different numbers) from the note. */
const off = (say: string): Step => ({ say, truth: "hold", off: true });
const back = (i: number, say: string): Step => ({ say, truth: i, back: true });
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, k) => a + k);
const X = (i: number, wer?: number) => v("en2", i, wer);

const sc = (name: string, note: string, lang: Lang, steps: Step[]): Scenario => ({ name, note, lang, steps });

export const SCENARIOS2: Scenario[] = [
  // --- numbers, acronyms, dates, money spoken out
  sc("x2 spoken numbers and acronyms", "en2", "en", [
    X(1),
    p(2, "we passed sock two in the third quarter and iso twenty seven thousand and one is planned for quarter one"),
    p(3, "a r r reached four point two million up thirty eight percent year over year"),
    p(4, "revenue in quarter four was one point one million with enterprise accounts driving most of it"),
    p(7, "support tickets dropped from nine hundred to four hundred and fifty per month after the new help center"),
    p(8, "hiring two data engineers and one security lead by the fifth of may"),
  ]),
  sc("x2 verbatim", "en2", "en", range(1, 8).map((i) => X(i))),
  sc("x2 verbatim wer15", "en2", "en", range(1, 8).map((i) => X(i, 0.15))),
  // --- near-identical bullets
  sc("x2 siblings skip the first", "en2", "en", [X(1), X(2), X(3), X(4), X(6), X(7)]),
  sc("x2 siblings both", "en2", "en", [X(4), X(5), X(6), X(7)]),
  sc("x2 siblings noisy skip first", "en2", "en", [X(4, 0.15), X(6, 0.15), X(7, 0.15)]),
  // --- very short blocks
  sc("x2 short block said", "en2", "en", [
    X(7),
    X(8),
    { say: "any questions", truth: 9, said: [9] },
    X(10),
  ]),
  sc("x2 short block only mentioned", "en2", "en", [
    X(1),
    X(2),
    { say: "I will take questions at the end of the session so please hold on to them until then", truth: "hold", off: true },
    X(3),
  ]),
  // --- off-script borrowing words and different numbers
  sc("x2 off-script borrows", "en2", "en", [
    X(2),
    X(3),
    off("last year revenue fell thirty percent in quarter two when the enterprise accounts left us for a competitor"),
    off("honestly support tickets rose to two thousand per month during the outage in march and nobody had a help center"),
    off("we hired two data engineers last year already and the security lead quit in june before the plan was ready"),
    off("ARR is a metric I never fully trusted, up or down, year over year it jumps around"),
    X(4),
    X(5),
  ]),
  // --- back references in different words
  sc("x2 back references reworded", "en2", "en", [
    ...range(1, 8).map((i) => X(i)),
    back(3, "coming back to the recurring revenue, it ended at four point two million which is thirty eight percent more than last year"),
    X(8),
    back(6, "about the delayed mobile app, we hold it until june and improve performance before anything else"),
    X(10),
    back(2, "on compliance, we cleared sock two last quarter and the iso certification comes next year"),
  ]),
  sc("x2 back reference after digression", "en2", "en", [
    ...range(1, 6).map((i) => X(i)),
    off("sorry the dog is barking, give me one second while I close the door, okay that is better"),
    back(4, "so on revenue, the fourth quarter ended at one point one million and enterprise accounts drove most of that"),
  ]),
  // --- Chinese
  sc("zh verbatim", "zh", "ja", range(1, 8).map((i) => v("zh", i))),
  sc("zh verbatim wer15", "zh", "ja", range(1, 8).map((i) => v("zh", i, 0.15))),
  sc("zh paraphrase", "zh", "ja", [
    v("zh", 1),
    p(2, "第一季度的收入上涨了20%，大客户续约是主要原因。"),
    p(4, "我们最大的风险，是推理服务只依赖一家云厂商。"),
    p(6, "路线图主要围绕三个支柱，也就是可靠性、速度还有协作。"),
    p(7, "到年底我们打算招聘十二名工程师和四名设计师。"),
  ]),
  // --- Korean
  sc("ko verbatim", "ko", "es", range(1, 8).map((i) => v("ko", i))),
  sc("ko verbatim wer15", "ko", "es", range(1, 8).map((i) => v("ko", i, 0.15))),
  sc("ko paraphrase", "ko", "es", [
    v("ko", 1),
    p(2, "대기업 고객이 계약을 갱신해서 첫 번째 분기 매출이 20퍼센트 성장했어요."),
    p(4, "가장 큰 위험은 클라우드 업체 하나에 추론을 의존하는 것입니다."),
    p(6, "로드맵은 안정성과 속도, 그리고 협업이라는 세 가지 축으로 되어 있습니다."),
    p(7, "올해 말까지 엔지니어를 12명, 디자이너를 4명 채용할 예정입니다."),
  ]),
  // --- Japanese, inflection and kanji numerals
  {
    name: "ja paraphrase inflection",
    lang: "ja",
    steps: [
      { say: "皆さん、今日は四半期の結果とロードマップ、それから採用計画をお話しします。", truth: 1, said: [1] },
      p(3, "オンボーディングを作り直したところ、解約率は4.5パーセントから3パーセントまで下がりました。"),
      p(5, "対策は、2026年9月までにマルチクラウド構成に移行することです。"),
      p(7, "年末までにエンジニアを十二名、デザイナーを四名採用する予定です。"),
    ],
  },
];
