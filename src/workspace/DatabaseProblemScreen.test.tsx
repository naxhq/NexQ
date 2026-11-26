import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({ load: async () => ({ get: async () => undefined, set: async () => {} }) }));
vi.mock("../components/ServiceStatusBar", () => ({ ServiceStatusBar: () => <div data-testid="footer-status" /> }));
const updater = vi.hoisted(() => ({ openUpdateDialog: vi.fn(), endMeetingFromThisWindow: vi.fn(async () => true) }));
vi.mock("../hooks/useUpdater", () => updater);
vi.mock("./chat/ChatPane", () => ({ ChatPane: () => <div data-testid="chat" /> }));

import { DatabaseProblemScreen, formatCopyDate } from "./DatabaseProblemScreen";
import type { DatabaseProblem, DatabaseProblemKind } from "./databaseProblem";
import { LauncherView } from "../launcher/LauncherView";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useMeetingStore } from "../stores/meetingStore";
import { mockBackend, seedWorkspaces, ws } from "./testUtils";

const PATH = "C:\\Users\\me\\AppData\\Roaming\\com.nexq.app\\nexq.db";
const problem = (kind: DatabaseProblemKind, over: Partial<DatabaseProblem> = {}): DatabaseProblem => ({
  kind,
  message: "database disk image is malformed",
  path: PATH,
  backups: [
    { name: "nexq-before-workspaces.db", created_at: Date.UTC(2026, 10, 16, 9, 41), bytes: 18_400_000, meetings: 41 },
    { name: "nexq-2026-11-20.db", created_at: Date.UTC(2026, 10, 20, 9, 41), bytes: 19_100_000, meetings: 1 },
  ],
  ...over,
});

beforeEach(() => {
  updater.openUpdateDialog.mockClear();
  seedWorkspaces([ws()], "general");
});
afterEach(() => cleanup());

describe("what every kind says", () => {
  it.each([
    ["unreadable", "NexQ couldn't open your meetings", "couldn't be read"],
    ["newer", "Your meetings were saved by a newer NexQ", "older than the one"],
    ["upgrade_failed", "NexQ couldn't finish updating your data", "didn't complete"],
    ["locked", "Your meetings are in use", "Another NexQ or program"],
  ] as const)("%s: a heading, one sentence, that nothing was deleted, and where the file is", (kind, title, sentence) => {
    mockBackend();
    render(<DatabaseProblemScreen problem={problem(kind)} />);
    const h = screen.getByRole("heading", { level: 1, name: title });
    expect(document.activeElement).toBe(h);
    expect(screen.getByText(new RegExp(sentence))).toBeInTheDocument();
    expect(screen.getByText(/Nothing was deleted/)).toBeInTheDocument();
    expect(screen.getByTestId("db-path")).toHaveTextContent(PATH);
    expect(screen.getByText("database disk image is malformed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open data folder" })).toBeInTheDocument();
    // Not an alarm: no alert role until something goes wrong.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("each kind offers only the choices that fit", () => {
    mockBackend();
    const names = () => screen.queryAllByRole("button").map((b) => b.textContent);
    render(<DatabaseProblemScreen problem={problem("newer")} />);
    expect(names()).toEqual(["Install the newer NexQ", "Open data folder"]);
    cleanup();
    render(<DatabaseProblemScreen problem={problem("upgrade_failed")} />);
    expect(names()).toEqual(["Try again", "Open data folder"]);
    cleanup();
    render(<DatabaseProblemScreen problem={problem("locked")} />);
    expect(names()).toEqual(["Try again", "Open data folder"]);
    cleanup();
    render(<DatabaseProblemScreen problem={problem("unreadable")} />);
    expect(names()).toEqual(["Restore", "Restore", "Open data folder", "Start with an empty database"]);
  });
});

