import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeetingAudioConfig } from "../lib/types";

vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));

import { ServiceStatusBar } from "./ServiceStatusBar";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";

const config: MeetingAudioConfig = {
  you: { role: "You", device_id: "mic", is_input_device: true, stt_provider: "deepgram" },
  them: { role: "Them", device_id: "out", is_input_device: false, stt_provider: "deepgram" },
  recording_enabled: false,
  preset_name: null,
};

describe("language picker in the status bar", () => {
  beforeEach(() => {
    useConfigStore.setState({ meetingAudioConfig: config, sttLanguage: "en-US" });
  });
  afterEach(cleanup);

  it("sits beside each side's mute button in the overlay footer during a meeting", () => {
    useMeetingStore.setState({ isRecording: true, audioMode: "online" });
    render(<ServiceStatusBar compact />);
    expect(screen.getByRole("button", { name: /^You language/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Them language/ })).toBeInTheDocument();
  });

  it("is a single Room picker in an in-person meeting", () => {
    useMeetingStore.setState({ isRecording: true, audioMode: "in_person" });
    render(<ServiceStatusBar compact />);
    expect(screen.getByRole("button", { name: /^Room language/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^You language/ })).toBeNull();
  });

  it("is absent outside a meeting and in the launcher footer", () => {
    useMeetingStore.setState({ isRecording: false, audioMode: "online" });
    const { rerender } = render(<ServiceStatusBar compact />);
    expect(screen.queryByRole("button", { name: /language/ })).toBeNull();
    useMeetingStore.setState({ isRecording: true });
    rerender(<ServiceStatusBar />);
    expect(screen.queryByRole("button", { name: /language/ })).toBeNull();
  });
});
