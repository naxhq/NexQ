import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { MeetingSummary } from "../lib/types";

type Handler = (e: { payload: unknown }) => void;
const listeners = new Map<string, Set<Handler>>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: Handler) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name)!.add(cb);
    return () => listeners.get(name)!.delete(cb);
  },
  emit: async () => {},
}));

const windowLabel = vi.hoisted(() => ({ value: "launcher" }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: windowLabel.value }),
}));

// In-memory plugin-store: `data` is nexq-settings.json; `broken` makes it unreadable.
const settings = vi.hoisted(() => ({ data: new Map<string, unknown>(), broken: false }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => {
    if (settings.broken) throw new Error("store unavailable");
    return {
      get: async (key: string) => settings.data.get(key),
      set: async (key: string, value: unknown) => {
        settings.data.set(key, value);
      },
    };
  },
}));

const ipc = vi.hoisted(() => ({ listMeetings: vi.fn() }));
vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  listMeetings: (...a: unknown[]) => ipc.listMeetings(...a),
}));

import { useStarPrompt } from "./useStarPrompt";
import { useMeetingStore } from "../stores/meetingStore";
import { useConfigStore } from "../stores/configStore";
import { useDemoStore } from "../demo/demoStore";
import { useUpdaterStore } from "../stores/updaterStore";
import { STAR_PROMPT_SHOWN_KEY } from "../lib/starPrompt";

// Literal on purpose: these are the product rules (2.5 s after the event, 2 s on screen).
const TRIGGER_DELAY_MS = 2_500;
const SHOWN_AFTER_MS = 2_000;

function summaries(count: number, agoMs = 20_000): MeetingSummary[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    title: `Meeting ${i}`,
    start_time: new Date(Date.now() - (i + 1) * 3_600_000).toISOString(),
    end_time: new Date(Date.now() - agoMs - i * 3_600_000).toISOString(),
    duration_seconds: 600,
    segment_count: 8,
    has_summary: false,
  }));
}

function meetingEnded(window: string) {
  listeners.get("nexq:meeting_ended")?.forEach((cb) => cb({ payload: { window } }));
}

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

async function mountHook() {
  const hook = renderHook(() => useStarPrompt());
  await advance(0); // the listener registers asynchronously
  return hook;
}

/** One meeting ended, as both windows report it, and the trigger delay passed. */
async function endMeeting() {
  meetingEnded("overlay");
  meetingEnded("launcher");
  await advance(TRIGGER_DELAY_MS);
}

