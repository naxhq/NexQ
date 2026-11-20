import { act, cleanup, renderHook } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startCapturePerParty, stopCapture } from "../lib/ipc";
import type { MeetingAudioConfig } from "../lib/types";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";
import { autoDetectProblem } from "../lib/sttLanguages";
import { useAudioConfigSync } from "./useAudioConfigSync";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  startCapturePerParty: vi.fn(),
  stopCapture: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/event")>()),
  emit: vi.fn(async () => {}),
}));

// What Rust sends back for a refused swap, built the way the settings screens word it.
const REFUSAL = autoDetectProblem({ provider: "azure_speech" }, {}, "You")!;

const config: MeetingAudioConfig = {
  you: { role: "You", device_id: "default", is_input_device: true, stt_provider: "deepgram" },
  them: { role: "Them", device_id: "default", is_input_device: false, stt_provider: "deepgram" },
  recording_enabled: true,
  preset_name: null,
};
const changed: MeetingAudioConfig = {
  ...config,
  you: { ...config.you, stt_provider: "azure_speech" },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  useMeetingStore.setState({ isRecording: true, audioMode: "online" });
  useConfigStore.setState({ meetingAudioConfig: config });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useMeetingStore.setState({ isRecording: false });
  useConfigStore.setState({ meetingAudioConfig: null });
});

async function change(next: MeetingAudioConfig) {
  act(() => useConfigStore.setState({ meetingAudioConfig: next }));
  await act(() => vi.advanceTimersByTimeAsync(300));
}

it("tells the user about a refused switch and keeps the running capture's config", async () => {
  vi.mocked(startCapturePerParty).mockRejectedValueOnce(REFUSAL);
  renderHook(() => useAudioConfigSync());

  await change(changed);
  expect(startCapturePerParty).toHaveBeenCalledTimes(1);
  expect(startCapturePerParty).toHaveBeenCalledWith(changed.you, changed.them, { skipYouStt: false });
  expect(stopCapture).not.toHaveBeenCalled();
  expect(emit).toHaveBeenCalledWith(
    "capture_warning",
    "Auto-detect doesn't work with Azure Speech, used for You. Your meeting keeps its current setup.",
  );

  // Back to what is still running: nothing to restart.
  await change(config);
  expect(startCapturePerParty).toHaveBeenCalledTimes(1);
});

it("can switch again after a refusal", async () => {
  vi.mocked(startCapturePerParty).mockRejectedValueOnce(REFUSAL).mockResolvedValue(undefined);
  renderHook(() => useAudioConfigSync());

  await change(changed);
  const other: MeetingAudioConfig = { ...config, you: { ...config.you, stt_provider: "groq_whisper" } };
  await change(other);
  expect(startCapturePerParty).toHaveBeenCalledTimes(2);
  expect(startCapturePerParty).toHaveBeenLastCalledWith(other.you, other.them, { skipYouStt: false });
});

it("applies a change made while a swap is running once that swap ends", async () => {
  let finishFirst!: () => void;
  vi.mocked(startCapturePerParty)
    .mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirst = resolve; }))
    .mockResolvedValue(undefined);
  renderHook(() => useAudioConfigSync());

  await change(changed);
  expect(startCapturePerParty).toHaveBeenCalledTimes(1);

  const later: MeetingAudioConfig = { ...config, you: { ...config.you, stt_provider: "groq_whisper" } };
  await change(later);
  expect(startCapturePerParty).toHaveBeenCalledTimes(1); // first swap still running

  await act(async () => finishFirst());
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(startCapturePerParty).toHaveBeenCalledTimes(2);
  expect(startCapturePerParty).toHaveBeenLastCalledWith(later.you, later.them, { skipYouStt: false });
});

it("retries a failure that may have stopped the capture, and says so", async () => {
  vi.mocked(startCapturePerParty).mockRejectedValueOnce("Audio device busy").mockResolvedValue(undefined);
  renderHook(() => useAudioConfigSync());

  await change(changed);
  expect(emit).toHaveBeenCalledWith("capture_warning", "Couldn't switch speech-to-text: Audio device busy");

  await change(config);
  expect(startCapturePerParty).toHaveBeenCalledTimes(2);
  expect(startCapturePerParty).toHaveBeenLastCalledWith(config.you, config.them, { skipYouStt: false });
});
