/**
 * Window switching helpers for the two-window Tauri layout.
 *
 * Keeping show/hide/focus in one place prevents the React view state from
 * drifting away from the actual native windows.
 */
import { logToFile } from "./logger";

/** Show the launcher window and hide the overlay (whichever window asks). */
export async function showLauncherWindow(): Promise<void> {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const launcher = await WebviewWindow.getByLabel("launcher");
  const overlay = await WebviewWindow.getByLabel("overlay");

  if (launcher) {
    await launcher.show().catch(() => {});
    await launcher.unminimize().catch(() => {});
    await launcher.setFocus().catch(() => {});
  }
  await overlay?.hide().catch(() => {});
}

/**
 * Show the overlay window and hide the launcher. Only the overlay window's
 * own view decides what it renders, so callers outside it should use
 * {@link showMeetingOverlay}.
 *
 * Non-stealth: show the overlay first, then hide the launcher. A slow
 * `overlay.show()` otherwise leaves a blank screen frame.
 *
 * Stealth: hide the launcher first, then show the overlay. Under stealth
 * we don't want to leak the launcher on screen between the two calls; the
 * brief blank frame is preferable to a visible launcher-flash.
 */
export async function showOverlayWindow(): Promise<void> {
  logToFile("info", "windows", "Showing the overlay window");
  const { useConfigStore } = await import("../stores/configStore");
  const stealth = useConfigStore.getState().stealthMode;
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const overlay = await WebviewWindow.getByLabel("overlay");
  const launcher = await WebviewWindow.getByLabel("launcher");

  if (stealth) {
    await launcher?.hide().catch(() => {});
  }
  if (overlay) {
    await overlay.show().catch(() => {});
    await overlay.unminimize().catch(() => {});
    await overlay.setFocus().catch(() => {});
  }
  if (!stealth) {
    await launcher?.hide().catch(() => {});
  }
}

/** Window -> overlay window: bring back the floating meeting overlay. */
export const SHOW_MEETING_OVERLAY_EVENT = "nexq:show_meeting_overlay";

/** What the show event carries: the meeting the sender is running, if any. */
export interface ShowMeetingOverlayPayload {
  meetingId?: string;
}

/**
 * Bring back the floating meeting overlay from any window (launcher RETURN,
 * Ctrl+B, tray). The overlay window switches itself to the meeting view and
 * shows; without a running meeting it shows the launcher instead.
 *
 * The event names the meeting the sender runs. A meeting that has only just
 * started reaches the overlay window as a separate event that it handles
 * asynchronously, so the show request can arrive before the overlay knows the
 * meeting; the id tells it to wait for that meeting instead of treating the
 * request as "no meeting" and hiding itself.
 */
export async function showMeetingOverlay(): Promise<void> {
  const { emit } = await import("@tauri-apps/api/event");
  const { useMeetingStore } = await import("../stores/meetingStore");
  const payload: ShowMeetingOverlayPayload = { meetingId: useMeetingStore.getState().activeMeeting?.id };
  await emit(SHOW_MEETING_OVERLAY_EVENT, payload);
}

/** How long the overlay waits for a meeting the launcher says is starting. */
export const MEETING_START_WAIT_MS = 3000;

/**
 * Overlay window: whether a meeting is (or soon will be) running here. With no
 * meeting yet, waits up to `timeoutMs` for one to appear when the sender named
 * a meeting (it is mid-start); otherwise answers at once.
 */
export async function waitForOverlayMeeting(
  expectedMeetingId: string | undefined,
  timeoutMs: number = MEETING_START_WAIT_MS,
): Promise<boolean> {
  const { useMeetingStore } = await import("../stores/meetingStore");
  if (useMeetingStore.getState().activeMeeting) return true;
  if (!expectedMeetingId) return false;
  return new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = useMeetingStore.subscribe((state) => {
      if (state.activeMeeting) done(true);
    });
    function done(started: boolean) {
      clearTimeout(timer);
      unsubscribe();
      resolve(started);
    }
    timer = setTimeout(() => done(false), timeoutMs);
  });
}

/** Whether the overlay window is on screen. */
export async function isOverlayVisible(): Promise<boolean> {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const overlay = await WebviewWindow.getByLabel("overlay");
  return overlay ? overlay.isVisible().catch(() => false) : false;
}

/**
 * Speakers, bookmarks, action items and topic sections are edited in the
 * overlay window. When a meeting ends, both windows may run endMeetingFlow
 * (tray Stop, update restart), and saving them replaces all rows — so exactly
 * one window persists them: the overlay, or the launcher only when no overlay
 * window has taken the meeting.
 */
export function shouldPersistOverlayData(windowLabel: string, overlayActive: boolean): boolean {
  if (windowLabel === "overlay") return true;
  return !overlayActive;
}

/**
 * How a window ends the running meeting: by itself, or through every window
 * (the tray's Stop path) when it is not the overlay and the overlay took the
 * meeting — the overlay holds data only it saves (see
 * shouldPersistOverlayData), so it must run its own endMeetingFlow.
 */
export function meetingEndRoute(windowLabel: string, overlayActive: boolean): "here" | "all_windows" {
  return windowLabel !== "overlay" && overlayActive ? "all_windows" : "here";
}

/**
 * What the meeting shortcut (Ctrl+M) does: end the running meeting, start
 * one, or nothing while a deferred quit is pending (NexQ is about to exit).
 */
export function meetingShortcutAction(hasMeeting: boolean, quitPending: boolean): "end" | "start" | "ignore" {
  if (hasMeeting) return "end";
  return quitPending ? "ignore" : "start";
}

/**
 * Where Ctrl+B goes: from the overlay to the dashboard, back to the meeting
 * overlay during a meeting, and otherwise to the dashboard, so the shortcut
 * always brings NexQ back (it has no taskbar button under stealth mode).
 */
export function switchShortcutTarget(overlayVisible: boolean, hasMeeting: boolean): "launcher" | "overlay" {
  if (overlayVisible) return "launcher";
  return hasMeeting ? "overlay" : "launcher";
}

/**
 * Whether the user can see a window right now (shown and not minimized).
 * An unknown window or a failed query counts as not shown.
 */
export async function isWindowShown(label: string): Promise<boolean> {
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const win = await WebviewWindow.getByLabel(label);
    if (!win) return false;
    return (await win.isVisible()) && !(await win.isMinimized());
  } catch {
    return false;
  }
}
