import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Plus } from "lucide-react";
import type { NoteBlockType, NoteDoc } from "../lib/types";
import { cn } from "../lib/utils";
import { BlockEditor, NoteBlockRow, type RowActions } from "./NoteBlockRow";
import { WINDOW_STEP, buildSections, formatClock, topicTime, windowSections, type Section } from "./page";
import "./liveNotes.css";

export interface PageActions {
  setText: (id: string, text: string) => void;
  setType: (id: string, type: NoteBlockType) => void;
  togglePin: (id: string) => void;
  addLine: (type: NoteBlockType, parent: string | null, text: string, after?: string | null) => void;
  deleteLine: (id: string) => void;
  undo?: () => void;
}

export interface NotePageProps {
  doc: NoteDoc;
  colors: boolean;
  editable: boolean;
  /** Lines that are new or changed, until when (ms epoch). */
  fresh?: Record<string, number>;
  /** Ids that just arrived (the page counts them while the reader is scrolled up). */
  arrivals?: { seq: number; added: string[] };
  /** Keep the newest line in view while the reader is at the bottom. */
  follow?: boolean;
  jump?: (ms: number) => void;
  actions: PageActions;
  /** Lines shown before older topics fold (tests use a small number). */
  windowSize?: number;
  className?: string;
}

type Draft = { after: string | null; parent: string | null; type: NoteBlockType } | null;

