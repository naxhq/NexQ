import { create } from "zustand";

export type ToastType = "success" | "error" | "info" | "warning";

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
  createdAt: number;
  /** A sticky toast stays until it is replaced or dismissed by its `key`, or the user closes it. */
  key?: string;
  sticky?: boolean;
  /** Replaced or dismissed by key: playing its exit animation, about to be removed. */
  leaving?: boolean;
}

/** How long a toast's exit animation takes before it leaves the store. */
export const TOAST_EXIT_MS = 280;

/** How long a toast stays: 4 s plus about 60 ms per character, at most 10 s, so a long message can be read. */
export function toastDurationMs(message: string): number {
  return Math.min(10_000, 4000 + 60 * message.length);
}

interface ToastState {
  toasts: Toast[];
  addToast: (message: string, type: ToastType) => void;
  /** Show a toast that stays, replacing the one with the same key. */
  setStickyToast: (key: string, message: string, type: ToastType) => void;
  /** Show a toast that goes by itself, replacing the one with the same key in place. */
  setKeyedToast: (key: string, message: string, type: ToastType) => void;
  dismissByKey: (key: string) => void;
  removeToast: (id: string) => void;
}

/** Show a toast under `key`, replacing the one with that key. */
function putKeyed(key: string, message: string, type: ToastType, sticky: boolean) {
  const toast: Toast = { id: crypto.randomUUID(), message, type, createdAt: Date.now(), key, sticky };
  const old = useToastStore.getState().toasts.filter((t) => t.key === key && !t.leaving);
  useToastStore.setState((state) => ({
    toasts: [...state.toasts.map((t) => (t.key === key ? { ...t, leaving: true } : t)), toast],
  }));
  retire(old.map((t) => t.id));
}

/** Remove toasts once their exit animation has played. */
function retire(ids: string[]) {
  if (ids.length === 0) return;
  setTimeout(() => {
    useToastStore.setState((state) => ({ toasts: state.toasts.filter((t) => !ids.includes(t.id)) }));
  }, TOAST_EXIT_MS);
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],

  addToast: (message, type) => {
    // Deduplicate: skip if an identical message is already visible
    const existing = useToastStore.getState().toasts;
    if (existing.some((t) => t.message === message && t.type === type)) return;

    const id = crypto.randomUUID();
    const toast: Toast = { id, message, type, createdAt: Date.now() };

    // The toast removes itself once it has been on screen long enough (and has not
    // been hovered or focused): see ToastItem, which owns the timer.
    set((state) => ({
      toasts: [...state.toasts, toast],
    }));
  },

  setStickyToast: (key, message, type) => putKeyed(key, message, type, true),
  setKeyedToast: (key, message, type) => putKeyed(key, message, type, false),

  dismissByKey: (key) => {
    const old = get().toasts.filter((t) => t.key === key && !t.leaving);
    if (old.length === 0) return;
    set((state) => ({ toasts: state.toasts.map((t) => (t.key === key ? { ...t, leaving: true } : t)) }));
    retire(old.map((t) => t.id));
  },

  removeToast: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    })),
}));

/**
 * Show a toast notification from anywhere (does not require React context).
 */
export function showToast(message: string, type: ToastType = "info") {
  useToastStore.getState().addToast(message, type);
}
