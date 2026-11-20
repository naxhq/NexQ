import { useToastStore, type ToastType } from "../stores/toastStore";
import type { AudioCaptureStatus, CaptureSide } from "./types";

/** A side still reconnecting after this long is shown, so a quiet side isn't a mystery. */
export const RECONNECT_NOTICE_AFTER_MS = 3000;
/** At most one "switched to another device" toast per side in this time. */
export const SWITCH_TOAST_INTERVAL_MS = 10_000;

const reconnectingText: Record<CaptureSide, string> = {
  you: "Reconnecting your microphone…",
  them: "Reconnecting the other side's audio…",
};
const backText: Record<CaptureSide, string> = {
  you: "Your microphone is back.",
  them: "The other side's audio is back.",
};

export interface CaptureToasts {
  show: (message: string, type: ToastType) => void;
  sticky: (key: string, message: string, type: ToastType) => void;
  dismiss: (key: string) => void;
}

const storeToasts: CaptureToasts = {
  show: (message, type) => useToastStore.getState().addToast(message, type),
  sticky: (key, message, type) => useToastStore.getState().setStickyToast(key, message, type),
  dismiss: (key) => useToastStore.getState().dismissByKey(key),
};

/**
 * Turns `audio_capture_status` events into toasts without ever interrupting a
 * live meeting for nothing:
 * - a reconnect to the same device is silent, unless the side was reconnecting
 *   for more than 3 s (then a reconnecting notice is up, and a short "back" replaces it);
 * - a switch to another device shows once per side every 10 s;
 * - a side that is lost, or reconnecting for a while, keeps one toast up until
 *   its recovery arrives; "lost" and what follows it are always shown.
 */
export function createCaptureStatusHandler(toasts: CaptureToasts = storeToasts) {
  const lastSwitch: Partial<Record<CaptureSide, number>> = {};
  const timers: Partial<Record<CaptureSide, ReturnType<typeof setTimeout>>> = {};
  const wasLost: Partial<Record<CaptureSide, boolean>> = {};
  const noticeUp: Partial<Record<CaptureSide, boolean>> = {};
  const key = (side: CaptureSide) => `capture-${side}`;

  const clearTimer = (side: CaptureSide) => {
    clearTimeout(timers[side]);
    delete timers[side];
  };

  return (status: AudioCaptureStatus) => {
    const { side } = status;
    switch (status.state) {
      case "recovering": {
        if (timers[side] || noticeUp[side] || wasLost[side]) return;
        timers[side] = setTimeout(() => {
          delete timers[side];
          noticeUp[side] = true;
          toasts.sticky(key(side), reconnectingText[side], "warning");
        }, RECONNECT_NOTICE_AFTER_MS);
        return;
      }
      case "lost": {
        clearTimer(side);
        wasLost[side] = true;
        noticeUp[side] = true;
        toasts.sticky(key(side), status.message, "warning");
        return;
      }
      case "recovered": {
        clearTimer(side);
        const hadNotice = noticeUp[side] === true;
        const afterLost = wasLost[side] === true;
        toasts.dismiss(key(side));
        delete noticeUp[side];
        delete wasLost[side];
        if (!status.message) {
          if (hadNotice) toasts.show(backText[side], "info");
          return;
        }
        const now = Date.now();
        const last = lastSwitch[side];
        if (afterLost || last === undefined || now - last >= SWITCH_TOAST_INTERVAL_MS) {
          lastSwitch[side] = now;
          toasts.show(status.message, "info");
        }
        return;
      }
    }
  };
}
