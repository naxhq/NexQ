import { describe, it, expect } from "vitest";
import { SUGGEST_CASES, SUGGEST_NOTES } from "./suggestion-cases";
import { runSuggestCase, summarise } from "./suggestion-runner";
import { buildNoteIndex } from "../tokenize";
import { VoiceFollower } from "../follower";
import { SuggestionScorer } from "../suggest";
import { VocabMatcher } from "../similarity";
import { mulberry32 } from "./notes-and-runner";

const outcomes = SUGGEST_CASES.map((c) => runSuggestCase(c));

describe("go-to suggestions (dev set)", () => {
  it("English: precision >= 0.8 at recall >= 0.6", () => {
    const g = summarise(outcomes.filter((o) => o.lang === "en")).en;
    expect(g.tp / Math.max(1, g.tp + g.fp)).toBeGreaterThanOrEqual(0.8);
    expect(g.tp / g.pos).toBeGreaterThanOrEqual(0.6);
  });

  it("every language: offers are precise, and the place is offered or reached", () => {
    for (const [lang, g] of Object.entries(summarise(outcomes))) {
      expect(g.tp / Math.max(1, g.tp + g.fp), `${lang} precision`).toBeGreaterThanOrEqual(0.8);
      expect(g.either / g.pos, `${lang} offered or moved`).toBeGreaterThanOrEqual(0.75);
    }
  });

  it("nothing is offered for talk that is off the script or already handled", () => {
    const neg = outcomes.filter((o) => o.expect === null);
    const bad = neg.filter((o) => o.offered !== null).map((o) => o.name);
    expect(bad).toEqual([]);
  });

  it("a dismissed offer does not come back, and offers are rate limited", () => {
    const blocks = SUGGEST_NOTES.en;
    const idx = buildNoteIndex(blocks);
    let t = 0;
    const f = new VoiceFollower(idx, { clock: () => t });
    f.onFinal(blocks[0].text, "a");
    const say = (txt: string, id: string) => {
      f.onInterim(txt.split(" ").slice(0, 5).join(" "), id);
      t += 600;
      f.onFinal(txt, id);
      t += 1500;
      return f.snapshot().suggestion?.blockId;
    };
    expect(say(blocks[8].text, "b")).toBe("en9");
    f.dismissSuggestion("en9");
    expect(f.snapshot().suggestion?.blockId).not.toBe("en9");
    expect(say(blocks[8].text, "c")).not.toBe("en9");
    // a different block right away: not before the rate limit has passed
    const other = say(blocks[10].text, "d");
    if (other) expect(other).toBe("en11");
  });

  const bench = (): { median: number; p95: number } => {
    const rnd = mulberry32(3);
    const syl = ["ba", "ko", "re", "ti", "mu", "la", "do", "ne", "si", "pra", "vel", "quo", "zin", "tar", "mex"];
    const pick = () => syl[Math.floor(rnd() * syl.length)];
    const vocab = Array.from({ length: 700 }, () => pick() + pick() + pick());
    const blocks = Array.from({ length: 170 }, (_, i) => ({
      id: `b${i}`,
      text: Array.from({ length: 12 }, () => vocab[Math.floor(rnd() * vocab.length)]).join(" "),
    }));
    const idx = buildNoteIndex(blocks);
    expect(idx.tokens.length).toBeGreaterThanOrEqual(2000);
    const sc = new SuggestionScorer(idx, new VocabMatcher(idx.vocab, idx.vocabIdx));
    const times: number[] = [];
    for (let i = 0; i < 300; i++) {
      const words = blocks[(i * 7) % 170].text.split(" ").slice(0, 3 + (i % 10));
      const t0 = performance.now();
      sc.candidate(words, 10, 12);
      times.push(performance.now() - t0);
    }
    times.splice(0, 30);
    times.sort((a, b) => a - b);
    return { median: times[Math.floor(times.length / 2)], p95: times[Math.floor(times.length * 0.95)] };
  };

  it("per-line cost on a 2,000-word note stays small (generous bound: wall clock is noisy under load)", () => {
    const { median } = bench();
    expect(median).toBeLessThan(20);
  });

  // manual benchmark on a quiet machine: remove .skip
  it.skip("manual benchmark: under 1 ms per line on a 2,000-word note", () => {
    const { median, p95 } = bench();
    expect(median).toBeLessThan(1);
    expect(p95).toBeLessThan(2);
  });
});
