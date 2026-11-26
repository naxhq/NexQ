import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TalkingPoint } from "../lib/types";

const ipc = vi.hoisted(() => ({
  listTalkingPoints: vi.fn(),
  createTalkingPoint: vi.fn(),
  patchTalkingPoint: vi.fn(),
  deleteTalkingPoint: vi.fn(),
  copyTalkingPoint: vi.fn(),
  reorderTalkingPoints: vi.fn(),
  getPointProgress: vi.fn(),
  savePointProgress: vi.fn(),
  getMeetingPointEdit: vi.fn(),
  saveMeetingPointEdit: vi.fn(),
  getMeetingScope: vi.fn(),
  listWorkspaces: vi.fn(),
}));
vi.mock("../lib/ipc", () => ipc);
vi.mock("../lib/export", () => ({ saveExportFile: vi.fn(async () => true) }));

import { TalkingPointsEditor } from "./TalkingPointsEditor";
import { TalkingPointsDialog } from "./TalkingPointsDialog";
import { __resetTalkingPointsForTests, loadPrefs, useTalkingPointsStore } from "../stores/talkingPointsStore";
import { docBlocks, docFromText, parseDoc } from "./doc/model";
import { dropIndex, moveItem } from "./reorder";
import { sortNotes } from "./noteSort";
import { saveExportFile } from "../lib/export";

function note(id: string, title: string, text: string, sort: number): TalkingPoint {
  return {
    id,
    workspace_id: "w1",
    title,
    doc_json: JSON.stringify(docFromText(text)),
    markdown: text,
    plain_text: text,
    in_context: false,
    sort,
    created_at: 1,
    updated_at: 1,
  };
}
const NOTES = [note("a", "Opening", "Welcome to the show", 0), note("b", "Pricing", "One plan for every team", 1), note("c", "Closing", "Thank you", 2)];

beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
  Range.prototype.getClientRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
  document.elementFromPoint = () => null;
});

// a small fake backend: patches merge into the latest copy of the note
const rows = new Map<string, TalkingPoint>();
let clock = 1000;
const saveCalls = () => ipc.createTalkingPoint.mock.calls.length + ipc.patchTalkingPoint.mock.calls.length;
const lastSaved = () => [...rows.values()].sort((a, b) => b.updated_at - a.updated_at)[0];
function wireBackend() {
  rows.clear();
  clock = 1000;
  ipc.patchTalkingPoint.mockImplementation(async (id: string, patch: Partial<TalkingPoint>) => {
    const base = rows.get(id) ?? NOTES.find((n) => n.id === id)!;
    const next = { ...base, ...patch, updated_at: ++clock };
    rows.set(id, next);
    return next;
  });
  ipc.createTalkingPoint.mockImplementation(async (ws: string, title: string, c: { doc_json: string; markdown: string; plain_text: string; in_context?: boolean }) => {
    const next: TalkingPoint = { id: "created" + ++clock, workspace_id: ws, title, ...c, in_context: c.in_context ?? true, sort: 99, created_at: 1, updated_at: ++clock };
    rows.set(next.id, next);
    return next;
  });
}

beforeEach(() => {
  __resetTalkingPointsForTests();
  for (const f of Object.values(ipc)) f.mockReset();
  ipc.listTalkingPoints.mockResolvedValue(NOTES);
  wireBackend();
  ipc.reorderTalkingPoints.mockResolvedValue(undefined);
  ipc.deleteTalkingPoint.mockResolvedValue(undefined);
  ipc.listWorkspaces.mockResolvedValue([
    { id: "w1", name: "Sales", archived: false },
    { id: "w2", name: "Hiring", archived: false },
    { id: "w3", name: "Old", archived: true },
  ]);
  localStorage.clear();
});
afterEach(cleanup);

/** The editor inside its dialog: the heading, the close button and the save state live there. */
const renderDialog = (onClose: () => void = () => {}) => render(<TalkingPointsDialog workspaceId="w1" open onClose={onClose} />);

describe("reorder helpers", () => {
  it("moves an item", () => {
    expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveItem(["a", "b"], 1, 1)).toEqual(["a", "b"]);
    expect(moveItem(["a", "b"], 5, 0)).toEqual(["a", "b"]);
  });
  it("finds where a drag lands", () => {
    const mids = [10, 30, 50];
    expect(dropIndex(mids, 0, 55)).toBe(2);
    expect(dropIndex(mids, 0, 35)).toBe(1);
    expect(dropIndex(mids, 2, 5)).toBe(0);
    expect(dropIndex(mids, 1, 30)).toBe(1);
  });
});

