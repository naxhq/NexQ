import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import type {
  DeleteWorkspaceMode,
  WorkspaceDetail,
  WorkspaceInput,
  WorkspacePatch,
  WorkspaceSummary,
} from "../lib/types";
import * as ipc from "../lib/ipc";
import { onWorkspacesChanged } from "../lib/events";
import { LIBRARY_DEFAULT, RAIL_DEFAULT } from "../workspace/layout";
import type { DatabaseProblem } from "../workspace/databaseProblem";

export const GENERAL_ID = "general";
/** A meeting started with a workspace that could not be used has the home `unfiled:<meeting id>` (it names no workspace). */
export const isUnfiledHome = (id: string | null | undefined): boolean => !!id && id.startsWith("unfiled:");

/** Sent by whoever changes a running meeting's home or borrowed workspaces, so both windows follow. */
export const MEETING_SCOPE_EVENT = "nexq:meeting_scope_changed";
export interface MeetingScopeChanged {
  meetingId: string;
  home: string;
  borrowed: string[];
}

/** What the app falls back to when workspaces are unavailable (it then works as before, on General). */
export const FALLBACK_GENERAL: WorkspaceSummary = {
  id: GENERAL_ID,
  name: "General",
  icon: null,
  color: null,
  description: "",
  include_general: false,
  keep_separate: false,
  default_scenario: null,
  is_default: true,
  pinned: false,
  archived: false,
  sort: 0,
  meeting_count: 0,
  chat_count: 0,
  item_count: 0,
  last_activity: null,
  created_at: 0,
  updated_at: 0,
};

/** Pinned first, then General, then the rest in their own order; archived ones only when asked for. */
export function railOrder(all: WorkspaceSummary[], showArchived: boolean): WorkspaceSummary[] {
  const live = all.filter((w) => showArchived || !w.archived || w.id === GENERAL_ID);
  const bySort = (a: WorkspaceSummary, b: WorkspaceSummary) => a.sort - b.sort || a.name.localeCompare(b.name);
  const pinned = live.filter((w) => w.pinned && !w.archived).sort(bySort);
  const general = live.filter((w) => w.id === GENERAL_ID && !w.pinned);
  const others = live.filter((w) => !w.pinned && w.id !== GENERAL_ID && !w.archived).sort(bySort);
  const archived = live.filter((w) => w.archived && w.id !== GENERAL_ID).sort(bySort);
  return [...pinned, ...general, ...others, ...archived];
}

// ── Remembered window arrangement and one-time notes (this window's storage; never required) ──

