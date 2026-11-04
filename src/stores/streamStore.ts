import { create } from "zustand";
import type { AIResponse, IntelligenceMode, StreamSource } from "../lib/types";
import { stripThinkTags } from "../lib/utils";
import { NO_USER_REQUESTS, type LastUserRequests } from "../lib/contextScope";

/** Every answer of the meeting is kept, up to this many (newest first). */
export const RESPONSE_HISTORY_CAP = 100;

/**
 * Where the current request is:
 * - `sending`: the user acted, no `llm_stream_start` yet
 * - `waiting`: started, no tokens yet
 * - `thinking`: the model is reasoning (backend thinking event, or <think> tokens)
 * - `writing`: visible words are arriving
 * - `idle`: nothing in flight
 */
export type StreamPhase = "idle" | "sending" | "waiting" | "thinking" | "writing";

/** What the start event told us about the current request. */
export interface StreamMeta {
  model: string;
  provider: string;
  /** The user's transcript scope ("Last 5 min"), null for the action default. */
  scopeLabel: string | null;
  /** Transcript lines sent: new lines on the Claude session path, lines in the window otherwise. */
  newLines: number | null;
  /** The Claude session that answers; null on the stateless path. */
  sessionKey: string | null;
}

/** Optional start-event details for `startStream`. */
export interface StreamStartDetails extends Partial<Omit<StreamMeta, "model" | "provider">> {
  requestId?: string | null;
}

interface StreamState {
  // Current stream
  isStreaming: boolean;
  currentContent: string;
  _rawContent: string; // unfiltered content (includes <think> tags)
  currentMode: IntelligenceMode | null;
  currentModel: string;
  currentProvider: string;
  currentSources: StreamSource[];
  error: string | null;
  latencyMs: number | null;

  // Progress of the current request
  phase: StreamPhase;
  /** Epoch ms the user acted (or the stream started, when not user-invoked). */
  requestStartedAt: number | null;
  /** Epoch ms the first visible words arrived. */
  firstTokenAt: number | null;
  streamMeta: StreamMeta | null;
  /** Request id of the user action awaiting its start event. */
  pendingRequestId: string | null;
  /** Request id of the answer streaming now (null when idle or unknown). */
  streamRequestId: string | null;

  /** Id of the history entry shown as "Current" (null while streaming / none). */
  currentId: string | null;
  /** Every answer of the meeting (newest first, capped) + pinned responses. */
  responseHistory: AIResponse[];
  pinnedResponses: AIResponse[];

  /** Start times of the previous user requests in this meeting (for "since last …" scopes). */
  lastUserRequest: LastUserRequests;

  // Actions
  setStreaming: (streaming: boolean) => void;
  appendToken: (token: string) => void;
  /** A user action was invoked: show "Sending…" until its start event. No-op while streaming. */
  setPending: (mode: IntelligenceMode | string, requestId: string) => void;
  /** The pending action failed before starting (only clears that request). */
  clearPending: (requestId: string) => void;
  /** Whether `requestId` is the request being sent or streamed now. */
  isRunning: (requestId: string) => boolean;
  /** When `requestId` ends, drop it: not kept in History, not left on screen. */
  discardRequest: (requestId: string) => void;
  setPhase: (phase: StreamPhase) => void;
  startStream: (mode: IntelligenceMode, model: string, provider: string, details?: StreamStartDetails) => void;
  setSources: (sources: StreamSource[]) => void;
  endStream: (latencyMs: number) => void;
  setError: (error: string | null) => void;
  clearCurrent: () => void;
  pinResponse: (id: string) => void;
  unpinResponse: (id: string) => void;
  recordUserRequest: (mode: string, at: number) => void;
  /** Meeting start: forget the previous meeting's answers, pins and request times. */
  resetForMeeting: () => void;
}

const IDLE_PROGRESS = {
  phase: "idle" as StreamPhase,
  requestStartedAt: null,
  firstTokenAt: null,
  streamMeta: null,
  pendingRequestId: null,
  streamRequestId: null,
};

/** Requests to drop when they end (automatic answers NexQ stopped). */
const discarded = new Set<string>();

