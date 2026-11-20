import { act, cleanup, renderHook } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startCapturePerParty } from "../lib/ipc";
import type { MeetingAudioConfig } from "../lib/types";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useAudioConfigSync } from "./useAudioConfigSync";
import { useSpeechRecognition } from "./useSpeechRecognition";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  startCapturePerParty: vi.fn(async () => {}),
  stopCapture: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/event")>()),
  emit: vi.fn(async () => {}),
}));

const config: MeetingAudioConfig = {
  you: { role: "You", device_id: "default", is_input_device: true, stt_provider: "web_speech" },
  them: { role: "Them", device_id: "default", is_input_device: false, stt_provider: "groq_whisper" },
  recording_enabled: true,
  preset_name: null,
};

const started: unknown[] = [];

class FakeRecognition {
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  lang = "";
  onresult = null;
  onerror = null;
  onend = null;
  start = vi.fn(() => { started.push(this); });
  stop = vi.fn();
  abort = vi.fn();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  started.length = 0;
  (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeRecognition;
  useMeetingStore.setState({ isRecording: true, audioMode: "online" });
  useConfigStore.setState({ meetingAudioConfig: config, sttLanguage: "en-US" });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
  useMeetingStore.setState({ isRecording: false });
  useConfigStore.setState({ meetingAudioConfig: null, sttLanguage: "en-US" });
});

async function change(next: MeetingAudioConfig) {
  act(() => useConfigStore.setState({ meetingAudioConfig: next }));
  await act(() => vi.advanceTimersByTimeAsync(300));
}

const warnings = () => vi.mocked(emit).mock.calls.filter(([name]) => name === "capture_warning").map(([, text]) => text);

it("tells the user once when Web Speech is set to Auto-detect mid-meeting, and later swaps still work", async () => {
  renderHook(() => { useSpeechRecognition(); useAudioConfigSync(); });
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(started).toHaveLength(1);

  // You (Web Speech) picks Auto-detect. Rust accepts the swap (Web Speech is the frontend's).
  const auto: MeetingAudioConfig = { ...config, you: { ...config.you, language: "auto" } };
  await change(auto);
  expect(startCapturePerParty).toHaveBeenCalledTimes(1);
  expect(warnings()).toEqual([
    "Stopped transcribing You: Web Speech can't detect the language. " +
    "Pick a language (it applies right away) or choose another provider for You.",
  ]);

  // Them changes afterwards: another swap, no further warning.
  const spanish: MeetingAudioConfig = { ...auto, them: { ...auto.them, language: "es-ES" } };
  await change(spanish);
  expect(startCapturePerParty).toHaveBeenCalledTimes(2);
  expect(startCapturePerParty).toHaveBeenLastCalledWith(spanish.you, spanish.them, { skipYouStt: false });
  expect(warnings()).toHaveLength(1);
});
