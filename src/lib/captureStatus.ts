import { useToastStore, type ToastType } from "../stores/toastStore";
import type { AudioCaptureStatus, CaptureSide } from "./types";

/** A side still reconnecting after this long is shown, so a quiet side isn't a mystery. */
export const RECONNECT_NOTICE_AFTER_MS = 3000;

const reconnectingText: Record<CaptureSide, string> = {
  you: "Reconnecting your microphone…",
  them: "Reconnecting the other side's audio…",
};
const backText: Record<CaptureSide, string> = {
  you: "Your microphone is back.",
  them: "The other side's audio is back.",
};

const SIDES: CaptureSide[] = ["you", "them"];
const stickyKey = (side: CaptureSide) => `capture-${side}`;
const switchKey = (side: CaptureSide) => `capture-switch-${side}`;

export interface CaptureToasts {
  /** A toast that goes by itself, replacing the one with the same key. */
  show: (key: string, message: string, type: ToastType) => void;
  /** A toast that stays until it is replaced or dismissed by its key. */
  sticky: (key: string, message: string, type: ToastType) => void;
  dismiss: (key: string) => void;
}

const storeToasts: CaptureToasts = {
  show: (key, message, type) => useToastStore.getState().setKeyedToast(key, message, type),
  sticky: (key, message, type) => useToastStore.getState().setStickyToast(key, message, type),
  dismiss: (key) => useToastStore.getState().dismissByKey(key),
};

/**
 * Turns `audio_capture_status` events into toasts without ever interrupting a
 * live meeting for nothing:
 * - a reconnect to the same device is silent, unless the side was reconnecting
 *   for more than 3 s (then a reconnecting note is up, and a short "back" replaces it);
 * - a switch to another device shows its message; a later one for the same side
 *   replaces it in place, so what is on screen is always the latest;
 * - a side that is lost, or reconnecting for a while, keeps one toast up until
 *   its recovery arrives.
 * `reset` forgets everything and takes the toasts down: capture has stopped.
 */
export function createCaptureStatusHandler(toasts: CaptureToasts = storeToasts) {
  const timers: Partial<Record<CaptureSide, ReturnType<typeof setTimeout>>> = {};
  const wasLost: Partial<Record<CaptureSide, boolean>> = {};
  const noticeUp: Partial<Record<CaptureSide, boolean>> = {};

  const clearTimer = (side: CaptureSide) => {
    clearTimeout(timers[side]);
    delete timers[side];
  };

  const handle = (status: AudioCaptureStatus) => {
    const { side } = status;
    switch (status.state) {
      case "recovering": {
        if (timers[side] || noticeUp[side] || wasLost[side]) return;
        timers[side] = setTimeout(() => {
          delete timers[side];
          noticeUp[side] = true;
          toasts.sticky(stickyKey(side), reconnectingText[side], "warning");
        }, RECONNECT_NOTICE_AFTER_MS);
        return;
      }
      case "lost": {
        clearTimer(side);
        wasLost[side] = true;
        noticeUp[side] = true;
        toasts.sticky(stickyKey(side), status.message, "warning");
        return;
      }
      case "recovered": {
        clearTimer(side);
        const hadNotice = noticeUp[side] === true;
        toasts.dismiss(stickyKey(side));
        delete noticeUp[side];
        delete wasLost[side];
        if (status.message) {
          toasts.show(switchKey(side), status.message, "info");
        } else if (hadNotice) {
          toasts.show(switchKey(side), backText[side], "info");
        }
        return;
      }
    }
  };

  const reset = () => {
    for (const side of SIDES) {
      clearTimer(side);
      delete wasLost[side];
      delete noticeUp[side];
      toasts.dismiss(stickyKey(side));
      toasts.dismiss(switchKey(side));
    }
  };

  return { handle, reset };
}
