import type { CSSProperties } from "react";
import type { DropHit, Rect, SepGeo } from "./layoutGeometry";
import { findNode, type Layout, type PanelId } from "./layoutModel";

export const rectStyle = (r: Rect): CSSProperties => ({
  transform: `translate3d(${r.x}px, ${r.y}px, 0)`,
  width: r.w,
  height: r.h,
});

export const DRAG_THRESHOLD = 6;
export const KEY_STEP = 16;
export const KEY_STEP_BIG = 64;

export function setRect(el: HTMLElement | null, r: Rect) {
  if (!el) return;
  el.style.transform = `translate3d(${r.x}px, ${r.y}px, 0)`;
  el.style.width = `${r.w}px`;
  el.style.height = `${r.h}px`;
}

export function withSizes(layout: Layout, splitId: string, sizes: number[]): Layout {
  const l = JSON.parse(JSON.stringify(layout)) as Layout;
  const n = findNode(l.root, splitId);
  if (n && n.kind === "split") n.sizes = sizes;
  return l;
}

export type TabDrag = {
  kind: "tab";
  panel: PanelId;
  pointerId: number;
  sx: number;
  sy: number;
  started: boolean;
  /** The chip's words were set once for this drag. */
  said?: boolean;
  hit: DropHit | null;
  index?: number;
};
export type SepDrag = {
  kind: "sep";
  sep: SepGeo;
  pointerId: number;
  start: number;
  snaps: number[];
  sizes: number[] | null;
};

