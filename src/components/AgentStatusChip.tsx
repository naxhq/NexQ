// Footer chip for the Claude subscription provider: a status dot, the live
// session's state during a meeting, and a hover card with login state, model,
// effort and thinking per tier, and the meeting's usage and response times.
// Rendered by ServiceStatusBar in both windows.

import { useEffect, useId, useState, type ReactNode } from "react";
import { Brain, ChevronUp } from "lucide-react";
import { useAgentStore } from "../stores/agentStore";
import { useConfigStore } from "../stores/configStore";
import { useMeetingAgentUsage } from "../hooks/useMeetingAgentUsage";
import {
  API_BILLED_NOTE,
  NPM_ONLY_NOTE,
  avgFirstTokenMs,
  avgLatencyMs,
  formatAgo,
  formatCostEstimate,
  formatDuration,
  formatTokenUsage,
  isApiBilled,
  isRateLimited,
} from "../lib/agentUsage";
import { claudeTierLabel } from "../settings/ClaudeCliSettings";
import type { AgentSessionStatus, ClaudeCliConfig, ClaudeCliStatus, ClaudeModelInfo, SessionUsage } from "../lib/types";

export type AgentChipState = "idle" | "starting" | "ready" | "busy" | "error" | "limited" | "attention";

// Color carries the state: green ready, amber starting / busy / needs the
// user / limit hit, red error, neutral unknown. Only starting and busy pulse.
const STATE_STYLE: Record<AgentChipState, { dot: string; pill: string; pulse: boolean }> = {
  ready: { dot: "bg-success", pill: "bg-success/10 border border-success/20", pulse: false },
  starting: { dot: "bg-warning", pill: "bg-warning/10 border border-warning/20", pulse: true },
  busy: { dot: "bg-warning", pill: "bg-warning/10 border border-warning/20", pulse: true },
  limited: { dot: "bg-warning", pill: "bg-warning/10 border border-warning/20", pulse: false },
  attention: { dot: "bg-warning", pill: "bg-warning/10 border border-warning/20", pulse: false },
  error: { dot: "bg-destructive", pill: "bg-destructive/10 border border-destructive/20", pulse: false },
  idle: { dot: "bg-muted-foreground/30", pill: "bg-secondary/30 border border-transparent", pulse: false },
};

const SESSION_STATE_LABEL: Record<AgentSessionStatus["state"], string> = {
  starting: "starting",
  ready: "ready",
  busy: "answering",
  error: "error",
  closed: "closed",
};

function sessionState(sessions: AgentSessionStatus[]): { state: AgentChipState; label: string } {
  // A with-sources session that failed to start is reported on the sources
  // pills; the plain session still answers, so the chip stays as it was.
  const errors = sessions.filter((s) => s.state === "error" && !s.with_sources);
  if (errors.length > 0) {
    // A real fault outranks a limit on the other tier.
    return errors.every(isRateLimited)
      ? { state: "limited", label: "Usage limit" }
      : { state: "error", label: "Session error" };
  }
  if (sessions.some((s) => s.state === "busy")) return { state: "busy", label: "Thinking…" };
  if (sessions.some((s) => s.state === "starting")) return { state: "starting", label: "Starting…" };
  return { state: "ready", label: "Session ready" };
}

function providerState(
  status: ClaudeCliStatus | undefined,
  statusError: string | undefined,
): { state: AgentChipState; label: string } {
  if (!status) return { state: "idle", label: statusError ? "" : "Checking…" };
  if (!status.installed) return { state: "attention", label: status.npm_only ? "Needs native install" : "Not installed" };
  if (!status.auth) return { state: "idle", label: "" };
  if (!status.auth.logged_in) return { state: "attention", label: "Not logged in" };
  // Usable, but never green: it doesn't use the subscription.
  if (isApiBilled(status)) return { state: "attention", label: "API account" };
  return { state: "ready", label: "Ready" };
}

