import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capture = vi.hoisted(() => vi.fn<() => Promise<ArrayBuffer>>());
const overlay = vi.hoisted(() => ({ shown: 0, log: [] as string[] }));
vi.mock("./ipc", () => ({ captureScreenUnderCursor: capture }));
vi.mock("./windows", () => ({
  showMeetingOverlay: async () => {
    overlay.shown += 1;
    overlay.log.push("show");
  },
}));

import {
  PENDING_SCREENSHOT_MS,
  SCREENSHOT_EVENT,
  SCREENSHOT_NOT_ATTACHED,
  captureErrorText,
  captureScreenIntoAsk,
  deliverScreenshot,
  discardPendingScreenshots,
  leaveSettingsForAsk,
  takePendingScreenshots,
} from "./screenCapture";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useToastStore } from "../stores/toastStore";
import type { Meeting } from "./types";

const bytes = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;
const shot = () => new File(["a"], "a.png", { type: "image/png" });
const messages = () => useToastStore.getState().toasts.map((t) => t.message);

beforeEach(() => {
  discardPendingScreenshots();
  capture.mockReset().mockImplementation(async () => bytes());
  overlay.shown = 0;
  overlay.log = [];
  useConfigStore.setState({ llmProvider: "claude_cli" });
  useMeetingStore.setState({ activeMeeting: { id: "m" } as Meeting, currentView: "overlay", settingsOpen: false });
  useToastStore.setState({ toasts: [] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A listener the way the Ask box has one: it takes the picture and claims the event. */
function askBoxListening() {
  const listener = (e: Event) => {
    takePendingScreenshots();
    e.preventDefault();
  };
  window.addEventListener(SCREENSHOT_EVENT, listener);
  return () => window.removeEventListener(SCREENSHOT_EVENT, listener);
}

describe("captureScreenIntoAsk", () => {
  it("hands the screenshot to the Ask box as a PNG file and tells the window", async () => {
    const files: File[] = [];
    const listener = (e: Event) => {
      files.push(...takePendingScreenshots());
      e.preventDefault();
    };
    window.addEventListener(SCREENSHOT_EVENT, listener);
    await captureScreenIntoAsk();
    window.removeEventListener(SCREENSHOT_EVENT, listener);

    expect(files).toHaveLength(1);
    expect(files[0].type).toBe("image/png");
    expect(files[0].size).toBe(4);
    expect(messages()).toEqual([]);
  });

  it("runs the show path on every press (the overlay may be visible but not focused), after the capture", async () => {
    capture.mockImplementation(async () => {
      overlay.log.push("capture");
      return bytes();
    });
    const heard = () => overlay.log.push("ask");
    window.addEventListener(SCREENSHOT_EVENT, heard);
    const stop = askBoxListening();
    await captureScreenIntoAsk();
    await captureScreenIntoAsk();
    window.removeEventListener(SCREENSHOT_EVENT, heard);
    stop();
    expect(overlay.log).toEqual(["capture", "show", "ask", "capture", "show", "ask"]);
  });

  it("brings the overlay back before the error toast, and attaches nothing", async () => {
    capture.mockRejectedValue("NexQ couldn't read the screen.");
    const seen: string[][] = [];
    const unsubscribe = useToastStore.subscribe(() => seen.push([...overlay.log, "toast"]));
    await captureScreenIntoAsk();
    unsubscribe();
    expect(seen[0]).toEqual(["show", "toast"]);
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ message: "NexQ couldn't read the screen.", type: "error" }),
    ]);
    expect(takePendingScreenshots()).toHaveLength(0);
  });

  it("drops a capture quietly when the meeting changes while it is in flight", async () => {
    let finish!: () => void;
    capture.mockImplementation(() => new Promise((resolve) => (finish = () => resolve(bytes()))));
    const delivered = vi.fn();
    window.addEventListener(SCREENSHOT_EVENT, delivered);
    const press = captureScreenIntoAsk();
    useMeetingStore.setState({ activeMeeting: { id: "other" } as Meeting });
    finish();
    await press;
    window.removeEventListener(SCREENSHOT_EVENT, delivered);
    expect(delivered).not.toHaveBeenCalled();
    expect(overlay.shown).toBe(0);
    expect(messages()).toEqual([]);
    expect(takePendingScreenshots()).toHaveLength(0);
  });

  it("drops a capture quietly when the AI stops reading images while it is in flight", async () => {
    let finish!: () => void;
    capture.mockImplementation(() => new Promise((resolve) => (finish = () => resolve(bytes()))));
    const press = captureScreenIntoAsk();
    useConfigStore.setState({ llmProvider: "openai" });
    finish();
    await press;
    expect(overlay.shown).toBe(0);
    expect(messages()).toEqual([]);
  });

  it("drops it too when the meeting ends while the overlay is being shown", async () => {
    const delivered = vi.fn();
    window.addEventListener(SCREENSHOT_EVENT, delivered);
    const press = captureScreenIntoAsk();
    await Promise.resolve();
    useMeetingStore.setState({ activeMeeting: null });
    await press;
    window.removeEventListener(SCREENSHOT_EVENT, delivered);
    expect(delivered).not.toHaveBeenCalled();
    expect(messages()).toEqual([]);
  });

  it("says nothing about a failed capture of a meeting that is over", async () => {
    let fail!: () => void;
    capture.mockImplementation(() => new Promise((_, reject) => (fail = () => reject("nope"))));
    const press = captureScreenIntoAsk();
    useMeetingStore.setState({ activeMeeting: null });
    fail();
    await press;
    expect(messages()).toEqual([]);
    expect(overlay.shown).toBe(0);
  });

  it("does nothing without a meeting or when the AI can't read images", async () => {
    useMeetingStore.setState({ activeMeeting: null });
    await captureScreenIntoAsk();
    useMeetingStore.setState({ activeMeeting: { id: "m" } as Meeting });
    useConfigStore.setState({ llmProvider: "openai" });
    await captureScreenIntoAsk();
    expect(capture).not.toHaveBeenCalled();
    expect(overlay.shown).toBe(0);
  });

  it("ignores a second press while one capture is running", async () => {
    let release!: () => void;
    capture.mockImplementation(() => new Promise((resolve) => (release = () => resolve(bytes()))));
    const stop = askBoxListening();
    const first = captureScreenIntoAsk();
    await captureScreenIntoAsk();
    expect(capture).toHaveBeenCalledTimes(1);
    release();
    await first;
    stop();
  });
});

