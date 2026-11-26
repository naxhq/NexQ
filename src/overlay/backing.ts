/**
 * The meeting window is see-through. What is behind it is unknown (a white page, a black one, a busy
 * photo), so text and icons on the window's own colour must be readable against the worst of them.
 * This works that out from the theme's real colours:
 *
 *  - the window's composite background is `alpha * theme background + (1 - alpha) * whatever is behind`,
 *    and "whatever is behind" is any grey from black to white (the worst grey for a given colour is the
 *    one with the same luminance, so a grid of greys finds it);
 *  - text must reach 4.5:1 and icons 3:1 in that worst case, at every transparency step;
 *  - to get there it first makes the muted colour stronger (a step toward the foreground colour), and
 *    only when the foreground colour itself would not read adds backing behind the chrome.
 *
 * At 100% nothing changes (the colours already read on the solid window).
 */

export type Rgb = [number, number, number];

/** "222 47% 6%" (a CSS variable's value) to rgb. */
export function hslVarToRgb(v: string): Rgb {
  const m = v.trim().match(/^(-?[\d.]+)\s+([\d.]+)%\s+([\d.]+)%/);
  if (!m) return [0, 0, 0];
  const h = ((parseFloat(m[1]) % 360) + 360) % 360;
  const s = parseFloat(m[2]) / 100;
  const l = parseFloat(m[3]) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const k = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + k) * 255), Math.round((g + k) * 255), Math.round((b + k) * 255)];
}

const lum = ([r, g, b]: Rgb) => {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};

export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)) as Rgb;

/** The window colour over a grey `behind` (0 to 255) at `alpha`. */
const over = (bg: Rgb, alpha: number, behind: number): Rgb => mix([behind, behind, behind], bg, alpha);

/** The lowest contrast of `text` on the window over any grey behind it. */
export function worstContrast(text: Rgb, bg: Rgb, alpha: number): number {
  let worst = Infinity;
  for (let g = 0; g <= 255; g += 5) worst = Math.min(worst, contrast(text, over(bg, alpha, g)));
  return worst;
}

export interface ThemeColours {
  background: Rgb;
  foreground: Rgb;
  mutedForeground: Rgb;
  /** Other text colours in the header and status bar (End, labels, badges) that must read too. */
  accents?: Rgb[];
}

export interface Backing {
  /** Alpha of the window's own colour behind header, status bar and surfaces: never below the user's opacity. */
  alpha: number;
  /** 0 = the theme's muted colour, 1 = the foreground colour. */
  muted: number;
  /** The muted colour to use (`--muted-foreground`). */
  mutedRgb: Rgb;
}

export const TEXT_RATIO = 4.5;
export const ICON_RATIO = 3;
const TRANSPARENT_MARGIN = 1.0;

/**
 * The least change that guarantees the ratios at window opacity `opacity` (0 to 1).
 * Muted text and icons are the hard case, so they set the result.
 */
export function backingFor(c: ThemeColours, opacity: number, textRatio = TEXT_RATIO): Backing {
  const a0 = Math.min(1, Math.max(0, opacity));
  // Chips tint their own background (bg-white/5), so see-through windows aim a little above the minimum.
  const target = a0 < 1 ? textRatio + TRANSPARENT_MARGIN : textRatio;
  const mutedAt = (t: number) => mix(c.mutedForeground, c.foreground, t);
  const ok = (alpha: number, t: number) =>
    worstContrast(mutedAt(t), c.background, alpha) >= target &&
    worstContrast(c.foreground, c.background, alpha) >= target &&
    (c.accents ?? []).every((a) => worstContrast(a, c.background, alpha) >= target);
  // 1. stronger muted text only
  for (let t = 0; t <= 1.0001; t += 0.05) if (ok(a0, t)) return { alpha: a0, muted: t, mutedRgb: mutedAt(t) };
  // 2. the foreground colour itself needs more backing: the smallest that makes everything read
  for (let a = a0; a <= 1.0001; a += 0.01) {
    const alpha = Math.min(1, a);
    for (let t = 0; t <= 1.0001; t += 0.05) if (ok(alpha, t)) return { alpha, muted: t, mutedRgb: mutedAt(t) };
  }
  return { alpha: 1, muted: 0, mutedRgb: c.mutedForeground };
}

