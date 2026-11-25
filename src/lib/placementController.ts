import {
  areaOf,
  applyRect,
  defaultLauncherRect,
  pickArea,
  planOnChange,
  planRestore,
  entryMatches,
  rememberSetup,
  setupKey,
  snapshotPlacement,
  samePlacement,
  type MonitorLike,
  type PlacementOptions,
  type SetupEntry,
  type WindowPlacement,
} from "./windowPlacement";

/** The window as the controller needs it: the Tauri window, or a fake in tests. Physical pixels. */
export interface PlacementWindow {
  monitors(): Promise<MonitorLike[]>;
  primary(): Promise<MonitorLike | null>;
  current(): Promise<MonitorLike | null>;
  isVisible(): Promise<boolean>;
  isMinimized(): Promise<boolean>;
  isMaximized(): Promise<boolean>;
  setPosition(x: number, y: number): Promise<void>;
  setSize(w: number, h: number): Promise<void>;
  outerPosition(): Promise<{ x: number; y: number }>;
  innerSize(): Promise<{ w: number; h: number }>;
  scaleFactor(): Promise<number>;
  maximize(): Promise<void>;
  show(): Promise<void>;
  onMoved(cb: () => void): Promise<() => void>;
  onResized(cb: () => void): Promise<() => void>;
  onScaleChanged(cb: () => void): Promise<() => void>;
}

/** Where the places live (the config store). */
export interface PlacementStore {
  entries(): SetupEntry[];
  /** The single place of v2.45 and earlier. */
  legacy(): WindowPlacement | null;
  save(entries: SetupEntry[], latest: WindowPlacement): void;
}

export interface PlacementController {
  /** Resolves when the first restore is done (and the launcher shown). */
  ready: Promise<void>;
  /** Save what was last seen now (close, quit, update, meeting end). */
  flush(): Promise<void>;
  /** Look now for a changed monitor setup, or a maximise that was waiting for the window to be shown. */
  check(): Promise<void>;
  stop(): void;
}

export interface ControllerOptions {
  label: "launcher" | "overlay";
  win: PlacementWindow;
  store: PlacementStore;
  options: PlacementOptions;
  /** Show the window after the first restore, so it never opens at the default size and then moves. */
  showAfterRestore?: boolean;
  /** False: only learn the current monitor setup (a second start in the same page, e.g. after demo mode). */
  restoreFirst?: boolean;
  saveDelayMs?: number;
  /** How often to look for a changed monitor setup (dock, undock) while nothing is being dragged. */
  pollMs?: number;
  /** A setup change waits until this long after the last move (a drag in progress). */
  dragQuietMs?: number;
  now?: () => number;
}

/**
 * Remembers and restores one window's size, place and maximised state, per monitor setup.
 *
 * - Restore (once at start, again when the monitors change): planRestore, then position, size, read
 *   back, correct once. Our own moves are muted for a moment so they are never saved as a user move.
 * - Save: debounced; only a sampled, visible, un-minimised window; never while the monitors changed
 *   under it (that is the OS moving windows, not the user); never off every monitor.
 * - It only reads and writes size and position, never display affinity or transparency.
 */
