import { act, cleanup, renderHook } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setPartyLanguage, startCapturePerParty, stopCapture } from "../lib/ipc";
import type { MeetingAudioConfig } from "../lib/types";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";
import { autoDetectProblem } from "../lib/sttLanguages";
import { useAudioConfigSync } from "./useAudioConfigSync";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  startCapturePerParty: vi.fn(),
  setPartyLanguage: vi.fn(),
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
  vi.mocked(setPartyLanguage).mockResolvedValue(true);
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

it("restarts the whole capture when Rust can't restart a side's language on its own", async () => {
  vi.mocked(startCapturePerParty).mockResolvedValue(undefined);
  vi.mocked(setPartyLanguage).mockResolvedValue(false);
  renderHook(() => useAudioConfigSync());

  // The older config (no language) is what the meeting started with: no swap.
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(startCapturePerParty).not.toHaveBeenCalled();

  const spanishThem: MeetingAudioConfig = { ...config, them: { ...config.them, language: "es-ES" } };
  await change(spanishThem);
  expect(startCapturePerParty).toHaveBeenCalledTimes(1);
  expect(startCapturePerParty).toHaveBeenLastCalledWith(
    config.you,
    { ...config.them, language: "es-ES" },
    { skipYouStt: false },
  );
  expect(vi.mocked(startCapturePerParty).mock.calls[0][0]).not.toHaveProperty("language");

  // Another language on the same side swaps again; the same config doesn't.
  await change({ ...spanishThem, them: { ...spanishThem.them, language: "auto" } });
  expect(startCapturePerParty).toHaveBeenCalledTimes(2);
  await change({ ...spanishThem, them: { ...spanishThem.them, language: "auto" } });
  expect(startCapturePerParty).toHaveBeenCalledTimes(2);
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

const spanishThem: MeetingAudioConfig = { ...config, them: { ...config.them, language: "es-ES" } };

it("restarts only one side's speech-to-text for a language-only change", async () => {
  renderHook(() => useAudioConfigSync());

  await change(spanishThem);
  expect(setPartyLanguage).toHaveBeenCalledTimes(1);
  expect(setPartyLanguage).toHaveBeenCalledWith("them", spanishThem.them, { skipYouStt: false });
  expect(startCapturePerParty).not.toHaveBeenCalled();

  // The other side next: that is one side again, from the config now running.
  const spanishBoth: MeetingAudioConfig = { ...spanishThem, you: { ...spanishThem.you, language: "fr-FR" } };
  await change(spanishBoth);
  expect(setPartyLanguage).toHaveBeenCalledTimes(2);
  expect(setPartyLanguage).toHaveBeenLastCalledWith("you", spanishBoth.you, { skipYouStt: false });
  expect(startCapturePerParty).not.toHaveBeenCalled();

  // What runs now is the new config: going back to it later is no change.
  await change(spanishBoth);
  expect(setPartyLanguage).toHaveBeenCalledTimes(2);
});

it("tells Rust the room is an in-person meeting's other side", async () => {
  useMeetingStore.setState({ audioMode: "in_person" });
  renderHook(() => useAudioConfigSync());

  await change(spanishThem);
  expect(setPartyLanguage).toHaveBeenCalledWith("them", spanishThem.them, { skipYouStt: true });
});

it("restarts the whole capture when a side's provider changes along with a language", async () => {
  vi.mocked(startCapturePerParty).mockResolvedValue(undefined);
  renderHook(() => useAudioConfigSync());

  const both: MeetingAudioConfig = {
    ...config,
    them: { ...config.them, language: "es-ES", stt_provider: "groq_whisper" },
  };
  await change(both);
  expect(setPartyLanguage).not.toHaveBeenCalled();
  expect(startCapturePerParty).toHaveBeenCalledTimes(1);
});

it("restarts the whole capture when both sides' languages change at once", async () => {
  vi.mocked(startCapturePerParty).mockResolvedValue(undefined);
  renderHook(() => useAudioConfigSync());

  await change({
    ...config,
    you: { ...config.you, language: "fr-FR" },
    them: { ...config.them, language: "es-ES" },
  });
  expect(setPartyLanguage).not.toHaveBeenCalled();
  expect(startCapturePerParty).toHaveBeenCalledTimes(1);
});

it("restarts the whole capture when the replacement provider can't start", async () => {
  vi.mocked(startCapturePerParty).mockResolvedValue(undefined);
  vi.mocked(setPartyLanguage).mockRejectedValueOnce("Failed to start STT: no connection");
  renderHook(() => useAudioConfigSync());

  await change(spanishThem);
  expect(setPartyLanguage).toHaveBeenCalledTimes(1);
  expect(startCapturePerParty).toHaveBeenCalledTimes(1);
  expect(startCapturePerParty).toHaveBeenLastCalledWith(spanishThem.you, spanishThem.them, { skipYouStt: false });
  expect(emit).not.toHaveBeenCalled();
  // The full restart brought the new language up: it is what runs now.
  await change(spanishThem);
  expect(startCapturePerParty).toHaveBeenCalledTimes(1);
});

it("falls back to the whole capture when the one-side restart fails, or does nothing", async () => {
  vi.mocked(startCapturePerParty).mockResolvedValue(undefined);
  vi.mocked(setPartyLanguage).mockRejectedValueOnce("Audio state lock poisoned").mockResolvedValueOnce(false);
  renderHook(() => useAudioConfigSync());

  await change(spanishThem);
  expect(setPartyLanguage).toHaveBeenCalledTimes(1);
  expect(startCapturePerParty).toHaveBeenCalledTimes(1);
  expect(startCapturePerParty).toHaveBeenLastCalledWith(spanishThem.you, spanishThem.them, { skipYouStt: false });
  expect(emit).not.toHaveBeenCalled();

  // Rust answered false (nothing it could restart): the whole capture again.
  await change({ ...spanishThem, you: { ...spanishThem.you, language: "fr-FR" } });
  expect(setPartyLanguage).toHaveBeenCalledTimes(2);
  expect(startCapturePerParty).toHaveBeenCalledTimes(2);
});

it("keeps the running config when Rust refuses Auto-detect for the side", async () => {
  vi.mocked(setPartyLanguage).mockRejectedValueOnce(REFUSAL);
  renderHook(() => useAudioConfigSync());

  await change({ ...config, you: { ...config.you, language: "auto" } });
  expect(setPartyLanguage).toHaveBeenCalledTimes(1);
  expect(startCapturePerParty).not.toHaveBeenCalled(); // a full swap would only be refused again
  expect(emit).toHaveBeenCalledWith(
    "capture_warning",
    "Auto-detect doesn't work with Azure Speech, used for You. Your meeting keeps its current setup.",
  );

  // Back to what is still running: nothing to restart.
  await change(config);
  expect(setPartyLanguage).toHaveBeenCalledTimes(1);
  expect(startCapturePerParty).not.toHaveBeenCalled();
});

it("restarts the whole capture after a failed swap, since what runs is unknown", async () => {
  vi.mocked(startCapturePerParty).mockRejectedValueOnce("Audio device busy").mockResolvedValue(undefined);
  renderHook(() => useAudioConfigSync());

  await change(changed);
  expect(startCapturePerParty).toHaveBeenCalledTimes(1);

  await change(spanishThem);
  expect(setPartyLanguage).not.toHaveBeenCalled();
  expect(startCapturePerParty).toHaveBeenCalledTimes(2);
});
