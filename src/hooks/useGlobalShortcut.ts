import { useEffect } from "react";
import {
  register,
  unregister,
} from "@tauri-apps/plugin-global-shortcut";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useMeetingStore } from "../stores/meetingStore";
import { useAIActionsStore } from "../stores/aiActionsStore";
import { isQuitPending } from "../lib/ipc";
import { runUserAction } from "../lib/userAction";
import { isOverlayVisible, meetingShortcutAction, showLauncherWindow, showMeetingOverlay } from "../lib/windows";
import { endMeetingFromThisWindow } from "./useUpdater";
import { showToast } from "../stores/toastStore";
import { useConfigStore } from "../stores/configStore";
import { reservedShortcutAction } from "../lib/shortcutLabel";

/** Ctrl+M: end the running meeting (in every window that holds it) or start one. */
async function toggleMeetingFromShortcut(): Promise<void> {
  const store = useMeetingStore.getState();
  const quitPending = store.activeMeeting ? false : await isQuitPending().catch(() => false);
  switch (meetingShortcutAction(!!store.activeMeeting, quitPending)) {
    case "end":
      if (!(await endMeetingFromThisWindow())) {
        showToast("Couldn't finish saving the meeting", "error");
      }
      break;
    case "start":
      await store.startMeetingFlow();
      break;
    case "ignore":
      break;
  }
}

/** Stealth shortcut: hide NexQ from screen sharing, or show it again. */
export async function toggleStealthMode(): Promise<void> {
  const config = useConfigStore.getState();
  const enabled = !config.stealthMode;
  try {
    await config.setStealthMode(enabled);
    showToast(enabled ? "Hidden from screen share" : "Visible in screen share", "info");
  } catch (e) {
    showToast(`Couldn't change screen-share visibility: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

export function useGlobalShortcut() {
  const stealthShortcut = useConfigStore((s) => s.stealthShortcut);

  // Stealth mode shortcut (user-configurable, re-registered when it changes)
  useEffect(() => {
    const key = stealthShortcut;
    // Never take over a built-in shortcut (e.g. a binding saved before it was
    // reserved): registering it would unregister that action's handler.
    if (!key || reservedShortcutAction(key)) {
      if (key) console.warn(`[useGlobalShortcut] Stealth shortcut ${key} collides with a built-in shortcut; not registered`);
      return;
    }
    let registered = false;
    (async () => {
      try {
        await unregister(key).catch(() => {});
        await register(key, (event) => {
          if (event.state === "Pressed") toggleStealthMode().catch(() => {});
        });
        registered = true;
      } catch (err) {
        console.warn(`Failed to register stealth shortcut ${key}:`, err);
      }
    })();
    return () => {
      if (registered) unregister(key).catch(() => {});
    };
  }, [stealthShortcut]);

  // Global shortcuts (work even when window is not focused)
  useEffect(() => {
    const shortcuts: string[] = [];

    async function registerShortcuts() {
      const isLauncher = getCurrentWebviewWindow().label === "launcher";
      // Register each shortcut independently — one failure shouldn't block the rest.
      // Unregister first to handle hot-reload / React strict mode re-mounts.
      const defs: Array<{ key: string; handler: (event: { state: string }) => void }> = [
        {
          key: "CmdOrCtrl+M",
          handler: (event) => {
            if (event.state === "Pressed") {
              toggleMeetingFromShortcut().catch(() => {});
            }
          },
        },
        {
          key: "CmdOrCtrl+B",
          handler: (event) => {
            if (event.state === "Pressed") {
              (async () => {
                if (await isOverlayVisible()) await showLauncherWindow();
                else if (useMeetingStore.getState().activeMeeting) await showMeetingOverlay();
              })().catch(() => {});
            }
          },
        },
        {
          key: "CmdOrCtrl+,",
          handler: (event) => {
            if (event.state === "Pressed") {
              const store = useMeetingStore.getState();
              store.setSettingsOpen(!store.settingsOpen);
            }
          },
        },
      ];

      for (const { key, handler } of defs) {
        if (key === "CmdOrCtrl+M" && !isLauncher) continue;
        try {
          await unregister(key).catch(() => {}); // Clean up stale registration
          await register(key, handler);
          shortcuts.push(key);
        } catch (err) {
          console.warn(`Failed to register shortcut ${key}:`, err);
        }
      }
    }

    registerShortcuts();

    return () => {
      shortcuts.forEach((s) => {
        unregister(s).catch(() => {});
      });
    };
  }, []);

  // Window-level shortcuts (work when window is active/focused)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const store = useMeetingStore.getState();
      if (!store.activeMeeting) return;

      // Don't trigger if user is typing in an input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      // Check action visibility from the AI actions store
      const actions = useAIActionsStore.getState().configs.actions;
      const isVisible = (mode: string) => actions[mode]?.visible !== false;

      switch (e.code) {
        case "Space":
          if (isVisible("Assist")) {
            e.preventDefault();
            runUserAction("Assist").catch(() => {});
          }
          break;
        case "Numpad1":
        case "Digit1":
          if (!e.ctrlKey && !e.metaKey && !e.altKey && isVisible("WhatToSay")) {
            e.preventDefault();
            runUserAction("WhatToSay").catch(() => {});
          }
          break;
        case "Numpad2":
        case "Digit2":
          if (!e.ctrlKey && !e.metaKey && !e.altKey && isVisible("Shorten")) {
            e.preventDefault();
            runUserAction("Shorten").catch(() => {});
          }
          break;
        case "Numpad3":
        case "Digit3":
          if (!e.ctrlKey && !e.metaKey && !e.altKey && isVisible("FollowUp")) {
            e.preventDefault();
            runUserAction("FollowUp").catch(() => {});
          }
          break;
        case "Numpad4":
        case "Digit4":
          if (!e.ctrlKey && !e.metaKey && !e.altKey && isVisible("Recap")) {
            e.preventDefault();
            runUserAction("Recap").catch(() => {});
          }
          break;
        case "Numpad5":
        case "Digit5":
          if (!e.ctrlKey && !e.metaKey && !e.altKey && isVisible("AskQuestion")) {
            e.preventDefault();
            // Open/focus the Ask input instead of triggering generation directly
            window.dispatchEvent(new Event("nexq:toggle-ask-input"));
          }
          break;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