export function startPlacement(c: ControllerOptions): PlacementController {
  const { label, win, store, options } = c;
  const saveDelay = c.saveDelayMs ?? 600;
  const pollMs = c.pollMs ?? 15000;
  const dragQuiet = c.dragQuietMs ?? 1500;
  const now = c.now ?? Date.now;

  let stopped = false;
  let currentKey = "";
  let quietUntil = 0;
  let lastMoveAt = -Infinity;
  let pending: { placement: WindowPlacement } | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let sampleTimer: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let busyRestoring = false;
  let setupChanged = false;
  let pendingMaximize = false;
  /** The last normal (not maximised) place seen: what to keep behind a maximised window with nothing saved yet. */
  let lastNormal: WindowPlacement | null = null;
  const unlisten: Array<() => void> = [];

  const readAreas = async () => {
    const monitors = await win.monitors();
    return monitors.map(areaOf);
  };

  async function captureNormal(): Promise<void> {
    try {
      if ((await win.isMaximized()) || (await win.isMinimized())) return;
      const [pos, size, scale] = await Promise.all([win.outerPosition(), win.innerSize(), win.scaleFactor()]);
      const snap = snapshotPlacement({ x: pos.x, y: pos.y }, { w: size.w, h: size.h }, scale);
      if (snap) lastNormal = snap;
    } catch {
      /* nothing to keep */
    }
  }

  async function restore(): Promise<void> {
    if (busyRestoring) return;
    busyRestoring = true;
    try {
      const areas = await readAreas();
      if (areas.length === 0) return;
      currentKey = setupKey(areas);
      setupChanged = false;
      const primaryM = await win.primary().catch(() => null);
      const currentM = (await win.current().catch(() => null)) ?? primaryM;
      const primary = primaryM ? areaOf(primaryM) : null;
      const current = currentM ? areaOf(currentM) : null;
      let plan = planRestore(store.entries(), store.legacy(), areas, primary, current, options);
      const home = current ?? areas[0];
      if (!plan && label === "launcher" && home) {
        plan = { rect: defaultLauncherRect(home, options), maximized: false, known: false };
      }
      if (!plan || stopped) return;
      if (await win.isMinimized().catch(() => false)) return;
      quietUntil = now() + 1500;
      await applyRect(win, plan.rect);
      await captureNormal();
      // A hidden window is maximised only by its style (it then does not fill the work area), so wait until
      // it is on screen.
      if (plan.maximized) {
        if (await win.isVisible().catch(() => false)) await win.maximize().catch(() => {});
        else pendingMaximize = true;
      }
      quietUntil = now() + 800;
    } catch (e) {
      console.warn(`[placement] could not restore the ${label} window:`, e);
    } finally {
      busyRestoring = false;
    }
  }

  async function sample(): Promise<void> {
    sampleTimer = undefined;
    if (stopped || now() < quietUntil) return;
    try {
      if (!(await win.isVisible()) || (await win.isMinimized())) return;
      if (await win.isMaximized()) {
        const base = store.entries().find((e) => e.key === currentKey);
        // The place behind a maximised window stays as it was; only the state is remembered.
        const normal = base?.placement ?? lastNormal;
        pending = normal ? { placement: { ...normal, maximized: true } } : null;
        return;
      }
      const [pos, size, scale] = await Promise.all([win.outerPosition(), win.innerSize(), win.scaleFactor()]);
      const snap = snapshotPlacement({ x: pos.x, y: pos.y }, { w: size.w, h: size.h }, scale);
      pending = snap ? { placement: snap } : null;
      if (snap) lastNormal = snap;
    } catch {
      /* a window being closed: nothing to sample */
    }
  }

  async function commit(): Promise<void> {
    saveTimer = undefined;
    if (stopped) return;
    await sample();
    const item = pending;
    pending = null;
    if (!item) return;
    try {
      const areas = await readAreas();
      if (areas.length === 0) return;
      const key = setupKey(areas);
      if (key !== currentKey) {
        // The monitors changed under the window: this place is the OS's doing, not a user move.
        setupChanged = true;
        void checkSetup();
        return;
      }
      const home = pickArea(areas, item.placement);
      if (!home) return;
      const existing = store.entries().find((e) => entryMatches(e, areas));
      if (existing && existing.key === key && samePlacement(existing.placement, item.placement)) return;
      const entry: SetupEntry = { key, placement: item.placement, area: home, at: now() };
      // An entry saved under the older (work area) key for these monitors is replaced by this one.
      const rest = store.entries().filter((e) => !entryMatches(e, areas));
      store.save(rememberSetup(rest, entry), item.placement);
    } catch {
      /* storage or a closing window: the next change saves again */
    }
  }

  const onUserChange = () => {
    if (stopped || now() < quietUntil) return;
    lastMoveAt = now();
    if (!sampleTimer) sampleTimer = setTimeout(() => void sample(), 120);
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void commit(), saveDelay);
  };

  /** The monitors changed: a setup with a saved place gets its window there; any other leaves it where it is. */
  async function moveForNewSetup(areas: ReturnType<typeof areaOf>[]): Promise<void> {
    currentKey = setupKey(areas);
    setupChanged = false;
    if (await win.isMinimized().catch(() => false)) return;
    const [pos, size] = await Promise.all([win.outerPosition(), win.innerSize()]);
    const primaryM = await win.primary().catch(() => null);
    const plan = planOnChange(store.entries(), areas, { x: pos.x, y: pos.y, w: size.w, h: size.h }, primaryM ? areaOf(primaryM) : null, options);
    if (!plan) return;
    quietUntil = now() + 1500;
    await applyRect(win, plan.rect);
    if (plan.maximized && (await win.isVisible().catch(() => false))) await win.maximize().catch(() => {});
    quietUntil = now() + 800;
  }

  async function checkSetup(): Promise<void> {
    if (stopped || busyRestoring) return;
    try {
      if (pendingMaximize && (await win.isVisible().catch(() => false))) {
        pendingMaximize = false;
        await win.maximize().catch(() => {});
      }
      const areas = await readAreas();
      if (areas.length === 0) return;
      if (!setupChanged && setupKey(areas) === currentKey) return;
      // Never in the middle of a drag or a resize.
      if (now() - lastMoveAt < dragQuiet) return;
      // Nothing from before the change may be saved under the new setup.
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = undefined;
      pending = null;
      await moveForNewSetup(areas);
    } catch {
      /* try again at the next look */
    }
  }

  const ready = (async () => {
    if (c.restoreFirst === false) currentKey = setupKey(await readAreas().catch(() => []));
    else await restore();
    // Nothing was saved or restored (a fresh install, the overlay): the place it opened at is the normal one.
    if (!lastNormal) await captureNormal();
    if (c.showAfterRestore && !stopped) {
      await win.show().catch(() => {});
      if (pendingMaximize) {
        pendingMaximize = false;
        await win.maximize().catch(() => {});
      }
    }
    if (stopped) return;
    for (const sub of [win.onMoved(onUserChange), win.onResized(onUserChange), win.onScaleChanged(() => void checkSetup())]) {
      sub.then((fn) => (stopped ? fn() : unlisten.push(fn))).catch(() => {});
    }
    poll = setInterval(() => {
      // A hidden window is left alone until it is shown again.
      void win
        .isVisible()
        .then((v) => (v ? checkSetup() : undefined))
        .catch(() => {});
    }, pollMs);
  })();

  return {
    ready,
    check: checkSetup,
    async flush() {
      if (stopped) return;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = undefined;
      if (!pending && !sampleTimer) return;
      if (sampleTimer) clearTimeout(sampleTimer);
      await commit();
    },
    stop() {
      stopped = true;
      if (saveTimer) clearTimeout(saveTimer);
      if (sampleTimer) clearTimeout(sampleTimer);
      if (poll) clearInterval(poll);
      unlisten.forEach((fn) => fn());
    },
  };
}
