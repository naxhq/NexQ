import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import {
  askMeeting,
  checkMcpServer,
  classifySecretNames,
  discardPendingMcpServers,
  deleteMcpSecrets,
  importClaudeCodeMcpServers,
  importMcpServersJson,
  inspectNotesFolder,
  listClaudeCodeMcpServers,
  openSourceFile,
  retrySourcesSession,
  saveMcpServerForm,
  setPersonalSources,
} from "./ipc";
import type { McpServer, McpServerForm } from "./types";

const server: McpServer = {
  id: "i",
  key: "mira",
  label: "Mira",
  transport: { type: "stdio", command: "node", args: ["s.js"] },
  enabled: true,
  env: [],
  tools: [],
  last_check: null,
  needs_sign_in: false,
};

describe("personal sources ipc", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
  });

  it("checks a saved server by id, or a draft form", async () => {
    await checkMcpServer("i");
    expect(invoke).toHaveBeenLastCalledWith("check_mcp_server", { serverId: "i", draft: null });
    const draft: McpServerForm = { id: null, key: null, label: "M", transport: server.transport, env: [], headers: [] };
    await checkMcpServer(null, draft);
    expect(invoke).toHaveBeenLastCalledWith("check_mcp_server", { serverId: null, draft });
  });

  it("sends camelCase argument names for the Rust snake_case ones", async () => {
    await importMcpServersJson("{}");
    expect(invoke).toHaveBeenLastCalledWith("import_mcp_servers_json", { json: "{}" });
    await importClaudeCodeMcpServers(["x"]);
    expect(invoke).toHaveBeenLastCalledWith("import_claude_code_mcp_servers", { names: ["x"] });
    const form: McpServerForm = {
      id: null,
      key: null,
      label: "Mira",
      transport: server.transport,
      env: [{ name: "API_KEY", value: "k" }],
      headers: [],
    };
    await saveMcpServerForm(form);
    expect(invoke).toHaveBeenLastCalledWith("save_mcp_server_form", { form });
  });

  it("saves the sources and asks a meeting with or without pills", async () => {
    const config = { notes_folders: [], mcp_servers: [server], mcp_notice_seen: false };
    await setPersonalSources(config);
    expect(invoke).toHaveBeenLastCalledWith("set_personal_sources", { config });
    await askMeeting("m", "q", "r");
    expect(invoke).toHaveBeenLastCalledWith("ask_meeting", { meetingId: "m", question: "q", requestId: "r" });
    await askMeeting("m", "q", "r", { notes: true, tools: true });
    expect(invoke).toHaveBeenLastCalledWith("ask_meeting", {
      meetingId: "m",
      question: "q",
      requestId: "r",
      sources: { notes: true, tools: true },
    });
  });

  it("uses the command names the backend registers", async () => {
    await inspectNotesFolder("D:/v");
    expect(invoke).toHaveBeenLastCalledWith("inspect_notes_folder", { path: "D:/v" });
    await listClaudeCodeMcpServers();
    expect(invoke).toHaveBeenLastCalledWith("list_claude_code_mcp_servers");
    await deleteMcpSecrets("i");
    expect(invoke).toHaveBeenLastCalledWith("delete_mcp_secrets", { serverId: "i" });
    await classifySecretNames(["API_KEY"]);
    expect(invoke).toHaveBeenLastCalledWith("classify_secret_names", { names: ["API_KEY"] });
    await discardPendingMcpServers(["i"]);
    expect(invoke).toHaveBeenLastCalledWith("discard_pending_mcp_servers", { ids: ["i"] });
    await retrySourcesSession();
    expect(invoke).toHaveBeenLastCalledWith("retry_sources_session");
    await openSourceFile("D:/v/a.md");
    expect(invoke).toHaveBeenLastCalledWith("open_source_file", { path: "D:/v/a.md" });
  });
});
