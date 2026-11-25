import { beforeEach, describe, expect, it, vi } from "vitest";
import { bs } from "../live-notes/testing";
import type { BriefSheet, BriefSheetEvent, BriefState } from "../lib/types";

const h = vi.hoisted(() => ({
  sheet: null as BriefSheet | null,
  calls: [] as string[],
  fail: null as string | null,
  failOnly: new Set<string>(),
  wsOn: true,
  live: "m1" as string | null,
  onSheet: null as null | ((e: BriefSheetEvent) => void),
  onState: null as null | ((e: BriefState) => void),
}));

vi.mock("../lib/ipc", () => {
  const rec = (name: string) => async () => {
    h.calls.push(name);
    if (h.fail || h.failOnly.has(name)) throw h.fail ?? "failed";
  };
  return {
    getBriefState: async () => {
      throw new Error("no state");
    },
    getMeetingBrief: async () => h.sheet,
    getBriefSettings: async () => ({ provider: null, model: null, effort: null, cap: 60000 }),
    setBriefSettings: async (patch: object) => {
      h.calls.push("set_settings:" + JSON.stringify(patch));
      return { provider: null, model: null, effort: null, cap: 60000, ...patch };
    },
    getWorkspace: async () => {
      if (h.failOnly.has("get_ws")) throw "offline";
      return { brief_enabled: h.wsOn };
    },
    updateWorkspace: async (_id: string, patch: { brief_enabled: boolean }) => {
      h.calls.push("ws:" + patch.brief_enabled);
      if (h.failOnly.has("ws")) throw "failed";
      h.wsOn = patch.brief_enabled;
    },
    briefStart: rec("start"),
    briefStop: rec("stop"),
    briefPause: rec("pause"),
    briefResume: rec("resume"),
    briefRefresh: rec("refresh"),
    briefContinue: rec("continue"),
  };
});
vi.mock("./meetingStore", () => ({ useMeetingStore: { getState: () => ({ activeMeeting: h.live ? { id: h.live } : null }) } }));
vi.mock("../lib/events", () => ({
  onBriefSettingsChanged: async () => () => {},
  onBriefSheet: async (cb: (e: BriefSheetEvent) => void) => {
    h.onSheet = cb;
    return () => (h.onSheet = null);
  },
  onBriefState: async (cb: (e: BriefState) => void) => {
    h.onState = cb;
    return () => (h.onState = null);
  },
}));

import { sheetTimeMs, useLiveBriefStore } from "./liveBriefStore";

const sheet = (now: string): BriefSheet => ({ now, facts: [], earlier: [], generated_at: 1_700_000_000_000 });

beforeEach(() => {
  h.sheet = null;
  h.calls.length = 0;
  h.fail = null;
  h.failOnly.clear();
  h.wsOn = true;
  h.live = "m1";
  useLiveBriefStore.getState().reset();
});

describe("liveBriefStore", () => {
  it("loads the saved sheet and follows new ones", async () => {
    h.sheet = sheet("Old topic");
    const off = await useLiveBriefStore.getState().attach("m1");
    expect(useLiveBriefStore.getState().sheet?.now).toBe("Old topic");
    h.onSheet!({ meeting_id: "m1", sheet: sheet("New topic") });
    expect(useLiveBriefStore.getState().sheet?.now).toBe("New topic");
    off();
    expect(h.onSheet).toBeNull();
  });

  it("hides the old sheet at once on a topic change and says so until a new one arrives", async () => {
    h.sheet = sheet("Old topic");
    await useLiveBriefStore.getState().attach("m1");
    h.onSheet!({ meeting_id: "m1", sheet: null });
    expect(useLiveBriefStore.getState()).toMatchObject({ sheet: null, hidden: true });
    h.onSheet!({ meeting_id: "m1", sheet: sheet("Next") });
    expect(useLiveBriefStore.getState()).toMatchObject({ hidden: false });
  });

  it("ignores another meeting's events", async () => {
    await useLiveBriefStore.getState().attach("m1");
    h.onSheet!({ meeting_id: "zzz", sheet: sheet("Nope") });
    h.onState!(bs("running", [], { meeting_id: "zzz" }));
    expect(useLiveBriefStore.getState().sheet).toBeNull();
    expect(useLiveBriefStore.getState().run).toBeNull();
  });

  it("controls the run: refresh, pause, resume, keep going", async () => {
    await useLiveBriefStore.getState().attach("m1");
    const s = useLiveBriefStore.getState();
    await s.refresh();
    await s.pause();
    await s.resume();
    await s.keepGoing();
    expect(h.calls).toEqual(["refresh", "pause", "resume", "continue"]);
  });

  it("turning on is per workspace: saves it there, then starts the live meeting", async () => {
    h.wsOn = false;
    await useLiveBriefStore.getState().attach("m1", "w1");
    await useLiveBriefStore.getState().turnOn();
    expect(h.calls).toEqual(["ws:true", "start"]);
    expect(useLiveBriefStore.getState().workspaceEnabled).toBe(true);
  });

  it("run controls go to the live meeting only", async () => {
    h.live = "m-live";
    await useLiveBriefStore.getState().attach("m-past", "w1");
    await useLiveBriefStore.getState().refresh();
    h.live = null;
    await useLiveBriefStore.getState().refresh();
    expect(h.calls).toEqual(["refresh"]);
  });

  it("turning off tries to stop and to save whichever fails, then shows the truth", async () => {
    await useLiveBriefStore.getState().attach("m1", "w1");
    h.failOnly.add("stop");
    await useLiveBriefStore.getState().turnOff();
    expect(h.calls).toEqual(expect.arrayContaining(["stop", "ws:false"]));
    expect(useLiveBriefStore.getState().workspaceEnabled).toBe(false);
    expect(useLiveBriefStore.getState().error).toMatch(/may still be running/);
  });

  it("never claims off when the save failed or the truth is unreadable", async () => {
    await useLiveBriefStore.getState().attach("m1", "w1");
    h.failOnly.add("ws");
    await useLiveBriefStore.getState().turnOff();
    expect(useLiveBriefStore.getState().workspaceEnabled).toBe(true);
    h.failOnly.add("get_ws");
    await useLiveBriefStore.getState().turnOff();
    expect(useLiveBriefStore.getState().workspaceEnabled).toBeNull();
    expect(useLiveBriefStore.getState().error).toMatch(/Could not confirm/);
  });

  it("a settings change is a patch", async () => {
    await useLiveBriefStore.getState().attach("m1");
    await useLiveBriefStore.getState().patchSettings({ cap: 120000 });
    expect(h.calls).toEqual(["set_settings:" + JSON.stringify({ cap: 120000 })]);
    expect(useLiveBriefStore.getState().settings?.cap).toBe(120000);
  });

  it("says what failed", async () => {
    await useLiveBriefStore.getState().attach("m1");
    h.fail = "No model is set up";
    await useLiveBriefStore.getState().refresh();
    expect(useLiveBriefStore.getState().error).toBe("No model is set up");
  });

  it("reads seconds or milliseconds for the age", () => {
    expect(sheetTimeMs({ ...sheet("x"), generated_at: 1_700_000_000 })).toBe(1_700_000_000_000);
    expect(sheetTimeMs({ ...sheet("x"), generated_at: 1_700_000_000_000 })).toBe(1_700_000_000_000);
  });
});
