import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALLOWED_IMAGE_TYPES,
  IMAGE_TOO_LARGE,
  MAX_IMAGES,
  MAX_IMAGE_BASE64_LEN,
  MAX_IMAGE_EDGE,
  MAX_INPUT_BYTES,
  base64Length,
  clipboardHasText,
  fitWithin,
  imageFilesFrom,
  providerReadsImages,
  imageProblem,
  prepareImage,
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
    expect(imageProblem({ type: "image/png", size: MAX_INPUT_BYTES + 1 }, 0)).toBe(IMAGE_TOO_LARGE);
    // A 4K screenshot is bigger than 5 MB as a file but shrinks to fit.
    expect(imageProblem({ type: "image/png", size: 8 * 1024 * 1024 }, 0)).toBeNull();
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

describe("fitWithin and base64Length", () => {
  it("shrinks the long edge to the limit and never scales up", () => {
    expect(fitWithin(1000, 9000)).toEqual({ width: 174, height: MAX_IMAGE_EDGE });
    expect(fitWithin(4000, 3000)).toEqual({ width: MAX_IMAGE_EDGE, height: 1176 });
    expect(fitWithin(1568, 800)).toEqual({ width: 1568, height: 800 });
    expect(fitWithin(300, 200)).toEqual({ width: 300, height: 200 });
    expect(fitWithin(10000, 1)).toEqual({ width: MAX_IMAGE_EDGE, height: 1 });
  });

  it("counts base64 text like btoa does", () => {
    expect(base64Length(0)).toBe(0);
    expect(base64Length(5)).toBe(btoa("hello").length);
    expect(base64Length(6)).toBe(btoa("hellos").length);
  });
});

describe("prepareImage", () => {
  type Encoded = { width: number; height: number; type: string; quality?: number };
  let encoded: Encoded[] = [];

  /** A decoded image of `width` x `height`; the canvas encodes to `bytesFor(type)` bytes. */
  function stubCanvas(width: number, height: number, bytesFor: (type: string) => number) {
    encoded = [];
    vi.stubGlobal("createImageBitmap", async () => ({ width, height, close: () => {} }));
    const ctx = { drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: "" };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
      this: HTMLCanvasElement,
      callback: BlobCallback,
      type?: string,
      quality?: unknown,
    ) {
      encoded.push({ width: this.width, height: this.height, type: type ?? "", quality: quality as number | undefined });
      callback(new Blob([new Uint8Array(bytesFor(type ?? ""))], { type }));
    });
    return ctx;
  }

  const file = (bytes: number, type = "image/png") => new File([new Uint8Array(bytes)], "x", { type });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends a small image within the edge limit as pasted", async () => {
    stubCanvas(800, 600, () => 1);
    const small = new File(["hello"], "a.png", { type: "image/png" });
    expect(await prepareImage(small)).toEqual({ media_type: "image/png", data: btoa("hello") });
    expect(encoded).toEqual([]);
  });

  it("shrinks a tall 1000x9000 PNG to a long edge of 1568 and keeps it PNG", async () => {
    const ctx = stubCanvas(1000, 9000, () => 200_000);
    const image = await prepareImage(file(900_000));
    expect(encoded).toEqual([{ width: 174, height: 1568, type: "image/png", quality: undefined }]);
    expect(ctx.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 174, 1568);
    expect(image.media_type).toBe("image/png");
    expect(base64Length(200_000)).toBeLessThan(MAX_IMAGE_BASE64_LEN);
    expect(image.data.length).toBe(base64Length(200_000));
  });

  it("re-encodes a big image that fits the edge limit (a 6 MB file) without resizing it", async () => {
    stubCanvas(1500, 1000, () => 1_000_000);
    const image = await prepareImage(file(6_000_000));
    expect(encoded).toEqual([{ width: 1500, height: 1000, type: "image/png", quality: undefined }]);
    expect(image.media_type).toBe("image/png");
  });

  it("makes a GIF or WebP that needs shrinking a PNG", async () => {
    stubCanvas(4000, 3000, () => 100_000);
    expect((await prepareImage(file(2_000_000, "image/gif"))).media_type).toBe("image/png");
    expect((await prepareImage(file(2_000_000, "image/webp"))).media_type).toBe("image/png");
  });

  it("encodes a JPEG as JPEG at 0.9 on a white background", async () => {
    const ctx = stubCanvas(4000, 3000, () => 300_000);
    const image = await prepareImage(file(2_000_000, "image/jpeg"));
    expect(encoded).toEqual([{ width: MAX_IMAGE_EDGE, height: 1176, type: "image/jpeg", quality: 0.9 }]);
    expect(ctx.fillRect).toHaveBeenCalled();
    expect(image.media_type).toBe("image/jpeg");
  });

  it("falls back to JPEG when the PNG is still over the 5 MB base64 limit", async () => {
    stubCanvas(4000, 3000, (type) => (type === "image/png" ? 4_000_000 : 500_000));
    const image = await prepareImage(file(9_000_000));
    expect(encoded.map((e) => e.type)).toEqual(["image/png", "image/jpeg"]);
    expect(image.media_type).toBe("image/jpeg");
    expect(image.data.length).toBeLessThanOrEqual(MAX_IMAGE_BASE64_LEN);
  });

  it("refuses an image that is still too big after shrinking", async () => {
    stubCanvas(4000, 3000, () => 4_000_000);
    await expect(prepareImage(file(9_000_000))).rejects.toThrow(IMAGE_TOO_LARGE);
  });

  it("refuses a file the browser can't decode", async () => {
    vi.stubGlobal("createImageBitmap", async () => {
      throw new Error("bad image");
    });
    await expect(prepareImage(file(10))).rejects.toThrow("Couldn't read the image");
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

describe("providerReadsImages", () => {
  it("is true only for Claude (subscription)", () => {
    expect(providerReadsImages("claude_cli")).toBe(true);
    for (const other of ["openai", "anthropic", "ollama", "groq", "custom", ""]) {
      expect(providerReadsImages(other)).toBe(false);
    }
  });
});
