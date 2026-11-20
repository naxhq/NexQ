import { invoke } from "@tauri-apps/api/core";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeetingAudioConfig } from "../lib/types";
import type * as IPC from "../lib/ipc";

vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));
vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof IPC>()),
  listAudioDevices: async () => ({
    inputs: [{ id: 'Studio: USB "Audio"', name: 'Studio: USB "Audio"', is_input: true, is_default: false }],
    outputs: [{ id: 'Studio: USB "Audio"', name: 'Studio: USB "Audio"', is_input: false, is_default: false }],
  }),
  getAudioSessions: async () => [],
  hasApiKey: async () => false,
  listLocalSTTEngines: async () => [],
  startDeviceMonitor: async () => {},
  stopDeviceMonitor: async () => {},
  stopAudioTest: async () => false,
}));

import { MeetingAudioSettings } from "./MeetingAudioSettings";
import { AudioSetupStep } from "../components/wizard/AudioSetupStep";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";
import { STT_LANGUAGES } from "../lib/sttLanguages";

const initialConfig: MeetingAudioConfig = {
  you: { role: "You", device_id: 'Studio: USB "Audio"', is_input_device: true, stt_provider: "deepgram" },
  them: { role: "Them", device_id: 'Studio: USB "Audio"', is_input_device: true, stt_provider: "deepgram" },
  recording_enabled: false,
  preset_name: null,
};

const initialDeepgramConfig = useConfigStore.getState().deepgramConfig;
beforeEach(() => useConfigStore.setState({ meetingAudioConfig: initialConfig }));
afterEach(() => {
  cleanup();
  // A test's Deepgram model (Flux, say) must not reach the next test.
  useConfigStore.setState({ deepgramConfig: initialDeepgramConfig });
});

it.each([
  ["Vietnamese", "vi-VN"],
  ["Ukrainian", "uk-UA"],
])("allows %s to be selected in Audio & Devices", async (label, locale) => {
  useConfigStore.setState({ sttLanguage: "en-US" });
  render(<MeetingAudioSettings />);
  const select = screen.getByRole("combobox", { name: /Transcription language/i });
  await userEvent.setup().selectOptions(select, locale);
  expect(useConfigStore.getState().sttLanguage).toBe(locale);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("set_stt_language", { language: locale }));
  expect(within(select).getByRole<HTMLOptionElement>("option", { name: label }).selected).toBe(true);
});

it("selects Auto-detect and identifies the channel that needs a different STT engine", async () => {
  useConfigStore.setState({
    sttLanguage: "en-US",
    meetingAudioConfig: {
      ...initialConfig,
      you: { ...initialConfig.you, stt_provider: "web_speech" },
      them: { ...initialConfig.them, stt_provider: "groq_whisper" },
    },
  });
  const user = userEvent.setup();
  render(<MeetingAudioSettings />);
  const select = screen.getByRole("combobox", { name: /Transcription language/i });

  await user.selectOptions(select, within(select).getByRole("option", { name: "Auto-detect" }));
  expect(useConfigStore.getState().sttLanguage).toBe("auto");
  expect(select).toHaveAccessibleDescription(
    "Auto-detect won't work for You. See its card below, or pick a language."
  );
  // Only the affected side's card carries the explanation.
  const alerts = screen.getAllByRole("alert");
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toHaveTextContent(
    "Auto-detect doesn't work with Web Speech, used for You. " +
    "Choose Deepgram Nova-3, Parakeet TDT 0.6B v3, Groq Whisper or Whisper API for that side, or pick a language."
  );

  await user.selectOptions(select, "en-US");
  expect(useConfigStore.getState().sttLanguage).toBe("en-US");
  expect(select).not.toHaveAccessibleDescription();
  expect(screen.queryByRole("alert")).toBeNull();
});

