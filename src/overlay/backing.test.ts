import { describe, expect, it } from "vitest";
import {
  ACCENT_TOKENS,
  DEFAULT_OVERLAY_OPACITY,
  ICON_RATIO,
  MAX_HALO,
  OPACITY_LEVELS,
  TEXT_RATIO,
  backingFor,
  haloIconFilter,
  haloTextShadow,
  hslVarToRgb,
  nextOpacityLevel,
  overlayAlphas,
  stack,
  surfaceAlphaFor,
  transparencyFor,
  transparencyVars,
  worstContrast,
  type ThemeColours,
} from "./backing";

// The real colours: parsed from index.css, not copied.
async function tokens(): Promise<Record<"light" | "dark", ThemeColours>> {
  // @ts-expect-error the node types are not part of the app's build
  const { readFileSync } = await import("node:fs");
  const files: string[] = ["src/index.css", "src/live-notes/liveNotes.css"].map((f) => readFileSync(f, "utf8"));
  // a theme's variables can be spread over files: join the same selector's blocks
  const block = (sel: string) =>
    files
      .map((css) => {
        const i = css.indexOf(sel + " {");
        return i < 0 ? "" : css.slice(i, css.indexOf("}", i));
      })
      .join(" ");
  const get = (b: string, name: string) => hslVarToRgb(new RegExp(`${name}:\\s*([^;]+);`).exec(b)![1]);
  const make = (sel: string): ThemeColours => {
    const b = block(sel);
    return {
      background: get(b, "--background"),
      foreground: get(b, "--foreground"),
      mutedForeground: get(b, "--muted-foreground"),
      accents: ACCENT_TOKENS.map((n) => get(b, n)),
    };
  };
  return { light: make(":root"), dark: make(".dark") };
}

const STEPS = [0.1, 0.2, 0.3, 0.35, 0.4, 0.5, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1];

describe("the see-through window reads over any background", () => {
  for (const theme of ["light", "dark"] as const) {
    for (const a of STEPS) {
      it(`${theme} at ${Math.round(a * 100)}%: text 4.5:1, icons 3:1, against the worst grey behind (black, white, a photo)`, async () => {
        const c = (await tokens())[theme];
        const b = backingFor(c, a);
        expect(b.alpha).toBeGreaterThanOrEqual(a);
        expect(worstContrast(b.mutedRgb, c.background, b.alpha)).toBeGreaterThanOrEqual(TEXT_RATIO);
        expect(worstContrast(c.foreground, c.background, b.alpha)).toBeGreaterThanOrEqual(TEXT_RATIO);
        for (const accent of c.accents ?? []) expect(worstContrast(accent, c.background, b.alpha)).toBeGreaterThanOrEqual(TEXT_RATIO);
        expect(worstContrast(b.mutedRgb, c.background, b.alpha)).toBeGreaterThanOrEqual(ICON_RATIO);
        // the muted colour never gets weaker than the theme's own
        expect(worstContrast(b.mutedRgb, c.background, b.alpha)).toBeGreaterThanOrEqual(
          worstContrast(c.mutedForeground, c.background, b.alpha) - 1e-9,
        );
      });
    }
    it(`${theme} at 100% is unchanged, and the minimum is applied, not more`, async () => {
      const c = (await tokens())[theme];
      expect(backingFor(c, 1)).toMatchObject({ alpha: 1, muted: 0 });
      const low = backingFor(c, 0.6);
      expect(low.alpha).toBeLessThan(0.95);
    });
  }

  it("the surfaces of panels reach the same total backing", () => {
    expect(surfaceAlphaFor(0.6, 0.85)).toBeCloseTo(1 - (1 - 0.85) / (1 - 0.6), 5);
    expect(surfaceAlphaFor(0.9, 0.5)).toBe(0.2);
  });
});

describe("the opacity levels", () => {
  it("the eye cycles 100, 85, 65, 45, 30 and wraps to solid", () => {
    expect([...OPACITY_LEVELS]).toEqual([1, 0.85, 0.65, 0.45, 0.3]);
    const seen: number[] = [];
    let o = 1;
    for (let i = 0; i < 6; i++) {
      o = nextOpacityLevel(o);
      seen.push(o);
    }
    expect(seen).toEqual([0.85, 0.65, 0.45, 0.3, 1, 0.85]);
  });

  it("a saved value that is not a level (an old preset, a slider) goes to the next level from its nearest one", () => {
    expect(nextOpacityLevel(0.9)).toBe(0.65); // nearest is 85
    expect(nextOpacityLevel(0.35)).toBe(1); // nearest is 30, the last
    expect(nextOpacityLevel(0.1)).toBe(1);
    expect(nextOpacityLevel(0.66)).toBe(0.45); // nearest is 65
    expect(nextOpacityLevel(0.97)).toBe(0.85); // nearest is 100
  });

  it("panels default to about 85%", () => {
    expect(DEFAULT_OVERLAY_OPACITY).toBe(0.85);
    expect(overlayAlphas(DEFAULT_OVERLAY_OPACITY).reading).toBeCloseTo(0.85, 5);
  });
});

