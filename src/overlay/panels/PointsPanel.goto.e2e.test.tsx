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
import { docBlocks } from "../../talking-points/doc/model";
import { markdownToDoc } from "../../talking-points/doc/markdown";

const doc = markdownToDoc(
  [
    "# Quarterly review",
    "Welcome everyone to the quarterly review of the product organisation.",
    "## Revenue",
    "Revenue grew twelve percent compared with last year, driven by enterprise renewals.",
    "Churn fell to two point one percent after the support overhaul.",
    "## Hiring",
    "We hired fourteen engineers across three product teams this quarter.",
    "## Roadmap",
    "Next quarter we ship the offline mode and the new billing dashboard.",
    "## Risks",
    "The main risk is the data migration scheduled for November.",
  ].join("\n\n"),
);
const blocks = docBlocks(doc);
const idOf = (starts: string) => blocks.find((b) => b.text.startsWith(starts))!.id;

const NOTE: TalkingPoint = {
  id: "n1",
  workspace_id: "w1",
  title: "Review",
  doc_json: JSON.stringify(doc),
  markdown: "",
  plain_text: "",
  in_context: true,
  sort: 0,
  created_at: 1,
  updated_at: 1,
};

let n = 0;
/** A You-side line the way the app feeds them: an id, and an epoch timestamp. */
function you(text: string, final = true, id = `seg-${++n}`) {
  const seg: TranscriptSegment = { id, text, speaker: "User", timestamp_ms: Date.now(), is_final: final, confidence: 0.9 };
  act(() => useTranscriptStore.getState().updateInterimSegment(seg));
  return id;
}
/** What a streaming engine does: the line grows word by word as interims, then a final under the same id. */
async function speak(text: string) {
  const words = text.split(" ");
  const id = `seg-${++n}`;
  for (let i = 3; i < words.length; i += 1) {
    you(words.slice(0, i).join(" "), false, id);
    await tick(150);
  }
  you(text, true, id);
}
const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const chip = () => screen.queryByRole("button", { name: /^Go to:/ });

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

async function openAndSettleAtStart() {
  render(<PointsPanel />);
  await screen.findByRole("region", { name: /Review/ });
  await tick(100); // the note has been opened and its effects have run, as before any real speech
  // the opening lines, spoken in order: the follower is sure of where you are
  you("welcome everyone to the quarterly review of the product organisation");
  await tick(300);
  you("revenue grew twelve percent compared with last year");
  await tick(600);
}

/** The phrasings the follower itself recognises as pointing at another place (it offers nothing for the rest). */
const PHRASINGS: Array<[string, string, string]> = [
  ["an off-script jump to a later point", "so next quarter we will ship the offline mode and the new billing dashboard", "Next quarter"],
  ["naming the point's heading", "let me talk about the roadmap now offline mode and billing dashboard", "Next quarter"],
];

describe("Go to, from a transcript event to the visible offer (epoch timestamps)", () => {
  for (const [name, said, target] of PHRASINGS) {
    it(`appears for: ${name}`, async () => {
      await openAndSettleAtStart();
      expect(chip()).toBeNull();
      await speak(said);
      await tick(1800);
      const c = chip();
      expect(c, "the chip should be visible").not.toBeNull();
      expect(c!.textContent).toContain(blocks.find((b) => b.id === idOf(target))!.text.split(/\s+/).slice(0, 2).join(" "));
      expect(chip()).toHaveAttribute("tabindex", "-1");
    });
  }

  it("is still offered when the pause detector has gone quiet (no speech for 4 s)", async () => {
    await openAndSettleAtStart();
    const said = "so next quarter we will ship the offline mode and the new billing dashboard";
    await speak(said);
    await tick(1500);
    expect(chip()).not.toBeNull();
    await tick(2500); // past the follower's "paused" threshold
    expect(chip()).not.toBeNull();
  });

  it("is taken back when you say something else that settles the place", async () => {
    await openAndSettleAtStart();
    await speak("so next quarter we will ship the offline mode and the new billing dashboard");
    await tick(1500);
    expect(chip()).not.toBeNull();
    await speak("coming back to churn it fell to two point one percent after the support overhaul");
    await tick(1500);
    // the old offer is gone; going back to an earlier point is itself offered now (or the note moved by itself)
    expect(chip()?.textContent ?? "").not.toContain("Next quarter");
  });
});
