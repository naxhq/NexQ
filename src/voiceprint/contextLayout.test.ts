import { describe, expect, it } from "vitest";
import type { ContextBar, ContextLayer } from "../lib/types";
import { formatTokens, layoutContextBars } from "./contextLayout";

function bar(id: string, layer: ContextLayer, tokens: number, extra: Partial<ContextBar> = {}): ContextBar {
  return { id, layer, title: id, tokens, relevance: 0.5, pinned: false, included: true, ...extra };
}

describe("layoutContextBars", () => {
  it("draws nothing but the flat line for no items", () => {
    const l = layoutContextBars([], { budget: 24000, widthPx: 600 });
    expect(l.segments).toEqual([]);
    expect(l.free).toEqual({ x: 0, w: 1, tokens: 24000 });
    expect(l.layers.map((s) => s.count)).toEqual([0, 0, 0, 0, 0]);
  });

  it("draws a single item at its share of the budget", () => {
    const l = layoutContextBars([bar("a", "documents", 6000)], { budget: 24000, widthPx: 600 });
    expect(l.segments).toHaveLength(1);
    expect(l.segments[0]).toMatchObject({ x: 0, w: 0.25, count: 1 });
    expect(l.free).toEqual({ x: 0.25, w: 0.75, tokens: 18000 });
  });

  it("orders by layer, then as given, and leaves no gaps between bars", () => {
    const l = layoutContextBars(
      [bar("c", "conversation", 2000), bar("m", "meetings", 4000), bar("i", "instructions", 1000), bar("d", "documents", 3000)],
      { budget: 10000, widthPx: 1000 },
    );
    expect(l.segments.map((s) => s.id)).toEqual(["i", "m", "d", "c"]);
    let at = 0;
    for (const s of l.segments) {
      expect(s.x).toBeCloseTo(at);
      at += s.w;
    }
    expect(l.free).toBeNull();
  });

  it("leaves cut items off the axis but reports them", () => {
    const l = layoutContextBars([bar("a", "meetings", 1000), bar("b", "meetings", 9000, { included: false })], {
      budget: 4000,
      widthPx: 400,
    });
    expect(l.segments).toHaveLength(1);
    expect(l.cut.map((b) => b.id)).toEqual(["b"]);
    expect(l.used).toBe(1000);
  });

  it("groups 400 tiny items so no bar is thinner than the minimum", () => {
    const bars = Array.from({ length: 400 }, (_, i) => bar(`t${i}`, i < 200 ? "meetings" : "folders", 40, { relevance: (i % 10) / 10 }));
    const l = layoutContextBars(bars, { budget: 24000, widthPx: 600, minBarPx: 3 });
    // At most one bar per 3px: 600px holds 200, not 400 slivers.
    expect(l.segments.length).toBeLessThanOrEqual(200);
    expect(l.segments.length).toBeLessThan(150);
    for (const s of l.segments) expect(s.w * 600).toBeGreaterThanOrEqual(2.9);
    // Nothing is lost: every item is in exactly one segment, groups never cross layers.
    expect(l.segments.reduce((n, s) => n + s.count, 0)).toBe(400);
    for (const s of l.segments) expect(new Set(s.members.map((m) => m.layer)).size).toBe(1);
    const grouped = l.segments.find((s) => s.count > 1)!;
    expect(grouped.relevance).toBe(Math.max(...grouped.members.map((m) => m.relevance)));
  });

  it("keeps big bars single and folds a leftover sliver into the bar before it", () => {
    const l = layoutContextBars([bar("big", "documents", 5000), bar("tiny", "documents", 5)], { budget: 10000, widthPx: 500 });
    expect(l.segments).toHaveLength(1);
    expect(l.segments[0].count).toBe(2);
  });

  it("stays valid when items exceed the budget", () => {
    const l = layoutContextBars([bar("a", "meetings", 9000)], { budget: 4000, widthPx: 400 });
    expect(l.axis).toBe(9000);
    expect(l.free).toBeNull();
    expect(l.segments[0].w).toBe(1);
  });
});

describe("formatTokens", () => {
  it("is short", () => {
    expect(formatTokens(900)).toBe("900");
    expect(formatTokens(1240)).toBe("1.2k");
    expect(formatTokens(24000)).toBe("24k");
    expect(formatTokens(128000)).toBe("128k");
  });
});
