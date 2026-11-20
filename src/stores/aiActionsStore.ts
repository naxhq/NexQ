import { create } from "zustand";
import { load, Store } from "@tauri-apps/plugin-store";
import type {
  ActionConfig,
  AllActionConfigs,
  GlobalDefaults,
  InstructionPresets,
} from "../lib/types";
import { updateActionConfigs, getActionConfigs, setCustomInstructions as ipcSetCustomInstructions } from "../lib/ipc";

const STORE_FILE = "config.json";
const STORE_KEY = "ai_action_configs";

let storeInstance: Store | null = null;

async function getStore(): Promise<Store> {
  if (!storeInstance) {
    storeInstance = await load(STORE_FILE, { autoSave: true, defaults: {} });
  }
  return storeInstance;
}

/** Saved settings with any setting or built-in action added since they were saved. */
function withDefaults(saved: AllActionConfigs): AllActionConfigs {
  const defaults = createDefaultConfigs();
  return {
    ...defaults,
    ...saved,
    actions: { ...defaults.actions, ...saved.actions },
    globalDefaults: { ...defaults.globalDefaults, ...saved.globalDefaults },
  };
}

/** The same settings give the same text, whatever order their keys come back in. */
function fingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

// The plugin tells every window about a save, the saving window included. These
// are this window's saves it hasn't heard back yet, so its own echo (which can
// arrive after a newer edit) is never taken for another window's change.
const ownSaves: string[] = [];
const OWN_SAVES_KEPT = 20;

// Default prompt templates (mirror of Rust prompt_templates.rs)
const DEFAULT_PROMPTS: Record<string, string> = {
  Assist:
    "You are an AI meeting assistant. A question has been detected in the meeting. " +
    "Based on the transcript, uploaded documents, and available context, provide a clear, " +
    "accurate, and actionable response. Focus on directly addressing the detected question. " +
    "Be concise but thorough.",
  WhatToSay:
    "You are a real-time response coach. Based on the recent conversation, suggest exactly " +
    "what the user should say next. Write in first person as if the user would speak it directly. " +
    "Be professional, specific, and natural-sounding. " +
    "Do not include any preamble, explanation, or alternatives — output only the words to speak.",
  Shorten:
    "Condense the following into a brief, clear response that could be spoken in under 30 seconds. " +
    "Preserve the core message and key points. Remove filler, redundancy, and secondary details. " +
    "Output only the shortened version — no commentary or explanation.",
  FollowUp:
    "Based on the meeting conversation, suggest 2-3 thoughtful follow-up questions the user could " +
    "ask the other participants. Each question should demonstrate active listening, deepen the " +
    "discussion, or clarify important points. Format as a numbered list. " +
    "Make them specific to what was discussed, not generic.",
  Recap:
    "Provide a structured summary of the meeting so far. Include:\\n" +
    "- Key topics discussed\\n" +
    "- Decisions made\\n" +
    "- Action items and owners (if mentioned)\\n" +
    "- Outstanding questions or unresolved points\\n" +
    "Use bullet points for scannability. Be factual and concise — do not add interpretation.",
  AskQuestion:
    "The user has a specific question about the meeting or uploaded documents. Answer directly " +
    "and helpfully based on all available context — transcript, documents, and meeting history. " +
    "If the answer isn't clear from the context, say so. Be precise and cite specific parts of " +
    "the discussion or documents when possible.",
};

