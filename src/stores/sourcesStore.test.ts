// The sources store lives in each window and meets the other window in the
// plugin-store file (modelled as in aiActionsStore.crossWindow.test.ts: one
// shared map, and a write tells every window that listens for the key).

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer, PersonalSourcesConfig } from "../lib/types";

const saved = vi.hoisted(() => new Map<string, unknown>());
const keyListeners = vi.hoisted(() => [] as Array<{ key: string; cb: (v: unknown) => void }>);
const invokeCalls = vi.hoisted(() => [] as Array<{ cmd: string; args: unknown }>);
const backend = vi.hoisted(() => ({ reject: null as string | null, startingFor: 0 }));
const writes = vi.hoisted(() => ({ count: 0 }));

vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({
    get: async (key: string) => saved.get(key),
    set: async (key: string, value: unknown) => {
      writes.count += 1;
      const stored = structuredClone(value);
      saved.set(key, stored);
      for (const l of [...keyListeners]) if (l.key === key) l.cb(structuredClone(stored));
    },
    onKeyChange: async (key: string, cb: (v: unknown) => void) => {
      const listener = { key, cb };
      keyListeners.push(listener);
      return () => {
        const at = keyListeners.indexOf(listener);
        if (at >= 0) keyListeners.splice(at, 1);
      };
    },
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: unknown) => {
    invokeCalls.push({ cmd, args });
    if (cmd === "set_personal_sources" && backend.startingFor > 0) {
      backend.startingFor -= 1;
      throw "state not managed for field `state` on command `set_personal_sources`. You must call `.manage()` before using this command";
    }
    if (cmd === "set_personal_sources" && backend.reject) throw new Error(backend.reject);
    return null;
  }),
}));

type Mod = typeof import("./sourcesStore");

/** A window: a fresh module graph (its own store) that has started as App does. */
async function openWindow(): Promise<Mod & { setProvider: (p: string) => Promise<void> }> {
  vi.resetModules();
  const mod = await import("./sourcesStore");
  const { useConfigStore } = await import("./configStore");
  await mod.useSourcesStore.getState().load();
  return {
    ...mod,
    setProvider: async (p) => {
      useConfigStore.setState({ llmProvider: p as never });
    },
  };
}

const server = (over: Partial<McpServer> = {}): McpServer => ({
  id: "s1",
  key: "mira",
  label: "Mira",
  transport: { type: "stdio", command: "node", args: ["m.js"] },
  enabled: true,
  env: [{ name: "API_TOKEN", value: null, secret: true }],
  tools: [{ name: "person_brief", full_name: "mcp__mira__person_brief", allowed: true }],
  last_check: { ok: true, tool_count: 1, error: null, checked_at_ms: 1 },
  needs_sign_in: false,
  ...over,
});

const config = (over: Partial<PersonalSourcesConfig> = {}): PersonalSourcesConfig => ({
  notes_folders: [{ id: "f1", label: "Vault", path: "D:\\Vault", enabled: true }],
  mcp_servers: [server()],
  mcp_notice_seen: true,
  ...over,
});

const pushes = () => invokeCalls.filter((c) => c.cmd === "set_personal_sources");

