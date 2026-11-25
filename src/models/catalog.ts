import { useEffect, useMemo, useState } from "react";
import type { CliAgentKind, ClaudeModelInfo, ModelInfo, WorkspaceChat } from "../lib/types";
import { CLI_AGENTS, cliAgentInfo, cliEffectiveEffort, cliModelLabel, isCliAgent, resolveListedModel } from "../lib/cliAgents";
import { STATIC_CLAUDE_MODELS, findClaudeModel } from "../lib/claudeModels";
import { isOutdated } from "../lib/agentUsage";
import { getApiKey, listModels } from "../lib/ipc";
import { useConfigStore } from "../stores/configStore";
import { useAgentStore } from "../stores/agentStore";
import { PROVIDER_LABELS, providerLabel } from "./labels";
import { plainError } from "../lib/plainError";

export type ProviderGroup = "subscription" | "cloud" | "local";
/** What an answer can use: folders and tools (CLI agents) or only the passages found for it. */
export type Capability = "tools" | "passages";

export const CAPABILITY_TEXT: Record<Capability, string> = {
  tools: "Reads folders and tools",
  passages: "Uses found passages",
};

/** Said where Codex and Antigravity are offered: they can't ask before a tool runs yet. */
export const TOOLS_OFF_TEXT = "Tools that change things are off with this version";

const GROUP_OF: Record<string, ProviderGroup> = {
  ollama: "local",
  lm_studio: "local",
  custom: "local",
  openai: "cloud",
  anthropic: "cloud",
  groq: "cloud",
  gemini: "cloud",
  openrouter: "cloud",
  claude_cli: "subscription",
  antigravity_cli: "subscription",
  codex_cli: "subscription",
};

export const GROUP_NAMES: Record<ProviderGroup, string> = {
  subscription: "Subscriptions",
  cloud: "Cloud",
  local: "On this computer",
};

const EMBEDDING = ["embed", "all-minilm", "nomic-embed", "bge-", "text-embedding", "snowflake-arctic", "jina-embedding"];

export { PROVIDER_LABELS, providerLabel };
export const capabilityOf = (provider: string): Capability => (isCliAgent(provider) ? "tools" : "passages");

export interface ModelChoice {
  provider: string;
  model: string;
  label: string;
  /** Effort levels this model accepts, lowest first; empty = none. */
  efforts: string[];
  window: number | null;
}

export interface ProviderSection {
  provider: string;
  label: string;
  group: ProviderGroup;
  capability: Capability;
  models: ModelChoice[];
  loading: boolean;
  /** Listing the models failed (a key, a server that isn't running). */
  error: string | null;
}

export const choiceKey = (provider: string, model: string) => `${provider}::${model}`;

// ── Listing the models of API providers: once per provider, again after a minute ──

interface ApiEntry {
  at: number;
  models: ModelChoice[];
  error: string | null;
}
const apiCache = new Map<string, ApiEntry>();
const inflight = new Map<string, Promise<void>>();
const STALE_MS = 60_000;

async function loadApi(provider: string): Promise<void> {
  const known = apiCache.get(provider);
  if (known && Date.now() - known.at < STALE_MS) return;
  const running = inflight.get(provider);
  if (running) return running;
  const job = (async () => {
    try {
      const key = await getApiKey(provider).catch(() => null);
      const config = JSON.stringify({ provider_type: provider, ...(key ? { api_key: key } : {}) });
      const list: ModelInfo[] = await listModels(config);
      const models = list
        .filter((m) => !EMBEDDING.some((p) => m.id.toLowerCase().includes(p)))
        .map((m) => ({ provider, model: m.id, label: m.name || m.id, efforts: [], window: m.context_window ?? null }));
      apiCache.set(provider, { at: Date.now(), models, error: null });
    } catch (e) {
      apiCache.set(provider, { at: Date.now(), models: [], error: plainError(e, "The list of models could not be read.") });
    } finally {
      inflight.delete(provider);
    }
  })();
  inflight.set(provider, job);
  return job;
}

export function resetModelCacheForTests() {
  apiCache.clear();
  inflight.clear();
}

function cliModels(kind: CliAgentKind, listed: ClaudeModelInfo[] | undefined): ClaudeModelInfo[] {
  if (listed && listed.length > 0) return listed;
  return kind === "claude_cli" ? STATIC_CLAUDE_MODELS : [];
}

function cliSection(kind: CliAgentKind, listed: ClaudeModelInfo[] | undefined, currentModel: string | null): ProviderSection {
  const infos = cliModels(kind, listed);
  const models: ModelChoice[] = infos.map((m) => ({
    provider: kind,
    model: m.value,
    label: cliModelLabel(kind, m.value, infos),
    efforts: cliAgentInfo(kind).supportsEffort && m.supports_effort ? m.effort_levels : [],
    window: null,
  }));
  // The CLI has not listed anything yet: offer the one in use, or its own default.
  if (models.length === 0) {
    models.push({
      provider: kind,
      model: currentModel ?? "",
      label: currentModel ? cliModelLabel(kind, currentModel) : "Default",
      efforts: [],
      window: null,
    });
  }
  return { provider: kind, label: providerLabel(kind), group: "subscription", capability: "tools", models, loading: false, error: null };
}

/**
 * Everything the chat can run on: logged-in subscriptions, verified cloud and local providers,
 * grouped. API model lists load when `open` turns true.
 */
