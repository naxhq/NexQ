import { describe, expect, it } from "vitest";
import { placeBox, type Anchor } from "./portal";

const anchor = (left: number, top: number, w = 24, h = 24): Anchor => ({ left, top, right: left + w, bottom: top + h, width: w, height: h });
const sizes = [
  { width: 420, height: 420 },
  { width: 500, height: 700 },
  { width: 980, height: 560 },
  { width: 1400, height: 900 },
  { width: 2560, height: 1400 },
];
const boxes = [
  { width: 272, height: 640 },
  { width: 160, height: 120 },
  { width: 400, height: 900 },
];

describe("placeBox keeps every popover inside the window", () => {
  for (const vp of sizes) {
    for (const box of boxes) {
      // the opener at every edge and corner, and in the middle
      const xs = [0, vp.width / 2 - 12, vp.width - 24];
      const ys = [0, vp.height / 2 - 12, vp.height - 24];
      for (const x of xs) {
        for (const y of ys) {
          for (const align of ["start", "end", "center"] as const) {
            for (const prefer of ["below", "above"] as const) {
              it(`${vp.width}x${vp.height} box ${box.width}x${box.height} opener ${x},${y} ${align} ${prefer}`, () => {
                const p = placeBox(anchor(x, y), box, { align, prefer, viewport: vp });
                const w = Math.min(box.width, p.maxWidth);
                const h = Math.min(box.height, p.maxHeight);
                expect(p.left).toBeGreaterThanOrEqual(8);
                expect(p.top).toBeGreaterThanOrEqual(8);
                expect(p.left + w).toBeLessThanOrEqual(vp.width - 8 + 0.01);
                expect(p.top + h).toBeLessThanOrEqual(vp.height - 8 + 0.01);
              });
            }
          }
        }
      }
    }
  }

  it("a right-aligned popover under a button near the left edge is shifted in, not cut off", () => {
    const p = placeBox(anchor(40, 10), { width: 272, height: 300 }, { align: "end", viewport: { width: 980, height: 560 } });
    expect(p.left).toBe(8);
  });

  it("flips above when there is more room there", () => {
    const p = placeBox(anchor(100, 500), { width: 200, height: 300 }, { viewport: { width: 980, height: 560 } });
    expect(p.placement).toBe("above");
  });

  it("limits the height to the room on its side and lets it scroll", () => {
    const p = placeBox(anchor(100, 20), { width: 200, height: 900 }, { viewport: { width: 500, height: 700 } });
    expect(p.maxHeight).toBeLessThan(900);
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(692);
  });

  it("covers the opener when there is no usable room on either side", () => {
    const p = placeBox(anchor(0, 80, 24, 24), { width: 200, height: 300 }, { viewport: { width: 420, height: 200 }, gap: 6 });
    expect(p.maxHeight).toBe(184);
  });
});
