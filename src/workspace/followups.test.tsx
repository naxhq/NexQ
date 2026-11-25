import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({ load: async () => ({ get: async () => undefined, set: async () => {} }) }));
vi.mock("./chat/ChatPane", () => ({ ChatPane: () => <div data-testid="chat" /> }));

import { MeetingCard } from "../launcher/MeetingCard";
import { MeetingSetupModal } from "../launcher/MeetingSetupModal";
import { MiddlePane } from "./MiddlePane";
import { WorkspaceActionsProvider, useWorkspaceActions } from "./WorkspaceActions";
import { LibraryRow } from "./LibraryRow";
import { libraryEstimate } from "./ContextMeter";
import { changeNotice } from "./MeetingWorkspaceChip";
import { collectWorkspaceMeetingIds, deleteAllInWorkspace, describeDeleteAll } from "./deleteAll";
import { formatMeetingWhen } from "./meetingGroups";
import { useMeetingStore } from "../stores/meetingStore";
import { useWorkspaceChatStore } from "../stores/workspaceChatStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { detailOf, item, meeting, mockBackend, seedWorkspaces, ws } from "./testUtils";

beforeEach(() => {
  localStorage.clear();
  seedWorkspaces([ws(), ws({ id: "acme", name: "Acme", is_default: false })], "acme");
});
afterEach(() => cleanup());

describe("meeting rows are one quiet line", () => {
  const card = (m = meeting(), extra: object = {}) =>
    render(<MeetingCard meeting={m} onSelect={() => {}} onDelete={() => {}} onRename={() => {}} {...extra} />);

  it("says when and how long, and leaves out what is usual", () => {
    card(meeting({ audio_mode: "online", ai_scenario: "team_meeting", speaker_count: 2, start_time: "2020-11-15T10:00:00Z" }));
    const row = screen.getByRole("button", { name: /^Meeting:/ });
    expect(row).toHaveTextContent("15 Nov 2020");
    expect(row).not.toHaveTextContent(/Online/);
    expect(row).not.toHaveTextContent(/speakers/);
    expect(row).not.toHaveTextContent(/team meeting/i);
  });

  it("names only what is not the default, and the star appears when set", () => {
    card(meeting({ audio_mode: "in_person", ai_scenario: "interview", has_summary: true }), { isFavorite: true });
    const row = screen.getByRole("button", { name: /^Meeting:/ });
    expect(row).toHaveTextContent("In person");
    expect(row).toHaveTextContent("interview");
    expect(row).toHaveTextContent("Summary");
    expect(screen.getByRole("button", { name: "Remove from favorites" })).toHaveAttribute("aria-pressed", "true");
  });

  it("reads dates like 15 Nov, and times for today and yesterday", () => {
    const now = new Date(2026, 10, 24, 15, 0);
    expect(formatMeetingWhen(new Date(2026, 10, 15, 9, 0).toISOString(), now)).toBe("15 Nov");
    expect(formatMeetingWhen(new Date(2025, 10, 15, 9, 0).toISOString(), now)).toBe("15 Nov 2025");
    expect(formatMeetingWhen(new Date(2026, 10, 24, 9, 5).toISOString(), now)).toMatch(/9[:.]05|09[:.]05/);
    expect(formatMeetingWhen("nonsense", now)).toBe("");
  });
});

describe("delete all counts honestly", () => {
  it("pages until the total is reached", async () => {
    const all = Array.from({ length: 450 }, (_, i) => meeting({ id: `m${i}` }));
    const b = mockBackend({
      list_workspace_meetings: (a: Record<string, unknown>) => ({ meetings: all.slice(Number(a.offset), Number(a.offset) + Number(a.limit)), total: 450 }),
    });
    const { ids, total } = await collectWorkspaceMeetingIds("acme");
    expect(ids).toHaveLength(450);
    expect(total).toBe(450);
    expect(b.called("list_workspace_meetings").length).toBe(3);
  });

  it("counts a list shorter than the total as not deleted, and never says all", async () => {
    const b = mockBackend({
      list_workspace_meetings: { meetings: [meeting({ id: "a" }), meeting({ id: "b" })], total: 5 },
      delete_meeting: (a: Record<string, unknown>) => {
        if (a.meetingId === "b") throw "busy";
        return null;
      },
    });
    const r = await deleteAllInWorkspace("acme", 5);
    expect(r).toEqual({ deleted: 1, failed: 4, expected: 5 });
    expect(describeDeleteAll(r)).toBe("Deleted 1 of 5 meetings. 4 could not be deleted.");
    expect(b.called("delete_workspace_meetings")).toHaveLength(1);
  });

  it("uses the backend's one call when it exists", async () => {
    const b = mockBackend({ delete_workspace_meetings: { deleted: 7, failed: 1 } });
    const r = await deleteAllInWorkspace("acme", 8);
    expect(r).toEqual({ deleted: 7, failed: 1, expected: 8 });
    expect(b.called("list_workspace_meetings")).toHaveLength(0);
    expect(describeDeleteAll({ deleted: 3, failed: 0, expected: 3 })).toBe("Deleted 3 meetings");
  });
});