function providerNote(status: ClaudeCliStatus | undefined): string {
  if (status && !status.installed) return status.npm_only ? NPM_ONLY_NOTE : "Claude Code is not installed on this PC";
  if (status?.auth && !status.auth.logged_in) return "Not logged in — sign in from Settings";
  return "";
}

/** "Signed in · Max plan" / "Not logged in" / "" when unknown. */
function loginLine(status: ClaudeCliStatus | undefined): string {
  if (!status?.installed || !status.auth) return "";
  if (!status.auth.logged_in) return "Not logged in";
  const plan = status.auth.subscription_type;
  return plan ? `Signed in · ${plan.charAt(0).toUpperCase()}${plan.slice(1)} plan` : "Signed in";
}

interface TierRow {
  tier: "Fast" | "Deep";
  label: string;
  thinking: boolean;
  state: AgentSessionStatus["state"] | null;
}

function tierRows(sessions: AgentSessionStatus[], cfg: ClaudeCliConfig, models?: ClaudeModelInfo[]): TierRow[] {
  return (["fast", "deep"] as const).map((tier) => {
    const s = sessions.find((x) => x.tier === tier && !x.with_sources) ?? sessions.find((x) => x.tier === tier);
    const effort = tier === "fast" ? cfg.fast_effort : cfg.deep_effort;
    const model = s?.model ?? (tier === "fast" ? cfg.fast_model : cfg.deep_model);
    return {
      tier: tier === "fast" ? "Fast" : "Deep",
      label: claudeTierLabel(model, effort, models),
      thinking: tier === "fast" ? cfg.fast_thinking : cfg.deep_thinking,
      state: s?.state ?? null,
    };
  });
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right tabular-nums text-foreground/90">{children}</dd>
    </div>
  );
}

