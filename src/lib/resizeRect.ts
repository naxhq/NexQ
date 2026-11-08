/** A window edge or corner the user can drag to resize. */
export type ResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/** A window rectangle in logical pixels (top-left origin). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/**
 * The window rectangle after dragging `edge` by (`dx`, `dy`) from `start`,
 * never smaller than `min`. Dragging a north or west edge moves the window's
 * origin so the opposite edge stays where it was, as native resizing does.
 */
export function resizeRect(start: Rect, edge: ResizeEdge, dx: number, dy: number, min: Size): Rect {
  const north = edge === "n" || edge === "ne" || edge === "nw";
  const south = edge === "s" || edge === "se" || edge === "sw";
  const east = edge === "e" || edge === "ne" || edge === "se";
  const west = edge === "w" || edge === "nw" || edge === "sw";

  let { x, y, width, height } = start;
  if (east) width = Math.max(min.width, start.width + dx);
  if (west) {
    width = Math.max(min.width, start.width - dx);
    x = start.x + start.width - width;
  }
  if (south) height = Math.max(min.height, start.height + dy);
  if (north) {
    height = Math.max(min.height, start.height - dy);
    y = start.y + start.height - height;
  }
  return { x, y, width, height };
}
