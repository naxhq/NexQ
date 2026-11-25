import { create } from "zustand";
import type { NoteBlockType, NoteDoc, NoteEdit, NotetakerSettings, NotetakerState } from "../lib/types";
import {
  getMeetingNotes,
  getNotetakerSettings,
  notetakerContinue,
  notetakerStart,
  notetakerStop,
  notetakerUpdateNow,
  saveMeetingNotesEdit,
  setNotetakerSettings,
} from "../lib/ipc";
import { onNotetakerDoc, onNotetakerState } from "../lib/events";
import { applyEdit, invertEdit, newUserId, planDelete } from "../live-notes/edits";
import { diffDocs } from "../live-notes/page";

/** How long a new or changed line keeps its margin tick. */
export const FRESH_MS = 4000;
const UNDO_LIMIT = 30;

export const DEFAULT_NOTETAKER_SETTINGS: NotetakerSettings = {
  enabled: false,
  scope: "meeting",
  provider: null,
  model: null,
  effort: null,
  update_mode: "automatic",
  detail: "standard",
  language: "meeting",
  cap: 120000,
  colors: true,
};

/** A document from the engine, or null when what arrived is not one. */
export function cleanDoc(x: unknown): NoteDoc | null {
  const d = x as NoteDoc | null | undefined;
  return d && Array.isArray(d.blocks) ? d : null;
}

interface UndoEntry {
  label: string;
  edits: NoteEdit[];
}

interface LiveNotesState {
  meetingId: string | null;
  doc: NoteDoc | null;
  version: number;
  run: NotetakerState | null;
  settings: NotetakerSettings | null;
  /** Lines that are new or changed, until when (ms epoch). */
  fresh: Record<string, number>;
  /** Bumps when new lines arrive, so the page can count them while the reader is scrolled up. */
  arrivals: { seq: number; added: string[] };
  undoStack: UndoEntry[];
  /** The last thing that failed, in words. */
  error: string | null;

  attach: (meetingId: string) => Promise<() => void>;
  reset: () => void;
  turnOn: (scope: NotetakerSettings["scope"]) => Promise<void>;
  stop: () => Promise<void>;
  start: () => Promise<void>;
  updateNow: () => Promise<void>;
  keepGoing: () => Promise<void>;
  patchSettings: (patch: Partial<NotetakerSettings>) => Promise<void>;
  edit: (edit: NoteEdit, label?: string) => Promise<void>;
  setText: (id: string, text: string) => Promise<void>;
  setType: (id: string, type: NoteBlockType) => Promise<void>;
  togglePin: (id: string) => Promise<void>;
  addLine: (type: NoteBlockType, parent: string | null, text: string, after?: string | null) => Promise<string>;
  deleteLine: (id: string) => Promise<void>;
  undo: () => Promise<void>;
  clearError: () => void;
}

let pruneTimer: ReturnType<typeof setTimeout> | null = null;

function describeError(e: unknown): string {
  const s = typeof e === "string" ? e : e instanceof Error ? e.message : "";
  return s || "Something went wrong. Try again.";
}

