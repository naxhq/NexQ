/** Test fixtures: notes in four languages, a deterministic STT corrupter and a scenario runner. */
import { buildNoteIndex, NoteBlock, NoteIndex } from "./tokenize";
import { VoiceFollower, FollowState } from "./follower";
import { SaidTracker } from "./said";

export type Lang = "en" | "es" | "de" | "ja";

const mk = (prefix: string, texts: string[]): NoteBlock[] => texts.map((text, i) => ({ id: `${prefix}${i + 1}`, text }));

export const NOTES: Record<Lang, NoteBlock[]> = {
  en: mk("en", [
    "Welcome everyone, today I will cover our results, the roadmap and the hiring plan.",
    "Revenue grew 20 percent in the first quarter driven by enterprise renewals.",
    "Revenue grew 35 percent in the second quarter driven by new logos in Europe.",
    "Churn dropped from 4.5 percent to 3 percent after we rebuilt onboarding.",
    "Our biggest risk is the dependency on a single cloud vendor for inference.",
    "Mitigation: migrate to a multi cloud setup by September 2025 with Kubernetes.",
    "The roadmap has three pillars: reliability, speed and collaboration.",
    "Reliability means 99.9 percent uptime and automated failover.",
    "Speed means cutting the median latency from 800 milliseconds to 200 milliseconds.",
    "Collaboration means shared workspaces, comments and a public API for partners.",
    "We plan to hire 12 engineers and 4 designers before the end of 2026.",
    "Budget for hiring is 2.4 million dollars, approved by the board in March.",
    "Questions about pricing: we keep the free tier and add a team plan at 29 dollars per seat.",
    "Thank you, the slides and the demo recording will be shared tomorrow morning.",
  ]),
  es: mk("es", [
    "Bienvenidos, hoy presento los resultados del trimestre y el plan de contratación.",
    "Los ingresos crecieron un 20 por ciento gracias a las renovaciones de grandes clientes.",
    "La rotación bajó del 4,5 por ciento al 3 por ciento después de rediseñar la incorporación.",
    "El mayor riesgo es depender de un único proveedor de nube para la inferencia.",
    "Para mitigarlo migraremos a una arquitectura multinube antes de septiembre de 2026.",
    "La hoja de ruta tiene tres pilares: fiabilidad, velocidad y colaboración.",
    "Contrataremos 12 ingenieros y 4 diseñadores antes de fin de año.",
    "Gracias, compartiré las diapositivas y la grabación de la demostración mañana.",
  ]),
  de: mk("de", [
    "Willkommen, heute stelle ich die Ergebnisse, die Roadmap und den Einstellungsplan vor.",
    "Der Umsatz ist im ersten Quartal um 20 Prozent gestiegen, getrieben von Verlängerungen bei Großkunden.",
    "Die Kündigungsrate sank von 4,5 Prozent auf 3 Prozent, nachdem wir das Onboarding neu gebaut haben.",
    "Unser größtes Risiko ist die Abhängigkeit von einem einzigen Cloud-Anbieter für die Inferenz.",
    "Zur Absicherung wechseln wir bis September 2026 zu einer Multi-Cloud-Architektur.",
    "Die Roadmap hat drei Säulen: Zuverlässigkeit, Geschwindigkeit und Zusammenarbeit.",
    "Wir stellen 12 Entwickler und 4 Designer vor Jahresende ein.",
    "Vielen Dank, die Folien und die Aufzeichnung der Demo schicke ich morgen früh.",
  ]),
  ja: mk("ja", [
    "皆さん、本日は四半期の結果とロードマップと採用計画についてお話しします。",
    "売上は第一四半期に20パーセント増加し、大口顧客の契約更新が牽引しました。",
    "解約率はオンボーディングを作り直した結果、4.5パーセントから3パーセントに下がりました。",
    "最大のリスクは、推論を単一のクラウドベンダーに依存していることです。",
    "対策として、2026年9月までにマルチクラウド構成へ移行します。",
    "ロードマップの柱は、信頼性、速度、そして共同作業の三つです。",
    "年末までにエンジニアを12名、デザイナーを4名採用する予定です。",
    "ありがとうございました。スライドとデモの録画は明日の朝に共有します。",
  ]),
};

// ---------------------------------------------------------------------------
// Deterministic STT corrupter
// ---------------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const POOL: Record<Lang, string[]> = {
  en: ["so", "the", "yeah", "okay", "actually", "right", "and", "that", "this", "well", "now", "just"],
  es: ["entonces", "bueno", "pues", "y", "que", "vale", "este", "ahora"],
  de: ["also", "ja", "und", "dass", "genau", "dann", "nun", "halt"],
  ja: ["あの", "えっと", "まあ", "そして"],
};
const KANA = "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん";

/** Splits text into the units an ASR would get wrong: words, or ~3-char chunks for Japanese. */
export function splitUnits(text: string, lang: Lang): string[] {
  if (lang === "ja") return text.match(/[\s\S]{1,3}/gu) ?? [];
  return text.split(/\s+/).filter(Boolean);
}
export const joinUnits = (u: string[], lang: Lang) => u.join(lang === "ja" ? "" : " ");

