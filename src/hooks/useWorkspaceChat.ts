import { useCallback, useEffect, useMemo } from "react";
import type { WorkspaceChat } from "../lib/types";
import {
  EMPTY_SESSION,
  NO_CHATS,
  draftKey,
  isKnownEmpty,
  rememberedDraft,
  useWorkspaceChatStore,
  watchWorkspaceChats,
  type ChatSession,
} from "../stores/workspaceChatStore";
import { useWorkspaceStore } from "../stores/workspaceStore";

export interface WorkspaceChatView {
  /** Chats worth listing: an empty one is hidden unless it is open. */
  chats: WorkspaceChat[];
  loaded: boolean;
  error: string | null;
  chat: WorkspaceChat | null;
  chatId: string | null;
  session: ChatSession;
  draftKey: string;
  draft: string;
  setDraft: (text: string) => void;
  /** Something is being written in any chat (a running meeting allows one answer at a time). */
  anyBusy: boolean;
}

const isBusyStatus = (s: string) => s === "waiting" || s === "streaming" || s === "stopping";

/**
 * The open workspace's chats and the open chat's state. Subscribes the window to the chat
 * events once and never unsubscribes: leaving the pane does not cancel an answer.
 */
export function useWorkspaceChat(workspaceId: string): WorkspaceChatView {
  const chatsAll = useWorkspaceChatStore((s) => s.chats[workspaceId]) ?? NO_CHATS;
  const loaded = useWorkspaceChatStore((s) => !!s.chatsLoaded[workspaceId]);
  const error = useWorkspaceChatStore((s) => s.chatsError[workspaceId] ?? null);
  const chatId = useWorkspaceChatStore((s) => s.activeChat[workspaceId] ?? null);
  const session = useWorkspaceChatStore((s) => (chatId ? s.sessions[chatId] : undefined)) ?? EMPTY_SESSION;
  const key = draftKey(chatId, workspaceId);
  const stored = useWorkspaceChatStore((s) => s.drafts[key]);
  const anyBusy = useWorkspaceChatStore((s) => Object.values(s.sessions).some((x) => !!x.turn && isBusyStatus(x.turn.status)));
  const revision = useWorkspaceStore((s) => s.revision);

  useEffect(() => {
    void watchWorkspaceChats();
  }, []);

  // The list loads when the workspace opens and again when workspaces change (counts, deletes).
  useEffect(() => {
    void useWorkspaceChatStore.getState().loadChats(workspaceId);
  }, [workspaceId, revision]);

  const chat = useMemo(() => chatsAll.find((c) => c.id === chatId) ?? null, [chatsAll, chatId]);
  const chats = useMemo(
    () => chatsAll.filter((c) => c.id === chatId || !(isKnownEmpty(c.id) && !useWorkspaceChatStore.getState().sessions[c.id]?.messages.length)),
    // sessions change when messages arrive, so depend on the open session's size too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chatsAll, chatId, session.messages.length],
  );

  const draft = stored !== undefined ? stored : rememberedDraft(key);
  const setDraft = useCallback((text: string) => useWorkspaceChatStore.getState().setDraft(key, text), [key]);

  return { chats, loaded, error, chat, chatId, session, draftKey: key, draft, setDraft, anyBusy };
}

/**
 * The estimate before sending: asks the backend (debounced) when the question or anything
 * that changes the context changes. Late answers of an older ask are dropped by the store.
 */
export function useChatPreview(chatId: string | null, question: string, signature: string, enabled = true, delay = 450) {
  useEffect(() => {
    if (!chatId || !enabled) return;
    const timer = setTimeout(() => void useWorkspaceChatStore.getState().refreshPreview(chatId, question), delay);
    return () => clearTimeout(timer);
  }, [chatId, question, signature, enabled, delay]);
}
