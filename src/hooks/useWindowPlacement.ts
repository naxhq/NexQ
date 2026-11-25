import { useEffect, useRef } from "react";
import {
  availableMonitors,
  currentMonitor,
  getCurrentWindow,
  primaryMonitor,
  PhysicalPosition,
  PhysicalSize,
} from "@tauri-apps/api/window";
import { useConfigStore } from "../stores/configStore";
import {
  areaOf,
  defaultLauncherRect,
  resolvePlacement,
  samePlacement,
  snapshotPlacement,
  type PlacementOptions,
  type Rect,
  type WindowPlacement,
} from "../lib/windowPlacement";

/** Limits of each window (tauri.conf.json): the minimum size and the frame around the content. */
const OPTIONS: Record<"launcher" | "overlay", PlacementOptions> = {
  launcher: { minW: 700, minH: 500, chromeW: 16, chromeH: 40 },
  overlay: { minW: 400, minH: 480 },
};

const SAVE_DELAY_MS = 600;

function isManaged(label: string): label is "launcher" | "overlay" {
  return label === "launcher" || label === "overlay";
}

/**
 * Remember the window's size and place, and put it back after a restart.
 *
 * - Restores once, as soon as the config is loaded (the overlay is still hidden then),
 *   onto a connected monitor's work area. A window whose monitor is gone, or that was
 *   off-screen, is centred on the current one. The launcher's first ever size is
 *   min(1180x740, 92% of the work area).
 * - Saves (debounced) after a move or resize, only while the window is visible and neither
 *   minimised nor maximised. It never reads or writes anything but size and position, so it
 *   cannot change a hidden window's display affinity (that leaves a ghost frame).
 * - `paused` (demo mode) neither restores nor saves.
 */
export function useWindowPlacement(label: string, opts: { enabled?: boolean; paused?: boolean } = {}) {
  const { enabled = true, paused = false } = opts;
  const restored = useRef(false);

  useEffect(() => {
    if (!enabled || paused || !isManaged(label)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unlisten: Array<() => void> = [];
    const saved = useConfigStore.getState();
    let last: WindowPlacement | null = label === "launcher" ? saved.launcherPlacement : saved.overlayPlacement;

    const win = getCurrentWindow();
    const o = OPTIONS[label];

    const restore = async () => {
      if (restored.current) return;
      restored.current = true;
      try {
        const monitors = await availableMonitors();
        const areas = monitors.map(areaOf);
        const primary = await primaryMonitor().catch(() => null);
        const current = (await currentMonitor().catch(() => null)) ?? primary;
        const fallback = current ? areaOf(current) : areas[0] ?? null;
        let rect: Rect | null = null;
        if (last) {
          rect = resolvePlacement(last, areas, fallback, o);
        } else if (label === "launcher" && fallback) {
          rect = defaultLauncherRect(fallback, o);
        }
        if (!rect || cancelled) return;
        if ((await win.isMaximized().catch(() => false)) || (await win.isMinimized().catch(() => false))) return;
        await win.setSize(new PhysicalSize(rect.w, rect.h));
        await win.setPosition(new PhysicalPosition(rect.x, rect.y));
      } catch (e) {
        console.warn(`[placement] could not restore the ${label} window:`, e);
      }
    };

    const save = async () => {
      timer = undefined;
      if (cancelled) return;
      try {
        if (!(await win.isVisible()) || (await win.isMinimized()) || (await win.isMaximized())) return;
        const [pos, size, scale] = await Promise.all([win.outerPosition(), win.innerSize(), win.scaleFactor()]);
        const next = snapshotPlacement({ x: pos.x, y: pos.y }, { w: size.width, h: size.height }, scale);
        if (!next || samePlacement(next, last)) return;
        last = next;
        useConfigStore.getState().setWindowPlacement(label, next);
      } catch {
        /* a window being closed: nothing to save */
      }
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(save, SAVE_DELAY_MS);
    };

    (async () => {
      await restore();
      if (cancelled) return;
      for (const sub of [win.onMoved(schedule), win.onResized(schedule)]) {
        sub.then((fn) => (cancelled ? fn() : unlisten.push(fn))).catch(() => {});
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      unlisten.forEach((fn) => fn());
    };
  }, [label, enabled, paused]);
}
