import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({ missing: false, calls: [] as unknown[] }));
vi.mock("../lib/ipc", () => ({
  getMemorySettings: async () => {
    if (h.missing) throw "unknown command";
    return { provider: "claude_cli", model: "sonnet", effort: null };
  },
  setMemorySettings: async (p: object) => {
    h.calls.push(p);
    if (h.missing) throw "unknown command";
    return { provider: null, model: null, effort: null, ...p };
  },
}));
vi.mock("../lib/events", () => ({ onMemorySettingsChanged: async () => () => {} }));

import { useMemoryModel } from "./useMemoryModel";

describe("useMemoryModel", () => {
  it("loads the saved choice and saves a change as a patch", async () => {
    h.missing = false;
    const { result } = renderHook(() => useMemoryModel());
    await waitFor(() => expect(result.current.value.provider).toBe("claude_cli"));
    await act(() => result.current.change({ provider: "ollama", model: "llama3", effort: null }));
    expect(h.calls).toEqual([{ provider: "ollama", model: "llama3", effort: null }]);
    expect(result.current.value.model).toBe("llama3");
  });

  it("says so when the choice cannot be read or saved, and keeps what it had", async () => {
    h.missing = true;
    const { result } = renderHook(() => useMemoryModel());
    await waitFor(() => expect(result.current.error).toMatch(/Couldn't read/));
    await act(() => result.current.change({ provider: "ollama", model: "x", effort: null }));
    expect(result.current.value.provider).toBeNull();
    expect(result.current.error).toMatch(/Couldn't save/);
  });
});
