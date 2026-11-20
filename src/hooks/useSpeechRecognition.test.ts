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
    "Stopped transcribing You: Web Speech can't detect the language. " +
    "Pick a language (it applies right away) or choose another provider for You.",
  );

  // Picking a language starts it again, and the warning isn't repeated.
  await act(async () => useConfigStore.setState({ sttLanguage: "uk-UA" }));
  expect(started).toHaveLength(2);
  expect(emit).toHaveBeenCalledTimes(1);
});

it("recognises the language of the side it transcribes, not the shared one", async () => {
  useConfigStore.setState({
    sttLanguage: "en-US",
    meetingAudioConfig: { ...config, you: { ...config.you, language: "es-ES" } },
  });
  renderHook(() => useSpeechRecognition());
  expect(started).toHaveLength(1);
  expect((started[0] as FakeRecognition).lang).toBe("es-ES");

  // The other side's language is not Web Speech's business.
  await act(async () =>
    useConfigStore.setState({
      meetingAudioConfig: { ...config, you: { ...config.you, language: "es-ES" }, them: { ...config.them, language: "fr-FR" } },
    }),
  );
  expect(started).toHaveLength(1);

  // Changing this side's language restarts recognition in the new one.
  await act(async () =>
    useConfigStore.setState({ meetingAudioConfig: { ...config, you: { ...config.you, language: "de-DE" } } }),
  );
  expect(started).toHaveLength(2);
  expect((started[1] as FakeRecognition).lang).toBe("de-DE");

  // Back to "Same as…": the shared language.
  await act(async () => useConfigStore.setState({ meetingAudioConfig: config }));
  expect((started[2] as FakeRecognition).lang).toBe("en-US");
  await act(async () => useConfigStore.setState({ sttLanguage: "it-IT" }));
  expect((started[3] as FakeRecognition).lang).toBe("it-IT");
});

it("follows the room side's language when Web Speech transcribes Them", async () => {
  const them: MeetingAudioConfig = {
    ...config,
    you: { ...config.you, stt_provider: "deepgram", language: "en-US" },
    them: { ...config.them, stt_provider: "web_speech", is_input_device: true, language: "pt-BR" },
  };
  useConfigStore.setState({ sttLanguage: "en-US", meetingAudioConfig: them });
  renderHook(() => useSpeechRecognition());
  expect((started[0] as FakeRecognition).lang).toBe("pt-BR");
});

it("is silenced by Auto-detect on its own side while the shared language is fixed", async () => {
  renderHook(() => useSpeechRecognition());
  expect(started).toHaveLength(1);
  await act(async () =>
    useConfigStore.setState({ meetingAudioConfig: { ...config, you: { ...config.you, language: "auto" } } }),
  );
  expect(emit).toHaveBeenCalledWith(
    "capture_warning",
    "Stopped transcribing You: Web Speech can't detect the language. " +
    "Pick a language (it applies right away) or choose another provider for You.",
  );
  expect(started).toHaveLength(1);
});

it("stays quiet when Web Speech was not running", async () => {
  useConfigStore.setState({ sttLanguage: "auto" });
  renderHook(() => useSpeechRecognition());
  await act(async () => useConfigStore.setState({ sttLanguage: "auto", meetingAudioConfig: { ...config } }));
  expect(started).toHaveLength(0);
  expect(emit).not.toHaveBeenCalled();
});