describe("the notes list", () => {
  it("lists the notes with word counts and opens the first one", async () => {
    render(<TalkingPointsEditor workspaceId="w1" />);
    const list = await screen.findByRole("list", { name: "Notes" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(within(list).getByText("4 words")).toBeInTheDocument();
    expect(await screen.findByRole("textbox", { name: "Text of Opening" })).toBeInTheDocument();
    expect(screen.getByLabelText("Note title")).toHaveValue("Opening");
    expect(within(list).getByRole("button", { name: /^Opening/ })).toHaveAttribute("aria-current", "true");
  });

  it("invites the first note when there are none, and offers Markdown", async () => {
    ipc.listTalkingPoints.mockResolvedValue([]);
    render(<TalkingPointsEditor workspaceId="w1" />);
    expect(await screen.findByText("Write your first talking points")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import Markdown" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Write a note" }));
    expect(await screen.findByLabelText("Note title")).toBeInTheDocument();
    expect(ipc.createTalkingPoint).toHaveBeenCalledTimes(1);
  });

  it("moves a note with the arrow keys on its grip and says where it went", async () => {
    const user = userEvent.setup();
    render(<TalkingPointsEditor workspaceId="w1" />);
    await screen.findByRole("list", { name: "Notes" });
    const grip = screen.getByRole("button", { name: /^Reorder Opening/ });
    grip.focus();
    await user.keyboard("{ArrowDown}");
    expect(ipc.reorderTalkingPoints).toHaveBeenCalledWith("w1", ["b", "a", "c"]);
    expect(screen.getAllByRole("listitem").map((li) => li.getAttribute("data-note-id"))).toEqual(["b", "a", "c"]);
    expect(screen.getByText("Opening moved to position 2 of 3")).toBeInTheDocument();
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(ipc.reorderTalkingPoints).toHaveBeenLastCalledWith("w1", ["a", "b", "c"]);
  });

  it("the Actions menu has Move up and Move down too, so no pointer is needed", async () => {
    const user = userEvent.setup();
    render(<TalkingPointsEditor workspaceId="w1" />);
    await screen.findByRole("list", { name: "Notes" });
    await user.click(screen.getByRole("button", { name: "Actions for Closing" }));
    await user.click(await screen.findByRole("menuitem", { name: "Move up" }));
    expect(ipc.reorderTalkingPoints).toHaveBeenCalledWith("w1", ["a", "c", "b"]);
  });

  it("reorders with pointer events on the grip, and Escape cancels", async () => {
    render(<TalkingPointsEditor workspaceId="w1" />);
    await screen.findByRole("list", { name: "Notes" });
    const rows = screen.getAllByRole("listitem");
    rows.forEach((r, i) => (r.getBoundingClientRect = () => ({ top: i * 40, height: 40, bottom: i * 40 + 40, left: 0, right: 100, width: 100, x: 0, y: i * 40, toJSON: () => ({}) }) as DOMRect));
    const grip = screen.getByRole("button", { name: /^Reorder Opening/ });
    grip.setPointerCapture = () => undefined;
    fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientY: 20 });
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 110 });
    fireEvent.pointerUp(grip, { pointerId: 1, clientY: 110 });
    expect(ipc.reorderTalkingPoints).toHaveBeenCalledWith("w1", ["b", "c", "a"]);

    ipc.reorderTalkingPoints.mockClear();
    const grip2 = screen.getByRole("button", { name: /^Reorder Closing/ });
    grip2.setPointerCapture = () => undefined;
    fireEvent.pointerDown(grip2, { button: 0, pointerId: 2, clientY: 90 });
    fireEvent.pointerMove(grip2, { pointerId: 2, clientY: 0 });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(grip2, { pointerId: 2, clientY: 0 });
    expect(ipc.reorderTalkingPoints).not.toHaveBeenCalled();
  });

  it("duplicates a note", async () => {
    const user = userEvent.setup();
    render(<TalkingPointsEditor workspaceId="w1" />);
    await screen.findByRole("list", { name: "Notes" });
    await user.click(screen.getByRole("button", { name: "Actions for Pricing" }));
    await user.click(await screen.findByRole("menuitem", { name: "Duplicate" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /^Pricing copy/ })).toBeInTheDocument());
    expect(saveCalls()).toBeGreaterThan(0);
    expect(screen.getByLabelText("Note title")).toHaveValue("Pricing copy");
  });

  it("asks before deleting, and says what it removes", async () => {
    const user = userEvent.setup();
    render(<TalkingPointsEditor workspaceId="w1" />);
    await screen.findByRole("list", { name: "Notes" });
    await user.click(screen.getByRole("button", { name: "Actions for Closing" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const dlg = await screen.findByRole("alertdialog");
    expect(dlg).toHaveTextContent('Delete "Closing"?');
    await user.click(within(dlg).getByRole("button", { name: "Cancel" }));
    expect(ipc.deleteTalkingPoint).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Actions for Closing" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete note" }));
    expect(ipc.deleteTalkingPoint).toHaveBeenCalledWith("c");
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Closing/ })).not.toBeInTheDocument());
  });

  it("copies to another workspace, never offering archived ones or itself", async () => {
    const user = userEvent.setup();
    ipc.copyTalkingPoint.mockResolvedValue({ ...NOTES[0], id: "a2", workspace_id: "w2" });
    render(<TalkingPointsEditor workspaceId="w1" />);
    await screen.findByRole("list", { name: "Notes" });
    await user.click(screen.getByRole("button", { name: "Actions for Opening" }));
    await user.click(await screen.findByRole("menuitem", { name: "Copy to another workspace" }));
    const dlg = await screen.findByRole("dialog", { name: "Copy to another workspace" });
    await user.click(within(dlg).getByRole("combobox", { name: "Workspace" }));
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Hiring"]);
    await user.click(options[0]);
    await user.click(within(dlg).getByRole("button", { name: "Copy note" }));
    expect(ipc.copyTalkingPoint).toHaveBeenCalledWith("a", "w2");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Copy to another workspace" })).not.toBeInTheDocument());
  });
});

