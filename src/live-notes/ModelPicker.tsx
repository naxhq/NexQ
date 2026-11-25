import { useEffect, useMemo, useState } from "react";
import { Select, type SelectOption } from "../ui";
import { cliAgentModels, getLLMProviders, listModels } from "../lib/ipc";
import type { CliAgentKind, ClaudeModelInfo } from "../lib/types";

export const CLI_PROVIDERS: Record<CliAgentKind, string> = {
  claude_cli: "Claude subscription",
  codex_cli: "Codex subscription",
  antigravity_cli: "Antigravity subscription",
};

const API_LABELS: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  groq: "Groq",
  gemini: "Gemini",
  ollama: "Ollama (local)",
  lmstudio: "LM Studio (local)",
  lm_studio: "LM Studio (local)",
  openrouter: "OpenRouter",
  custom: "Custom server",
};

export function providerLabel(id: string): string {
  return CLI_PROVIDERS[id as CliAgentKind] ?? API_LABELS[id] ?? id;
}

export interface ModelChoice {
  provider: string | null;
  model: string | null;
  effort: string | null;
}

interface ModelRow {
  value: string;
  label: string;
  efforts: string[];
}

const AUTOMATIC = "__auto";
const CHEAPEST = "__cheapest";
const DEFAULT_EFFORT = "__default";

/** The models one provider offers (API providers and subscription CLIs alike). */
export function useModelRows(provider: string | null): { rows: ModelRow[]; loading: boolean; failed: boolean } {
  const [state, setState] = useState<{ rows: ModelRow[]; loading: boolean; failed: boolean }>({ rows: [], loading: false, failed: false });
  useEffect(() => {
    if (!provider) {
      setState({ rows: [], loading: false, failed: false });
      return;
    }
    let alive = true;
    setState({ rows: [], loading: true, failed: false });
    const load = async (): Promise<ModelRow[]> => {
      if (provider in CLI_PROVIDERS) {
        const list: ClaudeModelInfo[] = await cliAgentModels(provider as CliAgentKind);
        return list.map((m) => ({ value: m.value, label: m.display_name || m.value, efforts: m.supports_effort ? m.effort_levels : [] }));
      }
      const list = await listModels(provider);
      return list.map((m) => ({ value: m.id, label: m.name || m.id, efforts: [] }));
    };
    load()
      .then((rows) => alive && setState({ rows, loading: false, failed: false }))
      .catch(() => alive && setState({ rows: [], loading: false, failed: true }));
    return () => {
      alive = false;
    };
  }, [provider]);
  return state;
}

/**
 * Any provider, API or subscription. With nothing chosen, the engine uses the
 * cheapest tier of the active provider, and the first option says so.
 */
export function ModelPicker({
  value,
  onChange,
  idPrefix,
}: {
  value: ModelChoice;
  onChange: (next: ModelChoice) => void;
  idPrefix: string;
}) {
  const [providers, setProviders] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    getLLMProviders()
      .then((list) => alive && setProviders(list))
      .catch(() => alive && setProviders([]));
    return () => {
      alive = false;
    };
  }, []);

  const providerOptions: SelectOption[] = useMemo(() => {
    const ids = new Set<string>(providers);
    for (const k of Object.keys(CLI_PROVIDERS)) ids.add(k);
    if (value.provider) ids.add(value.provider);
    return [
      { value: AUTOMATIC, label: "Automatic", description: "The cheapest model of your active provider" },
      ...[...ids].map((id) => ({ value: id, label: providerLabel(id) })),
    ];
  }, [providers, value.provider]);

  const { rows, loading, failed } = useModelRows(value.provider);
  const modelOptions: SelectOption[] = [{ value: CHEAPEST, label: "Cheapest available" }, ...rows.map((r) => ({ value: r.value, label: r.label }))];
  const current = rows.find((r) => r.value === value.model);
  const efforts = current?.efforts ?? [];

  return (
    <div className="flex flex-col gap-2" data-testid={`${idPrefix}-model-picker`}>
      <Select
        label="Provider"
        value={value.provider ?? AUTOMATIC}
        options={providerOptions}
        onChange={(v) => onChange({ provider: v === AUTOMATIC ? null : v, model: null, effort: null })}
      />
      {value.provider && (
        <Select
          label="Model"
          value={value.model ?? CHEAPEST}
          options={modelOptions}
          filterable={modelOptions.length > 8}
          disabled={loading}
          placeholder={loading ? "Loading models" : "Choose a model"}
          onChange={(v) => onChange({ ...value, model: v === CHEAPEST ? null : v, effort: null })}
        />
      )}
      {value.provider && failed && <p className="ui-meta text-muted-foreground">Could not list this provider&apos;s models. Check its settings.</p>}
      {efforts.length > 0 && (
        <Select
          label="Effort"
          value={value.effort ?? DEFAULT_EFFORT}
          options={[{ value: DEFAULT_EFFORT, label: "Default effort" }, ...efforts.map((e) => ({ value: e, label: e }))]}
          onChange={(v) => onChange({ ...value, effort: v === DEFAULT_EFFORT ? null : v })}
        />
      )}
    </div>
  );
}

/** One line for the header or a summary: who writes the notes. */
export function describeChoice(c: ModelChoice): string {
  if (!c.provider) return "Automatic, cheapest model";
  return `${providerLabel(c.provider)}${c.model ? `, ${c.model}` : ", cheapest model"}`;
}
