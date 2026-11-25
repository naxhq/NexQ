/**
 * Pure dock layout model: a split/stack tree, a reducer and a sanitizer.
 * No React, no DOM. Every panel exists exactly once (docked in a stack, or hidden).
 */

export type PanelId = string;
export type Dir = "row" | "col";
export type Side = "left" | "right" | "top" | "bottom";
export type Zone = Side | "center";

export interface StackNode {
  kind: "stack";
  id: string;
  panels: PanelId[];
  active: PanelId;
  /** Collapsed to a thin strip (only meaningful inside a split). */
  collapsed: boolean;
}
export interface SplitNode {
  kind: "split";
  id: string;
  dir: Dir;
  /** Fractions, one per child, sum to 1, each >= MIN_FRAC. */
  sizes: number[];
  children: LayoutNode[];
}
export type LayoutNode = StackNode | SplitNode;

/** Where a hidden panel returns to. */
export interface Place {
  near: PanelId | null;
  zone: Zone;
  index?: number;
  size?: number;
}

export interface Layout {
  v: 1;
  root: LayoutNode | null;
  hidden: PanelId[];
  places: Record<PanelId, Place>;
  locked: boolean;
  /** Last used numeric suffix for generated node ids. */
  seq: number;
}

export interface SavedLayout {
  id: string;
  name: string;
  layout: Layout;
}

export interface DockState {
  layout: Layout;
  custom: SavedLayout[];
  customSeq: number;
}

export const MIN_FRAC = 0.05;
export const MAX_CUSTOM = 20;
export const DEFAULT_PANELS: PanelId[] = [
  "transcript",
  "assistant",
  "notes",
  "brief",
  "points",
  "bookmarks",
  "stats",
  "calllog",
  "devlog",
];

/* ------------------------------------------------------------------ walkers */

export function leaves(n: LayoutNode | null): StackNode[] {
  if (!n) return [];
  return n.kind === "stack" ? [n] : n.children.flatMap(leaves);
}
export function panelsOf(n: LayoutNode | null): PanelId[] {
  return leaves(n).flatMap((s) => s.panels);
}
export function allPanels(l: Layout): PanelId[] {
  return [...panelsOf(l.root), ...l.hidden];
}
export function findNode(n: LayoutNode | null, id: string): LayoutNode | undefined {
  if (!n) return undefined;
  if (n.id === id) return n;
  if (n.kind === "split") {
    for (const c of n.children) {
      const f = findNode(c, id);
      if (f) return f;
    }
  }
  return undefined;
}
export function findStackOf(n: LayoutNode | null, panel: PanelId): StackNode | undefined {
  return leaves(n).find((s) => s.panels.includes(panel));
}
export function parentOf(
  n: LayoutNode | null,
  id: string,
): { parent: SplitNode; index: number } | null {
  if (!n || n.kind === "stack") return null;
  for (let i = 0; i < n.children.length; i++) {
    if (n.children[i].id === id) return { parent: n, index: i };
    const f = parentOf(n.children[i], id);
    if (f) return f;
  }
  return null;
}
function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}
function newId(l: Layout, prefix: "s" | "p"): string {
  l.seq += 1;
  return `${prefix}${l.seq}`;
}
function newStack(l: Layout, panel: PanelId): StackNode {
  return { kind: "stack", id: newId(l, "s"), panels: [panel], active: panel, collapsed: false };
}
function replaceNode(n: LayoutNode, id: string, repl: LayoutNode): LayoutNode {
  if (n.id === id) return repl;
  if (n.kind === "split") {
    return { ...n, children: n.children.map((c) => replaceNode(c, id, repl)) };
  }
  return n;
}

/* ---------------------------------------------------------------- normalize */

