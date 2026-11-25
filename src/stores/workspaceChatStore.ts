import { create } from "zustand";
import type {
  ChatItemPrefValue,
  ContextReport,
  SourceActivity,
  WorkspaceChat,
  WorkspaceChatPatch,
  WorkspaceMessage,
} from "../lib/types";
import * as ipc from "../lib/ipc";
import {
  onWorkspaceChatActivity,
  onWorkspaceChatApproval,
  onWorkspaceChatApprovalClosed,
  onWorkspaceChatContext,
  onWorkspaceChatEnd,
  onWorkspaceChatError,
  onWorkspaceChatStart,
  onWorkspaceChatToken,
} from "../lib/events";
import { showToast } from "./toastStore";

// Workspace chat state. One store for the launcher window: streams are held here (not in a
// component), so leaving the pane never cancels an answer, and two chats can run at once.
// Every event is matched on chat_id and request_id; anything for a request we no longer
// hold (cancelled, replaced, finished) is dropped.

/** Seconds a tool approval waits before the backend denies it (spec: 60 s, below the 90 s watchdog). */
export const APPROVAL_SECONDS = 60;
/** How long "Stopping" waits for the end event before the stop is shown anyway. */
const STOP_GRACE_MS = 8000;
const TOKEN_FLUSH_MS = 32;

export type ApprovalState = "pending" | "sending" | "allowed" | "denied" | "expired" | "failed" | "closed";

export interface Approval {
  approvalId: string;
  chatId: string;
  requestId: string;
  server: string;
  tool: string;
  args: unknown;
  receivedAt: number;
  state: ApprovalState;
  /** The arguments were cut by the backend. */
  truncated: boolean;
  /** Secrets were hidden in the arguments. */
  redacted: boolean;
  /** Why a closed card closed ("answered", "timeout", "cancelled"). */
  closedReason?: string;
}

export type TurnStatus = "waiting" | "streaming" | "stopping" | "stopped" | "failed";

/** The answer being written (or the one that stopped or failed), before it is saved. */
export interface Turn {
  requestId: string;
  question: string;
  deeper: boolean;
  text: string;
  model: string | null;
  status: TurnStatus;
  activity: SourceActivity[];
  report: ContextReport | null;
  approvals: Approval[];
  error: string | null;
  startedAt: number;
}

/** What the view remembers about a saved answer (not stored by the backend). */
export interface AnswerExtras {
  activity: SourceActivity[];
  approvals: Approval[];
}

export interface ChatSession {
  messages: WorkspaceMessage[];
  loaded: boolean;
  loading: boolean;
  loadError: string | null;
  turn: Turn | null;
  extras: Record<number, AnswerExtras>;
  preview: ContextReport | null;
  previewing: boolean;
  previewFailed: boolean;
  /** Meetings left out of this chat (a mirror of what was sent to the backend, which has no getter). */
  excluded: string[];
}

const emptySession = (): ChatSession => ({
  messages: [],
  loaded: false,
  loading: false,
  loadError: null,
  turn: null,
  extras: {},
  preview: null,
  previewing: false,
  previewFailed: false,
  excluded: [],
});

export const EMPTY_SESSION: ChatSession = Object.freeze(emptySession()) as ChatSession;
export const NO_CHATS: WorkspaceChat[] = [];

// ── Remembered bits (this window's storage; never required) ────────────────────

const PREF = {
  active: (ws: string) => `nexq_ws_chat_active_${ws}`,
  draft: (key: string) => `nexq_ws_chat_draft_${key}`,
  excluded: (chat: string) => `nexq_ws_chat_excluded_${chat}`,
  wave: "nexq_ws_chat_wave_open",
} as const;

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writePref(key: string, value: string | null) {
  try {
    if (value === null || value === "") localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* not remembered */
  }
}

export function readWaveOpen(): boolean {
  return readPref(PREF.wave) === "1";
}
export function writeWaveOpen(open: boolean) {
  writePref(PREF.wave, open ? "1" : "0");
}

/** Where the draft of a chat lives; a chat that doesn't exist yet uses its workspace. */
export function draftKey(chatId: string | null, workspaceId: string): string {
  return chatId ?? `new:${workspaceId}`;
}

// Scroll positions change on every wheel tick: a plain map, not state.
const scrollPositions = new Map<string, number>();
export const chatScroll = {
  get: (chatId: string) => scrollPositions.get(chatId),
  set: (chatId: string, top: number) => void scrollPositions.set(chatId, top),
  clear: (chatId: string) => void scrollPositions.delete(chatId),
};

