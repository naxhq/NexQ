import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { ExternalLink, Loader2, RefreshCw, Terminal } from "lucide-react";
import {
  CODEX_API_KEY_NOTE,
  NPM_ONLY_NOTE,
  apiBilledNoteFor,
  isApiKeyLogin,
  isOutdated,
  isRateLimited,
  outdatedLine,
  outdatedNote,
  updateCommand,
  updateShell,
} from "../lib/agentUsage";
import { getApiKey, listModels, openCliLoginTerminal } from "../lib/ipc";
import { ProviderLogo } from "../components/icons/ProviderLogos";
import {
  CLAUDE_EFFORT_VALUES,
  STATIC_CLAUDE_MODELS,
  findClaudeModel,
  formatCheckedAgo,
  groupClaudeModels,
} from "../lib/claudeModels";
import {
  CLI_AGENTS,
  cliAgentInfo,
  cliEffectiveEffort,
  cliEffortLabel,
  effortRanks,
  resolveListedModel,
  type CliAgentInfo,
} from "../lib/cliAgents";
import type { AgentSessionStatus, ClaudeCliConfig, ClaudeModelInfo, CliAgentKind, CliAgentStatus } from "../lib/types";
import { isSessionRunning, useAgentStore } from "../stores/agentStore";
import { CLI_FALLBACK_PROVIDERS, useConfigStore } from "../stores/configStore";
import { showToast } from "../stores/toastStore";
import { ProviderCard, type StatusTone } from "./ProviderCard";

const FALLBACK_LABELS: Record<string, string> = {
  ollama: "Ollama",
  lm_studio: "LM Studio",
  openai: "OpenAI",
  anthropic: "Anthropic",
  groq: "Groq",
  gemini: "Google Gemini",
  openrouter: "OpenRouter",
};

/** What the status line calls the program ("Claude Code"; the others by their own name). */
function productName(kind: CliAgentKind): string {
  return kind === "claude_cli" ? "Claude Code" : cliAgentInfo(kind).name;
}

type ConnectionState =
  | "checking"
  | "failed"
  | "connected"
  | "api_billed"
  | "logged_out"
  | "not_installed"
  | "npm_only"
  | "outdated"
  | "unknown"
  | "limited"
  | "error";

/** A session of the agent in use that stopped: a usage limit, or a fault. */
interface SessionIssue {
  kind: "limited" | "error";
  detail: string;
}

/** The first failed plain session, as the card shows it. */
function sessionIssueOf(sessions: AgentSessionStatus[]): SessionIssue | null {
  const failed = sessions.filter((s) => s.state === "error" && !s.with_sources);
  if (failed.length === 0) return null;
  const real = failed.filter((s) => !isRateLimited(s));
  const pick = real[0] ?? failed[0];
  return { kind: real.length === 0 ? "limited" : "error", detail: pick.detail ?? "" };
}

function connectionState(
  status: CliAgentStatus | undefined,
  failed: boolean,
  issue: SessionIssue | null,
): ConnectionState {
  // No answer yet: still checking, or the check itself failed.
  if (!status) return failed ? "failed" : "checking";
  if (!status.installed) return status.npm_only ? "npm_only" : "not_installed";
  // Too old to launch: whatever the login says, nothing works until it is updated.
  if (isOutdated(status)) return "outdated";
  if (!status.auth) return "unknown";
  if (!status.auth.logged_in) return "logged_out";
  // Only a subscription login counts as connected; any other login bills an API account.
  if (status.auth.login !== "subscription") return "api_billed";
  return issue ? issue.kind : "connected";
}

// Color carries the state: green ok, amber needs the user, neutral absent.
const STATE_TONE: Record<ConnectionState, StatusTone> = {
  checking: "checking",
  failed: "warn",
  connected: "ok",
  api_billed: "warn",
  logged_out: "warn",
  unknown: "warn",
  not_installed: "neutral",
  npm_only: "warn",
  outdated: "warn",
  limited: "warn",
  error: "warn",
};

