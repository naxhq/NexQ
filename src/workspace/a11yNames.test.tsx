import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({ load: async () => ({ get: async () => undefined, set: async () => {} }) }));
vi.mock("./chat/ChatPane", () => ({ ChatPane: () => <div data-testid="chat" /> }));
vi.mock("../components/ServiceStatusBar", () => ({ ServiceStatusBar: () => null }));
vi.mock("../hooks/useUpdater", () => ({ endMeetingFromThisWindow: async () => true, openUpdateDialog: () => {} }));

import { WorkspaceHome } from "./WorkspaceHome";
import { WorkspaceActionsProvider, useWorkspaceActions } from "./WorkspaceActions";
import { LibraryPanel } from "./LibraryPanel";
import { AllWorkspaces } from "./AllWorkspaces";
import { DatabaseProblemScreen } from "./DatabaseProblemScreen";
import { MeetingSetupModal } from "../launcher/MeetingSetupModal";
import { MeetingTabBar } from "../launcher/meeting-details/MeetingTabBar";
import { MemorySection } from "../memory/MemorySection";
import { useMemoryStore } from "../memory/memoryStore";
import { useConfigStore } from "../stores/configStore";
import { unnamedControls } from "../test/a11yNames";
import { detailOf, item, meeting, mockBackend, seedWorkspaces, ws } from "./testUtils";

const GEN = ws();
const ACME = ws({ id: "acme", name: "Acme", is_default: false, meeting_count: 3, keep_separate: true });
const BIO = ws({ id: "bio", name: "Biology", is_default: false });

function expectNamed(label: string) {
  const bad = unnamedControls(document.body);
  expect(bad, `${label}: ${JSON.stringify(bad, null, 1)}`).toEqual([]);
}

beforeEach(() => {
  localStorage.clear();
  seedWorkspaces([GEN, ACME, BIO], "acme");
  useConfigStore.setState({ rememberedMeetingSetup: null } as never);
  mockBackend({
    list_workspaces: [GEN, ACME, BIO],
    list_workspace_meetings: { meetings: [meeting({ id: "m1" })], total: 1 },
    get_workspace: detailOf(ACME, [item({ kind: "folder", ref_id: "f1", name: "C:/n", index_opt_in: false }), item({ ref_id: "d1" }), item({ kind: "server", ref_id: "s1", name: "Jira" })], "Be brief."),
    list_workspace_chats: [],
    list_memory: [
      { id: "k1", workspace_id: "acme", kind: "fact", title: "Cap", text: "40k", status: "saved", source_meeting: null, source_ms: null, created_at: 0, updated_at: 0 },
      { id: "k2", workspace_id: "acme", kind: "person", title: "Priya", text: "CFO", status: "suggested", source_meeting: null, source_ms: null, created_at: 0, updated_at: 0 },
    ],
  });
});
afterEach(() => cleanup());

function Openers() {
  const a = useWorkspaceActions();
  return (
    <>
      <button onClick={() => a.edit("acme")}>open edit</button>
      <button onClick={a.create}>open new</button>
      <button onClick={() => a.clone("acme")}>open clone</button>
      <button onClick={() => a.remove("acme")}>open delete</button>
    </>
  );
}

