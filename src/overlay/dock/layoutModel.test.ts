import { describe, expect, it } from "vitest";
import {
  DEFAULT_PANELS,
  PRESET_IDS,
  allPanels,
  dockReducer,
  findStackOf,
  initialDockState,
  leaves,
  moveOptions,
  panelsOf,
  presetLayout,
  sanitizeLayout,
  sanitizeState,
  violations,
  type DockAction,
  type DockState,
  type SplitNode,
  type LayoutNode,
} from "./layoutModel";

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function splits(n: LayoutNode | null): SplitNode[] {
  if (!n || n.kind === "stack") return [];
  return [n, ...n.children.flatMap(splits)];
}

function randomAction(s: DockState, r: () => number): DockAction {
  const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
  const panels = allPanels(s.layout);
  const stacks = leaves(s.layout.root);
  const sp = splits(s.layout.root);
  const panel = r() < 0.03 ? "ghost" : pick(panels);
  const zones = ["left", "right", "top", "bottom", "center"] as const;
  const k = Math.floor(r() * 18);
  switch (k) {
    case 0:
    case 1:
    case 2:
      return {
        type: "dock",
        panel,
        target: stacks.length && r() < 0.8 ? { kind: "stack", stackId: pick(stacks).id } : { kind: "edge" },
        zone: pick([...zones]),
        index: r() < 0.5 ? Math.floor(r() * 6) - 1 : undefined,
        size: r() < 0.3 ? r() * 2 - 0.5 : undefined,
      };
    case 3:
      return { type: "dock", panel, target: { kind: "stack", stackId: "nope" }, zone: "left" };
    case 4:
      return { type: "reorder", panel, index: Math.floor(r() * 7) - 1 };
    case 5:
      return { type: "activate", panel };
    case 6:
      return sp.length
        ? (() => {
            const p = pick(sp);
            return { type: "resize", splitId: p.id, sizes: p.sizes.map(() => r() * r()) } as DockAction;
          })()
        : { type: "resize", splitId: "x", sizes: [1] };
    case 7:
      return sp.length ? { type: "equalize", splitId: pick(sp).id, index: Math.floor(r() * 4) } : { type: "reset" };
    case 8:
    case 9:
      return { type: "hide", panel };
    case 10:
    case 11:
      return { type: "show", panel };
    case 12:
      return { type: "reveal", panel };
    case 13:
      return stacks.length ? { type: "collapse", stackId: pick(stacks).id } : { type: "reset" };
    case 14:
      return r() < 0.5 ? { type: "preset", preset: pick([...PRESET_IDS]) } : { type: "reset" };
    case 15:
      return pick<DockAction>([
        { type: "saveLayout", name: "L" },
        { type: "applyLayout", id: s.custom.length ? pick(s.custom).id : "c0" },
        { type: "deleteLayout", id: s.custom.length ? pick(s.custom).id : "c0" },
      ]);
    default:
      return { type: "lock", locked: r() < 0.15 };
  }
}

describe("presets", () => {
  it("Classic is transcript left, assistant right, equal, rest hidden", () => {
    const l = presetLayout("classic", DEFAULT_PANELS);
    expect(l.root?.kind).toBe("split");
    const root = l.root as SplitNode;
    expect(root.dir).toBe("row");
    expect(root.sizes).toEqual([0.5, 0.5]);
    expect(panelsOf(root)).toEqual(["transcript", "assistant"]);
    expect(l.hidden).toEqual(DEFAULT_PANELS.filter((p) => p !== "transcript" && p !== "assistant"));
  });

  it.each(PRESET_IDS)("%s is valid and keeps every panel exactly once", (id) => {
    const l = presetLayout(id, DEFAULT_PANELS);
    expect(violations(l, DEFAULT_PANELS)).toEqual([]);
  });

  it("presets work with a reduced or foreign panel set", () => {
    for (const known of [["transcript"], ["assistant", "notes"], ["a", "b", "c"], []]) {
      for (const id of PRESET_IDS) {
        const l = presetLayout(id, known);
        expect(violations(l, known)).toEqual([]);
      }
    }
  });
});

