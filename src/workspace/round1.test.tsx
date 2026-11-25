import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({ load: async () => ({ get: async () => undefined, set: async () => {} }) }));

import { MeetingSetupModal } from "../launcher/MeetingSetupModal";
import { WorkspaceActionsProvider, useWorkspaceActions } from "./WorkspaceActions";
import { FromLibraryDialog, usedIn } from "./LibraryDialogs";
import { readableName } from "./libraryStatus";
import { skippedByFolder } from "./indexStatus";
import { AGG_PREFIX, WAVE_SINGLES, waveMeetings } from "./waveMeetings";
import { recapCountLine, recapsDescription } from "./WorkspaceDialog";
import { useConfigStore } from "../stores/configStore";
import { useContextStore } from "../stores/contextStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useSourcesStore } from "../stores/sourcesStore";
import { useToastStore } from "../stores/toastStore";
import { detailOf, meeting, mockBackend, seedWorkspaces, ws } from "./testUtils";

const GEN = ws();
const ACME = ws({ id: "acme", name: "Acme", is_default: false });
const BIO = ws({ id: "bio", name: "Biology", is_default: false });

beforeEach(() => {
  localStorage.clear();
  seedWorkspaces([GEN, ACME, BIO], "general");
  useConfigStore.setState({ llmProvider: "claude_cli", llmModel: "sonnet", rememberedMeetingSetup: null } as never);
});
afterEach(() => cleanup());

