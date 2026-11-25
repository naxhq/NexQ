import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  type DockAction,
  type DockState,
  type PanelId,
  dockReducer,
  initialDockState,
  sanitizeState,
} from "./layoutModel";

/** Injected by the integration agent (wired to the app config). */
export interface LayoutStorage {
  /** Whatever was saved last, or null/undefined. May be garbage; it is sanitized. */
  load(): unknown | Promise<unknown>;
  save(state: DockState): void | Promise<void>;
}

export interface DebouncedSaver<T> {
  push(value: T): void;
  flush(): void;
  cancel(): void;
}

export function createDebouncedSaver<T>(save: (v: T) => void | Promise<void>, ms = 500): DebouncedSaver<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { v: T } | null = null;
  const run = () => {
    timer = null;
    if (!pending) return;
    const { v } = pending;
    pending = null;
    try {
      void Promise.resolve(save(v)).catch(() => undefined);
    } catch {
      /* storage failure must never break the meeting */
    }
  };
  return {
    push(v) {
      pending = { v };
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, ms);
    },
    flush() {
      if (timer) clearTimeout(timer);
      run();
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}

/**
 * Dock state with persistence. `known` is the full list of panel ids the window hosts.
 * Loading sanitizes whatever was saved; saving is debounced and flushed on unmount/pagehide.
 */
export function useDockState(known: PanelId[], storage?: LayoutStorage, debounceMs = 500) {
  const [state, dispatch] = useReducer(dockReducer, known, (k) => initialDockState(k));
  const [ready, setReady] = useState(!storage);
  const loaded = useRef(!storage);
  const saver = useRef<DebouncedSaver<DockState> | null>(null);
  const knownKey = known.join("|");

  useEffect(() => {
    if (!storage) return;
    saver.current = createDebouncedSaver((s: DockState) => storage.save(s), debounceMs);
    const flush = () => saver.current?.flush();
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      saver.current?.flush();
      saver.current = null;
    };
  }, [storage, debounceMs]);

  useEffect(() => {
    let alive = true;
    const finish = (json: unknown) => {
      if (!alive) return;
      if (json !== null && json !== undefined) {
        dispatch({ type: "load", state: sanitizeState(json, known) });
      }
      loaded.current = true;
      setReady(true);
    };
    if (!storage) {
      loaded.current = true;
      setReady(true);
      return;
    }
    Promise.resolve()
      .then(() => storage.load())
      .then(finish, () => finish(null));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storage, knownKey]);

  // when the panel set changes, reconcile the current layout
  const lastKey = useRef(knownKey);
  useEffect(() => {
    if (lastKey.current === knownKey) return;
    lastKey.current = knownKey;
    dispatch({ type: "load", state: sanitizeState(state, known) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [knownKey]);

  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (loaded.current) saver.current?.push(state);
  }, [state]);

  const act = useCallback((a: DockAction) => dispatch(a), []);
  return { state, dispatch: act, ready };
}
