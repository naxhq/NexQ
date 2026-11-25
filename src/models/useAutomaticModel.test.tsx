import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import fixture from "../contracts/fixtures/automatic_model_updated.json";

const h = vi.hoisted(() => ({
  label: "OpenAI gpt-5-nano (cheapest)",
  calls: [] as Array<string | null>,
  handlers: [] as Array<(e: { provider: string }) => void>,
}));
vi.mock("../lib/ipc", () => ({
  getAutomaticModel: async (p: string | null) => {
    h.calls.push(p);
    return { provider: "openai", model: "gpt-5-nano", effort: null, label: h.label };
  },
}));
vi.mock("../lib/events", () => ({
  onAutomaticModelUpdated: async (cb: (e: { provider: string }) => void) => {
    h.handlers.push(cb);
    return () => h.handlers.splice(h.handlers.indexOf(cb), 1);
  },
}));

import { useAutomaticModel } from "./useAutomaticModel";
import { useConfigStore } from "../stores/configStore";

beforeEach(() => {
  h.calls.length = 0;
  h.handlers.length = 0;
  h.label = "OpenAI gpt-5-nano (cheapest)";
  useConfigStore.setState({ llmProvider: "openai", llmModel: "gpt-5" } as never);
});

describe("useAutomaticModel", () => {
  it("reads the backend's automatic model", async () => {
    const { result } = renderHook(() => useAutomaticModel(null));
    await waitFor(() => expect(result.current.model?.label).toBe(h.label));
    expect(h.calls).toEqual([null]);
  });

  it("reads again when that provider's model list lands (the backend's own event payload)", async () => {
    const { result } = renderHook(() => useAutomaticModel(null));
    await waitFor(() => expect(result.current.model).not.toBeNull());
    h.label = "OpenAI gpt-5-mini (cheapest)";
    await waitFor(() => expect(h.handlers).toHaveLength(1));
    act(() => h.handlers[0](fixture));
    await waitFor(() => expect(result.current.model?.label).toBe("OpenAI gpt-5-mini (cheapest)"));
  });

  it("ignores another provider's list when it follows a chosen one", async () => {
    useConfigStore.setState({ llmProvider: "groq" } as never);
    const { result } = renderHook(() => useAutomaticModel("ollama"));
    await waitFor(() => expect(result.current.model).not.toBeNull());
    await waitFor(() => expect(h.handlers).toHaveLength(1));
    h.calls.length = 0;
    act(() => h.handlers[0]({ provider: "openai" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(h.calls).toEqual([]);
  });

  it("reads again when the active provider or model changes", async () => {
    renderHook(() => useAutomaticModel(null));
    await waitFor(() => expect(h.calls).toHaveLength(1));
    act(() => useConfigStore.setState({ llmModel: "gpt-5-mini" } as never));
    await waitFor(() => expect(h.calls).toHaveLength(2));
    act(() => useConfigStore.setState({ llmProvider: "anthropic" } as never));
    await waitFor(() => expect(h.calls.length).toBeGreaterThanOrEqual(3));
  });
});
