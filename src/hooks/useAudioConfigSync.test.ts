import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { startCapturePerParty, stopCapture } from "../lib/ipc";
import type { MeetingAudioConfig } from "../lib/types";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useAudioConfigSync } from "./useAudioConfigSync";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  startCapturePerParty: vi.fn(),
  stopCapture: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useMeetingStore.setState({ isRecording: false });
  useConfigStore.setState({ meetingAudioConfig: null });
});

it("lets Rust validate a hot-swap before capture stops and can retry after rejection", async () => {
  vi.useFakeTimers();
  vi.mocked(startCapturePerParty).mockRejectedValueOnce("Unsupported automatic detection");
  const config: MeetingAudioConfig = {
    you: { role: "You", device_id: "default", is_input_device: true, stt_provider: "deepgram" },
    them: { role: "Them", device_id: "default", is_input_device: false, stt_provider: "deepgram" },
    recording_enabled: true,
    preset_name: null,
  };
  const unsupported: MeetingAudioConfig = {
    ...config,
    you: { ...config.you, stt_provider: "azure_speech" },
  };

  useMeetingStore.setState({ isRecording: true, audioMode: "online" });
  useConfigStore.setState({ meetingAudioConfig: config });
  renderHook(() => useAudioConfigSync());

  act(() => useConfigStore.setState({ meetingAudioConfig: unsupported }));
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(startCapturePerParty).toHaveBeenNthCalledWith(1, unsupported.you, unsupported.them, { skipYouStt: false });
  expect(stopCapture).not.toHaveBeenCalled();

  act(() => useConfigStore.setState({ meetingAudioConfig: config }));
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(startCapturePerParty).toHaveBeenNthCalledWith(2, config.you, config.them, { skipYouStt: false });
});