let localSeq = 0;
const newRequestId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `req-${Date.now()}-${++localSeq}`;

const tokenBuffers = new Map<string, string>();
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
const approvalTimers = new Map<string, ReturnType<typeof setTimeout>>();
const stopTimers = new Map<string, ReturnType<typeof setTimeout>>();
const loadSeq = new Map<string, number>();
const previewSeq = new Map<string, number>();
const chatsSeq = new Map<string, number>();

/** Chats created here that have no message yet (the backend has no message count). */
const knownEmpty = new Set<string>();
export const isKnownEmpty = (chatId: string) => knownEmpty.has(chatId);
/** Empty by the backend's count when it gives one, else by what this window saw. */
export const isEmptyChat = (c: WorkspaceChat) => (c.message_count !== undefined ? c.message_count === 0 : knownEmpty.has(c.id));

const isBusy = (t: Turn | null | undefined) => !!t && (t.status === "waiting" || t.status === "streaming" || t.status === "stopping");

// ── Writes that shape an answer (model, depth, scope, pins) go one at a time per chat, in order,
// and a question waits for them: it is never sent on settings the backend hasn't confirmed. ──
const writeQueues = new Map<string, Promise<boolean>>();
const inflight = new Map<string, Set<Promise<boolean>>>();

function enqueueWrite(chatId: string, job: () => Promise<boolean>): Promise<boolean> {
  const prev = writeQueues.get(chatId) ?? Promise.resolve(true);
  const next = prev.then(() => job()).catch(() => false);
  writeQueues.set(chatId, next);
  let set = inflight.get(chatId);
  if (!set) inflight.set(chatId, (set = new Set()));
  set.add(next);
  void next.finally(() => {
    set!.delete(next);
    if (set!.size === 0) {
      inflight.delete(chatId);
      writeQueues.delete(chatId);
    }
  });
  return next;
}
const hasPendingWrites = (chatId: string) => (inflight.get(chatId)?.size ?? 0) > 0;

interface ChatState {
  chats: Record<string, WorkspaceChat[]>;
  chatsLoaded: Record<string, boolean>;
  chatsError: Record<string, string | null>;
  activeChat: Record<string, string | null>;
  sessions: Record<string, ChatSession>;
  drafts: Record<string, string>;

  loadChats: (workspaceId: string) => Promise<void>;
  selectChat: (workspaceId: string, chatId: string | null) => void;
  /** The active chat, or a new one (an empty one is reused). */
  ensureChat: (workspaceId: string) => Promise<string | null>;
  newChat: (workspaceId: string) => Promise<string | null>;
  renameChat: (chatId: string, title: string) => Promise<void>;
  deleteChat: (chatId: string) => Promise<void>;
  updateChat: (chatId: string, patch: WorkspaceChatPatch) => Promise<boolean>;
  loadMessages: (chatId: string) => Promise<void>;

  setDraft: (key: string, text: string) => void;
  /** Waits for settings still being saved; false (and a message) when one failed, so nothing is sent. */
  settleWrites: (chatId: string) => Promise<boolean>;
  ask: (chatId: string, question: string, opts?: { deeper?: boolean }) => Promise<boolean>;
  stop: (chatId: string) => Promise<void>;
  dismissTurn: (chatId: string) => void;
  answerApproval: (approval: Approval, allow: boolean) => Promise<void>;
  refreshPreview: (chatId: string, question?: string) => Promise<void>;
  setItemPref: (chatId: string, kind: string, refId: string, pref: ChatItemPrefValue) => Promise<boolean>;
  setMeetingIncluded: (workspaceId: string, chatId: string, meetingId: string, included: boolean) => Promise<boolean>;
}

type Setter = (fn: (s: ChatState) => Partial<ChatState>) => void;

function patchSession(set: Setter, chatId: string, fn: (s: ChatSession) => Partial<ChatSession>) {
  set((s) => {
    const cur = s.sessions[chatId] ?? emptySession();
    return { sessions: { ...s.sessions, [chatId]: { ...cur, ...fn(cur) } } };
  });
}

const sortChats = (list: WorkspaceChat[]) => [...list].sort((a, b) => b.updated_at - a.updated_at);

const DEFAULT_TITLE = /^(new chat|untitled|new conversation)?$/i;
function titleFrom(question: string): string {
  const one = question.replace(/\s+/g, " ").trim();
  return one.length > 48 ? `${one.slice(0, 47).trimEnd()}…` : one;
}

const asText = (e: unknown) => (e instanceof Error ? e.message : typeof e === "string" ? e : String(e));

