// The two note tints (people, places) must read on the page and card in both
// themes (WCAG AA, 4.5:1) and stay apart for the common colour-vision types.
// @ts-ignore node typings are not part of the app's tsconfig
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");
const css = read("./liveNotes.css");
const index = read("../index.css");


function hsl(token: string): [number, number, number] {
  const [h, s, l] = token.trim().replace(/%/g, "").split(/\s+/).map(Number);
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]: number[]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
function contrast(a: number[], b: number[]) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function token(source: string, block: RegExp, name: string): string {
  const m = block.exec(source);
  const v = new RegExp(`${name}:\\s*([^;]+);`).exec(m?.[1] ?? "");
  if (!v) throw new Error(`missing ${name}`);
  return v[1];
}

const light = {
  person: hsl(token(css, /:root\s*\{([^}]*)\}/, "--ln-person")),
  place: hsl(token(css, /:root\s*\{([^}]*)\}/, "--ln-place")),
  page: hsl(token(index, /:root\s*\{([^}]*)\}/, "--background")),
  card: hsl(token(index, /:root\s*\{([^}]*)\}/, "--card")),
};
const dark = {
  person: hsl(token(css, /\.dark\s*\{([^}]*)\}/, "--ln-person")),
  place: hsl(token(css, /\.dark\s*\{([^}]*)\}/, "--ln-place")),
  page: hsl(token(index, /\.dark\s*\{([^}]*)\}/, "--background")),
  card: hsl(token(index, /\.dark\s*\{([^}]*)\}/, "--card")),
};

// Machado et al. 2009, severity 1.0, applied in linear RGB.
const SIM: Record<string, number[][]> = {
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};
function simulate(rgb: number[], m: number[][]): number[] {
  const l = rgb.map(lin);
  return m.map((row) => Math.min(1, Math.max(0, row[0] * l[0] + row[1] * l[1] + row[2] * l[2])));
}
function lab(linRgb: number[]): number[] {
  const [r, g, b] = linRgb;
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
const dE = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe.each([
  ["light", light],
  ["dark", dark],
])("note tints in the %s theme", (_name, t) => {
  it("reach AA contrast on the page and on the card", () => {
    for (const bg of [t.page, t.card]) {
      expect(contrast(t.person, bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.place, bg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(Object.keys(SIM))("stay distinguishable with %s", (type) => {
    const p = lab(simulate(t.person, SIM[type]));
    const l = lab(simulate(t.place, SIM[type]));
    expect(dE(p, l)).toBeGreaterThan(18);
  });
});
