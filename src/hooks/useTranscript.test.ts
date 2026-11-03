import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/events", () => ({
  onTranscriptUpdate: () => Promise.resolve(() => {}),
  onTranscriptFinal: () => Promise.resolve(() => {}),
}));

import { processSpeaker, useTranscript } from "./useTranscript";
import { useSpeakerStore } from "../stores/speakerStore";
import { INTERIM_LIFETIME_MS, useTranscriptStore } from "../stores/transcriptStore";
import type { TranscriptSegment } from "../lib/types";

function them(id: string, text: string, extra: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return { id, text, speaker: "Them", timestamp_ms: 1, is_final: true, confidence: 1, ...extra };
}

describe("useTranscript", () => {
  it("clears an interim no final followed, without any new transcript event", () => {
    vi.useFakeTimers();
    useTranscriptStore.getState().clearSegments();
    const { unmount } = renderHook(() => useTranscript());
    useTranscriptStore.getState().updateInterimSegment(them("you_1_acc_1", "Good", { is_final: false }));
    vi.advanceTimersByTime(INTERIM_LIFETIME_MS + 2_000);
    expect(useTranscriptStore.getState().segments).toEqual([]);
    unmount();
    vi.useRealTimers();
  });
});

describe("processSpeaker", () => {
  beforeEach(() => useSpeakerStore.getState().initForOnline());

  it("online: a tagged remote line stays 'them' and tracks its person", () => {
    const out = processSpeaker(them("a", "Hello there", { speaker_tag: "S2", speaker_id: "speaker_1" }), false);
    expect(out).toMatchObject({ speaker: "Them", speaker_id: "them", speaker_tag: "S2" });
    const store = useSpeakerStore.getState();
    expect(store.speakers["them:S2"]).toMatchObject({ display_name: "Speaker 2", source: "remote_tag" });
    // Not a stats/filter speaker, and no naming prompt.
    expect(store.getAllSpeakers().map((s) => s.id)).toEqual(["you", "them"]);
    expect(store.pendingNaming).toBeNull();
    expect(store.getRemoteSpeakers().map((s) => s.id)).toEqual(["them:S2"]);
  });

  it("renaming a remote person keeps the name for later lines", () => {
    processSpeaker(them("a", "Hi", { speaker_tag: "S1" }), false);
    useSpeakerStore.getState().renameSpeaker("them:S1", "Erin");
    processSpeaker(them("b", "Again", { speaker_tag: "S1" }), false);
    expect(useSpeakerStore.getState().speakers["them:S1"].display_name).toBe("Erin");
  });

  it("counts the words of a growing line once", () => {
    processSpeaker(them("p", "one two"), false);
    processSpeaker(them("p", "one two three four"), false);
    processSpeaker(them("p", "one two three four"), false);
    expect(useSpeakerStore.getState().speakers.them.stats).toMatchObject({ segment_count: 1, word_count: 4 });
  });

  it("in person: keeps the diarized speaker id", () => {
    useSpeakerStore.getState().initForInPerson(true);
    const out = processSpeaker(them("a", "Hi", { speaker_tag: "S1", speaker_id: "speaker_0" }), true);
    expect(out?.speaker_id).toBe("speaker_0");
    expect(useSpeakerStore.getState().getAllSpeakers().map((s) => s.id)).toEqual(["speaker_0"]);
  });
});
