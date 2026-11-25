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
  you: { role: "You", device_id: "mic", is_input_device: true, stt_provider: "azure_mai_streaming" },
  them: { role: "Them", device_id: "out", is_input_device: false, stt_provider: "deepgram" },
  recording_enabled: false,
  preset_name: null,
};

/** The bar's width is read from clientWidth, which jsdom leaves at 0. */
function barWidth(px: number) {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => px });
}

describe("the meeting footer in a narrow window", () => {
  beforeEach(() => {
    useConfigStore.setState({ meetingAudioConfig: config, sttLanguage: "en-US" });
    useMeetingStore.setState({ isRecording: true, audioMode: "online" });
  });
  afterEach(() => {
    cleanup();
    // @ts-expect-error restore jsdom's own getter
    delete HTMLElement.prototype.clientWidth;
  });

  it("at 420 px keeps names in the tooltip and has no native title (Windows would draw it in a screen share)", () => {
    barWidth(420);
    const { container } = render(<ServiceStatusBar compact />);
    expect(container.querySelectorAll("[title]")).toHaveLength(0);
    // icon and dot only: the provider name is not in the layout, the button still has its full name
    expect(screen.getByText("Deepgram").closest(".hidden")).not.toBeNull();
    expect(screen.getByRole("button", { name: /^Your STT: Azure MAI Streaming/ })).toBeInTheDocument();
  });

  it("at 500 px a long model name is not shown beside the chip and nothing carries a native title", () => {
    barWidth(500);
    const { container } = render(<ServiceStatusBar compact />);
    expect(container.querySelectorAll("[title]")).toHaveLength(0);
    expect(screen.queryByText("MAI-Transcribe-2-Streaming")).toBeNull();
    expect(screen.getByRole("button", { name: /MAI-Transcribe-2-Streaming/ })).toBeInTheDocument();
  });
});
