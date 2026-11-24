import { describe, expect, it } from "vitest";
import type { MeetingSummary } from "./types";
import {
  FINISHED_MEETINGS_NEEDED,
  RECENT_END_WINDOW_MS,
  isFinishedMeeting,
  newestFinishedEndMs,
  parseEndTime,
  shouldOfferStarPrompt,
  starPromptWaiting,
  type StarPromptCheck,
} from "./starPrompt";

const NOW = Date.parse("2026-11-24T12:00:00Z");

function meeting(id: number, over: Partial<MeetingSummary> = {}): MeetingSummary {
  return {
    id: `m${id}`,
    title: `Meeting ${id}`,
    start_time: new Date(NOW - (id + 1) * 3_600_000).toISOString(),
    end_time: new Date(NOW - id * 3_600_000 - 1_800_000).toISOString(),
    duration_seconds: 1800,
    segment_count: 12,
    has_summary: false,
    ...over,
  };
}

/** `count` finished meetings, the newest ended `agoMs` ago, the rest hours earlier. */
function finished(count: number, agoMs = 30_000): MeetingSummary[] {
  return Array.from({ length: count }, (_, i) =>
    meeting(i, { end_time: new Date(NOW - agoMs - i * 3_600_000).toISOString() }),
  );
}

function check(over: Partial<StarPromptCheck> = {}): StarPromptCheck {
  return {
    alreadyShown: false,
    meetings: finished(5),
    nowMs: NOW,
    demoActive: false,
    hasActiveMeeting: false,
    meetingStarting: false,
    ...over,
  };
}

describe("shouldOfferStarPrompt", () => {
  it("offers on the fifth finished meeting", () => {
    expect(FINISHED_MEETINGS_NEEDED).toBe(5);
    expect(shouldOfferStarPrompt(check({ meetings: finished(5) }))).toBe(true);
  });

  it("does not offer on the fourth", () => {
    expect(shouldOfferStarPrompt(check({ meetings: finished(4) }))).toBe(false);
  });

  it("does not count unfinished meetings", () => {
    const meetings = [...finished(4), meeting(9, { end_time: null })];
    expect(shouldOfferStarPrompt(check({ meetings }))).toBe(false);
  });

  it("does not count meetings with no transcript", () => {
    const meetings = [...finished(4), meeting(9, { segment_count: 0 })];
    expect(shouldOfferStarPrompt(check({ meetings }))).toBe(false);
  });

  it("does not offer when only an empty meeting just ended (the newest finished one is old)", () => {
    const recentEmpty = meeting(20, { end_time: new Date(NOW - 10_000).toISOString(), segment_count: 0 });
    const meetings = [recentEmpty, ...finished(5, 3 * 3_600_000)];
    expect(shouldOfferStarPrompt(check({ meetings }))).toBe(false);
  });

  it("does not offer after a demo ends (no new real meeting ended just now)", () => {
    expect(shouldOfferStarPrompt(check({ meetings: finished(7, 3 * 3_600_000) }))).toBe(false);
  });

  it("does not offer while a demo, a meeting or a start is under way", () => {
    expect(shouldOfferStarPrompt(check({ demoActive: true }))).toBe(false);
    expect(shouldOfferStarPrompt(check({ hasActiveMeeting: true }))).toBe(false);
    expect(shouldOfferStarPrompt(check({ meetingStarting: true }))).toBe(false);
  });

  it("does not offer once it was shown", () => {
    expect(shouldOfferStarPrompt(check({ alreadyShown: true }))).toBe(false);
  });

  it("takes the recent-end window as 2 minutes, inclusive", () => {
    expect(RECENT_END_WINDOW_MS).toBe(120_000);
    expect(shouldOfferStarPrompt(check({ meetings: finished(5, 120_000) }))).toBe(true);
    expect(shouldOfferStarPrompt(check({ meetings: finished(5, 120_001) }))).toBe(false);
  });

  it("does not trust an end time far in the future", () => {
    expect(shouldOfferStarPrompt(check({ meetings: finished(5, -3_600_000) }))).toBe(false);
  });

  it("works with 50 or more meetings in the list", () => {
    expect(shouldOfferStarPrompt(check({ meetings: finished(50) }))).toBe(true);
    expect(shouldOfferStarPrompt(check({ meetings: finished(80, 3 * 3_600_000) }))).toBe(false);
  });

  it("finds the newest end even when the list is ordered by start time", () => {
    // A long meeting that started first but ended last is still the newest end.
    const longOne = meeting(30, {
      start_time: new Date(NOW - 10 * 3_600_000).toISOString(),
      end_time: new Date(NOW - 20_000).toISOString(),
    });
    const meetings = [...finished(4, 3 * 3_600_000), longOne];
    expect(shouldOfferStarPrompt(check({ meetings }))).toBe(true);
  });

  it("ignores an end time it cannot read", () => {
    const meetings = [...finished(4), meeting(9, { end_time: "not a date" })];
    expect(shouldOfferStarPrompt(check({ meetings }))).toBe(false);
  });
});

describe("parseEndTime", () => {
  it("reads what Rust writes: UTC with nine fractional digits", () => {
    expect(parseEndTime("2026-11-24T11:59:30.123456789+00:00")).toBe(Date.parse("2026-11-24T11:59:30.123Z"));
  });

  it("reads Z, offsets and whole seconds", () => {
    expect(parseEndTime("2026-11-24T11:59:30Z")).toBe(Date.parse("2026-11-24T11:59:30Z"));
    expect(parseEndTime("2026-11-24T06:59:30-05:00")).toBe(Date.parse("2026-11-24T11:59:30Z"));
  });

  it("reads a time without an offset as UTC, not local time", () => {
    expect(parseEndTime("2026-11-24T11:59:30")).toBe(Date.parse("2026-11-24T11:59:30Z"));
  });

  it("is NaN for nonsense", () => {
    expect(Number.isNaN(parseEndTime("later"))).toBe(true);
  });
});

describe("isFinishedMeeting / newestFinishedEndMs", () => {
  it("needs an end time and a transcript", () => {
    expect(isFinishedMeeting({ end_time: "2026-11-24T11:00:00Z", segment_count: 1 })).toBe(true);
    expect(isFinishedMeeting({ end_time: null, segment_count: 5 })).toBe(false);
    expect(isFinishedMeeting({ end_time: "2026-11-24T11:00:00Z", segment_count: 0 })).toBe(false);
  });

  it("is null with nothing finished", () => {
    expect(newestFinishedEndMs([meeting(1, { end_time: null })])).toBeNull();
  });
});

describe("starPromptWaiting", () => {
  const clear = {
    wizard: false,
    notOnLauncher: false,
    updateDialogOpen: false,
    updateToastShowing: false,
    installing: false,
  };

  it("is clear when nothing else has the screen", () => {
    expect(starPromptWaiting(clear)).toBe(false);
  });

  it.each(["wizard", "notOnLauncher", "updateDialogOpen", "updateToastShowing", "installing"] as const)(
    "waits for %s",
    (key) => {
      expect(starPromptWaiting({ ...clear, [key]: true })).toBe(true);
    },
  );
});
