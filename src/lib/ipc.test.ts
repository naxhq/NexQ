import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { generateAssist, startCapturePerParty } from "./ipc";
import type { PartyAudioConfig } from "./types";
import { useTranscriptStore } from "../stores/transcriptStore";

describe("generateAssist", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
  });

  it("sends a fresh request id and the live transcript by default", async () => {
    useTranscriptStore.setState({
      segments: [
        { id: "a", text: "hello", speaker: "Them", timestamp_ms: 1, is_final: true },
        { id: "b", text: "partial", speaker: "Them", timestamp_ms: 2, is_final: false },
      ],
    } as never);

    await generateAssist("Assist");
    await generateAssist("Assist");

    const first = invoke.mock.calls[0][1];
    const second = invoke.mock.calls[1][1];
    expect(invoke.mock.calls[0][0]).toBe("generate_assist");
    expect(typeof first.requestId).toBe("string");
    expect(first.requestId).not.toBe(second.requestId);
    expect(JSON.parse(first.transcriptSegments)).toEqual([
      { id: "a", text: "hello", speaker: "Them", timestamp_ms: 1 },
      { id: "b", text: "partial", speaker: "Them (interim)", timestamp_ms: 2 },
    ]);
  });

  it("sends the latest interim extension without changing stored finals", async () => {
    const segment = { id: "a", text: "hello", pending_text: "hello world", speaker: "User", timestamp_ms: 1, is_final: true };
    useTranscriptStore.setState({ segments: [segment] } as never);
    await generateAssist("Assist");
    expect(JSON.parse(invoke.mock.calls[0][1].transcriptSegments)).toEqual([
      { id: "a", text: "hello world", speaker: "You (interim)", timestamp_ms: 1 },
    ]);
    expect(useTranscriptStore.getState().segments[0]).toEqual(segment);
  });

  it("labels diarized remote lines with their person's name for the AI", async () => {
    const { useSpeakerStore } = await import("../stores/speakerStore");
    useSpeakerStore.getState().initForOnline();
    useSpeakerStore.getState().ensureRemoteSpeaker("S1");
    useSpeakerStore.getState().ensureRemoteSpeaker("S2");
    useSpeakerStore.getState().renameSpeaker("them:S1", "Erin");
    useTranscriptStore.setState({
      segments: [
        { id: "a", text: "We ship", speaker: "Them", speaker_id: "them", speaker_tag: "S1", timestamp_ms: 1, is_final: true },
        { id: "b", text: "Agreed", speaker: "Them", speaker_id: "them", speaker_tag: "S2", timestamp_ms: 2, is_final: true },
        { id: "c", text: "Great", speaker: "User", speaker_id: "you", timestamp_ms: 3, is_final: true },
        { id: "d", text: "Plain", speaker: "Them", speaker_id: "them", timestamp_ms: 4, is_final: true },
      ],
    } as never);

    await generateAssist("Assist");

    const sent = JSON.parse(invoke.mock.calls[0][1].transcriptSegments);
    expect(sent.map((s: { speaker: string }) => s.speaker)).toEqual(["Erin", "Speaker 2", "User", "Them"]);
  });

  it("uses the caller's request id and transcript segments", async () => {
    const segments = [{ id: "s1", text: "past", speaker: "You", timestamp_ms: 5 }];

    await generateAssist("BookmarkSuggestions", "Find moments", {
      requestId: "req-42",
      transcriptSegments: segments,
    });

    expect(invoke).toHaveBeenCalledWith("generate_assist", {
      mode: "BookmarkSuggestions",
      customQuestion: "Find moments",
      transcriptSegments: JSON.stringify(segments),
      requestId: "req-42",
    });
  });

  it("sends a picked scope, and nothing for the default", async () => {
    const scope = { kind: "minutes" as const, since_ms: 100, minutes: 5, label: "Last 5 min" };
    await generateAssist("Recap", undefined, { requestId: "r", scope });
    expect(invoke.mock.calls[0][1].scope).toEqual(scope);

    await generateAssist("Recap", undefined, { scope: { kind: "default", since_ms: null, label: "" } });
    await generateAssist("Recap", undefined, { scope: null });
    expect("scope" in invoke.mock.calls[1][1]).toBe(false);
    expect("scope" in invoke.mock.calls[2][1]).toBe(false);
  });
});

describe("startCapturePerParty", () => {
  const you: PartyAudioConfig = { role: "You", device_id: "Mic", is_input_device: true, stt_provider: "cartesia" };
  const them: PartyAudioConfig = { role: "Them", device_id: "Room mic", is_input_device: true, stt_provider: "cartesia" };

  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
  });

  it("asks the backend to skip the You transcriber when told to", async () => {
    await startCapturePerParty(you, them, { skipYouStt: true });
    expect(invoke).toHaveBeenCalledWith("start_capture_per_party", {
      youConfig: JSON.stringify(you),
      themConfig: JSON.stringify(them),
      skipYouStt: true,
    });
  });

  it("starts both transcribers by default", async () => {
    await startCapturePerParty(you, them);
    expect(invoke.mock.calls[0][1].skipYouStt).toBe(false);
  });
});
