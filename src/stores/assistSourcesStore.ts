import { create } from "zustand";
import { getAssistSources } from "../lib/ipc";
import { isCliAgent } from "../lib/cliAgents";
import { holdsKnowledge, holdsTools } from "../lib/sourcePills";
import type { AssistSources, SourceToggles } from "../lib/types";
import { useConfigStore } from "./configStore";
import { useMeetingStore } from "./meetingStore";
import { useSourcesStore } from "./sourcesStore";

/**
 * The assistant panel's Knowledge and Tools pills, one set per meeting. What a pill covers comes
 * from the meeting's own workspace (the backend resolves it), never from the global list of saved
 * sources. A meeting that has not been touched starts with the default from `sourcesStore` (both on).
 */

/** The key of the running meeting when its id is not known yet. */
export const LIVE_KEY = "live";

/** The meeting a pill belongs to: the one named, else the running one. */
export function meetingKeyOf(meetingId?: string | null): string {
  return meetingId || useMeetingStore.getState().activeMeeting?.id || LIVE_KEY;
}

interface AssistSourcesState {
  /** What each meeting's workspace holds, by meeting key. */
  info: Record<string, AssistSources>;
  /** The pills a meeting's user has set (a meeting not here has the default). */
  pills: Record<string, SourceToggles>;
  /** Read what the meeting's workspace holds. A failure leaves what was known. */
  refresh: (meetingId?: string | null) => Promise<void>;
  /** Set one pill of a meeting; two quick clicks each see the other's result. */
  setPill: (meetingId: string | null | undefined, kind: keyof SourceToggles, on: boolean) => void;
}

/** What came back, with every field filled in; null when it is not an answer at all. */
function normalizeInfo(raw: unknown): AssistSources | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<AssistSources>;
  return {
    workspace_id: typeof r.workspace_id === "string" ? r.workspace_id : "",
    documents: typeof r.documents === "number" ? r.documents : 0,
    notes: typeof r.notes === "number" ? r.notes : 0,
    folders: Array.isArray(r.folders) ? r.folders : [],
    servers: Array.isArray(r.servers) ? r.servers : [],
  };
}

/** The pills of a meeting right now. */
export function pillsOf(key: string): SourceToggles {
  return useAssistSourcesStore.getState().pills[key] ?? useSourcesStore.getState().toggles;
}

export const useAssistSourcesStore = create<AssistSourcesState>((set, get) => ({
  info: {},
  pills: {},

  refresh: async (meetingId) => {
    const key = meetingKeyOf(meetingId);
    try {
      const info = normalizeInfo(await getAssistSources(key === LIVE_KEY ? null : key));
      if (info) set((s) => ({ info: { ...s.info, [key]: info } }));
    } catch (e) {
      console.warn("[assistSources] Couldn't read the workspace's Knowledge and Tools:", e);
    }
  },

  setPill: (meetingId, kind, on) => {
    const key = meetingKeyOf(meetingId);
    set((s) => ({ pills: { ...s.pills, [key]: { ...(s.pills[key] ?? useSourcesStore.getState().toggles), [kind]: on } } }));
  },
}));

/**
 * The pills as they are right now, for a request the user makes: sent with every answer that
 * asks (any provider: the Knowledge pill is a lock for documents, notes and folders everywhere).
 * Tools count only with something usable behind them on a subscription agent.
 */
export function requestToggles(meetingId?: string | null): SourceToggles {
  const key = meetingKeyOf(meetingId);
  const t = pillsOf(key);
  const info = useAssistSourcesStore.getState().info[key];
  const toolsUsable = isCliAgent(useConfigStore.getState().llmProvider) && (!info || holdsTools(info));
  return { library: t.library, tools: t.tools && toolsUsable };
}

/**
 * Whether answers asked with `toggles` may wait for a with-sources session to start: a folder
 * behind Knowledge or a server behind Tools, on a subscription agent.
 */
export function asksForSession(toggles: SourceToggles | undefined, meetingId?: string | null): boolean {
  if (!toggles || !isCliAgent(useConfigStore.getState().llmProvider)) return false;
  const info = useAssistSourcesStore.getState().info[meetingKeyOf(meetingId)];
  if (!info) return toggles.library || toggles.tools;
  return (toggles.library && info.folders.some((f) => f.used)) || (toggles.tools && holdsTools(info));
}

export { holdsKnowledge, holdsTools };