function createDefaultConfigs(): AllActionConfigs {
  return {
    globalDefaults: {
      transcriptWindowSeconds: 300,
      temperature: 0.3,
      questionDetection: true,
      autoTrigger: false,
    },
    customInstructions: "",
    instructionPresets: { tone: null, format: null, length: null, opinion: null },
    actions: {
      Assist: {
        id: "Assist", name: "Assist", mode: "Assist", visible: true,
        systemPrompt: DEFAULT_PROMPTS.Assist, isDefaultPrompt: true,
        includeTranscript: true, includeRagChunks: true,
        includeCustomInstructions: true, includeDetectedQuestion: true,
        webSearch: false,
        transcriptWindowSeconds: null, ragTopK: null, temperature: null,
        isBuiltIn: true,
      },
      WhatToSay: {
        id: "WhatToSay", name: "Say", mode: "WhatToSay", visible: true,
        systemPrompt: DEFAULT_PROMPTS.WhatToSay, isDefaultPrompt: true,
        includeTranscript: true, includeRagChunks: false,
        includeCustomInstructions: true, includeDetectedQuestion: true,
        webSearch: false,
        transcriptWindowSeconds: 60, ragTopK: null, temperature: null,
        isBuiltIn: true,
      },
      Shorten: {
        id: "Shorten", name: "Short", mode: "Shorten", visible: true,
        systemPrompt: DEFAULT_PROMPTS.Shorten, isDefaultPrompt: true,
        includeTranscript: true, includeRagChunks: false,
        includeCustomInstructions: true, includeDetectedQuestion: true,
        webSearch: false,
        transcriptWindowSeconds: 30, ragTopK: null, temperature: null,
        isBuiltIn: true,
      },
      FollowUp: {
        id: "FollowUp", name: "F/U", mode: "FollowUp", visible: true,
        systemPrompt: DEFAULT_PROMPTS.FollowUp, isDefaultPrompt: true,
        includeTranscript: true, includeRagChunks: false,
        includeCustomInstructions: true, includeDetectedQuestion: false,
        webSearch: false,
        transcriptWindowSeconds: null, ragTopK: null, temperature: null,
        isBuiltIn: true,
      },
      Recap: {
        id: "Recap", name: "Recap", mode: "Recap", visible: true,
        systemPrompt: DEFAULT_PROMPTS.Recap, isDefaultPrompt: true,
        includeTranscript: true, includeRagChunks: false,
        includeCustomInstructions: false, includeDetectedQuestion: false,
        webSearch: false,
        transcriptWindowSeconds: 0, ragTopK: null, temperature: null,
        isBuiltIn: true,
      },
      AskQuestion: {
        id: "AskQuestion", name: "Ask", mode: "AskQuestion", visible: true,
        systemPrompt: DEFAULT_PROMPTS.AskQuestion, isDefaultPrompt: true,
        includeTranscript: true, includeRagChunks: true,
        includeCustomInstructions: true, includeDetectedQuestion: false,
        webSearch: true,
        transcriptWindowSeconds: null, ragTopK: null, temperature: null,
        isBuiltIn: true,
      },
    },
  };
}

/** Compose instruction presets into a prefix string. */
function composeInstructions(presets: InstructionPresets, custom: string): string {
  const parts: string[] = [];
  if (presets.tone) parts.push(`${presets.tone} tone.`);
  if (presets.format) {
    const formatMap: Record<string, string> = {
      bullets: "Use bullet points.",
      paragraphs: "Use paragraphs.",
      numbered: "Use a numbered list.",
      oneliner: "Keep it to one line.",
    };
    parts.push(formatMap[presets.format] || `Use ${presets.format} format.`);
  }
  if (presets.length) {
    const lengthMap: Record<string, string> = {
      brief: "Brief responses.",
      standard: "Standard length responses.",
      detailed: "Detailed responses.",
    };
    parts.push(lengthMap[presets.length] || `${presets.length} responses.`);
  }
  if (presets.opinion === "add") {
    parts.push(
      "After answering based on the provided context, add a short section '## My Take' with your own analysis, interpretation, or recommendation — clearly separated from the factual answer above."
    );
  }
  const prefix = parts.join(" ");
  if (prefix && custom) return `${prefix} ${custom}`;
  return prefix || custom;
}

interface AIActionsState {
  configs: AllActionConfigs;
  isLoaded: boolean;

  loadConfigs: () => Promise<void>;
  saveConfigs: () => Promise<void>;
  updateGlobalDefaults: (defaults: Partial<GlobalDefaults>) => void;
  updateActionConfig: (mode: string, patch: Partial<ActionConfig>) => void;
  resetActionPrompt: (mode: string) => void;
  addCustomAction: (name: string, prompt: string) => void;
  removeCustomAction: (mode: string) => void;
  setInstructionPresets: (presets: InstructionPresets) => void;
  setCustomInstructions: (text: string) => void;
  getComposedInstructions: () => string;
}

