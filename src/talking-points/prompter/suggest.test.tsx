import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_READING, type ReadingSettings } from "../../stores/talkingPointsStore";
import { usePrompter, SUGGEST_AFTER_MS, SUGGEST_EXPIRE_MS, type FollowerLike } from "./usePrompter";
import { docBlocks, docFromText } from "../doc/model";
import type { FollowState } from "../follow";

type Snap = ReturnType<FollowerLike["snapshot"]>;

function fake() {
  let snap: Snap = { position: 0, confidence: 0.2, state: "unsure", suggestion: null };
  const seek = vi.fn();
  const f: FollowerLike = {
    onInterim: () => undefined,
    onFinal: () => undefined,
    snapshot: () => snap,
    seek,
    reset: () => undefined,
    setIndex: () => undefined,
  };
  return { f, seek, set: (s: Partial<Snap>) => (snap = { ...snap, ...s }) };
}

const doc = docFromText("Welcome to the review\nRevenue grew twelve percent\nWe hired fourteen engineers");
const ids = docBlocks(doc).map((b) => b.id);

function setup(reading: Partial<ReadingSettings> = {}) {
  const fk = fake();
  const hook = renderHook(
    (r: ReadingSettings) =>
      usePrompter({
        doc,
        noteKey: "n",
        scrollRef: { current: null },
        contentRef: { current: null },
        reading: r,
        availability: { ok: true },
        suggest: r.suggest,
        follower: fk.f,
        reducedMotion: true,
      }),
    { initialProps: { ...DEFAULT_READING, mode: "voice" as const, ...reading } },
  );
  return { fk, hook };
}

const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Go to suggestion", () => {
  it("shows only after the suggestion has held for a second, with the first words and the edge", () => {
    const { fk, hook } = setup();
    fk.set({ state: "unsure", suggestion: { blockId: ids[2], confidence: 0.8 } });
    tick(800); // the 700 ms look picks it up
    expect(hook.result.current.suggestion).toBeNull();
    tick(1300);
    expect(hook.result.current.suggestion).toEqual({ blockId: ids[2], text: "We hired fourteen engineers", edge: "bottom" });
  });

  it("sits at the top edge when the target is above the current point", () => {
    const { fk, hook } = setup();
    act(() => hook.result.current.toggleSaid(ids[0]));
    fk.set({ state: "unsure", position: 0, suggestion: { blockId: ids[0], confidence: 0.8 } });
    // the current block follows the follower position: move it to the third block first
    fk.set({ state: "following", position: 16, suggestion: null });
    tick(800);
    fk.set({ state: "unsure", position: 16, suggestion: { blockId: ids[0], confidence: 0.8 } });
    tick(2400);
    expect(hook.result.current.suggestion?.blockId).toBe(ids[0]);
  });

  it("goes when following resumes, when the suggestion goes, or after twelve seconds", () => {
    const { fk, hook } = setup();
    fk.set({ suggestion: { blockId: ids[1], confidence: 0.7 } });
    tick(2000);
    expect(hook.result.current.suggestion).not.toBeNull();
    fk.set({ state: "following" as FollowState });
    tick(800);
    expect(hook.result.current.suggestion).toBeNull();

    fk.set({ state: "unsure", suggestion: { blockId: ids[1], confidence: 0.7 } });
    tick(2000);
    expect(hook.result.current.suggestion).not.toBeNull();
    fk.set({ suggestion: null });
    tick(800);
    expect(hook.result.current.suggestion).toBeNull();

    fk.set({ suggestion: { blockId: ids[2], confidence: 0.7 } });
    tick(SUGGEST_AFTER_MS + 1500);
    expect(hook.result.current.suggestion).not.toBeNull();
    tick(SUGGEST_EXPIRE_MS);
    expect(hook.result.current.suggestion).toBeNull();
  });

  it("going there moves the follower to that point and clears the offer", () => {
    const { fk, hook } = setup();
    fk.set({ suggestion: { blockId: ids[2], confidence: 0.9 } });
    tick(2000);
    act(() => hook.result.current.goToSuggestion());
    const first = hook.result.current.index.blocks[2].first;
    expect(fk.seek).toHaveBeenCalledWith(first);
    expect(hook.result.current.suggestion).toBeNull();
    expect(hook.result.current.currentBlockId).toBe(ids[2]);
  });

  it("can be dismissed, and then does not come back for the same point", () => {
    const { fk, hook } = setup();
    fk.set({ suggestion: { blockId: ids[1], confidence: 0.9 } });
    tick(2000);
    act(() => hook.result.current.dismissSuggestion());
    expect(hook.result.current.suggestion).toBeNull();
    tick(3000);
    expect(hook.result.current.suggestion).toBeNull();
  });

  it("is off when the setting is off, and when voice following is not on", () => {
    const off = setup({ suggest: false });
    off.fk.set({ suggestion: { blockId: ids[1], confidence: 0.9 } });
    tick(3000);
    expect(off.hook.result.current.suggestion).toBeNull();
    const manual = setup({ mode: "manual" });
    manual.fk.set({ suggestion: { blockId: ids[1], confidence: 0.9 } });
    tick(3000);
    expect(manual.hook.result.current.suggestion).toBeNull();
  });
});
