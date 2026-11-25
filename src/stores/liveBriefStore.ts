import { create } from "zustand";
import type { BriefSettings, BriefSheet, BriefState } from "../lib/types";
import {
  briefContinue,
  briefPause,
  briefResume,
  briefRefresh,
  briefStart,
  briefStop,
  getBriefSettings,
  getBriefState,
  getMeetingBrief,
  getWorkspace,
  setBriefSettings,
  updateWorkspace,
} from "../lib/ipc";
import { onBriefSettingsChanged, onBriefSheet, onBriefState } from "../lib/events";
import { useMeetingStore } from "./meetingStore";

export const DEFAULT_BRIEF_SETTINGS: BriefSettings = {
  provider: null,
  model: null,
  effort: null,
  /** 0 until the backend says: it owns the default. */
  cap: 0,
};

/** A sheet from the engine with every list present, or null when it is not one. */
export function cleanSheet(x: unknown): BriefSheet | null {
  const s = x as Partial<BriefSheet> | null | undefined;
  if (!s || typeof s.now !== "string") return null;
  return {
    now: s.now,
    facts: Array.isArray(s.facts) ? s.facts : [],
    earlier: Array.isArray(s.earlier) ? s.earlier : [],
    generated_at: Number(s.generated_at) || Date.now(),
  };
}

/** `generated_at` may be seconds or milliseconds; always return milliseconds. */
export function sheetTimeMs(sheet: BriefSheet): number {
  return sheet.generated_at < 1e11 ? sheet.generated_at * 1000 : sheet.generated_at;
}

/** The live meeting: the only one a run command may touch. */
export function liveMeetingId(): string | null {
  return useMeetingStore.getState().activeMeeting?.id ?? null;
}

interface LiveBriefState {
  meetingId: string | null;
  sheet: BriefSheet | null;
  /** A topic change hid the old sheet and the new one is not here yet. */
  hidden: boolean;
  run: BriefState | null;
  /** When the next model call is due (ms epoch), from `next_in_ms` at the moment it arrived. */
  deadline: number | null;
  settings: BriefSettings | null;
  /** The meeting's home workspace, and whether the brief is on there (null = not known yet). */
  workspaceId: string | null;
  workspaceEnabled: boolean | null;
  error: string | null;
  /** A refusal that is not a failure ("nothing new yet"), in the backend words. */
  notice: string | null;

  attach: (meetingId: string, workspaceId?: string | null) => Promise<() => void>;
  watchSettings: () => Promise<() => void>;
  loadSettings: () => Promise<void>;
  reset: () => void;
  turnOn: () => Promise<void>;
  turnOff: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  tryAgain: () => Promise<void>;
  start: () => Promise<void>;
  refresh: () => Promise<void>;
  keepGoing: () => Promise<void>;
  patchSettings: (patch: Partial<BriefSettings>) => Promise<void>;
  clearError: () => void;
}

function describeError(e: unknown): string {
  const s = typeof e === "string" ? e : e instanceof Error ? e.message : "";
  return s || "Something went wrong. Try again.";
}

const okSettings = (x: unknown): BriefSettings | null => (x && typeof x === "object" ? (x as BriefSettings) : null);

