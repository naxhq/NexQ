import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NotePage, type PageActions } from "./NotePage";
import { bigDoc, block, sampleDoc } from "./fixtures";
import type { NoteDoc } from "../lib/types";

function actions(): PageActions & Record<string, ReturnType<typeof vi.fn>> {
  return {
    setText: vi.fn(),
    setType: vi.fn(),
    togglePin: vi.fn(),
    addLine: vi.fn(),
    deleteLine: vi.fn(),
    undo: vi.fn(),
  } as never;
}

function page(doc: NoteDoc = sampleDoc, over: Partial<React.ComponentProps<typeof NotePage>> = {}) {
  const a = actions();
  const utils = render(<NotePage doc={doc} colors editable actions={a} {...over} />);
  return { a, ...utils };
}

describe("NotePage", () => {
  it("sets topics as headings with a time, summary as lead, and marked lines in a list", () => {
    const { container } = page(sampleDoc, { jump: vi.fn() });
    expect(screen.getByRole("region", { name: "Notes" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Launch plan" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Jump to 1:05 in the transcript" })).toBeInTheDocument();
    expect(container.querySelector(".ln-summary")).not.toBeNull();
    const list = screen.getByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
    // Each kind has its own class (mark and weight) and a spoken name.
    expect(container.querySelector(".ln-decision")).toHaveTextContent("Decision: Ship the beta first");
    expect(container.querySelector(".ln-task")).toHaveTextContent("Task:");
    expect(container.querySelector(".ln-question")).toHaveTextContent("Question: Who owns support?");
  });

  it("tints people and places and sets dates, numbers and orgs by weight only", () => {
    const { container } = page();
    expect(container.querySelector(".ln-ent-person")).toHaveTextContent("Ana");
    expect(container.querySelector(".ln-ent-place")).toHaveTextContent("Berlin");
    expect(container.querySelector(".ln-ent-date")).toHaveTextContent("March 3");
    expect(container.querySelector(".ln-ent-number")).toHaveTextContent("$40k");
    expect(container.querySelector(".ln-ent-org")).toHaveTextContent("Acme");
    expect(container.querySelector(".ln-page")).not.toHaveClass("ln-plain");
  });

  it("switches colours off without losing the words", () => {
    const { container } = page(sampleDoc, { colors: false });
    expect(container.querySelector(".ln-page")).toHaveClass("ln-plain");
    expect(container.querySelector(".ln-ent-person")).toHaveTextContent("Ana");
  });

  it("renders model output as text: no element is created from it", () => {
    const evil: NoteDoc = {
      version: 1,
      blocks: [
        block({ id: "t", type: "topic", text: "<img src=x onerror=alert(1)> {{p:<b>Bob</b>}}" }),
        block({ id: "x", parent: "t", text: "<script>window.hacked = 1</script> {{l:<i>Rome</i>}}" }),
      ],
    };
    const { container } = page(evil);
    expect(container.querySelector("img, script, b, i")).toBeNull();
    expect(screen.getByText(/<script>window.hacked = 1<\/script>/)).toBeInTheDocument();
    expect((window as unknown as { hacked?: number }).hacked).toBeUndefined();
  });

  it("marks pinned and edited lines for everyone, sighted or not", () => {
    const { container } = page();
    expect(screen.getByText("(pinned)")).toBeInTheDocument();
    expect(container.querySelector(".ln-edited")).toHaveTextContent("Edited by you");
    expect(screen.getByText("(edited by you)")).toBeInTheDocument();
  });

  it("jumps the transcript from a topic time and from a line time", async () => {
    const jump = vi.fn();
    page(sampleDoc, { jump });
    await userEvent.click(screen.getByRole("button", { name: "Jump to 1:05 in the transcript" }));
    expect(jump).toHaveBeenLastCalledWith(65_000);
    await userEvent.click(screen.getByRole("button", { name: "Jump to 1:20 in the transcript" }));
    expect(jump).toHaveBeenLastCalledWith(80_000);
  });

  it("is a keyboard page: one tab stop, arrows move, Enter edits and keeps entity colours", async () => {
    const { a, container } = page();
    const rows = () => Array.from(container.querySelectorAll<HTMLElement>("[data-block-id]"));
    expect(rows().filter((r) => r.tabIndex === 0)).toHaveLength(1);
    rows()[0].focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(rows()[1]);
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(rows()[2]);

    await userEvent.keyboard("{Enter}");
    const box = screen.getByRole("textbox", { name: "Edit line" });
    expect(box).toHaveValue("Budget is $40k for Acme");
    await userEvent.clear(box);
    await userEvent.type(box, "Budget is $50k for Acme");
    await userEvent.keyboard("{Enter}");
    expect(a.setText).toHaveBeenCalledWith("b3", "Budget is $50k for {{o:Acme}}");
  });

  it("cancels an edit with Escape and changes the kind of a line", async () => {
    const { a, container } = page();
    const row = container.querySelector<HTMLElement>('[data-block-id="b3"]')!;
    row.focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(a.setText).not.toHaveBeenCalled();

    container.querySelector<HTMLElement>('[data-block-id="b3"]')!.focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.click(screen.getByRole("radio", { name: "Task" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(a.setType).toHaveBeenCalledWith("b3", "task");
  });

  it("pins with P, deletes with Delete and undoes with Ctrl+Z", async () => {
    const { a, container } = page();
    container.querySelector<HTMLElement>('[data-block-id="b4"]')!.focus();
    await userEvent.keyboard("p");
    expect(a.togglePin).toHaveBeenCalledWith("b4");
    await userEvent.keyboard("{Delete}");
    expect(a.deleteLine).toHaveBeenCalledWith("b4");
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(a.undo).toHaveBeenCalled();
  });

  it("ignores page keys while typing in the editor", async () => {
    const { a, container } = page();
    container.querySelector<HTMLElement>('[data-block-id="b3"]')!.focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.type(screen.getByRole("textbox"), "pxz{Delete}");
    expect(a.togglePin).not.toHaveBeenCalled();
    expect(a.deleteLine).not.toHaveBeenCalled();
  });

  it("opens a block menu with the line's actions", async () => {
    const { a } = page();
    const buttons = screen.getAllByRole("button", { name: /Options for this decision/ });
    await userEvent.click(buttons[0]);
    const menu = await screen.findByRole("menu", { name: "Line options" });
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("Edit"), expect.stringContaining("Pin"), expect.stringContaining("Copy as Markdown"), expect.stringContaining("Delete")]),
    );
    await userEvent.click(within(menu).getByRole("menuitem", { name: /Delete/ }));
    expect(a.deleteLine).toHaveBeenCalledWith("b4");
  });

  it("adds the user's own line, below a chosen line", async () => {
    const { a } = page();
    await userEvent.click(screen.getAllByRole("button", { name: /Options for this note/ })[0]);
    await userEvent.click(await screen.findByRole("menuitem", { name: /Add a line below/ }));
    await userEvent.type(screen.getByRole("textbox", { name: "New line" }), "Call the venue");
    await userEvent.click(screen.getByRole("radio", { name: "Task" }));
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(a.addLine).toHaveBeenCalledWith("task", "b1", "Call the venue", "b3");
  });

  it("shows the Add button at the end of the page, under the last topic", async () => {
    const { a } = page();
    await userEvent.click(screen.getByRole("button", { name: "Add your own line" }));
    await userEvent.type(screen.getByRole("textbox", { name: "New line" }), "One more{Enter}");
    expect(a.addLine).toHaveBeenCalledWith("bullet", "b1", "One more", "b6");
  });

  it("is read only when it cannot be edited", async () => {
    page(sampleDoc, { editable: false });
    expect(screen.queryByRole("button", { name: "Add your own line" })).toBeNull();
    await userEvent.click(screen.getAllByRole("button", { name: /Options for this decision/ })[0]);
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByRole("menuitem", { name: /Delete/ })).toBeNull();
  });

  it("gives a new line one reveal and a margin tick while it is fresh", () => {
    const { container, rerender, a } = page(sampleDoc, { fresh: { b3: Date.now() + 4000 } });
    expect(container.querySelector('[data-block-id="b3"]')).toHaveClass("ln-fresh");
    expect(container.querySelector('[data-block-id="b4"]')).not.toHaveClass("ln-fresh");
    rerender(<NotePage doc={sampleDoc} colors editable actions={a} fresh={{ b3: Date.now() - 1 }} />);
    expect(container.querySelector('[data-block-id="b3"]')).not.toHaveClass("ln-fresh");
  });
});

