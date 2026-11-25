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
export function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}
export function newId(l: Layout, prefix: "s" | "p"): string {
  l.seq += 1;
  return `${prefix}${l.seq}`;
}
export function newStack(l: Layout, panel: PanelId): StackNode {
  return { kind: "stack", id: newId(l, "s"), panels: [panel], active: panel, collapsed: false };
}
export function replaceNode(n: LayoutNode, id: string, repl: LayoutNode): LayoutNode {
  if (n.id === id) return repl;
  if (n.kind === "split") {
    return { ...n, children: n.children.map((c) => replaceNode(c, id, repl)) };
  }
  return n;
}

/* ---------------------------------------------------------------- normalize */

export function normSizes(sizes: number[]): number[] {
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

export function norm(n: LayoutNode): LayoutNode | null {
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

export function normalizeLayout(l: Layout): Layout {
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

