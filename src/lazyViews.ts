import { lazy } from "react";

// Each window loads only what it shows. The views are separate chunks, started
// the moment the window starts (by its label), so nothing waits when it is needed.

const loaders = {
  launcher: () => import("./launcher/LauncherView"),
  overlay: () => import("./overlay/OverlayView"),
  settings: () => import("./settings/SettingsOverlay"),
  wizard: () => import("./components/wizard/FirstRunWizard"),
  updateDialog: () => import("./components/UpdateDialog"),
  starPrompt: () => import("./components/StarPrompt"),
  selectionToolbar: () => import("./components/SelectionToolbar"),
  resizeHandles: () => import("./overlay/OverlayResizeHandles"),
  demoPicker: () => import("./demo/DemoPicker"),
  demoBadge: () => import("./demo/DemoBadge"),
};

export const LauncherView = lazy(() => loaders.launcher().then((m) => ({ default: m.LauncherView })));
export const OverlayView = lazy(() => loaders.overlay().then((m) => ({ default: m.OverlayView })));
export const SettingsOverlay = lazy(() => loaders.settings().then((m) => ({ default: m.SettingsOverlay })));
export const FirstRunWizard = lazy(() => loaders.wizard().then((m) => ({ default: m.FirstRunWizard })));
export const UpdateDialog = lazy(() => loaders.updateDialog().then((m) => ({ default: m.UpdateDialog })));
export const StarPrompt = lazy(() => loaders.starPrompt().then((m) => ({ default: m.StarPrompt })));
export const SelectionToolbar = lazy(() => loaders.selectionToolbar().then((m) => ({ default: m.SelectionToolbar })));
export const OverlayResizeHandles = lazy(() => loaders.resizeHandles().then((m) => ({ default: m.OverlayResizeHandles })));
export const DemoPicker = lazy(() => loaders.demoPicker().then((m) => ({ default: m.DemoPicker })));
export const DemoBadge = lazy(() => loaders.demoBadge().then((m) => ({ default: m.DemoBadge })));

/** The label of this window, known synchronously in the Tauri shell (empty in a browser or a test). */
export function currentWindowLabel(): string {
  try {
    const meta = (window as unknown as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } }).__TAURI_INTERNALS__;
    return meta?.metadata?.currentWindow?.label ?? "";
  } catch {
    return "";
  }
}

const swallow = () => {};
const idle = (fn: () => void) => {
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback;
  if (ric) ric(fn);
  else setTimeout(fn, 200);
};

/**
 * Start loading what this window will show, at once. The meeting window is made
 * hidden at launch, so its view is ready long before a meeting starts. The rest
 * (settings, dialogs) load when the window is idle, never ahead of the first paint.
 */
export function preloadForWindow(label: string = currentWindowLabel()): void {
  if (label === "overlay") {
    void loaders.overlay().catch(swallow);
    void loaders.resizeHandles().catch(swallow);
    idle(() => {
      void loaders.settings().catch(swallow);
      void loaders.updateDialog().catch(swallow);
    });
  } else if (label === "launcher") {
    void loaders.launcher().catch(swallow);
    idle(() => {
      void loaders.settings().catch(swallow);
      void loaders.updateDialog().catch(swallow);
      void loaders.selectionToolbar().catch(swallow);
      void loaders.starPrompt().catch(swallow);
    });
  }
}
