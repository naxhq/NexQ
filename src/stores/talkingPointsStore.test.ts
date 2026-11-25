import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PointSaid, TalkingPoint } from "../lib/types";

const ipc = vi.hoisted(() => ({
  listTalkingPoints: vi.fn(),
  saveTalkingPoint: vi.fn(),
  deleteTalkingPoint: vi.fn(),
  copyTalkingPoint: vi.fn(),
  reorderTalkingPoints: vi.fn(),
  getPointProgress: vi.fn(),
  savePointProgress: vi.fn(),
  getMeetingPointEdit: vi.fn(),
  saveMeetingPointEdit: vi.fn(),
}));
vi.mock("../lib/ipc", () => ipc);

import { __resetTalkingPointsForTests, DEFAULT_READING, loadPrefs, pendingSaveCount, useTalkingPointsStore as useStore } from "./talkingPointsStore";
import { docBlocks, docFromText, parseDoc } from "../talking-points/doc/model";

const S = () => useStore.getState();

function point(id: string, ws = "w1", sort = 0, text = "hello"): TalkingPoint {
  const doc = docFromText(text);
  return {
    id,
    workspace_id: ws,
    title: `Note ${id}`,
    doc_json: JSON.stringify(doc),
    markdown: text,
    plain_text: text,
    in_context: false,
    sort,
    created_at: 1,
    updated_at: 1,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  __resetTalkingPointsForTests();
  for (const f of Object.values(ipc)) f.mockReset();
  ipc.saveTalkingPoint.mockImplementation(async (p: TalkingPoint) => p);
  ipc.savePointProgress.mockResolvedValue(undefined);
  ipc.saveMeetingPointEdit.mockResolvedValue(undefined);
  localStorage.clear();
});
afterEach(() => vi.useRealTimers());

describe("loading and creating", () => {
  it("loads a workspace's notes in order", async () => {
    ipc.listTalkingPoints.mockResolvedValue([point("b", "w1", 1), point("a", "w1", 0)]);
    await S().load("w1");
    expect(S().byWorkspace.w1.map((p) => p.id)).toEqual(["a", "b"]);
    expect(S().loading.w1).toBe(false);
  });

  it("keeps the error and lets you retry", async () => {
    ipc.listTalkingPoints.mockRejectedValueOnce("backend down");
    await S().load("w1");
    expect(S().loadError.w1).toBe("backend down");
    ipc.listTalkingPoints.mockResolvedValue([point("a")]);
    await S().load("w1");
    expect(S().loadError.w1).toBeNull();
  });

  it("creates a note with derived text and saves it", async () => {
    ipc.listTalkingPoints.mockResolvedValue([point("a", "w1", 4)]);
    await S().load("w1");
    const p = await S().create("w1", { title: "  New  ", doc: docFromText("one two") });
    expect(p.title).toBe("New");
    expect(p.sort).toBe(5);
    expect(p.plain_text).toBe("one two");
    expect(ipc.saveTalkingPoint).toHaveBeenCalledTimes(1);
    expect(S().saveState[p.id]).toBe("saved");
    expect(pendingSaveCount()).toBe(0);
  });
});