const PREF_KEYS = {
  open: "nexq_open_workspace",
  rail: "nexq_rail_width",
  library: "nexq_library_width",
  archived: "nexq_show_archived",
  note: "nexq_general_note_seen",
} as const;

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the arrangement just isn't remembered */
  }
}
function readNumber(key: string, fallback: number): number {
  const n = Number(readPref(key));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export type WorkspaceView = "home" | "all";

/** Something asked to be shown: a Library row to highlight, a folder file to point at, a note to edit. */
export interface OpenFocus {
  kind: "document" | "folder" | "talking_point";
  refId: string;
  subRef: string | null;
  workspaceId: string;
  /** Changes with every request, so asking twice for the same thing shows it twice. */
  nonce: number;
}

interface WorkspaceState {
  workspaces: WorkspaceSummary[];
  loaded: boolean;
  /** Workspaces could not be read: the app runs on General alone. */
  unavailable: boolean;
  /** The meetings file could not be used: the home is replaced by the recovery screen. */
  database: DatabaseProblem | null;
  error: string | null;
  /** Bumped on every change, so lists that depend on it (meetings, library) reload. */
  revision: number;
  openId: string;
  view: WorkspaceView;
  details: Record<string, WorkspaceDetail>;
  railWidth: number;
  libraryWidth: number;
  showArchived: boolean;
  /** The 820 to 1099 px Library sheet. */
  librarySheetOpen: boolean;
  noteSeen: boolean;
  focus: OpenFocus | null;
  setFocus: (f: Omit<OpenFocus, "nonce"> | null) => void;

  load: () => Promise<void>;
  refresh: () => Promise<void>;
  openWorkspace: (id: string) => void;
  setView: (view: WorkspaceView) => void;
  setRailWidth: (n: number) => void;
  setLibraryWidth: (n: number) => void;
  setShowArchived: (v: boolean) => void;
  setLibrarySheetOpen: (v: boolean) => void;
  dismissNote: () => void;
  loadDetail: (id: string) => Promise<WorkspaceDetail | null>;

  create: (input: WorkspaceInput) => Promise<WorkspaceDetail>;
  update: (id: string, patch: WorkspacePatch) => Promise<WorkspaceDetail>;
  clone: (id: string, name: string) => Promise<WorkspaceDetail>;
  archive: (id: string, archived: boolean) => Promise<void>;
  remove: (id: string, mode: DeleteWorkspaceMode) => Promise<void>;
  makeDefault: (id: string) => Promise<void>;
  reorder: (ids: string[]) => Promise<void>;
}

/** The workspace new meetings start in (shortcut, tray and detection); General when none says so. */
export function defaultWorkspaceOf(workspaces: WorkspaceSummary[]): WorkspaceSummary {
  return (
    workspaces.find((w) => w.is_default && !w.archived) ??
    workspaces.find((w) => w.id === GENERAL_ID) ??
    FALLBACK_GENERAL
  );
}

export function workspaceById(workspaces: WorkspaceSummary[], id: string | null | undefined): WorkspaceSummary | undefined {
  return workspaces.find((w) => w.id === (id || GENERAL_ID));
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [FALLBACK_GENERAL],
  loaded: false,
  unavailable: false,
  database: null,
  error: null,
  revision: 0,
  openId: readPref(PREF_KEYS.open) || GENERAL_ID,
  view: "home",
  details: {},
  railWidth: readNumber(PREF_KEYS.rail, RAIL_DEFAULT),
  libraryWidth: readNumber(PREF_KEYS.library, LIBRARY_DEFAULT),
  showArchived: readPref(PREF_KEYS.archived) === "1",
  librarySheetOpen: false,
  noteSeen: readPref(PREF_KEYS.note) === "1",
  focus: null,
  setFocus: (f) => set({ focus: f ? { ...f, nonce: Date.now() + Math.random() } : null }),

  load: async () => {
    await get().refresh();
  },

  refresh: async () => {
    try {
      // A failed upgrade leaves the app on General alone: say so, and don't ask for lists that can't come.
      const status = (await ipc.getWorkspacesStatus().catch(() => ({ available: true, error: null as string | null }))) as {
        available: boolean;
        error: string | null;
        db?: DatabaseProblem | null;
      };
      const database = status.db ?? null;
      if (database) {
        // Nothing can be listed from a file that can't be opened.
        set((s) => ({ workspaces: [FALLBACK_GENERAL], loaded: true, unavailable: true, database, error: status.error ?? database.message, revision: s.revision + 1 }));
        return;
      }
      if (!status.available) {
        set((s) => ({
          workspaces: [FALLBACK_GENERAL],
          loaded: true,
          unavailable: true,
          database: null,
          error: status.error ?? "Workspaces could not be set up.",
          openId: GENERAL_ID,
          revision: s.revision + 1,
        }));
        return;
      }
      const list = await ipc.listWorkspaces();
      const workspaces = list.length > 0 ? list : [FALLBACK_GENERAL];
      set((s) => ({
        workspaces,
        loaded: true,
        unavailable: false,
        database: null,
        error: null,
        // An archived workspace stays open while it is being looked at; a deleted one does not.
        openId: workspaces.some((w) => w.id === s.openId) ? s.openId : defaultWorkspaceOf(workspaces).id,
        revision: s.revision + 1,
      }));
      // The open workspace's detail (instructions, items) follows the change.
      const id = get().openId;
      if (get().details[id]) void get().loadDetail(id);
    } catch (e) {
      // Not started yet, or workspaces are unavailable: keep what we have and work on General.
      set((s) => ({ loaded: true, unavailable: s.workspaces.length <= 1, error: messageOf(e), revision: s.revision + 1 }));
    }
  },

  openWorkspace: (id) => {
    writePref(PREF_KEYS.open, id);
    set({ openId: id, view: "home" });
    void get().loadDetail(id);
  },

  setView: (view) => set({ view }),

  setRailWidth: (n) => {
    writePref(PREF_KEYS.rail, String(Math.round(n)));
    set({ railWidth: Math.round(n) });
  },
  setLibraryWidth: (n) => {
    writePref(PREF_KEYS.library, String(Math.round(n)));
    set({ libraryWidth: Math.round(n) });
  },
  setShowArchived: (v) => {
    writePref(PREF_KEYS.archived, v ? "1" : "0");
    set({ showArchived: v });
  },
  setLibrarySheetOpen: (v) => set({ librarySheetOpen: v }),
  dismissNote: () => {
    writePref(PREF_KEYS.note, "1");
    set({ noteSeen: true });
  },

  loadDetail: async (id) => {
    try {
      const got = await ipc.getWorkspace(id);
      // Whatever came back, the rest of the app can count on a list of items.
      const detail: WorkspaceDetail = { ...got, items: Array.isArray(got?.items) ? got.items : [], instructions: got?.instructions ?? "" };
      set((s) => ({ details: { ...s.details, [id]: detail } }));
      return detail;
    } catch {
      return null;
    }
  },

  create: async (input) => {
    const detail = await ipc.createWorkspace(input);
    set((s) => ({ details: { ...s.details, [detail.id]: detail } }));
    await get().refresh();
    return detail;
  },
  update: async (id, patch) => {
    const detail = await ipc.updateWorkspace(id, patch);
    set((s) => ({ details: { ...s.details, [id]: detail } }));
    await get().refresh();
    return detail;
  },
  clone: async (id, name) => {
    const detail = await ipc.cloneWorkspace(id, name);
    await get().refresh();
    return detail;
  },
  archive: async (id, archived) => {
    await ipc.archiveWorkspace(id, archived);
    await get().refresh();
    if (archived && get().openId === id) get().openWorkspace(defaultWorkspaceOf(get().workspaces).id);
  },
  remove: async (id, mode) => {
    await ipc.deleteWorkspace(id, mode);
    set((s) => {
      const { [id]: _gone, ...details } = s.details;
      return { details };
    });
    await get().refresh();
    if (get().openId === id) get().openWorkspace(defaultWorkspaceOf(get().workspaces).id);
  },
  makeDefault: async (id) => {
    await ipc.setDefaultWorkspace(id);
    await get().refresh();
  },
  reorder: async (ids) => {
    // Shown at once; the backend's answer (a change event) settles it.
    set((s) => ({
      workspaces: s.workspaces.map((w) => {
        const at = ids.indexOf(w.id);
        return at >= 0 ? { ...w, sort: at } : w;
      }),
    }));
    try {
      await ipc.reorderWorkspaces(ids);
    } finally {
      await get().refresh();
    }
  },
}));

