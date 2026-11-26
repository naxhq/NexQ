import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnchoredBox, Popover } from "./Popover";
import { popOrigin } from "./portal";

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

const raw = import.meta.glob(["../index.css", "../components/ServiceStatusBar.tsx", "../components/AgentStatusChip.tsx"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function rect(left: number, top: number, width: number, height: number) {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

function mockLayout(opener: DOMRect, box: DOMRect) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 500 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 700 });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return this.getAttribute("role") === "tooltip" || this.getAttribute("role") === "dialog" ? box : opener;
  });
}

describe("AnchoredBox entrance", () => {
  it("is drawn at its final place in its first painted style, with no transition on its position, even when the caller adds duration-*", () => {
    mockLayout(rect(100, 660, 60, 24), rect(0, 0, 200, 120));
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
    // Record every style the box has the moment it is first visible (a layout effect runs before paint).
    const seen: Array<{ left: string; top: string; transition: string; visibility: string }> = [];
    const obs = new MutationObserver(() => {
      const el = document.querySelector<HTMLElement>('[role="tooltip"]');
      if (el) seen.push({ left: el.style.left, top: el.style.top, transition: el.style.transition, visibility: el.style.visibility });
    });
    obs.observe(root, { subtree: true, attributes: true, childList: true });
    render(
      <div>
        <button>opener</button>
        <AnchoredBox role="tooltip" className="w-48 animate-in slide-in-from-bottom-2 duration-150">
          hello
        </AnchoredBox>
      </div>,
      { container: root.appendChild(document.createElement("div")) },
    );
    obs.takeRecords();
    const box = screen.getByRole("tooltip");
    // Above the footer opener: bottom of the box sits 8px over the opener, never at the window's top.
    expect(box.style.top).toBe(`${660 - 8 - 120}px`);
    expect(box.style.left).toBe("100px");
    expect(box.style.visibility).toBe("visible");
    expect(box.style.transition).toMatch(/none/);
    expect(box.className).toContain("nq-pop");
    // Every style it was ever visible with already had the final position.
    for (const s of seen.filter((x) => x.visibility === "visible")) {
      expect(s.top).toBe(`${660 - 8 - 120}px`);
      expect(s.left).toBe("100px");
      expect(s.transition).toMatch(/none/);
    }
    obs.disconnect();
    root.remove();
  });

  it("grows from the trigger edge: bottom edge when above, top edge when below, at the trigger centre", () => {
    mockLayout(rect(100, 660, 60, 24), rect(0, 0, 200, 120));
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
    render(
      <div>
        <AnchoredBox role="tooltip">above</AnchoredBox>
      </div>,
      { container: root.appendChild(document.createElement("div")) },
    );
    const above = screen.getByRole("tooltip");
    expect(above.dataset.side).toBe("top");
    expect(above.style.transformOrigin).toBe("30px 100%");
    cleanup();
    root.remove();
    // An opener at the top of the window: the box goes below it and grows from its top edge.
    mockLayout(rect(100, 10, 60, 24), rect(0, 0, 200, 120));
    const root2 = document.createElement("div");
    root2.id = "root";
    document.body.appendChild(root2);
    render(<AnchoredBox role="tooltip" prefer="below">below</AnchoredBox>, { container: root2.appendChild(document.createElement("div")) });
    const below = screen.getByRole("tooltip");
    expect(below.dataset.side).toBe("bottom");
    expect(below.style.transformOrigin).toMatch(/ 0%$/);
    root2.remove();
  });

  it("Popover has the same entrance contract", () => {
    mockLayout(rect(100, 660, 60, 24), rect(0, 0, 200, 120));
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    render(
      <Popover open onClose={() => {}} anchorRef={{ current: opener }} label="menu" prefer="above" className="duration-150">
        x
      </Popover>,
      { container: root.appendChild(document.createElement("div")) },
    );
    const box = screen.getByRole("dialog");
    expect(box.dataset.side).toBe("top");
    expect(box.style.transition).toMatch(/none/);
    expect(box.style.transformOrigin).toMatch(/100%$/);
    opener.remove();
    root.remove();
  });
});

describe("popOrigin", () => {
  const anchor = { left: 100, top: 100, right: 160, bottom: 124, width: 60, height: 24 };
  it("is the facing edge at the trigger's centre, kept inside the box", () => {
    expect(popOrigin(anchor, { left: 100, placement: "above" }, 200)).toBe("30px 100%");
    expect(popOrigin(anchor, { left: 100, placement: "below" }, 200)).toBe("30px 0%");
    expect(popOrigin(anchor, { left: 140, placement: "below" }, 200)).toBe("0px 0%");
    expect(popOrigin(anchor, { left: 0, placement: "above" }, 50)).toBe("50px 100%");
  });
});

describe(".nq-pop stylesheet", () => {
  const css = raw["../index.css"];
  const rule = css.match(/@keyframes nq-pop-in \{[^}]*\{[^}]*\}[^}]*\{[^}]*\}\s*\}/)?.[0] ?? "";
  it("animates only opacity and scale, never position", () => {
    expect(rule).toMatch(/opacity/);
    expect(rule).toMatch(/scale\(/);
    expect(rule).not.toMatch(/translate|top|left|inset/);
    expect(css).toMatch(/\.nq-pop \{[^}]*transition: none/);
  });
  it("is switched off for prefers-reduced-motion", () => {
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.nq-pop \{ animation: none; \}/);
  });
});

describe("callers do not bring their own entrance animation", () => {
  it("no AnchoredBox caller passes animate-in / slide-in / duration-* (they used to slide the box from the window's corner)", () => {
    for (const f of ["../components/ServiceStatusBar.tsx", "../components/AgentStatusChip.tsx"]) {
      const src = raw[f];
      for (const m of src.matchAll(/<AnchoredBox[\s\S]*?className="([^"]*)"/g)) {
        expect(m[1]).not.toMatch(/animate-in|slide-in|fade-in|duration-/);
      }
    }
  });
});
