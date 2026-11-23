import { useEffect } from "react";
import { emitAgentFallbackShown, onAgentFallback, onAgentFallbackShown } from "../lib/events";
import { isRateLimitText } from "../lib/agentUsage";
import { isWindowShown } from "../lib/windows";
import { useMeetingStore } from "../stores/meetingStore";
import { useConfigStore } from "../stores/configStore";
import { cliAgentName, isCliAgent } from "../lib/cliAgents";
import { showToast } from "../stores/toastStore";
import type { AgentFallbackEvent } from "../lib/types";

/** Toast copy for one `agent_fallback` event. */
export function fallbackMessage({ reason, provider }: AgentFallbackEvent, agentName = "Claude"): string {
  if (isRateLimitText(reason)) {
    return provider ? `${agentName} usage limit reached — using ${provider}` : `${agentName} usage limit reached`;
  }
  return `${agentName} unavailable (${reason}) — using ${provider}`;
}

/**
 * Which window shows the notice. During a meeting the overlay does, otherwise
 * the launcher; a window the user cannot see yields to the other one when that
 * one is visible. Both windows evaluate this with the same inputs, so exactly
 * one of them says yes; with neither visible nobody does (the notice waits).
 */
export function shouldToastHere(o: {
  windowLabel: "launcher" | "overlay";
  inMeeting: boolean;
  thisShown: boolean;
  otherShown: boolean;
}): boolean {
  if (!o.thisShown) return false;
  const preferred = o.inMeeting ? "overlay" : "launcher";
  return o.windowLabel === preferred || !o.otherShown;
}

/**
 * Toast when requests move from the CLI agent to the fallback provider (or a usage
 * limit is hit with no fallback). The backend announces each outage once and
 * the event reaches both windows, so the notice is held until a window the
 * user can see claims it (`shouldToastHere`); the claim is broadcast so the
 * other window drops its copy.
 */
export function useAgentFallbackToast(windowLabel: string): void {
  useEffect(() => {
    if (!windowLabel) return;
    const me = windowLabel === "overlay" ? "overlay" : "launcher";
    const other = me === "overlay" ? "launcher" : "overlay";
    let pending: AgentFallbackEvent | null = null;
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    const attempt = async () => {
      const event = pending;
      if (!event) return;
      const [thisShown, otherShown] = await Promise.all([isWindowShown(me), isWindowShown(other)]);
      // Another window may have claimed it, or a newer event replaced it, meanwhile.
      if (disposed || pending !== event) return;
      const inMeeting = useMeetingStore.getState().activeMeeting != null;
      if (!shouldToastHere({ windowLabel: me, inMeeting, thisShown, otherShown })) return;
      pending = null;
      const active = useConfigStore.getState().llmProvider;
      showToast(fallbackMessage(event, isCliAgent(active) ? cliAgentName(active) : "Claude"), "warning");
      emitAgentFallbackShown().catch(() => {});
    };

    const track = (p: Promise<() => void>) =>
      p
        .then((fn) => (disposed ? fn() : unlisteners.push(fn)))
        .catch((e) => console.warn("[useAgentFallbackToast] listen failed:", e));

    track(
      onAgentFallback((event) => {
        pending = event;
        void attempt();
      }),
    );
    track(onAgentFallbackShown(() => (pending = null)));

    // A hidden window that comes back shows what it was holding.
    const onBack = () => void attempt();
    window.addEventListener("focus", onBack);
    document.addEventListener("visibilitychange", onBack);

    return () => {
      disposed = true;
      window.removeEventListener("focus", onBack);
      document.removeEventListener("visibilitychange", onBack);
      unlisteners.forEach((fn) => fn());
    };
  }, [windowLabel]);
}
