/**
 * Pure geometry: layout tree + container size -> absolute rects (integers) for stacks,
 * tab bars, bodies, separators, plus drop-zone hit testing.
 *
 * Collapse is per axis, not a fixed breakpoint. A split that cannot give every child its
 * preferred size along its own axis is tried along the other axis (like flex-wrap), and if
 * that does not fit either, its panels are merged into one virtual tab stack.
 */
import {
  type Dir,
  type DropTarget,
  type Layout,
  type LayoutNode,
  type PanelId,
  type SplitNode,
  type StackNode,
  type Zone,
  panelsOf,
} from "./layoutModel";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface PanelMeta {
  minW: number;
  minH: number;
  /** Width a column prefers; below it a row split wraps. Default max(minW, 220). */
  prefW?: number;
  prefH?: number;
}
export interface GeoOptions {
  gap: number;
  padX: number;
  padY: number;
  tabH: number;
  strip: number;
}
export const GEO_DEFAULTS: GeoOptions = { gap: 10, padX: 12, padY: 10, tabH: 30, strip: 28 };
export const DEFAULT_META: PanelMeta = { minW: 180, minH: 120 };
export const PREF_W = 220;
export const EDGE_BAND = 18;
export const SNAP_PX = 7;
export const MIN_BODY = 40;

type Axis = "x" | "y";

export interface StackGeo {
  id: string;
  rect: Rect;
  tabBar: Rect;
  body: Rect;
  panels: PanelId[];
  active: PanelId;
  /** Rendered as a thin strip (collapsed). */
  strip: boolean;
  /** Strip runs along this axis: a vertical strip is "x" thin. */
  stripThin: Axis | null;
  /** Merged tab stack standing in for a split that could not fit. */
  virtual: boolean;
}

export interface SepGeo {
  id: string;
  splitId: string;
  /** Between children `index` and `index + 1`. */
  index: number;
  /** The axis the boundary moves along ("x" = a vertical bar). */
  axis: Axis;
  /** Pointer hit area (the gap). */
  rect: Rect;
  /** Visible line, centred in the gap. */
  line: Rect;
  /** Boundary position (centre of the gap) along `axis`, container coordinates. */
  pos: number;
  /** Start and end of the parent split along `axis`. */
  span: [number, number];
  childPx: number[];
  childMin: number[];
  isStrip: boolean[];
  sizes: number[];
  /** 0..1 position of the boundary within the parent (for aria-valuenow). */
  fraction: number;
}

export interface Geometry {
  size: { w: number; h: number };
  inner: Rect;
  stacks: StackGeo[];
  separators: SepGeo[];
  /** Body rect and visibility of every docked panel. */
  panels: Record<PanelId, { stackId: string; rect: Rect; visible: boolean }>;
  /** True when some split fell back to a merged tab stack. */
  compact: boolean;
  opts: GeoOptions;
}

interface Ctx {
  metas: Record<PanelId, PanelMeta>;
  o: GeoOptions;
  focus?: PanelId;
  out: Geometry;
}

const meta = (ctx: Ctx, p: PanelId): PanelMeta => ctx.metas[p] ?? DEFAULT_META;

/** Size a node needs along `axis`. */
function req(n: LayoutNode, axis: Axis, kind: "min" | "pref", ctx: Ctx): number {
  if (n.kind === "stack") {
    if (n.collapsed) return ctx.o.strip;
    let m = 0;
    for (const p of n.panels) {
      const mt = meta(ctx, p);
      const v =
        axis === "x"
          ? kind === "pref"
            ? (mt.prefW ?? Math.max(mt.minW, PREF_W))
            : mt.minW
          : kind === "pref"
            ? (mt.prefH ?? mt.minH)
            : mt.minH;
      m = Math.max(m, v);
    }
    return axis === "y" ? m + ctx.o.tabH : m;
  }
  const along = (n.dir === "row") === (axis === "x");
  const vals = n.children.map((c) => req(c, axis, kind, ctx));
  return along
    ? vals.reduce((a, b) => a + b, 0) + ctx.o.gap * (n.children.length - 1)
    : Math.max(0, ...vals);
}

