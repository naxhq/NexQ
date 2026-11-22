import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MeetingAudioConfig } from "../lib/types";
import type * as IPC from "../lib/ipc";

const azureMai = vi.hoisted(() => ({
  credentials: new Map<string, string>(),
  has: vi.fn(),
  get: vi.fn(),
  probe: vi.fn(),
  sttTest: vi.fn(),
  store: vi.fn(),
  delete: vi.fn(),
}));
const shell = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/plugin-shell", () => shell);
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));
vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof IPC>()),
  hasApiKey: (provider: string) => azureMai.has(provider),
  getApiKey: (provider: string) => azureMai.get(provider),
  storeApiKey: (provider: string, key: string) => azureMai.store(provider, key),
  deleteApiKey: (provider: string) => azureMai.delete(provider),
  testAzureMaiConnection: (key: string, region: string) => azureMai.probe(key, region),
  testSTTConnection: (provider: string) => azureMai.sttTest(provider),
  listLocalSTTEngines: async () => [],
}));

import { STTSettings } from "./STTSettings";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";
import { open } from "@tauri-apps/plugin-shell";

const config: MeetingAudioConfig = {
  you: { role: "You", device_id: "default", is_input_device: true, stt_provider: "web_speech" },
  them: { role: "Them", device_id: "default", is_input_device: false, stt_provider: "deepgram" },
  recording_enabled: false,
  preset_name: null,
};