describe("the window and the panels both take their alpha from the level", () => {
  it("window plus a reading panel add up to the level, for every level", () => {
    for (const l of [0.1, 0.2, 0.3, 0.45, 0.65, 0.85, 0.95]) {
      const a = overlayAlphas(l);
      expect(stack(a.window, a.readingSurface)).toBeCloseTo(l, 2);
      expect(a.reading).toBeCloseTo(l, 5);
      expect(a.window).toBeLessThan(l);
    }
  });

  it("lower levels are really more see-through, window and panel surface alike", () => {
    let prev = overlayAlphas(1);
    for (const l of [0.85, 0.65, 0.45, 0.3]) {
      const a = overlayAlphas(l);
      expect(a.window).toBeLessThan(prev.window);
      expect(a.reading).toBeLessThan(prev.reading);
      // a quiet panel is never firmer than a reading one
      expect(a.quietSurface).toBeLessThanOrEqual(a.readingSurface + 1e-9);
      prev = a;
    }
    // at 30% the panel as seen is 30% opaque, not the old 85% floor
    expect(overlayAlphas(0.3).reading).toBeCloseTo(0.3, 5);
    expect(overlayAlphas(0.3).window).toBeLessThan(0.25);
    expect(overlayAlphas(0.3).readingSurface).toBeLessThan(0.15);
  });

  it("100% is the solid window with the card tint it always had", () => {
    expect(overlayAlphas(1)).toEqual({ window: 1, reading: 1, readingSurface: 0.2, quietSurface: 0.2 });
  });

  it("clamps what it is given", () => {
    expect(overlayAlphas(-1).window).toBe(0);
    expect(overlayAlphas(7).window).toBe(1);
  });
});

describe("text and icons read at every level, through the halo and not a solid box", () => {
  const LEVELS = [...OPACITY_LEVELS, 0.1, 0.2, 0.25, 0.35, 0.55, 0.75, 0.9, 0.95];
  for (const theme of ["light", "dark"] as const) {
    for (const level of LEVELS) {
      it(`${theme} at ${Math.round(level * 100)}%: 4.5:1 text and 3:1 icons on the window and on a reading panel, over the worst grey`, async () => {
        const c = (await tokens())[theme];
        const t = transparencyFor(c, level);
        const colours = [c.foreground, t.mutedRgb, ...(c.accents ?? [])];
        for (const local of [t.chromeLocal, t.readingLocal]) {
          for (const rgb of colours) {
            expect(worstContrast(rgb, c.background, local)).toBeGreaterThanOrEqual(TEXT_RATIO);
            expect(worstContrast(rgb, c.background, local)).toBeGreaterThanOrEqual(ICON_RATIO);
          }
        }
        // the muted colour never gets weaker than the theme's own
        expect(worstContrast(t.mutedRgb, c.background, t.chromeLocal)).toBeGreaterThanOrEqual(
          worstContrast(c.mutedForeground, c.background, t.chromeLocal) - 1e-9,
        );
        // it is a halo, never a solid box
        expect(t.chromeHalo).toBeLessThanOrEqual(MAX_HALO);
        expect(t.readingHalo).toBeLessThanOrEqual(MAX_HALO);
        // a reading panel's own surface backs it, so it needs no more halo than the bare window
        expect(t.readingHalo).toBeLessThanOrEqual(t.chromeHalo + 0.01);
      });
    }
    it(`${theme}: the solid window needs no halo and changes no colour`, async () => {
      const t = transparencyFor((await tokens())[theme], 1);
      expect(t.chromeHalo).toBe(0);
      expect(t.readingHalo).toBe(0);
      expect(t.muted).toBe(0);
      expect(transparencyVars(t)).toMatchObject({ "--nq-halo-text": "none", "--nq-halo-icon": "none" });
      expect(transparencyVars(t)["--muted-foreground"]).toBeUndefined();
    });
    it(`${theme}: the halo grows as the window gets more see-through`, async () => {
      const c = (await tokens())[theme];
      let prev = -1;
      for (const l of [1, 0.85, 0.65, 0.45, 0.3]) {
        const h = transparencyFor(c, l).chromeHalo;
        expect(h).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = h;
      }
    });
  }

  it("the halo is the window colour, behind the glyphs only", () => {
    expect(haloTextShadow(0)).toBe("none");
    expect(haloIconFilter(0)).toBe("none");
    const s = haloTextShadow(0.8);
    expect(s).toContain("hsl(var(--background) /");
    // it surrounds the glyph on every side (rings of 1px offsets), it is not a one-sided drop shadow
    for (const side of ["1px 0px 0", "-1px 0px 0", "0px 1px 0", "0px -1px 0"]) expect(s).toContain(side);
    expect(s).toContain("0 0 3px");
    expect(haloIconFilter(0.8)).toContain("drop-shadow(1px 0px 0 ");
  });
});
