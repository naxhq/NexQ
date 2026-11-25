import { DEFAULT_PANELS, DockState, Layout, LayoutNode, PanelId, newId, normalizeLayout, panelsOf } from "./layoutTree";

/* ------------------------------------------------------------------ presets */

export type Tpl =
  | { t: "s"; p: PanelId[]; a?: PanelId; c?: boolean }
  | { t: "r" | "c"; k: [Tpl, number][] };
export const S = (p: PanelId[], o: { a?: PanelId; c?: boolean } = {}): Tpl => ({ t: "s", p, ...o });
export const R = (...k: [Tpl, number][]): Tpl => ({ t: "r", k });
export const C = (...k: [Tpl, number][]): Tpl => ({ t: "c", k });

export const PRESET_IDS = ["classic", "focus", "notes", "presenter", "everything"] as const;
export type PresetId = (typeof PRESET_IDS)[number];
export const PRESET_NAMES: Record<PresetId, string> = {
  classic: "Classic",
  focus: "Focus",
  notes: "Notes",
  presenter: "Presenter",
  everything: "Everything",
};

export const TEMPLATES: Record<PresetId, Tpl> = {
  // Today's window: transcript left, assistant right, equal columns.
  classic: R([S(["transcript"]), 0.5], [S(["assistant"]), 0.5]),
  focus: R([S(["transcript"], { c: true }), 0.25], [S(["assistant"]), 0.75]),
  notes: R(
    [C([S(["transcript"]), 0.5], [S(["assistant"]), 0.5]), 0.42],
    [S(["notes", "brief"], { a: "notes" }), 0.58],
  ),
  presenter: R(
    [S(["points", "brief"], { a: "points" }), 0.45],
    [S(["assistant", "transcript"], { a: "assistant" }), 0.55],
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

export function buildTpl(l: Layout, t: Tpl, present: Set<PanelId>): LayoutNode | null {
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
  return { layout: presetLayout("classic", known), custom: [], customSeq: 0, drags: 0 };
}

