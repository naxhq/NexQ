import { describe, expect, it } from "vitest";
import {
  areaOf,
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
