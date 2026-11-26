/**
 * Talking points: the notes of each workspace, autosave, and what the meeting
 * panel remembers (last note, reading settings, "only this meeting" copies,
 * "said it" progress).
 *
 * Saving never loses an edit: the newest document stays in memory until the
 * backend has it. A failed save keeps it, shows "Not saved" and retries with
 * back-off, at once when the network comes back, and on demand.
 */
import { create } from "zustand";
import {
  copyTalkingPoint,
  deleteTalkingPoint,
  getMeetingPointEdit,
  getPointProgress,
  listTalkingPoints,
  reorderTalkingPoints,
  saveMeetingPointEdit,
  savePointProgress,
  createTalkingPoint,
  patchTalkingPoint,
} from "../lib/ipc";
import type { PointSaid, TalkingPoint } from "../lib/types";
import {
  cleanTitle,
  docPlainText,
  emptyDoc,
  parseDoc,
  reidDoc,
  serializeDoc,
  type TpDoc,
} from "../talking-points/doc/model";
import { docToMarkdown } from "../talking-points/doc/markdown";
import { onWorkspacesChanged } from "../lib/events";

export type SaveState = "saved" | "dirty" | "saving" | "failed" | "conflict";
export type ScrollKind = "manual" | "auto" | "voice";
/** How the three states of a line (what is left, what is covered, what you said) are drawn. */
export type TextStyleId = "classic" | "checked" | "highlight" | "focus" | "contrast";
/** How the notes of a workspace are ordered in the list. "manual" is the drag order the backend keeps. */
export type NoteSort = "manual" | "newest" | "oldest" | "edited" | "az";
export const NOTE_SORTS: readonly NoteSort[] = ["manual", "newest", "oldest", "edited", "az"];

export const TEXT_STYLE_IDS: readonly TextStyleId[] = ["classic", "checked", "highlight", "focus", "contrast"];
export const DEFAULT_TEXT_STYLE: TextStyleId = "classic";

export interface ReadingSettings {
  /** Reading text size in px (the unit the user sees). */
  fontSize: number;
  /** Line height multiplier. */
  lineSpacing: number;
  wpm: number;
  mode: ScrollKind;
  /** "Said it" ticking (local, switchable). */
  saidIt: boolean;
  /** Offer "Go to" when you stray to another point. */
  suggest: boolean;
  /** Style preset for the line states; Classic is the look from before the setting existed. */
  textStyle: TextStyleId;
}

export const READING_LIMITS = {
  fontSize: { min: 14, max: 56, step: 2 },
  lineSpacing: { min: 1.2, max: 2.2, step: 0.1 },
  wpm: { min: 60, max: 260, step: 10 },
} as const;

export const DEFAULT_READING: ReadingSettings = { fontSize: 26, lineSpacing: 1.5, wpm: 140, mode: "manual", saidIt: true, suggest: true, textStyle: DEFAULT_TEXT_STYLE };

const PREFS_KEY = "nexq-talking-points-v1";
const AUTOSAVE_MS = 800;
const PROGRESS_MS = 1500;
const RETRY_MS = [2000, 5000, 15000, 30000, 60000];
const MAX_RECENT = 12;

interface Prefs {
  reading: ReadingSettings;
  lastNote: Record<string, string>;
  recent: Record<string, string[]>;
  /** The list order chosen per workspace (absent: manual). */
  noteSort: Record<string, NoteSort>;
}

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
}

