import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INTERIM_LIFETIME_MS, useTranscriptStore } from "./transcriptStore";
import { resetSavedSegments, segmentsToSave } from "../lib/transcriptPersistence";
import type { TranscriptSegment } from "../lib/types";

function seg(text: string, is_final: boolean, id = "them_1_acc_1"): TranscriptSegment {
  return { id, text, speaker: "Them", speaker_id: "them", timestamp_ms: 1_000, is_final, confidence: 0.9 };
}

describe("transcriptStore upsert", () => {
  beforeEach(() => useTranscriptStore.getState().clearSegments());

  it("replaces a line in place when its final grows (same id)", () => {
    const { updateInterimSegment } = useTranscriptStore.getState();
    updateInterimSegment(seg("We ship", true));
    updateInterimSegment(seg("other", true, "you_1_acc_1"));
    updateInterimSegment(seg("We ship on Friday", true));
    const { segments } = useTranscriptStore.getState();
    expect(segments.map((s) => s.text)).toEqual(["We ship on Friday", "other"]);
  });

  it("keeps a final line final while interim words extend it", () => {
    const { updateInterimSegment } = useTranscriptStore.getState();
    updateInterimSegment(seg("We ship", true));
    updateInterimSegment(seg("We ship on fri", false));
    let line = useTranscriptStore.getState().segments[0];
    expect(line).toMatchObject({ text: "We ship", is_final: true, pending_text: "We ship on fri" });

    updateInterimSegment(seg("We ship on Friday.", true));
    line = useTranscriptStore.getState().segments[0];
    expect(line).toMatchObject({ text: "We ship on Friday.", is_final: true });
    expect(line.pending_text).toBeUndefined();
  });

  it("an interim for a new line is added as interim", () => {
    useTranscriptStore.getState().updateInterimSegment(seg("hel", false));
    expect(useTranscriptStore.getState().segments[0]).toMatchObject({ text: "hel", is_final: false });
  });

  it("finalizing interims commits pending words", () => {
    const { updateInterimSegment, finalizeAllInterim } = useTranscriptStore.getState();
    updateInterimSegment(seg("We ship", true));
    updateInterimSegment(seg("We ship today", false));
    updateInterimSegment(seg("Sure", false, "you_1_acc_1"));
    finalizeAllInterim();
    const { segments } = useTranscriptStore.getState();
    expect(segments.map((s) => [s.text, s.is_final, s.pending_text])).toEqual([
      ["We ship today", true, undefined],
      ["Sure", true, undefined],
    ]);
  });
});

describe("interim lifetime", () => {
  const you = (text: string, is_final = false) => seg(text, is_final, "you_1_acc_1");
  const texts = () => useTranscriptStore.getState().segments.map((s) => s.text);

  beforeEach(() => {
    vi.useFakeTimers();
    useTranscriptStore.getState().clearSegments();
  });
  afterEach(() => vi.useRealTimers());

  it("drops an interim line no final followed", () => {
    const { updateInterimSegment, dropStaleInterim } = useTranscriptStore.getState();
    updateInterimSegment(you("Good"));
    vi.advanceTimersByTime(INTERIM_LIFETIME_MS - 1);
    dropStaleInterim();
    expect(texts()).toEqual(["Good"]);

    vi.advanceTimersByTime(1);
    dropStaleInterim();
    expect(texts()).toEqual([]);
  });

  it("keeps an interim that is still being updated", () => {
    const { updateInterimSegment, dropStaleInterim } = useTranscriptStore.getState();
    updateInterimSegment(you("Good"));
    vi.advanceTimersByTime(INTERIM_LIFETIME_MS - 1);
    updateInterimSegment(you("Good morning"));
    vi.advanceTimersByTime(INTERIM_LIFETIME_MS - 1);
    dropStaleInterim();
    expect(texts()).toEqual(["Good morning"]);
  });

  it("drops stale pending words but keeps their final line", () => {
    const { updateInterimSegment, dropStaleInterim } = useTranscriptStore.getState();
    updateInterimSegment(seg("We ship", true));
    updateInterimSegment(seg("We ship on fri", false));
    vi.advanceTimersByTime(INTERIM_LIFETIME_MS);
    dropStaleInterim();
    const [line] = useTranscriptStore.getState().segments;
    expect(line).toMatchObject({ text: "We ship", is_final: true });
    expect(line.pending_text).toBeUndefined();
  });

  it("never touches a final line, and adds a final that arrives late", () => {
    const { updateInterimSegment, dropStaleInterim } = useTranscriptStore.getState();
    updateInterimSegment(seg("We ship", true));
    updateInterimSegment(you("Good"));
    vi.advanceTimersByTime(INTERIM_LIFETIME_MS);
    dropStaleInterim();
    expect(texts()).toEqual(["We ship"]);

    updateInterimSegment(you("Good morning", true));
    vi.advanceTimersByTime(INTERIM_LIFETIME_MS * 2);
    dropStaleInterim();
    expect(texts()).toEqual(["We ship", "Good morning"]);
  });

  it("stops holding back the lines after it from being saved", () => {
    resetSavedSegments();
    const { updateInterimSegment, dropStaleInterim } = useTranscriptStore.getState();
    updateInterimSegment(you("Good"));
    updateInterimSegment(seg("Thanks for joining", true));
    expect(segmentsToSave(useTranscriptStore.getState().segments, 0).toSave).toEqual([]);

    vi.advanceTimersByTime(INTERIM_LIFETIME_MS);
    dropStaleInterim();
    const { toSave } = segmentsToSave(useTranscriptStore.getState().segments, 0);
    expect(toSave.map((s) => s.text)).toEqual(["Thanks for joining"]);
  });

  it("does nothing when no interim is stale", () => {
    const { updateInterimSegment, dropStaleInterim } = useTranscriptStore.getState();
    updateInterimSegment(you("Good"));
    const before = useTranscriptStore.getState().segments;
    dropStaleInterim();
    expect(useTranscriptStore.getState().segments).toBe(before);
  });
});