describe("reducer", () => {
  const start = () => initialDockState();
  const stackId = (s: DockState, p: string) => findStackOf(s.layout.root, p)!.id;

  it("docks to the right of a stack and tabs into one", () => {
    let s = start();
    s = dockReducer(s, { type: "show", panel: "notes" });
    expect(panelsOf(s.layout.root)).toContain("notes");
    s = dockReducer(s, {
      type: "dock",
      panel: "notes",
      target: { kind: "stack", stackId: stackId(s, "assistant") },
      zone: "center",
    });
    expect(findStackOf(s.layout.root, "assistant")!.panels).toEqual(["assistant", "notes"]);
    expect(violations(s.layout, DEFAULT_PANELS)).toEqual([]);
  });

  it("docking to a window edge wraps the root", () => {
    let s = start();
    s = dockReducer(s, {
      type: "dock",
      panel: "transcript",
      target: { kind: "edge" },
      zone: "bottom",
    });
    const root = s.layout.root as SplitNode;
    expect(root.dir).toBe("col");
    expect(panelsOf(root.children[1])).toEqual(["transcript"]);
  });

  it("a panel docked onto its own sole stack is a no-op", () => {
    const s = start();
    const next = dockReducer(s, {
      type: "dock",
      panel: "transcript",
      target: { kind: "stack", stackId: stackId(s, "transcript") },
      zone: "left",
    });
    expect(next).toBe(s);
  });

  it("hide then show returns to the last place", () => {
    let s = start();
    s = dockReducer(s, { type: "show", panel: "notes" });
    s = dockReducer(s, {
      type: "dock",
      panel: "notes",
      target: { kind: "stack", stackId: stackId(s, "transcript") },
      zone: "bottom",
    });
    const before = JSON.stringify(
      leaves(s.layout.root).map((x) => x.panels),
    );
    s = dockReducer(s, { type: "hide", panel: "notes" });
    expect(s.layout.hidden).toContain("notes");
    s = dockReducer(s, { type: "show", panel: "notes" });
    expect(JSON.stringify(leaves(s.layout.root).map((x) => x.panels))).toBe(before);
    expect(violations(s.layout, DEFAULT_PANELS)).toEqual([]);
  });

  it("hide of a tabbed panel returns to its tab slot", () => {
    let s = dockReducer(start(), { type: "preset", preset: "everything" });
    const st = findStackOf(s.layout.root, "notes")!;
    const idx = st.panels.indexOf("bookmarks");
    s = dockReducer(s, { type: "hide", panel: "bookmarks" });
    s = dockReducer(s, { type: "show", panel: "bookmarks" });
    expect(findStackOf(s.layout.root, "bookmarks")!.panels.indexOf("bookmarks")).toBe(idx);
  });

  it("can hide every panel and bring one back", () => {
    let s = start();
    for (const p of ["transcript", "assistant"]) s = dockReducer(s, { type: "hide", panel: p });
    expect(s.layout.root).toBeNull();
    s = dockReducer(s, { type: "show", panel: "assistant" });
    expect(panelsOf(s.layout.root)).toEqual(["assistant"]);
  });

  it("reorder moves tabs", () => {
    let s = dockReducer(start(), { type: "preset", preset: "everything" });
    const before = findStackOf(s.layout.root, "notes")!.panels.slice();
    s = dockReducer(s, { type: "reorder", panel: "stats", index: 0 });
    const after = findStackOf(s.layout.root, "notes")!.panels;
    expect(after[0]).toBe("stats");
    expect([...after].sort()).toEqual([...before].sort());
  });

  it("lock blocks moving and re-arranging but not showing, hiding, collapsing or revealing", () => {
    let s = dockReducer(start(), { type: "lock", locked: true });
    expect(dockReducer(s, { type: "preset", preset: "focus" })).toBe(s);
    expect(dockReducer(s, { type: "reset" })).toBe(s);
    const hidden = dockReducer(s, { type: "hide", panel: "transcript" });
    expect(hidden.layout.hidden).toContain("transcript");
    expect(dockReducer(hidden, { type: "show", panel: "transcript" }).layout.hidden).not.toContain("transcript");
    const c = dockReducer(s, { type: "collapse", stackId: stackId(s, "transcript"), collapsed: true });
    expect(findStackOf(c.layout.root, "transcript")!.collapsed).toBe(true);
    s = dockReducer(s, { type: "reveal", panel: "notes" });
    expect(panelsOf(s.layout.root)).toContain("notes");
  });

  it("collapse is refused on the root stack, and activate expands", () => {
    let s = dockReducer(start(), { type: "hide", panel: "assistant" });
    const only = s.layout.root!;
    expect(dockReducer(s, { type: "collapse", stackId: only.id })).toBe(s);
    s = dockReducer(start(), { type: "collapse", stackId: stackId(start(), "transcript") });
    s = dockReducer(s, { type: "collapse", stackId: findStackOf(s.layout.root, "transcript")!.id });
    expect(violations(s.layout, DEFAULT_PANELS)).toEqual([]);
  });

  it("collapsing every child of a split keeps one open", () => {
    let s = start();
    const a = stackId(s, "transcript");
    const b = stackId(s, "assistant");
    s = dockReducer(s, { type: "collapse", stackId: a, collapsed: true });
    s = dockReducer(s, { type: "collapse", stackId: b, collapsed: true });
    const open = leaves(s.layout.root).filter((x) => !x.collapsed);
    expect(open.length).toBeGreaterThan(0);
  });

  it("saves, renames, applies and deletes custom layouts", () => {
    let s = dockReducer(start(), { type: "preset", preset: "notes" });
    s = dockReducer(s, { type: "saveLayout", name: "  Interview  " });
    expect(s.custom[0].name).toBe("Interview");
    s = dockReducer(s, { type: "preset", preset: "focus" });
    s = dockReducer(s, { type: "applyLayout", id: s.custom[0].id });
    expect(panelsOf(s.layout.root)).toContain("notes");
    s = dockReducer(s, { type: "renameLayout", id: s.custom[0].id, name: "Panel" });
    expect(s.custom[0].name).toBe("Panel");
    s = dockReducer(s, { type: "deleteLayout", id: s.custom[0].id });
    expect(s.custom).toHaveLength(0);
  });

  it("moveOptions only offers valid moves", () => {
    const s = dockReducer(start(), { type: "preset", preset: "everything" });
    const opts = moveOptions(s.layout, "stats", (p) => p);
    expect(opts.length).toBeGreaterThan(8);
    for (const o of opts) {
      const next = dockReducer(s, o.action);
      expect(violations(next.layout, DEFAULT_PANELS)).toEqual([]);
    }
  });
});

