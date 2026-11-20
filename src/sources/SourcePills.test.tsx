import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionStatus, McpServer } from "../lib/types";

const saved = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({
    get: async (k: string) => saved.get(k),
    set: async (k: string, v: unknown) => void saved.set(k, v),
    onKeyChange: async () => () => {},
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

const ipc = vi.hoisted(() => ({ retrySourcesSession: vi.fn(), getAgentSessions: vi.fn() }));
vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  ...ipc,
}));

import { SourcePills } from "./SourcePills";
import { DEFAULT_SOURCES_CONFIG, useSourcesStore } from "../stores/sourcesStore";
import { agentSessionKey, useAgentStore } from "../stores/agentStore";
import { useConfigStore } from "../stores/configStore";
import { EMPTY_USAGE } from "../lib/agentUsage";

const server: McpServer = {
  id: "s1",
  key: "mira",
  label: "Mira",
  transport: { type: "stdio", command: "node", args: [] },
  enabled: true,
  env: [],
  tools: [{ name: "person_brief", full_name: "mcp__mira__person_brief", allowed: true }],
  last_check: { ok: true, tool_count: 1, error: null, checked_at_ms: 1 },
  needs_sign_in: false,
};

const session = (over: Partial<AgentSessionStatus> = {}): AgentSessionStatus => ({
  scope: "live",
  meeting_id: "m1",
  tier: "fast",
  state: "ready",
  model: "haiku",
  detail: null,
  error_kind: null,
  with_sources: true,
  sources_notice: null,
  usage: EMPTY_USAGE,
  ...over,
});

function setSessions(...list: AgentSessionStatus[]) {
  useAgentStore.setState({ sessions: Object.fromEntries(list.map((s) => [agentSessionKey(s), s])) });
}

function setUp(config: Partial<typeof DEFAULT_SOURCES_CONFIG> = {}) {
  useSourcesStore.setState({
    config: {
      ...DEFAULT_SOURCES_CONFIG,
      notes_folders: [
        { id: "f1", label: "DePaul vault", path: "D:\\V", enabled: true },
        { id: "f2", label: "Team wiki", path: "D:\\W", enabled: true },
      ],
      mcp_servers: [server],
      ...config,
    },
    toggles: { notes: false, tools: false },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  saved.clear();
  ipc.getAgentSessions.mockResolvedValue([]);
  ipc.retrySourcesSession.mockResolvedValue(undefined);
  useConfigStore.setState({ llmProvider: "claude_cli" });
  useAgentStore.setState({ sessions: {} });
  setUp();
});

afterEach(() => cleanup());

describe("SourcePills", () => {
  it("clicking a pill flips it and saves it", async () => {
    render(<SourcePills scope="live" />);
    const notes = screen.getByRole("switch", { name: "Notes" });
    expect(notes).toHaveAttribute("aria-checked", "false");
    fireEvent.click(notes);
    expect(screen.getByRole("switch", { name: "Notes" })).toHaveAttribute("aria-checked", "true");
    expect(useSourcesStore.getState().toggles).toEqual({ notes: true, tools: false });
    await waitFor(() => expect(saved.get("sourceToggles")).toEqual({ notes: true, tools: false }));
    fireEvent.click(screen.getByRole("switch", { name: "Notes" }));
    expect(useSourcesStore.getState().toggles.notes).toBe(false);
  });

  it("two quick clicks on different pills both count", () => {
    render(<SourcePills scope="live" />);
    const notes = screen.getByRole("switch", { name: "Notes" });
    const tools = screen.getByRole("switch", { name: "Tools" });
    // Both clicks land before React renders again, as with a fast double click.
    act(() => {
      notes.click();
      tools.click();
    });
    expect(useSourcesStore.getState().toggles).toEqual({ notes: true, tools: true });
  });

  it("what a pill's tooltip says is also read out, not only in the title", () => {
    render(<SourcePills scope="live" />);
    const notes = screen.getByRole("switch", { name: "Notes" });
    const described = notes.getAttribute("aria-describedby");
    expect(described).toBeTruthy();
    expect(document.getElementById(described!)?.textContent).toBe("Notes: DePaul vault, Team wiki");
  });

  it("a pill shows only for a kind that has something enabled", () => {
    setUp({ mcp_servers: [] });
    render(<SourcePills scope="live" />);
    expect(screen.getByRole("switch", { name: "Notes" })).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Tools" })).toBeNull();
  });

  it("shows nothing off the Claude subscription, or with nothing set up", () => {
    useConfigStore.setState({ llmProvider: "openai" });
    const { container, rerender } = render(<SourcePills scope="live" />);
    expect(container).toBeEmptyDOMElement();
    useConfigStore.setState({ llmProvider: "claude_cli" });
    setUp({ notes_folders: [], mcp_servers: [] });
    rerender(<SourcePills scope="live" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("the tooltip names what is behind the pill", () => {
    render(<SourcePills scope="live" />);
    expect(screen.getByRole("switch", { name: "Notes" })).toHaveAttribute("title", "Notes: DePaul vault, Team wiki");
    expect(screen.getByRole("switch", { name: "Tools" })).toHaveAttribute("title", "Tools: Mira");
  });

  it("an error shows the reason and a Retry that tries the session again", () => {
    setSessions(session({ state: "error", detail: "Mira did not start: spawn node ENOENT" }));
    render(<SourcePills scope="live" />);
    expect(screen.getByText("Mira did not start: spawn node ENOENT")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Notes" }).getAttribute("title")).toContain("spawn node ENOENT");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(ipc.retrySourcesSession).toHaveBeenCalledTimes(1);
  });

  it("a ready session with a notice puts a warning on the pill with that text", () => {
    setSessions(session({ sources_notice: "Mira did not start, so its tools are not available" }));
    render(<SourcePills scope="live" />);
    expect(screen.getByRole("switch", { name: "Tools" }).getAttribute("title")).toContain(
      "Mira did not start, so its tools are not available",
    );
    expect(screen.getByText("Mira did not start, so its tools are not available")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("a pill that is on loads while its session starts", () => {
    useSourcesStore.setState({ toggles: { notes: true, tools: false } });
    setSessions(session({ state: "starting" }));
    const { container } = render(<SourcePills scope="live" />);
    // Only the pill that is on spins.
    expect(container.querySelectorAll(".animate-spin")).toHaveLength(1);
  });

  it("past scope follows that meeting's Deep session, not the live one", () => {
    setSessions(
      session({ state: "error", detail: "live trouble" }),
      session({ scope: "past", meeting_id: "p1", tier: "deep", state: "ready" }),
    );
    render(<SourcePills scope="past" meetingId="p1" />);
    expect(screen.queryByText("live trouble")).toBeNull();
    expect(screen.getByRole("switch", { name: "Notes" })).toBeInTheDocument();
  });
});