function normSizes(sizes: number[]): number[] {
  const n = sizes.length;
  let s = sizes.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  let sum = s.reduce((a, b) => a + b, 0);
  if (sum <= 0) return Array(n).fill(1 / n);
  const ok = Math.abs(sum - 1) < 1e-9 && s.every((x) => x >= MIN_FRAC - 1e-9);
  if (ok) return sizes.slice();
  s = s.map((x) => x / sum);
  if (n * MIN_FRAC >= 1) return Array(n).fill(1 / n);
  for (let pass = 0; pass <= n; pass++) {
    const low = s.map((x) => x < MIN_FRAC);
    const lowCount = low.filter(Boolean).length;
    if (!lowCount) break;
    const rest = s.reduce((acc, x, i) => (low[i] ? acc : acc + x), 0);
    const scale = (1 - lowCount * MIN_FRAC) / rest;
    s = s.map((x, i) => (low[i] ? MIN_FRAC : x * scale));
  }
  s = s.map((x) => Math.max(x, MIN_FRAC));
  let big = 0;
  s.forEach((x, i) => {
    if (x > s[big]) big = i;
  });
  s[big] += 1 - s.reduce((a, b) => a + b, 0);
  return s;
}

function norm(n: LayoutNode): LayoutNode | null {
  if (n.kind === "stack") {
    if (n.panels.length === 0) return null;
    if (!n.panels.includes(n.active)) n.active = n.panels[0];
    return n;
  }
  const kids: LayoutNode[] = [];
  const sizes: number[] = [];
  let total = n.sizes.reduce((a, b) => a + (Number.isFinite(b) && b > 0 ? b : 0), 0) || 1;
  if (Math.abs(total - 1) < 1e-9) total = 1;
  n.children.forEach((c, i) => {
    const cn = norm(c);
    if (!cn) return;
    const raw = n.sizes[i];
    const w = (Number.isFinite(raw) && raw > 0 ? raw : total / n.children.length) / total;
    if (cn.kind === "split" && cn.dir === n.dir) {
      cn.children.forEach((g, k) => {
        kids.push(g);
        sizes.push(w * cn.sizes[k]);
      });
    } else {
      kids.push(cn);
      sizes.push(w);
    }
  });
  if (kids.length === 0) return null;
  if (kids.length === 1) return kids[0];
  n.children = kids;
  n.sizes = normSizes(sizes);
  // at least one child must be able to take space
  if (kids.every((k) => k.kind === "stack" && k.collapsed)) {
    let best = 0;
    n.sizes.forEach((s, i) => {
      if (s > n.sizes[best]) best = i;
    });
    (kids[best] as StackNode).collapsed = false;
  }
  return n;
}

function normalizeLayout(l: Layout): Layout {
  if (l.root) {
    l.root = norm(l.root);
    if (l.root && l.root.kind === "stack") l.root.collapsed = false;
  }
  return l;
}

/* --------------------------------------------------------------- invariants */

export function violations(l: Layout, known?: PanelId[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const ids = new Set<string>();
  const visit = (n: LayoutNode, parentDir: Dir | null, isRoot: boolean) => {
    if (ids.has(n.id)) out.push(`duplicate node id ${n.id}`);
    ids.add(n.id);
    if (n.kind === "stack") {
      if (n.panels.length === 0) out.push(`empty stack ${n.id}`);
      if (!n.panels.includes(n.active)) out.push(`active not in stack ${n.id}`);
      if (isRoot && n.collapsed) out.push("root stack collapsed");
      for (const p of n.panels) {
        if (seen.has(p)) out.push(`panel ${p} twice`);
        seen.add(p);
      }
      return;
    }
    if (n.children.length < 2) out.push(`split ${n.id} has ${n.children.length} children`);
    if (n.sizes.length !== n.children.length) out.push(`split ${n.id} sizes length`);
    const sum = n.sizes.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > 1e-6) out.push(`split ${n.id} sizes sum ${sum}`);
    if (n.sizes.some((s) => !Number.isFinite(s) || s < MIN_FRAC - 1e-6)) {
      out.push(`split ${n.id} size below minimum`);
    }
    if (parentDir === n.dir) out.push(`split ${n.id} not flattened`);
    if (n.children.every((c) => c.kind === "stack" && c.collapsed)) {
      out.push(`split ${n.id} fully collapsed`);
    }
    n.children.forEach((c) => visit(c, n.dir, false));
  };
  if (l.root) visit(l.root, null, true);
  for (const p of l.hidden) {
    if (seen.has(p)) out.push(`panel ${p} twice (hidden)`);
    seen.add(p);
  }
  if (known) {
    for (const p of known) if (!seen.has(p)) out.push(`panel ${p} missing`);
    for (const p of seen) if (!known.includes(p)) out.push(`unknown panel ${p}`);
  }
  for (const k of Object.keys(l.places)) if (!seen.has(k)) out.push(`place for unknown ${k}`);
  return out;
}