export const useLiveBriefStore = create<LiveBriefState>((set, get) => {
  const guard = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      set({ error: describeError(e) });
    }
  };
  /** On the live meeting; with none, say so instead of doing nothing. */
  const onLive = (fn: (id: string) => Promise<void>) => () => {
    const id = liveMeetingId();
    if (!id) {
      set({ error: "No meeting is running, so there is nothing to change." });
      return Promise.resolve();
    }
    return guard(() => fn(id));
  };
  const applyState = (s: BriefState) => {
    set({ run: s, deadline: typeof s.next_in_ms === "number" ? Date.now() + s.next_in_ms : null });
  };

  const rereadWorkspace = async (): Promise<boolean | null> => {
    const ws = get().workspaceId;
    if (!ws) return null;
    try {
      const w = await getWorkspace(ws);
      const on = !!w?.brief_enabled;
      if (get().workspaceId === ws) set({ workspaceEnabled: on });
      return on;
    } catch {
      return null;
    }
  };

  return {
    meetingId: null,
    sheet: null,
    hidden: false,
    run: null,
    deadline: null,
    settings: null,
    workspaceId: null,
    workspaceEnabled: null,
    error: null,
    notice: null,

    attach: async (meetingId, workspaceId = null) => {
      if (get().meetingId !== meetingId) {
        set({ meetingId, sheet: null, hidden: false, run: null, error: null });
      }
      set({ workspaceId, workspaceEnabled: null });
      void rereadWorkspace();
      let alive = true;
      const [offState, offSheet] = await Promise.all([
        onBriefState((e) => {
          if (alive && e.meeting_id === get().meetingId) applyState(e);
        }),
        onBriefSheet((e) => {
          if (!alive || e.meeting_id !== get().meetingId) return;
          const next = cleanSheet(e.sheet);
          if (next) set({ sheet: next, hidden: false });
          else set((s) => ({ sheet: null, hidden: s.sheet !== null || s.hidden }));
        }),
      ]);
      void getBriefState(meetingId)
        .then((s) => alive && get().meetingId === meetingId && applyState(s))
        .catch((e) => alive && set({ error: describeError(e) }));
      try {
        const [sheet, settings] = await Promise.all([getMeetingBrief(meetingId), getBriefSettings()]);
        if (alive && get().meetingId === meetingId) set((cur) => ({ sheet: cur.sheet ?? cleanSheet(sheet), settings: okSettings(settings) ?? cur.settings }));
      } catch (e) {
        if (alive) set({ error: describeError(e) });
      }
      return () => {
        alive = false;
        offState();
        offSheet();
      };
    },
    watchSettings: async () => {
      const off = await onBriefSettingsChanged((s) => {
        const next = okSettings(s);
        if (next) set({ settings: next });
      });
      await get().loadSettings();
      return off;
    },
    loadSettings: async () => {
      try {
        const s = okSettings(await getBriefSettings());
        if (s) set({ settings: s });
      } catch (e) {
        set({ error: describeError(e) });
      }
    },
    reset: () => set({ meetingId: null, sheet: null, hidden: false, run: null, deadline: null, workspaceId: null, workspaceEnabled: null, error: null }),

    turnOn: async () => {
      const ws = get().workspaceId;
      set({ error: null });
      try {
        if (ws) await updateWorkspace(ws, { brief_enabled: true });
        set({ workspaceEnabled: true });
        const live = liveMeetingId();
        if (live) await briefStart(live);
      } catch (e) {
        set({ error: describeError(e) });
        await rereadWorkspace();
      }
    },
    turnOff: async () => {
      // Try to stop and to persist, whichever fails; then show what is true.
      const ws = get().workspaceId;
      const live = liveMeetingId();
      const results = await Promise.allSettled([
        live ? briefStop(live) : Promise.resolve(),
        ws ? updateWorkspace(ws, { brief_enabled: false }) : Promise.resolve(),
      ]);
      const truth = await rereadWorkspace();
      const failed = results.some((r) => r.status === "rejected");
      if (truth === null && ws) set({ workspaceEnabled: null, error: "Could not confirm whether the brief is off. Check again before you rely on it." });
      else if (failed || truth) set({ error: "The brief may still be running. Try turning it off again." });
    },
    pause: onLive((id) => briefPause(id)),
    resume: onLive(async (id) => {
      set({ error: null });
      await briefResume(id);
    }),
    start: onLive(async (id) => {
      set({ error: null });
      await briefStart(id);
    }),
    tryAgain: onLive(async (id) => {
      set({ error: null });
      await briefStart(id);
    }),
    refresh: async () => {
      const id = liveMeetingId();
      if (!id) {
        set({ error: "No meeting is running, so there is nothing to change." });
        return;
      }
      set({ error: null, notice: null });
      try {
        await briefRefresh(id);
      } catch (e) {
        set({ notice: describeError(e) });
      }
    },
    keepGoing: onLive((id) => briefContinue(id)),
    patchSettings: async (patch) => {
      const before = get().settings;
      if (before) set({ settings: { ...before, ...patch } });
      try {
        const merged = okSettings(await setBriefSettings(patch));
        if (merged) set({ settings: merged });
      } catch (e) {
        set({ error: describeError(e) });
        void get().loadSettings();
      }
    },
    clearError: () => set({ error: null, notice: null }),
  };
});
