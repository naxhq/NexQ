/**
 * Two reader bugs: (1) in "My voice" the note must scroll to keep the spoken line at the reading line,
 * also after a new note or Resume made a fresh scroll controller; (2) the "Checked off" strike must follow
 * the same word index as the highlight, word by word.
 */
import { act, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptSegment } from "../../lib/types";
import { DEFAULT_READING, type ReadingSettings } from "../../stores/talkingPointsStore";
import { useTranscriptStore } from "../../stores/transcriptStore";
import { docBlocks, docFromText } from "../doc/model";
import { buildNoteIndex, type FollowState } from "../follow";
import css from "../talkingPoints.css?raw";
import { DocView } from "../reader/DocView";
import { SpokenTracker, isSpokenAt, spokenEnd, spokenWordRanges } from "./spoken";
import { FOCUS_RATIO, usePrompter, type FollowerLike } from "./usePrompter";

// No layout in jsdom: one line per block, 100 px apart.
vi.mock("./measure", async (orig) => {
  const real = await orig<typeof import("./measure")>();
  return {
    ...real,
    measureLines: (_root: HTMLElement, index: import("../follow").NoteIndex) =>
      index.blocks.map((b, i) => ({ startToken: b.first, endToken: b.end, top: i * 100, height: 30 })).filter((l) => l.endToken > l.startToken),
  };
});

const LINES = Array.from({ length: 12 }, (_, i) => `Point number ${i + 1} covers the subject of area ${i + 1} in some detail`);
const doc = docFromText(LINES.join("\n"));
const VIEWPORT = 300;

let pending: Array<() => void> = [];
let now = 0;
let seq = 0;

function makeScroller() {
  const el = document.createElement("div");
  let top = 0;
  Object.defineProperty(el, "scrollTop", { get: () => top, set: (v: number) => void (top = v), configurable: true });
  Object.defineProperty(el, "clientHeight", { value: VIEWPORT, configurable: true });
  Object.defineProperty(el, "scrollHeight", { value: 5000, configurable: true });
  return el;
}

/** Runs the queued animation frames (and the ones they queue) for `n` frames, 16 ms apart. */
function frames(n: number) {
  for (let i = 0; i < n; i++) {
    const run = pending;
    pending = [];
    now += 16;
    act(() => run.forEach((f) => f()));
  }
}

function fakeFollower() {
  const f = { pos: 0, state: "following" as FollowState };
  const follower: FollowerLike = {
    onInterim: () => undefined,
    onFinal: () => undefined,
    snapshot: () => ({ position: f.pos, confidence: 1, state: f.state }),
    seek: (t: number) => void (f.pos = t),
    reset: () => undefined,
    setIndex: () => undefined,
  };
  return { f, follower };
}

function speak() {
  const seg: TranscriptSegment = { id: `s${++seq}`, text: `word ${seq}`, speaker: "User", timestamp_ms: 0, is_final: false, confidence: 0.9 };
  act(() => useTranscriptStore.getState().updateInterimSegment(seg));
}

const index = buildNoteIndex(docBlocks(doc).map((b) => ({ id: b.id, text: b.text })));
const wantTop = (block: number) => Math.max(0, block * 100 + 15 - VIEWPORT * FOCUS_RATIO);

beforeEach(() => {
  pending = [];
  now = 0;
  useTranscriptStore.getState().clearSegments();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    pending.push(() => cb(now));
    return pending.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  useTranscriptStore.getState().clearSegments();
});

function mount(over: Partial<ReadingSettings> = {}, noteKey = "a") {
  const el = makeScroller();
  const scrollRef = { current: el };
  const contentRef = { current: document.createElement("div") };
  const { f, follower } = fakeFollower();
  const reading: ReadingSettings = { ...DEFAULT_READING, mode: "voice", ...over };
  const hook = renderHook(
    (p: { noteKey: string }) =>
      usePrompter({ doc, noteKey: p.noteKey, scrollRef, contentRef, reading, availability: { ok: true }, follower, reducedMotion: true, clock: () => now }),
    { initialProps: { noteKey } },
  );
  return { el, f, hook };
}

