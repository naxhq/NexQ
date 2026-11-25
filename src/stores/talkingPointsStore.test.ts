import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PointSaid, TalkingPoint } from "../lib/types";

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
}));
vi.mock("../lib/ipc", () => ipc);
vi.mock("../lib/events", () => ({ onWorkspacesChanged: vi.fn(async () => () => undefined) }));

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

/** A tiny backend: patches merge, expectedUpdatedAt is checked, a missing note is "not_found". */
const server = new Map<string, TalkingPoint>();
let clock = 100;
function install(list: TalkingPoint[]) {
  server.clear();
  for (const p of list) server.set(p.id, { ...p });
}
const sent = () => ipc.patchTalkingPoint.mock.calls.map((c) => c[1] as Record<string, unknown>);

beforeEach(() => {
  vi.useFakeTimers();
  __resetTalkingPointsForTests();
  for (const f of Object.values(ipc)) f.mockReset();
  server.clear();
  clock = 100;
  ipc.listTalkingPoints.mockImplementation(async (ws: string) => [...server.values()].filter((p) => p.workspace_id === ws).map((p) => ({ ...p })));
  ipc.patchTalkingPoint.mockImplementation(async (id: string, patch: Partial<TalkingPoint>, expected?: number) => {
    const r = server.get(id);
    if (!r) throw "not_found";
    if (expected !== undefined && expected !== r.updated_at) throw "conflict";
    Object.assign(r, patch, { updated_at: ++clock });
    return { ...r };
  });
  // like the backend: everything arrives in one call; a missing flag would default to true
  ipc.createTalkingPoint.mockImplementation(async (ws: string, title: string, c: { doc_json: string; markdown: string; plain_text: string; in_context?: boolean }) => {
    const r: TalkingPoint = { ...point(`new${server.size + 1}`, ws, server.size), title, ...c, in_context: c.in_context ?? true, updated_at: ++clock };
    server.set(r.id, r);
    return { ...r };
  });
  ipc.deleteTalkingPoint.mockImplementation(async (id: string) => {
    if (!server.delete(id)) throw "not_found";
  });
  ipc.savePointProgress.mockResolvedValue(undefined);
  ipc.saveMeetingPointEdit.mockResolvedValue(undefined);
  localStorage.clear();
});
afterEach(() => vi.useRealTimers());

describe("loading and creating", () => {
  it("loads a workspace's notes in order", async () => {
    install([point("b", "w1", 1), point("a", "w1", 0)]);
    await S().load("w1");
    expect(S().byWorkspace.w1.map((p) => p.id)).toEqual(["a", "b"]);
    expect(S().loading.w1).toBe(false);
  });

  it("keeps the error and lets you retry", async () => {
    ipc.listTalkingPoints.mockRejectedValueOnce("backend down");
    await S().load("w1");
    expect(S().loadError.w1).toBe("backend down");
    install([point("a")]);
    await S().load("w1");
    expect(S().loadError.w1).toBeNull();
  });

  it("creates in one atomic call with the text and an explicit AI-context flag (on by default)", async () => {
    install([point("a", "w1", 4)]);
    await S().load("w1");
    const p = await S().create("w1", { title: "  New  ", doc: docFromText("one two") });
    expect(ipc.createTalkingPoint).toHaveBeenCalledTimes(1);
    expect(ipc.createTalkingPoint).toHaveBeenCalledWith("w1", "New", {
      doc_json: expect.stringContaining("one two"),
      markdown: "one two\n",
      plain_text: "one two",
      in_context: true,
    });
    expect(p!.in_context).toBe(true);
    expect(ipc.patchTalkingPoint).not.toHaveBeenCalled(); // no follow-up call, nothing to turn on or off
    expect(S().saveState[p!.id]).toBe("saved");
    expect(S().byWorkspace.w1.map((x) => x.id)).toContain(p!.id);
    expect(pendingSaveCount()).toBe(0);
  });

  it("duplicating an opted-out note is opted out at every instant; an opted-in one is opted in", async () => {
    install([point("a"), { ...point("b", "w1", 1), in_context: true }]);
    await S().load("w1");
    const seen: boolean[] = [];
    const unsub = useStore.subscribe((st) => {
      for (const p of st.byWorkspace.w1 ?? []) if (p.title === "Note a copy") seen.push(p.in_context);
    });
    const copyA = await S().duplicate("a");
    unsub();
    expect(ipc.createTalkingPoint.mock.calls[0][2].in_context).toBe(false);
    expect(copyA!.in_context).toBe(false);
    expect(server.get(copyA!.id)!.in_context).toBe(false);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((v) => v === false)).toBe(true);
    expect(ipc.patchTalkingPoint).not.toHaveBeenCalled();
    const copyB = await S().duplicate("b");
    expect(ipc.createTalkingPoint.mock.calls[1][2].in_context).toBe(true);
    expect(copyB!.in_context).toBe(true);
  });

  it("copying to another workspace keeps the source's flag and sends nothing else", async () => {
    install([point("a")]);
    await S().load("w1");
    await S().load("w2");
    ipc.copyTalkingPoint.mockImplementation(async (id: string, ws: string) => ({ ...server.get(id)!, id: "copy1", workspace_id: ws }));
    const c = await S().copyTo("a", "w2");
    expect(c!.in_context).toBe(false);
    expect(S().byWorkspace.w2[0].in_context).toBe(false);
    expect(ipc.patchTalkingPoint).not.toHaveBeenCalled();
  });

  it("a refused create says why and adds nothing", async () => {
    install([]);
    await S().load("w1");
    ipc.createTalkingPoint.mockRejectedValueOnce("disk full");
    expect(await S().create("w1")).toBeNull();
    expect(S().actionError).toBe("disk full");
    expect(S().byWorkspace.w1).toEqual([]);
  });
});

