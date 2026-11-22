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
  { who: 'them', text: "Thanks for joining. I'm Dana, I lead hiring for the design team." },
  { who: 'you', text: 'Great to meet you, Dana. Happy to be here.' },
  { who: 'them', text: 'What was the toughest trade-off on your last project?' },
];
export const HERO_QUESTION = HERO_TEXT[HERO_TEXT.length - 1].text;

// Beat a, 02:10. The other side speaks Spanish, you speak English.
export const A_LINES: Line[] = [
  { who: 'them', ts: '1:49', text: 'Perfecto. Cuéntame cómo trabajas con ingeniería.', tr: 'Perfect. Tell me how you work with engineering.' },
  { who: 'you', ts: '1:57', text: 'I pair with them from day one.' },
  { who: 'them', ts: '2:04', text: 'Me gusta. Cuéntame qué haces si no están de acuerdo.', tr: 'I like that. Tell me what you do if they disagree.' },
];

// Beat b and c, 04:40 and 05:35.
export const B_LINES: Line[] = [
  { who: 'them', ts: '4:19', text: 'Good. Performance matters a lot on our product.' },
  { who: 'you', ts: '4:26', text: 'I treat speed as a design problem too.' },
  { who: 'them', ts: '4:34', text: 'How would you make a slow dashboard with fifty charts feel fast?' },
];
export const B_QUESTION = B_LINES[2].text;

// Beat d and e, 08:10 and 09:05.
export const D_LINES: Line[] = [
  { who: 'them', ts: '7:46', text: 'We loved the portfolio.' },
  { who: 'you', ts: '7:53', text: 'Thank you, I enjoyed talking it through.' },
  { who: 'them', ts: '8:00', text: 'Can you do a second round with our CTO next week?' },
];
export const D_QUESTION = D_LINES[2].text;

/** Answers. `**bold**` becomes a bold word. Hero answers stream word by word. */
export const ANSWERS: Record<string, { label: string; text: string }> = {
  Assist: {
    label: 'Assist',
    text: 'Pick one decision and say why. **We shipped the design system before the redesign.** It cost two weeks up front, and every screen after that took days, not weeks. Close with what you would do differently.',
  },
  WhatToSay: {
    label: 'Say',
    text: 'Say it in two sentences. **"We shipped the design system first. It slowed us by two weeks and saved us months."**',
  },
  Shorten: { label: 'Short', text: '**Two weeks slower, months faster.** We built the system first.' },
  FollowUp: { label: 'F/U', text: 'Ask Dana: **"How does the team weigh speed against consistency today?"**' },
  Recap: {
    label: 'Recap',
    text: '**So far:** Dana leads hiring for design. You introduced yourself. She asked for your toughest trade-off.',
  },
};

// Beat c: a finished answer, mode Short.
export const C_ANSWER = {
  label: 'Short',
  text: '**Show something useful first.** Load the summary at once, then stream the charts as they arrive.',
  timing: '0.9 s · first words 0.4 s',
};

// Beat d: an answer that used notes and a tool (src-tauri/src/sources/activity.rs L85-111 for the lines).
export const D_ANSWER = {
  label: 'Assist',
  text: '**Yes.** Tuesday after 2 pm or Thursday morning both work, so offer both. Dana\'s notes say you wanted to ask about the team roadmap, so keep that for the second round.',
  timing: '4.1 s · first words 2.3 s',
  activity: ["Searching notes for 'Dana'", 'Reading Dana.md', 'Calendar: free_slots'],
  chips: [
    { kind: 'notes', label: 'Dana.md' },
    { kind: 'tool', label: 'Calendar: free_slots' },
  ],
};

/** Meeting time of the overlay header in each moment (seconds). Beat eyebrows read the same times. */
export const TIMES = { h: HERO_SECONDS, a: 130, b: 280, c: 335, d: 490, e: 545 } as const;
export const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
/** Transcript stamp, the way TranscriptLine.tsx shows it: m:ss. */
export const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

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

  const speakers: (Speaker | null)[] = Array(n).fill(null);
  const out: Line[] = lines.map((l, i) => {
    const a = phrases[(ends[i - 1] ?? -1) + 1][0];
    const b = phrases[ends[i]][1];
    for (let k = a; k < b; k++) speakers[k] = l.who;
    return { who: l.who, text: l.text, from: a / n, to: b / n, ts: clock((a / n) * HERO_SECONDS) };
  });
  return { lines: out, speakers };
}
