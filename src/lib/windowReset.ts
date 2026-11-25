import { applyRect, areaOf, defaultLauncherRect, type MonitorLike, type PlacementOptions, type Rect, type WorkArea } from "./windowPlacement";

/** Where a window opens after a reset: the launcher as on first start, the overlay at the top right. */
export function resetRect(label: "launcher" | "overlay", area: WorkArea, o: PlacementOptions): Rect {
  if (label === "launcher") return defaultLauncherRect(area, o);
  const margin = Math.round(24 * area.scale);
  const w = Math.min(Math.round(500 * area.scale), area.w - 2 * margin);
  const h = Math.min(Math.round(700 * area.scale), area.h - 2 * margin);
  return { x: area.x + area.w - w - margin, y: area.y + margin, w: Math.max(w, Math.round(o.minW * area.scale)), h: Math.max(h, Math.round(o.minH * area.scale)) };
}

/** The work area of the monitor that contains the point, else the primary, else the first. */
export function areaAt(monitors: MonitorLike[], primary: MonitorLike | null, point: { x: number; y: number } | null): WorkArea | null {
  const areas = monitors.map(areaOf);
  if (point) {
    const hit = areas.find((a) => point.x >= a.x && point.x < a.x + a.w && point.y >= a.y && point.y < a.y + a.h);
    if (hit) return hit;
  }
  return primary ? areaOf(primary) : areas[0] ?? null;
}

/**
 * "Reset window positions": forgets every saved place and puts both windows back on one screen (the one
 * under the mouse, else the primary), un-maximised. For a window lost off-screen. Only size and position.
 */
export async function resetWindowPositions(where: "cursor" | "primary" = "primary"): Promise<boolean> {
  const [{ availableMonitors, primaryMonitor, cursorPosition }, { WebviewWindow }, { useConfigStore }, { toMonitorLike, PLACEMENT_OPTIONS }] = await Promise.all([
    import("@tauri-apps/api/window"),
    import("@tauri-apps/api/webviewWindow"),
    import("../stores/configStore"),
    import("../hooks/useWindowPlacement"),
  ]);
  const monitors = (await availableMonitors()).map(toMonitorLike);
  const primary = await primaryMonitor().then((m) => (m ? toMonitorLike(m) : null)).catch(() => null);
  const cursor = where === "cursor" ? await cursorPosition().then((p) => ({ x: p.x, y: p.y })).catch(() => null) : null;
  const area = areaAt(monitors, primary, cursor);
  if (!area) return false;
  useConfigStore.getState().clearWindowPlacements();
  for (const label of ["launcher", "overlay"] as const) {
    const win = await WebviewWindow.getByLabel(label);
    if (!win) continue;
    const rect = resetRect(label, area, PLACEMENT_OPTIONS[label]);
    await win.unmaximize().catch(() => {});
    await applyRect(
      {
        setPosition: async (x, y) => win.setPosition(new (await import("@tauri-apps/api/window")).PhysicalPosition(x, y)),
        setSize: async (w, h) => win.setSize(new (await import("@tauri-apps/api/window")).PhysicalSize(w, h)),
        outerPosition: async () => {
          const p = await win.outerPosition();
          return { x: p.x, y: p.y };
        },
        innerSize: async () => {
          const s = await win.innerSize();
          return { w: s.width, h: s.height };
        },
      },
      rect,
    ).catch(() => {});
  }
  return true;
}
