import { act, render } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it } from "vitest";
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
