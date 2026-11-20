import { describe, expect, it } from "vitest";
import {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  clipboardHasText,
  imageFilesFrom,
  imageProblem,
  previewSrc,
  readImage,
} from "./imageAttachments";

describe("imageProblem", () => {
  it("accepts the image types Claude takes", () => {
    for (const type of ALLOWED_IMAGE_TYPES) {
      expect(imageProblem({ type, size: 1000 }, 0)).toBeNull();
    }
  });

  it("refuses other types, big files and a fourth image", () => {
    expect(imageProblem({ type: "image/bmp", size: 10 }, 0)).toMatch(/PNG, JPEG/);
    expect(imageProblem({ type: "application/pdf", size: 10 }, 0)).toMatch(/PNG, JPEG/);
    expect(imageProblem({ type: "image/png", size: MAX_IMAGE_BYTES + 1 }, 0)).toMatch(/5 MB/);
    expect(imageProblem({ type: "image/png", size: MAX_IMAGE_BYTES }, 0)).toBeNull();
    expect(imageProblem({ type: "image/png", size: 10 }, MAX_IMAGES)).toMatch(/up to 3/);
  });
});

describe("imageFilesFrom", () => {
  const item = (kind: string, type: string, file: File | null) => ({ kind, type, getAsFile: () => file });

  it("returns only the image files on the clipboard", () => {
    const png = new File(["x"], "shot.png", { type: "image/png" });
    const data = {
      items: [item("string", "text/plain", null), item("file", "image/png", png), item("file", "text/csv", null)],
    } as unknown as DataTransfer;
    expect(imageFilesFrom(data)).toEqual([png]);
  });

  it("copes with no clipboard data", () => {
    expect(imageFilesFrom(null)).toEqual([]);
  });
});

describe("readImage", () => {
  it("returns the base64 body without the data: prefix", async () => {
    const file = new File(["hello"], "a.png", { type: "image/png" });
    const image = await readImage(file);
    expect(image).toEqual({ media_type: "image/png", data: btoa("hello") });
    expect(previewSrc(image)).toBe(`data:image/png;base64,${btoa("hello")}`);
  });
});

describe("clipboardHasText", () => {
  const clip = (text: string) => ({ getData: () => text }) as unknown as DataTransfer;

  it("is true for a clipboard with text, false for none or blank", () => {
    expect(clipboardHasText(clip("A1\tB1"))).toBe(true);
    expect(clipboardHasText(clip(""))).toBe(false);
    expect(clipboardHasText(clip("  \n"))).toBe(false);
    expect(clipboardHasText(null)).toBe(false);
  });
});
