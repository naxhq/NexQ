// Claude CLI model catalog helpers: picker grouping, effort clamping (mirrors
// Rust `cli_agent::models::effective_effort`) and check-time wording.

import type { ClaudeModelInfo } from "./types";

/** Effort levels the CLI accepts for `--effort`, lowest first. */
export const CLAUDE_EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max"] as const;

/** Every effort level any CLI agent takes, lowest first (Codex adds "ultra" on top). */
export const CLI_EFFORT_RANKS = [...CLAUDE_EFFORT_VALUES, "ultra"] as const;

function staticAlias(value: string, name: string): ClaudeModelInfo {
  return {
    value,
    resolved_model: value,
    display_name: name,
    description: "",
    // Unknown until the CLI reports it: every level is offered and passed on.
    supports_effort: true,
    effort_levels: [...CLAUDE_EFFORT_VALUES],
  };
}

/** Used only until the CLI has reported its catalog once. */
export const STATIC_CLAUDE_MODELS: ClaudeModelInfo[] = [
  staticAlias("haiku", "Haiku"),
  staticAlias("sonnet", "Sonnet"),
  staticAlias("opus", "Opus"),
  staticAlias("fable", "Fable"),
];

export interface ClaudeModelOption {
  value: string;
  label: string;
  model: ClaudeModelInfo;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * An alias that always follows the newest model of its family ("sonnet"),
 * as opposed to a pinned id with a version. "default" is left out: it is
 * one of the other aliases under a plan-dependent name.
 */
export function isClaudeAlias(value: string): boolean {
  return value !== "default" && !/\d/.test(value);
}

/** "Sonnet — Sonnet 5.5"; just "Sonnet" when the name adds nothing. */
function aliasLabel(m: ClaudeModelInfo): string {
  const name = capitalize(m.value);
  return m.display_name && m.display_name !== name ? `${name} — ${m.display_name}` : name;
}

/** Picker groups: "Latest" (aliases) and "Pinned versions" (the rest), in CLI order. */
export function groupClaudeModels(models: ClaudeModelInfo[]): {
  latest: ClaudeModelOption[];
  pinned: ClaudeModelOption[];
} {
  const latest: ClaudeModelOption[] = [];
  const pinned: ClaudeModelOption[] = [];
  for (const model of models) {
    if (model.value === "default") continue;
    if (isClaudeAlias(model.value)) latest.push({ value: model.value, label: aliasLabel(model), model });
    else pinned.push({ value: model.value, label: model.display_name || model.value, model });
  }
  return { latest, pinned };
}

/** The catalog entry for `value`, matched by value, else by resolved id. */
export function findClaudeModel(models: ClaudeModelInfo[], value: string): ClaudeModelInfo | undefined {
  return models.find((m) => m.value === value) ?? models.find((m) => m.resolved_model === value);
}

/**
 * The effort a session actually gets: null when the model takes none, the
 * saved one when accepted (or the model is unknown), else the closest level
 * the model accepts (ties go to the lower one). `ranks` orders the levels
 * ("closest" is measured on it); Codex passes `CLI_EFFORT_RANKS`.
 */
export function effectiveEffort(
  model: ClaudeModelInfo | undefined,
  saved: string,
  ranks: readonly string[] = CLAUDE_EFFORT_VALUES,
): string | null {
  if (!model) return saved;
  if (!model.supports_effort || model.effort_levels.length === 0) return null;
  if (model.effort_levels.includes(saved)) return saved;
  const rank = (l: string) => ranks.indexOf(l);
  const target = rank(saved);
  if (target < 0) return model.effort_levels[0];
  let best = model.effort_levels[0];
  let bestKey: [number, number] = [Infinity, Infinity];
  for (const level of model.effort_levels) {
    const r = rank(level);
    if (r < 0) continue;
    const key: [number, number] = [Math.abs(r - target), r];
    if (key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
      best = level;
      bestKey = key;
    }
  }
  return best;
}

/** "just now", "5 min ago", "2 h ago", "3 d ago". */
export function formatCheckedAgo(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}
