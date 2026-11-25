import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeMonitor {
  scaleFactor: number;
  position: { x: number; y: number };
  size: { width: number; height: number };
  workArea: { position: { x: number; y: number }; size: { width: number; height: number } };
}
const mon = (x: number, y: number, w: number, h: number, scale = 1): FakeMonitor => ({
  scaleFactor: scale,
  position: { x, y },
  size: { width: w, height: h },
  workArea: { position: { x, y }, size: { width: w, height: h - 40 } },
});

const win = vi.hoisted(() => ({
  visible: true,
  minimized: false,
  maximized: false,
  pos: { x: 100, y: 80 },
  size: { width: 500, height: 700 },
  scale: 1,
  setSize: vi.fn(),
  setPosition: vi.fn(),
  maximize: vi.fn(),
  show: vi.fn(),
  setEffects: vi.fn(),
  setContentProtected: vi.fn(),
  handlers: { moved: [] as Array<() => void>, resized: [] as Array<() => void>, scale: [] as Array<() => void> },
}));
const world = vi.hoisted(() => ({ monitors: [] as unknown[] }));

vi.mock("@tauri-apps/api/window", () => {
  class PhysicalSize {
    constructor(
      public width: number,
      public height: number,
    ) {}
  }
  class PhysicalPosition {
    constructor(
      public x: number,
      public y: number,
    ) {}
  }
  return {
    PhysicalSize,
    PhysicalPosition,
    availableMonitors: async () => world.monitors,
    primaryMonitor: async () => world.monitors[0],
    currentMonitor: async () => world.monitors[0],
    getCurrentWindow: () => ({
      isVisible: async () => win.visible,
      isMinimized: async () => win.minimized,
      isMaximized: async () => win.maximized,
      outerPosition: async () => win.pos,
      innerSize: async () => win.size,
      scaleFactor: async () => win.scale,
      setSize: win.setSize,
      setPosition: win.setPosition,
      maximize: win.maximize,
      show: win.show,
      setEffects: win.setEffects,
      setContentProtected: win.setContentProtected,
      onMoved: async (h: () => void) => (win.handlers.moved.push(h), () => {}),
      onResized: async (h: () => void) => (win.handlers.resized.push(h), () => {}),
      onScaleChanged: async (h: () => void) => (win.handlers.scale.push(h), () => {}),
    }),
  };
});

import { useWindowPlacement, flushWindowPlacement, resetPlacementMemory } from "./useWindowPlacement";
import { useConfigStore } from "../stores/configStore";
import { setupKey, areaOf, sanitizeSetups } from "../lib/windowPlacement";

const saved = vi.fn();
const keyOf = (ms: FakeMonitor[]) => setupKey(ms.map((m) => areaOf(m as never)));

async function settle(ms = 20) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
async function moved() {
  win.handlers.moved.forEach((h) => h());
  await settle(900);
}

