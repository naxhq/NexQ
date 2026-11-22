// Sample call shown in the overlay recreation. Everything on screen is written here once and used by
// the live overlay (Overlay.astro) and the static beat frames (BeatFrame.astro).
// It is a made-up conversation (labelled "Sample conversation" on the page). The UI around it mirrors
// the app: src/overlay/OverlayView.tsx, TranscriptLine.tsx, QuestionDetector.tsx, ModeButtons.tsx.

export type Speaker = 'you' | 'them';

export interface Line {
  who: Speaker;
  /** Meeting time, shown the way TranscriptLine does (m:ss). */
  ts: string;
  text: string;
  /** Language of `text` when it is not English (sets `lang` on the text element). */
  lang?: string;
  /** Amber translation under the line (TranscriptLine.tsx L48, #fbbf24). */
  tr?: string;
  /** Hero only: playhead range (0..1) in which the words arrive. */
  from?: number;
  to?: number;
}

// Hero opening (00:00 to 00:38). Only the words live here: when each line starts and ends is read
// from the release wave's phrases at build time (planHero), so the colours fall on real phrases.
export const HERO_SECONDS = 38;
export const HERO_TEXT: { who: Speaker; text: string }[] = [
  { who: 'them', text: "Thanks for joining. I’m Dana, I lead hiring for the design team." },
  { who: 'you', text: 'Great to meet you, Dana. Happy to be here.' },
  { who: 'them', text: 'What was the toughest trade-off on your last project?' },
];
export const HERO_QUESTION = HERO_TEXT[HERO_TEXT.length - 1].text;

// Beat a, 02:10. The other side speaks Spanish, you speak English.
export const A_LINES: Line[] = [
  { who: 'them', ts: '1:49', lang: 'es', text: 'Perfecto. ¿Sigo en español? Me siento más cómoda.', tr: 'Perfect. Shall I go on in Spanish? I feel more comfortable.' },
  { who: 'you', ts: '1:57', text: 'Of course. I’ll keep my side in English.' },
  { who: 'them', ts: '2:04', lang: 'es', text: 'Cuéntame cómo trabajas con ingeniería.', tr: 'Tell me how you work with engineering.' },
];

// Beat b and c, 04:40 and 05:35.
export const B_LINES: Line[] = [
  { who: 'them', ts: '4:19', text: 'Good. Performance matters a lot on our product.' },
  { who: 'you', ts: '4:26', text: 'I treat speed as a design problem too.' },
  { who: 'them', ts: '4:34', text: 'How would you make a slow dashboard with fifty charts feel fast?' },
];
export const B_QUESTION = B_LINES[2].text;
/** Your reply at 5:01, after the beat b answer: on screen in beat c and in After the call. */
export const C_REPLY: Line = { who: 'you', ts: '5:01', text: 'Show something useful first. Load the summary at once, then stream the charts as they arrive.' };

// Beat d and e, 08:10 and 09:05.
export const D_LINES: Line[] = [
  { who: 'them', ts: '7:46', text: 'We loved the portfolio.' },
  { who: 'you', ts: '7:53', text: 'Thank you, I enjoyed talking it through.' },
  { who: 'them', ts: '8:00', text: 'Can you do a second round with our CTO next week?' },
];
export const D_QUESTION = D_LINES[2].text;
/** Your reply at 8:13, after the beat d answer: on screen in beat e and in After the call. */
export const E_REPLY: Line = { who: 'you', ts: '8:13', text: 'Yes. Tuesday after 2 pm or Thursday morning both work.' };

/** "0.7 s", "1:05": the app's formatDuration (src/overlay/responseFormat.ts L4-9). */
export function formatDuration(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < 60_000) return `${(safe / 1000).toFixed(1)} s`;
  const secs = Math.floor(safe / 1000);
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

/**
 * The one timing of an answer, in milliseconds. Every place that shows it (the live counter, the answer's header, the
 * no-JS markup, After the call) reads these numbers, and callDemo.ts paces the run from them:
 *   sending until `sendMs`, waiting until `firstMs` (or until the thinking starts), thinking for `thinkMs` and ending at
 *   `firstMs` (Deep tier only), then writing from `firstMs` until `totalMs`, where the stream ends.
 */
