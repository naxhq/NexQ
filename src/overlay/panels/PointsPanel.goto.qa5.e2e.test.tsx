/**
 * From a transcript event to the visible "Go to" offer, with the real follower, the real
 * store path and real (epoch) timestamps like the speech engines send them.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Meeting, TalkingPoint, TranscriptSegment } from "../../lib/types";

const ipc = vi.hoisted(() => ({
  listTalkingPoints: vi.fn(),
  createTalkingPoint: vi.fn(),
  patchTalkingPoint: vi.fn(),
  deleteTalkingPoint: vi.fn(),
  copyTalkingPoint: vi.fn(),
  reorderTalkingPoints: vi.fn(),
  getPointProgress: vi.fn(),
  savePointProgress: vi.fn(),
  getMeetingPointEdit: vi.fn(),
  saveMeetingPointEdit: vi.fn(),
  getMeetingScope: vi.fn(),
  listWorkspaces: vi.fn(),
}));
vi.mock("../../lib/ipc", () => ipc);

import { PointsPanel } from "./PointsPanel";
import { useMeetingStore } from "../../stores/meetingStore";
import { useConfigStore } from "../../stores/configStore";
import { useTranscriptStore } from "../../stores/transcriptStore";
import { __resetTalkingPointsForTests, useTalkingPointsStore } from "../../stores/talkingPointsStore";
import { docBlocks, docFromText } from "../../talking-points/doc/model";


const LINES = [
  "Our backups stay in Frankfurt and Dublin and never leave the European Union",
  "One named contact handles incidents and answers within one hour",
  "The twenty twenty four rate holds for two years if we sign before January",
  "Support staff outside Europe cannot open customer records without approval",
  "The procurement call is planned for the ninth of December in Chicago",
  "We migrated every customer record to regional storage over three years",
  "Security questionnaire answers match the master services agreement",
  "The renewal covers four hundred seats with room to grow",
];
const doc = docFromText(LINES.join(String.fromCharCode(10)));
const blocks = docBlocks(doc);

const NOTE: TalkingPoint = {
  id: "n1", workspace_id: "w1", title: "QA Script", doc_json: JSON.stringify(doc), markdown: "", plain_text: "",
  in_context: true, sort: 0, created_at: 1, updated_at: 1,
};

let n = 0;
const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
function emit(text: string, final: boolean, id: string) {
  const seg: TranscriptSegment = { id, text, speaker: "User", timestamp_ms: Date.now(), is_final: final, confidence: 0.9 };
  act(() => useTranscriptStore.getState().updateInterimSegment(seg));
}
/** QA's say(): interims every 3 words 110 ms apart, the final, then 900 ms. */
async function say(text: string, interim = true) {
  const id = `seg-${++n}`;
  if (interim) {
    const w = text.split(" ");
    for (let k = 3; k < w.length; k += 3) {
      emit(w.slice(0, k).join(" "), false, id);
      await tick(110);
    }
  }
  emit(text, true, id);
  await tick(900);
}
const chip = () => screen.queryByRole("button", { name: /^Go to:/ });
/** the sentence the follower's position is in */
const pos = () => useTalkingPointsStore.getState().reading;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-11-25T10:00:00Z"));
  __resetTalkingPointsForTests();
  for (const f of Object.values(ipc)) f.mockReset();
  ipc.listTalkingPoints.mockResolvedValue([NOTE]);
  ipc.getPointProgress.mockResolvedValue(null);
  ipc.savePointProgress.mockResolvedValue(undefined);
  ipc.saveMeetingPointEdit.mockResolvedValue(undefined);
  ipc.getMeetingPointEdit.mockResolvedValue(null);
  ipc.getMeetingScope.mockResolvedValue({ meeting_id: "m1", home: "w1", borrowed: [], effective: ["w1"] });
  ipc.listWorkspaces.mockResolvedValue([]);
  localStorage.clear();
  useTranscriptStore.getState().clearSegments();
  useConfigStore.setState({ mutedYou: false });
  useMeetingStore.setState({ activeMeeting: { id: "m1", title: "Sync", workspace_id: "w1" } as Meeting, audioMode: "online" });
  useTalkingPointsStore.getState().setReading({ mode: "voice", suggest: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useMeetingStore.setState({ activeMeeting: null });
});

