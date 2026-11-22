import { act, cleanup, render, screen } from "@testing-library/react";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Windows talk over Tauri events, and there is no other window here: keep the
// handlers so a test can deliver what the launcher sends.
const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => unknown>());
vi.mock("@tauri-apps/api/event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/event")>()),
  listen: (name: string, handler: (event: { payload: unknown }) => unknown) => {
    listeners.set(name, handler);
    return Promise.resolve(() => {});
  },
  emit: () => Promise.resolve(),
}));

// Which window the overlay asks to show is what the start-up ordering decides.
const windowCalls = vi.hoisted(() => ({
  showLauncherWindow: vi.fn(() => Promise.resolve()),
  showOverlayWindow: vi.fn(() => Promise.resolve()),
}));
vi.mock("./lib/windows", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/windows")>()),
  ...windowCalls,
}));

import App from "./App";
import { useMeetingStore } from "./stores/meetingStore";
import { useScenarioStore } from "./stores/scenarioStore";
import { useAIActionsStore } from "./stores/aiActionsStore";
import { useToastStore } from "./stores/toastStore";
import type { AIScenario, AudioCaptureStatus } from "./lib/types";

/** config.json, which both windows read and the launcher writes. */
let savedConfig: Record<string, unknown> = {};

const defaultAIConfigs = useAIActionsStore.getState().configs;
const realLoadScenarioConfig = useScenarioStore.getState().loadScenarioConfig;

async function launchOverlayOn(activeScenarioId: AIScenario) {
  savedConfig = { firstRunCompleted: true, activeScenarioId };
  render(<App />);
  await vi.waitFor(() => {
    expect(useScenarioStore.getState().activeScenarioId).toBe(activeScenarioId);
    expect(listeners.has("nexq:meeting_started")).toBe(true);
  });
}

async function launcherStartsMeeting(aiScenario: AIScenario) {
  await act(async () => {
    await listeners.get("nexq:meeting_started")?.({
      payload: { meeting: { id: "meeting-1", title: "Standup" }, audioMode: "online", aiScenario },
    });
  });
}

beforeAll(() => {
  mockWindows("overlay");
  mockIPC((cmd, args) => {
    if (cmd === "plugin:store|load") return 1;
    if (cmd === "plugin:store|get") {
      const { key } = args as { key: string };
      return key in savedConfig ? [savedConfig[key], true] : [null, false];
    }
    if (cmd === "list_meetings") return "[]"; // Sent as a JSON string, like the two below
    if (cmd === "get_rag_status" || cmd === "get_token_budget") return "null";
    return [];
  }, { shouldMockEvents: true });
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  Element.prototype.scrollTo = () => {};
});

afterEach(() => {
  windowCalls.showLauncherWindow.mockClear();
  windowCalls.showOverlayWindow.mockClear();
  cleanup();
  listeners.clear();
  useMeetingStore.getState().stopTimer();
  useMeetingStore.setState({ activeMeeting: null, currentView: "launcher", isRecording: false });
  useScenarioStore.setState({
    activeScenarioId: "team_meeting",
    customScenarios: [],
    scenarioOverrides: {},
    loadScenarioConfig: realLoadScenarioConfig,
  });
  useAIActionsStore.setState({ configs: defaultAIConfigs });
});

describe("scenarios saved by another window", () => {
  it("show up in this window", async () => {
    await launchOverlayOn("lecture");
    const { emit } = await vi.importActual<typeof import("@tauri-apps/api/event")>("@tauri-apps/api/event");
    await vi.waitFor(async () => {
      await emit("store://change", {
        resourceId: 1,
        key: "customScenarios",
        value: [{ id: "custom_1", name: "Board review", is_custom: true }],
        exists: true,
      });
      expect(useScenarioStore.getState().resolveScenario("custom_1")).toBe("custom_1");
    });
  });
});

describe("AI settings saved by another window", () => {
  it("Auto-Answer switched on in the launcher's Settings reaches the overlay", async () => {
    await launchOverlayOn("team_meeting");
    expect(useAIActionsStore.getState().configs.globalDefaults.autoTrigger).toBe(false);
    const { emit } = await vi.importActual<typeof import("@tauri-apps/api/event")>("@tauri-apps/api/event");
    await vi.waitFor(async () => {
      await emit("store://change", {
        resourceId: 1,
        key: "ai_action_configs",
        value: { actions: {}, globalDefaults: { autoTrigger: true } },
        exists: true,
      });
      expect(useAIActionsStore.getState().configs.globalDefaults.autoTrigger).toBe(true);
    });
    // Settings saved before a newer one existed still get its default.
    expect(useAIActionsStore.getState().configs.actions.Assist).toBeTruthy();
    expect(useAIActionsStore.getState().configs.globalDefaults.questionDetection).toBe(true);
  });
});

