import { create } from "zustand";
import type { BriefSettings, BriefSheet, BriefState } from "../lib/types";
import {
  briefContinue,
  briefRefresh,
  briefStart,
  briefStop,
  getBriefSettings,
  getMeetingBrief,
  getWorkspace,
  setBriefSettings,
  updateWorkspace,
} from "../lib/ipc";
import { onBriefSettingsChanged, onBriefSheet, onBriefState } from "../lib/events";
import { useMeetingStore } from "./meetingStore";

export const DEFAULT_BRIEF_SETTINGS: BriefSettings = {
  enabled: false,
  provider: null,
  model: null,
  effort: null,
  cap: 60000,
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
  settings: BriefSettings | null;
  /** The meeting's home workspace, and whether the brief is on there (null = not known yet). */
  workspaceId: string | null;
  workspaceEnabled: boolean | null;
  error: string | null;

  attach: (meetingId: string, workspaceId?: string | null) => Promise<() => void>;
  watchSettings: () => Promise<() => void>;
  loadSettings: () => Promise<void>;
  reset: () => void;
  turnOn: () => Promise<void>;
  turnOff: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
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
  const onLive = (fn: (id: string) => Promise<void>) => () => {
    const id = liveMeetingId();
    return id ? guard(() => fn(id)) : Promise.resolve();
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
    settings: null,
    workspaceId: null,
    workspaceEnabled: null,
    error: null,

    attach: async (meetingId, workspaceId = null) => {
      if (get().meetingId !== meetingId) {
        set({ meetingId, sheet: null, hidden: false, run: null, error: null });
      }
      set({ workspaceId, workspaceEnabled: null });
      void rereadWorkspace();
      let alive = true;
      const [offState, offSheet] = await Promise.all([
        onBriefState((e) => {
          if (alive && e.meeting_id === get().meetingId) set({ run: e });
        }),
        onBriefSheet((e) => {
          if (!alive || e.meeting_id !== get().meetingId) return;
          const next = cleanSheet(e.sheet);
          if (next) set({ sheet: next, hidden: false });
          else set((s) => ({ sheet: null, hidden: s.sheet !== null || s.hidden }));
        }),
      ]);
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
    reset: () => set({ meetingId: null, sheet: null, hidden: false, run: null, workspaceId: null, workspaceEnabled: null, error: null }),

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
    pause: onLive((id) => briefStop(id)),
    resume: onLive(async (id) => {
      set({ error: null });
      await briefStart(id);
    }),
    refresh: onLive(async (id) => {
      set({ error: null });
      await briefRefresh(id);
    }),
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
    clearError: () => set({ error: null }),
  };
});
