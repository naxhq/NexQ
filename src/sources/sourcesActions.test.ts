import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "../lib/types";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));
const ipc = vi.hoisted(() => ({ setPersonalSources: vi.fn() }));
vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  ...ipc,
}));

import { applyCheckResult, patchMcpServer } from "./sourcesActions";
import { DEFAULT_SOURCES_CONFIG, useSourcesStore } from "../stores/sourcesStore";

const tool = (name: string, allowed: boolean) => ({ name, full_name: `mcp__m__${name}`, allowed });
const ok = { ok: true, tool_count: 2, error: null, checked_at_ms: 5 };
const server = (over: Partial<McpServer> = {}): McpServer => ({
  id: "s1",
  key: "m",
  label: "M",
  transport: { type: "stdio", command: "node", args: ["m.js"] },
  enabled: false,
  env: [],
  tools: [],
  last_check: null,
  needs_sign_in: false,
  ...over,
});
const saved = () => useSourcesStore.getState().config.mcp_servers;

beforeEach(() => {
  ipc.setPersonalSources.mockResolvedValue(undefined);
  useSourcesStore.setState({ config: { ...DEFAULT_SOURCES_CONFIG, mcp_servers: [server()] }, pushError: null });
});

describe("applyCheckResult", () => {
  it("keeps the current switches and takes the tool list and status", async () => {
    // The Check started on a copy with no tools; meanwhile the user switched it on
    // and a tool is already known and switched off.
    await patchMcpServer("s1", (s) => ({ ...s, enabled: true, tools: [tool("get", false)] }));
    const result = server({ tools: [tool("get", true), tool("put", false)], last_check: ok });
    await applyCheckResult(result);
    const now = saved()[0];
    expect(now.enabled).toBe(true);
    expect(now.tools).toEqual([tool("get", false), tool("put", false)]);
    expect(now.last_check).toEqual(ok);
  });

  it("takes the answer when the saved copy has the same settings in another key order", async () => {
    // A config read back from disk has its keys sorted; the backend's answer doesn't.
    const fromDisk = {
      ...server(),
      transport: { args: ["m.js"], command: "node", type: "stdio" },
      env: [{ name: "A", secret: false, value: "1" }],
    } as unknown as McpServer;
    useSourcesStore.setState({ config: { ...DEFAULT_SOURCES_CONFIG, mcp_servers: [fromDisk] } });
    await applyCheckResult(
      server({ env: [{ name: "A", value: "1", secret: false }], tools: [tool("get", true)], last_check: ok }),
    );
    expect(saved()[0].last_check).toEqual(ok);
    expect(saved()[0].tools.map((t) => t.name)).toEqual(["get"]);
  });

  it("drops tools that vanished and keeps the tools of a failed Check", async () => {
    await patchMcpServer("s1", (s) => ({ ...s, tools: [tool("old", true), tool("get", true)] }));
    await applyCheckResult(server({ tools: [tool("get", true)], last_check: ok }));
    expect(saved()[0].tools.map((t) => t.name)).toEqual(["get"]);
    const failed = { ok: false, tool_count: 0, error: "The server failed to start.", checked_at_ms: 6 };
    await applyCheckResult(server({ tools: [], last_check: failed }));
    expect(saved()[0].tools.map((t) => t.name)).toEqual(["get"]);
    expect(saved()[0].last_check).toEqual(failed);
  });

  it("is dropped when the command, address or variables changed meanwhile, or the server is gone", async () => {
    await patchMcpServer("s1", (s) => ({ ...s, transport: { type: "stdio", command: "node", args: ["other.js"] } }));
    await applyCheckResult(server({ tools: [tool("get", true)], last_check: ok }));
    expect(saved()[0].tools).toEqual([]);
    expect(saved()[0].last_check).toBeNull();

    await patchMcpServer("s1", (s) => ({ ...s, transport: { type: "stdio", command: "node", args: ["m.js"] }, env: [{ name: "A", value: "1", secret: false }] }));
    await applyCheckResult(server({ tools: [tool("get", true)], last_check: ok }));
    expect(saved()[0].last_check).toBeNull();

    useSourcesStore.setState({ config: { ...DEFAULT_SOURCES_CONFIG, mcp_servers: [] } });
    await applyCheckResult(server({ last_check: ok }));
    expect(saved()).toEqual([]);
  });
});
