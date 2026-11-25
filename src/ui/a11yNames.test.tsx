import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button, ColorSwatches, Combobox, ConfirmDialog, Dialog, EmptyState, IconButton, InlineEdit, Menu, Segmented, Select, SlideOver, Switch, Tooltip } from "./index";
import { Popover } from "./Popover";
import { accessibleName, unnamedControls } from "../test/a11yNames";

afterEach(cleanup);

describe("the checker itself", () => {
  it("flags an empty name, a generated id and a dangling labelledby, and accepts real names", () => {
    const { container } = render(
      <div>
        <button aria-label=":r2q:" />
        <button />
        <div role="dialog" aria-labelledby="nope" />
        <button aria-label="Save" />
        <input aria-label="Name" />
        <input id="x" />
        <label htmlFor="x">Email</label>
        <button hidden aria-hidden="true" />
      </div>,
    );
    const why = unnamedControls(container).map((u) => u.why).sort();
    expect(why).toEqual(["dangling aria-labelledby", "empty", "generated id"]);
    expect(accessibleName(container.querySelector("#x")!)).toBe("Email");
  });
});

/** Mounts every primitive open, so a name that is missing only when it opens is caught too. */
function Everything() {
  const anchor = useRef<HTMLButtonElement | null>(null);
  const [sel, setSel] = useState("a");
  return (
    <div>
      <Button>Plain</Button>
      <IconButton aria-label="Close thing">x</IconButton>
      <Switch checked={false} onChange={() => {}} label="Notify me" />
      <Switch checked onChange={() => {}} aria-label="Quiet switch" />
      <Segmented label="View" value="a" onChange={() => {}} options={[{ value: "a", label: "A" }, { value: "b", label: "B" }]} />
      <ColorSwatches value={null} onChange={() => {}} />
      <InlineEdit value="Title" label="Title" onCommit={() => {}} />
      <Tooltip content="Help">
        <button type="button">Hover me</button>
      </Tooltip>
      <Select label="Pick one" value={sel} onChange={setSel} options={[{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }]} />
      <Combobox label="Find one" value={sel} onChange={setSel} options={[{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }]} />
      <Menu label="Actions" items={[{ id: "1", label: "One", onSelect: () => {} }, { id: "2", label: "Two", checked: true, onSelect: () => {} }]} renderTrigger={(p) => <button {...p}>Actions</button>} />
      <EmptyState title="Nothing yet" body="Add something" action={<Button>Add</Button>} />
      <button ref={anchor} type="button">
        Anchor
      </button>
      <Popover open onClose={() => {}} anchorRef={anchor} label="A popover">
        <button type="button">Inside</button>
      </Popover>
      <Dialog open onClose={() => {}} title="A dialog" description="Why it is here">
        <input aria-label="Field in dialog" />
      </Dialog>
      <SlideOver open onClose={() => {}} title="A sheet">
        <p>Body</p>
      </SlideOver>
      <ConfirmDialog open title="Are you sure?" confirmLabel="Yes" onConfirm={() => {}} onCancel={() => {}} />
    </div>
  );
}

describe("every ui primitive, open", () => {
  it("has no unnamed or id-named dialog, sheet, popover, menu, list or control", async () => {
    render(<Everything />);
    // Open the menu and both selects too.
    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.getAllByRole("dialog").length).toBeGreaterThan(1);
    const bad = unnamedControls(document.body);
    expect(bad, JSON.stringify(bad, null, 1)).toEqual([]);
    // Each dialog is named by its own title, not by an id.
    for (const d of screen.getAllByRole("dialog")) expect(accessibleName(d)).not.toMatch(/^:/);
    expect(screen.getByRole("dialog", { name: "A dialog" })).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "A sheet" })).toBeInTheDocument();
    expect(screen.getByRole("alertdialog", { name: "Are you sure?" })).toBeInTheDocument();
    expect(screen.getByRole("menu", { name: "Actions", hidden: true })).toBeInTheDocument();
  });

  it("the open selects list named options", async () => {
    render(
      <>
        <Select label="Pick one" value="a" onChange={() => {}} options={[{ value: "a", label: "Alpha" }]} />
        <Combobox label="Find one" value="a" onChange={() => {}} options={[{ value: "a", label: "Alpha" }]} />
      </>,
    );
    for (const name of ["Pick one", "Find one"]) {
      await userEvent.click(screen.getByRole("combobox", { name }));
      expect(screen.getByRole("listbox", { name })).toBeInTheDocument();
      expect(unnamedControls(document.body)).toEqual([]);
      await userEvent.keyboard("{Escape}");
    }
    const onChange = vi.fn();
    void onChange;
  });
});