describe("unreadable", () => {
  it("lists every copy with its date, meetings and size, and restores the one chosen, then asks for a restart", async () => {
    const b = mockBackend({ restore_database_copy: null, restart_app: null });
    render(<DatabaseProblemScreen problem={problem("unreadable")} />);
    const list = screen.getByRole("list", { name: "Copies of your meetings" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    // Newest first.
    expect(rows[0]).toHaveTextContent("1 meeting, 18.2 MB");
    expect(rows[1]).toHaveTextContent("41 meetings, 17.5 MB");
    expect(rows[1]).toHaveTextContent(formatCopyDate(Date.UTC(2026, 10, 16, 9, 41)));

    await userEvent.click(within(rows[0]).getByRole("button", { name: /^Restore the copy from .*, 1 meeting$/ }));
    await waitFor(() => expect(b.called("restore_database_copy")[0]?.args).toMatchObject({ name: "nexq-2026-11-20.db" }));
    const restart = await screen.findByRole("button", { name: "Restart NexQ" });
    expect(screen.getByRole("heading", { level: 1, name: "NexQ needs to restart" })).toBeInTheDocument();
    expect(document.activeElement).toBe(restart);
    expect(screen.getByRole("status")).toHaveTextContent(/Restart to open your meetings/);
    await userEvent.click(restart);
    await waitFor(() => expect(b.called("restart_app")).toHaveLength(1));
  });

  it("says plainly when there are no copies", () => {
    mockBackend();
    render(<DatabaseProblemScreen problem={problem("unreadable", { backups: [] })} />);
    expect(screen.getByText(/No copies were found/)).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Copies of your meetings" })).toBeNull();
  });

  it("asks first before starting empty, says the damaged file is kept aside under its name, and cancels cleanly", async () => {
    const b = mockBackend({ start_with_new_database: null });
    render(<DatabaseProblemScreen problem={problem("unreadable")} />);
    await userEvent.click(screen.getByRole("button", { name: "Start with an empty database" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("nexq.db");
    expect(dialog).toHaveTextContent(/not deleted: it is kept aside under its name/);
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(b.called("start_with_new_database")).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Start with an empty database" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Start empty" }));
    await waitFor(() => expect(b.called("start_with_new_database")).toHaveLength(1));
    expect(await screen.findByRole("button", { name: "Restart NexQ" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/kept aside/);
  });

  it("reports a failed restore in words and leaves every choice open", async () => {
    mockBackend({
      restore_database_copy: () => {
        throw "The copy is damaged too";
      },
    });
    render(<DatabaseProblemScreen problem={problem("unreadable")} />);
    await userEvent.click(screen.getAllByRole("button", { name: /^Restore the copy/ })[0]);
    expect(await screen.findByRole("alert")).toHaveTextContent("That didn't work: The copy is damaged too");
    expect(screen.getAllByRole("button", { name: /^Restore the copy/ })[0]).toBeEnabled();
  });
});

describe("the other kinds", () => {
  it("newer: Install opens the update dialog", async () => {
    mockBackend();
    render(<DatabaseProblemScreen problem={problem("newer")} />);
    await userEvent.click(screen.getByRole("button", { name: "Install the newer NexQ" }));
    expect(updater.openUpdateDialog).toHaveBeenCalledTimes(1);
  });

  it("upgrade failed: Try again restarts", async () => {
    const b = mockBackend({ restart_app: null });
    render(<DatabaseProblemScreen problem={problem("upgrade_failed")} />);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(b.called("restart_app")).toHaveLength(1));
  });

  it("locked: Try again opens the file again, then looks, and says so while it is still in use", async () => {
    const b = mockBackend({ retry_open_database: null, get_workspaces_status: { available: false, error: null, db: problem("locked") } });
    useWorkspaceStore.setState({ database: problem("locked") });
    render(<DatabaseProblemScreen problem={problem("locked")} />);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("status")).toHaveTextContent("It is still in use. Close the other program, then try again.");
    expect(b.called("retry_open_database")).toHaveLength(1);
    expect(b.called("get_workspaces_status").length).toBeGreaterThan(0);
    expect(b.called("restart_app")).toHaveLength(0);
  });

  it("locked: a file that opens but needs a restart offers Restart, and one still held says it is in use", async () => {
    const b = mockBackend({ retry_open_database: { ok: true, needs_restart: true }, restart_app: null });
    render(<DatabaseProblemScreen problem={problem("locked")} />);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Your meetings can be opened now. Restart to open your meetings.");
    await userEvent.click(screen.getByRole("button", { name: "Restart NexQ" }));
    await waitFor(() => expect(b.called("restart_app")).toHaveLength(1));
    cleanup();
    mockBackend({ retry_open_database: { ok: false, needs_restart: false } });
    render(<DatabaseProblemScreen problem={problem("locked")} />);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("status")).toHaveTextContent("It is still in use");
  });

  it("locked: without a reopen command it restarts instead, and a refusal is said in words", async () => {
    const b = mockBackend({
      retry_open_database: () => {
        throw "command retry_open_database not found";
      },
      restart_app: null,
    });
    render(<DatabaseProblemScreen problem={problem("locked")} />);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(b.called("restart_app")).toHaveLength(1));
    cleanup();
    mockBackend({
      retry_open_database: () => {
        throw "The file is held by another NexQ";
      },
    });
    render(<DatabaseProblemScreen problem={problem("locked")} />);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The file is held by another NexQ");
  });

  it("Open data folder asks the backend, and a refusal is reported", async () => {
    mockBackend({
      open_data_folder: () => {
        throw "No file manager";
      },
    });
    render(<DatabaseProblemScreen problem={problem("locked")} />);
    await userEvent.click(screen.getByRole("button", { name: "Open data folder" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No file manager");
  });
});

describe("in the launcher", () => {
  it("replaces the home: no meeting list, no chat, no Start meeting; the header, Settings and footer stay", async () => {
    mockBackend({ get_workspaces_status: { available: false, error: null, db: problem("unreadable") }, list_workspaces: [] });
    useMeetingStore.setState({ activeMeeting: null, selectedMeetingId: null });
    await useWorkspaceStore.getState().refresh();
    render(<LauncherView />);
    expect(screen.getByRole("heading", { level: 1, name: "NexQ couldn't open your meetings" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start meeting" })).toBeNull();
    expect(screen.queryByTestId("chat")).toBeNull();
    expect(screen.queryByRole("region", { name: "Meetings" })).toBeNull();
    expect(screen.queryByText(/No meetings in General yet/)).toBeNull();
    expect(screen.getByRole("button", { name: /^Settings/ })).toBeInTheDocument();
    expect(screen.getByTestId("footer-status")).toBeInTheDocument();
  });

  it("the store carries the problem and drops it once the file opens again", async () => {
    const b = mockBackend({ get_workspaces_status: { available: false, error: null, db: problem("locked") }, list_workspaces: [ws()] });
    await useWorkspaceStore.getState().refresh();
    expect(useWorkspaceStore.getState().database?.kind).toBe("locked");
    expect(b.called("list_workspaces")).toHaveLength(0);
    mockBackend({ get_workspaces_status: { available: true, error: null, db: null }, list_workspaces: [ws()] });
    await useWorkspaceStore.getState().refresh();
    expect(useWorkspaceStore.getState().database).toBeNull();
  });
});
