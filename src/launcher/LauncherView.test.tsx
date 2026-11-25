import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({ load: async () => ({ get: async () => undefined, set: async () => {} }) }));
vi.mock("../components/ServiceStatusBar", () => ({ ServiceStatusBar: () => null }));
const ended = vi.hoisted(() => ({ end: vi.fn(async () => true) }));
vi.mock("../hooks/useUpdater", () => ({ endMeetingFromThisWindow: ended.end }));

vi.mock("../workspace/chat/ChatPane", () => ({ ChatPane: () => null }));

import { LauncherView, resetLauncherAutoStart } from "./LauncherView";
import { useMeetingStore } from "../stores/meetingStore";
import { useConfigStore } from "../stores/configStore";
import { mockBackend, seedWorkspaces, ws } from "../workspace/testUtils";

const start = vi.fn(async () => {});

beforeEach(() => {
  localStorage.clear();
  resetLauncherAutoStart();
  ended.end.mockClear();
  start.mockClear();
  mockBackend({ list_workspaces: [], list_workspace_meetings: { meetings: [], total: 0 } });
  seedWorkspaces(
    [ws({ id: "general", name: "General" }), ws({ id: "bio", name: "Biology", is_default: false, default_scenario: "interview" })],
    "bio",
  );
  useConfigStore.setState({ startOnLogin: false, rememberedMeetingSetup: null } as never);
  useMeetingStore.setState({ activeMeeting: null, selectedMeetingId: null, startMeetingFlow: start, recentMeetings: [] });
});
afterEach(() => cleanup());

describe("LauncherView starting meetings", () => {
  it("files a meeting in the open workspace with what the setup dialog chose", async () => {
    render(<LauncherView />);
    await userEvent.click(screen.getByRole("button", { name: "Start meeting" }));
    const setup = await screen.findByRole("dialog", { name: "Meeting setup" });
    await userEvent.click(within(setup).getByRole("button", { name: "In-Person Mic only, shared room" }));
    await userEvent.click(within(setup).getByRole("button", { name: "Start Meeting" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(start).toHaveBeenCalledWith(undefined, "in_person", "interview", { workspaceId: "bio", borrowed: [] });
  });

  it("End and start new keeps the mode, scenario and workspace that were chosen", async () => {
    useMeetingStore.setState({ activeMeeting: { id: "live", title: "Running call" } as never });
    render(<LauncherView />);
    await userEvent.click(screen.getByRole("button", { name: "Start meeting" }));
    const setup = await screen.findByRole("dialog", { name: "Meeting setup" });
    await userEvent.click(within(setup).getByRole("button", { name: "In-Person Mic only, shared room" }));
    await userEvent.click(within(setup).getByRole("radio", { name: "General" }));
    await userEvent.click(within(setup).getByRole("button", { name: "Start Meeting" }));

    const conflict = await screen.findByRole("dialog", { name: "Meeting in progress" });
    expect(conflict).toHaveTextContent("Running call");
    expect(start).not.toHaveBeenCalled();
    await userEvent.click(within(conflict).getByRole("button", { name: "End current and start new" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(ended.end).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(undefined, "in_person", "team_meeting", { workspaceId: "general", borrowed: [] });
  });

  it("cancelling the conflict forgets the choice and starts nothing", async () => {
    useMeetingStore.setState({ activeMeeting: { id: "live", title: "Running call" } as never });
    render(<LauncherView />);
    await userEvent.click(screen.getByRole("button", { name: "Start meeting" }));
    const setup = await screen.findByRole("dialog", { name: "Meeting setup" });
    await userEvent.click(within(setup).getByRole("button", { name: "Start Meeting" }));
    const conflict = await screen.findByRole("dialog", { name: "Meeting in progress" });
    await userEvent.click(within(conflict).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Meeting in progress" })).toBeNull());
    expect(start).not.toHaveBeenCalled();
    expect(ended.end).not.toHaveBeenCalled();
  });

  it("does not start the new meeting when the running one could not be saved", async () => {
    ended.end.mockResolvedValueOnce(false);
    useMeetingStore.setState({ activeMeeting: { id: "live", title: "Running call" } as never });
    render(<LauncherView />);
    await userEvent.click(screen.getByRole("button", { name: "Start meeting" }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Meeting setup" })).getByRole("button", { name: "Start Meeting" }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Meeting in progress" })).getByRole("button", { name: "End current and start new" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Couldn't finish saving/);
    expect(start).not.toHaveBeenCalled();
  });

  it("start on login starts in the default workspace, once", async () => {
    useConfigStore.setState({ startOnLogin: true } as never);
    render(<LauncherView />);
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(start).toHaveBeenCalledWith();
  });

  it("returns to the running meeting from the header", async () => {
    useMeetingStore.setState({ activeMeeting: { id: "live", title: "Running call" } as never });
    render(<LauncherView />);
    expect(screen.getAllByText("Running call").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Return to meeting/ })).toBeInTheDocument();
  });
});
