import { create } from "zustand";
import type { UpdateInfo } from "../lib/types";

/**
 * Updater lifecycle. An update that was found but not downloaded yet (automatic
 * updates off) is `phase: "idle"` with `version` set.
 */
export type UpdatePhase = "idle" | "checking" | "downloading" | "ready" | "error";

/**
 * Looking for a newer release while one is already downloaded. Separate from
 * the phase because the waiting update stays ready and installable meanwhile.
 */
export type UpdateRefresh = "idle" | "checking" | "downloading";

export interface UpdateProgress {
  received: number;
  total: number | null;
}

interface UpdaterState {
  phase: UpdatePhase;
  /** Version of the available / downloading / ready update. */
  version?: string;
  /** Release notes of that update. */
  notes?: string;
  progress: UpdateProgress;
  error?: string;
  lastChecked?: number;
  refresh: UpdateRefresh;
  /** The newer version being downloaded. */
  refreshVersion?: string;
  /** The "what's new" dialog shown before installing. */
  dialogOpen: boolean;

  // Persisted preferences (hydrated by useUpdater)
  autoUpdate: boolean;
  skippedVersion?: string;

  startCheck: () => void;
  /**
   * Record a finished check. Returns the update to act on, or null when there
   * is none or it was skipped (automatic checks only — a manual check always
   * surfaces the update).
   */
  finishCheck: (update: UpdateInfo | null, opts?: { manual?: boolean }) => UpdateInfo | null;
  failCheck: (error: string) => void;
  startDownload: () => void;
  addProgress: (chunkLength: number, contentLength: number | null) => void;
  /**
   * Mark a downloaded update ready. A skipped version is ignored unless the
   * user explicitly asked for it.
   */
  setReady: (version: string, notes?: string | null, opts?: { explicit?: boolean }) => void;
  failDownload: (error: string) => void;
  setRefresh: (refresh: UpdateRefresh, version?: string) => void;
  setDialogOpen: (open: boolean) => void;
  setAutoUpdate: (enabled: boolean) => void;
  setSkippedVersion: (version: string | undefined) => void;
  /** Skip a version and drop it from view unless it is mid-download. */
  skip: (version: string) => void;
  reset: () => void;
}

const initialState = {
  phase: "idle" as UpdatePhase,
  version: undefined as string | undefined,
  notes: undefined as string | undefined,
  progress: { received: 0, total: null } as UpdateProgress,
  error: undefined as string | undefined,
  lastChecked: undefined as number | undefined,
  refresh: "idle" as UpdateRefresh,
  refreshVersion: undefined as string | undefined,
  dialogOpen: false,
};

export const useUpdaterStore = create<UpdaterState>((set, get) => ({
  ...initialState,
  autoUpdate: true,
  skippedVersion: undefined,

  startCheck: () => set({ phase: "checking", error: undefined }),

  finishCheck: (update, opts) => {
    const skipped =
      !!update && !opts?.manual && get().skippedVersion === update.version;
    const actionable = update && !skipped ? update : null;
    set({
      phase: "idle",
      error: undefined,
      lastChecked: Date.now(),
      version: actionable?.version,
      notes: actionable?.body ?? undefined,
    });
    return actionable;
  },

  failCheck: (error) => set({ phase: "error", error, version: undefined, notes: undefined }),

  startDownload: () =>
    set({ phase: "downloading", error: undefined, progress: { received: 0, total: null } }),

  addProgress: (chunkLength, contentLength) =>
    set((s) => ({
      // A newer version downloading doesn't take away the one that's ready.
      phase: s.phase === "ready" ? "ready" : "downloading",
      progress: {
        received: s.progress.received + chunkLength,
        total: contentLength ?? s.progress.total,
      },
    })),

  setReady: (version, notes, opts) => {
    if (!opts?.explicit && get().skippedVersion === version) {
      set({ phase: "idle", version: undefined, notes: undefined, error: undefined });
      return;
    }
    set((s) => ({
      phase: "ready",
      version,
      notes: notes ?? (s.version === version ? s.notes : undefined),
      error: undefined,
    }));
  },

  failDownload: (error) => set({ phase: "error", error }),

  setRefresh: (refresh, version) =>
    set((s) => ({
      refresh,
      refreshVersion: version,
      progress: refresh === "downloading" ? { received: 0, total: null } : s.progress,
    })),

  setDialogOpen: (open) => set({ dialogOpen: open }),

  setAutoUpdate: (enabled) => set({ autoUpdate: enabled }),

  setSkippedVersion: (version) => set({ skippedVersion: version }),

  skip: (version) =>
    set((s) =>
      s.version === version && s.phase !== "downloading"
        ? { skippedVersion: version, phase: "idle", version: undefined, notes: undefined, error: undefined }
        : { skippedVersion: version },
    ),

  reset: () => set({ ...initialState }),
}));
