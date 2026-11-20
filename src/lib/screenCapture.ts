// The screen-capture shortcut: grab the screen under the mouse pointer and hand
// it to the Ask box as an attachment. The picture stays in memory (a `File` that
// is attached or dropped); nothing is saved or logged.

import { captureScreenUnderCursor } from "./ipc";
import { providerReadsImages } from "./imageAttachments";
import { showMeetingOverlay } from "./windows";
import { showToast } from "../stores/toastStore";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";

/**
 * Window event: a captured screenshot is waiting for the Ask box (see
 * {@link takePendingScreenshots}). It is cancelable: a listener that takes the
 * picture, or has made room for the Ask box to show it, calls `preventDefault()`.
 * A picture nobody claims gets a toast instead of being lost silently.
 */
export const SCREENSHOT_EVENT = "nexq:screenshot-captured";

/** How long a screenshot waits for an Ask box that isn't on screen yet. */
export const PENDING_SCREENSHOT_MS = 30_000;

export const SCREENSHOT_NOT_ATTACHED = "Couldn't attach the screenshot. Open Ask and try again.";

const pending: Array<{ file: File; at: number; timer: ReturnType<typeof setTimeout> }> = [];

/**
 * The screenshots waiting for the Ask box, oldest first, and forgets them.
 * One that waited too long is dropped, so a stale picture never shows up later.
 */
export function takePendingScreenshots(now = Date.now()): File[] {
  const files = pending.filter((p) => now - p.at <= PENDING_SCREENSHOT_MS).map((p) => p.file);
  for (const p of pending) clearTimeout(p.timer);
  pending.length = 0;
  return files;
}

/** Forgets the waiting screenshots without a word (the meeting they belong to is over). */
export function discardPendingScreenshots(): void {
  for (const p of pending) clearTimeout(p.timer);
  pending.length = 0;
}

function dropPending(file: File): boolean {
  const i = pending.findIndex((p) => p.file === file);
  if (i < 0) return false;
  clearTimeout(pending[i].timer);
  pending.splice(i, 1);
  return true;
}

/**
 * Hands a screenshot to the Ask box. Listeners run synchronously; if the
 * picture is still waiting and nobody claimed it, or nobody takes it in time,
 * the user is told rather than left wondering.
 */
export function deliverScreenshot(file: File): void {
  const timer = setTimeout(() => {
    if (dropPending(file)) showToast(SCREENSHOT_NOT_ATTACHED, "error");
  }, PENDING_SCREENSHOT_MS);
  pending.push({ file, at: Date.now(), timer });
  const event = new Event(SCREENSHOT_EVENT, { cancelable: true });
  window.dispatchEvent(event);
  if (!event.defaultPrevented && dropPending(file)) showToast(SCREENSHOT_NOT_ATTACHED, "error");
}

/**
 * Makes room for the Ask box when the overlay window shows Settings (the full
 * view or the modal over the meeting). Returns whether it changed anything.
 */
export function leaveSettingsForAsk(): boolean {
  const meeting = useMeetingStore.getState();
  let changed = false;
  if (meeting.currentView === "settings") {
    meeting.setCurrentView("overlay");
    changed = true;
  }
  if (meeting.settingsOpen) {
    meeting.setSettingsOpen(false);
    changed = true;
  }
  return changed;
}

// Screenshots wait for the meeting they were taken in: a new meeting (or none) drops them.
useMeetingStore.subscribe((state, previous) => {
  if ((state.activeMeeting?.id ?? "") !== (previous.activeMeeting?.id ?? "")) discardPendingScreenshots();
});

/** The sentence to show for a failed capture. */
export function captureErrorText(error: unknown): string {
  const text = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  return text.trim() || "Couldn't capture the screen";
}

let capturing = false;

/**
 * The capture shortcut: screenshot of the screen under the pointer, attached
 * to the Ask box (never sent). Every press runs the Ctrl+B show path (show,
 * unminimize, focus), also when the overlay is already visible, so the
 * cursor ends up in the Ask box, and a failure is seen. The overlay is shown
 * after the capture, so NexQ is only in the picture when it was already on
 * screen (and not hidden from screen share). Failures show a toast.
 */
export async function captureScreenIntoAsk(): Promise<void> {
  if (capturing) return;
  const meetingId = useMeetingStore.getState().activeMeeting?.id;
  // The shortcut is registered only for these, but a press can race the change.
  if (!meetingId || !providerReadsImages(useConfigStore.getState().llmProvider)) return;
  // The meeting ended or changed, or the AI no longer reads images, while we waited:
  // whatever came back belongs to a state the user has left. Drop it quietly.
  const stale = () =>
    useMeetingStore.getState().activeMeeting?.id !== meetingId ||
    !providerReadsImages(useConfigStore.getState().llmProvider);
  capturing = true;
  try {
    let png: ArrayBuffer;
    try {
      png = await captureScreenUnderCursor();
    } catch (error) {
      if (stale()) return;
      // The toast shows in the overlay: bring it back first.
      await showMeetingOverlay().catch(() => {});
      if (!stale()) showToast(captureErrorText(error), "error");
      return;
    }
    if (stale()) return;
    const file = new File([png], "screen.png", { type: "image/png" });
    await showMeetingOverlay().catch(() => {});
    if (stale()) return;
    deliverScreenshot(file);
  } finally {
    capturing = false;
  }
}
