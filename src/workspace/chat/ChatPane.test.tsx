import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceChat, WorkspaceCitation, WorkspaceMessage } from "../../lib/types";

type Handler = (e: { payload: unknown }) => void;
const listeners = vi.hoisted(() => new Map<string, Set<(e: { payload: unknown }) => void>>());
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: Handler) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name)!.add(cb);
    return () => listeners.get(name)!.delete(cb);
  },
}));
const emit = (name: string, payload: unknown) => act(() => void listeners.get(name)?.forEach((cb) => cb({ payload })));

const ipc = vi.hoisted(() => ({
  listWorkspaceChats: vi.fn(),
  createWorkspaceChat: vi.fn(),
  updateWorkspaceChat: vi.fn(),
  deleteWorkspaceChat: vi.fn(),
  listWorkspaceMessages: vi.fn(),
  askWorkspace: vi.fn(),
  cancelWorkspaceRequest: vi.fn(),
  answerWorkspaceApproval: vi.fn(),
  previewChatContext: vi.fn(),
  setChatMeetingIncluded: vi.fn(),
  listWorkspaceMeetings: vi.fn(),
  listMemory: vi.fn(),
  getWorkspace: vi.fn(),
  saveAnswerToLibrary: vi.fn(),
  addAnswerToInstructions: vi.fn(),
  listModels: vi.fn(),
  getApiKey: vi.fn(),
  listChatMeetingPrefs: vi.fn(),
  setChatItemPref: vi.fn(),
  getChatCapabilities: vi.fn(),
  listChatItemPrefs: vi.fn(),
}));
vi.mock("../../lib/ipc", async (orig) => ({ ...(await orig<typeof import("../../lib/ipc")>()), ...ipc }));

import { ChatPane } from "./ChatPane";
import { VIRTUALISE_AFTER } from "./Transcript";
import { resetWorkspaceChatForTests, useWorkspaceChatStore } from "../../stores/workspaceChatStore";
import { FALLBACK_GENERAL, useWorkspaceStore } from "../../stores/workspaceStore";
import { useMeetingStore } from "../../stores/meetingStore";
import { useConfigStore } from "../../stores/configStore";

const WS = "w1";
const chat = (id: string, over: Partial<WorkspaceChat> = {}): WorkspaceChat => ({
  id,
  workspace_id: WS,
  title: "Pricing talk",
  provider: null,
  model: null,
  effort: null,
  depth: "balanced",
  include_meetings: true,
  condensed_upto: null,
  created_at: 1,
  updated_at: 1,
  ...over,
});
const cite: WorkspaceCitation = { tag: "S1", kind: "transcript", ref_id: "m1", sub_ref: null, title: "Weekly sync", start_ms: 75_000, snippet: "We agreed to ship Friday." };
const message = (id: number, role: "user" | "assistant", content: string, over: Partial<WorkspaceMessage> = {}): WorkspaceMessage => ({
  id,
  chat_id: "c1",
  role,
  content,
  model: role === "assistant" ? "claude-sonnet" : null,
  citations: [],
  context: null,
  input_tokens: 0,
  output_tokens: 0,
  created_at: id,
  ...over,
});
const pairs = (n: number): WorkspaceMessage[] =>
  Array.from({ length: n }, (_, i) => [message(i * 2 + 1, "user", `Question ${i + 1}`), message(i * 2 + 2, "assistant", `Answer ${i + 1}`)]).flat();

const report = { strategy: "ladder", depth: "balanced", budget: 24000, window: 200000, used: 1234, bars: [], omitted: 0, notices: [], estimate: true } as const;

function setup(opts: { chats?: WorkspaceChat[]; messages?: WorkspaceMessage[]; props?: Partial<React.ComponentProps<typeof ChatPane>> } = {}) {
  const chats = opts.chats ?? [];
  ipc.listWorkspaceChats.mockResolvedValue(chats);
  ipc.listWorkspaceMessages.mockResolvedValue(opts.messages ?? []);
  return render(<ChatPane workspaceId={WS} {...opts.props} />);
}

const typeQuestion = async (text: string) => {
  const box = await screen.findByRole("textbox", { name: /ask about this workspace/i });
  await userEvent.setup().click(box);
  fireEvent.change(box, { target: { value: text } });
  return box;
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  resetWorkspaceChatForTests();
  useMeetingStore.setState({ activeMeeting: null });
  useWorkspaceStore.setState({
    workspaces: [{ ...FALLBACK_GENERAL, id: WS, name: "Acme" }],
    details: {},
    revision: 0,
  });
  ipc.getWorkspace.mockResolvedValue({ ...FALLBACK_GENERAL, id: WS, name: "Acme", instructions: "", recaps_with_ai: false, suggest_memory: false, items: [] });
  ipc.listWorkspaceMeetings.mockResolvedValue({ meetings: [], total: 0 });
  ipc.listMemory.mockResolvedValue([]);
  ipc.previewChatContext.mockResolvedValue(report);
  ipc.updateWorkspaceChat.mockImplementation(async (id: string, p: object) => chat(id, p));
  ipc.createWorkspaceChat.mockImplementation(async () => chat("c1", { title: "New chat" }));
  ipc.askWorkspace.mockResolvedValue(undefined);
  ipc.listChatMeetingPrefs.mockRejectedValue(new Error("none"));
});
afterEach(cleanup);