/**
 * Panel surface alpha so window + surface reach `total` (never below the base surface alpha).
 */
export function surfaceAlphaFor(windowAlpha: number, total: number, base = 0.2): number {
  if (total <= windowAlpha) return base;
  return Math.min(0.95, Math.max(base, 1 - (1 - total) / (1 - Math.min(0.999, windowAlpha))));
}

/** The theme's colours as the page has them now (the CSS variables on the root element). */
export const ACCENT_TOKENS = [
  "--primary-text",
  "--destructive-text",
  "--success-text",
  "--warning-text",
  "--info-text",
  "--speaker-user-text",
  "--speaker-interviewer-text",
  // Live notes entity colours (liveNotes.css): panels that show them get the same guaranteed surface.
  "--ln-person",
  "--ln-place",
] as const;

export function readThemeColours(): ThemeColours {
  const cs = getComputedStyle(document.documentElement);
  const get = (n: string) => hslVarToRgb(cs.getPropertyValue(n));
  return {
    background: get("--background"),
    foreground: get("--foreground"),
    mutedForeground: get("--muted-foreground"),
    // The coloured text of the chrome (End, badges, labels) comes from the theme's -text tokens.
    accents: ACCENT_TOKENS.filter((n) => cs.getPropertyValue(n).trim()).map(get),
  };
}

