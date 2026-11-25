import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextReport, WorkspaceChat, WorkspaceMessage } from "../lib/types";

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
  listChatMeetingPrefs: vi.fn(),
  setChatItemPref: vi.fn(),
  listChatItemPrefs: vi.fn(),
  getChatCapabilities: vi.fn(),
}));
vi.mock("../lib/ipc", () => ipc);
vi.mock("../lib/events", () => {
  const none = async () => () => {};
  return {
    onWorkspaceChatStart: none,
    onWorkspaceChatToken: none,
    onWorkspaceChatActivity: none,
    onWorkspaceChatContext: none,
    onWorkspaceChatEnd: none,
    onWorkspaceChatError: none,
    onWorkspaceChatApproval: none,
    onWorkspaceChatApprovalClosed: none,
    onWorkspaceChatApprovalRefused: none,
  };
});

import {
  APPROVAL_SECONDS,
  chatEventHandlers,
  resetWorkspaceChatForTests,
  useWorkspaceChatStore,
} from "./workspaceChatStore";

const S = () => useWorkspaceChatStore.getState();
const chat = (id: string, over: Partial<WorkspaceChat> = {}): WorkspaceChat => ({
  id,
  workspace_id: "w1",
  title: "Pricing",
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
const answer = (id: number, chat_id: string, content = "Done [S1]"): WorkspaceMessage => ({
  id,
  chat_id,
  role: "assistant",
  content,
  model: "m",
  citations: [],
  context: null,
  input_tokens: 10,
  output_tokens: 5,
  created_at: Date.now(),
});
const report = (over: Partial<ContextReport> = {}): ContextReport => ({
  strategy: "ladder",
  depth: "balanced",
  budget: 24000,
  window: 200000,
  used: 1000,
  bars: [],
  omitted: 0,
  notices: [],
  estimate: false,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  resetWorkspaceChatForTests();
  ipc.listWorkspaceMessages.mockResolvedValue([]);
  ipc.updateWorkspaceChat.mockImplementation(async (id: string, p: object) => chat(id, p));
  useWorkspaceChatStore.setState({ chats: { w1: [chat("c1"), chat("c2")] }, activeChat: { w1: "c1" } });
});
afterEach(() => {
  vi.useRealTimers();
});

const h = () => chatEventHandlers();
async function startAsk(chatId = "c1", q = "What did we decide?") {
  let release: () => void = () => {};
  ipc.askWorkspace.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
  const done = S().ask(chatId, q);
  const reqId = ipc.askWorkspace.mock.calls[ipc.askWorkspace.mock.calls.length - 1][2] as string;
  return { reqId, release: () => release(), done };
}

describe("streaming", () => {
  it("collects tokens, then keeps the saved answer when it ends", async () => {
    const { reqId, release, done } = await startAsk();
    expect(S().sessions.c1.turn?.status).toBe("waiting");
    h().start({ chat_id: "c1", request_id: reqId, model: "sonnet" });
    h().token({ chat_id: "c1", request_id: reqId, token: "Hello " });
    h().token({ chat_id: "c1", request_id: reqId, token: "there" });
    await vi.waitFor(() => expect(S().sessions.c1.turn?.text).toBe("Hello there"));
    h().activity({ chat_id: "c1", request_id: reqId, activity: { kind: "tool", label: "Read notes", chip: null } });
    h().end({ chat_id: "c1", request_id: reqId, cancelled: false, message: answer(9, "c1", "Hello there") });
    release();
    await done;
    const s = S().sessions.c1;
    expect(s.turn).toBeNull();
    expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(s.messages[1].content).toBe("Hello there");
    expect(s.extras[9].activity[0].label).toBe("Read notes");
  });

  it("drops events of another request and of another chat", async () => {
    const a = await startAsk("c1", "one");
    const b = await startAsk("c2", "two");
    h().token({ chat_id: "c1", request_id: b.reqId, token: "WRONG" });
    h().token({ chat_id: "c2", request_id: a.reqId, token: "WRONG" });
    h().token({ chat_id: "c1", request_id: a.reqId, token: "A" });
    h().token({ chat_id: "c2", request_id: b.reqId, token: "B" });
    await vi.waitFor(() => expect(S().sessions.c2.turn?.text).toBe("B"));
    expect(S().sessions.c1.turn?.text).toBe("A");
  });

  it("runs two chats at once and refuses a second question in the same chat", async () => {
    const a = await startAsk("c1");
    await startAsk("c2");
    expect(S().sessions.c1.turn?.status).toBe("waiting");
    expect(S().sessions.c2.turn?.status).toBe("waiting");
    expect(await S().ask("c1", "again")).toBe(false);
    expect(ipc.askWorkspace).toHaveBeenCalledTimes(2);
    expect(a.reqId).toBeTruthy();
  });

  it("ignores late tokens after a stop and keeps what was written", async () => {
    ipc.cancelWorkspaceRequest.mockResolvedValue(undefined);
    const { reqId } = await startAsk();
    h().token({ chat_id: "c1", request_id: reqId, token: "Part" });
    await vi.waitFor(() => expect(S().sessions.c1.turn?.text).toBe("Part"));
    await S().stop("c1");
    expect(S().sessions.c1.turn?.status).toBe("stopping");
    expect(ipc.cancelWorkspaceRequest).toHaveBeenCalledWith(reqId);
    h().end({ chat_id: "c1", request_id: reqId, cancelled: true, message: answer(0, "c1", "Part") });
    expect(S().sessions.c1.turn?.status).toBe("stopped");
    h().token({ chat_id: "c1", request_id: reqId, token: " LATE" });
    await new Promise((r) => setTimeout(r, 60));
    expect(S().sessions.c1.turn?.text).toBe("Part");
    expect(S().sessions.c1.messages).toHaveLength(0);
  });

  it("shows the stop anyway when the end event never comes", async () => {
    vi.useFakeTimers();
    ipc.cancelWorkspaceRequest.mockResolvedValue(undefined);
    await startAsk();
    await S().stop("c1");
    await vi.advanceTimersByTimeAsync(8100);
    expect(S().sessions.c1.turn?.status).toBe("stopped");
  });

  it("a new question after a stop starts clean and the old request's events no longer matter", async () => {
    ipc.cancelWorkspaceRequest.mockResolvedValue(undefined);
    const first = await startAsk();
    await S().stop("c1");
    h().end({ chat_id: "c1", request_id: first.reqId, cancelled: true, message: answer(0, "c1", "") });
    const second = await startAsk("c1", "next");
    h().token({ chat_id: "c1", request_id: first.reqId, token: "OLD" });
    h().token({ chat_id: "c1", request_id: second.reqId, token: "NEW" });
    await vi.waitFor(() => expect(S().sessions.c1.turn?.text).toBe("NEW"));
  });
});

describe("errors", () => {
  it("an error event fails the turn in place and keeps the text so far", async () => {
    const { reqId } = await startAsk();
    h().token({ chat_id: "c1", request_id: reqId, token: "Half" });
    h().error({ chat_id: "c1", request_id: reqId, error: "401 unauthorized" });
    const t = S().sessions.c1.turn!;
    expect(t.status).toBe("failed");
    expect(t.error).toBe("401 unauthorized");
    expect(t.text).toBe("Half");
  });

  it("a rejected command fails the turn instead of failing silently", async () => {
    ipc.askWorkspace.mockRejectedValueOnce(new Error("Ollama isn't running"));
    expect(await S().ask("c1", "hi")).toBe(false);
    expect(S().sessions.c1.turn).toMatchObject({ status: "failed", error: "Ollama isn't running" });
    // and the next question may go
    const next = await startAsk("c1", "again");
    expect(S().sessions.c1.turn?.requestId).toBe(next.reqId);
  });
});

describe("tool approvals", () => {
  const approval = (reqId: string, id = "ap1") => ({ chat_id: "c1", request_id: reqId, approval_id: id, server: "notes", tool: "delete_note", args: { id: 3 } });

  it("holds the card, answers it once, and records the answer", async () => {
    const { reqId } = await startAsk();
    h().approval(approval(reqId));
    const card = S().sessions.c1.turn!.approvals[0];
    expect(card).toMatchObject({ state: "pending", tool: "delete_note", truncated: false });
    ipc.answerWorkspaceApproval.mockResolvedValue(undefined);
    await S().answerApproval(card, true);
    expect(ipc.answerWorkspaceApproval).toHaveBeenCalledWith("ap1", true);
    expect(S().sessions.c1.turn!.approvals[0].state).toBe("allowed");
    await S().answerApproval(S().sessions.c1.turn!.approvals[0], false);
    expect(ipc.answerWorkspaceApproval).toHaveBeenCalledTimes(1);
  });

  it("expires after 60 seconds without a click", async () => {
    vi.useFakeTimers();
    const { reqId } = await startAsk();
    h().approval(approval(reqId));
    await vi.advanceTimersByTimeAsync(APPROVAL_SECONDS * 1000 - 1);
    expect(S().sessions.c1.turn!.approvals[0].state).toBe("pending");
    await vi.advanceTimersByTimeAsync(2);
    expect(S().sessions.c1.turn!.approvals[0].state).toBe("expired");
  });

  it("closes when the backend says it was answered elsewhere, and keeps a given answer", async () => {
    const { reqId } = await startAsk();
    h().approval(approval(reqId, "a1"));
    h().approval(approval(reqId, "a2"));
    ipc.answerWorkspaceApproval.mockResolvedValue(undefined);
    await S().answerApproval(S().sessions.c1.turn!.approvals[1], false);
    h().approvalClosed({ chat_id: "c1", approval_id: "a1", reason: "answered" });
    h().approvalClosed({ chat_id: "c1", approval_id: "a2", reason: "timed_out" });
    const [a1, a2] = S().sessions.c1.turn!.approvals;
    expect(a1).toMatchObject({ state: "closed", closedReason: "answered" });
    expect(a2.state).toBe("denied");
  });

  it("a failed answer says so", async () => {
    const { reqId } = await startAsk();
    h().approval(approval(reqId));
    ipc.answerWorkspaceApproval.mockRejectedValue(new Error("gone"));
    await S().answerApproval(S().sessions.c1.turn!.approvals[0], true);
    expect(S().sessions.c1.turn!.approvals[0].state).toBe("failed");
  });

  it("settles open cards when the answer ends", async () => {
    const { reqId } = await startAsk();
    h().approval(approval(reqId));
    h().end({ chat_id: "c1", request_id: reqId, cancelled: false, message: answer(5, "c1") });
    expect(S().sessions.c1.extras[5].approvals[0].state).toBe("expired");
  });
});

describe("chats", () => {
  it("renames optimistically and puts the old name back when it fails", async () => {
    ipc.updateWorkspaceChat.mockRejectedValueOnce(new Error("no"));
    await S().renameChat("c1", "Budget");
    expect(S().chats.w1.find((c) => c.id === "c1")!.title).toBe("Pricing");
  });

  it("names an untitled chat after its first question", async () => {
    useWorkspaceChatStore.setState({ chats: { w1: [chat("c1", { title: "New chat" })] } });
    const { reqId, release, done } = await startAsk("c1", "What is the Q3 target for Acme?");
    h().end({ chat_id: "c1", request_id: reqId, cancelled: false, message: answer(2, "c1") });
    release();
    await done;
    await vi.waitFor(() => expect(ipc.updateWorkspaceChat).toHaveBeenCalledWith("c1", { title: "What is the Q3 target for Acme?" }));
  });

  it("deleting the open chat opens the next one and forgets the draft", async () => {
    ipc.deleteWorkspaceChat.mockResolvedValue(undefined);
    S().setDraft("c1", "unsent");
    await S().deleteChat("c1");
    expect(S().activeChat.w1).toBe("c2");
    expect(S().drafts.c1).toBeUndefined();
    expect(localStorage.getItem("nexq_ws_chat_draft_c1")).toBeNull();
  });

  it("keeps a draft per chat", () => {
    S().setDraft("c1", "one");
    S().setDraft("c2", "two");
    expect(S().drafts).toMatchObject({ c1: "one", c2: "two" });
    expect(localStorage.getItem("nexq_ws_chat_draft_c2")).toBe("two");
  });

  it("opening a chat loads its messages once", async () => {
    ipc.listWorkspaceMessages.mockResolvedValue([answer(1, "c2")]);
    S().selectChat("w1", "c2");
    S().selectChat("w1", "c2");
    await vi.waitFor(() => expect(S().sessions.c2.messages).toHaveLength(1));
    expect(ipc.listWorkspaceMessages).toHaveBeenCalledTimes(1);
  });

  it("New chat reuses a chat that is still empty", async () => {
    ipc.createWorkspaceChat.mockResolvedValue(chat("c9", { title: "New chat" }));
    const first = await S().newChat("w1");
    const second = await S().newChat("w1");
    expect(first).toBe("c9");
    expect(second).toBe("c9");
    expect(ipc.createWorkspaceChat).toHaveBeenCalledTimes(1);
  });
});

describe("estimate and scope", () => {
  it("drops an older estimate that arrives late", async () => {
    let first: (r: ContextReport) => void = () => {};
    ipc.previewChatContext.mockImplementationOnce(() => new Promise<ContextReport>((r) => (first = r)));
    ipc.previewChatContext.mockResolvedValueOnce(report({ used: 2 }));
    const slow = S().refreshPreview("c1", "a");
    await S().refreshPreview("c1", "ab");
    first(report({ used: 999 }));
    await slow;
    expect(S().sessions.c1.preview?.used).toBe(2);
  });

  it("remembers left-out meetings and rolls back when the backend refuses", async () => {
    ipc.setChatMeetingIncluded.mockResolvedValueOnce(undefined);
    await S().setMeetingIncluded("w1", "c1", "m1", false);
    expect(S().sessions.c1.excluded).toEqual(["m1"]);
    expect(JSON.parse(localStorage.getItem("nexq_ws_chat_excluded_c1")!)).toEqual(["m1"]);
    ipc.setChatMeetingIncluded.mockRejectedValueOnce(new Error("no"));
    expect(await S().setMeetingIncluded("w1", "c1", "m2", false)).toBe(false);
    expect(S().sessions.c1.excluded).toEqual(["m1"]);
  });
});

describe("settings that shape an answer", () => {
  it("a question waits for a setting still being saved, then goes", async () => {
    let finish: () => void = () => {};
    ipc.updateWorkspaceChat.mockImplementationOnce(() => new Promise((r) => (finish = () => r(chat("c1", { depth: "deep" })))));
    const saving = S().updateChat("c1", { depth: "deep" });
    const asked = S().ask("c1", "hello");
    await Promise.resolve();
    expect(ipc.askWorkspace).not.toHaveBeenCalled();
    finish();
    await saving;
    await asked;
    expect(ipc.askWorkspace).toHaveBeenCalledTimes(1);
  });

  it("nothing is sent when a setting did not save, and the old value is back", async () => {
    ipc.updateWorkspaceChat.mockRejectedValueOnce(new Error("disk full"));
    const saving = S().updateChat("c1", { model: "opus", depth: "deep" });
    expect(await S().ask("c1", "hello")).toBe(false);
    await saving;
    expect(ipc.askWorkspace).not.toHaveBeenCalled();
    expect(S().chats.w1[0]).toMatchObject({ model: null, depth: "balanced" });
    expect(S().sessions.c1?.turn ?? null).toBeNull();
  });

  it("writes go one at a time, in order", async () => {
    const order: string[] = [];
    ipc.updateWorkspaceChat.mockImplementation(async (id: string, p: { depth?: string; model?: string }) => {
      order.push(`start ${Object.keys(p)[0]}`);
      await new Promise((r) => setTimeout(r, p.depth ? 20 : 1));
      order.push(`end ${Object.keys(p)[0]}`);
      return chat(id, p as object);
    });
    await Promise.all([S().updateChat("c1", { depth: "lean" }), S().updateChat("c1", { model: "m" })]);
    expect(order).toEqual(["start depth", "end depth", "start model", "end model"]);
  });
});

describe("left-out meetings", () => {
  it("a failed change puts back only that meeting and says why", async () => {
    ipc.setChatMeetingIncluded.mockResolvedValueOnce(undefined);
    ipc.setChatMeetingIncluded.mockRejectedValueOnce(new Error("busy"));
    ipc.listChatMeetingPrefs.mockRejectedValue(new Error("none"));
    const a = S().setMeetingIncluded("w1", "c1", "m1", false);
    const b = S().setMeetingIncluded("w1", "c1", "m2", false);
    expect(S().sessions.c1.excluded).toEqual(["m1", "m2"]);
    expect(await a).toBe(true);
    expect(await b).toBe(false);
    expect(S().sessions.c1.excluded).toEqual(["m1"]);
  });

  it("reloads the truth from the backend once the last write is done", async () => {
    ipc.setChatMeetingIncluded.mockResolvedValue(undefined);
    ipc.listChatMeetingPrefs.mockResolvedValue([{ meeting_id: "m9", included: false }]);
    await S().setMeetingIncluded("w1", "c1", "m1", false);
    expect(S().sessions.c1.excluded).toEqual(["m9"]);
  });

  it("a question never goes while a change is unconfirmed, and not at all if it fails", async () => {
    let fail: (e: Error) => void = () => {};
    ipc.setChatMeetingIncluded.mockImplementationOnce(() => new Promise((_, rej) => (fail = rej)));
    ipc.listChatMeetingPrefs.mockRejectedValue(new Error("none"));
    void S().setMeetingIncluded("w1", "c1", "m1", false);
    const asked = S().ask("c1", "go");
    await Promise.resolve();
    expect(ipc.askWorkspace).not.toHaveBeenCalled();
    fail(new Error("no"));
    expect(await asked).toBe(false);
    expect(ipc.askWorkspace).not.toHaveBeenCalled();
    expect(S().sessions.c1.excluded).toEqual([]);
  });

  it("pins go through the same queue and refresh the estimate", async () => {
    ipc.setChatItemPref.mockResolvedValue(undefined);
    ipc.previewChatContext.mockResolvedValue(report());
    expect(await S().setItemPref("c1", "document", "d1", "pin")).toBe(true);
    expect(ipc.setChatItemPref).toHaveBeenCalledWith("c1", "document", "d1", "pin");
  });
});

describe("backend words", () => {
  it("keeps the backend's error kind on a failed turn", async () => {
    const { reqId } = await startAsk();
    h().error({ chat_id: "c1", request_id: reqId, error: "boom", error_kind: "rate_limited" });
    expect(S().sessions.c1.turn).toMatchObject({ status: "failed", errorKind: "rate_limited" });
  });

  it("a refused tool shows as a note on the answer, once", async () => {
    const { reqId } = await startAsk();
    h().approvalRefused({ chat_id: "c1", request_id: reqId, reason: "update_deal can't be undone" });
    h().approvalRefused({ chat_id: "c1", request_id: reqId, reason: "update_deal can't be undone" });
    const notes = S().sessions.c1.turn!.activity.filter((a) => a.kind === "notice");
    expect(notes).toHaveLength(1);
    expect(notes[0].label).toContain("update_deal");
  });

  it("loads saved pins and capabilities, and tolerates failures", async () => {
    ipc.listChatItemPrefs.mockResolvedValue([{ kind: "document", ref_id: "d1", pref: "pin" }]);
    await S().loadItemPrefs("c1");
    expect(S().sessions.c1.itemPrefs).toHaveLength(1);
    ipc.getChatCapabilities.mockResolvedValue({ can_ask: true, tools_off: [{ tool: "CRM: update_deal", reason: "r" }], notes: [] });
    await S().refreshCapabilities("c1");
    expect(S().sessions.c1.capabilities?.tools_off[0].tool).toBe("CRM: update_deal");
    ipc.getChatCapabilities.mockRejectedValue(new Error("x"));
    await S().refreshCapabilities("c1");
    expect(S().sessions.c1.capabilities).toBeNull();
  });
});

describe("access changed", () => {
  const revoke = (reqId: string, chat_id = "c1") => h().error({ chat_id, request_id: reqId, error: "moved", error_kind: "access_changed" as never });

  it("removes the partial answer, even tokens still waiting to be shown, and keeps the question", async () => {
    const { reqId } = await startAsk("c1", "What did Dana say?");
    h().activity({ chat_id: "c1", request_id: reqId, activity: { kind: "tool", label: "Read secret.md", chip: null } });
    h().token({ chat_id: "c1", request_id: reqId, token: "Dana said the secret" });
    revoke(reqId);
    const t = S().sessions.c1.turn!;
    expect(t).toMatchObject({ status: "removed", text: "", question: "What did Dana say?", activity: [], report: null });
    await new Promise((r) => setTimeout(r, 60));
    expect(S().sessions.c1.turn!.text).toBe("");
  });

  it("ignores tokens, notes and an end that arrive after it", async () => {
    const { reqId } = await startAsk();
    revoke(reqId);
    h().token({ chat_id: "c1", request_id: reqId, token: "late" });
    h().activity({ chat_id: "c1", request_id: reqId, activity: { kind: "tool", label: "late", chip: null } });
    h().context({ chat_id: "c1", request_id: reqId, report: report() });
    h().end({ chat_id: "c1", request_id: reqId, cancelled: false, message: answer(7, "c1", "late answer") });
    await new Promise((r) => setTimeout(r, 60));
    const s = S().sessions.c1;
    expect(s.turn).toMatchObject({ status: "removed", text: "", activity: [], report: null });
    expect(s.messages).toHaveLength(0);
  });

  it("takes back an answer that had already ended", async () => {
    const { reqId, release, done } = await startAsk("c1", "Q?");
    h().end({ chat_id: "c1", request_id: reqId, cancelled: false, message: answer(9, "c1", "Saved text") });
    release();
    await done;
    expect(S().sessions.c1.messages).toHaveLength(2);
    ipc.listWorkspaceMessages.mockResolvedValue([]);
    revoke(reqId);
    const s = S().sessions.c1;
    expect(s.messages).toHaveLength(0);
    expect(s.extras[9]).toBeUndefined();
    expect(s.turn).toMatchObject({ status: "removed", question: "Q?", text: "" });
  });

  it("works for a chat that is not open, and Ask again keeps the question", async () => {
    useWorkspaceChatStore.setState({ activeChat: { w1: "c1" } });
    const { reqId } = await startAsk("c2", "Other chat question");
    revoke(reqId, "c2");
    expect(S().sessions.c2.turn).toMatchObject({ status: "removed", question: "Other chat question" });
    expect(S().sessions.c1?.turn ?? null).toBeNull();
    expect(await S().ask("c2", S().sessions.c2.turn!.question)).toBe(true);
    expect(ipc.askWorkspace).toHaveBeenCalledTimes(2);
    expect(S().sessions.c2.turn?.status).toBe("waiting");
  });
});
