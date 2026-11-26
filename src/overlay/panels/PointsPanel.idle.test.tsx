/**
 * The Talking points panel does no frame work while it is hidden, and in Manual mode, with a real note
 * in the real dock: hidden 0, shown and manual 0, auto runs, hidden again 0.
 */
import { act, cleanup, render } from "@testing-library/react";
import { useReducer } from "react";
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
import { Dock } from "../dock";
import { dockReducer, initialDockState, type DockAction, type DockState } from "../dock/layoutModel";
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


const IDS = ["transcript", "points"];
let send: (a: DockAction) => void = () => undefined;
let state: DockState;

function Harness() {
  const [s, d] = useReducer(dockReducer, IDS, (k) => dockReducer(initialDockState(k), { type: "hide", panel: "points" }));
  send = d;
  state = s;
  return (
    <Dock
      size={{ w: 900, h: 600 }}
      state={s}
      dispatch={d}
      panels={{
        transcript: { title: "Transcript", node: <div>lines</div> },
        points: { title: "Talking points", node: <PointsPanel /> },
      }}
    />
  );
}

const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
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
  useTalkingPointsStore.getState().setReading({ mode: "manual", suggest: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  useMeetingStore.setState({ activeMeeting: null });
});

describe("frame work of the Talking points panel", () => {
  it("is zero while hidden and in Manual, runs in Auto, and stops again when hidden", async () => {
    const raf = vi.spyOn(window, "requestAnimationFrame");
    const frames = async (ms: number) => {
      await tick(600); // let anything pending finish
      raf.mockClear();
      await tick(ms);
      return raf.mock.calls.length;
    };
    const { container } = render(<Harness />);
    await tick(800);
    const host = () => container.querySelector('[data-dock-panel="points"]')!;
    expect(host().getAttribute("data-visible")).toBe("false");
    // the note is loaded and mounted, but hidden
    expect(container.textContent).toContain("Quarterly review");

    // hidden, Auto set: still nothing
    act(() => useTalkingPointsStore.getState().setReading({ mode: "auto" }));
    expect(await frames(1500)).toBe(0);

    // shown, Manual: nothing
    act(() => useTalkingPointsStore.getState().setReading({ mode: "manual" }));
    act(() => send({ type: "show", panel: "points" }));
    expect(host().getAttribute("data-visible")).toBe("true");
    expect(await frames(1500)).toBe(0);

    // shown, Auto: it runs
    act(() => useTalkingPointsStore.getState().setReading({ mode: "auto" }));
    raf.mockClear();
    await tick(600);
    expect(raf.mock.calls.length).toBeGreaterThan(3);

    // hidden again: it stops
    act(() => send({ type: "hide", panel: "points" }));
    expect(host().getAttribute("data-visible")).toBe("false");
    expect(await frames(1500)).toBe(0);
  });

  it("is zero while the window is hidden or minimised, and picks up again when it is back", async () => {
    const raf = vi.spyOn(window, "requestAnimationFrame");
    const { container } = render(<Harness />);
    act(() => send({ type: "show", panel: "points" }));
    act(() => useTalkingPointsStore.getState().setReading({ mode: "auto" }));
    await tick(800);
    expect(container.querySelector('[data-dock-panel="points"]')!.getAttribute("data-visible")).toBe("true");
    raf.mockClear();
    await tick(400);
    expect(raf.mock.calls.length).toBeGreaterThan(2);
    const vis = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    await tick(600);
    raf.mockClear();
    await tick(1500);
    expect(raf.mock.calls.length).toBe(0);
    vis.mockReturnValue("visible");
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    raf.mockClear();
    await tick(600);
    expect(raf.mock.calls.length).toBeGreaterThan(2);
  });
});
