import { describe, expect, it } from "vitest";
import { areaAt, resetRect } from "./windowReset";
import type { MonitorLike, WorkArea } from "./windowPlacement";

const mon = (x: number, y: number, w: number, h: number, scaleFactor = 1): MonitorLike => ({ scaleFactor, position: { x, y }, size: { width: w, height: h } });

describe("window reset", () => {
  const area: WorkArea = { x: -1920, y: 0, w: 1920, h: 1040, scale: 1.25 };
  it("puts the launcher on first-start size and the overlay at the top right, both inside the work area", () => {
    for (const label of ["launcher", "overlay"] as const) {
      const r = resetRect(label, area, label === "launcher" ? { minW: 700, minH: 500, chromeW: 16, chromeH: 40 } : { minW: 400, minH: 480 });
      expect(r.x).toBeGreaterThanOrEqual(area.x);
      expect(r.y).toBeGreaterThanOrEqual(area.y);
      expect(r.x + r.w).toBeLessThanOrEqual(area.x + area.w);
      expect(r.y + r.h).toBeLessThanOrEqual(area.y + area.h);
    }
  });

  it("chooses the monitor under the mouse, else the primary", () => {
    const monitors = [mon(0, 0, 1920, 1080), mon(1920, 0, 2560, 1440, 1.5)];
    expect(areaAt(monitors, monitors[0], { x: 2000, y: 100 })!.x).toBe(1920);
    expect(areaAt(monitors, monitors[0], { x: 99999, y: 0 })!.x).toBe(0);
    expect(areaAt(monitors, monitors[1], null)!.x).toBe(1920);
  });
});
