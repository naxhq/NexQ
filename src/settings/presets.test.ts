import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioDevice } from "../lib/types";

// In-memory plugin-store, as in configStore.test.ts.
const saved = vi.hoisted(() => new Map<string, unknown>());

vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({
    get: async (key: string) => saved.get(key),
    set: async (key: string, value: unknown) => void saved.set(key, value),
    onKeyChange: async () => () => {},
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));

const devices = [
  { id: "mic-1", name: "Mic 1", is_input: true, is_default: true },
  { id: "mic-2", name: "Mic 2", is_input: true, is_default: false },
  { id: "out-1", name: "Speakers", is_input: false, is_default: true },
] as unknown as AudioDevice[];

describe("built-in meeting presets vs. the load-time migration", () => {
  beforeEach(() => {
    saved.clear();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("never use a batch-only engine", async () => {
    const { BUILT_IN_PRESETS } = await import("./presets");
    for (const p of BUILT_IN_PRESETS) {
      expect(p.you.stt, p.name).not.toBe("whisper_cpp");
      expect(p.them.stt, p.name).not.toBe("whisper_cpp");
      expect(p.requiresDownload, p.name).not.toBe("whisper_cpp");
    }
  });

  it("only claim private, offline or local when both sides run on this computer", async () => {
    const { BUILT_IN_PRESETS } = await import("./presets");
    const onDevice = ["parakeet_tdt", "sherpa_onnx", "ort_streaming"];
    for (const p of BUILT_IN_PRESETS) {
      if (onDevice.includes(p.you.stt) && onDevice.includes(p.them.stt)) continue;
      expect(`${p.name} ${p.description}`, p.name).not.toMatch(/private|offline|local/i);
    }
  });

  it("keep both providers after the next launch", async () => {
    vi.resetModules();
    const { BUILT_IN_PRESETS, applyPreset } = await import("./presets");
    for (const preset of BUILT_IN_PRESETS) {
      saved.clear();
      const applied = applyPreset(preset, devices);
      saved.set("meetingAudioConfig", applied);
      vi.resetModules();
      const { useConfigStore } = await import("../stores/configStore");
      await useConfigStore.getState().loadConfig();
      const loaded = useConfigStore.getState().meetingAudioConfig;
      expect(loaded?.you.stt_provider, `${preset.name} (You)`).toBe(applied.you.stt_provider);
      expect(loaded?.them.stt_provider, `${preset.name} (Them)`).toBe(applied.them.stt_provider);
    }
  });
});
