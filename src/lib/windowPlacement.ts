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
  /** Was maximised when last seen. x, y, w and h then stay the un-maximised place behind it. */
  maximized?: boolean;
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
  const out: WindowPlacement = { x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.w), h: Math.round(p.h), scale: p.scale };
  if (p.maximized === true) out.maximized = true;
  return out;
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
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && a.scale === b.scale && !!a.maximized === !!b.maximized;
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

// == Monitor setups ==

/** How many monitor setups (docked, undocked, projector...) keep their own place per window. */
export const MAX_SETUPS = 6;

/** One remembered place, for one set of connected monitors. */
export interface SetupEntry {
  /** `setupKey` of the monitors that were connected. */
  key: string;
  placement: WindowPlacement;
  /** The work area the window was on, so an unknown setup can get "the same relative place". */
  area: WorkArea | null;
  /** When it was saved (ms), newest first in the list. */
  at: number;
}

/** A stable name for a set of monitors: work areas and scales, in a fixed order (plug order does not matter). */
export function setupKey(areas: WorkArea[]): string {
  return areas
    .map((a) => `${Math.round(a.x)},${Math.round(a.y)},${Math.round(a.w)}x${Math.round(a.h)}@${Math.round(a.scale * 100) / 100}`)
    .sort()
    .join("|");
}

function sanitizeArea(v: unknown): WorkArea | null {
  if (typeof v !== "object" || v === null) return null;
  const a = v as Record<string, unknown>;
  if (!finite(a.x) || !finite(a.y) || !finite(a.w) || !finite(a.h) || !finite(a.scale)) return null;
  if (a.w < 100 || a.h < 100 || a.scale <= 0 || a.scale > 8) return null;
  return { x: a.x, y: a.y, w: a.w, h: a.h, scale: a.scale };
}

/** What came back from disk: only well-formed entries, newest first, at most `MAX_SETUPS`. */
export function sanitizeSetups(v: unknown): SetupEntry[] {
  if (!Array.isArray(v)) return [];
  const out: SetupEntry[] = [];
  for (const raw of v) {
    if (typeof raw !== "object" || raw === null) continue;
    const e = raw as Record<string, unknown>;
    const placement = sanitizePlacement(e.placement);
    if (typeof e.key !== "string" || !e.key || !placement) continue;
    if (out.some((o) => o.key === e.key)) continue;
    out.push({ key: e.key, placement, area: sanitizeArea(e.area), at: finite(e.at) ? e.at : 0 });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, MAX_SETUPS);
}

/** The list with this entry first; an older entry for the same setup is replaced, the oldest setups drop off. */
export function rememberSetup(entries: SetupEntry[], entry: SetupEntry): SetupEntry[] {
  return [entry, ...entries.filter((e) => e.key !== entry.key)].slice(0, MAX_SETUPS);
}

export interface RestorePlan {
  rect: Rect;
  maximized: boolean;
  /** True when this exact setup was seen before; false when the place is a best guess. */
  known: boolean;
}

/**
 * Where a window goes for the monitors connected now. Same setup as before: its own saved place.
 * New setup: the newest saved place carried over (same relative spot on the primary monitor, same size
 * in logical pixels), or the old single placement of v2.45 and earlier. Always inside a work area.
 * Null when there is nothing saved (the window stays where it opened) or no monitor is known.
 */
export function planRestore(
  entries: SetupEntry[],
  legacy: WindowPlacement | null,
  areas: WorkArea[],
  primary: WorkArea | null,
  current: WorkArea | null,
  o: PlacementOptions,
): RestorePlan | null {
  if (areas.length === 0) return null;
  const key = setupKey(areas);
  const fallback = current ?? primary ?? areas[0];
  const exact = entries.find((e) => e.key === key);
  if (exact) {
    const rect = resolvePlacement(exact.placement, areas, fallback, o);
    return rect ? { rect, maximized: !!exact.placement.maximized, known: true } : null;
  }
  const newest = entries[0];
  if (newest && newest.area) {
    const home = primary ?? areas[0];
    const p = newest.placement;
    const fx = (p.x - newest.area.x) / newest.area.w;
    const fy = (p.y - newest.area.y) / newest.area.h;
    const lw = p.w / p.scale;
    const lh = p.h / p.scale;
    const guess: WindowPlacement = {
      x: Math.round(home.x + clamp(fx, 0, 1) * home.w),
      y: Math.round(home.y + clamp(fy, 0, 1) * home.h),
      w: Math.round(lw * home.scale),
      h: Math.round(lh * home.scale),
      scale: home.scale,
    };
    const rect = resolvePlacement(guess, areas, home, o);
    return rect ? { rect, maximized: !!p.maximized, known: false } : null;
  }
  const old = newest?.placement ?? legacy;
  if (!old) return null;
  const rect = resolvePlacement(old, areas, fallback, o);
  return rect ? { rect, maximized: !!old.maximized, known: false } : null;
}

/** A window as far as moving it goes (the Tauri window, or a fake in tests). All physical pixels. */
export interface MovableWindow {
  setPosition(x: number, y: number): Promise<void>;
  setSize(w: number, h: number): Promise<void>;
  outerPosition(): Promise<{ x: number; y: number }>;
  innerSize(): Promise<{ w: number; h: number }>;
}

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

/**
 * Put a window at `rect`: position first, then size, so a move to a monitor with another scale has
 * already been rescaled (WM_DPICHANGED) before the size is set. Reads it back and corrects once.
 * Returns whether it ended up where asked (a minimum size can legitimately differ).
 */
export async function applyRect(win: MovableWindow, rect: Rect, tolerance = 2): Promise<boolean> {
  const attempt = async () => {
    await win.setPosition(rect.x, rect.y);
    await win.setSize(rect.w, rect.h);
    const [pos, size] = await Promise.all([win.outerPosition(), win.innerSize()]);
    return near(pos.x, rect.x, tolerance) && near(pos.y, rect.y, tolerance) && near(size.w, rect.w, tolerance) && near(size.h, rect.h, tolerance);
  };
  if (await attempt()) return true;
  return attempt();
}