describe("delivering a screenshot", () => {
  it("is handed over once", () => {
    const stop = askBoxListening();
    deliverScreenshot(shot());
    stop();
    expect(takePendingScreenshots()).toHaveLength(0);
    expect(messages()).toEqual([]);
  });

  it("tells the user, right away, when nobody claims it", () => {
    deliverScreenshot(shot());
    expect(messages()).toEqual([SCREENSHOT_NOT_ATTACHED]);
    expect(takePendingScreenshots()).toHaveLength(0);
  });

  it("a claimed picture that no Ask box takes in time is announced, not dropped silently", () => {
    vi.useFakeTimers();
    const claim = (e: Event) => e.preventDefault(); // e.g. making room for the Ask box
    window.addEventListener(SCREENSHOT_EVENT, claim);
    deliverScreenshot(shot());
    window.removeEventListener(SCREENSHOT_EVENT, claim);
    expect(messages()).toEqual([]);
    vi.advanceTimersByTime(PENDING_SCREENSHOT_MS + 1);
    expect(messages()).toEqual([SCREENSHOT_NOT_ATTACHED]);
  });

  it("one the Ask box took in time never produces the late toast", () => {
    vi.useFakeTimers();
    const claim = (e: Event) => e.preventDefault();
    window.addEventListener(SCREENSHOT_EVENT, claim);
    deliverScreenshot(shot());
    window.removeEventListener(SCREENSHOT_EVENT, claim);
    expect(takePendingScreenshots()).toHaveLength(1);
    vi.advanceTimersByTime(PENDING_SCREENSHOT_MS + 1);
    expect(messages()).toEqual([]);
  });

  it("a waiting screenshot is cleared when the meeting changes", () => {
    vi.useFakeTimers();
    const claim = (e: Event) => e.preventDefault();
    window.addEventListener(SCREENSHOT_EVENT, claim);
    deliverScreenshot(shot());
    window.removeEventListener(SCREENSHOT_EVENT, claim);
    useMeetingStore.setState({ activeMeeting: { id: "next" } as Meeting });
    expect(takePendingScreenshots()).toHaveLength(0);
    vi.advanceTimersByTime(PENDING_SCREENSHOT_MS + 1);
    expect(messages()).toEqual([]);
  });

  it("a stale screenshot is not handed over", () => {
    const claim = (e: Event) => e.preventDefault();
    window.addEventListener(SCREENSHOT_EVENT, claim);
    deliverScreenshot(shot());
    window.removeEventListener(SCREENSHOT_EVENT, claim);
    expect(takePendingScreenshots(Date.now() + PENDING_SCREENSHOT_MS + 1000)).toHaveLength(0);
  });
});

describe("leaveSettingsForAsk", () => {
  it("goes from the Settings view back to the meeting view", () => {
    useMeetingStore.setState({ currentView: "settings", previousView: "overlay" });
    expect(leaveSettingsForAsk()).toBe(true);
    expect(useMeetingStore.getState().currentView).toBe("overlay");
  });

  it("closes the Settings modal over the meeting", () => {
    useMeetingStore.setState({ currentView: "overlay", settingsOpen: true });
    expect(leaveSettingsForAsk()).toBe(true);
    expect(useMeetingStore.getState().settingsOpen).toBe(false);
  });

  it("leaves the meeting view alone", () => {
    expect(leaveSettingsForAsk()).toBe(false);
    expect(useMeetingStore.getState().currentView).toBe("overlay");
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
