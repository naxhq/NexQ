import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({ load: async () => ({ get: async () => undefined, set: async () => {}, onKeyChange: async () => () => {} }) }));

import { addMcpServers, addNotesFolder, explicitWorkspaceId, removeMcpServer, removeMcpServerDurably, removeNotesFolder } from "./sourcesActions";
import { useSourcesStore } from "../stores/sourcesStore";
import { useMeetingStore } from "../stores/meetingStore";
import { mockBackend, seedWorkspaces, ws } from "../workspace/testUtils";
import type { McpServer } from "../lib/types";

const server = (id: string): McpServer =>
  ({ id, key: id, label: id, transport: { type: "stdio", command: "x", args: [] }, enabled: true, env: [], tools: [], last_check: null, needs_sign_in: false }) as McpServer;

beforeEach(() => {
  seedWorkspaces([ws(), ws({ id: "acme", name: "Acme", is_default: false })], "acme");
  useMeetingStore.setState({ currentView: "launcher" });
  useSourcesStore.setState({ config: { notes_folders: [{ id: "f1", label: "n", path: "/n", enabled: true }], mcp_servers: [server("s1")], mcp_notice_seen: true } });
});

describe("personal sources and workspaces", () => {
  it("an added folder is filed in the open workspace, naming exactly its id", async () => {
    const b = mockBackend();
    await addNotesFolder({ id: "f2", label: "docs", path: "/docs", enabled: true });
    expect(b.called("set_personal_sources")[0].args.filing).toEqual({ workspace_id: "acme", items: [{ kind: "folder", ref_id: "f2" }] });
  });

  it("added servers are filed with their own ids only", async () => {
    const b = mockBackend();
    await addMcpServers([server("s2"), server("s3")]);
    expect(b.called("set_personal_sources")[0].args.filing).toEqual({
      workspace_id: "acme",
      items: [
        { kind: "server", ref_id: "s2" },
        { kind: "server", ref_id: "s3" },
      ],
    });
  });

  it("the same server added in a second workspace stays one server in Settings and is linked in both libraries", async () => {
    const b = mockBackend();
    // The backend finds the second add is the first one and hands that server back.
    const mira = server("mira-id");
    const first = await addMcpServers([mira], "acme");
    const second = await addMcpServers([{ ...mira }], "general");
    expect(first).toEqual([]);
    expect(second.map((s) => s.id)).toEqual(["mira-id"]);
    expect(useSourcesStore.getState().config.mcp_servers.filter((s) => s.id === "mira-id")).toHaveLength(1);
    const filings = b.called("set_personal_sources").map((c) => c.args.filing);
    expect(filings).toEqual([
      { workspace_id: "acme", items: [{ kind: "server", ref_id: "mira-id" }] },
      { workspace_id: "general", items: [{ kind: "server", ref_id: "mira-id" }] },
    ]);
  });

  it("a folder at a path Settings already has is linked, not added again", async () => {
    const b = mockBackend();
    await addNotesFolder({ id: "new", label: "n", path: "/N/", enabled: true });
    expect(useSourcesStore.getState().config.notes_folders).toHaveLength(1);
    expect(b.called("set_personal_sources")[0].args.filing).toEqual({ workspace_id: "acme", items: [{ kind: "folder", ref_id: "f1" }] });
  });

  it("from Settings an add goes to the default workspace", async () => {
    useMeetingStore.setState({ currentView: "settings" });
    expect(explicitWorkspaceId()).toBe("general");
    const b = mockBackend();
    await addNotesFolder({ id: "f9", label: "x", path: "/x", enabled: true });
    expect((b.called("set_personal_sources")[0].args.filing as { workspace_id: string }).workspace_id).toBe("general");
  });

  it("edits and startup pushes carry no filing", async () => {
    const b = mockBackend();
    await useSourcesStore.getState().setConfig(useSourcesStore.getState().config);
    expect("filing" in b.called("set_personal_sources")[0].args).toBe(false);
  });

  it("removing a folder or server tells the backend after the new config was sent", async () => {
    const b = mockBackend();
    await removeNotesFolder("f1");
    await removeMcpServer("s1");
    const order = b.calls.map((c) => c.cmd).filter((c) => c === "set_personal_sources" || c === "remove_library_item");
    expect(order).toEqual(["set_personal_sources", "remove_library_item", "set_personal_sources", "remove_library_item"]);
    expect(b.called("remove_library_item")[0].args).toMatchObject({ kind: "folder", refId: "f1" });
    expect(b.called("remove_library_item")[1].args).toMatchObject({ kind: "server", refId: "s1" });
  });

  it("the durable removal also does", async () => {
    const b = mockBackend();
    await removeMcpServerDurably("s1");
    expect(b.called("remove_library_item")[0].args).toMatchObject({ kind: "server", refId: "s1" });
  });
});
