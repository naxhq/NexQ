import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocView } from "./DocView";
import { docBlocks, markdownToDoc, type TpDoc } from "../index";

afterEach(cleanup);

describe("DocView", () => {
  it("draws only text: markup in a note is shown as characters, never built", () => {
    const hostile = {
      type: "doc",
      content: [
        { type: "paragraph", attrs: { id: "a" }, content: [{ type: "text", text: '<img src=x onerror="alert(1)"><script>alert(2)</script>' }] },
        { type: "image", attrs: { src: "https://evil.test/x.png" } },
        { type: "paragraph", attrs: { id: "b" }, content: [{ type: "text", text: "red?", marks: [{ type: "tpColor", attrs: { name: "red; background:url(x)" } }, { type: "link", attrs: { href: "javascript:alert(3)" } }] }] },
      ],
    } as unknown as TpDoc;
    const { container } = render(<DocView doc={hostile} />);
    expect(container.querySelector("img, script, a, iframe, style, [onerror]")).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(container.querySelector('[class*="background"]')).toBeNull();
    expect(container.innerHTML).not.toMatch(/javascript|evil\.test/);
  });

  it("renders headings, lists, marks, named colours and sizes", () => {
    const doc = markdownToDoc("# Title\n\nA **bold** and *italic* line.\n\n- one\n  - nested\n\n3. three");
    const { container } = render(<DocView doc={doc} />);
    expect(container.querySelector("h1")?.textContent).toBe("Title");
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("em")?.textContent).toBe("italic");
    expect(container.querySelectorAll("ul ul li")).toHaveLength(1);
    expect(container.querySelector("ol")?.getAttribute("start")).toBe("3");

    const styled: TpDoc = {
      type: "doc",
      content: [{ type: "paragraph", attrs: { id: "s" }, content: [{ type: "text", text: "loud", marks: [{ type: "tpColor", attrs: { name: "amber" } }, { type: "tpSize", attrs: { step: "xlarge" } }, { type: "underline" }] }] }],
    };
    const r2 = render(<DocView doc={styled} />);
    expect(r2.container.querySelector(".tp-c-amber .tp-s-xlarge, .tp-s-xlarge .tp-c-amber")).not.toBeNull();
    expect(r2.container.querySelector("u")).not.toBeNull();
  });

  it("marks each block with its id and state, and ticks only when asked", async () => {
    const doc = markdownToDoc("one two three\n\n- four five six");
    const ids = docBlocks(doc).map((b) => b.id);
    const states = new Map([[ids[0], "said" as const], [ids[1], "current" as const]]);
    const onToggle = vi.fn();
    const { container, rerender } = render(<DocView doc={doc} states={states} />);
    expect(container.querySelector(`[data-block-id="${ids[0]}"]`)).toHaveAttribute("data-state", "said");
    expect(container.querySelector(`[data-block-id="${ids[1]}"]`)).toHaveAttribute("data-state", "current");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    rerender(<DocView doc={doc} states={states} ticks onToggleSaid={onToggle} />);
    const ticks = screen.getAllByRole("button", { name: /^Said it:/ });
    expect(ticks).toHaveLength(2);
    expect(ticks[0]).toHaveAttribute("aria-pressed", "true");
    expect(ticks[1]).toHaveAttribute("aria-pressed", "false");
    expect(ticks.every((t) => t.getAttribute("tabindex") === "-1")).toBe(true);
    await userEvent.click(ticks[1]);
    expect(onToggle).toHaveBeenCalledWith(ids[1]);
  });

  it("an empty note renders without blocks of text", () => {
    const { container } = render(<DocView doc={{ type: "doc", content: [] } as unknown as TpDoc} />);
    expect(container.textContent).toBe("");
  });
});
