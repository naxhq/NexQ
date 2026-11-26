import { useEffect } from "react";
import {
  register,
  unregister,
} from "@tauri-apps/plugin-global-shortcut";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useMeetingStore } from "../stores/meetingStore";
import { useDemoStore } from "../demo/demoStore";
import { useAIActionsStore } from "../stores/aiActionsStore";
import { isQuitPending } from "../lib/ipc";
import { runYourAction } from "../lib/autoAnswer";
import { TOGGLE_SETTINGS_EVENT, isOverlayVisible, isWindowShown, meetingShortcutAction, showLauncherWindow, showMeetingOverlay, switchShortcutTarget } from "../lib/windows";
import { endMeetingFromThisWindow } from "./useUpdater";
import { showToast } from "../stores/toastStore";
import { useConfigStore } from "../stores/configStore";
import { formatShortcut, normalizeAccelerator, reservedShortcutAction, screenCaptureSupported } from "../lib/shortcutLabel";
import { providerReadsImages } from "../lib/imageAttachments";
import { forwardChordToEditor, keyBelongsToFocusedControl, modeForKeyEvent } from "../lib/hotkeys";
import { captureScreenIntoAsk } from "../lib/screenCapture";

/**
 * Ctrl+M: end the running meeting (in every window that holds it) or start one.
 * A demo's fake meeting is not a running meeting: the press starts a real one
 * (startMeetingFlow leaves the demo first).
 */
