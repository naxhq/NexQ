import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { WorkspaceMessage } from "../../lib/types";
import { chatScroll, type AnswerExtras, type Turn } from "../../stores/workspaceChatStore";
import { cn } from "../../lib/utils";
import { COLUMN } from "./column";
import { LiveTurn, SavedTurn, type TurnContext } from "./TurnView";

/** A saved question and its answer. Only answered pairs are kept, so a lone question is rare. */
export interface TurnPair {
  key: string;
  question: WorkspaceMessage | null;
  answer: WorkspaceMessage | null;
}

export function buildTurns(messages: WorkspaceMessage[]): TurnPair[] {
  const out: TurnPair[] = [];
  let question: WorkspaceMessage | null = null;
  for (const m of messages) {
    if (m.role === "user") {
      if (question) out.push({ key: `q${question.id}`, question, answer: null });
      question = m;
    } else {
      out.push({ key: `a${m.id}`, question, answer: m });
      question = null;
    }
  }
  if (question) out.push({ key: `q${question.id}`, question, answer: null });
  return out;
}

/** Turns whose messages the model only sees condensed (ids up to `upto`; unsaved ones have negative ids). */
export function isCondensed(t: TurnPair, upto: number | null): boolean {
  if (upto === null) return false;
  const id = t.answer?.id ?? t.question?.id ?? 0;
  return id > 0 && id <= upto;
}

type Item = { type: "turn"; turn: TurnPair; index: number } | { type: "marker" };

/** Beyond this many saved answers the list is windowed (only what is near the screen exists). */
export const VIRTUALISE_AFTER = 30;

const NEAR_BOTTOM = 96;
const FALLBACK_TAIL = 12;

function Marker({ count, expanded, onToggle }: { count: number; expanded: boolean; onToggle: () => void }) {
  return (
    <div className="pb-8">
      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-border" aria-hidden="true" />
        <p className="ui-meta text-muted-foreground">
          Earlier messages condensed{" "}
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            className="rounded font-medium text-foreground underline underline-offset-2 outline-none ui-focus ui-focus-sm"
          >
            {expanded ? "Hide originals" : `Show ${count} ${count === 1 ? "original" : "originals"}`}
          </button>
        </p>
        <span className="h-px flex-1 bg-border" aria-hidden="true" />
      </div>
      {!expanded && <p className="ui-meta mt-1 text-center text-muted-foreground">The model reads a summary of them. Nothing was deleted.</p>}
    </div>
  );
}

/**
 * The conversation as a page: each question a quiet heading with its answer under it. Sticks
 * to the bottom while an answer is written, but only if you were at the bottom. Position is
 * remembered per chat. Long chats are windowed. Alt+Up/Down (or the arrow keys on an answer)
 * move between answers.
 */
