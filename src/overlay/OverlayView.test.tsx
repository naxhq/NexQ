import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Intercept the launcher-window helper so Minus-button tests can assert
// whether the stealth branch avoided it. Dynamically imported in the
// factory to preserve everything else exported by the module.
vi.mock("../lib/windows", async () => {
  const actual = await vi.importActual<typeof import("../lib/windows")>("../lib/windows");
  return {
    ...actual,
    showLauncherWindow: vi.fn().mockResolvedValue(undefined),
  };
});

// Intercept the dynamic webviewWindow import inside the stealth-hide branch
// so we can assert it tried to hide the overlay (and not show the launcher).
const overlayHide = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: {
    getByLabel: vi.fn(async (label: string) => (label === "overlay" ? { hide: overlayHide } : null)),
  },
}));

import { OverlayView } from "./OverlayView";
import { CallLogPanel } from "../calllog";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useScenarioStore } from "../stores/scenarioStore";
import { useSpeakerStore } from "../stores/speakerStore";
import { showLauncherWindow } from "../lib/windows";
import type { AIScenario, AudioMode, Meeting, SpeakerIdentity } from "../lib/types";

// Mounts the real overlay and every store behind it: a selector that returns a
// new value on each read only shows up as a crash in a real render.
function renderOverlay(audioMode: AudioMode, scenario: AIScenario) {
  useMeetingStore.setState({
    activeMeeting: { id: "meeting-1", title: "Standup" } as Meeting,
    currentView: "overlay",
    audioMode,
    aiScenario: scenario,
    isRecording: true,
  });
  return render(
    <div>
      <OverlayView />
      <CallLogPanel />
    </div>,
  );
}

// Kept for the whole file: listeners unsubscribe asynchronously, after cleanup.
beforeAll(() => {
  mockWindows("overlay");
  mockIPC(() => []);
  Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollTo = () => {};
});

afterEach(() => {
  cleanup();
  useMeetingStore.setState({ activeMeeting: null, currentView: "launcher", isRecording: false });
  useScenarioStore.setState({ activeScenarioId: "team_meeting", customScenarios: [], scenarioOverrides: {} });
  useSpeakerStore.getState().reset();
});

describe("OverlayView", () => {
  const setups: Array<[AudioMode, AIScenario]> = [
    ["online", "interview"],
    ["online", "team_meeting"],
    ["in_person", "interview"],
    ["in_person", "team_meeting"],
  ];

  it.each(setups)("opens for a %s %s meeting", (audioMode, scenario) => {
    renderOverlay(audioMode, scenario);
    expect(screen.getByRole("button", { name: "End meeting" })).toBeTruthy();
  });

  it.each(setups)("opens for a %s %s meeting when the scenario's prompts were edited", (audioMode, scenario) => {
    useScenarioStore.setState({
      activeScenarioId: scenario,
      scenarioOverrides: { [scenario]: { system_prompt: "Edited prompt" } },
    });
    renderOverlay(audioMode, scenario);
    expect(screen.getByRole("button", { name: "End meeting" })).toBeTruthy();
  });

  it("shows the name of a scenario whose prompts were edited", () => {
    useScenarioStore.setState({
      activeScenarioId: "interview",
      scenarioOverrides: { interview: { name: "My interview" } },
    });
    renderOverlay("online", "interview");
    expect(screen.getByText("My interview")).toBeTruthy();
  });

  it("Minus button tooltip says 'Minimize to Dashboard' when stealth is off", () => {
    useConfigStore.setState({ stealthMode: false });
    renderOverlay("online", "team_meeting");
    expect(screen.getByRole("button", { name: "Minimize to Dashboard (Ctrl+B brings it back)" })).toBeTruthy();
  });

  it("Minus button tooltip switches to 'Hide to tray' when stealth is on during a meeting", () => {
    useConfigStore.setState({ stealthMode: true });
    renderOverlay("online", "team_meeting");
    expect(screen.getByRole("button", { name: "Hide to tray (Ctrl+B brings it back)" })).toBeTruthy();
    useConfigStore.setState({ stealthMode: false });
  });

  it("Minus button tooltip uses the menu bar and ⌘B on macOS", () => {
    const userAgent = Object.getOwnPropertyDescriptor(window.navigator, "userAgent");
    Object.defineProperty(window.navigator, "userAgent", { value: "Mozilla/5.0 (Macintosh)", configurable: true });
    try {
      useConfigStore.setState({ stealthMode: true });
      renderOverlay("online", "team_meeting");
      expect(screen.getByRole("button", { name: "Hide to menu bar (⌘B brings it back)" })).toBeTruthy();
    } finally {
      if (userAgent) Object.defineProperty(window.navigator, "userAgent", userAgent);
      else delete (window.navigator as { userAgent?: string }).userAgent;
      useConfigStore.setState({ stealthMode: false });
    }
  });

  it("Minus click shows the launcher when stealth is off", async () => {
    vi.mocked(showLauncherWindow).mockClear();
    overlayHide.mockClear();
    useConfigStore.setState({ stealthMode: false });
    renderOverlay("online", "team_meeting");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /Minimize to Dashboard/ }));
    });
    await waitFor(() => expect(showLauncherWindow).toHaveBeenCalledTimes(1));
    expect(overlayHide).not.toHaveBeenCalled();
  });

  it("Minus click hides the overlay and does NOT reveal the launcher when stealth + meeting are on", async () => {
    vi.mocked(showLauncherWindow).mockClear();
    overlayHide.mockClear();
    useConfigStore.setState({ stealthMode: true });
    renderOverlay("online", "team_meeting");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /Hide to tray/ }));
    });
    await waitFor(() => expect(overlayHide).toHaveBeenCalledTimes(1));
    expect(showLauncherWindow).not.toHaveBeenCalled();
    useConfigStore.setState({ stealthMode: false });
  });

  it("opens Speaker Stats and shows the speakers", () => {
    useSpeakerStore.setState({
      speakers: { you: { id: "you", display_name: "You", stats: { word_count: 3 } } as SpeakerIdentity },
      speakerOrder: ["you"],
    });
    renderOverlay("online", "team_meeting");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Speaker Stats (S)" }));
    });
    expect(screen.getByText("Speaker Stats")).toBeTruthy();
    expect(screen.getByText("1 speaker")).toBeTruthy();
  });
});
