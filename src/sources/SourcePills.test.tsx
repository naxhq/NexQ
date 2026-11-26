import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionStatus, AssistSources } from "../lib/types";

const saved = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({
    get: async (k: string) => saved.get(k),
    set: async (k: string, v: unknown) => void saved.set(k, v),
    onKeyChange: async () => () => {},
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

const ipc = vi.hoisted(() => ({ retrySourcesSession: vi.fn(), getAgentSessions: vi.fn(), getAssistSources: vi.fn() }));
vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  ...ipc,
}));

import { SourcePills } from "./SourcePills";
import { useSourcesStore } from "../stores/sourcesStore";
import { agentSessionKey, useAgentStore } from "../stores/agentStore";
import { useAssistSourcesStore } from "../stores/assistSourcesStore";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { EMPTY_USAGE } from "../lib/agentUsage";

/** What the meeting's own workspace holds. */
const held = (over: Partial<AssistSources> = {}): AssistSources => ({
  workspace_id: "w1",
  documents: 3,
  notes: 1,
  folders: [{ label: "DePaul vault", used: true }],
  servers: [{ label: "mira", allowed_tools: 9, total_tools: 19, usable: true }],
  ...over,
});

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

/** The backend answers with `info` for the running meeting m1. */
function setUp(info: AssistSources = held()) {
  ipc.getAssistSources.mockResolvedValue(info);
  useAssistSourcesStore.setState({ info: { m1: info }, pills: {} });
  useSourcesStore.setState({ toggles: { library: true, tools: true } });
}

beforeEach(() => {
  vi.clearAllMocks();
  saved.clear();
  ipc.getAgentSessions.mockResolvedValue([]);
  ipc.retrySourcesSession.mockResolvedValue(undefined);
  useConfigStore.setState({ llmProvider: "claude_cli" });
  useMeetingStore.setState({ activeMeeting: { id: "m1" } as never });
  useAgentStore.setState({ sessions: {} });
  setUp();
});

afterEach(() => {
  cleanup();
  useMeetingStore.setState({ activeMeeting: null });
});

