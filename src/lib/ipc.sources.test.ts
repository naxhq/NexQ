import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import {
  checkMcpServer,
  deleteMcpSecrets,
  importClaudeCodeMcpServers,
  importMcpServersJson,
  inspectNotesFolder,
  listClaudeCodeMcpServers,
  openSourceFile,
  saveMcpServerForm,
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

  it("checks a server through check_mcp_server", async () => {
    await checkMcpServer(server);
    expect(invoke).toHaveBeenCalledWith("check_mcp_server", { server });
  });

  it("sends camelCase argument names for the Rust snake_case ones", async () => {
    await importMcpServersJson("{}", ["a"]);
    expect(invoke).toHaveBeenLastCalledWith("import_mcp_servers_json", { json: "{}", takenKeys: ["a"] });
    await importClaudeCodeMcpServers(["x"], ["a"]);
    expect(invoke).toHaveBeenLastCalledWith("import_claude_code_mcp_servers", { names: ["x"], takenKeys: ["a"] });
    const form: McpServerForm = {
      id: null,
      key: null,
      label: "Mira",
      transport: server.transport,
      env: [{ name: "API_KEY", value: "k" }],
      headers: [],
    };
    await saveMcpServerForm(form, ["a"]);
    expect(invoke).toHaveBeenLastCalledWith("save_mcp_server_form", { form, takenKeys: ["a"] });
  });

  it("uses the command names the backend registers", async () => {
    await inspectNotesFolder("D:/v");
    expect(invoke).toHaveBeenLastCalledWith("inspect_notes_folder", { path: "D:/v" });
    await listClaudeCodeMcpServers();
    expect(invoke).toHaveBeenLastCalledWith("list_claude_code_mcp_servers");
    await deleteMcpSecrets(server);
    expect(invoke).toHaveBeenLastCalledWith("delete_mcp_secrets", { server });
    await openSourceFile("D:/v/a.md");
    expect(invoke).toHaveBeenLastCalledWith("open_source_file", { path: "D:/v/a.md" });
  });
});
