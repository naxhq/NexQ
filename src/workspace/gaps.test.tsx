import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({ load: async () => ({ get: async () => undefined, set: async () => {} }) }));

import { LibraryPanel } from "./LibraryPanel";
import { DeleteWorkspaceDialog, memoryDeleted } from "./DeleteWorkspaceDialog";
import { CloneDialog } from "./CloneDialog";
import { IndexingNote } from "./IndexingNote";
import { ContextMeter } from "./ContextMeter";
import { indexingWords, skippedByFolder } from "./indexStatus";
import { MemorySection } from "../memory/MemorySection";
import { useMemoryStore } from "../memory/memoryStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useContextStore } from "../stores/contextStore";
import { detailOf, item, meeting, mockBackend, seedWorkspaces, ws } from "./testUtils";

const ACME = ws({ id: "acme", name: "Acme", is_default: false, meeting_count: 3, chat_count: 2 });

beforeEach(() => {
  localStorage.clear();
  seedWorkspaces([ws(), ACME], "acme");
  useContextStore.setState({ resources: [] });
});
afterEach(() => cleanup());

describe("skipped files", () => {
  const status = (skipped: unknown[]) => ({ workspace_id: "acme", state: "idle", done: 0, total: 0, passages: 0, skipped, last_indexed_at: null });

  it("attributes skipped files to the folder that holds them, longest folder first, and keeps the rest apart", () => {
    const r = skippedByFolder(
      [
        { ref_id: "a", name: "C:\\notes" },
        { ref_id: "b", name: "C:\\notes\\clients" },
      ],
      [
        { path: "C:\\notes\\big.pdf", reason: "too large" },
        { path: "c:/NOTES/clients/.env", reason: "secret-looking name" },
        { path: "D:\\elsewhere\\x.md", reason: "hidden" },
        { path: "C:\\notes-old\\y.md", reason: "hidden" },
      ],
    );
    expect(r.byFolder.get("a")?.map((f) => f.reason)).toEqual(["too large"]);
    expect(r.byFolder.get("b")?.map((f) => f.reason)).toEqual(["secret-looking name"]);
    expect(r.other.map((f) => f.path)).toEqual(["D:\\elsewhere\\x.md", "C:\\notes-old\\y.md"]);
  });

  it("a folder with skipped files says how many, and the count opens the list with a reason for each", async () => {
    mockBackend({
      get_workspace: detailOf(ACME, [item({ kind: "folder", ref_id: "f1", name: "C:/notes", label: "Client notes", index_opt_in: true })]),
      get_index_status: status([
        { path: "C:/notes/big.pdf", reason: "too large" },
        { path: "C:/notes/.env", reason: "secret-looking name" },
        { path: "D:/elsewhere/x.md", reason: "hidden" },
      ]),
      list_workspace_chats: [],
    });
    render(<LibraryPanel workspaceId="acme" />);
    const open = await screen.findByRole("button", { name: "2 files skipped" });
    await userEvent.click(open);
    const dialog = await screen.findByRole("dialog", { name: "Skipped in Client notes" });
    const list = within(dialog).getByRole("list", { name: "Skipped files" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(list).toHaveTextContent("C:/notes/big.pdf");
    expect(list).toHaveTextContent("too large");
    expect(list).toHaveTextContent("secret-looking name");
    expect(list).not.toHaveTextContent("elsewhere");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Skipped in/ })).toBeNull());
    // Files outside any folder of the Library are not lost: they get their own line.
    await userEvent.click(screen.getByRole("button", { name: "1 file skipped" }));
    expect(await screen.findByRole("dialog", { name: "Skipped in your folders" })).toHaveTextContent("elsewhere");
  });

  it("says nothing when nothing was skipped", async () => {
    mockBackend({ get_workspace: detailOf(ACME, [item({ kind: "folder", ref_id: "f1", name: "C:/notes", index_opt_in: true })]), get_index_status: status([]), list_workspace_chats: [] });
    render(<LibraryPanel workspaceId="acme" />);
    await screen.findByRole("switch", { name: /Search its text/ });
    expect(screen.queryByRole("button", { name: /skipped/ })).toBeNull();
  });
});