describe("autosave", () => {
  async function open() {
    install([point("a")]);
    await S().load("w1");
  }

  it("waits for a pause and sends only the changed fields, based on the version it knows", async () => {
    await open();
    S().edit("a", { doc: docFromText("one") });
    S().edit("a", { doc: docFromText("one two three") });
    expect(S().saveState.a).toBe("dirty");
    expect(ipc.patchTalkingPoint).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(900);
    expect(ipc.patchTalkingPoint).toHaveBeenCalledTimes(1);
    const [, patch, expected] = ipc.patchTalkingPoint.mock.calls[0];
    expect(Object.keys(patch).sort()).toEqual(["doc_json", "markdown", "plain_text"]);
    expect(patch.plain_text).toBe("one two three");
    expect(expected).toBe(1);
    expect(S().saveState.a).toBe("saved");
  });

  it("a title change sends the title alone", async () => {
    await open();
    S().edit("a", { title: "Renamed" });
    await vi.advanceTimersByTimeAsync(900);
    expect(sent()).toEqual([{ title: "Renamed" }]);
  });

  it("a failed save keeps the text, says so, retries with back-off and recovers", async () => {
    await open();
    ipc.patchTalkingPoint.mockRejectedValueOnce("offline").mockRejectedValueOnce("offline");
    S().edit("a", { doc: docFromText("kept") });
    await vi.advanceTimersByTimeAsync(900);
    expect(S().saveState.a).toBe("failed");
    expect(S().saveError.a).toBe("offline");
    expect(S().find("a")!.plain_text).toBe("kept");
    expect(pendingSaveCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(2100);
    expect(ipc.patchTalkingPoint).toHaveBeenCalledTimes(2);
    expect(S().saveState.a).toBe("failed");
    await vi.advanceTimersByTimeAsync(5100);
    expect(ipc.patchTalkingPoint).toHaveBeenCalledTimes(3);
    expect(S().saveState.a).toBe("saved");
    expect(server.get("a")!.plain_text).toBe("kept");
    expect(pendingSaveCount()).toBe(0);
  });

  it("the network coming back retries at once", async () => {
    await open();
    ipc.patchTalkingPoint.mockRejectedValueOnce("offline");
    S().edit("a", { doc: docFromText("x") });
    await vi.advanceTimersByTimeAsync(900);
    expect(S().saveState.a).toBe("failed");
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(S().saveState.a).toBe("saved");
  });

  it("race: typing while a save is in flight sends the newer text next and loses nothing", async () => {
    await open();
    let release: () => void = () => undefined;
    const realImpl = ipc.patchTalkingPoint.getMockImplementation()!;
    ipc.patchTalkingPoint.mockImplementationOnce(
      (...a: unknown[]) => new Promise((r) => (release = () => r((realImpl as (...x: unknown[]) => unknown)(...a)))),
    );
    S().edit("a", { doc: docFromText("first") });
    await vi.advanceTimersByTimeAsync(900);
    expect(S().saveState.a).toBe("saving");
    S().edit("a", { doc: docFromText("second") });
    release();
    await vi.advanceTimersByTimeAsync(900);
    expect(ipc.patchTalkingPoint).toHaveBeenCalledTimes(2);
    expect(server.get("a")!.plain_text).toBe("second");
    expect(S().find("a")!.plain_text).toBe("second");
    expect(S().saveState.a).toBe("saved");
  });

  it("flushAll sends what is waiting (window closing)", async () => {
    await open();
    S().edit("a", { doc: docFromText("late") });
    await S().flushAll();
    expect(server.get("a")!.plain_text).toBe("late");
  });

  it("'Use as AI context' is its own immediate patch, never part of autosave", async () => {
    await open();
    S().edit("a", { doc: docFromText("typing") });
    await S().setInContext("a", true);
    expect(sent()[0]).toEqual({ in_context: true });
    expect(ipc.patchTalkingPoint.mock.calls[0][2]).toBeUndefined();
    expect(S().find("a")!.in_context).toBe(true);
    await vi.advanceTimersByTimeAsync(900);
    expect(sent()[1]).not.toHaveProperty("in_context");
    expect(S().saveState.a).toBe("saved"); // the text save was not broken by our own in_context patch
    expect(server.get("a")!.in_context).toBe(true);
    expect(server.get("a")!.plain_text).toBe("typing");
  });

  it("a refused 'AI context' change goes back and says why", async () => {
    await open();
    ipc.patchTalkingPoint.mockRejectedValueOnce("locked");
    await S().setInContext("a", true);
    expect(S().find("a")!.in_context).toBe(false);
    expect(S().actionError).toBe("locked");
  });
});

describe("deleted notes stay deleted", () => {
  async function open() {
    install([point("a"), point("b", "w1", 1)]);
    await S().load("w1");
  }

  it("waits for a save in flight before deleting, and that save cannot bring the note back", async () => {
    await open();
    let release: () => void = () => undefined;
    const realImpl = ipc.patchTalkingPoint.getMockImplementation()!;
    ipc.patchTalkingPoint.mockImplementationOnce(
      (...a: unknown[]) => new Promise((r) => (release = () => r((realImpl as (...x: unknown[]) => unknown)(...a)))),
    );
    S().edit("a", { doc: docFromText("typed") });
    await vi.advanceTimersByTimeAsync(900);
    const del = S().remove("a");
    await vi.advanceTimersByTimeAsync(0);
    expect(ipc.deleteTalkingPoint).not.toHaveBeenCalled(); // waits for the save
    release();
    await del;
    expect(ipc.deleteTalkingPoint).toHaveBeenCalledWith("a");
    expect(S().find("a")).toBeUndefined();
    expect(server.has("a")).toBe(false);
    expect(pendingSaveCount()).toBe(0);
  });

  it("a queued save is dropped when the note is deleted", async () => {
    await open();
    S().edit("a", { doc: docFromText("queued") });
    await S().remove("a");
    await vi.advanceTimersByTimeAsync(5000);
    expect(ipc.patchTalkingPoint).not.toHaveBeenCalled();
    expect(server.has("a")).toBe(false);
  });

  it("edit and flush after deletion do nothing", async () => {
    await open();
    await S().remove("a");
    S().edit("a", { doc: docFromText("ghost") });
    await S().flush("a");
    await S().setInContext("a", true);
    expect(ipc.patchTalkingPoint).not.toHaveBeenCalled();
    expect(S().find("a")).toBeUndefined();
  });

  it("a reload, even a stale one that still lists the note, does not bring it back", async () => {
    await open();
    const stale = [...server.values()].map((p) => ({ ...p }));
    await S().remove("a");
    ipc.listTalkingPoints.mockResolvedValue(stale);
    await S().syncFromBackend("w1");
    await S().load("w1");
    expect(S().byWorkspace.w1.map((p) => p.id)).toEqual(["b"]);
  });

  it("a refused delete takes the tombstone back and keeps the unsaved text", async () => {
    await open();
    S().edit("a", { doc: docFromText("keep me") });
    ipc.deleteTalkingPoint.mockRejectedValueOnce("busy");
    await S().remove("a");
    expect(S().actionError).toBe("busy");
    expect(S().find("a")!.plain_text).toBe("keep me");
    await vi.advanceTimersByTimeAsync(3000);
    expect(server.get("a")!.plain_text).toBe("keep me");
  });

  it("a note deleted in another window is dropped when our save is refused (not_found)", async () => {
    await open();
    S().edit("a", { doc: docFromText("edit") });
    server.delete("a");
    await vi.advanceTimersByTimeAsync(900);
    expect(S().find("a")).toBeUndefined();
    expect(S().actionError).toMatch(/deleted in another window/);
    expect(pendingSaveCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10000);
    expect(ipc.patchTalkingPoint).toHaveBeenCalledTimes(1);
  });
});

describe("another window changes notes", () => {
  async function open() {
    install([point("a", "w1", 0, "alpha"), point("b", "w1", 1, "beta")]);
    await S().load("w1");
  }

  it("a reload brings in changes, new notes and removals when nothing is unsaved", async () => {
    await open();
    server.get("b")!.title = "Beta renamed";
    server.get("b")!.updated_at = 500;
    server.get("b")!.doc_json = JSON.stringify(docFromText("new beta"));
    server.set("c", point("c", "w1", 2));
    server.delete("a");
    await S().syncFromBackend();
    expect(S().byWorkspace.w1.map((p) => p.id)).toEqual(["b", "c"]);
    expect(S().find("b")!.title).toBe("Beta renamed");
    expect(S().docRev.b).toBe(1); // an open editor reloads the new text
  });

  it("unsaved local fields win; fields changed elsewhere that we did not touch come in", async () => {
    await open();
    S().edit("a", { doc: docFromText("my words") });
    server.get("a")!.title = "Their title";
    server.get("a")!.updated_at = 500;
    await S().syncFromBackend("w1");
    const a = S().find("a")!;
    expect(a.plain_text).toBe("my words");
    expect(a.title).toBe("Their title");
    expect(S().saveState.a).toBe("dirty");
    await vi.advanceTimersByTimeAsync(900);
    expect(ipc.patchTalkingPoint.mock.calls[0][2]).toBe(500); // based on the version we now know
    expect(server.get("a")!.plain_text).toBe("my words");
    expect(server.get("a")!.title).toBe("Their title");
    expect(S().saveState.a).toBe("saved");
  });

  it("the same field changed in both places is a conflict: nothing is sent, nothing is lost", async () => {
    await open();
    S().edit("a", { doc: docFromText("mine") });
    server.get("a")!.doc_json = JSON.stringify(docFromText("theirs"));
    server.get("a")!.plain_text = "theirs";
    server.get("a")!.updated_at = 500;
    await S().syncFromBackend("w1");
    expect(S().saveState.a).toBe("conflict");
    expect(S().find("a")!.plain_text).toBe("mine");
    await vi.advanceTimersByTimeAsync(5000);
    expect(ipc.patchTalkingPoint).not.toHaveBeenCalled();
    S().edit("a", { doc: docFromText("mine again") });
    expect(S().saveState.a).toBe("conflict");
  });

  it("keep mine saves our text over theirs", async () => {
    await open();
    S().edit("a", { doc: docFromText("mine") });
    server.get("a")!.plain_text = "theirs";
    server.get("a")!.doc_json = JSON.stringify(docFromText("theirs"));
    server.get("a")!.updated_at = 500;
    await S().syncFromBackend("w1");
    await S().resolveConflict("a", "mine");
    expect(server.get("a")!.plain_text).toBe("mine");
    expect(S().saveState.a).toBe("saved");
  });

  it("use theirs drops our edits and reloads the editor", async () => {
    await open();
    S().edit("a", { doc: docFromText("mine") });
    server.get("a")!.plain_text = "theirs";
    server.get("a")!.doc_json = JSON.stringify(docFromText("theirs"));
    server.get("a")!.updated_at = 500;
    await S().syncFromBackend("w1");
    await S().resolveConflict("a", "theirs");
    expect(S().find("a")!.plain_text).toBe("theirs");
    expect(S().saveState.a).toBe("saved");
    expect(S().docRev.a).toBe(1);
    expect(pendingSaveCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(ipc.patchTalkingPoint).not.toHaveBeenCalled();
  });

  it("a refused save (conflict) from the backend becomes the same conflict state", async () => {
    await open();
    S().edit("a", { doc: docFromText("mine") });
    server.get("a")!.updated_at = 777; // changed elsewhere before we noticed
    await vi.advanceTimersByTimeAsync(900);
    expect(S().saveState.a).toBe("conflict");
    expect(S().find("a")!.plain_text).toBe("mine");
    await S().resolveConflict("a", "mine");
    expect(server.get("a")!.plain_text).toBe("mine");
  });

  it("a reload during our own save does not call it a conflict", async () => {
    await open();
    let release: () => void = () => undefined;
    const realImpl = ipc.patchTalkingPoint.getMockImplementation()!;
    ipc.patchTalkingPoint.mockImplementationOnce((...a: unknown[]) => {
      const applied = (realImpl as (...x: unknown[]) => Promise<unknown>)(...a); // the backend applies it now
      return new Promise((r) => (release = () => r(applied)));
    });
    S().edit("a", { doc: docFromText("mine") });
    await vi.advanceTimersByTimeAsync(900);
    // the backend has applied our save, the reply is not back yet
    await S().syncFromBackend("w1");
    expect(S().saveState.a).toBe("saving");
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(S().saveState.a).not.toBe("conflict");
  });

  it("a failed reload leaves local edits alone", async () => {
    await open();
    S().edit("a", { doc: docFromText("mine") });
    ipc.listTalkingPoints.mockRejectedValue("down");
    await S().syncFromBackend();
    expect(S().find("a")!.plain_text).toBe("mine");
  });
});

describe("list actions", () => {
  beforeEach(async () => {
    install([point("a", "w1", 0), point("b", "w1", 1), point("c", "w1", 2)]);
    await S().load("w1");
  });

  it("reorders optimistically and rolls back when the backend refuses", async () => {
    ipc.reorderTalkingPoints.mockRejectedValueOnce("locked");
    const p = S().reorder("w1", ["c", "a", "b"]);
    expect(S().byWorkspace.w1.map((x) => x.id)).toEqual(["c", "a", "b"]);
    await p;
    expect(S().byWorkspace.w1.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(S().actionError).toBe("locked");
    ipc.reorderTalkingPoints.mockResolvedValue(undefined);
    await S().reorder("w1", ["b", "c", "a"]);
    expect(ipc.reorderTalkingPoints).toHaveBeenLastCalledWith("w1", ["b", "c", "a"]);
    expect(S().actionError).toBeNull();
  });

  it("duplicates with new block ids and the same context flag", async () => {
    await S().setInContext("a", true);
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
    await S().load("w2");
    const c = await S().copyTo("a", "w2");
    expect(c!.workspace_id).toBe("w2");
    expect(S().byWorkspace.w2.map((x) => x.id)).toEqual(["a2"]);
    ipc.copyTalkingPoint.mockRejectedValueOnce("nope");
    expect(await S().copyTo("a", "w2")).toBeNull();
    expect(S().actionError).toBe("nope");
  });

  it("deletes after the backend agrees", async () => {
    await S().remove("b");
    expect(S().find("b")).toBeUndefined();
    expect(S().byWorkspace.w1.map((x) => x.id)).toEqual(["a", "c"]);
  });
});

describe("in the meeting", () => {
  beforeEach(async () => {
    install([point("a")]);
    await S().load("w1");
  });

  it("an 'only this meeting' edit does not touch the workspace note", async () => {
    await S().saveMeetingOnly("m1", "a", docFromText("for today"));
    expect(ipc.saveMeetingPointEdit).toHaveBeenCalledWith("m1", "a", expect.stringContaining("for today"));
    expect(ipc.patchTalkingPoint).not.toHaveBeenCalled();
    expect(S().meetingEdits.a).toContain("for today");
    expect(S().find("a")!.plain_text).toBe("hello");
  });

  it("'save to workspace' saves the note, then drops the meeting copy", async () => {
    await S().saveMeetingOnly("m1", "a", docFromText("draft"));
    await S().saveToWorkspace("m1", "a", docFromText("final"));
    expect(server.get("a")!.plain_text).toBe("final");
    expect(ipc.saveMeetingPointEdit).toHaveBeenLastCalledWith("m1", "a", null);
    expect(S().meetingEdits.a).toBeUndefined();
  });

  it("'save to workspace' that fails keeps the meeting copy and throws", async () => {
    await S().saveMeetingOnly("m1", "a", docFromText("draft"));
    ipc.patchTalkingPoint.mockRejectedValue("offline");
    await expect(S().saveToWorkspace("m1", "a", docFromText("final"))).rejects.toThrow("offline");
    expect(S().meetingEdits.a).toContain("draft");
    expect(ipc.saveMeetingPointEdit).not.toHaveBeenLastCalledWith("m1", "a", null);
  });

  it("'save to workspace' into a conflict throws and keeps the meeting copy", async () => {
    await S().saveMeetingOnly("m1", "a", docFromText("draft"));
    server.get("a")!.updated_at = 900;
    await expect(S().saveToWorkspace("m1", "a", docFromText("final"))).rejects.toThrow();
    expect(S().meetingEdits.a).toContain("draft");
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
