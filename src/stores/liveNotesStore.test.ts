import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteDoc, NoteEdit, NotetakerDocEvent, NotetakerState } from "../lib/types";
import { sampleDoc } from "../live-notes/fixtures";
import { ns } from "../live-notes/testing";

const h = vi.hoisted(() => ({
  docs: {} as Record<string, unknown>,
  settings: { enabled: true, scope: "meeting", provider: "openai", model: "gpt-x", effort: null, update_mode: "automatic", detail: "standard", language: "meeting", cap: 120000, colors: true } as Record<string, unknown>,
  calls: [] as Array<[string, unknown[]]>,
  fail: null as string | null,
  failOnly: new Set<string>(),
  stateFor: {} as Record<string, unknown>,
  live: "live1" as string | null,
  onDoc: null as null | ((e: NotetakerDocEvent) => void),
  onState: null as null | ((e: NotetakerState) => void),
  onSettings: null as null | ((s: unknown) => void),
  saved: [] as Array<[string, NoteEdit]>,
}));

vi.mock("../lib/ipc", async () => {
  const { applyEdit } = await import("../live-notes/edits");
  const rec = (name: string) => async (...args: unknown[]) => {
    h.calls.push([name, args]);
    if (h.fail || h.failOnly.has(name)) throw h.fail ?? "failed";
  };
  return {
    getNotetakerState: async (id: string) => {
      if (h.stateFor[id]) return h.stateFor[id];
      throw "no such command";
    },
    getMeetingNotes: async (id: string) => h.docs[id] ?? null,
    getNotetakerSettings: async () => {
      if (h.failOnly.has("get_settings")) throw "offline";
      return h.settings;
    },
    setNotetakerSettings: async (patch: object) => {
      h.calls.push(["set_settings", [patch]]);
      if (h.fail || h.failOnly.has("set_settings")) throw h.fail ?? "failed";
      h.settings = { ...h.settings, ...patch };
      return h.settings;
    },
    notetakerPause: rec("pause"),
    notetakerResume: rec("resume"),
    notetakerStart: rec("start"),
    notetakerStop: rec("stop"),
    notetakerUpdateNow: rec("update_now"),
    notetakerContinue: rec("continue"),
    saveMeetingNotesEdit: async (id: string, edit: NoteEdit) => {
      if (h.fail) throw h.fail;
      h.saved.push([id, edit]);
      h.docs[id] = applyEdit(h.docs[id] as NoteDoc, edit);
      return h.docs[id];
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
  onNotetakerSettingsChanged: async (cb: (s: unknown) => void) => {
    h.onSettings = cb;
    return () => {
      h.onSettings = null;
    };
  },
}));
vi.mock("./meetingStore", () => ({ useMeetingStore: { getState: () => ({ activeMeeting: h.live ? { id: h.live } : null }) } }));

import { FRESH_MS, useLiveNotesStore } from "./liveNotesStore";

const S = () => useLiveNotesStore.getState();
const entry = (id: string) => S().entries[id];
const names = () => h.calls.map((c) => c[0]);
const run = (over: Partial<NotetakerState> = {}): NotetakerState => ns("running", [], { meeting_id: "live1", tokens_used: 10, cap: 100, ...over });

beforeEach(() => {
  h.docs = { live1: structuredClone(sampleDoc), past1: structuredClone(sampleDoc) };
  h.calls.length = 0;
  h.saved.length = 0;
  h.fail = null;
  h.failOnly.clear();
  h.stateFor = {};
  h.live = "live1";
  h.settings = { enabled: true, scope: "meeting", provider: "openai", model: "gpt-x", effort: null, update_mode: "automatic", detail: "standard", language: "meeting", cap: 120000, colors: true };
  S().reset();
  useLiveNotesStore.setState({ settings: null });
});
afterEach(() => vi.useRealTimers());

describe("documents", () => {
  it("loads the saved notes and settings, and follows its meeting's run", async () => {
    const off = await S().attach("live1");
    expect(entry("live1").doc?.blocks).toHaveLength(sampleDoc.blocks.length);
    expect(S().settings?.cap).toBe(120000);
    h.onState!(run({ status: "paused", reason: "Plan limit reached" }));
    expect(S().runs.live1.reason).toBe("Plan limit reached");
    h.onState!({ ...run(), meeting_id: "other" });
    expect(S().runs.other).toBeUndefined();
    off();
    expect(h.onDoc).toBeNull();
  });

  it("keeps a past meeting's notes apart from the live one", async () => {
    await S().attach("live1");
    await S().attach("past1");
    await S().setText("past1", "b3", "Past edit");
    expect(entry("past1").doc!.blocks.find((b) => b.id === "b3")!.text).toBe("Past edit");
    expect(entry("live1").doc!.blocks.find((b) => b.id === "b3")!.text).toContain("Budget");
    expect(h.saved).toEqual([["past1", { op: "update", id: "b3", text: "Past edit" }]]);
    expect(entry("past1").undoStack).toHaveLength(1);
    expect(entry("live1").undoStack).toHaveLength(0);
  });

  it("marks new and changed lines fresh for 4 seconds, and counts arrivals", async () => {
    vi.useFakeTimers();
    await S().attach("live1");
    const next = structuredClone(sampleDoc);
    next.blocks[2].text = "Budget moved";
    next.blocks.push({ id: "b9", type: "bullet", parent: "b1", text: "New", t: 1, edited: false, pinned: false });
    h.onDoc!({ meeting_id: "live1", version: 2, doc: next });
    expect(Object.keys(entry("live1").fresh).sort()).toEqual(["b3", "b9"]);
    expect(entry("live1").arrivals).toEqual({ seq: 1, added: ["b9"] });
    vi.advanceTimersByTime(FRESH_MS + 100);
    expect(entry("live1").fresh).toEqual({});
  });

  it("does not flash the first load, ignores a late older answer and other meetings", async () => {
    await S().attach("live1");
    expect(entry("live1").fresh).toEqual({});
    h.onDoc!({ meeting_id: "live1", version: 5, doc: { version: 1, blocks: [] } });
    h.onDoc!({ meeting_id: "live1", version: 4, doc: structuredClone(sampleDoc) });
    expect(entry("live1").doc?.blocks).toHaveLength(0);
    h.onDoc!({ meeting_id: "elsewhere", version: 9, doc: structuredClone(sampleDoc) });
    expect(S().entries.elsewhere).toBeUndefined();
  });

  it("edits at once, saves, and undoes", async () => {
    await S().attach("live1");
    const p = S().setText("live1", "b3", "Edited words");
    expect(entry("live1").doc!.blocks.find((b) => b.id === "b3")).toMatchObject({ text: "Edited words", edited: true });
    await p;
    await S().undo("live1");
    expect(entry("live1").doc!.blocks.find((b) => b.id === "b3")!.text).toBe("Budget is {{n:$40k}} for {{o:Acme}}");
  });

  it("pins, adds and deletes; deleting is undone", async () => {
    await S().attach("live1");
    await S().togglePin("live1", "b3");
    expect(entry("live1").doc!.blocks.find((b) => b.id === "b3")!.pinned).toBe(true);
    const id = await S().addLine("live1", "task", "b1", "Mine", "b3");
    expect(entry("live1").doc!.blocks.map((b) => b.id)).toContain(id);
    await S().deleteLine("live1", "b4");
    expect(entry("live1").doc!.blocks.some((b) => b.id === "b4")).toBe(false);
    await S().undo("live1");
    expect(entry("live1").doc!.blocks.some((b) => b.text === "Ship the beta first")).toBe(true);
  });

  it("puts the page back and says so when a save fails", async () => {
    await S().attach("live1");
    h.fail = "disk is full";
    await S().setText("live1", "b3", "Nope");
    expect(entry("live1").doc!.blocks.find((b) => b.id === "b3")!.text).toContain("Budget");
    expect(S().error).toBe("disk is full");
    S().clearError();
    expect(S().error).toBeNull();
  });
});

describe("a reopened window reads the true state", () => {
  it("takes the getter's state and a deadline from next_in_ms, before any event", async () => {
    h.stateFor.live1 = ns("paused", ["resume"], { meeting_id: "live1", tokens_used: 5, cap: 100, next_in_ms: 20_000 });
    const before = Date.now();
    await S().attach("live1");
    await vi.waitFor(() => expect(S().runs.live1?.status).toBe("paused"));
    expect(S().runs.live1.can).toEqual(["resume"]);
    expect(S().deadlines.live1!).toBeGreaterThanOrEqual(before + 20_000);
  });

  it("says so when the state cannot be read, and still loads the notes", async () => {
    await S().attach("live1");
    await vi.waitFor(() => expect(S().error).toBe("no such command"));
    expect(S().runs.live1).toBeUndefined();
    expect(entry("live1").doc).not.toBeNull();
  });
});

describe("run controls only ever touch the live meeting", () => {
  it("update now, start and keep going go to the live meeting even with a past one open", async () => {
    await S().attach("past1");
    await S().updateNow();
    await S().start();
    await S().keepGoing();
    expect(h.calls.map((c) => [c[0], c[1][0]])).toEqual([["update_now", "live1"], ["start", "live1"], ["continue", "live1"]]);
  });

  it("with no live meeting, says so instead of doing nothing in silence", async () => {
    h.live = null;
    await S().attach("past1");
    for (const act of [S().updateNow, S().start, S().pause, S().resume, S().tryAgain, S().keepGoing]) {
      S().clearError();
      await act();
      expect(S().error).toMatch(/No meeting is running/);
    }
    await S().stop();
    expect(h.calls).toEqual([]);
  });

  it("pause stops the live run and resume and try again start it again", async () => {
    await S().pause();
    await S().resume();
    await S().tryAgain();
    expect(h.calls.map((c) => [c[0], c[1][0]])).toEqual([["pause", "live1"], ["resume", "live1"], ["start", "live1"]]);
  });

  it("turning on saves only what was chosen, then starts the live meeting", async () => {
    await S().attach("past1");
    await S().turnOn("every");
    expect(h.calls).toEqual([["set_settings", [{ enabled: true, scope: "every" }]], ["start", ["live1"]]]);
    expect(S().settings).toMatchObject({ enabled: true, scope: "every", provider: "openai" });
  });

  it("a settings change is a patch and never rewrites other fields", async () => {
    await S().loadSettings();
    await S().patchSettings({ colors: false });
    expect(h.calls).toEqual([["set_settings", [{ colors: false }]]]);
    expect(S().settings).toMatchObject({ colors: false, provider: "openai", model: "gpt-x" });
  });

  it("follows settings changed in the other window", async () => {
    const off = await S().watchSettings();
    h.onSettings!({ ...h.settings, update_mode: "manual" });
    expect(S().settings?.update_mode).toBe("manual");
    off();
  });

  it("Stop stops every run it knows of, past the live one", async () => {
    await S().attach("live1");
    h.onState!(run());
    useLiveNotesStore.setState({ runs: { live1: run(), stale: run({ meeting_id: "stale", status: "paused" }), done: run({ meeting_id: "done", status: "finished" }) } });
    await S().stop();
    expect(h.calls.map((c) => c[1][0]).sort()).toEqual(["live1", "stale"]);
  });
});

describe("turning off is never claimed unless true", () => {
  it("tries both even when stopping fails, then shows what the backend says", async () => {
    await S().loadSettings();
    h.failOnly.add("stop");
    await S().patchSettings({ enabled: false });
    expect(names()).toEqual(expect.arrayContaining(["set_settings", "stop"]));
    expect(S().settings?.enabled).toBe(false); // persisted
    expect(S().error).toMatch(/may still be running/);
  });

  it("still stops when saving fails, and the UI keeps saying on", async () => {
    await S().loadSettings();
    h.failOnly.add("set_settings");
    await S().patchSettings({ enabled: false });
    expect(names()).toContain("stop");
    expect(S().settings?.enabled).toBe(true);
    expect(S().error).toMatch(/may still be running/);
  });

  it("when the truth cannot be read, does not claim off", async () => {
    await S().loadSettings();
    h.failOnly.add("get_settings");
    await S().patchSettings({ enabled: false });
    expect(S().settings?.enabled).toBe(true);
    expect(S().error).toMatch(/Could not confirm/);
  });

  it("a clean turn off leaves no error and shows off", async () => {
    await S().loadSettings();
    await S().patchSettings({ enabled: false });
    expect(S().settings?.enabled).toBe(false);
    expect(S().error).toBeNull();
  });
});

describe("errors", () => {
  it("reports a failed command in words", async () => {
    h.fail = "No provider is set up";
    await S().updateNow();
    expect(S().error).toBe("No provider is set up");
  });

  it("forgets everything when a new meeting starts", async () => {
    await S().attach("live1");
    useLiveNotesStore.getState().reset();
    expect([S().entries, S().runs]).toEqual([{}, {}]);
  });
});
