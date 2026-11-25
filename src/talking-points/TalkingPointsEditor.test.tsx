import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TalkingPoint } from "../lib/types";

const ipc = vi.hoisted(() => ({
  listTalkingPoints: vi.fn(),
  saveTalkingPoint: vi.fn(),
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
import { __resetTalkingPointsForTests, useTalkingPointsStore } from "../stores/talkingPointsStore";
import { docBlocks, docFromText, parseDoc } from "./doc/model";
import { dropIndex, moveItem } from "./reorder";
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

beforeEach(() => {
  __resetTalkingPointsForTests();
  for (const f of Object.values(ipc)) f.mockReset();
  ipc.listTalkingPoints.mockResolvedValue(NOTES);
  ipc.saveTalkingPoint.mockImplementation(async (p: TalkingPoint) => p);
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
    expect(screen.getAllByRole("button", { name: /Import/ }).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: "Write a note" }));
    expect(await screen.findByLabelText("Note title")).toBeInTheDocument();
    expect(ipc.saveTalkingPoint).toHaveBeenCalledTimes(1);
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
    expect(ipc.saveTalkingPoint).toHaveBeenCalled();
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
    render(<TalkingPointsEditor workspaceId="w1" />);
    const box = await screen.findByRole("textbox", { name: "Text of Opening" });
    await user.click(box);
    await user.keyboard(" and more");
    expect(await screen.findByText("Unsaved changes")).toBeInTheDocument();
    await waitFor(() => expect(ipc.saveTalkingPoint).toHaveBeenCalled(), { timeout: 3000 });
    expect(ipc.saveTalkingPoint.mock.calls[ipc.saveTalkingPoint.mock.calls.length - 1][0].plain_text).toContain("and more");
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("shows a failed save, keeps trying and lets you retry now", async () => {
    const user = userEvent.setup();
    ipc.saveTalkingPoint.mockRejectedValueOnce("offline");
    render(<TalkingPointsEditor workspaceId="w1" />);
    await user.click(await screen.findByRole("textbox", { name: "Text of Opening" }));
    await user.keyboard("!");
    const alert = await screen.findByRole("alert", undefined, { timeout: 3000 });
    expect(alert).toHaveTextContent("Not saved: offline");
    await user.click(within(alert).getByRole("button", { name: "Try now" }));
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(ipc.saveTalkingPoint).toHaveBeenCalledTimes(2);
  });

  it("renames the note", async () => {
    const user = userEvent.setup();
    render(<TalkingPointsEditor workspaceId="w1" />);
    const title = await screen.findByLabelText("Note title");
    await user.clear(title);
    await user.type(title, "Kick off plan");
    await user.tab();
    await waitFor(() => expect(ipc.saveTalkingPoint).toHaveBeenCalled());
    expect(ipc.saveTalkingPoint.mock.calls[ipc.saveTalkingPoint.mock.calls.length - 1][0].title).toBe("Kick off plan");
    expect(screen.getByRole("button", { name: /^Kick off plan/ })).toBeInTheDocument();
  });

  it("'Use as AI context' is a switch that saves", async () => {
    const user = userEvent.setup();
    render(<TalkingPointsEditor workspaceId="w1" />);
    const sw = await screen.findByRole("switch", { name: "Use as AI context" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    await user.click(sw);
    expect(sw).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(ipc.saveTalkingPoint).toHaveBeenCalled());
    expect(ipc.saveTalkingPoint.mock.calls[ipc.saveTalkingPoint.mock.calls.length - 1][0].in_context).toBe(true);
    expect(screen.getByText(/used as AI context/)).toBeInTheDocument();
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
    await waitFor(() => expect(ipc.saveTalkingPoint).toHaveBeenCalled(), { timeout: 3000 });
    const saved = ipc.saveTalkingPoint.mock.calls[ipc.saveTalkingPoint.mock.calls.length - 1][0] as TalkingPoint;
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
    await user.click(screen.getByRole("button", { name: "Import" }));
    return { user, dlg: await screen.findByRole("dialog", { name: "Import Markdown" }) };
  };

  it("imports pasted Markdown as a new note, titled from its first heading", async () => {
    const { user, dlg } = await open();
    const area = within(dlg).getByLabelText("Markdown to import");
    await user.click(area);
    await user.paste("# Kick off\n\n- **Goals** for the quarter\n- Risks");
    expect(within(dlg).getByText("7 words will be imported.")).toBeInTheDocument();
    await user.click(within(dlg).getByRole("button", { name: "Import as a new note" }));
    await waitFor(() => expect(ipc.saveTalkingPoint).toHaveBeenCalled());
    const saved = ipc.saveTalkingPoint.mock.calls[ipc.saveTalkingPoint.mock.calls.length - 1][0] as TalkingPoint;
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
    await waitFor(() => expect(ipc.saveTalkingPoint).toHaveBeenCalled());
    const saved = ipc.saveTalkingPoint.mock.calls[ipc.saveTalkingPoint.mock.calls.length - 1][0] as TalkingPoint;
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
