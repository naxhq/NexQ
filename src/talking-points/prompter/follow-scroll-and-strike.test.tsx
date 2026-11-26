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
import { spokenEnd, spokenWordRanges } from "./spoken";
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
