import { useEffect } from "react";
import {
  availableMonitors,
  currentMonitor,
  getCurrentWindow,
  primaryMonitor,
  PhysicalPosition,
  PhysicalSize,
  type Monitor,
} from "@tauri-apps/api/window";
import { useConfigStore } from "../stores/configStore";
import { startPlacement, type PlacementController, type PlacementWindow } from "../lib/placementController";
import type { MonitorLike, PlacementOptions } from "../lib/windowPlacement";

/** Limits of each window (tauri.conf.json): the minimum size and the frame around the content. */
export const PLACEMENT_OPTIONS: Record<"launcher" | "overlay", PlacementOptions> = {
  launcher: { minW: 700, minH: 500, chromeW: 16, chromeH: 40 },
  overlay: { minW: 400, minH: 480 },
};

function isManaged(label: string): label is "launcher" | "overlay" {
  return label === "launcher" || label === "overlay";
}

export const toMonitorLike = (m: Monitor): MonitorLike => ({
  scaleFactor: m.scaleFactor,
  position: { x: m.position.x, y: m.position.y },
  size: { width: m.size.width, height: m.size.height },
  workArea: m.workArea
    ? { position: { x: m.workArea.position.x, y: m.workArea.position.y }, size: { width: m.workArea.size.width, height: m.workArea.size.height } }
    : undefined,
});

/** The current Tauri window, as the controller (and the reset command) move it. */
export function tauriPlacementWindow(): PlacementWindow {
  const win = getCurrentWindow();
  return {
    monitors: async () => (await availableMonitors()).map(toMonitorLike),
    primary: async () => {
      const m = await primaryMonitor();
      return m ? toMonitorLike(m) : null;
    },
    current: async () => {
      const m = await currentMonitor();
      return m ? toMonitorLike(m) : null;
    },
    isVisible: () => win.isVisible(),
    isMinimized: () => win.isMinimized(),
    isMaximized: () => win.isMaximized(),
    setPosition: (x, y) => win.setPosition(new PhysicalPosition(x, y)),
    setSize: (w, h) => win.setSize(new PhysicalSize(w, h)),
    outerPosition: async () => {
      const p = await win.outerPosition();
      return { x: p.x, y: p.y };
    },
    innerSize: async () => {
      const s = await win.innerSize();
      return { w: s.width, h: s.height };
    },
    scaleFactor: () => win.scaleFactor(),
    maximize: () => win.maximize(),
    show: () => win.show(),
    onMoved: (cb) => win.onMoved(cb),
    onResized: (cb) => win.onResized(cb),
    onScaleChanged: (cb) => win.onScaleChanged(cb),
  };
}

let active: PlacementController | null = null;
/** Windows (by label) already put back in this page: demo mode ending must not move them again. */
const restoredLabels = new Set<string>();

/** Save the place now (before an update restarts the app, a quit, the end of a meeting). */
export async function flushWindowPlacement(): Promise<void> {
  await active?.flush().catch(() => {});
}

/**
 * Remember the window's size, place and maximised state per monitor setup, and put it back.
 * The launcher starts hidden (tauri.conf.json) and is shown after the restore, so it never appears at
 * the default size and then jumps; the overlay is restored while still hidden. Demo mode (`paused`)
 * neither restores nor saves. Details: `startPlacement`.
 */
export function useWindowPlacement(label: string, opts: { enabled?: boolean; paused?: boolean } = {}) {
  const { enabled = true, paused = false } = opts;

  useEffect(() => {
    if (!enabled || paused || !isManaged(label)) return;
    const options = PLACEMENT_OPTIONS[label];
    const setupsKey = label === "launcher" ? "launcherSetups" : "overlaySetups";
    const legacyKey = label === "launcher" ? "launcherPlacement" : "overlayPlacement";
    const controller = startPlacement({
      label,
      win: tauriPlacementWindow(),
      options,
      showAfterRestore: label === "launcher",
      restoreFirst: !restoredLabels.has(label),
      store: {
        entries: () => useConfigStore.getState()[setupsKey],
        legacy: () => useConfigStore.getState()[legacyKey],
        save: (entries, latest) => useConfigStore.getState().setWindowSetups(label, entries, latest),
      },
    });
    restoredLabels.add(label);
    active = controller;
    const flush = () => void controller.flush();
    const onHidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener("blur", flush);
    // Coming back to a window: a monitor change or a pending maximise is looked at now, not at the next poll.
    const recheck = () => void controller.check();
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", onHidden);
    const unlisten: Array<() => void> = [];
    let gone = false;
    import("@tauri-apps/api/event")
      .then(({ listen }) => listen("nexq:meeting_ended", flush))
      .then((fn) => (gone ? fn() : unlisten.push(fn)))
      .catch(() => {});
    return () => {
      gone = true;
      flush();
      controller.stop();
      if (active === controller) active = null;
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("blur", flush);
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", onHidden);
      unlisten.forEach((fn) => fn());
    };
  }, [label, enabled, paused]);
}

/** For tests: forget which windows were already put back in this page. */
export function resetPlacementMemory(): void {
  restoredLabels.clear();
}
