import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({ load: async () => ({ get: async () => undefined, set: async () => {} }) }));

import { useMeetingStore } from "./meetingStore";
import { useWorkspaceStore } from "./workspaceStore";
import { useScenarioStore } from "./scenarioStore";
import { mockBackend, seedWorkspaces, ws } from "../workspace/testUtils";

let scopeError: string | null = null;

function backend() {
  return mockBackend({
    start_meeting: (a: Record<string, unknown>) =>
      JSON.stringify({ id: "m-1", title: "Standup", workspace_id: (a.workspaceId as string) ?? "general" }),
    set_meeting_scope: (a: Record<string, unknown>) => {
      if (scopeError) throw scopeError;
      return { meeting_id: "m-1", home: "acme", borrowed: a.borrowed, effective: ["acme", ...(a.borrowed as string[])] };
    },
  });
}

beforeEach(() => {
  scopeError = null;
  seedWorkspaces(
    [
      ws({ id: "general", name: "General", is_default: true, default_scenario: null }),
      ws({ id: "acme", name: "Acme", is_default: false, default_scenario: "interview" }),
      ws({ id: "docs", name: "Docs", is_default: false }),
    ],
    "acme",
  );
});
afterEach(() => {
  useMeetingStore.getState().stopTimer();
  useMeetingStore.setState({ activeMeeting: null, activeBorrowed: [], currentView: "launcher", isRecording: false, aiScenario: "team_meeting" });
  useScenarioStore.setState({ activeScenarioId: "team_meeting", customScenarios: [], scenarioOverrides: {} });
});

describe("startMeetingFlow and workspaces", () => {
  it("files the meeting in the workspace it is given", async () => {
    const b = backend();
    await useMeetingStore.getState().startMeetingFlow("Standup", "online", "team_meeting", { workspaceId: "acme" });
    expect(b.called("start_meeting")[0].args.workspaceId).toBe("acme");
    expect(useMeetingStore.getState().activeMeeting?.workspace_id).toBe("acme");
  });

  it("without a workspace (shortcut, tray) leaves it to the default one", async () => {
    const b = backend();
    await useMeetingStore.getState().startMeetingFlow("Standup", "online", "team_meeting");
    expect("workspaceId" in b.called("start_meeting")[0].args).toBe(false);
  });

  it("takes the workspace's scenario unless one was picked", async () => {
    const b = backend();
    await useMeetingStore.getState().startMeetingFlow("Standup", "online", undefined, { workspaceId: "acme" });
    expect(useMeetingStore.getState().aiScenario).toBe("interview");
    expect(b.called("update_meeting_mode")[0]?.args).toMatchObject({ aiScenario: "interview" });
    useMeetingStore.setState({ activeMeeting: null });
    await useMeetingStore.getState().startMeetingFlow("Standup", "online", "webinar", { workspaceId: "acme" });
    expect(useMeetingStore.getState().aiScenario).toBe("webinar");
  });

  it("uses the default workspace's scenario for a start with no workspace", async () => {
    seedWorkspaces([ws({ id: "general", is_default: true, default_scenario: "webinar" })], "general");
    backend();
    await useMeetingStore.getState().startMeetingFlow("Standup", "online");
    expect(useMeetingStore.getState().aiScenario).toBe("webinar");
  });

  it("sets the borrowed workspaces after the start, and keeps them in the store", async () => {
    const b = backend();
    await useMeetingStore.getState().startMeetingFlow("Standup", "online", "team_meeting", { workspaceId: "acme", borrowed: ["docs"] });
    expect(b.called("set_meeting_scope")[0].args).toMatchObject({ meetingId: "m-1", borrowed: ["docs"] });
    expect(useMeetingStore.getState().activeBorrowed).toEqual(["docs"]);
  });

  it("still starts when the backend refuses the borrowed ones, and says so", async () => {
    backend();
    scopeError = "Vault is kept separate";
    await useMeetingStore.getState().startMeetingFlow("Standup", "online", "team_meeting", { workspaceId: "acme", borrowed: ["docs"] });
    expect(useMeetingStore.getState().activeMeeting?.id).toBe("m-1");
    expect(useMeetingStore.getState().activeBorrowed).toEqual([]);
  });

  it("tells the meeting window which workspace and what was borrowed", async () => {
    const emitted: Array<[string, unknown]> = [];
    const events = await import("@tauri-apps/api/event");
    const b = backend();
    // Events are mocked by mockBackend; listen to the one the overlay hears.
    const stop = await events.listen("nexq:meeting_started", (e) => emitted.push(["nexq:meeting_started", e.payload]));
    await useMeetingStore.getState().startMeetingFlow("Standup", "online", "team_meeting", { workspaceId: "acme", borrowed: ["docs"] });
    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    expect(emitted[0][1]).toMatchObject({ workspaceId: "acme", borrowed: ["docs"], aiScenario: "team_meeting" });
    stop();
    expect(b.called("start_meeting")).toHaveLength(1);
  });

  it("the store of workspaces is untouched by starting", async () => {
    backend();
    await useMeetingStore.getState().startMeetingFlow("Standup", "online", "team_meeting", { workspaceId: "acme" });
    expect(useWorkspaceStore.getState().openId).toBe("acme");
  });
});
