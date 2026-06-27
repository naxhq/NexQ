/**
 * Window switching helpers for the two-window Tauri layout.
 *
 * Keeping show/hide/focus in one place prevents the React view state from
 * drifting away from the actual native windows.
 */
export async function showLauncherWindow(): Promise<void> {
  const { WebviewWindow, getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const current = getCurrentWebviewWindow();
  const launcher = await WebviewWindow.getByLabel("launcher");

  if (launcher) {
    await launcher.show().catch(() => {});
    await launcher.unminimize().catch(() => {});
    await launcher.setFocus().catch(() => {});
  }

  if (current.label === "overlay") {
    await current.hide().catch(() => {});
  }
}

export async function showOverlayWindow(): Promise<void> {
  const { WebviewWindow, getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const current = getCurrentWebviewWindow();
  const overlay = await WebviewWindow.getByLabel("overlay");

  if (overlay) {
    await overlay.show().catch(() => {});
    await overlay.unminimize().catch(() => {});
    await overlay.setFocus().catch(() => {});
  }

  if (current.label === "launcher") {
    await current.hide().catch(() => {});
  }
}
