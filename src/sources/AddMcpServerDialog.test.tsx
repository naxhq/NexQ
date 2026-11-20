import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "../lib/types";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));

const ipc = vi.hoisted(() => ({
  setPersonalSources: vi.fn(),
  checkMcpServer: vi.fn(),
  importMcpServersJson: vi.fn(),
  saveMcpServerForm: vi.fn(),
  listClaudeCodeMcpServers: vi.fn(),
  importClaudeCodeMcpServers: vi.fn(),
  classifySecretNames: vi.fn(),
  discardPendingMcpServers: vi.fn(),
}));
vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  ...ipc,
}));

import { AddMcpServerDialog } from "./AddMcpServerDialog";
import { DEFAULT_SOURCES_CONFIG, useSourcesStore } from "../stores/sourcesStore";

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

const TOKEN = "tok-123-super-secret";

beforeEach(() => {
  vi.clearAllMocks();
  ipc.setPersonalSources.mockResolvedValue(undefined);
  ipc.discardPendingMcpServers.mockResolvedValue(undefined);
  // The backend's rule, as a stand-in.
  ipc.classifySecretNames.mockImplementation(async (names: string[]) => names.map((n) => /TOKEN|KEY/.test(n)));
  useSourcesStore.setState({ config: DEFAULT_SOURCES_CONFIG, pushError: null });
});

afterEach(() => cleanup());