describe("property: random operations", () => {
  it.each([1, 2, 3, 4, 5, 6])("seed %i keeps every invariant over 1500 ops", (seed) => {
    const r = rng(seed * 7919);
    let s = initialDockState();
    for (let i = 0; i < 1500; i++) {
      const a = randomAction(s, r);
      const next = dockReducer(s, a);
      const v = violations(next.layout, DEFAULT_PANELS);
      if (v.length) throw new Error(`op ${i} ${JSON.stringify(a)} -> ${v.join("; ")}`);
      expect(allPanels(next.layout).slice().sort()).toEqual(DEFAULT_PANELS.slice().sort());
      if (i % 25 === 0) {
        const again = sanitizeState(JSON.parse(JSON.stringify(next)), DEFAULT_PANELS);
        expect(again).toEqual(next);
      }
      s = next;
    }
  });
});

describe("sanitize", () => {
  const known = DEFAULT_PANELS;
  it("round-trips a valid layout exactly", () => {
    const l = presetLayout("everything", known);
    expect(sanitizeLayout(JSON.parse(JSON.stringify(l)), known)).toEqual(l);
  });

  it.each([
    ["null", null],
    ["number", 7],
    ["string", "x"],
    ["array", []],
    ["empty object", {}],
    ["bad root", { root: { kind: "weird" }, hidden: [] }],
    ["split without children", { root: { kind: "split", children: [] } }],
    ["cyclic-ish depth", { root: JSON.parse("{\"kind\":\"split\",\"children\":[".repeat(30) + "]}".repeat(30)) }],
  ])("garbage %s falls back to Classic", (_n, json) => {
    const l = sanitizeLayout(json, known);
    expect(violations(l, known)).toEqual([]);
    expect(panelsOf(l.root)).toEqual(["transcript", "assistant"]);
  });

  it("drops unknown panels, dedupes, adds missing ones hidden, fixes sizes", () => {
    const l = sanitizeLayout(
      {
        root: {
          kind: "split",
          dir: "row",
          sizes: [5, -1, "x"],
          children: [
            { kind: "stack", panels: ["transcript", "transcript", "bogus"], active: "bogus" },
            { kind: "stack", panels: ["assistant", 4] },
            { kind: "stack", panels: ["bogus"] },
          ],
        },
        hidden: ["transcript", "notes", "other"],
        locked: "yes",
      },
      known,
    );
    expect(violations(l, known)).toEqual([]);
    expect(panelsOf(l.root)).toEqual(["transcript", "assistant"]);
    expect(l.hidden).toContain("notes");
    expect(l.locked).toBe(false);
  });

  it("an old layout missing new panels still loads", () => {
    const old = presetLayout("classic", ["transcript", "assistant"]);
    const l = sanitizeLayout(JSON.parse(JSON.stringify(old)), known);
    expect(violations(l, known)).toEqual([]);
    expect(l.hidden).toContain("notes");
  });

  it("sanitizeState survives garbage custom entries", () => {
    const s = sanitizeState({ layout: null, custom: [1, { id: 3 }, { id: "c2", name: "A", layout: 5 }] }, known);
    expect(violations(s.layout, known)).toEqual([]);
    expect(s.custom).toHaveLength(1);
    expect(s.customSeq).toBe(2);
  });

  it("a deleted saved layout comes back where it was (undo), once", () => {
    let st = dockReducer(initialDockState(DEFAULT_PANELS), { type: "saveLayout", name: "A" });
    st = dockReducer(st, { type: "saveLayout", name: "B" });
    const first = st.custom[0];
    const del = dockReducer(st, { type: "deleteLayout", id: first.id });
    expect(del.custom.map((c) => c.name)).toEqual(["B"]);
    const back = dockReducer(del, { type: "restoreLayout", saved: first, index: 0 });
    expect(back.custom.map((c) => c.name)).toEqual(["A", "B"]);
    expect(dockReducer(back, { type: "restoreLayout", saved: first, index: 0 })).toBe(back);
  });
});