beforeEach(() => {
  azureMai.credentials.clear();
  azureMai.has.mockReset().mockImplementation(async (provider: string) => azureMai.credentials.has(provider));
  azureMai.get.mockReset().mockImplementation(async (provider: string) => azureMai.credentials.get(provider) ?? null);
  azureMai.probe.mockReset().mockResolvedValue(true);
  azureMai.sttTest.mockReset().mockResolvedValue(true);
  azureMai.store.mockReset().mockImplementation(async (provider: string, key: string) => {
    azureMai.credentials.set(provider, key);
  });
  azureMai.delete.mockReset().mockImplementation(async (provider: string) => {
    azureMai.credentials.delete(provider);
  });
  shell.open.mockReset().mockResolvedValue(undefined);
  useMeetingStore.setState({ audioMode: "online" });
  useConfigStore.setState({
    sttLanguage: "auto",
    sttProvider: "deepgram",
    meetingAudioConfig: config,
    deepgramConfig: { ...useConfigStore.getState().deepgramConfig, model: "nova-3" },
    verifiedCloudProviders: [],
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

it("shows MAI model, preview, Speech Resource regions, multilingual default, and the official guide", async () => {
  useConfigStore.setState({
    meetingAudioConfig: {
      ...config,
      you: { ...config.you, stt_provider: "deepgram" },
    },
  });
  const user = userEvent.setup();
  render(<STTSettings />);
  await user.click(screen.getByRole("button", { name: /Azure MAI Streaming/ }));

  expect(screen.getByText("MAI-Transcribe-2-Streaming")).toBeInTheDocument();
  expect(screen.getByText("Public Preview")).toBeInTheDocument();
  expect(screen.getByText("Speech Resource")).toBeInTheDocument();
  expect(screen.getByText(
    "MAI-Transcribe-2-Streaming uses multilingual mode with automatic language detection by default.",
  )).toBeInTheDocument();

  const region = screen.getByRole<HTMLSelectElement>("combobox", { name: "Speech Resource region" });
  expect(Array.from(region.options, (option) => option.textContent)).toEqual([
    "Sweden Central (swedencentral)",
    "Central US (centralus)",
    "East US 2 (eastus2)",
    "Southeast Asia (southeastasia)",
  ]);
  expect(region).toHaveAccessibleDescription(
    "Choose the region where your Speech Resource was created. The API key and region are saved only after the connection test succeeds.",
  );

  await user.click(screen.getByRole("button", { name: "Official Microsoft guide" }));
  expect(open).toHaveBeenCalledExactlyOnceWith(
    "https://learn.microsoft.com/en-us/azure/ai-services/speech-service/mai-transcribe-2-streaming-speech-sdk",
  );
});

it("tests replacement MAI credentials before saving and preserves the prior key and region on failure", async () => {
  azureMai.credentials.set("azure_mai_streaming", "previous-key");
  azureMai.credentials.set("azure_mai_streaming_region", "swedencentral");
  azureMai.probe.mockResolvedValue(false);
  useConfigStore.setState({
    meetingAudioConfig: {
      ...config,
      you: { ...config.you, stt_provider: "azure_mai_streaming" },
    },
    verifiedCloudProviders: ["azure_mai_streaming"],
  });

  const user = userEvent.setup();
  render(<STTSettings />);
  const key = await screen.findByLabelText("API Key");
  await waitFor(() => expect(azureMai.has).toHaveBeenCalledWith("azure_mai_streaming"));
  expect(key).toHaveValue("");
  expect(key).toHaveAttribute("placeholder", "Key stored — type to replace");
  expect(azureMai.get).not.toHaveBeenCalledWith("azure_mai_streaming");
  expect(screen.getByText("API key configured and stored securely")).toBeInTheDocument();
  const region = screen.getByRole("combobox", { name: "Speech Resource region" });
  await waitFor(() => expect(region).toHaveValue("swedencentral"));

  await user.clear(key);
  await user.type(key, "replacement-key");
  await user.selectOptions(region, "centralus");
  await user.click(screen.getByRole("button", { name: "Save & Test" }));

  await waitFor(() => expect(azureMai.probe).toHaveBeenCalledWith("replacement-key", "centralus"));
  expect(azureMai.store).not.toHaveBeenCalled();
  expect(azureMai.credentials.get("azure_mai_streaming")).toBe("previous-key");
  expect(azureMai.credentials.get("azure_mai_streaming_region")).toBe("swedencentral");
  expect(await screen.findByText("Connection failed — existing credentials were kept")).toBeInTheDocument();
});

it("saves MAI key and region only after the direct probe succeeds", async () => {
  azureMai.credentials.set("azure_mai_streaming", "previous-key");
  azureMai.credentials.set("azure_mai_streaming_region", "swedencentral");
  azureMai.probe.mockImplementation(async () => {
    expect(azureMai.credentials.get("azure_mai_streaming")).toBe("previous-key");
    expect(azureMai.credentials.get("azure_mai_streaming_region")).toBe("swedencentral");
    return true;
  });
  useConfigStore.setState({
    meetingAudioConfig: {
      ...config,
      you: { ...config.you, stt_provider: "azure_mai_streaming" },
    },
  });

  const user = userEvent.setup();
  render(<STTSettings />);
  const key = await screen.findByLabelText("API Key");
  await waitFor(() => expect(key).toHaveAttribute("placeholder", "Key stored — type to replace"));
  expect(key).toHaveValue("");
  expect(azureMai.get).not.toHaveBeenCalledWith("azure_mai_streaming");
  await user.type(key, "replacement-key");
  await user.selectOptions(screen.getByRole("combobox", { name: "Speech Resource region" }), "eastus2");
  await user.click(screen.getByRole("button", { name: "Save & Test" }));

  await waitFor(() => expect(azureMai.credentials.get("azure_mai_streaming")).toBe("replacement-key"));
  expect(azureMai.credentials.get("azure_mai_streaming_region")).toBe("eastus2");
  expect(azureMai.store).toHaveBeenCalledWith("azure_mai_streaming", "replacement-key");
  expect(azureMai.store).toHaveBeenCalledWith("azure_mai_streaming_region", "eastus2");
  expect(screen.getByText("Connection successful — provider is ready")).toBeInTheDocument();
});

it("clears configured MAI credentials without ever reading the stored key value", async () => {
  azureMai.credentials.set("azure_mai_streaming", "mai-secret");
  azureMai.credentials.set("azure_mai_streaming_region", "swedencentral");
  useConfigStore.setState({
    meetingAudioConfig: {
      ...config,
      you: { ...config.you, stt_provider: "azure_mai_streaming" },
    },
    verifiedCloudProviders: ["azure_mai_streaming"],
  });

  const user = userEvent.setup();
  render(<STTSettings />);
  const key = await screen.findByLabelText("API Key");
  await waitFor(() => expect(key).toHaveAttribute("placeholder", "Key stored — type to replace"));
  expect(screen.getByRole("button", { name: "Clear" })).toBeInTheDocument();
  expect(azureMai.get).not.toHaveBeenCalledWith("azure_mai_streaming");

  await user.click(screen.getByRole("button", { name: "Clear" }));
  await waitFor(() => expect(azureMai.credentials.has("azure_mai_streaming")).toBe(false));
  expect(azureMai.credentials.has("azure_mai_streaming_region")).toBe(false);
  expect(azureMai.delete).toHaveBeenCalledWith("azure_mai_streaming");
  expect(azureMai.delete).toHaveBeenCalledWith("azure_mai_streaming_region");
  expect(azureMai.get).not.toHaveBeenCalledWith("azure_mai_streaming");
});

it("keeps legacy Azure Speech readback and eastus region isolated from MAI region selection", async () => {
  azureMai.credentials.set("azure_mai_streaming", "mai-secret");
  azureMai.credentials.set("azure_mai_streaming_region", "swedencentral");
  azureMai.credentials.set("azure_speech", "legacy-key");
  useConfigStore.setState({
    meetingAudioConfig: {
      ...config,
      you: { ...config.you, stt_provider: "azure_mai_streaming" },
    },
  });

  const user = userEvent.setup();
  render(<STTSettings />);
  const maiRegion = await screen.findByRole("combobox", { name: "Speech Resource region" });
  await waitFor(() => expect(maiRegion).toHaveValue("swedencentral"));
  await user.selectOptions(maiRegion, "centralus");
  expect(screen.getByText(/Re-enter the saved API key to test the updated region/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save & Test" })).toBeDisabled();

  await user.click(screen.getByRole("button", { name: /Azure Speech/ }));
  const legacyKey = await screen.findByLabelText("API Key");
  await waitFor(() => expect(legacyKey).toHaveValue("legacy-key"));
  expect(await screen.findByLabelText("Azure Region")).toHaveValue("eastus");
  expect(azureMai.get).toHaveBeenCalledWith("azure_speech");
  expect(azureMai.get).not.toHaveBeenCalledWith("azure_mai_streaming");
  expect(azureMai.credentials.get("azure_mai_streaming_region")).toBe("swedencentral");
});

it("ignores a delayed MAI credential-presence result after switching to Azure Speech", async () => {
  let resolveMaiPresence!: (exists: boolean) => void;
  azureMai.credentials.set("azure_mai_streaming", "mai-secret");
  azureMai.has.mockImplementation((provider: string) => {
    if (provider === "azure_mai_streaming") {
      return new Promise<boolean>((resolve) => { resolveMaiPresence = resolve; });
    }
    return Promise.resolve(azureMai.credentials.has(provider));
  });
  useConfigStore.setState({
    meetingAudioConfig: {
      ...config,
      you: { ...config.you, stt_provider: "azure_mai_streaming" },
    },
  });

  const user = userEvent.setup();
  render(<STTSettings />);
  await waitFor(() => expect(resolveMaiPresence).toBeTypeOf("function"));
  await user.click(screen.getByRole("button", { name: /Azure Speech/ }));
  const key = await screen.findByLabelText("API Key");
  await waitFor(() => expect(key).toHaveAttribute("placeholder", "Enter Azure Speech API key"));
  resolveMaiPresence(true);
  await waitFor(() => expect(key).toHaveAttribute("placeholder", "Enter Azure Speech API key"));
  expect(key).toHaveValue("");
  expect(screen.queryByText("API key configured and stored securely")).toBeNull();
  expect(azureMai.get).not.toHaveBeenCalledWith("azure_mai_streaming");
});

it("persists a successful in-flight MAI test to MAI without showing its result in the newly selected provider form", async () => {
  let resolveProbe!: (success: boolean) => void;
  azureMai.credentials.set("azure_mai_streaming", "old-mai-key");
  azureMai.credentials.set("azure_mai_streaming_region", "swedencentral");
  azureMai.probe.mockImplementation(() => new Promise<boolean>((resolve) => { resolveProbe = resolve; }));
  useConfigStore.setState({
    meetingAudioConfig: {
      ...config,
      you: { ...config.you, stt_provider: "azure_mai_streaming" },
    },
  });

  const user = userEvent.setup();
  render(<STTSettings />);
  const key = await screen.findByLabelText("API Key");
  await waitFor(() => expect(key).toHaveAttribute("placeholder", "Key stored — type to replace"));
  await user.type(key, "new-mai-key");
  await user.click(screen.getByRole("button", { name: "Save & Test" }));
  await waitFor(() => expect(resolveProbe).toBeTypeOf("function"));

  await user.click(screen.getByRole("button", { name: /Azure Speech/ }));
  const azureKey = await screen.findByLabelText("API Key");
  await waitFor(() => expect(azureKey).toHaveAttribute("placeholder", "Enter Azure Speech API key"));
  resolveProbe(true);

  await waitFor(() => expect(azureMai.credentials.get("azure_mai_streaming")).toBe("new-mai-key"));
  expect(azureMai.credentials.get("azure_mai_streaming_region")).toBe("swedencentral");
  expect(azureKey).toHaveValue("");
  expect(screen.queryByText("Connection successful — provider is ready")).toBeNull();
  expect(screen.queryByText("API key configured and stored securely")).toBeNull();
});

it("still reads back stored keys for non-MAI cloud providers", async () => {
  azureMai.credentials.set("deepgram", "deepgram-key");
  useConfigStore.setState({
    meetingAudioConfig: {
      ...config,
      you: { ...config.you, stt_provider: "deepgram" },
    },
  });

  render(<STTSettings />);
  await waitFor(() => expect(screen.getByLabelText("API Key")).toHaveValue("deepgram-key"));
  expect(azureMai.get).toHaveBeenCalledWith("deepgram");
});

function useWhisperApiProvider(verified: boolean = false) {
  useConfigStore.setState({
    meetingAudioConfig: {
      ...config,
      you: { ...config.you, stt_provider: "whisper_api" },
    },
    verifiedCloudProviders: verified ? ["whisper_api"] : [],
  });
}

async function renderWhisper() {
  const user = userEvent.setup();
  render(<STTSettings />);
  const endpoint = await screen.findByLabelText("Endpoint");
  await waitFor(() => expect(endpoint).not.toBeDisabled());
  // The key field finishes loading its slot after the endpoint decides which slot applies.
  await waitFor(() => expect(screen.getByLabelText(/^API [Kk]ey/)).not.toBeDisabled());
  return { user, endpoint, model: screen.getByLabelText("Model") };
}

function whisperBadge() {
  return within(screen.getByRole("button", { name: /^Whisper API/ }));
}

it("loads the saved Whisper API endpoint and model, above the key field", async () => {
  azureMai.credentials.set("whisper_api_base_url", "http://127.0.0.1:8000/v1");
  azureMai.credentials.set("whisper_api_model", "Systran/faster-whisper-small");
  useWhisperApiProvider();

  render(<STTSettings />);
  const endpoint = await screen.findByLabelText("Endpoint");
  await waitFor(() => expect(endpoint).toHaveValue("http://127.0.0.1:8000/v1"));
  expect(screen.getByLabelText("Model")).toHaveValue("Systran/faster-whisper-small");
  expect(endpoint).toHaveAttribute("placeholder", "https://api.openai.com/v1");
  expect(screen.getByLabelText("Model")).toHaveAttribute("placeholder", "whisper-1");
  expect(screen.getByText(
    "Any OpenAI-compatible transcription server, for example a local faster-whisper server. Leave empty for OpenAI.",
  )).toBeInTheDocument();

  const key = await screen.findByLabelText("API key for this server (optional)");
  expect(endpoint.compareDocumentPosition(key) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("describes Whisper API as OpenAI or your own server", async () => {
  useWhisperApiProvider();
  render(<STTSettings />);
  expect(await screen.findByText("OpenAI or your own compatible server")).toBeInTheDocument();
});

it("saves the Whisper API endpoint and model on blur and deletes them when emptied", async () => {
  useWhisperApiProvider();
  const { user, endpoint, model } = await renderWhisper();

  await user.type(endpoint, "http://127.0.0.1:8000/v1");
  await user.type(model, "my-model");
  await user.tab();
  await waitFor(() => expect(azureMai.credentials.get("whisper_api_base_url")).toBe("http://127.0.0.1:8000/v1"));
  expect(azureMai.credentials.get("whisper_api_model")).toBe("my-model");

  await user.clear(endpoint);
  await user.clear(model);
  await user.tab();
  await waitFor(() => expect(azureMai.credentials.has("whisper_api_base_url")).toBe(false));
  expect(azureMai.credentials.has("whisper_api_model")).toBe(false);
});

it("rejects an invalid endpoint on blur with aria-invalid and a message, and does not save it", async () => {
  useWhisperApiProvider();
  const { user, endpoint } = await renderWhisper();

  await user.type(endpoint, "127.0.0.1:8000");
  await user.tab();
  expect(await screen.findByRole("alert")).toHaveTextContent(/must start with http:\/\/ or https:\/\//);
  expect(endpoint).toHaveAttribute("aria-invalid", "true");
  expect(azureMai.credentials.has("whisper_api_base_url")).toBe(false);

  await user.clear(endpoint);
  await user.type(endpoint, "http://127.0.0.1:8000/v1");
  expect(endpoint).not.toHaveAttribute("aria-invalid");
});

it("lets Whisper API Save & Test run without any key when an endpoint is set", async () => {
  useWhisperApiProvider();
  const { user, endpoint } = await renderWhisper();
  expect(screen.queryByRole("button", { name: "Save & Test" })).not.toBeInTheDocument();

  await user.type(endpoint, "http://127.0.0.1:8000/v1");
  await user.click(screen.getByRole("button", { name: "Save & Test" }));

  await waitFor(() => expect(azureMai.sttTest).toHaveBeenCalledWith("whisper_api"));
  expect(azureMai.credentials.get("whisper_api_base_url")).toBe("http://127.0.0.1:8000/v1");
  expect(azureMai.credentials.has("whisper_api")).toBe(false);
  expect(azureMai.credentials.has("whisper_api_custom_key")).toBe(false);
  await waitFor(() => expect(useConfigStore.getState().verifiedCloudProviders).toContain("whisper_api"));
});

it("keeps the saved OpenAI key out of a custom endpoint: not shown, not stored over, not deleted", async () => {
  azureMai.credentials.set("whisper_api", "sk-openai");
  azureMai.credentials.set("whisper_api_base_url", "http://127.0.0.1:8000/v1");
  useWhisperApiProvider();
  const { user } = await renderWhisper();

  const key = screen.getByLabelText("API key for this server (optional)");
  expect(key).toHaveValue("");
  await user.click(screen.getByRole("button", { name: "Save & Test" }));
  await waitFor(() => expect(azureMai.sttTest).toHaveBeenCalledWith("whisper_api"));

  expect(azureMai.store.mock.calls.some(([p]) => p === "whisper_api")).toBe(false);
  expect(azureMai.delete.mock.calls.some(([p]) => p === "whisper_api")).toBe(false);
  expect(azureMai.credentials.get("whisper_api")).toBe("sk-openai");
});

it("stores a typed key for a custom endpoint in its own slot, never the OpenAI one", async () => {
  azureMai.credentials.set("whisper_api", "sk-openai");
  azureMai.credentials.set("whisper_api_base_url", "http://127.0.0.1:8000/v1");
  useWhisperApiProvider();
  const { user } = await renderWhisper();

  await user.type(screen.getByLabelText("API key for this server (optional)"), "server-key");
  await user.click(screen.getByRole("button", { name: "Save & Test" }));
  await waitFor(() => expect(azureMai.credentials.get("whisper_api_custom_key")).toBe("server-key"));
  expect(azureMai.credentials.get("whisper_api")).toBe("sk-openai");
});

it("restores the previous custom key and shows the server's message when the test fails", async () => {
  azureMai.credentials.set("whisper_api_custom_key", "old-key");
  azureMai.credentials.set("whisper_api_base_url", "http://127.0.0.1:8000/v1");
  azureMai.sttTest.mockRejectedValue("Couldn't reach http://127.0.0.1:8000/v1. Is the server running?");
  useWhisperApiProvider();
  const { user } = await renderWhisper();

  const key = screen.getByLabelText("API key for this server (optional)");
  await waitFor(() => expect(key).toHaveValue("old-key"));
  await user.clear(key);
  await user.type(key, "new-key");
  await user.click(screen.getByRole("button", { name: "Save & Test" }));

  expect(await screen.findByText("Couldn't reach http://127.0.0.1:8000/v1. Is the server running?")).toBeInTheDocument();
  expect(azureMai.credentials.get("whisper_api_custom_key")).toBe("old-key");
});

it("keeps a stored OpenAI key through a model-only change, even when the test fails", async () => {
  azureMai.credentials.set("whisper_api", "sk-openai");
  azureMai.sttTest.mockRejectedValue("The server answered 400: bad model");
  useWhisperApiProvider(true);
  const { user, model } = await renderWhisper();
  expect(screen.queryByRole("button", { name: "Save & Test" })).not.toBeInTheDocument();

  await user.type(model, "gpt-4o-transcribe");
  expect(screen.getByRole("button", { name: "Save & Test" })).toBeEnabled();
  await user.tab();
  // Saved on blur; the badge asks for a new test instead of turning into "No Key".
  await waitFor(() => expect(azureMai.credentials.get("whisper_api_model")).toBe("gpt-4o-transcribe"));
  expect(whisperBadge().getByText("Not tested")).toBeInTheDocument();
  expect(whisperBadge().queryByText("No Key")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Save & Test" }));
  expect(await screen.findByText("The server answered 400: bad model")).toBeInTheDocument();
  expect(azureMai.credentials.get("whisper_api")).toBe("sk-openai");
  expect(azureMai.delete.mock.calls.some(([p]) => p === "whisper_api")).toBe(false);
});

it("keeps Whisper API key-required by default and rejects a non-http endpoint on Save & Test", async () => {
  useWhisperApiProvider();
  const { user, endpoint } = await renderWhisper();

  await user.type(screen.getByLabelText(/^API [Kk]ey/), "sk-test");
  await user.type(endpoint, "127.0.0.1:8000");
  await user.click(screen.getByRole("button", { name: "Save & Test" }));

  expect(await screen.findAllByText(/must start with http:\/\/ or https:\/\//)).not.toHaveLength(0);
  expect(azureMai.sttTest).not.toHaveBeenCalled();
  expect(azureMai.credentials.has("whisper_api_base_url")).toBe(false);
});

it("warns that a key is sent unencrypted to a non-local http endpoint, but not to localhost", async () => {
  useWhisperApiProvider();
  const { user, endpoint } = await renderWhisper();

  await user.type(endpoint, "http://127.0.0.1:8000/v1");
  await user.type(screen.getByLabelText("API key for this server (optional)"), "k");
  expect(screen.queryByText(/sent unencrypted/)).not.toBeInTheDocument();

  await user.clear(endpoint);
  await user.type(endpoint, "http://192.168.1.20:8000/v1");
  expect(await screen.findByText(/the key is sent unencrypted/)).toBeInTheDocument();
});

it("treats the OpenAI URL as the default: OpenAI key field and slot stay, nothing is stored", async () => {
  azureMai.credentials.set("whisper_api", "sk-openai");
  useWhisperApiProvider();
  const { user, endpoint } = await renderWhisper();
  expect(screen.getByLabelText("API Key")).toHaveValue("sk-openai");

  await user.type(endpoint, "HTTPS://api.openai.com/v1/audio/transcriptions/");
  await user.tab();
  expect(screen.getByLabelText("API Key")).toHaveValue("sk-openai");
  expect(screen.queryByLabelText("API key for this server (optional)")).not.toBeInTheDocument();
  expect(azureMai.credentials.has("whisper_api_base_url")).toBe(false);
});

it("carries a typed, unsaved key over when the key slot swaps, but never a saved one", async () => {
  azureMai.credentials.set("whisper_api", "sk-openai");
  useWhisperApiProvider();
  const first = await renderWhisper();

  // A saved key stays with its slot.
  expect(screen.getByLabelText("API Key")).toHaveValue("sk-openai");
  await first.user.type(first.endpoint, "http://127.0.0.1:8000/v1");
  const customKey = await screen.findByLabelText("API key for this server (optional)");
  await waitFor(() => expect(customKey).toHaveValue(""));
  cleanup();

  // A key typed but not saved moves with the user to the other slot.
  azureMai.credentials.clear();
  useWhisperApiProvider();
  const second = await renderWhisper();
  await second.user.type(screen.getByLabelText("API Key"), "typed-key");
  await second.user.type(second.endpoint, "http://127.0.0.1:8000/v1");
  const swapped = await screen.findByLabelText("API key for this server (optional)");
  await waitFor(() => expect(swapped).toHaveValue("typed-key"));
});

it("leaves the endpoint saved and the previous key intact when a test fails", async () => {
  azureMai.credentials.set("whisper_api_custom_key", "old-key");
  azureMai.credentials.set("whisper_api_base_url", "http://127.0.0.1:8000/v1");
  azureMai.sttTest.mockRejectedValue("The server answered 404: not found");
  useWhisperApiProvider();
  const { user, endpoint } = await renderWhisper();

  const key = screen.getByLabelText("API key for this server (optional)");
  await waitFor(() => expect(key).toHaveValue("old-key"));
  await user.clear(endpoint);
  await user.type(endpoint, "http://127.0.0.1:9000/v1");
  await user.clear(key);
  await user.type(key, "new-key");
  await user.click(screen.getByRole("button", { name: "Save & Test" }));

  expect(await screen.findByText("The server answered 404: not found")).toBeInTheDocument();
  expect(azureMai.credentials.get("whisper_api_base_url")).toBe("http://127.0.0.1:9000/v1");
  expect(azureMai.credentials.get("whisper_api_custom_key")).toBe("old-key");
});

it("says the Whisper API key is stored, not verified, until a test passes", async () => {
  azureMai.credentials.set("whisper_api", "sk-openai");
  useWhisperApiProvider();
  await renderWhisper();
  expect(await screen.findByText("API key stored securely")).toBeInTheDocument();
  expect(screen.queryByText("API key verified and stored securely")).not.toBeInTheDocument();

  cleanup();
  useWhisperApiProvider(true);
  await renderWhisper();
  expect(await screen.findByText("API key verified and stored securely")).toBeInTheDocument();
});

it("chains overlapping endpoint saves so the last edit is what stays stored", async () => {
  // The first save is slow; without chaining it would finish after the second one.
  azureMai.store.mockImplementation(async (provider: string, key: string) => {
    if (provider === "whisper_api_base_url" && key.includes("first")) {
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    azureMai.credentials.set(provider, key);
  });
  useWhisperApiProvider();
  const { user, endpoint } = await renderWhisper();

  await user.type(endpoint, "http://first:1/v1");
  await user.tab();
  await user.clear(endpoint);
  await user.type(endpoint, "http://second:2/v1");
  await user.tab();

  await waitFor(() => expect(azureMai.credentials.get("whisper_api_base_url")).toBe("http://second:2/v1"));
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(azureMai.credentials.get("whisper_api_base_url")).toBe("http://second:2/v1");
  const writes = azureMai.store.mock.calls.filter(([p]) => p === "whisper_api_base_url").map(([, v]) => v);
  expect(writes).toEqual(["http://first:1/v1", "http://second:2/v1"]);
});

it("locks the Whisper inputs while a test runs", async () => {
  let finish: (ok: boolean) => void = () => {};
  azureMai.sttTest.mockReturnValue(new Promise<boolean>((resolve) => { finish = resolve; }));
  useWhisperApiProvider();
  const { user, endpoint, model } = await renderWhisper();

  await user.type(endpoint, "http://127.0.0.1:8000/v1");
  await user.click(screen.getByRole("button", { name: "Save & Test" }));
  await waitFor(() => expect(azureMai.sttTest).toHaveBeenCalled());
  expect(endpoint).toBeDisabled();
  expect(model).toBeDisabled();
  expect(screen.getByLabelText("API key for this server (optional)")).toBeDisabled();

  finish(true);
  await waitFor(() => expect(endpoint).not.toBeDisabled());
  await waitFor(() => expect(useConfigStore.getState().verifiedCloudProviders).toContain("whisper_api"));
});

it("does not mark Whisper API verified when the config changed under a running test", async () => {
  let finish: (ok: boolean) => void = () => {};
  azureMai.sttTest.mockReturnValue(new Promise<boolean>((resolve) => { finish = resolve; }));
  useWhisperApiProvider();
  const { user, endpoint } = await renderWhisper();

  await user.type(endpoint, "http://127.0.0.1:8000/v1");
  await user.click(screen.getByRole("button", { name: "Save & Test" }));
  await waitFor(() => expect(azureMai.sttTest).toHaveBeenCalled());

  // Switching provider mid-test changes the config context: the late result is stale.
  await user.click(screen.getByRole("button", { name: /Deepgram/ }));
  finish(true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(useConfigStore.getState().verifiedCloudProviders).not.toContain("whisper_api");
});
