// Images pasted into the Ask box (Ctrl+V): validated, turned into base64 and
// sent with the question. Mirrors Rust `cli_agent::protocol::ImageAttachment`.

import type { ImageAttachment } from "./types";

// The backend checks the same limits (`validate_images` in
// src-tauri/src/llm/cli_agent/protocol.rs): keep the two in step.

/** Image types the Claude API accepts. */
export const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
/** Pasted screenshots are small; this keeps one message well under the API limit. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES = 3;

/** Why `file` can't be attached, or `null` when it can. */
export function imageProblem(file: { type: string; size: number }, already: number): string | null {
  if (already >= MAX_IMAGES) return `You can attach up to ${MAX_IMAGES} images`;
  if (!(ALLOWED_IMAGE_TYPES as readonly string[]).includes(file.type)) {
    return "Only PNG, JPEG, GIF and WebP images can be attached";
  }
  if (file.size > MAX_IMAGE_BYTES) return "That image is larger than 5 MB";
  return null;
}

/**
 * Whether the clipboard carries text. Copies from Excel, Word or a web page
 * bring a rendered picture along with their text; that is a text paste, not a
 * screenshot, so the picture must not be attached.
 */
export function clipboardHasText(data: DataTransfer | null): boolean {
  if (!data) return false;
  try {
    return data.getData("text/plain").trim().length > 0;
  } catch {
    return false;
  }
}

/** The image files on a clipboard (a screenshot arrives as one `image/png` item). */
export function imageFilesFrom(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return files;
}

/** Reads `file` as a base64 attachment (no `data:` prefix). */
export function readImage(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the image"));
    reader.onload = () => {
      const url = String(reader.result ?? "");
      const comma = url.indexOf(",");
      if (comma < 0) {
        reject(new Error("Couldn't read the image"));
        return;
      }
      resolve({ media_type: file.type, data: url.slice(comma + 1) });
    };
    reader.readAsDataURL(file);
  });
}

/** The `src` that shows an attachment in an `<img>`. */
export function previewSrc(image: ImageAttachment): string {
  return `data:${image.media_type};base64,${image.data}`;
}
