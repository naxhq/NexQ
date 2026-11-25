import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({ load: async () => ({ get: async () => undefined, set: async () => {} }) }));

vi.mock("./chat/ChatPane", () => ({
  // The chat has its own tests; here it only has to sit in the middle and report its openers.
  ChatPane: (p: { workspaceId: string; onOpenMeeting?: (id: string) => void }) => (
    <div data-testid="chat" data-ws={p.workspaceId}>
      <button type="button" onClick={() => p.onOpenMeeting?.("cited-1")}>
        Open cited meeting
      </button>
    </div>
  ),
}));

import { WorkspaceHome } from "./WorkspaceHome";
import { WorkspaceActionsProvider } from "./WorkspaceActions";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useMeetingStore } from "../stores/meetingStore";
import { detailOf, meeting, mockBackend, seedWorkspaces, ws } from "./testUtils";

const GENERAL = ws({ id: "general", name: "General", is_default: true, meeting_count: 2, item_count: 1 });
const ACME = ws({ id: "acme", name: "Acme account", color: "teal", sort: 1, meeting_count: 3, chat_count: 2, item_count: 4, description: "The Acme rollout" });
const OLD = ws({ id: "old", name: "Old job", sort: 2, archived: true });

function setWidth(w: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: w });
}

function backend(extra: Record<string, unknown> = {}) {
  return mockBackend({
    list_workspaces: [GENERAL, ACME, OLD],
    list_workspace_meetings: (a: Record<string, unknown>) => ({
      meetings: [meeting({ id: `${a.id}-1`, title: `${a.id} planning`, workspace_id: String(a.id) })],
      total: 1,
    }),
    get_workspace: (a: Record<string, unknown>) =>
      detailOf(a.id === "acme" ? ACME : GENERAL, [], a.id === "acme" ? "Be brief." : ""),
    search_meetings: JSON.stringify([meeting({ id: "far", title: "Elsewhere meeting", workspace_id: "general" })]),
    ...extra,
  });
}

function mount(onStart = vi.fn(), onOpenMeeting = vi.fn()) {
  render(
    <WorkspaceActionsProvider>
      <WorkspaceHome starting={false} onStart={onStart} onOpenMeeting={onOpenMeeting} />
    </WorkspaceActionsProvider>,
  );
  return { onStart, onOpenMeeting };
}

beforeEach(() => {
  localStorage.clear();
  setWidth(1280);
  seedWorkspaces([GENERAL, ACME, OLD], "acme");
  useMeetingStore.setState({ activeMeeting: null, recentMeetings: [] });
});
afterEach(() => cleanup());

