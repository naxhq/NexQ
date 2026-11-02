import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { Meeting } from "../lib/types";
import { useMeetingStore } from "../stores/meetingStore";
import { useMeetingStats } from "./useMeetingStats";

function meetingWithText(text: string): Meeting {
  return {
    id: "meeting-1",
    title: "Word count test",
    start_time: "2026-01-01T00:00:00Z",
    end_time: "2026-01-01T00:02:00Z",
    duration_seconds: 120,
    transcript: [{ id: "segment-1", text, speaker: "User", timestamp_ms: 0, is_final: true, confidence: 1 }],
    ai_interactions: [],
    summary: null,
    config_snapshot: null,
  };
}

describe("useMeetingStats", () => {
  beforeEach(() => {
    useMeetingStore.setState({ activeMeeting: null, elapsedMs: 0 });
  });

  it.each([
    ["今天讨论进度。", 6],
    ["專案進度會議", 6],
    ["日本語で話します。", 8],
    ["スーパー", 4],
    ["안녕하세요 세계", 2],
    ["안녕하세요 세계".normalize("NFD"), 2],
    ["회의 API 리뷰", 3],
    ["你好world，测试API 2026", 7],
    ["𠮷野家", 3],
    ["Hello, world! It's a follow-up.", 5],
    ["Café déjà vu", 3],
    ["Cafe\u0301 déjà vu", 3],
    ["  one\n two\tthree  ", 3],
    ["", 0],
    ["   ", 0],
    ["！？… — 🎉", 0],
  ] as const)("counts %j as %i words", (text, expected) => {
    const { result } = renderHook(() => useMeetingStats(meetingWithText(text)));
    expect(result.current.wordCount).toBe(expected);
  });

  it("uses the corrected counts for pace and speaker percentages", () => {
    const meeting = meetingWithText("今天讨论进度。");
    meeting.transcript.push({ id: "segment-2", text: "API review", speaker: "Them", timestamp_ms: 1000, is_final: true, confidence: 1 });
    const { result } = renderHook(() => useMeetingStats(meeting));
    expect(result.current.wordCount).toBe(8);
    expect(result.current.wordsPerMinute).toBe(4);
    expect(result.current.speakerBreakdown).toEqual([
      { speaker: "User", percentage: 75, color: "text-blue-400" },
      { speaker: "Them", percentage: 25, color: "text-emerald-400" },
    ]);
  });

  it("recalculates pace as an active meeting progresses", () => {
    const meeting = meetingWithText("今天讨论进度。");
    useMeetingStore.setState({ activeMeeting: meeting, elapsedMs: 60_000 });
    const { result } = renderHook(() => useMeetingStats(meeting));
    expect(result.current.wordsPerMinute).toBe(6);
    act(() => useMeetingStore.setState({ elapsedMs: 120_000 }));
    expect(result.current.wordCount).toBe(6);
    expect(result.current.wordsPerMinute).toBe(3);
  });

  it("keeps empty meetings at zero", () => {
    const { result } = renderHook(() => useMeetingStats(null));
    expect(result.current.wordCount).toBe(0);
    expect(result.current.wordsPerMinute).toBe(0);
    expect(result.current.speakerBreakdown).toEqual([]);
  });
});
