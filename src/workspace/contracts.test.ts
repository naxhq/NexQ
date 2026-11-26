import { emit } from "@tauri-apps/api/event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({ load: async () => ({ get: async () => undefined, set: async () => {} }) }));

import * as ipc from "../lib/ipc";
import { onMemoryChanged, onWorkspaceIndexProgress, onWorkspaceMaterialUnavailable, onWorkspacesChanged } from "../lib/events";
import { restoreDatabaseCopy, retryOpenDatabase } from "./databaseProblem";
import { mockBackend } from "./testUtils";
import type { PersonalSourcesConfig } from "../lib/types";

// What this side sends and hears, checked against the names and shapes the backend contract fixes.

describe("commands the launcher sends", () => {
  const cfg: PersonalSourcesConfig = { notes_folders: [], mcp_servers: [], mcp_notice_seen: true };

  const cases: Array<[string, () => Promise<unknown>, string, Record<string, unknown>]> = [
    ["list_workspaces", () => ipc.listWorkspaces(), "list_workspaces", {}],
    ["create_workspace", () => ipc.createWorkspace({ name: "A", id: "id-1" }), "create_workspace", { input: { name: "A", id: "id-1" } }],
    ["update_workspace", () => ipc.updateWorkspace("w", { recaps_with_ai: true }), "update_workspace", { id: "w", patch: { recaps_with_ai: true } }],
    ["delete_workspace", () => ipc.deleteWorkspace("w", "move"), "delete_workspace", { id: "w", mode: "move" }],
    ["clone_workspace", () => ipc.cloneWorkspace("w", "Copy"), "clone_workspace", { id: "w", name: "Copy" }],
    ["delete_workspace_meetings", () => ipc.deleteWorkspaceMeetings("w"), "delete_workspace_meetings", { id: "w" }],
    ["start_meeting", () => ipc.startMeeting("T", "w"), "start_meeting", { title: "T", workspaceId: "w" }],
    ["set_meeting_scope", () => ipc.setMeetingScope("m", ["a"]), "set_meeting_scope", { meetingId: "m", borrowed: ["a"] }],
    ["move_meeting", () => ipc.moveMeeting("m", "w"), "move_meeting", { meetingId: "m", workspaceId: "w" }],
    ["load_context_file", () => ipc.loadContextFile("/a.pdf", "w"), "load_context_file", { filePath: "/a.pdf", workspaceId: "w" }],
    [
      "set_personal_sources (filing, loaded)",
      () => ipc.setPersonalSources(cfg, { workspace_id: "w", items: [{ kind: "folder", ref_id: "f" }] }, true),
      "set_personal_sources",
      { filing: { workspace_id: "w", items: [{ kind: "folder", ref_id: "f" }] }, loaded: true },
    ],
    ["remove_library_item", () => ipc.removeLibraryItem("folder", "f"), "remove_library_item", { kind: "folder", refId: "f" }],
    ["get_workspace_note", () => ipc.getWorkspaceNote("d1"), "get_workspace_note", { refId: "d1" }],
    ["update_workspace_note", () => ipc.updateWorkspaceNote("d1", "Plan", "# Plan"), "update_workspace_note", { refId: "d1", title: "Plan", markdown: "# Plan" }],
    ["get_library_file_path", () => ipc.getLibraryFilePath("f", "a.md"), "get_library_file_path", { folderId: "f", subPath: "a.md" }],
    ["reveal_library_file", () => ipc.revealLibraryFile("f", "a.md"), "reveal_library_file", { folderId: "f", subPath: "a.md" }],
    ["create_memory", () => ipc.createMemory({ workspace_id: "w", kind: "fact", title: "t", text: "x" }), "create_memory", { input: { workspace_id: "w", kind: "fact", title: "t", text: "x" } }],
    ["update_memory", () => ipc.updateMemory("k", { text: "y" }), "update_memory", { id: "k", patch: { text: "y" } }],
    ["suggest_memory", () => ipc.suggestMemory("w", "m"), "suggest_memory", { workspaceId: "w", meetingId: "m" }],
    ["resolve_memory", () => ipc.resolveMemory("k", "save", { title: "t" }), "resolve_memory", { id: "k", action: "save", patch: { title: "t" } }],
    ["retry_recaps", () => ipc.retryRecaps("w"), "retry_recaps", { workspaceId: "w" }],
    ["get_index_status", () => ipc.getIndexStatus("w"), "get_index_status", { id: "w" }],
    ["restore_database_copy", () => restoreDatabaseCopy("nexq-1.db"), "restore_database_copy", { name: "nexq-1.db" }],
    ["retry_open_database", () => retryOpenDatabase(), "retry_open_database", {}],
  ];

  it.each(cases)("%s", async (_label, call, command, args) => {
    const b = mockBackend();
    await call().catch(() => {});
    const sent = b.called(command)[0];
    expect(sent, `${command} was not sent`).toBeDefined();
    expect(sent.args).toMatchObject(args);
  });

  it("never sends the removed commands", () => {
    expect("getAssembledContext" in ipc).toBe(false);
    expect("saveMemory" in ipc).toBe(false);
  });

  it("a push without a loaded config does not say it was loaded", async () => {
    const b = mockBackend();
    await ipc.setPersonalSources(cfg).catch(() => {});
    expect("loaded" in b.called("set_personal_sources")[0].args).toBe(false);
    expect("filing" in b.called("set_personal_sources")[0].args).toBe(false);
  });
});

