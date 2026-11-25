import { describe, expect, it } from "vitest";
import { WORKSPACE_HUES, hueColor, isWorkspaceHue } from "./hues";

function rgb([h, s, l]: [number, number, number]): [number, number, number] {
  const sat = s / 100;
  const lig = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}
function luminance(c: [number, number, number]): number {
  const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}
function contrast(a: [number, number, number], b: [number, number, number]): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// Backgrounds from src/index.css: page, card/popover and secondary, per theme.
const LIGHT_BACKGROUNDS: Array<[number, number, number]> = [[0, 0, 100], [210, 20, 98], [210, 40, 96]];
const DARK_BACKGROUNDS: Array<[number, number, number]> = [[222, 47, 6], [222, 40, 8], [220, 26, 14]];

describe("workspace hues", () => {
  it("are eight, with unique ids", () => {
    expect(WORKSPACE_HUES).toHaveLength(8);
    expect(new Set(WORKSPACE_HUES.map((h) => h.id)).size).toBe(8);
  });

  it("reach 4.5:1 (AA text) on every light and dark background", () => {
    for (const hue of WORKSPACE_HUES) {
      for (const bg of LIGHT_BACKGROUNDS) expect(contrast(rgb(hue.light), rgb(bg)), `${hue.id} light`).toBeGreaterThanOrEqual(4.5);
      for (const bg of DARK_BACKGROUNDS) expect(contrast(rgb(hue.dark), rgb(bg)), `${hue.id} dark`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("stay out of blue, green, amber and red (coloured hues only)", () => {
    for (const hue of WORKSPACE_HUES) {
      const [h, s] = hue.light;
      if (s < 25) continue; // the neutral
      const forbidden = (h >= 195 && h <= 250) || (h >= 95 && h <= 170) || (h >= 30 && h <= 55) || h >= 352 || h <= 8;
      expect(forbidden, `${hue.id} at ${h}`).toBe(false);
    }
  });

  it("maps ids to css variables, unknown to muted", () => {
    expect(hueColor("violet")).toBe("hsl(var(--hue-violet))");
    expect(hueColor(null)).toContain("muted-foreground");
    expect(isWorkspaceHue("blue")).toBe(false);
  });
});