describe("autosave", () => {
  async function open() {
    ipc.listTalkingPoints.mockResolvedValue([point("a")]);
    await S().load("w1");
  }

  it("waits for a pause in typing and sends only the newest text", async () => {
    await open();
    S().edit("a", { doc: docFromText("one") });
    S().edit("a", { doc: docFromText("one two") });
    S().edit("a", { doc: docFromText("one two three") });
    expect(S().saveState.a).toBe("dirty");
    expect(ipc.saveTalkingPoint).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(900);
    expect(ipc.saveTalkingPoint).toHaveBeenCalledTimes(1);
    expect(ipc.saveTalkingPoint.mock.calls[0][0].plain_text).toBe("one two three");
    expect(S().saveState.a).toBe("saved");
  });

  it("a failed save keeps the text, says so, retries with back-off and recovers", async () => {
    await open();
    ipc.saveTalkingPoint.mockRejectedValueOnce("offline").mockRejectedValueOnce("offline");
    S().edit("a", { doc: docFromText("kept") });
    await vi.advanceTimersByTimeAsync(900);
    expect(S().saveState.a).toBe("failed");
    expect(S().saveError.a).toBe("offline");
    expect(S().find("a")!.plain_text).toBe("kept");
    expect(pendingSaveCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(2100); // first retry (2 s) fails again
    expect(ipc.saveTalkingPoint).toHaveBeenCalledTimes(2);
    expect(S().saveState.a).toBe("failed");
    await vi.advanceTimersByTimeAsync(5100); // second retry (5 s) succeeds
    expect(ipc.saveTalkingPoint).toHaveBeenCalledTimes(3);
    expect(S().saveState.a).toBe("saved");
    expect(ipc.saveTalkingPoint.mock.calls[2][0].plain_text).toBe("kept");
    expect(pendingSaveCount()).toBe(0);
  });

  it("the network coming back retries at once", async () => {
    await open();
    ipc.saveTalkingPoint.mockRejectedValueOnce("offline");
    S().edit("a", { doc: docFromText("x") });
    await vi.advanceTimersByTimeAsync(900);
    expect(S().saveState.a).toBe("failed");
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(S().saveState.a).toBe("saved");
  });

  it("typing while a save is in flight sends the newer text next, never loses it", async () => {
    await open();
    let release: (p: TalkingPoint) => void = () => undefined;
    ipc.saveTalkingPoint.mockImplementationOnce(() => new Promise<TalkingPoint>((r) => (release = r)));
    S().edit("a", { doc: docFromText("first") });
    await vi.advanceTimersByTimeAsync(900);
    expect(S().saveState.a).toBe("saving");
    S().edit("a", { doc: docFromText("second") });
    release(ipc.saveTalkingPoint.mock.calls[0][0]);
    await vi.advanceTimersByTimeAsync(900);
    expect(ipc.saveTalkingPoint).toHaveBeenCalledTimes(2);
    expect(ipc.saveTalkingPoint.mock.calls[1][0].plain_text).toBe("second");
    expect(S().find("a")!.plain_text).toBe("second");
    expect(S().saveState.a).toBe("saved");
  });

  it("a note with unsaved text keeps it over a reload from the backend", async () => {
    await open();
    ipc.saveTalkingPoint.mockRejectedValue("offline");
    S().edit("a", { doc: docFromText("local") });
    await vi.advanceTimersByTimeAsync(900);
    ipc.listTalkingPoints.mockResolvedValue([point("a", "w1", 0, "stored")]);
    await S().load("w1");
    expect(S().find("a")!.plain_text).toBe("local");
  });

  it("toggling AI context saves at once", async () => {
    await open();
    S().edit("a", { in_context: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(ipc.saveTalkingPoint).toHaveBeenCalledTimes(1);
    expect(ipc.saveTalkingPoint.mock.calls[0][0].in_context).toBe(true);
  });

  it("flushAll sends what is waiting (window closing)", async () => {
    await open();
    S().edit("a", { doc: docFromText("late") });
    await S().flushAll();
    expect(ipc.saveTalkingPoint).toHaveBeenCalledTimes(1);
  });
});

describe("list actions", () => {
  beforeEach(async () => {
    ipc.listTalkingPoints.mockResolvedValue([point("a", "w1", 0), point("b", "w1", 1), point("c", "w1", 2)]);
    await S().load("w1");
  });

  it("reorders optimistically and rolls back when the backend refuses", async () => {
    ipc.reorderTalkingPoints.mockRejectedValueOnce("locked");
    const p = S().reorder("w1", ["c", "a", "b"]);
    expect(S().byWorkspace.w1.map((x) => x.id)).toEqual(["c", "a", "b"]);
    await p;
    expect(S().byWorkspace.w1.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(S().actionError).toBe("locked");
    await S().reorder("w1", ["b", "c", "a"]);
    expect(ipc.reorderTalkingPoints).toHaveBeenLastCalledWith("w1", ["b", "c", "a"]);
    expect(S().actionError).toBeNull();
  });

  it("duplicates with new block ids and the same context flag", async () => {
    S().edit("a", { in_context: true });
    await vi.advanceTimersByTimeAsync(0);
    const copy = await S().duplicate("a");
    expect(copy!.title).toBe("Note a copy");
    await vi.advanceTimersByTimeAsync(0);
    const src = docBlocks(parseDoc(S().find("a")!.doc_json)).map((b) => b.id);
    const dup = docBlocks(parseDoc(S().find(copy!.id)!.doc_json)).map((b) => b.id);
    expect(dup.some((id) => src.includes(id))).toBe(false);
    expect(S().find(copy!.id)!.in_context).toBe(true);
  });

  it("copies to another workspace and reports a failure", async () => {
    ipc.copyTalkingPoint.mockResolvedValue({ ...point("a2", "w2") });
    ipc.listTalkingPoints.mockResolvedValue([]);
    await S().load("w2");
    const c = await S().copyTo("a", "w2");
    expect(c!.workspace_id).toBe("w2");
    expect(S().byWorkspace.w2.map((x) => x.id)).toEqual(["a2"]);
    ipc.copyTalkingPoint.mockRejectedValueOnce("nope");
    expect(await S().copyTo("a", "w2")).toBeNull();
    expect(S().actionError).toBe("nope");
  });

  it("deletes after the backend agrees, and keeps the note when it does not", async () => {
    ipc.deleteTalkingPoint.mockRejectedValueOnce("busy");
    await S().remove("b");
    expect(S().find("b")).toBeDefined();
    expect(S().actionError).toBe("busy");
    await S().remove("b");
    expect(S().find("b")).toBeUndefined();
  });
});

describe("in the meeting", () => {
  beforeEach(async () => {
    ipc.listTalkingPoints.mockResolvedValue([point("a")]);
    await S().load("w1");
  });

  it("an 'only this meeting' edit does not touch the workspace note", async () => {
    await S().saveMeetingOnly("m1", "a", docFromText("for today"));
    expect(ipc.saveMeetingPointEdit).toHaveBeenCalledWith("m1", "a", expect.stringContaining("for today"));
    expect(ipc.saveTalkingPoint).not.toHaveBeenCalled();
    expect(S().meetingEdits.a).toContain("for today");
    expect(S().find("a")!.plain_text).toBe("hello");
  });

  it("'save to workspace' saves the note, then drops the meeting copy", async () => {
    await S().saveMeetingOnly("m1", "a", docFromText("draft"));
    await S().saveToWorkspace("m1", "a", docFromText("final"));
    expect(ipc.saveTalkingPoint).toHaveBeenCalledTimes(1);
    expect(ipc.saveTalkingPoint.mock.calls[0][0].plain_text).toBe("final");
    expect(ipc.saveMeetingPointEdit).toHaveBeenLastCalledWith("m1", "a", null);
    expect(S().meetingEdits.a).toBeUndefined();
  });

  it("'save to workspace' that fails keeps the meeting copy and throws", async () => {
    await S().saveMeetingOnly("m1", "a", docFromText("draft"));
    ipc.saveTalkingPoint.mockRejectedValue("offline");
    await expect(S().saveToWorkspace("m1", "a", docFromText("final"))).rejects.toThrow("offline");
    expect(S().meetingEdits.a).toContain("draft");
    expect(ipc.saveMeetingPointEdit).not.toHaveBeenLastCalledWith("m1", "a", null);
  });

  it("loads the meeting copy and the saved progress of a note", async () => {
    const said: PointSaid[] = [{ block_id: "x", by: "manual", ticked: true }];
    ipc.getMeetingPointEdit.mockResolvedValue('{"type":"doc"}');
    ipc.getPointProgress.mockResolvedValue({ meeting_id: "m1", point_id: "a", said });
    await S().loadMeetingState("m1", "a");
    expect(S().meetingEdits.a).toBe('{"type":"doc"}');
    expect(S().progress.a).toEqual(said);
    ipc.getMeetingPointEdit.mockResolvedValue(null);
    await S().loadMeetingState("m1", "a");
    expect(S().meetingEdits.a).toBeUndefined();
  });

  it("saves progress after a pause, once, with the newest state; a failure is kept for the next change", async () => {
    const one: PointSaid[] = [{ block_id: "x", by: "voice", ticked: true }];
    const two: PointSaid[] = [...one, { block_id: "y", by: "manual", ticked: true }];
    S().setProgress("m1", "a", one);
    S().setProgress("m1", "a", two);
    expect(ipc.savePointProgress).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1600);
    expect(ipc.savePointProgress).toHaveBeenCalledTimes(1);
    expect(ipc.savePointProgress).toHaveBeenCalledWith("m1", "a", two);

    ipc.savePointProgress.mockRejectedValueOnce("disk");
    S().setProgress("m1", "a", one);
    await vi.advanceTimersByTimeAsync(1600);
    expect(S().progressError).toBe("disk");
    await S().flushProgress();
    expect(ipc.savePointProgress).toHaveBeenLastCalledWith("m1", "a", one);
  });

  it("flushProgress saves what is waiting when the meeting ends", async () => {
    S().setProgress("m1", "a", [{ block_id: "x", by: "voice", ticked: true }]);
    await S().flushProgress();
    expect(ipc.savePointProgress).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(ipc.savePointProgress).toHaveBeenCalledTimes(1);
  });
});

describe("what the panel remembers", () => {
  it("keeps the last note and recents per workspace, and the reading settings", () => {
    S().rememberNote("w1", "a");
    S().rememberNote("w1", "b");
    S().rememberNote("w1", "a");
    S().rememberNote("w2", "z");
    S().setReading({ fontSize: 34, mode: "voice" });
    expect(S().lastNote).toEqual({ w1: "a", w2: "z" });
    expect(S().recent.w1).toEqual(["a", "b"]);
    const again = loadPrefs();
    expect(again.lastNote.w1).toBe("a");
    expect(again.reading.fontSize).toBe(34);
    expect(again.reading.mode).toBe("voice");
  });

  it("an old or damaged saved value falls back to defaults", () => {
    localStorage.setItem("nexq-talking-points-v1", "{broken");
    expect(loadPrefs().reading).toEqual(DEFAULT_READING);
    localStorage.setItem("nexq-talking-points-v1", JSON.stringify({ reading: { fontSize: 9999, lineSpacing: "x", mode: "weird", wpm: -5 } }));
    const r = loadPrefs().reading;
    expect(r.fontSize).toBe(56);
    expect(r.lineSpacing).toBe(DEFAULT_READING.lineSpacing);
    expect(r.mode).toBe("manual");
    expect(r.wpm).toBe(60);
  });

  it("resetMeeting forgets meeting-only state", () => {
    useStore.setState({ meetingEdits: { a: "x" }, progress: { a: [] } });
    S().resetMeeting();
    expect(S().meetingEdits).toEqual({});
    expect(S().progress).toEqual({});
  });
});