describe("NotePage scrolling", () => {
  function metrics(el: HTMLElement, m: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: m.scrollHeight });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: m.clientHeight });
    el.scrollTop = m.scrollTop;
  }
  const more: NoteDoc = { version: 1, blocks: [...sampleDoc.blocks, block({ id: "n1", parent: "b1", text: "a" }), block({ id: "n2", parent: "b1", text: "b" }), block({ id: "n3", parent: "b1", text: "c" })] };

  it("never jumps while the reader is scrolled up: counts new lines in a pill instead", async () => {
    const a = actions();
    const { rerender } = render(<NotePage doc={sampleDoc} colors editable follow arrivals={{ seq: 0, added: [] }} actions={a} />);
    const scroller = screen.getByTestId("note-scroll");
    metrics(scroller, { scrollHeight: 1000, clientHeight: 200, scrollTop: 100 });
    fireEvent.scroll(scroller);
    rerender(<NotePage doc={more} colors editable follow arrivals={{ seq: 1, added: ["n1", "n2", "n3"] }} actions={a} />);
    expect(scroller.scrollTop).toBe(100);
    const pill = screen.getByRole("button", { name: "3 new lines" });
    await userEvent.click(pill);
    expect(scroller.scrollTop).toBe(1000);
    expect(screen.queryByRole("button", { name: /new line/ })).toBeNull();
  });

  it("says one new line in the singular", () => {
    const a = actions();
    const { rerender } = render(<NotePage doc={sampleDoc} colors editable follow arrivals={{ seq: 0, added: [] }} actions={a} />);
    const scroller = screen.getByTestId("note-scroll");
    metrics(scroller, { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 });
    fireEvent.scroll(scroller);
    rerender(<NotePage doc={more} colors editable follow arrivals={{ seq: 1, added: ["n1"] }} actions={a} />);
    expect(screen.getByRole("button", { name: "1 new line" })).toBeInTheDocument();
  });

  it("sticks to the newest line when the reader is already at the bottom", () => {
    const a = actions();
    const { rerender } = render(<NotePage doc={sampleDoc} colors editable follow arrivals={{ seq: 0, added: [] }} actions={a} />);
    const scroller = screen.getByTestId("note-scroll");
    metrics(scroller, { scrollHeight: 500, clientHeight: 200, scrollTop: 300 });
    fireEvent.scroll(scroller);
    act(() => {
      rerender(<NotePage doc={more} colors editable follow arrivals={{ seq: 1, added: ["n1"] }} actions={a} />);
    });
    expect(scroller.scrollTop).toBe(500);
    expect(screen.queryByRole("button", { name: /new line/ })).toBeNull();
  });
});

