// The overlay window keeps its own stores between meetings; a new meeting must
// start from nothing there (it used to show every earlier meeting's transcript).

import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ get: async () => undefined, set: async () => {}, onKeyChange: async () => () => {} }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));

import { initMeetingSpeakers, resetMeetingScopedStores } from "./resetMeeting";
import { useTranscriptStore } from "./transcriptStore";
import { useSpeakerStore } from "./speakerStore";
import { useStreamStore } from "./streamStore";
import { useConfigStore } from "./configStore";

describe("resetMeetingScopedStores", () => {
  it("clears the previous meeting's transcript, speakers and answers", async () => {
    useTranscriptStore.getState().appendSegment({
      id: "them_1_acc_1",
      text: "Last meeting's line",
      speaker: "Them",
      speaker_id: "them",
      timestamp_ms: 1_000,
      is_final: true,
      confidence: 0.9,
    });
    useSpeakerStore.getState().addSpeaker("speaker_16");
    useStreamStore.setState({ currentContent: "old answer" });

    await resetMeetingScopedStores();
    initMeetingSpeakers("online");

    expect(useTranscriptStore.getState().segments).toEqual([]);
    expect(useStreamStore.getState().currentContent).toBe("");
    expect(useStreamStore.getState().responseHistory).toEqual([]);
    expect(useSpeakerStore.getState().speakerOrder).toEqual(["you", "them"]);
  });
});

describe("initMeetingSpeakers in person", () => {
  const room = (stt_provider: string, model: string) => {
    const config = useConfigStore.getState();
    useConfigStore.setState({
      diarizationEnabled: true,
      sttProvider: stt_provider as never,
      meetingAudioConfig: undefined as never,
      deepgramConfig: { ...config.deepgramConfig, model },
    });
  };

  it("tells speakers apart with Deepgram Nova", () => {
    room("deepgram", "nova-3");
    expect(initMeetingSpeakers("in_person")).toBe(true);
  });

  it("uses a single Room with Deepgram Flux, which can't tell speakers apart", () => {
    room("deepgram", "flux-general-en");
    expect(initMeetingSpeakers("in_person")).toBe(false);
  });
});