/** Word-level corrupter at the given word error rate: 50% substitutions, 30% deletions, 20% insertions. */
export function corrupt(text: string, wer: number, seed: number, lang: Lang): string {
  if (wer <= 0) return text;
  const rnd = mulberry32(seed);
  const out: string[] = [];
  for (const u of splitUnits(text, lang)) {
    if (rnd() >= wer) {
      out.push(u);
      continue;
    }
    const op = rnd();
    if (op < 0.5) {
      if (lang === "ja") {
        const cs = Array.from(u);
        cs[Math.floor(rnd() * cs.length)] = KANA[Math.floor(rnd() * KANA.length)];
        out.push(cs.join(""));
      } else if (rnd() < 0.5 && u.length >= 4) {
        const k = 1 + Math.floor(rnd() * (u.length - 2));
        out.push(rnd() < 0.5 ? u.slice(0, k) + u.slice(k + 1) : u.slice(0, k) + "q" + u.slice(k + 1));
      } else {
        const pool = POOL[lang];
        out.push(pool[Math.floor(rnd() * pool.length)]);
      }
    } else if (op < 0.8) {
      // deletion
    } else {
      const pool = POOL[lang];
      out.push(pool[Math.floor(rnd() * pool.length)], u);
    }
  }
  return joinUnits(out, lang);
}

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------

export interface Step {
  /** Text spoken by the user. */
  say: string;
  /** Word error rate applied to this step. */
  wer?: number;
  /** Not fed (the other side speaking). */
  notFed?: boolean;
  /** Expected place after the step: a 1-based block (its end) or "hold" (same as before). */
  truth: number | "hold";
  /** 1-based blocks that count as said by this step. */
  said?: number[];
}

export interface Scenario {
  name: string;
  lang: Lang;
  steps: Step[];
}

export interface Checkpoint {
  pos: number;
  truth: number;
  state: FollowState;
  strict: boolean;
  acceptable: boolean;
  confidentWrong: boolean;
}

export interface ScenarioResult {
  name: string;
  checkpoints: Checkpoint[];
  expectedSaid: Set<string>;
  ticked: Set<string>;
  backJumps: number;
}

export function wordsOf(step: string, lang: Lang): string[] {
  return splitUnits(step, lang);
}

/** Feed one utterance as interims (every few units, with a half-spoken last word) then a final. */
export function speak(
  text: string,
  lang: Lang,
  segId: string,
  sink: { onInterim(t: string, id: string): void; onFinal(t: string, id: string): void },
  tick: () => void,
): void {
  const units = splitUnits(text, lang);
  const every = lang === "ja" ? 3 : 3;
  for (let i = every; i < units.length; i += every) {
    let part = joinUnits(units.slice(0, i), lang);
    if (lang !== "ja") {
      const last = units[i - 1];
      if (last.length > 4) part = joinUnits([...units.slice(0, i - 1), last.slice(0, last.length - 2)], lang);
    }
    sink.onInterim(part, segId);
    tick();
  }
  sink.onFinal(text, segId);
}

export function runScenario(sc: Scenario, seed = 1): ScenarioResult {
  const blocks = NOTES[sc.lang];
  const index: NoteIndex = buildNoteIndex(blocks);
  const tol = 8 * index.scale;
  let t = 1_000_000;
  const clock = () => t;
  const follower = new VoiceFollower(index, { clock });
  const tracker = new SaidTracker(index, { clock });
  const sink = {
    onInterim: (x: string, id: string) => {
      follower.onInterim(x, id);
      tracker.onInterim(x, id);
    },
    onFinal: (x: string, id: string) => {
      follower.onFinal(x, id);
      tracker.onFinal(x, id);
    },
  };
  const checkpoints: Checkpoint[] = [];
  const expected = new Set<string>();
  let prevTruth = 0;
  let prevPos = 0;
  let backJumps = 0;
  sc.steps.forEach((s, i) => {
    const truth = s.truth === "hold" ? prevTruth : index.blocks[s.truth - 1].end;
    for (const b of s.said ?? []) expected.add(blocks[b - 1].id);
    if (s.notFed) {
      t += 4000;
      return;
    }
    const text = s.wer ? corrupt(s.say, s.wer, seed * 1000 + i, sc.lang) : s.say;
    speak(text, sc.lang, `${sc.name}-${i}`, sink, () => (t += 700));
    t += 1500;
    const snap = follower.snapshot();
    const strict = Math.abs(snap.position - truth) <= tol;
    checkpoints.push({
      pos: snap.position,
      truth,
      state: snap.state,
      strict,
      acceptable: strict || snap.state !== "following",
      confidentWrong: !strict && snap.state === "following",
    });
    if (snap.position < prevPos - tol) backJumps++;
    prevPos = snap.position;
    prevTruth = truth;
  });
  return {
    name: sc.name,
    checkpoints,
    expectedSaid: expected,
    ticked: new Set(tracker.saidBlockIds()),
    backJumps,
  };
}