/* ------------------------------------------------------------------ presets */

type Tpl =
  | { t: "s"; p: PanelId[]; a?: PanelId; c?: boolean }
  | { t: "r" | "c"; k: [Tpl, number][] };
const S = (p: PanelId[], o: { a?: PanelId; c?: boolean } = {}): Tpl => ({ t: "s", p, ...o });
const R = (...k: [Tpl, number][]): Tpl => ({ t: "r", k });
const C = (...k: [Tpl, number][]): Tpl => ({ t: "c", k });

export const PRESET_IDS = ["classic", "focus", "notes", "presenter", "everything"] as const;
export type PresetId = (typeof PRESET_IDS)[number];
export const PRESET_NAMES: Record<PresetId, string> = {
  classic: "Classic",
  focus: "Focus",
  notes: "Notes",
  presenter: "Presenter",
  everything: "Everything",
};

const TEMPLATES: Record<PresetId, Tpl> = {
  // Today's window: transcript left, assistant right, equal columns.
  classic: R([S(["transcript"]), 0.5], [S(["assistant"]), 0.5]),
  focus: R([S(["transcript"], { c: true }), 0.25], [S(["assistant"]), 0.75]),
  notes: R(
    [C([S(["transcript"]), 0.5], [S(["assistant"]), 0.5]), 0.42],
    [S(["notes", "brief"], { a: "notes" }), 0.58],
  ),
  presenter: R(
    [S(["points", "brief"], { a: "points" }), 0.4],
    [C([S(["assistant"]), 0.7], [S(["transcript"]), 0.3]), 0.6],
  ),
  everything: R(
    [S(["transcript", "calllog", "devlog"], { a: "transcript" }), 0.34],
    [
      C(
        [S(["assistant"]), 0.58],
        [S(["notes", "brief", "points", "bookmarks", "stats"], { a: "notes" }), 0.42],
      ),
      0.66,
    ],
  ),
};

function buildTpl(l: Layout, t: Tpl, present: Set<PanelId>): LayoutNode | null {
  if (t.t === "s") {
    const panels = t.p.filter((p) => present.has(p));
    if (!panels.length) return null;
    return {
      kind: "stack",
      id: newId(l, "s"),
      panels,
      active: t.a && panels.includes(t.a) ? t.a : panels[0],
      collapsed: !!t.c,
    };
  }
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  for (const [ct, size] of t.k) {
    const n = buildTpl(l, ct, present);
    if (n) {
      children.push(n);
      sizes.push(size);
    }
  }
  if (!children.length) return null;
  return { kind: "split", id: newId(l, "p"), dir: t.t === "r" ? "row" : "col", sizes, children };
}

/** A fresh layout of `preset` over exactly `known` panels (others hidden). */
export function presetLayout(preset: PresetId, known: PanelId[], locked = false): Layout {
  const l: Layout = { v: 1, root: null, hidden: [], places: {}, locked, seq: 0 };
  const present = new Set(known);
  let root = buildTpl(l, TEMPLATES[preset], present);
  if (!root && known.length) {
    root = { kind: "stack", id: newId(l, "s"), panels: [...known], active: known[0], collapsed: false };
  }
  l.root = root;
  const placed = new Set(panelsOf(root));
  l.hidden = known.filter((p) => !placed.has(p));
  return normalizeLayout(l);
}

