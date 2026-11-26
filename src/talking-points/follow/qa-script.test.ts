/** QA's "QA Script" note and line timing, at the follower: what is offered, and what is not. */
import { describe, it, expect } from "vitest";
import { buildNoteIndex } from "./tokenize";
import { VoiceFollower } from "./follower";

const LINES = [
  "Our backups stay in Frankfurt and Dublin and never leave the European Union",
  "One named contact handles incidents and answers within one hour",
  "The twenty twenty four rate holds for two years if we sign before January",
  "Support staff outside Europe cannot open customer records without approval",
  "The procurement call is planned for the ninth of December in Chicago",
  "We migrated every customer record to regional storage over three years",
  "Security questionnaire answers match the master services agreement",
  "The renewal covers four hundred seats with room to grow",
];

/** Lines read as finals 900 ms apart, 1.5 s of quiet, then the line as interims every 3 words, then 1.9 s. */
function run(upto: number, say: string) {
  const idx = buildNoteIndex(LINES.map((text, i) => ({ id: `q${i}`, text })));
  let t = 1000;
  const f = new VoiceFollower(idx, { clock: () => t });
  for (let i = 0; i <= upto; i++) {
    f.onFinal(LINES[i], `r${i}`);
    t += 900;
  }
  t += 1500;
  const start = f.snapshot().position;
  const w = say.split(" ");
  for (let k = 3; k < w.length; k += 3) {
    f.onInterim(w.slice(0, k).join(" "), "c");
    t += 110;
  }
  f.onFinal(say, "c");
  t += 1900;
  return { start, snap: f.snapshot(), idx };
}

describe("QA Script", () => {
  it("off-script chat about a frozen video moves nothing and offers nothing", () => {
    for (const say of [
      "Sorry the video froze for a second can everyone see my screen",
      "Let me share the other window real quick",
      "I will send the notes to everyone after the call",
    ]) {
      const { start, snap } = run(3, say);
      // at most a nudge inside the current line (one shared word), never a jump
      expect(Math.abs(snap.position - start), say).toBeLessThanOrEqual(8);
      expect(snap.suggestion, say).toBeUndefined();
    }
  });

  it("an earlier point said word for word, and a paraphrase of a far later point, are offered", () => {
    const a = run(4, LINES[0]);
    expect(a.snap.suggestion?.blockId).toBe("q0");
    const b = run(2, "The renewal includes four hundred seats and has room to grow");
    expect(b.snap.suggestion?.blockId).toBe("q7");
  });
});
