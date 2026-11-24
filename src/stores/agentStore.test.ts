import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeCliStatus, ClaudeModelInfo, CliAgentKind } from "../lib/types";

vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));

const ipc = vi.hoisted(() => ({
  cliAgentStatus: vi.fn(),
  cliAgentModels: vi.fn(),
  getAgentSessions: vi.fn(),
}));
vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  cliAgentStatus: (kind: string) => ipc.cliAgentStatus(kind),
  cliAgentModels: (...a: unknown[]) => ipc.cliAgentModels(...a),
  getAgentSessions: () => ipc.getAgentSessions(),
}));

import { refreshCliModelsOnStart, resetAgentStoreForTests, useAgentStore } from "./agentStore";
import { useConfigStore } from "./configStore";

const NOT_INSTALLED: ClaudeCliStatus = { installed: false, binary_path: null, version: null, auth: null, npm_only: false, required_version: null };
const LOGGED_IN: ClaudeCliStatus = {
  installed: true,
  binary_path: "agent.exe",
  version: "1.0.0",
  auth: { logged_in: true, auth_method: "chatgpt", subscription_type: "plus", email: null, login: "subscription" },
  npm_only: false, required_version: null,
};
const LOGGED_OUT: ClaudeCliStatus = {
  ...LOGGED_IN,
  auth: { logged_in: false, auth_method: "none", subscription_type: null, email: null, login: "logged_out" },
};

function model(value: string): ClaudeModelInfo {
  return {
    value,
    resolved_model: value,
    display_name: value,
    description: "",
    supports_effort: false,
    effort_levels: [],
  };
}

function statuses(map: Partial<Record<CliAgentKind, ClaudeCliStatus>>) {
  ipc.cliAgentStatus.mockImplementation(async (kind: CliAgentKind) => map[kind] ?? NOT_INSTALLED);
}

const modelCalls = () => ipc.cliAgentModels.mock.calls.map(([kind, refresh]) => [kind, refresh]);

describe("agentStore: per-agent status and models", () => {
  beforeEach(() => {
    resetAgentStoreForTests();
    useConfigStore.setState({ cliAgentModels: {} });
    ipc.cliAgentStatus.mockReset();
    ipc.cliAgentModels.mockReset().mockImplementation(async (kind: string) => [model(`${kind}-model`)]);
    ipc.getAgentSessions.mockReset().mockResolvedValue([]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("keeps each agent's status, check state and errors apart", async () => {
    ipc.cliAgentStatus.mockImplementation(async (kind: CliAgentKind) => {
      if (kind === "antigravity_cli") throw new Error("spawn failed");
      return kind === "codex_cli" ? LOGGED_IN : NOT_INSTALLED;
    });
    const store = useAgentStore.getState();
    await Promise.all([store.refreshStatus("codex_cli"), store.refreshStatus("antigravity_cli")]);
    const s = useAgentStore.getState();
    expect(s.statuses.codex_cli).toEqual(LOGGED_IN);
    expect(s.statuses.antigravity_cli).toBeUndefined();
    expect(s.statusErrors).toEqual({ antigravity_cli: "spawn failed" });
    expect(s.checking).toEqual({ codex_cli: false, antigravity_cli: false });
    expect(s.checkedAt.codex_cli).toBeDefined();
    expect(s.statuses.claude_cli).toBeUndefined();
  });

  it("concurrent checks of one agent share a single probe", async () => {
    statuses({ codex_cli: LOGGED_IN });
    const store = useAgentStore.getState();
    await Promise.all([store.refreshStatus("codex_cli"), store.refreshStatus("codex_cli")]);
    expect(ipc.cliAgentStatus).toHaveBeenCalledTimes(1);
  });

  it("stores each agent's refreshed model list under its own key", async () => {
    await useAgentStore.getState().refreshModels("codex_cli");
    expect(useConfigStore.getState().cliAgentModels).toEqual({ codex_cli: [model("codex_cli-model")] });
    expect(ipc.cliAgentModels).toHaveBeenCalledWith("codex_cli", true);
  });

  it("a failed refresh keeps the last good list and says why", async () => {
    useConfigStore.setState({ cliAgentModels: { codex_cli: [model("old")] } });
    ipc.cliAgentModels.mockRejectedValue(new Error("timed out"));
    await useAgentStore.getState().refreshModels("codex_cli");
    expect(useConfigStore.getState().cliAgentModels.codex_cli).toEqual([model("old")]);
    expect(useAgentStore.getState().modelsErrors).toEqual({ codex_cli: "timed out" });
    expect(useAgentStore.getState().modelsRefreshing.codex_cli).toBe(false);
  });

  describe("refreshCliModelsOnStart", () => {
    it("refreshes the model list of every installed and logged-in agent", async () => {
      statuses({ claude_cli: LOGGED_IN, antigravity_cli: LOGGED_IN, codex_cli: LOGGED_IN });
      refreshCliModelsOnStart();
      await vi.waitFor(() => expect(ipc.cliAgentModels).toHaveBeenCalledTimes(3));
      expect(modelCalls()).toEqual(
        expect.arrayContaining([
          ["claude_cli", true],
          ["antigravity_cli", true],
          ["codex_cli", true],
        ]),
      );
      await vi.waitFor(() =>
        expect(Object.keys(useConfigStore.getState().cliAgentModels).sort()).toEqual([
          "antigravity_cli",
          "claude_cli",
          "codex_cli",
        ]),
      );
    });

    it("skips an agent that is not installed or not logged in", async () => {
      statuses({ claude_cli: LOGGED_OUT, codex_cli: LOGGED_IN });
      refreshCliModelsOnStart();
      await vi.waitFor(() => expect(ipc.cliAgentModels).toHaveBeenCalledTimes(1));
      // Give the other two their chance to (wrongly) ask.
      await new Promise((r) => setTimeout(r, 20));
      expect(modelCalls()).toEqual([["codex_cli", true]]);
      // Their status is still known, for the tiles.
      expect(useAgentStore.getState().statuses.claude_cli).toEqual(LOGGED_OUT);
      expect(useAgentStore.getState().statuses.antigravity_cli).toEqual(NOT_INSTALLED);
    });

    it("skips an agent whose status check failed", async () => {
      ipc.cliAgentStatus.mockImplementation(async (kind: CliAgentKind) => {
        if (kind === "claude_cli") throw new Error("boom");
        return NOT_INSTALLED;
      });
      refreshCliModelsOnStart();
      await new Promise((r) => setTimeout(r, 20));
      expect(ipc.cliAgentModels).not.toHaveBeenCalled();
    });

    it("runs once per app start", async () => {
      statuses({ codex_cli: LOGGED_IN });
      refreshCliModelsOnStart();
      await vi.waitFor(() => expect(ipc.cliAgentModels).toHaveBeenCalledTimes(1));
      refreshCliModelsOnStart();
      await new Promise((r) => setTimeout(r, 20));
      expect(ipc.cliAgentStatus).toHaveBeenCalledTimes(3);
      expect(ipc.cliAgentModels).toHaveBeenCalledTimes(1);
    });
  });
});