export function initialDockState(known: PanelId[] = DEFAULT_PANELS): DockState {
  return { layout: presetLayout("classic", known), custom: [], customSeq: 0 };
}

/* ------------------------------------------------------------------ sanitize */

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const isZone = (z: unknown): z is Zone =>
  z === "left" || z === "right" || z === "top" || z === "bottom" || z === "center";

function parseNode(
  j: unknown,
  seen: Set<PanelId>,
  ids: Set<string>,
  ctr: { n: number; fresh: number },
  allowed: Set<PanelId> | null,
  depth: number,
): LayoutNode | null {
  if (!isObj(j) || depth > 12 || ++ctr.n > 80) return null;
  let id = typeof j.id === "string" && j.id && !ids.has(j.id) ? j.id : "";
  const mk = (prefix: string) => {
    if (id) return id;
    do id = `${prefix}x${++ctr.fresh}`;
    while (ids.has(id));
    return id;
  };
  if (j.kind === "stack") {
    const panels: PanelId[] = [];
    if (Array.isArray(j.panels)) {
      for (const p of j.panels) {
        if (typeof p !== "string" || seen.has(p)) continue;
        if (allowed && !allowed.has(p)) continue;
        seen.add(p);
        panels.push(p);
      }
    }
    if (!panels.length) return null;
    ids.add(mk("s"));
    return {
      kind: "stack",
      id,
      panels,
      active: typeof j.active === "string" && panels.includes(j.active) ? j.active : panels[0],
      collapsed: j.collapsed === true,
    };
  }
  if (j.kind === "split" && Array.isArray(j.children)) {
    const dir: Dir = j.dir === "col" ? "col" : "row";
    ids.add(mk("p"));
    const children: LayoutNode[] = [];
    const sizes: number[] = [];
    j.children.forEach((c, i) => {
      const n = parseNode(c, seen, ids, ctr, allowed, depth + 1);
      if (!n) return;
      children.push(n);
      const s = Array.isArray(j.sizes) ? (j.sizes as unknown[])[i] : undefined;
      sizes.push(typeof s === "number" && Number.isFinite(s) && s > 0 ? s : 1);
    });
    if (!children.length) return null;
    return { kind: "split", id, dir, sizes, children };
  }
  return null;
}

function maxSeq(n: LayoutNode | null, floor: number): number {
  let m = floor;
  const walk = (x: LayoutNode) => {
    const mt = /^[a-z]+(\d+)$/.exec(x.id);
    if (mt) m = Math.max(m, parseInt(mt[1], 10));
    if (x.kind === "split") x.children.forEach(walk);
  };
  if (n) walk(n);
  return m;
}

/**
 * Turn anything (old versions, hand edits, garbage) into a valid layout.
 * Unknown panels are dropped, missing known ones are added hidden. Falls back to Classic.
 */
export function sanitizeLayout(json: unknown, known: PanelId[] = DEFAULT_PANELS): Layout {
  const fallback = () => presetLayout("classic", known);
  if (!isObj(json)) return fallback();
  const allowed = new Set(known);
  const seen = new Set<PanelId>();
  const ids = new Set<string>();
  let root: LayoutNode | null = null;
  if (json.root !== null && json.root !== undefined) {
    root = parseNode(json.root, seen, ids, { n: 0, fresh: 0 }, allowed, 0);
    if (!root) return fallback();
  } else if (!("hidden" in json)) {
    return fallback();
  }
  const hidden: PanelId[] = [];
  if (Array.isArray(json.hidden)) {
    for (const p of json.hidden) {
      if (typeof p === "string" && allowed.has(p) && !seen.has(p)) {
        seen.add(p);
        hidden.push(p);
      }
    }
  }
  for (const p of known) if (!seen.has(p)) hidden.push(p);
  const places: Record<PanelId, Place> = {};
  if (isObj(json.places)) {
    for (const [k, v] of Object.entries(json.places)) {
      if (!hidden.includes(k) || !isObj(v) || !isZone(v.zone)) continue;
      const near = typeof v.near === "string" ? v.near : null;
      const pl: Place = { near, zone: v.zone };
      if (typeof v.index === "number" && Number.isInteger(v.index) && v.index >= 0) pl.index = v.index;
      if (typeof v.size === "number" && v.size > 0 && v.size < 1) pl.size = v.size;
      places[k] = pl;
    }
  }
  const seqIn =
    typeof json.seq === "number" && Number.isFinite(json.seq) ? Math.max(0, Math.floor(json.seq)) : 0;
  const l: Layout = {
    v: 1,
    root,
    hidden,
    places,
    locked: json.locked === true,
    seq: maxSeq(root, seqIn),
  };
  normalizeLayout(l);
  if (violations(l, known).length) return fallback();
  return l;
}

