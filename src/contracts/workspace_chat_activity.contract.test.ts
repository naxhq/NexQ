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

// `workspace_chat_activity`: one line of what the answer's tools are doing.
describe("workspace_chat_activity", () => {
  const fixture = loadFixture<{ chat_id: string; request_id: string; activity: Record<string, unknown> }>("workspace_chat_activity");

  it("adds the line to the answer it names", async () => {
    await startAsk(fixture.request_id);
    h().activity(fixture as never);
    expect(S().sessions.c1.turn!.activity).toEqual([fixture.activity]);
  });

  it("is dropped for another answer", async () => {
    await startAsk("another-answer");
    h().activity(fixture as never);
    expect(S().sessions.c1.turn!.activity).toEqual([]);
  });
});