beforeEach(() => {
  resetPlacementMemory();
  vi.useFakeTimers();
  Object.assign(win, { visible: true, minimized: false, maximized: false, pos: { x: 100, y: 80 }, size: { width: 500, height: 700 }, scale: 1 });
  // A window that obeys: what is set is what is read back.
  win.setPosition.mockReset().mockImplementation(async (p: { x: number; y: number }) => void (win.pos = { x: p.x, y: p.y }));
  win.setSize.mockReset().mockImplementation(async (s: { width: number; height: number }) => void (win.size = { width: s.width, height: s.height }));
  win.maximize.mockReset().mockImplementation(async () => void (win.maximized = true));
  win.show.mockReset().mockResolvedValue(undefined);
  win.setEffects.mockReset();
  win.setContentProtected.mockReset();
  win.handlers.moved.length = 0;
  win.handlers.resized.length = 0;
  win.handlers.scale.length = 0;
  world.monitors = [mon(0, 0, 1920, 1080)];
  saved.mockReset();
  useConfigStore.setState({
    launcherPlacement: null,
    overlayPlacement: null,
    launcherSetups: [],
    overlaySetups: [],
    setWindowSetups: ((label: string, entries: unknown[], latest: unknown) => {
      saved(label, entries, latest);
      useConfigStore.setState(label === "launcher" ? { launcherSetups: entries as never } : { overlaySetups: entries as never });
    }) as never,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useWindowPlacement", () => {
  it("puts the overlay back where it was, inside the monitor", async () => {
    useConfigStore.setState({ overlayPlacement: { x: 1800, y: 900, w: 500, h: 700, scale: 1 } });
    renderHook(() => useWindowPlacement("overlay"));
    await settle();
    expect(win.size).toEqual({ width: 500, height: 700 });
    expect(win.pos.x + 500).toBeLessThanOrEqual(1920);
    expect(win.pos.y + 700).toBeLessThanOrEqual(1040);
  });

  it("migrates the single placement of an older config: it is used, then saved for this setup", async () => {
    useConfigStore.setState({ overlayPlacement: { x: 300, y: 200, w: 500, h: 700, scale: 1 } });
    renderHook(() => useWindowPlacement("overlay"));
    await settle();
    expect(win.pos).toEqual({ x: 300, y: 200 });
    await settle(1500);
    win.pos = { x: 310, y: 210 };
    await moved();
    expect(saved).toHaveBeenCalledTimes(1);
    expect(saved.mock.calls[0][1][0].key).toBe(keyOf(world.monitors as FakeMonitor[]));
  });

  it("leaves the overlay alone when nothing was saved", async () => {
    renderHook(() => useWindowPlacement("overlay"));
    await settle();
    expect(win.setSize).not.toHaveBeenCalled();
    expect(win.setPosition).not.toHaveBeenCalled();
  });

  it("gives the launcher min(1180x740, 92% of the work area) the first time, then shows it", async () => {
    renderHook(() => useWindowPlacement("launcher"));
    await settle();
    expect(win.size).toEqual({ width: 1180, height: 740 });
    expect(win.show).toHaveBeenCalledTimes(1);
    // Placed before shown.
    expect(win.setSize.mock.invocationCallOrder[0]).toBeLessThan(win.show.mock.invocationCallOrder[0]);
  });

  it("never shows the overlay itself", async () => {
    renderHook(() => useWindowPlacement("overlay"));
    await settle();
    expect(win.show).not.toHaveBeenCalled();
  });

  it("restores a launcher that was on an unplugged monitor onto the current one", async () => {
    useConfigStore.setState({ launcherPlacement: { x: 3000, y: 100, w: 1000, h: 700, scale: 1 } });
    renderHook(() => useWindowPlacement("launcher"));
    await settle();
    expect(win.pos.x).toBeGreaterThanOrEqual(0);
    expect(win.pos.x + 1000).toBeLessThanOrEqual(1920);
  });

  it("sets the position before the size (a move to another scale rescales first)", async () => {
    useConfigStore.setState({ overlayPlacement: { x: 100, y: 100, w: 500, h: 700, scale: 1 } });
    renderHook(() => useWindowPlacement("overlay"));
    await settle();
    expect(win.setPosition.mock.invocationCallOrder[0]).toBeLessThan(win.setSize.mock.invocationCallOrder[0]);
  });

  it("corrects once when a DPI change altered the size behind the first attempt", async () => {
    useConfigStore.setState({ overlayPlacement: { x: 100, y: 100, w: 500, h: 700, scale: 1 } });
    let first = true;
    win.setSize.mockImplementation(async (s: { width: number; height: number }) => {
      win.size = first ? { width: Math.round(s.width * 1.5), height: Math.round(s.height * 1.5) } : { width: s.width, height: s.height };
      first = false;
    });
    renderHook(() => useWindowPlacement("overlay"));
    await settle();
    expect(win.setSize).toHaveBeenCalledTimes(2);
    expect(win.size).toEqual({ width: 500, height: 700 });
  });

  it("puts a maximised window back maximised, with the normal size behind it kept", async () => {
    useConfigStore.setState({
      launcherSetups: [{ key: keyOf(world.monitors as FakeMonitor[]), placement: { x: 200, y: 100, w: 1100, h: 700, scale: 1, maximized: true }, area: null, at: 1 }],
    });
    renderHook(() => useWindowPlacement("launcher"));
    await settle();
    expect(win.size).toEqual({ width: 1100, height: 700 });
    expect(win.maximize).toHaveBeenCalled();
    // While maximised the window reports a huge rect; the normal one behind it must not be replaced.
    await settle(1500);
    win.size = { width: 1920, height: 1040 };
    win.pos = { x: 0, y: 0 };
    await moved();
    const last = saved.mock.calls[saved.mock.calls.length - 1];
    if (last) expect(last[2]).toMatchObject({ x: 200, y: 100, w: 1100, h: 700, maximized: true });
  });

  it("saves after a move, debounced, once the window has settled", async () => {
    renderHook(() => useWindowPlacement("overlay"));
    await settle();
    win.handlers.moved.forEach((h) => h());
    win.handlers.moved.forEach((h) => h());
    expect(saved).not.toHaveBeenCalled();
    await settle(900);
    expect(saved).toHaveBeenCalledTimes(1);
    expect(saved.mock.calls[0][2]).toEqual({ x: 100, y: 80, w: 500, h: 700, scale: 1 });
  });

  it("does not save the same place twice", async () => {
    renderHook(() => useWindowPlacement("overlay"));
    await settle();
    await moved();
    await moved();
    expect(saved).toHaveBeenCalledTimes(1);
  });

  it("does not save our own restore as a user move", async () => {
    useConfigStore.setState({ overlayPlacement: { x: 300, y: 200, w: 500, h: 700, scale: 1 } });
    renderHook(() => useWindowPlacement("overlay"));
    await settle();
    // The events our setPosition and setSize cause, a moment later.
    win.handlers.moved.forEach((h) => h());
    win.handlers.resized.forEach((h) => h());
    await settle(1000);
    expect(saved).not.toHaveBeenCalled();
  });

  it.each([
    ["hidden", { visible: false }],
    ["minimised", { minimized: true }],
  ])("does not save while %s", async (_name, state) => {
    renderHook(() => useWindowPlacement("overlay"));
    await settle();
    Object.assign(win, state);
    await moved();
    expect(saved).not.toHaveBeenCalled();
  });

  it("does not save the parked off-screen position of a minimised window", async () => {
    renderHook(() => useWindowPlacement("launcher"));
    await settle();
    win.pos = { x: -32000, y: -32000 };
    await moved();
    expect(saved).not.toHaveBeenCalled();
  });

  it("flushes a move that has not been saved yet (close, quit, update, end of a meeting)", async () => {
    renderHook(() => useWindowPlacement("overlay"));
    await settle();
    win.pos = { x: 400, y: 300 };
    win.handlers.moved.forEach((h) => h());
    await settle(200);
    // The window hides right after (close to tray): the sampled place is still saved.
    win.visible = false;
    await act(async () => {
      await flushWindowPlacement();
    });
    expect(saved).toHaveBeenCalledTimes(1);
    expect(saved.mock.calls[0][2]).toMatchObject({ x: 400, y: 300 });
  });

  it("keeps a separate place for each monitor setup, and a missing monitor does not overwrite one", async () => {
    const docked = [mon(0, 0, 1920, 1080), mon(1920, 0, 1920, 1080)];
    world.monitors = docked;
    renderHook(() => useWindowPlacement("overlay"));
    await settle();
    win.pos = { x: 2500, y: 100 };
    await moved();
    const dockedKey = keyOf(docked);
    expect(saved.mock.calls[saved.mock.calls.length - 1][1][0].key).toBe(dockedKey);

    // Undock: the OS drags the window to the one monitor, a move event arrives with it.
    world.monitors = [mon(0, 0, 1920, 1080)];
    win.pos = { x: 100, y: 100 };
    await moved();
    await settle(6000);
    const entry = useConfigStore.getState().overlaySetups.find((e) => e.key === dockedKey)!;
    expect(entry.placement.x).toBe(2500);
    expect(win.pos.x + 500).toBeLessThanOrEqual(1920);
  });

  it("goes to the saved place of a setup it has seen when the monitors change back", async () => {
    const solo = [mon(0, 0, 1920, 1080)];
    const docked = [mon(0, 0, 1920, 1080), mon(1920, 0, 1920, 1080)];
    useConfigStore.setState({
      overlaySetups: [
        { key: keyOf(solo), placement: { x: 50, y: 60, w: 500, h: 700, scale: 1 }, area: areaOf(solo[0] as never), at: 2 },
        { key: keyOf(docked), placement: { x: 2200, y: 90, w: 500, h: 700, scale: 1 }, area: areaOf(docked[1] as never), at: 1 },
      ],
    });
    world.monitors = solo;
    renderHook(() => useWindowPlacement("overlay"));
    await settle();
    expect(win.pos).toEqual({ x: 50, y: 60 });
    world.monitors = docked;
    await settle(16000);
    expect(win.pos).toEqual({ x: 2200, y: 90 });
  });

  it("does not move the window during a drag", async () => {
    const solo = [mon(0, 0, 1920, 1080)];
    const docked = [mon(0, 0, 1920, 1080), mon(1920, 0, 1920, 1080)];
    useConfigStore.setState({
      overlaySetups: [{ key: keyOf(docked), placement: { x: 2200, y: 90, w: 500, h: 700, scale: 1 }, area: areaOf(docked[1] as never), at: 1 }],
    });
    world.monitors = solo;
    renderHook(() => useWindowPlacement("overlay"));
    await settle(2500);
    world.monitors = docked;
    win.pos = { x: 700, y: 300 };
    // The user keeps dragging for the next 3 s.
    for (let i = 0; i < 12; i++) {
      win.handlers.moved.forEach((h) => h());
      await settle(250);
    }
    expect(win.pos).toEqual({ x: 700, y: 300 });
    await settle(16000);
    expect(win.pos).toEqual({ x: 2200, y: 90 });
  });

  it("moves nothing when only a work area changes (captions bar, taskbar auto-hide, a docked bar)", async () => {
    useConfigStore.setState({ overlayPlacement: { x: 300, y: 200, w: 500, h: 700, scale: 1 } });
    renderHook(() => useWindowPlacement("overlay"));
    await settle();
    const calls = win.setPosition.mock.calls.length;
    const shapes = [
      { ...mon(0, 0, 1920, 1080), workArea: { position: { x: 0, y: 80 }, size: { width: 1920, height: 920 } } },
      { ...mon(0, 0, 1920, 1080), workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } } },
      { ...mon(0, 0, 1920, 1080), workArea: { position: { x: 120, y: 0 }, size: { width: 1800, height: 1040 } } },
    ];
    for (const m of shapes) {
      world.monitors = [m];
      win.pos = { x: 10, y: 10 }; // even the OS shuffling it
      await settle(16000);
    }
    expect(win.setPosition.mock.calls.length).toBe(calls);
    expect(saved).not.toHaveBeenCalled();
  });

  it("a monitor change with no saved place for it leaves a visible window where it is", async () => {
    useConfigStore.setState({ overlayPlacement: { x: 300, y: 200, w: 500, h: 700, scale: 1 } });
    renderHook(() => useWindowPlacement("overlay"));
    await settle();
    const calls = win.setPosition.mock.calls.length;
    world.monitors = [mon(0, 0, 1920, 1080), mon(1920, 0, 1920, 1080)];
    win.pos = { x: 2300, y: 120 };
    await settle(16000);
    expect(win.setPosition.mock.calls.length).toBe(calls);
    expect(win.pos).toEqual({ x: 2300, y: 120 });
  });

  it("a place saved under the older work-area key is still used", async () => {
    const m = world.monitors as FakeMonitor[];
    const legacyKey = setupKey(m.map((x) => ({ ...areaOf(x as never), mon: undefined })));
    useConfigStore.setState({ overlaySetups: [{ key: legacyKey, placement: { x: 222, y: 111, w: 500, h: 700, scale: 1 }, area: null, at: 1 }] });
    renderHook(() => useWindowPlacement("overlay"));
    await settle();
    expect(win.pos).toEqual({ x: 222, y: 111 });
  });

  it("after a reset the other window hears it: its next save writes only the new place", async () => {
    useConfigStore.setState({
      overlaySetups: [
        { key: "old-a", placement: { x: 1, y: 1, w: 500, h: 700, scale: 1 }, area: null, at: 1 },
        { key: "old-b", placement: { x: 2, y: 2, w: 500, h: 700, scale: 1 }, area: null, at: 2 },
      ],
    });
    renderHook(() => useWindowPlacement("overlay"));
    await settle();
    // What the store does when the launcher clears the keys (onKeyChange with null).
    useConfigStore.setState({ overlaySetups: sanitizeSetups(null), overlayPlacement: null });
    await settle(1600);
    win.pos = { x: 640, y: 320 };
    await moved();
    const entries = saved.mock.calls[saved.mock.calls.length - 1][1];
    expect(entries).toHaveLength(1);
    expect(entries[0].placement).toMatchObject({ x: 640, y: 320 });
  });

  it("maximises a hidden overlay only once it is shown", async () => {
    const m = world.monitors as FakeMonitor[];
    useConfigStore.setState({ overlaySetups: [{ key: setupKey(m.map((x) => areaOf(x as never))), placement: { x: 200, y: 100, w: 500, h: 700, scale: 1, maximized: true }, area: null, at: 1 }] });
    win.visible = false;
    renderHook(() => useWindowPlacement("overlay"));
    await settle();
    expect(win.maximize).not.toHaveBeenCalled();
    win.visible = true;
    await settle(16000);
    expect(win.maximize).toHaveBeenCalled();
  });

  it("does nothing in demo mode, before the config is loaded, or in another window", async () => {
    useConfigStore.setState({ overlayPlacement: { x: 10, y: 10, w: 500, h: 700, scale: 1 } });
    renderHook(() => useWindowPlacement("overlay", { paused: true }));
    renderHook(() => useWindowPlacement("overlay", { enabled: false }));
    renderHook(() => useWindowPlacement("devlog"));
    await settle();
    expect(win.setSize).not.toHaveBeenCalled();
    expect(win.handlers.moved).toHaveLength(0);
  });

  it("only reads and moves the window: no effects, no content protection", async () => {
    useConfigStore.setState({ overlayPlacement: { x: 10, y: 10, w: 500, h: 700, scale: 1 } });
    renderHook(() => useWindowPlacement("overlay"));
    await settle();
    await moved();
    expect(win.setEffects).not.toHaveBeenCalled();
    expect(win.setContentProtected).not.toHaveBeenCalled();
  });

  it("restores only once, even when demo mode ends", async () => {
    const { rerender } = renderHook(({ paused }) => useWindowPlacement("launcher", { paused }), { initialProps: { paused: false } });
    await settle();
    rerender({ paused: true });
    rerender({ paused: false });
    await settle();
    expect(win.setSize).toHaveBeenCalledTimes(1);
  });
});