export function sanitizeState(json: unknown, known: PanelId[] = DEFAULT_PANELS): DockState {
  if (!isObj(json)) return initialDockState(known);
  const layout = sanitizeLayout(json.layout ?? json, known);
  const custom: SavedLayout[] = [];
  let customSeq = 0;
  if (Array.isArray(json.custom)) {
    for (const c of json.custom) {
      if (!isObj(c) || typeof c.id !== "string" || typeof c.name !== "string") continue;
      if (custom.some((x) => x.id === c.id) || custom.length >= MAX_CUSTOM) continue;
      custom.push({
        id: c.id,
        name: c.name.slice(0, 40) || "Layout",
        layout: sanitizeLayout(c.layout, known),
      });
      const m = /^c(\d+)$/.exec(c.id);
      if (m) customSeq = Math.max(customSeq, parseInt(m[1], 10));
    }
  }
  if (typeof json.customSeq === "number" && Number.isFinite(json.customSeq)) {
    customSeq = Math.max(customSeq, Math.floor(json.customSeq));
  }
  return { layout, custom, customSeq };
}

/* ------------------------------------------------------------------ actions */

export type DropTarget = { kind: "stack"; stackId: string } | { kind: "edge" };

export type DockAction =
  | { type: "dock"; panel: PanelId; target: DropTarget; zone: Zone; index?: number; size?: number }
  | { type: "reorder"; panel: PanelId; index: number }
  | { type: "activate"; panel: PanelId }
  | { type: "resize"; splitId: string; sizes: number[] }
  | { type: "equalize"; splitId: string; index: number }
  | { type: "hide"; panel: PanelId }
  | { type: "show"; panel: PanelId }
  | { type: "reveal"; panel: PanelId }
  | { type: "collapse"; stackId: string; collapsed?: boolean }
  | { type: "reset" }
  | { type: "preset"; preset: PresetId }
  | { type: "saveLayout"; name: string }
  | { type: "renameLayout"; id: string; name: string }
  | { type: "deleteLayout"; id: string }
  | { type: "applyLayout"; id: string }
  | { type: "lock"; locked: boolean }
  | { type: "load"; state: DockState };

function computePlace(l: Layout, panel: PanelId): Place {
  const stack = findStackOf(l.root, panel);
  if (!stack) return { near: null, zone: "center" };
  if (stack.panels.length > 1) {
    const i = stack.panels.indexOf(panel);
    return { near: stack.panels[i + 1] ?? stack.panels[i - 1], zone: "center", index: i };
  }
  const p = parentOf(l.root, stack.id);
  if (!p) return { near: null, zone: "center" };
  const { parent, index: i } = p;
  const j = i + 1 < parent.children.length ? i + 1 : i - 1;
  const near = panelsOf(parent.children[j])[0] ?? null;
  const row = parent.dir === "row";
  const zone: Zone = j > i ? (row ? "left" : "top") : row ? "right" : "bottom";
  const sum = parent.sizes.reduce((a, b) => a + b, 0) || 1;
  return { near, zone, size: Math.min(0.7, Math.max(0.15, parent.sizes[i] / sum)) };
}