export function Transcript({
  chatId,
  messages,
  loaded,
  extras,
  turn,
  condensedUpto,
  ctx,
  onDismissTurn,
  className,
}: {
  chatId: string;
  messages: WorkspaceMessage[];
  loaded: boolean;
  extras: Record<number, AnswerExtras>;
  turn: Turn | null;
  condensedUpto: number | null;
  ctx: TurnContext;
  onDismissTurn: () => void;
  className?: string;
}) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const restored = useRef<string | null>(null);
  const [away, setAway] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const turns = useMemo(() => buildTurns(messages), [messages]);
  const condensedCount = useMemo(() => turns.filter((t) => isCondensed(t, condensedUpto)).length, [turns, condensedUpto]);

  useEffect(() => setExpanded(false), [chatId]);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    const shown = turns.map((t, i) => ({ t, i })).filter(({ t }) => expanded || !isCondensed(t, condensedUpto));
    const old = shown.filter(({ t }) => isCondensed(t, condensedUpto));
    const fresh = shown.filter(({ t }) => !isCondensed(t, condensedUpto));
    if (condensedCount > 0 && !expanded) out.push({ type: "marker" });
    old.forEach(({ t, i }) => out.push({ type: "turn", turn: t, index: i }));
    if (condensedCount > 0 && expanded) out.push({ type: "marker" });
    fresh.forEach(({ t, i }) => out.push({ type: "turn", turn: t, index: i }));
    return out;
  }, [turns, expanded, condensedUpto, condensedCount]);

  const virtual = items.length > VIRTUALISE_AFTER;
  const virtualizer = useVirtualizer({
    count: virtual ? items.length : 0,
    getScrollElement: () => scroller.current,
    estimateSize: () => 260,
    overscan: 4,
    initialRect: { width: 640, height: 640 },
    getItemKey: (i) => {
      const it = items[i];
      return it?.type === "turn" ? it.turn.key : "marker";
    },
  });

  const atBottom = () => {
    const el = scroller.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
  };
  const toBottom = useCallback(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = atBottom();
    chatScroll.set(chatId, el.scrollTop);
    setAway((was) => (was === !stick.current ? was : !stick.current));
  };

  // Opening a chat: back to where it was, else the end.
  useLayoutEffect(() => {
    if (!loaded || restored.current === chatId) return;
    restored.current = chatId;
    const el = scroller.current;
    if (!el) return;
    const saved = chatScroll.get(chatId);
    if (saved === undefined) {
      // A chat opens on the latest question with its answer under it, not on the last action row.
      if (virtual) {
        virtualizer.scrollToIndex(items.length - 1, { align: "start" });
      } else {
        const arts = el.querySelectorAll<HTMLElement>("[data-turn]");
        const last = arts[arts.length - 1];
        if (last) el.scrollTop = Math.max(0, last.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 8);
        else toBottom();
      }
      stick.current = atBottom();
    } else {
      el.scrollTop = saved;
      stick.current = atBottom();
    }
    setAway(!stick.current);
  }, [chatId, loaded, toBottom]);

  // New text, a new answer or a card: follow only if you were following.
  const tail = turn ? `${turn.text.length}:${turn.approvals.length}:${turn.status}` : "";
  useLayoutEffect(() => {
    if (stick.current && restored.current === chatId) toBottom();
  }, [messages.length, tail, chatId, toBottom, expanded]);

  const turnItems = useMemo(() => items.filter((i): i is Extract<Item, { type: "turn" }> => i.type === "turn"), [items]);
  const total = turnItems.length + (turn ? 1 : 0);

  const focusTurn = (n: number) => {
    const target = Math.max(0, Math.min(n, total - 1));
    const live = !!turn && target === turnItems.length;
    const go = () => {
      const el = scroller.current?.querySelector<HTMLElement>(live ? '[data-turn="live"]' : `[data-turn="${turnItems[target]?.index}"]`);
      el?.focus({ preventScroll: false });
      if (el) el.scrollIntoView?.({ block: "nearest" });
    };
    if (virtual && !live) {
      const at = items.findIndex((it) => it.type === "turn" && it.index === turnItems[target]?.index);
      if (at >= 0) virtualizer.scrollToIndex(at, { align: "start" });
      requestAnimationFrame(() => requestAnimationFrame(go));
    } else go();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const art = (e.target as HTMLElement).closest<HTMLElement>("[data-turn]");
    if (!art) return;
    const onArticle = e.target === art;
    const raw = art.dataset.turn ?? "";
    const here = raw === "live" ? turnItems.length : turnItems.findIndex((t) => String(t.index) === raw);
    if (here < 0) return;
    const down = e.key === "ArrowDown";
    const up = e.key === "ArrowUp";
    if ((e.altKey && (down || up)) || (onArticle && !e.altKey && !e.ctrlKey && (down || up))) {
      e.preventDefault();
      focusTurn(here + (down ? 1 : -1));
    } else if (onArticle && e.key === "Home") {
      e.preventDefault();
      focusTurn(0);
    } else if (onArticle && e.key === "End") {
      e.preventDefault();
      focusTurn(total - 1);
    }
  };

  const renderItem = (it: Item) =>
    it.type === "marker" ? (
      <Marker count={condensedCount} expanded={expanded} onToggle={() => setExpanded((x) => !x)} />
    ) : (
      <div className="pb-8">
        <SavedTurn
          question={it.turn.question}
          answer={it.turn.answer}
          extras={it.turn.answer ? extras[it.turn.answer.id] : undefined}
          index={it.index}
          total={turns.length}
          ctx={ctx}
        />
      </div>
    );

  return (
    <div className={cn("relative min-h-0 flex-1", className)}>
      <div
        ref={scroller}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        role="region"
        aria-label="Conversation"
        aria-describedby="ws-chat-keys"
        className="absolute inset-0 overflow-y-auto overscroll-contain px-5 pt-6 [overflow-anchor:none]"
      >
        <p id="ws-chat-keys" className="sr-only">
          Alt and the up or down arrow move between answers.
        </p>
        <div className={cn(COLUMN, "ui-body")}>
          {virtual && virtualizer.getVirtualItems().length === 0 ? (
            // The window has no size yet (hidden pane): draw the newest few so it is never blank.
            items.slice(-FALLBACK_TAIL).map((it, i) => <div key={it.type === "turn" ? it.turn.key : `m${i}`}>{renderItem(it)}</div>)
          ) : virtual ? (
            <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
              {virtualizer.getVirtualItems().map((v) => (
                <div
                  key={v.key}
                  data-index={v.index}
                  ref={virtualizer.measureElement}
                  style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${v.start}px)` }}
                >
                  {items[v.index] && renderItem(items[v.index])}
                </div>
              ))}
            </div>
          ) : (
            items.map((it, i) => <div key={it.type === "turn" ? it.turn.key : `m${i}`}>{renderItem(it)}</div>)
          )}
          {turn && (
            <div className="pb-6" data-live-turn>
              <LiveTurn turn={turn} ctx={ctx} onDismiss={onDismissTurn} />
            </div>
          )}
          <div className="h-6" aria-hidden="true" />
        </div>
      </div>
      {away && turn && (turn.status === "streaming" || turn.status === "waiting") && (
        <button
          type="button"
          onClick={() => {
            stick.current = true;
            toBottom();
            setAway(false);
          }}
          className="ui-meta absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-border bg-popover px-3 py-1.5 font-medium text-foreground shadow-[0_6px_18px_-8px_rgba(0,0,0,0.5)] outline-none hover:bg-accent ui-focus ui-focus-pill"
        >
          Jump to the latest
        </button>
      )}
    </div>
  );
}