describe("the edit dialog never shows another workspace's instructions", () => {
  function Opener({ id }: { id: string }) {
    const actions = useWorkspaceActions();
    return <button onClick={() => actions.edit(id)}>edit {id}</button>;
  }

  it("ignores a late answer for the workspace that was opened first", async () => {
    seedWorkspaces([ws(), ws({ id: "a", name: "Alpha", is_default: false }), ws({ id: "b", name: "Beta", is_default: false })], "general");
    const waiting: Record<string, (v: unknown) => void> = {};
    const b = mockBackend({
      get_workspace: (a: Record<string, unknown>) =>
        new Promise((resolve) => {
          waiting[String(a.id)] = resolve;
        }),
      update_workspace: detailOf(ws({ id: "b", name: "Beta", is_default: false })),
      list_workspaces: [ws(), ws({ id: "a", name: "Alpha", is_default: false }), ws({ id: "b", name: "Beta", is_default: false })],
    });
    render(
      <WorkspaceActionsProvider>
        <Opener id="a" />
        <Opener id="b" />
      </WorkspaceActionsProvider>,
    );
    await userEvent.click(screen.getByText("edit a"));
    await screen.findByRole("dialog", { name: /Settings for Alpha/ });
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByText("edit b"));
    const dialog = await screen.findByRole("dialog", { name: /Settings for Beta/ });
    // Alpha's detail arrives late.
    await act(async () => {
      waiting.a(detailOf(ws({ id: "a", name: "Alpha" }), [], "ALPHA SECRETS"));
    });
    const box = within(dialog).getByRole("textbox", { name: "Instructions for the AI" });
    expect(box).toHaveValue("");
    expect(box).toBeDisabled();
    // Saving before Beta's detail is in leaves the instructions out of the patch.
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(b.called("update_workspace")).toHaveLength(1));
    expect(b.called("update_workspace")[0].args.patch).not.toHaveProperty("instructions");
  });

  it("fills in the matching detail once it arrives and sends it back with the edit", async () => {
    const A = ws({ id: "a", name: "Alpha", is_default: false });
    seedWorkspaces([ws(), A], "general");
    const b = mockBackend({ get_workspace: detailOf(A, [], "Be brief."), update_workspace: detailOf(A, [], "Be brief."), list_workspaces: [ws(), A] });
    render(
      <WorkspaceActionsProvider>
        <Opener id="a" />
      </WorkspaceActionsProvider>,
    );
    await userEvent.click(screen.getByText("edit a"));
    const dialog = await screen.findByRole("dialog", { name: /Settings for Alpha/ });
    await waitFor(() => expect(within(dialog).getByRole("textbox", { name: "Instructions for the AI" })).toHaveValue("Be brief."));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(b.called("update_workspace")[0]?.args.patch).toMatchObject({ instructions: "Be brief." }));
  });

  it("creates with a client id so the preview is the real mark", async () => {
    const b = mockBackend({ create_workspace: detailOf(ws({ id: "x", name: "Biology" })), list_workspaces: [ws()] });
    render(
      <WorkspaceActionsProvider>
        <NewButton />
      </WorkspaceActionsProvider>,
    );
    await userEvent.click(screen.getByText("make one"));
    const dialog = await screen.findByRole("dialog", { name: "New workspace" });
    expect(within(dialog).getByRole("img", { name: /Preview of the mark/ })).toBeInTheDocument();
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Name" }), "Biology");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create workspace" }));
    await waitFor(() => expect(b.called("create_workspace")).toHaveLength(1));
    const input = b.called("create_workspace")[0].args.input as { id: string };
    expect(input.id).toMatch(/^[0-9a-f-]{36}$/);
  });
  function NewButton() {
    const a = useWorkspaceActions();
    return <button onClick={a.create}>make one</button>;
  }
});

describe("never starting in an archived workspace", () => {
  it("selects the default visibly and says why", () => {
    seedWorkspaces([ws(), ws({ id: "old", name: "Old job", archived: true, is_default: false }), ws({ id: "acme", name: "Acme", is_default: false })], "old");
    const onStart = vi.fn();
    render(<MeetingSetupModal open workspaceId="old" onStart={onStart} onCancel={() => {}} />);
    expect(screen.getByRole("note")).toHaveTextContent("Old job is archived, so this meeting goes to General.");
    expect(screen.getByRole("radio", { name: "General" })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("radio", { name: "Old job" })).toBeNull();
    screen.getByRole("button", { name: "Start Meeting" }).click();
    expect(onStart).toHaveBeenCalledWith("online", "team_meeting", { workspaceId: "general", borrowed: [] });
  });
});

