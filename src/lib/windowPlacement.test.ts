import { describe, expect, it } from "vitest";
import {
  MAX_SETUPS,
  applyRect,
  areaOf,
  planRestore,
  rememberSetup,
  sanitizeSetups,
  setupKey,
  type SetupEntry,
  defaultLauncherRect,
  pickArea,
  resolvePlacement,
  samePlacement,
  sanitizePlacement,
  snapshotPlacement,
  type WorkArea,
} from "./windowPlacement";

const main: WorkArea = { x: 0, y: 0, w: 1920, h: 1040, scale: 1 };
const right: WorkArea = { x: 1920, y: 0, w: 2560, h: 1400, scale: 1.5 };
const overlayOpts = { minW: 400, minH: 480 };
const launcherOpts = { minW: 700, minH: 500, chromeW: 16, chromeH: 40 };

describe("sanitizePlacement", () => {
  it("keeps a good one and rounds", () => {
    expect(sanitizePlacement({ x: 10.4, y: 20, w: 500, h: 700, scale: 1.25 })).toEqual({
      x: 10,
      y: 20,
      w: 500,
      h: 700,
      scale: 1.25,
    });
  });
  it.each([
    null,
    undefined,
    "x",
    {},
    { x: 1, y: 1, w: 50, h: 700, scale: 1 },
    { x: NaN, y: 1, w: 500, h: 700, scale: 1 },
    { x: 1, y: 1, w: 500, h: 700, scale: 0 },
    { x: 1e9, y: 1, w: 500, h: 700, scale: 1 },
  ])("drops garbage %#", (v) => {
    expect(sanitizePlacement(v)).toBeNull();
  });
});

describe("snapshotPlacement", () => {
  it("refuses the parked-minimised position", () => {
    expect(snapshotPlacement({ x: -32000, y: -32000 }, { w: 160, h: 28 }, 1)).toBeNull();
  });
  it("accepts a negative position on a left-hand monitor", () => {
    expect(snapshotPlacement({ x: -1500, y: 100 }, { w: 800, h: 600 }, 1)?.x).toBe(-1500);
  });
});

describe("resolvePlacement", () => {
  it("keeps a window that is fully on its monitor", () => {
    const r = resolvePlacement({ x: 100, y: 80, w: 500, h: 700, scale: 1 }, [main], main, overlayOpts);
    expect(r).toEqual({ x: 100, y: 80, w: 500, h: 700 });
  });

  it("slides a window that hangs off the right and bottom edge back inside the work area", () => {
    const r = resolvePlacement({ x: 1800, y: 900, w: 500, h: 700, scale: 1 }, [main], main, overlayOpts)!;
    expect(r.x + r.w).toBeLessThanOrEqual(1920);
    expect(r.y + r.h).toBeLessThanOrEqual(1040);
    expect(r.x).toBeGreaterThanOrEqual(0);
  });

  it("shrinks a window larger than the work area", () => {
    const r = resolvePlacement({ x: 0, y: 0, w: 3000, h: 2000, scale: 1 }, [main], main, overlayOpts)!;
    expect(r).toEqual({ x: 0, y: 0, w: 1920, h: 1040 });
  });

  it("centres on the fallback monitor when the saved one was unplugged", () => {
    const r = resolvePlacement({ x: 2400, y: 100, w: 600, h: 800, scale: 1 }, [main], main, overlayOpts)!;
    expect(r).toEqual({ x: 660, y: 120, w: 600, h: 800 });
  });

  it("treats a window that is almost entirely off-screen as lost", () => {
    const r = resolvePlacement({ x: -580, y: 100, w: 600, h: 800, scale: 1 }, [main], main, overlayOpts)!;
    expect(r.x).toBe(660);
  });

  it("picks the monitor with the larger overlap", () => {
    expect(pickArea([main, right], { x: 1700, y: 100, w: 800, h: 600 })).toBe(right);
    expect(pickArea([main, right], { x: 1000, y: 100, w: 800, h: 600 })).toBe(main);
  });

  it("converts the size through logical pixels when the monitor's scale differs", () => {
    // Saved at 100% (500x700); restored on the 150% monitor: 750x1050 physical.
    const r = resolvePlacement({ x: 2000, y: 50, w: 500, h: 700, scale: 1 }, [main, right], main, overlayOpts)!;
    expect(r.w).toBe(750);
    expect(r.h).toBe(1050);
    // Same logical size when the saved scale was 1.5 and the monitor is 1.5.
    const r2 = resolvePlacement({ x: 2000, y: 50, w: 750, h: 1050, scale: 1.5 }, [main, right], main, overlayOpts)!;
    expect(r2.w).toBe(750);
    expect(r2.h).toBe(1050);
  });

  it("raises a tiny saved size to the minimum", () => {
    const r = resolvePlacement({ x: 10, y: 10, w: 150, h: 150, scale: 1 }, [main], main, overlayOpts)!;
    expect(r.w).toBe(400);
    expect(r.h).toBe(480);
  });

  it("leaves room for a title bar on decorated windows", () => {
    const r = resolvePlacement({ x: 1000, y: 800, w: 1100, h: 700, scale: 1 }, [main], main, launcherOpts)!;
    expect(r.y + r.h + 40).toBeLessThanOrEqual(1040);
    expect(r.x + r.w + 16).toBeLessThanOrEqual(1920);
  });

  it("does nothing when no monitor is known", () => {
    expect(resolvePlacement({ x: 0, y: 0, w: 500, h: 700, scale: 1 }, [], null, overlayOpts)).toBeNull();
  });

  it("works on a monitor to the left of the primary (negative coordinates)", () => {
    const left: WorkArea = { x: -1920, y: 0, w: 1920, h: 1040, scale: 1 };
    const r = resolvePlacement({ x: -1500, y: 100, w: 500, h: 700, scale: 1 }, [left, main], main, overlayOpts)!;
    expect(r).toEqual({ x: -1500, y: 100, w: 500, h: 700 });
  });
});