describe("F23 Prepare recaps with AI", () => {
  function Opener() {
    const a = useWorkspaceActions();
    return <button onClick={() => a.edit("acme")}>edit</button>;
  }
  const open = async (detail = detailOf(ACME, [], "")) => {
    const b = mockBackend({ get_workspace: detail, update_workspace: detail, list_workspaces: [GEN, ACME, BIO], get_automatic_model: { provider: "claude_cli", model: "haiku", effort: null, label: "Claude Haiku (cheapest)" } });
    render(
      <WorkspaceActionsProvider>
        <Opener />
      </WorkspaceActionsProvider>,
    );
    await userEvent.click(screen.getByText("edit"));
    const dialog = await screen.findByRole("dialog", { name: /Settings for Acme/ });
    return { b, dialog };
  };

  it("is off by default, says the model, what is sent and where a recap shows", async () => {
    const { dialog } = await open();
    const sw = within(dialog).getByRole("switch", { name: /Prepare recaps with AI/ });
    await waitFor(() => expect(sw).toBeEnabled());
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(await within(dialog).findByText(/one AI call writes a short recap from the transcript/)).toBeInTheDocument();
    expect(within(dialog).getByText(/for up to 5 meetings without one when this workspace opens/)).toBeInTheDocument();
    expect(within(dialog).getByText(/It never runs during a meeting, uses the cheapest model you have set up \(Claude Haiku \(cheapest\)\)/)).toBeInTheDocument();
    expect(within(dialog).getByText(/sends that meeting's transcript to it/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Meetings that already have a summary are left alone/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Chat reads recaps first/)).toBeInTheDocument();
    expect(recapsDescription("x")).not.toMatch(/context estimate/);
  });

  it("turns on and is saved with the workspace, and shows on when it already was", async () => {
    const { b, dialog } = await open();
    const sw = within(dialog).getByRole("switch", { name: /Prepare recaps with AI/ });
    await waitFor(() => expect(sw).toBeEnabled());
    await userEvent.click(sw);
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(b.called("update_workspace")[0]?.args.patch).toMatchObject({ recaps_with_ai: true }));
    cleanup();
    const on = { ...detailOf(ACME, [], ""), recaps_with_ai: true };
    const again = await open(on);
    await waitFor(() => expect(within(again.dialog).getByRole("switch", { name: /Prepare recaps with AI/ })).toHaveAttribute("aria-checked", "true"));
  });

  it("is not offered while creating (there is nothing to recap yet)", async () => {
    mockBackend();
    function NewOne() {
      const a = useWorkspaceActions();
      return <button onClick={a.create}>new</button>;
    }
    render(
      <WorkspaceActionsProvider>
        <NewOne />
      </WorkspaceActionsProvider>,
    );
    await userEvent.click(screen.getByText("new"));
    const dialog = await screen.findByRole("dialog", { name: "New workspace" });
    expect(within(dialog).queryByRole("switch", { name: /Prepare recaps/ })).toBeNull();
  });
});

describe("F24 skipped files match their folder", () => {
  it("uses the folder id the backend sends, before any path guess", () => {
    const folders = [
      { ref_id: "a", name: "C:/notes" },
      { ref_id: "b", name: "C:/notes/clients" },
    ];
    const r = skippedByFolder(folders, [
      { path: "C:/notes/clients/x.md", reason: "hidden", folder_id: "a" },
      { path: "C:/elsewhere/y.md", reason: "too large", folder_id: "b" },
      { path: "C:/notes/clients/z.md", reason: "hidden", folder_id: "gone" },
      { path: "C:/notes/clients/w.md", reason: "hidden" },
    ]);
    expect(r.byFolder.get("a")?.map((f) => f.path)).toEqual(["C:/notes/clients/x.md"]);
    expect(r.byFolder.get("b")?.map((f) => f.path)).toEqual(["C:/elsewhere/y.md", "C:/notes/clients/w.md"]);
    expect(r.other.map((f) => f.path)).toEqual(["C:/notes/clients/z.md"]);
  });
});

describe("F19 names, never ids", () => {
  const id = "3a9be2aa-1c2d-4e5f-8a9b-0c1d2e3f4a5b";

  it("falls back to the saved label, path or name, and then to a plain word", () => {
    useSourcesStore.setState({
      config: {
        notes_folders: [{ id, label: "Client notes", path: "C:/n", enabled: true }],
        mcp_servers: [{ id: "s1", label: "Jira" } as never],
        mcp_notice_seen: true,
      },
    });
    useContextStore.setState({ resources: [{ id: "d1", name: "plan.pdf" } as never] });
    expect(readableName("folder", id, id)).toBe("Client notes");
    expect(readableName("server", "s1", "s1")).toBe("Jira");
    expect(readableName("document", "d1", "d1")).toBe("plan.pdf");
    expect(readableName("folder", "zzz", "zzz")).toBe("A folder that was removed");
    expect(readableName("server", "zzz", "")).toBe("A tool that was removed");
    expect(readableName("document", id, "Real name.pdf")).toBe("Real name.pdf");
  });

  it("the library dialog names the item and the workspaces that use it", async () => {
    useSourcesStore.setState({ config: { notes_folders: [{ id, label: "Client notes", path: "C:/n", enabled: true }], mcp_servers: [], mcp_notice_seen: true } });
    mockBackend({
      list_library: [{ kind: "folder", ref_id: id, name: id, status: "ready", detail: null, tokens: null, workspace_ids: ["acme", "bio", "ghost"], unfiled: false }],
    });
    seedWorkspaces([GEN, ACME, BIO], "general");
    render(<FromLibraryDialog workspaceId="general" open onClose={() => {}} />);
    const dialog = await screen.findByRole("dialog", { name: "Add from library" });
    expect(await within(dialog).findByText("Client notes")).toBeInTheDocument();
    expect(dialog).toHaveTextContent("Folder, used in Acme, Biology");
    expect(dialog).not.toHaveTextContent(id);
    expect(usedIn(["acme", "bio", "general", "x"], [GEN, ACME, BIO])).toBe("Acme, Biology, General");
    expect(usedIn(["a", "b", "c", "d", "e"], ["a", "b", "c", "d", "e"].map((x) => ({ id: x, name: x.toUpperCase() })))).toBe("A, B, C and 2 more");
    expect(usedIn(["ghost"], [GEN])).toBe("another workspace");
  });
});

describe("F25 the Start dialog names its workspace and lets you change it", () => {
  it("says where the meeting goes, and Change opens the choice from the compact view", async () => {
    useConfigStore.setState({ rememberedMeetingSetup: { audioMode: "online", scenario: "team_meeting" } } as never);
    const onStart = vi.fn();
    render(<MeetingSetupModal open workspaceId="acme" onStart={onStart} onCancel={() => {}} />);
    expect(screen.getByText("Goes to Acme")).toBeInTheDocument();
    const badge = screen.getByRole("button", { name: "Workspace: Acme. Change" });
    await userEvent.click(badge);
    await userEvent.click(screen.getByRole("radio", { name: "Biology" }));
    expect(screen.getByText("Goes to Biology")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Start Meeting" }));
    expect(onStart).toHaveBeenCalledWith("online", "team_meeting", { workspaceId: "bio", borrowed: [] });
  });

  it("names General too when it is the only workspace", () => {
    seedWorkspaces([GEN], "general");
    render(<MeetingSetupModal open onStart={() => {}} onCancel={() => {}} />);
    expect(screen.getByText("Goes to General")).toBeInTheDocument();
  });
});

describe("F25 the header wave is not limited to 50", () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      meeting({ id: `m${i}`, title: `Meeting ${i}`, start_time: new Date(2024, 0, 1 + i * 5).toISOString(), duration_seconds: 600 }),
    );

  it("draws the newest as bars and gathers the older ones by month, without dropping any", () => {
    const list = many(WAVE_SINGLES + 25);
    const bars = waveMeetings(list);
    const singles = bars.filter((b) => !b.id.startsWith(AGG_PREFIX));
    const groups = bars.filter((b) => b.id.startsWith(AGG_PREFIX));
    expect(singles).toHaveLength(WAVE_SINGLES);
    const gathered = groups.reduce((n, g) => n + Number(g.title.split(" ")[0]), 0);
    expect(gathered).toBe(25);
    expect(groups.every((g) => /earlier meetings?$/.test(g.title))).toBe(true);
    expect(groups.reduce((n, g) => n + (g.duration_seconds ?? 0), 0)).toBe(25 * 600);
    // The newest ones are the single bars.
    expect(singles.map((b) => b.id)).toContain(`m${WAVE_SINGLES + 24}`);
  });

  it("leaves a short history as it is", () => {
    expect(waveMeetings(many(5))).toHaveLength(5);
    expect(waveMeetings([])).toEqual([]);
  });
});

