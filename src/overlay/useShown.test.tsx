import { act, render } from "@testing-library/react";
import { createRef, useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { useShown } from "./useShown";

function Probe({ r, out }: { r: React.RefObject<HTMLDivElement>; out: { v: boolean } }) {
  out.v = useShown(r);
  return null;
}

describe("useShown", () => {
  it("follows the dock's data-visible, without polling", async () => {
    const host = document.createElement("div");
    host.setAttribute("data-dock-panel", "points");
    host.setAttribute("data-visible", "false");
    const inner = document.createElement("div");
    host.appendChild(inner);
    document.body.appendChild(host);
    const r = createRef<HTMLDivElement>() as { current: HTMLDivElement | null };
    r.current = inner as HTMLDivElement;
    const out = { v: true };
    render(<Probe r={r as React.RefObject<HTMLDivElement>} out={out} />);
    expect(out.v).toBe(false);
    await act(async () => {
      host.setAttribute("data-visible", "true");
      await Promise.resolve();
    });
    expect(out.v).toBe(true);
    host.remove();
  });

  it("outside a dock it is always shown", () => {
    const el = document.createElement("div");
    const out = { v: false };
    render(<Probe r={{ current: el } as React.RefObject<HTMLDivElement>} out={out} />);
    expect(out.v).toBe(true);
  });
});

function Late({ out }: { out: { v: boolean; set: (n: number) => void } }) {
  // the scroll area is not there on the first render and is replaced later, like the prompter's
  const [n, setN] = useState(0);
  out.set = setN;
  const ref = useRef<HTMLDivElement | null>(null);
  out.v = useShown(ref);
  return n === 0 ? null : (
    <div
      key={n}
      ref={(el) => {
        ref.current = el;
      }}
    />
  );
}

describe("useShown with an element that comes later or is replaced", () => {
  it("attaches when the element first appears, again when it is replaced, and follows the page being hidden", async () => {
    const host = document.createElement("div");
    host.setAttribute("data-dock-panel", "points");
    host.setAttribute("data-visible", "false");
    document.body.appendChild(host);
    const out = { v: true, set: (_: number) => {} };
    render(<Late out={out} />, { container: host });
    expect(out.v).toBe(true); // nothing to watch yet
    await act(async () => out.set(1));
    expect(out.v).toBe(false); // found its panel, which is hidden
    await act(async () => out.set(2)); // a different element in the same panel
    expect(out.v).toBe(false);
    await act(async () => {
      host.setAttribute("data-visible", "true");
      await Promise.resolve();
    });
    expect(out.v).toBe(true);
    const vis = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
    expect(out.v).toBe(false);
    vis.mockRestore();
    await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
    expect(out.v).toBe(true);
    host.remove();
  });
});