describe("events the launcher hears", () => {
  it("workspaces_changed, memory_changed, index progress and material unavailable arrive with the agreed fields", async () => {
    mockBackend();
    const seen: Record<string, unknown> = {};
    const stops = await Promise.all([
      onWorkspacesChanged((e) => (seen.changed = e)),
      onMemoryChanged((e) => (seen.memory = e)),
      onWorkspaceIndexProgress((e) => (seen.index = e)),
      onWorkspaceMaterialUnavailable((e) => (seen.material = e)),
    ]);
    await emit("workspaces_changed", { workspace_id: "w" });
    await emit("memory_changed", { workspace_id: "w" });
    await emit("workspace_index_progress", { workspace_id: "w", done: 3, total: 9, current: "a.md", skipped: 1 });
    await emit("workspace_material_unavailable", { meeting_id: null, message: "A folder is missing" });
    await vi.waitFor(() => expect(Object.keys(seen)).toHaveLength(4));
    expect(seen.changed).toEqual({ workspace_id: "w" });
    expect(seen.memory).toEqual({ workspace_id: "w" });
    expect(seen.index).toMatchObject({ workspace_id: "w", done: 3, total: 9, skipped: 1 });
    expect(seen.material).toEqual({ meeting_id: null, message: "A folder is missing" });
    stops.forEach((s) => s());
  });
});

describe("answers the launcher reads", () => {
  it("get_workspaces_status carries the database problem with its copies, and the screen's fields line up", async () => {
    mockBackend({
      get_workspaces_status: {
        available: false,
        error: null,
        db: { kind: "unreadable", message: "bad", path: "C:/x/nexq.db", backups: [{ name: "a.db", created_at: 1_700_000_000_000, bytes: 10, meetings: 2 }] },
      },
    });
    const s = (await ipc.getWorkspacesStatus()) as unknown as { db: { kind: string; path: string; backups: Array<Record<string, unknown>> } };
    expect(Object.keys(s.db.backups[0]).sort()).toEqual(["bytes", "created_at", "meetings", "name"]);
    expect(["unreadable", "newer", "upgrade_failed", "locked"]).toContain(s.db.kind);
  });

  it("delete_workspace_meetings returns the deleted count and a failure list with reasons", async () => {
    mockBackend({ delete_workspace_meetings: { deleted: 2, failed: [{ id: "m", reason: "running" }] } });
    const r = await ipc.deleteWorkspaceMeetings("w");
    expect(r.deleted).toBe(2);
    expect(r.failed).toEqual([{ id: "m", reason: "running" }]);
  });
});
