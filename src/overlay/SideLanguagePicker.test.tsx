import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeetingAudioConfig } from "../lib/types";

const listeners = vi.hoisted(() => ({ map: new Map<string, Set<(e: { payload: unknown }) => void>>() }));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
    if (!listeners.map.has(name)) listeners.map.set(name, new Set());
    listeners.map.get(name)!.add(cb);
    return () => listeners.map.get(name)!.delete(cb);
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));

import { SideLanguagePicker } from "./SideLanguagePicker";
import { RESTART_STATE_MS } from "../hooks/useSideLanguages";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";

const emit = (name: string, payload: unknown) =>
  act(() => listeners.map.get(name)?.forEach((cb) => (cb as (e: { payload: unknown }) => void)({ payload })));

const baseConfig: MeetingAudioConfig = {
  you: { role: "You", device_id: "mic", is_input_device: true, stt_provider: "deepgram" },
  them: { role: "Them", device_id: "out", is_input_device: false, stt_provider: "deepgram" },
  recording_enabled: false,
  preset_name: null,
};

const chip = (name: RegExp) => screen.getByRole("button", { name });
const configNow = () => useConfigStore.getState().meetingAudioConfig!;

describe("SideLanguagePicker", () => {
  beforeEach(() => {
    listeners.map.clear();
    useConfigStore.setState({
      meetingAudioConfig: baseConfig,
      sttLanguage: "en-US",
      deepgramConfig: { ...useConfigStore.getState().deepgramConfig, model: "nova-3" },
    });
    useMeetingStore.setState({ isRecording: true, audioMode: "online" });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows the side's current language, the shared one when it has none of its own", () => {
    useConfigStore.setState({
      meetingAudioConfig: { ...baseConfig, them: { ...baseConfig.them, language: "fr-FR" } },
    });
    render(
      <>
        <SideLanguagePicker side="you" />
        <SideLanguagePicker side="them" />
      </>,
    );
    expect(chip(/You language: English \(US\)/)).toHaveTextContent("EN-US");
    expect(chip(/Them language: French/)).toHaveTextContent("FR-FR");
  });

  it("shows Auto for Auto-detect", () => {
    useConfigStore.setState({ sttLanguage: "auto" });
    render(<SideLanguagePicker side="you" />);
    expect(chip(/You language: Auto-detect/)).toHaveTextContent("Auto");
  });

  it("lists Default, Auto-detect and the languages, with the current one checked", () => {
    render(<SideLanguagePicker side="them" />);
    fireEvent.click(chip(/Them language/));
    expect(screen.getByRole("dialog", { name: "Them language" })).toBeInTheDocument();
    const radios = screen.getAllByRole("radio");
    expect(radios[0]).toHaveAccessibleName("Default: English (US)");
    expect(radios[1]).toHaveAccessibleName("Auto-detect");
    expect(radios[0]).toHaveAttribute("aria-checked", "true");
    expect(document.activeElement).toBe(radios[0]);
  });

  it("saves the pick into meetingAudioConfig like Settings does, and leaves the other side alone", () => {
    render(<SideLanguagePicker side="them" />);
    fireEvent.click(chip(/Them language/));
    fireEvent.click(screen.getByRole("radio", { name: "German" }));
    expect(configNow().them.language).toBe("de-DE");
    expect(configNow().you).toEqual(baseConfig.you);
    expect(useConfigStore.getState().sttLanguage).toBe("en-US");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(chip(/Them language/));
  });

  it("stores Default as no language at all", () => {
    useConfigStore.setState({
      meetingAudioConfig: { ...baseConfig, you: { ...baseConfig.you, language: "fr-FR" } },
    });
    render(<SideLanguagePicker side="you" />);
    fireEvent.click(chip(/You language/));
    fireEvent.click(screen.getByRole("radio", { name: /Default/ }));
    expect("language" in configNow().you).toBe(false);
  });

  it("works from the keyboard: arrows move, Enter picks, Escape closes", () => {
    render(<SideLanguagePicker side="you" />);
    const trigger = chip(/You language/);
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const radios = screen.getAllByRole("radio");
    expect(document.activeElement).toBe(radios[0]);
    fireEvent.keyDown(radios[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(radios[1]);
    fireEvent.keyDown(radios[1], { key: "Enter" });
    expect(configNow().you.language).toBe("auto");

    fireEvent.click(chip(/You language/));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(chip(/You language/));
  });

  it("warns inline when the side's provider can't transcribe its language", () => {
    useConfigStore.setState({
      deepgramConfig: { ...useConfigStore.getState().deepgramConfig, model: "flux-general-en" },
      meetingAudioConfig: { ...baseConfig, them: { ...baseConfig.them, language: "fr-FR" } },
    });
    render(<SideLanguagePicker side="them" />);
    expect(chip(/Them language: French. Flux transcribes English only/)).toBeInTheDocument();
    fireEvent.click(chip(/Them language/));
    expect(screen.getByRole("alert")).toHaveTextContent("Flux transcribes English only");
  });

  it("warns when Auto-detect can't work with the side's provider", () => {
    useConfigStore.setState({
      meetingAudioConfig: { ...baseConfig, you: { ...baseConfig.you, stt_provider: "web_speech", language: "auto" } },
    });
    render(<SideLanguagePicker side="you" />);
    fireEvent.click(chip(/You language/));
    expect(screen.getByRole("alert")).toHaveTextContent("Auto-detect doesn't work with Web Speech, used for You.");
  });

  it("shows no warning when the provider handles the language", () => {
    render(<SideLanguagePicker side="you" />);
    fireEvent.click(chip(/You language/));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says Restarting while a changed side reconnects, until its provider is connected", () => {
    render(<SideLanguagePicker side="them" />);
    fireEvent.click(chip(/Them language/));
    fireEvent.click(screen.getByRole("radio", { name: "Spanish" }));
    expect(chip(/Them language.*Restarting/)).toHaveTextContent("Restarting…");

    emit("stt_connection_status", { provider: "deepgram", party: "You", status: "connected" });
    expect(chip(/Them language.*Restarting/)).toBeInTheDocument();
    emit("stt_connection_status", { provider: "deepgram", party: "Them", status: "connected" });
    expect(chip(/Them language: Spanish$/)).toHaveTextContent("ES-ES");
  });

  it("stops saying Restarting when nothing reports back", () => {
    vi.useFakeTimers();
    render(<SideLanguagePicker side="them" />);
    fireEvent.click(chip(/Them language/));
    fireEvent.click(screen.getByRole("radio", { name: "Spanish" }));
    expect(chip(/Restarting/)).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(RESTART_STATE_MS + 10));
    expect(screen.queryByRole("button", { name: /Restarting/ })).toBeNull();
  });

  it("does not say Restarting outside a meeting", () => {
    useMeetingStore.setState({ isRecording: false });
    render(<SideLanguagePicker side="them" />);
    fireEvent.click(chip(/Them language/));
    fireEvent.click(screen.getByRole("radio", { name: "Spanish" }));
    expect(configNow().them.language).toBe("es-ES");
    expect(screen.queryByRole("button", { name: /Restarting/ })).toBeNull();
  });

  it("picking what is already chosen changes nothing", () => {
    const spy = vi.spyOn(useConfigStore.getState(), "setMeetingAudioConfig");
    render(<SideLanguagePicker side="you" />);
    fireEvent.click(chip(/You language/));
    fireEvent.click(screen.getAllByRole("radio")[0]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  describe("in-person (Room) meetings", () => {
    beforeEach(() => useMeetingStore.setState({ audioMode: "in_person" }));

    it("has no picker for You", () => {
      const { container } = render(<SideLanguagePicker side="you" />);
      expect(container).toBeEmptyDOMElement();
    });

    it("names the room side Room and sets the same Them setting", () => {
      render(<SideLanguagePicker side="them" />);
      fireEvent.click(chip(/Room language/));
      expect(screen.getByRole("dialog", { name: "Room language" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("radio", { name: "Italian" }));
      expect(configNow().them.language).toBe("it-IT");
    });

    it("a Room connection status clears Restarting", () => {
      render(<SideLanguagePicker side="them" />);
      fireEvent.click(chip(/Room language/));
      fireEvent.click(screen.getByRole("radio", { name: "Italian" }));
      expect(chip(/Room language.*Restarting/)).toHaveTextContent("Restarting…");
      emit("stt_connection_status", { provider: "deepgram", party: "Room", status: "connected" });
      expect(chip(/Room language: Italian$/)).toHaveTextContent("IT-IT");
    });

    it("words a Room warning with Room", () => {
      useConfigStore.setState({
        meetingAudioConfig: { ...baseConfig, them: { ...baseConfig.them, stt_provider: "web_speech", language: "auto" } },
      });
      render(<SideLanguagePicker side="them" />);
      fireEvent.click(chip(/Room language/));
      expect(screen.getByRole("alert")).toHaveTextContent("used for Room.");
    });
  });

  it("Space and Enter on the chip open the picker and never reach window shortcuts", () => {
    const onWindowKey = vi.fn();
    window.addEventListener("keydown", onWindowKey);
    try {
      render(<SideLanguagePicker side="them" />);
      for (const key of [" ", "Enter"]) {
        fireEvent.click(screen.getByRole("button", { name: /Them language/ }));
        if (screen.queryByRole("dialog")) fireEvent.keyDown(document.activeElement!, { key: "Escape" });
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        const c = chip(/Them language/);
        c.focus();
        const notPrevented = fireEvent.keyDown(c, { key });
        expect(notPrevented).toBe(false);
        expect(screen.getByRole("dialog", { name: "Them language" })).toBeInTheDocument();
        fireEvent.keyDown(document.activeElement!, { key: "Escape" });
      }
      // Keys inside the list are contained too.
      fireEvent.click(chip(/Them language/));
      fireEvent.keyDown(document.activeElement!, { key: " " });
      expect(onWindowKey).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", onWindowKey);
    }
  });

  it("renders nothing before the config has loaded", () => {
    useConfigStore.setState({ meetingAudioConfig: null });
    const { container } = render(<SideLanguagePicker side="them" />);
    expect(container).toBeEmptyDOMElement();
  });
});
