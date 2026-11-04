import { useMemo } from "react";
import { create } from "zustand";
import { load, Store } from "@tauri-apps/plugin-store";
import type { AIScenario, ScenarioTemplate } from "../lib/types";
import { BUILT_IN_SCENARIOS, getScenarioById } from "../lib/scenarios";

const STORE_FILE = "config.json";

// Lazy singleton for Tauri plugin-store (shared with configStore)
let storeInstance: Store | null = null;

async function getStore(): Promise<Store> {
  if (!storeInstance) {
    storeInstance = await load(STORE_FILE, { autoSave: true, defaults: {} });
  }
  return storeInstance;
}

async function persistValue(key: string, value: unknown): Promise<void> {
  try {
    const store = await getStore();
    await store.set(key, value);
  } catch (err) {
    console.error(`[scenarioStore] Failed to persist "${key}":`, err);
  }
}

interface ScenarioState {
  activeScenarioId: AIScenario;
  customScenarios: ScenarioTemplate[];
  scenarioOverrides: Record<string, Partial<ScenarioTemplate>>;

  // Actions
  setActiveScenario: (id: AIScenario) => void;
  getActiveTemplate: () => ScenarioTemplate;
  /** `id` if that scenario still exists, otherwise Team Meeting (custom ones can be deleted). */
  resolveScenario: (id: AIScenario) => AIScenario;
  updatePrompt: (
    scenarioId: string,
    field: keyof Pick<ScenarioTemplate, "system_prompt" | "summary_prompt" | "question_detection_prompt">,
    value: string
  ) => void;
  resetScenarioOverrides: (scenarioId: string) => void;
  createCustomScenario: (template: ScenarioTemplate) => void;
  updateCustomScenario: (template: ScenarioTemplate) => void;
  deleteCustomScenario: (id: string) => void;
  cloneScenario: (sourceId: string, newName: string) => ScenarioTemplate | null;

  // Persistence
  loadScenarioConfig: () => Promise<void>;
}

export const useScenarioStore = create<ScenarioState>((set, get) => ({
  activeScenarioId: "team_meeting",
  customScenarios: [],
  scenarioOverrides: {},

  setActiveScenario: (id) => {
    set({ activeScenarioId: id });
    persistValue("activeScenarioId", id);
  },

  getActiveTemplate: () => {
    const { activeScenarioId, customScenarios, scenarioOverrides } = get();

    // Check custom scenarios first
    const custom = customScenarios.find((s) => s.id === activeScenarioId);
    if (custom) return custom;

    // Fall back to built-in merged with overrides
    const builtIn = getScenarioById(activeScenarioId);
    if (!builtIn) {
      // Fallback to team_meeting if active scenario not found
      return BUILT_IN_SCENARIOS[0];
    }

    const overrides = scenarioOverrides[activeScenarioId];
    if (!overrides) return builtIn;

    return { ...builtIn, ...overrides };
  },

  resolveScenario: (id) =>
    getScenarioById(id) || get().customScenarios.some((s) => s.id === id) ? id : "team_meeting",

  updatePrompt: (scenarioId, field, value) => {
    set((s) => {
      const existing = s.scenarioOverrides[scenarioId] ?? {};
      const updated = {
        ...s.scenarioOverrides,
        [scenarioId]: { ...existing, [field]: value },
      };
      persistValue("scenarioOverrides", updated);
      return { scenarioOverrides: updated };
    });
  },

  resetScenarioOverrides: (scenarioId) => {
    set((s) => {
      const updated = { ...s.scenarioOverrides };
      delete updated[scenarioId];
      persistValue("scenarioOverrides", updated);
      return { scenarioOverrides: updated };
    });
  },

  createCustomScenario: (template) => {
    set((s) => {
      const updated = [...s.customScenarios, template];
      persistValue("customScenarios", updated);
      return { customScenarios: updated };
    });
  },

  updateCustomScenario: (template) => {
    set((s) => {
      const updated = s.customScenarios.map((c) => (c.id === template.id ? template : c));
      persistValue("customScenarios", updated);
      return { customScenarios: updated };
    });
  },

  deleteCustomScenario: (id) => {
    set((s) => {
      const updated = s.customScenarios.filter((sc) => sc.id !== id);
      persistValue("customScenarios", updated);
      // If deleting active scenario, fall back to team_meeting
      const activeId = s.activeScenarioId === id ? "team_meeting" : s.activeScenarioId;
      if (activeId !== s.activeScenarioId) {
        persistValue("activeScenarioId", activeId);
      }
      return { customScenarios: updated, activeScenarioId: activeId };
    });
  },

  cloneScenario: (sourceId, newName) => {
    const state = get();

    // Find source: check custom first, then built-in
    const source =
      state.customScenarios.find((s) => s.id === sourceId) ??
      getScenarioById(sourceId);

    if (!source) return null;

    // Apply overrides for built-ins before cloning
    const overrides = state.scenarioOverrides[sourceId];
    const base = overrides ? { ...source, ...overrides } : source;

    const cloned: ScenarioTemplate = {
      ...base,
      id: `custom_${Date.now()}`,
      name: newName,
      is_custom: true,
    };

    const updated = [...state.customScenarios, cloned];
    set({ customScenarios: updated });
    persistValue("customScenarios", updated);

    return cloned;
  },

  loadScenarioConfig: async () => {
    try {
      const store = await getStore();

      const activeScenarioId = await store.get<AIScenario>("activeScenarioId");
      const customScenarios = await store.get<ScenarioTemplate[]>("customScenarios");
      const scenarioOverrides = await store.get<Record<string, Partial<ScenarioTemplate>>>("scenarioOverrides");

      set((s) => ({
        ...s,
        ...(activeScenarioId != null && { activeScenarioId }),
        ...(customScenarios != null && { customScenarios }),
        ...(scenarioOverrides != null && { scenarioOverrides }),
      }));

      console.log("[scenarioStore] Scenario config loaded");
    } catch (err) {
      console.error("[scenarioStore] Failed to load scenario config:", err);
    }
  },
}));

/**
 * Cross-window sync: when another window saves scenarios, update this window's
 * copy, so an edit here can't overwrite them with old ones. The active scenario
 * stays per window: the overlay's is the running meeting's.
 */
export async function watchSavedScenarios(): Promise<() => void> {
  const store = await getStore();
  const stop = await Promise.all([
    store.onKeyChange<ScenarioTemplate[]>("customScenarios", (value) => {
      useScenarioStore.setState({ customScenarios: value ?? [] });
    }),
    store.onKeyChange<ScenarioState["scenarioOverrides"]>("scenarioOverrides", (value) => {
      useScenarioStore.setState({ scenarioOverrides: value ?? {} });
    }),
  ]);
  return () => stop.forEach((fn) => fn());
}

/** The scenarios a meeting can use, in the order the pickers list them. */
export function useMeetingScenarios(): ScenarioTemplate[] {
  const customScenarios = useScenarioStore((s) => s.customScenarios);
  return useMemo(() => [...BUILT_IN_SCENARIOS, ...customScenarios], [customScenarios]);
}

/** How a saved meeting's scenario reads: "team meeting", or a custom scenario's name. */
export function scenarioLabel(id: string, customScenarios: ScenarioTemplate[]): string {
  if (!id.startsWith("custom_")) return id.replace(/_/g, " ");
  return customScenarios.find((s) => s.id === id)?.name ?? "custom scenario";
}
