import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async () => ({ installed: true })));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { cliAgentStatus } from "./ipc";

describe("cliAgentStatus", () => {
  beforeEach(() => invoke.mockClear());
  it("asks plainly when a picker opens", async () => {
    await cliAgentStatus("claude_cli");
    expect(invoke).toHaveBeenCalledWith("cli_agent_status", { kind: "claude_cli" });
  });
  it("asks the backend to look again only for an explicit check", async () => {
    await cliAgentStatus("codex_cli", true);
    expect(invoke).toHaveBeenCalledWith("cli_agent_status", { kind: "codex_cli", refresh: true });
  });
});
