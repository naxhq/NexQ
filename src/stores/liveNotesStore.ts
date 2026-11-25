import { create } from "zustand";
import type { NoteBlockType, NoteDoc, NoteEdit, NotetakerSettings, NotetakerState } from "../lib/types";
import {
  getMeetingNotes,
  getNotetakerState,
  getNotetakerSettings,
  notetakerContinue,
  notetakerDismissMoved,
  notetakerPause,
  notetakerResume,
  notetakerStart,
  notetakerStop,
  notetakerUpdateNow,
  saveMeetingNotesEdit,
  setNotetakerSettings,
} from "../lib/ipc";
import { onNotetakerDoc, onNotetakerSettingsChanged, onNotetakerState } from "../lib/events";
import { applyEdit, invertEdit, newUserId, planDelete } from "../live-notes/edits";
import { diffDocs } from "../live-notes/page";
import { useMeetingStore } from "./meetingStore";
import { plainError } from "../lib/plainError";

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
  /** 0 until the backend says: it owns the default. */
  cap: 0,
  colors: true,
};

/** A document from the engine, or null when what arrived is not one. */
export function cleanDoc(x: unknown): NoteDoc | null {
  const d = x as NoteDoc | null | undefined;
  return d && Array.isArray(d.blocks) ? d : null;
}

function cleanSettings(x: unknown): NotetakerSettings | null {
  return x && typeof x === "object" ? (x as NotetakerSettings) : null;
}

interface UndoEntry {
  label: string;
  edits: NoteEdit[];
}

/** One meeting's notes as the editor sees them: the live meeting and a past one never share this. */
export interface NotesEntry {
  doc: NoteDoc | null;
  version: number;
  /** Lines that are new or changed, until when (ms epoch). */
  fresh: Record<string, number>;
  /** Bumps when new lines arrive, so the page can count them while the reader is scrolled up. */
  arrivals: { seq: number; added: string[] };
  undoStack: UndoEntry[];
}

export const EMPTY_ENTRY: NotesEntry = { doc: null, version: 0, fresh: {}, arrivals: { seq: 0, added: [] }, undoStack: [] };
const blank = (): NotesEntry => ({ ...EMPTY_ENTRY, fresh: {}, arrivals: { seq: 0, added: [] }, undoStack: [] });

/** The live meeting: the only one a run command may ever touch. */
export function liveMeetingId(): string | null {
  return useMeetingStore.getState().activeMeeting?.id ?? null;
}

export const NO_LIVE_MEETING = "No meeting is running, so there is nothing to change.";

interface LiveNotesState {
  /** Notes by meeting id (the live one and any past one open in meeting details). */
  entries: Record<string, NotesEntry>;
  /** Runs seen by event, by meeting id. */
  runs: Record<string, NotetakerState>;
  /** When the next automatic update is due (ms epoch), from `next_in_ms` at the moment it arrived. */
  deadlines: Record<string, number | null>;
  settings: NotetakerSettings | null;
  /** The last thing that failed, in words. */
  error: string | null;
  /** A refusal that is not a failure ("nothing new to add yet"), in the backend's words. */
  notice: string | null;

  /** Load a meeting's notes and follow it. Never changes which meeting is live. */
  attach: (meetingId: string) => Promise<() => void>;
  /** Follow the settings from either window. */
  watchSettings: () => Promise<() => void>;
  loadSettings: () => Promise<void>;
  reset: () => void;

  // Run controls: the live meeting only.
  turnOn: (scope: NotetakerSettings["scope"]) => Promise<void>;
  stop: () => Promise<void>;
  start: () => Promise<void>;
  /** For the live meeting, or for the ended meeting the panel or tab shows (it runs on the saved transcript). */
  updateNow: (meetingId?: string) => Promise<void>;
  /** Pause this meeting's notes (they can be resumed); `stop` ends them for the meeting. */
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  tryAgain: () => Promise<void>;
  keepGoing: (meetingId?: string) => Promise<void>;
  /** The "moved to an online provider" line has been seen. */
  dismissMoved: (meetingId: string) => Promise<void>;
  patchSettings: (patch: Partial<NotetakerSettings>) => Promise<void>;