describe("start state", () => {
  it("shows the workspace name, a focused composer and questions made from real data", async () => {
    ipc.listWorkspaceMeetings.mockResolvedValue({
      meetings: [{ id: "m1", title: "Pricing review", start_time: "2026-11-01T10:00:00Z", end_time: null, duration_seconds: 9, segment_count: 4, has_summary: false }],
      total: 1,
    });
    ipc.listMemory.mockResolvedValue([{ id: "p", workspace_id: WS, kind: "person", title: "Dana", text: "", source_meeting: null, source_ms: null, status: "saved", created_at: 1, updated_at: 1 }]);
    setup({ props: { startAction: <button>Start meeting</button> } });
    expect(await screen.findByRole("heading", { name: "Acme" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start meeting" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Pricing review/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Dana/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("textbox", { name: /ask about this workspace/i })).toHaveFocus());
  });

  it("an example fills the composer and does not send", async () => {
    ipc.listWorkspaceMeetings.mockResolvedValue({
      meetings: [{ id: "m1", title: "Kickoff", start_time: "2026-11-01T10:00:00Z", end_time: null, duration_seconds: 9, segment_count: 4, has_summary: false }],
      total: 1,
    });
    setup();
    await userEvent.setup().click(await screen.findByRole("button", { name: /Kickoff/ }));
    expect(screen.getByRole("textbox", { name: /ask about this workspace/i })).toHaveValue('What did we decide in "Kickoff"?');
    expect(ipc.askWorkspace).not.toHaveBeenCalled();
  });
});

describe("composer", () => {
  it("Enter sends in a new chat; Shift+Enter only adds a line", async () => {
    setup();
    const box = await typeQuestion("What is the plan?");
    await userEvent.setup().keyboard("{Shift>}{Enter}{/Shift}");
    expect(ipc.askWorkspace).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(ipc.askWorkspace).toHaveBeenCalled());
    expect(ipc.createWorkspaceChat).toHaveBeenCalledWith(WS);
    const [chatId, q, , deeper] = ipc.askWorkspace.mock.calls[0];
    expect(chatId).toBe("c1");
    expect(q).toBe("What is the plan?");
    expect(deeper).toBe(false);
    await waitFor(() => expect(box).toHaveValue(""));
  });

  it("shows the estimate from the backend, debounced", async () => {
    setup({ chats: [chat("c1")], messages: pairs(1) });
    await typeQuestion("Hello");
    expect(await screen.findByText("About 1.2k tokens of 24k", {}, { timeout: 2000 })).toBeInTheDocument();
    expect(ipc.previewChatContext).toHaveBeenCalledWith("c1", "Hello");
  });

  it("keeps a separate draft for each chat", async () => {
    setup({ chats: [chat("c1"), chat("c2", { title: "Hiring", updated_at: 0 })], messages: pairs(1) });
    const box = await typeQuestion("draft for pricing");
    await waitFor(() => expect(useWorkspaceChatStore.getState().drafts.c1).toBe("draft for pricing"));
    act(() => useWorkspaceChatStore.getState().selectChat(WS, "c2"));
    await waitFor(() => expect(box).toHaveValue(""));
    act(() => useWorkspaceChatStore.getState().selectChat(WS, "c1"));
    await waitFor(() => expect(box).toHaveValue("draft for pricing"));
  });

  it("says plainly that a plain provider can't use folders when the workspace has some", async () => {
    ipc.getWorkspace.mockResolvedValue({
      ...FALLBACK_GENERAL,
      id: WS,
      instructions: "",
      recaps_with_ai: false,
      suggest_memory: false,
      items: [{ workspace_id: WS, kind: "folder", ref_id: "f", label: "Notes", pinned: false }],
    });
    setup();
    expect(await screen.findByText(/can't open folders or use tools/i)).toBeInTheDocument();
  });

  it("notes a running meeting", async () => {
    useMeetingStore.setState({ activeMeeting: { id: "live" } as never });
    setup();
    expect(await screen.findByText(/A meeting is running/i)).toBeInTheDocument();
  });
});

describe("answers", () => {
  it("streams in place, then shows citations as chips that open the meeting at that moment", async () => {
    const onOpenMeeting = vi.fn();
    setup({ props: { onOpenMeeting } });
    const box = await typeQuestion("When do we ship?");
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(ipc.askWorkspace).toHaveBeenCalled());
    const requestId = ipc.askWorkspace.mock.calls[0][2] as string;
    emit("workspace_chat_start", { chat_id: "c1", request_id: requestId, model: "sonnet" });
    emit("workspace_chat_token", { chat_id: "c1", request_id: requestId, token: "Friday [S1]" });
    expect(await screen.findByText(/Friday/)).toBeInTheDocument();
    // Not a button while it is being written.
    expect(screen.queryByRole("button", { name: /Source S1/ })).toBeNull();
    const saved = message(2, "assistant", "Friday [S1]", { citations: [cite], input_tokens: 1500, output_tokens: 40 });
    ipc.listWorkspaceMessages.mockResolvedValue([message(1, "user", "When do we ship?"), saved]);
    emit("workspace_chat_end", { chat_id: "c1", request_id: requestId, cancelled: false, message: saved });
    const chip = await screen.findByRole("button", { name: "Source S1: Weekly sync at 1:15" });
    expect(screen.getByText("1.5k in, 40 out", { exact: false })).toBeInTheDocument();
    await userEvent.setup().click(chip);
    expect(onOpenMeeting).toHaveBeenCalledWith("m1", 75_000);
    // The tooltip names the meeting and the moment on keyboard focus.
    act(() => chip.focus());
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Weekly sync at 1:15");
  });

  it("an unknown citation stays as text", async () => {
    setup({ chats: [chat("c1")], messages: [message(1, "user", "Q"), message(2, "assistant", "See [S9].")] });
    expect(await screen.findByText("[S9]")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Source S9/ })).toBeNull();
  });

  it("lists sources and what the model did, on demand", async () => {
    const answer = message(2, "assistant", "Yes [S1]", { citations: [cite] });
    setup({ chats: [chat("c1")], messages: [message(1, "user", "Q"), answer] });
    const toggle = await screen.findByRole("button", { name: "1 source" });
    expect(screen.queryByRole("list", { name: "Sources" })).toBeNull();
    await userEvent.setup().click(toggle);
    expect(within(screen.getByRole("list", { name: "Sources" })).getByText("Weekly sync at 1:15")).toBeInTheDocument();
  });

  it("offers Search deeper when things didn't fit, and re-asks deeper", async () => {
    const r = { ...report, estimate: false, omitted: 2, bars: [{ id: "x", layer: "meetings", title: "Old", tokens: 9, relevance: 0.2, pinned: false, included: false }] };
    setup({ chats: [chat("c1")], messages: [message(1, "user", "Q1"), message(2, "assistant", "A1", { context: r as never })] });
    expect(await screen.findByText(/3 things didn't fit/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Search deeper" }));
    await waitFor(() => expect(ipc.askWorkspace).toHaveBeenCalledWith("c1", "Q1", expect.any(String), true));
  });

  it("copies the answer without its tags", async () => {
    setup({ chats: [chat("c1")], messages: [message(1, "user", "Q"), message(2, "assistant", "Done [S1].", { citations: [cite] })] });
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    await user.click(await screen.findByRole("button", { name: /Copy/ }));
    expect(writeText).toHaveBeenCalledWith("Done.");
  });

  it("never loads a remote image from an answer", async () => {
    setup({ chats: [chat("c1")], messages: [message(1, "user", "Q"), message(2, "assistant", "![chart](https://evil.example/x.png)")] });
    await screen.findByText(/\[Image: chart\]/);
    expect(document.querySelector("img")).toBeNull();
  });

  it("saves an answer to the library through a named dialog", async () => {
    ipc.saveAnswerToLibrary.mockResolvedValue("doc1");
    setup({ chats: [chat("c1")], messages: [message(1, "user", "What is the plan?"), message(2, "assistant", "The plan.")] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Save to library" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Document name")).toHaveValue("What is the plan?");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(ipc.saveAnswerToLibrary).toHaveBeenCalledWith(2, "What is the plan?", "The plan."));
  });

  it("shows the text that will be stored, cleans what must go, and stores exactly the reviewed text", async () => {
    ipc.saveAnswerToLibrary.mockResolvedValue("doc1");
    const zw = String.fromCharCode(0x200b);
    setup({ chats: [chat("c1")], messages: [message(1, "user", "Plan?"), message(2, "assistant", "Plan" + zw + " <b>A</b> [x](https://evil.example) [S1]")] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Save to library" }));
    const dialog = await screen.findByRole("dialog");
    const field = within(dialog).getByLabelText("Text to save") as HTMLTextAreaElement;
    expect(field.value).toBe("Plan A x");
    fireEvent.change(field, { target: { value: "Plan A x" + zw + "!" } });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(ipc.saveAnswerToLibrary).not.toHaveBeenCalled();
    expect(field.value).toBe("Plan A x!");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Some of it was removed");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(ipc.saveAnswerToLibrary).toHaveBeenCalledWith(2, "Plan?", "Plan A x!"));
  });
});

describe("errors and stopping", () => {
  async function ask(text = "Q") {
    const box = await typeQuestion(text);
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(ipc.askWorkspace).toHaveBeenCalled());
    return ipc.askWorkspace.mock.calls[ipc.askWorkspace.mock.calls.length - 1][2] as string;
  }

  it("shows the failure in place with fixes, never silently", async () => {
    setup();
    const id = await ask();
    emit("workspace_chat_error", { chat_id: "c1", request_id: id, error: "401 unauthorized: bad api key" });
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/didn't accept your sign-in/)).toBeInTheDocument();
    expect(within(alert).getByText(/bad api key/)).toBeInTheDocument();
    expect(within(alert).getByRole("button", { name: "Open provider settings" })).toBeInTheDocument();
    expect(within(alert).getByRole("button", { name: "Pick another model" })).toBeInTheDocument();
  });

  it("a command that rejects shows the error too, and Try again asks again", async () => {
    ipc.askWorkspace.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    setup();
    await ask("Again?");
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/Couldn't reach the model/)).toBeInTheDocument();
    ipc.askWorkspace.mockResolvedValue(undefined);
    await userEvent.setup().click(within(alert).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(ipc.askWorkspace).toHaveBeenCalledTimes(2));
  });

  it("Stop cancels that request and keeps what was written, marked as stopped", async () => {
    ipc.cancelWorkspaceRequest.mockResolvedValue(undefined);
    setup();
    const id = await ask();
    emit("workspace_chat_token", { chat_id: "c1", request_id: id, token: "Partial answer" });
    await screen.findByText("Partial answer");
    await userEvent.setup().click(screen.getByRole("button", { name: "Stop" }));
    expect(ipc.cancelWorkspaceRequest).toHaveBeenCalledWith(id);
    emit("workspace_chat_end", { chat_id: "c1", request_id: id, cancelled: true, message: message(0, "assistant", "Partial answer") });
    expect(await screen.findByText(/Stopped\./)).toBeInTheDocument();
    emit("workspace_chat_token", { chat_id: "c1", request_id: id, token: " late" });
    await new Promise((r) => setTimeout(r, 60));
    expect(screen.queryByText(/late/)).toBeNull();
    expect(screen.getByRole("button", { name: "Ask" })).toBeInTheDocument();
  });
});

describe("leaving and coming back", () => {
  it("an answer keeps streaming while the pane is gone", async () => {
    const view = setup();
    const box = await typeQuestion("Q");
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(ipc.askWorkspace).toHaveBeenCalled());
    const id = ipc.askWorkspace.mock.calls[0][2] as string;
    view.unmount();
    emit("workspace_chat_token", { chat_id: "c1", request_id: id, token: "Written while away" });
    await waitFor(() => expect(useWorkspaceChatStore.getState().sessions.c1.turn?.text).toBe("Written while away"));
    expect(ipc.cancelWorkspaceRequest).not.toHaveBeenCalled();
    ipc.listWorkspaceChats.mockResolvedValue([chat("c1")]);
    render(<ChatPane workspaceId={WS} />);
    expect(await screen.findByText("Written while away")).toBeInTheDocument();
  });
});

describe("tool approval", () => {
  it("asks with the exact arguments, and Allow once answers it", async () => {
    ipc.answerWorkspaceApproval.mockResolvedValue(undefined);
    setup();
    const box = await typeQuestion("Delete it");
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(ipc.askWorkspace).toHaveBeenCalled());
    const id = ipc.askWorkspace.mock.calls[0][2] as string;
    emit("workspace_chat_approval", { chat_id: "c1", request_id: id, approval_id: "ap1", server: "notes", tool: "delete_note", args: { id: 3 }, truncated: false });
    const card = await screen.findByRole("group", { name: /Needs your answer/ });
    expect(card).toHaveTextContent("delete_note");
    expect(card).toHaveTextContent("notes");
    expect(within(card).getByText(/Denied automatically in \d+ s/)).toBeInTheDocument();
    const user = userEvent.setup();
    expect(within(card).getByLabelText("Exact arguments")).toHaveTextContent('"id": 3');
    await user.click(within(card).getByRole("button", { name: "Allow once" }));
    await waitFor(() => expect(ipc.answerWorkspaceApproval).toHaveBeenCalledWith("ap1", true));
    expect(await screen.findByText("Allowed once.")).toBeInTheDocument();
  });

  it("says when arguments were cut and starts on Deny", async () => {
    setup();
    const box = await typeQuestion("x");
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(ipc.askWorkspace).toHaveBeenCalled());
    const id = ipc.askWorkspace.mock.calls[0][2] as string;
    (document.activeElement as HTMLElement | null)?.blur();
    emit("workspace_chat_approval", { chat_id: "c1", request_id: id, approval_id: "ap2", server: "s", tool: "t", args: "{...}", truncated: true });
    expect(await screen.findByText(/Not everything is shown/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Deny" })).toHaveFocus());
  });

  it("closes the card with the reason the backend gives", async () => {
    setup();
    const box = await typeQuestion("x");
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(ipc.askWorkspace).toHaveBeenCalled());
    const id = ipc.askWorkspace.mock.calls[0][2] as string;
    emit("workspace_chat_approval", { chat_id: "c1", request_id: id, approval_id: "ap3", server: "s", tool: "t", args: {} });
    await screen.findByRole("button", { name: "Allow once" });
    emit("workspace_chat_approval_closed", { chat_id: "c1", approval_id: "ap3", reason: "answered" });
    expect(await screen.findByText("Answered somewhere else.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
  });

  it("does not take focus from the composer while you type", async () => {
    setup();
    const box = await typeQuestion("x");
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(ipc.askWorkspace).toHaveBeenCalled());
    const id = ipc.askWorkspace.mock.calls[0][2] as string;
    box.focus();
    emit("workspace_chat_approval", { chat_id: "c1", request_id: id, approval_id: "ap4", server: "s", tool: "t", args: {} });
    await screen.findByRole("button", { name: "Allow once" });
    expect(box).toHaveFocus();
  });
});

describe("long chats", () => {
  it("windows a long conversation instead of drawing all of it", async () => {
    const n = VIRTUALISE_AFTER + 50;
    setup({ chats: [chat("c1")], messages: pairs(n) });
    await screen.findByRole("region", { name: "Conversation" });
    await waitFor(() => expect(document.querySelectorAll("[data-turn]").length).toBeGreaterThan(0));
    expect(document.querySelectorAll("[data-turn]").length).toBeLessThan(n);
  });

  it("hides condensed messages behind a marker you can open", async () => {
    setup({ chats: [chat("c1", { condensed_upto: 4 })], messages: pairs(4) });
    expect(await screen.findByText(/Earlier messages condensed/)).toBeInTheDocument();
    expect(screen.queryByText("Question 1")).toBeNull();
    expect(screen.getByText("Question 3")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Show 2 originals" }));
    expect(screen.getByText("Question 1")).toBeInTheDocument();
  });

  it("moves between answers with Alt and the arrow keys", async () => {
    setup({ chats: [chat("c1")], messages: pairs(3) });
    await screen.findByText("Question 3");
    const articles = () => Array.from(document.querySelectorAll<HTMLElement>("article[data-turn]"));
    act(() => articles()[2].focus());
    fireEvent.keyDown(articles()[2], { key: "ArrowUp", altKey: true });
    await waitFor(() => expect(articles()[1]).toHaveFocus());
    fireEvent.keyDown(articles()[1], { key: "ArrowUp" });
    await waitFor(() => expect(articles()[0]).toHaveFocus());
  });
});

describe("chats list", () => {
  it("searches, switches and renames", async () => {
    ipc.listWorkspaceMessages.mockImplementation(async (id: string) => (id === "c2" ? [message(1, "user", "Hiring Q", { chat_id: "c2" })] : pairs(1)));
    setup({ chats: [chat("c1"), chat("c2", { title: "Hiring plan", updated_at: 0 })] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Chats \(2\)/ }));
    const dialog = await screen.findByRole("dialog", { name: "Chats" });
    await user.type(within(dialog).getByRole("textbox", { name: "Search chats" }), "hir");
    expect(within(dialog).queryByText("Pricing talk")).toBeNull();
    await user.click(within(dialog).getByText("Hiring plan"));
    await waitFor(() => expect(useWorkspaceChatStore.getState().activeChat[WS]).toBe("c2"));
  });

  it("deletes only after a confirmation", async () => {
    ipc.deleteWorkspaceChat.mockResolvedValue(undefined);
    setup({ chats: [chat("c1"), chat("c2", { title: "Other", updated_at: 0 })], messages: pairs(1) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Chats \(2\)/ }));
    await user.click(await screen.findByRole("button", { name: "Delete Pricing talk" }));
    expect(ipc.deleteWorkspaceChat).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "Delete chat" }));
    await waitFor(() => expect(ipc.deleteWorkspaceChat).toHaveBeenCalledWith("c1"));
  });
});

