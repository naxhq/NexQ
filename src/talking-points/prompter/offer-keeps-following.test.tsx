/**
 * An offered "Go to" never changes the follower state or stops scroll-follow: a speaker who is
 * back on the script is "following" again at once, with the offer still on the table.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptSegment } from "../../lib/types";
import { DEFAULT_READING } from "../../stores/talkingPointsStore";
import { useTranscriptStore } from "../../stores/transcriptStore";
import { useConfigStore } from "../../stores/configStore";
import { usePrompter } from "./usePrompter";
import { docFromText } from "../doc/model";
import { VoiceFollower, buildNoteIndex } from "../follow";

const lines = [
  "Welcome everyone to the quarterly review of the product organisation",
  "Revenue grew twelve percent compared with last year driven by enterprise renewals",
  "Churn fell to two point one percent after the support overhaul",
  "We hired fourteen engineers across three product teams this quarter",
  "Next quarter we ship the offline mode and the new billing dashboard",
  "The main risk is the data migration scheduled for November",
  "Finally we will review the budget with the board in March",
];
const doc = docFromText(lines.join("\n"));

let n = 0;
function you(text: string, final = true, id = `seg-${++n}`) {
  const seg: TranscriptSegment = { id, text, speaker: "User", timestamp_ms: Date.now(), is_final: final, confidence: 0.9 };
  act(() => useTranscriptStore.getState().updateInterimSegment(seg));
}
const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
function speak(text: string) {
  const words = text.split(" ");
  const id = `seg-${++n}`;
  for (let i = 3; i < words.length; i++) {
    you(words.slice(0, i).join(" "), false, id);
    tick(150);
  }
  you(text, true, id);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-25T10:00:00Z"));
  useTranscriptStore.getState().clearSegments();
  useConfigStore.setState({ mutedYou: false });
});
afterEach(() => vi.useRealTimers());

describe("an offer and scroll-follow", () => {
  it("the follower keeps following the script while an offer is pending, and the hook passes it on", () => {
    const hook = renderHook(() =>
      usePrompter({
        doc,
        noteKey: "n",
        scrollRef: { current: null },
        contentRef: { current: null },
        reading: { ...DEFAULT_READING, mode: "voice" as const, suggest: true },
        availability: { ok: true },
        suggest: true,
        reducedMotion: true,
      }),
    );
    speak(lines[0]);
    tick(500);
    speak(lines[1]);
    tick(1500);
    const at = hook.result.current.followPosition;
    // far off the current place: an offer, and the follower is no longer sure where we are
    speak("so next quarter we ship the offline mode and the new billing dashboard");
    tick(2500);
    // back on the script, in order: the state must be "following" and the position must move on
    speak(lines[2]);
    tick(300);
    speak(lines[3]);
    tick(700);
    expect(hook.result.current.followState).toBe("following");
    expect(hook.result.current.followPosition).toBeGreaterThan(at);
  });

  it("the state reported with an offer is the follower's own (the offer adds a field, not a state)", () => {
    let t = 0;
    const f = new VoiceFollower(buildNoteIndex(lines.map((text, i) => ({ id: `b${i}`, text }))), { clock: () => t });
    f.onFinal(lines[0], "a");
    t += 1500;
    f.onFinal(lines[1], "b");
    t += 1500;
    f.onFinal("so next quarter we ship the offline mode and the new billing dashboard", "c");
    t += 1500;
    const s = f.snapshot();
    expect(s.suggestion?.blockId).toBe("b4");
    // with the offer showing, the state is whatever the evidence says; it is never forced
    f.onFinal(lines[2], "d");
    t += 300;
    f.onFinal(lines[3], "e");
    expect(f.snapshot().state).toBe("following");
    expect(f.snapshot().position).toBeGreaterThan(s.position);
  });
});
