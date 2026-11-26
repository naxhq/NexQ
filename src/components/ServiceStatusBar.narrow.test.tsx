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

/**
 * jsdom has no layout, so a row "overflows" here while any name is still shown: that drives the
 * bar through its steps (model, YOU/THEM, STT names) the way a too-narrow window does.
 */
function narrowBar(px: number) {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => px });
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get(this: HTMLElement) {
      if (!String(this.className).includes("flex-nowrap")) return px;
      const shown = [...this.querySelectorAll("span")].some(
        (e) => e.children.length === 0 && /Deepgram|Azure MAI|MAI-Transcribe|^You$|^Them$/.test(e.textContent ?? "") && !e.closest(".hidden"),
      );
      return shown ? px + 200 : px;
    },
  });
}

describe("the meeting footer in a narrow window", () => {
  beforeEach(() => {
    useConfigStore.setState({ meetingAudioConfig: config, sttLanguage: "en-US" });
    useMeetingStore.setState({ isRecording: true, audioMode: "online" });
  });
  afterEach(() => {
    cleanup();
    // @ts-expect-error restore jsdom's own getters
    delete HTMLElement.prototype.clientWidth;
    // @ts-expect-error restore jsdom's own getters
    delete HTMLElement.prototype.scrollWidth;
  });

  it("at 420 px keeps names in the tooltip and has no native title (Windows would draw it in a screen share)", () => {
    narrowBar(420);
    const { container } = render(<ServiceStatusBar compact />);
    expect(container.querySelectorAll("[title]")).toHaveLength(0);
    // icon and dot only: the provider name is not in the layout, the button still has its full name
    expect(screen.getByText("Deepgram").closest(".hidden")).not.toBeNull();
    expect(screen.queryByText(/^You$/)).toBeNull();
    expect(screen.getByRole("button", { name: /^Your STT: Azure MAI Streaming/ })).toBeInTheDocument();
  });

  it("whatever the names, the row gives up model names first and nothing carries a native title", () => {
    narrowBar(500);
    const { container } = render(<ServiceStatusBar compact />);
    expect(container.querySelectorAll("[title]")).toHaveLength(0);
    expect(screen.queryByText("MAI-Transcribe-2-Streaming")).toBeNull();
    expect(screen.getByRole("button", { name: /MAI-Transcribe-2-Streaming/ })).toBeInTheDocument();
  });
});