describe("approval card, security", () => {
  async function card(args: unknown, extra: object) {
    setup();
    const box = await typeQuestion("x");
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(ipc.askWorkspace).toHaveBeenCalled());
    const id = ipc.askWorkspace.mock.calls[0][2] as string;
    (document.activeElement as HTMLElement | null)?.blur();
    emit("workspace_chat_approval", { chat_id: "c1", request_id: id, approval_id: "s1", server: "s", tool: "t", args, ...extra });
    return screen.findByRole("group", { name: /Needs your answer/ });
  }

  it("shows a very long argument in full, scrollable", async () => {
    const long = "y".repeat(100_000);
    const el = await card(long, {});
    const args = within(el).getByLabelText("Exact arguments");
    expect(args.textContent).toBe(long);
    expect(args.className).toContain("overflow-auto");
  });

  it("makes hidden characters visible", async () => {
    const el = await card("a" + String.fromCharCode(0x202e) + "b", {});
    expect(within(el).getByLabelText("Exact arguments").textContent).toContain(String.fromCharCode(92) + "u{202E}");
  });

  it.each([["truncated", /Not everything is shown/], ["redacted", /Secrets are hidden/]])("when %s: says so, starts on Deny, Allow is not the main button", async (flag, text) => {
    const el = await card({ a: 1 }, { [flag]: true });
    expect(within(el).getByText(text)).toBeInTheDocument();
    await waitFor(() => expect(within(el).getByRole("button", { name: "Deny" })).toHaveFocus());
    expect(within(el).getByRole("button", { name: "Allow once" }).className).not.toContain("bg-primary");
    expect(within(el).getByRole("button", { name: "Deny" }).className).toContain("bg-primary");
  });

  it("a complete request keeps Allow once as the main button", async () => {
    const el = await card({ a: 1 }, {});
    expect(within(el).getByRole("button", { name: "Allow once" }).className).toContain("bg-primary");
  });
});