export interface Timing {
  totalMs: number;
  firstMs: number;
  /** Deep tier only (Recap): how long "Thinking…" lasts before the first words. */
  thinkMs?: number;
}
/** Sending ends here for every answer (ms). */
export const SEND_MS = 200;
/** "1.4 s · first words 0.7 s", the way AIResponsePanel.tsx L382-385 builds its timing line. */
export const timingLabel = (t: Timing) => `${formatDuration(t.totalMs)} · first words ${formatDuration(t.firstMs)}`;
function timed<T extends object>(t: Timing, rest: T): T & Timing & { timing: string } {
  if (!(t.firstMs > SEND_MS && t.totalMs > t.firstMs && (t.thinkMs === undefined || (t.thinkMs > 0 && t.firstMs - t.thinkMs >= SEND_MS)))) {
    throw new Error(`content.ts: bad timing ${JSON.stringify(t)}`);
  }
  return { ...rest, ...t, timing: timingLabel(t) };
}

/**
 * Answers, one per action. `**bold**` becomes a bold word. Hero answers stream word by word.
 * The timing is the one every place prints for that answer. Fast tier (Haiku, thinking off) answers are quick; Recap runs
 * on the Deep tier (Sonnet, thinking on), so it thinks first and takes longer (docs/user-guide/claude-subscription.md L22-26).
 * `timing` is the label built from the numbers.
 */
export const ANSWERS: Record<string, { label: string; text: string; timing: string } & Timing> = {
  Assist: timed({ totalMs: 1400, firstMs: 700 }, {
    label: 'Assist',
    text: 'Pick one decision and say why. **We shipped the design system before the redesign.** It cost two weeks, then every screen took days, not weeks. Close with what you would change.',
  }),
  WhatToSay: timed({ totalMs: 1000, firstMs: 500 }, {
    label: 'Say',
    text: 'Say it in two sentences. **“We shipped the design system first. It slowed us by two weeks and saved us months.”**',
  }),
  Shorten: timed({ totalMs: 900, firstMs: 500 }, {
    label: 'Short',
    text: '**Two weeks slower, months faster.** We built the system first.',
  }),
  FollowUp: timed({ totalMs: 1000, firstMs: 500 }, {
    label: 'F/U',
    text: 'Ask Dana: **“How does the team weigh speed against consistency today?”**',
  }),
  Recap: timed({ totalMs: 3200, firstMs: 2100, thinkMs: 1400 }, {
    label: 'Recap',
    text: '**So far:** Dana leads hiring for design. You introduced yourself. She asked for your toughest trade-off.',
  }),
};

// Beat c: a finished answer, mode Short.
export const C_ANSWER = timed({ totalMs: ANSWERS.Shorten.totalMs, firstMs: ANSWERS.Shorten.firstMs }, {
  label: 'Short',
  text: '**Show something useful first.** Load the summary at once, then stream the charts as they arrive.',
});

// Beat d: an answer that used notes and a tool (src-tauri/src/sources/activity.rs L85-111 for the lines).
export const D_ANSWER = timed({ totalMs: 4100, firstMs: 2300 }, {
  label: 'Assist',
  text: '**Yes.** Tuesday after 2 pm or Thursday morning both work. Dana’s notes say you wanted to ask about the team roadmap, so save that for round two.',
  activity: ["Searching notes for 'Dana'", 'Reading Dana.md', 'Calendar: free_slots'],
  chips: [
    { kind: 'notes', label: 'Dana.md' },
    { kind: 'tool', label: 'Calendar: free_slots' },
  ],
});

/**
 * Every other word on the overlay, so Overlay.astro and BeatFrame.astro draw the same text.
 * src: src/overlay/OverlayView.tsx L212-224 (title, mode badge, scenario chip), QuestionDetector.tsx (idle text),
 * AskImages.tsx L24 (placeholder with Claude), ContextScopePicker.tsx (scope picker), SideLanguagePicker.tsx L146-147 (chip).
 */