describe("what deleting and cloning take along", () => {
  it("says what happens to the memory in each choice, with the count", async () => {
    mockBackend({
      list_memory: [
        { id: "1", workspace_id: "acme", kind: "fact", title: "a", text: "b", status: "saved", source_meeting: null, source_ms: null, created_at: 0, updated_at: 0 },
        { id: "2", workspace_id: "acme", kind: "fact", title: "c", text: "d", status: "saved", source_meeting: null, source_ms: null, created_at: 0, updated_at: 0 },
        { id: "3", workspace_id: "acme", kind: "fact", title: "e", text: "f", status: "dismissed", source_meeting: null, source_ms: null, created_at: 0, updated_at: 0 },
      ],
    });
    render(<DeleteWorkspaceDialog workspace={ACME} onClose={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByText(/Its memory, 2 items, is deleted with it/)).toBeInTheDocument());
    expect(within(dialog).getByText(/3 meetings and 2 chats go to General, with its talking points/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Everything stays, memory included/)).toBeInTheDocument();
    expect(within(dialog).getByText(/its talking points and its memory \(2 items\)\. This can't be undone/)).toBeInTheDocument();
  });

  it("words the memory line for none, one and unknown", () => {
    expect(memoryDeleted(0)).toBe("It has no saved memory.");
    expect(memoryDeleted(1)).toBe("Its memory, 1 item, is deleted with it.");
    expect(memoryDeleted(null)).toBe("Its saved memory is deleted with it.");
  });

  it("the clone dialog lists what is copied and what is not", () => {
    mockBackend();
    render(<CloneDialog workspace={ACME} onClose={() => {}} />);
    const copied = screen.getByRole("region", { name: "What is copied" });
    for (const word of [/instructions/, /Also use General/, /Keep separate/, /Starts as/, /files, folders and tools/, /Talking points/]) expect(copied).toHaveTextContent(word);
    const not = screen.getByRole("region", { name: "What is not copied" });
    for (const word of [/Meetings, chats and memory/, /search a folder's text/, /default/]) expect(not).toHaveTextContent(word);
  });
});

describe("still indexing", () => {
  it("words the progress", () => {
    expect(indexingWords({ done: 312, total: 540 })).toBe("Still indexing 312 of 540");
    expect(indexingWords(null)).toBeNull();
    expect(indexingWords({ done: 0, total: 0 })).toBeNull();
  });

  it("shows beside the results while the index runs, follows the progress, and goes when it is done", async () => {
    let finished = false;
    mockBackend({
      get_index_status: () => ({ workspace_id: "acme", state: finished ? "idle" : "indexing", done: finished ? 540 : 312, total: 540, passages: 10, skipped: [], last_indexed_at: null }),
    });
    render(<IndexingNote workspaceId="acme" />);
    expect(await screen.findByRole("status")).toHaveTextContent("Still indexing 312 of 540. Results may leave out files that aren't indexed yet.");
    const { emit } = await import("@tauri-apps/api/event");
    await act(async () => {
      await emit("workspace_index_progress", { workspace_id: "acme", done: 400, total: 540, current: null, skipped: 0 });
    });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Still indexing 400 of 540"));
    await act(async () => {
      await emit("workspace_index_progress", { workspace_id: "other", done: 1, total: 9, current: null, skipped: 0 });
    });
    expect(screen.getByRole("status")).toHaveTextContent("400 of 540");
    finished = true;
    await act(async () => {
      await emit("workspace_index_progress", { workspace_id: "acme", done: 540, total: 540, current: null, skipped: 0 });
    });
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("is also in the Library footer and next to the context estimate", async () => {
    mockBackend({
      get_workspace: detailOf(ACME, [item({ kind: "folder", ref_id: "f1", name: "C:/n", index_opt_in: true })]),
      get_index_status: { workspace_id: "acme", state: "indexing", done: 1, total: 9, passages: 0, skipped: [], last_indexed_at: null },
      list_workspace_chats: [],
    });
    render(<LibraryPanel workspaceId="acme" />);
    await waitFor(() => expect(screen.getAllByText(/Still indexing 1 of 9/).length).toBeGreaterThanOrEqual(2));
    cleanup();
    render(<ContextMeter workspaceId="acme" />);
    expect(await screen.findByText(/Still indexing 1 of 9/)).toBeInTheDocument();
  });

  it("is absent when the index is idle", async () => {
    mockBackend({ get_index_status: { workspace_id: "acme", state: "idle", done: 0, total: 0, passages: 5, skipped: [], last_indexed_at: 1 } });
    render(<IndexingNote workspaceId="acme" />);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("a memory source opens its moment", () => {
  it("passes the source time to the meeting", async () => {
    mockBackend({
      list_memory: [{ id: "m1", workspace_id: "acme", kind: "fact", title: "Budget", text: "40k", status: "saved", source_meeting: "hp", source_ms: 125_000, created_at: 0, updated_at: 0 }],
    });
    useMemoryStore.setState({ byWorkspace: {}, loadError: {}, suggest: {} });
    useMeetingStore.setState({ recentMeetings: [meeting({ id: "hp", title: "Hiring panel" })], selectedMeetingId: null, selectedMeetingMoment: null });
    render(<MemorySection workspaceId="acme" />);
    await userEvent.click(await screen.findByRole("button", { name: "Budget, Fact" }));
    await userEvent.click(await screen.findByRole("button", { name: "From Hiring panel · 2:05" }));
    expect(useMeetingStore.getState().selectedMeetingId).toBe("hp");
    expect(useMeetingStore.getState().selectedMeetingMoment?.ms).toBe(125_000);
  });
});
