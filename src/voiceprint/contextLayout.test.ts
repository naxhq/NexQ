import { describe, expect, it } from "vitest";
import type { ContextBar, ContextLayer } from "../lib/types";
import { formatTokens, layerColor, layoutContextBars, strokeHeights } from "./contextLayout";

function bar(id: string, layer: ContextLayer, tokens: number, extra: Partial<ContextBar> = {}): ContextBar {
  return { id, layer, title: id, tokens, relevance: 0.5, pinned: false, included: true, ...extra };
}

describe("layoutContextBars", () => {
  it("draws nothing but the dots for no items", () => {
    const l = layoutContextBars([], { budget: 24000, widthPx: 600 });
    expect(l.segments).toEqual([]);
    expect(l.free).toEqual({ x: 0, w: 600, tokens: 24000 });
    expect(l.layers.map((s) => s.count)).toEqual([0, 0, 0, 0, 0]);
  });

  it("draws a single item at its share of the budget", () => {
    const l = layoutContextBars([bar("a", "documents", 6000)], { budget: 24000, widthPx: 600 });
    expect(l.segments).toHaveLength(1);
    expect(l.segments[0]).toMatchObject({ x: 0, w: 150, count: 1 });
    expect(l.free!.x).toBe(158);
    expect(l.free!.x + l.free!.w).toBe(600);
  });

  it("orders by layer, with 4px between items and 8px between layers, ending inside the width", () => {
    const l = layoutContextBars(
      [bar("c", "conversation", 2000), bar("m", "meetings", 3000), bar("m2", "meetings", 1000), bar("i", "instructions", 1000), bar("d", "documents", 3000)],
      { budget: 10000, widthPx: 1000 },
    );
    expect(l.segments.map((s) => s.id)).toEqual(["i", "m", "m2", "d", "c"]);
    const gaps = l.segments.slice(1).map((s, i) => s.x - (l.segments[i].x + l.segments[i].w));
    expect(gaps.map((g) => Math.round(g))).toEqual([8, 4, 8, 8]);
    const last = l.segments[l.segments.length - 1];
    expect(last.x + last.w).toBeLessThanOrEqual(1000.0001);
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

  it("groups 400 tiny items so every run is at least three strokes and nothing is lost", () => {
    const bars = Array.from({ length: 400 }, (_, i) => bar(`t${i}`, i < 200 ? "meetings" : "folders", 40, { relevance: (i % 10) / 10 }));
    const l = layoutContextBars(bars, { budget: 24000, widthPx: 600 });
    expect(l.segments.length).toBeLessThanOrEqual(60);
    for (const s of l.segments) expect(s.w).toBeGreaterThanOrEqual(5.9);
    expect(l.segments.reduce((n, s) => n + s.count, 0)).toBe(400);
    for (const s of l.segments) expect(new Set(s.members.map((m) => m.layer)).size).toBe(1);
    const grouped = l.segments.find((s) => s.count > 1)!;
    expect(grouped.relevance).toBe(Math.max(...grouped.members.map((m) => m.relevance)));
    const last = l.segments[l.segments.length - 1];
    expect(last.x + last.w).toBeLessThanOrEqual(600.5);
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
    expect(l.segments[0].w).toBe(400);
  });
});

describe("strokeHeights", () => {
  it("is deterministic per id, one stroke per 4px, taller for more relevant items", () => {
    const a = strokeHeights("x", 40, 1);
    expect(a).toHaveLength(10);
    expect(strokeHeights("x", 40, 1)).toEqual(a);
    expect(strokeHeights("y", 40, 1)).not.toEqual(a);
    expect(Math.max(...strokeHeights("x", 40, 0.1))).toBeLessThan(Math.max(...a));
    expect(strokeHeights("x", 1, 0.5)).toHaveLength(1);
  });
});

describe("layerColor", () => {
  it("is never pure white for instructions", () => {
    expect(layerColor("instructions")).toBe("hsl(var(--foreground) / 0.7)");
    expect(layerColor("meetings")).toBe("hsl(var(--layer-meetings))");
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
