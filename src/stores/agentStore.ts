import { create } from "zustand";
import type { AgentSessionStatus, ClaudeCliStatus } from "../lib/types";
import { claudeCliModels, claudeCliStatus, getAgentSessions } from "../lib/ipc";
import { onAgentSessionStatus } from "../lib/events";
import { useConfigStore } from "./configStore";

/** Map key of a session: `${scope}:${meeting_id ?? ""}:${tier}`, plus `:sources` for a with-sources session. */
export function agentSessionKey(
  s: Pick<AgentSessionStatus, "scope" | "meeting_id" | "tier"> & { with_sources?: boolean },
): string {
  return `${s.scope}:${s.meeting_id ?? ""}:${s.tier}${s.with_sources ? ":sources" : ""}`;
}

/** A session that holds (or is about to hold) a running `claude` process. */
export function isSessionRunning(s: AgentSessionStatus): boolean {
  return s.state === "starting" || s.state === "ready" || s.state === "busy";
}

interface AgentState {
  /** Last `claude_cli_status` answer; undefined until the first check ends. */
  status?: ClaudeCliStatus;
  /** A status check is in flight (it spawns child processes: a few seconds). */
  checking: boolean;
  /** Why the last status check failed; cleared by the next successful one. */
  statusError?: string;
  /** When the last status check ended (ms since epoch), either way. */
  checkedAt?: number;
  /** Why the last model-catalog refresh failed; cleared by the next successful one. */
  modelsError?: string;
  /** A model-catalog refresh is in flight. */
  modelsRefreshing: boolean;
  /** Open Claude sessions by `agentSessionKey`. Closed sessions are dropped. */
  sessions: Record<string, AgentSessionStatus>;
  /** Re-detect the CLI and its login. Concurrent calls share one check. */
  refreshStatus: () => Promise<void>;
  /**
   * Ask the CLI for its model catalog and keep it in the config store
   * (persisted, so every window and the next start have it). Concurrent
   * calls share one probe; a failure keeps the last good catalog.
   */
  refreshModels: () => Promise<void>;
  /** Subscribe to `agent_session_status` and load the current sessions (once per window). */
  init: () => void;
}

let inFlight: Promise<void> | null = null;
let modelsInFlight: Promise<void> | null = null;
let initialized = false;
let startupModelsFetched = false;

function applySession(
  sessions: Record<string, AgentSessionStatus>,
  status: AgentSessionStatus,
): Record<string, AgentSessionStatus> {
  const key = agentSessionKey(status);
  if (status.state === "closed") {
    if (!(key in sessions)) return sessions;
    const next = { ...sessions };
    delete next[key];
    return next;
  }
  return { ...sessions, [key]: status };
}

export const useAgentStore = create<AgentState>((set) => ({
  status: undefined,
  checking: false,
  modelsRefreshing: false,
  sessions: {},

  refreshStatus: () => {
    if (inFlight) return inFlight;
    set({ checking: true });
    inFlight = claudeCliStatus()
      .then((status) => set({ status, statusError: undefined }))
      .catch((e) => {
        console.warn("[agentStore] Claude CLI status failed:", e);
        set({ statusError: e instanceof Error ? e.message : String(e) });
      })
      .finally(() => {
        inFlight = null;
        set({ checking: false, checkedAt: Date.now() });
      });
    return inFlight;
  },

  refreshModels: () => {
    if (modelsInFlight) return modelsInFlight;
    set({ modelsRefreshing: true });
    modelsInFlight = claudeCliModels(true)
      .then((models) => {
        if (models.length > 0) useConfigStore.getState().setClaudeModels(models);
        set({ modelsError: undefined });
      })
      .catch((e) => {
        console.warn("[agentStore] Claude model list failed:", e);
        set({ modelsError: e instanceof Error ? e.message : String(e) });
      })
      .finally(() => {
        modelsInFlight = null;
        set({ modelsRefreshing: false });
      });
    return modelsInFlight;
  },

  init: () => {
    if (initialized) return;
    // Set now so concurrent calls don't subscribe twice; cleared on failure so
    // a later call retries.
    initialized = true;
    onAgentSessionStatus((status) => {
      set((s) => ({ sessions: applySession(s.sessions, status) }));
    }).catch((e) => {
      initialized = false;
      console.warn("[agentStore] Failed to listen for session status:", e);
    });
    getAgentSessions()
      .then((all) =>
        set((s) => {
          // Events that arrived meanwhile are newer than the snapshot.
          const sessions = { ...s.sessions };
          for (const status of all) {
            const key = agentSessionKey(status);
            if (!(key in sessions) && status.state !== "closed") sessions[key] = status;
          }
          return { sessions };
        }),
      )
      .catch((e) => console.warn("[agentStore] Failed to load sessions:", e));
  },
}));

/** Refresh the model catalog once per app start (called by the launcher window). */
export function refreshClaudeModelsOnStart(): void {
  if (startupModelsFetched) return;
  startupModelsFetched = true;
  void useAgentStore.getState().refreshModels();
}

/** Test-only: forget the subscription and any in-flight check. */
export function resetAgentStoreForTests(): void {
  inFlight = null;
  modelsInFlight = null;
  initialized = false;
  startupModelsFetched = false;
  useAgentStore.setState({
    status: undefined,
    checking: false,
    statusError: undefined,
    checkedAt: undefined,
    modelsError: undefined,
    modelsRefreshing: false,
    sessions: {},
  });
}
