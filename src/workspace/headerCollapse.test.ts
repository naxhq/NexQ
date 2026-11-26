import { describe, expect, it } from "vitest";
import {
  COMPACT_AT,
  DEFAULT_EXTRA,
  FOLLOW_STEP,
  FULL_AT,
  MIN_EXTRA,
  blockOpacity,
  condenseRange,
  extrasOpacity,
  modeFor,
  progressFromScroll,
  snappedProgress,
  stepProgress,
} from "./headerCollapse";

describe("the header's scroll mapping", () => {
  it("is 0 at the top, 1 once scrolled the whole range, linear between and clamped", () => {
    expect(progressFromScroll(0, 150)).toBe(0);
    expect(progressFromScroll(75, 150)).toBe(0.5);
    expect(progressFromScroll(150, 150)).toBe(1);
    expect(progressFromScroll(900, 150)).toBe(1);
    expect(progressFromScroll(-40, 150)).toBe(0);
  });

  it("treats an unknown position as condensed, and never divides by zero", () => {
    expect(progressFromScroll(Number.NaN, 150)).toBe(1);
    expect(progressFromScroll(10, 0)).toBe(1);
  });

  it("condenses over exactly the room the block measured, never under the minimum", () => {
    expect(condenseRange(178)).toBe(178);
    expect(condenseRange(20)).toBe(MIN_EXTRA);
    expect(condenseRange(0)).toBe(DEFAULT_EXTRA);
  });
});

describe("the discrete mode has hysteresis", () => {
  it("flips to compact at the upper threshold and back to full only at the lower one", () => {
    expect(modeFor("full", COMPACT_AT - 0.01)).toBe("full");
    expect(modeFor("full", COMPACT_AT)).toBe("compact");
    expect(modeFor("compact", COMPACT_AT - 0.01)).toBe("compact");
    expect(modeFor("compact", FULL_AT + 0.01)).toBe("compact");
    expect(modeFor("compact", FULL_AT)).toBe("full");
  });

  it("holds its state while the thumb rests anywhere between the thresholds", () => {
    let mode = modeFor("full", 0.7);
    for (const p of [0.55, 0.5, 0.45, 0.5, 0.58, 0.41]) mode = modeFor(mode, p);
    expect(mode).toBe("compact");
    mode = modeFor(mode, 0.2);
    for (const p of [0.45, 0.5, 0.58, 0.42]) mode = modeFor(mode, p);
    expect(mode).toBe("full");
  });
});

describe("reduced motion snaps", () => {
  it("is exactly 0 or 1, never in between, with the same hysteresis", () => {
    expect(snappedProgress("full", 0.3)).toEqual({ mode: "full", progress: 0 });
    expect(snappedProgress("full", 0.5)).toEqual({ mode: "full", progress: 0 });
    expect(snappedProgress("full", 0.65)).toEqual({ mode: "compact", progress: 1 });
    expect(snappedProgress("compact", 0.5)).toEqual({ mode: "compact", progress: 1 });
    expect(snappedProgress("compact", 0.1)).toEqual({ mode: "full", progress: 0 });
  });
});

describe("one frame of progress", () => {
  it("lands exactly on a small move, so the header and the content never drift", () => {
    expect(stepProgress(0.2, 0.2 + FOLLOW_STEP - 0.01, 16)).toBe(0.2 + FOLLOW_STEP - 0.01);
    expect(stepProgress(0.9, 0.7, 16)).toBe(0.7);
  });

  it("glides toward a jump without ever passing the target", () => {
    let p = 0;
    const seen: number[] = [];
    for (let i = 0; i < 80; i++) {
      p = stepProgress(p, 1, 16);
      seen.push(p);
    }
    expect(seen.every((v, i) => v <= 1 && (i === 0 || v >= seen[i - 1]))).toBe(true);
    expect(seen[0]).toBeGreaterThan(0);
    expect(seen[0]).toBeLessThan(0.5);
    expect(seen[seen.length - 1]).toBe(1);
  });

  it("glides the other way too", () => {
    let p = 1;
    for (let i = 0; i < 80; i++) p = stepProgress(p, 0, 16);
    expect(p).toBe(0);
  });
});

describe("what fades when", () => {
  it("the full block is gone before the bar is done, and the bar's extras arrive in the second half", () => {
    expect(blockOpacity(0)).toBe(1);
    expect(blockOpacity(0.7)).toBe(0);
    expect(extrasOpacity(0.3)).toBe(0);
    expect(extrasOpacity(0.9)).toBe(1);
    expect(extrasOpacity(0.6)).toBeGreaterThan(0);
    expect(extrasOpacity(0.6)).toBeLessThan(1);
  });
});