export const OV = {
  title: 'Design interview with Dana',
  badge: 'ONLINE',
  /** Scenario chip (OverlayView.tsx L222-224): the active scenario's name, src/lib/scenarios.ts L57. */
  scenario: 'Interview',
  idleQuestion: 'Listening for questions from the other party',
  /** askPlaceholder(true): the Claude subscription can take a pasted screenshot (AskImages.tsx L24). */
  askPlaceholder: 'Ask or paste a screenshot',
  askLabel: 'Ask a question (sample, does not send)',
  /** The empty answer panel; on a touch screen the key hint becomes a tap hint. */
  emptyPre: 'Press',
  emptyKey: 'Space',
  emptyPost: 'for AI assistance',
  emptyTap: 'Tap Assist for AI assistance',
  scopeDefault: 'Action default',
  scopeChosen: 'Last 5 min',
  /** The side's language chip while it restarts the speech engine (SideLanguagePicker.tsx L146-147). */
  restarting: 'Restarting…',
  langs: { en: 'EN', es: 'ES' },
  services: { ai: 'Claude', model: 'Haiku', stt: 'Deepgram', you: 'YOU', them: 'THEM' },
  /** The "what was sent" line under the progress row: model and provider, then the transcript lines sent. */
  sent: { fast: 'Haiku · Claude', deep: 'Sonnet · Claude', lines: '3 new transcript lines sent' },
  scopeHeading: 'Focus the next answers on',
  scopeOptions: [
    { label: 'Action default', note: 'Claude decides from the whole meeting', on: false },
    { label: 'Since last answer', note: 'New talk since any answer', on: false },
    { label: 'Last 5 min', note: '', on: true },
    { label: 'Whole meeting', note: 'Everything said so far', on: false },
  ],
} as const;

/** Meeting time of the overlay header in each moment (seconds). Beat eyebrows read the same times. */
export const TIMES = { h: HERO_SECONDS, a: 130, b: 280, c: 335, d: 490, e: 545 } as const;
export const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
/** Transcript stamp, the way TranscriptLine.tsx shows it: m:ss. */
export const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** "4:34" to 274 seconds. */
const stampSeconds = (ts: string) => {
  const [m, sec] = ts.split(':').map(Number);
  return m * 60 + sec;
};
/**
 * The earliest the header timer may read in each beat: one second after the last line on screen, so the
 * clock never runs behind the transcript. callDemo.ts takes the larger of this and the scrolled time.
 */
export const T0 = {
  a: stampSeconds(A_LINES[A_LINES.length - 1].ts) + 1,
  b: stampSeconds(B_LINES[B_LINES.length - 1].ts) + 1,
  c: stampSeconds(C_REPLY.ts) + 1,
  d: stampSeconds(D_LINES[D_LINES.length - 1].ts) + 1,
  e: stampSeconds(E_REPLY.ts) + 1,
} as const;
// Your replies come after the lines they answer.
if (stampSeconds(C_REPLY.ts) <= stampSeconds(B_LINES[B_LINES.length - 1].ts)) throw new Error('C_REPLY must come after the last line of B_LINES');
if (stampSeconds(E_REPLY.ts) <= stampSeconds(D_LINES[D_LINES.length - 1].ts)) throw new Error('E_REPLY must come after the last line of D_LINES');
for (const k of Object.keys(T0) as (keyof typeof T0)[]) {
  if (T0[k] > TIMES[k]) throw new Error(`Beat ${k}: its lines run past the beat's time (${T0[k]} s > ${TIMES[k]} s)`);
}

// Actions, in the order of the app's buttons (src/stores/aiActionsStore.ts L96-141, src/overlay/ModeButtons.tsx L29-48).
// `name` is the full action name for prose and screen readers; `label` is what the button shows.
export const MODES = [
  { mode: 'Assist', name: 'Assist', label: 'Assist', icon: 'sparkles', key: 'Space' },
  { mode: 'WhatToSay', name: 'What to say', label: 'Say', icon: 'message', key: '1' },
  { mode: 'Shorten', name: 'Shorten', label: 'Short', icon: 'scissors', key: '2' },
  { mode: 'FollowUp', name: 'Follow-up', label: 'F/U', icon: 'corner', key: '3' },
  { mode: 'Recap', name: 'Recap', label: 'Recap', icon: 'list', key: '4' },
  { mode: 'AskQuestion', name: 'Ask', label: 'Ask', icon: 'help', key: '5' },
] as const;