describe("room for the answer", () => {
  it("a chat with messages gets one compact row: follow-up box, model, one options button", async () => {
    setup({ chats: [chat("c1")], messages: pairs(1) });
    expect(await screen.findByPlaceholderText("Ask a follow-up")).toBeInTheDocument();
    const options = screen.getByRole("button", { name: /Answer options: Balanced, All meetings/ });
    expect(screen.queryByRole("radiogroup", { name: "Depth" })).toBeNull();
    await userEvent.setup().click(options);
    const dialog = await screen.findByRole("dialog", { name: "Answer options" });
    expect(within(dialog).getByRole("radiogroup", { name: "Depth" })).toBeInTheDocument();
    expect(within(dialog).getByText(/For most questions/)).toBeInTheDocument();
  });

  it("the start screen explains depth only while you are on it", async () => {
    setup();
    await screen.findByRole("textbox", { name: /ask about this workspace/i });
    expect(screen.queryByText(/For most questions/)).toBeNull();
    const group = await screen.findByRole("radiogroup", { name: "Depth" });
    act(() => within(group).getByRole("radio", { name: "Balanced" }).focus());
    expect(await screen.findByText(/For most questions/)).toBeInTheDocument();
  });

  it("names the effort and lets the model name take the room it needs", async () => {
    useConfigStore.setState({ llmProvider: "claude_cli", llmModel: "sonnet" });
    setup();
    expect(await screen.findByText("Effort:")).toBeInTheDocument();
    const model = screen.getByRole("button", { name: "Model" });
    expect(model.className).not.toContain("max-w-[");
    expect(model.className).not.toContain("truncate");
    useConfigStore.setState({ llmProvider: "ollama", llmModel: "" });
  });

  it("the context is a strip until you open it, then it says what it shows", async () => {
    setup({ chats: [chat("c1")], messages: pairs(1) });
    const toggle = await screen.findByRole("button", { name: /What the next answer will see/ }, { timeout: 2000 });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("What the next answer will see")).toBeNull();
    await userEvent.setup().click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("What the next answer will see")).toBeInTheDocument();
    expect(localStorage.getItem("nexq_ws_chat_wave_open")).toBe("1");
  });

  it("keeps the answer column at least half the pane", async () => {
    setup({ chats: [chat("c1")], messages: pairs(1) });
    const region = await screen.findByRole("region", { name: "Conversation" });
    expect(region.parentElement?.className).toContain("min-h-[50%]");
    expect(document.querySelector("[data-workspace-chat]")?.className).toContain("overflow-hidden");
  });
});