describe("NotePage on long and narrow meetings", () => {
  it("windows 2,400 lines: only the newest topics are in the page, the rest fold", async () => {
    const doc = bigDoc(400, 4);
    const { container } = page(doc, { windowSize: 60 });
    const shown = container.querySelectorAll("[data-block-id]").length;
    expect(shown).toBeLessThan(80);
    expect(screen.getByText("Topic 399")).toBeInTheDocument();
    expect(screen.queryByText("Topic 0")).toBeNull();
    const more = screen.getByRole("button", { name: /earlier lines/ });
    await userEvent.click(more);
    expect(container.querySelectorAll("[data-block-id]").length).toBeGreaterThan(shown);
  });

  it("renders 2,000 lines without trouble", () => {
    const t0 = performance.now();
    const { container } = page(bigDoc(250, 6));
    expect(container.querySelectorAll("[data-block-id]").length).toBeLessThanOrEqual(400);
    expect(performance.now() - t0).toBeLessThan(5000);
  });

  it("has a single accessible tab stop however long the page is", () => {
    const { container } = page(bigDoc(100, 4), { windowSize: 100 });
    const stops = Array.from(container.querySelectorAll<HTMLElement>("[tabindex='0'], button:not([tabindex='-1'])"));
    // One row, its own buttons, the topic time of that row, and the Add and fold buttons.
    expect(stops.filter((s) => s.matches("[data-block-id]"))).toHaveLength(1);
  });
});
