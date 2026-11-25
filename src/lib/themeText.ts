import { useSyncExternalStore } from "react";

/**
 * The default transcript and answer text colours are light greys picked for the dark theme.
 * A user who never changed them gets the theme's own text colour, so the light theme is readable;
 * a colour the user picked is used as chosen.
 */
const THEME_BOUND_DEFAULTS = new Set(["#e4e4e7", "#d4d4d8"]);

export function readingTextColor(color: string): string {
  return THEME_BOUND_DEFAULTS.has(color.trim().toLowerCase()) ? "hsl(var(--foreground))" : color;
}

/* ---- readable colours: a colour picked for one theme (speaker tags, translation) must still read in the other ---- */


type Rgb = [number, number, number];

function parseColor(c: string): Rgb | null {
  const hex = c.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!hex) return null;
  const h = hex[1].length === 3 ? hex[1].split("").map((x) => x + x).join("") : hex[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const lum = ([r, g, b]: Rgb) => {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};

export function contrastRatio(a: Rgb, b: Rgb): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

function toHsl([r, g, b]: Rgb): [number, number, number] {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [h * 60, s, l];
}

function fromHsl(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

const hex = ([r, g, b]: Rgb) => "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");

/** The meeting window's text backgrounds, close enough for a contrast target. */
const SURFACE: Record<"light" | "dark", Rgb> = { light: [250, 251, 252], dark: [16, 20, 32] };

/**
 * `color` itself when it reads at 4.5:1 on the theme's surface, else the same hue made
 * darker (light theme) or lighter (dark theme) until it does. Not a hex colour: returned as is.
 */
const readableCache = new Map<string, string>();

export function readableOn(color: string, mode: "light" | "dark", target = 4.6): string {
  const key = `${color}|${mode}|${target}`;
  const hit = readableCache.get(key);
  if (hit !== undefined) return hit;
  const out = computeReadableOn(color, mode, target);
  if (readableCache.size > 500) readableCache.clear();
  readableCache.set(key, out);
  return out;
}

function computeReadableOn(color: string, mode: "light" | "dark", target: number): string {
  const rgb = parseColor(color);
  if (!rgb) return color;
  const bg = SURFACE[mode];
  if (contrastRatio(rgb, bg) >= target) return color;
  const [h, s, l0] = toHsl(rgb);
  const step = mode === "light" ? -0.02 : 0.02;
  for (let l = l0; l >= 0 && l <= 1; l += step) {
    const c = fromHsl(h, s, l);
    if (contrastRatio(c, bg) >= target) return hex(c);
  }
  return mode === "light" ? "#000000" : "#ffffff";
}

const isLightNow = () => typeof document !== "undefined" && document.documentElement.classList.contains("light");
// One observer for every component that asks, so a 1,000-line transcript costs one subscription, not 1,000.
const themeListeners = new Set<() => void>();
let themeObserver: MutationObserver | null = null;
const subscribeTheme = (notify: () => void) => {
  if (typeof MutationObserver === "undefined" || typeof document === "undefined") return () => {};
  themeListeners.add(notify);
  if (!themeObserver) {
    themeObserver = new MutationObserver(() => themeListeners.forEach((l) => l()));
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  }
  return () => {
    themeListeners.delete(notify);
    if (themeListeners.size === 0) {
      themeObserver?.disconnect();
      themeObserver = null;
    }
  };
};

/**
 * Whether the document is in the light theme (follows theme changes in any window). Read with
 * useSyncExternalStore: the first render already has the right answer, so a row never renders twice for it.
 */
export function useIsLight(): boolean {
  return useSyncExternalStore(subscribeTheme, isLightNow, () => false);
}