function HoverCard({
  id,
  sessions,
  usage,
  cfg,
  status,
  note,
  apiBilled,
  models,
}: {
  id: string;
  sessions: AgentSessionStatus[];
  usage: SessionUsage;
  cfg: ClaudeCliConfig;
  status: ClaudeCliStatus | undefined;
  note: string;
  apiBilled: boolean;
  models?: ClaudeModelInfo[];
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const inSession = sessions.length > 0;
  const login = loginLine(status);
  const detail = sessions.find((s) => s.state === "error" && s.detail)?.detail;
  const avg = avgLatencyMs(usage);
  const avgFirst = avgFirstTokenMs(usage);

  return (
    <div
      id={id}
      role="tooltip"
      data-testid="agent-hover-card"
      className="absolute bottom-full left-0 z-50 mb-2 w-72 rounded-xl border border-border/40 bg-popover p-3 text-meta shadow-lg animate-in fade-in-0 slide-in-from-bottom-1 duration-150"
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-semibold text-foreground">
          {apiBilled ? "Claude (API account)" : "Claude (subscription)"}
        </span>
        {login && <span className="truncate text-muted-foreground">{login}</span>}
      </div>
      {apiBilled && <p className="mt-1 text-warning">{API_BILLED_NOTE}</p>}

      <dl className="mt-2.5 space-y-1">
        {tierRows(sessions, cfg, models).map((row) => (
          <Row key={row.tier} label={row.tier}>
            {row.label} · thinking {row.thinking ? "on" : "off"}
            {row.state && <span className="text-muted-foreground"> · {SESSION_STATE_LABEL[row.state]}</span>}
          </Row>
        ))}
      </dl>

      {inSession && (
        <dl className="mt-2.5 space-y-1 border-t border-border/30 pt-2.5">
          <Row label="Requests this meeting">{usage.requests}</Row>
          {usage.requests > 0 && usage.last_request_at_ms > 0 && (
            <Row label="Last request">
              {formatAgo(usage.last_request_at_ms, Math.max(now, usage.last_request_at_ms))} ·{" "}
              {formatDuration(usage.last_latency_ms)}
            </Row>
          )}
          {avg != null && (
            <Row label="Average response">
              {formatDuration(avg)}
              {avgFirst != null && (
                <span className="text-muted-foreground"> · first words {formatDuration(avgFirst)}</span>
              )}
            </Row>
          )}
          <Row label="Tokens">{formatTokenUsage(usage)}</Row>
          <p className="pt-0.5 text-muted-foreground">{formatCostEstimate(usage, apiBilled)}</p>
        </dl>
      )}

      {(detail || note) && (
        <p className={`mt-2.5 border-t border-border/30 pt-2.5 ${detail ? "text-destructive" : "text-muted-foreground"}`}>
          {detail ?? note}
        </p>
      )}
    </div>
  );
}

export function AgentStatusChip({
  compact = false,
  onClick,
  pickerOpen = false,
}: {
  compact?: boolean;
  onClick?: () => void;
  pickerOpen?: boolean;
}) {
  const status = useAgentStore((s) => s.status);
  const statusError = useAgentStore((s) => s.statusError);
  const cfg = useConfigStore((s) => s.claudeCliConfig);
  const claudeModels = useConfigStore((s) => s.claudeModels);
  const { sessions, usage } = useMeetingAgentUsage();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const cardId = useId();

  // Session updates only arrive once the store has subscribed (per window).
  useEffect(() => {
    const store = useAgentStore.getState();
    store.init();
    if (!store.status) void store.refreshStatus();
  }, []);

  // Closed sessions are dropped from the store, so any session here is open.
  const inSession = sessions.length > 0;
  const apiBilled = isApiBilled(status);
  const chip = inSession ? sessionState(sessions) : providerState(status, statusError);
  // An API-billed login is never shown green, in a session or not.
  const state: AgentChipState = apiBilled && chip.state === "ready" ? "attention" : chip.state;
  const label = chip.label;
  const style = STATE_STYLE[state];
  // The picker replaces the card while it is open.
  const cardOpen = (hovered || focused) && !dismissed && !pickerOpen;

  return (
    <div
      className="relative"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setDismissed(false);
      }}
    >
      <div
        data-testid="agent-status-chip"
        role={onClick ? "button" : undefined}
        tabIndex={0}
        aria-label={`AI provider: Claude${label ? `, ${label}` : ""}`}
        aria-describedby={cardOpen ? cardId : undefined}
        aria-expanded={onClick ? pickerOpen : undefined}
        className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-primary/40 ${style.pill} ${
          onClick ? "cursor-pointer hover:brightness-110" : ""
        }`}
        onClick={onClick}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          setDismissed(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") setDismissed(true);
          else if (onClick && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            onClick();
          }
        }}
      >
        <span className="relative flex h-2 w-2 shrink-0">
          {style.pulse && (
            <span className={`absolute inline-flex h-full w-full animate-pulse rounded-full ${style.dot} opacity-40`} />
          )}
          <span
            data-testid="agent-status-dot"
            data-state={state}
            className={`relative inline-flex h-2 w-2 rounded-full transition-colors duration-200 ${style.dot}`}
          />
        </span>
        <Brain className={`h-3.5 w-3.5 shrink-0 ${state === "idle" ? "text-muted-foreground/60" : "text-foreground/70"}`} />
        <div className="flex min-w-0 items-center gap-1">
          {!compact && <span className="text-xs font-medium text-foreground/90">Claude</span>}
          {label && (
            <span className={`truncate ${compact ? "text-xs font-medium text-foreground/90" : "text-meta text-foreground/60"}`}>
              {label}
            </span>
          )}
        </div>
        {onClick && (
          <ChevronUp
            className={`h-2.5 w-2.5 shrink-0 transition-all duration-200 ${
              pickerOpen ? "rotate-0 text-foreground/60" : "rotate-180 text-muted-foreground/50"
            }`}
          />
        )}
      </div>
      {cardOpen && (
        <HoverCard
          id={cardId}
          sessions={sessions}
          usage={usage}
          cfg={cfg}
          status={status}
          note={inSession ? "" : providerNote(status)}
          apiBilled={apiBilled}
          models={claudeModels ?? undefined}
        />
      )}
    </div>
  );
}
