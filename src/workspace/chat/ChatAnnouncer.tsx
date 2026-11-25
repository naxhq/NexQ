import { useEffect, useRef, useState } from "react";
import { EMPTY_SESSION, useWorkspaceChatStore } from "../../stores/workspaceChatStore";

/**
 * What a screen reader hears about the open chat, in a few short sentences and never token by token:
 * "Answering", "Stopping", a summary of the tools it used when it is ready, and (assertive) a tool
 * that needs an answer. Errors, a stopped answer and a removed one are announced by their own notes. Two visually hidden live regions; the answer text itself is not one.
 */
export function ChatAnnouncer({ chatId }: { chatId: string | null }) {
  const turn = useWorkspaceChatStore((s) => (chatId ? (s.sessions[chatId] ?? EMPTY_SESSION).turn : null));
  const messageCount = useWorkspaceChatStore((s) => (chatId ? (s.sessions[chatId] ?? EMPTY_SESSION).messages.length : 0));
  const [polite, setPolite] = useState("");
  const [assertive, setAssertive] = useState("");
  const wasBusy = useRef(false);
  const tools = useRef(0);
  const asked = useRef(new Set<string>());
  const prevCount = useRef(messageCount);

  const status = turn?.status ?? null;
  const toolCount = turn ? turn.activity.filter((a) => a.kind !== "notice" && a.label).length : 0;
  if (turn && (status === "waiting" || status === "streaming" || status === "stopping")) tools.current = toolCount;

  useEffect(() => {
    if (status === "waiting" || status === "streaming") {
      if (!wasBusy.current) setPolite("Answering");
      wasBusy.current = true;
    } else if (status === "stopping") {
      setPolite("Stopping");
    } else if (status === "stopped" || status === "failed" || status === "removed") {
      // These already speak for themselves: the note on screen is a status or an alert.
      wasBusy.current = false;
    } else if (status === null && wasBusy.current) {
      // The answer ended into a saved message.
      wasBusy.current = false;
      const n = tools.current;
      setPolite(n > 0 ? `Answer ready. It used ${n} ${n === 1 ? "tool" : "tools"}.` : "Answer ready.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // A new chat opened: nothing from the last one is repeated.
  useEffect(() => {
    wasBusy.current = false;
    prevCount.current = messageCount;
    setPolite("");
    setAssertive("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  const pending = turn?.approvals.filter((a) => a.state === "pending") ?? [];
  useEffect(() => {
    for (const a of pending) {
      if (asked.current.has(a.approvalId)) continue;
      asked.current.add(a.approvalId);
      setAssertive(`A tool needs your answer: ${a.tool} on ${a.server}. Allow once or deny.`);
    }
  }, [pending]);

  return (
    <>
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-chat-live="polite">
        {polite}
      </div>
      <div aria-live="assertive" aria-atomic="true" className="sr-only" data-chat-live="assertive">
        {assertive}
      </div>
    </>
  );
}