/** Divide `total` by weights, never below `mins` (water-filling). */
export function distribute(total: number, weights: number[], mins: number[]): number[] {
  const n = weights.length;
  if (!n) return [];
  const minSum = mins.reduce((a, b) => a + b, 0);
  if (minSum >= total) return mins.map((m) => (minSum > 0 ? (m / minSum) * Math.max(0, total) : 0));
  const out = new Array<number>(n).fill(0);
  const frozen = new Array<boolean>(n).fill(false);
  let remaining = total;
  for (let iter = 0; iter <= n; iter++) {
    const wsum = weights.reduce((a, w, i) => (frozen[i] ? a : a + w), 0);
    if (wsum <= 0) break;
    const snap = remaining;
    let again = false;
    for (let i = 0; i < n; i++) {
      if (frozen[i]) continue;
      if ((snap * weights[i]) / wsum < mins[i] - 1e-9) {
        out[i] = mins[i];
        frozen[i] = true;
        remaining -= mins[i];
        again = true;
      }
    }
    if (!again) {
      for (let i = 0; i < n; i++) if (!frozen[i]) out[i] = (snap * weights[i]) / wsum;
      break;
    }
  }
  return out;
}

function roundLens(lens: number[]): number[] {
  const out: number[] = [];
  let cum = 0;
  let prev = 0;
  for (const l of lens) {
    cum += l;
    const r = Math.round(cum);
    out.push(r - prev);
    prev = r;
  }
  return out;
}

function pushStack(
  ctx: Ctx,
  id: string,
  r: Rect,
  panels: PanelId[],
  active: PanelId,
  strip: boolean,
  stripThin: Axis | null,
  virtual: boolean,
): void {
  const th = Math.min(ctx.o.tabH, r.h);
  ctx.out.stacks.push({
    id,
    rect: r,
    tabBar: strip ? { x: r.x, y: r.y, w: r.w, h: 0 } : { x: r.x, y: r.y, w: r.w, h: th },
    body: strip ? { x: r.x, y: r.y, w: 0, h: 0 } : { x: r.x, y: r.y + th, w: r.w, h: Math.max(0, r.h - th) },
    panels,
    active,
    strip,
    stripThin,
    virtual,
  });
  const body = ctx.out.stacks[ctx.out.stacks.length - 1].body;
  for (const p of panels) {
    ctx.out.panels[p] = { stackId: id, rect: body, visible: !strip && p === active };
  }
}

