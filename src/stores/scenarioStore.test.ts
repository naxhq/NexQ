import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** config.json, and what the plugin tells each window when another one saves to it. */
const disk = vi.hoisted(() => ({
  saved: {} as Record<string, unknown>,
  writes: [] as string[],
  changeHandlers: {} as Record<string, (value: unknown) => void>,
  stopped: 0,
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({
    get: async (key: string) => disk.saved[key],
    set: async (key: string, value: unknown) => {
      disk.saved[key] = value;
      disk.writes.push(key);
    },
    onKeyChange: async (key: string, handler: (value: unknown) => void) => {
      disk.changeHandlers[key] = handler;
      return () => {
        disk.stopped += 1;
      };
    },
  }),
}));

import { scenarioLabel, useScenarioStore, watchSavedScenarios } from "./scenarioStore";
import type { ScenarioTemplate } from "../lib/types";

const custom = (id: string, name: string, system_prompt = "Prompt") =>
  ({ id, name, system_prompt, is_custom: true }) as ScenarioTemplate;
const boardReview = custom("custom_1", "Board review");

beforeEach(() => {
  disk.saved = {};
  disk.writes = [];
  disk.changeHandlers = {};
  disk.stopped = 0;
});

afterEach(() => {
  useScenarioStore.setState({ activeScenarioId: "team_meeting", customScenarios: [], scenarioOverrides: {} });
});

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

describe("watchSavedScenarios", () => {
  it("shows prompts another window saved, and a later edit here keeps them", async () => {
    await watchSavedScenarios();
    disk.changeHandlers.scenarioOverrides({ interview: { system_prompt: "From the overlay" } });

    const scenarios = useScenarioStore.getState();
    expect(scenarios.scenarioOverrides.interview?.system_prompt).toBe("From the overlay");

    scenarios.updatePrompt("lecture", "system_prompt", "From the launcher");
    await vi.waitFor(() => {
      expect(disk.saved.scenarioOverrides).toEqual({
        interview: { system_prompt: "From the overlay" },
        lecture: { system_prompt: "From the launcher" },
      });
    });
  });

  it("shows custom scenarios another window saved, and a later one here keeps them", async () => {
    await watchSavedScenarios();
    disk.changeHandlers.customScenarios([boardReview]);

    const scenarios = useScenarioStore.getState();
    expect(scenarios.resolveScenario("custom_1")).toBe("custom_1");

    scenarios.createCustomScenario(custom("custom_2", "Client call"));
    await vi.waitFor(() => {
      expect((disk.saved.customScenarios as ScenarioTemplate[]).map((s) => s.id)).toEqual(["custom_1", "custom_2"]);
    });
  });

  it("empties a list another window removed", async () => {
    useScenarioStore.setState({ customScenarios: [boardReview] });
    await watchSavedScenarios();
    disk.changeHandlers.customScenarios(undefined);
    expect(useScenarioStore.getState().customScenarios).toEqual([]);
  });

  it("leaves this window's active scenario alone: the overlay's is the running meeting's", async () => {
    await watchSavedScenarios();
    expect(disk.changeHandlers.activeScenarioId).toBeUndefined();
  });

  it("stops watching when asked", async () => {
    const stop = await watchSavedScenarios();
    stop();
    expect(disk.stopped).toBe(Object.keys(disk.changeHandlers).length);
  });
});

describe("updateCustomScenario", () => {
  it("replaces the scenario in place with one save, so no window sees it missing", async () => {
    useScenarioStore.setState({
      activeScenarioId: "custom_1",
      customScenarios: [boardReview, custom("custom_2", "Client call")],
    });
    useScenarioStore.getState().updateCustomScenario(custom("custom_1", "Board review", "Edited"));

    const { customScenarios, activeScenarioId } = useScenarioStore.getState();
    expect(customScenarios.map((s) => s.system_prompt)).toEqual(["Edited", "Prompt"]);
    expect(activeScenarioId).toBe("custom_1");
    await vi.waitFor(() => expect(disk.writes).toEqual(["customScenarios"]));
    expect(disk.saved.customScenarios).toEqual(customScenarios);
  });
});
