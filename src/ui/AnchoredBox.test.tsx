import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnchoredBox } from "./Popover";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AnchoredBox", () => {
  it("draws outside an overflow-hidden ancestor, inside the window, placed by the shared helper", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 420 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 420 });
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const r = this.getAttribute("role") === "tooltip" ? { left: 0, top: 0, width: 288, height: 200 } : { left: 380, top: 380, width: 30, height: 24 };
      return { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON: () => ({}) } as DOMRect;
    });
    render(
      <div data-clip style={{ overflow: "hidden" }}>
        <div>
          <button>opener</button>
          <AnchoredBox role="tooltip" className="w-72">
            hello
          </AnchoredBox>
        </div>
      </div>,
      { container: root.appendChild(document.createElement("div")) },
    );
    const box = screen.getByRole("tooltip");
    expect(box.closest("[data-clip]")).toBeNull();
    expect(root.contains(box)).toBe(true);
    expect(box.style.position).toBe("fixed");
    expect(parseFloat(box.style.left) + 288).toBeLessThanOrEqual(420 - 8);
    expect(parseFloat(box.style.top)).toBeGreaterThanOrEqual(8);
    expect(parseFloat(box.style.top) + 200).toBeLessThanOrEqual(420 - 8);
    root.remove();
  });
});
