import { act, cleanup, renderHook } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MeetingAudioConfig } from "../lib/types";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useSpeechRecognition } from "./useSpeechRecognition";

vi.mock("@tauri-apps/api/event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/event")>()),
  emit: vi.fn(async () => {}),
}));

const config: MeetingAudioConfig = {
  you: { role: "You", device_id: "default", is_input_device: true, stt_provider: "web_speech" },
  them: { role: "Them", device_id: "default", is_input_device: false, stt_provider: "deepgram" },
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
  onstart = null;
  start = vi.fn(() => { started.push(this); });
  stop = vi.fn();
  abort = vi.fn();
}

beforeEach(() => {
  vi.clearAllMocks();
  started.length = 0;
  (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeRecognition;
  useMeetingStore.setState({ isRecording: true, audioMode: "online" });
  useConfigStore.setState({ meetingAudioConfig: config, sttLanguage: "en-US" });
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
  useMeetingStore.setState({ isRecording: false });
  useConfigStore.setState({ meetingAudioConfig: null, sttLanguage: "en-US" });
});

it("tells the user when Auto-detect silences a running Web Speech side", async () => {
  renderHook(() => useSpeechRecognition());
  expect(started).toHaveLength(1);

  await act(async () => useConfigStore.setState({ sttLanguage: "auto" }));
  expect(emit).toHaveBeenCalledTimes(1);
  expect(emit).toHaveBeenCalledWith(
    "capture_warning",
    "You isn't being transcribed: Web Speech can't detect the language. " +
    "Pick a language (it applies right away) or choose another provider for You.",
  );

  // Picking a language starts it again, and the warning isn't repeated.
  await act(async () => useConfigStore.setState({ sttLanguage: "uk-UA" }));
  expect(started).toHaveLength(2);
  expect(emit).toHaveBeenCalledTimes(1);
});

it("stays quiet when Web Speech was not running", async () => {
  useConfigStore.setState({ sttLanguage: "auto" });
  renderHook(() => useSpeechRecognition());
  await act(async () => useConfigStore.setState({ sttLanguage: "auto", meetingAudioConfig: { ...config } }));
  expect(started).toHaveLength(0);
  expect(emit).not.toHaveBeenCalled();
});