export const useStreamStore = create<StreamState>((set, get) => ({
  isStreaming: false,
  currentContent: "",
  _rawContent: "",
  currentMode: null,
  currentModel: "",
  currentProvider: "",
  currentSources: [],
  error: null,
  latencyMs: null,
  ...IDLE_PROGRESS,
  currentId: null,
  responseHistory: [],
  pinnedResponses: [],
  lastUserRequest: NO_USER_REQUESTS,

  setStreaming: (streaming) => set({ isStreaming: streaming }),

  appendToken: (token) =>
    set((state) => {
      const raw = state._rawContent + token;
      const content = stripThinkTags(raw);
      const progress: Partial<StreamState> = {};
      if (state.firstTokenAt === null && content.trim().length > 0) {
        progress.firstTokenAt = Date.now();
        progress.phase = "writing";
      } else if (state.firstTokenAt === null && raw.trim().length > 0) {
        // Only <think> content so far.
        progress.phase = "thinking";
      }
      return { _rawContent: raw, currentContent: content, ...progress };
    }),

  setPending: (mode, requestId) => {
    // A second press while one is running or still sending is refused by the
    // backend; it must not take over the first request's progress.
    if (get().isStreaming || get().phase === "sending") return;
    set({
      phase: "sending",
      pendingRequestId: requestId,
      requestStartedAt: Date.now(),
      firstTokenAt: null,
      streamMeta: null,
      currentMode: mode as IntelligenceMode,
      currentContent: "",
      _rawContent: "",
      currentSources: [],
      currentId: null,
      error: null,
    });
  },

  clearPending: (requestId) => {
    if (get().pendingRequestId !== requestId) return;
    set({ ...IDLE_PROGRESS, currentMode: get().isStreaming ? get().currentMode : null });
  },

  isRunning: (requestId) => {
    const state = get();
    return state.pendingRequestId === requestId || (state.isStreaming && state.streamRequestId === requestId);
  },

  discardRequest: (requestId) => {
    discarded.add(requestId);
  },

  setPhase: (phase) => set({ phase }),

  startStream: (mode, model, provider, details = {}) => {
    const state = get();
    const fromClick =
      state.pendingRequestId !== null &&
      state.requestStartedAt !== null &&
      (details.requestId == null || details.requestId === state.pendingRequestId);
    set({
      isStreaming: true,
      currentContent: "",
      _rawContent: "",
      currentMode: mode,
      currentModel: model,
      currentProvider: provider,
      currentSources: [],
      error: null,
      latencyMs: null,
      phase: "waiting",
      requestStartedAt: fromClick ? state.requestStartedAt : Date.now(),
      firstTokenAt: null,
      pendingRequestId: null,
      streamRequestId: details.requestId ?? null,
      currentId: null,
      streamMeta: {
        model,
        provider,
        scopeLabel: details.scopeLabel ?? null,
        newLines: details.newLines ?? null,
        sessionKey: details.sessionKey ?? null,
      },
    });
  },

  setSources: (sources) => set({ currentSources: sources }),

  endStream: (latencyMs) => {
    const state = get();
    // Strip <think> tags from the final stored content
    const content = stripThinkTags(state._rawContent);
    const now = Date.now();
    const started = state.requestStartedAt;
    const response: AIResponse = {
      id: crypto.randomUUID(),
      content,
      mode: state.currentMode!,
      timestamp: now,
      pinned: false,
      model: state.currentModel,
      provider: state.currentProvider,
      latency_ms: latencyMs,
      sources: state.currentSources.length > 0 ? state.currentSources : undefined,
      total_ms: started !== null ? now - started : latencyMs,
      first_token_ms: started !== null && state.firstTokenAt !== null ? state.firstTokenAt - started : undefined,
      scope_label: state.streamMeta?.scopeLabel ?? null,
    };
    // A stream stopped before any words is nothing to keep, nor is one NexQ
    // stopped and asked to drop.
    const dropped = state.streamRequestId !== null && discarded.delete(state.streamRequestId);
    const keep = !dropped && content.trim().length > 0;

    set((s) => ({
      isStreaming: false,
      currentContent: dropped ? "" : content,
      latencyMs,
      ...IDLE_PROGRESS,
      currentId: keep ? response.id : null,
      responseHistory: keep ? [response, ...s.responseHistory].slice(0, RESPONSE_HISTORY_CAP) : s.responseHistory,
    }));
  },

  setError: (error) => set({ error, isStreaming: false, ...IDLE_PROGRESS }),
  clearCurrent: () =>
    set({
      currentContent: "",
      _rawContent: "",
      currentMode: null,
      currentModel: "",
      currentProvider: "",
      currentSources: [],
      error: null,
      latencyMs: null,
      currentId: null,
      ...IDLE_PROGRESS,
    }),

  pinResponse: (id) => {
    const state = get();
    const response = state.responseHistory.find((r) => r.id === id);
    if (response && !state.pinnedResponses.find((r) => r.id === id)) {
      set({
        pinnedResponses: [
          ...state.pinnedResponses,
          { ...response, pinned: true },
        ],
      });
    }
  },

  unpinResponse: (id) =>
    set((state) => ({
      pinnedResponses: state.pinnedResponses.filter((r) => r.id !== id),
    })),

  recordUserRequest: (mode, at) =>
    set((state) => ({
      lastUserRequest: {
        anyAt: at,
        byMode: { ...state.lastUserRequest.byMode, [mode]: at },
      },
    })),

  resetForMeeting: () => {
    discarded.clear();
    get().clearCurrent();
    set({ isStreaming: false, responseHistory: [], pinnedResponses: [], lastUserRequest: NO_USER_REQUESTS });
  },
}));