async function toggleMeetingFromShortcut(): Promise<void> {
  const store = useMeetingStore.getState();
  const hasMeeting = !!store.activeMeeting && !useDemoStore.getState().isDemoActive;
  const quitPending = hasMeeting ? false : await isQuitPending().catch(() => false);
  switch (meetingShortcutAction(hasMeeting, quitPending)) {
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

/**
 * Opens Settings in this window, or closes them: the dashboard's Settings page,
 * or the meeting overlay's Settings panel (the demo draws the overlay in the
 * launcher, so both can happen there).
 */
export function toggleSettingsHere(): void {
  const store = useMeetingStore.getState();
  if (store.currentView === "settings") store.setCurrentView(store.previousView || "launcher");
  else if (store.settingsOpen) store.setSettingsOpen(false);
  else store.openSettings();
}

/**
 * Ctrl+, wherever the user is. The launcher holds the global key (two windows
 * registering the same key leave it to whichever registered last); it opens
 * the dashboard's Settings, or hands the press to the overlay window while
 * the meeting overlay is the window on screen.
 */
async function toggleSettingsFromShortcut(): Promise<void> {
  if (await isOverlayVisible()) {
    await emit(TOGGLE_SETTINGS_EVENT);
    return;
  }
  toggleSettingsHere();
  // NexQ may be hidden (it has no taskbar button under stealth mode).
  const settingsShowing = useMeetingStore.getState().currentView === "settings";
  if (settingsShowing && !(await isWindowShown("launcher"))) await showLauncherWindow();
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

/** Keys whose registration failure was already announced (once is enough). */
const announcedCaptureKeys = new Set<string>();

function announceCaptureShortcutFailure(key: string): void {
  if (announcedCaptureKeys.has(key)) return;
  announcedCaptureKeys.add(key);
  showToast(
    `${formatShortcut(key)} is in use by another app, so Capture screen into Ask is off. Choose another key in Settings > General.`,
    "warning",
  );
}

export function useGlobalShortcut() {
  const stealthShortcut = useConfigStore((s) => s.stealthShortcut);
  const assistShortcut = useConfigStore((s) => s.assistShortcut);
  const captureShortcut = useConfigStore((s) => s.captureShortcut);
  const canReadImages = useConfigStore((s) => providerReadsImages(s.llmProvider));
  const meetingActive = useMeetingStore((s) => !!s.activeMeeting);

  // Assist from any app (Space only works while the overlay has focus). Held
  // only during a meeting, by the overlay window, so the key combination
  // stays free for other apps the rest of the time.
  useEffect(() => {
    const key = assistShortcut;
    if (!meetingActive || !key || getCurrentWebviewWindow().label !== "overlay") return;
    if (reservedShortcutAction(key) || normalizeAccelerator(key) === normalizeAccelerator(stealthShortcut)) {
      console.warn(`[useGlobalShortcut] Assist shortcut ${key} collides with another shortcut; not registered`);
      return;
    }
    let registered = false;
    let cancelled = false;
    (async () => {
      try {
        await unregister(key).catch(() => {});
        if (cancelled) return;
        await register(key, (event) => {
          if (event.state !== "Pressed") return;
          const visible = useAIActionsStore.getState().configs.actions["Assist"]?.visible !== false;
          if (visible) runYourAction("Assist").catch(() => {});
        });
        registered = true;
        // The meeting ended (or the key changed) while registering.
        if (cancelled) unregister(key).catch(() => {});
      } catch (err) {
        console.warn(`Failed to register Assist shortcut ${key}:`, err);
      }
    })();
    return () => {
      cancelled = true;
      if (registered) unregister(key).catch(() => {});
    };
  }, [assistShortcut, stealthShortcut, meetingActive]);

  // Capture the screen under the mouse into the Ask box. Held only during a
  // meeting, by the overlay window, and only while the chosen AI can read
  // images, so the key combination stays free for other apps otherwise.
  // Assist and Hide from screen share win a collision.
  useEffect(() => {
    const key = captureShortcut;
    if (!screenCaptureSupported() || !meetingActive || !canReadImages || !key) return;
    if (getCurrentWebviewWindow().label !== "overlay") return;
    const wanted = normalizeAccelerator(key);
    if (
      reservedShortcutAction(key) ||
      wanted === normalizeAccelerator(stealthShortcut) ||
      wanted === normalizeAccelerator(assistShortcut)
    ) {
      console.warn(`[useGlobalShortcut] Capture shortcut ${key} collides with another shortcut; not registered`);
      return;
    }
    let registered = false;
    let cancelled = false;
    (async () => {
      try {
        await unregister(key).catch(() => {});
        if (cancelled) return;
        await register(key, (event) => {
          if (event.state === "Pressed") captureScreenIntoAsk().catch(() => {});
        });
        registered = true;
        // The meeting ended (or the key or provider changed) while registering.
        if (cancelled) unregister(key).catch(() => {});
      } catch (err) {
        console.warn(`Failed to register capture shortcut ${key}:`, err);
        if (!cancelled) announceCaptureShortcutFailure(key);
      }
    })();
    return () => {
      cancelled = true;
      if (registered) unregister(key).catch(() => {});
    };
  }, [captureShortcut, assistShortcut, stealthShortcut, meetingActive, canReadImages]);

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
              // In a NexQ editor Ctrl+B is bold: the global key hands it over.
              if (forwardChordToEditor("b")) return;
              (async () => {
                const target = switchShortcutTarget(await isOverlayVisible(), !!useMeetingStore.getState().activeMeeting);
                if (target === "launcher") await showLauncherWindow();
                else await showMeetingOverlay();
              })().catch(() => {});
            }
          },
        },
        {
          key: "CmdOrCtrl+,",
          handler: (event) => {
            if (event.state === "Pressed") {
              toggleSettingsFromShortcut().catch(() => {});
            }
          },
        },
      ];

      for (const { key, handler } of defs) {
        // The launcher holds these two keys; the overlay gets Settings by event.
        if ((key === "CmdOrCtrl+M" || key === "CmdOrCtrl+,") && !isLauncher) continue;
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

  // Overlay window: the launcher passes on Ctrl+, while the overlay is showing.
  useEffect(() => {
    if (getCurrentWebviewWindow().label !== "overlay") return;
    let cancelled = false;
    let stop: (() => void) | undefined;
    listen(TOGGLE_SETTINGS_EVENT, toggleSettingsHere)
      .then((fn) => { if (cancelled) fn(); else stop = fn; })
      .catch(() => {});
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  // Window-level shortcuts (work when window is active/focused)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const store = useMeetingStore.getState();
      if (!store.activeMeeting) return;

      // Text boxes (inputs, contenteditable, role=textbox) keep every key; Space also
      // stays with a focused button or menu item.
      if (keyBelongsToFocusedControl(e)) return;

      // Check action visibility from the AI actions store
      const actions = useAIActionsStore.getState().configs.actions;
      const isVisible = (mode: string) => actions[mode]?.visible !== false;

      // The keys come from Settings > Hotkeys (read now, so a change applies at once).
      const mode = modeForKeyEvent(e, useConfigStore.getState().hotkeys);
      if (!mode || !isVisible(mode)) return;
      e.preventDefault();
      // Holding the key must not start the action again and again.
      if (e.repeat) return;
      if (mode === "AskQuestion") {
        // Open/focus the Ask input instead of triggering generation directly
        window.dispatchEvent(new Event("nexq:toggle-ask-input"));
      } else {
        runYourAction(mode).catch(() => {});
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