/** Remove a panel from the tree / hidden list (no normalization). */
function detach(l: Layout, panel: PanelId): void {
  l.hidden = l.hidden.filter((p) => p !== panel);
  delete l.places[panel];
  const strip = (n: LayoutNode): LayoutNode | null => {
    if (n.kind === "stack") {
      const i = n.panels.indexOf(panel);
      if (i < 0) return n;
      n.panels.splice(i, 1);
      if (!n.panels.length) return null;
      if (n.active === panel) n.active = n.panels[Math.min(i, n.panels.length - 1)];
      return n;
    }
    const kids: LayoutNode[] = [];
    const sizes: number[] = [];
    n.children.forEach((c, i) => {
      const r = strip(c);
      if (r) {
        kids.push(r);
        sizes.push(n.sizes[i]);
      }
    });
    if (!kids.length) return null;
    n.children = kids;
    n.sizes = sizes;
    return n;
  };
  if (l.root) l.root = strip(l.root);
}

function sideDir(side: Side): Dir {
  return side === "left" || side === "right" ? "row" : "col";
}

function wrapWith(l: Layout, base: LayoutNode, panel: PanelId, side: Side, size: number): LayoutNode {
  const ns = newStack(l, panel);
  const first = side === "left" || side === "top";
  return {
    kind: "split",
    id: newId(l, "p"),
    dir: sideDir(side),
    sizes: first ? [size, 1 - size] : [1 - size, size],
    children: first ? [ns, base] : [base, ns],
  };
}

/** Core docking. Returns false when nothing changes. Mutates the clone `l`. */
function doDock(
  l: Layout,
  panel: PanelId,
  target: DropTarget,
  zone: Zone,
  index?: number,
  size?: number,
): boolean {
  if (!allPanels(l).includes(panel)) return false;
  const clampSize = (s: number | undefined, d: number) =>
    s !== undefined && Number.isFinite(s) ? Math.min(0.85, Math.max(0.1, s)) : d;

  if (target.kind === "stack") {
    const ts = findNode(l.root, target.stackId);
    if (!ts || ts.kind !== "stack") return false;
    if (zone === "center") {
      if (ts.panels.includes(panel)) {
        const from = ts.panels.indexOf(panel);
        const to = Math.min(Math.max(index ?? ts.panels.length - 1, 0), ts.panels.length - 1);
        ts.panels.splice(from, 1);
        ts.panels.splice(to, 0, panel);
        ts.active = panel;
        ts.collapsed = false;
        return true;
      }
      detach(l, panel);
      const at = Math.min(Math.max(index ?? ts.panels.length, 0), ts.panels.length);
      ts.panels.splice(at, 0, panel);
      ts.active = panel;
      ts.collapsed = false;
      return true;
    }
    if (ts.panels.length === 1 && ts.panels[0] === panel) return false;
    detach(l, panel);
    const wrapped = wrapWith(l, ts, panel, zone, clampSize(size, 0.5));
    l.root = replaceNode(l.root as LayoutNode, ts.id, wrapped);
    return true;
  }
  // window edge
  const side: Side = zone === "center" ? "right" : zone;
  if (l.root && l.root.kind === "stack" && l.root.panels.length === 1 && l.root.panels[0] === panel) {
    return false;
  }
  detach(l, panel);
  if (!l.root) {
    l.root = newStack(l, panel);
    return true;
  }
  l.root = wrapWith(l, l.root, panel, side, clampSize(size, 0.3));
  return true;
}

function doShow(l: Layout, panel: PanelId): boolean {
  if (!l.hidden.includes(panel)) return false;
  const place = l.places[panel];
  delete l.places[panel];
  if (place?.near) {
    const ns = findStackOf(l.root, place.near);
    if (ns) return doDock(l, panel, { kind: "stack", stackId: ns.id }, place.zone, place.index, place.size);
  }
  const zone: Zone = place && place.zone !== "center" ? place.zone : "right";
  return doDock(l, panel, { kind: "edge" }, zone, undefined, place?.size);
}