function place(n: LayoutNode, r: Rect, ctx: Ctx, parent: SplitNode | null, eff: Dir | null): void {
  if (n.kind === "stack") {
    const strip = n.collapsed && parent !== null;
    pushStack(ctx, n.id, r, n.panels, n.active, strip, strip ? (eff === "row" ? "x" : "y") : null, n.id.startsWith("~"));
    return;
  }
  const k = n.children.length;
  const o = ctx.o;
  const isStrip = n.children.map((c) => c.kind === "stack" && c.collapsed);
  const stripTotal = isStrip.filter(Boolean).length * o.strip;

  const fits = (dir: Dir): boolean => {
    const axis: Axis = dir === "row" ? "x" : "y";
    const avail = (axis === "x" ? r.w : r.h) - o.gap * (k - 1) - stripTotal;
    const need = n.children.reduce(
      (a, c, i) => (isStrip[i] ? a : a + req(c, axis, "pref", ctx)),
      0,
    );
    return need <= avail + 1e-9;
  };
  const flip: Dir = n.dir === "row" ? "col" : "row";
  const dir: Dir | null = fits(n.dir) ? n.dir : fits(flip) ? flip : null;

  if (dir === null && k > 2) {
    // Too tight for every child: tab the two smallest neighbours together and try again,
    // so a 3-panel window shows 2 areas (one of them tabbed) before it gives up to one stack.
    let at = -1;
    let best = Infinity;
    for (let i = 0; i + 1 < k; i++) {
      if (isStrip[i] || isStrip[i + 1]) continue;
      const w = n.sizes[i] + n.sizes[i + 1];
      if (w < best) {
        best = w;
        at = i;
      }
    }
    if (at >= 0) {
      const pair = [n.children[at], n.children[at + 1]];
      const panels = pair.flatMap((c) => panelsOf(c));
      const leafActive = (x: LayoutNode): PanelId => (x.kind === "stack" ? x.active : leafActive(x.children[0]));
      const active = ctx.focus && panels.includes(ctx.focus) ? ctx.focus : leafActive(pair[0]);
      const merged: LayoutNode = { kind: "stack", id: `~${n.id}.${at}`, panels, active, collapsed: false };
      const children = [...n.children.slice(0, at), merged, ...n.children.slice(at + 2)];
      const sizes = [...n.sizes.slice(0, at), best, ...n.sizes.slice(at + 2)];
      ctx.out.compact = true;
      place({ ...n, id: `~${n.id}~`, children, sizes }, r, ctx, parent, eff);
      return;
    }
  }

  if (dir === null) {
    // merged tab stack
    const panels = panelsOf(n);
    const leafActive = (x: LayoutNode): PanelId => (x.kind === "stack" ? x.active : leafActive(x.children[0]));
    const active = ctx.focus && panels.includes(ctx.focus) ? ctx.focus : leafActive(n);
    pushStack(ctx, `~${n.id}`, r, panels, active, false, null, true);
    ctx.out.compact = true;
    return;
  }

  const axis: Axis = dir === "row" ? "x" : "y";
  const total = (axis === "x" ? r.w : r.h) - o.gap * (k - 1);
  const flexTotal = total - stripTotal;
  const flexIdx = n.children.map((_, i) => i).filter((i) => !isStrip[i]);
  const mins = flexIdx.map((i) => Math.min(req(n.children[i], axis, "min", ctx), flexTotal));
  const weights = flexIdx.map((i) => n.sizes[i]);
  const flexLens = distribute(flexTotal, weights, mins);
  const lens = n.children.map((_, i) => (isStrip[i] ? o.strip : flexLens[flexIdx.indexOf(i)]));
  const px = roundLens(lens);

  let cursor = axis === "x" ? r.x : r.y;
  const start = cursor;
  const rects: Rect[] = [];
  n.children.forEach((c, i) => {
    const cr: Rect =
      axis === "x"
        ? { x: cursor, y: r.y, w: px[i], h: r.h }
        : { x: r.x, y: cursor, w: r.w, h: px[i] };
    rects.push(cr);
    cursor += px[i] + o.gap;
    place(c, cr, ctx, n, dir);
  });
  const end = start + total + o.gap * (k - 1);
  for (let i = 0; i < k - 1; i++) {
    if (isStrip[i] || isStrip[i + 1]) continue;
    const a = rects[i];
    const pos = axis === "x" ? a.x + a.w + o.gap / 2 : a.y + a.h + o.gap / 2;
    const gapRect: Rect =
      axis === "x"
        ? { x: a.x + a.w, y: r.y, w: o.gap, h: r.h }
        : { x: r.x, y: a.y + a.h, w: r.w, h: o.gap };
    const line: Rect =
      axis === "x"
        ? { x: Math.round(pos - 1), y: r.y, w: 2, h: r.h }
        : { x: r.x, y: Math.round(pos - 1), w: r.w, h: 2 };
    ctx.out.separators.push({
      id: `${n.id}:${i}`,
      splitId: n.id,
      index: i,
      axis,
      rect: gapRect,
      line,
      pos,
      span: [start, end],
      childPx: px,
      childMin: n.children.map((c, ci) => (isStrip[ci] ? o.strip : req(c, axis, "min", ctx))),
      isStrip,
      sizes: n.sizes,
      fraction: end > start ? (pos - start) / (end - start) : 0.5,
    });
  }
}