const prefersCalm = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** The notes as a set page: topics with a time rule, lead lines, marked items. */
export function NotePage({ doc, colors, editable, fresh, arrivals, follow = false, jump, actions, windowSize = WINDOW_STEP, className }: NotePageProps) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const atBottom = useRef(true);
  const [unseen, setUnseen] = useState(0);
  const [limit, setLimit] = useState(windowSize);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const sections = useMemo(() => buildSections(doc.blocks), [doc.blocks]);
  const { shown, hidden } = useMemo(() => windowSections(sections, limit), [sections, limit]);
  const firstId = shown[0]?.topic?.id ?? shown[0]?.lead[0]?.id ?? shown[0]?.items[0]?.id ?? null;
  const tabId = activeId && doc.blocks.some((b) => b.id === activeId) ? activeId : firstId;

  const now = Date.now();
  const isFresh = (id: string) => (fresh?.[id] ?? 0) > now;

  const scrollToEnd = useCallback((smooth: boolean) => {
    const el = scroller.current;
    if (!el) return;
    if (smooth && !prefersCalm() && typeof el.scrollTo === "function") el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    else el.scrollTop = el.scrollHeight;
  }, []);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom.current) setUnseen(0);
  };

  // New lines: stay put unless the reader is at the bottom; otherwise count them.
  const seenSeq = useRef(arrivals?.seq ?? 0);
  useLayoutEffect(() => {
    if (!arrivals || arrivals.seq === seenSeq.current) return;
    seenSeq.current = arrivals.seq;
    if (follow && atBottom.current) scrollToEnd(false);
    else if (arrivals.added.length) setUnseen((n) => n + arrivals.added.length);
  }, [arrivals, follow, scrollToEnd]);

  // First paint of a long page opens at the newest line.
  useLayoutEffect(() => {
    if (follow) scrollToEnd(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!draft) return;
    const el = scroller.current?.querySelector("[data-draft]");
    el?.scrollIntoView?.({ block: "nearest" });
  }, [draft]);

  const moveFocus = (dir: 1 | -1, from: HTMLElement) => {
    const all = Array.from(scroller.current?.querySelectorAll<HTMLElement>("[data-block-id]") ?? []).filter((el) => el.tabIndex >= -1 && !el.querySelector(".ln-textarea"));
    const i = all.indexOf(from);
    const next = all[Math.max(0, Math.min(all.length - 1, i + dir))];
    if (next && next !== from) next.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const typing = target.tagName === "TEXTAREA" || target.tagName === "INPUT";
    if (typing) return;
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z" && actions.undo) {
      e.preventDefault();
      actions.undo();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (target.hasAttribute("data-block-id")) {
        e.preventDefault();
        moveFocus(e.key === "ArrowDown" ? 1 : -1, target);
      }
    } else if (e.key === "Home" && target.hasAttribute("data-block-id")) {
      e.preventDefault();
      scroller.current?.querySelector<HTMLElement>("[data-block-id]")?.focus();
    } else if (e.key === "End" && target.hasAttribute("data-block-id")) {
      e.preventDefault();
      const all = scroller.current?.querySelectorAll<HTMLElement>("[data-block-id]");
      all?.[all.length - 1]?.focus();
    }
  };

  const rowActions: RowActions = useMemo(
    () => ({
      setText: actions.setText,
      setType: actions.setType,
      togglePin: actions.togglePin,
      deleteLine: actions.deleteLine,
      jump,
      startAddAfter: (id: string) => {
        const b = doc.blocks.find((x) => x.id === id);
        if (!b) return;
        setDraft({ after: id, parent: b.type === "topic" ? b.id : b.parent, type: "bullet" });
      },
    }),
    [actions.setText, actions.setType, actions.togglePin, actions.deleteLine, jump, doc.blocks],
  );

  const endEdit = useCallback(() => setEditingId(null), []);
  const setActive = useCallback((id: string) => setActiveId(id), []);

  const renderDraftFor = (id: string) =>
    draft && draft.after === id ? (
      <li key={`draft-${id}`} className="ln-item" data-draft>
        <BlockEditor
          initialType={draft.type}
          onSave={(text, type) => {
            actions.addLine(type ?? "bullet", draft.parent, text, draft.after);
            setDraft(null);
          }}
          onCancel={() => setDraft(null)}
        />
      </li>
    ) : null;

  const lastTopic = [...doc.blocks].reverse().find((b) => b.type === "topic") ?? null;
  const lastBlock = doc.blocks[doc.blocks.length - 1] ?? null;

  const renderSection = (s: Section, i: number) => {
    const time = topicTime(s);
    const clock = formatClock(time);
    const key = s.topic?.id ?? `loose-${i}`;
    const draftAtTop = !!draft?.after && (draft.after === s.topic?.id || s.lead.some((b) => b.id === draft.after));
    return (
      <section key={key} className="ln-topic" aria-label={s.topic ? undefined : "Earlier lines"} data-topic={s.topic?.id}>
        {s.topic && clock && (jump && time != null ? (
          <button type="button" className="ln-time" tabIndex={tabId === s.topic.id ? 0 : -1} onClick={() => jump(time)} aria-label={`Jump to ${clock} in the transcript`}>
            {clock}
          </button>
        ) : (
          <span className="ln-time">{clock}</span>
        ))}
        {s.topic && (
          <NoteBlockRow
            block={s.topic}
            fresh={isFresh(s.topic.id)}
            editable={editable}
            editing={editingId === s.topic.id}
            tabbable={tabId === s.topic.id}
            actions={rowActions}
            onEditDone={endEdit}
            onFocusRow={setActive}
            showTime={false}
          />
        )}
        {s.lead.map((b) => (
          <NoteBlockRow
            key={b.id}
            block={b}
            fresh={isFresh(b.id)}
            editable={editable}
            editing={editingId === b.id}
            tabbable={tabId === b.id}
            actions={rowActions}
            onEditDone={endEdit}
            onFocusRow={setActive}
          />
        ))}
        {(s.items.length > 0 || draftAtTop) && (
          <ul className="ln-list" aria-label={s.topic ? undefined : "Lines"}>
            {draftAtTop && renderDraftFor(draft!.after!)}
            {s.items.map((b) => (
              <Fragment key={b.id}>
                <NoteBlockRow
                  block={b}
                  fresh={isFresh(b.id)}
                  editable={editable}
                  editing={editingId === b.id}
                  tabbable={tabId === b.id}
                  actions={rowActions}
                  onEditDone={endEdit}
                  onFocusRow={setActive}
                />
                {renderDraftFor(b.id)}
              </Fragment>
            ))}
          </ul>
        )}
      </section>
    );
  };

  return (
    <div className={cn("relative flex min-h-0 flex-1 flex-col", className)}>
      <div
        ref={scroller}
        className="ln-scroll"
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        role="region"
        aria-label="Notes"
        data-testid="note-scroll"
      >
        <div className={cn("ln-page", !colors && "ln-plain")}>
          {hidden > 0 && (
            <button type="button" className="ln-tool ln-tool-solid mb-2 ml-1" onClick={() => setLimit((n) => n + windowSize)}>
              Show {Math.min(hidden, windowSize)} earlier {Math.min(hidden, windowSize) === 1 ? "line" : "lines"} ({hidden} folded)
            </button>
          )}
          {shown.map(renderSection)}
          {editable && (
            <button
              type="button"
              className="ln-tool ln-add"
              onClick={() => setDraft({ after: lastBlock?.id ?? null, parent: lastTopic?.id ?? null, type: "bullet" })}
            >
              <Plus className="h-3 w-3" aria-hidden />
              Add your own line
            </button>
          )}
          {draft && draft.after === null && (
            <ul className="ln-list">
              <li className="ln-item" data-draft>
                <BlockEditor
                  initialType={draft.type}
                  onSave={(text, type) => {
                    actions.addLine(type ?? "bullet", draft.parent, text, null);
                    setDraft(null);
                  }}
                  onCancel={() => setDraft(null)}
                />
              </li>
            </ul>
          )}
        </div>
      </div>
      <div role="status" aria-live="polite">
        {unseen > 0 && (
          <button
            type="button"
            className="ln-pill"
            onClick={() => {
              scrollToEnd(true);
              setUnseen(0);
            }}
          >
            {unseen} new {unseen === 1 ? "line" : "lines"}
          </button>
        )}
      </div>
    </div>
  );
}
