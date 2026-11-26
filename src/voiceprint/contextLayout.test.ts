import { describe, expect, it } from "vitest";
import type { ContextBar, ContextLayer, ContextLayerInfo } from "../lib/types";
import { formatTokens, layerColor, layoutContextBars, legendText, strokeHeights } from "./contextLayout";

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

describe("what is sent against what is searched", () => {
  const folders: ContextLayerInfo = { layer: "folders", available: 1_200_000, sources: 638, searched: true };
  const docs: ContextLayerInfo = { layer: "documents", available: 390, sources: 2, searched: false };
  const meetings: ContextLayerInfo = { layer: "meetings", available: 54_000, sources: 6, searched: true };

  it("bars are proportional to their tokens on the budget's scale, and bars, gaps and free room fill the width", () => {
    const bars = [bar("m", "meetings", 6000), bar("d", "documents", 3000), bar("f", "folders", 1500)];
    const l = layoutContextBars(bars, { budget: 24000, widthPx: 800 });
    const ppt = l.segments[0].w / 6000;
    for (const s of l.segments) expect(s.w / s.tokens).toBeCloseTo(ppt, 9);
    const gaps = 8 + 8 + 8; // three layers, then the free room
    expect(l.segments.reduce((n, s) => n + s.w, 0) + gaps + l.free!.w).toBeCloseTo(800, 6);
    // the free room is the rest of the budget at the same scale (less the layer gap that sets it apart)
    expect(l.free!.tokens).toBe(24000 - 10500);
    expect((l.free!.w + 8) / l.free!.tokens).toBeCloseTo(ppt, 6);
  });

  it("a searched layer is outlined in the free room and never counted as used", () => {
    const l = layoutContextBars([bar("d", "documents", 390), bar("m", "meetings", 1600)], { budget: 60000, widthPx: 600, layers: [meetings, docs, folders] });
    expect(l.hints.map((h) => h.layer)).toEqual(["meetings", "folders"]);
    expect(l.used).toBe(1990);
    expect(l.hints[0].available).toBe(54_000 - 1600);
    expect(l.hints[1].available).toBe(1_200_000);
    const free = l.free!;
    expect(l.hints[0].x).toBeGreaterThanOrEqual(free.x);
    const last = l.hints[l.hints.length - 1];
    expect(last.x + last.w).toBeLessThanOrEqual(free.x + free.w + 0.001);
    expect(l.hints[0].x + l.hints[0].w).toBeLessThan(l.hints[1].x);
  });

  it("draws no hint when nothing is left to find or there is no room", () => {
    expect(layoutContextBars([bar("d", "documents", 390)], { budget: 60000, widthPx: 600, layers: [docs] }).hints).toEqual([]);
    expect(layoutContextBars([bar("d", "documents", 60000)], { budget: 60000, widthPx: 600, layers: [folders] }).hints).toEqual([]);
    expect(layoutContextBars([bar("d", "documents", 390)], { budget: 60000, widthPx: 600 }).hints).toEqual([]);
  });

  it("the prompt's own words take room on the axis without a bar", () => {
    const l = layoutContextBars([bar("m", "meetings", 1000)], { budget: 4000, widthPx: 400, total: 1400 });
    expect(l.used).toBe(1000);
    expect(l.framing).toBe(400);
    expect(l.free!.tokens).toBe(2600);
    const plain = layoutContextBars([bar("m", "meetings", 1000)], { budget: 4000, widthPx: 400 });
    expect(l.free!.x).toBeGreaterThan(plain.free!.x);
    expect(l.free!.x + l.free!.w).toBeCloseTo(400, 6);
  });

  it("the legend says what is sent, what is searched and how much exists", () => {
    expect(legendText("folders", 0, folders)).toBe("searched when you ask · 1.2M indexed".replace("1.2M", "1200k"));
    expect(legendText("meetings", 1600, meetings)).toBe("1.6k sent · searched when you ask · 54k indexed");
    expect(legendText("documents", 390, docs)).toBe("390");
    expect(legendText("documents", 390, { ...docs, available: 31_000, searched: true })).toBe("390 sent · searched when you ask · 31k in all");
    expect(legendText("instructions", 0, undefined)).toBe("none");
    expect(legendText("folders", 0, undefined)).toBe("none");
  });
});
