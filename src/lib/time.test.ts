import { describe, expect, it } from "vitest";
import { meetingBase, relMs, segmentsRel } from "./time";
import { rawIndexAtMs } from "../launcher/meeting-details/momentIndex";
import { exportToSRT } from "./export";
import type { TranscriptSegment } from "./types";

const START = Date.parse("2026-01-02T10:00:00Z");
const seg = (id: string, ts: number): TranscriptSegment =>
  ({ id, text: id, speaker: "Them", timestamp_ms: ts, is_final: true } as unknown as TranscriptSegment);

describe("the time contract: ms since the meeting started", () => {
  it("reads epoch and relative stamps alike", () => {
    expect(relMs(START + 83_000, START)).toBe(83_000);
    expect(relMs(83_000, START)).toBe(83_000);
    expect(relMs(83_000, null)).toBe(83_000);
  });

  it("clamps before the start and never returns centuries", () => {
    expect(relMs(START - 5_000, START)).toBe(0);
    expect(relMs(START + 5_000, null)).toBe(0);
    expect(relMs(Number.NaN, START)).toBe(0);
    expect(relMs(START + 5_000, Number.NaN)).toBe(0);
  });

  it("counts from the first epoch stamp when the meeting has no usable start", () => {
    expect(meetingBase(Number.NaN, [START + 9_000, START + 2_000, 500])).toBe(START + 2_000);
    expect(segmentsRel([seg("a", START + 2_000), seg("b", START + 9_000)], Number.NaN)).toEqual([0, 7_000]);
  });

  it.each([
    ["epoch", START],
    ["relative", 0],
  ])("opens a moment on the right line with %s stamps", (_n, off) => {
    const segs = [seg("a", off + 1_000), seg("b", off + 61_000), seg("c", off + 125_000)];
    expect(rawIndexAtMs(segs, START, 0)).toBe(0);
    expect(rawIndexAtMs(segs, START, 62_000)).toBe(1);
    expect(rawIndexAtMs(segs, START, 200_000)).toBe(2);
    expect(rawIndexAtMs(segs, Number.NaN, 62_000)).toBe(1);
  });

  it.each([
    ["epoch", START],
    ["relative", 0],
  ])("exports subtitle times since the start with %s stamps", (_n, off) => {
    const srt = exportToSRT([seg("a", off + 3_000), seg("b", off + 65_000)], START);
    expect(srt).toContain("00:00:03,000");
    expect(srt).toContain("00:01:05,000");
    expect(srt).not.toMatch(/\d{3,}:\d\d:\d\d/);
  });
});
