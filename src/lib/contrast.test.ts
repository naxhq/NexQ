import { describe, expect, it } from "vitest";
import indexCss from "../index.css?raw";

/*
 * Colour guard. index.css is parsed (nothing is copied here), so a token edit that makes text hard to read fails
 * this test in the same commit. A second part scans the source for hard-coded low-contrast text colours.
 */

type Rgb = [number, number, number];
const css = indexCss.replace(/\r\n/g, "\n");

function block(selector: string): Record<string, string> {
  // the first `selector { ... }` that defines --background (the theme blocks in @layer base)
  const re = new RegExp(`${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    if (!m[1].includes("--background")) continue;
    const out: Record<string, string> = {};
    for (const d of m[1].matchAll(/--([a-z-]+):\s*([^;]+);/g)) out[d[1]] = d[2].trim();
    return out;
  }
  throw new Error(`no theme block for ${selector}`);
}

function hsl(triplet: string): Rgb {
  const [h, s, l] = triplet.replace(/%/g, "").split(/\s+/).map(Number);
  const sat = s / 100;
  const lig = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}
const lum = ([r, g, b]: Rgb) => {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a: Rgb, b: Rgb) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const mix = (fg: Rgb, bg: Rgb, a: number): Rgb => [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a)) as Rgb;

const THEMES = { light: block(":root"), dark: block(".dark") };
const SURFACES = ["background", "card", "popover", "secondary", "muted", "accent"];
const TEXT = ["foreground", "muted-foreground", "primary-text", "success-text", "warning-text", "info-text", "destructive-text", "highlight-text", "speaker-user-text", "speaker-interviewer-text", "violet-text", "rose-text"];
const FILLS: Array<[fill: string, on: string]> = [
  ["primary", "primary-foreground"],
  ["destructive", "destructive-foreground"],
  ["success", "success-foreground"],
  ["warning", "warning-foreground"],
  ["info", "info-foreground"],
  ["highlight", "highlight-foreground"],
];

describe.each(Object.entries(THEMES))("%s theme colour tokens", (_name, t) => {
  const c = (k: string) => {
    if (!t[k]) throw new Error(`missing token --${k}`);
    return hsl(t[k]);
  };

  it.each(TEXT)("--%s is text: 4.5:1 on every surface", (token) => {
    for (const s of SURFACES) expect(ratio(c(token), c(s)), `${token} on ${s}`).toBeGreaterThanOrEqual(4.5);
  });

  it.each(TEXT.filter((k) => k.endsWith("-text")))("--%s stays readable on its own 5, 10 and 20% tints", (token) => {
    for (const a of [0.05, 0.1, 0.2]) {
      for (const s of ["background", "card", "muted"]) {
        const bg = mix(c(token), c(s), a);
        expect(ratio(c(token), bg), `${token} on ${a} tint over ${s}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it.each(FILLS)("--%s with --%s is a readable label", (fill, on) => {
    expect(ratio(c(on), c(fill)), `${on} on ${fill}`).toBeGreaterThanOrEqual(4.5);
  });

  it("a field's edge (--input) reaches 3:1 on the page and on cards", () => {
    for (const s of ["background", "card", "popover"]) expect(ratio(c("input"), c(s)), `input on ${s}`).toBeGreaterThanOrEqual(3);
  });

  it("the focus ring reaches 3:1 on the page", () => {
    expect(ratio(c("ring"), c("background"))).toBeGreaterThanOrEqual(3);
  });

  it("surfaces keep a visible ladder (page, card, well, selected)", () => {
    const step = (a: string, b: string) => Math.abs(lum(c(a)) - lum(c(b)));
    if (_name === "light") {
      expect(step("background", "card")).toBeGreaterThan(0.025);
      expect(step("card", "accent")).toBeGreaterThan(0.025);
    }
    expect(step("background", "accent")).toBeGreaterThan(_name === "light" ? 0.02 : 0.008);
  });
});

describe("the semantic colours have a text token for every fill", () => {
  it("each -text token exists in both themes", () => {
    for (const [name, t] of Object.entries(THEMES)) {
      for (const k of TEXT.filter((x) => x.endsWith("-text"))) expect(t[k], `${name} --${k}`).toBeTruthy();
    }
  });
});

// ---- source scan -------------------------------------------------------------------------------------------

// Every source file of the app (not tests, not harnesses), as text.
const SOURCES = import.meta.glob(["/src/**/*.ts", "/src/**/*.tsx", "!/src/**/*.test.ts", "!/src/**/*.test.tsx", "!/src/contracts/**"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/**
 * Text colours that cannot be right in both themes. Palette colours (text-red-400, text-amber-500 ...) are fine:
 * tailwind.config.ts maps them to the theme's text tokens. Faded text (text-foreground/40, placeholder:text-x/50)
 * is fine too: it resolves to the muted token. What is left is a fixed grey, a translucent white or black, or an
 * arbitrary colour, which is the same on a light and a dark surface.
 */
const BAD: Array<[RegExp, string]> = [
  [/\b(?:text|placeholder:text|hover:text|group-hover:text)-(?:slate|gray|zinc|neutral|stone)-\d+/, "grey palette text"],
  [/\b(?:text|placeholder:text)-white\/\d+/, "translucent white text"],
  [/\b(?:text|placeholder:text)-black(?:\/\d+)?\b/, "black text"],
  [/\b(?:text|placeholder:text)-\[(?:#|hsl|rgb)/, "arbitrary text colour"],
];

/** Existing lines checked by hand (white on a dark scrim or a filled primary button). Do not add to this list to silence a new one. */
const ALLOWED: RegExp[] = [/AskImages\.tsx/];

describe("source scan: no new fixed low-contrast text colours", () => {
  const files = Object.keys(SOURCES);
  it("scans a plausible number of files", () => expect(files.length).toBeGreaterThan(200));
  it("finds none", () => {
    const found: string[] = [];
    for (const f of files) {
      const rel = f.replace(/^\/src\//, "");
      if (ALLOWED.some((a) => a.test(rel))) continue;
      SOURCES[f].split("\n").forEach((line, i) => {
        for (const [re, why] of BAD) if (re.test(line)) found.push(`${rel}:${i + 1} ${why}: ${line.trim().slice(0, 100)}`);
      });
    }
    expect(found).toEqual([]);
  });
});

describe("text-only controls keep hover feedback", () => {
  it("index.css lifts muted, foreground and primary hover text a step (both faded colours resolve to one token)", () => {
    expect(css).toContain('[class*=" hover:text-muted-foreground"]:hover');
    expect(css).toContain('[class*=" hover:text-foreground/"]:hover');
    expect(css).toContain("--primary-text-hover");
  });
  it("the hover text of every theme stays readable", () => {
    for (const [name, t] of Object.entries(THEMES)) {
      expect(t["primary-text-hover"], `${name} --primary-text-hover`).toBeTruthy();
      for (const s of ["background", "card", "secondary", "accent"]) {
        expect(ratio(hsl(t["primary-text-hover"]), hsl(t[s])), `${name} primary hover on ${s}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