export function computeGeometry(
  layout: Layout,
  size: { w: number; h: number },
  metas: Record<PanelId, PanelMeta> = {},
  options: Partial<GeoOptions> = {},
  focus?: PanelId,
): Geometry {
  const o = { ...GEO_DEFAULTS, ...options };
  const w = Math.max(0, Math.floor(size.w));
  const h = Math.max(0, Math.floor(size.h));
  const px = Math.min(o.padX, Math.floor(w / 4));
  const py = Math.min(o.padY, Math.floor(h / 4));
  const inner: Rect = { x: px, y: py, w: Math.max(0, w - 2 * px), h: Math.max(0, h - 2 * py) };
  const out: Geometry = {
    size: { w, h },
    inner,
    stacks: [],
    separators: [],
    panels: {},
    compact: false,
    opts: o,
  };
  if (layout.root) place(layout.root, inner, { metas, o, focus, out }, null, null);
  return out;
}

/* ------------------------------------------------------------- separator maths */

/** Absolute boundary positions other separators sit at (for snapping). */
export function snapCandidates(geo: Geometry, sep: SepGeo): number[] {
  const out: number[] = [(sep.span[0] + sep.span[1]) / 2];
  for (const s of geo.separators) {
    if (s.id !== sep.id && s.splitId !== sep.splitId && s.axis === sep.axis) out.push(s.pos);
  }
  return out;
}

export interface ResizeResult {
  sizes: number[];
  /** Boundary position after clamping and snapping. */
  pos: number;
  snapped: boolean;
}

/**
 * New split sizes when separator `sep` moves by `deltaPx`. Only the two neighbours change;
 * both stay above their minimum. `snaps` are absolute positions to snap to within SNAP_PX.
 */
export function resizeFromDelta(sep: SepGeo, deltaPx: number, snaps: number[] = []): ResizeResult {
  const i = sep.index;
  const a = sep.childPx[i];
  const b = sep.childPx[i + 1];
  const lo = sep.childMin[i];
  const hi = a + b - sep.childMin[i + 1];
  let d = deltaPx;
  let snapped = false;
  if (snaps.length) {
    const target = sep.pos + d;
    let best: number | null = null;
    for (const s of snaps) {
      if (Math.abs(s - target) <= SNAP_PX && (best === null || Math.abs(s - target) < Math.abs(best - target))) {
        best = s;
      }
    }
    if (best !== null) {
      d = best - sep.pos;
      snapped = true;
    }
  }
  let newA = a + d;
  if (hi < lo) newA = a;
  else newA = Math.min(Math.max(newA, lo), hi);
  if (Math.abs(newA - (a + d)) > 0.5) snapped = false;
  const newB = a + b - newA;
  const px = sep.childPx.slice();
  px[i] = newA;
  px[i + 1] = newB;
  const flex = px.map((v, idx) => (sep.isStrip[idx] ? 0 : v));
  const flexSum = flex.reduce((x, y) => x + y, 0) || 1;
  const stripShare = sep.sizes.reduce((acc, s, idx) => (sep.isStrip[idx] ? acc + s : acc), 0);
  const share = 1 - stripShare;
  const sizes = sep.sizes.map((s, idx) => (sep.isStrip[idx] ? s : (flex[idx] / flexSum) * share));
  return { sizes, pos: sep.pos + (newA - a), snapped };
}

/** Largest and smallest boundary offsets for Home/End on a separator. */
export function resizeBounds(sep: SepGeo): { min: number; max: number } {
  const i = sep.index;
  const a = sep.childPx[i];
  const b = sep.childPx[i + 1];
  return { min: sep.childMin[i] - a, max: Math.max(sep.childMin[i] - a, a + b - sep.childMin[i + 1] - a) };
}

/* -------------------------------------------------------------------- hit test */

export interface DropHit {
  target: DropTarget;
  zone: Zone;
  /** Region our own preview element should fill. */
  preview: Rect;
  /** Pointer is over a tab bar: the caller computes the insertion index. */
  onTabBar: boolean;
  stackId?: string;
}

