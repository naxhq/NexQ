import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({ load: async () => ({ get: async () => undefined, set: async () => {} }) }));

import { MoveMeetingMenu } from "./MoveMeetingMenu";
import { MeetingWorkspaceChip } from "./MeetingWorkspaceChip";
import { useMeetingStore } from "../stores/meetingStore";
import { mockBackend, seedWorkspaces, ws } from "./testUtils";

const LIST = [
  ws({ id: "general", name: "General" }),
  ws({ id: "acme", name: "Acme", is_default: false }),
  ws({ id: "docs", name: "Docs", is_default: false }),
  ws({ id: "vault", name: "Vault", is_default: false, keep_separate: true }),
  ws({ id: "old", name: "Old", is_default: false, archived: true }),
];

const scope = (home: string, borrowed: string[]) => ({ meeting_id: "m1", home, borrowed, effective: [home, ...borrowed] });

beforeEach(() => {
  seedWorkspaces(LIST, "general");
  useMeetingStore.setState({ activeMeeting: null, activeBorrowed: [], recentMeetings: [] });
});
afterEach(() => cleanup());

describe("MoveMeetingMenu", () => {
  it("lists the live workspaces with the current one ticked, and files the meeting in the one chosen", async () => {
    const b = mockBackend({ get_meeting_scope: scope("acme", []), list_meetings: "[]", list_workspaces: LIST });
    render(<MoveMeetingMenu meetingId="m1" currentWorkspaceId="general" variant="button" />);
    await userEvent.click(screen.getByRole("button", { name: "Move to workspace" }));
    const items = screen.getAllByRole("menuitemcheckbox");
    expect(items.map((i) => i.textContent)).toEqual(["General", "Acme", "Docs", "Vault"]);
    expect(screen.getByRole("menuitemcheckbox", { name: "General" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "Acme" }));
    await waitFor(() => expect(b.called("move_meeting")[0]?.args).toMatchObject({ meetingId: "m1", workspaceId: "acme" }));
  });

  it("keeps a running meeting's store in step when it is moved", async () => {
    mockBackend({ get_meeting_scope: scope("acme", ["docs"]), list_meetings: "[]", list_workspaces: LIST });
    useMeetingStore.setState({ activeMeeting: { id: "m1", title: "Live", workspace_id: "general" } as never });
    render(<MoveMeetingMenu meetingId="m1" currentWorkspaceId="general" />);
    await userEvent.click(screen.getByRole("button", { name: "Move to workspace" }));
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "Acme" }));
    await waitFor(() => expect(useMeetingStore.getState().activeMeeting?.workspace_id).toBe("acme"));
    expect(useMeetingStore.getState().activeBorrowed).toEqual(["docs"]);
  });
});

describe("MeetingWorkspaceChip", () => {
  beforeEach(() => {
    useMeetingStore.setState({ activeMeeting: { id: "m1", title: "Live", workspace_id: "acme" } as never, activeBorrowed: ["docs"] });
  });

  it("shows the home and how many it also uses", async () => {
    mockBackend({ get_meeting_scope: scope("acme", ["docs"]) });
    render(<MeetingWorkspaceChip meetingId="m1" />);
    expect(screen.getByRole("button", { name: "Workspace: Acme, also using 1" })).toHaveTextContent("+1");
  });

  it("offers Also use toggles, blocks kept-separate ones with the reason, and sends the new set", async () => {
    const b = mockBackend({
      get_meeting_scope: scope("acme", ["docs"]),
      set_meeting_scope: (a: Record<string, unknown>) => scope("acme", a.borrowed as string[]),
    });
    render(<MeetingWorkspaceChip meetingId="m1" />);
    await userEvent.click(screen.getByRole("button", { name: /Workspace: Acme/ }));
    expect(screen.getByRole("menuitemcheckbox", { name: /Filed in Acme/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemcheckbox", { name: /Also use Docs/ })).toHaveAttribute("aria-checked", "true");
    const vault = screen.getByRole("menuitemcheckbox", { name: /Also use Vault/ });
    expect(vault).toHaveAttribute("aria-disabled", "true");
    expect(vault).toHaveTextContent("Kept separate");
    expect(screen.queryByRole("menuitemcheckbox", { name: /Old/ })).toBeNull();

    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: /Also use General/ }));
    await waitFor(() => expect(b.called("set_meeting_scope")[0]?.args).toMatchObject({ meetingId: "m1", borrowed: ["docs", "general"] }));
    await waitFor(() => expect(useMeetingStore.getState().activeBorrowed).toEqual(["docs", "general"]));
  });

  it("changes the home through the same path", async () => {
    let moved = false;
    const b = mockBackend({
      move_meeting: () => {
        moved = true;
        return null;
      },
      get_meeting_scope: () => scope(moved ? "docs" : "acme", []),
      list_meetings: "[]",
      list_workspaces: LIST,
    });
    render(<MeetingWorkspaceChip meetingId="m1" />);
    await userEvent.click(screen.getByRole("button", { name: /Workspace: Acme/ }));
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: /File in Docs/ }));
    await waitFor(() => expect(b.called("move_meeting")[0]?.args).toMatchObject({ meetingId: "m1", workspaceId: "docs" }));
    await waitFor(() => expect(useMeetingStore.getState().activeMeeting?.workspace_id).toBe("docs"));
  });

  it("a meeting filed nowhere says so, offers only the filing choices, and files through the ordinary move", async () => {
    useMeetingStore.setState({ activeMeeting: { id: "m1", title: "Live", workspace_id: "unfiled:m1" } as never, activeBorrowed: [] });
    let moved = false;
    const b = mockBackend({
      move_meeting: () => {
        moved = true;
        return null;
      },
      get_meeting_scope: () => scope(moved ? "docs" : "unfiled:m1", []),
      list_meetings: "[]",
      list_workspaces: LIST,
    });
    render(<MeetingWorkspaceChip meetingId="m1" />);
    await userEvent.click(screen.getByRole("button", { name: /Workspace: No workspace/ }));
    expect(screen.queryByRole("menuitemcheckbox", { name: /Also use/ })).toBeNull();
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: /File in Docs/ }));
    await waitFor(() => expect(b.called("move_meeting")[0]?.args).toMatchObject({ meetingId: "m1", workspaceId: "docs" }));
    await waitFor(() => expect(useMeetingStore.getState().activeMeeting?.workspace_id).toBe("docs"));
  });
});
