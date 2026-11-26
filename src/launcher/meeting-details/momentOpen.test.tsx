import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({ load: async () => ({ get: async () => undefined, set: async () => {} }) }));
vi.mock("./TranscriptView", () => ({
  // The list is virtual (no layout in jsdom): the container's part is the tab and the index it hands down.
  TranscriptView: (p: { initialScrollToIndex?: number | null; isVisible?: boolean }) => (
    <div data-testid="tv" data-scroll={String(p.initialScrollToIndex)} data-visible={String(p.isVisible)} />
  ),
}));

import { MeetingDetails } from "./MeetingDetailsContainer";
import { focusAndMarkRow, rawIndexAtMs, relativeMs } from "./momentIndex";
import { handleOpenRequest } from "../../workspace/openRequest";
import { useMeetingStore } from "../../stores/meetingStore";
import { mockBackend } from "../../workspace/testUtils";
import type { TranscriptSegment } from "../../lib/types";

const START = Date.parse("2026-11-10T10:00:00Z");
const seg = (i: number, atMs: number): TranscriptSegment =>
  ({ id: `s${i}`, text: `line ${i}`, speaker: "Interviewer", timestamp_ms: START + atMs, is_final: true, confidence: 1 }) as TranscriptSegment;
const SEGS = [seg(0, 2_000), seg(1, 10_000), seg(2, 30_000)];

describe("which line a moment lands on", () => {
  it("is the nearest line that started at or before it", () => {
    expect(rawIndexAtMs(SEGS, START, 10_000)).toBe(1);
    expect(rawIndexAtMs(SEGS, START, 29_999)).toBe(1);
    expect(rawIndexAtMs(SEGS, START, 30_000)).toBe(2);
    expect(rawIndexAtMs(SEGS, START, 999_999)).toBe(2);
  });
  it("0 ms and anything before the first line is the first line", () => {
    expect(rawIndexAtMs(SEGS, START, 0)).toBe(0);
    expect(rawIndexAtMs(SEGS, START, 1_500)).toBe(0);
  });
  it("is null with nothing to land on", () => {
    expect(rawIndexAtMs([], START, 5_000)).toBeNull();
  });
});

describe("the time contract: ms since the meeting started, converted once", () => {
  it("stamps that are already relative are used as they are", () => {
    const rel = [seg(0, 0), seg(1, 0), seg(2, 0)].map((x, i) => ({ ...x, timestamp_ms: [2_000, 10_000, 30_000][i] }));
    expect(rawIndexAtMs(rel, START, 10_000)).toBe(1);
    expect(rawIndexAtMs(rel, START, 29_000)).toBe(1);
    expect(rawIndexAtMs(rel, START, 30_000)).toBe(2);
    expect(rawIndexAtMs(rel, 0, 5_000)).toBe(0);
  });
  it("clock times lose the start once; a meeting with no usable start uses the earliest clock time", () => {
    expect(rawIndexAtMs(SEGS, START, 12_000)).toBe(1);
    // No start: the first line (at START+2000) counts as 0, so the lines are at 0, 8000 and 28000.
    expect(rawIndexAtMs(SEGS, 0, 7_999)).toBe(0);
    expect(rawIndexAtMs(SEGS, 0, 8_000)).toBe(1);
    expect(rawIndexAtMs(SEGS, 0, 28_000)).toBe(2);
  });
  it("a stamp before the start is 0, and nothing is converted when there is no base", () => {
    expect(relativeMs(START - 5_000, START)).toBe(0);
    expect(relativeMs(0, START)).toBe(0);
    expect(relativeMs(7_000, START)).toBe(7_000);
    expect(relativeMs(START + 7_000, null)).toBe(0);
    expect(relativeMs(START + 7_000, START)).toBe(7_000);
  });
});

