import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer, NotesFolderInfo, PersonalSourcesConfig } from "../lib/types";

const storeFlags = vi.hoisted(() => ({ failSet: false }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({
    set: async () => {
      if (storeFlags.failSet) throw new Error("disk full");
    },
    get: async () => undefined,
    onKeyChange: async () => () => {},
  }),
}));

const dialog = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => dialog);

const ipc = vi.hoisted(() => ({
  inspectNotesFolder: vi.fn(),
  setPersonalSources: vi.fn(),
  checkMcpServer: vi.fn(),
  deleteMcpSecrets: vi.fn(),
  importMcpServersJson: vi.fn(),
  saveMcpServerForm: vi.fn(),
  listClaudeCodeMcpServers: vi.fn(),
  importClaudeCodeMcpServers: vi.fn(),
}));
vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  ...ipc,
}));

import { PersonalSourcesEditor, SOURCES_GATING_LINE } from "./PersonalSourcesEditor";
import { DEFAULT_SOURCES_CONFIG, useSourcesStore } from "../stores/sourcesStore";
import { useConfigStore } from "../stores/configStore";
import { useToastStore } from "../stores/toastStore";

const info = (over: Partial<NotesFolderInfo> = {}): NotesFolderInfo => ({
  exists: true,
  md_count: 12,
  truncated: false,
  problem: null,
  ...over,
});

const server = (over: Partial<McpServer> = {}): McpServer => ({
  id: "s1",
  key: "mira",
  label: "Mira",
  transport: { type: "stdio", command: "node", args: ["m.js"] },
  enabled: false,
  env: [],
  tools: [],
  last_check: null,
  needs_sign_in: false,
  ...over,
});

function setConfig(c: Partial<PersonalSourcesConfig>) {
  useSourcesStore.setState({ config: { ...DEFAULT_SOURCES_CONFIG, mcp_notice_seen: true, ...c } });
}

beforeEach(() => {
  vi.clearAllMocks();
  ipc.inspectNotesFolder.mockResolvedValue(info());
  ipc.setPersonalSources.mockResolvedValue(undefined);
  ipc.deleteMcpSecrets.mockResolvedValue(undefined);
  ipc.checkMcpServer.mockImplementation(async (id: string) => server({ id }));
  storeFlags.failSet = false;
  useToastStore.setState({ toasts: [] });
  useConfigStore.setState({ llmProvider: "claude_cli" });
  useSourcesStore.setState({ config: DEFAULT_SOURCES_CONFIG, toggles: { notes: false, tools: false }, pushError: null });
});

afterEach(() => cleanup());

