import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MeetingSetupModal } from "./MeetingSetupModal";
import { useConfigStore } from "../stores/configStore";
import { useScenarioStore } from "../stores/scenarioStore";
import type { AIScenario, ScenarioTemplate } from "../lib/types";

const boardReview = {
  id: "custom_1",
  name: "Board review",
  description: "Custom scenario",
  is_custom: true,
} as ScenarioTemplate;

const start = () => fireEvent.click(screen.getByRole("button", { name: "Start Meeting" }));

function remember(scenario: AIScenario) {
  useConfigStore.setState({ rememberedMeetingSetup: { audioMode: "online", scenario } });
}

beforeAll(() => {
  mockWindows("launcher");
  mockIPC(() => []);
});

beforeEach(() => {
  useScenarioStore.setState({ customScenarios: [boardReview] });
});

afterEach(() => {
  cleanup();
  useConfigStore.setState({ rememberedMeetingSetup: null });
  useScenarioStore.setState({ customScenarios: [] });
});

describe("MeetingSetupModal scenarios", () => {
  it("offers custom scenarios and starts the chosen one", () => {
    const onStart = vi.fn();
    render(<MeetingSetupModal open onStart={onStart} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Team Meeting" }));
    fireEvent.click(screen.getByRole("button", { name: /Board review/ }));
    start();
    expect(onStart).toHaveBeenCalledWith("online", "custom_1");
  });

  it("shows a remembered custom scenario by name", () => {
    remember("custom_1");
    const onStart = vi.fn();
    render(<MeetingSetupModal open onStart={onStart} onCancel={() => {}} />);
    expect(screen.getByText("Board review")).toBeInTheDocument();
    start();
    expect(onStart).toHaveBeenCalledWith("online", "custom_1");
  });

  it("falls back to Team Meeting when the remembered scenario was deleted", () => {
    remember("custom_deleted");
    const onStart = vi.fn();
    render(<MeetingSetupModal open onStart={onStart} onCancel={() => {}} />);
    expect(screen.getByText("Team Meeting")).toBeInTheDocument();
    expect(screen.queryByText("custom_deleted")).toBeNull();
    start();
    expect(onStart).toHaveBeenCalledWith("online", "team_meeting");
  });
});
