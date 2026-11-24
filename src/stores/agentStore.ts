import { create } from "zustand";
import type { AgentSessionStatus, CliAgentKind, CliAgentStatus } from "../lib/types";
import { cliAgentModels, cliAgentStatus, getAgentSessions } from "../lib/ipc";
import { CLI_AGENTS } from "../lib/cliAgents";
import { isOutdated } from "../lib/agentUsage";
import { onAgentSessionStatus } from "../lib/events";
import { useConfigStore } from "./configStore";

/** Map key of a session: `${scope}:${meeting_id ?? ""}:${tier}`, plus `:sources` for a with-sources session. */
export function agentSessionKey(
  s: Pick<AgentSessionStatus, "scope" | "meeting_id" | "tier"> & { with_sources?: boolean },
): string {
  return `${s.scope}:${s.meeting_id ?? ""}:${s.tier}${s.with_sources ? ":sources" : ""}`;
}

/** A session that holds (or is about to hold) a running CLI process. */
export function isSessionRunning(s: AgentSessionStatus): boolean {
  return s.state === "starting" || s.state === "ready" || s.state === "busy";
}

type PerAgent<T> = Partial<Record<CliAgentKind, T>>;

interface AgentState {
  /** Last `cli_agent_status` answer per agent; missing until its first check ends. */
  statuses: PerAgent<CliAgentStatus>;
  /** A status check is in flight (it spawns child processes: a few seconds). */
  checking: PerAgent<boolean>;
  /** Why the last status check failed; cleared by the next successful one. */
  statusErrors: PerAgent<string>;
  /** When the last status check ended (ms since epoch), either way. */
  checkedAt: PerAgent<number>;
  /** Why the last model-catalog refresh failed; cleared by the next successful one. */
  modelsErrors: PerAgent<string>;
  /** A model-catalog refresh is in flight. */
  modelsRefreshing: PerAgent<boolean>;
  /** Open agent sessions by `agentSessionKey`. Closed sessions are dropped. */
  sessions: Record<string, AgentSessionStatus>;
  /** Re-detect the CLI and its login. Concurrent calls for one agent share one check. */
  refreshStatus: (kind: CliAgentKind) => Promise<void>;
  /**
   * Ask the CLI for its model catalog and keep it in the config store
   * (persisted, so every window and the next start have it). Concurrent
   * calls share one probe; a failure keeps the last good catalog.
   */
  refreshModels: (kind: CliAgentKind) => Promise<void>;
  /** Subscribe to `agent_session_status` and load the current sessions (once per window). */
  init: () => void;
}

const inFlight = new Map<CliAgentKind, Promise<void>>();
const modelsInFlight = new Map<CliAgentKind, Promise<void>>();
let initialized = false;
let startupModelsFetched = false;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `current` with one agent's entry set (or removed with `undefined`). */
function withAgent<T>(current: PerAgent<T>, kind: CliAgentKind, value: T | undefined): PerAgent<T> {
  const next = { ...current };
  if (value === undefined) delete next[kind];
  else next[kind] = value;
  return next;
}

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
  statuses: {},
  checking: {},
  statusErrors: {},
  checkedAt: {},
  modelsErrors: {},
  modelsRefreshing: {},
  sessions: {},

  refreshStatus: (kind) => {
    const running = inFlight.get(kind);
    if (running) return running;
    set((s) => ({ checking: withAgent(s.checking, kind, true) }));
    const run = cliAgentStatus(kind)
      .then((status) =>
        set((s) => ({
          statuses: withAgent(s.statuses, kind, status),
          statusErrors: withAgent(s.statusErrors, kind, undefined),
        })),
      )
      .catch((e) => {
        console.warn(`[agentStore] ${kind} status failed:`, e);
        set((s) => ({ statusErrors: withAgent(s.statusErrors, kind, errorText(e)) }));
      })
      .finally(() => {
        inFlight.delete(kind);
        set((s) => ({
          checking: withAgent(s.checking, kind, false),
          checkedAt: withAgent(s.checkedAt, kind, Date.now()),
        }));
      });
    inFlight.set(kind, run);
    return run;
  },

  refreshModels: (kind) => {
    const running = modelsInFlight.get(kind);
    if (running) return running;
    set((s) => ({ modelsRefreshing: withAgent(s.modelsRefreshing, kind, true) }));
    const run = cliAgentModels(kind, true)
      .then((models) => {
        if (models.length > 0) useConfigStore.getState().setCliAgentModels(kind, models);
        set((s) => ({ modelsErrors: withAgent(s.modelsErrors, kind, undefined) }));
      })
      .catch((e) => {
        console.warn(`[agentStore] ${kind} model list failed:`, e);
        set((s) => ({ modelsErrors: withAgent(s.modelsErrors, kind, errorText(e)) }));
      })
      .finally(() => {
        modelsInFlight.delete(kind);
        set((s) => ({ modelsRefreshing: withAgent(s.modelsRefreshing, kind, false) }));
      });
    modelsInFlight.set(kind, run);
    return run;
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

/**
 * Once per app start (called by the launcher window): check every CLI agent
 * and refresh the model list of each one that is installed and logged in, so
 * the pickers always offer the CLIs' current models.
 */
export function refreshCliModelsOnStart(): void {
  if (startupModelsFetched) return;
  startupModelsFetched = true;
  const store = useAgentStore.getState();
  for (const { id } of CLI_AGENTS) {
    void store.refreshStatus(id).then(() => {
      const status = useAgentStore.getState().statuses[id];
      // A Claude that is too old can't list models (it isn't started).
      if (status?.installed && status.auth?.logged_in && !isOutdated(status)) return useAgentStore.getState().refreshModels(id);
    });
  }
}

/** Test-only: forget the subscription and any in-flight check. */
export function resetAgentStoreForTests(): void {
  inFlight.clear();
  modelsInFlight.clear();
  initialized = false;
  startupModelsFetched = false;
  useAgentStore.setState({
    statuses: {},
    checking: {},
    statusErrors: {},
    checkedAt: {},
    modelsErrors: {},
    modelsRefreshing: {},
    sessions: {},
  });
}
