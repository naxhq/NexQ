import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({ load: async () => ({ get: async () => undefined, set: async () => {} }) }));

import { MemorySection } from "./MemorySection";
import { displayText, formatClock, oneLine, savedItems } from "./memoryDisplay";
import { SuggestFromMeeting } from "./SuggestFromMeeting";
import { useMemoryStore, type MemoryRow } from "./memoryStore";
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

describe("display helpers", () => {
  it("lists saved items newest first, without the suggestions", () => {
    const items = [
      row({ id: "a", kind: "decision", updated_at: 1 }),
      row({ id: "b", kind: "person", updated_at: 2 }),
      row({ id: "c", kind: "decision", updated_at: 5 }),
      row({ id: "d", status: "suggested", updated_at: 9 }),
    ];
    expect(savedItems(items).map((i) => i.id)).toEqual(["c", "b", "a"]);
  });
  it("formats the moment of a source", () => {
    expect(formatClock(65_000)).toBe("1:05");
    expect(formatClock(3_725_000)).toBe("1:02:05");
  });
  it("drops a leaked transcript label from what is shown, and only that", () => {
    expect(displayText("0:54 You  We agreed to ship in May.")).toBe("We agreed to ship in May.");
    expect(displayText("1:02:05 Them: Budget is 40k")).toBe("Budget is 40k");
    expect(displayText("[12:03] Speaker 2 - needs a visa")).toBe("needs a visa");
    expect(displayText("The 0:54 You said was early")).toBe("The 0:54 You said was early");
    expect(displayText("Ship at 10:30 on Friday")).toBe("Ship at 10:30 on Friday");
    expect(oneLine("0:54 You first line\nsecond   line")).toBe("first line second line");
  });
});