describe("focusing the row", () => {
  it("waits for the virtual list to draw it, focuses it and marks it for a moment", () => {
    vi.useFakeTimers();
    const root = document.createElement("div");
    document.body.appendChild(root);
    const done = vi.fn();
    const stop = focusAndMarkRow(root, 3, done);
    // Not drawn yet.
    vi.advanceTimersByTime(80);
    expect(done).not.toHaveBeenCalled();
    const row = document.createElement("div");
    row.setAttribute("data-testid", "transcript-row");
    row.setAttribute("data-index", "3");
    row.tabIndex = -1;
    root.appendChild(row);
    vi.advanceTimersByTime(60);
    expect(document.activeElement).toBe(row);
    expect(row.classList.contains("ring-2")).toBe(true);
    vi.advanceTimersByTime(2300);
    expect(row.classList.contains("ring-2")).toBe(false);
    expect(done).toHaveBeenCalledTimes(1);
    stop();
    root.remove();
    vi.useRealTimers();
  });
});

describe("opening a meeting at a moment", () => {
  beforeEach(() => {
    mockBackend({
      get_meeting: JSON.stringify({
        id: "m1",
        title: "Security review",
        start_time: new Date(START).toISOString(),
        end_time: new Date(START + 60_000).toISOString(),
        duration_seconds: 60,
        transcript: SEGS,
        ai_interactions: [],
        summary: null,
        config_snapshot: null,
      }),
      get_recording_info: null,
    });
    useMeetingStore.setState({ selectedMeetingId: null, selectedMeetingMoment: null, recentMeetings: [], activeMeeting: null });
  });
  afterEach(() => cleanup());

  it("a citation opens the Transcript tab at its line, 0 ms included", async () => {
    useMeetingStore.getState().openMeetingAt("m1", 12_000);
    render(<MeetingDetails meetingId="m1" onBack={() => {}} />);
    const tv = await screen.findByTestId("tv");
    await waitFor(() => expect(tv).toHaveAttribute("data-scroll", "1"));
    expect(tv).toHaveAttribute("data-visible", "true");
    cleanup();
    useMeetingStore.getState().openMeetingAt("m1", 0);
    render(<MeetingDetails meetingId="m1" onBack={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("tv")).toHaveAttribute("data-scroll", "0"));
  });

  it("a meeting that is already open follows a new citation, and leaves its tab for the Transcript", async () => {
    render(<MeetingDetails meetingId="m1" onBack={() => {}} />);
    const tv = await screen.findByTestId("tv");
    expect(tv).toHaveAttribute("data-scroll", "null");
    await userEvent.click(await screen.findByRole("tab", { name: /Summary/ }));
    await waitFor(() => expect(screen.getByTestId("tv")).toHaveAttribute("data-visible", "false"));
    await act(async () => {
      await handleOpenRequest({ kind: "transcript", ref_id: "m1", start_ms: 31_000 });
    });
    await waitFor(() => expect(screen.getByTestId("tv")).toHaveAttribute("data-scroll", "2"));
    expect(screen.getByTestId("tv")).toHaveAttribute("data-visible", "true");
    // The same moment asked for again still works.
    await act(async () => {
      await handleOpenRequest({ kind: "transcript", ref_id: "m1", start_ms: 31_000 });
    });
    expect(useMeetingStore.getState().selectedMeetingMoment).not.toBeNull();
  });
});

describe("what carries a moment", () => {
  it("a transcript citation carries it (0 too), a meeting alone does not, and plain selection clears it", async () => {
    await handleOpenRequest({ kind: "transcript", ref_id: "m9", start_ms: 0 });
    expect(useMeetingStore.getState().selectedMeetingMoment?.ms).toBe(0);
    await handleOpenRequest({ kind: "transcript", refId: "m9", atMs: 4_000 });
    expect(useMeetingStore.getState().selectedMeetingMoment?.ms).toBe(4_000);
    await handleOpenRequest({ kind: "meeting", meetingId: "m8" });
    expect(useMeetingStore.getState().selectedMeetingId).toBe("m8");
    expect(useMeetingStore.getState().selectedMeetingMoment).toBeNull();
    useMeetingStore.getState().openMeetingAt("m7", 100);
    useMeetingStore.getState().setSelectedMeetingId("m6");
    expect(useMeetingStore.getState().selectedMeetingMoment).toBeNull();
    useMeetingStore.getState().openMeetingAt("m7", null);
    expect(useMeetingStore.getState().selectedMeetingMoment).toBeNull();
  });
});
