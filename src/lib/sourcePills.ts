import type { AgentSessionStatus } from "./types";

/** How a Notes or Tools pill looks and acts. */
export type PillState = "hidden" | "off" | "on" | "loading" | "error";

export interface PillContext {
  provider: string;
  /** Something of this kind is set up and usable (an enabled folder, a ready server). */
  enabled: boolean;
  /** The user's pill. */
  on: boolean;
  /** The with-sources Claude session this pill's answers come from, if it exists. */
  session?: Pick<AgentSessionStatus, "state"> | AgentSessionStatus;
}

/**
 * The rules, in order:
 * 1. not the Claude subscription, or nothing of this kind set up: hidden;
 * 2. the sources session failed: error, whether the pill is on or not, so the
 *    user sees why sources are down;
 * 3. the pill is on and the session is still starting: loading;
 * 4. otherwise on or off.
 */
export function pillState(_kind: "notes" | "tools", ctx: PillContext): PillState {
  if (ctx.provider !== "claude_cli" || !ctx.enabled) return "hidden";
  if (ctx.session?.state === "error") return "error";
  if (ctx.on && ctx.session?.state === "starting") return "loading";
  return ctx.on ? "on" : "off";
}

/**
 * The with-sources session that answers `scope`: the Fast one of the live
 * meeting, or the Deep one of that past meeting.
 */
export function findSourcesSession(
  sessions: Record<string, AgentSessionStatus>,
  scope: "live" | "past",
  meetingId?: string | null,
): AgentSessionStatus | undefined {
  return Object.values(sessions).find((s) => {
    if (!s.with_sources) return false;
    if (scope === "live") return s.scope === "live" && s.tier === "fast";
    return s.scope === "past" && s.tier === "deep" && s.meeting_id === (meetingId ?? null);
  });
}
