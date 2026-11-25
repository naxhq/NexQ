import { create } from "zustand";
import type { BriefSettings, BriefSheet, BriefState } from "../lib/types";
import {
  briefContinue,
  briefRefresh,
  briefStart,
  briefStop,
  getBriefSettings,
  getMeetingBrief,
  setBriefSettings,
} from "../lib/ipc";
import { onBriefSheet, onBriefState } from "../lib/events";

export const DEFAULT_BRIEF_SETTINGS: BriefSettings = {
  enabled: false,
  provider: null,
  model: null,
  effort: null,
  cap: 60000,
};

interface LiveBriefState {
  meetingId: string | null;
  sheet: BriefSheet | null;
  /** A topic change hid the old sheet and the new one is not here yet. */
  hidden: boolean;
  run: BriefState | null;
  settings: BriefSettings | null;
  error: string | null;

  attach: (meetingId: string) => Promise<() => void>;
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

/** `generated_at` may be seconds or milliseconds; always return milliseconds. */
/** A sheet from the engine with every list present, or null when it is not one. */
export function cleanSheet(x: unknown): BriefSheet | null {
  const s = x as Partial<BriefSheet> | null | undefined;
  if (!s || typeof s.now !== "string") return null;
  return { now: s.now, facts: Array.isArray(s.facts) ? s.facts : [], earlier: Array.isArray(s.earlier) ? s.earlier : [], generated_at: Number(s.generated_at) || Date.now() };
}

export function sheetTimeMs(sheet: BriefSheet): number {
  return sheet.generated_at < 1e11 ? sheet.generated_at * 1000 : sheet.generated_at;
}

export const useLiveBriefStore = create<LiveBriefState>((set, get) => {
  const guard = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      set({ error: describeError(e) });
    }
  };
  const withId = (fn: (id: string) => Promise<void>) => () => {
    const id = get().meetingId;
    return id ? guard(() => fn(id)) : Promise.resolve();
  };

  return {
    meetingId: null,
    sheet: null,
    hidden: false,
    run: null,
    settings: null,
    error: null,

    attach: async (meetingId) => {
      if (get().meetingId !== meetingId) {
        set({ meetingId, sheet: null, hidden: false, run: null, error: null });
      }
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
        if (alive && get().meetingId === meetingId) set((cur) => ({ sheet: cur.sheet ?? cleanSheet(sheet), settings: settings && typeof settings === "object" ? settings : cur.settings }));
      } catch (e) {
        if (alive) set({ error: describeError(e) });
      }
      return () => {
        alive = false;
        offState();
        offSheet();
      };
    },
    reset: () => set({ meetingId: null, sheet: null, hidden: false, run: null, error: null }),

    turnOn: withId(async (id) => {
      const next = { ...(get().settings ?? DEFAULT_BRIEF_SETTINGS), enabled: true };
      set({ settings: next, error: null });
      await setBriefSettings(next);
      await briefStart(id);
    }),
    turnOff: withId(async (id) => {
      const next = { ...(get().settings ?? DEFAULT_BRIEF_SETTINGS), enabled: false };
      set({ settings: next });
      await briefStop(id);
      await setBriefSettings(next);
    }),
    pause: withId((id) => briefStop(id)),
    resume: withId(async (id) => {
      set({ error: null });
      await briefStart(id);
    }),
    refresh: withId(async (id) => {
      set({ error: null });
      await briefRefresh(id);
    }),
    keepGoing: withId((id) => briefContinue(id)),
    patchSettings: async (patch) => {
      const next = { ...(get().settings ?? DEFAULT_BRIEF_SETTINGS), ...patch };
      set({ settings: next });
      await guard(async () => {
        await setBriefSettings(next);
        const id = get().meetingId;
        if (id && patch.enabled === true) await briefStart(id);
        else if (id && patch.enabled === false) await briefStop(id);
      });
    },
    clearError: () => set({ error: null }),
  };
});
