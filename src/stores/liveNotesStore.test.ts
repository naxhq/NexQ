import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteDoc, NoteEdit, NotetakerDocEvent, NotetakerState } from "../lib/types";
import { sampleDoc } from "../live-notes/fixtures";

const h = vi.hoisted(() => ({
  doc: null as NoteDoc | null,
  settings: { enabled: true, scope: "meeting", provider: null, model: null, effort: null, update_mode: "automatic", detail: "standard", language: "meeting", cap: 120000, colors: true },
  calls: [] as Array<[string, unknown]>,
  fail: null as string | null,
  onDoc: null as null | ((e: NotetakerDocEvent) => void),
  onState: null as null | ((e: NotetakerState) => void),
  saved: [] as NoteEdit[],
}));

vi.mock("../lib/ipc", async () => {
  const { applyEdit } = await import("../live-notes/edits");
  const rec = (name: string) => async (...args: unknown[]) => {
    h.calls.push([name, args]);
    if (h.fail) throw h.fail;
  };
  return {
    getMeetingNotes: async () => h.doc,
    getNotetakerSettings: async () => h.settings,
    setNotetakerSettings: rec("set_settings"),
    notetakerStart: rec("start"),
    notetakerStop: rec("stop"),
    notetakerUpdateNow: rec("update_now"),
    notetakerContinue: rec("continue"),
    saveMeetingNotesEdit: async (_id: string, edit: NoteEdit) => {
      if (h.fail) throw h.fail;
      h.saved.push(edit);
      h.doc = applyEdit(h.doc!, edit);
      return h.doc;
    },
  };
});
vi.mock("../lib/events", () => ({
  onNotetakerDoc: async (cb: (e: NotetakerDocEvent) => void) => {
    h.onDoc = cb;
    return () => {
      h.onDoc = null;
    };
  },
  onNotetakerState: async (cb: (e: NotetakerState) => void) => {
    h.onState = cb;
    return () => {
      h.onState = null;
    };
  },
}));

import { FRESH_MS, useLiveNotesStore } from "./liveNotesStore";

const run = (over: Partial<NotetakerState> = {}): NotetakerState => ({ meeting_id: "m1", status: "running", tokens_used: 10, cap: 100, ...over });

beforeEach(() => {
  h.doc = structuredClone(sampleDoc);
  h.calls.length = 0;
  h.saved.length = 0;
  h.fail = null;
  useLiveNotesStore.getState().reset();
});
afterEach(() => vi.useRealTimers());

