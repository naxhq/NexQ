import { NOTES, Scenario, Step, Lang } from "./notes-and-runner";

/** Verbatim delivery of block i (1-based). */
const v = (lang: Lang, i: number, wer?: number): Step => ({ say: NOTES[lang][i - 1].text, wer, truth: i, said: [i] });
/** Own wording of block i (key words kept). */
const p = (i: number, say: string, wer?: number): Step => ({ say, wer, truth: i, said: [i] });
/** Digression: off script, place does not change. */
const d = (say: string): Step => ({ say, truth: "hold" });
/** The other side speaking: never fed. */
const other = (say: string): Step => ({ say, notFed: true, truth: "hold" });
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, k) => a + k);

const EN = (i: number, wer?: number) => v("en", i, wer);

const FILLED = (i: number): Step => ({
  say: "um so " + NOTES.en[i - 1].text.replace(/, /g, " uh, ").replace(/ (the|in|by) /g, " $1 you know "),
  truth: i,
  said: [i],
});

export const SCENARIOS: Scenario[] = [
  { name: "en verbatim", lang: "en", steps: range(1, 14).map((i) => EN(i)) },
  { name: "en verbatim wer10", lang: "en", steps: range(1, 14).map((i) => EN(i, 0.1)) },
  { name: "en verbatim wer20", lang: "en", steps: range(1, 14).map((i) => EN(i, 0.2)) },
  {
    name: "en paraphrase",
    lang: "en",
    steps: [
      EN(1),
      p(2, "Revenue was up twenty percent in the first quarter, mostly enterprise renewals driving it."),
      p(3, "In the second quarter revenue grew thirty five percent thanks to new logos across Europe."),
      p(4, "Churn fell from four point five percent down to three percent once we rebuilt onboarding."),
      p(5, "The biggest risk we have is relying on one single cloud vendor for inference."),
      p(6, "To mitigate that we will migrate to a multi cloud setup with Kubernetes by September 2025."),
    ],
  },
  {
    name: "en paraphrase wer15",
    lang: "en",
    steps: [
      EN(1, 0.15),
      p(2, "Revenue was up twenty percent in the first quarter, mostly enterprise renewals driving it.", 0.15),
      p(3, "In the second quarter revenue grew thirty five percent thanks to new logos across Europe.", 0.15),
      p(5, "The biggest risk we have is relying on one single cloud vendor for inference.", 0.15),
      p(7, "Our roadmap rests on three pillars: reliability, speed and collaboration.", 0.15),
    ],
  },
  { name: "en skipped bullet", lang: "en", steps: [1, 2, 3, 5, 6].map((i) => EN(i)) },
  { name: "en skipped three", lang: "en", steps: [1, 2, 3, 4, 8, 9, 10].map((i) => EN(i)) },
  {
    name: "en back reference",
    lang: "en",
    steps: [
      ...range(1, 8).map((i) => EN(i)),
      { say: "Going back to the second quarter numbers, revenue grew 35 percent driven by new logos in Europe.", truth: 3 },
      EN(9),
      EN(10),
    ],
  },
  {
    name: "en interviewer interrupts",
    lang: "en",
    steps: [
      EN(1),
      EN(2),
      other("Can you tell me more about how you handle risk and what your team looks like today?"),
      EN(3),
      other("Interesting. And how did the onboarding rebuild go?"),
      EN(4),
      EN(5),
    ],
  },
  {
    name: "en number formats",
    lang: "en",
    steps: [
      EN(1),
      p(2, "revenue grew twenty percent in the first quarter driven by enterprise renewals"),
      EN(3),
      p(4, "churn dropped from four point five percent to three percent after we rebuilt onboarding"),
      EN(5),
      EN(6),
      EN(7),
      p(8, "reliability means ninety nine point nine percent uptime and automated failover"),
      p(9, "speed means cutting the median latency from eight hundred milliseconds to two hundred milliseconds"),
      EN(10),
      p(11, "we plan to hire twelve engineers and four designers before the end of twenty twenty six"),
      p(12, "budget for hiring is two point four million dollars approved by the board in march"),
      p(13, "questions about pricing we keep the free tier and add a team plan at twenty nine dollars per seat"),
    ],
  },
  {
    name: "en two similar bullets",
    lang: "en",
    steps: [EN(1), { ...EN(3), said: [3] }, EN(4)],
  },
  {
    name: "en similar bullets noisy",
    lang: "en",
    steps: [EN(1), EN(2, 0.15), EN(3, 0.15), EN(4, 0.15)],
  },
  {
    name: "en digression and return",
    lang: "en",
    steps: [
      ...range(1, 4).map((i) => EN(i)),
      d("By the way did you see the game last night, it went to double overtime and honestly I could not believe the referee."),
      EN(5),
      EN(6),
    ],
  },
  {
    name: "en long digression",
    lang: "en",
    steps: [
      ...range(1, 5).map((i) => EN(i)),
      d("That reminds me of a trip last summer when we drove along the coast for two days, stopped at a tiny bakery near the harbour, and the owner told us a story about her grandmother and the storm that took the old pier."),
      EN(6),
      EN(7),
    ],
  },
  { name: "en fillers", lang: "en", steps: [EN(1), ...[2, 3, 4, 5, 6].map(FILLED)] },
  {
    name: "en repeat a line",
    lang: "en",
    steps: [
      EN(1),
      EN(2),
      { say: "As I said, revenue grew twenty percent in the first quarter driven by enterprise renewals.", truth: 2 },
      EN(3),
    ],
  },
  { name: "en far jump", lang: "en", steps: [EN(1), EN(2), EN(13), EN(14)] },
  { name: "en start mid note", lang: "en", steps: range(5, 8).map((i) => EN(i)) },
  { name: "en start far", lang: "en", steps: range(12, 14).map((i) => EN(i)) },
  {
    name: "en one long segment",
    lang: "en",
    steps: [
      EN(1),
      {
        say: range(2, 5).map((i) => NOTES.en[i - 1].text).join(" "),
        wer: 0.1,
        truth: 5,
        said: [2, 3, 4, 5],
      },
      EN(6),
    ],
  },
  {
    name: "en nothing said",
    lang: "en",
    steps: [
      d("Okay let me just check that everyone can hear me before we begin, the sound seemed a bit off earlier."),
      d("I made some coffee this morning and the machine in the kitchen is making a strange noise again."),
      d("The weather is supposed to turn cold by the weekend, so we might move the offsite to next time."),
      d("Honestly the best part of the day was lunch, we had pasta with a really good tomato sauce."),
      d("Anyway let me know if the video freezes and I will switch off my camera for a while."),
    ],
  },
  {
    name: "en mention in passing",
    lang: "en",
    steps: [
      EN(1),
      d("Somebody asked about pricing earlier but we will come back to that later, and I will not go into the roadmap yet."),
      EN(2),
      EN(3),
    ],
  },
  // --- Spanish
  { name: "es verbatim", lang: "es", steps: range(1, 8).map((i) => v("es", i)) },
  { name: "es verbatim wer15", lang: "es", steps: range(1, 8).map((i) => v("es", i, 0.15)) },
  {
    name: "es paraphrase skip",
    lang: "es",
    steps: [
      v("es", 1),
      p(2, "Los ingresos subieron un 20 por ciento, sobre todo por las renovaciones de los grandes clientes."),
      p(4, "El riesgo más grande es depender de un solo proveedor de nube para la inferencia."),
      p(6, "La hoja de ruta se apoya en tres pilares: fiabilidad, velocidad y colaboración."),
      v("es", 8),
    ],
  },
  {
    name: "es digression back",
    lang: "es",
    steps: [
      v("es", 1),
      v("es", 2),
      v("es", 3),
      d("Por cierto, ayer vi el partido y el árbitro fue una vergüenza total, no entiendo cómo siguen así."),
      v("es", 4),
      v("es", 5),
      { say: "Volviendo a los ingresos, crecieron un 20 por ciento gracias a las renovaciones de grandes clientes.", truth: 2 },
      v("es", 6),
    ],
  },
  // --- German
  { name: "de verbatim", lang: "de", steps: range(1, 8).map((i) => v("de", i)) },
  { name: "de verbatim wer15", lang: "de", steps: range(1, 8).map((i) => v("de", i, 0.15)) },
  {
    name: "de paraphrase skip",
    lang: "de",
    steps: [
      v("de", 1),
      p(2, "Im ersten Quartal ist der Umsatz um 20 Prozent gewachsen, vor allem wegen Verlängerungen bei Großkunden."),
      p(4, "Das größte Risiko ist, dass wir von nur einem Cloud-Anbieter für die Inferenz abhängen."),
      p(6, "Die Roadmap steht auf drei Säulen: Zuverlässigkeit, Geschwindigkeit und Zusammenarbeit."),
      v("de", 8),
    ],
  },
  {
    name: "de digression interviewer",
    lang: "de",
    steps: [
      v("de", 1),
      v("de", 2),
      other("Können Sie das bitte genauer erklären?"),
      v("de", 3),
      d("Übrigens, haben Sie gestern das Spiel gesehen? Der Schiedsrichter war wirklich schwach, das kann man nicht anders sagen."),
      v("de", 4),
      v("de", 5),
    ],
  },
  // --- Japanese
  { name: "ja verbatim", lang: "ja", steps: range(1, 8).map((i) => v("ja", i)) },
  { name: "ja verbatim wer15", lang: "ja", steps: range(1, 8).map((i) => v("ja", i, 0.15)) },
  {
    name: "ja paraphrase skip",
    lang: "ja",
    steps: [
      v("ja", 1),
      p(2, "売上は第一四半期に20パーセント伸びて、大口顧客の契約更新が主な要因でした。"),
      p(4, "最大のリスクは、クラウドベンダーが一社だけで、推論がそれに依存している点です。"),
      p(6, "ロードマップは、信頼性と速度と共同作業という三つの柱で構成されます。"),
      v("ja", 8),
    ],
  },
  {
    name: "ja digression back",
    lang: "ja",
    steps: [
      v("ja", 1),
      v("ja", 2),
      v("ja", 3),
      d("ところで昨日の試合を見ましたか、審判の判定がひどくて本当に驚きました、あれはないですよね。"),
      v("ja", 4),
      v("ja", 5),
      { say: "売上の話に戻ると、第一四半期に20パーセント増加して、大口顧客の契約更新が牽引しました。", truth: 2 },
      v("ja", 6),
    ],
  },
];