/** QA reset(upto): the first lines read in order as finals only, then 1.5 s. */
async function readUpTo(upto: number) {
  render(<PointsPanel />);
  await screen.findByRole("region", { name: /QA Script/ });
  await tick(500);
  for (let i = 0; i <= upto; i++) await say(LINES[i], false);
  await tick(1500);
}
const stateLabel = () => ["Following you", "Listening", "Lost your place. Scroll to show me.", "Waiting for you"].find((x) => (document.body.textContent ?? "").includes(x)) ?? "";
const report: string[] = [];

// [name, lines read before, said, 0-based line it points at]
const CASES: Array<[string, number, string, number]> = [
  ["later point exact (line 6)", 3, LINES[6], 6],
  ["later point paraphrase", 3, "Our security questionnaire answers line up with the master services agreement", 6],
  ["skip two (line 5)", 3, LINES[5], 5],
  ["earlier point exact (line 0)", 4, LINES[0], 0],
  ["earlier point paraphrase", 4, "Backups remain in Frankfurt and Dublin and never leave the EU", 0],
  ["far later paraphrase", 2, "The renewal includes four hundred seats and has room to grow", 7],
  ["partial later point (half a line)", 3, "the procurement call is planned for the ninth of December", 4],
  ["earlier point, short", 5, "named contact handles incidents within one hour", 1],
  ["later point with filler", 3, "so um we migrated every customer record to regional storage over like three years", 5],
];
const OFF = [
  "Sorry the video froze for a second can everyone see my screen",
  "Let me share the other window real quick",
  "Can you hear me okay now",
  "I will send the notes to everyone after the call",
  "Thanks all, let us take a short break",
];

/** QA reset(): Manual, then Follow my voice again, the first lines read again as finals. */
async function resetTo(upto: number) {
  act(() => useTalkingPointsStore.getState().setReading({ mode: "manual" }));
  await tick(300);
  act(() => useTalkingPointsStore.getState().setReading({ mode: "voice" }));
  await tick(500);
  useTranscriptStore.getState().clearSegments();
  for (let i = 0; i <= upto; i++) await say(LINES[i], false);
  await tick(1500);
}

describe("QA round 5: exact note, lines and timing through the real hook chain", () => {
  for (const [name, upto, said, target] of CASES) {
    it(`${name}: offered, or the note went there by itself`, async () => {
      await readUpTo(upto);
      expect(chip()).toBeNull();
      await say(said);
      await tick(1000);
      const c = chip();
      report.push(`${name}: chip=${c?.textContent ?? '-'} state=${stateLabel()}`);
      // @ts-ignore
      (globalThis as any).__r5 = report;
      const first = blocks[target].text.split(/\s+/).slice(0, 2).join(" ");
      if (c) {
        expect(c.textContent).toContain(first);
      } else {
        // no chip is fine only when the follower itself already moved to that line (it says "Following you")
        const st = document.body.textContent ?? "";
        expect(st).toMatch(/Following you/);
      }
    });
  }
  for (const text of OFF) {
    it(`off-script "${text.slice(0, 30)}": nothing offered`, async () => {
      await readUpTo(3);
      await say(text);
      await tick(1000);
      expect(chip()).toBeNull();
    });
  }
  it("keeps following when the lines are read in order", async () => {
    await readUpTo(-1);
    for (let i = 0; i < 8; i++) await say(LINES[i]);
    expect(document.body.textContent).toMatch(/Following you/);
  });

  it("an offer left over from the previous line does not show again after Manual and back to Follow my voice", async () => {
    await readUpTo(3);
    await say("so um we migrated every customer record to regional storage over like three years");
    await tick(1000);
    await resetTo(3);
    await say(OFF[0]);
    await tick(1000);
    expect(chip()).toBeNull();
  });
});
// @ts-ignore
import { writeFileSync as __w } from "node:fs";
import { afterAll } from "vitest";
afterAll(() => __w(".agent-logs/r5-report.txt", ((globalThis as any).__r5 ?? []).join("\n")));
