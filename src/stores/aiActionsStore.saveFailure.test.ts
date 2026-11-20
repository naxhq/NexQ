// Two saves can start before the plugin-store has loaded. If the load fails for
// the second one, only the second one's bookkeeping may be undone: the first
// save did go through, and its echo must still be recognised as this window's own.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AllActionConfigs } from "../lib/types";

const plugin = vi.hoisted(() => ({
  loads: [] as Array<{ resolve: (store: unknown) => void; reject: (e: Error) => void }>,
  keyListeners: [] as Array<(v: unknown) => void>,
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  load: () =>
    new Promise((resolve, reject) => {
      plugin.loads.push({ resolve, reject });
    }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null),
}));

describe("saveConfigs when the store can't be opened", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the record of an earlier save that did go through", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { useAIActionsStore, watchSavedActionConfigs } = await import("./aiActionsStore");
    const saved = useAIActionsStore.getState().configs;

    // Both saves find the store not yet loaded and ask for it.
    const first = useAIActionsStore.getState().saveConfigs();
    const second = useAIActionsStore.getState().saveConfigs();
    expect(plugin.loads).toHaveLength(2);

    plugin.loads[0].resolve({
      set: async () => {},
      onKeyChange: async (_key: string, cb: (v: unknown) => void) => {
        plugin.keyListeners.push(cb);
        return () => {};
      },
    });
    await first;
    plugin.loads[1].reject(new Error("could not open the store"));
    await second;

    await watchSavedActionConfigs();
    // A newer edit made since the first save, then the first save's echo arrives.
    const newer: AllActionConfigs = { ...saved, customInstructions: "Typed after the save" };
    useAIActionsStore.setState({ configs: newer });
    plugin.keyListeners[0](structuredClone(saved));

    expect(plugin.keyListeners).toHaveLength(1);
    expect(useAIActionsStore.getState().configs.customInstructions).toBe("Typed after the save");
  });
});
