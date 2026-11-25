import { computeGeometry, type PanelMeta, type Rect } from "./layoutGeometry";
import { dockReducer } from "./layoutReducer";
import { dropLabel, targetPanel, type DropTargetLike } from "./dropLabel";
import type { DockState, Layout, PanelId } from "./layoutTree";

const rectOf = (g: ReturnType<typeof computeGeometry>, p: PanelId): Rect | null => g.panels[p]?.rect ?? null;

/**
 * What the drop will look like in THIS window. A small window cannot always put panels side by side, so
 * "Right of Transcript" may be drawn below it, or as tabs: the words describe what will be seen, taken
 * from the geometry the layout will have after the drop (the same code that draws it).
 */
export function visibleDropLabel(
  layout: Layout,
  to: DropTargetLike | null,
  panel: PanelId,
  title: (id: PanelId) => string,
  size: { w: number; h: number },
  metas: Record<PanelId, PanelMeta>,
): string {
  if (!to) return "No change here";
  const base = dropLabel(layout, to, panel, title);
  const state: DockState = { layout, custom: [], customSeq: 0 };
  const next = dockReducer(state, { type: "dock", panel, target: to.target, zone: to.zone });
  if (next === state) return "No change here";
  const g = computeGeometry(next.layout, size, metas);
  const mine = g.panels[panel];
  if (!mine) return base;
  const inner = g.inner;
  const r = mine.rect;

  if (to.target.kind === "edge") {
    const stacked = g.stacks.find((s) => s.id === mine.stackId);
    if (stacked?.virtual) return "Tab with the other panels (window too small to split)";
    const full = r.w >= inner.w - 2;
    const edge = full ? (r.y <= inner.y + 1 ? "top" : "bottom") : r.x <= inner.x + 1 ? "left" : "right";
    const words = { left: "Left edge of the window", right: "Right edge of the window", top: "Top edge of the window", bottom: "Bottom edge of the window" } as const;
    return edge === to.zone ? base : `${words[edge]} (stacked here)`;
  }

  if (to.zone === "center") return base;
  const A = targetPanel(layout, to, panel);
  const other = A ? g.panels[A] : null;
  const a = A ? rectOf(g, A) : null;
  if (!A || !other || !a) return base;
  const name = title(A);
  if (other.stackId === mine.stackId) return `Tab in ${name} (window too small to split)`;
  const seen =
    r.x + r.w <= a.x + 1 ? "left" : r.x >= a.x + a.w - 1 ? "right" : r.y + r.h <= a.y + 1 ? "top" : r.y >= a.y + a.h - 1 ? "bottom" : null;
  if (!seen) return base;
  if (seen === to.zone) return base;
  const words = { left: `Left of ${name}`, right: `Right of ${name}`, top: `Above ${name}`, bottom: `Below ${name}` } as const;
  return `${words[seen]} (stacked here)`;
}
