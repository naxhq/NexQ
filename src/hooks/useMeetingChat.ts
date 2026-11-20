import { useCallback, useEffect, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { askMeeting, cancelGeneration, getAgentSessions, listMeetingChat } from "../lib/ipc";
import { dedupeChips } from "../lib/sourceChips";
import {
  onAgentSessionStatus,
  onStreamActivity,
  onStreamEnd,
  onStreamError,
  onStreamStart,
  onStreamToken,
} from "../lib/events";
import type { AgentSessionStatus, MeetingChatMessage, SourceChip } from "../lib/types";
import { requestToggles } from "../stores/sourcesStore";

/**
 * - `saved`: loaded from the database
 * - `pending`: a question waiting for its answer
 * - `streaming`: an answer arriving
 * - `done`: a question sent / an answer finished in this view (the backend saved it)
 * - `stopped`: stopped by the user (not saved)
 * - `error`: failed (not saved)
 */
export type ChatItemStatus = "saved" | "pending" | "streaming" | "done" | "stopped" | "error";

export interface ChatItem {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: ChatItemStatus;
  /** Why the request failed, or why a finished answer was not saved. */
  error?: string;
  model?: string | null;
  createdAt: number;
  /** What the answer did with your sources while it streamed, oldest first (this view only; not saved). */
  activity?: string[];
  /** Notes and tools the answer used (this view only; not saved). */
  chips?: SourceChip[];
  /** Sources were not used, or only partly (this view only; not saved). */
  notice?: string | null;
}

export interface MeetingChatState {
  items: ChatItem[];
  loading: boolean;
  /** The saved chat could not be loaded. */
  loadError: string | null;
  isAsking: boolean;
  /** This meeting's Claude session (Claude CLI only; null when unknown). */
  session: AgentSessionStatus | null;
  ask: (question: string) => Promise<void>;
  stop: () => void;
}

interface Options {
  /** Load and ask through the backend (off in demo mode). */
  enabled?: boolean;
  /** Follow this meeting's Claude session status. */
  trackSession?: boolean;
}

function fromSaved(message: MeetingChatMessage): ChatItem {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    status: "saved",
    model: message.model,
    createdAt: message.created_at,
  };
}

/** Answered question/answer pairs, oldest first (for the AI Log). */
export function answeredExchanges(items: ChatItem[]): { question: ChatItem; answer: ChatItem }[] {
  const out: { question: ChatItem; answer: ChatItem }[] = [];
  for (let i = 0; i + 1 < items.length; i++) {
    const [question, answer] = [items[i], items[i + 1]];
    if (
      question.role === "user" &&
      answer.role === "assistant" &&
      (answer.status === "saved" || answer.status === "done")
    ) {
      out.push({ question, answer });
    }
  }
  return out;
}

/**
 * "Ask this meeting": the meeting's saved chat plus questions asked in this
 * view. Answers stream through the request-scoped `llm_stream_*` events (the
 * listeners are subscribed before the request starts).
 */
export function useMeetingChat(meetingId: string, { enabled = true, trackSession = false }: Options = {}): MeetingChatState {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isAsking, setIsAsking] = useState(false);
  const [session, setSession] = useState<AgentSessionStatus | null>(null);
  const askingRef = useRef(false);
  const listenersRef = useRef<UnlistenFn[]>([]);

  const dropListeners = useCallback(() => {
    listenersRef.current.forEach((unlisten) => unlisten());
    listenersRef.current = [];
  }, []);

  // Saved chat of this meeting.
  useEffect(() => {
    setItems([]);
    setLoadError(null);
    if (!enabled) {
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    listMeetingChat(meetingId)
      .then((saved) => {
        if (!alive) return;
        // Questions asked while the history loaded stay after it.
        setItems((local) => [...saved.map(fromSaved), ...local]);
      })
      .catch((err) => {
        if (alive) setLoadError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [meetingId, enabled]);

  // This meeting's Claude session: current snapshot, then live updates.
  useEffect(() => {
    setSession(null);
    if (!enabled || !trackSession) return;
    let alive = true;
    // The plain session only: the with-sources one has its own status on the pills.
    const ours = (s: AgentSessionStatus) => s.scope === "past" && s.meeting_id === meetingId && !s.with_sources;
    const unlisten = onAgentSessionStatus((status) => {
      if (ours(status)) setSession(status);
    });
    getAgentSessions()
      .then((all) => {
        const current = all.find(ours);
        // A status event that arrived meanwhile is newer than the snapshot.
        if (alive && current) setSession((prev) => prev ?? current);
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten.then((fn) => fn());
    };
  }, [meetingId, enabled, trackSession]);

  // Leaving the view drops the listeners (the container stops the request).
  useEffect(() => dropListeners, [dropListeners]);

  const ask = useCallback(
    async (raw: string) => {
      const question = raw.trim();
      if (!question || !enabled || askingRef.current) return;
      askingRef.current = true;
      setIsAsking(true);

      const requestId = crypto.randomUUID();
      // The pills as they are when you ask; a question you type always may use them.
      const sources = requestToggles();
      const questionId = `local-q-${requestId}`;
      const answerId = `local-a-${requestId}`;
      const now = Date.now();
      setItems((prev) => [
        ...prev,
        { id: questionId, role: "user", content: question, status: "pending", createdAt: now },
        { id: answerId, role: "assistant", content: "", status: "streaming", createdAt: now },
      ]);

      let answer = "";
      let finished = false;
      let activity: string[] = [];
      let chips: SourceChip[] = [];
      let notice: string | null = null;
      const update = (id: string, patch: Partial<ChatItem>) =>
        setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
      const finish = (status: ChatItemStatus, error?: string) => {
        if (finished) return;
        finished = true;
        dropListeners();
        update(questionId, { status: "done" });
        update(answerId, { status, content: answer, ...(error ? { error } : {}) });
        askingRef.current = false;
        setIsAsking(false);
      };
      const ours = (id: string | null) => id === requestId;

      try {
        // Subscribe before the request starts so no token is missed.
        dropListeners();
        listenersRef.current.push(
          await onStreamStart((event) => {
            if (ours(event.request_id)) update(answerId, { model: event.model });
          }),
          await onStreamToken((event) => {
            if (!ours(event.request_id)) return;
            answer += event.token;
            update(answerId, { content: answer });
          }),
          await onStreamActivity((event) => {
            if (!ours(event.request_id)) return;
            const a = event.activity;
            if (a.kind === "notice") {
              notice = notice ? `${notice} ${a.label}` : a.label;
            } else {
              activity = [...activity, a.label];
              if (a.chip) chips = dedupeChips([...chips, a.chip]);
            }
            update(answerId, { activity, chips, notice });
          }),
          await onStreamEnd((event) => {
            if (ours(event.request_id)) finish(event.cancelled ? "stopped" : "done");
          }),
          await onStreamError((event) => {
            if (ours(event.request_id)) finish("error", event.message);
          }),
        );
        await (sources ? askMeeting(meetingId, question, requestId, sources) : askMeeting(meetingId, question, requestId));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (finished) {
          // Answered, but the backend could not save it.
          update(answerId, { error: message });
        } else {
          finish("error", message);
        }
      }
    },
    [meetingId, enabled, dropListeners],
  );

  const stop = useCallback(() => {
    if (askingRef.current) cancelGeneration().catch(() => {});
  }, []);

  return { items, loading, loadError, isAsking, session, ask, stop };
}
