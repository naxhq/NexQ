import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { withoutImages } from "../../lib/answerMarkdown";
import { findSourcesSession } from "../../lib/sourcePills";
import { useAgentStore } from "../../stores/agentStore";
import type { Components } from "react-markdown";
import { ArrowUp, Loader2, MessageCircleQuestion, Square } from "lucide-react";
import type { ChatItem, MeetingChatState } from "../../hooks/useMeetingChat";
import { mdComponents, stripThinkTags } from "./SummaryView";
import { SourcePills } from "../../sources/SourcePills";
import { SourceChips } from "../../sources/SourceChips";
import { SourceActivityLines, SourceNotices } from "../../sources/SourceActivityLines";

/** Summary markdown styles, with headings and paragraphs sized for a chat answer. */
const answerMd: Components = withoutImages({
  ...mdComponents,
  h1: ({ children }) => <h3 className="mt-4 mb-1.5 text-sm font-semibold text-foreground">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-4 mb-1.5 text-sm font-semibold text-foreground">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-3 mb-1 text-sm font-medium text-foreground/90">{children}</h4>,
  p: ({ children }) => <p className="mb-2.5 text-sm leading-relaxed text-foreground/85 last:mb-0">{children}</p>,
});

const SUGGESTIONS = ["What was decided?", "What are the open questions?", "Who agreed to do what?"];

/** Distance from the bottom (px) within which new text keeps the view pinned. */
const PIN_THRESHOLD = 80;

interface AskMeetingTabProps {
  chat: MeetingChatState;
  /** The meeting being asked about: its Notes and Tools pills follow that meeting's sources session. */
  meetingId?: string | null;
  /** Why asking is unavailable right now (e.g. no transcript), if it is. */
  unavailableReason?: string | null;
  /** Another AI task of this view is running; asking waits for it. */
  otherTaskRunning?: boolean;
}

/** "Ask this meeting": a chat about a past meeting, saved with it. */
export function AskMeetingTab({ chat, meetingId = null, unavailableReason = null, otherTaskRunning = false }: AskMeetingTabProps) {
  const { items, loading, loadError, isAsking, session, ask, stop } = chat;
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pinnedRef = useRef(true);

  // This meeting's with-sources session is still starting: an answer that asked for sources waits for it.
  const sourcesStarting = useAgentStore((s) => findSourcesSession(s.sessions, "past", meetingId)?.state === "starting");
  const blocked = !!unavailableReason || otherTaskRunning;
  const canSend = !blocked && !isAsking && draft.trim().length > 0;

  // Keep the newest text in view while the reader is at the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD;
  }, []);

  const submit = useCallback(
    (text: string) => {
      const question = text.trim();
      if (!question || blocked || isAsking) return;
      pinnedRef.current = true;
      setDraft("");
      void ask(question);
    },
    [ask, blocked, isAsking],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Keep meeting-view shortcuts (Space = play, arrows = seek) out of the input.
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit(draft);
    }
  };

  // Grow with the text, up to ~6 lines.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
  }, [draft]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div className="mx-auto flex max-w-2xl flex-col gap-5" aria-live="polite">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-16 text-xs text-muted-foreground/60">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading conversation…
            </div>
          )}
          {loadError && <p className="text-center text-xs text-destructive/80">Couldn't load earlier questions: {loadError}</p>}
          {!loading && items.length === 0 && (
            <EmptyState disabled={blocked || isAsking} onPick={submit} />
          )}
          {items.map((item) =>
            item.role === "user" ? <Question key={item.id} item={item} /> : <Answer key={item.id} item={item} loadingSources={sourcesStarting} />,
          )}
        </div>
      </div>

      <form
        className="border-t border-border/20 px-5 pb-3 pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit(draft);
        }}
      >
        <div className="mx-auto max-w-2xl">
          <div className="flex items-end gap-2 rounded-xl border border-input bg-card/40 py-1.5 pl-3.5 pr-1.5 transition-colors duration-150 focus-within:border-ring">
            <div className="flex min-h-[28px] shrink-0 items-center">
              <SourcePills scope="past" meetingId={meetingId} />
            </div>
            <textarea
              ref={inputRef}
              rows={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={unavailableReason ?? "Ask about this meeting…"}
              aria-label="Ask about this meeting"
              disabled={!!unavailableReason}
              maxLength={4000}
              className="max-h-36 min-h-[28px] flex-1 resize-none bg-transparent py-1 text-sm leading-relaxed text-foreground/90 outline-none placeholder:text-muted-foreground/45 disabled:cursor-not-allowed"
            />
            {isAsking ? (
              <button
                type="button"
                onClick={stop}
                aria-label="Stop answer"
                title="Stop"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-foreground/10 text-foreground/80 transition-colors duration-150 hover:bg-foreground/15 cursor-pointer"
              >
                <Square className="h-3 w-3 fill-current" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!canSend}
                aria-label="Send question"
                title={otherTaskRunning ? "Wait for the current AI task to finish" : "Send (Enter)"}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-opacity duration-150 disabled:opacity-25 disabled:cursor-not-allowed cursor-pointer"
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="mt-1.5 flex h-4 items-center justify-between px-1 text-[11px] text-muted-foreground/50">
            <SessionLabel state={session?.state ?? null} detail={session?.detail ?? null} />
            <span className="hidden sm:inline">Enter to send · Shift+Enter for a new line</span>
          </div>
        </div>
      </form>
    </div>
  );
}