describe.each([
  { surface: "settings", Component: MeetingAudioSettings },
  { surface: "wizard", Component: AudioSetupStep },
])("$surface audio source selection", ({ Component }) => {
  it.each(["you", "them"] as const)("keeps the %s input and output distinct when their names match", async (party) => {
    const user = userEvent.setup();
    const view = render(<Component />);
    const group = await screen.findAllByRole("group", { name: "Speakers / Output" });
    const output = within(group[party === "you" ? 0 : 1]).getByRole<HTMLOptionElement>("option");
    const select = output.closest("select")!;
    await waitFor(() => expect(select).toBeEnabled());

    await user.selectOptions(select, output);
    expect(useConfigStore.getState().meetingAudioConfig?.[party]).toMatchObject({
      device_id: 'Studio: USB "Audio"',
      is_input_device: false,
    });
    expect(output.selected).toBe(true);

    view.unmount();
    render(<Component />);
    const restoredGroups = await screen.findAllByRole("group", { name: "Speakers / Output" });
    const restoredOutput = within(restoredGroups[party === "you" ? 0 : 1]).getByRole<HTMLOptionElement>("option");
    expect(restoredOutput.selected).toBe(true);
    const restoredSelect = restoredOutput.closest("select")!;
    const micGroup = within(restoredSelect).getByRole("group", { name: "Microphones" });
    const input = within(micGroup).getByRole<HTMLOptionElement>("option");
    await waitFor(() => expect(restoredSelect).toBeEnabled());
    await user.selectOptions(restoredSelect, input);
    expect(useConfigStore.getState().meetingAudioConfig?.[party]).toMatchObject({
      device_id: 'Studio: USB "Audio"',
      is_input_device: true,
    });
    expect(input.selected).toBe(true);
  });

  it.each([
    { party: "you" as const, isInput: true },
    { party: "them" as const, isInput: false },
  ])("uses the correct direction for the $party default", async ({ party, isInput }) => {
    const user = userEvent.setup();
    render(<Component />);
    const groups = await screen.findAllByRole("group", { name: "Microphones" });
    const select = groups[party === "you" ? 0 : 1].closest("select")!;
    await waitFor(() => expect(select).toBeEnabled());
    await user.selectOptions(select, select.options[0]);
    expect(useConfigStore.getState().meetingAudioConfig?.[party]).toMatchObject({
      device_id: "default",
      is_input_device: isInput,
    });
    expect(select.options[0].selected).toBe(true);
  });
});

