import { beforeEach, describe, expect, it, vi } from "vitest";

const disk = vi.hoisted(() => ({ saved: undefined as unknown }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ get: async () => disk.saved, set: async () => {} }),
}));
vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  updateActionConfigs: vi.fn(() => Promise.resolve()),
  setCustomInstructions: vi.fn(() => Promise.resolve()),
}));

import { useAIActionsStore } from "./aiActionsStore";

describe("a new install", () => {
  it("detects questions, and leaves answering them to you", () => {
    expect(useAIActionsStore.getState().configs.globalDefaults).toMatchObject({
      questionDetection: true,
      autoTrigger: false,
    });
  });
});

describe("loadConfigs with saved settings", () => {
  beforeEach(() => {
    // The shape versions before Question Detection saved.
    disk.saved = {
      actions: {},
      globalDefaults: { autoTrigger: false, ragTopK: 9, temperature: 0.7, transcriptWindowSeconds: 120 },
    };
  });

  it("turns on a setting that didn't exist when they were saved", async () => {
    await useAIActionsStore.getState().loadConfigs();
    expect(useAIActionsStore.getState().configs.globalDefaults.questionDetection).toBe(true);
  });

  it("keeps what was saved", async () => {
    await useAIActionsStore.getState().loadConfigs();
    expect(useAIActionsStore.getState().configs.globalDefaults).toMatchObject({
      autoTrigger: false,
      ragTopK: 9,
      temperature: 0.7,
      transcriptWindowSeconds: 120,
    });
  });

  it("keeps Auto-Answer on when it was saved on", async () => {
    disk.saved = { actions: {}, globalDefaults: { autoTrigger: true } };
    await useAIActionsStore.getState().loadConfigs();
    expect(useAIActionsStore.getState().configs.globalDefaults.autoTrigger).toBe(true);
  });

  it("keeps Question Detection off when it was saved off", async () => {
    disk.saved = { actions: {}, globalDefaults: { questionDetection: false, autoTrigger: false } };
    await useAIActionsStore.getState().loadConfigs();
    expect(useAIActionsStore.getState().configs.globalDefaults.questionDetection).toBe(false);
  });
});
