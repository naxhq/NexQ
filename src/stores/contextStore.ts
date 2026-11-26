import { create } from "zustand";
import type { ContextResource, TokenBudget } from "../lib/types";
import {
  loadContextFile as ipcLoadContextFile,
  removeContextFile as ipcRemoveContextFile,
  listContextResources as ipcListContextResources,
  setCustomInstructions as ipcSetCustomInstructions,
  getTokenBudget as ipcGetTokenBudget,
} from "../lib/ipc";

interface ContextState {
  resources: ContextResource[];
  customInstructions: string;
  tokenBudget: TokenBudget | null;
  isLoading: boolean;
  error: string | null;

  // Actions
  setResources: (resources: ContextResource[]) => void;
  addResource: (resource: ContextResource) => void;
  removeResource: (id: string) => void;
  setCustomInstructions: (instructions: string) => void;
  setTokenBudget: (budget: TokenBudget) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;

  // Async actions that call IPC
  loadResources: () => Promise<void>;
  loadFile: (filePath: string, workspaceId?: string) => Promise<ContextResource>;
  removeFile: (resourceId: string) => Promise<void>;
  saveCustomInstructions: (instructions: string) => Promise<void>;
  refreshTokenBudget: () => Promise<void>;
}

export const useContextStore = create<ContextState>((set, get) => ({
  resources: [],
  customInstructions: "",
  tokenBudget: null,
  isLoading: false,
  error: null,

  setResources: (resources) => set({ resources }),
  addResource: (resource) =>
    set((state) => ({ resources: [...state.resources, resource] })),
  removeResource: (id) =>
    set((state) => ({
      resources: state.resources.filter((r) => r.id !== id),
    })),
  setCustomInstructions: (instructions) =>
    set({ customInstructions: instructions }),
  setTokenBudget: (budget) => set({ tokenBudget: budget }),
  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error }),

  loadResources: async () => {
    try {
      set({ isLoading: true, error: null });
      const resources = await ipcListContextResources();
      set({ resources, isLoading: false });
      // Also refresh token budget after loading resources
      await get().refreshTokenBudget();
    } catch (e) {
      set({
        isLoading: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },

  loadFile: async (filePath: string, workspaceId?: string) => {
    try {
      set({ isLoading: true, error: null });
      const resource = await ipcLoadContextFile(filePath, workspaceId);
      set((state) => ({
        resources: [...state.resources, resource],
        isLoading: false,
      }));
      // Refresh token budget after adding a file
      await get().refreshTokenBudget();
      return resource;
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      set({ isLoading: false, error: errorMsg });
      throw new Error(errorMsg);
    }
  },

  removeFile: async (resourceId: string) => {
    try {
      set({ error: null });
      await ipcRemoveContextFile(resourceId);
      set((state) => ({
        resources: state.resources.filter((r) => r.id !== resourceId),
      }));
      // Refresh token budget after removing a file
      await get().refreshTokenBudget();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  },

  saveCustomInstructions: async (instructions: string) => {
    try {
      set({ error: null, customInstructions: instructions });
      await ipcSetCustomInstructions(instructions);
      // Refresh token budget after updating instructions
      await get().refreshTokenBudget();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  refreshTokenBudget: async () => {
    try {
      const budget = await ipcGetTokenBudget();
      set({ tokenBudget: budget });
    } catch (e) {
      // Non-critical — just log it
      console.warn("Failed to refresh token budget:", e);
    }
  },
}));