describe("PersonalSourcesEditor", () => {
  it("shows the gating line and keeps everything editable under another provider", () => {
    useConfigStore.setState({ llmProvider: "openai" });
    const { container } = render(<PersonalSourcesEditor variant="full" />);
    expect(screen.getByText(SOURCES_GATING_LINE)).toBeInTheDocument();
    expect(SOURCES_GATING_LINE).toBe("Personal sources work with the Claude subscription. Switch to it in LLM Providers to use them.");
    expect(screen.getByRole("button", { name: /add folder/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /add server/i })).toBeEnabled();
    const dimmed = container.querySelector(".opacity-60");
    expect(dimmed).not.toBeNull();
    expect(dimmed!.getAttribute("aria-describedby")).toBe(screen.getByText(SOURCES_GATING_LINE).id);
  });

  it("shows no gating line on the Claude subscription", () => {
    const { container } = render(<PersonalSourcesEditor variant="compact" />);
    expect(screen.queryByText(SOURCES_GATING_LINE)).toBeNull();
    expect(container.querySelector(".opacity-60")).toBeNull();
  });

  it("a missing folder says Folder not found and can't be switched on", async () => {
    ipc.inspectNotesFolder.mockResolvedValue(info({ exists: false, md_count: 0 }));
    setConfig({ notes_folders: [{ id: "f1", label: "Vault", path: "D:\\Gone", enabled: false }] });
    render(<PersonalSourcesEditor variant="full" />);
    expect(await screen.findByText("Folder not found")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Use Vault" })).toBeDisabled();
  });

  it("a saved folder shows its .md count", async () => {
    setConfig({ notes_folders: [{ id: "f1", label: "Vault", path: "D:\\Vault", enabled: true }] });
    render(<PersonalSourcesEditor variant="full" />);
    expect(await screen.findByText("12 notes")).toBeInTheDocument();
    expect(ipc.inspectNotesFolder).toHaveBeenCalledWith("D:\\Vault");
  });

  it("adding a folder through the picker saves a card with its .md count", async () => {
    dialog.open.mockResolvedValue("D:\\Notes\\@Vault");
    ipc.inspectNotesFolder.mockResolvedValue(info({ md_count: 7 }));
    render(<PersonalSourcesEditor variant="full" />);
    fireEvent.click(screen.getByRole("button", { name: /add folder/i }));
    expect(await screen.findByText("7 notes")).toBeInTheDocument();
    const folders = useSourcesStore.getState().config.notes_folders;
    expect(folders).toHaveLength(1);
    expect(folders[0]).toMatchObject({ label: "@Vault", path: "D:\\Notes\\@Vault", enabled: true });
    expect(ipc.setPersonalSources).toHaveBeenCalled();
  });

  it("a folder the backend refuses is not added and shows why", async () => {
    dialog.open.mockResolvedValue("C:\\Users\\me");
    ipc.inspectNotesFolder.mockResolvedValue(info({ problem: "That is your home folder. Pick a folder inside it." }));
    render(<PersonalSourcesEditor variant="full" />);
    fireEvent.click(screen.getByRole("button", { name: /add folder/i }));
    expect(await screen.findByText("That is your home folder. Pick a folder inside it.")).toBeInTheDocument();
    expect(useSourcesStore.getState().config.notes_folders).toHaveLength(0);
  });

  it("a folder with a problem that was saved earlier can't be switched on", async () => {
    ipc.inspectNotesFolder.mockResolvedValue(info({ problem: "NexQ's own files are not notes." }));
    setConfig({ notes_folders: [{ id: "f1", label: "Vault", path: "D:\\X", enabled: false }] });
    render(<PersonalSourcesEditor variant="full" />);
    expect(await screen.findByText("NexQ's own files are not notes.")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Use Vault" })).toBeDisabled();
  });

  it("a server can't be switched on before a successful Check, and shows N of M tools allowed after", async () => {
    setConfig({ mcp_servers: [server()] });
    ipc.checkMcpServer.mockResolvedValue(
      server({
        last_check: { ok: true, tool_count: 3, error: null, checked_at_ms: 1 },
        tools: [
          { name: "person_brief", full_name: "mcp__mira__person_brief", allowed: true },
          { name: "add_task", full_name: "mcp__mira__add_task", allowed: false },
          { name: "tasks", full_name: "mcp__mira__tasks", allowed: true },
        ],
      }),
    );
    render(<PersonalSourcesEditor variant="full" />);
    expect(screen.getByText("Not checked yet. Check it to switch it on")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Use Mira" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByText("Ready with 3 tools")).toBeInTheDocument();
    expect(screen.getByText("2 of 3 tools allowed")).toBeInTheDocument();
    expect(ipc.checkMcpServer).toHaveBeenCalledWith("s1");

    const sw = screen.getByRole("switch", { name: "Use Mira" });
    expect(sw).toBeEnabled();
    fireEvent.click(sw);
    await waitFor(() => expect(useSourcesStore.getState().config.mcp_servers[0].enabled).toBe(true));
  });

  it("a server that was just added is checked at once, its tools open, and it can then be switched on", async () => {
    ipc.importMcpServersJson.mockResolvedValue([server({ id: "n1", key: "notes", label: "Notes server", enabled: false })]);
    ipc.checkMcpServer.mockResolvedValue(
      server({
        id: "n1",
        key: "notes",
        label: "Notes server",
        last_check: { ok: true, tool_count: 2, error: null, checked_at_ms: 1 },
        tools: [
          { name: "get_note", full_name: "mcp__notes__get_note", allowed: true },
          { name: "delete_note", full_name: "mcp__notes__delete_note", allowed: false },
        ],
      }),
    );
    setConfig({});
    render(<PersonalSourcesEditor variant="full" />);
    fireEvent.click(screen.getByRole("button", { name: /add server/i }));
    fireEvent.change(screen.getByLabelText("Server JSON"), { target: { value: '{"mcpServers":{}}' } });
    fireEvent.click(screen.getByRole("button", { name: "Add servers" }));

    expect(await screen.findByText("Ready with 2 tools")).toBeInTheDocument();
    expect(ipc.checkMcpServer).toHaveBeenCalledWith("n1");
    // The list is already open, so what the AI may call is in front of the user.
    expect(screen.getByText("get_note")).toBeInTheDocument();
    expect(screen.getByText("delete_note")).toBeInTheDocument();
    const sw = screen.getByRole("switch", { name: "Use Notes server" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(sw).toBeEnabled();
  });

  it("a failed Check shows the error and keeps the server off", async () => {
    setConfig({ mcp_servers: [server()] });
    ipc.checkMcpServer.mockResolvedValue(server({ last_check: { ok: false, tool_count: 0, error: "spawn node ENOENT", checked_at_ms: 1 } }));
    render(<PersonalSourcesEditor variant="full" />);
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByText("Failed: spawn node ENOENT")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Failed: spawn node ENOENT");
    expect(screen.getByRole("switch", { name: "Use Mira" })).toBeDisabled();
  });

  it("flipping a tool switch saves it", async () => {
    setConfig({
      mcp_servers: [
        server({
          enabled: true,
          last_check: { ok: true, tool_count: 2, error: null, checked_at_ms: 1 },
          tools: [
            { name: "person_brief", full_name: "mcp__mira__person_brief", allowed: true },
            { name: "add_task", full_name: "mcp__mira__add_task", allowed: false },
          ],
        }),
      ],
    });
    render(<PersonalSourcesEditor variant="full" />);
    fireEvent.click(screen.getByText("1 of 2 tools allowed"));
    fireEvent.click(screen.getByRole("switch", { name: "Allow add_task" }));
    await waitFor(() =>
      expect(useSourcesStore.getState().config.mcp_servers[0].tools.map((t) => t.allowed)).toEqual([true, true]),
    );
    expect(await screen.findByText("2 of 2 tools allowed")).toBeInTheDocument();
    await waitFor(() => expect(ipc.setPersonalSources).toHaveBeenCalled());
  });

  it("a tool switched off while a Check runs stays off when the Check ends", async () => {
    const tools = [
      { name: "person_brief", full_name: "mcp__mira__person_brief", allowed: true },
      { name: "tasks", full_name: "mcp__mira__tasks", allowed: true },
    ];
    const known = { ok: true, tool_count: 2, error: null, checked_at_ms: 1 };
    setConfig({ mcp_servers: [server({ enabled: true, last_check: known, tools })] });
    let finish: (s: McpServer) => void = () => {};
    ipc.checkMcpServer.mockReturnValue(new Promise<McpServer>((resolve) => (finish = resolve)));
    render(<PersonalSourcesEditor variant="full" />);
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    // While it runs the user opens the list and switches a tool off.
    fireEvent.click(screen.getByText("2 of 2 tools allowed"));
    fireEvent.click(screen.getByRole("switch", { name: "Allow tasks" }));
    await waitFor(() => expect(useSourcesStore.getState().config.mcp_servers[0].tools[1].allowed).toBe(false));
    // The Check answers from the copy it started with: both tools still allowed.
    await act(async () => {
      finish(server({ enabled: true, last_check: { ...known, checked_at_ms: 2 }, tools }));
    });
    const now = useSourcesStore.getState().config.mcp_servers[0];
    expect(now.tools.map((t) => t.allowed)).toEqual([true, false]);
    expect(now.enabled).toBe(true);
    expect(now.last_check?.checked_at_ms).toBe(2);
  });

  it("an OAuth import is listed but can't be enabled", () => {
    setConfig({
      mcp_servers: [server({ needs_sign_in: true, last_check: { ok: true, tool_count: 1, error: null, checked_at_ms: 1 } })],
    });
    render(<PersonalSourcesEditor variant="full" />);
    expect(screen.getByText("Needs sign-in, not supported yet")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Use Mira" })).toBeDisabled();
  });

  it("removing a server forgets its secrets once the removal is saved, before the backend hears of it", async () => {
    setConfig({ mcp_servers: [server()] });
    render(<PersonalSourcesEditor variant="full" />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Mira" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm removing Mira" }));
    await waitFor(() => expect(useSourcesStore.getState().config.mcp_servers).toHaveLength(0));
    await waitFor(() => expect(ipc.setPersonalSources).toHaveBeenCalled());
    expect(ipc.deleteMcpSecrets).toHaveBeenCalledWith("s1");
    expect(ipc.deleteMcpSecrets.mock.invocationCallOrder[0]).toBeLessThan(ipc.setPersonalSources.mock.invocationCallOrder[0]);
  });

  it("a removal that can't be saved keeps the server, keeps its secrets and says so", async () => {
    storeFlags.failSet = true;
    setConfig({ mcp_servers: [server()] });
    render(<PersonalSourcesEditor variant="full" />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Mira" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm removing Mira" }));
    await waitFor(() => expect(useToastStore.getState().toasts.some((t) => t.type === "error")).toBe(true));
    expect(useToastStore.getState().toasts.find((t) => t.type === "error")?.message).toContain("Couldn't remove Mira: disk full");
    expect(ipc.deleteMcpSecrets).not.toHaveBeenCalled();
    expect(ipc.setPersonalSources).not.toHaveBeenCalled();
    expect(useSourcesStore.getState().config.mcp_servers.map((s) => s.id)).toEqual(["s1"]);
    expect(screen.getByText("Mira")).toBeInTheDocument();
  });

  it("the permission notice shows once, on the first server added", async () => {
    useSourcesStore.setState({ config: { ...DEFAULT_SOURCES_CONFIG, mcp_notice_seen: false } });
    ipc.importMcpServersJson.mockResolvedValue([server()]);
    render(<PersonalSourcesEditor variant="full" />);

    fireEvent.click(screen.getByRole("button", { name: /add server/i }));
    fireEvent.change(screen.getByLabelText("Server JSON"), { target: { value: '{"mcpServers":{}}' } });
    fireEvent.click(screen.getByRole("button", { name: "Add servers" }));

    const notice = await screen.findByRole("dialog", { name: "Before you switch tools on" });
    fireEvent.click(within(notice).getByRole("button", { name: "Got it" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(useSourcesStore.getState().config.mcp_notice_seen).toBe(true);

    // A second server does not bring it back.
    ipc.importMcpServersJson.mockResolvedValue([server({ id: "s2", key: "other", label: "Other" })]);
    fireEvent.click(screen.getByRole("button", { name: /add server/i }));
    fireEvent.change(screen.getByLabelText("Server JSON"), { target: { value: '{"mcpServers":{}}' } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add servers" }));
    });
    await waitFor(() => expect(useSourcesStore.getState().config.mcp_servers).toHaveLength(2));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the plain guide for each group", () => {
    render(<PersonalSourcesEditor variant="full" />);
    const links = screen.getAllByRole("button", { name: "How this works" });
    fireEvent.click(links[0]);
    expect(screen.getByRole("dialog", { name: "How notes folders work" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(links[1]);
    expect(screen.getByRole("dialog", { name: "How tools work" })).toBeInTheDocument();
  });

  it("shows the backend's refusal of the saved sources", () => {
    useSourcesStore.setState({ pushError: "Two servers use the key mira" });
    render(<PersonalSourcesEditor variant="full" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Two servers use the key mira");
  });
});