describe("F28 a workspace that cannot be used starts the meeting unfiled, and says so", () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] } as never);
  });
  afterEach(() => {
    useMeetingStore.getState().stopTimer();
    useMeetingStore.setState({ activeMeeting: null, activeBorrowed: [], currentView: "launcher", isRecording: false });
  });
  const toasts = () => (useToastStore.getState() as unknown as { toasts: Array<{ message: string }> }).toasts.map((t) => t.message);

  it("toasts the backend's sentence, keeps the meeting running and drops the borrows", async () => {
    const notice = "That workspace is no longer available, so this meeting is not filed in a workspace and uses none of their material. Pick one from the island to file it";
    const b = mockBackend({ start_meeting: JSON.stringify({ id: "m", title: "t", workspace_id: "unfiled:m", workspace_notice: notice }) });
    await useMeetingStore.getState().startMeetingFlow("t", "online", "team_meeting", { workspaceId: "acme", borrowed: ["x"] });
    expect(toasts()).toContain(notice);
    expect(useMeetingStore.getState().activeMeeting?.id).toBe("m");
    expect(b.called("set_meeting_scope")).toHaveLength(0);
  });

  it("is quiet when it went where it was asked", async () => {
    mockBackend({ start_meeting: JSON.stringify({ id: "m", title: "t", workspace_id: "acme" }) });
    await useMeetingStore.getState().startMeetingFlow("t", "online", "team_meeting", { workspaceId: "acme" });
    expect(toasts().some((t) => /not filed in a workspace/.test(t))).toBe(false);
  });
});
describe("the Start dialog keeps its buttons in view", () => {
  it("only the body scrolls: Start and Remember sit in a fixed footer, Workspace and Scenario come first", () => {
    render(<MeetingSetupModal open workspaceId="acme" onStart={() => {}} onCancel={() => {}} />);
    const start = screen.getByRole("button", { name: "Start Meeting" });
    expect(start.closest(".overflow-y-auto")).toBeNull();
    const remember = screen.getByRole("checkbox", { name: /Remember these settings/ });
    expect(remember.closest(".overflow-y-auto")).toBeNull();
    const workspace = screen.getByRole("radiogroup", { name: "Workspace" });
    const scenario = screen.getByText("Scenario");
    const audio = screen.getByText("Audio mode");
    expect(workspace.closest(".overflow-y-auto")).not.toBeNull();
    // Workspace, then Scenario, then Audio mode.
    expect(workspace.compareDocumentPosition(scenario) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(scenario.compareDocumentPosition(audio) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("with many workspaces the picker is one searchable field, and Also use scrolls in its own box", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ws({ id: `w${i}`, name: `Workspace ${i}`, is_default: false }));
    seedWorkspaces([GEN, ...many], "w3");
    const onStart = vi.fn();
    render(<MeetingSetupModal open workspaceId="w3" onStart={onStart} onCancel={() => {}} />);
    expect(screen.queryByRole("radiogroup", { name: "Workspace" })).toBeNull();
    const field = screen.getByRole("combobox", { name: "Workspace" });
    expect(field).toHaveTextContent("Workspace 3");
    await userEvent.click(field);
    await userEvent.keyboard("Workspace 17");
    await userEvent.click(await screen.findByRole("option", { name: /Workspace 17/ }));
    expect(screen.getByText("Goes to Workspace 17")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Also use" }).querySelector(".max-h-28")).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Start Meeting" }));
    expect(onStart).toHaveBeenCalledWith("online", expect.any(String), { workspaceId: "w17", borrowed: [] });
  });
});


