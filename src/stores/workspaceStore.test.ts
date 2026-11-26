import { emit } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({ load: async () => ({ get: async () => undefined, set: async () => {} }) }));

import { FALLBACK_GENERAL, defaultWorkspaceOf, useWorkspaceStore, watchWorkspaces, MEETING_SCOPE_EVENT } from "./workspaceStore";
import { useMeetingStore } from "./meetingStore";
import { detailOf, mockBackend, ws } from "../workspace/testUtils";

const LIST = [ws({ id: "general", name: "General" }), ws({ id: "acme", name: "Acme", is_default: false, sort: 1 })];

beforeEach(() => {
  localStorage.clear();
  useWorkspaceStore.setState({ workspaces: [FALLBACK_GENERAL], loaded: false, unavailable: false, error: null, openId: "general", details: {}, revision: 0 });
});

describe("workspaceStore", () => {
  it("loads the list and bumps the revision so lists reload", async () => {
    mockBackend({ list_workspaces: LIST });
    await useWorkspaceStore.getState().load();
    const s = useWorkspaceStore.getState();
    expect(s.workspaces.map((w) => w.id)).toEqual(["general", "acme"]);
    expect(s.loaded).toBe(true);
    expect(s.revision).toBeGreaterThan(0);
  });

  it("moves the open workspace to the default when it was deleted elsewhere", async () => {
    mockBackend({ list_workspaces: LIST });
    useWorkspaceStore.setState({ openId: "gone" });
    await useWorkspaceStore.getState().refresh();
    expect(useWorkspaceStore.getState().openId).toBe("general");
  });

  it("keeps an archived workspace open while it is being looked at", async () => {
    mockBackend({ list_workspaces: [LIST[0], { ...LIST[1], archived: true }] });
    useWorkspaceStore.setState({ openId: "acme" });
    await useWorkspaceStore.getState().refresh();
    expect(useWorkspaceStore.getState().openId).toBe("acme");
  });

  it("falls back to General alone, with the reason, when workspaces are unavailable", async () => {
    const b = mockBackend({ get_workspaces_status: { available: false, error: "The upgrade could not finish" }, list_workspaces: LIST });
    await useWorkspaceStore.getState().refresh();
    const s = useWorkspaceStore.getState();
    expect(s.unavailable).toBe(true);
    expect(s.error).toBe("The upgrade could not finish");
    expect(s.workspaces).toEqual([FALLBACK_GENERAL]);
    expect(s.openId).toBe("general");
    expect(b.called("list_workspaces")).toHaveLength(0);
  });

  it("keeps working when the backend is not ready yet", async () => {
    mockBackend({
      list_workspaces: () => {
        throw "state not managed";
      },
    });
    await useWorkspaceStore.getState().refresh();
    expect(useWorkspaceStore.getState().workspaces).toEqual([FALLBACK_GENERAL]);
    expect(useWorkspaceStore.getState().loaded).toBe(true);
  });

  it("remembers the open workspace and the widths in this window's storage", () => {
    mockBackend({ get_workspace: detailOf(LIST[1]) });
    useWorkspaceStore.getState().openWorkspace("acme");
    useWorkspaceStore.getState().setRailWidth(300);
    useWorkspaceStore.getState().setLibraryWidth(400);
    useWorkspaceStore.getState().setShowArchived(true);
    expect(localStorage.getItem("nexq_open_workspace")).toBe("acme");
    expect(localStorage.getItem("nexq_rail_width")).toBe("300");
    expect(localStorage.getItem("nexq_library_width")).toBe("400");
    expect(localStorage.getItem("nexq_show_archived")).toBe("1");
  });

  it("picks the default workspace for the shortcut, the tray and detection", () => {
    expect(defaultWorkspaceOf([ws({ id: "general", is_default: false }), ws({ id: "acme", is_default: true })]).id).toBe("acme");
    expect(defaultWorkspaceOf([ws({ id: "general", is_default: false })]).id).toBe("general");
    expect(defaultWorkspaceOf([]).id).toBe("general");
    // An archived default is not used.
    expect(defaultWorkspaceOf([ws({ id: "general", is_default: false }), ws({ id: "acme", is_default: true, archived: true })]).id).toBe("general");
  });

  it("sends changes through the backend and refreshes", async () => {
    const b = mockBackend({ list_workspaces: LIST, update_workspace: detailOf(LIST[1]), set_default_workspace: null });
    await useWorkspaceStore.getState().update("acme", { pinned: true });
    await useWorkspaceStore.getState().makeDefault("acme");
    expect(b.called("update_workspace")[0].args).toMatchObject({ id: "acme", patch: { pinned: true } });
    expect(b.called("set_default_workspace")[0].args).toMatchObject({ id: "acme" });
    expect(b.called("list_workspaces").length).toBeGreaterThanOrEqual(2);
  });

  it("reorders at once and settles with the backend", async () => {
    const b = mockBackend({ list_workspaces: LIST, reorder_workspaces: null });
    useWorkspaceStore.setState({ workspaces: LIST });
    const done = useWorkspaceStore.getState().reorder(["acme", "general"]);
    expect(useWorkspaceStore.getState().workspaces.find((w) => w.id === "acme")?.sort).toBe(0);
    await done;
    expect(b.called("reorder_workspaces")[0].args).toMatchObject({ ids: ["acme", "general"] });
  });
});

describe("both windows follow workspaces", () => {
  it("refreshes on workspaces_changed and mirrors a running meeting's scope", async () => {
    const b = mockBackend({ list_workspaces: LIST });
    useMeetingStore.setState({ activeMeeting: { id: "m1", title: "Live", workspace_id: "general" } as never, activeBorrowed: [] });
    const stop = await watchWorkspaces();
    const before = b.called("list_workspaces").length;
    await emit("workspaces_changed", { workspace_id: "acme" });
    await vi.waitFor(() => expect(b.called("list_workspaces").length).toBeGreaterThan(before));

    await emit(MEETING_SCOPE_EVENT, { meetingId: "m1", home: "acme", borrowed: ["docs"] });
    await vi.waitFor(() => expect(useMeetingStore.getState().activeMeeting?.workspace_id).toBe("acme"));
    expect(useMeetingStore.getState().activeBorrowed).toEqual(["docs"]);
    // Another meeting's change is not this one's.
    await emit(MEETING_SCOPE_EVENT, { meetingId: "other", home: "docs", borrowed: [] });
    await new Promise((r) => setTimeout(r, 20));
    expect(useMeetingStore.getState().activeMeeting?.workspace_id).toBe("acme");
    stop();
    useMeetingStore.setState({ activeMeeting: null, activeBorrowed: [] });
  });
});