const inside = (r: Rect, x: number, y: number) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

export function sameHit(a: DropHit | null, b: DropHit | null): boolean {
  if (!a || !b) return a === b;
  return a.zone === b.zone && a.stackId === b.stackId && a.target.kind === b.target.kind && a.onTabBar === b.onTabBar;
}

/**
 * Where would a drop at (x, y) go? Window edges win over stack zones. Returns null when
 * dropping would change nothing, or when the layout is compact (merged tabs).
 */
export function hitTest(
  geo: Geometry,
  x: number,
  y: number,
  dragged: PanelId,
  rootHasOtherPanels: boolean,
): DropHit | null {
  if (geo.compact) return null;
  const { w, h } = geo.size;
  if (x < 0 || y < 0 || x >= w || y >= h) return null;
  const inr = geo.inner;
  if (rootHasOtherPanels && geo.stacks.length) {
    const dl = x;
    const dr = w - 1 - x;
    const dt = y;
    const db = h - 1 - y;
    const m = Math.min(dl, dr, dt, db);
    if (m < EDGE_BAND) {
      const horiz = m === dl || m === dr;
      const zone: Zone = horiz ? (m === dl ? "left" : "right") : m === dt ? "top" : "bottom";
      const pw = Math.round(inr.w * 0.32);
      const ph = Math.round(inr.h * 0.32);
      const preview: Rect =
        zone === "left"
          ? { x: inr.x, y: inr.y, w: pw, h: inr.h }
          : zone === "right"
            ? { x: inr.x + inr.w - pw, y: inr.y, w: pw, h: inr.h }
            : zone === "top"
              ? { x: inr.x, y: inr.y, w: inr.w, h: ph }
              : { x: inr.x, y: inr.y + inr.h - ph, w: inr.w, h: ph };
      return { target: { kind: "edge" }, zone, preview, onTabBar: false };
    }
  }
  const s = geo.stacks.find((st) => inside(st.rect, x, y));
  if (!s) return null;
  const sole = s.panels.length === 1 && s.panels[0] === dragged;
  const t: DropTarget = { kind: "stack", stackId: s.id };
  if (s.strip) return sole ? null : { target: t, zone: "center", preview: s.rect, onTabBar: false, stackId: s.id };
  if (inside(s.tabBar, x, y)) {
    if (sole) return null;
    return { target: t, zone: "center", preview: s.rect, onTabBar: true, stackId: s.id };
  }
  const r = s.rect;
  const fx = (x - r.x) / Math.max(1, r.w);
  const fy = (y - r.y) / Math.max(1, r.h);
  if (fx >= 0.25 && fx <= 0.75 && fy >= 0.25 && fy <= 0.75) {
    if (sole || s.panels.includes(dragged)) return null; // centre of own stack: nothing to do
    return { target: t, zone: "center", preview: s.rect, onTabBar: false, stackId: s.id };
  }
  if (sole) return null;
  const d = [fx, 1 - fx, fy, 1 - fy];
  const m = Math.min(...d);
  const zone: Zone = m === d[0] ? "left" : m === d[1] ? "right" : m === d[2] ? "top" : "bottom";
  const hw = Math.floor(r.w / 2);
  const hh = Math.floor(r.h / 2);
  const preview: Rect =
    zone === "left"
      ? { x: r.x, y: r.y, w: hw, h: r.h }
      : zone === "right"
        ? { x: r.x + r.w - hw, y: r.y, w: hw, h: r.h }
        : zone === "top"
          ? { x: r.x, y: r.y, w: r.w, h: hh }
          : { x: r.x, y: r.y + r.h - hh, w: r.w, h: hh };
  return { target: t, zone, preview, onTabBar: false, stackId: s.id };
}

/* ----------------------------------------------------------------------- misc */

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
export function rectWithin(a: Rect, outer: { w: number; h: number }): boolean {
  return a.x >= 0 && a.y >= 0 && a.x + a.w <= outer.w && a.y + a.h <= outer.h;
}
export type { StackNode };