/** Parse "**bold**" markers into word tokens, keeping a trailing space on each. */
export function tokens(text: string): { w: string; b: boolean }[] {
  const out: { w: string; b: boolean }[] = [];
  let bold = false;
  for (const part of text.split('**')) {
    for (const w of part.split(/\s+/).filter(Boolean)) out.push({ w, b: bold });
    bold = !bold;
  }
  return out;
}

/** Wave bars at or below this height are the breaths between phrases (src/lib/releaseWave.mjs). */
const BREATH = 0.06;

/** [start, end) bar ranges of the phrases in a release wave: runs of bars between breaths. */
export function phrasesOf(bars: number[]): [number, number][] {
  const out: [number, number][] = [];
  let from = -1;
  bars.forEach((v, i) => {
    if (v <= BREATH + 1e-9) {
      if (from >= 0) out.push([from, i]);
      from = -1;
    } else if (from < 0) from = i;
  });
  if (from >= 0) out.push([from, bars.length]);
  return out;
}

export interface HeroPlan {
  lines: Line[];
  /** Speaker of each wave bar (null in the gaps). */
  speakers: (Speaker | null)[];
}

/**
 * Lay the hero lines onto the phrases of the release wave: each line takes whole, successive phrases,
 * sized by its word count, so colours fall on phrases and the same code works for the next version.
 * Each line's stamp is its start position times HERO_SECONDS, which is what the header timer shows.
 */
export function planHero(bars: number[]): HeroPlan {
  const n = bars.length;
  const lines = HERO_TEXT;
  let phrases = phrasesOf(bars);
  if (phrases.length < lines.length) {
    // Too few phrases to give each line its own: split the wave evenly instead.
    phrases = lines.map((_, i): [number, number] => [Math.round((i * n) / lines.length), Math.round(((i + 1) * n) / lines.length)]);
  }
  const words = lines.map((l) => l.text.split(/\s+/).length);
  const pace = words.reduce((a, b) => a + b, 0) / n; // words per bar, over the whole wave
  // Last phrase of each line. Try every split into successive runs of whole phrases and keep the one
  // where each line's words-per-bar is closest to the overall pace (nobody races, nobody drags).
  let ends: number[] = [];
  let best = Infinity;
  const search = (i: number, from: number, acc: number[], cost: number) => {
    if (cost >= best) return;
    if (i === lines.length - 1) {
      const bars = phrases[phrases.length - 1][1] - phrases[from][0];
      const c = cost + (words[i] / bars - pace) ** 2;
      if (c < best) {
        best = c;
        ends = [...acc, phrases.length - 1];
      }
      return;
    }
    for (let j = from; j <= phrases.length - (lines.length - i); j++) {
      const bars = phrases[j][1] - phrases[from][0];
      search(i + 1, j + 1, [...acc, j], cost + (words[i] / bars - pace) ** 2);
    }
  };
  search(0, 0, [], 0);
  // Build-time check: every line needs phrases of its own, in order, inside the wave. A wave that
  // cannot carry the conversation fails the build instead of shipping a transcript with no words in it.
  if (ends.length !== lines.length || ends.some((e, i) => e === undefined || (i > 0 && e <= ends[i - 1]))) {
    throw new Error(`planHero: no split of ${phrases.length} phrases gives each of the ${lines.length} lines a phrase`);
  }

  const speakers: (Speaker | null)[] = Array(n).fill(null);
  const out: Line[] = lines.map((l, i) => {
    const first = phrases[(ends[i - 1] ?? -1) + 1];
    const last = phrases[ends[i]];
    if (!first || !last) throw new Error(`planHero: line ${i + 1} ("${l.text}") has no phrase`);
    const a = first[0];
    const b = last[1];
    for (let k = a; k < b; k++) speakers[k] = l.who;
    return { who: l.who, text: l.text, from: a / n, to: b / n, ts: clock((a / n) * HERO_SECONDS) };
  });
  out.forEach((l, i) => {
    const { from, to } = l;
    if (from === undefined || to === undefined || !(from >= 0 && to <= 1 && from < to) || (i > 0 && from < (out[i - 1].to as number))) {
      throw new Error(`planHero: line ${i + 1} has a bad playhead range (${from} to ${to}); ranges must be ordered, inside [0, 1]`);
    }
  });
  return { lines: out, speakers };
}
