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
  expect(screen.getByRole("combobox", { name: /STT language/i })).toHaveAccessibleDescription(warning.textContent!);
});

it("checks the Them side too, and says nothing when both can detect the language", () => {
  useConfigStore.setState({
    meetingAudioConfig: { ...config, you: { ...config.you, stt_provider: "deepgram" }, them: { ...config.them, stt_provider: "azure_speech" } },
  });
  render(<STTSettings />);
  expect(screen.getByText(/doesn't work with Azure Speech, used for Them\..*\(set in Audio & Devices\)$/)).toBeInTheDocument();
  expect(screen.queryByText(/used for You/)).toBeNull();

  cleanup();
  useConfigStore.setState({ meetingAudioConfig: { ...config, you: { ...config.you, stt_provider: "deepgram" } } });
  render(<STTSettings />);
  expect(screen.queryByText(/Auto-detect doesn't work/)).toBeNull();
  expect(screen.getByText("Nova-3 can transcribe multiple languages within the same sentence.")).toBeInTheDocument();
});
