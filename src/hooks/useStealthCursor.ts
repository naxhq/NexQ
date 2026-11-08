import { useEffect } from "react";
import { useConfigStore } from "../stores/configStore";

/**
 * Stealth mode keeps the cursor as the plain arrow everywhere in the overlay
 * window, so it doesn't change shape over every button and edit field.
 *
 * Sets `data-stealth-cursor` on the window's `<html>` (see index.css), which
 * covers everything the overlay window draws: the overlay itself, the AI call
 * log panel, toasts, the Settings dialog, and menus rendered into
 * `document.body`. The resize cursors at the window's edges come from
 * Windows, not the page; stealth_commands.rs handles those.
 *
 * Only the overlay window: each window has its own document, so the launcher
 * keeps its normal cursors.
 */
export function useStealthCursor(windowLabel: string) {
  const stealthMode = useConfigStore((s) => s.stealthMode);

  useEffect(() => {
    if (windowLabel !== "overlay") return;
    const root = document.documentElement;
    root.dataset.stealthCursor = stealthMode ? "true" : "false";
    return () => {
      delete root.dataset.stealthCursor;
    };
  }, [windowLabel, stealthMode]);
}
