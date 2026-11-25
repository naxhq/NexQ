// The backend's own examples (generated from the Rust structs and checked on that side) go
// through the real chat store and the real ipc wrapper: whatever the backend can send, the
// chat must read, and what the chat sends must be exactly what the backend takes.
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a), isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

import approval from "./fixtures/answer_workspace_approval.json";
import addAnswer from "./fixtures/add_answer_to_instructions.json";
import { addAnswerToInstructions, answerWorkspaceApproval } from "../lib/ipc";
import { chatEventHandlers, resetWorkspaceChatForTests, useWorkspaceChatStore, type Turn } from "../stores/workspaceChatStore";

const files = import.meta.glob("./fixtures/*.json", { eager: true, import: "default" }) as Record<string, any>;
const named = (re: RegExp) =>
  Object.entries(files)
    .filter(([k]) => re.test(k))
    .map(([k, data]) => ({ name: k.split("/").pop()!.replace(/\.json$/, ""), data }));

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  resetWorkspaceChatForTests();
});

describe("answer_workspace_approval", () => {
  it("sends exactly the arguments the backend's example has", async () => {
    await answerWorkspaceApproval(approval.approvalId, approval.allow);
    expect(invoke).toHaveBeenCalledWith("answer_workspace_approval", approval);
    expect(Object.keys(invoke.mock.calls[0][1] as object).sort()).toEqual(Object.keys(approval).sort());
  });
});

describe("add_answer_to_instructions", () => {
  it("sends exactly the arguments the backend's example has", async () => {
    await addAnswerToInstructions(addAnswer.messageId);
    expect(invoke).toHaveBeenCalledWith("add_answer_to_instructions", addAnswer);
    expect(Object.keys(invoke.mock.calls[0][1] as object)).toEqual(["messageId"]);
  });
});

const turnFor = (chatId: string, requestId: string): Turn => ({
  requestId,
  question: "Q",
  deeper: false,
  text: "",
  model: null,
  status: "streaming",
  activity: [],
  report: null,
  approvals: [],
  error: null,
  errorKind: null,
  startedAt: Date.now(),
});

// Every event the backend gives an example of is read by the matching handler, on a turn that
// holds the example's own ids (so a rename of chat_id or request_id on either side fails here).
const EVENTS = ["start", "token", "activity", "context", "end", "error", "approval", "approval_closed", "approval_refused"] as const;
const handlerOf = (kind: (typeof EVENTS)[number]) =>
  ({ approval_closed: "approvalClosed", approval_refused: "approvalRefused" })[kind as string] ?? kind;

describe("workspace_chat events from the backend", () => {
  const found = EVENTS.flatMap((kind) => named(new RegExp(`(^|/)workspace_chat_${kind}\\.json$`)).map((f) => ({ kind, ...f })));

  it("has an example of every event the backend sends", () => {
    const kinds = new Set(found.map((f) => f.kind));
    for (const k of EVENTS) expect(kinds.has(k), `no workspace_chat_${k}.json fixture`).toBe(true);
  });

  it.each(found)("$name is read by the real store", ({ kind, data }) => {
    const chatId = String(data.chat_id ?? "c-fixture");
    const requestId = String(data.request_id ?? "r-fixture");
    useWorkspaceChatStore.setState({
      sessions: { [chatId]: { messages: [], loaded: true, loading: false, loadError: null, turn: turnFor(chatId, requestId), extras: {}, preview: null, previewing: false, previewFailed: false, excluded: [], itemPrefs: [], capabilities: null } },
    });
    const h = chatEventHandlers() as unknown as Record<string, (e: unknown) => void>;
    expect(() => h[handlerOf(kind)](data)).not.toThrow();
    const after = useWorkspaceChatStore.getState().sessions[chatId];
    // The turn was found by its ids: something changed on it, or it ended into a saved answer.
    if (kind === "end" && !data.cancelled) expect(after.turn).toBeNull();
    else expect(after.turn).not.toBeNull();
    if (kind === "approval") expect(after.turn!.approvals[0]?.approvalId).toBe(data.approval_id);
    if (kind === "context") expect(after.turn!.report).toEqual(data.report);
  });
});

describe("saved messages from the backend", () => {
  const found = named(/(^|\/)(list_workspace_messages|workspace_message)[^/]*\.json$/);
  it("has the saved-message example, with every citation kind", () => {
    expect(found.length, "no list_workspace_messages_result.json fixture").toBeGreaterThan(0);
    const kinds = new Set(found.flatMap((f) => (Array.isArray(f.data) ? f.data : []).flatMap((m: any) => m.citations.map((c: any) => c.kind))));
    for (const k of ["transcript", "document", "folder", "talking_point"]) expect(kinds.has(k), k).toBe(true);
  });
  it.each(found)("$name loads into the store and keeps what was sent", async ({ data }) => {
    const list = Array.isArray(data) ? data : (data.output ?? data.messages ?? []);
    invoke.mockImplementation(async (cmd: string) => (cmd === "list_workspace_messages" ? list : undefined));
    useWorkspaceChatStore.setState({ chats: { w: [{ id: "c1", workspace_id: "w" } as never] }, activeChat: { w: "c1" } });
    await useWorkspaceChatStore.getState().loadMessages("c1");
    expect(useWorkspaceChatStore.getState().sessions.c1.messages).toHaveLength(list.length);
  });
});
