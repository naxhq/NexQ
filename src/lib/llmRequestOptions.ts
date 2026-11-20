import type { LLMProviderType, ThinkingSetting } from "./types";

/** The choices, in the order the select shows them. */
export const THINKING_OPTIONS: { value: ThinkingSetting; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "off", label: "Off" },
  { value: "low", label: "Low" },
  { value: "high", label: "High" },
];

/** Providers that accept an advanced "Extra request JSON". */
export const EXTRA_JSON_PROVIDERS: LLMProviderType[] = ["ollama", "lm_studio", "openrouter", "custom"];

/** Providers with a thinking setting (the Claude subscription has its own). */
export function supportsThinking(provider: LLMProviderType): boolean {
  return provider !== "claude_cli";
}

export function supportsExtraJson(provider: LLMProviderType): boolean {
  return EXTRA_JSON_PROVIDERS.includes(provider);
}

/** A saved or synced value as a setting: anything unknown is Auto. */
export function normalizeThinking(value: unknown): ThinkingSetting {
  return value === "off" || value === "low" || value === "high" ? value : "auto";
}

/** Per-provider map from a saved value, dropping unknown settings. */
export function normalizeThinkingMap(value: unknown): Record<string, ThinkingSetting> {
  const out: Record<string, ThinkingSetting> = {};
  if (value && typeof value === "object") {
    for (const [provider, setting] of Object.entries(value as Record<string, unknown>)) {
      const normalized = normalizeThinking(setting);
      if (normalized !== "auto") out[provider] = normalized;
    }
  }
  return out;
}

/** Per-provider map of saved extra JSON strings (strings only). */
export function normalizeExtraJsonMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (value && typeof value === "object") {
    for (const [provider, text] of Object.entries(value as Record<string, unknown>)) {
      if (typeof text === "string" && text.trim()) out[provider] = text;
    }
  }
  return out;
}

/**
 * Why `text` can't be used as extra request JSON, or null when it can (empty
 * is fine: nothing to send). It must be one JSON object.
 */
export function extraJsonError(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return `Not valid JSON: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "Must be a JSON object, like {\"top_p\": 0.9}";
  }
  return null;
}

/**
 * The fields a provider's backend config gets for these settings. Nothing for
 * Auto and for empty or invalid JSON, so a config without them is exactly what
 * was sent before the setting existed.
 */
export function requestOptionFields(
  provider: LLMProviderType,
  thinking: ThinkingSetting | undefined,
  extraJson: string | undefined,
): { thinking?: ThinkingSetting; extra_request_json?: string } {
  const fields: { thinking?: ThinkingSetting; extra_request_json?: string } = {};
  if (supportsThinking(provider) && thinking && thinking !== "auto") fields.thinking = thinking;
  if (supportsExtraJson(provider) && extraJson && extraJson.trim() && extraJsonError(extraJson) === null) {
    fields.extra_request_json = extraJson.trim();
  }
  return fields;
}