describe("add to instructions", () => {
  const open = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByRole("button", { name: "Add to instructions" }));
    return screen.findByRole("dialog");
  };
  const detail = (instructions: string) => useWorkspaceStore.setState({ loadDetail: (async () => ({ instructions })) as never });

  it("starts from the answer as plain text, sends exactly what was reviewed, and can undo", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    useWorkspaceStore.setState({ update: update as never });
    detail("Be brief.");
    ipc.addAnswerToInstructions.mockResolvedValue(undefined);
    setup({ chats: [chat("c1")], messages: [message(1, "user", "Q"), message(2, "assistant", "Always cite [S1]. [x](https://evil.example/p " + '"t"' + ")")] });
    const user = userEvent.setup();
    const dialog = await open(user);
    expect(within(dialog).getByText(/instructions the AI follows/)).toBeInTheDocument();
    const field = within(dialog).getByLabelText("Text to add") as HTMLTextAreaElement;
    expect(field.value).toBe("Always cite. x");
    fireEvent.change(field, { target: { value: "Always cite sources." } });
    await user.click(within(dialog).getByRole("button", { name: "Add to instructions" }));
    await waitFor(() => expect(ipc.addAnswerToInstructions).toHaveBeenCalledWith(2, "Always cite sources."));
    expect(update).not.toHaveBeenCalled();
    await user.click(await within(dialog).findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(WS, { instructions: "Be brief." }));
  });

  it("cleans hidden characters, HTML and links that were typed or pasted, and sends nothing until it is read again", async () => {
    detail("");
    ipc.addAnswerToInstructions.mockResolvedValue(undefined);
    setup({ chats: [chat("c1")], messages: [message(1, "user", "Q"), message(2, "assistant", "Text")] });
    const user = userEvent.setup();
    const dialog = await open(user);
    const field = within(dialog).getByLabelText("Text to add") as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "Be kind" + String.fromCharCode(0x200b) + " <b>always</b> [x](https://evil.example)" } });
    await user.click(within(dialog).getByRole("button", { name: "Add to instructions" }));
    expect(ipc.addAnswerToInstructions).not.toHaveBeenCalled();
    expect(field.value).toBe("Be kind always x");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Some of it was removed");
    await user.click(within(dialog).getByRole("button", { name: "Add to instructions" }));
    await waitFor(() => expect(ipc.addAnswerToInstructions).toHaveBeenCalledWith(2, "Be kind always x"));
  });

  it("shows the backend's refusal in place and adds nothing", async () => {
    detail("");
    ipc.addAnswerToInstructions.mockRejectedValue("Something this answer used has left this workspace, so it can't be saved.");
    setup({ chats: [chat("c1")], messages: [message(1, "user", "Q"), message(2, "assistant", "Text")] });
    const user = userEvent.setup();
    const dialog = await open(user);
    await user.click(within(dialog).getByRole("button", { name: "Add to instructions" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("has left this workspace");
    expect(within(dialog).queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("is not offered for an answer that isn't saved yet", async () => {
    setup({ chats: [chat("c1")], messages: [message(1, "user", "Q"), message(-5, "assistant", "Unsaved")] });
    expect(await screen.findByRole("button", { name: "Add to instructions" })).toBeDisabled();
  });
});

describe("can_ask never blocks the chat", () => {
  it.each([
    ["claude_cli", true],
    ["codex_cli", false],
    ["antigravity_cli", false],
    ["ollama", false],
    ["openai", false],
  ])("%s (can_ask %s) asks normally and still shows the tools-off note", async (provider, canAsk) => {
    useConfigStore.setState({ llmProvider: provider as never, llmModel: "m" });
    ipc.getChatCapabilities.mockResolvedValue({
      can_ask: canAsk,
      tools_off: canAsk ? [] : [{ tool: "CRM: update_deal", reason: "This one can't ask before running a tool that changes things." }],
      notes: [],
    });
    setup({ chats: [chat("c1")], messages: pairs(1) });
    const box = await typeQuestion("Go ahead");
    if (!canAsk) expect(await screen.findByRole("button", { name: /CRM: update_deal is off/ })).toBeInTheDocument();
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(ipc.askWorkspace).toHaveBeenCalledWith("c1", "Go ahead", expect.any(String), false));
    useConfigStore.setState({ llmProvider: "ollama", llmModel: "" });
  });
});

describe("composer structure", () => {
  it("puts the question on its own full-width row and keeps the controls and Ask in a wrapping row", async () => {
    setup({ chats: [chat("c1")], messages: pairs(1) });
    const box = await screen.findByPlaceholderText("Ask a follow-up");
    const root = document.querySelector("[data-composer='compact']") as HTMLElement;
    const controls = root.querySelector("[data-composer-controls]") as HTMLElement;
    // The textarea is not in the controls row, and fills its row.
    expect(controls.contains(box)).toBe(false);
    expect(box.className).toContain("w-full");
    expect(box.className).toContain("min-w-0");
    // Controls wrap, and may shrink; Ask is in the group that never shrinks.
    expect(controls.className).toContain("flex-wrap");
    expect(controls.className).toContain("min-w-0");
    const ask = within(controls).getByRole("button", { name: "Ask" });
    expect(ask.className).toContain("shrink-0");
    expect(ask.parentElement?.className).toContain("shrink-0");
    // Nothing in the composer can push the pane wider.
    expect(root.className).toContain("min-w-0");
    expect(root.firstElementChild?.className ?? "").not.toContain("overflow-x-scroll");
    // Labels truncate instead of growing.
    expect(within(controls).getByRole("button", { name: "Model" }).className).toContain("max-w-full");
    expect(within(controls).getByRole("button", { name: /Answer options/ }).className).toContain("max-w-full");
  });

  it("is one line when empty and grows with a draft, within a cap", async () => {
    setup({ chats: [chat("c1")], messages: pairs(1) });
    const box = (await screen.findByPlaceholderText("Ask a follow-up")) as HTMLTextAreaElement;
    expect(box.rows).toBe(1);
    expect(box.style.height).toBe("24px");
  });
});

describe("access changed and notices", () => {
  it("shows a calm note and Ask again, and nothing of the answer", async () => {
    setup();
    const box = await typeQuestion("What did Dana say?");
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(ipc.askWorkspace).toHaveBeenCalled());
    const id = ipc.askWorkspace.mock.calls[0][2] as string;
    emit("workspace_chat_token", { chat_id: "c1", request_id: id, token: "Secret partial text" });
    await screen.findByText("Secret partial text");
    emit("workspace_chat_error", { chat_id: "c1", request_id: id, error: "moved", error_kind: "access_changed", error_detail: "moved" });
    expect(await screen.findByText("Something this answer used was moved out of this workspace, so it was stopped.")).toBeInTheDocument();
    expect(screen.queryByText(/Secret partial text/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save to library" })).toBeNull();
    expect(screen.getByText("What did Dana say?")).toBeInTheDocument();
    ipc.askWorkspace.mockClear();
    await userEvent.setup().click(screen.getByRole("button", { name: "Ask again" }));
    await waitFor(() => expect(ipc.askWorkspace).toHaveBeenCalledWith("c1", "What did Dana say?", expect.any(String), false));
  });

  it("keeps an indexing note with the answer, next to Search deeper, and before asking", async () => {
    const r = { ...report, estimate: false, omitted: 2, notices: ["Still indexing 312 of 540 files"], bars: [] };
    ipc.previewChatContext.mockResolvedValue({ ...report, notices: ["Still indexing 312 of 540 files"] });
    setup({ chats: [chat("c1")], messages: [message(1, "user", "Q1"), message(2, "assistant", "A1", { context: r as never })] });
    expect(await screen.findAllByText("Still indexing 312 of 540 files")).not.toHaveLength(0);
    expect(await screen.findByText(/2 things didn't fit/)).toBeInTheDocument();
    // with the answer, and in the composer's notes before asking
    await waitFor(() => expect(screen.getAllByText("Still indexing 312 of 540 files").length).toBeGreaterThanOrEqual(2));
    await userEvent.setup().click(screen.getByRole("button", { name: "Search deeper" }));
    expect(screen.getAllByText("Still indexing 312 of 540 files").length).toBeGreaterThanOrEqual(1);
  });
});

describe("a turn ends only by its own request", () => {
  it("a follow-up right after an answer does not show the old answer", async () => {
    const old = message(2, "assistant", "OLD ANSWER", { created_at: Date.now() - 500 });
    setup({ chats: [chat("c1")], messages: [message(1, "user", "First", { created_at: Date.now() - 600 }), old] });
    const box = await typeQuestion("Follow-up");
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(ipc.askWorkspace).toHaveBeenCalled());
    // ask_workspace has returned; the backend still lists only the old answer.
    await new Promise((r) => setTimeout(r, 80));
    expect(useWorkspaceChatStore.getState().sessions.c1.turn?.status).toBe("waiting");
    expect(screen.getAllByText("OLD ANSWER")).toHaveLength(1);
    const id = ipc.askWorkspace.mock.calls[0][2] as string;
    const fresh = message(4, "assistant", "NEW ANSWER", { created_at: Date.now() });
    emit("workspace_chat_end", { chat_id: "c1", request_id: id, cancelled: false, message: fresh });
    expect(await screen.findByText("NEW ANSWER")).toBeInTheDocument();
  });

  it("fills What it looked at from the activity of its own request", async () => {
    setup();
    const box = await typeQuestion("Q");
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(ipc.askWorkspace).toHaveBeenCalled());
    const id = ipc.askWorkspace.mock.calls[0][2] as string;
    emit("workspace_chat_activity", { chat_id: "c1", request_id: id, activity: { kind: "tool", label: "CRM: get_deal (Acme)", chip: null } });
    emit("workspace_chat_activity", { chat_id: "c1", request_id: "other", activity: { kind: "tool", label: "NOT MINE", chip: null } });
    const saved = message(2, "assistant", "Done");
    ipc.listWorkspaceMessages.mockResolvedValue([message(1, "user", "Q"), saved]);
    emit("workspace_chat_end", { chat_id: "c1", request_id: id, cancelled: false, message: saved });
    await userEvent.setup().click(await screen.findByRole("button", { name: "What it looked at" }));
    const did = screen.getByRole("list", { name: "What it did" });
    expect(within(did).getByText("CRM: get_deal (Acme)")).toBeInTheDocument();
    expect(screen.queryByText("NOT MINE")).toBeNull();
  });

  it("closes an approval as timed out with the backend's word", async () => {
    setup();
    const box = await typeQuestion("x");
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(ipc.askWorkspace).toHaveBeenCalled());
    const id = ipc.askWorkspace.mock.calls[0][2] as string;
    emit("workspace_chat_approval", { chat_id: "c1", request_id: id, approval_id: "t1", server: "s", tool: "t", args: {} });
    await screen.findByRole("button", { name: "Allow once" });
    emit("workspace_chat_approval_closed", { chat_id: "c1", approval_id: "t1", reason: "timed_out" });
    expect(await screen.findByText(/No answer in 60 seconds, so it was denied/)).toBeInTheDocument();
  });
});

describe("removed answers and saved pins, in words", () => {
  async function removed(detail?: "deleted" | "moved") {
    setup();
    const box = await typeQuestion("Q");
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(ipc.askWorkspace).toHaveBeenCalled());
    const id = ipc.askWorkspace.mock.calls[0][2] as string;
    emit("workspace_chat_error", { chat_id: "c1", request_id: id, error: "x", error_kind: "access_changed", error_detail: detail });
  }
  it("says deleted when what it used was deleted", async () => {
    await removed("deleted");
    expect(await screen.findByText("Something this answer used was deleted, so it was stopped.")).toBeInTheDocument();
  });
  it("says moved when it was moved or the reason is unknown", async () => {
    await removed("moved");
    expect(await screen.findByText(/was moved out of this workspace, so it was stopped/)).toBeInTheDocument();
  });

  it("lists pinned and left-out items by name, never by id, and puts them back", async () => {
    ipc.setChatItemPref.mockResolvedValue(undefined);
    ipc.listChatItemPrefs.mockResolvedValue([
      { kind: "document", ref_id: "d1", pref: "pin", title: "Master agreement" },
      { kind: "meeting", ref_id: "3f2b8c1e-9d4a-4c1b-8a55-0f1e2d3c4b5a", pref: "exclude", title: "" },
    ]);
    setup({ chats: [chat("c1")], messages: pairs(1) });
    await userEvent.setup().click(await screen.findByRole("button", { name: /What the next answer will see/ }, { timeout: 2000 }));
    const list = await screen.findByRole("list", { name: "Pinned and left out" });
    expect(within(list).getByText("Master agreement")).toBeInTheDocument();
    expect(within(list).getByText("Removed item")).toBeInTheDocument();
    expect(list.textContent).not.toContain("3f2b8c1e");
    await userEvent.setup().click(within(list).getByRole("button", { name: "Unpin" }));
    await waitFor(() => expect(ipc.setChatItemPref).toHaveBeenCalledWith("c1", "document", "d1", "default"));
  });
});

describe("hidden characters and screen readers", () => {
  const ZW = String.fromCharCode(0x200b);
  const RLO = String.fromCharCode(0x202e);
  const ZWNJ = String.fromCharCode(0x200c);

  async function ask(q = "Q") {
    setup();
    const box = await typeQuestion(q);
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(ipc.askWorkspace).toHaveBeenCalled());
    return ipc.askWorkspace.mock.calls[0][2] as string;
  }
  const live = (kind: "polite" | "assertive") => document.querySelector(`[data-chat-live="${kind}"]`) as HTMLElement;

  it("never draws hidden characters, even when they arrive split across tokens, and keeps real writing", async () => {
    const id = await ask();
    emit("workspace_chat_token", { chat_id: "c1", request_id: id, token: "Hel" + RLO + ZW });
    emit("workspace_chat_token", { chat_id: "c1", request_id: id, token: "lo " + ZW + "ی" + ZWNJ });
    emit("workspace_chat_token", { chat_id: "c1", request_id: id, token: "خ" });
    await waitFor(() => expect(document.body.textContent).toContain("Hello"));
    const prose = document.body.textContent ?? "";
    expect(prose).not.toContain(RLO);
    expect(prose).not.toContain(ZW);
    expect(prose).toContain("ی" + ZWNJ + "خ");
  });

  it("copies the answer without hidden characters", async () => {
    setup({ chats: [chat("c1")], messages: [message(1, "user", "Q"), message(2, "assistant", "Pay" + RLO + " now" + ZW)] });
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    await user.click(await screen.findByRole("button", { name: /Copy/ }));
    expect(writeText).toHaveBeenCalledWith("Pay now");
  });

  it("announces Answering once, then Answer ready with the tools it used, and never the tokens", async () => {
    const id = await ask();
    emit("workspace_chat_start", { chat_id: "c1", request_id: id, model: "m" });
    await waitFor(() => expect(live("polite").textContent).toBe("Answering"));
    emit("workspace_chat_token", { chat_id: "c1", request_id: id, token: "Some long answer text" });
    emit("workspace_chat_activity", { chat_id: "c1", request_id: id, activity: { kind: "tool", label: "CRM: get_deal", chip: null } });
    await new Promise((r) => setTimeout(r, 60));
    expect(live("polite").textContent).toBe("Answering");
    expect(live("assertive").textContent).not.toContain("Some long");
    const saved = message(2, "assistant", "Some long answer text");
    ipc.listWorkspaceMessages.mockResolvedValue([message(1, "user", "Q"), saved]);
    emit("workspace_chat_end", { chat_id: "c1", request_id: id, cancelled: false, message: saved });
    await waitFor(() => expect(live("polite").textContent).toBe("Answer ready. It used 1 tool."));
  });

  it("announces a tool request assertively, and an error through its own alert", async () => {
    const id = await ask();
    emit("workspace_chat_approval", { chat_id: "c1", request_id: id, approval_id: "an1", server: "CRM", tool: "update_deal", args: {} });
    await waitFor(() => expect(live("assertive").textContent).toContain("update_deal on CRM"));
    emit("workspace_chat_error", { chat_id: "c1", request_id: id, error: "429 rate limit", error_kind: "rate_limited" });
    expect(await screen.findByRole("alert")).toHaveTextContent("limiting requests");
  });

  it("has one named region for the chat, with the question box after the answers in the tab order", async () => {
    setup({ chats: [chat("c1")], messages: pairs(1) });
    const region = await screen.findByRole("region", { name: "Workspace chat" });
    const box = within(region).getByRole("textbox", { name: /ask about this workspace/i });
    const answers = within(region).getByRole("region", { name: "Conversation" });
    expect(answers.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("does not say moved when the reason is unknown", async () => {
    const id = await ask();
    emit("workspace_chat_error", { chat_id: "c1", request_id: id, error: "x", error_kind: "access_changed" });
    expect(await screen.findByText("Something this answer used is no longer available here, so it was stopped.")).toBeInTheDocument();
    expect(screen.queryByText(/was moved out of this workspace/)).toBeNull();
  });
});