let handlers: Handlers;

export const useWorkspaceChatStore = create<ChatState>((set, get) => {
  const turnOf = (chatId: string, requestId: string): Turn | null => {
    const t = get().sessions[chatId]?.turn;
    return t && t.requestId === requestId ? t : null;
  };
  const patchTurn = (chatId: string, requestId: string, fn: (t: Turn) => Partial<Turn>) => {
    if (!turnOf(chatId, requestId)) return;
    patchSession(set, chatId, (s) => (s.turn && s.turn.requestId === requestId ? { turn: { ...s.turn, ...fn(s.turn) } } : {}));
  };

  const flushTokens = (chatId: string, requestId: string) => {
    const timer = flushTimers.get(requestId);
    if (timer) clearTimeout(timer);
    flushTimers.delete(requestId);
    const buffered = tokenBuffers.get(requestId);
    tokenBuffers.delete(requestId);
    if (!buffered) return;
    patchTurn(chatId, requestId, (t) =>
      t.status === "waiting" || t.status === "streaming" ? { text: t.text + buffered, status: "streaming" } : {},
    );
  };

  const settleApprovals = (approvals: Approval[]): Approval[] =>
    approvals.map((a) => {
      if (a.state === "pending" || a.state === "sending") {
        const timer = approvalTimers.get(a.approvalId);
        if (timer) clearTimeout(timer);
        approvalTimers.delete(a.approvalId);
        return { ...a, state: "expired" as const };
      }
      return a;
    });

  /** The saved list, after an answer: the backend's ids replace the ones made here. */
  const reconcile = async (chatId: string, mustHave?: number) => {
    const mine = (loadSeq.get(chatId) ?? 0) + 1;
    loadSeq.set(chatId, mine);
    try {
      const saved = await ipc.listWorkspaceMessages(chatId);
      if (loadSeq.get(chatId) !== mine) return;
      if (mustHave !== undefined && !saved.some((m) => m.id === mustHave)) return;
      patchSession(set, chatId, () => ({ messages: saved, loaded: true, loadError: null }));
    } catch {
      /* the local copy stays */
    }
  };

  const finishOk = (chatId: string, requestId: string, message: WorkspaceMessage) => {
    const turn = turnOf(chatId, requestId);
    if (!turn) return;
    flushTokens(chatId, requestId);
    const settled = settleApprovals(turn.approvals);
    const temp: WorkspaceMessage = {
      id: -(++localSeq),
      chat_id: chatId,
      role: "user",
      content: turn.question,
      model: null,
      citations: [],
      context: null,
      input_tokens: 0,
      output_tokens: 0,
      created_at: turn.startedAt,
    };
    knownEmpty.delete(chatId);
    patchSession(set, chatId, (s) => ({
      turn: null,
      messages: [...s.messages.filter((m) => m.id !== message.id), temp, message],
      extras: { ...s.extras, [message.id]: { activity: turn.activity, approvals: settled } },
    }));
    // The first answer names an untitled chat.
    const chat = Object.values(get().chats)
      .flat()
      .find((c) => c.id === chatId);
    if (chat && DEFAULT_TITLE.test(chat.title.trim()) && !turn.deeper) void get().renameChat(chatId, titleFrom(turn.question));
    void reconcile(chatId, message.id);
  };

  const failTurn = (chatId: string, requestId: string, error: string) => {
    if (!turnOf(chatId, requestId)) return;
    flushTokens(chatId, requestId);
    const stop = stopTimers.get(requestId);
    if (stop) clearTimeout(stop);
    stopTimers.delete(requestId);
    patchTurn(chatId, requestId, (t) => ({ status: "failed", error, approvals: settleApprovals(t.approvals) }));
  };

  return {
    chats: {},
    chatsLoaded: {},
    chatsError: {},
    activeChat: {},
    sessions: {},
    drafts: {},

    loadChats: async (workspaceId) => {
      const mine = (chatsSeq.get(workspaceId) ?? 0) + 1;
      chatsSeq.set(workspaceId, mine);
      try {
        const list = sortChats(await ipc.listWorkspaceChats(workspaceId));
        if (chatsSeq.get(workspaceId) !== mine) return;
        const remembered = readPref(PREF.active(workspaceId));
        set((s) => {
          const current = s.activeChat[workspaceId];
          const keep = current && list.some((c) => c.id === current) ? current : null;
          const pick = keep ?? (remembered && list.some((c) => c.id === remembered) ? remembered : (list[0]?.id ?? null));
          return {
            chats: { ...s.chats, [workspaceId]: list },
            chatsLoaded: { ...s.chatsLoaded, [workspaceId]: true },
            chatsError: { ...s.chatsError, [workspaceId]: null },
            activeChat: { ...s.activeChat, [workspaceId]: pick },
          };
        });
        const picked = get().activeChat[workspaceId];
        if (picked) void get().loadMessages(picked);
      } catch (e) {
        if (chatsSeq.get(workspaceId) !== mine) return;
        set((s) => ({
          chatsLoaded: { ...s.chatsLoaded, [workspaceId]: true },
          chatsError: { ...s.chatsError, [workspaceId]: asText(e) },
        }));
      }
    },

    selectChat: (workspaceId, chatId) => {
      set((s) => ({ activeChat: { ...s.activeChat, [workspaceId]: chatId } }));
      writePref(PREF.active(workspaceId), chatId);
      if (chatId) void get().loadMessages(chatId);
    },

    ensureChat: async (workspaceId) => {
      const active = get().activeChat[workspaceId];
      if (active) return active;
      return get().newChat(workspaceId);
    },

    newChat: async (workspaceId) => {
      // One empty chat at a time: "New chat" goes to the one that is already empty.
      const empty = (get().chats[workspaceId] ?? NO_CHATS).find((c) => {
        const s = get().sessions[c.id];
        return isEmptyChat(c) && !(s?.messages.length) && !isBusy(s?.turn) && !get().drafts[c.id];
      });
      if (empty) {
        get().selectChat(workspaceId, empty.id);
        return empty.id;
      }
      try {
        const chat = await ipc.createWorkspaceChat(workspaceId);
        knownEmpty.add(chat.id);
        set((s) => ({
          chats: { ...s.chats, [workspaceId]: sortChats([chat, ...(s.chats[workspaceId] ?? [])]) },
          sessions: { ...s.sessions, [chat.id]: { ...emptySession(), loaded: true } },
          // What was typed before the chat existed moves into it.
          drafts: moveDraft(s.drafts, draftKey(null, workspaceId), chat.id),
        }));
        get().selectChat(workspaceId, chat.id);
        return chat.id;
      } catch (e) {
        showToast(`Couldn't start a chat: ${asText(e)}`, "error");
        return null;
      }
    },

    renameChat: async (chatId, title) => {
      const next = title.trim();
      if (!next) return;
      const before = findChat(get().chats, chatId);
      if (!before || before.title === next) return;
      mutateChat(set, chatId, { title: next });
      try {
        const saved = await ipc.updateWorkspaceChat(chatId, { title: next });
        mutateChat(set, chatId, saved);
      } catch (e) {
        mutateChat(set, chatId, { title: before.title });
        showToast(`Couldn't rename the chat: ${asText(e)}`, "error");
      }
    },

    deleteChat: async (chatId) => {
      const chat = findChat(get().chats, chatId);
      if (!chat) return;
      const turn = get().sessions[chatId]?.turn;
      if (isBusy(turn) && turn) Promise.resolve().then(() => ipc.cancelWorkspaceRequest(turn.requestId)).catch(() => {});
      try {
        await ipc.deleteWorkspaceChat(chatId);
      } catch (e) {
        showToast(`Couldn't delete the chat: ${asText(e)}`, "error");
        return;
      }
      const ws = chat.workspace_id;
      knownEmpty.delete(chatId);
      chatScroll.clear(chatId);
      writePref(PREF.draft(chatId), null);
      writePref(PREF.excluded(chatId), null);
      set((s) => {
        const list = (s.chats[ws] ?? []).filter((c) => c.id !== chatId);
        const { [chatId]: _s, ...sessions } = s.sessions;
        const { [chatId]: _d, ...drafts } = s.drafts;
        const wasActive = s.activeChat[ws] === chatId;
        return {
          chats: { ...s.chats, [ws]: list },
          sessions,
          drafts,
          activeChat: wasActive ? { ...s.activeChat, [ws]: list[0]?.id ?? null } : s.activeChat,
        };
      });
      const next = get().activeChat[ws];
      writePref(PREF.active(ws), next);
      if (next) void get().loadMessages(next);
    },

    updateChat: (chatId, patch) => {
      const before = findChat(get().chats, chatId);
      if (!before) return Promise.resolve(false);
      mutateChat(set, chatId, patch);
      return enqueueWrite(chatId, async () => {
        try {
          const saved = await ipc.updateWorkspaceChat(chatId, patch);
          // Only what this write was about; a later write's value is not overwritten.
          mutateChat(set, chatId, pickKeys(saved, Object.keys(patch)));
          return true;
        } catch (e) {
          mutateChat(set, chatId, pickKeys(before, Object.keys(patch)));
          showToast(`Couldn't change the chat: ${asText(e)}`, "error");
          return false;
        }
      });
    },

    loadMessages: async (chatId) => {
      const cur = get().sessions[chatId];
      if (cur?.loaded || cur?.loading) return;
      const mine = (loadSeq.get(chatId) ?? 0) + 1;
      loadSeq.set(chatId, mine);
      const excluded = readExcluded(chatId);
      patchSession(set, chatId, () => ({ loading: true, loadError: null, excluded }));
      // The backend's own list is the truth; the local mirror is only for older backends.
      const wsOf = findChat(get().chats, chatId)?.workspace_id;
      if (wsOf) {
        Promise.resolve().then(() => ipc.listChatMeetingPrefs(wsOf, chatId)).then(
          (prefs) => {
            if (!Array.isArray(prefs)) return;
            const left = prefs.filter((p) => !p.included).map((p) => p.meeting_id);
            patchSession(set, chatId, () => ({ excluded: left }));
          },
          () => {},
        );
      }
      try {
        const saved = await ipc.listWorkspaceMessages(chatId);
        if (loadSeq.get(chatId) !== mine) return;
        if (saved.length === 0) knownEmpty.add(chatId);
        // An answer that finished while the list loaded stays in it.
        patchSession(set, chatId, (s) => ({
          messages: mergeLoaded(saved, s.messages),
          loaded: true,
          loading: false,
        }));
      } catch (e) {
        if (loadSeq.get(chatId) !== mine) return;
        patchSession(set, chatId, () => ({ loading: false, loadError: asText(e) }));
      }
    },

    setDraft: (key, text) => {
      set((s) => (s.drafts[key] === text ? {} : { drafts: { ...s.drafts, [key]: text } }));
      writePref(PREF.draft(key), text.length > 8000 ? text.slice(0, 8000) : text);
    },

    settleWrites: async (chatId) => {
      if (!hasPendingWrites(chatId)) return true;
      const results = await Promise.all([...(inflight.get(chatId) ?? [])]);
      if (results.every(Boolean)) return true;
      showToast("A setting didn't save, so the question wasn't sent. Check it and ask again.", "error");
      return false;
    },

    ask: async (chatId, raw, opts = {}) => {
      const question = raw.trim();
      if (!question) return false;
      if (hasPendingWrites(chatId) && !(await get().settleWrites(chatId))) return false;
      if (isBusy(get().sessions[chatId]?.turn)) return false;
      const requestId = newRequestId();
      const deeper = !!opts.deeper;
      patchSession(set, chatId, () => ({
        turn: {
          requestId,
          question,
          deeper,
          text: "",
          model: null,
          status: "waiting",
          activity: [],
          report: null,
          approvals: [],
          error: null,
          startedAt: Date.now(),
        },
      }));
      try {
        await ipc.askWorkspace(chatId, question, requestId, deeper);
      } catch (e) {
        const t = turnOf(chatId, requestId);
        if (t && t.status !== "stopped" && t.status !== "failed") failTurn(chatId, requestId, asText(e));
        return false;
      }
      // Resolved: the end event normally came first. If it didn't, ask the backend what it saved.
      const t = turnOf(chatId, requestId);
      if (t && t.status !== "stopped" && t.status !== "failed" && t.status !== "stopping") {
        try {
          const saved = await ipc.listWorkspaceMessages(chatId);
          const last = saved[saved.length - 1];
          const still = turnOf(chatId, requestId);
          if (still && last && last.role === "assistant" && last.created_at >= still.startedAt - 2000) finishOk(chatId, requestId, last);
        } catch {
          /* the end event will settle it */
        }
      }
      return true;
    },

    stop: async (chatId) => {
      const t = get().sessions[chatId]?.turn;
      if (!t || (t.status !== "waiting" && t.status !== "streaming")) return;
      const before = t.status;
      patchTurn(chatId, t.requestId, () => ({ status: "stopping" }));
      stopTimers.set(
        t.requestId,
        setTimeout(() => {
          stopTimers.delete(t.requestId);
          flushTokens(chatId, t.requestId);
          patchTurn(chatId, t.requestId, (cur) => (cur.status === "stopping" ? { status: "stopped", approvals: settleApprovals(cur.approvals) } : {}));
        }, STOP_GRACE_MS),
      );
      try {
        await ipc.cancelWorkspaceRequest(t.requestId);
      } catch (e) {
        const timer = stopTimers.get(t.requestId);
        if (timer) clearTimeout(timer);
        stopTimers.delete(t.requestId);
        patchTurn(chatId, t.requestId, (cur) => (cur.status === "stopping" ? { status: before } : {}));
        showToast(`Couldn't stop the answer: ${asText(e)}`, "error");
      }
    },

    dismissTurn: (chatId) => {
      const t = get().sessions[chatId]?.turn;
      if (!t || isBusy(t)) return;
      patchSession(set, chatId, () => ({ turn: null }));
    },

    answerApproval: async (approval, allow) => {
      if (approval.state !== "pending") return;
      const timer = approvalTimers.get(approval.approvalId);
      if (timer) clearTimeout(timer);
      approvalTimers.delete(approval.approvalId);
      setApproval(set, approval, "sending");
      try {
        await ipc.answerWorkspaceApproval(approval.approvalId, allow);
        setApproval(set, approval, allow ? "allowed" : "denied");
      } catch {
        // Usually: too late, the backend already denied it.
        setApproval(set, approval, "failed");
      }
    },

    refreshPreview: async (chatId, question) => {
      const mine = (previewSeq.get(chatId) ?? 0) + 1;
      previewSeq.set(chatId, mine);
      patchSession(set, chatId, () => ({ previewing: true }));
      try {
        const report = await ipc.previewChatContext(chatId, question?.trim() ? question.trim() : undefined);
        if (previewSeq.get(chatId) !== mine) return;
        patchSession(set, chatId, () => ({ preview: report, previewing: false, previewFailed: false }));
      } catch {
        if (previewSeq.get(chatId) !== mine) return;
        patchSession(set, chatId, () => ({ previewing: false, previewFailed: true }));
      }
    },

    setItemPref: (chatId, kind, refId, pref) =>
      enqueueWrite(chatId, async () => {
        try {
          await ipc.setChatItemPref(chatId, kind, refId, pref);
          void get().refreshPreview(chatId);
          return true;
        } catch (e) {
          showToast(`Couldn't change that item: ${asText(e)}`, "error");
          return false;
        }
      }),

    setMeetingIncluded: (workspaceId, chatId, meetingId, included) => {
      const toggle = (list: string[], leaveOut: boolean) =>
        leaveOut ? (list.includes(meetingId) ? list : [...list, meetingId]) : list.filter((id) => id !== meetingId);
      const apply = (leaveOut: boolean) => {
        let next: string[] = [];
        patchSession(set, chatId, (s) => ({ excluded: (next = toggle(s.excluded, leaveOut)) }));
        writePref(PREF.excluded(chatId), next.length ? JSON.stringify(next) : null);
      };
      apply(!included);
      return enqueueWrite(chatId, async () => {
        let ok = true;
        try {
          await ipc.setChatMeetingIncluded(workspaceId, chatId, meetingId, included);
        } catch (e) {
          ok = false;
          // Only this meeting goes back to what it was; it shows as it really is, with the reason.
          apply(included);
          showToast(`Couldn't ${included ? "use" : "leave out"} that meeting: ${asText(e)}`, "error");
        }
        // The backend's list is the truth once the last write is done.
        if ((inflight.get(chatId)?.size ?? 0) <= 1) {
          try {
            const prefs = await ipc.listChatMeetingPrefs(workspaceId, chatId);
            if (Array.isArray(prefs) && (inflight.get(chatId)?.size ?? 0) <= 1) {
              const left = prefs.filter((p) => !p.included).map((p) => p.meeting_id);
              patchSession(set, chatId, () => ({ excluded: left }));
              writePref(PREF.excluded(chatId), left.length ? JSON.stringify(left) : null);
            }
          } catch {
            /* the local mirror stays */
          }
        }
        return ok;
      });
    },

    // Used by the event handlers below.
    ...(internal(set, get, { turnOf, patchTurn, flushTokens, finishOk, failTurn }) as object),
  } as ChatState;
});