describe("SourcePills", () => {
  it("both pills start on in a meeting, and clicking one flips it for this meeting only", () => {
    render(<SourcePills scope="live" />);
    const knowledge = screen.getByRole("switch", { name: "Knowledge" });
    expect(knowledge).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "Tools" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(knowledge);
    expect(screen.getByRole("switch", { name: "Knowledge" })).toHaveAttribute("aria-checked", "false");
    expect(useAssistSourcesStore.getState().pills.m1).toEqual({ library: false, tools: true });
    expect(useAssistSourcesStore.getState().pills.m2).toBeUndefined();
    fireEvent.click(screen.getByRole("switch", { name: "Knowledge" }));
    expect(useAssistSourcesStore.getState().pills.m1.library).toBe(true);
  });

  it("an off pill is a plain outline chip: opted out of the switch track, muted opaque text", () => {
    useAssistSourcesStore.setState({ pills: { m1: { library: false, tools: false } } });
    render(<SourcePills scope="live" />);
    for (const name of ["Knowledge", "Tools"]) {
      const pill = screen.getByRole("switch", { name });
      expect(pill).toHaveAttribute("aria-checked", "false");
      expect(pill).toHaveAttribute("data-chip");
      expect(pill.className).toContain("text-muted-foreground");
      expect(pill.className).not.toMatch(/text-muted-foreground\/\d/);
      expect(pill.className).not.toContain("bg-accent ");
    }
  });

  it("two quick clicks on different pills both count", () => {
    render(<SourcePills scope="live" />);
    const knowledge = screen.getByRole("switch", { name: "Knowledge" });
    const tools = screen.getByRole("switch", { name: "Tools" });
    act(() => {
      knowledge.click();
      tools.click();
    });
    expect(useAssistSourcesStore.getState().pills.m1).toEqual({ library: false, tools: false });
  });

  it("what the card says is also read out, and no pill has a native title", () => {
    render(<SourcePills scope="live" />);
    const knowledge = screen.getByRole("switch", { name: "Knowledge" });
    expect(knowledge).toHaveAttribute("aria-description", "Knowledge: 3 documents, 1 note, 1 folder (DePaul vault)");
    expect(knowledge).not.toHaveAttribute("title");
    expect(screen.getByRole("switch", { name: "Tools" })).not.toHaveAttribute("title");
  });

  it("a pill shows only when this meeting's workspace holds something of its kind, whatever else is saved", () => {
    setUp(held({ servers: [] }));
    const { rerender } = render(<SourcePills scope="live" />);
    expect(screen.getByRole("switch", { name: "Knowledge" })).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Tools" })).toBeNull();
    setUp(held({ documents: 0, notes: 0, folders: [] }));
    rerender(<SourcePills scope="live" />);
    expect(screen.queryByRole("switch", { name: "Knowledge" })).toBeNull();
    expect(screen.getByRole("switch", { name: "Tools" })).toBeInTheDocument();
  });

  it("shows nothing when the workspace holds neither, or before it is known", () => {
    setUp(held({ documents: 0, notes: 0, folders: [], servers: [] }));
    const { container, rerender } = render(<SourcePills scope="live" />);
    expect(container).toBeEmptyDOMElement();
    useAssistSourcesStore.setState({ info: {} });
    ipc.getAssistSources.mockReturnValue(new Promise(() => {}));
    rerender(<SourcePills scope="live" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("Knowledge works with an API provider; Tools is shown but cannot be switched on, with the reason", async () => {
    useConfigStore.setState({ llmProvider: "openai" });
    render(<SourcePills scope="live" />);
    expect(screen.getByRole("switch", { name: "Knowledge" })).toHaveAttribute("aria-checked", "true");
    const tools = screen.getByRole("switch", { name: "Tools" });
    expect(tools).toHaveAttribute("aria-disabled", "true");
    expect(tools).toHaveAttribute("aria-checked", "false");
    fireEvent.click(tools);
    expect(useAssistSourcesStore.getState().pills.m1).toBeUndefined();
    expect(tools.getAttribute("aria-description")).toMatch(/Claude, Codex or Antigravity subscription/);
    await userEvent.hover(tools);
    expect(await screen.findByRole("tooltip", {}, { timeout: 2000 })).toHaveTextContent(/Switch provider in Settings/);
  });

  it("the hover card names what is covered in this workspace, what on and off do, and the provider's limit", async () => {
    useWorkspaceStore.setState({ workspaces: [{ id: "w1", name: "Acme" } as never] });
    render(<SourcePills scope="live" />);
    await userEvent.hover(screen.getByRole("switch", { name: "Knowledge" }));
    const card = await screen.findByRole("tooltip", {}, { timeout: 2000 });
    expect(card).toHaveTextContent("Knowledge");
    expect(card).toHaveTextContent("Acme");
    expect(card).toHaveTextContent("3 documents, 1 note, 1 folder (DePaul vault)");
    expect(card).toHaveTextContent(/On.*can use/);
    expect(card).toHaveTextContent(/Off.*Nothing .* is sent/);
    expect(card).toHaveTextContent(/Claude reads the folders' files itself/);
    await userEvent.unhover(screen.getByRole("switch", { name: "Knowledge" }));
    await userEvent.hover(screen.getByRole("switch", { name: "Tools" }));
    expect(await screen.findByRole("tooltip", {}, { timeout: 2000 })).toHaveTextContent("mira (9 of 19 tools)");
  });

  it("the card also opens on keyboard focus and closes with Escape", async () => {
    render(<SourcePills scope="live" />);
    await userEvent.tab();
    expect(screen.getByRole("switch", { name: "Knowledge" })).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Knowledge");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("reads the meeting's workspace from the backend, again when the Library changes", async () => {
    useAssistSourcesStore.setState({ info: {} });
    ipc.getAssistSources.mockResolvedValue(held({ documents: 5 }));
    render(<SourcePills scope="live" />);
    await waitFor(() => expect(ipc.getAssistSources).toHaveBeenCalledWith("m1"));
    expect(await screen.findByRole("switch", { name: "Knowledge" })).toBeInTheDocument();
    expect(useAssistSourcesStore.getState().info.m1.documents).toBe(5);
  });

  it("an error shows the reason and a Retry that tries the session again", () => {
    setSessions(session({ state: "error", detail: "Mira did not start: spawn node ENOENT" }));
    render(<SourcePills scope="live" />);
    expect(screen.getByText("Mira did not start: spawn node ENOENT")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Knowledge" }).getAttribute("aria-description")).toContain("spawn node ENOENT");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(ipc.retrySourcesSession).toHaveBeenCalledTimes(1);
  });

  it("a ready session with a notice puts a warning on the pill with that text", () => {
    setSessions(session({ sources_notice: "Mira did not start, so its tools are not available" }));
    render(<SourcePills scope="live" />);
    expect(screen.getByRole("switch", { name: "Tools" }).getAttribute("aria-description")).toContain("Mira did not start, so its tools are not available");
    expect(screen.getByText("Mira did not start, so its tools are not available")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("a pill that is on loads while its session starts", () => {
    useAssistSourcesStore.setState({ pills: { m1: { library: true, tools: false } } });
    setSessions(session({ state: "starting" }));
    const { container } = render(<SourcePills scope="live" />);
    // Only the pill that is on spins.
    expect(container.querySelectorAll(".animate-spin")).toHaveLength(1);
  });

  it("past scope uses that meeting's own workspace and Deep session, not the live one", () => {
    useAssistSourcesStore.setState({ info: { m1: held(), p1: held({ documents: 0, notes: 0, folders: [], servers: [{ label: "other tools", allowed_tools: 1, total_tools: 1, usable: true }] }) } });
    setSessions(
      session({ state: "error", detail: "live trouble" }),
      session({ scope: "past", meeting_id: "p1", tier: "deep", state: "ready" }),
    );
    render(<SourcePills scope="past" meetingId="p1" />);
    expect(screen.queryByText("live trouble")).toBeNull();
    // that meeting's workspace holds tools but no Knowledge
    expect(screen.queryByRole("switch", { name: "Knowledge" })).toBeNull();
    expect(screen.getByRole("switch", { name: "Tools" })).toBeInTheDocument();
  });
});
