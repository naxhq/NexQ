import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capture = vi.hoisted(() => vi.fn<() => Promise<ArrayBuffer>>());
const overlay = vi.hoisted(() => ({ visible: true, shown: 0 }));
vi.mock("./ipc", () => ({ captureScreenUnderCursor: capture }));
vi.mock("./windows", () => ({
  isOverlayVisible: async () => overlay.visible,
  showMeetingOverlay: async () => {
    overlay.shown += 1;
  },
}));

import {
  PENDING_SCREENSHOT_MS,
  SCREENSHOT_EVENT,
  captureErrorText,
  captureScreenIntoAsk,
  deliverScreenshot,
  takePendingScreenshots,
} from "./screenCapture";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useToastStore } from "../stores/toastStore";
import type { Meeting } from "./types";

const bytes = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;

beforeEach(() => {
  takePendingScreenshots(Number.MAX_SAFE_INTEGER);
  capture.mockReset().mockImplementation(async () => bytes());
  overlay.visible = true;
  overlay.shown = 0;
  useConfigStore.setState({ llmProvider: "claude_cli" });
  useMeetingStore.setState({ activeMeeting: { id: "m" } as Meeting });
  useToastStore.setState({ toasts: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("captureScreenIntoAsk", () => {
  it("hands the screenshot to the Ask box as a PNG file and tells the window", async () => {
    const heard = vi.fn();
    window.addEventListener(SCREENSHOT_EVENT, heard);
    await captureScreenIntoAsk();
    window.removeEventListener(SCREENSHOT_EVENT, heard);

    expect(heard).toHaveBeenCalledTimes(1);
    const files = takePendingScreenshots();
    expect(files).toHaveLength(1);
    expect(files[0].type).toBe("image/png");
    expect(files[0].size).toBe(4);
    expect(overlay.shown).toBe(0);
  });

  it("brings a hidden overlay back, after the capture", async () => {
    overlay.visible = false;
    const order: string[] = [];
    capture.mockImplementation(async () => {
      order.push("capture");
      return bytes();
    });
    const heard = () => order.push(`shown:${overlay.shown}`);
    window.addEventListener(SCREENSHOT_EVENT, heard);
    await captureScreenIntoAsk();
    window.removeEventListener(SCREENSHOT_EVENT, heard);
    // The overlay is shown only once the picture is taken, before the Ask box gets it.
    expect(order).toEqual(["capture", "shown:1"]);
  });

  it("shows a plain error toast and attaches nothing when the capture fails", async () => {
    capture.mockRejectedValue("NexQ needs the Screen Recording permission.");
    await captureScreenIntoAsk();
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ message: "NexQ needs the Screen Recording permission.", type: "error" }),
    ]);
    expect(takePendingScreenshots()).toHaveLength(0);
    expect(overlay.shown).toBe(0);
  });

  it("does nothing without a meeting or when the AI can't read images", async () => {
    useMeetingStore.setState({ activeMeeting: null });
    await captureScreenIntoAsk();
    useMeetingStore.setState({ activeMeeting: { id: "m" } as Meeting });
    useConfigStore.setState({ llmProvider: "openai" });
    await captureScreenIntoAsk();
    expect(capture).not.toHaveBeenCalled();
  });

  it("ignores a second press while one capture is running", async () => {
    let release!: () => void;
    capture.mockImplementation(() => new Promise((resolve) => (release = () => resolve(bytes()))));
    const first = captureScreenIntoAsk();
    await captureScreenIntoAsk();
    expect(capture).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(takePendingScreenshots()).toHaveLength(1);
  });
});

describe("pending screenshots", () => {
  it("are handed over once", () => {
    deliverScreenshot(new File(["a"], "a.png", { type: "image/png" }));
    expect(takePendingScreenshots()).toHaveLength(1);
    expect(takePendingScreenshots()).toHaveLength(0);
  });

  it("are dropped when no Ask box took them in time", () => {
    deliverScreenshot(new File(["a"], "a.png", { type: "image/png" }));
    expect(takePendingScreenshots(Date.now() + PENDING_SCREENSHOT_MS + 1000)).toHaveLength(0);
  });
});

describe("captureErrorText", () => {
  it("uses the backend sentence, else a plain fallback", () => {
    expect(captureErrorText("The screen came out black.")).toBe("The screen came out black.");
    expect(captureErrorText(new Error("boom"))).toBe("boom");
    expect(captureErrorText(undefined)).toBe("Couldn't capture the screen");
    expect(captureErrorText("  ")).toBe("Couldn't capture the screen");
  });
});
