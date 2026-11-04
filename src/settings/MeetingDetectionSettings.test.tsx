import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MeetingDetectionSettings } from "./MeetingDetectionSettings";
import { useConfigStore } from "../stores/configStore";
import { useScenarioStore } from "../stores/scenarioStore";
import type { AIScenario, ScenarioTemplate } from "../lib/types";

const startAs = () => screen.getByRole("combobox", { name: "Start as" });

function startingAs(default_scenario: AIScenario) {
  const { meetingDetection } = useConfigStore.getState();
  useConfigStore.setState({ meetingDetection: { ...meetingDetection, enabled: true, default_scenario } });
}

beforeEach(() => {
  useScenarioStore.setState({
    customScenarios: [{ id: "custom_1", name: "Board review", is_custom: true } as ScenarioTemplate],
  });
});

afterEach(() => {
  cleanup();
  startingAs("team_meeting");
  useScenarioStore.setState({ customScenarios: [] });
});

describe("MeetingDetectionSettings' Start as", () => {
  it("offers custom scenarios", () => {
    startingAs("custom_1");
    render(<MeetingDetectionSettings />);
    expect(screen.getByRole("option", { name: "Board review" })).toBeInTheDocument();
    expect(startAs()).toHaveValue("custom_1");
  });

  it("shows Team Meeting when the chosen scenario was deleted", () => {
    startingAs("custom_deleted");
    render(<MeetingDetectionSettings />);
    expect(startAs()).toHaveValue("team_meeting");
  });
});