describe("every workspace screen names what a person can reach", () => {
  it("the home, with its rail, menus and the filter menu", async () => {
    render(
      <WorkspaceActionsProvider>
        <WorkspaceHome starting={false} onStart={() => {}} onOpenMeeting={() => {}} />
      </WorkspaceActionsProvider>,
    );
    await screen.findByRole("button", { name: /Meeting: Weekly sync/ });
    expectNamed("home");
    await userEvent.click(screen.getByRole("button", { name: "Filter meetings" }));
    expectNamed("filter menu");
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Actions for Acme" }));
    expectNamed("workspace menu");
  });

  it("the Library, with its rows, the add menu and a folder's switch", async () => {
    render(<LibraryPanel workspaceId="acme" />);
    await screen.findByRole("list", { name: "Library items" });
    expectNamed("library");
    await userEvent.click(screen.getByRole("button", { name: "Add to this workspace" }));
    expectNamed("add menu");
  });

  it("All workspaces", async () => {
    render(
      <WorkspaceActionsProvider>
        <AllWorkspaces onOpenMeeting={() => {}} />
      </WorkspaceActionsProvider>,
    );
    await screen.findByRole("list", { name: "All workspaces" });
    expectNamed("all workspaces");
  });

  it.each([
    ["open new", "New workspace"],
    ["open edit", "Settings for Acme"],
    ["open clone", "Clone Acme"],
  ])("the %s dialog is named by its title and every field in it is named", async (opener, title) => {
    render(
      <WorkspaceActionsProvider>
        <Openers />
      </WorkspaceActionsProvider>,
    );
    await userEvent.click(screen.getByText(opener));
    const dialog = await screen.findByRole("dialog", { name: title });
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect(dialog.getAttribute("aria-label") ?? "").not.toMatch(/^:/);
    expectNamed(title);
  });

  it("the delete dialog", async () => {
    render(
      <WorkspaceActionsProvider>
        <Openers />
      </WorkspaceActionsProvider>,
    );
    await userEvent.click(screen.getByText("open delete"));
    await screen.findByRole("dialog", { name: /Delete Acme/ });
    expectNamed("delete");
  });

  it("the Start dialog, compact and expanded", async () => {
    const { rerender } = render(<MeetingSetupModal open workspaceId="acme" onStart={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Meeting setup" })).toBeInTheDocument();
    expectNamed("start dialog");
    useConfigStore.setState({ rememberedMeetingSetup: { audioMode: "online", scenario: "team_meeting" } } as never);
    rerender(<MeetingSetupModal open workspaceId="bio" onStart={() => {}} onCancel={() => {}} />);
    expectNamed("start dialog, compact");
  });

  it("memory, with a suggestion tray and the edit form", async () => {
    useMemoryStore.setState({ byWorkspace: {}, loadError: {}, suggest: {} });
    render(<MemorySection workspaceId="acme" />);
    await screen.findByRole("group", { name: "Suggestions" });
    expectNamed("memory");
    await userEvent.click(screen.getByRole("button", { name: "Actions for Cap" }));
    expectNamed("memory menu");
    await userEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    await screen.findByRole("dialog", { name: "Edit memory" });
    expectNamed("memory edit");
  });

  it("the recovery screen and its confirm", async () => {
    const problem = { kind: "unreadable" as const, message: "bad", path: "C:/x/nexq.db", backups: [{ name: "a.db", created_at: Date.now(), bytes: 1000, meetings: 2 }] };
    render(<DatabaseProblemScreen problem={problem} />);
    expectNamed("recovery");
    await userEvent.click(screen.getByRole("button", { name: "Start with an empty database" }));
    await screen.findByRole("alertdialog");
    expectNamed("recovery confirm");
  });

  it("the meeting details tab bar", () => {
    render(<MeetingTabBar {...({ activeTab: "transcript", setActiveTab: () => {}, meeting: { transcript: [], ai_interactions: [] } } as unknown as ComponentProps<typeof MeetingTabBar>)} />);
    expectNamed("tab bar");
  });
});

describe("the Start dialog behaves like a dialog", () => {
  it("moves focus in, keeps Tab inside, and gives focus back on close", async () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open start</button>
          <MeetingSetupModal open={open} workspaceId="acme" onStart={() => {}} onCancel={() => setOpen(false)} />
        </>
      );
    }
    render(<Host />);
    const opener = screen.getByRole("button", { name: "Open start" });
    opener.focus();
    await userEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "Meeting setup" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "Cancel" }));
    for (let i = 0; i < 40; i++) {
      await userEvent.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    for (let i = 0; i < 40; i++) {
      await userEvent.tab({ shift: true });
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Meeting setup" })).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
