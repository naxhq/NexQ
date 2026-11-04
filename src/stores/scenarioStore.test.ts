import { afterEach, describe, expect, it } from "vitest";
import { scenarioLabel, useScenarioStore } from "./scenarioStore";
import type { ScenarioTemplate } from "../lib/types";

const boardReview = { id: "custom_1", name: "Board review", is_custom: true } as ScenarioTemplate;

afterEach(() => useScenarioStore.setState({ customScenarios: [] }));

describe("resolveScenario", () => {
  const resolve = useScenarioStore.getState().resolveScenario;

  it("keeps a built-in scenario, and a custom one that exists", () => {
    useScenarioStore.setState({ customScenarios: [boardReview] });
    expect(resolve("interview")).toBe("interview");
    expect(resolve("custom_1")).toBe("custom_1");
  });

  it("falls back to Team Meeting for a custom scenario that was deleted", () => {
    expect(resolve("custom_1")).toBe("team_meeting");
  });
});

describe("scenarioLabel", () => {
  it("reads a built-in scenario's id as words", () => {
    expect(scenarioLabel("team_meeting", [])).toBe("team meeting");
  });

  it("uses a custom scenario's name, also once it was deleted", () => {
    expect(scenarioLabel("custom_1", [boardReview])).toBe("Board review");
    expect(scenarioLabel("custom_1", [])).toBe("custom scenario");
  });
});
