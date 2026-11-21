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

// Hero opening (00:00 to 00:38). The ranges line up with the speaker bars of the release wave.
export const HERO_LINES: Line[] = [
  { who: 'them', ts: '0:04', text: "Thanks for joining. I'm Dana, I lead hiring for the design team.", from: 0.02, to: 0.27 },
  { who: 'you', ts: '0:11', text: 'Great to meet you, Dana. Happy to be here.', from: 0.31, to: 0.47 },
  { who: 'them', ts: '0:16', text: 'What was the toughest trade-off on your last project?', from: 0.52, to: 0.93 },
];
export const HERO_QUESTION = 'What was the toughest trade-off on your last project?';

// Beat a, 04:12. The other side speaks Spanish, you speak English.
export const A_LINES: Line[] = [
  { who: 'them', ts: '4:02', text: 'Perfecto. Cuéntame cómo trabajas con ingeniería.', tr: 'Perfect. Tell me how you work with engineering.' },
  { who: 'you', ts: '4:11', text: 'I pair with them from day one.' },
  { who: 'them', ts: '4:20', text: 'Me gusta. Cuéntame qué haces si no están de acuerdo.', tr: 'I like that. Tell me what you do if they disagree.' },
];

// Beat b and c, 12:40 and 23:05.
export const B_LINES: Line[] = [
  { who: 'them', ts: '12:19', text: 'Good. Performance matters a lot on our product.' },
  { who: 'you', ts: '12:26', text: 'I treat speed as a design problem too.' },
  { who: 'them', ts: '12:34', text: 'How would you make a slow dashboard with fifty charts feel fast?' },
];
export const B_QUESTION = 'How would you make a slow dashboard with fifty charts feel fast?';

// Beat d and e, 31:20.
export const D_LINES: Line[] = [
  { who: 'them', ts: '30:49', text: 'We loved the portfolio.' },
  { who: 'you', ts: '30:55', text: 'Thank you, I enjoyed talking it through.' },
  { who: 'them', ts: '31:02', text: 'Can you do a second round with our CTO next week?' },
];
export const D_QUESTION = 'Can you do a second round with our CTO next week?';

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

export const TIMES = { h: 38, a: 252, b: 760, c: 1385, d: 1880, e: 2285 } as const; // seconds
export const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

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

/** Speaker of each of the 72 hero wave bars (index / 72 is the bar's position). */
export function heroSpeakers(count = 72): ('you' | 'them' | null)[] {
  const out: ('you' | 'them' | null)[] = Array(count).fill(null);
  for (const l of HERO_LINES) {
    const a = Math.round((l.from ?? 0) * count);
    const b = Math.round((l.to ?? 0) * count);
    for (let i = a; i < b && i < count; i++) out[i] = l.who;
  }
  return out;
}