describe("My voice scrolls to the spoken line", () => {
  it("brings the line you are saying to the reading line when the position moves below the view", () => {
    const { el, f } = mount();
    frames(5);
    f.pos = index.blocks[6].first + 2;
    speak();
    frames(5);
    expect(el.scrollTop).toBeCloseTo(wantTop(6), 0);
  });

  it("scrolls once per line, not once per word", () => {
    const { el, f } = mount();
    frames(5);
    f.pos = index.blocks[4].first + 1;
    speak();
    frames(3);
    const sets: number[] = [];
    for (let w = 2; w < 9; w++) {
      f.pos = index.blocks[4].first + w;
      speak();
      frames(2);
      sets.push(el.scrollTop);
    }
    expect(new Set(sets).size).toBe(1);
    expect(sets[0]).toBeCloseTo(wantTop(4), 0);
  });

  it("still follows after the loop has gone to sleep and the note changed (a fresh controller is woken too)", () => {
    const { el, f, hook } = mount();
    frames(60); // the frame loop sleeps once nothing moves
    hook.rerender({ noteKey: "b" });
    frames(5);
    f.pos = index.blocks[8].first + 1;
    speak();
    frames(5);
    expect(el.scrollTop).toBeCloseTo(wantTop(8), 0);
  });

  it("still follows after Resume (another fresh controller), starting from where the note is", () => {
    const { el, f, hook } = mount();
    frames(5);
    f.pos = index.blocks[3].first + 1;
    speak();
    frames(5);
    // the user scrolls away by hand
    act(() => hook.result.current.noteUserIntent());
    el.scrollTop = 900;
    act(() => hook.result.current.onScroll());
    expect(hook.result.current.yielding).toBe(true);
    now += 5000;
    frames(40);
    act(() => hook.result.current.resume());
    frames(3);
    expect(el.scrollTop, "Resume goes to the line you were on, never to the top").toBeCloseTo(wantTop(9), 0);
    frames(60);
    f.pos = index.blocks[11].first + 1;
    speak();
    frames(5);
    expect(el.scrollTop).toBeCloseTo(wantTop(11), 0);
  });

  it("a manual scroll pauses following (the Resume offer shows) and the note stays where the user put it", () => {
    const { el, f, hook } = mount();
    frames(5);
    f.pos = index.blocks[2].first + 1;
    speak();
    frames(5);
    act(() => hook.result.current.noteUserIntent());
    el.scrollTop = 700;
    act(() => hook.result.current.onScroll());
    expect(hook.result.current.yielding).toBe(true);
    f.pos = index.blocks[10].first + 1;
    speak();
    frames(10);
    expect(el.scrollTop).toBe(700);
  });
});

describe("Auto mode still works", () => {
  it("Auto scrolls on play", () => {
    const { el, hook } = mount({ mode: "auto", wpm: 300 });
    frames(5);
    act(() => hook.result.current.play());
    frames(300);
    expect(el.scrollTop).toBeGreaterThan(50);
  });
});

// -- Checked off: the strike is the spoken range -----------------------------------------------------

const struckText = (root: HTMLElement) => Array.from(root.querySelectorAll("[data-struck]")).map((e) => e.textContent).join(" ");

