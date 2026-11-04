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

import App from "./App";
import { useMeetingStore } from "./stores/meetingStore";
import { useScenarioStore } from "./stores/scenarioStore";
import type { AIScenario } from "./lib/types";

/** config.json, which both windows read and the launcher writes. */
let savedConfig: Record<string, unknown> = {};

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
  cleanup();
  listeners.clear();
  useMeetingStore.getState().stopTimer();
  useMeetingStore.setState({ activeMeeting: null, currentView: "launcher", isRecording: false });
  useScenarioStore.setState({ activeScenarioId: "team_meeting", customScenarios: [], scenarioOverrides: {} });
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
