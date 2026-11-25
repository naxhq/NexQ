import { describe, expect, it } from "vitest";
import { computeGeometry } from "./layoutGeometry";
import { DEFAULT_PANELS, dockReducer, initialDockState } from "./layoutModel";

// Classic with Notes shown: transcript | assistant | notes.
const three = dockReducer(initialDockState(DEFAULT_PANELS), { type: "show", panel: "notes" }).layout;

/** "transcript@12,10,476x231 | assistant+notes@..." for reading what a size does. */
function describeAt(w: number, h: number): string[] {
  const g = computeGeometry(three, { w, h });
  return g.stacks.map((s) => `${s.panels.join("+")} ${s.rect.w}x${s.rect.h}`);
}

describe("three panels at the sizes the meeting window really has", () => {
  const table: Array<[number, number, string]> = [
    // too short for three rows and too narrow for columns: two areas, two panels tabbed
    [400, 480, "transcript 376x158 | assistant+notes 376x292"],
    // three rows fit
    [500, 700, "transcript 476x231 | assistant 476x231 | notes 476x198"],
    [620, 700, "transcript 596x231 | assistant 596x231 | notes 596x198"],
    // three columns fit
    [900, 700, "transcript 300x680 | assistant 299x680 | notes 257x680"],
  ];
  it.each(table)("%ix%i", (w, h, expected) => {
    expect(describeAt(w, h).join(" | ")).toBe(expected);
  });

  it("only gives up to one stack when even two areas do not fit", () => {
    expect(describeAt(300, 200)).toHaveLength(1);
  });

  it("the tabbed pair shows the focused panel and is marked virtual", () => {
    const g = computeGeometry(three, { w: 400, h: 480 }, {}, undefined, "notes");
    const tabbed = g.stacks.find((s) => s.panels.length === 2)!;
    expect(tabbed.virtual).toBe(true);
    expect(g.panels.notes.visible).toBe(true);
    expect(g.panels.assistant.visible).toBe(false);
    expect(g.compact).toBe(true);
  });
});
