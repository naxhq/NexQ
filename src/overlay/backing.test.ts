import { describe, expect, it } from "vitest";
import { ACCENT_TOKENS, ICON_RATIO, TEXT_RATIO, backingFor, hslVarToRgb, surfaceAlphaFor, worstContrast, type ThemeColours } from "./backing";

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
