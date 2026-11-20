// The screen-capture shortcut: grab the screen under the mouse pointer and hand
// it to the Ask box as an attachment. The picture stays in memory (a `File` that
// is attached or dropped); nothing is saved or logged.

import { captureScreenUnderCursor } from "./ipc";
import { providerReadsImages } from "./imageAttachments";
import { isOverlayVisible, showMeetingOverlay } from "./windows";
import { showToast } from "../stores/toastStore";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";

/** Window event: a captured screenshot is waiting for the Ask box (see {@link takePendingScreenshots}). */
export const SCREENSHOT_EVENT = "nexq:screenshot-captured";

/** How long a screenshot waits for an Ask box that isn't on screen yet. */
export const PENDING_SCREENSHOT_MS = 30_000;

const pending: Array<{ file: File; at: number }> = [];

/**
 * The screenshots waiting for the Ask box, oldest first, and forgets them.
 * One that waited too long (the Ask box never came, e.g. the overlay was
 * showing Settings) is dropped, so a stale picture never shows up later.
 */
export function takePendingScreenshots(now = Date.now()): File[] {
  const files = pending.filter((p) => now - p.at <= PENDING_SCREENSHOT_MS).map((p) => p.file);
  pending.length = 0;
  return files;
}

/** Hands a screenshot to the Ask box. */
export function deliverScreenshot(file: File): void {
  pending.push({ file, at: Date.now() });
  window.dispatchEvent(new Event(SCREENSHOT_EVENT));
}

/** The sentence to show for a failed capture. */
export function captureErrorText(error: unknown): string {
  const text = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  return text.trim() || "Couldn't capture the screen";
}

let capturing = false;

/**
 * The capture shortcut: screenshot of the screen under the pointer, attached
 * to the Ask box (never sent). If the overlay is hidden it is brought back
 * (as Ctrl+B does) after the capture, so NexQ is only in the picture when it
 * was already on screen (and not hidden from screen share). Failures show a toast.
 */
export async function captureScreenIntoAsk(): Promise<void> {
  if (capturing) return;
  // The shortcut is registered only for these, but a press can race the change.
  if (!useMeetingStore.getState().activeMeeting || !providerReadsImages(useConfigStore.getState().llmProvider)) return;
  capturing = true;
  try {
    let png: ArrayBuffer;
    try {
      png = await captureScreenUnderCursor();
    } catch (error) {
      showToast(captureErrorText(error), "error");
      return;
    }
    const file = new File([png], "screen.png", { type: "image/png" });
    if (!(await isOverlayVisible())) await showMeetingOverlay().catch(() => {});
    deliverScreenshot(file);
  } finally {
    capturing = false;
  }
}
