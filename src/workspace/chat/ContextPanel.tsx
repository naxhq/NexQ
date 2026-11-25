import { useId, useState } from "react";
import { ChevronRight } from "lucide-react";
import { CONTEXT_LAYER_NAMES, ContextWave, formatTokens, type ContextSelection } from "../../voiceprint";
import type { ContextBar, ContextReport } from "../../lib/types";
import { readWaveOpen, useWorkspaceChatStore, writeWaveOpen } from "../../stores/workspaceChatStore";
import { cn } from "../../lib/utils";
import { openItem, openMeeting, type ChatOpeners } from "./open";

/** The id of the meeting or item a bar stands for: "meeting:abc" or just "abc". */
export function refOfBar(bar: ContextBar): string {
  const at = bar.id.indexOf(":");
  return at >= 0 ? bar.id.slice(at + 1) : bar.id;
}

export type WaveSubject = "estimate" | "answer" | "live";

const HEADINGS: Record<WaveSubject, string> = {
  estimate: "What the next answer will see",
  answer: "What the last answer saw",
  live: "What this answer is seeing",
};

/**
 * The context wave for the current question. Collapsible and remembered. Clicking a bar, a
 * group or a layer lists its items; a meeting can be left out of this chat from there.
 * (The contract has no pin or exclude for other items, so those only open.)
 */
export function ContextPanel({
  report,
  subject,
  estimating,
  failed,
  workspaceId,
  chatId,
  excluded,
  openers,
}: {
  report: ContextReport | null;
  subject: WaveSubject;
  estimating: boolean;
  failed: boolean;
  workspaceId: string;
  chatId: string | null;
  excluded: string[];
  openers: ChatOpeners;
}) {
  const [open, setOpen] = useState(readWaveOpen);
  const [selection, setSelection] = useState<ContextSelection | null>(null);
  const id = useId();
  const toggle = () => {
    setOpen((o) => {
      writeWaveOpen(!o);
      return !o;
    });
  };
  const used = report?.used ?? 0;

  return (
    <section aria-label="Context" className="border-t border-border/60 px-4 pb-2 pt-1.5">
      <div className="mx-auto w-full max-w-[38rem]">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={`${id}-body`}
          className="ui-meta flex w-full items-center gap-1.5 rounded py-1 text-left text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform motion-reduce:transition-none", open && "rotate-90")} aria-hidden="true" />
          <span className="font-medium">{HEADINGS[subject]}</span>
          <span className="ml-auto tabular-nums" aria-live="polite">
            {report ? `${formatTokens(used)} of ${formatTokens(report.budget)}` : estimating ? "Estimating" : failed ? "No estimate" : ""}
          </span>
        </button>
        {open && (
          <div id={`${id}-body`} className="pb-1 pt-1">
            {report ? (
              <>
                <ContextWave bars={report.bars} window={report.window} budget={report.budget} height={52} onSelect={setSelection} />
                <p className="ui-meta mt-1.5 text-muted-foreground">
                  {report.strategy === "full" ? "Everything included fit." : "Picked the most relevant material."} The model's window is {formatTokens(report.window)}.
                  {report.omitted > 0 ? ` ${report.omitted} smaller ${report.omitted === 1 ? "item was" : "items were"} left out.` : ""}
                </p>
                {report.notices.map((n) => (
                  <p key={n} className="ui-meta mt-0.5 text-foreground/80">
                    {n}
                  </p>
                ))}
              </>
            ) : (
              <p className="ui-meta py-2 text-muted-foreground">{failed ? "The estimate isn't available right now." : estimating ? "Estimating what would be sent." : "Start typing to see what would be sent."}</p>
            )}
            {selection && (
              <Inspector
                selection={selection}
                workspaceId={workspaceId}
                chatId={chatId}
                excluded={excluded}
                openers={openers}
                onClose={() => setSelection(null)}
              />
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function Inspector({
  selection,
  workspaceId,
  chatId,
  excluded,
  openers,
  onClose,
}: {
  selection: ContextSelection;
  workspaceId: string;
  chatId: string | null;
  excluded: string[];
  openers: ChatOpeners;
  onClose: () => void;
}) {
  const shown = selection.bars.slice(0, 12);
  return (
    <div role="region" aria-label={`${CONTEXT_LAYER_NAMES[selection.layer]} items`} className="mt-2 rounded-lg border border-border bg-card px-3 py-2">
      <div className="flex items-center justify-between">
        <p className="ui-section text-foreground">{CONTEXT_LAYER_NAMES[selection.layer]}</p>
        <button type="button" onClick={onClose} className="ui-meta rounded px-1.5 py-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60">
          Close
        </button>
      </div>
      <ul className="mt-1 divide-y divide-border/50">
        {shown.map((bar) => {
          const ref = refOfBar(bar);
          const meeting = bar.layer === "meetings";
          const left = excluded.includes(ref);
          return (
            <li key={bar.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-1.5">
              <span className="ui-body min-w-0 flex-1 truncate text-foreground">{bar.title}</span>
              <span className="ui-meta tabular-nums text-muted-foreground">
                {formatTokens(bar.tokens)} tokens{bar.pinned ? ", pinned" : ""}{bar.included ? "" : ", didn't fit"}
              </span>
              {bar.layer !== "instructions" && bar.layer !== "conversation" && (
                <button
                  type="button"
                  onClick={() => (meeting ? openMeeting(openers, ref, null) : openItem(openers, bar.layer === "folders" ? "folder" : "document", ref, null))}
                  className="ui-meta rounded px-1.5 py-0.5 text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  Open
                </button>
              )}
              {meeting && chatId && (
                <button
                  type="button"
                  onClick={() => void useWorkspaceChatStore.getState().setMeetingIncluded(workspaceId, chatId, ref, left)}
                  className="ui-meta rounded px-1.5 py-0.5 text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  {left ? "Use in this chat" : "Leave out of this chat"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {selection.bars.length > shown.length && <p className="ui-meta mt-1 text-muted-foreground">{selection.bars.length - shown.length} more.</p>}
    </div>
  );
}