describe("the middle header gives room to the answers", () => {
  const mount = () =>
    render(
      <WorkspaceActionsProvider>
        <MiddlePane
          workspace={ws({ id: "acme", name: "Acme", description: "The rollout", is_default: false })}
          starting={false}
          onStart={() => {}}
          onOpenMeeting={() => {}}
          showLibraryToggle={false}
          onToggleLibrary={() => {}}
          onShowLibrary={() => {}}
          onGoAll={() => {}}
          switcherOpen={false}
          onSwitcherOpenChange={() => {}}
        />
      </WorkspaceActionsProvider>,
    );

  beforeEach(() => {
    mockBackend({ list_workspace_meetings: { meetings: [meeting({ id: "m1" })], total: 22 } });
    useMeetingStore.setState({ activeMeeting: null });
  });

  it("shows the full header on the start state, with the explanation in a tooltip only", async () => {
    useWorkspaceChatStore.setState({ activeChat: {}, sessions: {} });
    mount();
    expect(screen.getByRole("heading", { level: 1, name: "Acme" })).toBeInTheDocument();
    expect(screen.getByText("The rollout")).toBeInTheDocument();
    expect(await screen.findByText("22 meetings")).toBeInTheDocument();
    expect(screen.queryByText(/each bar is one/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Edit workspace" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
  });

  it("collapses to one line with a small Start meeting once a chat has messages", () => {
    useWorkspaceChatStore.setState({
      activeChat: { acme: "c1" },
      sessions: { c1: { messages: [{ id: 1 }], turn: null } as never },
    });
    const { container } = mount();
    expect(container.querySelector('[data-header="compact"]')).not.toBeNull();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.getByRole("button", { name: "Start meeting" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("Acme");
  });
});

describe("library row details", () => {
  const folder = (opt: boolean) => item({ kind: "folder", ref_id: "f", name: "C:\\notes", index_opt_in: opt });
  const row = (i: ReturnType<typeof item>) =>
    render(<ul><LibraryRow item={i} menuItems={[]} onRename={() => {}} onTogglePin={() => {}} onOptIn={() => {}} /></ul>);

  it("explains where text goes only under a folder that is not on yet", () => {
    row(folder(false));
    expect(screen.getByText(/sends the passages that match a question/)).toBeInTheDocument();
    cleanup();
    row(folder(true));
    expect(screen.queryByText(/sends the passages that match a question/)).toBeNull();
    expect(screen.getByRole("switch", { name: /Search its text/ })).toHaveAttribute("aria-checked", "true");
  });

  it("shows no pin until hover, and a filled one when pinned", () => {
    row(item());
    expect(screen.getByRole("button", { name: /^Pin / })).toHaveClass("opacity-0");
    cleanup();
    row(item({ pinned: true }));
    const pinned = screen.getByRole("button", { name: /^Unpin / });
    expect(pinned).not.toHaveClass("opacity-0");
    expect(pinned.querySelector("svg")).toHaveAttribute("fill", "currentColor");
  });
});

describe("pieces", () => {
  it("estimates a first answer from instructions and readable files only", () => {
    const bars = libraryEstimate({
      instructions: "x".repeat(400),
      items: [item({ tokens: 500 }), item({ ref_id: "g", status: "missing", tokens: 900 }), item({ ref_id: "s", kind: "server", tokens: 50 }), item({ ref_id: "f", kind: "folder", tokens: 300 })],
    });
    expect(bars.map((b) => [b.layer, b.tokens])).toEqual([
      ["instructions", 100],
      ["documents", 500],
      ["folders", 300],
    ]);
    expect(libraryEstimate(undefined)).toEqual([]);
  });

  it("tells the person what a change in a running meeting does, in one line", () => {
    expect(changeNotice("home", "Acme")).toBe("Answers use Acme from now on. What was already said stays in this call.");
    expect(changeNotice("add", "Docs")).toMatch(/^Answers also use Docs from now on\./);
    expect(changeNotice("remove", "Docs")).toMatch(/^Answers stop using Docs from now on\./);
  });

  it("archived workspaces are not started in by the store either", async () => {
    mockBackend({ start_meeting: (a: Record<string, unknown>) => JSON.stringify({ id: "m", title: "t", workspace_id: a.workspaceId ?? "general" }) });
    seedWorkspaces([ws(), ws({ id: "old", name: "Old job", archived: true, is_default: false })], "general");
    await useMeetingStore.getState().startMeetingFlow("t", "online", "team_meeting", { workspaceId: "old", borrowed: ["x"] });
    expect(useMeetingStore.getState().activeMeeting?.workspace_id).toBe("general");
    expect(useMeetingStore.getState().activeBorrowed).toEqual([]);
    useMeetingStore.getState().stopTimer();
    useMeetingStore.setState({ activeMeeting: null });
    expect(useWorkspaceStore.getState().openId).toBe("general");
  });
});