export function useModelCatalog(open: boolean, current: { provider: string; model: string } | null): ProviderSection[] {
  const verified = useConfigStore((s) => s.verifiedCloudProviders);
  const customBase = useConfigStore((s) => s.customLlmBaseUrl);
  const listed = useConfigStore((s) => s.cliAgentModels);
  const statuses = useAgentStore((s) => s.statuses);
  const refreshStatus = useAgentStore((s) => s.refreshStatus);
  const [, bump] = useState(0);
  const curProvider = current?.provider ?? null;
  const curModel = current?.model ?? "";

  useEffect(() => {
    if (!open) return;
    for (const { id } of CLI_AGENTS) if (!useAgentStore.getState().statuses[id]) void refreshStatus(id);
  }, [open, refreshStatus]);

  const apiProviders = useMemo(() => {
    const out = new Set(verified.filter((p) => !isCliAgent(p) && p !== "custom"));
    if (curProvider && !isCliAgent(curProvider) && curProvider !== "custom") out.add(curProvider);
    return [...out];
  }, [verified, curProvider]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    for (const p of apiProviders) void loadApi(p).then(() => alive && bump((n) => n + 1));
    return () => {
      alive = false;
    };
  }, [open, apiProviders]);

  return useMemo(() => {
    const sections: ProviderSection[] = [];
    for (const a of CLI_AGENTS) {
      const status = statuses[a.id];
      const usable = !!status?.auth?.logged_in && !isOutdated(status);
      if (usable || curProvider === a.id) sections.push(cliSection(a.id, listed[a.id], curProvider === a.id ? curModel : null));
    }
    for (const p of apiProviders) {
      const entry = apiCache.get(p);
      const models = [...(entry?.models ?? [])];
      // The model in use is always offered, even before the list arrives.
      if (curProvider === p && curModel && !models.some((m) => m.model === curModel)) {
        models.unshift({ provider: p, model: curModel, label: curModel, efforts: [], window: null });
      }
      sections.push({
        provider: p,
        label: providerLabel(p),
        group: GROUP_OF[p] ?? "cloud",
        capability: "passages",
        models,
        loading: open && !entry,
        error: entry?.error ?? null,
      });
    }
    if (customBase || curProvider === "custom") {
      sections.push({
        provider: "custom",
        label: providerLabel("custom"),
        group: "local",
        capability: "passages",
        models: curProvider === "custom" && curModel ? [{ provider: "custom", model: curModel, label: curModel, efforts: [], window: null }] : [],
        loading: false,
        error: null,
      });
    }
    const order: ProviderGroup[] = ["subscription", "cloud", "local"];
    return sections.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
    // `bump` re-renders after a list arrives; apiCache is read here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statuses, listed, apiProviders, curProvider, curModel, customBase, open, bumpKey(apiProviders)]);
}

function bumpKey(providers: string[]): string {
  return providers.map((p) => `${p}:${apiCache.get(p)?.at ?? 0}`).join(",");
}

export interface Selection {
  provider: string;
  model: string;
  /** The effort in use, or null when this model takes none. */
  effort: string | null;
  /** Levels to choose from; empty hides the effort control. */
  efforts: string[];
  /** The chat has no choice of its own: it follows the app's active model. */
  inherited: boolean;
}

/** What the chat will run on: its own choice, else the app's active provider and model. */
export function useSelection(chat: Pick<WorkspaceChat, "provider" | "model" | "effort"> | null): Selection {
  const llmProvider = useConfigStore((s) => s.llmProvider);
  const llmModel = useConfigStore((s) => s.llmModel);
  const configs = useConfigStore((s) => s.cliAgentConfigs);
  const listed = useConfigStore((s) => s.cliAgentModels);
  return useMemo(() => {
    const provider = chat?.provider || llmProvider;
    const inherited = !chat?.provider;
    if (!isCliAgent(provider)) {
      return { provider, model: chat?.model || llmModel, effort: null, efforts: [], inherited };
    }
    const cfg = configs[provider];
    const model = chat?.model ?? (inherited ? (cfg?.deep_model ?? "") : "");
    const infos = cliModels(provider, listed[provider]);
    const info = provider === "claude_cli" ? findClaudeModel(infos, model) : resolveListedModel(infos, model);
    const wanted = chat?.effort || cfg?.deep_effort || "medium";
    const efforts = cliAgentInfo(provider).supportsEffort && info?.supports_effort ? info.effort_levels : [];
    const effort = efforts.length ? cliEffectiveEffort(provider, info, wanted) : null;
    return { provider, model, effort, efforts, inherited };
  }, [chat?.provider, chat?.model, chat?.effort, llmProvider, llmModel, configs, listed]);
}

/** "Claude Sonnet" or "Ollama llama3.2". */
export function selectionLabel(sel: Pick<Selection, "provider" | "model">, listed?: Partial<Record<CliAgentKind, ClaudeModelInfo[]>>): string {
  const base = providerLabel(sel.provider);
  if (isCliAgent(sel.provider)) {
    const name = cliModelLabel(sel.provider, sel.model, cliModels(sel.provider, listed?.[sel.provider]));
    return `${base} ${name}`;
  }
  return sel.model ? `${base} ${sel.model}` : base;
}

/** Codex and Antigravity can't ask before running a tool yet, so tools are off in chat (spec section 12). */
export function toolsOffInChat(provider: string): boolean {
  return provider === "codex_cli" || provider === "antigravity_cli";
}
