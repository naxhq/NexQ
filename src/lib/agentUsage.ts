// Pure helpers for Claude session status and usage, shared by the footer chip,
// the AI Log header and the fallback toast.

import type { AgentSessionStatus, ClaudeCliStatus, SessionUsage } from "./types";

/** Shown wherever a login that bills an API account would read as connected. */
export function apiBilledNoteFor(agentName: string): string {
  return `This ${agentName} login bills an API account, not your subscription.`;
}

export const API_BILLED_NOTE = apiBilledNoteFor("Claude");

/** Shown when only an npm install of Claude Code (`claude.cmd`) was found. */
export const NPM_ONLY_NOTE = "Found an npm install of Claude Code — NexQ needs the native installer";

/** Claude Code is installed but older than NexQ can launch (the backend sets `required_version` only then). */
export function isOutdated(status: ClaudeCliStatus | undefined | null): boolean {
  return !!status?.installed && !!status.required_version;
}

/** The `2.1.206` of a `--version` output such as "2.1.206 (Claude Code)", or null. */
export function versionNumber(version: string | null | undefined): string | null {
  return version?.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
}

/** "Claude Code 2.1.206 is too old" (the version is left out when unknown). */
export function outdatedLine(status: ClaudeCliStatus | undefined | null): string {
  const version = versionNumber(status?.version);
  return `Claude Code${version ? ` ${version}` : ""} is too old`;
}

/** What to do about an outdated Claude Code. */
export function outdatedNote(status: ClaudeCliStatus | undefined | null): string {
  return `NexQ needs Claude Code ${status?.required_version ?? "a newer version"} or newer. Update it, then check the connection.`;
}

/** A Windows path (drive letter or network share). */
function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]|^\\\\/.test(path);
}

/** Where the update command is typed. */
export function updateShell(binaryPath: string): string {
  return isWindowsPath(binaryPath) ? "PowerShell" : "a terminal";
}

/**
 * The command that updates the Claude Code at `binaryPath`. Single quotes, so a
 * `$` in the path stays literal; PowerShell also needs its call operator to run
 * a quoted path.
 */
export function updateCommand(binaryPath: string): string {
  return isWindowsPath(binaryPath)
    ? `& '${binaryPath.replace(/'/g, "''")}' update`
    : `'${binaryPath.replace(/'/g, "'\\''")}' update`;
}

/** The Claude login bills an API account (usable, but not the subscription). */
export function isApiBilled(status: ClaudeCliStatus | undefined | null): boolean {
  return status?.auth?.login === "api_billed";
}

/** Shown where a Codex API-key login would otherwise read as connected. */
export const CODEX_API_KEY_NOTE =
  "This Codex login uses an API key. NexQ needs Codex signed in with your ChatGPT account: run `codex login` and choose Sign in with ChatGPT.";

/** Codex is logged in with an API key: not usable (the backend reports it as not logged in, with this method). */
export function isApiKeyLogin(status: ClaudeCliStatus | undefined | null): boolean {
  return status?.auth?.auth_method === "api_key" && !status.auth.logged_in;
}

const NUMBER = new Intl.NumberFormat("en-US");

export function formatTokens(n: number): string {
  return NUMBER.format(Math.round(n));
}

export function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.005) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

export const EMPTY_USAGE: SessionUsage = {
  input_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  output_tokens: 0,
  thinking_tokens: 0,
  cost_usd: 0,
  requests: 0,
  total_latency_ms: 0,
  total_first_token_ms: 0,
  last_latency_ms: 0,
  last_request_at_ms: 0,
};

/** Every prompt token: uncached, cache reads and cache writes. */
export function promptTokens(u: Pick<SessionUsage, "input_tokens" | "cache_read_tokens" | "cache_write_tokens">): number {
  return u.input_tokens + (u.cache_read_tokens ?? 0) + (u.cache_write_tokens ?? 0);
}

/** "850 ms" / "1.2 s" / "31 s" / "2 min 5 s" */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 10) return `${(Math.round(s * 10) / 10).toFixed(1)} s`;
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  return rest > 0 ? `${m} min ${rest} s` : `${m} min`;
}

/** "Last answer: 1.2 s total, first words after 600 ms" */
export function lastAnswerTooltip(latencyMs: number, firstTokenMs: number | null): string {
  const total = `Last answer: ${formatDuration(latencyMs)} total`;
  return firstTokenMs != null ? `${total}, first words after ${formatDuration(firstTokenMs)}` : total;
}

