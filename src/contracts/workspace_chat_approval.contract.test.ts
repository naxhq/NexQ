import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadFixture } from "./loadFixture";

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

import { chatEventHandlers, resetWorkspaceChatForTests, useWorkspaceChatStore } from "../stores/workspaceChatStore";
import type { WorkspaceChat } from "../lib/types";

const S = () => useWorkspaceChatStore.getState();
const h = () => chatEventHandlers();
const chat = (id: string): WorkspaceChat => ({
  id, workspace_id: "w1", title: "T", provider: null, model: null, effort: null, depth: "balanced",
  include_meetings: true, condensed_upto: null, created_at: 1, updated_at: 1,
});

/** An answer being written on c1 whose request id is the one the fixtures carry. */
async function startAsk(requestId: string) {
  vi.spyOn(crypto, "randomUUID").mockReturnValue(requestId as `${string}-${string}-${string}-${string}-${string}`);
  ipc.askWorkspace.mockImplementationOnce(() => new Promise<void>(() => {}));
  void S().ask("c1", "What did we decide?");
  await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  resetWorkspaceChatForTests();
  ipc.listWorkspaceMessages.mockResolvedValue([]);
  ipc.updateWorkspaceChat.mockImplementation(async (id: string, p: object) => ({ ...chat(id), ...p }));
  useWorkspaceChatStore.setState({ chats: { w1: [chat("c1")] }, activeChat: { w1: "c1" } });
});
afterEach(() => {
  vi.restoreAllMocks();
});

// `workspace_chat_approval` as the backend sends it: a card for the answer being written.
describe("workspace_chat_approval", () => {
  const fixture = loadFixture<Record<string, unknown> & { request_id: string; approval_id: string; args: string }>("workspace_chat_approval");

  it("shows a pending card for the answer it names, with the exact arguments", async () => {
    await startAsk(fixture.request_id);
    h().approval(fixture as never);
    const [card] = S().sessions.c1.turn!.approvals;
    expect(card).toMatchObject({ approvalId: fixture.approval_id, requestId: fixture.request_id, state: "pending", server: "notes", tool: "set_flag", redacted: false, truncated: false });
    expect(card.args).toBe(fixture.args);
  });

  it("is ignored when it names an answer the chat is not writing", async () => {
    await startAsk("another-answer");
    h().approval(fixture as never);
    expect(S().sessions.c1.turn!.approvals).toEqual([]);
  });

  it("answers by the card's approval id", async () => {
    ipc.answerWorkspaceApproval.mockResolvedValue(undefined);
    await startAsk(fixture.request_id);
    h().approval(fixture as never);
    await S().answerApproval(S().sessions.c1.turn!.approvals[0], true);
    expect(ipc.answerWorkspaceApproval).toHaveBeenCalledWith(fixture.approval_id, true);
  });
});
