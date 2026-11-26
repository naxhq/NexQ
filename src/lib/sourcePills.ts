import type { AgentSessionStatus, AssistSources } from "./types";
import { cliAgentName, isCliAgent } from "./cliAgents";

/** The two pills of the assistant panel: Knowledge (the workspace's documents, notes and folders) and Tools (its MCP servers). */
export type PillKind = "knowledge" | "tools";

/** How a Knowledge or Tools pill looks and acts. `unavailable`: shown, but this provider can't use it. */
export type PillState = "hidden" | "off" | "on" | "loading" | "error" | "unavailable";

export interface PillContext {
  provider: string;
  /** The meeting's workspace holds something of this kind (a document, note or folder; a usable tool server). */
  held: boolean;
  /** The user's pill for this meeting. */
  on: boolean;
  /** The with-sources agent session this pill's answers come from, if it exists. */
  session?: Pick<AgentSessionStatus, "state"> | AgentSessionStatus;
}

/**
 * The rules, in order:
 * 1. the meeting's workspace holds nothing of this kind: hidden;
 * 2. Tools on a provider that isn't a subscription CLI agent: unavailable (shown, not clickable, with the reason);
 * 3. the sources session failed: error, whether the pill is on or not, so the user sees why sources are down;
 * 4. the pill is on and the session is still starting: loading;
 * 5. otherwise on or off.
 */
export function pillState(kind: PillKind, ctx: PillContext): PillState {
  if (!ctx.held) return "hidden";
  const cli = isCliAgent(ctx.provider);
  if (kind === "tools" && !cli) return "unavailable";
  if (cli && ctx.session?.state === "error") return "error";
  if (cli && ctx.on && ctx.session?.state === "starting") return "loading";
  return ctx.on ? "on" : "off";
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What the Knowledge pill covers, in words: "3 documents, 1 note, 1 folder (DePaul)". Empty when nothing. */
export function knowledgeIncludes(info: AssistSources): string {
  const parts: string[] = [];
  if (info.documents > 0) parts.push(plural(info.documents, "document", "documents"));
  if (info.notes > 0) parts.push(plural(info.notes, "note", "notes"));
  const used = info.folders.filter((f) => f.used);
  if (used.length > 0) parts.push(`${plural(used.length, "folder", "folders")} (${used.map((f) => f.label).join(", ")})`);
  return parts.join(", ");
}

/** What the Tools pill covers: "mira (9 of 19 tools)", one per usable server. Empty when nothing. */
export function toolsIncludes(info: AssistSources): string {
  return info.servers
    .filter((s) => s.usable)
    .map((s) => `${s.label} (${s.allowed_tools} of ${s.total_tools} tools)`)
    .join(", ");
}

/** Whether the workspace holds Knowledge (a document, note or folder that is switched on). */
export function holdsKnowledge(info: AssistSources | undefined | null): boolean {
  return !!info && (info.documents > 0 || info.notes > 0 || info.folders.some((f) => f.used));
}

/** Whether the workspace holds a tool server that could be used. */
export function holdsTools(info: AssistSources | undefined | null): boolean {
  return !!info && info.servers.some((s) => s.usable);
}

/** The words of one pill's hover card. */
export interface PillCardText {
  title: string;
  includes: string;
  on: string;
  off: string;
  /** What this provider can't do, or how it differs; null when nothing to add. */
  limit: string | null;
}

/** What the pill says on hover: what it covers in this workspace, what on and off do, and the provider's limits. */
export function pillCard(kind: PillKind, info: AssistSources, provider: string): PillCardText {
  const cli = isCliAgent(provider);
  if (kind === "knowledge") {
    const hasFolders = info.folders.some((f) => f.used);
    const off = info.folders.filter((f) => !f.used).map((f) => f.label);
    const limit = hasFolders
      ? cli
        ? `${cliAgentName(provider)} reads the folders' files itself.`
        : "With this provider NexQ searches the folders and sends the best matching passages with your question."
      : null;
    return {
      title: "Knowledge",
      includes: knowledgeIncludes(info) + (off.length > 0 ? `. Off in Settings: ${off.join(", ")}` : ""),
      on: "Your next answer can use these.",
      off: "Nothing from them is sent with your next answer.",
      limit,
    };
  }
  return {
    title: "Tools",
    includes: toolsIncludes(info),
    on: "Your next answer can call the allowed tools.",
    off: "No tool server starts for your next answer.",
    limit: cli
      ? null
      : "Tools work with a Claude, Codex or Antigravity subscription. Switch provider in Settings to use them.",
  };
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
