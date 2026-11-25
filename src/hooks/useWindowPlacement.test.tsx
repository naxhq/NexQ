import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const win = vi.hoisted(() => ({
  visible: true,
  minimized: false,
  maximized: false,
  pos: { x: 100, y: 80 },
  size: { width: 500, height: 700 },
  scale: 1,
  setSize: vi.fn(async () => {}),
  setPosition: vi.fn(async () => {}),
  setEffects: vi.fn(),
  setContentProtected: vi.fn(),
  handlers: { moved: [] as Array<() => void>, resized: [] as Array<() => void> },
}));

const area = vi.hoisted(() => ({
  work: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1040 } },
  monitors: [] as unknown[],
}));

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
  const monitor = () => ({
    scaleFactor: 1,
    position: { x: 0, y: 0 },
    size: { width: 1920, height: 1080 },
    workArea: area.work,
  });
  return {
    PhysicalSize,
    PhysicalPosition,
    availableMonitors: async () => (area.monitors.length ? area.monitors : [monitor()]),
    primaryMonitor: async () => monitor(),
    currentMonitor: async () => monitor(),
    getCurrentWindow: () => ({
      isVisible: async () => win.visible,
      isMinimized: async () => win.minimized,
      isMaximized: async () => win.maximized,
      outerPosition: async () => win.pos,
      innerSize: async () => win.size,
      scaleFactor: async () => win.scale,
      setSize: win.setSize,
      setPosition: win.setPosition,
      setEffects: win.setEffects,
      setContentProtected: win.setContentProtected,
      onMoved: async (h: () => void) => {
        win.handlers.moved.push(h);
        return () => {};
      },
      onResized: async (h: () => void) => {
        win.handlers.resized.push(h);
        return () => {};
      },
    }),
  };
});

import { useWindowPlacement } from "./useWindowPlacement";
import { useConfigStore } from "../stores/configStore";

const setPlacement = vi.fn();

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
}
async function moved() {
  win.handlers.moved.forEach((h) => h());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(700);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(win, {
    visible: true,
    minimized: false,
    maximized: false,
    pos: { x: 100, y: 80 },
    size: { width: 500, height: 700 },
    scale: 1,
  });
  win.setSize.mockClear();
  win.setPosition.mockClear();
  win.handlers.moved.length = 0;
  win.handlers.resized.length = 0;
  area.work = { position: { x: 0, y: 0 }, size: { width: 1920, height: 1040 } };
  area.monitors = [];
  setPlacement.mockClear();
  useConfigStore.setState({
    launcherPlacement: null,
    overlayPlacement: null,
    setWindowPlacement: setPlacement as never,
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
    expect(win.setSize).toHaveBeenCalledTimes(1);
    const size = win.setSize.mock.calls[0] as unknown as [{ width: number; height: number }];
    const pos = win.setPosition.mock.calls[0] as unknown as [{ x: number; y: number }];
    expect(size[0]).toMatchObject({ width: 500, height: 700 });
    expect(pos[0].x + 500).toBeLessThanOrEqual(1920);
    expect(pos[0].y + 700).toBeLessThanOrEqual(1040);
  });

  it("leaves the overlay alone when nothing was saved", async () => {
    renderHook(() => useWindowPlacement("overlay"));
    await settle();
    expect(win.setSize).not.toHaveBeenCalled();
    expect(win.setPosition).not.toHaveBeenCalled();
  });

  it("gives the launcher min(1180x740, 92% of the work area) the first time", async () => {
    renderHook(() => useWindowPlacement("launcher"));
    await settle();
    const size = win.setSize.mock.calls[0] as unknown as [{ width: number; height: number }];
    expect(size[0]).toMatchObject({ width: 1180, height: 740 });
  });

  it("shrinks the launcher's first size on a small work area", async () => {
    area.work = { position: { x: 0, y: 0 }, size: { width: 1280, height: 680 } };
    renderHook(() => useWindowPlacement("launcher"));
    await settle();
    const size = win.setSize.mock.calls[0] as unknown as [{ width: number; height: number }];
    expect(size[0]).toMatchObject({ width: Math.round(1280 * 0.92), height: Math.round(680 * 0.92) });
  });

  it("restores a launcher that was on an unplugged monitor onto the current one", async () => {
    useConfigStore.setState({ launcherPlacement: { x: 3000, y: 100, w: 1000, h: 700, scale: 1 } });
    renderHook(() => useWindowPlacement("launcher"));
    await settle();
    const pos = win.setPosition.mock.calls[0] as unknown as [{ x: number; y: number }];
    expect(pos[0].x).toBeGreaterThanOrEqual(0);
    expect(pos[0].x + 1000).toBeLessThanOrEqual(1920);
  });

  it("saves after a move, debounced, once the window has settled", async () => {
    renderHook(() => useWindowPlacement("overlay"));
    await settle();
    win.handlers.moved.forEach((h) => h());
    win.handlers.moved.forEach((h) => h());
    expect(setPlacement).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(setPlacement).toHaveBeenCalledTimes(1);
    expect(setPlacement).toHaveBeenCalledWith("overlay", { x: 100, y: 80, w: 500, h: 700, scale: 1 });
  });

  it("does not save the same place twice", async () => {
    renderHook(() => useWindowPlacement("overlay"));
    await settle();
    await moved();
    await moved();
    expect(setPlacement).toHaveBeenCalledTimes(1);
  });

  it.each([["hidden", { visible: false }], ["minimised", { minimized: true }], ["maximised", { maximized: true }]])(
    "does not save while %s",
    async (_name, state) => {
      renderHook(() => useWindowPlacement("overlay"));
      await settle();
      Object.assign(win, state);
      await moved();
      expect(setPlacement).not.toHaveBeenCalled();
    },
  );

  it("does not save the parked off-screen position of a minimised window", async () => {
    renderHook(() => useWindowPlacement("launcher"));
    await settle();
    win.pos = { x: -32000, y: -32000 };
    await moved();
    expect(setPlacement).not.toHaveBeenCalled();
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
    const { rerender } = renderHook(({ paused }) => useWindowPlacement("launcher", { paused }), {
      initialProps: { paused: false },
    });
    await settle();
    rerender({ paused: true });
    rerender({ paused: false });
    await settle();
    expect(win.setSize).toHaveBeenCalledTimes(1);
  });
});