// ── Helpers that need the store but not its state ────────────────────────────────

function pickKeys<T extends object>(from: T, keys: string[]): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) if (k in from) (out as Record<string, unknown>)[k] = (from as Record<string, unknown>)[k];
  return out;
}

function findChat(all: Record<string, WorkspaceChat[]>, chatId: string): WorkspaceChat | undefined {
  for (const list of Object.values(all)) {
    const hit = list.find((c) => c.id === chatId);
    if (hit) return hit;
  }
  return undefined;
}

function mutateChat(set: Setter, chatId: string, patch: Partial<WorkspaceChat>) {
  set((s) => {
    const chats: Record<string, WorkspaceChat[]> = {};
    for (const [ws, list] of Object.entries(s.chats)) chats[ws] = list.map((c) => (c.id === chatId ? { ...c, ...patch, id: c.id } : c));
    return { chats };
  });
}

function moveDraft(drafts: Record<string, string>, from: string, to: string): Record<string, string> {
  const text = drafts[from];
  if (!text) return drafts;
  const { [from]: _gone, ...rest } = drafts;
  writePref(PREF.draft(from), null);
  writePref(PREF.draft(to), text);
  return { ...rest, [to]: text };
}

function readExcluded(chatId: string): string[] {
  try {
    const raw = readPref(PREF.excluded(chatId));
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** The loaded list, plus answers finished here before it arrived. */
function mergeLoaded(saved: WorkspaceMessage[], local: WorkspaceMessage[]): WorkspaceMessage[] {
  if (local.length === 0) return saved;
  const ids = new Set(saved.map((m) => m.id));
  const extra = local.filter((m) => m.id > 0 && !ids.has(m.id));
  return extra.length ? [...saved, ...extra] : saved;
}

function setApproval(set: Setter, approval: Approval, state: ApprovalState, closedReason?: string) {
  const swap = (a: Approval): Approval => (a.approvalId === approval.approvalId ? { ...a, state, ...(closedReason ? { closedReason } : {}) } : a);
  patchSession(set, approval.chatId, (s) => ({
    turn: s.turn && s.turn.requestId === approval.requestId ? { ...s.turn, approvals: s.turn.approvals.map(swap) } : s.turn,
    extras: Object.fromEntries(Object.entries(s.extras).map(([id, x]) => [id, { ...x, approvals: x.approvals.map(swap) }])),
  }));
}

/** Event handlers kept apart so tests can drive them without Tauri. */
function internal(
  set: Setter,
  get: () => ChatState,
  h: {
    turnOf: (chatId: string, requestId: string) => Turn | null;
    patchTurn: (chatId: string, requestId: string, fn: (t: Turn) => Partial<Turn>) => void;
    flushTokens: (chatId: string, requestId: string) => void;
    finishOk: (chatId: string, requestId: string, message: WorkspaceMessage) => void;
    failTurn: (chatId: string, requestId: string, error: string) => void;
  },
) {
  handlers = {
    start: (e) => h.patchTurn(e.chat_id, e.request_id, (t) => (t.status === "waiting" ? { model: e.model, status: "streaming" } : { model: e.model })),
    token: (e) => {
      const t = h.turnOf(e.chat_id, e.request_id);
      // Late tokens of a stopped or failed answer are dropped.
      if (!t || (t.status !== "waiting" && t.status !== "streaming")) return;
      tokenBuffers.set(e.request_id, (tokenBuffers.get(e.request_id) ?? "") + e.token);
      if (!flushTimers.has(e.request_id)) {
        flushTimers.set(
          e.request_id,
          setTimeout(() => h.flushTokens(e.chat_id, e.request_id), TOKEN_FLUSH_MS),
        );
      }
    },
    activity: (e) => h.patchTurn(e.chat_id, e.request_id, (t) => ({ activity: [...t.activity, e.activity] })),
    context: (e) => h.patchTurn(e.chat_id, e.request_id, () => ({ report: e.report })),
    end: (e) => {
      const t = h.turnOf(e.chat_id, e.request_id);
      if (!t) return;
      h.flushTokens(e.chat_id, e.request_id);
      const stopTimer = stopTimers.get(e.request_id);
      if (stopTimer) clearTimeout(stopTimer);
      stopTimers.delete(e.request_id);
      if (e.cancelled) {
        const cur = h.turnOf(e.chat_id, e.request_id) ?? t;
        h.patchTurn(e.chat_id, e.request_id, () => ({
          status: "stopped",
          text: e.message?.content || cur.text,
          approvals: cur.approvals.map((a) => (a.state === "pending" || a.state === "sending" ? { ...a, state: "expired" as const } : a)),
        }));
        return;
      }
      h.finishOk(e.chat_id, e.request_id, e.message);
    },
    error: (e) => h.failTurn(e.chat_id, e.request_id, e.error),
    approvalClosed: (e) => {
      const timer = approvalTimers.get(e.approval_id);
      if (timer) clearTimeout(timer);
      approvalTimers.delete(e.approval_id);
      const found = get().sessions[e.chat_id]?.turn?.approvals.find((a) => a.approvalId === e.approval_id);
      // A card we already answered keeps its own result.
      if (found && (found.state === "pending" || found.state === "sending")) setApproval(set, found, e.reason === "timeout" ? "expired" : "closed", e.reason);
    },
    approval: (e) => {
      const t = h.turnOf(e.chat_id, e.request_id);
      if (!t || (t.status !== "waiting" && t.status !== "streaming")) return;
      if (t.approvals.some((a) => a.approvalId === e.approval_id)) return;
      const approval: Approval = {
        approvalId: e.approval_id,
        chatId: e.chat_id,
        requestId: e.request_id,
        server: e.server,
        tool: e.tool,
        args: e.args,
        receivedAt: Date.now(),
        state: "pending",
        truncated: !!e.truncated,
        redacted: !!e.redacted,
      };
      h.patchTurn(e.chat_id, e.request_id, (cur) => ({ approvals: [...cur.approvals, approval] }));
      approvalTimers.set(
        e.approval_id,
        setTimeout(() => {
          approvalTimers.delete(e.approval_id);
          const live = get().sessions[e.chat_id]?.turn?.approvals.find((a) => a.approvalId === e.approval_id);
          if (live?.state === "pending") setApproval(set, live, "expired");
        }, APPROVAL_SECONDS * 1000),
      );
    },
  };
  return {};
}

type Handlers = {
  start: (e: Parameters<Parameters<typeof onWorkspaceChatStart>[0]>[0]) => void;
  token: (e: Parameters<Parameters<typeof onWorkspaceChatToken>[0]>[0]) => void;
  activity: (e: Parameters<Parameters<typeof onWorkspaceChatActivity>[0]>[0]) => void;
  context: (e: Parameters<Parameters<typeof onWorkspaceChatContext>[0]>[0]) => void;
  end: (e: Parameters<Parameters<typeof onWorkspaceChatEnd>[0]>[0]) => void;
  error: (e: Parameters<Parameters<typeof onWorkspaceChatError>[0]>[0]) => void;
  approval: (e: Parameters<Parameters<typeof onWorkspaceChatApproval>[0]>[0]) => void;
  approvalClosed: (e: Parameters<Parameters<typeof onWorkspaceChatApprovalClosed>[0]>[0]) => void;
};

/** The event handlers, for tests that don't have the Tauri bus. */
export function chatEventHandlers(): Handlers {
  return handlers;
}

let watching: Promise<() => void> | null = null;

/**
 * The launcher window calls this once (the chat pane does too, so it is safe to call twice).
 * Never stopped by leaving the pane: that is what keeps an answer running while you look elsewhere.
 */
export function watchWorkspaceChats(): Promise<() => void> {
  if (watching) return watching;
  watching = (async () => {
    const stops: Array<() => void> = [];
    const add = async (p: Promise<() => void>) => {
      try {
        stops.push(await p);
      } catch {
        /* no event bridge (browser preview) */
      }
    };
    const h = () => handlers;
    await add(onWorkspaceChatStart((e) => h().start(e)));
    await add(onWorkspaceChatToken((e) => h().token(e)));
    await add(onWorkspaceChatActivity((e) => h().activity(e)));
    await add(onWorkspaceChatContext((e) => h().context(e)));
    await add(onWorkspaceChatEnd((e) => h().end(e)));
    await add(onWorkspaceChatError((e) => h().error(e)));
    await add(onWorkspaceChatApproval((e) => h().approval(e)));
    await add(onWorkspaceChatApprovalClosed((e) => h().approvalClosed(e)));
    return () => {
      stops.forEach((s) => s());
      watching = null;
    };
  })();
  return watching;
}

/** Tests: forget everything (timers, buffers, remembered drafts are left to the test's storage). */
export function resetWorkspaceChatForTests() {
  for (const m of [flushTimers, approvalTimers, stopTimers]) {
    m.forEach((t) => clearTimeout(t));
    m.clear();
  }
  tokenBuffers.clear();
  loadSeq.clear();
  previewSeq.clear();
  chatsSeq.clear();
  knownEmpty.clear();
  scrollPositions.clear();
  writeQueues.clear();
  inflight.clear();
  useWorkspaceChatStore.setState({ chats: {}, chatsLoaded: {}, chatsError: {}, activeChat: {}, sessions: {}, drafts: {} });
}

/** Reads a remembered draft (the store keeps it in memory after the first read). */
export function rememberedDraft(key: string): string {
  return readPref(PREF.draft(key)) ?? "";
}
