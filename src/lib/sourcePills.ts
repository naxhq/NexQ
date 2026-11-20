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
 * meeting, or that past meeting's: Deep, or Fast when both tiers have the same
 * settings (the backend then runs only the Fast one).
 */
export function findSourcesSession(
  sessions: Record<string, AgentSessionStatus>,
  scope: "live" | "past",
  meetingId?: string | null,
): AgentSessionStatus | undefined {
  const all = Object.values(sessions).filter((s) => s.with_sources);
  if (scope === "live") return all.find((s) => s.scope === "live" && s.tier === "fast");
  const ofMeeting = all.filter((s) => s.scope === "past" && s.meeting_id === (meetingId ?? null));
  return ofMeeting.find((s) => s.tier === "deep") ?? ofMeeting.find((s) => s.tier === "fast");
}
