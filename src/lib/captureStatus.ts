import type { AudioCaptureStatus } from "./types";
import type { ToastType } from "../stores/toastStore";

/**
 * The toast for a capture status, if any. A live meeting is never
 * interrupted for a reconnect that worked on the same device: only a switch
 * to another device (info) or a side that didn't come back (warning) shows.
 */
export function captureStatusToast(status: AudioCaptureStatus): { message: string; type: ToastType } | null {
  if (!status.message) return null;
  switch (status.state) {
    case "recovered":
      return { message: status.message, type: "info" };
    case "lost":
      return { message: status.message, type: "warning" };
    default:
      return null;
  }
}