function doHide(l: Layout, panel: PanelId): boolean {
  if (!panelsOf(l.root).includes(panel)) return false;
  const place = computePlace(l, panel);
  detach(l, panel);
  l.hidden.push(panel);
  l.places[panel] = place;
  return true;
}

function applySaved(l: Layout, saved: Layout): Layout {
  const next = sanitizeLayout(saved, allPanels(l));
  next.locked = l.locked;
  return next;
}

/** Actions that change the arrangement; blocked while locked. */
const STRUCTURAL = new Set<DockAction["type"]>([
  "dock",
  "reorder",
  "resize",
  "equalize",
  "hide",
  "show",
  "collapse",
  "reset",
  "preset",
  "applyLayout",
]);

function step(state: DockState, a: DockAction): DockState {
  const l0 = state.layout;
  if (a.type === "load") return a.state;
  if (l0.locked && STRUCTURAL.has(a.type)) return state;
  const l = clone(l0);
  let changed = false;
  const custom = state.custom;
  let layout = l;

  switch (a.type) {
    case "dock":
      changed = doDock(l, a.panel, a.target, a.zone, a.index, a.size);
      break;
    case "reorder": {
      const s = findStackOf(l.root, a.panel);
      if (s && s.panels.length > 1) {
        changed = doDock(l, a.panel, { kind: "stack", stackId: s.id }, "center", a.index);
      }
      break;
    }
    case "activate": {
      const s = findStackOf(l.root, a.panel);
      if (s && (s.active !== a.panel || s.collapsed)) {
        s.active = a.panel;
        s.collapsed = false;
        changed = true;
      }
      break;
    }
    case "resize": {
      const n = findNode(l.root, a.splitId);
      if (
        n &&
        n.kind === "split" &&
        a.sizes.length === n.children.length &&
        a.sizes.every(Number.isFinite)
      ) {
        n.sizes = a.sizes.slice();
        changed = true;
      }
      break;
    }
    case "equalize": {
      const n = findNode(l.root, a.splitId);
      if (n && n.kind === "split" && a.index >= 0 && a.index + 1 < n.sizes.length) {
        const avg = (n.sizes[a.index] + n.sizes[a.index + 1]) / 2;
        n.sizes[a.index] = avg;
        n.sizes[a.index + 1] = avg;
        changed = true;
      }
      break;
    }
    case "hide":
      changed = doHide(l, a.panel);
      break;
    case "show":
      changed = doShow(l, a.panel);
      break;
    case "reveal": {
      if (l.hidden.includes(a.panel)) changed = doShow(l, a.panel);
      const s = findStackOf(l.root, a.panel);
      if (s && (s.active !== a.panel || s.collapsed)) {
        s.active = a.panel;
        s.collapsed = false;
        changed = true;
      }
      break;
    }
    case "collapse": {
      const s = findNode(l.root, a.stackId);
      if (s && s.kind === "stack" && l.root !== s) {
        const to = a.collapsed ?? !s.collapsed;
        if (to !== s.collapsed) {
          s.collapsed = to;
          changed = true;
        }
      }
      break;
    }
    case "reset":
      layout = presetLayout("classic", allPanels(l), l.locked);
      changed = true;
      break;
    case "preset":
      layout = presetLayout(a.preset, allPanels(l), l.locked);
      changed = true;
      break;
    case "lock":
      if (l.locked !== a.locked) {
        l.locked = a.locked;
        changed = true;
      }
      break;
    case "saveLayout": {
      if (custom.length >= MAX_CUSTOM) break;
      const name = a.name.trim().slice(0, 40) || "My layout";
      const customSeq = state.customSeq + 1;
      const snap = clone(l);
      snap.locked = false;
      return { layout: l0, custom: [...custom, { id: `c${customSeq}`, name, layout: snap }], customSeq };
    }
    case "renameLayout": {
      const name = a.name.trim().slice(0, 40);
      if (!name || !custom.some((c) => c.id === a.id)) break;
      return { ...state, custom: custom.map((c) => (c.id === a.id ? { ...c, name } : c)) };
    }
    case "deleteLayout":
      if (!custom.some((c) => c.id === a.id)) break;
      return { ...state, custom: custom.filter((c) => c.id !== a.id) };
    case "applyLayout": {
      const saved = custom.find((c) => c.id === a.id);
      if (saved) {
        layout = applySaved(l, saved.layout);
        changed = true;
      }
      break;
    }
  }
  if (!changed) return state;
  normalizeLayout(layout);
  if (violations(layout, allPanels(l0)).length) return state;
  return { layout, custom, customSeq: state.customSeq };
}

