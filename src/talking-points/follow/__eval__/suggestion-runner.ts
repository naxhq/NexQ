import { buildNoteIndex } from "../tokenize";
import { VoiceFollower } from "../follower";
import { splitUnits, joinUnits } from "./notes-and-runner";
import { SUGGEST_NOTES, SuggestCase } from "./suggestion-cases";
import type { NoteBlock } from "../tokenize";

export interface SuggestOutcome {
  name: string;
  lang: string;
  expect: number | null;
  /** 1-based block offered after the line (and the pause after it), or null. */
  offered: number | null;
  /** Any wrong block offered while speaking. */
  wrongSeen: boolean;
  /** The follower itself moved into the expected block (an automatic jump). */
  moved: boolean;
}

/** Held-out use: pass your own note blocks and cases (`lang` only labels the group, `cut` picks word or character chunks). */
export function runSuggestCase(c: SuggestCase, notes: NoteBlock[] = SUGGEST_NOTES[c.lang]): SuggestOutcome {
  const blocks = notes;
  const index = buildNoteIndex(blocks);
  let t = 1_000_000;
  const f = new VoiceFollower(index, { clock: () => t });
  const mode = c.cut === "chars" ? "ja" : "en";
  let seg = 0;
  const speak = (text: string, tick: number) => {
    const units = splitUnits(text, mode);
    const id = `s${seg++}`;
    for (let i = 3; i < units.length; i += 3) {
      f.onInterim(joinUnits(units.slice(0, i), mode), id);
      t += tick;
    }
    f.onFinal(text, id);
  };
  for (const b of c.setup) {
    speak(blocks[b - 1].text, 300);
    t += 1500;
  }
  const idOf = (n: number) => blocks[n - 1].id;
  let wrong = false;
  const seen = (s: ReturnType<VoiceFollower["snapshot"]>) => {
    if (s.suggestion && c.expect !== null && s.suggestion.blockId !== idOf(c.expect)) wrong = true;
    if (s.suggestion && c.expect === null) wrong = true;
  };
  const units = splitUnits(c.say, mode);
  const id = `s${seg++}`;
  for (let i = 3; i < units.length; i += 3) {
    f.onInterim(joinUnits(units.slice(0, i), mode), id);
    t += 500;
    seen(f.snapshot());
  }
  f.onFinal(c.say, id);
  t += 1500; // the pause after the line
  const snap = f.snapshot();
  seen(snap);
  const offered = snap.suggestion ? blocks.findIndex((b) => b.id === snap.suggestion!.blockId) + 1 : null;
  const tokBlock = (p: number) => index.tokens[Math.max(0, Math.min(index.tokens.length - 1, Math.round(p) - 1))].block + 1;
  const moved = c.expect !== null && tokBlock(snap.position) === c.expect;
  return { name: c.name, lang: c.lang, expect: c.expect, offered, wrongSeen: wrong, moved };
}

export function summarise(rs: SuggestOutcome[]) {
  const by: Record<string, { tp: number; fp: number; pos: number; neg: number; negFp: number; either: number }> = {};
  for (const r of rs) {
    const g = (by[r.lang] ??= { tp: 0, fp: 0, pos: 0, neg: 0, negFp: 0, either: 0 });
    if (r.expect !== null) g.pos++;
    else g.neg++;
    if (r.expect !== null && (r.offered === r.expect || r.moved)) g.either++;
    if (r.offered !== null) {
      if (r.offered === r.expect) g.tp++;
      else {
        g.fp++;
        if (r.expect === null) g.negFp++;
      }
    }
  }
  return by;
}
