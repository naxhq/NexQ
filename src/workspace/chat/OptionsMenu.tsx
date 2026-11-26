import { useCallback, useRef, useState } from "react";
import { Portal, anchorOf, placeBox, useDismiss, useMeasured, type Anchor } from "../../ui/portal";
import { Segmented, Button } from "../../ui";
import { cliEffortLabel, isCliAgent } from "../../lib/cliAgents";
import type { ContextDepth, DepthBudgets, WorkspaceChat } from "../../lib/types";
import { DEPTHS, depthText } from "./depths";
import { PickerCaret } from "./ModelPicker";
import { ScopeBody, scopeSummary } from "./ScopeControl";
import type { Selection } from "./models";

/**
 * Depth, effort and which meetings, behind one quiet button, for the compact composer.
 * The button says what is set ("Balanced, All meetings"); the popover explains each choice.
 */
export function OptionsMenu({
  workspaceId,
  chat,
  excluded,
  selection,
  disabled,
  onDepth,
  onEffort,
  ensureChat,
  budgets,
}: {
  workspaceId: string;
  chat: WorkspaceChat | null;
  excluded: string[];
  selection: Selection;
  disabled?: boolean;
  onDepth: (d: ContextDepth) => void;
  onEffort: (e: string) => void;
  ensureChat: () => Promise<string | null>;
  /** The budget of each depth for this chat's model (from the latest estimate). */
  budgets?: DepthBudgets | null;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const { setEl, size } = useMeasured<HTMLDivElement>(open ? excluded.length : null);
  const depth = chat?.depth ?? "balanced";
  const info = DEPTHS.find((d) => d.value === depth) ?? DEPTHS[1];
  const close = useCallback((restore: boolean) => {
    setOpen(false);
    if (restore) trigger.current?.focus();
  }, []);
  useDismiss(open, [box, trigger], () => close(false));
  const pos = anchor ? placeBox(anchor, size, { align: "end", gap: 6, prefer: "above" }) : null;
  const summary = `${info.label}, ${scopeSummary(chat ? chat.include_meetings : true, excluded.length)}`;

  return (
    <>
      <button
        ref={trigger}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Answer options: ${summary}`}
        onClick={() => {
          if (open) return close(false);
          if (trigger.current) setAnchor(anchorOf(trigger.current));
          setOpen(true);
          void ensureChat();
        }}
        className="ui-meta inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 whitespace-nowrap rounded-md px-2 font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground ui-focus ui-r-md disabled:opacity-50"
      >
        <span className="min-w-0 truncate">{summary}</span>
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
            aria-label="Answer options"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                close(true);
              }
            }}
            style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 60, width: "min(24rem, calc(100vw - 16px))" }}
            className="ui-pop-in flex max-h-[min(34rem,80vh)] flex-col overflow-y-auto rounded-xl border border-border bg-popover text-popover-foreground shadow-[0_12px_32px_-12px_rgba(0,0,0,0.55)]"
          >
            <div className="space-y-2 border-b border-border px-3.5 py-3">
              <p className="ui-section text-foreground">How much to look at</p>
              <Segmented label="Depth" value={depth} onChange={onDepth} options={DEPTHS.map((d) => ({ value: d.value, label: d.label }))} />
              <p className="ui-meta text-muted-foreground" aria-live="polite">
                {depthText(depth, budgets)}
              </p>
              {selection.efforts.length > 0 && selection.effort && (
                <div className="space-y-1.5 pt-1">
                  <p className="ui-section text-foreground">Effort</p>
                  <Segmented
                    label="Effort"
                    value={selection.effort}
                    onChange={onEffort}
                    options={selection.efforts.map((e) => ({ value: e, label: isCliAgent(selection.provider) ? cliEffortLabel(e) : e }))}
                  />
                </div>
              )}
            </div>
            <ScopeBody workspaceId={workspaceId} chat={chat} excluded={excluded} ensureChat={ensureChat} autoFocus={false} />
          </div>
        </Portal>
      )}
    </>
  );
}
