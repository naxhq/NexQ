import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({ load: async () => ({ get: async () => undefined, set: async () => {} }) }));
const shell = vi.hoisted(() => ({ open: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: shell.open }));

import { handleOpenRequest } from "./openRequest";
import { OpenFocusLayer, folderOf } from "./OpenFocusLayer";
import { LibraryPanel } from "./LibraryPanel";
import { useMeetingStore } from "../stores/meetingStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { detailOf, item, mockBackend, seedWorkspaces, ws } from "./testUtils";

const GEN = ws();
const ACME = ws({ id: "acme", name: "Acme", is_default: false });

beforeEach(() => {
  shell.open.mockClear();
  seedWorkspaces([GEN, ACME], "general");
  useWorkspaceStore.setState({ focus: null, librarySheetOpen: false });
  useMeetingStore.setState({ selectedMeetingId: null });
});
afterEach(() => cleanup());

describe("opening what a chat answer or brief cites", () => {
  it("opens a meeting in the launcher", async () => {
    mockBackend();
    await handleOpenRequest({ kind: "transcript", ref_id: "m9", start_ms: 5000 });
    expect(useMeetingStore.getState().selectedMeetingId).toBe("m9");
    await handleOpenRequest({ kind: "meeting", meetingId: "m8" });
    expect(useMeetingStore.getState().selectedMeetingId).toBe("m8");
  });

  it("finds the workspace that holds a document, shows the Library and asks for its row", async () => {
    mockBackend({
      get_workspace: detailOf(GEN, []),
      list_library: [{ kind: "document", ref_id: "d1", name: "plan.pdf", status: "ready", detail: null, tokens: 1, workspace_ids: ["acme"], unfiled: false }],
    });
    await handleOpenRequest({ kind: "document", ref_id: "d1" });
    const s = useWorkspaceStore.getState();
    expect(s.openId).toBe("acme");
    expect(s.librarySheetOpen).toBe(true);
    expect(s.focus).toMatchObject({ kind: "document", refId: "d1", workspaceId: "acme" });
  });

  it("stays in the open workspace when it holds the file", async () => {
    mockBackend({ get_workspace: detailOf(GEN, [item({ ref_id: "d1" })]) });
    await handleOpenRequest({ kind: "document", ref_id: "d1" });
    expect(useWorkspaceStore.getState().openId).toBe("general");
  });

  it("highlights the row in the Library, then lets go", async () => {
    mockBackend({ get_workspace: detailOf(GEN, [item({ ref_id: "d1", name: "plan.pdf" }), item({ ref_id: "d2", name: "other.pdf" })]), list_workspace_chats: [] });
    render(<LibraryPanel workspaceId="general" />);
    await screen.findByText("plan.pdf");
    act(() => useWorkspaceStore.getState().setFocus({ kind: "document", refId: "d1", subRef: null, workspaceId: "general" }));
    const rows = screen.getAllByRole("listitem").filter((r) => r.hasAttribute("data-highlighted") || r.textContent?.includes("pdf"));
    await waitFor(() => expect(rows.some((r) => r.getAttribute("data-highlighted") === "true" && r.textContent?.includes("plan.pdf"))).toBe(true));
    expect(rows.filter((r) => r.getAttribute("data-highlighted") === "true")).toHaveLength(1);
  });

  it("shows a folder file's path and opens its folder", async () => {
    render(<OpenFocusLayer />);
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => useWorkspaceStore.getState().setFocus({ kind: "folder", refId: "f1", subRef: "/notes/clients/acme.md", workspaceId: "general" }));
    const dialog = await screen.findByRole("dialog", { name: "A file in your folder" });
    expect(dialog).toHaveTextContent("/notes/clients/acme.md");
    await userEvent.click(within(dialog).getByRole("button", { name: "Open folder" }));
    await waitFor(() => expect(shell.open).toHaveBeenCalledWith("/notes/clients"));
    expect(folderOf("/a/b/c.md")).toBe("/a/b");
  });

  it("opens the talking points editor for a cited note", async () => {
    mockBackend();
    render(<OpenFocusLayer />);
    act(() => useWorkspaceStore.getState().setFocus({ kind: "talking_point", refId: "tp1", subRef: null, workspaceId: "acme" }));
    expect(await screen.findByRole("dialog", { name: "Talking points" })).toBeInTheDocument();
  });
});
