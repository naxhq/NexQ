import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { win, mac } = vi.hoisted(() => ({
  win: {
    scaleFactor: vi.fn(async () => 2),
    outerPosition: vi.fn(async () => ({ toLogical: () => ({ x: 100, y: 50 }) })),
    innerSize: vi.fn(async () => ({ toLogical: () => ({ width: 500, height: 700 }) })),
    setSize: vi.fn(async () => {}),
    setPosition: vi.fn(async () => {}),
  },
  mac: { value: true },
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => win,
  LogicalSize: class {
    constructor(public width: number, public height: number) {}
  },
  LogicalPosition: class {
    constructor(public x: number, public y: number) {}
  },
}));
vi.mock("../lib/shortcutLabel", () => ({ isMacPlatform: () => mac.value }));

import { OverlayResizeHandles } from "./OverlayResizeHandles";
import { useConfigStore } from "../stores/configStore";

beforeAll(() => {
  // jsdom has no pointer capture; frames run at once so each move applies.
  Object.assign(HTMLElement.prototype, {
    setPointerCapture() {},
    releasePointerCapture() {},
    hasPointerCapture: () => true,
  });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

beforeEach(() => {
  mac.value = true;
  useConfigStore.setState({ stealthMode: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useConfigStore.setState({ stealthMode: false });
});

const handle = (container: HTMLElement, edge: string) =>
  container.querySelector(`[data-resize-edge="${edge}"]`) as HTMLElement;

describe("OverlayResizeHandles", () => {
  it("adds the eight edge and corner handles on macOS while stealth is on", () => {
    const { container } = render(<OverlayResizeHandles />);
    expect(container.querySelectorAll("[data-resize-edge]")).toHaveLength(8);
  });

  it("adds nothing while stealth is off: native resizing is on then", () => {
    useConfigStore.setState({ stealthMode: false });
    const { container } = render(<OverlayResizeHandles />);
    expect(container.querySelectorAll("[data-resize-edge]")).toHaveLength(0);
  });

  it("adds nothing outside macOS (Windows changes the cursor natively)", () => {
    mac.value = false;
    const { container } = render(<OverlayResizeHandles />);
    expect(container.querySelectorAll("[data-resize-edge]")).toHaveLength(0);
  });

  it("dragging the east edge widens the window and leaves it in place", async () => {
    const { container } = render(<OverlayResizeHandles />);
    const east = handle(container, "e");
    fireEvent.pointerDown(east, { button: 0, pointerId: 1, screenX: 1000, screenY: 500 });
    await act(async () => {}); // the window's start rect arrives
    fireEvent.pointerMove(east, { pointerId: 1, screenX: 1030, screenY: 500 });
    fireEvent.pointerUp(east, { pointerId: 1, screenX: 1030, screenY: 500 });

    expect(win.setSize).toHaveBeenCalledWith(expect.objectContaining({ width: 530, height: 700 }));
    expect(win.setPosition).not.toHaveBeenCalled();
  });

  it("dragging the west edge moves the window so its right edge stays put", async () => {
    const { container } = render(<OverlayResizeHandles />);
    const west = handle(container, "w");
    fireEvent.pointerDown(west, { button: 0, pointerId: 1, screenX: 100, screenY: 300 });
    await act(async () => {});
    fireEvent.pointerMove(west, { pointerId: 1, screenX: 80, screenY: 300 });
    fireEvent.pointerUp(west, { pointerId: 1, screenX: 80, screenY: 300 });

    expect(win.setPosition).toHaveBeenCalledWith(expect.objectContaining({ x: 80, y: 50 }));
    expect(win.setSize).toHaveBeenCalledWith(expect.objectContaining({ width: 520, height: 700 }));
  });

  it("ignores a right-click", async () => {
    const { container } = render(<OverlayResizeHandles />);
    const east = handle(container, "e");
    fireEvent.pointerDown(east, { button: 2, pointerId: 1, screenX: 1000, screenY: 500 });
    await act(async () => {});
    fireEvent.pointerMove(east, { pointerId: 1, screenX: 1100, screenY: 500 });
    expect(win.setSize).not.toHaveBeenCalled();
  });
});
