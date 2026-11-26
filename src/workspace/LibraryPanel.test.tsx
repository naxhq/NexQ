import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({ load: async () => ({ get: async () => undefined, set: async () => {} }) }));

import { LibraryPanel } from "./LibraryPanel";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useContextStore } from "../stores/contextStore";
import { useConfigStore } from "../stores/configStore";
import { detailOf, item, mockBackend, seedWorkspaces, ws } from "./testUtils";

const ACME = ws({ id: "acme", name: "Acme account", item_count: 4 });

const ITEMS = [
  item({ ref_id: "d1", name: "contract.pdf", label: "The contract", pinned: true }),
  item({ ref_id: "d2", name: "gone.pdf", status: "missing" }),
  item({ ref_id: "f1", kind: "folder", name: "C:\\notes", status: "ready", index_opt_in: false }),
  item({ ref_id: "s1", kind: "server", name: "Slack", status: "off" }),
];

function backend(extra: Record<string, unknown> = {}) {
  return mockBackend({
    get_workspace: detailOf(ACME, ITEMS, "Be brief and name the client."),
    list_workspace_chats: [],
    ...extra,
  });
}

beforeEach(() => {
  localStorage.clear();
  seedWorkspaces([ws(), ACME], "acme");
  useContextStore.setState({ resources: [] });
  useConfigStore.setState({ contextStrategy: "full_context" } as never);
});
afterEach(() => cleanup());

