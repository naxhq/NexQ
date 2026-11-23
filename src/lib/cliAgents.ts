// The subscription CLI agents (Claude, Antigravity, Codex): one data array
// that the settings, footer and status chip all read, plus the model and
// effort wording they share. Mirrors Rust `CliAgentKind`.

import type { CliLogoId } from "../components/icons/ProviderLogos";
import { CLAUDE_EFFORT_VALUES, CLI_EFFORT_RANKS, effectiveEffort, findClaudeModel, isClaudeAlias } from "./claudeModels";
import type { ClaudeCliConfig, ClaudeModelInfo, CliAgentKind } from "./types";

export interface CliAgentInfo {
  /** Provider id, the same as the backend's `CliAgentKind`. */
  id: CliAgentKind;
  /** Short name: "Claude", "Antigravity", "Codex". */
  name: string;
  logo: CliLogoId;
  /** Has an effort level per tier. Antigravity bakes effort into its model names. */
  supportsEffort: boolean;
  /** Has the extended thinking switch (Claude only). */
  supportsThinking: boolean;
  /** Said when the user is logged out: how the login works. */
  loginHint: string;
  /** Said when the CLI is not installed. */
  installHint: string;
  /** Where to get it, when there is a page for that. */
  installUrl?: string;
  installLinkLabel?: string;
  /** Mirrors Rust `ClaudeCliConfig::default_for(kind)`. */
  defaultConfig: ClaudeCliConfig;
}

const BASE_CONFIG: ClaudeCliConfig = {
  fast_model: "haiku",
  fast_effort: "low",
  deep_model: "sonnet",
  deep_effort: "medium",
  fast_thinking: false,
  deep_thinking: true,
  fallback_provider: null,
  fallback_model: null,
};

export const CLAUDE_INSTALL_URL = "https://code.claude.com/docs/en/setup";
export const ANTIGRAVITY_INSTALL_URL = "https://antigravity.google";

export const CLI_AGENTS: CliAgentInfo[] = [
  {
    id: "claude_cli",
    name: "Claude",
    logo: "claude_cli",
    supportsEffort: true,
    supportsThinking: true,
    loginHint:
      "Log in once in a terminal: Claude opens there and walks you through it. Your login stays between you and Claude.",
    installHint: "Claude Code isn't installed on this PC. Install it, log in once, then check the connection.",
    installUrl: CLAUDE_INSTALL_URL,
    installLinkLabel: "Install Claude Code",
    defaultConfig: BASE_CONFIG,
  },
  {
    id: "antigravity_cli",
    name: "Antigravity",
    logo: "antigravity_cli",
    supportsEffort: false,
    supportsThinking: false,
    loginHint:
      "Log in once in a terminal: Antigravity opens there and asks you to sign in with Google. Your login stays between you and Google.",
    installHint:
      "Antigravity isn't installed on this PC. Install it from antigravity.google, sign in once, then check the connection.",
    installUrl: ANTIGRAVITY_INSTALL_URL,
    installLinkLabel: "Get Antigravity",
    defaultConfig: {
      ...BASE_CONFIG,
      fast_model: "gemini-3.8-flash-low",
      deep_model: "gemini-4-neon-medium",
      deep_thinking: false,
    },
  },
  {
    id: "codex_cli",
    name: "Codex",
    logo: "codex_cli",
    supportsEffort: true,
    supportsThinking: false,
    loginHint:
      "Log in once in a terminal: choose Sign in with ChatGPT there. Your login stays between you and OpenAI.",
    installHint:
      "Codex isn't installed on this PC. Install it with `npm i -g @openai/codex`, sign in once, then check the connection.",
    defaultConfig: { ...BASE_CONFIG, fast_model: "", deep_model: "", deep_thinking: false },
  },
];

const BY_ID = new Map<string, CliAgentInfo>(CLI_AGENTS.map((a) => [a.id, a]));

/** True when `provider` is one of the subscription CLI agents. */
export function isCliAgent(provider: string | null | undefined): provider is CliAgentKind {
  return !!provider && BY_ID.has(provider);
}

/** The data row of a CLI agent (throws for an unknown id: use `isCliAgent` first). */
export function cliAgentInfo(id: CliAgentKind): CliAgentInfo {
  return BY_ID.get(id) as CliAgentInfo;
}

/** "Claude" / "Antigravity" / "Codex"; the id itself for anything else. */
export function cliAgentName(provider: string): string {
  return BY_ID.get(provider)?.name ?? provider;
}

export const CLI_EFFORT_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};

export function cliEffortLabel(effort: string): string {
  return CLI_EFFORT_LABELS[effort] ?? effort;
}

/**
 * The catalog entry a session of a non-Claude agent runs: the saved model when
 * the CLI lists it, else the first listed one (what the backend does too; Codex
 * saves "" for "first listed"). Undefined while the catalog is empty.
 */
export function resolveListedModel(models: ClaudeModelInfo[] | undefined | null, saved: string): ClaudeModelInfo | undefined {
  if (!models || models.length === 0) return undefined;
  return (saved ? findClaudeModel(models, saved) : undefined) ?? models[0];
}

/** "haiku" → "Haiku", a pinned id → its name ("Opus 4.8"); unknown ids as they are. */
function claudeModelLabel(model: string, models?: ClaudeModelInfo[] | null): string {
  if (isClaudeAlias(model)) return model.charAt(0).toUpperCase() + model.slice(1);
  return (models ? findClaudeModel(models, model)?.display_name : undefined) || model;
}

/** The name of the model a tier shows for `kind`; "Default" when nothing is known yet. */
export function cliModelLabel(kind: CliAgentKind, model: string, models?: ClaudeModelInfo[] | null): string {
  if (kind === "claude_cli") return claudeModelLabel(model, models);
  const info = resolveListedModel(models, model);
  return info?.display_name || info?.value || model || "Default";
}

/**
 * "Sonnet · Medium" with the effort the session actually gets; just the model
 * when it (or the agent) takes no effort. Antigravity never shows an effort.
 */
export function cliTierLabel(
  kind: CliAgentKind,
  model: string,
  effort: string,
  models?: ClaudeModelInfo[] | null,
): string {
  const label = cliModelLabel(kind, model, models);
  if (!cliAgentInfo(kind).supportsEffort) return label;
  const info = kind === "claude_cli" ? (models ? findClaudeModel(models, model) : undefined) : resolveListedModel(models, model);
  const effective = cliEffectiveEffort(kind, info, effort);
  return effective === null ? label : `${label} · ${cliEffortLabel(effective)}`;
}

/** The effort levels of `kind`, lowest first (Codex adds "ultra" on top). */
export function effortRanks(kind: CliAgentKind): readonly string[] {
  return kind === "codex_cli" ? CLI_EFFORT_RANKS : CLAUDE_EFFORT_VALUES;
}

/** The effort a session of `kind` gets for a saved one (null: the model takes none); mirrors Rust. */
export function cliEffectiveEffort(kind: CliAgentKind, model: ClaudeModelInfo | undefined, saved: string): string | null {
  return effectiveEffort(model, saved, effortRanks(kind));
}