/** True when the user has more than General (the upgrade note is only for those who haven't made any). */
export function shouldShowGeneralNote(s: Pick<WorkspaceState, "workspaces" | "noteSeen" | "loaded" | "unavailable">): boolean {
  if (!s.loaded || s.noteSeen || s.unavailable) return false;
  const others = s.workspaces.filter((w) => w.id !== GENERAL_ID);
  if (others.length > 0) return false;
  const general = s.workspaces.find((w) => w.id === GENERAL_ID);
  return !!general && (general.meeting_count > 0 || general.item_count > 0);
}

let watching: Promise<() => void> | null = null;

/**
 * Both windows call this once: the list follows `workspaces_changed` (whoever
 * caused it) and a running meeting's home/borrowed changes made in the other window.
 */
export function watchWorkspaces(): Promise<() => void> {
  if (watching) return watching;
  watching = (async () => {
    const stops: Array<() => void> = [];
    try {
      stops.push(await onWorkspacesChanged(() => void useWorkspaceStore.getState().refresh()));
    } catch {
      /* no event bridge (browser preview) */
    }
    try {
      stops.push(
        await listen<MeetingScopeChanged>(MEETING_SCOPE_EVENT, async (e) => {
          const { useMeetingStore } = await import("./meetingStore");
          const state = useMeetingStore.getState();
          if (state.activeMeeting?.id === e.payload.meetingId) {
            useMeetingStore.setState({
              activeMeeting: { ...state.activeMeeting, workspace_id: e.payload.home },
              activeBorrowed: e.payload.borrowed,
            });
          }
        }),
      );
    } catch {
      /* same */
    }
    return () => {
      stops.forEach((s) => s());
      watching = null;
    };
  })();
  return watching;
}

/** Tells the other window a running meeting's home or borrowed workspaces changed. */
export async function announceMeetingScope(payload: MeetingScopeChanged): Promise<void> {
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit(MEETING_SCOPE_EVENT, payload);
  } catch {
    /* not running in Tauri */
  }
}
