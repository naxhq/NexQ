// Pure helpers for the AI Call Log: per-entry timing/tokens and the stats row.

import { formatTokens } from "../lib/agentUsage";
import type { LogEntry, StreamUsage } from "../lib/types";
import { CLI_AGENTS, isCliAgent } from "../lib/cliAgents";

/** One request's cost: "$0.0043" below a cent, "$0.12" above. */
export function formatRequestCost(usd: number): string {
  if (usd <= 0) return "$0";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** "4,210 in (4,000 cached · 200 written) · 38 out (12 thinking) · ≈$0.0043" */
export function formatActualUsage(u: StreamUsage): string {
  const prompt = u.input_tokens + u.cache_read_tokens + u.cache_write_tokens;
  const cache = [
    u.cache_read_tokens > 0 && `${formatTokens(u.cache_read_tokens)} cached`,
    u.cache_write_tokens > 0 && `${formatTokens(u.cache_write_tokens)} written`,
  ].filter(Boolean);
  const parts = [
    `${formatTokens(prompt)} in${cache.length ? ` (${cache.join(" · ")})` : ""}`,
    `${formatTokens(u.output_tokens)} out${u.thinking_tokens > 0 ? ` (${formatTokens(u.thinking_tokens)} thinking)` : ""}`,
  ];
  if (u.cost_usd != null) parts.push(`≈${formatRequestCost(u.cost_usd)}`);
  return parts.join(" · ");
}

/** Display name the backend gives the Claude subscription provider. */
export const CLAUDE_PROVIDER_LABEL = "Claude (subscription)";

/** Display names the backend gives the subscription CLI agents. */
const CLI_PROVIDER_LABELS = new Set(CLI_AGENTS.map((a) => `${a.name} (subscription)`));

/** Answered by a CLI agent (session or stateless): temperature does not apply there. */
export function isClaudeEntry(e: Pick<LogEntry, "provider" | "sessionKey">): boolean {
  return !!e.sessionKey || CLI_PROVIDER_LABELS.has(e.provider) || isCliAgent(e.provider);
}

/** Time from the request to its first words (ms): measured by the backend when it reports it. */
export function entryFirstTokenMs(e: LogEntry): number | null {
  if (e.usage?.first_token_ms != null) return e.usage.first_token_ms;
  return e.firstTokenAt != null ? Math.max(0, e.firstTokenAt - e.startedAt) : null;
}

/** Actual tokens of an answered entry (prompt incl. cache + output), else the stream's own count. */
export function entryTokens(e: LogEntry): number {
  const u = e.usage;
  if (u) return u.input_tokens + u.cache_read_tokens + u.cache_write_tokens + u.output_tokens;
  return e.totalTokens ?? 0;
}

export interface CallLogStats {
  total: number;
  /** Average end-to-end response time of completed entries (ms). */
  avgLatencyMs: number | null;
  /** Average time to the first words of completed entries (ms). */
  avgFirstTokenMs: number | null;
  totalTokens: number;
  errorCount: number;
}

function average(values: number[]): number | null {
  return values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : null;
}

export function callLogStats(entries: LogEntry[]): CallLogStats {
  const completed = entries.filter((e) => e.status === "complete");
  return {
    total: entries.length,
    avgLatencyMs: average(completed.filter((e) => e.latencyMs != null).map((e) => e.latencyMs as number)),
    avgFirstTokenMs: average(
      completed.map(entryFirstTokenMs).filter((v): v is number => v != null)
    ),
    totalTokens: completed.reduce((s, e) => s + entryTokens(e), 0),
    errorCount: entries.filter((e) => e.status === "error").length,
  };
}

/** "45k" / "999" */
export function formatCompactTokens(n: number): string {
  return n > 999 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}
