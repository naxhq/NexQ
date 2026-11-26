import { describe, expect, it } from "vitest";
import {
  DEFAULT_PANELS,
  DRAG_NOTE_LIMIT,
  PRESET_IDS,
  allPanels,
  dockReducer,
  dropLabel,
  findStackOf,
  initialDockState,
  leaves,
  parentOf,
  panelsOf,
  showDragNote,
  type DockAction,
  type DockState,
  type PanelId,
  type Zone,
  visibleDropLabel,
} from "./layoutModel";
import { computeGeometry } from "./layoutGeometry";

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

const title = (id: PanelId) => id;
const ZONES: Zone[] = ["left", "right", "top", "bottom", "center"];

function randomState(seed: number): DockState {
  const r = rng(seed);
  let s = initialDockState(DEFAULT_PANELS);
  const known = allPanels(s.layout);
  for (let i = 0; i < 25; i++) {
    const p = known[Math.floor(r() * known.length)];
    const x = r();
    let a: DockAction;
    if (x < 0.25) a = { type: "hide", panel: p };
    else if (x < 0.5) a = { type: "show", panel: p };
    else if (x < 0.55) a = { type: "preset", preset: PRESET_IDS[Math.floor(r() * PRESET_IDS.length)] };
    else {
      const docked = leaves(s.layout.root);
      if (!docked.length) continue;
      const t = docked[Math.floor(r() * docked.length)];
      a = { type: "dock", panel: p, target: { kind: "stack", stackId: t.id }, zone: ZONES[Math.floor(r() * 5)] };
    }
    s = dockReducer(s, a);
  }
  return s;
}

const kinds = new Set<string>();
let total = 0;

describe("the label shown while dragging says where the panel really ends up", () => {
  for (let seed = 1; seed <= 25; seed++) {
    it(`random layout ${seed}: every stack zone and every window edge`, () => {
      const s = randomState(seed);
      const root = s.layout.root;
      if (!root) return;
      const docked = panelsOf(root);
      let checked = 0;
      for (const P of docked) {
        const targets: Array<{ target: { kind: "stack"; stackId: string } | { kind: "edge" }; zone: Zone }> = [];
        for (const t of leaves(root)) for (const z of ZONES) targets.push({ target: { kind: "stack", stackId: t.id }, zone: z });
        if (docked.length > 1) for (const z of ["left", "right", "top", "bottom"] as Zone[]) targets.push({ target: { kind: "edge" }, zone: z });
        for (const to of targets) {
          const before = s.layout;
          const label = dropLabel(before, to, P, title);
          const next = dockReducer(s, { type: "dock", panel: P, target: to.target, zone: to.zone });
          if (next === s) continue; // the model refuses it: the pointer shows "No change here" there
          const after = next.layout;
          const mine = findStackOf(after.root, P)!;
          checked++;
          total++;
          kinds.add(to.target.kind === "edge" ? `${to.zone} edge` : to.zone === "center" ? (label === "Reorder" ? "Reorder" : "Tab") : to.zone);
          if (to.target.kind === "edge") {
            const dir = to.zone === "left" || to.zone === "right" ? "row" : "col";
            expect(after.root!.kind).toBe("split");
            const rs = after.root as { kind: "split"; dir: string; children: Array<{ id: string; kind: string }> };
            expect(rs.dir).toBe(dir);
            const idx = rs.children.findIndex((c) => c.id === mine.id || (c.kind === "split" && panelsOf(c as never).includes(P)));
            expect(idx).toBe(to.zone === "left" || to.zone === "top" ? 0 : rs.children.length - 1);
            expect(label).toBe({ left: "Left edge of the window", right: "Right edge of the window", top: "Top edge of the window", bottom: "Bottom edge of the window", center: "Window" }[to.zone]);
            continue;
          }
          const T = leaves(before.root).find((l) => l.id === (to.target as { stackId: string }).stackId)!;
          const A = T.active !== P ? T.active : (T.panels.find((x) => x !== P) ?? T.active);
          if (to.zone === "center") {
            if (mine.panels.includes(A) && findStackOf(before.root, P)!.id === T.id) expect(label).toBe("Reorder");
            else {
              expect(label).toBe(`Tab in ${A}`);
              expect(mine.panels).toContain(A);
              expect(mine.panels).toContain(P);
            }
            continue;
          }
          const stackA = findStackOf(after.root, A)!;
          const pm = parentOf(after.root, mine.id);
          const pa = parentOf(after.root, stackA.id);
          expect(pm && pa && pm.parent.id === pa.parent.id).toBe(true);
          const dir = to.zone === "left" || to.zone === "right" ? "row" : "col";
          expect(pm!.parent.dir).toBe(dir);
          const delta = to.zone === "left" || to.zone === "top" ? -1 : 1;
          expect(pm!.index - pa!.index).toBe(delta);
          expect(label).toBe({ left: `Left of ${A}`, right: `Right of ${A}`, top: `Above ${A}`, bottom: `Below ${A}` }[to.zone as "left"]);
        }
      }
      if (docked.length > 1) expect(checked).toBeGreaterThan(0);
    });
  }

  it("exercised every kind of drop, many times (so the checks above cannot be vacuous)", () => {
    expect(total).toBeGreaterThan(500);
    for (const k of ["left", "right", "top", "bottom", "Tab", "Reorder", "left edge", "right edge", "top edge", "bottom edge"]) {
      expect([...kinds], k).toContain(k);
    }
  });

  it("nothing under the pointer says so", () => {
    expect(dropLabel(initialDockState(DEFAULT_PANELS).layout, null, "transcript", title)).toBe("No change here");
  });
});

