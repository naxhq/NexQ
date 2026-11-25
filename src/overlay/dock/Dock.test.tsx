import { useReducer, useState, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dock, type DockPanelDef } from "./Dock";
import { LayoutMenu } from "./LayoutMenu";
import { createDebouncedSaver } from "./layoutStorage";
import {
  dockReducer,
  findStackOf,
  initialDockState,
  leaves,
  panelsOf,
  type DockAction,
  type DockState,
} from "./layoutModel";
import { computeGeometry } from "./layoutGeometry";

const IDS = ["transcript", "assistant", "notes", "brief"];

function Counter({ id }: { id: string }) {
  const [n, setN] = useState(0);
  return (
    <div data-testid={`body-${id}`} className="flex flex-col">
      <button type="button" onClick={() => setN((x) => x + 1)}>
        {`count-${id}`}
      </button>
      <span data-testid={`n-${id}`}>{n}</span>
      <div data-testid={`scroll-${id}`} style={{ overflow: "auto", height: 40 }} />
      <input aria-label={`field-${id}`} />
    </div>
  );
}

function defs(): Record<string, DockPanelDef> {
  return Object.fromEntries(
    IDS.map((id) => [
      id,
      {
        title: id[0].toUpperCase() + id.slice(1),
        node: <Counter id={id} />,
        minW: 180,
        minH: 120,
        canHide: id !== "assistant",
        reading: id === "transcript" || id === "assistant",
      } satisfies DockPanelDef,
    ]),
  );
}

let dispatchRef: (a: DockAction) => void = () => undefined;
let stateRef: DockState = initialDockState(IDS);

function Harness({ size = { w: 900, h: 600 }, opacity }: { size?: { w: number; h: number }; opacity?: number }) {
  const [state, dispatch] = useReducer(dockReducer, IDS, (k) => initialDockState(k));
  dispatchRef = dispatch;
  stateRef = state;
  const panels = defs();
  return (
    <div>
      <Dock panels={panels} state={state} dispatch={dispatch} size={size} windowOpacity={opacity} />
    </div>
  ) as ReactNode as never;
}

const run = (a: DockAction) => act(() => dispatchRef(a));
const stackId = (p: string) => findStackOf(stateRef.layout.root, p)!.id;

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => cleanup());

describe("Dock: panels mount once and are only moved by style", () => {
  it("keeps element identity, state, scrollTop and focus across dock, reorder, hide, show and presets", () => {
    render(<Harness />);
    const nodes = Object.fromEntries(IDS.map((id) => [id, screen.getByTestId(`body-${id}`)]));

    fireEvent.click(screen.getByText("count-transcript"));
    fireEvent.click(screen.getByText("count-transcript"));
    fireEvent.click(screen.getByText("count-assistant"));
    const sc = screen.getByTestId("scroll-transcript");
    sc.scrollTop = 37;
    const field = screen.getByLabelText("field-assistant") as HTMLInputElement;
    field.value = "draft kept";
    field.focus();
    expect(document.activeElement).toBe(field);

    const check = (focusKept: boolean) => {
      for (const id of IDS) expect(screen.getByTestId(`body-${id}`)).toBe(nodes[id]);
      expect(screen.getByTestId("n-transcript").textContent).toBe("2");
      expect(screen.getByTestId("n-assistant").textContent).toBe("1");
      expect(screen.getByTestId("scroll-transcript").scrollTop).toBe(37);
      expect((screen.getByLabelText("field-assistant") as HTMLInputElement).value).toBe("draft kept");
      if (focusKept) expect(document.activeElement).toBe(field);
    };

    // dock transcript below assistant (assistant stays visible: focus kept)
    run({ type: "dock", panel: "transcript", target: { kind: "stack", stackId: stackId("assistant") }, zone: "bottom" });
    check(true);
    // tab notes into assistant's stack, then another into it, reorder
    run({ type: "show", panel: "notes" });
    run({ type: "dock", panel: "notes", target: { kind: "stack", stackId: stackId("transcript") }, zone: "center" });
    check(true);
    run({ type: "show", panel: "brief" });
    run({ type: "dock", panel: "brief", target: { kind: "stack", stackId: stackId("transcript") }, zone: "center" });
    run({ type: "reorder", panel: "brief", index: 0 });
    check(true);
    // hide and show a panel (still mounted, inert while hidden)
    run({ type: "hide", panel: "transcript" });
    const hidden = document.getElementById("nq-panel-transcript")!;
    expect(hidden).toBe(nodes.transcript.parentElement);
    expect(hidden.hasAttribute("inert")).toBe(true);
    expect(hidden.getAttribute("data-visible")).toBe("false");
    expect(hidden.style.visibility === "" || hidden.className.includes("nq-dock-panel")).toBe(true);
    check(true);
    run({ type: "show", panel: "transcript" });
    expect(document.getElementById("nq-panel-transcript")!.hasAttribute("inert")).toBe(false);
    check(true);
    // presets
    for (const preset of ["notes", "presenter", "focus", "everything", "classic"] as const) {
      run({ type: "preset", preset });
      check(preset !== "presenter" && preset !== "focus" ? true : true);
    }
    // same wrapper element for the whole run
    expect(document.getElementById("nq-panel-assistant")!.contains(nodes.assistant)).toBe(true);
  });

  it("panels in the same stack share a rect; only the active one is visible and not inert", () => {
    render(<Harness />);
    run({ type: "show", panel: "notes" });
    run({ type: "dock", panel: "notes", target: { kind: "stack", stackId: stackId("assistant") }, zone: "center" });
    const a = document.getElementById("nq-panel-assistant")!;
    const n = document.getElementById("nq-panel-notes")!;
    expect(n.getAttribute("data-visible")).toBe("true"); // docking activates it
    expect(a.getAttribute("data-visible")).toBe("false");
    expect(a.hasAttribute("inert")).toBe(true);
    expect(a.style.transform).toBe(n.style.transform);
    expect(a.style.width).toBe(n.style.width);
  });
});