/** rgb to the "H S% L%" form of the theme's CSS variables. */
export function rgbToHslVar([r, g, b]: Rgb): string {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
    h *= 60;
  }
  return `${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}


// ─────────────────────────────────────────────────────────────────────────────────────────
// The transparency levels of the meeting window.
//
// A level is how much of the window you can NOT see through. It sets the alpha of the window's own
// colour AND of the panel surfaces on top of it, so lowering it really shows what is behind, panels
// included. Text and icons are kept readable by a halo of the window colour right behind the glyphs
// (a text-shadow / drop-shadow, no solid box), sized by the contrast maths above.
// ─────────────────────────────────────────────────────────────────────────────────────────

/** What the eye button cycles through, most solid first. */
export const OPACITY_LEVELS = [1, 0.85, 0.65, 0.45, 0.3] as const;
/** Panels sit at about 82 to 85% by default. */
export const DEFAULT_OVERLAY_OPACITY = 0.85;
/** The window's own colour is this share of the level; the panel surfaces make up the rest. */
const WINDOW_SHARE = 0.75;
/** The surface alpha of a panel that is not for reading (a quiet card), as before. */
const QUIET_SURFACE = 0.2;
/** The most a halo may cover: past it the window would be a solid box again. */
export const MAX_HALO = 0.97;

/** The index in OPACITY_LEVELS closest to `opacity` (a saved value from a slider or an older preset). */
export function levelIndex(opacity: number): number {
  let best = 0;
  OPACITY_LEVELS.forEach((l, i) => {
    if (Math.abs(l - opacity) < Math.abs(OPACITY_LEVELS[best] - opacity)) best = i;
  });
  return best;
}

/** The level one click after `opacity`, wrapping from the most see-through back to solid. */
export function nextOpacityLevel(opacity: number): number {
  return OPACITY_LEVELS[(levelIndex(opacity) + 1) % OPACITY_LEVELS.length];
}

export interface OverlayAlphas {
  /** Alpha of the window's own colour (what shows between and around the panels). */
  window: number;
  /** Window and a reading panel together, as seen: the level itself. */
  reading: number;
  /** Alpha of a reading panel's own surface. */
  readingSurface: number;
  /** Alpha of any other panel's surface. */
  quietSurface: number;
}

export function overlayAlphas(level: number): OverlayAlphas {
  const l = Math.min(1, Math.max(0, level));
  if (l >= 1) return { window: 1, reading: 1, readingSurface: QUIET_SURFACE, quietSurface: QUIET_SURFACE };
  const window = l * WINDOW_SHARE;
  const readingSurface = surfaceAlphaFor(window, l, 0);
  return { window, reading: l, readingSurface, quietSurface: Math.min(QUIET_SURFACE, readingSurface) };
}

/** Alpha of two layers stacked. */
export const stack = (a: number, b: number) => 1 - (1 - a) * (1 - b);

/** The halo coverage that lifts a local alpha of `base` to `needed`. */
export function haloCoverage(base: number, needed: number): number {
  if (needed <= base + 1e-9) return 0;
  return Math.min(MAX_HALO, 1 - (1 - needed) / (1 - Math.min(0.999, base)));
}

export interface Transparency {
  alphas: OverlayAlphas;
  /** The muted colour to use (strengthened where the theme's own would not read). */
  muted: number;
  mutedRgb: Rgb;
  /** Halo coverage behind text and icons on the bare window (header, footer, quiet panels). */
  chromeHalo: number;
  /** Halo coverage behind text and icons on a reading panel. */
  readingHalo: number;
  /** The alpha a glyph actually sits on, worst case, in each place (window or panel, plus its halo). */
  chromeLocal: number;
  readingLocal: number;
}

/** Everything the meeting window needs at `level` so it is see-through and still reads over any background. */
export function transparencyFor(c: ThemeColours, level: number): Transparency {
  const alphas = overlayAlphas(level);
  // The bare window under the header and footer: the least backing anywhere.
  const chrome = backingFor(c, alphas.window);
  // Text uses one muted colour everywhere, so the strongest requirement (the bare window's) sets it.
  const mutedRgb = chrome.mutedRgb;
  const chromeHalo = haloCoverage(alphas.window, chrome.alpha);
  // A reading panel starts from window + surface, which is the level itself.
  const reading = backingFor({ ...c, mutedForeground: mutedRgb }, alphas.reading);
  const readingHalo = haloCoverage(alphas.reading, reading.alpha);
  return {
    alphas,
    muted: chrome.muted,
    mutedRgb,
    chromeHalo,
    readingHalo,
    chromeLocal: stack(alphas.window, chromeHalo),
    readingLocal: stack(alphas.reading, readingHalo),
  };
}

/**
 * The offsets (px) of the halo's layers: a ring one pixel out and a ring two out. Each layer is the window
 * colour at the full `coverage` alpha, so every pixel within about two pixels of a glyph sits on at least
 * that much backing (a blurred shadow would thin out to a fraction of it next to a hairline stroke).
 */
const HALO_RING: [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
  [2, 0], [-2, 0], [0, 2], [0, -2], [1.5, 1.5], [1.5, -1.5], [-1.5, 1.5], [-1.5, -1.5],
];

const haloColour = (coverage: number) => `hsl(var(--background) / ${Math.min(MAX_HALO, coverage).toFixed(3)})`;

/** `text-shadow` that backs glyphs with the window colour; "none" when no halo is needed. */
export function haloTextShadow(coverage: number): string {
  if (coverage < 0.01) return "none";
  const col = haloColour(coverage);
  return [...HALO_RING.map(([x, y]) => `${x}px ${y}px 0 ${col}`), `0 0 3px ${col}`].join(", ");
}

/** The same for icons (an svg ignores text-shadow). */
export function haloIconFilter(coverage: number): string {
  if (coverage < 0.01) return "none";
  const col = haloColour(coverage);
  return [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([x, y]) => `drop-shadow(${x}px ${y}px 0 ${col})`).join(" ") + ` drop-shadow(0 0 3px ${col})`;
}

/** The CSS variables of the meeting window for a level (read by `.overlay-bg` in index.css and by dock.css). */
export function transparencyVars(t: Transparency): Record<string, string> {
  const vars: Record<string, string> = {
    "--nq-halo-text": haloTextShadow(t.chromeHalo),
    "--nq-halo-icon": haloIconFilter(t.chromeHalo),
    "--nq-halo-text-reading": haloTextShadow(t.readingHalo),
    "--nq-halo-icon-reading": haloIconFilter(t.readingHalo),
  };
  if (t.muted > 0) vars["--muted-foreground"] = rgbToHslVar(t.mutedRgb);
  return vars;
}
