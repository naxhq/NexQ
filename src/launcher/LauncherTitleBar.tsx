import { useEffect, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { platform } from "@tauri-apps/plugin-os";

/**
 * Custom title bar for the launcher window. The launcher runs with
 * `decorations: false` so it gets a consistent cross-platform look and so
 * the Windows `WS_EX_TOOLWINDOW` style (set by stealth mode) has no OS
 * title bar to repaint.
 *
 * Windows: 32px bar, NexQ icon + title on the left, three 46x32 control
 * buttons on the right. Glyph proportions match Segoe MDL2; close hover
 * is Windows 11's close-red. Focused vs unfocused dim mirrors the native
 * title-bar behavior.
 *
 * macOS: 28px drag region with the native traffic lights showing through
 * via `titleBarStyle: "Overlay"` in tauri.conf.json.
 *
 * Close routes through `CloseRequested`, which is already intercepted in
 * Rust ([lib.rs:494]) to call `hide_all()` → minimize-to-tray, identical
 * to today's X-click behavior.
 */
export function LauncherTitleBar() {
  const [isMac, setIsMac] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [focused, setFocused] = useState(true);

  useEffect(() => {
    try {
      setIsMac(platform() === "macos");
    } catch {
      // platform() reads a global set by the Tauri runtime; in test or
      // dev-without-tauri contexts it may throw. Default: Windows chrome.
    }
    const win = getCurrentWebviewWindow();
    win.isMaximized().then(setMaximized).catch(() => {});
    win.isFocused().then(setFocused).catch(() => {});
    const unResize = win.onResized(() => {
      win.isMaximized().then(setMaximized).catch(() => {});
    });
    const unFocus = win.onFocusChanged(({ payload }) => setFocused(payload));
    return () => {
      unResize.then((fn) => fn()).catch(() => {});
      unFocus.then((fn) => fn()).catch(() => {});
    };
  }, []);

  const win = getCurrentWebviewWindow();

  if (isMac) {
    // macOS keeps native traffic lights via titleBarStyle: "Overlay".
    // The bar is a drag region; the native lights are drawn on top by the OS.
    return (
      <div
        className="flex h-7 shrink-0 items-center select-none"
        style={{ background: "hsl(var(--background))" }}
        data-tauri-drag-region
        role="toolbar"
        aria-label="Window controls"
      >
        <div
          className="pl-20 text-[12px] text-foreground/80"
          data-tauri-drag-region
          style={{ fontFamily: "-apple-system, 'Segoe UI', system-ui" }}
        >
          NexQ
        </div>
      </div>
    );
  }

  const dim = focused ? "" : "opacity-60";
  return (
    <div
      className="flex h-8 shrink-0 items-stretch justify-between select-none"
      style={{ background: "hsl(var(--background))" }}
      data-tauri-drag-region
      role="toolbar"
      aria-label="Window controls"
    >
      <div
        className={`flex items-center gap-1.5 pl-2 ${dim}`}
        data-tauri-drag-region
      >
        <img src="/nexq-icon.png" alt="" width={16} height={16} />
        <span
          className="text-[12px] text-foreground/90"
          style={{ fontFamily: "-apple-system, 'Segoe UI', system-ui" }}
        >
          NexQ
        </span>
      </div>

      <div className="flex items-stretch">
        <button
          type="button"
          onClick={() => win.minimize().catch(() => {})}
          aria-label="Minimize"
          className={`flex h-8 w-[46px] items-center justify-center text-foreground/80 transition-colors hover:bg-foreground/10 focus:outline-none focus-visible:ring-1 focus-visible:ring-primary ${dim}`}
        >
          <MinGlyph />
        </button>
        <button
          type="button"
          onClick={() => win.toggleMaximize().catch(() => {})}
          aria-label={maximized ? "Restore" : "Maximize"}
          className={`flex h-8 w-[46px] items-center justify-center text-foreground/80 transition-colors hover:bg-foreground/10 focus:outline-none focus-visible:ring-1 focus-visible:ring-primary ${dim}`}
        >
          {maximized ? <RestoreGlyph /> : <MaxGlyph />}
        </button>
        <button
          type="button"
          onClick={() => win.close().catch(() => {})}
          aria-label="Close"
          className={`flex h-8 w-[46px] items-center justify-center text-foreground/80 transition-colors hover:bg-[#c42b1c] hover:text-white focus:outline-none focus-visible:ring-1 focus-visible:ring-primary ${dim}`}
        >
          <CloseGlyph />
        </button>
      </div>
    </div>
  );
}

// Glyphs: 10x10 viewBox SVGs matching Segoe MDL2 weights.

function MinGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <line x1="0" y1="5" x2="10" y2="5" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function MaxGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function RestoreGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <rect x="2.5" y="0.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
      <rect x="0.5" y="2.5" width="7" height="7" fill="hsl(var(--background))" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1" />
      <line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}
