import { describe, expect, it } from "vitest";
import {
  computeGeometry,
  distribute,
  hitTest,
  rectWithin,
  rectsOverlap,
  resizeFromDelta,
  snapCandidates,
  type Geometry,
  type PanelMeta,
  type Rect,
} from "./layoutGeometry";
import {
  DEFAULT_PANELS,
  PRESET_IDS,
  dockReducer,
  initialDockState,
  leaves,
  presetLayout,
  allPanels,
  type DockAction,
  type DockState,
} from "./layoutModel";

const METAS: Record<string, PanelMeta> = Object.fromEntries(
  DEFAULT_PANELS.map((p) => [p, { minW: 180, minH: 120 }]),
);

function allRects(g: Geometry): Rect[] {
  return g.stacks.map((s) => s.rect);
}
function expectSound(g: Geometry) {
  const rs = allRects(g);
  rs.forEach((r, i) => {
    expect(r.w).toBeGreaterThanOrEqual(0);
    expect(r.h).toBeGreaterThanOrEqual(0);
    expect(rectWithin(r, g.size)).toBe(true);
    for (let j = i + 1; j < rs.length; j++) expect(rectsOverlap(r, rs[j])).toBe(false);
  });
  for (const s of g.stacks) {
    expect(rectWithin(s.tabBar, g.size)).toBe(true);
    expect(rectWithin(s.body, g.size)).toBe(true);
    if (!s.strip) {
      expect(s.tabBar.y + s.tabBar.h).toBeLessThanOrEqual(s.body.y);
    }
  }
  for (const sep of g.separators) {
    expect(rectWithin(sep.rect, g.size)).toBe(true);
    for (const r of rs) expect(rectsOverlap(sep.rect, r)).toBe(false);
  }
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("distribute", () => {
  it("respects minimums and sums to the total", () => {
    const out = distribute(500, [0.9, 0.05, 0.05], [100, 100, 100]);
    expect(out[1]).toBeGreaterThanOrEqual(100);
    expect(out.reduce((a, b) => a + b, 0)).toBeCloseTo(500, 6);
  });
});

describe("Classic at real widths (matches today's flex-wrap)", () => {
  const classic = presetLayout("classic", DEFAULT_PANELS);
  const at = (w: number, h = 480) => computeGeometry(classic, { w, h }, METAS);

  it("400 px wraps: transcript above assistant, both visible", () => {
    const g = at(400);
    const t = g.stacks.find((s) => s.panels[0] === "transcript")!;
    const a = g.stacks.find((s) => s.panels[0] === "assistant")!;
    expect(g.stacks).toHaveLength(2);
    expect(g.compact).toBe(false);
    expect(t.rect.x).toBe(a.rect.x);
    expect(t.rect.y).toBeLessThan(a.rect.y);
    expect(g.panels.transcript.visible && g.panels.assistant.visible).toBe(true);
    expectSound(g);
  });

  it.each([500, 900])("%i px is two columns, transcript left", (w) => {
    const g = at(w);
    const t = g.stacks.find((s) => s.panels[0] === "transcript")!;
    const a = g.stacks.find((s) => s.panels[0] === "assistant")!;
    expect(t.rect.y).toBe(a.rect.y);
    expect(t.rect.x).toBeLessThan(a.rect.x);
    expect(Math.abs(t.rect.w - a.rect.w)).toBeLessThanOrEqual(1);
    expect(t.rect.w).toBeGreaterThanOrEqual(220);
    expectSound(g);
  });

  it("the wrap point is where 2 x 220 + gap + padding stops fitting", () => {
    expect(at(473).stacks[0].rect.x).toBe(at(473).stacks[1].rect.x);
    expect(at(474).stacks[0].rect.y).toBe(at(474).stacks[1].rect.y);
  });

  it("falls back to merged tabs only when neither axis fits", () => {
    const g = computeGeometry(classic, { w: 400, h: 200 }, METAS);
    expect(g.compact).toBe(true);
    expect(g.stacks).toHaveLength(1);
    expect(g.stacks[0].panels).toEqual(["transcript", "assistant"]);
    expectSound(g);
  });
});

describe("never overlaps or overflows", () => {
  const sizes: [number, number][] = [
    [400, 480],
    [400, 700],
    [520, 480],
    [700, 560],
    [900, 650],
    [1280, 720],
    [1920, 1080],
    [3840, 2160],
    [320, 240],
    [120, 90],
    [3840, 300],
  ];
  it.each(PRESET_IDS)("preset %s at every size", (id) => {
    const l = presetLayout(id, DEFAULT_PANELS);
    for (const [w, h] of sizes) expectSound(computeGeometry(l, { w, h }, METAS));
  });

  it("random layouts at random sizes", () => {
    const r = rng(42);
    let s: DockState = initialDockState();
    for (let i = 0; i < 400; i++) {
      const panels = allPanels(s.layout);
      const stacks = leaves(s.layout.root);
      const p = panels[Math.floor(r() * panels.length)];
      const zones = ["left", "right", "top", "bottom", "center"] as const;
      const act: DockAction =
        r() < 0.15
          ? { type: "hide", panel: p }
          : r() < 0.2
            ? { type: "show", panel: p }
            : r() < 0.1 && stacks.length
              ? { type: "collapse", stackId: stacks[Math.floor(r() * stacks.length)].id }
              : stacks.length
                ? {
                    type: "dock",
                    panel: p,
                    target:
                      r() < 0.8
                        ? { kind: "stack", stackId: stacks[Math.floor(r() * stacks.length)].id }
                        : { kind: "edge" },
                    zone: zones[Math.floor(r() * 5)],
                  }
                : { type: "show", panel: p };
      s = dockReducer(s, act);
      const w = 120 + Math.floor(r() * 3720);
      const h = 90 + Math.floor(r() * 2070);
      expectSound(computeGeometry(s.layout, { w, h }, METAS));
    }
  });

  it("collapsed strips keep their thickness", () => {
    let s = initialDockState();
    const t = leaves(s.layout.root)[0];
    s = dockReducer(s, { type: "collapse", stackId: t.id });
    const g = computeGeometry(s.layout, { w: 900, h: 600 }, METAS);
    const strip = g.stacks.find((x) => x.id === t.id)!;
    expect(strip.strip).toBe(true);
    expect(strip.rect.w).toBe(28);
    expect(g.separators).toHaveLength(0);
    expectSound(g);
  });
});

describe("separators", () => {
  const g = computeGeometry(presetLayout("classic", DEFAULT_PANELS), { w: 900, h: 600 }, METAS);
  const sep = g.separators[0];

  it("sits in the gap between two stacks", () => {
    expect(sep.axis).toBe("x");
    expect(sep.rect.w).toBe(10);
    expect(sep.fraction).toBeCloseTo(0.5, 1);
  });

  it("moves, clamps to minimums, and keeps sizes summing to 1", () => {
    const r = resizeFromDelta(sep, 100);
    expect(r.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(r.sizes[0]).toBeGreaterThan(r.sizes[1]);
    const far = resizeFromDelta(sep, -10000);
    const aPx = far.sizes[0] * (900 - 24 - 10);
    expect(aPx).toBeGreaterThanOrEqual(179);
  });

  it("snaps to 50% and releases outside the threshold", () => {
    const snap = snapCandidates(g, sep);
    expect(resizeFromDelta(sep, 4, snap).snapped).toBe(true);
    expect(resizeFromDelta(sep, 4, snap).pos).toBeCloseTo(sep.pos - (sep.pos - snap[0]), 3);
    expect(resizeFromDelta(sep, 40, snap).snapped).toBe(false);
  });

  it("snaps to a neighbouring separator", () => {
    const l = dockReducer(initialDockState(), { type: "preset", preset: "notes" }).layout;
    const geo = computeGeometry(l, { w: 1000, h: 700 }, METAS);
    const horiz = geo.separators.find((s) => s.axis === "y")!;
    const vert = geo.separators.find((s) => s.axis === "x")!;
    expect(snapCandidates(geo, vert)).not.toContain(horiz.pos);
    expect(horiz.pos).toBeGreaterThan(0);
  });
});

describe("hit testing", () => {
  const l = presetLayout("classic", DEFAULT_PANELS);
  const g = computeGeometry(l, { w: 900, h: 600 }, METAS);
  const t = g.stacks[0];
  const a = g.stacks[1];

  it("window edges beat stack zones", () => {
    const hit = hitTest(g, 3, 300, "assistant", true)!;
    expect(hit.target.kind).toBe("edge");
    expect(hit.zone).toBe("left");
  });

  it("the middle of a stack tabs, its sides split", () => {
    const cx = a.rect.x + a.rect.w / 2;
    const cy = a.rect.y + a.rect.h / 2;
    expect(hitTest(g, cx, cy, "transcript", true)!.zone).toBe("center");
    expect(hitTest(g, a.rect.x + 10, cy, "transcript", true)!.zone).toBe("left");
    expect(hitTest(g, cx, a.rect.y + a.rect.h - 12, "transcript", true)!.zone).toBe("bottom");
  });

  it("tab bar gives centre with onTabBar", () => {
    const hit = hitTest(g, a.tabBar.x + 20, a.tabBar.y + 22, "transcript", true)!;
    expect(hit.onTabBar).toBe(true);
    expect(hit.zone).toBe("center");
  });

  it("no drop on a panel's own sole stack", () => {
    expect(hitTest(g, t.rect.x + t.rect.w / 2, t.rect.y + t.rect.h / 2, "transcript", true)).toBeNull();
  });

  it("no drops while compact", () => {
    const c = computeGeometry(l, { w: 400, h: 200 }, METAS);
    expect(hitTest(c, 200, 100, "assistant", true)).toBeNull();
  });
});
