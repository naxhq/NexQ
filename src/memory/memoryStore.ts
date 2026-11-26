import { create } from "zustand";
import { createMemory, type MemoryCreate, deleteMemory, listMemory, resolveMemory, suggestMemory, updateMemory } from "../lib/ipc";
import { onMemoryChanged } from "../lib/events";
import type { MemoryItem, MemoryKind } from "../lib/types";
import { messageOf } from "../lib/plainError";

/** A suggestion may carry a flag from the check against the transcript. */
export type MemoryRow = MemoryItem;

export const MEMORY_KINDS: ReadonlyArray<{ kind: MemoryKind; plural: string; singular: string }> = [
  { kind: "person", plural: "People", singular: "Person" },
  { kind: "decision", plural: "Decisions", singular: "Decision" },
  { kind: "open_item", plural: "Open items", singular: "Open item" },
  { kind: "fact", plural: "Facts", singular: "Fact" },
  { kind: "preference", plural: "Preferences", singular: "Preference" },
];

export const UNSUPPORTED_TEXT = "Not found in the transcript";

export type SuggestState =
  | { status: "running"; meetingId: string }
  | { status: "failed"; meetingId: string; error: string }
  | { status: "none"; meetingId: string }
  | { status: "done"; meetingId: string; count: number };

interface MemoryState {
  byWorkspace: Record<string, MemoryRow[]>;
  loadError: Record<string, string | null>;
  suggest: Record<string, SuggestState | undefined>;

  load: (workspaceId: string) => Promise<void>;
  add: (workspaceId: string, draft: { kind: MemoryKind; title: string; text: string }) => Promise<void>;
  edit: (item: MemoryRow, patch: { kind: MemoryKind; title: string; text: string }) => Promise<void>;
  forget: (item: MemoryRow) => Promise<void>;
  resolve: (item: MemoryRow, action: "save" | "dismiss", patch?: { kind?: MemoryKind; title?: string; text?: string }) => Promise<void>;
  runSuggest: (workspaceId: string, meetingId: string) => Promise<void>;
  clearSuggest: (workspaceId: string) => void;
}


/**
 * Exactly what `create_memory` takes (Rust `MemoryCreate`): every field of the struct is
 * present, because `unsupported` has no default and a missing one is refused.
 */
export function newMemoryPayload(workspaceId: string, draft: { kind: MemoryItem["kind"]; title: string; text: string }): MemoryCreate {
  return {
    workspace_id: workspaceId,
    kind: draft.kind,
    title: draft.title.trim(),
    text: draft.text.trim(),
    source_meeting: null,
    source_ms: null,
    status: "saved",
    unsupported: false,
  };
}

export const useMemoryStore = create<MemoryState>((set, get) => ({
  byWorkspace: {},
  loadError: {},
  suggest: {},

  load: async (workspaceId) => {
    try {
      const items = await listMemory(workspaceId);
      set((s) => ({
        byWorkspace: { ...s.byWorkspace, [workspaceId]: Array.isArray(items) ? items : [] },
        loadError: { ...s.loadError, [workspaceId]: null },
      }));
    } catch (e) {
      set((s) => ({ loadError: { ...s.loadError, [workspaceId]: messageOf(e) } }));
    }
  },

  add: async (workspaceId, draft) => {
    await createMemory(newMemoryPayload(workspaceId, draft));
    await get().load(workspaceId);
  },

  edit: async (item, patch) => {
    try {
      await updateMemory(item.id, { kind: patch.kind, title: patch.title.trim(), text: patch.text.trim() });
    } catch (e) {
      // A forgotten id fails instead of coming back; the list catches up through `memory_changed`.
      if (/not_found/i.test(messageOf(e))) throw new Error("This was forgotten in the meantime, so it was not saved again.");
      throw e;
    }
    await get().load(item.workspace_id);
  },

  forget: async (item) => {
    await deleteMemory(item.id);
    set((s) => ({ byWorkspace: { ...s.byWorkspace, [item.workspace_id]: (s.byWorkspace[item.workspace_id] ?? []).filter((m) => m.id !== item.id) } }));
  },

  resolve: async (item, action, patch) => {
    await resolveMemory(item.id, action, patch);
    await get().load(item.workspace_id);
  },

  runSuggest: async (workspaceId, meetingId) => {
    if (get().suggest[workspaceId]?.status === "running") return;
    set((s) => ({ suggest: { ...s.suggest, [workspaceId]: { status: "running", meetingId } } }));
    try {
      const found = await suggestMemory(workspaceId, meetingId);
      await get().load(workspaceId);
      const count = Array.isArray(found) ? found.length : 0;
      set((s) => ({ suggest: { ...s.suggest, [workspaceId]: count > 0 ? { status: "done", meetingId, count } : { status: "none", meetingId } } }));
    } catch (e) {
      set((s) => ({ suggest: { ...s.suggest, [workspaceId]: { status: "failed", meetingId, error: messageOf(e) } } }));
    }
  },

  clearSuggest: (workspaceId) => set((s) => ({ suggest: { ...s.suggest, [workspaceId]: undefined } })),
}));

let watching: Promise<() => void> | null = null;

/** Memory changes (from either window, or the automatic suggestions after a meeting) reload the list. */
export function watchMemory(): Promise<() => void> {
  if (watching) return watching;
  watching = onMemoryChanged((e) => {
    void useMemoryStore.getState().load(e.workspace_id);
  }).catch(() => () => {});
  return watching;
}
