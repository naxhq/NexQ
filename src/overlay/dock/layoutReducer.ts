import { Dir, DockState, Layout, LayoutNode, MAX_CUSTOM, PanelId, Place, Side, Zone, allPanels, clone, findNode, findStackOf, leaves, newId, newStack, normalizeLayout, panelsOf, parentOf, replaceNode, violations } from "./layoutTree";
import { PresetId, presetLayout } from "./layoutPresets";
import { sanitizeLayout } from "./layoutSanitize";

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

export function computePlace(l: Layout, panel: PanelId): Place {
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
export function detach(l: Layout, panel: PanelId): void {
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

export function sideDir(side: Side): Dir {
  return side === "left" || side === "right" ? "row" : "col";
}

export function wrapWith(l: Layout, base: LayoutNode, panel: PanelId, side: Side, size: number): LayoutNode {
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
export function doDock(
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

export function doShow(l: Layout, panel: PanelId): boolean {
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

export function doHide(l: Layout, panel: PanelId): boolean {
  if (!panelsOf(l.root).includes(panel)) return false;
  const place = computePlace(l, panel);
  detach(l, panel);
  l.hidden.push(panel);
  l.places[panel] = place;
  return true;
}

export function applySaved(l: Layout, saved: Layout): Layout {
  const next = sanitizeLayout(saved, allPanels(l));
  next.locked = l.locked;
  return next;
}

/** Moving, resizing and re-arranging; blocked while locked. Showing, hiding and collapsing always work. */
export const STRUCTURAL = new Set<DockAction["type"]>([
  "dock",
  "reorder",
  "resize",
  "equalize",
  "reset",
  "preset",
  "applyLayout",
]);

export function step(state: DockState, a: DockAction): DockState {
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

