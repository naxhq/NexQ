import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Button,
  ColorSwatches,
  IconButton,
  Combobox,
  ConfirmDialog,
  Dialog,
  EmptyState,
  InlineEdit,
  Kbd,
  Menu,
  Segmented,
  Select,
  SlideOver,
  Switch,
  Tooltip,
} from "./index";

afterEach(cleanup);

function TestMenu({ onPick, items }: { onPick: (id: string) => void; items?: string[] }) {
  const labels = items ?? ["Transcript", "Notes", "Talking points", "Bookmarks"];
  return (
    <Menu
      label="Panels"
      renderTrigger={(props) => <button {...props}>Panels</button>}
      items={labels.map((l) => ({ id: l, label: l, onSelect: () => onPick(l) }))}
    />
  );
}

describe("Menu", () => {
  it("opens with Enter on the trigger, focuses the first item and uses menu roles", async () => {
    const user = userEvent.setup();
    render(<TestMenu onPick={() => {}} />);
    const trigger = screen.getByRole("button", { name: "Panels" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu", { name: "Panels" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Transcript" })).toHaveFocus();
  });

  it("roves with arrows (wrapping), Home and End, and chooses with Enter then returns focus", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<TestMenu onPick={onPick} />);
    const trigger = screen.getByRole("button", { name: "Panels" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "Bookmarks" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(screen.getByRole("menuitem", { name: "Transcript" })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("menuitem", { name: "Bookmarks" })).toHaveFocus();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Notes" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onPick).toHaveBeenCalledWith("Notes");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("jumps by typing the start of a label", async () => {
    const user = userEvent.setup();
    render(<TestMenu onPick={() => {}} />);
    screen.getByRole("button", { name: "Panels" }).focus();
    await user.keyboard("{ArrowDown}");
    await user.keyboard("b");
    expect(screen.getByRole("menuitem", { name: "Bookmarks" })).toHaveFocus();
    await user.keyboard("{Escape}");
    await user.keyboard("{ArrowDown}");
    await new Promise((r) => setTimeout(r, 650));
    await user.keyboard("ta");
    expect(screen.getByRole("menuitem", { name: "Talking points" })).toHaveFocus();
  });

  it("closes on Escape with focus back on the trigger, and on an outside press", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <TestMenu onPick={() => {}} />
        <p>elsewhere</p>
      </div>,
    );
    const trigger = screen.getByRole("button", { name: "Panels" });
    await user.click(trigger);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    await user.click(screen.getByText("elsewhere"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("skips disabled items and shows checked ones as menuitemcheckbox", async () => {
    const user = userEvent.setup();
    render(
      <Menu
        label="View"
        renderTrigger={(p) => <button {...p}>View</button>}
        items={[
          { id: "a", label: "A", disabled: true, onSelect: () => {} },
          { id: "b", label: "B", checked: true, onSelect: () => {} },
        ]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "View" }));
    const b = screen.getByRole("menuitemcheckbox", { name: "B" });
    expect(b).toHaveAttribute("aria-checked", "true");
    expect(b).toHaveFocus();
    expect(screen.getByRole("menuitem", { name: "A" })).toHaveAttribute("aria-disabled", "true");
  });

  it("renders inside the window's own root, not a new place", async () => {
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
    const user = userEvent.setup();
    render(<TestMenu onPick={() => {}} />, { container: root });
    await user.click(screen.getByRole("button", { name: "Panels" }));
    expect(root.contains(screen.getByRole("menu"))).toBe(true);
    cleanup();
    root.remove();
  });
});

const OPTIONS = [
  { value: "a", label: "Acme renewal" },
  { value: "b", label: "Board prep" },
  { value: "c", label: "Course", disabled: true },
  { value: "d", label: "General" },
];

function Controlled({ filterable }: { filterable?: boolean }) {
  const [v, setV] = useState<string | null>("a");
  const Comp = filterable ? Combobox : Select;
  return <Comp label="Workspace" value={v} onChange={setV} options={OPTIONS} />;
}