describe("liveNotesStore", () => {
  it("loads the saved notes and settings, and listens for the run", async () => {
    const off = await useLiveNotesStore.getState().attach("m1");
    const s = useLiveNotesStore.getState();
    expect(s.doc?.blocks).toHaveLength(sampleDoc.blocks.length);
    expect(s.settings?.cap).toBe(120000);
    h.onState!(run({ status: "paused", reason: "Plan limit reached" }));
    expect(useLiveNotesStore.getState().run?.reason).toBe("Plan limit reached");
    h.onState!({ ...run(), meeting_id: "other" });
    expect(useLiveNotesStore.getState().run?.status).toBe("paused");
    off();
    expect(h.onDoc).toBeNull();
  });

  it("marks new and changed lines fresh for 4 seconds, and counts arrivals", async () => {
    vi.useFakeTimers();
    await useLiveNotesStore.getState().attach("m1");
    const next = structuredClone(sampleDoc);
    next.blocks[2].text = "Budget moved";
    next.blocks.push({ id: "b9", type: "bullet", parent: "b1", text: "New", t: 1, edited: false, pinned: false });
    h.onDoc!({ meeting_id: "m1", version: 2, doc: next });
    const s = useLiveNotesStore.getState();
    expect(Object.keys(s.fresh).sort()).toEqual(["b3", "b9"]);
    expect(s.arrivals).toEqual({ seq: 1, added: ["b9"] });
    vi.advanceTimersByTime(FRESH_MS + 100);
    expect(useLiveNotesStore.getState().fresh).toEqual({});
  });

  it("does not flash the first load, and ignores a late older answer", async () => {
    await useLiveNotesStore.getState().attach("m1");
    expect(useLiveNotesStore.getState().fresh).toEqual({});
    h.onDoc!({ meeting_id: "m1", version: 5, doc: { version: 1, blocks: [] } });
    h.onDoc!({ meeting_id: "m1", version: 4, doc: structuredClone(sampleDoc) });
    expect(useLiveNotesStore.getState().doc?.blocks).toHaveLength(0);
    h.onDoc!({ meeting_id: "elsewhere", version: 9, doc: structuredClone(sampleDoc) });
    expect(useLiveNotesStore.getState().doc?.blocks).toHaveLength(0);
  });

  it("edits at once, saves, and undoes", async () => {
    await useLiveNotesStore.getState().attach("m1");
    const p = useLiveNotesStore.getState().setText("b3", "Edited words");
    expect(useLiveNotesStore.getState().doc!.blocks.find((b) => b.id === "b3")).toMatchObject({ text: "Edited words", edited: true });
    await p;
    expect(h.saved).toEqual([{ op: "update", id: "b3", text: "Edited words" }]);
    expect(useLiveNotesStore.getState().undoStack).toHaveLength(1);
    await useLiveNotesStore.getState().undo();
    expect(useLiveNotesStore.getState().doc!.blocks.find((b) => b.id === "b3")!.text).toBe("Budget is {{n:$40k}} for {{o:Acme}}");
    expect(useLiveNotesStore.getState().undoStack).toHaveLength(0);
  });

  it("pins, adds and deletes; deleting is undone", async () => {
    await useLiveNotesStore.getState().attach("m1");
    await useLiveNotesStore.getState().togglePin("b3");
    expect(useLiveNotesStore.getState().doc!.blocks.find((b) => b.id === "b3")!.pinned).toBe(true);
    const id = await useLiveNotesStore.getState().addLine("task", "b1", "Mine", "b3");
    expect(useLiveNotesStore.getState().doc!.blocks.map((b) => b.id)).toContain(id);
    await useLiveNotesStore.getState().deleteLine("b4");
    expect(useLiveNotesStore.getState().doc!.blocks.some((b) => b.id === "b4")).toBe(false);
    await useLiveNotesStore.getState().undo();
    expect(useLiveNotesStore.getState().doc!.blocks.some((b) => b.text === "Ship the beta first")).toBe(true);
  });

  it("puts the page back and says so when a save fails", async () => {
    await useLiveNotesStore.getState().attach("m1");
    h.fail = "disk is full";
    await useLiveNotesStore.getState().setText("b3", "Nope");
    expect(useLiveNotesStore.getState().doc!.blocks.find((b) => b.id === "b3")!.text).toContain("Budget");
    expect(useLiveNotesStore.getState().error).toBe("disk is full");
    useLiveNotesStore.getState().clearError();
    expect(useLiveNotesStore.getState().error).toBeNull();
  });

  it("turns on for this meeting or every meeting, then starts", async () => {
    await useLiveNotesStore.getState().attach("m1");
    await useLiveNotesStore.getState().turnOn("every");
    expect(h.calls.map((c) => c[0])).toEqual(["set_settings", "start"]);
    expect((h.calls[0][1] as unknown[])[0]).toMatchObject({ enabled: true, scope: "every" });
  });

  it("answers the cap prompt: Keep going continues, Stop stops", async () => {
    await useLiveNotesStore.getState().attach("m1");
    h.onState!(run({ status: "capped", tokens_used: 120000, cap: 120000 }));
    await useLiveNotesStore.getState().keepGoing();
    await useLiveNotesStore.getState().stop();
    expect(h.calls.map((c) => c[0])).toEqual(["continue", "stop"]);
  });

  it("update now and settings changes reach the engine", async () => {
    await useLiveNotesStore.getState().attach("m1");
    await useLiveNotesStore.getState().updateNow();
    await useLiveNotesStore.getState().patchSettings({ update_mode: "manual" });
    await useLiveNotesStore.getState().patchSettings({ enabled: false });
    expect(h.calls.map((c) => c[0])).toEqual(["update_now", "set_settings", "set_settings", "stop"]);
    expect(useLiveNotesStore.getState().settings?.update_mode).toBe("manual");
  });

  it("reports a failed start in words", async () => {
    await useLiveNotesStore.getState().attach("m1");
    h.fail = "No provider is set up";
    await useLiveNotesStore.getState().updateNow();
    expect(useLiveNotesStore.getState().error).toBe("No provider is set up");
  });

  it("forgets everything when a new meeting starts", async () => {
    await useLiveNotesStore.getState().attach("m1");
    await useLiveNotesStore.getState().setText("b3", "x");
    useLiveNotesStore.getState().reset();
    const s = useLiveNotesStore.getState();
    expect([s.meetingId, s.doc, s.run, s.undoStack.length]).toEqual([null, null, null, 0]);
  });
});