describe("MemorySection", () => {
  it("lists what is remembered as compact rows: a name, a kind tag and one line of text", async () => {
    mockBackend({
      list_memory: [
        row({ text: "The cap is 40k for the quarter.\n\nSecond paragraph that is long." }),
        row({ id: "p", kind: "person", title: "Priya Shah", text: "0:54 You  CFO at Acme", source_meeting: "hp", source_ms: 54_000 }),
      ],
    });
    render(<MemorySection workspaceId="acme" />);
    const list = await screen.findByRole("list", { name: "Memory items" });
    expect(screen.queryByRole("heading", { level: 4 })).toBeNull();
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    const priya = rows.find((r) => r.textContent?.includes("Priya Shah"))!;
    const cap = rows.find((r) => r.textContent?.includes("Budget cap"))!;
    expect(priya).toHaveTextContent("Person");
    expect(cap).toHaveTextContent("Fact");
    // The leaked "0:54 You" label is not shown; the stored text is not rewritten.
    expect(priya).toHaveTextContent("CFO at Acme");
    expect(priya).not.toHaveTextContent("0:54");
    expect(useMemoryStore.getState().byWorkspace.acme.find((m) => m.id === "p")!.text).toBe("0:54 You  CFO at Acme");
    // One line each: the long text is one flattened line in the row (the CSS truncates it).
    expect(within(cap).getByText(/The cap is 40k for the quarter\. Second paragraph/)).toBeInTheDocument();
    // Actions live in the menu, not as text links.
    expect(within(list).queryByRole("button", { name: /^(Edit|Forget)/ })).toBeNull();
  });

  it("opens an item to its whole text, with a chip that opens its meeting at that moment", async () => {
    mockBackend({ list_memory: [row({ text: "Full text.\n\nSecond paragraph.", source_meeting: "hp", source_ms: 54_000 })] });
    render(<MemorySection workspaceId="acme" />);
    await userEvent.click(await screen.findByRole("button", { name: "Budget cap, Fact" }));
    const dialog = await screen.findByRole("dialog", { name: "Budget cap" });
    expect(within(dialog).getByText(/Second paragraph/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "From Hiring panel · 0:54" }));
    expect(useMeetingStore.getState().selectedMeetingId).toBe("hp");
    expect(useMeetingStore.getState().selectedMeetingMoment?.ms).toBe(54_000);
    // Opening the meeting leaves the dialog.
    expect(screen.queryByRole("dialog", { name: "Budget cap" })).toBeNull();
  });

  it("says Added by you for what was typed in, and that chip is not a button", async () => {
    mockBackend({ list_memory: [row()] });
    render(<MemorySection workspaceId="acme" />);
    await userEvent.click(await screen.findByRole("button", { name: "Budget cap, Fact" }));
    const dialog = await screen.findByRole("dialog", { name: "Budget cap" });
    expect(within(dialog).getByText("Added by you")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /^From / })).toBeNull();
  });

  it("names the meeting generically when it is not among the recent ones, and leaves out a missing moment", async () => {
    mockBackend({ list_memory: [row({ source_meeting: "old", source_ms: null })] });
    render(<MemorySection workspaceId="acme" />);
    await userEvent.click(await screen.findByRole("button", { name: "Budget cap, Fact" }));
    expect(await screen.findByRole("button", { name: "From the meeting" })).toBeInTheDocument();
  });

  it("keeps its list to a fixed height, and from six items offers Show all with a search", async () => {
    const many = Array.from({ length: 9 }, (_, n) => row({ id: `m${n}`, title: `Item ${n}`, text: n === 7 ? "needle in here" : "plain", updated_at: 100 - n }));
    mockBackend({ list_memory: many });
    render(<MemorySection workspaceId="acme" />);
    const list = await screen.findByRole("list", { name: "Memory items" });
    expect(list.parentElement!.style.maxHeight).toBe("15.5rem");
    expect(list.parentElement).toHaveClass("overflow-y-auto");
    await userEvent.click(screen.getByRole("button", { name: "Show all 9 memory items" }));
    const dialog = await screen.findByRole("dialog", { name: "Memory" });
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(9);
    const search = within(dialog).getByRole("searchbox", { name: "Search memory" });
    await userEvent.type(search, "needle");
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(1);
    await userEvent.clear(search);
    await userEvent.type(search, "zzz");
    expect(within(dialog).getByText("Nothing matches that.")).toBeInTheDocument();
  });

  it("opens an item from the Show all dialog, one dialog at a time", async () => {
    const many = Array.from({ length: 7 }, (_, n) => row({ id: `m${n}`, title: `Item ${n}`, updated_at: 100 - n }));
    mockBackend({ list_memory: many });
    render(<MemorySection workspaceId="acme" />);
    await userEvent.click(await screen.findByRole("button", { name: "Show all 7 memory items" }));
    const all = await screen.findByRole("dialog", { name: "Memory" });
    await userEvent.click(within(all).getByRole("button", { name: "Item 3, Fact" }));
    expect(await screen.findByRole("dialog", { name: "Item 3" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Memory" })).toBeNull();
  });

  it("has no Show all for a short list", async () => {
    mockBackend({ list_memory: [row()] });
    render(<MemorySection workspaceId="acme" />);
    await screen.findByRole("list", { name: "Memory items" });
    expect(screen.queryByRole("button", { name: /^Show all/ })).toBeNull();
  });

  it("adds an item as saved, with a new id", async () => {
    const b = mockBackend({ list_memory: [] });
    render(<MemorySection workspaceId="acme" />);
    await userEvent.click(await screen.findByRole("button", { name: "Add to memory" }));
    await userEvent.type(await screen.findByRole("textbox", { name: "Title" }), "Kickoff");
    await userEvent.type(screen.getByRole("textbox", { name: "What to remember" }), "Starts on the 3rd");
    const dialog = await screen.findByRole("dialog", { name: "Add to memory" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Add" }));
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
    await userEvent.click(await screen.findByRole("button", { name: "Actions for Budget cap" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    const text = await screen.findByRole("textbox", { name: "What to remember" });
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
    await userEvent.click(await screen.findByRole("button", { name: "Actions for Budget cap" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Forget" }));
    expect(b.called("delete_memory")).toHaveLength(0);
    const confirm = await screen.findByRole("alertdialog");
    await userEvent.click(within(confirm).getByRole("button", { name: "Forget" }));
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
    // The long help is one hover or Tab away, not a paragraph under the switch.
    expect(screen.queryByText(/in up to 4 calls/)).toBeNull();
    await userEvent.hover(screen.getByRole("button", { name: "About suggesting after meetings" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(/in up to 4 calls .*It proposes up to 8 items/);
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
