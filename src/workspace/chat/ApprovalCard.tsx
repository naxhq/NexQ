import { useEffect, useId, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "../../ui";
import { cn } from "../../lib/utils";
import { APPROVAL_SECONDS, useWorkspaceChatStore, type Approval } from "../../stores/workspaceChatStore";

/** Characters that can hide or reorder text (bidi controls, zero-width, soft hyphen, other controls) shown as \u{...}. */
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB]/g;

export function escapeInvisible(text: string): string {
  return text.replace(INVISIBLE, (c) => `\\u{${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}}`);
}

/** The whole arguments, exactly as received (never cut here), with hidden characters made visible. */
export function prettyArgs(args: unknown): string {
  let text: string;
  try {
    text = typeof args === "string" ? args : (JSON.stringify(args, null, 2) ?? "");
  } catch {
    text = String(args);
  }
  return escapeInvisible(text);
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
  timed_out: `No answer in ${APPROVAL_SECONDS} seconds, so it was denied.`,
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
  const [open, setOpen] = useState(true);
  const left = useSecondsLeft(approval);
  const pending = approval.state === "pending" && left > 0;
  // Anything the backend cut or hid: Deny is the default and Allow is not the highlighted button.
  const partial = approval.truncated || approval.redacted;
  const answer = useWorkspaceChatStore((s) => s.answerApproval);

  useEffect(() => {
    const active = document.activeElement;
    const typing = active instanceof HTMLElement && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));
    if (!typing && (!active || active === document.body)) {
      // Cut arguments: start on Deny, so a stray Enter can't allow what wasn't fully shown.
      const deny = partial ? card.current?.querySelector<HTMLElement>("[data-deny]") : null;
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
      className="rounded-lg border border-border bg-card px-3.5 py-3 outline-none ui-focus ui-r-lg"
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
        className="ui-meta mt-2 inline-flex items-center gap-1 rounded text-muted-foreground outline-none hover:text-foreground ui-focus ui-focus-sm"
      >
        <ChevronRight className={cn("h-3 w-3 transition-transform motion-reduce:transition-none", open && "rotate-90")} aria-hidden="true" />
        {open ? "Hide arguments" : "Show arguments"}
      </button>
      {approval.truncated && (
        <p className="ui-meta mt-1.5 text-foreground">Not everything is shown: these arguments were cut. Deny it unless you are sure.</p>
      )}
      {approval.redacted && (
        <p className="ui-meta mt-1.5 text-foreground">Secrets are hidden in these arguments, so this isn't exactly what runs.</p>
      )}
      {open && (
        <pre
          id={`${id}-a`}
          tabIndex={0}
          aria-label="Exact arguments"
          className="ui-meta mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/60 px-2.5 py-2 text-foreground/90 outline-none ui-focus ui-r-md"
        >
          {prettyArgs(approval.args)}
        </pre>
      )}
      <div className="mt-3 flex min-h-8 flex-wrap items-center gap-2">
        {pending || approval.state === "sending" ? (
          <>
            <Button variant={partial ? "quiet" : "primary"} disabled={!pending} onClick={() => respond(true)}>
              Allow once
            </Button>
            <Button variant={partial ? "primary" : "quiet"} data-deny disabled={!pending} onClick={() => respond(false)}>
              Deny
            </Button>
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