export const useAIActionsStore = create<AIActionsState>((set, get) => ({
  configs: createDefaultConfigs(),
  isLoaded: false,

  loadConfigs: async () => {
    try {
      const store = await getStore();
      const saved = await store.get<AllActionConfigs>(STORE_KEY);
      if (saved) {
        // Merge saved configs with defaults to handle new built-in actions and settings
        const merged = withDefaults(saved);
        set({ configs: merged, isLoaded: true });
        // Sync to backend (action configs + composed instructions)
        updateActionConfigs(merged).catch((e) =>
          console.warn("[aiActionsStore] Failed to sync configs to backend:", e)
        );
        // Also sync composed instructions to ContextManager (belt-and-suspenders)
        const composed = composeInstructions(merged.instructionPresets, merged.customInstructions);
        if (composed) {
          ipcSetCustomInstructions(composed).catch(() => {});
        }
      } else {
        // No saved config — try loading from backend
        try {
          const backendConfigs = await getActionConfigs();
          set({ configs: backendConfigs, isLoaded: true });
        } catch {
          // Use defaults
          set({ isLoaded: true });
        }
      }
    } catch (err) {
      console.error("[aiActionsStore] Failed to load configs:", err);
      set({ isLoaded: true });
    }
  },

  saveConfigs: async () => {
    const { configs } = get();
    const mine = fingerprint(configs);
    let recorded = false;
    try {
      const store = await getStore();
      ownSaves.push(mine);
      recorded = true;
      if (ownSaves.length > OWN_SAVES_KEPT) ownSaves.shift();
      await store.set(STORE_KEY, configs);
    } catch (e) {
      // Nothing was saved, so no notice of it will come back. Only take back
      // the entry this call recorded: an equal one may belong to another save.
      if (recorded) {
        const at = ownSaves.lastIndexOf(mine);
        if (at >= 0) ownSaves.splice(at, 1);
      }
      console.error("[aiActionsStore] Failed to persist:", e);
    }
    // Sync to backend
    updateActionConfigs(configs).catch((e) =>
      console.warn("[aiActionsStore] Failed to sync to backend:", e)
    );
  },

  updateGlobalDefaults: (defaults) => {
    set((state) => ({
      configs: {
        ...state.configs,
        globalDefaults: { ...state.configs.globalDefaults, ...defaults },
      },
    }));
    // Auto-save after state update
    setTimeout(() => get().saveConfigs(), 0);
  },

  updateActionConfig: (mode, patch) => {
    set((state) => {
      const existing = state.configs.actions[mode];
      if (!existing) return state;
      return {
        configs: {
          ...state.configs,
          actions: {
            ...state.configs.actions,
            [mode]: { ...existing, ...patch },
          },
        },
      };
    });
    setTimeout(() => get().saveConfigs(), 0);
  },

  resetActionPrompt: (mode) => {
    const defaultPrompt = DEFAULT_PROMPTS[mode];
    if (!defaultPrompt) return;
    set((state) => {
      const existing = state.configs.actions[mode];
      if (!existing) return state;
      return {
        configs: {
          ...state.configs,
          actions: {
            ...state.configs.actions,
            [mode]: {
              ...existing,
              systemPrompt: defaultPrompt,
              isDefaultPrompt: true,
            },
          },
        },
      };
    });
    setTimeout(() => get().saveConfigs(), 0);
  },

  addCustomAction: (name, prompt) => {
    const id = `custom_${Date.now()}`;
    const newAction: ActionConfig = {
      id,
      name,
      mode: id,
      visible: true,
      systemPrompt: prompt,
      isDefaultPrompt: false,
      includeTranscript: true,
      includeRagChunks: true,
      includeCustomInstructions: true,
      includeDetectedQuestion: true,
      webSearch: false,
      transcriptWindowSeconds: null,
      ragTopK: null,
      temperature: null,
      isBuiltIn: false,
    };
    set((state) => ({
      configs: {
        ...state.configs,
        actions: { ...state.configs.actions, [id]: newAction },
      },
    }));
    setTimeout(() => get().saveConfigs(), 0);
  },

  removeCustomAction: (mode) => {
    set((state) => {
      const { [mode]: _, ...rest } = state.configs.actions;
      return {
        configs: { ...state.configs, actions: rest },
      };
    });
    setTimeout(() => get().saveConfigs(), 0);
  },

  setInstructionPresets: (presets) => {
    set((state) => ({
      configs: {
        ...state.configs,
        instructionPresets: presets,
      },
    }));
    // Sync composed instructions (presets + custom text) to ContextManager
    const composed = composeInstructions(presets, get().configs.customInstructions);
    ipcSetCustomInstructions(composed).catch(() => {});
    setTimeout(() => get().saveConfigs(), 0);
  },

  setCustomInstructions: (text) => {
    set((state) => ({
      configs: {
        ...state.configs,
        customInstructions: text,
      },
    }));
    // Sync composed instructions (presets + custom text) to ContextManager
    const composed = composeInstructions(get().configs.instructionPresets, text);
    ipcSetCustomInstructions(composed).catch(() => {});
    setTimeout(() => get().saveConfigs(), 0);
  },

  getComposedInstructions: () => {
    const { configs } = get();
    return composeInstructions(configs.instructionPresets, configs.customInstructions);
  },
}));

/**
 * Keeps this window's AI settings in step with what the other window saves.
 * Auto-Answer and question cards run in the overlay, but their switches are
 * usually flipped in the launcher's Settings; without this the overlay kept
 * the values it read at app start. The saving window already told the backend,
 * so this only updates the window's own copy.
 */
export async function watchSavedActionConfigs(): Promise<() => void> {
  const store = await getStore();
  return store.onKeyChange<AllActionConfigs>(STORE_KEY, (saved) => {
    if (!saved) return;
    const own = ownSaves.indexOf(fingerprint(saved));
    if (own >= 0) {
      ownSaves.splice(own, 1);
      return;
    }
    useAIActionsStore.setState({ configs: withDefaults(saved), isLoaded: true });
  });
}