describe("defaultLauncherRect", () => {
  it("is 1180x740 centred on a large screen", () => {
    const r = defaultLauncherRect(main, launcherOpts);
    expect(r.w).toBe(1180);
    expect(r.h).toBe(740);
    expect(r.x).toBe(Math.round((1920 - 1180 - 16) / 2));
  });
  it("is 92% of a small work area", () => {
    const small: WorkArea = { x: 0, y: 0, w: 1100, h: 640, scale: 1 };
    const r = defaultLauncherRect(small, launcherOpts);
    expect(r.w).toBe(Math.round(1100 * 0.92));
    expect(r.h).toBe(Math.round(640 * 0.92));
  });
  it("uses logical pixels on a high-DPI monitor", () => {
    const hi: WorkArea = { x: 0, y: 0, w: 3840, h: 2080, scale: 2 };
    const r = defaultLauncherRect(hi, launcherOpts);
    expect(r.w).toBe(2360);
    expect(r.h).toBe(1480);
  });
});

describe("misc", () => {
  it("compares placements", () => {
    const a = { x: 1, y: 2, w: 300, h: 400, scale: 1 };
    expect(samePlacement(a, { ...a })).toBe(true);
    expect(samePlacement(a, { ...a, w: 301 })).toBe(false);
    expect(samePlacement(null, null)).toBe(true);
    expect(samePlacement(a, null)).toBe(false);
  });
  it("reads the work area, falling back to the full monitor", () => {
    const m = { scaleFactor: 2, position: { x: 0, y: 0 }, size: { width: 100, height: 50 } };
    expect(areaOf(m)).toEqual({ x: 0, y: 0, w: 100, h: 50, scale: 2 });
    expect(areaOf({ ...m, workArea: { position: { x: 0, y: 0 }, size: { width: 90, height: 40 } } }).w).toBe(90);
  });
});

// == Monitor setups: property tests with random monitors, scales and places ==

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomSetup(r: () => number): WorkArea[] {
  const n = 1 + Math.floor(r() * 3);
  const scales = [1, 1.25, 1.5, 1.75, 2];
  const out: WorkArea[] = [];
  let x = Math.round((r() - 0.5) * 6000);
  for (let i = 0; i < n; i++) {
    const w = 1280 + Math.floor(r() * 2600);
    const h = 720 + Math.floor(r() * 1500);
    out.push({ x, y: Math.round((r() - 0.5) * 3000), w, h, scale: scales[Math.floor(r() * scales.length)] });
    x += w;
  }
  return out;
}

