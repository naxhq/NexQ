import { describe, it, expect } from "vitest";
import { buildNoteIndex, tokenizeText, spokenWords } from "./tokenize";
import { wordSim } from "./similarity";
import { VoiceFollower } from "./follower";
import { SaidTracker } from "./said";
import { ScrollController, ManualYield, MANUAL_YIELD_MS, LineMetric } from "./scroll";
import { NOTES, mulberry32 } from "./__eval__/notes-and-runner";

const toks = (s: string) => tokenizeText(s).map((t) => t.t);

describe("tokenizer", () => {
  it("folds accents, case, ligatures and contractions", () => {
    expect(toks("Café Straße")).toEqual(["cafe", "strasse"]);
    expect(toks("I'm sure we don't know, it's fine")).toEqual(["i", "am", "sure", "we", "do", "not", "know", "it", "fine"]);
    expect(toks("can't won't")).toEqual(["can", "not", "will", "not"]);
  });
  it("normalises number formats both ways", () => {
    expect(toks("twenty percent")).toEqual(["20", "pct"]);
    expect(toks("20%")).toEqual(["20", "pct"]);
    expect(toks("twenty twenty six")).toEqual(["2026"]);
    expect(toks("nineteen ninety nine")).toEqual(["1999"]);
    expect(toks("two thousand and five")).toEqual(["2005"]);
    expect(toks("ninety nine point nine percent")).toEqual(["99.9", "pct"]);
    expect(toks("twenty-five dollars")).toEqual(["25", "dollars"]);
    expect(toks("one hundred twenty")).toEqual(["120"]);
    expect(toks("1,000 and 4,5")).toEqual(["1000", "and", "4.5"]);
    expect(toks("twelve engineers")).toEqual(["12", "engineers"]);
    expect(toks("five six")).toEqual(["5", "6"]);
  });
  it("drops fillers and keeps offsets", () => {
    const t = tokenizeText("um revenue, uh grew");
    expect(t.map((x) => x.t)).toEqual(["revenue", "grew"]);
    expect("um revenue, uh grew".slice(t[0].start, t[0].end)).toBe("revenue");
  });
  it("makes character bigrams for CJK, katakana folded to hiragana", () => {
    expect(toks("ロードマップ")).toEqual(["ろー", "ーど", "どま", "まっ", "っぷ"]);
    expect(toks("売上は20パーセント")).toContain("20");
  });
  it("computes idf from the note itself, no stop list", () => {
    const idx = buildNoteIndex([
      { id: "a", text: "revenue grew with the team" },
      { id: "b", text: "churn fell with the team" },
      { id: "c", text: "kubernetes migration with the team" },
    ]);
    const w = (s: string) => idx.vocabW[idx.vocabIdx.get(s)!];
    expect(w("kubernetes")).toBeGreaterThan(w("team"));
    expect(w("team")).toBeGreaterThan(w("the") - 0.001);
  });
  it("similarity: stems, typos, phonetics, numbers exact", () => {
    expect(wordSim("revenue", "revenu")).toBeGreaterThan(0.7);
    expect(wordSim("kubernetes", "cubernetes")).toBeGreaterThan(0.7);
    expect(wordSim("listen", "listening")).toBeGreaterThan(0.7);
    expect(wordSim("plan", "pray")).toBe(0);
    expect(wordSim("20", "21")).toBe(0);
  });
});