function planLabel(plan: string | null): string | null {
  if (!plan) return null;
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

/** Short state shown on the provider row. */
const ROW_LABEL: Record<ConnectionState, string> = {
  checking: "Checking…",
  failed: "Couldn't check",
  connected: "Connected",
  api_billed: "API account",
  logged_out: "Logged out",
  unknown: "Login state unknown",
  not_installed: "Not installed",
  npm_only: "Needs native install",
  outdated: "Needs update",
  limited: "Usage limit",
  error: "Session error",
};

/** Full state line of the details panel. */
function statusLine(
  kind: CliAgentKind,
  state: ConnectionState,
  status: CliAgentStatus | undefined,
  issue: SessionIssue | null,
): string {
  switch (state) {
    case "checking":
      return `Looking for ${productName(kind)}…`;
    case "failed":
      return `Couldn't check for ${productName(kind)}`;
    case "not_installed":
      return "Not installed";
    case "npm_only":
      return NPM_ONLY_NOTE;
    case "outdated":
      return outdatedLine(status);
    case "unknown":
      return "Installed — login state unavailable";
    case "logged_out":
      return isApiKeyLogin(status) ? "API key login, needs ChatGPT" : "Not logged in";
    case "limited":
    case "error":
      return issue?.detail || (state === "limited" ? "Usage limit reached" : "The session stopped");
    case "connected":
    case "api_billed": {
      const auth = status?.auth;
      const who = auth?.email ?? (auth?.auth_method === "google" ? "Signed in with Google" : "Logged in");
      return state === "api_billed"
        ? [who, "Not on a subscription"].join(" · ")
        : [who, planLabel(auth?.subscription_type ?? null)].filter(Boolean).join(" · ");
    }
  }
}

/** Outcome of the last check, shown next to Check connection; color only where it means something. */
function checkResult(state: ConnectionState, error: string | undefined): { text: string; className: string } | null {
  if (state === "checking") return null;
  // The last check itself failed: say so, not the state an earlier check found.
  if (error) return { text: `Couldn't check: ${error}`, className: "text-warning" };
  switch (state) {
    case "connected":
    case "limited":
    case "error":
      return { text: "✓ Connected", className: "text-success" };
    case "api_billed":
      return { text: "Not on your subscription", className: "text-warning" };
    case "logged_out":
      return { text: "Not logged in", className: "text-warning" };
    case "unknown":
      return { text: "Login state unavailable", className: "text-warning" };
    case "npm_only":
      return { text: "npm install found — needs the native installer", className: "text-warning" };
    case "outdated":
      return { text: "Update needed", className: "text-warning" };
    case "not_installed":
      return { text: "Not installed", className: "text-muted-foreground" };
    case "failed":
      return { text: "Couldn't check", className: "text-warning" };
  }
}

/** Current time, re-read every `ms` so relative times stay honest. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
  return now;
}

/** While waiting for a login in the terminal: re-check this often, this many times. */
const LOGIN_POLL_MS = 4000;
const LOGIN_POLL_TRIES = 30;

const SELECT_CLASS =
  "rounded-lg border border-border/50 bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50";

const BUTTON_CLASS =
  "inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-background px-3.5 py-2 text-sm font-medium text-foreground transition-all duration-150 hover:bg-accent hover:-translate-y-px active:translate-y-px active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:active:scale-100 cursor-pointer";

/** The agent's status as the store has it, plus the state derived from it. */
function useAgentConnection(kind: CliAgentKind, active: boolean) {
  const status = useAgentStore((s) => s.statuses[kind]);
  const checking = useAgentStore((s) => !!s.checking[kind]);
  const statusFailed = useAgentStore((s) => !!s.statusErrors[kind]);
  const sessions = useAgentStore((s) => s.sessions);
  // Sessions belong to the agent in use.
  const issue = active ? sessionIssueOf(Object.values(sessions)) : null;
  const state = connectionState(status, statusFailed && !checking, issue);
  return { status, checking, state, issue };
}

interface CliAgentSettingsProps {
  /** Provider id being viewed (shows its details); anything else shows none. */
  selectedProvider: string;
  /** Provider in use. */
  activeProvider: string;
  /** Name of the provider in use, for the "Viewing Claude" line while another one is. */
  inUseLabel?: string;
  onSelect: (kind: CliAgentKind) => void;
}

/**
 * "Subscription (local CLI)" group of the AI provider settings: Claude,
 * Antigravity and Codex driven through the user's own login (Beta). One tile
 * per agent; the selected one shows its connection, models and fallback.
 */
export function CliAgentSettings({ selectedProvider, activeProvider, inUseLabel, onSelect }: CliAgentSettingsProps) {
  const refreshStatus = useAgentStore((s) => s.refreshStatus);
  const initAgentStore = useAgentStore((s) => s.init);

  // The viewed agent is checked each time the panel opens; the others only if
  // never checked (the launcher already did at start), so a tile never sits
  // on "Checking…" and opening Settings doesn't start three CLIs.
  useEffect(() => {
    initAgentStore();
    const store = useAgentStore.getState();
    for (const { id } of CLI_AGENTS) {
      if (id === selectedProvider || !store.statuses[id]) void refreshStatus(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initAgentStore, refreshStatus]);

  // A different agent opened: check it too.
  useEffect(() => {
    if (CLI_AGENTS.some((a) => a.id === selectedProvider)) void refreshStatus(selectedProvider as CliAgentKind);
  }, [selectedProvider, refreshStatus]);

  const viewed = CLI_AGENTS.find((a) => a.id === selectedProvider);

  return (
    <div className="rounded-xl border border-border/30 bg-card/50 p-5">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-primary/80">Subscription (local CLI)</h3>
        <span className="rounded-full border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-meta font-semibold uppercase tracking-wider text-warning">
          Beta
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Uses your own Claude, Antigravity or Codex login on this PC. NexQ never sees your credentials.
      </p>

      <div className="mt-4 grid grid-cols-3 gap-2.5">
        {CLI_AGENTS.map((agent) => (
          <AgentTile
            key={agent.id}
            agent={agent}
            active={activeProvider === agent.id}
            viewing={selectedProvider === agent.id}
            onSelect={() => onSelect(agent.id)}
          />
        ))}
      </div>

      {viewed && (
        <AgentDetails
          key={viewed.id}
          agent={viewed}
          active={activeProvider === viewed.id}
          inUseLabel={inUseLabel}
        />
      )}
    </div>
  );
}

function AgentTile({
  agent,
  active,
  viewing,
  onSelect,
}: {
  agent: CliAgentInfo;
  active: boolean;
  viewing: boolean;
  onSelect: () => void;
}) {
  const { state } = useAgentConnection(agent.id, active);
  return (
    <ProviderCard
      name={agent.name}
      icon={<ProviderLogo id={agent.logo} className="h-3.5 w-3.5 shrink-0" />}
      status={{ label: ROW_LABEL[state], tone: STATE_TONE[state] }}
      inUse={active}
      viewing={viewing}
      onClick={onSelect}
      dotTestId={`${agent.name.toLowerCase()}-status-dot`}
      dotState={state}
    />
  );
}

function AgentDetails({
  agent,
  active,
  inUseLabel,
}: {
  agent: CliAgentInfo;
  active: boolean;
  inUseLabel?: string;
}) {
  const kind = agent.id;
  const { status, checking, state, issue } = useAgentConnection(kind, active);
  const [awaitingLogin, setAwaitingLogin] = useState(false);
  const [activating, setActivating] = useState(false);
  const refreshStatus = useAgentStore((s) => s.refreshStatus);
  const refreshModels = useAgentStore((s) => s.refreshModels);
  const checkedAt = useAgentStore((s) => s.checkedAt[kind]);
  const statusError = useAgentStore((s) => s.statusErrors[kind]);
  const modelsRefreshing = useAgentStore((s) => !!s.modelsRefreshing[kind]);
  const now = useNow(15_000);
  const result = checkResult(state, statusError);
  // A check covers both the connection and the model list.
  const busy = checking || modelsRefreshing;

  // A check also refreshes the model catalog (nothing to ask a missing CLI). One
  // that was too old is checked first: after an update its models load too.
  const handleCheck = async () => {
    const checked = refreshStatus(kind);
    if (isOutdated(status)) {
      await checked;
      if (isOutdated(useAgentStore.getState().statuses[kind])) return;
    }
    if (status?.installed !== false) void refreshModels(kind);
  };
  // Same rule as "Set as Active": usable unless known to be missing, too old or logged out.
  const unusable = state === "not_installed" || state === "npm_only" || state === "outdated" || state === "logged_out";

  // The same store action as the footer, so both always agree.
  const handleActivate = async () => {
    setActivating(true);
    try {
      await useConfigStore.getState().activateLLMProvider(kind);
    } catch (e) {
      showToast(`Couldn't switch to ${agent.name}: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setActivating(false);
    }
  };

  // After the login terminal opens: re-check on window focus and every few
  // seconds for a while, until the CLI reports a login.
  useEffect(() => {
    if (!awaitingLogin) return;
    if (state === "connected") {
      setAwaitingLogin(false);
      return;
    }
    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      void refreshStatus(kind);
      if (tries >= LOGIN_POLL_TRIES) setAwaitingLogin(false);
    }, LOGIN_POLL_MS);
    const onFocus = () => void refreshStatus(kind);
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [awaitingLogin, state, refreshStatus, kind]);

  const handleOpenLogin = async () => {
    try {
      await openCliLoginTerminal(kind);
      setAwaitingLogin(true);
    } catch (e) {
      showToast(`Couldn't open a terminal: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  };

  const openInstallPage = (url: string) =>
    open(url).catch((err) =>
      showToast(`Couldn't open the browser: ${err instanceof Error ? err.message : String(err)}`, "error"),
    );

  return (
    <div className="mt-4 space-y-4 border-t border-border/20 pt-4">
      {!active && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-primary/20 bg-primary/5 px-4 py-3">
          <p className="text-xs text-muted-foreground">
            Viewing {agent.name}. NexQ is using {inUseLabel ?? "another provider"}.
          </p>
          <button
            type="button"
            onClick={handleActivate}
            disabled={unusable || activating}
            className={`${BUTTON_CLASS} shrink-0 border-primary/30 text-primary`}
          >
            {activating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Use {agent.name}
          </button>
        </div>
      )}

      {/* Connection */}
      <div>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p
              className={`text-xs font-medium ${state === "limited" || state === "error" || state === "outdated" ? "text-warning" : "text-foreground"}`}
            >
              {statusLine(kind, state, status, issue)}
            </p>
            {status?.installed && (
              <p className="mt-0.5 truncate font-mono text-meta text-muted-foreground/70" title={status.binary_path ?? undefined}>
                {[status.version && `v${status.version}`, status.binary_path].filter(Boolean).join(" — ")}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {!busy && result && checkedAt !== undefined && (
              <span
                role="status"
                className={`max-w-[16rem] truncate text-meta ${result.className}`}
                title={result.text}
              >
                {result.text}
                <span className="text-muted-foreground"> · checked {formatCheckedAgo(checkedAt, Math.max(now, checkedAt))}</span>
              </span>
            )}
            <button type="button" onClick={handleCheck} disabled={busy} className={BUTTON_CLASS}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              {busy ? "Checking…" : "Check connection"}
            </button>
          </div>
        </div>

        {(state === "not_installed" || state === "npm_only") && (
          <div
            className={`mt-3 rounded-lg border px-4 py-3 ${
              state === "npm_only" ? "border-warning/20 bg-warning/5" : "border-border/30 bg-accent/20"
            }`}
          >
            <p className="text-xs text-muted-foreground">
              {state === "npm_only"
                ? "NexQ runs Claude Code's native app, not the npm package. Install it with the native installer, log in once, then check the connection."
                : agent.installHint}
            </p>
            {agent.installUrl && (
              <a
                href={agent.installUrl}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => {
                  e.preventDefault();
                  void openInstallPage(agent.installUrl as string);
                }}
                className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                {agent.installLinkLabel ?? `Install ${agent.name}`}
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        )}

        {state === "outdated" && status && (
          <div className="mt-3 rounded-lg border border-warning/20 bg-warning/5 px-4 py-3">
            <p className="text-xs text-muted-foreground">{outdatedNote(status)}</p>
            {status.binary_path && (
              <>
                <p className="mt-2 text-meta text-muted-foreground">
                  {`In ${updateShell(status.binary_path)}:`}
                </p>
                <code
                  data-testid="update-command"
                  className="mt-1 block select-all break-all rounded-md border border-border/30 bg-background px-2.5 py-1.5 font-mono text-meta text-foreground"
                >
                  {updateCommand(status.binary_path)}
                </code>
              </>
            )}
          </div>
        )}

        {(state === "logged_out" || state === "unknown" || state === "api_billed") && (
          <div className="mt-3 rounded-lg border border-warning/20 bg-warning/5 px-4 py-3">
            {state === "api_billed" ? (
              <ApiBilledNote kind={kind} />
            ) : isApiKeyLogin(status) ? (
              <p className="text-xs font-medium text-warning">{CODEX_API_KEY_NOTE}</p>
            ) : (
              <p className="text-xs text-muted-foreground">{agent.loginHint}</p>
            )}
            <div className="mt-2.5 flex items-center gap-3">
              <button type="button" onClick={handleOpenLogin} className={BUTTON_CLASS}>
                <Terminal className="h-3.5 w-3.5" />
                Open terminal to log in
              </button>
              {awaitingLogin && (
                <span className="text-meta text-muted-foreground">Waiting for login…</span>
              )}
            </div>
          </div>
        )}
      </div>

      <ModelSettings agent={agent} active={active} />
      <FallbackSettings agent={agent} />
    </div>
  );
}

function ApiBilledNote({ kind }: { kind: CliAgentKind }) {
  const name = cliAgentInfo(kind).name;
  return (
    <>
      <p className="text-xs font-medium text-warning">{apiBilledNoteFor(name)}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        It still works, at API prices. To use your subscription, log in with your {name} account
        {kind === "claude_cli"
          ? " in a terminal (run /login there)."
          : kind === "codex_cli"
            ? " in a terminal and choose Sign in with ChatGPT."
            : " in a terminal."}
      </p>
    </>
  );
}

/** The model list of an agent: Claude falls back to its static aliases; the others have none until fetched. */
function modelsFor(kind: CliAgentKind, catalog: ClaudeModelInfo[] | undefined): ClaudeModelInfo[] {
  return catalog ?? (kind === "claude_cli" ? STATIC_CLAUDE_MODELS : []);
}

function ModelSettings({ agent, active }: { agent: CliAgentInfo; active: boolean }) {
  const kind = agent.id;
  const config = useConfigStore((s) => s.cliAgentConfigs[kind]);
  const setAgentConfig = useConfigStore((s) => s.setCliAgentConfig);
  const sessionRunning = useAgentStore((s) => active && Object.values(s.sessions).some(isSessionRunning));
  const catalog = useConfigStore((s) => s.cliAgentModels[kind]);
  const modelsError = useAgentStore((s) => s.modelsErrors[kind]);
  const [changed, setChanged] = useState(false);
  const models = modelsFor(kind, catalog);
  const isClaude = kind === "claude_cli";
  const { latest, pinned } = groupClaudeModels(models);

  // The hint is about sessions running now; once they end it no longer applies.
  useEffect(() => {
    if (!sessionRunning) setChanged(false);
  }, [sessionRunning]);

  const update = (patch: Partial<ClaudeCliConfig>) => {
    setAgentConfig(kind, { ...config, ...patch });
    setChanged(true);
  };

  const rows = [
    { tier: "Fast", hint: "Live answers and quick actions", model: "fast_model", effort: "fast_effort", thinking: "fast_thinking" },
    { tier: "Deep", hint: "Recaps and past meetings", model: "deep_model", effort: "deep_effort", thinking: "deep_thinking" },
  ] as const;

  // Picking a model whose effort levels don't include the saved one saves a
  // level it takes (its own default where it names one), so what is saved is
  // what runs.
  const pickModel = (row: (typeof rows)[number], value: string) => {
    const next = findClaudeModel(models, value);
    const patch: Partial<ClaudeCliConfig> = { [row.model]: value };
    if (agent.supportsEffort && next && next.supports_effort && !next.effort_levels.includes(config[row.effort])) {
      patch[row.effort] =
        next.default_effort && next.effort_levels.includes(next.default_effort)
          ? next.default_effort
          : (cliEffectiveEffort(kind, next, config[row.effort]) ?? config[row.effort]);
    }
    update(patch);
  };

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h4 className="text-xs font-semibold text-foreground">Models</h4>
        {changed && sessionRunning ? (
          <span className="text-meta text-muted-foreground">Applies to the next session</span>
        ) : (
          modelsError && (
            <span className="text-meta text-muted-foreground" title={modelsError}>
              {catalog === undefined
                ? isClaude
                  ? "Model list unavailable — showing the standard models"
                  : "Model list unavailable — log in and check the connection"
                : "Couldn't refresh model list — showing last known"}
            </span>
          )
        )}
      </div>
      <div className="mt-2 space-y-2">
        {rows.map((row) => {
          const saved = config[row.model];
          // Claude passes its aliases through; the others run the first listed model when the saved one is gone.
          const info = isClaude ? findClaudeModel(models, saved) : resolveListedModel(models, saved);
          const listed = isClaude
            ? [...latest, ...pinned].some((o) => o.value === saved)
            : models.some((m) => m.value === info?.value);
          // Only a fetched catalog can say a model is gone.
          const unavailable = catalog !== undefined && (isClaude ? !info : !!saved && !findClaudeModel(models, saved));
          const noEffort = !!info && !info.supports_effort;
          const levels = info
            ? info.effort_levels
            : isClaude
              ? [...CLAUDE_EFFORT_VALUES]
              : [...effortRanks(kind)];
          // Shown as the session will run it; the saved effort is kept as chosen.
          const effort = cliEffectiveEffort(kind, info, config[row.effort]) ?? "";
          const selectValue = isClaude ? saved : (info?.value ?? saved);
          return (
            <div key={row.tier} className="flex items-start gap-3">
              <div className="w-40 shrink-0 pt-0.5">
                <p className="text-xs font-medium text-foreground">{row.tier}</p>
                <p className="text-meta text-muted-foreground/70">{row.hint}</p>
              </div>
              <div className="min-w-0 flex-1">
                <select
                  aria-label={`${row.tier} model`}
                  value={selectValue}
                  title={info?.description || undefined}
                  onChange={(e) => pickModel(row, e.target.value)}
                  className={`${SELECT_CLASS} w-full ${unavailable ? "border-warning/50" : ""}`}
                >
                  {isClaude ? (
                    <>
                      {!listed && <option value={saved}>{info?.display_name || saved}</option>}
                      <optgroup label="Latest">
                        {latest.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </optgroup>
                      {pinned.length > 0 && (
                        <optgroup label="Pinned versions">
                          {pinned.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </optgroup>
                      )}
                    </>
                  ) : models.length === 0 ? (
                    <option value={saved}>{saved || "Default model"}</option>
                  ) : (
                    models.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.display_name || m.value}
                      </option>
                    ))
                  )}
                </select>
                {unavailable && (
                  <p className="mt-1 text-meta text-warning">
                    {isClaude ? "No longer available" : `No longer offered — using ${info?.display_name || info?.value}`}
                  </p>
                )}
                {agent.supportsThinking && (
                  <ThinkingToggle
                    tier={row.tier}
                    checked={config[row.thinking]}
                    onChange={(on) => update({ [row.thinking]: on })}
                  />
                )}
              </div>
              {agent.supportsEffort && (
                <select
                  aria-label={`${row.tier} effort`}
                  value={effort}
                  disabled={noEffort}
                  title={noEffort ? "This model doesn't take an effort level" : undefined}
                  onChange={(e) => update({ [row.effort]: e.target.value })}
                  className={`${SELECT_CLASS} w-36`}
                >
                  {noEffort ? (
                    <option value="">Not supported</option>
                  ) : (
                    levels.map((level) => (
                      <option key={level} value={level}>
                        {cliEffortLabel(level)}
                      </option>
                    ))
                  )}
                </select>
              )}
            </div>
          );
        })}
      </div>
      {!agent.supportsEffort && (
        <p className="mt-2 text-meta text-muted-foreground/70">
          {agent.name} puts the effort level in the model name, so there is no separate effort setting.
        </p>
      )}
    </div>
  );
}

/** Per-tier extended thinking: off answers fastest, on reasons more first. */
function ThinkingToggle({ tier, checked, onChange }: { tier: string; checked: boolean; onChange: (on: boolean) => void }) {
  const hintId = `claude-thinking-hint-${tier.toLowerCase()}`;
  return (
    <div className="mt-2 flex items-center gap-2.5">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={`${tier} extended thinking`}
        aria-describedby={hintId}
        onClick={() => onChange(!checked)}
        className={`relative h-4 w-7 shrink-0 cursor-pointer rounded-full transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
          checked ? "bg-primary" : "bg-muted"
        }`}
      >
        <span
          className={`absolute left-0.5 top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-transform duration-200 ${
            checked ? "translate-x-3" : "translate-x-0"
          }`}
        />
      </button>
      <span className="text-xs text-foreground">Extended thinking</span>
      <span id={hintId} className="truncate text-meta text-muted-foreground/70">
        Off: fastest replies · On: deeper reasoning, slower
      </span>
    </div>
  );
}

function FallbackSettings({ agent }: { agent: CliAgentInfo }) {
  const kind = agent.id;
  const config = useConfigStore((s) => s.cliAgentConfigs[kind]);
  const lastModelByProvider = useConfigStore((s) => s.lastModelByProvider);
  const setFallback = useConfigStore((s) => s.setCliAgentFallback);
  const provider = config.fallback_provider;
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  // The fallback provider's models, for the model picker.
  useEffect(() => {
    setModels([]);
    if (!provider) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const key = await getApiKey(provider).catch(() => null);
        const list = await listModels(JSON.stringify({ provider_type: provider, ...(key && { api_key: key }) }));
        if (!cancelled) setModels(list.map((m) => m.id));
      } catch {
        // No list (server down, no key): the saved model and the default stay available.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [provider]);

  const modelOptions = Array.from(
    new Set([config.fallback_model, ...models].filter((m): m is string => !!m)),
  );

  return (
    <div>
      <h4 className="text-xs font-semibold text-foreground">Fallback</h4>
      <p className="mt-0.5 text-meta text-muted-foreground/70">
        Answers while {agent.name} is unavailable (not logged in, usage limit, crash).
      </p>
      <div className="mt-2 flex items-center gap-3">
        <select
          aria-label="Fallback provider"
          value={provider ?? ""}
          onChange={(e) => {
            const next = e.target.value || null;
            setFallback(kind, next, next ? lastModelByProvider[next] ?? null : null);
          }}
          className={`${SELECT_CLASS} flex-1`}
        >
          <option value="">None</option>
          {CLI_FALLBACK_PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {FALLBACK_LABELS[p] ?? p}
            </option>
          ))}
        </select>
        <select
          aria-label="Fallback model"
          value={config.fallback_model ?? ""}
          disabled={!provider}
          onChange={(e) => setFallback(kind, provider, e.target.value || null)}
          className={`${SELECT_CLASS} flex-1`}
        >
          <option value="">{loading ? "Loading models…" : "Provider's first model"}</option>
          {modelOptions.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
