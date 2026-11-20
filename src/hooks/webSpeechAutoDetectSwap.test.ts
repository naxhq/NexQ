import { act, cleanup, renderHook } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

it("tells the user once when Web Speech is chosen while Auto-detect is on, and later swaps still work", async () => {
  // The meeting starts with You on Deepgram under Auto-detect: nothing for Web Speech to say.
  const deepgram: MeetingAudioConfig = { ...config, you: { ...config.you, stt_provider: "deepgram" } };
  useConfigStore.setState({ sttLanguage: "auto", meetingAudioConfig: deepgram });
  renderHook(() => { useSpeechRecognition(); useAudioConfigSync(); });
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(started).toHaveLength(0);
  expect(warnings()).toEqual([]);

  // You is switched to Web Speech (the overlay's STT chip, say).
  const webSpeech: MeetingAudioConfig = { ...deepgram, you: { ...deepgram.you, stt_provider: "web_speech" } };
  await change(webSpeech);
  expect(started).toHaveLength(0);
  expect(warnings()).toEqual([
    "You won't be transcribed: Web Speech can't detect the language. " +
    "Pick a language (it applies right away) or choose another provider for You.",
  ]);

  // A later change on Them swaps without another notice.
  const spanish: MeetingAudioConfig = { ...webSpeech, them: { ...webSpeech.them, language: "es-ES" } };
  await change(spanish);
  expect(startCapturePerParty).toHaveBeenLastCalledWith(spanish.you, spanish.them, { skipYouStt: false });
  expect(warnings()).toHaveLength(1);

  // Picking a language wakes it up; Auto-detect again says so again.
  // (It listens once the capture has restarted for that, a moment later.)
  await act(async () => useConfigStore.setState({ sttLanguage: "es-ES" }));
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(started).toHaveLength(1);
  await act(async () => useConfigStore.setState({ sttLanguage: "auto" }));
  expect(warnings()).toHaveLength(2);
  expect(warnings()[1]).toMatch(/^Stopped transcribing You:/);
});

describe("leaving Auto-detect with a microphone Rust has to switch to", () => {
  const headset: MeetingAudioConfig = {
    ...config,
    you: { ...config.you, device_id: "Headset Microphone" },
  };
  let finishSwap!: () => void;

  beforeEach(() => {
    vi.mocked(startCapturePerParty).mockImplementation(() => new Promise<void>((resolve) => { finishSwap = resolve; }));
  });

  it("starts Web Speech only once the capture restarted for it (shared language)", async () => {
    useConfigStore.setState({ sttLanguage: "auto", meetingAudioConfig: headset });
    renderHook(() => { useSpeechRecognition(); useAudioConfigSync(); });
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(started).toHaveLength(0);

    // The shared language stops being Auto-detect: no config change, but the capture must restart
    // (Rust skipped the mic override for the side Auto-detect left without STT).
    await act(async () => useConfigStore.setState({ sttLanguage: "es-ES" }));
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(startCapturePerParty).toHaveBeenCalledTimes(1);
    expect(startCapturePerParty).toHaveBeenLastCalledWith(headset.you, headset.them, { skipYouStt: false });
    expect(started).toHaveLength(0); // still on the old default microphone

    await act(async () => finishSwap());
    expect(started).toHaveLength(1);
    expect((started[0] as FakeRecognition).lang).toBe("es-ES");
  });

  it("starts Web Speech only once the capture restarted for it (its own language)", async () => {
    const auto: MeetingAudioConfig = { ...headset, you: { ...headset.you, language: "auto" } };
    useConfigStore.setState({ sttLanguage: "en-US", meetingAudioConfig: auto });
    renderHook(() => { useSpeechRecognition(); useAudioConfigSync(); });
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(started).toHaveLength(0);

    const spanish: MeetingAudioConfig = { ...headset, you: { ...headset.you, language: "es-ES" } };
    act(() => useConfigStore.setState({ meetingAudioConfig: spanish }));
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(startCapturePerParty).toHaveBeenCalledTimes(1);
    expect(started).toHaveLength(0);

    await act(async () => finishSwap());
    expect(started).toHaveLength(1);
    expect((started[0] as FakeRecognition).lang).toBe("es-ES");
  });

  it("starts anyway when the swap fails, and doesn't restart for changes that don't touch the mic", async () => {
    vi.mocked(startCapturePerParty).mockReset().mockRejectedValueOnce("Audio device busy").mockResolvedValue(undefined);
    useConfigStore.setState({ sttLanguage: "auto", meetingAudioConfig: headset });
    renderHook(() => { useSpeechRecognition(); useAudioConfigSync(); });
    await act(() => vi.advanceTimersByTimeAsync(300));

    await act(async () => useConfigStore.setState({ sttLanguage: "es-ES" }));
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(started).toHaveLength(1);

    // Them's language doesn't concern the microphone: Web Speech keeps listening.
    await change({ ...headset, them: { ...headset.them, language: "fr-FR" } });
    expect(startCapturePerParty).toHaveBeenCalledTimes(2);
    expect(started).toHaveLength(1);
  });
});
