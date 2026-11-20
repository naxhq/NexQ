// A user-invoked AI action (button, shortcut, Ask, detected question): the
// picked transcript scope is resolved and sent, the right panel shows
// "Sending…" at once, and a non-sticky scope goes back to the default.
// Background generations (summary, action items, bookmarks) call
// generateAssist directly and never carry a scope.

import { generateAssist } from "./ipc";
import { resolveScope, DEFAULT_CONTEXT_SCOPE } from "./contextScope";
import { getModeLabel } from "./utils";
import type { ImageAttachment, IntelligenceMode, SourceToggles } from "./types";
import { useConfigStore } from "../stores/configStore";
import { useStreamStore } from "../stores/streamStore";
import { useAIActionsStore } from "../stores/aiActionsStore";

/** The name the action row shows for `mode` ("F/U", a custom action's name...). */
export function actionLabel(mode: string): string {
  const actions = useAIActionsStore.getState().configs.actions;
  const cfg = actions[mode] ?? Object.values(actions).find((a) => a.mode === mode);
  return cfg?.name || getModeLabel(mode as IntelligenceMode) || mode;
}

/**
 * Resolves once the answer has finished (or was stopped); rejects when it
 * couldn't start, e.g. "Generation already in progress". `requestId` lets the
 * caller name the request, to stop exactly this one later.
 */
export async function runUserAction(
  mode: string,
  customQuestion?: string,
  opts: {
    requestId?: string;
    images?: ImageAttachment[];
    /**
     * The Notes / Tools pills when the user asks. Only an answer the user asked
     * for passes this; an automatic answer (Auto-Answer) never does.
     */
    sources?: SourceToggles;
  } = {},
): Promise<void> {
  const config = useConfigStore.getState();
  const setting = config.contextScope ?? DEFAULT_CONTEXT_SCOPE;
  const stream = useStreamStore.getState();
  const scope = resolveScope(setting, mode, actionLabel(mode), stream.lastUserRequest, Date.now());
  const requestId = opts.requestId ?? crypto.randomUUID();
  // Another action is already on its way: the backend will refuse this one.
  const busy = stream.isStreaming || stream.phase === "sending";

  stream.setPending(mode, requestId, opts.sources);
  // A one-off scope is used up by this action (not by a click the running
  // stream will refuse).
  if (!config.contextScopeSticky && setting.kind !== "default" && !busy) {
    config.setContextScope({ ...setting, kind: "default" });
  }

  try {
    await generateAssist(mode, customQuestion, {
      requestId,
      scope,
      images: opts.images,
      ...(opts.sources ? { sources: opts.sources } : {}),
    });
  } catch (err) {
    const store = useStreamStore.getState();
    store.clearPending(requestId);
    // The request failed after its stream started, and the backend's error event
    // didn't end it: don't leave the answer panel streaming forever.
    if (store.isStreaming && store.streamRequestId === requestId) {
      store.setError(typeof err === "string" ? err : err instanceof Error ? err.message : "Request failed");
    }
    throw err;
  }
}