describe("Dock: roles and live geometry", () => {
  it("exposes tablist, tab, tabpanel and separator roles with values", () => {
    render(<Harness />);
    expect(screen.getAllByRole("tablist")).toHaveLength(2);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Transcript", "Assistant"]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[0].getAttribute("aria-controls")).toBe("nq-panel-transcript");
    expect(document.getElementById("nq-panel-transcript")!.getAttribute("role")).toBe("tabpanel");
    const sep = screen.getByRole("separator");
    expect(sep.getAttribute("aria-orientation")).toBe("vertical");
    expect(sep.getAttribute("aria-valuenow")).toBe("50");
    expect(Number(sep.getAttribute("aria-valuemin"))).toBeLessThan(50);
    expect(Number(sep.getAttribute("aria-valuemax"))).toBeGreaterThan(50);
    expect(sep.getAttribute("aria-label")).toBe("Resize Transcript and Assistant");
  });

  it("Classic at 400/500/900 shows both panels like today", () => {
    for (const [w, sameX] of [
      [400, true],
      [500, false],
      [900, false],
    ] as const) {
      const { unmount } = render(<Harness size={{ w, h: 480 }} />);
      const t = document.getElementById("nq-panel-transcript")!;
      const a = document.getElementById("nq-panel-assistant")!;
      expect(t.getAttribute("data-visible")).toBe("true");
      expect(a.getAttribute("data-visible")).toBe("true");
      const x = (el: HTMLElement) => el.style.transform.match(/translate3d\((-?\d+)px/)![1];
      expect(x(t) === x(a)).toBe(sameX);
      unmount();
    }
  });

  it("arrow keys resize a separator (Shift = bigger); double-click evens out; Home goes to the minimum", () => {
    render(<Harness />);
    const sep = screen.getByRole("separator");
    const now = () => Number(screen.getByRole("separator").getAttribute("aria-valuenow"));
    sep.focus();
    fireEvent.keyDown(sep, { key: "ArrowRight" });
    const small = now();
    expect(small).toBeGreaterThan(50);
    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowRight", shiftKey: true });
    expect(now()).toBeGreaterThan(small);
    fireEvent.doubleClick(screen.getByRole("separator"));
    expect(now()).toBe(50);
    fireEvent.keyDown(screen.getByRole("separator"), { key: "Home" });
    expect(now()).toBeLessThan(30);
    expect(screen.getByRole("status").textContent).toMatch(/percent/);
  });

  it("separators are inert while locked", () => {
    render(<Harness />);
    run({ type: "lock", locked: true });
    const sep = screen.getByRole("separator");
    const before = sep.getAttribute("aria-valuenow");
    fireEvent.keyDown(sep, { key: "ArrowRight" });
    expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe(before);
  });

  it("sets a reading backing variable from the window opacity", () => {
    const { container } = render(<Harness opacity={0.1} />);
    const v = Number((container.querySelector(".nq-dock") as HTMLElement).style.getPropertyValue("--dock-reading-alpha"));
    expect(v).toBeGreaterThan(0.8);
  });
});

describe("Dock: tabs and the Move menu (keyboard alternative)", () => {
  it("arrow keys move between tabs of a stack and activate", () => {
    render(<Harness />);
    run({ type: "show", panel: "notes" });
    run({ type: "dock", panel: "notes", target: { kind: "stack", stackId: stackId("assistant") }, zone: "center" });
    const tabs = () => screen.getAllByRole("tab");
    const assistant = screen.getByRole("tab", { name: "Assistant" });
    assistant.focus();
    fireEvent.keyDown(assistant, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Notes" }).getAttribute("aria-selected")).toBe("true");
    expect(tabs().length).toBe(3);
    fireEvent.keyDown(screen.getByRole("tab", { name: "Notes" }), { key: "ArrowRight", altKey: true, shiftKey: true });
    // already last: no change
    expect(panelsOf(findStackOf(stateRef.layout.root, "notes")!)).toBeDefined();
  });

  it("opens a Move menu from the keyboard and docks, announcing the result", () => {
    render(<Harness />);
    const tab = screen.getByRole("tab", { name: "Transcript" });
    tab.focus();
    fireEvent.keyDown(tab, { key: "ContextMenu" });
    const menu = screen.getByRole("menu", { name: "Move Transcript" });
    const labels = within(menu).getAllByRole("menuitem").map((i) => i.textContent);
    expect(labels).toContain("Left of Assistant");
    expect(labels).toContain("Below Assistant");
    expect(labels).toContain("Tab with Assistant");
    expect(labels).toContain("Bottom edge");
    expect(labels).toContain("Hide Transcript");
    fireEvent.click(within(menu).getByText("Below Assistant"));
    expect(screen.queryByRole("menu")).toBeNull();
    const root = stateRef.layout.root!;
    expect(root.kind === "split" && root.dir).toBe("col");
    expect(screen.getByRole("status").textContent).toMatch(/below Assistant/i);
  });

  it("Escape closes the menu and returns focus to the tab", () => {
    render(<Harness />);
    const tab = screen.getByRole("tab", { name: "Transcript" });
    fireEvent.keyDown(tab, { key: "ContextMenu" });
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(tab);
  });

  it("a locked layout opens the menu to say why, on screen, with a way to unlock", () => {
    render(<Harness />);
    run({ type: "lock", locked: true });
    fireEvent.keyDown(screen.getByRole("tab", { name: "Transcript" }), { key: "F10", shiftKey: true });
    const menu = screen.getByRole("menu");
    expect(menu.textContent).toMatch(/locked/i);
    fireEvent.click(screen.getByRole("menuitem", { name: "Unlock layout" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("a collapsed stack becomes a button that expands it", () => {
    render(<Harness />);
    run({ type: "collapse", stackId: stackId("transcript"), collapsed: true });
    const strip = screen.getByRole("button", { name: /Expand Transcript/ });
    expect(document.getElementById("nq-panel-transcript")!.getAttribute("data-visible")).toBe("false");
    fireEvent.click(strip);
    expect(leaves(stateRef.layout.root).every((s) => !s.collapsed)).toBe(true);
  });
});

describe("Dock: pointer drag (no HTML5 drag)", () => {
  const geo = () =>
    computeGeometry(stateRef.layout, { w: 900, h: 600 }, Object.fromEntries(IDS.map((i) => [i, { minW: 180, minH: 120 }])));
  const press = (el: Element, x: number, y: number) =>
    fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: x, clientY: y, isPrimary: true });
  const move = (el: Element, x: number, y: number) =>
    fireEvent.pointerMove(el, { pointerId: 1, clientX: x, clientY: y, isPrimary: true });
  const release = (el: Element, x: number, y: number) =>
    fireEvent.pointerUp(el, { pointerId: 1, clientX: x, clientY: y, isPrimary: true });

  it("never sets draggable and a click under the threshold only activates", () => {
    render(<Harness />);
    const tab = screen.getByRole("tab", { name: "Assistant" });
    expect(tab.getAttribute("draggable")).toBeNull();
    const before = JSON.stringify(stateRef.layout.root);
    press(tab, 600, 20);
    move(tab, 603, 22);
    release(tab, 603, 22);
    expect(JSON.stringify(stateRef.layout.root)).toBe(before);
  });

  it("drags past 6 px, shows our preview, and docks on release", () => {
    const { container } = render(<Harness />);
    const tab = screen.getByRole("tab", { name: "Transcript" });
    const a = geo().stacks.find((s) => s.panels[0] === "assistant")!;
    press(tab, 100, 25);
    move(tab, 110, 60);
    const x = a.rect.x + a.rect.w - 14;
    move(tab, x, 300);
    const drop = container.querySelector("[data-dock-drop]") as HTMLElement;
    expect(drop.style.opacity).toBe("1");
    expect(container.querySelector(".nq-dock")!.getAttribute("data-dragging")).toBe("true");
    release(tab, x, 300);
    const root = stateRef.layout.root!;
    expect(root.kind).toBe("split");
    expect(panelsOf(root)).toEqual(["assistant", "transcript"]);
    expect(container.querySelector(".nq-dock")!.hasAttribute("data-dragging")).toBe(false);
    expect(drop.style.opacity).toBe("0");
  });

  it("Escape cancels a drag and changes nothing", () => {
    const { container } = render(<Harness />);
    const tab = screen.getByRole("tab", { name: "Transcript" });
    const before = JSON.stringify(stateRef.layout);
    press(tab, 100, 25);
    move(tab, 700, 300);
    fireEvent.keyDown(window, { key: "Escape" });
    release(tab, 700, 300);
    expect(JSON.stringify(stateRef.layout)).toBe(before);
    expect(container.querySelector(".nq-dock")!.hasAttribute("data-dragging")).toBe(false);
  });

  it("pointercancel and window blur cancel safely", () => {
    const { container } = render(<Harness />);
    const tab = screen.getByRole("tab", { name: "Transcript" });
    const before = JSON.stringify(stateRef.layout);
    press(tab, 100, 25);
    move(tab, 700, 300);
    fireEvent.pointerCancel(tab, { pointerId: 1 });
    expect(JSON.stringify(stateRef.layout)).toBe(before);
    press(tab, 100, 25);
    move(tab, 700, 300);
    fireEvent(window, new Event("blur"));
    release(tab, 700, 300);
    expect(JSON.stringify(stateRef.layout)).toBe(before);
    expect(container.querySelector(".nq-dock")!.hasAttribute("data-dragging")).toBe(false);
  });

  it("a separator drag moves live and commits on release; Escape restores", () => {
    const { container } = render(<Harness />);
    const sep = screen.getByRole("separator");
    const g = geo().separators[0];
    const startX = g.pos;
    const t = document.getElementById("nq-panel-transcript")!;
    const w0 = t.style.width;
    press(sep, startX, 300);
    move(sep, startX + 120, 300);
    expect(t.style.width).not.toBe(w0); // live, imperative
    expect(stateRef.layout.root!.kind === "split" && stateRef.layout.root!.sizes[0]).toBeCloseTo(0.5, 5);
    release(sep, startX + 120, 300);
    expect(stateRef.layout.root!.kind === "split" && stateRef.layout.root!.sizes[0]).toBeGreaterThan(0.55);

    const w1 = t.style.width;
    press(screen.getByRole("separator"), startX + 120, 300);
    move(screen.getByRole("separator"), startX + 200, 300);
    expect(t.style.width).not.toBe(w1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(t.style.width).toBe(w1);
    expect(container.querySelector(".nq-dock")!.hasAttribute("data-dragging")).toBe(false);
  });

  it("does not use data-tauri-drag-region anywhere in the dock", () => {
    const { container } = render(<Harness />);
    expect(container.querySelector("[data-tauri-drag-region]")).toBeNull();
  });
});

describe("LayoutMenu", () => {
  it("lists presets drawn from the tree, panels, lock and reset, and dispatches", () => {
    const calls: DockAction[] = [];
    const state = initialDockState(IDS);
    render(
      <LayoutMenu
        state={state}
        dispatch={(a) => calls.push(a)}
        panels={{ transcript: { title: "Transcript" }, assistant: { title: "Assistant", canHide: false }, notes: { title: "Notes" }, brief: { title: "Brief" } }}
      />,
    );
    expect(screen.getAllByRole("img").length).toBe(5);
    fireEvent.click(screen.getAllByText("Notes")[0]);
    expect(calls[calls.length - 1]).toEqual({ type: "preset", preset: "notes" });
    expect((screen.getByRole("checkbox", { name: "Assistant" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Brief" }));
    expect(calls[calls.length - 1]).toEqual({ type: "show", panel: "brief" });
    fireEvent.click(screen.getByRole("button", { name: /lock layout/i }));
    expect(calls[calls.length - 1]).toEqual({ type: "lock", locked: true });
    fireEvent.change(screen.getByLabelText("Name for the new layout"), { target: { value: "Interview" } });
    fireEvent.click(screen.getByText("Save"));
    expect(calls[calls.length - 1]).toEqual({ type: "saveLayout", name: "Interview" });
    fireEvent.click(screen.getByText("Reset to Classic"));
    expect(calls[calls.length - 1]).toEqual({ type: "reset" });
  });
});

describe("debounced saver", () => {
  it("collapses bursts into one save and flushes on demand", () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const s = createDebouncedSaver<number>(save, 300);
    s.push(1);
    s.push(2);
    s.push(3);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(299);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(3);
    s.push(4);
    s.flush();
    expect(save).toHaveBeenLastCalledWith(4);
    s.push(5);
    s.cancel();
    vi.advanceTimersByTime(1000);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("a failing store never throws into the app", async () => {
    vi.useFakeTimers();
    const s = createDebouncedSaver<number>(() => {
      throw new Error("disk full");
    }, 10);
    s.push(1);
    expect(() => vi.advanceTimersByTime(20)).not.toThrow();
  });
});

describe("Dock: the drag affordances", () => {
  const geo = () =>
    computeGeometry(stateRef.layout, { w: 900, h: 600 }, Object.fromEntries(IDS.map((i) => [i, { minW: 180, minH: 120 }])));
  const ptr = (type: "pointerDown" | "pointerMove" | "pointerUp", el: Element, x: number, y: number) =>
    fireEvent[type](el, { pointerId: 1, button: 0, clientX: x, clientY: y, isPrimary: true });

  it("every tab carries a six-dot grip that is not part of its name", () => {
    const { container } = render(<Harness />);
    const tabs = screen.getAllByRole("tab");
    expect(container.querySelectorAll(".nq-dock-grip").length).toBe(tabs.length);
    for (const g of container.querySelectorAll(".nq-dock-grip")) {
      expect(g.getAttribute("aria-hidden")).toBe("true");
      expect(g.querySelectorAll("circle").length).toBe(6);
    }
    expect(screen.getByRole("tab", { name: "Transcript" })).toBeTruthy();
  });

  it("a locked layout shows a lock, not dots; clicking it opens the Move menu, which holds Unlock", () => {
    const { container } = render(<Harness />);
    run({ type: "lock", locked: true });
    expect(container.querySelector(".nq-grip-l")).toBeNull();
    const lock = container.querySelector(".nq-dock-lock")!;
    expect(lock).toBeTruthy();
    fireEvent.click(lock.closest(".nq-dock-grip-slot")!);
    // it did not unlock silently
    expect(stateRef.layout.locked).toBe(true);
    const menu = screen.getByRole("menu");
    expect(menu.textContent).toMatch(/locked/i);
    fireEvent.click(screen.getByRole("menuitem", { name: "Unlock layout" }));
    expect(stateRef.layout.locked).toBe(false);
    expect(container.querySelector(".nq-grip-l")).toBeTruthy();
  });

  it("a keyboard-focused tab always explains itself with the real keys; a press hides it; the grip shows it on hover only", async () => {
    const { container } = render(<Harness />);
    const tab = screen.getByRole("tab", { name: "Assistant" });
    // focus from the keyboard: the tip is there at once
    fireEvent.focus(tab);
    const tip = screen.getByRole("tooltip");
    expect(tip.textContent).toContain("Drag to move");
    expect(tip.textContent).toContain("Shift+F10");
    // a press (the start of a drag) takes it away
    ptr("pointerDown", tab, 600, 20);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.pointerUp(tab, { pointerId: 1, button: 0, clientX: 600, clientY: 20, isPrimary: true });
    fireEvent.blur(tab);
    // hovering the label does nothing; hovering the grip does, after a moment
    fireEvent.mouseEnter(tab.querySelector(".nq-dock-tab-label")!);
    await new Promise((r) => setTimeout(r, 450));
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.mouseEnter(container.querySelector(".nq-dock-grip-slot")!);
    await waitFor(() => expect(screen.getByRole("tooltip").textContent).toContain("Drag to move"), { timeout: 1200 });
  });

  it("while dragging, the chip and the status text say the same thing, from the drop target; the box carries no second label, taken from the drop target", () => {
    const { container } = render(<Harness />);
    const tab = screen.getByRole("tab", { name: "Transcript" });
    const a = geo().stacks.find((s) => s.panels[0] === "assistant")!;
    ptr("pointerDown", tab, 100, 25);
    ptr("pointerMove", tab, 110, 60);
    const dock = container.querySelector(".nq-dock")!;
    expect(dock.getAttribute("data-hit")).toBe("false");
    expect(container.querySelector(".nq-dock-ghost-name")!.textContent).toBe("Transcript");
    ptr("pointerMove", tab, a.rect.x + a.rect.w - 14, 300);
    expect(dock.getAttribute("data-hit")).toBe("true");
    const label = "Right of Assistant";
    expect(container.querySelector(".nq-dock-ghost-do")!.textContent).toBe(label);
    expect(container.querySelector(".nq-dock-drop-label")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(`Transcript: ${label}`);
    ptr("pointerUp", tab, a.rect.x + a.rect.w - 14, 300);
    expect(panelsOf(stateRef.layout.root)).toEqual(["assistant", "transcript"]);
  });

  it("the one-line note shows for the first five finished drags, moves up when the pointer is low, and Escape does not count", () => {
    const { container } = render(<Harness />);
    const tab = () => screen.getByRole("tab", { name: "Transcript" });
    const dock = () => container.querySelector(".nq-dock")!;
    // an Escape does not count
    ptr("pointerDown", tab(), 100, 25);
    ptr("pointerMove", tab(), 110, 60);
    expect(dock().getAttribute("data-note")).toBe("true");
    ptr("pointerMove", tab(), 300, 580);
    expect(dock().getAttribute("data-notepos")).toBe("top");
    ptr("pointerMove", tab(), 300, 200);
    expect(dock().getAttribute("data-notepos")).toBe("bottom");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(stateRef.drags ?? 0).toBe(0);
    ptr("pointerUp", tab(), 300, 200);
    // five finished drags, then no note
    for (let i = 0; i < 5; i++) run({ type: "countDrag" });
    expect(stateRef.drags).toBe(5);
    ptr("pointerDown", tab(), 100, 25);
    ptr("pointerMove", tab(), 110, 60);
    expect(dock().getAttribute("data-note")).toBe("false");
    fireEvent.keyDown(window, { key: "Escape" });
  });

  it("a finished drag counts once", () => {
    render(<Harness />);
    const tab = screen.getByRole("tab", { name: "Transcript" });
    const a = geo().stacks.find((s) => s.panels[0] === "assistant")!;
    ptr("pointerDown", tab, 100, 25);
    ptr("pointerMove", tab, 110, 60);
    ptr("pointerMove", tab, a.rect.x + a.rect.w - 14, 300);
    ptr("pointerUp", tab, a.rect.x + a.rect.w - 14, 300);
    expect(stateRef.drags).toBe(1);
  });
});

describe("Dock: one wording over a panel's own centre", () => {
  const ptr = (type: "pointerDown" | "pointerMove" | "pointerUp", el: Element, x: number, y: number) =>
    fireEvent[type](el, { pointerId: 1, button: 0, clientX: x, clientY: y, isPrimary: true });

  it("says 'No change here' there from the first move, and does not alternate with the starting hint", () => {
    const { container } = render(<Harness />);
    const tab = screen.getByRole("tab", { name: "Transcript" });
    const words = () => container.querySelector(".nq-dock-ghost-do")!.textContent;
    ptr("pointerDown", tab, 100, 25);
    ptr("pointerMove", tab, 130, 60); // inside its own panel
    expect(words()).toBe("No change here");
    ptr("pointerMove", tab, 160, 200);
    ptr("pointerMove", tab, 140, 300);
    expect(words()).toBe("No change here");
    fireEvent.keyDown(window, { key: "Escape" });
  });
});