describe("the first few drags carry a note", () => {
  it("shows for the first five successful drags only", () => {
    expect(showDragNote(undefined)).toBe(true);
    expect(showDragNote(0)).toBe(true);
    expect(showDragNote(DRAG_NOTE_LIMIT - 1)).toBe(true);
    expect(showDragNote(DRAG_NOTE_LIMIT)).toBe(false);
  });

  it("counts through the reducer, survives a save and load, and Escape (no action) does not count", () => {
    let s = initialDockState(DEFAULT_PANELS);
    for (let i = 0; i < 4; i++) s = dockReducer(s, { type: "countDrag" });
    expect(s.drags).toBe(4);
    s = dockReducer(s, { type: "preset", preset: "focus" });
    expect(s.drags).toBe(4);
    const saved = JSON.parse(JSON.stringify(s));
    expect(showDragNote(saved.drags)).toBe(true);
    s = dockReducer(s, { type: "countDrag" });
    expect(showDragNote(s.drags)).toBe(false);
  });
});

describe("in a small window the words describe what will be seen there", () => {
  const SIZES: Array<[number, number]> = [
    [420, 480],
    [500, 700],
    [900, 700],
    [1400, 900],
  ];
  let stackedSeen = 0;
  let checked = 0;
  for (const [w, h] of SIZES) {
    for (let seed = 1; seed <= 15; seed++) {
      it(`${w}x${h}, random layout ${seed}`, () => {
        const s = randomState(seed * 31 + w);
        const root = s.layout.root;
        if (!root) return;
        const docked = panelsOf(root);
        for (const P of docked) {
          const targets: Array<{ target: { kind: "stack"; stackId: string } | { kind: "edge" }; zone: Zone }> = [];
          for (const t of leaves(root)) for (const z of ZONES) targets.push({ target: { kind: "stack", stackId: t.id }, zone: z });
          if (docked.length > 1) for (const z of ["left", "right", "top", "bottom"] as Zone[]) targets.push({ target: { kind: "edge" }, zone: z });
          for (const to of targets) {
            const label = visibleDropLabel(s.layout, to, P, title, { w, h }, {});
            const next = dockReducer(s, { type: "dock", panel: P, target: to.target, zone: to.zone });
            if (next === s) {
              expect(label).toBe("No change here");
              continue;
            }
            checked++;
            const g = computeGeometry(next.layout, { w, h }, {});
            const mine = g.panels[P];
            if (!mine || !mine.visible && g.compact === false) continue;
            const r = mine.rect;
            if (label.includes("(window too small to split)")) {
              // merged into tabs: its group holds other panels
              expect(g.stacks.find((x) => x.id === mine.stackId)!.panels.length).toBeGreaterThan(1);
              continue;
            }
            if (label.endsWith("(stacked here)")) stackedSeen++;
            const m = /^(Left of|Right of|Above|Below) (.+?)( \(stacked here\))?$/.exec(label);
            if (m) {
              const a = g.panels[m[2]];
              expect(a, label).toBeTruthy();
              const A = a.rect;
              const rel =
                m[1] === "Left of" ? r.x + r.w <= A.x + 1 : m[1] === "Right of" ? r.x >= A.x + A.w - 1 : m[1] === "Above" ? r.y + r.h <= A.y + 1 : r.y >= A.y + A.h - 1;
              expect(rel, `${label} in ${w}x${h}`).toBe(true);
              continue;
            }
            const e = /^(Left|Right|Top|Bottom) edge of the window/.exec(label);
            if (e) {
              const inner = g.inner;
              const full = r.w >= inner.w - 2;
              const where = full ? (r.y <= inner.y + 1 ? "Top" : "Bottom") : r.x <= inner.x + 1 ? "Left" : "Right";
              expect(where, `${label} in ${w}x${h}`).toBe(e[1]);
            }
          }
        }
      });
    }
  }
  it("a narrow window really does say 'stacked here' for some drops (so the checks cannot be vacuous)", () => {
    expect(checked).toBeGreaterThan(500);
    expect(stackedSeen).toBeGreaterThan(0);
  });
});
