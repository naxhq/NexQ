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

/**
 * The least change that guarantees the ratios at window opacity `opacity` (0 to 1).
 * Muted text and icons are the hard case, so they set the result.
 */
export function backingFor(c: ThemeColours, opacity: number, textRatio = TEXT_RATIO): Backing {
  const a0 = Math.min(1, Math.max(0, opacity));
  const mutedAt = (t: number) => mix(c.mutedForeground, c.foreground, t);
  const ok = (alpha: number, t: number) =>
    worstContrast(mutedAt(t), c.background, alpha) >= textRatio &&
    worstContrast(c.foreground, c.background, alpha) >= textRatio &&
    (c.accents ?? []).every((a) => worstContrast(a, c.background, alpha) >= textRatio);
  // 1. stronger muted text only
  for (let t = 0; t <= 1.0001; t += 0.05) if (ok(a0, t)) return { alpha: a0, muted: t, mutedRgb: mutedAt(t) };
  // 2. the foreground colour itself needs more backing: the smallest that makes everything read
  for (let a = a0; a <= 1.0001; a += 0.01) {
    const alpha = Math.min(1, a);
    for (let t = 0; t <= 1.0001; t += 0.05) if (ok(alpha, t)) return { alpha, muted: t, mutedRgb: mutedAt(t) };
  }
  return { alpha: 1, muted: 0, mutedRgb: c.mutedForeground };
}

/** Panel surface alpha so window + surface reach `total` (never below the base surface alpha). */
export function surfaceAlphaFor(windowAlpha: number, total: number, base = 0.2): number {
  if (total <= windowAlpha) return base;
  return Math.min(0.95, Math.max(base, 1 - (1 - total) / (1 - Math.min(0.999, windowAlpha))));
}

/** The theme's colours as the page has them now (the CSS variables on the root element). */
export function readThemeColours(accents?: Rgb[]): ThemeColours {
  const cs = getComputedStyle(document.documentElement);
  const get = (n: string) => hslVarToRgb(cs.getPropertyValue(n));
  return { background: get("--background"), foreground: get("--foreground"), mutedForeground: get("--muted-foreground"), accents };
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