describe("the editor", () => {
  it("saves after a pause and says so", async () => {
    const user = userEvent.setup();
    renderDialog();
    const box = await screen.findByRole("textbox", { name: "Text of Opening" });
    await user.click(box);
    await user.keyboard(" and more");
    expect(await screen.findByText("Unsaved changes")).toBeInTheDocument();
    await waitFor(() => expect(saveCalls()).toBeGreaterThan(0), { timeout: 3000 });
    expect(lastSaved().plain_text).toContain("and more");
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("shows a failed save, keeps trying and lets you retry now", async () => {
    const user = userEvent.setup();
    ipc.patchTalkingPoint.mockRejectedValueOnce("offline");
    renderDialog();
    await user.click(await screen.findByRole("textbox", { name: "Text of Opening" }));
    await user.keyboard("!");
    const alert = await screen.findByRole("alert", undefined, { timeout: 3000 });
    expect(alert).toHaveTextContent("Not saved: offline");
    await user.click(within(alert).getByRole("button", { name: "Try now" }));
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(ipc.patchTalkingPoint).toHaveBeenCalledTimes(2);
  });

  it("renames the note", async () => {
    const user = userEvent.setup();
    render(<TalkingPointsEditor workspaceId="w1" />);
    const title = await screen.findByLabelText("Note title");
    await user.clear(title);
    await user.type(title, "Kick off plan");
    await user.tab();
    await waitFor(() => expect(saveCalls()).toBeGreaterThan(0));
    expect(lastSaved().title).toBe("Kick off plan");
    expect(screen.getByRole("button", { name: /^Kick off plan/ })).toBeInTheDocument();
  });

  it("'Use as AI context' is a switch that saves", async () => {
    const user = userEvent.setup();
    render(<TalkingPointsEditor workspaceId="w1" />);
    const sw = await screen.findByRole("switch", { name: "Use as AI context" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    await user.click(sw);
    expect(sw).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(saveCalls()).toBeGreaterThan(0));
    expect(lastSaved().in_context).toBe(true);
    expect(within(screen.getByRole("list", { name: "Notes" })).getByText("AI context")).toBeInTheDocument();
  });

  it("shows words and speaking time, and the formatting bar with shortcuts on focus", async () => {
    const user = userEvent.setup();
    render(<TalkingPointsEditor workspaceId="w1" />);
    const box = await screen.findByRole("textbox", { name: "Text of Opening" });
    expect(await screen.findByText(/4 words, about \d+ s to say/)).toBeInTheDocument();
    await user.click(box);
    const bar = await screen.findByRole("toolbar", { name: "Text formatting" });
    for (const name of ["Bold", "Italic", "Underline", "Heading 1", "Heading 2", "Heading 3", "Bullet list", "Numbered list", "Colour", "Size", "Undo", "Redo"]) {
      expect(within(bar).getByRole("button", { name })).toBeInTheDocument();
    }
    await user.hover(within(bar).getByRole("button", { name: "Bold" }));
    expect(await screen.findByText("Ctrl B")).toBeInTheDocument();
  });

  it("bold and a named colour end up in the document as marks and names", async () => {
    const user = userEvent.setup();
    render(<TalkingPointsEditor workspaceId="w1" />);
    const box = await screen.findByRole("textbox", { name: "Text of Opening" });
    await user.click(box);
    await user.keyboard("{Control>}a{/Control}");
    const bar = await screen.findByRole("toolbar", { name: "Text formatting" });
    await user.click(within(bar).getByRole("button", { name: "Bold" }));
    await user.click(within(bar).getByRole("button", { name: "Colour" }));
    await user.click(await screen.findByRole("button", { name: "Red" }));
    await waitFor(() => expect(saveCalls()).toBeGreaterThan(0), { timeout: 3000 });
    const saved = lastSaved() as TalkingPoint;
    expect(saved.doc_json).toContain('"bold"');
    expect(saved.doc_json).toContain('"name":"red"');
    expect(saved.doc_json).not.toMatch(/#[0-9a-f]{3,6}|rgb|hsl/i);
    expect(saved.markdown).toContain("**");
    expect(docBlocks(parseDoc(saved.doc_json))[0].id).toBeTruthy();
  });

  it("exports Markdown through the save dialog", async () => {
    const user = userEvent.setup();
    render(<TalkingPointsEditor workspaceId="w1" />);
    await screen.findByLabelText("Note title");
    await user.click(screen.getByRole("button", { name: "More for this note" }));
    await user.click(await screen.findByRole("menuitem", { name: "Export as Markdown" }));
    expect(saveExportFile).toHaveBeenCalledWith(expect.objectContaining({ defaultName: "Opening", extension: "md", content: expect.stringContaining("Welcome to the show") }));
  });
});

describe("Markdown import", () => {
  const open = async () => {
    const user = userEvent.setup();
    render(<TalkingPointsEditor workspaceId="w1" />);
    await screen.findByLabelText("Note title");
    await user.click(screen.getByRole("button", { name: "Import Markdown" }));
    return { user, dlg: await screen.findByRole("dialog", { name: "Import Markdown" }) };
  };

  it("imports pasted Markdown as a new note, titled from its first heading", async () => {
    const { user, dlg } = await open();
    const area = within(dlg).getByLabelText("Markdown to import");
    await user.click(area);
    await user.paste("# Kick off\n\n- **Goals** for the quarter\n- Risks");
    expect(within(dlg).getByText("7 words will be imported.")).toBeInTheDocument();
    await user.click(within(dlg).getByRole("button", { name: "Import as a new note" }));
    await waitFor(() => expect(saveCalls()).toBeGreaterThan(0));
    const saved = lastSaved() as TalkingPoint;
    expect(saved.title).toBe("Kick off");
    expect(saved.plain_text).toContain("Goals for the quarter");
    expect(saved.doc_json).toContain('"bulletList"');
    expect(saved.doc_json).toContain('"bold"');
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Import Markdown" })).not.toBeInTheDocument());
  });

  it("imports a chosen file", async () => {
    const { dlg } = await open();
    const input = within(dlg).getByLabelText("Markdown file") as HTMLInputElement;
    const file = new File(["# From a file\n\nHello"], "plan.md", { type: "text/markdown" });
    Object.defineProperty(file, "text", { value: async () => "# From a file\n\nHello" });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    expect(await within(dlg).findByText("plan")).toBeInTheDocument();
    expect((within(dlg).getByLabelText("Markdown to import") as HTMLTextAreaElement).value).toContain("From a file");
  });

  it("scripts, handlers, images and links in the Markdown never reach the saved note", async () => {
    const { user, dlg } = await open();
    await user.click(within(dlg).getByLabelText("Markdown to import"));
    await user.paste('Hi <script>alert(1)</script>there\n\n<img src=x onerror=alert(2)>\n\n[click](javascript:alert(3)) ![x](https://evil.test/p.png)');
    await user.click(within(dlg).getByRole("button", { name: "Import as a new note" }));
    await waitFor(() => expect(saveCalls()).toBeGreaterThan(0));
    const saved = lastSaved() as TalkingPoint;
    const all = saved.doc_json + saved.markdown + saved.plain_text;
    expect(all).not.toMatch(/alert|onerror|javascript|evil|<script|<img/);
    expect(saved.plain_text).toContain("Hi there");
    expect(saved.plain_text).toContain("click");
  });

  it("refuses an empty import", async () => {
    const { dlg } = await open();
    expect(within(dlg).getByRole("button", { name: "Import as a new note" })).toBeDisabled();
  });
});

describe("Persian and pasted text", () => {
  const ZWNJ = "‌";

  it("typing after a half space with an autosave in the middle of the word keeps every character and the caret", async () => {
    const user = userEvent.setup();
    renderDialog();
    const box = await screen.findByRole("textbox", { name: "Text of Opening" });
    await user.click(box);
    await user.keyboard(` می${ZWNJ}`);
    await waitFor(() => expect(saveCalls()).toBeGreaterThan(0), { timeout: 3000 }); // the autosave fires mid-word
    expect(lastSaved().plain_text).toContain(`می${ZWNJ}`);
    // the backend tells every window about the save: it must not reload the editor
    ipc.listTalkingPoints.mockImplementation(async () => [{ ...NOTES[0], ...rows.get("a")! }, NOTES[1], NOTES[2]].filter((n) => n.workspace_id === "w1"));
    await act(async () => {
      await useTalkingPointsStore.getState().syncFromBackend("w1");
    });
    expect(useTalkingPointsStore.getState().docRev.a ?? 0).toBe(0);
    await user.keyboard("خواهم");
    expect(box.textContent).toContain(`می${ZWNJ}خواهم`);
    await waitFor(() => expect(lastSaved().plain_text).toContain(`می${ZWNJ}خواهم`), { timeout: 3000 });
    expect(screen.queryByText(/Changed in another window/)).not.toBeInTheDocument();
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("pasted web text loses hidden characters and keeps joiners", async () => {
    // jsdom has no clipboard classes; ProseMirror builds a paste event from them
    const g = globalThis as unknown as Record<string, unknown>;
    g.DataTransfer ??= class {
      private d = new Map<string, string>();
      get types() { return [...this.d.keys()]; }
      setData(t: string, v: string) { this.d.set(t, v); }
      getData(t: string) { return this.d.get(t) ?? ""; }
    };
    g.ClipboardEvent ??= class extends Event {
      clipboardData: unknown;
      constructor(type: string, init?: { clipboardData?: unknown }) { super(type, { bubbles: true, cancelable: true }); this.clipboardData = init?.clipboardData; }
    };
    const user = userEvent.setup();
    render(<TalkingPointsEditor workspaceId="w1" />);
    const box = await screen.findByRole("textbox", { name: "Text of Opening" });
    await user.click(box);
    const html = `<p>a​b‮c﻿d&#8203;e&#x200B;f&ZeroWidthSpace;g می${ZWNJ}خواهم</p>`;
    const view = (box as unknown as { editor?: { view: { pasteHTML: (h: string) => void } }; pmViewDesc?: { view?: { pasteHTML: (h: string) => void } } }).editor?.view ?? (box as unknown as { pmViewDesc?: { view?: { pasteHTML: (h: string) => void } } }).pmViewDesc?.view;
    expect(view).toBeDefined();
    act(() => view!.pasteHTML(html));
    await waitFor(() => expect(box.textContent).toContain("abcdefg"));
    expect(box.textContent).toContain(`می${ZWNJ}خواهم`);
    expect(box.textContent).not.toMatch(/[​‮﻿]/);
  });
});

describe("the dialog", () => {
  it("has one heading, named Talking points, with the workspace beside it", async () => {
    renderDialog();
    const dlg = await screen.findByRole("dialog", { name: "Talking points" });
    expect(within(dlg).getAllByRole("heading", { name: "Talking points" })).toHaveLength(1);
    expect(within(dlg).getByLabelText("Note title")).toBeInTheDocument();
    // the list has no heading of its own
    expect(within(within(dlg).getByRole("complementary", { name: "All notes" })).queryByRole("heading")).not.toBeInTheDocument();
  });

  it("closes with the Close button", async () => {
    const onClose = vi.fn();
    renderDialog(onClose);
    await screen.findByRole("list", { name: "Notes" });
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes with Escape, from the list and from inside the text", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderDialog(onClose);
    const box = await screen.findByRole("textbox", { name: "Text of Opening" });
    await user.click(box);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    screen.getByRole("button", { name: /^Pricing/ }).focus();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("moves focus in, keeps Tab inside and gives focus back to what opened it", async () => {
    const user = userEvent.setup();
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open notes</button>
          <TalkingPointsDialog workspaceId="w1" open={open} onClose={() => setOpen(false)} />
        </>
      );
    }
    render(<Host />);
    const opener = screen.getByRole("button", { name: "Open notes" });
    await user.click(opener);
    const dlg = await screen.findByRole("dialog", { name: "Talking points" });
    await waitFor(() => expect(dlg).toHaveFocus());
    await screen.findByRole("textbox", { name: "Text of Opening" });
    for (let i = 0; i < 40; i++) {
      await user.tab();
      expect(dlg.contains(document.activeElement)).toBe(true);
    }
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Talking points" })).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  it("a title typed just before closing is not lost", async () => {
    const user = userEvent.setup();
    const { unmount } = renderDialog();
    const title = await screen.findByLabelText("Note title");
    await user.clear(title);
    await user.type(title, "Last minute");
    unmount();
    await waitFor(() => expect(saveCalls()).toBeGreaterThan(0));
    expect(lastSaved().title).toBe("Last minute");
  });

  it("shows the save state in the header, not in the note", async () => {
    const user = userEvent.setup();
    renderDialog();
    const dlg = await screen.findByRole("dialog", { name: "Talking points" });
    const header = dlg.querySelector("header") as HTMLElement;
    expect(await within(header).findByText("Saved")).toBeInTheDocument();
    await user.click(await screen.findByRole("textbox", { name: "Text of Opening" }));
    await user.keyboard("!");
    expect(await within(header).findByText("Unsaved changes")).toBeInTheDocument();
    expect(await within(header).findByText("Saved", undefined, { timeout: 3000 })).toBeInTheDocument();
  });
});

describe("the formatting bar", () => {
  it("is part of the layout: there before the text has focus, in the pinned dock, never placed at the caret", async () => {
    const user = userEvent.setup();
    render(<TalkingPointsEditor workspaceId="w1" />);
    const bar = await screen.findByRole("toolbar", { name: "Text formatting" });
    const dock = bar.closest("[data-tp-toolbar-dock]") as HTMLElement;
    expect(dock).not.toBeNull();
    // the scrolling text is not the bar's parent: the bar cannot scroll away or follow the caret
    expect(dock.closest("[data-tp-scroll]")).toBeNull();
    expect(document.querySelector("[data-tp-scroll]")?.contains(bar)).toBe(false);
    const placed = (el: HTMLElement) => [el.style.position, el.style.top, el.style.left, el.style.transform].join("|");
    expect(placed(bar)).toBe("|||");
    expect(bar.className).not.toMatch(/\babsolute\b|\bfixed\b/);
    const box = screen.getByRole("textbox", { name: "Text of Opening" });
    await user.click(box);
    await user.keyboard(" and then some more words after a while");
    expect(placed(bar)).toBe("|||");
    expect(bar.closest("[data-tp-toolbar-dock]")).toBe(dock);
    expect(screen.getAllByRole("toolbar")).toHaveLength(1);
  });

  it("keeps working: the buttons act on the selection", async () => {
    const user = userEvent.setup();
    render(<TalkingPointsEditor workspaceId="w1" />);
    const bar = await screen.findByRole("toolbar", { name: "Text formatting" });
    await user.click(screen.getByRole("textbox", { name: "Text of Opening" }));
    await user.keyboard("{Control>}a{/Control}");
    await user.click(within(bar).getByRole("button", { name: "Italic" }));
    expect(within(bar).getByRole("button", { name: "Italic" })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("the note's layout", () => {
  it("the formatting bar belongs to the body: it sits inside the body box, after the title", async () => {
    render(<TalkingPointsEditor workspaceId="w1" />);
    const bar = await screen.findByRole("toolbar", { name: "Text formatting" });
    const title = screen.getByLabelText("Note title");
    const body = bar.closest("[data-tp-body]") as HTMLElement;
    expect(body).not.toBeNull();
    expect(body.contains(screen.getByRole("textbox", { name: "Text of Opening" }))).toBe(true);
    expect(body.contains(title)).toBe(false);
    expect(title.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // the bar is the first thing in the body box: its top edge
    expect(body.firstElementChild?.contains(bar)).toBe(true);
  });

  it("'Use as AI context' is out of the writing flow: not between the title and the body", async () => {
    render(<TalkingPointsEditor workspaceId="w1" />);
    const sw = await screen.findByRole("switch", { name: "Use as AI context" });
    const title = screen.getByLabelText("Note title");
    const body = document.querySelector("[data-tp-body]") as HTMLElement;
    expect(body.contains(sw)).toBe(false);
    // same row as the title and the note's menu, never after the title and before the body
    const row = title.parentElement as HTMLElement;
    expect(row.contains(sw)).toBe(true);
    expect(row.contains(screen.getByRole("button", { name: "More for this note" }))).toBe(true);
    expect(row.contains(body)).toBe(false);
    expect(title.nextElementSibling?.contains(sw)).toBe(true);
    expect(body.previousElementSibling).toBe(row);
  });
});

describe("sorting the notes", () => {
  const dated = [
    { ...note("a", "Banana", "x", 0), created_at: 200, updated_at: 900 },
    { ...note("b", "apple", "y", 1), created_at: 100, updated_at: 500 },
    { ...note("c", "Cherry", "z", 2), created_at: 300, updated_at: 700 },
  ];
  const order = () => screen.getAllByRole("listitem").map((li) => li.getAttribute("data-note-id"));
  const choose = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
    await user.click(screen.getByRole("button", { name: /^Sort notes/ }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name }));
  };

  it("orders by every key, with ties keeping the manual order", () => {
    const ids = (k: Parameters<typeof sortNotes>[1]) => sortNotes(dated, k).map((n) => n.id);
    expect(ids("manual")).toEqual(["a", "b", "c"]);
    expect(ids("newest")).toEqual(["c", "a", "b"]);
    expect(ids("oldest")).toEqual(["b", "a", "c"]);
    expect(ids("edited")).toEqual(["a", "c", "b"]);
    expect(ids("az")).toEqual(["b", "a", "c"]);
    expect(sortNotes(NOTES, "newest").map((n) => n.id)).toEqual(["a", "b", "c"]);
  });

  it("offers manual order, newest, oldest, recently edited and A to Z, and applies the choice", async () => {
    const user = userEvent.setup();
    ipc.listTalkingPoints.mockResolvedValue(dated);
    render(<TalkingPointsEditor workspaceId="w1" />);
    await screen.findByRole("list", { name: "Notes" });
    await user.click(screen.getByRole("button", { name: "Sort notes: Manual order" }));
    const items = (await screen.findAllByRole("menuitemcheckbox")).map((m) => m.textContent);
    expect(items).toEqual(["Manual order (drag)", "Newest first", "Oldest first", "Recently edited", "A to Z"]);
    await user.keyboard("{Escape}");
    await choose(user, "Newest first");
    expect(order()).toEqual(["c", "a", "b"]);
    await choose(user, "A to Z");
    expect(order()).toEqual(["b", "a", "c"]);
    await choose(user, "Recently edited");
    expect(order()).toEqual(["a", "c", "b"]);
  });

  it("remembers the choice for this workspace only", async () => {
    const user = userEvent.setup();
    ipc.listTalkingPoints.mockResolvedValue(dated);
    const first = render(<TalkingPointsEditor workspaceId="w1" />);
    await screen.findByRole("list", { name: "Notes" });
    await choose(user, "Oldest first");
    expect(JSON.parse(localStorage.getItem("nexq-talking-points-v1")!).noteSort).toEqual({ w1: "oldest" });
    expect(loadPrefs().noteSort).toEqual({ w1: "oldest" });
    first.unmount();
    render(<TalkingPointsEditor workspaceId="w1" />);
    await screen.findByRole("list", { name: "Notes" });
    expect(screen.getByRole("button", { name: "Sort notes: Oldest first" })).toBeInTheDocument();
    expect(order()).toEqual(["b", "a", "c"]);
    expect(useTalkingPointsStore.getState().noteSort.w2).toBeUndefined();
  });

  it("drag reorder works only in manual order", async () => {
    const user = userEvent.setup();
    ipc.listTalkingPoints.mockResolvedValue(dated);
    render(<TalkingPointsEditor workspaceId="w1" />);
    const list = await screen.findByRole("list", { name: "Notes" });
    expect(within(list).getAllByRole("button", { name: /^Reorder / })).toHaveLength(3);
    await choose(user, "Newest first");
    expect(screen.queryByRole("button", { name: /^Reorder / })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Actions for Cherry" }));
    expect(screen.queryByRole("menuitem", { name: "Move up" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(ipc.reorderTalkingPoints).not.toHaveBeenCalled();
    await choose(user, "Manual order (drag)");
    expect(within(screen.getByRole("list", { name: "Notes" })).getAllByRole("button", { name: /^Reorder / })).toHaveLength(3);
    expect(order()).toEqual(["a", "b", "c"]);
  });

  it("has no sort control for a single note", async () => {
    ipc.listTalkingPoints.mockResolvedValue([NOTES[0]]);
    render(<TalkingPointsEditor workspaceId="w1" />);
    await screen.findByRole("list", { name: "Notes" });
    expect(screen.queryByRole("button", { name: /^Sort notes/ })).not.toBeInTheDocument();
  });
});

describe("the list", () => {
  const many = Array.from({ length: 8 }, (_, i) => note(`n${i}`, i === 5 ? "Roadmap" : `Note ${i}`, i === 5 ? "Ship the new editor" : `text ${i}`, i));

  it("gets a search field when there are many notes, and reordering waits while it filters", async () => {
    const user = userEvent.setup();
    ipc.listTalkingPoints.mockResolvedValue(many);
    render(<TalkingPointsEditor workspaceId="w1" />);
    const list = await screen.findByRole("list", { name: "Notes" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(8);
    expect(within(list).getAllByRole("button", { name: /^Reorder / })).toHaveLength(8);
    await user.type(screen.getByRole("searchbox", { name: "Search notes" }), "editor");
    expect(within(screen.getByRole("list", { name: "Notes" })).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /^Reorder / })).not.toBeInTheDocument();
    await user.clear(screen.getByRole("searchbox", { name: "Search notes" }));
    await user.type(screen.getByRole("searchbox", { name: "Search notes" }), "zzz");
    expect(screen.getByText(/No note matches/)).toBeInTheDocument();
  });

  it("has no search field for a short list", async () => {
    render(<TalkingPointsEditor workspaceId="w1" />);
    await screen.findByRole("list", { name: "Notes" });
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });

  it("marks the notes the AI draws on, and has a way back to the list for narrow windows", async () => {
    const user = userEvent.setup();
    ipc.listTalkingPoints.mockResolvedValue([{ ...NOTES[0], in_context: true }, NOTES[1]]);
    render(<TalkingPointsEditor workspaceId="w1" initialId="a" />);
    const list = await screen.findByRole("list", { name: "Notes" });
    expect(within(list).getAllByText("AI context")).toHaveLength(1);
    const aside = screen.getByRole("complementary", { name: "All notes" });
    expect(aside.className).toMatch(/(^|\s)hidden(\s|$)/); // a note is open: narrow windows show it, not the list
    await user.click(screen.getByRole("button", { name: "All notes" }));
    expect(aside.className).not.toMatch(/(^|\s)hidden(\s|$)/);
  });

  it("a new note starts in the title, with the placeholder", async () => {
    const user = userEvent.setup();
    render(<TalkingPointsEditor workspaceId="w1" />);
    await screen.findByRole("list", { name: "Notes" });
    await user.click(screen.getByRole("button", { name: "New note" }));
    const title = await screen.findByLabelText("Note title");
    expect(title).toHaveValue("");
    expect(title).toHaveAttribute("placeholder", "Untitled note");
    await waitFor(() => expect(title).toHaveFocus());
  });
});