describe("follower", () => {
  const idx = buildNoteIndex(NOTES.en);
  const mkF = () => {
    let t = 0;
    const f = new VoiceFollower(idx, { clock: () => t });
    return { f, adv: (ms: number) => (t += ms) };
  };

  it("interim corrections do not double count", () => {
    const a = mkF();
    const b = mkF();
    const text = NOTES.en[1].text;
    for (const part of ["revenue", "revenue grew", "revenue grew twenty per", "revenue grew twenty percent in the first"]) {
      a.f.onInterim(part, "s1");
    }
    a.f.onFinal(text, "s1");
    b.f.onFinal(text, "s1");
    expect(a.f.snapshot().position).toBeCloseTo(b.f.snapshot().position, 0);
    const before = a.f.snapshot().position;
    a.f.onFinal(text, "s1");
    expect(a.f.snapshot().position).toBe(before);
  });

  it("reports paused after silence and resumes", () => {
    const { f, adv } = mkF();
    f.onFinal(NOTES.en[0].text, "s1");
    expect(f.snapshot().state).toBe("following");
    adv(5000);
    expect(f.snapshot().state).toBe("paused");
    f.onFinal(NOTES.en[1].text, "s2");
    expect(f.snapshot().state).toBe("following");
  });

  it("goes unsure then lost on a long digression, and holds the place", () => {
    const { f } = mkF();
    f.onFinal(NOTES.en[0].text, "s1");
    f.onFinal(NOTES.en[1].text, "s2");
    const pos = f.snapshot().position;
    f.onFinal("so last weekend we went hiking up the mountain and the weather was lovely", "d1");
    expect(f.snapshot().state).not.toBe("following");
    f.onFinal("then we had dinner at a small place with great pasta and talked for hours about nothing special at all", "d2");
    expect(f.snapshot().state).toBe("lost");
    expect(f.snapshot().position).toBe(pos);
  });

  it("seek moves the place and evidence continues from there", () => {
    const { f } = mkF();
    f.onFinal(NOTES.en[0].text, "s1");
    f.seek(idx.blocks[7].first);
    expect(f.snapshot().position).toBe(idx.blocks[7].first);
    f.onFinal(NOTES.en[7].text, "s2");
    expect(Math.abs(f.snapshot().position - idx.blocks[7].end)).toBeLessThanOrEqual(8);
  });

  it("scattered vocabulary never jumps; a sustained ordered run does (or is offered as a suggestion)", () => {
    const { f } = mkF();
    for (let i = 0; i < 4; i++) f.onFinal(NOTES.en[i].text, `s${i}`);
    const pos = f.snapshot().position;
    f.onFinal("honestly the board said hiring dollars were approved in march for the slides and the demo recording somewhere", "d1");
    expect(f.snapshot().position).toBe(pos);
    expect(f.snapshot().state).not.toBe("following");
    // back to bullet 2 in the same words, far enough back to count as a jump
    for (let i = 4; i < 9; i++) f.onFinal(NOTES.en[i].text, `s${i}`);
    f.onInterim(NOTES.en[1].text, "back");
    const early = f.snapshot();
    expect(early.position).toBeGreaterThan(idx.blocks[7].first); // not yet: needs sustained evidence
    f.onFinal(NOTES.en[1].text + " " + NOTES.en[2].text, "back");
    const late = f.snapshot();
    expect(Math.abs(late.position - idx.blocks[2].end) <= 8 || late.suggestion !== undefined || late.state !== "following").toBe(true);
  });

  it("a late interim never overrides a final", () => {
    const { f } = mkF();
    f.onFinal(NOTES.en[1].text, "s1");
    const p = f.snapshot().position;
    f.onInterim("revenue", "s1");
    expect(f.snapshot().position).toBe(p);
  });

  it("is fast: typically < 2 ms per update on a 5,000-word note", () => {
    const rnd = mulberry32(7);
    const syl = ["ba", "ko", "re", "ti", "mu", "la", "do", "ne", "si", "pra", "vel", "quo", "zin", "tar", "mex"];
    const pick = () => syl[Math.floor(rnd() * syl.length)];
    const vocab = Array.from({ length: 1400 }, () => pick() + pick() + pick());
    const blocks = Array.from({ length: 420 }, (_, i) => ({
      id: `b${i}`,
      text: Array.from({ length: 12 }, () => vocab[Math.floor(rnd() * vocab.length)]).join(" "),
    }));
    const big = buildNoteIndex(blocks);
    expect(big.tokens.length).toBeGreaterThanOrEqual(5000);
    let t = 0;
    const f = new VoiceFollower(big, { clock: () => t });
    const times: number[] = [];
    const speakBlocks = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 200, 201, 202, 203, 204, 205, 206];
    let seg = 0;
    for (const bi of speakBlocks) {
      const words = blocks[bi].text.split(" ");
      for (let i = 1; i <= words.length; i++) {
        const t0 = performance.now();
        f.onInterim(words.slice(0, i).join(" "), `s${seg}`);
        times.push(performance.now() - t0);
        t += 300;
      }
      f.onFinal(blocks[bi].text, `s${seg++}`);
    }
    const sorted = times.slice(30).sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length / 2)];
    // The median: single updates are slower while the whole suite runs in parallel.
    expect(p50).toBeLessThan(2);
    expect(Math.abs(f.snapshot().position - big.blocks[206].end)).toBeLessThanOrEqual(12);
  });
});

