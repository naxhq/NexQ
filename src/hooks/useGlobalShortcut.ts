import { useEffect } from "react";
import {
  register,
  unregister,
} from "@tauri-apps/plugin-global-shortcut";
import { useMeetingStore } from "../stores/meetingStore";
import { useAIActionsStore } from "../stores/aiActionsStore";
import { generateAssist } from "../lib/ipc";
import { showLauncherWindow, showOverlayWindow } from "../lib/windows";

export function useGlobalShortcut() {
  // Global shortcuts (work even when window is not focused)
  useEffect(() => {
    const shortcuts: string[] = [];

    async function registerShortcuts() {
      // Register each shortcut independently — one failure shouldn't block the rest.
      // Unregister first to handle hot-reload / React strict mode re-mounts.
      const defs: Array<{ key: string; handler: (event: { state: string }) => void }> = [
        {
          key: "CmdOrCtrl+M",
          handler: (event) => {
            if (event.state === "Pressed") {
              const store = useMeetingStore.getState();
              if (store.activeMeeting) {
                store.endMeetingFlow().catch(() => {});
              } else {
                store.startMeetingFlow().catch(() => {});
              }
            }
          },
        },
        {
          key: "CmdOrCtrl+B",
          handler: (event) => {
            if (event.state === "Pressed") {
              const store = useMeetingStore.getState();
              if (store.currentView === "overlay") {
                store.setCurrentView("launcher");
                showLauncherWindow().catch(() => {});
              } else if (store.activeMeeting) {
                store.setCurrentView("overlay");
                showOverlayWindow().catch(() => {});
              }
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
            generateAssist("Assist").catch(() => {});
          }
          break;
        case "Numpad1":
        case "Digit1":
          if (!e.ctrlKey && !e.metaKey && !e.altKey && isVisible("WhatToSay")) {
            e.preventDefault();
            generateAssist("WhatToSay").catch(() => {});
          }
          break;
        case "Numpad2":
        case "Digit2":
          if (!e.ctrlKey && !e.metaKey && !e.altKey && isVisible("Shorten")) {
            e.preventDefault();
            generateAssist("Shorten").catch(() => {});
          }
          break;
        case "Numpad3":
        case "Digit3":
          if (!e.ctrlKey && !e.metaKey && !e.altKey && isVisible("FollowUp")) {
            e.preventDefault();
            generateAssist("FollowUp").catch(() => {});
          }
          break;
        case "Numpad4":
        case "Digit4":
          if (!e.ctrlKey && !e.metaKey && !e.altKey && isVisible("Recap")) {
            e.preventDefault();
            generateAssist("Recap").catch(() => {});
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