/** "just now" / "40 s ago" / "2 min ago" / "3 h ago" */
export function formatAgo(atMs: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - atMs) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.floor(m / 60)} h ago`;
}

/** Average wall time per answered request (ms), or null before the first one. */
export function avgLatencyMs(u: SessionUsage): number | null {
  return u.requests > 0 ? u.total_latency_ms / u.requests : null;
}

/** Average time to the first words per answered request (ms), or null. */
export function avgFirstTokenMs(u: SessionUsage): number | null {
  return u.requests > 0 ? u.total_first_token_ms / u.requests : null;
}

/** "45,210 in (38,000 cached)": every prompt token, and how many came from the cache. */
export function formatPromptTokens(u: Pick<SessionUsage, "input_tokens" | "cache_read_tokens" | "cache_write_tokens">): string {
  const cached = u.cache_read_tokens ?? 0;
  return `${formatTokens(promptTokens(u))} in${cached > 0 ? ` (${formatTokens(cached)} cached)` : ""}`;
}

/** "in 45,210 (38,000 cached) · out 1,240 (thinking 300)" */
export function formatTokenUsage(u: SessionUsage): string {
  const cached = u.cache_read_tokens ?? 0;
  const thinking = u.thinking_tokens ?? 0;
  return (
    `in ${formatTokens(promptTokens(u))}${cached > 0 ? ` (${formatTokens(cached)} cached)` : ""}` +
    ` · out ${formatTokens(u.output_tokens)}${thinking > 0 ? ` (thinking ${formatTokens(thinking)})` : ""}`
  );
}

/** "3 requests · 45,210 in (38,000 cached) / 1,240 out · avg 1.4 s" */
export function formatUsageSummary(u: SessionUsage): string {
  const parts = [
    `${u.requests} request${u.requests === 1 ? "" : "s"}`,
    `${formatPromptTokens(u)} / ${formatTokens(u.output_tokens)} out`,
  ];
  const avg = avgLatencyMs(u);
  if (avg != null) parts.push(`avg ${formatDuration(avg)}`);
  return parts.join(" · ");
}

/**
 * The cost line shown wherever usage appears. `apiBilled` null: the agent that
 * ran the sessions is unknown, so no billing claim is made.
 */
export function formatCostEstimate(u: SessionUsage, apiBilled: boolean | null = false): string {
  const estimate = `≈ ${formatCost(u.cost_usd)} estimate`;
  if (apiBilled === null) return estimate;
  return `${estimate} — ${apiBilled ? "billed to your API account" : "included in your subscription"}`;
}

/** Name used when the agent behind the sessions is not known. */
export const NEUTRAL_AGENT_LABEL = "Subscription AI";

/**
 * Who the meeting's agent sessions are attributed to. Session rows carry no
 * agent kind, so only an active CLI agent can be named (and its billing
 * claimed); with an API provider active the sessions may come from any agent,
 * so the label is neutral and no billing is claimed.
 */
export function usageAttribution(
  llmProvider: string,
  statuses: Record<string, ClaudeCliStatus | undefined>,
  agentName: (provider: string) => string,
  isAgent: (provider: string) => boolean,
): { label: string; apiBilled: boolean | null } {
  if (!isAgent(llmProvider)) return { label: NEUTRAL_AGENT_LABEL, apiBilled: null };
  return { label: agentName(llmProvider), apiBilled: isApiBilled(statuses[llmProvider]) };
}

/** Live-scope sessions of one meeting (fast and/or deep). */
export function liveSessionsOf(
  sessions: Record<string, AgentSessionStatus>,
  meetingId: string | null,
): AgentSessionStatus[] {
  if (!meetingId) return [];
  return Object.values(sessions).filter((s) => s.scope === "live" && s.meeting_id === meetingId);
}

/** Cumulative fields of `SessionUsage` (only ever grow within a scope). */
const CUMULATIVE: Array<Exclude<keyof SessionUsage, "last_latency_ms" | "last_request_at_ms">> = [
  "input_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "output_tokens",
  "thinking_tokens",
  "cost_usd",
  "requests",
  "total_latency_ms",
  "total_first_token_ms",
];

/**
 * Cumulative usage of a meeting. Every session carries the usage of its whole
 * scope (both tiers), snapshotted when that session last changed, so tiers are
 * not summed: the larger snapshot per field is the latest one. The "last
 * request" fields come from the snapshot that saw the latest request.
 */
export function scopeUsage(list: AgentSessionStatus[]): SessionUsage {
  return list.reduce<SessionUsage>((acc, s) => {
    const u = { ...EMPTY_USAGE, ...s.usage };
    const next = { ...acc };
    for (const field of CUMULATIVE) next[field] = Math.max(acc[field], u[field]);
    if (u.last_request_at_ms > acc.last_request_at_ms) {
      next.last_request_at_ms = u.last_request_at_ms;
      next.last_latency_ms = u.last_latency_ms;
    }
    return next;
  }, { ...EMPTY_USAGE });
}

/** Text fallback for a limit error when the backend sent no `error_kind`. */
export function isRateLimitText(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  return (
    t.includes("rate limit") ||
    t.includes("usage limit") ||
    (t.includes("limit reached") && !t.includes("context")) ||
    t.includes("too many requests") ||
    t.includes("per minute")
  );
}

/** The session stopped on a usage / rate limit (not a fault). */
export function isRateLimited(s: Pick<AgentSessionStatus, "error_kind" | "detail">): boolean {
  return s.error_kind != null ? s.error_kind === "rate_limited" : isRateLimitText(s.detail);
}