const OPTS = { minW: 400, minH: 480 };
const inside = (rect: { x: number; y: number; w: number; h: number }, a: WorkArea) =>
  rect.x >= a.x && rect.y >= a.y && rect.x + rect.w <= a.x + a.w && rect.y + rect.h <= a.y + a.h;

describe("planRestore (random monitor setups)", () => {
  it("never puts a window off-screen, whatever was saved and whichever monitors are connected", () => {
    const r = rng(7);
    for (let i = 0; i < 400; i++) {
      const before = randomSetup(r);
      const now = randomSetup(r);
      const on = before[Math.floor(r() * before.length)];
      const saved = {
        x: Math.round(on.x + r() * on.w),
        y: Math.round(on.y + r() * on.h),
        w: 400 + Math.floor(r() * 1600),
        h: 480 + Math.floor(r() * 1000),
        scale: on.scale,
      };
      const entries: SetupEntry[] = [{ key: setupKey(before), placement: saved, area: on, at: 1 }];
      const plan = planRestore(entries, null, now, now[0], now[0], OPTS)!;
      expect(plan).not.toBeNull();
      expect(now.some((a) => inside(plan.rect, a))).toBe(true);
    }
  });

  it("is idempotent: planning from the planned place gives the same place", () => {
    const r = rng(11);
    for (let i = 0; i < 300; i++) {
      const areas = randomSetup(r);
      const on = areas[Math.floor(r() * areas.length)];
      const saved = { x: Math.round(on.x + r() * on.w), y: Math.round(on.y + r() * on.h), w: 500, h: 700, scale: on.scale };
      const key = setupKey(areas);
      const first = planRestore([{ key, placement: saved, area: on, at: 1 }], null, areas, areas[0], areas[0], OPTS)!;
      const home = areas.find((a) => inside(first.rect, a))!;
      const again = planRestore([{ key, placement: { ...first.rect, scale: home.scale }, area: on, at: 2 }], null, areas, areas[0], areas[0], OPTS)!;
      expect(again.rect).toEqual(first.rect);
    }
  });

  it("uses the own place of a setup it has seen, whatever the order of the monitors", () => {
    const a = [{ x: 0, y: 0, w: 1920, h: 1040, scale: 1 }];
    const b = [
      { x: 0, y: 0, w: 1920, h: 1040, scale: 1 },
      { x: 1920, y: 0, w: 2560, h: 1400, scale: 1.5 },
    ];
    const entries: SetupEntry[] = [
      { key: setupKey(a), placement: { x: 40, y: 40, w: 800, h: 600, scale: 1 }, area: a[0], at: 2 },
      { key: setupKey(b), placement: { x: 2500, y: 100, w: 1200, h: 900, scale: 1.5 }, area: b[1], at: 1 },
    ];
    expect(planRestore(entries, null, a, a[0], a[0], OPTS)!.rect).toMatchObject({ x: 40, y: 40, w: 800, h: 600 });
    const swapped = [b[1], b[0]];
    expect(setupKey(swapped)).toBe(setupKey(b));
    expect(planRestore(entries, null, swapped, b[0], b[1], OPTS)!.rect).toMatchObject({ x: 2500, y: 100, w: 1200, h: 900 });
  });

  it("an unknown setup gets the same relative place on the primary, never outside it", () => {
    const old = { x: 3840, y: 0, w: 3840, h: 2120, scale: 2 };
    const entries: SetupEntry[] = [{ key: "old", placement: { x: 3840 + 1920, y: 1060, w: 1600, h: 1000, scale: 2 }, area: old, at: 1 }];
    const laptop: WorkArea[] = [{ x: 0, y: 0, w: 1920, h: 1040, scale: 1.25 }];
    const plan = planRestore(entries, null, laptop, laptop[0], laptop[0], OPTS)!;
    expect(plan.known).toBe(false);
    expect(inside(plan.rect, laptop[0])).toBe(true);
    // Half way across the old monitor: well right of the left edge on this one.
    expect(plan.rect.x).toBeGreaterThan(300);
  });

  it("works with negative coordinates (a monitor left of or above the primary)", () => {
    const areas: WorkArea[] = [
      { x: -2560, y: -400, w: 2560, h: 1400, scale: 1 },
      { x: 0, y: 0, w: 1920, h: 1040, scale: 1 },
    ];
    const entries: SetupEntry[] = [{ key: setupKey(areas), placement: { x: -2000, y: -300, w: 900, h: 700, scale: 1 }, area: areas[0], at: 1 }];
    expect(planRestore(entries, null, areas, areas[1], areas[1], OPTS)!.rect).toMatchObject({ x: -2000, y: -300 });
  });

  it("falls back to the old single placement, centred when its monitor is gone", () => {
    const areas: WorkArea[] = [{ x: 0, y: 0, w: 1920, h: 1040, scale: 1 }];
    const plan = planRestore([], { x: 5000, y: 100, w: 800, h: 600, scale: 1 }, areas, areas[0], areas[0], OPTS)!;
    expect(inside(plan.rect, areas[0])).toBe(true);
  });

  it("returns nothing when nothing was saved or no monitor is known", () => {
    expect(planRestore([], null, [{ x: 0, y: 0, w: 1920, h: 1040, scale: 1 }], null, null, OPTS)).toBeNull();
    expect(planRestore([], { x: 0, y: 0, w: 800, h: 600, scale: 1 }, [], null, null, OPTS)).toBeNull();
  });
});

