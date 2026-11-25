/**
 * Pure maths for remembering a window's size and place. All numbers are
 * physical pixels (what Tauri reports); `scale` is the monitor's DPI factor at
 * the time of saving, so the size can be kept in logical pixels when the
 * window comes back on a monitor with another scale.
 */

export interface WindowPlacement {
  /** Outer top-left, physical. */
  x: number;
  y: number;
  /** Inner (content) size, physical. */
  w: number;
  h: number;
  scale: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A monitor's usable area (taskbar excluded), physical, with its DPI factor. */
export interface WorkArea extends Rect {
  scale: number;
}

export interface PlacementOptions {
  /** Smallest window, logical px. */
  minW: number;
  minH: number;
  /** Frame around the content (title bar, borders), logical px. 0 for undecorated windows. */
  chromeW?: number;
  chromeH?: number;
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** What came back from disk, or null when it is not a usable placement. */
export function sanitizePlacement(v: unknown): WindowPlacement | null {
  if (typeof v !== "object" || v === null) return null;
  const p = v as Record<string, unknown>;
  if (!finite(p.x) || !finite(p.y) || !finite(p.w) || !finite(p.h) || !finite(p.scale)) return null;
  if (p.w < 100 || p.h < 100 || p.scale <= 0 || p.scale > 8) return null;
  if (Math.abs(p.x) > 100000 || Math.abs(p.y) > 100000 || p.w > 100000 || p.h > 100000) return null;
  return { x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.w), h: Math.round(p.h), scale: p.scale };
}

/**
 * The placement to save from what the window reports, or null when it should
 * not be saved (Windows parks a minimised window at about -32000, -32000).
 */
export function snapshotPlacement(
  pos: { x: number; y: number },
  size: { w: number; h: number },
  scale: number,
): WindowPlacement | null {
  if (pos.x <= -30000 || pos.y <= -30000) return null;
  return sanitizePlacement({ x: pos.x, y: pos.y, w: size.w, h: size.h, scale });
}

export function samePlacement(a: WindowPlacement | null, b: WindowPlacement | null): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && a.scale === b.scale;
}

function overlap(a: Rect, b: Rect): { w: number; h: number; area: number } {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? { w, h, area: w * h } : { w: 0, h: 0, area: 0 };
}

/** The monitor the rect mostly sits on, if enough of it can still be seen and grabbed. */
export function pickArea(areas: WorkArea[], rect: Rect): WorkArea | null {
  let best: WorkArea | null = null;
  let bestArea = 0;
  for (const a of areas) {
    const o = overlap(rect, a);
    // Enough of the window must be on the monitor to find and drag it.
    if (o.w < 120 || o.h < 48) continue;
    if (o.area > bestArea) {
      best = a;
      bestArea = o.area;
    }
  }
  return best;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), Math.max(lo, hi));

function centered(area: WorkArea, w: number, h: number, chromeW: number, chromeH: number): Rect {
  return {
    x: Math.round(area.x + (area.w - w - chromeW) / 2),
    y: Math.round(area.y + (area.h - h - chromeH) / 2),
    w,
    h,
  };
}

function fitSize(
  lw: number,
  lh: number,
  area: WorkArea,
  o: PlacementOptions,
): { w: number; h: number; chromeW: number; chromeH: number } {
  const chromeW = Math.round((o.chromeW ?? 0) * area.scale);
  const chromeH = Math.round((o.chromeH ?? 0) * area.scale);
  const minW = Math.round(o.minW * area.scale);
  const minH = Math.round(o.minH * area.scale);
  // Never bigger than the usable area, even when that is below the minimum.
  const w = Math.round(clamp(lw * area.scale, Math.min(minW, area.w - chromeW), area.w - chromeW));
  const h = Math.round(clamp(lh * area.scale, Math.min(minH, area.h - chromeH), area.h - chromeH));
  return { w, h, chromeW, chromeH };
}

/**
 * Where to put a window that was saved as `saved`: on the monitor it was on
 * (size kept in logical pixels, moved inside that monitor's work area), or, when
 * its monitor is gone or it was off-screen, centred on `fallback`. Null when no
 * monitor is known (leave the window alone).
 */
export function resolvePlacement(
  saved: WindowPlacement,
  areas: WorkArea[],
  fallback: WorkArea | null,
  o: PlacementOptions,
): Rect | null {
  const home = pickArea(areas, { x: saved.x, y: saved.y, w: saved.w, h: saved.h });
  const area = home ?? fallback ?? areas[0] ?? null;
  if (!area) return null;
  const lw = saved.w / saved.scale;
  const lh = saved.h / saved.scale;
  const { w, h, chromeW, chromeH } = fitSize(lw, lh, area, o);
  if (!home) return centered(area, w, h, chromeW, chromeH);
  return {
    x: Math.round(clamp(saved.x, area.x, area.x + area.w - w - chromeW)),
    y: Math.round(clamp(saved.y, area.y, area.y + area.h - h - chromeH)),
    w,
    h,
  };
}

/** The launcher's first size: min(1180x740, 92% of the work area), centred. */
export function defaultLauncherRect(area: WorkArea, o: PlacementOptions): Rect {
  const lw = Math.min(1180, (area.w * 0.92) / area.scale);
  const lh = Math.min(740, (area.h * 0.92) / area.scale);
  const { w, h, chromeW, chromeH } = fitSize(lw, lh, area, o);
  return centered(area, w, h, chromeW, chromeH);
}

/** Shape of what `availableMonitors()` returns, reduced to what is used here. */
export interface MonitorLike {
  scaleFactor: number;
  position: { x: number; y: number };
  size: { width: number; height: number };
  workArea?: { position: { x: number; y: number }; size: { width: number; height: number } };
}

export function areaOf(m: MonitorLike): WorkArea {
  const wa = m.workArea ?? { position: m.position, size: m.size };
  return { x: wa.position.x, y: wa.position.y, w: wa.size.width, h: wa.size.height, scale: m.scaleFactor || 1 };
}
