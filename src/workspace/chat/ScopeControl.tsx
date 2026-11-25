import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Search } from "lucide-react";
import { Portal, anchorOf, placeBox, useDismiss, useMeasured, type Anchor } from "../../ui/portal";
import { Switch } from "../../ui";
import { listWorkspaceMeetings } from "../../lib/ipc";
import type { MeetingSummary, WorkspaceChat } from "../../lib/types";
import { useWorkspaceChatStore } from "../../stores/workspaceChatStore";
import { cn } from "../../lib/utils";
import { PickerCaret } from "./ModelPicker";

const PAGE = 50;

/** The one-line state of the scope, for the button. */
export function scopeSummary(includeMeetings: boolean, excluded: number): string {
  if (!includeMeetings) return "Meetings off";
  return excluded > 0 ? `Meetings, ${excluded} left out` : "All meetings";
}

function when(m: MeetingSummary): string {
  const d = new Date(m.start_time);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

interface ScopeProps {
  workspaceId: string;
  chat: WorkspaceChat | null;
  excluded: string[];
  ensureChat: () => Promise<string | null>;
}

/**
 * Which past meetings this chat may use: all of them on or off, or a list to leave some out.
 * Per chat. Only this workspace's meetings are ever listed (other workspaces' are never used).
 * Each meeting shows as it really is: a change that failed goes back, with the reason.
 */
export function ScopeBody({ workspaceId, chat, excluded, autoFocus = true }: ScopeProps & { autoFocus?: boolean }) {
  const [query, setQuery] = useState("");
  const [meetings, setMeetings] = useState<MeetingSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [limit, setLimit] = useState(PAGE);
  const search = useRef<HTMLInputElement | null>(null);
  const seq = useRef(0);
  const uid = useId();
  const store = useWorkspaceChatStore;
  const chatId = chat?.id ?? null;
  const includeMeetings = chat ? chat.include_meetings : true;
  const left = excluded.length;

  // The list of this workspace's meetings, debounced while typing; late answers are dropped.
  useEffect(() => {
    const mine = ++seq.current;
    setState("loading");
    const timer = setTimeout(
      () => {
        void (async () => {
          try {
            const page = await listWorkspaceMeetings(workspaceId, query.trim() || null, limit, 0);
            if (mine !== seq.current) return;
            setMeetings(Array.isArray(page?.meetings) ? page.meetings : []);
            setTotal(typeof page?.total === "number" ? page.total : 0);
            setState("idle");
          } catch {
            if (mine === seq.current) setState("error");
          }
        })();
      },
      query ? 250 : 0,
    );
    return () => clearTimeout(timer);
  }, [workspaceId, query, limit]);

  useEffect(() => {
    if (autoFocus) search.current?.focus({ preventScroll: true });
  }, [autoFocus, includeMeetings]);

  const setIncluded = (meetingId: string, included: boolean) => {
    const id = chatId ?? store.getState().activeChat[workspaceId];
    if (id) void store.getState().setMeetingIncluded(workspaceId, id, meetingId, included);
  };
  const includeAll = () => excluded.forEach((id) => setIncluded(id, true));

  return (
    <div className="flex min-h-0 flex-col">
      <div className="border-b border-border px-3.5 py-3">
        <Switch
          checked={includeMeetings}
          onChange={(on) => chatId && void store.getState().updateChat(chatId, { include_meetings: on })}
          label="Use past meetings"
          description="Answers can draw on this workspace's meetings. Meetings of other workspaces are never used."
        />
      </div>
      {includeMeetings && (
        <>
          <div className="flex items-center gap-2 border-b border-border px-3.5 py-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              ref={search}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search meetings"
              placeholder="Search meetings"
              className="ui-body min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground/70"
            />
          </div>
          <ul aria-label="Meetings" className="max-h-64 min-h-0 flex-1 overflow-y-auto py-1">
            {meetings.map((m) => {
              const on = !excluded.includes(m.id);
              return (
                <li key={m.id}>
                  <label className="flex cursor-pointer items-start gap-2.5 px-3.5 py-1.5 hover:bg-accent/60">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) => setIncluded(m.id, e.target.checked)}
                      className="mt-1 h-3.5 w-3.5 shrink-0 accent-[hsl(var(--primary))]"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="ui-body block truncate text-foreground">{m.title || "Untitled meeting"}</span>
                      <span className="ui-meta block text-muted-foreground">{when(m)}</span>
                    </span>
                  </label>
                </li>
              );
            })}
            {state === "loading" && meetings.length === 0 && <li className="ui-meta px-3.5 py-2 text-muted-foreground">Loading meetings</li>}
            {state === "error" && <li className="ui-meta px-3.5 py-2 text-muted-foreground">Couldn't load the meetings.</li>}
            {state === "idle" && meetings.length === 0 && (
              <li className="ui-meta px-3.5 py-2 text-muted-foreground">{query ? "No meeting matches." : "No meetings in this workspace yet."}</li>
            )}
          </ul>
          <div className="flex items-center justify-between gap-2 border-t border-border px-3.5 py-2">
            <span id={`${uid}-n`} className={cn("ui-meta text-muted-foreground", state === "loading" && "opacity-60")} aria-live="polite">
              {left > 0 ? `${left} left out` : total > 0 ? `All ${total} used` : ""}
            </span>
            <span className="flex gap-1">
              {meetings.length < total && (
                <button type="button" onClick={() => setLimit((n) => n + PAGE)} className="ui-meta rounded px-1.5 py-0.5 text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60">
                  Show more
                </button>
              )}
              {left > 0 && (
                <button type="button" onClick={includeAll} className="ui-meta rounded px-1.5 py-0.5 text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60">
                  Use all again
                </button>
              )}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

/** The scope as one button with a popover (the start screen's composer). */
export function ScopeControl({ workspaceId, chat, excluded, ensureChat, disabled }: ScopeProps & { disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const { setEl, size } = useMeasured<HTMLDivElement>(open ? excluded.length : null);
  const includeMeetings = chat ? chat.include_meetings : true;

  const close = useCallback((restore: boolean) => {
    setOpen(false);
    if (restore) trigger.current?.focus();
  }, []);
  useDismiss(open, [box, trigger], () => close(false));

  const openIt = async () => {
    if (disabled) return;
    if (trigger.current) setAnchor(anchorOf(trigger.current));
    setOpen(true);
    await ensureChat();
  };
  const pos = anchor ? placeBox(anchor, size, { align: "start", gap: 6, prefer: "above" }) : null;

  return (
    <>
      <button
        ref={trigger}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close(false) : void openIt())}
        className="ui-meta inline-flex h-7 items-center gap-1.5 rounded-md px-2 font-medium text-foreground/85 outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50"
      >
        <span>{scopeSummary(includeMeetings, excluded.length)}</span>
        <PickerCaret />
      </button>
      {open && pos && (
        <Portal>
          <div
            ref={(el) => {
              box.current = el;
              setEl(el);
            }}
            role="dialog"
            aria-label="Meetings this chat can use"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                close(true);
              }
            }}
            style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 60, width: "min(24rem, calc(100vw - 16px))" }}
            className="ui-pop-in flex max-h-[min(28rem,72vh)] flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-[0_12px_32px_-12px_rgba(0,0,0,0.55)]"
          >
            <ScopeBody workspaceId={workspaceId} chat={chat} excluded={excluded} ensureChat={ensureChat} />
          </div>
        </Portal>
      )}
    </>
  );
}