export function dockReducer(state: DockState, action: DockAction): DockState {
  return step(state, action);
}

/* ------------------------------------------------------------ move options */

export interface MoveOption {
  id: string;
  label: string;
  action: DockAction;
}

/** The keyboard alternative to dragging: every place `panel` can go. */
export function moveOptions(
  layout: Layout,
  panel: PanelId,
  title: (id: PanelId) => string,
): MoveOption[] {
  const out: MoveOption[] = [];
  const own = findStackOf(layout.root, panel);
  for (const s of leaves(layout.root)) {
    if (own && s.id === own.id) continue;
    const d = title(s.active);
    const t: DropTarget = { kind: "stack", stackId: s.id };
    out.push(
      { id: `${s.id}:left`, label: `Left of ${d}`, action: { type: "dock", panel, target: t, zone: "left" } },
      { id: `${s.id}:right`, label: `Right of ${d}`, action: { type: "dock", panel, target: t, zone: "right" } },
      { id: `${s.id}:top`, label: `Above ${d}`, action: { type: "dock", panel, target: t, zone: "top" } },
      { id: `${s.id}:bottom`, label: `Below ${d}`, action: { type: "dock", panel, target: t, zone: "bottom" } },
      {
        id: `${s.id}:center`,
        label: s.panels.length > 1 ? `Into tabs with ${d}` : `Tab with ${d}`,
        action: { type: "dock", panel, target: t, zone: "center" },
      },
    );
  }
  if (own && own.panels.length > 1) {
    const t: DropTarget = { kind: "stack", stackId: own.id };
    const sides: [Side, string][] = [
      ["left", "Split out to the left"],
      ["right", "Split out to the right"],
      ["top", "Split out above"],
      ["bottom", "Split out below"],
    ];
    for (const [z, label] of sides) {
      out.push({ id: `own:${z}`, label, action: { type: "dock", panel, target: t, zone: z } });
    }
  }
  const sole = !!own && own.panels.length === 1 && layout.root === own;
  if (!sole) {
    const edges: [Side, string][] = [
      ["left", "Left edge"],
      ["right", "Right edge"],
      ["top", "Top edge"],
      ["bottom", "Bottom edge"],
    ];
    for (const [z, label] of edges) {
      out.push({ id: `edge:${z}`, label, action: { type: "dock", panel, target: { kind: "edge" }, zone: z } });
    }
  }
  return out;
}

export function describeDock(
  layout: Layout,
  a: Extract<DockAction, { type: "dock" }>,
  title: (id: PanelId) => string,
): string {
  const me = title(a.panel);
  if (a.target.kind === "edge") return `${me}: dock to the ${a.zone} edge`;
  const s = findNode(layout.root, a.target.stackId);
  const d = s && s.kind === "stack" ? title(s.active) : "panel";
  switch (a.zone) {
    case "left":
      return `${me}: left of ${d}`;
    case "right":
      return `${me}: right of ${d}`;
    case "top":
      return `${me}: above ${d}`;
    case "bottom":
      return `${me}: below ${d}`;
    default:
      return `${me}: into tabs with ${d}`;
  }
}