describe("the overlay's scenario chip", () => {
  it("shows the meeting's scenario, not the one loaded at launch", async () => {
    await launchOverlayOn("lecture");
    await launcherStartsMeeting("interview");
    expect(await screen.findByText("Interview")).toBeTruthy();
    expect(screen.queryByText("Lecture")).toBeNull();
  });

  it("shows a custom scenario the launcher saved after launch", async () => {
    await launchOverlayOn("lecture");
    savedConfig.customScenarios = [{ id: "custom_1", name: "Board review", is_custom: true }];
    await launcherStartsMeeting("custom_1");
    expect(await screen.findByText("Board review")).toBeTruthy();
  });
});

describe("the overlay window when a meeting starts in the launcher", () => {
  const meetingStarted = {
    payload: { meeting: { id: "meeting-1", title: "Standup" }, audioMode: "online", aiScenario: "team_meeting" },
  };
  const showRequest = { payload: { meetingId: "meeting-1" } };

  it("shows the overlay when the show request lands while the meeting is still being set up", async () => {
    await launchOverlayOn("team_meeting");
    // The scenario read in the meeting-start handler is slow.
    let finishScenarioRead!: () => void;
    useScenarioStore.setState({
      loadScenarioConfig: () => new Promise<void>((resolve) => { finishScenarioRead = resolve; }),
    });
    windowCalls.showLauncherWindow.mockClear();

    await act(async () => {
      const started = listeners.get("nexq:meeting_started")?.(meetingStarted);
      const shown = listeners.get("nexq:show_meeting_overlay")?.(showRequest);
      await vi.waitFor(() => expect(finishScenarioRead).toBeTypeOf("function"));
      finishScenarioRead();
      await Promise.all([started, shown]);
    });

    expect(useMeetingStore.getState().activeMeeting?.id).toBe("meeting-1");
    expect(windowCalls.showOverlayWindow).toHaveBeenCalledTimes(1);
    expect(windowCalls.showLauncherWindow).not.toHaveBeenCalled();
  });

  it("shows the overlay when the show request lands before the meeting event", async () => {
    await launchOverlayOn("team_meeting");
    windowCalls.showLauncherWindow.mockClear();

    await act(async () => {
      const shown = listeners.get("nexq:show_meeting_overlay")?.(showRequest);
      await listeners.get("nexq:meeting_started")?.(meetingStarted);
      await shown;
    });

    expect(windowCalls.showOverlayWindow).toHaveBeenCalledTimes(1);
    expect(windowCalls.showLauncherWindow).not.toHaveBeenCalled();
  });

  it("still shows the launcher when asked for the overlay with no meeting running", async () => {
    await launchOverlayOn("team_meeting");
    windowCalls.showLauncherWindow.mockClear();

    await act(async () => {
      await listeners.get("nexq:show_meeting_overlay")?.({ payload: {} });
      await listeners.get("tray_show_overlay")?.({ payload: null });
    });

    expect(windowCalls.showLauncherWindow).toHaveBeenCalledTimes(2);
    expect(windowCalls.showOverlayWindow).not.toHaveBeenCalled();
  });
});

describe("a capture side reconnecting mid-meeting", () => {
  it("toasts a switch to another device and a lost side, nothing while reconnecting", async () => {
    await launchOverlayOn("team_meeting");
    useToastStore.setState({ toasts: [] });
    const deliver = (payload: AudioCaptureStatus) =>
      act(async () => {
        await listeners.get("audio_capture_status")?.({ payload });
      });

    await deliver({ side: "you", state: "recovering", device: "Headset", message: "" });
    await deliver({ side: "you", state: "recovered", device: "Headset", message: "" });
    expect(useToastStore.getState().toasts).toEqual([]);

    const switched = "Your microphone disconnected. Using Microphone (Realtek) for now.";
    await deliver({ side: "you", state: "recovered", device: "Microphone (Realtek)", message: switched });
    const lost =
      "The speakers or headphones you hear the call on disconnected. NexQ reconnects them when they're back, or pick another device in Audio & Devices.";
    await deliver({ side: "them", state: "lost", device: "Speakers", message: lost });
    expect(useToastStore.getState().toasts.map((t) => [t.message, t.type])).toEqual([
      [switched, "info"],
      [lost, "warning"],
    ]);

    // Capture stopping (End, or a device change restarting it) takes the lost toast down.
    await act(async () => {
      await listeners.get("audio_capture_stopped")?.({ payload: null });
    });
    const leaving = (message: string) => useToastStore.getState().toasts.find((t) => t.message === message)?.leaving;
    expect(leaving(lost)).toBe(true);
    expect(leaving(switched)).toBe(true);
  });
});