describe("the home, wide", () => {
  it("shows the rail, the open workspace and its meetings, and the Library", async () => {
    backend();
    mount();
    expect(screen.getByRole("navigation", { name: "Workspaces" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Acme account" })).toBeInTheDocument();
    expect(screen.getByText("The Acme rollout")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Meeting: acme planning/ })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Library" })).toBeInTheDocument();
    expect(screen.getAllByRole("separator")).toHaveLength(2);
    // The archived one stays behind a toggle.
    expect(screen.queryByText("Old job")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Show archived \(1\)/ }));
    expect(screen.getByText("Old job")).toBeInTheDocument();
  });

  it("puts Start meeting first and calls it", async () => {
    backend();
    const { onStart } = mount();
    await userEvent.click(screen.getByRole("button", { name: "Start meeting" }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("opens another workspace from the rail and lists its meetings", async () => {
    const b = backend();
    mount();
    await userEvent.click(screen.getByRole("button", { name: "General" }));
    expect(useWorkspaceStore.getState().openId).toBe("general");
    expect(await screen.findByRole("button", { name: /Meeting: general planning/ })).toBeInTheDocument();
    expect(b.called("list_workspace_meetings").some((c) => c.args.id === "general")).toBe(true);
    expect(localStorage.getItem("nexq_open_workspace")).toBe("general");
  });

  it("searches here by default and everywhere on request", async () => {
    const b = backend();
    mount();
    await userEvent.type(screen.getByRole("searchbox", { name: "Search meetings" }), "plan");
    await waitFor(() => expect(b.called("list_workspace_meetings").some((c) => c.args.query === "plan" && c.args.id === "acme")).toBe(true));
    await userEvent.click(screen.getByRole("radio", { name: "Everywhere" }));
    expect(await screen.findByText("Elsewhere meeting")).toBeInTheDocument();
    expect(b.called("search_meetings").length).toBeGreaterThan(0);
  });

  it("filters, deletes one meeting after a confirm, and deletes all after a confirm", async () => {
    const b = backend();
    mount();
    await screen.findByRole("button", { name: /Meeting: acme planning/ });
    await userEvent.click(screen.getByRole("button", { name: "Starred" }));
    expect(screen.getByText("No meetings match this filter.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "All" }));

    await userEvent.click(screen.getByRole("button", { name: "Delete meeting" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(b.called("delete_meeting")).toHaveLength(1));

    await userEvent.click(screen.getByRole("button", { name: "Delete all meetings" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/permanently deletes 3 meetings/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: /Delete 3 meetings/ }));
    await waitFor(() => expect(b.called("delete_meeting").length).toBeGreaterThan(1));
  });

  it("opens the switcher with Ctrl+Shift+O, filters by typing, and opens on Enter", async () => {
    backend();
    mount();
    fireEvent.keyDown(window, { key: "O", ctrlKey: true, shiftKey: true });
    const input = await screen.findByRole("combobox", { name: "Find a workspace" });
    await userEvent.type(input, "gen");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await userEvent.keyboard("{Enter}");
    expect(useWorkspaceStore.getState().openId).toBe("general");
    expect(screen.queryByRole("combobox", { name: "Find a workspace" })).toBeNull();
  });

  it("goes to All workspaces from the breadcrumb and back by choosing one", async () => {
    backend();
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Workspaces" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Workspaces" })).toBeInTheDocument();
    const index = screen.getByRole("list", { name: "All workspaces" });
    expect(within(index).getAllByRole("listitem")).toHaveLength(2);
    await userEvent.click(within(index).getByRole("button", { name: "General" }));
    expect(useWorkspaceStore.getState().view).toBe("home");
    expect(useWorkspaceStore.getState().openId).toBe("general");
  });

  it("resizes the rail with the keyboard and remembers it", async () => {
    backend();
    mount();
    const handle = screen.getByRole("separator", { name: "Resize the workspace list" });
    const before = Number(handle.getAttribute("aria-valuenow"));
    handle.focus();
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(Number(handle.getAttribute("aria-valuenow"))).toBe(before + 16);
    expect(localStorage.getItem("nexq_rail_width")).toBe(String(before + 16));
    fireEvent.keyDown(handle, { key: "Home" });
    expect(Number(handle.getAttribute("aria-valuenow"))).toBe(264);
  });

  it("shows the live meeting in the list and returns to it", async () => {
    backend({ list_workspace_meetings: { meetings: [meeting({ id: "live", title: "On air" })], total: 1 } });
    useMeetingStore.setState({ activeMeeting: { id: "live", title: "On air" } as never });
    const { onOpenMeeting } = mount();
    const row = await screen.findByRole("button", { name: /Meeting: On air/ });
    expect(within(row).getByText("Live")).toBeInTheDocument();
    await userEvent.click(row);
    expect(onOpenMeeting).toHaveBeenCalledWith("live");
  });
});

describe("the chat in the middle", () => {
  it("is the open workspace's chat, and a cited meeting opens the meeting", async () => {
    backend();
    const { onOpenMeeting } = mount();
    expect(screen.getByTestId("chat")).toHaveAttribute("data-ws", "acme");
    await userEvent.click(screen.getByRole("button", { name: "Open cited meeting" }));
    expect(onOpenMeeting).toHaveBeenCalledWith("cited-1");
  });
});

describe("the home at other widths", () => {
  it("below 1100 the Library is a sheet opened from a button", async () => {
    setWidth(900);
    backend();
    mount();
    expect(screen.queryByRole("complementary", { name: "Library" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Library" }));
    const sheet = await screen.findByRole("dialog", { name: /Library of Acme account/ });
    expect(sheet).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Library of/ })).toBeNull());
  });

  it("below 820 the rail is marks only, with the meetings in a sheet", async () => {
    setWidth(700);
    backend();
    mount();
    const rail = screen.getByRole("navigation", { name: "Workspaces" });
    expect(within(rail).queryByText("Acme account")).toBeNull();
    expect(within(rail).getByRole("button", { name: "Acme account" })).toHaveAttribute("aria-current", "page");
    expect(within(rail).getByRole("button", { name: "General" })).toBeInTheDocument();
    expect(screen.queryByRole("separator", { name: "Resize the workspace list" })).toBeNull();
    await userEvent.click(within(rail).getByRole("button", { name: "Meetings in Acme account" }));
    expect(await screen.findByRole("dialog", { name: "Meetings in Acme account" })).toBeInTheDocument();
  });

  it("follows a resize of the window", async () => {
    backend();
    mount();
    expect(screen.getByRole("complementary", { name: "Library" })).toBeInTheDocument();
    setWidth(1000);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Library" })).toBeNull());
  });
});

describe("workspaces: create, delete, notes", () => {
  it("creates a workspace that starts without General", async () => {
    const b = backend({ create_workspace: detailOf(ws({ id: "new", name: "Biology 201" })) });
    mount();
    await userEvent.click(screen.getByRole("button", { name: "New workspace" }));
    const dialog = await screen.findByRole("dialog", { name: "New workspace" });
    expect(within(dialog).getByRole("switch", { name: /Also use General/ })).toHaveAttribute("aria-checked", "false");
    expect(within(dialog).getByText(/General has 1 file or tool/)).toBeInTheDocument();
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Name" }), "Biology 201");
    await userEvent.click(within(dialog).getByRole("radio", { name: "Teal" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Create workspace" }));
    await waitFor(() => expect(b.called("create_workspace")).toHaveLength(1));
    const input = b.called("create_workspace")[0].args.input as Record<string, unknown>;
    expect(input).toMatchObject({ name: "Biology 201", color: "teal", include_general: false, keep_separate: false, default_scenario: null });
  });

  it("refuses a duplicate name and an empty one", async () => {
    backend();
    mount();
    await userEvent.click(screen.getByRole("button", { name: "New workspace" }));
    const dialog = await screen.findByRole("dialog", { name: "New workspace" });
    expect(within(dialog).getByRole("button", { name: "Create workspace" })).toBeDisabled();
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Name" }), "acme account");
    expect(within(dialog).getByRole("alert")).toHaveTextContent(/already has this name/);
    expect(within(dialog).getByRole("button", { name: "Create workspace" })).toBeDisabled();
  });

  it("Keep separate turns Also use General off and explains itself", async () => {
    backend();
    mount();
    await userEvent.click(screen.getByRole("button", { name: "New workspace" }));
    const dialog = await screen.findByRole("dialog", { name: "New workspace" });
    await userEvent.click(within(dialog).getByRole("switch", { name: /Also use General/ }));
    expect(within(dialog).getByRole("switch", { name: /Also use General/ })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(within(dialog).getByRole("switch", { name: /Keep separate/ }));
    expect(within(dialog).getByRole("switch", { name: /Also use General/ })).toHaveAttribute("aria-checked", "false");
    expect(within(dialog).getByRole("switch", { name: /Also use General/ })).toBeDisabled();
    expect(within(dialog).getByText(/Blocks borrowing in both directions/)).toBeInTheDocument();
  });

  async function openDelete() {
    await userEvent.click(screen.getByRole("button", { name: "Actions for Acme account" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    return screen.findByRole("dialog", { name: /Delete Acme account/ });
  }

  it("asks what happens to meetings and chats, with their counts, and moves them by default", async () => {
    const b = backend();
    mount();
    const dialog = await openDelete();
    expect(within(dialog).getByText(/3 meetings and 2 chats go to General/)).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: /Move to General/ })).toBeChecked();
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete workspace" }));
    await waitFor(() => expect(b.called("delete_workspace")).toHaveLength(1));
    expect(b.called("delete_workspace")[0].args).toMatchObject({ id: "acme", mode: "move" });
  });

  it("can archive instead, or delete everything with a plain warning", async () => {
    const b = backend();
    mount();
    let dialog = await openDelete();
    await userEvent.click(within(dialog).getByRole("radio", { name: /Archive it instead/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Archive workspace" }));
    await waitFor(() => expect(b.called("archive_workspace")[0]?.args).toMatchObject({ id: "acme", archived: true }));

    seedWorkspaces([GENERAL, ACME, OLD], "general");
    dialog = await openDelete();
    await userEvent.click(within(dialog).getByRole("radio", { name: /Delete everything/ }));
    expect(within(dialog).getByText(/can't be undone/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete everything" }));
    await waitFor(() => expect(b.called("delete_workspace")[0]?.args).toMatchObject({ id: "acme", mode: "delete" }));
  });

  it("shows the General note once and remembers it was dismissed", async () => {
    backend();
    useWorkspaceStore.setState({ workspaces: [ws({ meeting_count: 4 })], openId: "general", noteSeen: false });
    mount();
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("Your meetings and files are in General.");
    await userEvent.click(within(note).getByRole("button", { name: "Dismiss this note" }));
    expect(screen.queryByRole("note")).toBeNull();
    expect(localStorage.getItem("nexq_general_note_seen")).toBe("1");
  });
});