describe("Select and Combobox", () => {
  it("is a combobox that opens a listbox with the current value selected", async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    const trigger = screen.getByRole("combobox", { name: "Workspace" });
    expect(trigger).toHaveTextContent("Acme renewal");
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const list = screen.getByRole("listbox", { name: "Workspace" });
    expect(list).toHaveFocus();
    expect(within(list).getByRole("option", { name: /Acme renewal/ })).toHaveAttribute("aria-selected", "true");
  });

  it("moves with arrows (skipping disabled), chooses with Enter and returns focus", async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    const trigger = screen.getByRole("combobox");
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    const list = screen.getByRole("listbox");
    await user.keyboard("{ArrowDown}");
    expect(list.getAttribute("aria-activedescendant")).toBe(screen.getByRole("option", { name: /Board prep/ }).id);
    await user.keyboard("{ArrowDown}");
    expect(list.getAttribute("aria-activedescendant")).toBe(screen.getByRole("option", { name: /General/ }).id);
    await user.keyboard("{Enter}");
    expect(trigger).toHaveTextContent("General");
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes on Escape without changing the value", async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    const trigger = screen.getByRole("combobox");
    await user.click(trigger);
    await user.keyboard("{ArrowDown}{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(trigger).toHaveTextContent("Acme renewal");
    expect(trigger).toHaveFocus();
  });

  it("Combobox filters as you type and chooses with Enter", async () => {
    const user = userEvent.setup();
    render(<Controlled filterable />);
    const trigger = screen.getByRole("combobox", { name: "Workspace" });
    await user.click(trigger);
    const filter = screen.getByRole("searchbox", { name: /Filter/ });
    expect(filter).toHaveFocus();
    await user.keyboard("gen");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await user.keyboard("{Enter}");
    expect(trigger).toHaveTextContent("General");
  });

  it("says when nothing matches", async () => {
    const user = userEvent.setup();
    render(<Controlled filterable />);
    await user.click(screen.getByRole("combobox"));
    await user.keyboard("zzz");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("Nothing matches")).toBeInTheDocument();
  });
});

