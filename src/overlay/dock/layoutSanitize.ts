import { DEFAULT_PANELS, Dir, DockState, Layout, LayoutNode, MAX_CUSTOM, PanelId, Place, SavedLayout, Zone, normalizeLayout, violations } from "./layoutTree";
import { initialDockState, presetLayout } from "./layoutPresets";

/* ------------------------------------------------------------------ sanitize */

export const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
export const isZone = (z: unknown): z is Zone =>
  z === "left" || z === "right" || z === "top" || z === "bottom" || z === "center";

export function parseNode(
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

export function maxSeq(n: LayoutNode | null, floor: number): number {
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

