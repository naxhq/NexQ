import { useEffect, useId, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { buttonClass } from "../../ui";
import { cn } from "../../lib/utils";
import { APPROVAL_SECONDS, useWorkspaceChatStore, type Approval } from "../../stores/workspaceChatStore";

const MAX_ARGS_CHARS = 4000;

export function prettyArgs(args: unknown): string {
  let text: string;
  try {
    text = typeof args === "string" ? args : (JSON.stringify(args, null, 2) ?? "");
  } catch {
    text = String(args);
  }
  return text.length > MAX_ARGS_CHARS ? `${text.slice(0, MAX_ARGS_CHARS)}\n(cut, ${text.length - MAX_ARGS_CHARS} more characters)` : text;
}

function useSecondsLeft(approval: Approval): number {
  const [now, setNow] = useState(() => Date.now());
  const live = approval.state === "pending";
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  return Math.max(0, APPROVAL_SECONDS - Math.floor((now - approval.receivedAt) / 1000));
}

const RESULT: Partial<Record<Approval["state"], string>> = {
  allowed: "Allowed once.",
  denied: "Denied.",
  expired: `No answer in ${APPROVAL_SECONDS} seconds, so it was denied.`,
  failed: "Your answer didn't arrive in time. The tool was denied.",
  sending: "Sending your answer.",
};

const CLOSED: Record<string, string> = {
  answered: "Answered somewhere else.",
  timeout: `No answer in ${APPROVAL_SECONDS} seconds, so it was denied.`,
  cancelled: "The answer was stopped, so this was not run.",
};

/**
 * A tool that is not read-only asks first. Shows the server, the tool and the exact arguments,
 * then Allow once or Deny; nothing is chosen for you and the backend denies after 60 seconds.
 * Focus: the card takes it only when nothing is being typed, on the card itself (never on a
 * button, so a stray Enter can't allow), and gives it back to the composer when answered.
 */
export function ApprovalCard({ approval }: { approval: Approval }) {
  const id = useId();
  const card = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const left = useSecondsLeft(approval);
  const pending = approval.state === "pending" && left > 0;
  const answer = useWorkspaceChatStore((s) => s.answerApproval);

  useEffect(() => {
    const active = document.activeElement;
    const typing = active instanceof HTMLElement && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));
    if (!typing && (!active || active === document.body)) {
      // Cut arguments: start on Deny, so a stray Enter can't allow what wasn't fully shown.
      const deny = approval.truncated ? card.current?.querySelector<HTMLElement>("[data-deny]") : null;
      (deny ?? card.current)?.focus({ preventScroll: false });
    }
    // Only when the card first appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const respond = (allow: boolean) => {
    const hadFocus = !!card.current?.contains(document.activeElement);
    void answer(approval, allow);
    if (hadFocus) document.querySelector<HTMLElement>("[data-chat-composer]")?.focus();
  };

  const result = (approval.state === "closed" ? (CLOSED[approval.closedReason ?? ""] ?? "This request is closed.") : undefined) ?? RESULT[approval.state] ?? (approval.state === "pending" && left === 0 ? RESULT.expired : undefined);

  return (
    <div
      ref={card}
      tabIndex={-1}
      role="group"
      aria-labelledby={`${id}-t`}
      aria-describedby={`${id}-d`}
      data-approval={approval.state}
      className="rounded-lg border border-border bg-card px-3.5 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <p id={`${id}-t`} className="ui-section text-foreground">
        {pending ? "Needs your answer" : "Tool request"}
      </p>
      <p id={`${id}-d`} className="ui-body mt-0.5 text-foreground/90">
        The model wants to run <span className="font-semibold">{approval.tool}</span> on <span className="font-semibold">{approval.server}</span>.
      </p>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={`${id}-a`}
        className="ui-meta mt-2 inline-flex items-center gap-1 rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <ChevronRight className={cn("h-3 w-3 transition-transform motion-reduce:transition-none", open && "rotate-90")} aria-hidden="true" />
        {open ? "Hide arguments" : "Show arguments"}
      </button>
      {approval.truncated && (
        <p className="ui-meta mt-1.5 text-foreground">Not everything is shown: these arguments were cut. Deny it unless you are sure.</p>
      )}
      {open && (
        <pre
          id={`${id}-a`}
          tabIndex={0}
          aria-label="Exact arguments"
          className="ui-meta mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/60 px-2.5 py-2 text-foreground/90 outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          {prettyArgs(approval.args)}
        </pre>
      )}
      <div className="mt-3 flex min-h-8 flex-wrap items-center gap-2">
        {pending || approval.state === "sending" ? (
          <>
            <button type="button" disabled={!pending} onClick={() => respond(true)} className={cn(buttonClass.base, buttonClass.primary)}>
              Allow once
            </button>
            <button type="button" data-deny disabled={!pending} onClick={() => respond(false)} className={cn(buttonClass.base, buttonClass.quiet)}>
              Deny
            </button>
            <span className="ui-meta ml-auto tabular-nums text-muted-foreground" role="timer" aria-label={`${left} seconds left`}>
              {approval.state === "sending" ? "Sending" : `Denied automatically in ${left} s`}
            </span>
          </>
        ) : (
          <p role="status" className="ui-body text-muted-foreground">
            {result}
          </p>
        )}
      </div>
    </div>
  );
}