function EmptyState({ disabled, onPick }: { disabled: boolean; onPick: (q: string) => void }) {
  return (
    <div className="flex flex-col items-center py-14 text-center">
      <MessageCircleQuestion className="mb-3 h-7 w-7 text-primary/30" />
      <p className="text-sm font-medium text-foreground/70">Ask anything about this meeting</p>
      <p className="mt-1 text-xs text-muted-foreground/50">Questions and answers are saved with the meeting.</p>
      <div className="mt-5 flex flex-wrap justify-center gap-1.5">
        {SUGGESTIONS.map((q) => (
          <button
            key={q}
            type="button"
            disabled={disabled}
            onClick={() => onPick(q)}
            className="rounded-full border border-border/30 px-3 py-1 text-xs text-muted-foreground/70 transition-colors duration-150 hover:border-primary/30 hover:text-foreground disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}

function Question({ item }: { item: ChatItem }) {
  return (
    <div className="flex justify-end" data-status={item.status}>
      <p
        className={`max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary/10 px-3.5 py-2 text-sm leading-relaxed text-foreground/90 transition-opacity duration-200 ${
          item.status === "pending" ? "opacity-70" : ""
        }`}
      >
        {item.content}
      </p>
    </div>
  );
}

function Answer({ item, loadingSources }: { item: ChatItem; loadingSources: boolean }) {
  const text = stripThinkTags(item.content);
  const streaming = item.status === "streaming";
  return (
    <div data-status={item.status} className="min-w-0">
      {item.notice && <SourceNotices notices={[item.notice]} />}
      {streaming && (
        <div className="mb-2">
          <SourceActivityLines lines={item.activity ?? []} />
        </div>
      )}
      {streaming && !text ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground/60">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary/70" />
          {item.askedSources && loadingSources ? "Loading your sources…" : "Thinking…"}
        </div>
      ) : (
        text && (
          <div className="text-sm">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={answerMd}>
              {text}
            </ReactMarkdown>
            {streaming && <span className="ml-0.5 inline-block h-3.5 w-0.5 animate-pulse bg-primary/60 align-middle" />}
          </div>
        )
      )}
      {!streaming && item.chips && item.chips.length > 0 && (
        <div className="mt-2">
          <SourceChips chips={item.chips} />
        </div>
      )}
      {item.status === "stopped" && <p className="mt-1.5 text-[11px] text-muted-foreground/50">Stopped · not saved</p>}
      {item.error && <p className="mt-1.5 text-xs text-destructive/80">{item.error}</p>}
    </div>
  );
}

function SessionLabel({ state, detail }: { state: string | null; detail: string | null }) {
  const label =
    state === "starting"
      ? "Session starting…"
      : state === "ready"
        ? "Ready"
        : state === "busy"
          ? "Thinking…"
          : state === "error"
            ? "Session unavailable"
            : null;
  if (!label) return <span />;
  const dot =
    state === "ready" ? "bg-success" : state === "error" ? "bg-destructive" : "bg-warning animate-pulse";
  return (
    <span className="flex items-center gap-1.5" title={detail ?? undefined}>
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  );
}