describe("AddMcpServerDialog", () => {
  it("paste JSON with two servers adds both", async () => {
    ipc.importMcpServersJson.mockResolvedValue([server(), server({ id: "s2", key: "wiki", label: "Wiki" })]);
    const onClose = vi.fn();
    render(<AddMcpServerDialog onClose={onClose} />);
    fireEvent.change(screen.getByLabelText("Server JSON"), { target: { value: '{"mcpServers":{"mira":{},"wiki":{}}}' } });
    fireEvent.click(screen.getByRole("button", { name: "Add servers" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(ipc.importMcpServersJson).toHaveBeenCalledWith('{"mcpServers":{"mira":{},"wiki":{}}}');
    expect(useSourcesStore.getState().config.mcp_servers.map((s) => s.label)).toEqual(["Mira", "Wiki"]);
  });

  it("invalid JSON shows the parser error and adds nothing", async () => {
    ipc.importMcpServersJson.mockRejectedValue("That is not valid JSON: expected value at line 1");
    const onClose = vi.fn();
    render(<AddMcpServerDialog onClose={onClose} />);
    fireEvent.change(screen.getByLabelText("Server JSON"), { target: { value: "{oops" } });
    fireEvent.click(screen.getByRole("button", { name: "Add servers" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That is not valid JSON: expected value at line 1");
    expect(onClose).not.toHaveBeenCalled();
    expect(useSourcesStore.getState().config.mcp_servers).toHaveLength(0);
  });

  it("the form sends secret values to saveMcpServerForm and never into the store", async () => {
    ipc.saveMcpServerForm.mockResolvedValue(
      server({ env: [{ name: "API_TOKEN", value: null, secret: true }, { name: "REGION", value: "eu", secret: false }] }),
    );
    const onClose = vi.fn();
    render(<AddMcpServerDialog onClose={onClose} />);
    fireEvent.click(screen.getByRole("tab", { name: "Form" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Mira" } });
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "node" } });
    fireEvent.change(screen.getByLabelText(/Arguments/), { target: { value: "m.js\n--read-only\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Add variable" }));
    fireEvent.change(screen.getByLabelText("Environment variables name 1"), { target: { value: "API_TOKEN" } });
    const value = screen.getByLabelText("Environment variables value 1");
    expect(value).toHaveAttribute("type", "password");
    fireEvent.change(value, { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole("button", { name: "Add server" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());

    expect(ipc.saveMcpServerForm).toHaveBeenCalledTimes(1);
    const form = ipc.saveMcpServerForm.mock.calls[0][0];
    expect(form).toMatchObject({
      id: null,
      label: "Mira",
      transport: { type: "stdio", command: "node", args: ["m.js", "--read-only"] },
      env: [{ name: "API_TOKEN", value: TOKEN }],
    });
    expect(JSON.stringify(useSourcesStore.getState().config)).not.toContain(TOKEN);
    expect(useSourcesStore.getState().config.mcp_servers).toHaveLength(1);
  });

  it("the backend decides which variables are secret; unanswered ones stay hidden", async () => {
    render(<AddMcpServerDialog onClose={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: "Form" }));
    fireEvent.click(screen.getByRole("button", { name: "Add variable" }));
    fireEvent.change(screen.getByLabelText("Environment variables name 1"), { target: { value: "REGION" } });
    // Until the backend answers, the value is hidden.
    expect(screen.getByLabelText("Environment variables value 1")).toHaveAttribute("type", "password");
    await waitFor(() => expect(screen.getByLabelText("Environment variables value 1")).toHaveAttribute("type", "text"));
    expect(ipc.classifySecretNames).toHaveBeenCalledWith(["REGION"]);
    fireEvent.change(screen.getByLabelText("Environment variables name 1"), { target: { value: "API_KEY" } });
    await waitFor(() => expect(ipc.classifySecretNames).toHaveBeenCalledWith(["API_KEY"]));
    expect(screen.getByLabelText("Environment variables value 1")).toHaveAttribute("type", "password");
  });

  it("servers the webview could not save are given back to the backend", async () => {
    ipc.importMcpServersJson.mockResolvedValue([server()]);
    // The save of the config fails for good (the store throws).
    const realSetConfig = useSourcesStore.getState().setConfig;
    useSourcesStore.setState({ setConfig: () => Promise.reject(new Error("disk full")) });
    try {
      render(<AddMcpServerDialog onClose={() => {}} />);
      fireEvent.change(screen.getByLabelText("Server JSON"), { target: { value: "{}" } });
      fireEvent.click(screen.getByRole("button", { name: "Add servers" }));
      await waitFor(() => expect(ipc.discardPendingMcpServers).toHaveBeenCalledWith(["s1"]));
      expect(await screen.findByText("disk full")).toBeInTheDocument();
    } finally {
      useSourcesStore.setState({ setConfig: realSetConfig });
    }
  });

  it("an edit that needs the secrets again shows the reason next to the secret fields and keeps the dialog open", async () => {
    ipc.saveMcpServerForm.mockRejectedValue("Enter the secrets again: API_TOKEN");
    const onClose = vi.fn();
    const editing = server({ env: [{ name: "API_TOKEN", value: null, secret: true }] });
    useSourcesStore.setState({ config: { ...DEFAULT_SOURCES_CONFIG, mcp_servers: [editing] } });
    render(<AddMcpServerDialog editing={editing} onClose={onClose} />);

    const secret = screen.getByLabelText("Environment variables value 1");
    expect(secret).toHaveAttribute("placeholder", expect.stringContaining("Leave blank"));
    fireEvent.change(screen.getByLabelText(/Arguments/), { target: { value: "other.js" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Enter the secrets again: API_TOKEN");
    expect(screen.getByLabelText("Environment variables value 1")).toHaveAttribute("aria-invalid", "true");
    expect(ipc.saveMcpServerForm.mock.calls[0][0]).toMatchObject({ id: "s1", key: "mira" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("saving an edit replaces the server and keeps its place", async () => {
    const editing = server({ label: "Mira" });
    const other = server({ id: "s2", key: "wiki", label: "Wiki" });
    useSourcesStore.setState({ config: { ...DEFAULT_SOURCES_CONFIG, mcp_servers: [editing, other] } });
    ipc.saveMcpServerForm.mockResolvedValue({ ...editing, label: "Mira 2" });
    const onClose = vi.fn();
    render(<AddMcpServerDialog editing={editing} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Mira 2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(useSourcesStore.getState().config.mcp_servers.map((s) => s.label)).toEqual(["Mira 2", "Wiki"]);
  });

  it("Check these settings checks the unsaved form as a draft", async () => {
    ipc.checkMcpServer.mockResolvedValue(server({ last_check: { ok: true, tool_count: 4, error: null, checked_at_ms: 1 } }));
    render(<AddMcpServerDialog onClose={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: "Form" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Mira" } });
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "node" } });
    fireEvent.click(screen.getByRole("button", { name: "Check these settings" }));
    expect(await screen.findByText("Ready with 4 tools")).toBeInTheDocument();
    expect(screen.getByText("Ready with 4 tools")).toHaveAttribute("role", "status");
    expect(ipc.checkMcpServer).toHaveBeenCalledWith(null, expect.objectContaining({ label: "Mira" }));
  });

  it("Claude Code import lists servers, disables the ones that can't be imported and imports the picked ones", async () => {
    ipc.listClaudeCodeMcpServers.mockResolvedValue([
      { name: "notes", summary: "node n.js", transport: "stdio", needs_sign_in: false, unsupported: null },
      { name: "cloud", summary: "https://x.test/mcp", transport: "http", needs_sign_in: true, unsupported: null },
      { name: "legacy", summary: "sse", transport: "unsupported", needs_sign_in: false, unsupported: "Needs sign-in, not supported yet" },
    ]);
    ipc.importClaudeCodeMcpServers.mockResolvedValue([server({ id: "n1", key: "notes", label: "notes" })]);
    const onClose = vi.fn();
    render(<AddMcpServerDialog onClose={onClose} />);
    fireEvent.click(screen.getByRole("tab", { name: "Import from Claude Code" }));
    expect(await screen.findByLabelText("notes")).toBeEnabled();
    expect(screen.getByLabelText("legacy")).toBeDisabled();
    // The OAuth server is listed with its reason; the unsupported one gives its own.
    expect(screen.getAllByText("Needs sign-in, not supported yet")).toHaveLength(2);

    fireEvent.click(screen.getByLabelText("notes"));
    fireEvent.click(screen.getByRole("button", { name: "Import selected" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(ipc.importClaudeCodeMcpServers).toHaveBeenCalledWith(["notes"]);
    expect(useSourcesStore.getState().config.mcp_servers.map((s) => s.key)).toEqual(["notes"]);
  });
});
