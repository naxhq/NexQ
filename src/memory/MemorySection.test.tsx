import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({ load: async () => ({ get: async () => undefined, set: async () => {} }) }));

import { MemorySection, formatClock } from "./MemorySection";
import { SuggestFromMeeting } from "./SuggestFromMeeting";
import { groupSaved, useMemoryStore, type MemoryRow } from "./memoryStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { detailOf, meeting, mockBackend, seedWorkspaces, ws } from "../workspace/testUtils";

const row = (over: Partial<MemoryRow> = {}): MemoryRow => ({
  id: "m1",
  workspace_id: "acme",
  kind: "fact",
  title: "Budget cap",
  text: "The cap is 40k for the quarter.",
  source_meeting: null,
  source_ms: null,
  status: "saved",
  created_at: 1,
  updated_at: 1,
  ...over,
});

const ACME = ws({ id: "acme", name: "Acme", is_default: false });

beforeEach(() => {
  seedWorkspaces([ws(), ACME], "acme");
  useMemoryStore.setState({ byWorkspace: {}, loadError: {}, suggest: {} });
  useMeetingStore.setState({ recentMeetings: [meeting({ id: "hp", title: "Hiring panel" })] });
});
afterEach(() => cleanup());

describe("grouping", () => {
  it("groups saved items by kind in reading order, newest first, and filters by search", () => {
    const items = [
      row({ id: "a", kind: "decision", title: "Ship in May", text: "x", updated_at: 1 }),
      row({ id: "b", kind: "person", title: "Priya Shah", text: "CFO", updated_at: 2 }),
      row({ id: "c", kind: "decision", title: "Hire two", text: "y", updated_at: 5 }),
      row({ id: "d", status: "suggested" }),
    ];
    const g = groupSaved(items, "");
    expect(g.map((x) => x.plural)).toEqual(["People", "Decisions"]);
    expect(g[1].items.map((i) => i.id)).toEqual(["c", "a"]);
    expect(groupSaved(items, "cfo").map((x) => x.items.map((i) => i.id))).toEqual([["b"]]);
  });
  it("formats the moment of a source", () => {
    expect(formatClock(65_000)).toBe("1:05");
    expect(formatClock(3_725_000)).toBe("1:02:05");
  });
});