describe("the Checked off strike follows the spoken word", () => {
  const BLOCK = 1;
  const text = docBlocks(doc)[BLOCK].text;

  it("the strike covers exactly the words the highlight covers, at every position", () => {
    const span = index.blocks[BLOCK];
    for (let pos = span.first; pos <= span.end + 1; pos += 1.5) {
      const spoken = spokenEnd({ blocks: docBlocks(doc), index, curBlock: BLOCK, followPosition: pos, followState: "following", wantVoice: true });
      const { container, unmount } = render(<DocView doc={doc} textStyle="checked" spoken={spoken} />);
      const block = container.querySelector(`[data-block-id="${docBlocks(doc)[BLOCK].id}"]`) as HTMLElement;
      const want = spoken ? spokenWordRanges(text, spoken.endChar).map(([a, b]) => text.slice(a, b)).join(" ") : "";
      expect(struckText(block), `position ${pos}`).toBe(want);
      // and that is the text up to the last spoken word of the highlight range
      if (spoken) expect(text.slice(0, spoken.endChar).trim().split(/\s+/).length).toBeLessThanOrEqual(want.split(" ").length);
      unmount();
    }
  });

  it("the word you just said is struck at once (the index moves by one word, the strike by one word)", () => {
    const span = index.blocks[BLOCK];
    const at = (n: number) => spokenEnd({ blocks: docBlocks(doc), index, curBlock: BLOCK, followPosition: span.first + n, followState: "following", wantVoice: true });
    const two = spokenWordRanges(text, at(2)!.endChar).length;
    const three = spokenWordRanges(text, at(3)!.endChar).length;
    expect(two).toBe(2);
    expect(three).toBe(3);
  });

  it("no strike when not following, in another style, or in another block", () => {
    const off = spokenEnd({ blocks: docBlocks(doc), index, curBlock: BLOCK, followPosition: index.blocks[BLOCK].first + 3, followState: "unsure", wantVoice: true });
    expect(off).toBeNull();
    const on = spokenEnd({ blocks: docBlocks(doc), index, curBlock: BLOCK, followPosition: index.blocks[BLOCK].first + 3, followState: "following", wantVoice: true });
    const other = render(<DocView doc={doc} textStyle="highlight" spoken={on} />);
    expect(other.container.querySelectorAll("[data-struck]").length).toBe(0);
    other.unmount();
    const same = render(<DocView doc={doc} textStyle="checked" spoken={on} />);
    const ids = new Set(Array.from(same.container.querySelectorAll("[data-struck]")).map((e) => e.closest("[data-block-id]")?.getAttribute("data-block-id")));
    expect(ids).toEqual(new Set([docBlocks(doc)[BLOCK].id]));
  });

  it("the prompter hands the same spoken range to the highlight and the strike", () => {
    const { f, hook } = mount();
    frames(5);
    f.pos = index.blocks[BLOCK].first + 3;
    speak();
    frames(3);
    const s = hook.result.current.spoken;
    expect(s).toEqual(spokenEnd({ blocks: docBlocks(doc), index, curBlock: BLOCK, followPosition: f.pos, followState: "following", wantVoice: true }));
    expect(s?.blockId).toBe(docBlocks(doc)[BLOCK].id);
  });

  it("the strike draws in 100 ms or less, and not at all with reduced motion", () => {
    expect(css).toMatch(/\.tp-w\s*\{[^}]*transition:\s*background-size\s*(\d+)ms/);
    const ms = Number(/\.tp-w\s*\{[^}]*transition:\s*background-size\s*(\d+)ms/.exec(css)![1]);
    expect(ms).toBeLessThanOrEqual(120);
    expect(css.slice(css.lastIndexOf("prefers-reduced-motion"))).toMatch(/\.tp-w\s*\{\s*transition:\s*none/);
  });
});

// -- Checked off: the strike is literal, in the block you are on and in the ones you left ---------------

describe("the Checked off strike covers exactly the spoken words, also in blocks already left", () => {
  const blocks = docBlocks(doc);
  const wordsOf = (b: number) => blocks[b].text.split(/\s+/);
  const blockEl = (root: HTMLElement, b: number) => root.querySelector(`[data-block-id="${blocks[b].id}"]`) as HTMLElement;
  const struckWords = (root: HTMLElement, b: number) => Array.from(blockEl(root, b).querySelectorAll("[data-struck]")).map((e) => e.textContent);
  const unstruckWords = (root: HTMLElement, b: number) => Array.from(blockEl(root, b).querySelectorAll(".tp-w:not([data-struck])")).map((e) => e.textContent);
  const states = new Map(blocks.map((b, i) => [b.id, i < 2 ? "autosaid" : i === 2 ? "current" : "ahead"] as const));

  /** Reads block 1 up to six words before its end, then carries on into block 2. */
  function readLeavingTail() {
    const t = new SpokenTracker();
    const span = index.blocks[1];
    t.advance(index, span.end - 6);
    t.advance(index, index.blocks[2].first + 3);
    return t;
  }

  it("the last six words of a left block stay unstruck, the rest are struck, though the block counts as said", () => {
    const t = readLeavingTail();
    const { container } = render(<DocView doc={doc} states={states} textStyle="checked" struck={t.snapshot()} />);
    const all = wordsOf(1);
    expect(struckWords(container, 1)).toEqual(all.slice(0, all.length - 6));
    expect(unstruckWords(container, 1)).toEqual(all.slice(-6));
    expect(blockEl(container, 1).hasAttribute("data-struck-all")).toBe(false);
    expect(blockEl(container, 1).getAttribute("data-state")).toBe("autosaid");
    // the block being read is struck up to the spoken word as before
    expect(struckWords(container, 2)).toEqual(wordsOf(2).slice(0, 3));
  });

  it("a word skipped in the middle stays unstruck (a jump marks only the tail it landed on)", () => {
    const t = new SpokenTracker();
    t.advance(index, index.blocks[0].first + 2);
    t.advance(index, index.blocks[0].first + 2 + 60);
    const jumped = t.snapshot();
    const { container } = render(<DocView doc={doc} states={states} textStyle="checked" struck={jumped} />);
    expect(struckWords(container, 0)).toEqual(wordsOf(0).slice(0, 2));
    // a record with a hole: words 0-3 and 6-end spoken, 4 and 5 skipped
    const b = index.blocks[3];
    const holey = new SpokenTracker();
    holey.advance(index, b.first + 4);
    holey.advance(index, b.first + 4 + 0);
    const text = blocks[3].text;
    const ranges = [[0, index.tokens[b.first + 3].end] as const, [index.tokens[b.first + 6].start, text.length] as const];
    const skipped = render(<DocView doc={doc} textStyle="checked" struck={new Map([[blocks[3].id, ranges]])} />);
    const w = wordsOf(3);
    expect(struckWords(skipped.container, 3)).toEqual([...w.slice(0, 4), ...w.slice(6)]);
    expect(unstruckWords(skipped.container, 3)).toEqual(w.slice(4, 6));
  });

  it("a fully spoken block takes the whole-block strike, and blocks with no spoken word have no word spans", () => {
    const t = new SpokenTracker();
    t.advance(index, index.blocks[1].first + 2);
    t.advance(index, index.blocks[1].end);
    t.advance(index, index.blocks[2].first + 1);
    const { container } = render(<DocView doc={doc} states={states} textStyle="checked" struck={t.snapshot()} />);
    expect(blockEl(container, 1).hasAttribute("data-struck-all")).toBe(true);
    expect(blockEl(container, 1).querySelectorAll("[data-struck]").length).toBe(wordsOf(1).length);
    expect(blockEl(container, 5).querySelectorAll(".tp-w").length).toBe(0);
    expect(blockEl(container, 5).hasAttribute("data-struck-all")).toBe(false);
  });

  it("the whole-block line-through is only drawn for a fully spoken block", () => {
    expect(css).toMatch(/\[data-state="said"\]\[data-struck-all\],\s*\.tp-read\[data-style="checked"\] \[data-state="autosaid"\]\[data-struck-all\]\s*\{[^}]*text-decoration:\s*line-through/);
    expect(css).not.toMatch(/data-style="checked"\] \[data-state="autosaid"\]\s*\{[^}]*line-through/);
  });

  it("other styles never strike, with or without a record", () => {
    const t = readLeavingTail();
    for (const style of ["classic", "highlight", "focus"] as const) {
      const { container, unmount } = render(<DocView doc={doc} states={states} textStyle={style} struck={t.snapshot()} spoken={{ blockId: blocks[2].id, endChar: 5 }} />);
      expect(container.querySelectorAll("[data-struck],[data-struck-all],.tp-w").length, style).toBe(0);
      unmount();
    }
  });

  it("only the block that gained spoken words re-renders: unchanged blocks keep their range array", () => {
    const t = new SpokenTracker();
    t.advance(index, index.blocks[2].first + 2);
    const a = t.snapshot();
    t.advance(index, index.blocks[2].first + 4);
    const b = t.snapshot();
    expect(b.get(blocks[1].id)).toBe(a.get(blocks[1].id));
    expect(b.get(blocks[2].id)).not.toBe(a.get(blocks[2].id));
  });

  it("the prompter keeps a block's spoken words after the speaker moves on, and clears them on restart", () => {
    const { f, hook } = mount();
    frames(5);
    f.pos = index.blocks[1].end - 6;
    speak();
    frames(2);
    f.pos = index.blocks[2].first + 3;
    speak();
    frames(2);
    const r = hook.result.current.spokenRanges;
    const kept = r.get(blocks[1].id)!;
    expect(isSpokenAt(kept, 0)).toBe(true);
    const lastWordStart = blocks[1].text.lastIndexOf(" ") + 1;
    expect(isSpokenAt(kept, lastWordStart)).toBe(false);
    act(() => hook.result.current.restart());
    expect(hook.result.current.spokenRanges.size).toBe(0);
  });
});