describe("the Library panel", () => {
  it("lists documents, folders and tools with the user's label and each state in words", async () => {
    backend();
    render(<LibraryPanel workspaceId="acme" />);
    const list = await screen.findByRole("list", { name: "Library items" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(4);
    // Pinned first, and the label replaces the file name.
    expect(rows[0]).toHaveTextContent("The contract");
    expect(rows[0]).toHaveTextContent("contract.pdf");
    expect(list).toHaveTextContent("Missing");
    expect(list).toHaveTextContent("Needs your OK to search its text");
    expect(list).toHaveTextContent("Off in Settings");
  });

  it("says a document is missing when the context list does, and offers Remove", async () => {
    const b = backend({ get_workspace: detailOf(ACME, [item({ ref_id: "d9", name: "moved.pdf" })]) });
    useContextStore.setState({ resources: [{ id: "d9", status: "missing" } as never] });
    // loadResources would replace the list; keep the seeded one.
    vi.spyOn(useContextStore.getState(), "loadResources").mockResolvedValue();
    render(<LibraryPanel workspaceId="acme" />);
    const remove = await screen.findByRole("button", { name: "Remove moved.pdf from this workspace" });
    await userEvent.click(remove);
    await waitFor(() => expect(b.called("remove_workspace_item")[0]?.args).toMatchObject({ id: "acme", kind: "document", refId: "d9" }));
  });

  it("keeps a folder's text unsearched until the person allows it, with one sentence about where it goes", async () => {
    const b = backend();
    render(<LibraryPanel workspaceId="acme" />);
    const sw = await screen.findByRole("switch", { name: /Search its text/ });
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByText(/sends the passages that match a question/)).toBeNull();
    await userEvent.hover(screen.getByRole("button", { name: /^About searching the text of/ }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(/sends the passages that match a question to the AI provider you use/);
    await userEvent.click(sw);
    await waitFor(() => expect(b.called("update_workspace_item")[0]?.args).toMatchObject({ id: "acme", kind: "folder", refId: "f1", patch: { index_opt_in: true } }));
  });

  it("renames with the user's label, and pins", async () => {
    const b = backend();
    render(<LibraryPanel workspaceId="acme" />);
    await userEvent.click(await screen.findByRole("button", { name: "Pin Slack" }));
    await waitFor(() => expect(b.called("update_workspace_item")[0]?.args).toMatchObject({ refId: "s1", patch: { pinned: true } }));

    await userEvent.click(screen.getByRole("button", { name: "Rename Slack" }));
    const field = screen.getByRole("textbox", { name: "Rename Slack" });
    await userEvent.clear(field);
    await userEvent.type(field, "Team chat{Enter}");
    await waitFor(() => expect(b.called("update_workspace_item").some((c) => (c.args.patch as { label?: string }).label === "Team chat")).toBe(true));
  });

  it("removes from this workspace without touching the library, and removing from the library asks first", async () => {
    const b = backend();
    render(<LibraryPanel workspaceId="acme" />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for Slack" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Remove from this workspace" }));
    await waitFor(() => expect(b.called("remove_workspace_item")[0]?.args).toMatchObject({ id: "acme", kind: "server", refId: "s1" }));
    expect(b.called("remove_context_file")).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Actions for The contract" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Remove from library" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm).toHaveTextContent(/leaves every workspace/);
    await userEvent.click(within(confirm).getByRole("button", { name: "Remove from library" }));
    await waitFor(() => expect(b.called("remove_context_file")).toHaveLength(1));
  });

  it("edits the instructions in place and saves them", async () => {
    const b = backend({ update_workspace: detailOf(ACME, ITEMS, "Short.") });
    render(<LibraryPanel workspaceId="acme" />);
    expect(await screen.findByText("Be brief and name the client.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Edit instructions" }));
    const field = screen.getByRole("textbox", { name: "Instructions for the AI" });
    await userEvent.clear(field);
    await userEvent.type(field, "Short.");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(b.called("update_workspace")[0]?.args).toMatchObject({ id: "acme", patch: { instructions: "Short." } }));
  });

  it("shows the knowledge base actions of the old dashboard when the local index is on", async () => {
    backend();
    useConfigStore.setState({ contextStrategy: "local_rag" } as never);
    useContextStore.setState({ resources: [{ id: "d1", status: "ready" } as never] });
    vi.spyOn(useContextStore.getState(), "loadResources").mockResolvedValue();
    render(<LibraryPanel workspaceId="acme" />);
    expect(await screen.findByRole("button", { name: /Build the knowledge base/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rescan folders" })).toBeInTheDocument();
  });

  it("says what to do in an empty workspace, and what the meter needs", async () => {
    backend({ get_workspace: detailOf(ACME, []) });
    render(<LibraryPanel workspaceId="acme" />);
    expect(await screen.findByText("Nothing here yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add a folder" })).toBeInTheDocument();
    expect(await screen.findByText(/The first question shows how much/)).toBeInTheDocument();
  });

  it("explains when workspaces are unavailable, and keeps working", async () => {
    backend();
    useWorkspaceStore.setState({ unavailable: true });
    render(<LibraryPanel workspaceId="acme" />);
    expect(screen.getByRole("note")).toHaveTextContent(/aren't available right now/);
  });

  it("adds from the library: the ids picked, to this workspace", async () => {
    const b = backend({
      list_library: [
        { kind: "document", ref_id: "x1", name: "other.pdf", status: "ready", detail: null, tokens: 5, workspace_ids: ["general"], unfiled: false },
        { kind: "folder", ref_id: "x2", name: "loose", status: "ready", detail: null, tokens: null, workspace_ids: [], unfiled: true },
      ],
    });
    render(<LibraryPanel workspaceId="acme" />);
    await userEvent.click(await screen.findByRole("button", { name: "Add" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /From the library/ }));
    const dialog = await screen.findByRole("dialog", { name: "Add from library" });
    await userEvent.click(await within(dialog).findByRole("checkbox", { name: /other.pdf/ }));
    expect(within(dialog).getByText(/not in any workspace/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Add 1" }));
    await waitFor(() => expect(b.called("add_workspace_item")[0]?.args).toMatchObject({ id: "acme", kind: "document", refId: "x1" }));
  });

  it("pastes text as a note: the title follows the first line until the person writes their own", async () => {
    const b = backend({ add_workspace_text: "doc-1" });
    render(<LibraryPanel workspaceId="acme" />);
    await userEvent.click(await screen.findByRole("button", { name: "Add" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Paste text as a note" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a note" });
    expect(within(dialog).getByRole("button", { name: "Add note" })).toBeDisabled();
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Text" }), "## Kickoff notes{enter}Agenda follows");
    expect(within(dialog).getByRole("textbox", { name: "Title" })).toHaveValue("Kickoff notes");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add note" }));
    await waitFor(() => expect(b.called("add_workspace_text")[0]?.args).toMatchObject({ id: "acme", title: "Kickoff notes", markdown: "## Kickoff notes\nAgenda follows" }));
  });

  it("keeps a title the person wrote, even when the text changes after", async () => {
    const b = backend({ add_workspace_text: "doc-1" });
    render(<LibraryPanel workspaceId="acme" />);
    await userEvent.click(await screen.findByRole("button", { name: "Add" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Paste text as a note" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a note" });
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Title" }), "Kickoff");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Text" }), "Something else entirely");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add note" }));
    await waitFor(() => expect(b.called("add_workspace_text")[0]?.args).toMatchObject({ title: "Kickoff", markdown: "Something else entirely" }));
  });
});

describe("a note in the Library", () => {
  const NOTE = item({ ref_id: "n1", name: "Kickoff", detail: "note", tokens: 40 });

  it("is tagged Note, not Document, and opens in an edit dialog that saves the change", async () => {
    const b = backend({
      get_workspace: detailOf(ACME, [NOTE, item({ ref_id: "d1", name: "contract.pdf", detail: "pdf" })], ""),
      get_workspace_note: { title: "Kickoff", text: "Old text" },
      update_workspace_note: null,
    });
    render(<LibraryPanel workspaceId="acme" />);
    const list = await screen.findByRole("list", { name: "Library items" });
    const rows = within(list).getAllByRole("listitem");
    const noteRow = rows.find((r) => r.textContent?.includes("Kickoff"))!;
    expect(noteRow).toHaveTextContent("Note");
    expect(noteRow).not.toHaveTextContent("Document");
    expect(rows.find((r) => r.textContent?.includes("contract.pdf"))).toHaveTextContent("Document");

    await userEvent.click(within(noteRow).getByRole("button", { name: "Edit note Kickoff" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit note" });
    const body = within(dialog).getByRole("textbox", { name: "Text" });
    await waitFor(() => expect(body).toHaveValue("Old text"));
    await userEvent.clear(body);
    await userEvent.type(body, "New text");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(b.called("update_workspace_note")[0]?.args).toMatchObject({ refId: "n1", title: "Kickoff", markdown: "New text" }));
  });

  it("opens from the row's menu too, and a document has no such item", async () => {
    backend({
      get_workspace: detailOf(ACME, [NOTE, item({ ref_id: "d1", name: "contract.pdf", detail: "pdf" })], ""),
      get_workspace_note: { title: "Kickoff", text: "Old text" },
    });
    render(<LibraryPanel workspaceId="acme" />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for Kickoff" }));
    expect(screen.getByRole("menuitem", { name: "Edit note" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Actions for contract.pdf" }));
    expect(screen.queryByRole("menuitem", { name: "Edit note" })).toBeNull();
  });

  it("scrolls inside its own box so a long library does not push the other sections down", async () => {
    const many = Array.from({ length: 14 }, (_, n) => item({ ref_id: `x${n}`, name: `file ${n}.pdf` }));
    backend({ get_workspace: detailOf(ACME, many, "") });
    render(<LibraryPanel workspaceId="acme" />);
    const list = await screen.findByRole("list", { name: "Library items" });
    const box = list.parentElement!;
    expect(box.style.maxHeight).toBe("15.5rem");
    expect(box).toHaveClass("overflow-y-auto");
  });

  it("folds a section and remembers it", async () => {
    backend();
    render(<LibraryPanel workspaceId="acme" />);
    const fold = await screen.findByRole("button", { name: /^Instructions/ });
    expect(fold).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(fold);
    expect(fold).toHaveAttribute("aria-expanded", "false");
    cleanup();
    render(<LibraryPanel workspaceId="acme" />);
    expect(await screen.findByRole("button", { name: /^Instructions/ })).toHaveAttribute("aria-expanded", "false");
  });
});

describe("workspace store keeps its own detail fresh", () => {
  it("loads the detail of the workspace the panel shows", async () => {
    const b = backend();
    render(<LibraryPanel workspaceId="acme" />);
    await waitFor(() => expect(useWorkspaceStore.getState().details.acme?.instructions).toBe("Be brief and name the client."));
    expect(b.called("get_workspace")[0].args).toMatchObject({ id: "acme" });
  });
});
