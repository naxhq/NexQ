import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { OverlayView } from "./OverlayView";
import { CallLogPanel } from "../calllog";
import { useMeetingStore } from "../stores/meetingStore";
import { useScenarioStore } from "../stores/scenarioStore";
import { useSpeakerStore } from "../stores/speakerStore";
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
