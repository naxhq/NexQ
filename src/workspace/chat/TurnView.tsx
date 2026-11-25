import { memo, useId, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { SourceActivity, WorkspaceCitation, WorkspaceMessage } from "../../lib/types";
import type { AnswerExtras, Turn } from "../../stores/workspaceChatStore";
import { Button, buttonClasses } from "../../ui";
import { useMeetingStore } from "../../stores/meetingStore";
import { cn } from "../../lib/utils";
import type { ModelChoice } from "./models";
import { classifyChatError } from "./errors";
import { citationKindName, citationWhere } from "./citations";
import { Prose, type OpenCitation } from "./Prose";
import { ApprovalCard } from "./ApprovalCard";
import { ReportNotices, withoutSessionNote } from "./ReportNotices";
import { stripHidden } from "./instructionText";
import { AnswerActions } from "./AnswerActions";
import { ModelPicker, PickerCaret } from "./ModelPicker";
import { formatTokens } from "../../voiceprint";

export interface TurnContext {
  workspaceId: string;
  chatId: string;
  current: { provider: string; model: string } | null;
  /** Another answer is running in this chat. */
  busy: boolean;
  onOpenCitation: OpenCitation;
  /** Ask the same question again, on another model, or deeper. */
  onAsk: (question: string, opts?: { choice?: ModelChoice; deeper?: boolean }) => void;
  onOpenSettings: () => void;
}

function Question({ text, id }: { text: string; id: string }) {
  return (
    <h3 id={id} className="ui-section ui-measure whitespace-pre-wrap break-words text-muted-foreground">
      {stripHidden(text)}
    </h3>
  );
}

/** The latest line of what the model did with your sources (a note, a tool), not its notices. */
function latestLabel(activity: SourceActivity[]): string | null {
  for (let i = activity.length - 1; i >= 0; i--) if (activity[i].kind !== "notice" && activity[i].label) return activity[i].label;
  return null;
}

function Notices({ activity }: { activity: SourceActivity[] }) {
  const notices = activity.filter((a) => a.kind === "notice").map((a) => a.label);
  if (notices.length === 0) return null;
  return (
    <div className="mt-2 space-y-0.5">
      {notices.map((n) => (
        <p key={n} className="ui-meta flex flex-wrap items-baseline gap-x-2 text-muted-foreground">
          <span>{n}</span>
          {/* "... Turn it on in Settings > Personal Sources.": the way there is one click */}
          {/Settings > Personal Sources/.test(n) && (
            <button
              type="button"
              onClick={() => useMeetingStore.getState().openSettings("personal_sources")}
              className="rounded font-medium text-foreground underline underline-offset-2 outline-none ui-focus ui-focus-sm"
            >
              Open Personal Sources
            </button>
          )}
        </p>
      ))}
    </div>
  );
}

/** Sources (citations) and what the model did to get them. Revealed on demand. */
function SourcesDisclosure({
  citations,
  activity,
  onOpen,
}: {
  citations: WorkspaceCitation[];
  activity: SourceActivity[];
  onOpen: OpenCitation;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const did = activity.filter((a) => a.kind !== "notice" && a.label);
  if (citations.length === 0 && did.length === 0) return null;
  const count = citations.length;
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={id}
        className="ui-meta inline-flex items-center gap-1 rounded text-muted-foreground outline-none transition-colors hover:text-foreground ui-focus ui-focus-sm"
      >
        <ChevronRight className={cn("h-3 w-3 transition-transform motion-reduce:transition-none", open && "rotate-90")} aria-hidden="true" />
        {count > 0 ? `${count} ${count === 1 ? "source" : "sources"}` : "What it looked at"}
      </button>
      {open && (
        <div id={id} className="ui-fade-in ui-measure mt-1.5">
          {count > 0 && (
            <ol aria-label="Sources" className="space-y-1.5">
              {citations.map((c) => (
                <li key={c.tag} className="flex gap-2">
                  <span className="ui-meta w-6 shrink-0 pt-0.5 font-semibold tabular-nums text-muted-foreground">{c.tag}</span>
                  <button
                    type="button"
                    onClick={() => onOpen(c)}
                    className="min-w-0 flex-1 rounded text-left outline-none ui-focus ui-focus-sm"
                  >
                    <span className="ui-body block truncate text-foreground underline-offset-2 hover:underline">{citationWhere(c)}</span>
                    <span className="ui-meta block text-muted-foreground">{citationKindName(c)}</span>
                    {c.snippet && <span className="ui-meta mt-0.5 line-clamp-2 block text-foreground/75">{c.snippet}</span>}
                  </button>
                </li>
              ))}
            </ol>
          )}
          {did.length > 0 && (
            <ul aria-label="What it did" className={cn("space-y-0.5", count > 0 && "mt-2")}>
              {did.map((a, i) => (
                <li key={i} className="ui-meta text-muted-foreground">
                  {a.label}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function tokenLine(m: WorkspaceMessage): string {
  const parts: string[] = [];
  if (m.input_tokens > 0) parts.push(`${formatTokens(m.input_tokens)} in`);
  if (m.output_tokens > 0) parts.push(`${formatTokens(m.output_tokens)} out`);
  return parts.join(", ");
}

/** "3 things didn't fit." with the way to look deeper. */
function leftOut(m: WorkspaceMessage): number {
  const r = m.context;
  if (!r || r.estimate) return 0;
  return r.omitted + r.bars.filter((b) => !b.included).length;
}

export const SavedTurn = memo(function SavedTurn({
  question,
  answer,
  extras,
  index,
  total,
  ctx,
}: {
  question: WorkspaceMessage | null;
  answer: WorkspaceMessage | null;
  extras: AnswerExtras | undefined;
  index: number;
  total: number;
  ctx: TurnContext;
}) {
  const qid = useId();
  const last = index === total - 1;
  const missed = answer ? leftOut(answer) : 0;
  const canDeeper = !!answer && answer.context?.depth !== "deep";
  const meta = answer ? [answer.model, tokenLine(answer)].filter(Boolean).join(", ") : "";
  return (
    <article
      data-turn={index}
      tabIndex={last ? 0 : -1}
      aria-labelledby={qid}
      className="rounded-md outline-none ui-focus ui-r-md"
    >
      {question && <Question id={qid} text={question.content} />}
      {answer && (
        <>
          <Prose text={answer.content} citations={answer.citations} onOpenCitation={ctx.onOpenCitation} className="mt-2" />
          {extras && extras.approvals.length > 0 && (
            <ul aria-label="Tool requests" className="mt-3 space-y-2">
              {extras.approvals.map((a) => (
                <li key={a.approvalId}>
                  <ApprovalCard approval={a} />
                </li>
              ))}
            </ul>
          )}
          <SourcesDisclosure citations={answer.citations} activity={extras?.activity ?? []} onOpen={ctx.onOpenCitation} />
          <ReportNotices notices={withoutSessionNote(answer.context?.notices)} />
          {missed > 0 && (
            <p className="ui-meta mt-2 text-muted-foreground">
              {missed} {missed === 1 ? "thing" : "things"} didn't fit.{" "}
              {canDeeper && question && (
                <button
                  type="button"
                  disabled={ctx.busy}
                  onClick={() => ctx.onAsk(question.content, { deeper: true })}
                  className="rounded font-medium text-foreground underline underline-offset-2 outline-none ui-focus ui-focus-sm disabled:opacity-50"
                >
                  Search deeper
                </button>
              )}
            </p>
          )}
          <p className="ui-meta mt-2 min-h-[1.1rem] text-muted-foreground">{meta}</p>
          <AnswerActions
            workspaceId={ctx.workspaceId}
            message={answer}
            question={question?.content ?? ""}
            busy={ctx.busy}
            current={ctx.current}
            onRetryWith={(choice) => question && ctx.onAsk(question.content, { choice })}
            onOpenSettings={ctx.onOpenSettings}
          />
        </>
      )}
    </article>
  );
});

/** The failure, in place: what happened, the real message, and what to do. */
function ErrorBlock({ error, turn, ctx }: { error: string; turn: Turn; ctx: TurnContext }) {
  const info = classifyChatError(error, turn.errorKind);
  return (
    <div role="alert" className="mt-3 rounded-lg border border-destructive/50 bg-destructive/10 px-3.5 py-3">
      <p className="ui-section text-foreground">{info.title}</p>
      <p className="ui-meta mt-1 break-words text-foreground/80">{info.detail}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {info.fixes.map((fix) =>
          fix === "settings" ? (
            <Button key={fix} onClick={ctx.onOpenSettings}>
              Open provider settings
            </Button>
          ) : fix === "model" ? (
            <ModelPicker
              key={fix}
              value={ctx.current}
              label="Pick another model"
              onPick={(choice) => ctx.onAsk(turn.question, { choice, deeper: turn.deeper })}
              onOpenSettings={ctx.onOpenSettings}
              buttonClassName={buttonClasses("quiet", "md")}
            >
              Pick another model
              <PickerCaret />
            </ModelPicker>
          ) : (
            <Button key={fix} onClick={() => ctx.onAsk(turn.question, { deeper: turn.deeper })}>
              Try again
            </Button>
          ),
        )}
      </div>
    </div>
  );
}

/** The answer being written, or the one that stopped or failed. It stays below the saved ones. */
export function LiveTurn({ turn, ctx, onDismiss }: { turn: Turn; ctx: TurnContext; onDismiss: () => void }) {
  const qid = useId();
  const active = turn.status === "waiting" || turn.status === "streaming" || turn.status === "stopping";
  const doing = latestLabel(turn.activity);
  const reading = turn.report ? turn.report.bars.filter((b) => b.included).length : 0;
  const status =
    turn.status === "stopping"
      ? "Stopping"
      : turn.status === "stopped"
        ? "Stopped. What was written is kept here, not saved."
        : turn.status === "failed"
          ? ""
          : (doing ?? (turn.text ? "Writing" : reading > 0 ? `Reading ${reading} ${reading === 1 ? "item" : "items"}` : "Starting"));
  return (
    <article data-turn="live" tabIndex={-1} aria-labelledby={qid} aria-busy={active} className="rounded-md outline-none">
      <Question id={qid} text={turn.question} />
      {turn.text && <Prose text={turn.text} citations={[]} live={active} onOpenCitation={ctx.onOpenCitation} className="mt-2" />}
      {turn.approvals.length > 0 && (
        <ul aria-label="Tool requests" className="mt-3 space-y-2">
          {turn.approvals.map((a) => (
            <li key={a.approvalId}>
              <ApprovalCard approval={a} />
            </li>
          ))}
        </ul>
      )}
      <Notices activity={turn.activity} />
      <ReportNotices notices={withoutSessionNote(turn.report?.notices)} />
      {turn.status === "failed" && turn.error !== null && <ErrorBlock error={turn.error} turn={turn} ctx={ctx} />}
      {turn.status === "removed" && (
        <p role="status" className="ui-body mt-2 text-muted-foreground">
          {turn.removedBecause === "deleted"
            ? "Something this answer used was deleted, so it was stopped."
            : turn.removedBecause === "moved"
              ? "Something this answer used was moved out of this workspace, so it was stopped."
              : "Something this answer used is no longer available here, so it was stopped."}
        </p>
      )}
      {turn.status !== "failed" && turn.status !== "removed" && (
        <p role="status" className="ui-meta mt-2 flex min-h-[1.1rem] items-center gap-2 text-muted-foreground">
          {active && <span aria-hidden="true" className="inline-block h-3.5 w-0.5 bg-foreground/70 motion-safe:animate-pulse" />}
          <span>{status}</span>
          {turn.model && active && <span className="text-muted-foreground/80">{turn.model}</span>}
        </p>
      )}
      {(turn.status === "stopped" || turn.status === "failed" || turn.status === "removed") && (
        <div className="-ml-2 mt-1 flex gap-1">
          {(turn.status === "stopped" || turn.status === "removed") && (
            <Button variant="ghost" size="sm" onClick={() => ctx.onAsk(turn.question, { deeper: turn.deeper })} className="ui-meta">
              Ask again
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onDismiss} className="ui-meta">
            Dismiss
          </Button>
        </div>
      )}
    </article>
  );
}
