import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { MeetingSummary, WorkspaceDetail, WorkspaceItem, WorkspaceSummary } from "../lib/types";
import { FALLBACK_GENERAL, useWorkspaceStore } from "../stores/workspaceStore";

/** A workspace summary for tests; override what matters. */
export function ws(over: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  const isGeneral = over.id === undefined || over.id === "general";
  return { ...FALLBACK_GENERAL, is_default: isGeneral, ...over };
}

export function meeting(over: Partial<MeetingSummary> = {}): MeetingSummary {
  return {
    id: "m1",
    title: "Weekly sync",
    start_time: new Date().toISOString(),
    end_time: null,
    duration_seconds: 1800,
    segment_count: 10,
    has_summary: false,
    workspace_id: "general",
    ...over,
  };
}

export function item(over: Partial<WorkspaceItem> = {}): WorkspaceItem {
  return {
    workspace_id: "general",
    kind: "document",
    ref_id: "d1",
    label: null,
    name: "contract.pdf",
    pinned: false,
    status: "ready",
    detail: null,
    tokens: 1200,
    added_at: 0,
    ...over,
  };
}

export function detailOf(summary: WorkspaceSummary, items: WorkspaceItem[] = [], instructions = ""): WorkspaceDetail {
  return { ...summary, instructions, recaps_with_ai: false, suggest_memory: false, items };
}

export type Handler = (args: Record<string, unknown>) => unknown;

/**
 * Answers IPC by command name; everything else answers `[]`. Returns the call
 * log so a test can check what was sent.
 */
export function mockBackend(handlers: Record<string, Handler | unknown> = {}) {
  const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
  mockWindows("launcher");
  mockIPC(
    (cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      calls.push({ cmd, args: a });
      const h = handlers[cmd];
      if (typeof h === "function") return (h as Handler)(a);
      if (h !== undefined) return h;
      if (cmd === "get_workspaces_status") return { available: true, error: null };
      if (cmd === "get_index_status") return { workspace_id: "x", state: "idle", done: 0, total: 0, passages: 0, skipped: [], last_indexed_at: null };
      return [];
    },
    { shouldMockEvents: true },
  );
  return {
    calls,
    called: (cmd: string) => calls.filter((c) => c.cmd === cmd),
  };
}

/** Puts the store in a known state without asking the backend. */
export function seedWorkspaces(list: WorkspaceSummary[], openId = "general") {
  useWorkspaceStore.setState({ workspaces: list, loaded: true, unavailable: false, openId, view: "home", details: {}, noteSeen: true });
}
