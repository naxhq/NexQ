// Images pasted into the Ask box (Ctrl+V): validated, shrunk, turned into
// base64 and sent with the question. Mirrors Rust
// `cli_agent::protocol::ImageAttachment`.

import type { ImageAttachment } from "./types";

// The backend checks the same limits (`validate_images` in
// src-tauri/src/llm/cli_agent/protocol.rs): keep the two in step.

/** Image types the Claude API accepts. */
export const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const MAX_IMAGES = 3;
/** Longest base64 body for one image: the API's 5 MB limit (Rust `MAX_IMAGE_BASE64_LEN`). */
export const MAX_IMAGE_BASE64_LEN = 5_242_880;
/** The long edge Claude sees (larger images are shrunk by the API anyway). */
export const MAX_IMAGE_EDGE = 1568;
/** An image this small, within the edge limit, is sent as pasted. */
export const SEND_AS_IS_BYTES = 1_500_000;
/** Largest file we try to decode: a sanity limit, before any downscaling. */
export const MAX_INPUT_BYTES = 25 * 1024 * 1024;
export const IMAGE_TOO_LARGE = "That image is too large. Paste a smaller area.";

/**
 * Whether the LLM provider can read images. Only Claude (subscription) can;
 * pasting an image and the screen-capture shortcut both depend on this.
 */
export function providerReadsImages(provider: string): boolean {
  return provider === "claude_cli";
}

/** Why `file` can't be attached, or `null` when it can. */
export function imageProblem(file: { type: string; size: number }, already: number): string | null {
  if (already >= MAX_IMAGES) return `You can attach up to ${MAX_IMAGES} images`;
  if (!(ALLOWED_IMAGE_TYPES as readonly string[]).includes(file.type)) {
    return "Only PNG, JPEG, GIF and WebP images can be attached";
  }
  if (file.size > MAX_INPUT_BYTES) return IMAGE_TOO_LARGE;
  return null;
}

/** `width` x `height` scaled down (never up) so the long edge is at most `max`. */
export function fitWithin(width: number, height: number, max = MAX_IMAGE_EDGE): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= max) return { width, height };
  const scale = max / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Length of the base64 text for `bytes` bytes. */
export function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/** Draws the decoded image at `width` x `height` and encodes it; null when the browser can't. */
function encode(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  type: "image/png" | "image/jpeg",
  quality?: number,
): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.resolve(null);
  if (type === "image/jpeg") {
    // JPEG has no transparency: paint white under it.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * A pasted image ready to send: as pasted when it is small, else shrunk to a
 * long edge of 1568 px and re-encoded (PNG for PNG, GIF and WebP; JPEG at 0.9
 * for JPEG, and for a PNG still too big), so one image stays well under the
 * API's 5 MB / 8000 px limits. Throws an `Error` with a message to show.
 */
export async function prepareImage(file: File): Promise<ImageAttachment> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("Couldn't read the image");
  }
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height);
    const resized = width !== bitmap.width || height !== bitmap.height;
    if (!resized && file.size <= SEND_AS_IS_BYTES) return await readImage(file);

    const primary = file.type === "image/jpeg" ? "image/jpeg" : "image/png";
    let blob = await encode(bitmap, width, height, primary, primary === "image/jpeg" ? 0.9 : undefined);
    let type: string = primary;
    if (blob && base64Length(blob.size) > MAX_IMAGE_BASE64_LEN && primary === "image/png") {
      blob = await encode(bitmap, width, height, "image/jpeg", 0.9);
      type = "image/jpeg";
    }
    if (!blob) throw new Error("Couldn't read the image");
    if (base64Length(blob.size) > MAX_IMAGE_BASE64_LEN) throw new Error(IMAGE_TOO_LARGE);
    return await readImage(new File([blob], "image", { type }));
  } finally {
    bitmap.close?.();
  }
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
