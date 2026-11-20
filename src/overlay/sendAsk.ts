import { runYourAction } from "../lib/autoAnswer";
import type { ImageAttachment } from "../lib/types";
import { showToast } from "../stores/toastStore";

/**
 * Sent when an image is pasted and the question box is left empty. The image is
 * the task itself (a question, an exercise), not something to describe.
 */
export const DEFAULT_IMAGE_QUESTION =
  "The attached image is the task or question to handle. Read it and answer or solve it directly, in the context of the meeting. Do not describe the image.";

/** The toast for a rejected send. Tauri rejects with plain text: with an image, say why. */
export function askErrorMessage(err: unknown, withImages: boolean, fallback: string): string {
  if (err instanceof Error) return err.message;
  if (withImages && typeof err === "string" && err) return err;
  return fallback;
}

interface SendAskOptions {
  /** What was typed in the Ask box. */
  typed: string;
  images: ImageAttachment[];
  /** Toast text when the send fails without a message of its own. */
  fallbackError: string;
  /** The request is on its way (true) or finished either way (false). */
  onSending?: (sending: boolean) => void;
  /** The answer came: the box and its images can be cleared. */
  onSent?: () => void;
  /** The send failed: hand the typed text back so it isn't lost. */
  onFailed?: (typed: string) => void;
}

/**
 * Sends the Ask box as an `AskQuestion` request: the typed text, or, with only
 * images, a question that makes the image the task. Shared by both Ask boxes.
 * Returns false when there is nothing to send.
 */
export function sendAsk({ typed, images, fallbackError, onSending, onSent, onFailed }: SendAskOptions): boolean {
  const text = typed.trim() || (images.length > 0 ? DEFAULT_IMAGE_QUESTION : "");
  if (!text) return false;
  const withImages = images.length > 0;
  onSending?.(true);
  runYourAction("AskQuestion", text, images)
    .then(
      () => onSent?.(),
      (err) => {
        showToast(askErrorMessage(err, withImages, fallbackError), "error");
        onFailed?.(typed);
      },
    )
    .finally(() => onSending?.(false));
  return true;
}