describe("the AI recap count in Edit workspace", () => {
  function Opener() {
    const a = useWorkspaceActions();
    return <button onClick={() => a.edit("acme")}>edit</button>;
  }
  const open = async (status: Record<string, unknown>) => {
    mockBackend({ get_workspace: detailOf(ACME, [], ""), list_workspaces: [GEN, ACME, BIO], get_index_status: status });
    render(
      <WorkspaceActionsProvider>
        <Opener />
      </WorkspaceActionsProvider>,
    );
    await userEvent.click(screen.getByText("edit"));
    return screen.findByRole("dialog", { name: /Settings for Acme/ });
  };
  const base = { workspace_id: "acme", state: "idle", done: 0, total: 0, passages: 0, skipped: [], last_indexed_at: null };

  it("says how many meetings have one, in the singular and the plural", async () => {
    let dialog = await open({ ...base, ai_recaps: 12 });
    expect(await within(dialog).findByText("12 meetings have an AI recap.")).toBeInTheDocument();
    cleanup();
    dialog = await open({ ...base, ai_recaps: 1 });
    expect(await within(dialog).findByText("1 meeting has an AI recap.")).toBeInTheDocument();
    cleanup();
    dialog = await open({ ...base, ai_recaps: 0 });
    expect(await within(dialog).findByText("No meeting here has an AI recap yet.")).toBeInTheDocument();
  });

  it("says nothing about a count an older backend does not give", async () => {
    const dialog = await open(base);
    await within(dialog).findByRole("switch", { name: /Prepare recaps with AI/ });
    expect(within(dialog).queryByText(/AI recap\./)).toBeNull();
    expect(recapCountLine(undefined)).toBeNull();
  });
});