describe("MemorySection", () => {
  it("lists what is remembered like an index, with a link to its meeting", async () => {
    mockBackend({
      list_memory: [row({ source_meeting: "hp", source_ms: 125_000 }), row({ id: "p", kind: "person", title: "Priya Shah", text: "CFO" })],
    });
    render(<MemorySection workspaceId="acme" />);
    expect(await screen.findByRole("heading", { level: 4, name: "People" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 4, name: "Facts" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "From Hiring panel at 2:05" }));
    expect(useMeetingStore.getState().selectedMeetingId).toBe("hp");
  });

  it("adds an item as saved, with a new id", async () => {
    const b = mockBackend({ list_memory: [] });
    render(<MemorySection workspaceId="acme" />);
    await userEvent.click(await screen.findByRole("button", { name: "Add to memory" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Title" }), "Kickoff");
    await userEvent.type(screen.getByRole("textbox", { name: "What to remember" }), "Starts on the 3rd");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(b.called("create_memory")).toHaveLength(1));
    expect(b.called("create_memory")[0].args.input).toMatchObject({ workspace_id: "acme", kind: "fact", title: "Kickoff", status: "saved" });
  });

  it("edits in place, and refuses to bring back what was forgotten meanwhile", async () => {
    let list = [row()];
    const b = mockBackend({
      list_memory: () => list,
      update_memory: () => {
        throw "not_found";
      },
    });
    render(<MemorySection workspaceId="acme" />);
    await userEvent.click(await screen.findByRole("button", { name: "Edit Budget cap" }));
    const text = screen.getByRole("textbox", { name: "What to remember" });
    await userEvent.clear(text);
    await userEvent.type(text, "Now 50k");
    list = []; // forgotten in another window
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/forgotten in the meantime/);
    expect(b.called("update_memory")).toHaveLength(1);
    expect(b.called("create_memory")).toHaveLength(0);
  });

  it("forgets after a second click", async () => {
    const b = mockBackend({ list_memory: [row()], delete_memory: null });
    render(<MemorySection workspaceId="acme" />);
    await userEvent.click(await screen.findByRole("button", { name: "Forget Budget cap" }));
    expect(b.called("delete_memory")).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Forget" }));
    await waitFor(() => expect(b.called("delete_memory")[0]?.args).toMatchObject({ id: "m1" }));
    await waitFor(() => expect(screen.queryByText("Budget cap")).toBeNull());
  });

  it("shows suggestions from a meeting, flags what the transcript does not support, and saves only what was reviewed", async () => {
    const sugg = [
      row({ id: "s1", status: "suggested", title: "Offer sent", text: "Sent Friday", source_meeting: "hp" }),
      row({ id: "s2", status: "suggested", title: "Start date", text: "June 1", source_meeting: "hp", unsupported: true }),
    ];
    const b = mockBackend({ list_memory: sugg, resolve_memory: null });
    render(<MemorySection workspaceId="acme" />);
    const tray = await screen.findByRole("group", { name: "Suggestions" });
    expect(within(tray).getByText("2 suggestions from Hiring panel")).toBeInTheDocument();
    expect(within(tray).getByRole("note")).toHaveTextContent("Not found in the transcript");
    const all = within(tray).getByRole("button", { name: /Save all reviewed/ });
    expect(all).toBeDisabled();
    await userEvent.click(within(tray).getByRole("checkbox", { name: "Reviewed: Offer sent" }));
    await userEvent.click(within(tray).getByRole("button", { name: "Save all reviewed (1)" }));
    await waitFor(() => expect(b.called("resolve_memory")).toHaveLength(1));
    expect(b.called("resolve_memory")[0].args).toMatchObject({ id: "s1", action: "save" });
  });

  it("edits a suggestion before saving it, and dismisses another", async () => {
    const b = mockBackend({ list_memory: [row({ id: "s1", status: "suggested", title: "Offer sent", text: "Sent Friday" })], resolve_memory: null });
    render(<MemorySection workspaceId="acme" />);
    const tray = await screen.findByRole("group", { name: "Suggestions" });
    await userEvent.click(within(tray).getByRole("button", { name: "Edit" }));
    const text = within(tray).getByRole("textbox", { name: "What to remember" });
    await userEvent.clear(text);
    await userEvent.type(text, "Sent Monday");
    await userEvent.click(within(tray).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(b.called("resolve_memory")[0]?.args).toMatchObject({ id: "s1", action: "save", patch: { text: "Sent Monday", title: "Offer sent" } }));
  });

  it("dismisses a suggestion", async () => {
    const b = mockBackend({ list_memory: [row({ id: "s1", status: "suggested" })], resolve_memory: null });
    render(<MemorySection workspaceId="acme" />);
    await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(b.called("resolve_memory")[0]?.args).toMatchObject({ id: "s1", action: "dismiss" }));
  });

  it("turns Suggest after meetings on for the workspace and says what it sends and to which model", async () => {
    const b = mockBackend({ list_memory: [], update_workspace: detailOf(ACME), list_workspaces: [ws(), ACME] });
    useWorkspaceStore.setState({ details: { acme: detailOf(ACME) } });
    render(<MemorySection workspaceId="acme" />);
    const sw = await screen.findByRole("switch", { name: /Suggest after meetings/ });
    expect(screen.getByText(/in up to 4 calls .*It proposes up to 8 items/)).toBeInTheDocument();
    await userEvent.click(sw);
    await waitFor(() => expect(b.called("update_workspace")[0]?.args).toMatchObject({ id: "acme", patch: { suggest_memory: true } }));
  });

  it("says it is empty, and says nothing was found, and says what failed with a way on", async () => {
    mockBackend({ list_memory: [] });
    render(<MemorySection workspaceId="acme" />);
    expect(await screen.findByText(/Nothing remembered yet/)).toBeInTheDocument();
    useMemoryStore.setState({ suggest: { acme: { status: "none", meetingId: "hp" } } });
    expect(await screen.findByText(/Nothing new to remember was found/)).toBeInTheDocument();
    useMemoryStore.setState({ suggest: { acme: { status: "failed", meetingId: "hp", error: "The model is not set up" } } });
    expect(await screen.findByRole("alert")).toHaveTextContent(/The model is not set up/);
    expect(screen.getByText(/Check the AI model in Settings/)).toBeInTheDocument();
    useMemoryStore.setState({ suggest: { acme: { status: "running", meetingId: "hp" } } });
    expect(await screen.findByRole("status")).toHaveTextContent(/Reading the meeting/);
  });

  it("reloads when memory changes elsewhere", async () => {
    const b = mockBackend({ list_memory: [] });
    render(<MemorySection workspaceId="acme" />);
    await waitFor(() => expect(b.called("list_memory").length).toBeGreaterThan(0));
    const { emit } = await import("@tauri-apps/api/event");
    const before = b.called("list_memory").length;
    await emit("memory_changed", { workspace_id: "acme" });
    await waitFor(() => expect(b.called("list_memory").length).toBeGreaterThan(before));
  });
});

describe("Suggest from this meeting", () => {
  it("asks for suggestions for the meeting's workspace and tells how many are waiting", async () => {
    const b = mockBackend({
      suggest_memory: [row({ id: "s1", status: "suggested" }), row({ id: "s2", status: "suggested" })],
      list_memory: [],
    });
    render(<SuggestFromMeeting meetingId="hp" workspaceId="acme" />);
    await userEvent.click(screen.getByRole("button", { name: "Suggest from this meeting" }));
    await waitFor(() => expect(b.called("suggest_memory")[0]?.args).toMatchObject({ workspaceId: "acme", meetingId: "hp" }));
    await waitFor(() => expect(useMemoryStore.getState().suggest.acme).toMatchObject({ status: "done", count: 2 }));
  });

  it("records a failure with its reason", async () => {
    mockBackend({
      suggest_memory: () => {
        throw "No model set";
      },
    });
    render(<SuggestFromMeeting meetingId="hp" workspaceId="acme" />);
    await userEvent.click(screen.getByRole("button", { name: "Suggest from this meeting" }));
    await waitFor(() => expect(useMemoryStore.getState().suggest.acme).toMatchObject({ status: "failed", error: "No model set" }));
  });
});