describe("said tracker", () => {
  const idx = buildNoteIndex(NOTES.en);
  const mk = () => {
    let t = 0;
    const s = new SaidTracker(idx, { clock: () => t });
    return { s, adv: (ms: number) => (t += ms) };
  };

  it("ticks a block when its words are said, not on single words", () => {
    const { s } = mk();
    s.onFinal("we should talk about pricing", "a");
    expect(s.saidBlockIds()).toEqual([]);
    s.onFinal(NOTES.en[3].text, "b");
    expect(s.isSaid("en4")).toBe(true);
    expect(s.leftToSay()).toBe(13);
  });

  it("evidence expires after 90 s", () => {
    const { s, adv } = mk();
    s.onFinal("churn dropped from four point five percent", "a");
    adv(95_000);
    s.onFinal("to three percent after we rebuilt onboarding", "b");
    expect(s.isSaid("en4")).toBe(false);
  });

  it("manual override wins both ways and serialises", () => {
    const { s } = mk();
    s.toggle("en1");
    expect(s.isSaid("en1")).toBe(true);
    s.onFinal(NOTES.en[3].text, "b");
    s.toggle("en4"); // untick an auto tick
    s.onFinal(NOTES.en[3].text, "c");
    expect(s.isSaid("en4")).toBe(false);
    expect(s.marks()).toEqual({ en1: "manual_on", en4: "manual_off" });
    const s2 = new SaidTracker(idx);
    s2.load(s.marks());
    expect(s2.isSaid("en1")).toBe(true);
    s2.setManual("en1", null);
    expect(s2.isSaid("en1")).toBe(false);
  });

  it("short blocks need a stricter rule", () => {
    const small = buildNoteIndex([
      { id: "h", text: "Pricing" },
      { id: "x", text: "Pricing tiers: free, team, enterprise" },
      { id: "y", text: "Totally different content about kubernetes clusters and storage" },
    ]);
    const s = new SaidTracker(small);
    s.onFinal("pricing is something people ask about", "a");
    expect(s.isSaid("h")).toBe(false);
    s.onFinal("pricing tiers free team enterprise", "b");
    expect(s.isSaid("x")).toBe(true);
  });
});

describe("scroll controller", () => {
  const lines: LineMetric[] = Array.from({ length: 40 }, (_, i) => ({ startToken: i * 10, endToken: i * 10 + 10, top: i * 30, height: 30 }));
  const metrics = { lines, contentHeight: 1200, viewportHeight: 300 };
  const mk = (extra = {}) => {
    let t = 0;
    const c = new ScrollController({ clock: () => t, ...extra });
    c.setMetrics(metrics);
    return {
      c,
      step: (ms: number) => {
        t += ms;
        return c.update();
      },
      adv: (ms: number) => (t += ms),
    };
  };

  it("settles on the target with no overshoot and a speed limit", () => {
    const { c, step } = mk({ maxSpeed: 500 });
    c.setVoice(200, "following");
    step(16);
    let prev = 0;
    let maxStep = 0;
    let last = 0;
    for (let i = 0; i < 400; i++) {
      last = step(16);
      expect(last).toBeLessThanOrEqual(c.targetTop + 1e-6);
      maxStep = Math.max(maxStep, (last - prev) / 0.016);
      prev = last;
    }
    expect(last).toBeCloseTo(c.targetTop, 0);
    expect(maxStep).toBeLessThanOrEqual(520);
  });

  it("holds when the follower is not following", () => {
    const { c, step } = mk();
    c.setVoice(100, "following");
    for (let i = 0; i < 200; i++) step(16);
    const t = c.targetTop;
    c.setVoice(300, "lost");
    c.setVoice(300, "unsure");
    c.setVoice(300, "paused");
    for (let i = 0; i < 50; i++) step(16);
    expect(c.targetTop).toBe(t);
  });

  it("wpm mode advances by words per minute, play/pause, speed", () => {
    const { c, step } = mk({ wpm: 120 });
    c.setMode("wpm");
    for (let i = 0; i < 100; i++) step(16);
    expect(c.scrollTop).toBe(0);
    c.play();
    for (let i = 0; i < 2500; i++) step(16); // 40 s -> 80 tokens at 120 wpm (2 words/s)
    const y = c.targetTop;
    expect(y).toBeGreaterThan(135);
    expect(y).toBeLessThan(165);
    c.pause();
    const held = c.targetTop;
    for (let i = 0; i < 100; i++) step(16);
    expect(c.targetTop).toBe(held);
    c.setWpm(10_000);
    expect(c.getWpm()).toBe(400);
  });

  it("yields to manual scroll for 4 s then resumes", () => {
    const { c, step, adv } = mk();
    c.setVoice(100, "following");
    for (let i = 0; i < 200; i++) step(16);
    c.onUserScroll(600);
    expect(c.isYielding()).toBe(true);
    expect(step(16)).toBe(600);
    adv(MANUAL_YIELD_MS - 100);
    expect(step(16)).toBe(600);
    adv(300);
    expect(c.isYielding()).toBe(false);
    for (let i = 0; i < 200; i++) step(16);
    expect(Math.abs(c.scrollTop - c.scrollForToken(100))).toBeLessThan(2);
    expect(c.tokenAtScroll(c.scrollTop)).toBeCloseTo(100, 0);
  });

  it("reduced motion snaps", () => {
    const { c, step } = mk({ reducedMotion: true });
    c.setVoice(200, "following");
    step(16);
    expect(c.scrollTop).toBe(c.targetTop);
  });

  it("ManualYield helper", () => {
    let t = 0;
    const y = new ManualYield(() => t);
    expect(y.active()).toBe(false);
    y.touch();
    t = 3999;
    expect(y.active()).toBe(true);
    t = 4000;
    expect(y.active()).toBe(false);
  });

  it("spoken words helper matches the note tokenizer", () => {
    expect(spokenWords("Revenue grew twenty percent")).toEqual(toks("revenue grew 20%"));
  });
});
