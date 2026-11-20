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
}

/** How long a toast stays: 4 s plus about 60 ms per character, at most 10 s, so a long message can be read. */
export function toastDurationMs(message: string): number {
  return Math.min(10_000, 4000 + 60 * message.length);
}

interface ToastState {
  toasts: Toast[];
  addToast: (message: string, type: ToastType) => void;
  /** Show a toast that stays, replacing the one with the same key. */
  setStickyToast: (key: string, message: string, type: ToastType) => void;
  dismissByKey: (key: string) => void;
  removeToast: (id: string) => void;
}

export const useToastStore = create<ToastState>((set) => ({
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

  setStickyToast: (key, message, type) => {
    const toast: Toast = { id: crypto.randomUUID(), message, type, createdAt: Date.now(), key, sticky: true };
    set((state) => ({ toasts: [...state.toasts.filter((t) => t.key !== key), toast] }));
  },

  dismissByKey: (key) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.key !== key) })),

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