export const useLiveNotesStore = create<LiveNotesState>((set, get) => {
  const markFresh = (ids: string[]) => {
    if (ids.length === 0) return;
    const until = Date.now() + FRESH_MS;
    set((s) => {
      const fresh = { ...s.fresh };
      for (const id of ids) fresh[id] = until;
      return { fresh };
    });
    if (pruneTimer) clearTimeout(pruneTimer);
    pruneTimer = setTimeout(() => {
      const now = Date.now();
      set((s) => {
        const fresh: Record<string, number> = {};
        for (const [id, t] of Object.entries(s.fresh)) if (t > now) fresh[id] = t;
        return { fresh };
      });
    }, FRESH_MS + 50);
  };

  const receiveDoc = (meetingId: string, doc: NoteDoc, version: number) => {
    const s = get();
    if (s.meetingId !== meetingId) return;
    if (!cleanDoc(doc)) return;
    if (version < s.version) return; // an older run's answer arriving late
    const diff = diffDocs(s.doc, doc);
    const added = s.doc ? diff.added : [];
    set((cur) => ({
      doc,
      version,
      arrivals: added.length ? { seq: cur.arrivals.seq + 1, added } : cur.arrivals,
    }));
    if (s.doc) markFresh([...diff.added, ...diff.changed]);
  };

  const send = async (edits: NoteEdit[]) => {
    const meetingId = get().meetingId;
    if (!meetingId) return;
    let last: NoteDoc | null = null;
    for (const e of edits) last = await saveMeetingNotesEdit(meetingId, e);
    if (cleanDoc(last) && get().meetingId === meetingId) set({ doc: last });
  };

  const fail = (e: unknown) => set({ error: describeError(e) });

  return {
    meetingId: null,
    doc: null,
    version: 0,
    run: null,
    settings: null,
    fresh: {},
    arrivals: { seq: 0, added: [] },
    undoStack: [],
    error: null,

    attach: async (meetingId) => {
      if (get().meetingId !== meetingId) {
        set({ meetingId, doc: null, version: 0, run: null, fresh: {}, arrivals: { seq: 0, added: [] }, undoStack: [], error: null });
      }
      const unlisten: Array<() => void> = [];
      let alive = true;
      const [offState, offDoc] = await Promise.all([
        onNotetakerState((e) => {
          if (alive && e.meeting_id === get().meetingId) set({ run: e });
        }),
        onNotetakerDoc((e) => {
          if (alive) receiveDoc(e.meeting_id, e.doc, e.version);
        }),
      ]);
      unlisten.push(offState, offDoc);
      try {
        const [doc, settings] = await Promise.all([getMeetingNotes(meetingId), getNotetakerSettings()]);
        if (alive && get().meetingId === meetingId) {
          // A newer event may already have arrived; keep it.
          set((cur) => ({
            doc: cur.doc ?? cleanDoc(doc),
            settings: settings && typeof settings === "object" ? settings : cur.settings,
          }));
        }
      } catch (e) {
        if (alive) fail(e);
      }
      return () => {
        alive = false;
        for (const u of unlisten) u();
      };
    },

    reset: () => {
      if (pruneTimer) clearTimeout(pruneTimer);
      set({ meetingId: null, doc: null, version: 0, run: null, fresh: {}, arrivals: { seq: 0, added: [] }, undoStack: [], error: null });
    },

    turnOn: async (scope) => {
      const id = get().meetingId;
      if (!id) return;
      const next = { ...(get().settings ?? DEFAULT_NOTETAKER_SETTINGS), enabled: true, scope };
      set({ settings: next, error: null });
      try {
        await setNotetakerSettings(next);
        await notetakerStart(id);
      } catch (e) {
        fail(e);
      }
    },
    stop: async () => {
      const id = get().meetingId;
      if (!id) return;
      try {
        await notetakerStop(id);
      } catch (e) {
        fail(e);
      }
    },
    start: async () => {
      const id = get().meetingId;
      if (!id) return;
      set({ error: null });
      try {
        await notetakerStart(id);
      } catch (e) {
        fail(e);
      }
    },
    updateNow: async () => {
      const id = get().meetingId;
      if (!id) return;
      set({ error: null });
      try {
        await notetakerUpdateNow(id);
      } catch (e) {
        fail(e);
      }
    },
    keepGoing: async () => {
      const id = get().meetingId;
      if (!id) return;
      try {
        await notetakerContinue(id);
      } catch (e) {
        fail(e);
      }
    },
    patchSettings: async (patch) => {
      const next = { ...(get().settings ?? DEFAULT_NOTETAKER_SETTINGS), ...patch };
      set({ settings: next });
      try {
        await setNotetakerSettings(next);
        // Turning notes on or off from the settings also starts or stops this meeting's run.
        const id = get().meetingId;
        if (id && patch.enabled === true) await notetakerStart(id);
        else if (id && patch.enabled === false) await notetakerStop(id);
      } catch (e) {
        fail(e);
      }
    },

    edit: async (edit, label = "Change") => {
      const doc = get().doc;
      if (!doc) return;
      const back = invertEdit(doc, edit);
      set((s) => ({
        doc: applyEdit(doc, edit),
        undoStack: back.length ? [...s.undoStack, { label, edits: back }].slice(-UNDO_LIMIT) : s.undoStack,
      }));
      try {
        await send([edit]);
      } catch (e) {
        set({ doc });
        fail(e);
      }
    },
    setText: (id, text) => get().edit({ op: "update", id, text }, "Edit"),
    setType: (id, type) => get().edit({ op: "update", id, type }, "Edit"),
    togglePin: async (id) => {
      const b = get().doc?.blocks.find((x) => x.id === id);
      if (b) await get().edit({ op: "update", id, pinned: !b.pinned }, b.pinned ? "Unpin" : "Pin");
    },
    addLine: async (type, parent, text, after) => {
      const id = newUserId();
      await get().edit({ op: "add", id, type, parent, text, after: after ?? null }, "Add");
      return id;
    },
    deleteLine: async (id) => {
      const doc = get().doc;
      if (!doc) return;
      const { edits, undo } = planDelete(doc, id);
      if (!edits.length) return;
      let next = doc;
      for (const e of edits) next = applyEdit(next, e);
      set((s) => ({ doc: next, undoStack: [...s.undoStack, { label: "Delete", edits: undo }].slice(-UNDO_LIMIT) }));
      try {
        await send(edits);
      } catch (e) {
        set({ doc });
        fail(e);
      }
    },
    undo: async () => {
      const { undoStack, doc } = get();
      const top = undoStack[undoStack.length - 1];
      if (!top || !doc) return;
      let next = doc;
      for (const e of top.edits) next = applyEdit(next, e);
      set({ doc: next, undoStack: undoStack.slice(0, -1) });
      try {
        await send(top.edits);
      } catch (e) {
        set({ doc });
        fail(e);
      }
    },
    clearError: () => set({ error: null }),
  };
});