describe("useStarPrompt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    listeners.clear();
    windowLabel.value = "launcher";
    settings.data.clear();
    settings.broken = false;
    ipc.listMeetings.mockReset().mockImplementation(async () => summaries(5));
    useMeetingStore.setState({ activeMeeting: null, meetingStarting: false, currentView: "launcher", settingsOpen: false });
    useConfigStore.setState({ firstRunCompleted: true });
    useDemoStore.setState({ isDemoActive: false });
    useUpdaterStore.getState().reset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows after the fifth finished meeting, once the delay has passed", async () => {
    const { result } = await mountHook();
    meetingEnded("launcher");
    await advance(TRIGGER_DELAY_MS - 1);
    expect(result.current.visible).toBe(false);
    await advance(1);
    expect(result.current.visible).toBe(true);
  });

  it("reads the 50 newest meetings fresh, once, for the event both windows send", async () => {
    // Real reads take time: without the debounce a second read would start meanwhile.
    ipc.listMeetings.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(summaries(5)), 20)),
    );
    const { result } = await mountHook();
    await endMeeting();
    await advance(100);
    expect(result.current.visible).toBe(true);
    expect(ipc.listMeetings).toHaveBeenCalledTimes(1);
    expect(ipc.listMeetings).toHaveBeenCalledWith(50, 0);
  });

  it("a second meeting-ended event while it is up does not show a second card", async () => {
    const { result } = await mountHook();
    await endMeeting();
    await endMeeting();
    expect(result.current.visible).toBe(true);
    expect(ipc.listMeetings).toHaveBeenCalledTimes(1);
  });

  it("stays away on the fourth meeting", async () => {
    ipc.listMeetings.mockImplementation(async () => summaries(4));
    const { result } = await mountHook();
    await endMeeting();
    expect(result.current.visible).toBe(false);
  });

  it("works for an old saved config that has no starPromptShown key", async () => {
    settings.data.set("auto_update", true);
    const { result } = await mountHook();
    await endMeeting();
    expect(result.current.visible).toBe(true);
  });

  it("stays away once it was shown", async () => {
    settings.data.set(STAR_PROMPT_SHOWN_KEY, true);
    const { result } = await mountHook();
    await endMeeting();
    expect(result.current.visible).toBe(false);
  });

  it("does not show when the setting can't be read (never nag)", async () => {
    settings.broken = true;
    const { result } = await mountHook();
    await endMeeting();
    expect(result.current.visible).toBe(false);
  });

  it("does not show when the meetings can't be read", async () => {
    ipc.listMeetings.mockRejectedValue(new Error("db busy"));
    const { result } = await mountHook();
    await endMeeting();
    expect(result.current.visible).toBe(false);
  });

  it("does not show after a demo ends (no recent real meeting)", async () => {
    ipc.listMeetings.mockImplementation(async () => summaries(9, 3 * 3_600_000));
    const { result } = await mountHook();
    await endMeeting();
    expect(result.current.visible).toBe(false);
  });

  it("does not show while a demo is running", async () => {
    useDemoStore.setState({ isDemoActive: true });
    const { result } = await mountHook();
    await endMeeting();
    expect(result.current.visible).toBe(false);
  });

  it("does nothing outside the launcher window", async () => {
    windowLabel.value = "overlay";
    const { result } = await mountHook();
    await endMeeting();
    expect(listeners.get("nexq:meeting_ended")?.size ?? 0).toBe(0);
    expect(result.current.visible).toBe(false);
  });

  it("saves that it was shown after 2 s on screen, not before", async () => {
    const { result } = await mountHook();
    await endMeeting();
    expect(result.current.visible).toBe(true);
    await advance(SHOWN_AFTER_MS - 1);
    expect(settings.data.has(STAR_PROMPT_SHOWN_KEY)).toBe(false);
    await advance(1);
    expect(settings.data.get(STAR_PROMPT_SHOWN_KEY)).toBe(true);
  });

  it("does not save when it was on screen for less than 2 s", async () => {
    const { result } = await mountHook();
    await endMeeting();
    await advance(SHOWN_AFTER_MS - 500);
    act(() => useMeetingStore.setState({ meetingStarting: true }));
    expect(result.current.visible).toBe(false);
    await advance(5_000);
    expect(settings.data.has(STAR_PROMPT_SHOWN_KEY)).toBe(false);
  });

  it("saves at once when the user acts, and close takes the card away", async () => {
    const { result } = await mountHook();
    await endMeeting();
    await act(async () => result.current.acknowledge());
    expect(settings.data.get(STAR_PROMPT_SHOWN_KEY)).toBe(true);
    expect(result.current.visible).toBe(true);
    await act(async () => result.current.close());
    expect(result.current.visible).toBe(false);
  });

  it("does not come back after it was closed", async () => {
    const { result } = await mountHook();
    await endMeeting();
    await act(async () => result.current.close());
    await endMeeting();
    expect(result.current.visible).toBe(false);
  });

  describe("waiting for the screen", () => {
    it.each([
      ["settings", () => useMeetingStore.setState({ currentView: "settings" }), () => useMeetingStore.setState({ currentView: "launcher" })],
      ["the update dialog", () => useUpdaterStore.getState().setDialogOpen(true), () => useUpdaterStore.getState().setDialogOpen(false)],
      ["the update notice", () => useUpdaterStore.getState().setReadyToastVisible(true), () => useUpdaterStore.getState().setReadyToastVisible(false)],
      ["an install", () => useUpdaterStore.getState().setInstalling(true), () => useUpdaterStore.getState().setInstalling(false)],
      ["the wizard", () => useConfigStore.setState({ firstRunCompleted: false }), () => useConfigStore.setState({ firstRunCompleted: true })],
    ])("waits for %s, then shows", async (_name, block, unblock) => {
      block();
      const { result } = await mountHook();
      await endMeeting();
      expect(result.current.visible).toBe(false);
      await advance(5 * 60_000); // longer than the 2-minute window: the check already passed
      expect(result.current.visible).toBe(false);
      act(() => unblock());
      expect(result.current.visible).toBe(true);
    });

    it("hides at once when one of them appears while it is up", async () => {
      const { result } = await mountHook();
      await endMeeting();
      expect(result.current.visible).toBe(true);
      act(() => useUpdaterStore.getState().setReadyToastVisible(true));
      expect(result.current.visible).toBe(false);
      act(() => useUpdaterStore.getState().setReadyToastVisible(false));
      expect(result.current.visible).toBe(true);
    });

    it("an acted-on card that gets covered is finished, not parked", async () => {
      const { result } = await mountHook();
      await endMeeting();
      await act(async () => result.current.acknowledge());
      act(() => useMeetingStore.setState({ currentView: "settings" }));
      act(() => useMeetingStore.setState({ currentView: "launcher" }));
      expect(result.current.visible).toBe(false);
    });
  });

  describe("a meeting starting", () => {
    it("drops a card that is waiting, and the next meeting's end offers it again", async () => {
      useMeetingStore.setState({ currentView: "settings" });
      const { result } = await mountHook();
      await endMeeting();
      act(() => useMeetingStore.setState({ meetingStarting: true }));
      act(() => useMeetingStore.setState({ meetingStarting: false, currentView: "launcher" }));
      expect(result.current.visible).toBe(false);
      await endMeeting();
      expect(result.current.visible).toBe(true);
    });

    it("hides a visible card at once and brings it back after that meeting, even though it was saved as shown", async () => {
      const { result } = await mountHook();
      await endMeeting();
      await advance(SHOWN_AFTER_MS);
      expect(settings.data.get(STAR_PROMPT_SHOWN_KEY)).toBe(true);

      act(() => useMeetingStore.setState({ activeMeeting: { id: "next" } as never }));
      expect(result.current.visible).toBe(false);
      act(() => useMeetingStore.setState({ activeMeeting: null }));
      expect(result.current.visible).toBe(false); // not before the meeting's end event

      ipc.listMeetings.mockImplementation(async () => summaries(6));
      await endMeeting();
      expect(result.current.visible).toBe(true);
    });

    it("a demo starting hides it too", async () => {
      const { result } = await mountHook();
      await endMeeting();
      act(() => useDemoStore.setState({ isDemoActive: true }));
      expect(result.current.visible).toBe(false);
    });

    it("an answered card does not come back after the next meeting", async () => {
      const { result } = await mountHook();
      await endMeeting();
      await act(async () => result.current.close());
      act(() => useMeetingStore.setState({ activeMeeting: { id: "next" } as never }));
      act(() => useMeetingStore.setState({ activeMeeting: null }));
      await endMeeting();
      expect(result.current.visible).toBe(false);
    });

    it("is not shown if a meeting started while the data was loading", async () => {
      ipc.listMeetings.mockImplementation(async () => {
        useMeetingStore.setState({ meetingStarting: true });
        return summaries(5);
      });
      const { result } = await mountHook();
      await endMeeting();
      expect(result.current.visible).toBe(false);
    });
  });
});
