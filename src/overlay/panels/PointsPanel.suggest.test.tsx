import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Meeting, TalkingPoint } from "../../lib/types";

const h = vi.hoisted(() => ({
  snap: { position: 0, confidence: 0.1, state: "unsure", suggestion: null as null | { blockId: string; confidence: number } },
  seek: vi.fn(),
  place: vi.fn(),
}));

vi.mock("../../talking-points/follow", async (orig) => {
  const mod = await orig<typeof import("../../talking-points/follow")>();
  class FakeFollower {
    constructor(public index: unknown) {}
    setIndex() {}
    onInterim() {}
    onFinal() {}
    reset() {}
    seek(t: number) {
      h.seek(t);
    }
    snapshot() {
      return h.snap;
    }
  }
  class FakeSaid extends mod.SaidTracker {
    setPlace(t: number) {
      h.place(t);
      super.setPlace(t);
    }
  }
  return { ...mod, VoiceFollower: FakeFollower, SaidTracker: FakeSaid };
});

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
import { __resetTalkingPointsForTests, useTalkingPointsStore } from "../../stores/talkingPointsStore";
import { docBlocks, docFromText } from "../../talking-points/doc/model";

const doc = docFromText("Welcome to the review\nRevenue grew twelve percent\nWe hired fourteen engineers");
const ids = docBlocks(doc).map((b) => b.id);
const NOTE: TalkingPoint = {
  id: "n1",
  workspace_id: "w1",
  title: "Opening",
  doc_json: JSON.stringify(doc),
  markdown: "",
  plain_text: "",
  in_context: true,
  sort: 0,
  created_at: 1,
  updated_at: 1,
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  __resetTalkingPointsForTests();
  for (const f of Object.values(ipc)) f.mockReset();
  h.seek.mockReset();
  h.place.mockReset();
  h.snap.state = "unsure";
  h.snap.suggestion = null;
  ipc.listTalkingPoints.mockResolvedValue([NOTE]);
  ipc.getPointProgress.mockResolvedValue(null);
  ipc.getMeetingPointEdit.mockResolvedValue(null);
  ipc.getMeetingScope.mockResolvedValue({ meeting_id: "m1", home: "w1", borrowed: [], effective: ["w1"] });
  ipc.listWorkspaces.mockResolvedValue([]);
  localStorage.clear();
  useConfigStore.setState({ mutedYou: false });
  useMeetingStore.setState({ activeMeeting: { id: "m1", title: "Sync", workspace_id: "w1" } as Meeting, audioMode: "online" });
  useTalkingPointsStore.getState().setReading({ mode: "voice" });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useMeetingStore.setState({ activeMeeting: null });
});

const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

describe("Go to chip", () => {
  it("shows after a second when you stray, never takes focus, and Enter in the reader goes there", async () => {
    render(<PointsPanel />);
    const region = await screen.findByRole("region", { name: /Opening/ });
    region.focus();
    h.snap.suggestion = { blockId: ids[2], confidence: 0.8 };
    await tick(800);
    expect(screen.queryByRole("button", { name: /^Go to:/ })).not.toBeInTheDocument();
    await tick(1600);
    const chip = screen.getByRole("button", { name: "Go to: We hired fourteen engineers" });
    expect(chip).toHaveAttribute("tabindex", "-1");
    expect(region).toHaveFocus();
    expect(screen.getByText("Go to: We hired fourteen engineers", { selector: ".sr-only" })).toBeInTheDocument();
    act(() => {
      region.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(h.seek).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /^Go to:/ })).not.toBeInTheDocument();
    // the Enter went to the chip, not to a tick
    expect(screen.queryAllByRole("button", { pressed: true, name: /^Said it:/ })).toHaveLength(0);
  });

  it("clicking the chip goes there too, and it leaves when following resumes", async () => {
    render(<PointsPanel />);
    await screen.findByRole("region", { name: /Opening/ });
    h.snap.suggestion = { blockId: ids[1], confidence: 0.8 };
    await tick(2500);
    act(() => screen.getByRole("button", { name: /^Go to:/ }).click());
    expect(h.seek).toHaveBeenCalledTimes(1);

    h.snap.suggestion = { blockId: ids[2], confidence: 0.8 };
    await tick(2500);
    expect(screen.getByRole("button", { name: /^Go to:/ })).toBeInTheDocument();
    h.snap.state = "following";
    await tick(800);
    expect(screen.queryByRole("button", { name: /^Go to:/ })).not.toBeInTheDocument();
  });

  it("is gone after twelve seconds, and off when the setting is off", async () => {
    render(<PointsPanel />);
    await screen.findByRole("region", { name: /Opening/ });
    h.snap.suggestion = { blockId: ids[1], confidence: 0.8 };
    await tick(2500);
    expect(screen.getByRole("button", { name: /^Go to:/ })).toBeInTheDocument();
    await tick(12_000);
    expect(screen.queryByRole("button", { name: /^Go to:/ })).not.toBeInTheDocument();
    act(() => useTalkingPointsStore.getState().setReading({ suggest: false }));
    h.snap.suggestion = { blockId: ids[2], confidence: 0.8 };
    await tick(4000);
    expect(screen.queryByRole("button", { name: /^Go to:/ })).not.toBeInTheDocument();
  });

  it("tells the said-it tracker where the follower thinks you are on every update", async () => {
    render(<PointsPanel />);
    await screen.findByRole("region", { name: /Opening/ });
    h.snap.position = 7;
    h.snap.state = "following";
    await tick(1500); // the 700 ms look
    expect(h.place).toHaveBeenCalledWith(7);
  });
});
