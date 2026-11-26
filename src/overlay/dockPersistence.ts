import {
  type DockState,
  type PanelId,
  dockReducer,
  initialDockState,
  sanitizeState,
} from "./dock";

/** The saved layout, or Classic when nothing usable was saved (corrupt data never throws). */
export function readDock(known: PanelId[], saved: unknown): DockState {
  if (saved === null || saved === undefined) return initialDockState(known);
  try {
    return sanitizeState(saved, known);
  } catch {
    return initialDockState(known);
  }
}

/**
 * A new meeting hides the panels the last one opened on the fly (Stats, Bookmarks,
 * Call log, Dev log via their keys or buttons), so Classic looks like today's window
 * at the start of every meeting. The arrangement itself is never touched, and a lock
 * does not keep these closed panels open.
 */
export function hideTransient(state: DockState, transient: PanelId[]): DockState {
  let next = state;
  for (const panel of transient) {
    if (next.layout.hidden.includes(panel)) continue;
    const wasLocked = next.layout.locked;
    const open: DockState = wasLocked ? { ...next, layout: { ...next.layout, locked: false } } : next;
    const hidden = dockReducer(open, { type: "hide", panel });
    next = wasLocked ? { ...hidden, layout: { ...hidden.layout, locked: true } } : hidden;
  }
  return next;
}
