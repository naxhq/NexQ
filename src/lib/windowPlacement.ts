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
  /** The monitor itself (taskbar included): what tells one monitor setup from another. */
  mon?: Rect;
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
  return {
    x: wa.position.x,
    y: wa.position.y,
    w: wa.size.width,
    h: wa.size.height,
    scale: m.scaleFactor || 1,
    mon: { x: m.position.x, y: m.position.y, w: m.size.width, h: m.size.height },
  };
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

const keyPart = (r: Rect, scale: number) => `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.w)}x${Math.round(r.h)}@${Math.round(scale * 100) / 100}`;

/**
 * A stable name for a set of monitors: each monitor's bounds and scale (physical), in a fixed order, so
 * plug order does not matter. The taskbar, a docked bar or the captions bar change a work area, never this.
 */
export function setupKey(areas: WorkArea[]): string {
  return areas
    .map((a) => keyPart(a.mon ?? a, a.scale))
    .sort()
    .join("|");
}

/** The key earlier dev builds saved (work areas instead of monitor bounds); still matched, then replaced. */
export function legacySetupKey(areas: WorkArea[]): string {
  return areas
    .map((a) => keyPart(a, a.scale))
    .sort()
    .join("|");
}

/** Whether a saved entry belongs to the monitors connected now (by the current or the older key). */
export function entryMatches(e: SetupEntry, areas: WorkArea[]): boolean {
  return e.key === setupKey(areas) || e.key === legacySetupKey(areas);
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

/**
 * The same relative spot, and the same size in logical pixels, on another monitor: what a window that
 * was on `from` gets when it has to go to `to`. Not yet clamped; `resolvePlacement` does that.
 */
export function carryOver(p: WindowPlacement, from: Rect, to: WorkArea): WindowPlacement {
  const fx = (p.x - from.x) / from.w;
  const fy = (p.y - from.y) / from.h;
  return {
    x: Math.round(to.x + clamp(fx, 0, 1) * to.w),
    y: Math.round(to.y + clamp(fy, 0, 1) * to.h),
    w: Math.round((p.w / p.scale) * to.scale),
    h: Math.round((p.h / p.scale) * to.scale),
    scale: to.scale,
  };
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
  const fallback = current ?? primary ?? areas[0];
  const exact = entries.find((e) => entryMatches(e, areas));
  if (exact) {
    const rect = resolvePlacement(exact.placement, areas, fallback, o);
    return rect ? { rect, maximized: !!exact.placement.maximized, known: true } : null;
  }
  const newest = entries[0];
  if (newest && newest.area) {
    const home = primary ?? areas[0];
    const p = newest.placement;
    const rect = resolvePlacement(carryOver(p, newest.area, home), areas, home, o);
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

/** The window as it was before the monitors changed: where it sat, and the monitors it sat among. */
export interface ChangeContext {
  /** The monitors connected before the change. */
  areas: WorkArea[];
  /** The last place the user left the window at (not maximised). */
  placement: WindowPlacement;
}

/**
 * Whether the monitor `old` is still connected: some monitor sits at the same corner of the desktop. A
 * resolution or scale change on a monitor that stays put does not make it "gone"; two identical monitors
 * are told apart by where they are.
 */
export function monitorSurvives(old: WorkArea, areas: WorkArea[]): boolean {
  const om = old.mon ?? old;
  return areas.some((a) => {
    const m = a.mon ?? a;
    return Math.abs(m.x - om.x) <= 2 && Math.abs(m.y - om.y) <= 2;
  });
}

/** The monitor the window was on before the change, when it is no longer connected. */
export function lostHome(before: ChangeContext | null | undefined, areas: WorkArea[]): WorkArea | null {
  if (!before) return null;
  const home = pickArea(before.areas, before.placement);
  return home && !monitorSurvives(home, areas) ? home : null;
}

/**
 * What to do with a window that is on screen when the monitors change. A setup with a saved place: go
 * there (so the window returns to a monitor that comes back). The monitor it sat on is gone and the setup
 * is new: the primary monitor, the same relative spot and logical size, inside its work area. Anything
 * else (a monitor added, a work area or scale tweak): stay where it is, and only when its title bar could
 * no longer be reached, bring it back inside a screen. Null means leave it alone.
 * Nothing here is saved: the saved places of the other setups are never touched.
 */
export function planOnChange(
  entries: SetupEntry[],
  areas: WorkArea[],
  window: Rect,
  primary: WorkArea | null,
  o: PlacementOptions,
  before?: ChangeContext | null,
): RestorePlan | null {
  if (areas.length === 0) return null;
  const exact = entries.find((e) => entryMatches(e, areas));
  const fallback = primary ?? areas[0];
  if (exact) {
    const rect = resolvePlacement(exact.placement, areas, fallback, o);
    return rect ? { rect, maximized: !!exact.placement.maximized, known: true } : null;
  }
  const lost = lostHome(before, areas);
  if (lost && before) {
    const rect = resolvePlacement(carryOver(before.placement, lost, fallback), areas, fallback, o);
    return rect ? { rect, maximized: false, known: false } : null;
  }
  // Reachable: enough of the window is on a screen to find and drag it.
  if (pickArea(areas, window)) return null;
  const rect = resolvePlacement(
    { x: window.x, y: window.y, w: window.w, h: window.h, scale: fallback.scale },
    areas,
    fallback,
    o,
  );
  return rect ? { rect, maximized: false, known: false } : null;
}
