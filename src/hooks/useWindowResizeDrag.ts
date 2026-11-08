import { useCallback, useEffect, useRef } from "react";
import type React from "react";
import { getCurrentWindow, LogicalPosition, LogicalSize } from "@tauri-apps/api/window";
import { resizeRect, type Rect, type ResizeEdge, type Size } from "../lib/resizeRect";

interface Drag {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  /** The window's rect when the drag began; null until it has been read. */
  start: Rect | null;
  /** The rect last sent to the window, so unchanged moves send nothing. */
  applied: Rect | null;
  frame: number;
}

/**
 * Resize the current window by dragging one of its edges, for windows whose
 * native resizing is off (the macOS overlay under stealth: see
 * `sync_macos` in stealth_commands.rs). Pointer moves are batched to one
 * window update per animation frame.
 */
export function useWindowResizeDrag(edge: ResizeEdge, min: Size) {
  const drag = useRef<Drag | null>(null);

  const apply = useCallback(() => {
    const d = drag.current;
    if (!d) return;
    d.frame = 0;
    if (!d.start) return;
    const next = resizeRect(d.start, edge, d.lastX - d.startX, d.lastY - d.startY, min);
    const prev = d.applied ?? d.start;
    const win = getCurrentWindow();
    if (next.x !== prev.x || next.y !== prev.y) {
      win.setPosition(new LogicalPosition(next.x, next.y)).catch(() => {});
    }
    if (next.width !== prev.width || next.height !== prev.height) {
      win.setSize(new LogicalSize(next.width, next.height)).catch(() => {});
    }
    d.applied = next;
  }, [edge, min]);

  const schedule = useCallback(() => {
    const d = drag.current;
    if (d && !d.frame) d.frame = requestAnimationFrame(apply);
  }, [apply]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      const d: Drag = {
        pointerId: e.pointerId,
        startX: e.screenX,
        startY: e.screenY,
        lastX: e.screenX,
        lastY: e.screenY,
        start: null,
        applied: null,
        frame: 0,
      };
      drag.current = d;
      // Screen coordinates are stable while the window moves under the
      // pointer, unlike client coordinates.
      const win = getCurrentWindow();
      Promise.all([win.scaleFactor(), win.outerPosition(), win.innerSize()])
        .then(([scale, pos, size]) => {
          if (drag.current !== d) return;
          const p = pos.toLogical(scale);
          const s = size.toLogical(scale);
          d.start = { x: p.x, y: p.y, width: s.width, height: s.height };
          schedule();
        })
        .catch(() => {
          if (drag.current === d) drag.current = null;
        });
    },
    [schedule],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointerId) return;
      d.lastX = e.screenX;
      d.lastY = e.screenY;
      schedule();
    },
    [schedule],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointerId) return;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      if (d.frame) cancelAnimationFrame(d.frame);
      d.lastX = e.screenX;
      d.lastY = e.screenY;
      apply();
      drag.current = null;
    },
    [apply],
  );

  useEffect(
    () => () => {
      if (drag.current?.frame) cancelAnimationFrame(drag.current.frame);
      drag.current = null;
    },
    [],
  );

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp };
}