describe("setups storage", () => {
  const p = { x: 1, y: 2, w: 500, h: 700, scale: 1 };
  it("keeps at most six setups, newest first, one per key", () => {
    let list: SetupEntry[] = [];
    for (let i = 0; i < 9; i++) list = rememberSetup(list, { key: `k${i}`, placement: p, area: null, at: i });
    list = rememberSetup(list, { key: "k5", placement: { ...p, x: 9 }, area: null, at: 20 });
    expect(list).toHaveLength(MAX_SETUPS);
    expect(list[0].key).toBe("k5");
    expect(list.filter((e) => e.key === "k5")).toHaveLength(1);
  });

  it("reads an old config (no setups) and garbage as empty, and drops bad entries", () => {
    expect(sanitizeSetups(undefined)).toEqual([]);
    expect(sanitizeSetups("x")).toEqual([]);
    const good = { key: "k", placement: p, area: null, at: 1 };
    expect(sanitizeSetups([good, { key: "", placement: p }, { key: "z", placement: { x: "a" } }, null, good])).toHaveLength(1);
  });

  it("keeps the maximised flag through the sanitizer", () => {
    expect(sanitizePlacement({ ...p, maximized: true })).toMatchObject({ maximized: true });
    expect(sanitizePlacement({ ...p, maximized: "yes" })).not.toHaveProperty("maximized");
  });
});

describe("applyRect", () => {
  it("sets position, then size, and stops when it reads back right", async () => {
    const calls: string[] = [];
    let pos = { x: 0, y: 0 };
    let size = { w: 0, h: 0 };
    const ok = await applyRect(
      {
        setPosition: async (x, y) => (calls.push("pos"), void (pos = { x, y })),
        setSize: async (w, h) => (calls.push("size"), void (size = { w, h })),
        outerPosition: async () => pos,
        innerSize: async () => size,
      },
      { x: 10, y: 20, w: 500, h: 600 },
    );
    expect(ok).toBe(true);
    expect(calls).toEqual(["pos", "size"]);
  });

  it("tries a second time only, when the first did not stick", async () => {
    let n = 0;
    const win = {
      setPosition: async () => void n++,
      setSize: async () => void n++,
      outerPosition: async () => ({ x: 0, y: 0 }),
      innerSize: async () => ({ w: 1, h: 1 }),
    };
    expect(await applyRect(win, { x: 10, y: 20, w: 500, h: 600 })).toBe(false);
    expect(n).toBe(4);
  });
});
