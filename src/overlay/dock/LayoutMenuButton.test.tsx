import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LayoutMenuButton } from "./LayoutMenu";
import { DEFAULT_PANELS, initialDockState } from "./layoutModel";

const panels = Object.fromEntries(DEFAULT_PANELS.map((p) => [p, { title: p }]));

afterEach(cleanup);

describe("Layout menu placement", () => {
  it("opens in the window's root through the shared popover, inside the window even for a button at the left edge", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 420 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 420 });
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
    const rect = { left: 4, top: 4, right: 28, bottom: 28, width: 24, height: 24, x: 4, y: 4, toJSON: () => ({}) } as DOMRect;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(rect);
    render(<LayoutMenuButton state={initialDockState(DEFAULT_PANELS)} dispatch={() => {}} panels={panels} />, { container: root.appendChild(document.createElement("div")) });
    fireEvent.click(screen.getByRole("button", { name: "Layout" }));
    const dialog = screen.getByRole("dialog", { name: "Layout" });
    expect(root.contains(dialog)).toBe(true);
    expect(dialog.style.position).toBe("fixed");
    expect(parseFloat(dialog.style.left)).toBeGreaterThanOrEqual(8);
    expect(dialog.style.maxHeight).not.toBe("");
    vi.restoreAllMocks();
    root.remove();
  });
});

import { LayoutMenu } from "./LayoutMenu";
import { dockReducer, type DockState } from "./layoutModel";
import { useState } from "react";

function Menu() {
  const [st, setSt] = useState<DockState>(() => dockReducer(initialDockState(DEFAULT_PANELS), { type: "saveLayout", name: "Mine" }));
  return <LayoutMenu state={st} dispatch={(a) => setSt((s) => dockReducer(s, a))} panels={panels} />;
}

describe("deleting a saved layout", () => {
  it("offers Undo that brings it back", () => {
    render(<Menu />);
    fireEvent.click(screen.getByRole("button", { name: "Delete Mine" }));
    expect(screen.queryByRole("button", { name: "Delete Mine" })).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/Deleted "Mine"/);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByRole("button", { name: "Delete Mine" })).toBeTruthy();
  });
});
