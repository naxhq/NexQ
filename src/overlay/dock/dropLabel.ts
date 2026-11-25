import { findStackOf, type Layout, type PanelId, type Zone } from "./layoutTree";

/** Where a drop would land: the same object the highlight is drawn from. */
export interface DropTargetLike {
  target: { kind: "stack"; stackId: string } | { kind: "edge" };
  zone: Zone;
}

/** A drop of the panel on `to`: null means nothing is under the pointer (or it would change nothing). */
export function dropLabel(
  layout: Layout,
  to: DropTargetLike | null,
  panel: PanelId,
  title: (id: PanelId) => string,
): string {
  if (!to) return "No change here";
  if (to.target.kind === "edge") {
    return { left: "Left edge of the window", right: "Right edge of the window", top: "Top edge of the window", bottom: "Bottom edge of the window", center: "Window" }[to.zone];
  }
  const stackId = to.target.stackId;
  const stack = findStackOf(layout.root, panel);
  const into = leafById(layout, stackId);
  const stays = targetPanel(layout, to, panel);
  const name = stays ? title(stays) : "panel";
  if (to.zone === "center") return stack && stack.id === stackId ? "Reorder" : `Tab in ${name}`;
  return { left: `Left of ${name}`, right: `Right of ${name}`, top: `Above ${name}`, bottom: `Below ${name}` }[to.zone];
}

function leafById(layout: Layout, id: string) {
  const walk = (n: Layout["root"]): ReturnType<typeof findStackOf> => {
    if (!n) return undefined;
    if (n.kind === "stack") return n.id === id ? n : undefined;
    for (const c of n.children) {
      const r = walk(c);
      if (r) return r;
    }
    return undefined;
  };
  return walk(layout.root);
}

/** The first few successful drags carry a short note; after that only the chip. */
export const DRAG_NOTE_LIMIT = 5;
export const showDragNote = (drags: number | undefined): boolean => (drags ?? 0) < DRAG_NOTE_LIMIT;

/** The panel a drop is "of": beside the stack the panel is in, it is one that stays, not the one being moved. */
export function targetPanel(layout: Layout, to: DropTargetLike, panel: PanelId): PanelId | null {
  if (to.target.kind !== "stack") return null;
  const into = leafById(layout, to.target.stackId);
  if (!into) return null;
  return into.active !== panel ? into.active : (into.panels.find((p) => p !== panel) ?? into.active);
}