export function loadPrefs(): Prefs {
  const base: Prefs = { reading: { ...DEFAULT_READING }, lastNote: {}, recent: {}, noteSort: {} };
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(PREFS_KEY) : null;
    if (!raw) return base;
    const p = JSON.parse(raw) as Partial<Prefs>;
    const r = (p.reading ?? {}) as Partial<ReadingSettings>;
    const L = READING_LIMITS;
    base.reading = {
      fontSize: clampNum(r.fontSize, L.fontSize.min, L.fontSize.max, DEFAULT_READING.fontSize),
      lineSpacing: clampNum(r.lineSpacing, L.lineSpacing.min, L.lineSpacing.max, DEFAULT_READING.lineSpacing),
      wpm: clampNum(r.wpm, L.wpm.min, L.wpm.max, DEFAULT_READING.wpm),
      mode: r.mode === "auto" || r.mode === "voice" || r.mode === "manual" ? r.mode : "manual",
      saidIt: r.saidIt !== false,
      suggest: r.suggest !== false,
      textStyle: TEXT_STYLE_IDS.includes(r.textStyle as TextStyleId) ? (r.textStyle as TextStyleId) : DEFAULT_TEXT_STYLE,
    };
    if (p.lastNote && typeof p.lastNote === "object") {
      for (const [k, v] of Object.entries(p.lastNote)) if (typeof v === "string") base.lastNote[k] = v;
    }
    if (p.noteSort && typeof p.noteSort === "object") {
      for (const [k, v] of Object.entries(p.noteSort)) if (NOTE_SORTS.includes(v as NoteSort)) base.noteSort[k] = v as NoteSort;
    }
    if (p.recent && typeof p.recent === "object") {
      for (const [k, v] of Object.entries(p.recent)) {
        if (Array.isArray(v)) base.recent[k] = v.filter((x): x is string => typeof x === "string").slice(0, MAX_RECENT);
      }
    }
  } catch {
    /* private window or damaged value: defaults */
  }
  return base;
}

