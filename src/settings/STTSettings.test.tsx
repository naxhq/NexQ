import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MeetingAudioConfig } from "../lib/types";
import type * as IPC from "../lib/ipc";

vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));
vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof IPC>()),
  hasApiKey: async () => false,
  getApiKey: async () => null,
  listLocalSTTEngines: async () => [],
}));

import { STTSettings } from "./STTSettings";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";

const config: MeetingAudioConfig = {
  you: { role: "You", device_id: "default", is_input_device: true, stt_provider: "web_speech" },
  them: { role: "Them", device_id: "default", is_input_device: false, stt_provider: "deepgram" },
  recording_enabled: false,
  preset_name: null,
};

beforeEach(() => {
  useMeetingStore.setState({ audioMode: "online" });
  useConfigStore.setState({
    sttLanguage: "auto",
    sttProvider: "deepgram",
    meetingAudioConfig: config,
    deepgramConfig: { ...useConfigStore.getState().deepgramConfig, model: "nova-3" },
  });
});
afterEach(cleanup);

it("opens on the provider You uses and names the side that can't detect the language", () => {
  render(<STTSettings />);
  // Not the stored sttProvider ("deepgram"): the You side runs Web Speech.
  const warning = screen.getByText(
    "Auto-detect doesn't work with Web Speech, used for You. " +
    "Choose Deepgram Nova-3, Parakeet TDT 0.6B v3, Groq Whisper or Whisper API for that side, or pick a language."
  );
  expect(warning).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: /Transcription language/i })).toHaveAccessibleDescription(warning.textContent!);
});

it("checks the Them side too, and says nothing when both can detect the language", () => {
  useConfigStore.setState({
    meetingAudioConfig: { ...config, you: { ...config.you, stt_provider: "deepgram" }, them: { ...config.them, stt_provider: "azure_speech" } },
  });
  render(<STTSettings />);
  expect(screen.getByText(/doesn't work with Azure Speech, used for Them \(set in Audio & Devices\)\. Choose /)).toBeInTheDocument();
  expect(screen.queryByText(/used for You/)).toBeNull();

  cleanup();
  useConfigStore.setState({ meetingAudioConfig: { ...config, you: { ...config.you, stt_provider: "deepgram" } } });
  render(<STTSettings />);
  expect(screen.queryByText(/Auto-detect doesn't work/)).toBeNull();
  expect(screen.getByText("Nova-3 can transcribe multiple languages within the same sentence.")).toBeInTheDocument();
});

const deepgramYou: MeetingAudioConfig = { ...config, you: { ...config.you, stt_provider: "deepgram" } };

it("judges the You provider by the language You is transcribed in", () => {
  const flux = { ...useConfigStore.getState().deepgramConfig, model: "flux-general-multi" };
  // Shared Ukrainian, but You has its own English: Flux is fine.
  useConfigStore.setState({
    sttLanguage: "uk-UA",
    deepgramConfig: flux,
    meetingAudioConfig: { ...deepgramYou, you: { ...deepgramYou.you, language: "en-US" } },
  });
  render(<STTSettings />);
  expect(screen.queryByText(/Switch from Flux to Nova-3/)).toBeNull();

  // Shared English, but You has its own Ukrainian: not fine.
  cleanup();
  useConfigStore.setState({
    sttLanguage: "en-US",
    meetingAudioConfig: { ...deepgramYou, you: { ...deepgramYou.you, language: "uk-UA" } },
  });
  render(<STTSettings />);
  expect(screen.getByText("Switch from Flux to Nova-3 for Ukrainian transcription.")).toBeInTheDocument();

  // Without a language of its own, the shared one counts, as before.
  cleanup();
  useConfigStore.setState({ sttLanguage: "uk-UA", meetingAudioConfig: deepgramYou });
  render(<STTSettings />);
  expect(screen.getByText("Switch from Flux to Nova-3 for Ukrainian transcription.")).toBeInTheDocument();
});

it("keeps the Cartesia line and the other provider hints", () => {
  useConfigStore.setState({
    sttLanguage: "es-ES",
    meetingAudioConfig: { ...config, you: { ...config.you, stt_provider: "cartesia" } },
  });
  render(<STTSettings />);
  expect(screen.getByText("Cartesia detects English, French, Hindi, Japanese and Spanish on its own.")).toBeInTheDocument();
  cleanup();
  useConfigStore.setState({ sttLanguage: "de-DE" });
  render(<STTSettings />);
  expect(screen.getByText(/Cartesia transcribes only English, French, Hindi, Japanese and Spanish/)).toBeInTheDocument();
  cleanup();
  useConfigStore.setState({
    sttLanguage: "vi-VN",
    meetingAudioConfig: { ...config, you: { ...config.you, stt_provider: "parakeet_tdt" } },
  });
  render(<STTSettings />);
  expect(screen.getByText(/The included Parakeet models do not support Vietnamese/)).toBeInTheDocument();
});

it("says which sides are transcribed in a language of their own, under the shared picker", () => {
  useConfigStore.setState({ sttLanguage: "en-US" });
  render(<STTSettings />);
  expect(screen.queryByText(/set in Audio & Devices\.$/)).toBeNull();

  cleanup();
  useConfigStore.setState({
    meetingAudioConfig: { ...config, them: { ...config.them, language: "es-ES" } },
  });
  render(<STTSettings />);
  expect(screen.getByText("Them: Spanish, set in Audio & Devices.")).toBeInTheDocument();
  expect(screen.queryByText(/^You: /)).toBeNull();

  cleanup();
  useConfigStore.setState({
    meetingAudioConfig: {
      ...config,
      you: { ...config.you, language: "en-GB" },
      them: { ...config.them, language: "es-ES" },
    },
  });
  render(<STTSettings />);
  expect(screen.getByText("You: English (UK), set in Audio & Devices.")).toBeInTheDocument();
  expect(screen.getByText("Them: Spanish, set in Audio & Devices.")).toBeInTheDocument();

  // In-person meetings transcribe the room only.
  cleanup();
  useMeetingStore.setState({ audioMode: "in_person" });
  render(<STTSettings />);
  expect(screen.getByText("Room: Spanish, set in Audio & Devices.")).toBeInTheDocument();
  expect(screen.queryByText(/^You: /)).toBeNull();
});

it("warns about a side that picked Auto-detect itself, though the shared language is fixed", () => {
  useConfigStore.setState({
    sttLanguage: "en-US",
    meetingAudioConfig: { ...config, you: { ...config.you, language: "auto" } },
  });
  render(<STTSettings />);
  const warning = screen.getByText(/Auto-detect doesn't work with Web Speech, used for You\./);
  expect(warning).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: /Transcription language/i })).toHaveAccessibleDescription(warning.textContent!);
  // The Nova-3 tip belongs to the shared Auto-detect only.
  expect(screen.queryByText(/Nova-3 can transcribe|For speech that switches/)).toBeNull();
});

it("keeps the Nova-3 tip for the shared Auto-detect and drops a warning for a side that picked a language", () => {
  useConfigStore.setState({
    sttLanguage: "auto",
    meetingAudioConfig: { ...config, you: { ...config.you, language: "en-US" } },
  });
  render(<STTSettings />);
  // You (Web Speech) has its own language, so Auto-detect doesn't concern it; Them runs Deepgram Nova-3.
  expect(screen.queryByText(/Auto-detect doesn't work/)).toBeNull();
  expect(screen.getByText("For speech that switches languages mid-sentence, use Deepgram Nova-3.")).toBeInTheDocument();
});