  // Edits: the meeting they are about.
  edit: (meetingId: string, edit: NoteEdit, label?: string) => Promise<void>;
  setText: (meetingId: string, id: string, text: string) => Promise<void>;
  setType: (meetingId: string, id: string, type: NoteBlockType) => Promise<void>;
  togglePin: (meetingId: string, id: string) => Promise<void>;
  addLine: (meetingId: string, type: NoteBlockType, parent: string | null, text: string, after?: string | null) => Promise<string>;
  deleteLine: (meetingId: string, id: string) => Promise<void>;
  undo: (meetingId: string) => Promise<void>;
  clearError: () => void;
}

const pruneTimers = new Map<string, ReturnType<typeof setTimeout>>();

export const NOTES_UNREADABLE = "Live notes couldn't be read. Try again.";

/** A backend sentence stays; a JavaScript error becomes a plain sentence. */
function describeError(e: unknown): string {
  return plainError(e, NOTES_UNREADABLE);
}

/** A run state that is not one (null, an empty answer): said, never thrown. */
const isRunState = (s: unknown): s is NotetakerState => !!s && typeof s === "object" && typeof (s as NotetakerState).meeting_id === "string" && typeof (s as NotetakerState).status === "string";

export const useLiveNotesStore = create<LiveNotesState>((set, get) => {
  const entry = (id: string): NotesEntry => get().entries[id] ?? EMPTY_ENTRY;
  const patchEntry = (id: string, fn: (e: NotesEntry) => Partial<NotesEntry>) =>
    set((s) => {
      const cur = s.entries[id] ?? blank();
      return { entries: { ...s.entries, [id]: { ...cur, ...fn(cur) } } };
    });

  const markFresh = (meetingId: string, ids: string[]) => {
    if (ids.length === 0) return;
    const until = Date.now() + FRESH_MS;
    patchEntry(meetingId, (e) => {
      const fresh = { ...e.fresh };
      for (const id of ids) fresh[id] = until;
      return { fresh };
    });
    const old = pruneTimers.get(meetingId);
    if (old) clearTimeout(old);
    pruneTimers.set(
      meetingId,
      setTimeout(() => {
        const now = Date.now();
        patchEntry(meetingId, (e) => {
          const fresh: Record<string, number> = {};
          for (const [id, t] of Object.entries(e.fresh)) if (t > now) fresh[id] = t;
          return { fresh };
        });
      }, FRESH_MS + 50),
    );
  };

  const receiveDoc = (meetingId: string, doc: NoteDoc, version: number) => {
    const cur = get().entries[meetingId];
    if (!cur) return; // nobody is looking at this meeting
    if (!cleanDoc(doc)) return;
    if (version < cur.version) return; // an older run's answer arriving late
    const diff = diffDocs(cur.doc, doc);
    const added = cur.doc ? diff.added : [];
    patchEntry(meetingId, (e) => ({ doc, version, arrivals: added.length ? { seq: e.arrivals.seq + 1, added } : e.arrivals }));
    if (cur.doc) markFresh(meetingId, [...diff.added, ...diff.changed]);
  };

  const send = async (meetingId: string, edits: NoteEdit[]) => {
    let last: NoteDoc | null = null;
    for (const e of edits) last = await saveMeetingNotesEdit(meetingId, e);
    if (cleanDoc(last)) patchEntry(meetingId, () => ({ doc: last }));
  };

  const fail = (e: unknown) => set({ error: describeError(e) });

  const applyState = (s: NotetakerState) => {
    if (!isRunState(s)) {
      set({ error: NOTES_UNREADABLE });
      return;
    }
    set((cur) => ({
      runs: { ...cur.runs, [s.meeting_id]: s },
      deadlines: { ...cur.deadlines, [s.meeting_id]: typeof s.next_in_ms === "number" ? Date.now() + s.next_in_ms : null },
    }));
  };

  /** The live meeting, or a said reason: a command never does nothing in silence. */
  const needLive = (): string | null => {
    const id = liveMeetingId();
    if (!id) set({ error: NO_LIVE_MEETING });
    return id;
  };

  /** Run a command on the live meeting and report what failed. */
  const onLive = async (fn: (id: string) => Promise<unknown>) => {
    const id = needLive();
    if (!id) return;
    set({ error: null });
    try {
      await fn(id);
    } catch (e) {
      fail(e);
    }
  };

  /** The settings as the backend has them now. */
  const reread = async () => {
    const s = cleanSettings(await getNotetakerSettings());
    if (s) set({ settings: s });
    return s;
  };

  /** Stop every run we know of, the live meeting first. Never throws. */
  const stopEverything = async (): Promise<boolean> => {
    const ids = new Set<string>();
    const live = liveMeetingId();
    if (live) ids.add(live);
    for (const [id, r] of Object.entries(get().runs)) if (r.status !== "off" && r.status !== "finished") ids.add(id);
    const results = await Promise.allSettled([...ids].map((id) => notetakerStop(id)));
    return results.every((r) => r.status === "fulfilled");
  };

  return {
    entries: {},
    runs: {},
    deadlines: {},
    settings: null,
    error: null,
    notice: null,

    attach: async (meetingId) => {
      if (!get().entries[meetingId]) patchEntry(meetingId, () => blank());
      let alive = true;
      const [offState, offDoc] = await Promise.all([
        onNotetakerState((e) => {
          if (!alive) return;
          if (!isRunState(e)) applyState(e);
          else if (e.meeting_id === meetingId) applyState(e);
        }),
        onNotetakerDoc((e) => {
          if (alive && e && e.meeting_id === meetingId) receiveDoc(meetingId, e.doc, e.version);
        }),
      ]);
      // A reopened window shows the true state, not the last event it happened to hear.
      void getNotetakerState(meetingId)
        .then((s) => alive && applyState(s))
        .catch((e) => alive && fail(e));
      try {
        const [doc, settings] = await Promise.all([getMeetingNotes(meetingId), getNotetakerSettings()]);
        if (alive) {
          // A newer event may already have arrived; keep it.
          patchEntry(meetingId, (e) => ({ doc: e.doc ?? cleanDoc(doc) }));
          const s = cleanSettings(settings);
          if (s) set({ settings: s });
        }
      } catch (e) {
        if (alive) fail(e);
      }
      return () => {
        alive = false;
        offState();
        offDoc();
      };
    },

    watchSettings: async () => {
      const off = await onNotetakerSettingsChanged((s) => {
        const next = cleanSettings(s);
        if (next) set({ settings: next });
      });
      await get().loadSettings();
      return off;
    },
    loadSettings: async () => {
      try {
        await reread();
      } catch (e) {
        fail(e);
      }
    },

    reset: () => {
      for (const t of pruneTimers.values()) clearTimeout(t);
      pruneTimers.clear();
      set({ entries: {}, runs: {}, deadlines: {}, error: null, notice: null });
    },

    turnOn: async (scope) => {
      set({ error: null });
      try {
        const merged = cleanSettings(await setNotetakerSettings({ enabled: true, scope }));
        if (merged) set({ settings: merged });
        const live = liveMeetingId();
        if (live) await notetakerStart(live);
      } catch (e) {
        fail(e);
        void reread().catch(() => {});
      }
    },
    stop: async () => {
      // Stopping this meeting's notes is "off for now": attempt it, then show the truth.
      const ok = await stopEverything();
      if (!ok) set({ error: "Could not stop the notes. Try again." });
    },
    start: () => onLive((id) => notetakerStart(id)),
    updateNow: async (meetingId) => {
      const id = meetingId ?? needLive();
      if (!id) return;
      set({ error: null, notice: null });
      try {
        await notetakerUpdateNow(id);
      } catch (e) {
        // "Nothing new yet" and other refusals come with a reason: say it, it is not a failure.
        set({ notice: describeError(e) });
      }
    },
    pause: () => onLive((id) => notetakerPause(id)),
    resume: () => onLive((id) => notetakerResume(id)),
    tryAgain: () => onLive((id) => notetakerStart(id)),
    dismissMoved: async (meetingId) => {
      try {
        await notetakerDismissMoved(meetingId);
      } catch (e) {
        fail(e);
      }
    },
    keepGoing: async (meetingId) => {
      const id = meetingId ?? needLive();
      if (!id) return;
      set({ error: null });
      try {
        await notetakerContinue(id);
      } catch (e) {
        fail(e);
      }
    },

    patchSettings: async (patch) => {
      if (patch.enabled === false) {
        // Off must never be claimed unless it is true: try both, then read the truth.
        const [saved, stopped] = await Promise.allSettled([setNotetakerSettings(patch), stopEverything()]);
        let truth: NotetakerSettings | null = null;
        try {
          truth = await reread();
        } catch {
          truth = null;
        }
        const clean = saved.status === "fulfilled" && stopped.status === "fulfilled" && stopped.value;
        if (!truth) set({ error: "Could not confirm whether the notes are off. Check again before you rely on it." });
        else if (!clean || truth.enabled) set({ error: "Notes may still be running. Try turning them off again." });
        return;
      }
      const before = get().settings;
      if (before) set({ settings: { ...before, ...patch } });
      try {
        const merged = cleanSettings(await setNotetakerSettings(patch));
        if (merged) set({ settings: merged });
        const live = liveMeetingId();
        if (live && patch.enabled === true) await notetakerStart(live);
      } catch (e) {
        fail(e);
        void reread().catch(() => {});
      }
    },

    edit: async (meetingId, edit, label = "Change") => {
      const doc = entry(meetingId).doc;
      if (!doc) return;
      const back = invertEdit(doc, edit);
      patchEntry(meetingId, (e) => ({
        doc: applyEdit(doc, edit),
        undoStack: back.length ? [...e.undoStack, { label, edits: back }].slice(-UNDO_LIMIT) : e.undoStack,
      }));
      try {
        await send(meetingId, [edit]);
      } catch (e) {
        patchEntry(meetingId, () => ({ doc }));
        fail(e);
      }
    },
    setText: (m, id, text) => get().edit(m, { op: "update", id, text }, "Edit"),
    setType: (m, id, type) => get().edit(m, { op: "update", id, type }, "Edit"),
    togglePin: async (m, id) => {
      const b = entry(m).doc?.blocks.find((x) => x.id === id);
      if (b) await get().edit(m, { op: "update", id, pinned: !b.pinned }, b.pinned ? "Unpin" : "Pin");
    },
    addLine: async (m, type, parent, text, after) => {
      const id = newUserId();
      await get().edit(m, { op: "add", id, type, parent, text, after: after ?? null }, "Add");
      return id;
    },
    deleteLine: async (m, id) => {
      const doc = entry(m).doc;
      if (!doc) return;
      const { edits, undo } = planDelete(doc, id);
      if (!edits.length) return;
      let next = doc;
      for (const e of edits) next = applyEdit(next, e);
      patchEntry(m, (e) => ({ doc: next, undoStack: [...e.undoStack, { label: "Delete", edits: undo }].slice(-UNDO_LIMIT) }));
      try {
        await send(m, edits);
      } catch (e) {
        patchEntry(m, () => ({ doc }));
        fail(e);
      }
    },
    undo: async (m) => {
      const { undoStack, doc } = entry(m);
      const top = undoStack[undoStack.length - 1];
      if (!top || !doc) return;
      let next = doc;
      for (const e of top.edits) next = applyEdit(next, e);
      patchEntry(m, () => ({ doc: next, undoStack: undoStack.slice(0, -1) }));
      try {
        await send(m, top.edits);
      } catch (e) {
        patchEntry(m, () => ({ doc }));
        fail(e);
      }
    },
    clearError: () => set({ error: null, notice: null }),
  };
});
