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
  saveTalkingPoint,
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

export type SaveState = "saved" | "dirty" | "saving" | "failed";
export type ScrollKind = "manual" | "auto" | "voice";

export interface ReadingSettings {
  /** Reading text size in px (the unit the user sees). */
  fontSize: number;
  /** Line height multiplier. */
  lineSpacing: number;
  wpm: number;
  mode: ScrollKind;
  /** "Said it" ticking (local, switchable). */
  saidIt: boolean;
}

export const READING_LIMITS = {
  fontSize: { min: 14, max: 56, step: 2 },
  lineSpacing: { min: 1.2, max: 2.2, step: 0.1 },
  wpm: { min: 60, max: 260, step: 10 },
} as const;

export const DEFAULT_READING: ReadingSettings = { fontSize: 26, lineSpacing: 1.5, wpm: 140, mode: "manual", saidIt: true };

const PREFS_KEY = "nexq-talking-points-v1";
const AUTOSAVE_MS = 800;
const PROGRESS_MS = 1500;
const RETRY_MS = [2000, 5000, 15000, 30000, 60000];
const MAX_RECENT = 12;

interface Prefs {
  reading: ReadingSettings;
  lastNote: Record<string, string>;
  recent: Record<string, string[]>;
}

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
}

export function loadPrefs(): Prefs {
  const base: Prefs = { reading: { ...DEFAULT_READING }, lastNote: {}, recent: {} };
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
    };
    if (p.lastNote && typeof p.lastNote === "object") {
      for (const [k, v] of Object.entries(p.lastNote)) if (typeof v === "string") base.lastNote[k] = v;
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

interface Pending {
  point: TalkingPoint;
  version: number;
  timer: ReturnType<typeof setTimeout> | null;
  attempt: number;
  inFlight: boolean;
}
const pending = new Map<string, Pending>();
const progressTimers = new Map<string, ReturnType<typeof setTimeout>>();
const progressLatest = new Map<string, { meetingId: string; pointId: string; said: PointSaid[] }>();

interface TalkingPointsState {
  byWorkspace: Record<string, TalkingPoint[]>;
  loading: Record<string, boolean>;
  loadError: Record<string, string | null>;
  saveState: Record<string, SaveState>;
  saveError: Record<string, string | null>;
  /** Last error of a list action (reorder, copy, delete). */
  actionError: string | null;

  reading: ReadingSettings;
  lastNote: Record<string, string>;
  recent: Record<string, string[]>;

  /** "Only this meeting" documents (JSON text) by point id, for the open meeting. */
  meetingEdits: Record<string, string>;
  /** "Said it" state by point id, for the open meeting. */
  progress: Record<string, PointSaid[]>;
  progressError: string | null;

  load: (workspaceId: string) => Promise<void>;
  create: (workspaceId: string, init?: { title?: string; doc?: TpDoc }) => Promise<TalkingPoint>;
  edit: (id: string, patch: { title?: string; doc?: TpDoc; in_context?: boolean }) => void;
  flush: (id: string) => Promise<void>;
  flushAll: () => Promise<void>;
  retry: (id: string) => void;
  duplicate: (id: string) => Promise<TalkingPoint | null>;
  copyTo: (id: string, workspaceId: string) => Promise<TalkingPoint | null>;
  remove: (id: string) => Promise<void>;
  reorder: (workspaceId: string, ids: string[]) => Promise<void>;
  find: (id: string) => TalkingPoint | undefined;

  setReading: (patch: Partial<ReadingSettings>) => void;
  rememberNote: (workspaceId: string, pointId: string) => void;

  loadMeetingState: (meetingId: string, pointId: string) => Promise<void>;
  saveMeetingOnly: (meetingId: string, pointId: string, doc: TpDoc) => Promise<void>;
  saveToWorkspace: (meetingId: string, pointId: string, doc: TpDoc) => Promise<void>;
  discardMeetingEdit: (meetingId: string, pointId: string) => Promise<void>;
  setProgress: (meetingId: string, pointId: string, said: PointSaid[]) => void;
  flushProgress: () => Promise<void>;
  resetMeeting: () => void;
}

function withDerived(p: TalkingPoint, doc: TpDoc): TalkingPoint {
  return {
    ...p,
    doc_json: serializeDoc(doc),
    markdown: docToMarkdown(doc),
    plain_text: docPlainText(doc),
    updated_at: Date.now(),
  };
}

export const useTalkingPointsStore = create<TalkingPointsState>((set, get) => {
  const prefs = loadPrefs();

  const savePrefs = () => {
    const s = get();
    writePrefs({ reading: s.reading, lastNote: s.lastNote, recent: s.recent });
  };

  const replacePoint = (point: TalkingPoint) =>
    set((s) => {
      const list = s.byWorkspace[point.workspace_id];
      if (!list) return s;
      const i = list.findIndex((p) => p.id === point.id);
      const next = i >= 0 ? list.map((p, k) => (k === i ? point : p)) : [...list, point];
      return { byWorkspace: { ...s.byWorkspace, [point.workspace_id]: next } };
    });

  const setSave = (id: string, state: SaveState, error: string | null = null) =>
    set((s) => ({ saveState: { ...s.saveState, [id]: state }, saveError: { ...s.saveError, [id]: error } }));

  const scheduleRetry = (id: string) => {
    const p = pending.get(id);
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    const wait = RETRY_MS[Math.min(Math.max(0, p.attempt - 1), RETRY_MS.length - 1)];
    p.timer = setTimeout(() => void get().flush(id), wait);
  };

  return {
    byWorkspace: {},
    loading: {},
    loadError: {},
    saveState: {},
    saveError: {},
    actionError: null,
    reading: prefs.reading,
    lastNote: prefs.lastNote,
    recent: prefs.recent,
    meetingEdits: {},
    progress: {},
    progressError: null,

    find: (id) => {
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
        set((s) => {
          // A note with an unsaved edit keeps its local text over the stored one.
          const merged = list
            .map((p) => pending.get(p.id)?.point ?? p)
            .sort((a, b) => a.sort - b.sort);
          const extra = (s.byWorkspace[workspaceId] ?? []).filter((p) => pending.has(p.id) && !merged.some((m) => m.id === p.id));
          return {
            byWorkspace: { ...s.byWorkspace, [workspaceId]: [...merged, ...extra] },
            loading: { ...s.loading, [workspaceId]: false },
          };
        });
      } catch (e) {
        set((s) => ({
          loading: { ...s.loading, [workspaceId]: false },
          loadError: { ...s.loadError, [workspaceId]: message(e) },
        }));
      }
    },

    create: async (workspaceId, init) => {
      const list = get().byWorkspace[workspaceId] ?? [];
      const doc = init?.doc ?? emptyDoc();
      const now = Date.now();
      const point = withDerived(
        {
          id: uid(),
          workspace_id: workspaceId,
          title: cleanTitle(init?.title ?? "", "Untitled note"),
          doc_json: "",
          markdown: "",
          plain_text: "",
          in_context: false,
          sort: list.reduce((m, p) => Math.max(m, p.sort), -1) + 1,
          created_at: now,
          updated_at: now,
        },
        doc,
      );
      set((s) => ({ byWorkspace: { ...s.byWorkspace, [workspaceId]: [...(s.byWorkspace[workspaceId] ?? []), point] } }));
      pending.set(point.id, { point, version: 1, timer: null, attempt: 0, inFlight: false });
      setSave(point.id, "dirty");
      await get().flush(point.id);
      return get().find(point.id) ?? point;
    },

    edit: (id, patch) => {
      const current = pending.get(id)?.point ?? get().find(id);
      if (!current) return;
      let next: TalkingPoint = { ...current };
      if (patch.title !== undefined) next.title = cleanTitle(patch.title, "Untitled note");
      if (patch.in_context !== undefined) next.in_context = patch.in_context;
      if (patch.doc) next = withDerived(next, patch.doc);
      else next.updated_at = Date.now();
      const p = pending.get(id);
      const entry: Pending = p ?? { point: next, version: 0, timer: null, attempt: 0, inFlight: false };
      entry.point = next;
      entry.version += 1;
      pending.set(id, entry);
      replacePoint(next);
      setSave(id, "dirty");
      if (entry.timer) clearTimeout(entry.timer);
      // A switch is saved at once; typing waits for a pause.
      const wait = patch.doc || patch.title !== undefined ? AUTOSAVE_MS : 0;
      entry.attempt = 0;
      entry.timer = setTimeout(() => void get().flush(id), wait);
    },

    flush: async (id) => {
      const entry = pending.get(id);
      if (!entry || entry.inFlight) return;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
      entry.inFlight = true;
      const sent = entry.version;
      const payload = entry.point;
      setSave(id, "saving");
      try {
        const saved = await saveTalkingPoint(payload);
        entry.inFlight = false;
        if (entry.version === sent) {
          pending.delete(id);
          replacePoint({ ...payload, sort: saved?.sort ?? payload.sort, updated_at: saved?.updated_at ?? payload.updated_at });
          setSave(id, "saved");
        } else {
          // Typed while saving: the newer text goes next.
          entry.attempt = 0;
          setSave(id, "dirty");
          entry.timer = setTimeout(() => void get().flush(id), 0);
        }
      } catch (e) {
        entry.inFlight = false;
        entry.attempt += 1;
        setSave(id, "failed", message(e));
        scheduleRetry(id);
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

    duplicate: async (id) => {
      const src = pending.get(id)?.point ?? get().find(id);
      if (!src) return null;
      const doc = parseDoc(src.doc_json);
      const copy = await get().create(src.workspace_id, { title: `${src.title} copy`, doc: reidDoc(doc) });
      get().edit(copy.id, { in_context: src.in_context });
      return copy;
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
      if (entry?.timer) clearTimeout(entry.timer);
      pending.delete(id);
      try {
        await deleteTalkingPoint(id);
      } catch (e) {
        set({ actionError: message(e) });
        return;
      }
      if (!src) return;
      set((s) => ({
        byWorkspace: { ...s.byWorkspace, [src.workspace_id]: (s.byWorkspace[src.workspace_id] ?? []).filter((p) => p.id !== id) },
        actionError: null,
      }));
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
          return { meetingEdits: edits, progress: { ...s.progress, [pointId]: prog?.said ?? s.progress[pointId] ?? [] }, progressError: null };
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
      get().edit(pointId, { doc });
      await get().flush(pointId);
      if (get().saveState[pointId] === "failed") throw new Error(get().saveError[pointId] ?? "Could not save");
      set((s) => {
        const edits = { ...s.meetingEdits };
        delete edits[pointId];
        return { meetingEdits: edits };
      });
      await saveMeetingPointEdit(meetingId, pointId, null);
    },

    discardMeetingEdit: async (meetingId, pointId) => {
      set((s) => {
        const edits = { ...s.meetingEdits };
        delete edits[pointId];
        return { meetingEdits: edits };
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
      set({ meetingEdits: {}, progress: {}, progressError: null });
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
  window.addEventListener("beforeunload", () => {
    void useTalkingPointsStore.getState().flushAll();
    void useTalkingPointsStore.getState().flushProgress();
  });
}

/** Test hook: forget timers and queues between tests. */
export function __resetTalkingPointsForTests(): void {
  for (const e of pending.values()) if (e.timer) clearTimeout(e.timer);
  pending.clear();
  for (const t of progressTimers.values()) clearTimeout(t);
  progressTimers.clear();
  progressLatest.clear();
  useTalkingPointsStore.setState({
    byWorkspace: {},
    loading: {},
    loadError: {},
    saveState: {},
    saveError: {},
    actionError: null,
    meetingEdits: {},
    progress: {},
    progressError: null,
    reading: { ...DEFAULT_READING },
    lastNote: {},
    recent: {},
  });
}

export function pendingSaveCount(): number {
  return pending.size;
}