describe("a language for each side", () => {
  const SAME = /^Default: /;
  const side = (name: "You" | "Them" | "Room") =>
    screen.getByRole<HTMLSelectElement>("combobox", { name: `${name} language` });

  afterEach(() => useMeetingStore.setState({ audioMode: "online" }));

  it("shows a picker on each card that starts on the shared language, for a config saved by an older version", () => {
    // initialConfig has no `language`, like every config saved before this setting.
    useConfigStore.setState({ sttLanguage: "en-US" });
    render(<MeetingAudioSettings />);
    for (const name of ["You", "Them"] as const) {
      expect(side(name).selectedOptions[0]).toHaveTextContent("Default: English (US)");
      expect(side(name).value).toBe("");
      // The shared list, Auto-detect included.
      const labels = within(side(name)).getAllByRole("option").map((o) => o.textContent);
      expect(labels).toEqual(["Default: English (US)", ...STT_LANGUAGES.map((l) => l.label)]);
    }
    // Showing the pickers saved nothing.
    expect(useConfigStore.getState().meetingAudioConfig).toEqual(initialConfig);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("names the shared language in the default option", async () => {
    useConfigStore.setState({ sttLanguage: "es-ES" });
    render(<MeetingAudioSettings />);
    expect(side("You").selectedOptions[0]).toHaveTextContent("Default: Spanish");
    await act(async () => useConfigStore.setState({ sttLanguage: "auto" }));
    expect(side("Them").selectedOptions[0]).toHaveTextContent("Default: Auto-detect");
  });

  it("saves a side's language into meetingAudioConfig and leaves the shared language and the other side alone", async () => {
    useConfigStore.setState({ sttLanguage: "en-US" });
    const user = userEvent.setup();
    render(<MeetingAudioSettings />);

    await user.selectOptions(side("Them"), "es-ES");
    const saved = useConfigStore.getState().meetingAudioConfig!;
    expect(saved.them.language).toBe("es-ES");
    expect("language" in saved.you).toBe(false);
    expect(useConfigStore.getState().sttLanguage).toBe("en-US");
    expect(side("Them").selectedOptions[0]).toHaveTextContent("Spanish");

    await user.selectOptions(side("You"), "auto");
    expect(useConfigStore.getState().meetingAudioConfig!.you.language).toBe("auto");

    // Back to "Default" drops the field, so the config has its old shape again.
    await user.selectOptions(side("Them"), within(side("Them")).getByRole("option", { name: SAME }));
    await user.selectOptions(side("You"), within(side("You")).getByRole("option", { name: SAME }));
    expect(useConfigStore.getState().meetingAudioConfig).toEqual(initialConfig);
    expect("language" in useConfigStore.getState().meetingAudioConfig!.them).toBe(false);
  });

  it("names the room side Room in in-person meetings and has no picker for You", () => {
    useMeetingStore.setState({ audioMode: "in_person" });
    render(<MeetingAudioSettings />);
    expect(side("Room")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "You language" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Them language" })).toBeNull();
  });

  it("checks Auto-detect with each side's own language", async () => {
    // Shared Auto-detect, but You speaks English: only Them is judged.
    useConfigStore.setState({
      sttLanguage: "auto",
      meetingAudioConfig: {
        ...initialConfig,
        you: { ...initialConfig.you, stt_provider: "web_speech", language: "en-US" },
        them: { ...initialConfig.them, stt_provider: "azure_speech" },
      },
    });
    const user = userEvent.setup();
    render(<MeetingAudioSettings />);
    let alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent("Auto-detect doesn't work with Azure Speech, used for Them.");
    expect(screen.getByRole("combobox", { name: /Transcription language/i })).toHaveAccessibleDescription(
      "Auto-detect won't work for Them. See its card below, or pick a language.",
    );

    // Them picks a language: nothing left to refuse.
    await user.selectOptions(side("Them"), "es-ES");
    expect(screen.queryByRole("alert")).toBeNull();

    // A fixed shared language, but You picks Auto-detect on a provider that can't.
    await act(async () => useConfigStore.setState({ sttLanguage: "en-US" }));
    await user.selectOptions(side("You"), "auto");
    alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent("Auto-detect doesn't work with Web Speech, used for You.");
  });

  it("uses the side's language for the provider hints", async () => {
    useConfigStore.setState({
      sttLanguage: "en-US",
      deepgramConfig: { ...useConfigStore.getState().deepgramConfig, model: "flux-general-multi" },
      meetingAudioConfig: {
        ...initialConfig,
        you: { ...initialConfig.you, stt_provider: "cartesia" },
        them: { ...initialConfig.them, stt_provider: "deepgram" },
      },
    });
    const user = userEvent.setup();
    render(<MeetingAudioSettings />);
    expect(screen.queryByRole("alert")).toBeNull();

    // Ukrainian is a problem for Flux on Them only.
    await user.selectOptions(side("Them"), "uk-UA");
    expect(screen.getByRole("alert")).toHaveTextContent("Switch from Flux to Nova-3 for Ukrainian transcription.");
    await user.selectOptions(side("You"), "ru-RU");
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    expect(
      screen.getByText(/Cartesia transcribes only English, French, Hindi, Japanese and Spanish/),
    ).toBeInTheDocument();

    // Sides with a language of their own ignore the shared one.
    await user.selectOptions(side("You"), "es-ES");
    await user.selectOptions(side("Them"), "en-US");
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => useConfigStore.setState({ sttLanguage: "uk-UA" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the chosen languages when a preset is applied", async () => {
    useConfigStore.setState({
      meetingAudioConfig: {
        ...initialConfig,
        you: { ...initialConfig.you, language: "en-US" },
        them: { ...initialConfig.them, language: "es-ES" },
      },
    });
    const user = userEvent.setup();
    render(<MeetingAudioSettings />);
    await user.click(screen.getByRole("button", { name: "All Cloud" }));
    const saved = useConfigStore.getState().meetingAudioConfig!;
    expect(saved.preset_name).toBe("All Cloud");
    expect([saved.you.language, saved.them.language]).toEqual(["en-US", "es-ES"]);
  });
});