describe("Tooltip", () => {
  it("shows on keyboard focus, describes the control, hides on blur and Escape", async () => {
    const user = userEvent.setup();
    render(
      <Tooltip content="Search deeper">
        <button>Deeper</button>
      </Tooltip>,
    );
    const button = screen.getByRole("button", { name: "Deeper" });
    await user.tab();
    expect(button).toHaveFocus();
    const tip = await screen.findByRole("tooltip");
    expect(tip).toHaveTextContent("Search deeper");
    expect(button.getAttribute("aria-describedby")).toBe(tip.id);
    expect(button).not.toHaveAttribute("title");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shows after a short delay on hover and keeps the child's own handlers", async () => {
    const user = userEvent.setup();
    const onMouseEnter = vi.fn();
    render(
      <Tooltip content="Hi" delay={10}>
        <button onMouseEnter={onMouseEnter}>Go</button>
      </Tooltip>,
    );
    await user.hover(screen.getByRole("button"));
    expect(onMouseEnter).toHaveBeenCalled();
    expect(await screen.findByRole("tooltip")).toBeInTheDocument();
    await user.unhover(screen.getByRole("button"));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

describe("Dialog", () => {
  function Host({ danger = false }: { danger?: boolean }) {
    const [open, setOpen] = useState(false);
    return (
      <div>
        <button onClick={() => setOpen(true)}>Open</button>
        {danger ? (
          <ConfirmDialog
            open={open}
            title="Delete workspace?"
            body="Its meetings move to General."
            confirmLabel="Delete workspace"
            tone="danger"
            onConfirm={() => setOpen(false)}
            onCancel={() => setOpen(false)}
          />
        ) : (
          <Dialog open={open} onClose={() => setOpen(false)} title="New workspace" description="A place for one job.">
            <input aria-label="Name" />
            <button>Second</button>
          </Dialog>
        )}
      </div>
    );
  }

  it("is a labelled modal, focuses its first control, traps Tab, and restores focus on Escape", async () => {
    const user = userEvent.setup();
    render(<Host />);
    const opener = screen.getByRole("button", { name: "Open" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "New workspace" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription("A place for one job.");
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Second" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Second" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("ConfirmDialog is an alertdialog; a danger one starts on Cancel", async () => {
    const user = userEvent.setup();
    render(<Host danger />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByRole("alertdialog", { name: "Delete workspace?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Delete workspace" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("does not close on Escape while it is not dismissible", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Saving" dismissible={false}>
        <button>Wait</button>
      </Dialog>,
    );
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("SlideOver", () => {
  it("is a modal sheet that closes with Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <SlideOver open onClose={onClose} title="Library">
        <button>Add</button>
      </SlideOver>,
    );
    expect(screen.getByRole("dialog", { name: "Library" })).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("button", { name: "Add" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});

describe("Switch", () => {
  it("is a switch with its state and label, toggled by Space and Enter", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Switch checked={false} onChange={onChange} label="Prepare recaps with AI" description="Uses your model" />);
    const sw = screen.getByRole("switch", { name: "Prepare recaps with AI" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(sw).toHaveAccessibleDescription("Uses your model");
    sw.focus();
    await user.keyboard(" ");
    expect(onChange).toHaveBeenLastCalledWith(true);
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

describe("Segmented", () => {
  function Host() {
    const [v, setV] = useState("balanced");
    return (
      <Segmented
        label="Depth"
        value={v}
        onChange={setV}
        options={[
          { value: "lean", label: "Lean" },
          { value: "balanced", label: "Balanced" },
          { value: "deep", label: "Deep" },
        ]}
      />
    );
  }
  it("is a radio group with one tab stop; arrows move and choose, wrapping", async () => {
    const user = userEvent.setup();
    render(<Host />);
    const group = screen.getByRole("radiogroup", { name: "Depth" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.filter((r) => r.tabIndex === 0)).toHaveLength(1);
    expect(screen.getByRole("radio", { name: "Balanced" })).toBeChecked();
    screen.getByRole("radio", { name: "Balanced" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Deep" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Deep" })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Lean" })).toBeChecked();
    await user.keyboard("{End}");
    expect(screen.getByRole("radio", { name: "Deep" })).toBeChecked();
    await user.keyboard("{Home}");
    expect(screen.getByRole("radio", { name: "Lean" })).toBeChecked();
  });
});

describe("InlineEdit", () => {
  it("shows text as a button; Enter on it edits, Enter again saves the trimmed value", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<InlineEdit value="Acme" onCommit={onCommit} label="workspace" />);
    const button = screen.getByRole("button", { name: "Rename workspace" });
    button.focus();
    await user.keyboard("{Enter}");
    const input = screen.getByRole("textbox", { name: "Rename workspace" });
    expect(input).toHaveFocus();
    await user.keyboard("{Control>}a{/Control}Acme Inc  {Enter}");
    expect(onCommit).toHaveBeenCalledWith("Acme Inc");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("Escape puts the old text back without saving", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<InlineEdit value="Acme" onCommit={onCommit} label="workspace" />);
    await user.click(screen.getByRole("button"));
    await user.keyboard("zzz{Escape}");
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Rename workspace" })).toHaveTextContent("Acme");
  });

  it("refuses an empty name with a message the field points to", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<InlineEdit value="Acme" onCommit={onCommit} label="workspace" />);
    await user.click(screen.getByRole("button"));
    await user.keyboard("{Control>}a{/Control}{Backspace}{Enter}");
    expect(onCommit).not.toHaveBeenCalled();
    const input = screen.getByRole("textbox");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("A name is needed");
    expect(input).toHaveAccessibleDescription("A name is needed");
  });

  it("uses validate() and saves on blur", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(
      <div>
        <InlineEdit value="Acme" onCommit={onCommit} label="workspace" validate={(v) => (v === "General" ? "Taken" : null)} />
        <button>other</button>
      </div>,
    );
    await user.click(screen.getByRole("button", { name: "Rename workspace" }));
    await user.keyboard("{Control>}a{/Control}General{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent("Taken");
    await user.keyboard("{Control>}a{/Control}Beta");
    await user.click(screen.getByRole("button", { name: "other" }));
    expect(onCommit).toHaveBeenCalledWith("Beta");
  });
});

describe("ColorSwatches", () => {
  function Host({ onChange }: { onChange?: (v: string | null) => void }) {
    const [v, setV] = useState<string | null>("violet");
    return (
      <ColorSwatches
        value={v}
        onChange={(n) => {
          setV(n);
          onChange?.(n);
        }}
      />
    );
  }
  it("offers none plus eight named hues, none of them blue, green, amber or red", () => {
    render(<Host />);
    const names = screen.getAllByRole("radio").map((r) => r.getAttribute("aria-label"));
    expect(names).toEqual(["No colour", "Violet", "Orchid", "Magenta", "Rose", "Clay", "Teal", "Moss", "Stone"]);
    expect(names.some((n) => /blue|green|amber|red/i.test(n ?? ""))).toBe(false);
  });
  it("marks the chosen one with a check, not only colour, and moves with arrows", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Host onChange={onChange} />);
    expect(screen.getByRole("radio", { name: "Violet" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Violet" }).querySelector("svg")).not.toBeNull();
    screen.getByRole("radio", { name: "Violet" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith("orchid");
    await user.keyboard("{Home}");
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(screen.getByRole("radio", { name: "No colour" })).toBeChecked();
  });
});

describe("EmptyState and Kbd", () => {
  it("shows the title, text and the one action", () => {
    render(<EmptyState title="No meetings yet" body="Start one." action={<button>Start meeting</button>} />);
    expect(screen.getByRole("heading", { name: "No meetings yet" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start meeting" })).toBeInTheDocument();
  });
  it("Kbd is a kbd element", () => {
    render(<Kbd>N</Kbd>);
    expect(screen.getByText("N").tagName).toBe("KBD");
  });
});

describe("Button and IconButton", () => {
  it("is a type=button by default, with one focus treatment and a size-matched radius", () => {
    render(<Button>Save</Button>);
    const b = screen.getByRole("button", { name: "Save" });
    expect(b).toHaveAttribute("type", "button");
    expect(b.className).toContain("ui-focus");
    expect(b.className).toContain("rounded-lg");
    expect(b.className).toContain("ui-r-lg");
  });
  it("sm is h-7 rounded-md and lg is rounded-xl; variants change only colour", () => {
    render(
      <div>
        <Button size="sm">S</Button>
        <Button size="lg" variant="primary">L</Button>
        <Button variant="danger">D</Button>
      </div>,
    );
    expect(screen.getByRole("button", { name: "S" }).className).toMatch(/h-7.*rounded-md|rounded-md.*h-7/);
    expect(screen.getByRole("button", { name: "L" }).className).toContain("rounded-xl");
    expect(screen.getByRole("button", { name: "D" }).className).toContain("bg-destructive");
  });
  it("forwards its ref, clicks and the disabled state", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    let ref: HTMLButtonElement | null = null;
    render(
      <Button ref={(el) => { ref = el; }} onClick={onClick} disabled>
        Go
      </Button>,
    );
    expect(ref).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Go" }));
    expect(onClick).not.toHaveBeenCalled();
  });
  it("IconButton needs a name and is at least 28 px square", () => {
    render(<IconButton aria-label="Add">+</IconButton>);
    const b = screen.getByRole("button", { name: "Add" });
    expect(b.className).toContain("h-7");
    expect(b.className).toContain("w-7");
    expect(b.className).toContain("ui-focus");
  });
});
