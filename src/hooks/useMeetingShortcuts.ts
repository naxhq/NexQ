// SP5 Enhancement 4: Consolidated keyboard shortcuts for live meeting overlay.
// Single-key shortcuts (B, S, K, M) work outside inputs; Escape always works;
// Ctrl+Shift+L (dev log) is carried over from its previous individual handler.

import { useEffect } from "react";
import { useMeetingStore } from "../stores/meetingStore";
import { overlaySingleKey } from "../lib/hotkeys";

interface ShortcutActions {
  addBookmark: () => void;
  toggleStats: () => void;
  toggleBookmarks: () => void;
  toggleMute: () => void;
  closeAllPanels: () => void;
  toggleDevLog: () => void;
}

export function useMeetingShortcuts(actions: ShortcutActions) {
  const isRecording = useMeetingStore((s) => s.isRecording);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!isRecording) return;

      const target = e.target as HTMLElement;
      const isInput =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable;

      // Escape always works (even in inputs) — close all panels
      if (overlaySingleKey(e.key)?.id === "closePanels") {
        actions.closeAllPanels();
        return;
      }

      // Ctrl+B is the global switch overlay / dashboard shortcut, not a bookmark key.

      // Ctrl+Shift+L: dev log (consolidated from OverlayView inline handler)
      if (e.ctrlKey && e.shiftKey && e.key === "L") {
        e.preventDefault();
        actions.toggleDevLog();
        return;
      }

      // Single-key shortcuts only outside inputs, and only the bare key: Ctrl+K,
      // Shift+M and the like belong to the action keys in Settings > Hotkeys.
      if (isInput || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;

      switch (overlaySingleKey(e.key)?.id) {
        case "bookmark":
          actions.addBookmark();
          break;
        case "stats":
          actions.toggleStats();
          break;
        case "bookmarks":
          actions.toggleBookmarks();
          break;
        case "mute":
          actions.toggleMute();
          break;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isRecording, actions]);
}