function writePrefs(p: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

function uid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `tp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function message(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return "Could not save";
}

// -- pending autosaves (module state: timers are not render state) -----------------------------

/** The fields autosave sends. `in_context` is its own immediate patch, never part of this. */
type TextFields = Pick<TalkingPoint, "title" | "doc_json" | "markdown" | "plain_text">;

interface Pending {
  workspaceId: string;
  /** Only what changed locally and the backend does not have yet. */
  dirty: Partial<TextFields>;
  /** Values the dirty fields had before our first edit (to tell a real clash from an unrelated change). */
  orig: Partial<TextFields>;
  /** `updated_at` of the backend copy our edits are based on. */
  base: number;
  timer: ReturnType<typeof setTimeout> | null;
  attempt: number;
  inFlight: Promise<void> | null;
  /** Changed in another window while we had unsaved edits. */
  conflict: boolean;
}
const pending = new Map<string, Pending>();
/** Notes deleted in this session: no save, reload or merge may bring them back. */
const tombstones = new Set<string>();
const progressTimers = new Map<string, ReturnType<typeof setTimeout>>();
const progressLatest = new Map<string, { meetingId: string; pointId: string; said: PointSaid[] }>();

function isErr(e: unknown, code: "not_found" | "conflict"): boolean {
  return message(e).toLowerCase().includes(code);
}

interface TalkingPointsState {
  byWorkspace: Record<string, TalkingPoint[]>;
  loading: Record<string, boolean>;
  loadError: Record<string, string | null>;
  saveState: Record<string, SaveState>;
  saveError: Record<string, string | null>;
  /** Bumped when a note's text was replaced from the backend, so an open editor reloads it. */
  docRev: Record<string, number>;
  /** The other window's copy of a note we have a conflict on (to show both). */
  theirs: Record<string, TalkingPoint>;
  /** The base note as it was when a meeting-only edit began (so "save to workspace" says which version it was made from). */
  meetingBase: Record<string, { updated_at: number; doc_json: string; title: string }>;
  /** Last error of a list action (reorder, copy, delete). */
  actionError: string | null;

  reading: ReadingSettings;
  lastNote: Record<string, string>;
  recent: Record<string, string[]>;
  /** The list order chosen per workspace (absent: manual). */
  noteSort: Record<string, NoteSort>;

  /** "Only this meeting" documents (JSON text) by point id, for the open meeting. */
  meetingEdits: Record<string, string>;
  /** "Said it" state by point id, for the open meeting. */
  progress: Record<string, PointSaid[]>;
  progressError: string | null;

  load: (workspaceId: string) => Promise<void>;
  /** Reloads every loaded workspace (or one) keeping unsaved local edits. */
  syncFromBackend: (workspaceId?: string | null) => Promise<void>;
  create: (workspaceId: string, init?: { title?: string; doc?: TpDoc; in_context?: boolean }) => Promise<TalkingPoint | null>;
  edit: (id: string, patch: { title?: string; doc?: TpDoc }) => void;
  setInContext: (id: string, value: boolean) => Promise<void>;
  flush: (id: string) => Promise<void>;
  flushAll: () => Promise<void>;
  retry: (id: string) => void;
  resolveConflict: (id: string, which: "mine" | "theirs") => Promise<void>;
  loadTheirs: (id: string) => Promise<TalkingPoint | null>;
  beginMeetingEdit: (pointId: string) => void;
  /** The editor was closed without saving to the workspace: the base only stays if a meeting-only copy still rests on it. */
  endMeetingEdit: (pointId: string) => void;
  duplicate: (id: string) => Promise<TalkingPoint | null>;
  copyTo: (id: string, workspaceId: string) => Promise<TalkingPoint | null>;
  remove: (id: string) => Promise<void>;
  reorder: (workspaceId: string, ids: string[]) => Promise<void>;
  find: (id: string) => TalkingPoint | undefined;

  setReading: (patch: Partial<ReadingSettings>) => void;
  setNoteSort: (workspaceId: string, sort: NoteSort) => void;
  rememberNote: (workspaceId: string, pointId: string) => void;

  loadMeetingState: (meetingId: string, pointId: string) => Promise<void>;
  saveMeetingOnly: (meetingId: string, pointId: string, doc: TpDoc) => Promise<void>;
  saveToWorkspace: (meetingId: string, pointId: string, doc: TpDoc) => Promise<void>;
  discardMeetingEdit: (meetingId: string, pointId: string) => Promise<void>;
  setProgress: (meetingId: string, pointId: string, said: PointSaid[]) => void;
  flushProgress: () => Promise<void>;
  resetMeeting: () => void;
}

function derived(doc: TpDoc): Pick<TalkingPoint, "doc_json" | "markdown" | "plain_text"> {
  return { doc_json: serializeDoc(doc), markdown: docToMarkdown(doc), plain_text: docPlainText(doc) };
}

export const useTalkingPointsStore = create<TalkingPointsState>((set, get) => {
  const prefs = loadPrefs();

  const savePrefs = () => {
    const s = get();
    writePrefs({ reading: s.reading, lastNote: s.lastNote, recent: s.recent, noteSort: s.noteSort });
  };

  /** Puts a point into its workspace list (never a deleted one). */
  const upsert = (point: TalkingPoint) => {
    if (tombstones.has(point.id)) return;
    set((s) => {
      const list = s.byWorkspace[point.workspace_id];
      if (!list) return s;
      const i = list.findIndex((p) => p.id === point.id);
      const next = i >= 0 ? list.map((p, k) => (k === i ? point : p)) : [...list, point];
      return { byWorkspace: { ...s.byWorkspace, [point.workspace_id]: next } };
    });
  };

  const drop = (id: string) =>
    set((s) => {
      const byWorkspace: Record<string, TalkingPoint[]> = {};
      for (const [ws, list] of Object.entries(s.byWorkspace)) byWorkspace[ws] = list.filter((p) => p.id !== id);
      return { byWorkspace };
    });

  const bumpRev = (id: string) => set((s) => ({ docRev: { ...s.docRev, [id]: (s.docRev[id] ?? 0) + 1 } }));

  const setSave = (id: string, state: SaveState, error: string | null = null) =>
    set((s) => ({ saveState: { ...s.saveState, [id]: state }, saveError: { ...s.saveError, [id]: error } }));

  const scheduleRetry = (id: string) => {
    const p = pending.get(id);
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    const wait = RETRY_MS[Math.min(Math.max(0, p.attempt - 1), RETRY_MS.length - 1)];
    p.timer = setTimeout(() => void get().flush(id), wait);
  };

  /** The note as the user sees it: backend copy with unsaved fields on top. */
  const withDirty = (server: TalkingPoint, e: Pending | undefined): TalkingPoint => (e ? { ...server, ...e.dirty } : server);

  const forget = (id: string) => {
    const e = pending.get(id);
    if (e?.timer) clearTimeout(e.timer);
    pending.delete(id);
  };

  /** The backend says the note is gone: stop saving it, remove it, say so. */
  const vanished = (id: string) => {
    tombstones.add(id);
    forget(id);
    drop(id);
    set({ actionError: "That note was deleted in another window." });
  };

  const upsertNew = (p: TalkingPoint) => {
    tombstones.delete(p.id);
    set((s) => {
      const list = s.byWorkspace[p.workspace_id];
      if (!list || list.some((x) => x.id === p.id)) return s;
      return { byWorkspace: { ...s.byWorkspace, [p.workspace_id]: [...list, p] } };
    });
  };

  /**
   * Takes the backend's list of a workspace, keeping what is not saved yet. A note with
   * unsaved fields keeps them (they win); if the same fields also changed elsewhere it
   * is marked as a conflict for the user to settle. Deleted-here notes stay deleted.
   */
  const applyServerList = (ws: string, list: TalkingPoint[]) => {
    const prev = get().byWorkspace[ws] ?? [];
    const out: TalkingPoint[] = [];
    const seen = new Set<string>();
    const reload: string[] = [];
    for (const p of list) {
      if (tombstones.has(p.id)) continue;
      seen.add(p.id);
      const e = pending.get(p.id);
      const local = prev.find((x) => x.id === p.id);
      if (e && Object.keys(e.dirty).length > 0) {
        if (!e.inFlight) {
          // the backend copy is still the revision our edits are based on: nobody else changed it
          const clash =
            p.updated_at !== e.base &&
            (Object.keys(e.dirty) as Array<keyof TextFields>).some((k) => e.orig[k] !== undefined && p[k] !== e.orig[k] && p[k] !== e.dirty[k]);
          if (clash && !e.conflict) {
            e.conflict = true;
            if (e.timer) clearTimeout(e.timer);
            e.timer = null;
            set((s) => ({ theirs: { ...s.theirs, [p.id]: p } }));
            setSave(p.id, "conflict", "Changed in another window");
          } else if (!clash) {
            e.base = p.updated_at;
          }
        }
        out.push({ ...p, ...e.dirty });
        continue;
      }
      // Same revision as the copy we hold: our own save coming back (or nothing new). Never a reason to reload,
      // whatever the text compare says. A different revision with different text is another window's change.
      if (local && local.updated_at !== p.updated_at && local.doc_json !== p.doc_json) reload.push(p.id);
      out.push(p);
    }
    // unsaved notes the backend no longer lists stay until their save is refused ("not_found")
    for (const x of prev) if (!seen.has(x.id) && pending.has(x.id) && !tombstones.has(x.id)) out.push(x);
    out.sort((a, b) => a.sort - b.sort);
    set((s) => ({ byWorkspace: { ...s.byWorkspace, [ws]: out } }));
    for (const id of reload) bumpRev(id);
  };

  /**
   * The backend refused a save because the note moved on. If the other window changed fields we did not touch, our
   * edits go on top of its version (nothing is lost on either side). If we both changed the same field, nothing is
   * written and the person chooses (keep mine, use theirs, see both).
   */
  const rebaseOrConflict = async (id: string, entry: Pending) => {
    let theirs: TalkingPoint | undefined;
    try {
      theirs = (await listTalkingPoints(entry.workspaceId)).find((p) => p.id === id);
    } catch {
      entry.conflict = true;
      setSave(id, "conflict", "Changed in another window");
      return;
    }
    if (!theirs) return vanished(id);
    const keys = Object.keys(entry.dirty) as Array<keyof TextFields>;
    const disjoint = keys.every((k) => entry.orig[k] !== undefined && theirs![k] === entry.orig[k]);
    if (disjoint) {
      entry.base = theirs.updated_at;
      entry.attempt = 0;
      upsert({ ...theirs, ...entry.dirty });
      setSave(id, "dirty");
      entry.timer = setTimeout(() => void get().flush(id), 0);
      return;
    }
    entry.conflict = true;
    set((s) => ({ theirs: { ...s.theirs, [id]: theirs! } }));
    setSave(id, "conflict", "Changed in another window");
  };

  return {
    byWorkspace: {},
    loading: {},
    loadError: {},
    saveState: {},
    saveError: {},
    docRev: {},
    theirs: {},
    meetingBase: {},
    actionError: null,
    reading: prefs.reading,
    lastNote: prefs.lastNote,
    recent: prefs.recent,
    noteSort: prefs.noteSort,
    meetingEdits: {},
    progress: {},
    progressError: null,

    find: (id) => {
      if (tombstones.has(id)) return undefined;
      for (const list of Object.values(get().byWorkspace)) {
        const hit = list.find((p) => p.id === id);
        if (hit) return hit;
      }
      return undefined;
    },

    load: async (workspaceId) => {
      set((s) => ({ loading: { ...s.loading, [workspaceId]: true }, loadError: { ...s.loadError, [workspaceId]: null } }));
      try {
        const list = await listTalkingPoints(workspaceId);
        applyServerList(workspaceId, list);
        set((s) => ({ loading: { ...s.loading, [workspaceId]: false } }));
      } catch (e) {
        set((s) => ({
          loading: { ...s.loading, [workspaceId]: false },
          loadError: { ...s.loadError, [workspaceId]: message(e) },
        }));
      }
    },

    syncFromBackend: async (workspaceId) => {
      const ids = workspaceId && get().byWorkspace[workspaceId] ? [workspaceId] : Object.keys(get().byWorkspace);
      await Promise.all(
        ids.map(async (ws) => {
          try {
            applyServerList(ws, await listTalkingPoints(ws));
          } catch {
            /* the next change or a manual reload tries again; local edits are untouched */
          }
        }),
      );
    },

    create: async (workspaceId, init) => {
      const doc = init?.doc ?? emptyDoc();
      let created: TalkingPoint;
      try {
        // one atomic call with everything, the flag explicit: notes are AI context unless the source says otherwise
        created = await createTalkingPoint(workspaceId, cleanTitle(init?.title ?? "", "Untitled note"), {
          ...derived(doc),
          in_context: init?.in_context ?? true,
        });
      } catch (e) {
        set({ actionError: message(e) });
        return null;
      }
      upsertNew(created);
      setSave(created.id, "saved");
      return created;
    },

    edit: (id, patch) => {
      if (tombstones.has(id)) return;
      const current = get().find(id);
      if (!current) return;
      const fields: Partial<TextFields> = {};
      if (patch.title !== undefined) fields.title = cleanTitle(patch.title, "Untitled note");
      if (patch.doc) Object.assign(fields, derived(patch.doc));
      let e = pending.get(id);
      if (!e) {
        e = { workspaceId: current.workspace_id, dirty: {}, orig: {}, base: current.updated_at, timer: null, attempt: 0, inFlight: null, conflict: false };
        pending.set(id, e);
      }
      for (const k of Object.keys(fields) as Array<keyof TextFields>) if (!(k in e.orig)) e.orig[k] = current[k];
      Object.assign(e.dirty, fields);
      upsert({ ...current, ...fields });
      if (e.conflict) {
        setSave(id, "conflict");
        return;
      }
      setSave(id, "dirty");
      if (e.timer) clearTimeout(e.timer);
      e.attempt = 0;
      e.timer = setTimeout(() => void get().flush(id), AUTOSAVE_MS);
    },

    setInContext: async (id, value) => {
      const before = get().find(id);
      if (!before || tombstones.has(id)) return;
      upsert({ ...before, in_context: value });
      try {
        const saved = await patchTalkingPoint(id, { in_context: value });
        if (tombstones.has(id)) return;
        const e = pending.get(id);
        // the backend copy moved on by our own change; text edits are still based on it
        if (e && !e.conflict) e.base = saved.updated_at;
        const cur = get().find(id);
        if (cur) upsert({ ...cur, in_context: saved.in_context, updated_at: e ? cur.updated_at : saved.updated_at });
      } catch (e) {
        if (isErr(e, "not_found")) return vanished(id);
        const cur = get().find(id);
        if (cur) upsert({ ...cur, in_context: before.in_context });
        set({ actionError: message(e) });
      }
    },

    flush: async (id) => {
      const entry = pending.get(id);
      if (!entry || tombstones.has(id)) return;
      if (entry.inFlight) return entry.inFlight;
      if (entry.conflict) return;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
      const sent = { ...entry.dirty };
      if (Object.keys(sent).length === 0) {
        pending.delete(id);
        setSave(id, "saved");
        return;
      }
      setSave(id, "saving");
      const run = (async () => {
        try {
          const saved = await patchTalkingPoint(id, sent, entry.base);
          if (tombstones.has(id) || pending.get(id) !== entry) return;
          entry.base = saved.updated_at;
          for (const k of Object.keys(sent) as Array<keyof TextFields>) if (entry.dirty[k] === sent[k]) {
              delete entry.dirty[k];
              delete entry.orig[k];
            }
          const cur = get().find(id);
          if (cur) upsert({ ...cur, sort: saved.sort, updated_at: saved.updated_at });
          if (Object.keys(entry.dirty).length === 0) {
            pending.delete(id);
            setSave(id, "saved");
          } else {
            // typed while saving: the newer text goes next
            entry.attempt = 0;
            setSave(id, "dirty");
            entry.timer = setTimeout(() => void get().flush(id), 0);
          }
        } catch (e) {
          if (tombstones.has(id) || pending.get(id) !== entry) return;
          if (isErr(e, "not_found")) return vanished(id);
          if (isErr(e, "conflict")) {
            await rebaseOrConflict(id, entry);
            return;
          }
          entry.attempt += 1;
          setSave(id, "failed", message(e));
          scheduleRetry(id);
        }
      })();
      entry.inFlight = run;
      try {
        await run;
      } finally {
        if (entry.inFlight === run) entry.inFlight = null;
      }
    },

    flushAll: async () => {
      await Promise.all([...pending.keys()].map((id) => get().flush(id)));
    },

    retry: (id) => {
      const entry = pending.get(id);
      if (entry) entry.attempt = 0;
      void get().flush(id);
    },

    resolveConflict: async (id, which) => {
      const entry = pending.get(id);
      const cur = get().find(id);
      if (!cur) return;
      let theirs: TalkingPoint | undefined;
      try {
        theirs = (await listTalkingPoints(cur.workspace_id)).find((p) => p.id === id);
      } catch (e) {
        set({ actionError: message(e) });
        return;
      }
      if (!theirs) return vanished(id);
      set((st) => {
        const t = { ...st.theirs };
        delete t[id];
        return { theirs: t };
      });
      if (which === "theirs") {
        forget(id);
        upsert(theirs);
        bumpRev(id);
        setSave(id, "saved");
        return;
      }
      if (!entry) return;
      entry.conflict = false;
      entry.base = theirs.updated_at;
      entry.attempt = 0;
      upsert({ ...theirs, ...entry.dirty });
      setSave(id, "dirty");
      await get().flush(id);
    },

    loadTheirs: async (id) => {
      const cur = get().find(id);
      if (!cur) return get().theirs[id] ?? null;
      try {
        const t = (await listTalkingPoints(cur.workspace_id)).find((p) => p.id === id) ?? null;
        if (t) set((s) => ({ theirs: { ...s.theirs, [id]: t } }));
        return t;
      } catch {
        return get().theirs[id] ?? null;
      }
    },

    beginMeetingEdit: (pointId) => {
      const n = get().find(pointId);
      // a meeting-only copy already rests on its own base; otherwise every editing session starts from the version on screen now
      if (!n || (get().meetingBase[pointId] && get().meetingEdits[pointId] !== undefined)) return;
      set((s) => ({ meetingBase: { ...s.meetingBase, [pointId]: { updated_at: n.updated_at, doc_json: n.doc_json, title: n.title } } }));
    },

    endMeetingEdit: (pointId) => {
      if (get().meetingEdits[pointId] !== undefined) return;
      set((s) => {
        const mb = { ...s.meetingBase };
        delete mb[pointId];
        return { meetingBase: mb };
      });
    },

    duplicate: async (id) => {
      const src = get().find(id);
      if (!src) return null;
      // the copy is born with the source's own flag
      return get().create(src.workspace_id, { title: `${src.title} copy`, doc: reidDoc(parseDoc(src.doc_json)), in_context: src.in_context });
    },

    copyTo: async (id, workspaceId) => {
      await get().flush(id);
      try {
        const copy = await copyTalkingPoint(id, workspaceId);
        set((s) => {
          const list = s.byWorkspace[workspaceId];
          return list ? { byWorkspace: { ...s.byWorkspace, [workspaceId]: [...list, copy] }, actionError: null } : { actionError: null };
        });
        return copy;
      } catch (e) {
        set({ actionError: message(e) });
        return null;
      }
    },

    remove: async (id) => {
      const src = get().find(id);
      const entry = pending.get(id);
      // from now on nothing may save or bring the note back
      tombstones.add(id);
      if (entry?.timer) clearTimeout(entry.timer);
      entry && (entry.timer = null);
      if (entry?.inFlight) await entry.inFlight.catch(() => undefined);
      try {
        await deleteTalkingPoint(id);
      } catch (e) {
        if (isErr(e, "not_found")) {
          forget(id);
          drop(id);
          return;
        }
        // still there: take the tombstone back and keep trying to save what it had
        tombstones.delete(id);
        if (entry && pending.get(id) === entry && Object.keys(entry.dirty).length) scheduleRetry(id);
        set({ actionError: message(e) });
        return;
      }
      forget(id);
      if (src) drop(id);
      set({ actionError: null });
    },

    reorder: async (workspaceId, ids) => {
      const before = get().byWorkspace[workspaceId] ?? [];
      const byId = new Map(before.map((p) => [p.id, p]));
      const next = ids.map((id, i) => ({ ...byId.get(id)!, sort: i })).filter((p) => p.id);
      if (next.length !== before.length) return;
      set((s) => ({ byWorkspace: { ...s.byWorkspace, [workspaceId]: next } }));
      try {
        await reorderTalkingPoints(workspaceId, ids);
        set({ actionError: null });
      } catch (e) {
        set((s) => ({ byWorkspace: { ...s.byWorkspace, [workspaceId]: before }, actionError: message(e) }));
      }
    },

    setReading: (patch) => {
      set((s) => ({ reading: { ...s.reading, ...patch } }));
      savePrefs();
    },

    setNoteSort: (workspaceId, sort) => {
      set((s) => ({ noteSort: { ...s.noteSort, [workspaceId]: sort } }));
      savePrefs();
    },

    rememberNote: (workspaceId, pointId) => {
      set((s) => ({
        lastNote: { ...s.lastNote, [workspaceId]: pointId },
        recent: { ...s.recent, [workspaceId]: [pointId, ...(s.recent[workspaceId] ?? []).filter((x) => x !== pointId)].slice(0, MAX_RECENT) },
      }));
      savePrefs();
    },

    loadMeetingState: async (meetingId, pointId) => {
      try {
        const [edit, prog] = await Promise.all([getMeetingPointEdit(meetingId, pointId), getPointProgress(meetingId, pointId)]);
        set((s) => {
          const edits = { ...s.meetingEdits };
          if (edit) edits[pointId] = edit;
          else delete edits[pointId];
          // a meeting edit made earlier: its base is the version we know now (the best we can say)
          const known = Object.values(s.byWorkspace).flat().find((p) => p.id === pointId);
          const meetingBase =
            edit && known && !s.meetingBase[pointId]
              ? { ...s.meetingBase, [pointId]: { updated_at: known.updated_at, doc_json: known.doc_json, title: known.title } }
              : s.meetingBase;
          return { meetingEdits: edits, meetingBase, progress: { ...s.progress, [pointId]: prog?.said ?? s.progress[pointId] ?? [] }, progressError: null };
        });
      } catch (e) {
        set({ progressError: message(e) });
      }
    },

    saveMeetingOnly: async (meetingId, pointId, doc) => {
      const json = serializeDoc(doc);
      set((s) => ({ meetingEdits: { ...s.meetingEdits, [pointId]: json } }));
      await saveMeetingPointEdit(meetingId, pointId, json);
    },

    saveToWorkspace: async (meetingId, pointId, doc) => {
      const cur = get().find(pointId);
      if (!cur) throw new Error("This note was deleted in another window");
      // the version the meeting edit was made from; the backend refuses a save from any other
      const base = get().meetingBase[pointId] ?? { updated_at: cur.updated_at, doc_json: cur.doc_json, title: cur.title };
      let theirs: TalkingPoint | undefined;
      let known = true;
      try {
        theirs = (await listTalkingPoints(cur.workspace_id)).find((p) => p.id === pointId);
      } catch {
        known = false; // the backend still decides, by revision
      }
      if (known && !theirs) {
        vanished(pointId);
        throw new Error("This note was deleted in another window");
      }
      let baseRev = base.updated_at;
      let clash = false;
      if (theirs && theirs.updated_at !== base.updated_at) {
        upsert(theirs); // their changes to the other fields stay
        // the same writing is not a clash (block ids differ between two documents of the same text)
        const sameText = docToMarkdown(parseDoc(theirs.doc_json)) === docToMarkdown(doc);
        clash = theirs.doc_json !== base.doc_json && !sameText;
        baseRev = theirs.updated_at;
        if (clash) set((s) => ({ theirs: { ...s.theirs, [pointId]: theirs! } }));
      }
      get().edit(pointId, { doc });
      const entry = pending.get(pointId);
      if (entry) {
        entry.base = baseRev;
        if (clash) {
          entry.conflict = true;
          if (entry.timer) clearTimeout(entry.timer);
          entry.timer = null;
          setSave(pointId, "conflict", "Changed in another window");
        }
      }
      if (clash) throw new Error("Changed in another window");
      await get().flush(pointId);
      if (get().saveState[pointId] === "failed" || get().saveState[pointId] === "conflict") throw new Error(get().saveError[pointId] ?? "Could not save");
      set((s) => {
        const edits = { ...s.meetingEdits };
        delete edits[pointId];
        // the base is now the version just saved (the meeting copy is gone)
        const saved = Object.values(s.byWorkspace).flat().find((p) => p.id === pointId);
        const mb = { ...s.meetingBase };
        if (saved) mb[pointId] = { updated_at: saved.updated_at, doc_json: saved.doc_json, title: saved.title };
        else delete mb[pointId];
        return { meetingEdits: edits, meetingBase: mb };
      });
      await saveMeetingPointEdit(meetingId, pointId, null);
    },

    discardMeetingEdit: async (meetingId, pointId) => {
      set((s) => {
        const edits = { ...s.meetingEdits };
        delete edits[pointId];
        const mb = { ...s.meetingBase };
        delete mb[pointId];
        return { meetingEdits: edits, meetingBase: mb };
      });
      await saveMeetingPointEdit(meetingId, pointId, null);
    },

    setProgress: (meetingId, pointId, said) => {
      set((s) => ({ progress: { ...s.progress, [pointId]: said } }));
      const key = `${meetingId}:${pointId}`;
      progressLatest.set(key, { meetingId, pointId, said });
      const old = progressTimers.get(key);
      if (old) clearTimeout(old);
      progressTimers.set(
        key,
        setTimeout(() => {
          progressTimers.delete(key);
          const job = progressLatest.get(key);
          if (!job) return;
          progressLatest.delete(key);
          savePointProgress(job.meetingId, job.pointId, job.said)
            .then(() => set({ progressError: null }))
            .catch((e) => {
              // keep it to try again with the next change
              progressLatest.set(key, job);
              set({ progressError: message(e) });
            });
        }, PROGRESS_MS),
      );
    },

    flushProgress: async () => {
      for (const t of progressTimers.values()) clearTimeout(t);
      progressTimers.clear();
      const jobs = [...progressLatest.entries()];
      progressLatest.clear();
      await Promise.all(
        jobs.map(([key, job]) =>
          savePointProgress(job.meetingId, job.pointId, job.said).catch((e) => {
            progressLatest.set(key, job);
            set({ progressError: message(e) });
          }),
        ),
      );
    },

    resetMeeting: () => {
      for (const t of progressTimers.values()) clearTimeout(t);
      progressTimers.clear();
      progressLatest.clear();
      set({ meetingEdits: {}, meetingBase: {}, progress: {}, progressError: null });
    },
  };
});

// A network that comes back retries every failed save at once; closing flushes what is waiting.
if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    const st = useTalkingPointsStore.getState();
    for (const [id, entry] of pending) {
      if (st.saveState[id] === "failed") {
        entry.attempt = 0;
        void st.flush(id);
      }
    }
  });
  // another window changed the notes: reload what is loaded here, keeping unsaved edits
  try {
    void onWorkspacesChanged((e) => void useTalkingPointsStore.getState().syncFromBackend(e.workspace_id ?? null)).catch(() => undefined);
  } catch {
    /* no event bridge (tests) */
  }
  window.addEventListener("beforeunload", () => {
    void useTalkingPointsStore.getState().flushAll();
    void useTalkingPointsStore.getState().flushProgress();
  });
}

/** Test hook: forget timers and queues between tests. */
export function __resetTalkingPointsForTests(): void {
  for (const e of pending.values()) if (e.timer) clearTimeout(e.timer);
  pending.clear();
  tombstones.clear();
  for (const t of progressTimers.values()) clearTimeout(t);
  progressTimers.clear();
  progressLatest.clear();
  useTalkingPointsStore.setState({
    byWorkspace: {},
    loading: {},
    loadError: {},
    saveState: {},
    saveError: {},
    docRev: {},
    theirs: {},
    meetingBase: {},
    actionError: null,
    meetingEdits: {},
    progress: {},
    progressError: null,
    reading: { ...DEFAULT_READING },
    lastNote: {},
    recent: {},
    noteSort: {},
  });
}

export function pendingSaveCount(): number {
  return pending.size;
}