beforeEach(() => {
  saved.clear();
  keyListeners.length = 0;
  invokeCalls.length = 0;
  backend.reject = null;
  backend.startingFor = 0;
  writes.count = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("sourcesStore", () => {
  it("an old config.json without the new keys loads empty sources and both pills off, and leaves other keys alone", async () => {
    saved.set("llmProvider", "claude_cli"); // nothing else
    const w = await openWindow();
    expect(w.useSourcesStore.getState().config).toEqual(w.DEFAULT_SOURCES_CONFIG);
    expect(w.useSourcesStore.getState().toggles).toEqual({ notes: false, tools: false });
    expect(saved.has("personalSources")).toBe(false); // loading never writes
    expect(saved.has("sourceToggles")).toBe(false);
    expect(saved.get("llmProvider")).toBe("claude_cli");
    expect(writes.count).toBe(0);
  });

  it("a partial saved config (older shape) gets the missing fields", async () => {
    saved.set("personalSources", {
      notes_folders: [{ id: "f1", path: "D:\\Vault" }],
    });
    const w = await openWindow();
    const c = w.useSourcesStore.getState().config;
    expect(c.mcp_servers).toEqual([]);
    expect(c.mcp_notice_seen).toBe(false);
    expect(c.notes_folders).toEqual([{ id: "f1", label: "D:\\Vault", path: "D:\\Vault", enabled: false }]);
  });

  it("a malformed entry is dropped instead of crashing, and a saved secret value never survives", async () => {
    saved.set("personalSources", {
      notes_folders: [null, 5, { id: "f1" }, { id: "f2", path: "D:\\V", enabled: true }],
      mcp_servers: [
        { id: "x" },
        { id: "s1", key: "k", transport: { type: "stdio", command: "n" }, env: [{ name: "A_KEY", secret: true, value: "leak" }] },
      ],
    });
    saved.set("sourceToggles", "nonsense");
    const w = await openWindow();
    const c = w.useSourcesStore.getState().config;
    expect(c.notes_folders.map((f) => f.id)).toEqual(["f2"]);
    expect(c.mcp_servers).toHaveLength(1);
    expect(c.mcp_servers[0].env[0].value).toBeNull();
    expect(c.mcp_servers[0].transport).toEqual({ type: "stdio", command: "n", args: [] });
    expect(w.useSourcesStore.getState().toggles).toEqual({ notes: false, tools: false });
  });

  it("pushes the config to the backend on load and on every change", async () => {
    saved.set("personalSources", config());
    const w = await openWindow();
    expect(pushes()).toHaveLength(1);
    expect((pushes()[0].args as { config: PersonalSourcesConfig }).config.notes_folders[0].id).toBe("f1");

    const next = config({ notes_folders: [] });
    await w.useSourcesStore.getState().setConfig(next);
    expect(pushes()).toHaveLength(2);
    expect((pushes()[1].args as { config: PersonalSourcesConfig }).config.notes_folders).toEqual([]);
    expect(saved.get("personalSources")).toEqual(next);
  });

  it("an old install pushes an empty config at startup without writing the file", async () => {
    await openWindow();
    expect(pushes()).toHaveLength(1);
    expect(writes.count).toBe(0);
  });

  it("waits for a backend that is still starting instead of showing its error", async () => {
    saved.set("personalSources", config({ mcp_servers: [server()] }));
    backend.startingFor = 2;
    const w = await openWindow();
    const pushes = invokeCalls.filter((c) => c.cmd === "set_personal_sources");
    expect(pushes).toHaveLength(3);
    expect(w.useSourcesStore.getState().pushError).toBeNull();
  });

  it("keeps the backend's refusal for the editor to show", async () => {
    const w = await openWindow();
    backend.reject = "Two servers use the key mira";
    await w.useSourcesStore.getState().setConfig(config());
    expect(w.useSourcesStore.getState().pushError).toBe("Two servers use the key mira");
    backend.reject = null;
    await w.useSourcesStore.getState().setConfig(config());
    expect(w.useSourcesStore.getState().pushError).toBeNull();
  });

  it("a pill flipped in the overlay reaches the launcher and the next start", async () => {
    const overlay = await openWindow();
    // The launcher is a second window with its own store, listening on the same file.
    const launcherListeners = keyListeners.length;
    vi.resetModules();
    const launcherMod = await import("./sourcesStore");
    await launcherMod.useSourcesStore.getState().load();
    expect(keyListeners.length).toBeGreaterThan(launcherListeners);

    overlay.useSourcesStore.getState().setToggles({ notes: true, tools: false });
    await vi.waitFor(() => expect(launcherMod.useSourcesStore.getState().toggles).toEqual({ notes: true, tools: false }));
    // Its own copy is not clobbered by the echo of its own save.
    expect(overlay.useSourcesStore.getState().toggles).toEqual({ notes: true, tools: false });

    const next = await openWindow();
    expect(next.useSourcesStore.getState().toggles).toEqual({ notes: true, tools: false });
  });

  it("a config changed in another window arrives here without telling the backend again", async () => {
    const a = await openWindow();
    vi.resetModules();
    const b = await import("./sourcesStore");
    await b.useSourcesStore.getState().load();
    const before = pushes().length;
    await a.useSourcesStore.getState().setConfig(config());
    await vi.waitFor(() => expect(b.useSourcesStore.getState().config.notes_folders).toHaveLength(1));
    // One push: the window that saved it. The receiving window only updated its copy.
    expect(pushes().length).toBe(before + 1);
  });

  it("two quick changes end on the later one, in this window and at the backend", async () => {
    const w = await openWindow();
    const first = w.useSourcesStore.getState().setConfig(config({ notes_folders: [] }));
    const second = w.useSourcesStore.getState().setConfig(config());
    await Promise.all([first, second]);
    expect(w.useSourcesStore.getState().config.notes_folders).toHaveLength(1);
    const last = pushes()[pushes().length - 1].args as { config: PersonalSourcesConfig };
    expect(last.config.notes_folders).toHaveLength(1);
  });

  it("enabledKinds: tools means an enabled, signed-in server with an allowed tool", async () => {
    const { enabledKinds } = await openWindow();
    expect(enabledKinds(config())).toEqual({ notes: true, tools: true });
    expect(enabledKinds(config({ notes_folders: [] }))).toEqual({ notes: false, tools: true });
    expect(enabledKinds(config({ mcp_servers: [server({ enabled: false })] })).tools).toBe(false);
    expect(enabledKinds(config({ mcp_servers: [server({ needs_sign_in: true })] })).tools).toBe(false);
    expect(
      enabledKinds(config({ mcp_servers: [server({ tools: [{ name: "x", full_name: "mcp__mira__x", allowed: false }] })] })).tools,
    ).toBe(false);
  });

  it("requestToggles is undefined off Claude and masks kinds with nothing enabled", async () => {
    const w = await openWindow();
    await w.useSourcesStore.getState().setConfig(config({ mcp_servers: [] }));
    w.useSourcesStore.getState().setToggles({ notes: true, tools: true });

    await w.setProvider("openai");
    expect(w.requestToggles()).toBeUndefined();

    await w.setProvider("claude_cli");
    expect(w.requestToggles()).toEqual({ notes: true, tools: false }); // no usable server behind Tools

    // Nothing set up at all: nothing to send.
    await w.useSourcesStore.getState().setConfig(config({ notes_folders: [], mcp_servers: [] }));
    expect(w.requestToggles()).toBeUndefined();
  });
});
