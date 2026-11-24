import { useEffect, useId, useRef, useState } from "react";
import { Star } from "lucide-react";
import { open } from "@tauri-apps/plugin-shell";
import { useStarPrompt } from "../hooks/useStarPrompt";
import { useToastStore } from "../stores/toastStore";
import { NEXQ_NEW_ISSUE_URL, NEXQ_REPO_URL } from "../lib/links";
import { THANKS_CLOSE_MS } from "../lib/starPrompt";

export const STAR_PROMPT_TITLE = "Is NexQ working for you?";
export const STAR_PROMPT_BODY = "It's free and open source. A star on GitHub helps other people find it.";
export const STAR_PROMPT_THANKS = "Thanks. GitHub is open in your browser.";
export const STAR_PROMPT_OPEN_FAILED = "Couldn't open your browser.";

const EXIT_MS = 180;
/** Sits where the update notice does (bottom-14), a little above the footer. */
const BASE_BOTTOM_PX = 56;
/** Bottom margin of ToastContainer (bottom-4) plus a gap. */
const TOAST_CLEARANCE_PX = 16 + 10;

type Phase = "ask" | "thanks";

/**
 * One-time card after the fifth finished meeting. A card in the corner, not a
 * dialog: no backdrop, no focus grab, the app stays usable around it.
 */
export function StarPrompt() {
  const { visible, acknowledge, close } = useStarPrompt();
  if (!visible) return null;
  return <StarPromptCard onAcknowledge={acknowledge} onClose={close} />;
}

/** Height ToastContainer takes in the same corner, so the card can stay above it. */
function toastStackHeight(): number {
  const stack = document.querySelector('[aria-label="Notifications"]');
  return stack ? stack.getBoundingClientRect().height : 0;
}

function StarPromptCard({ onAcknowledge, onClose }: { onAcknowledge: () => void; onClose: () => void }) {
  const titleId = useId();
  const [phase, setPhase] = useState<Phase>("ask");
  const [openFailed, setOpenFailed] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [lift, setLift] = useState(0);
  const opening = useRef(false);
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const toastCount = useToastStore((s) => s.toasts.length);

  const later = (fn: () => void, ms: number) => {
    timers.current.push(setTimeout(fn, ms));
  };
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  // Toasts share this corner: stay above them while they are up.
  useEffect(() => {
    const height = toastStackHeight();
    setLift(height > 0 ? height + TOAST_CLEARANCE_PX : 0);
  }, [toastCount]);

  // Screen readers: a live region has to exist before its text does.
  useEffect(() => {
    const message =
      phase === "thanks" ? STAR_PROMPT_THANKS : openFailed ? STAR_PROMPT_OPEN_FAILED : `${STAR_PROMPT_TITLE} ${STAR_PROMPT_BODY}`;
    const timer = setTimeout(() => setAnnouncement(message), 120);
    return () => clearTimeout(timer);
  }, [phase, openFailed]);

  const dismiss = () => {
    if (leaving) return;
    onAcknowledge();
    setLeaving(true);
    later(onClose, EXIT_MS);
  };

  const openLink = async (url: string, onOpened: () => void) => {
    if (opening.current || leaving) return;
    opening.current = true;
    onAcknowledge();
    try {
      await open(url);
      setOpenFailed(false);
      onOpened();
    } catch (err) {
      console.warn("[starPrompt] Could not open the browser:", err);
      setOpenFailed(true);
    } finally {
      opening.current = false;
    }
  };

  const onStar = () =>
    openLink(NEXQ_REPO_URL, () => {
      setPhase("thanks");
      later(dismiss, THANKS_CLOSE_MS);
    });
  const onFeedback = () => openLink(NEXQ_NEW_ISSUE_URL, dismiss);

  return (
    <div
      className="fixed right-4 z-40 transition-[bottom] duration-200 ease-out"
      style={{ bottom: Math.max(BASE_BOTTOM_PX, lift) }}
    >
      <section
        role="region"
        aria-labelledby={titleId}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          // Focus is inside the card: this Escape is for the card only.
          e.stopPropagation();
          dismiss();
        }}
        className={`w-[392px] rounded-2xl border border-border/60 bg-popover p-4 shadow-2xl ${
          leaving ? "star-prompt-exit" : "star-prompt-enter"
        }`}
      >
        <span role="status" aria-live="polite" className="sr-only">
          {announcement}
        </span>

        {phase === "thanks" ? (
          <p id={titleId} className="text-sm font-semibold text-foreground">
            {STAR_PROMPT_THANKS}
          </p>
        ) : (
          <>
            <h2 id={titleId} className="text-sm font-semibold tracking-tight text-foreground">
              {STAR_PROMPT_TITLE}
            </h2>
            <p className="mt-1 text-pretty text-xs leading-relaxed text-muted-foreground">{STAR_PROMPT_BODY}</p>
            {openFailed && <p className="mt-2 text-xs font-medium text-destructive">{STAR_PROMPT_OPEN_FAILED}</p>}

            <div className="mt-4 flex items-center gap-2">
              <button
                type="button"
                onClick={dismiss}
                className="-ml-1.5 mr-auto rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                Don't show again
              </button>
              <button
                type="button"
                onClick={onFeedback}
                className="rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
              >
                Send feedback
              </button>
              <button
                type="button"
                onClick={onStar}
                className="group inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
              >
                <Star
                  aria-hidden="true"
                  className="h-3.5 w-3.5 fill-transparent transition-[fill] duration-150 group-hover:fill-current group-focus-visible:fill-current"
                />
                Star on GitHub
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
