import { RotateCcw } from "lucide-react";
import type { ScrollKind } from "../../stores/talkingPointsStore";
import { buttonClass } from "../../ui";
import { cn } from "../../lib/utils";
import type { PrompterState } from "./prompterTypes";

/** The quiet chips over the reading area: Go to, Back to where I was, Resume. Never take focus. */
export function ReaderOffers({ p, readingMode }: { p: PrompterState; readingMode: ScrollKind }) {
  return (
    <>
      <div aria-live="polite" className="sr-only">
        {p.suggestion ? `Go to: ${p.suggestion.text}` : ""}
      </div>
      {p.suggestion && (
        <button
          type="button"
          tabIndex={-1}
          onClick={p.goToSuggestion}
          className={cn(
            buttonClass.base,
            "tp-suggest max-w-[calc(100%-1.5rem)] border border-border bg-popover/95 text-popover-foreground shadow-md backdrop-blur-sm hover:bg-accent",
            p.suggestion.edge === "top" ? "tp-suggest-top" : "tp-suggest-bottom",
          )}
        >
          <span className="truncate">Go to: {p.suggestion.text}</span>
        </button>
      )}
      {p.canGoBack && (
        <button
          type="button"
          tabIndex={-1}
          onClick={p.goBack}
          className={cn(buttonClass.base, "tp-back border border-border bg-popover/95 text-popover-foreground shadow-md backdrop-blur-sm hover:bg-accent")}
        >
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          Back to where I was
        </button>
      )}
      {p.yielding && readingMode !== "manual" && (
        <button
          type="button"
          onClick={p.resume}
          className={cn(buttonClass.base, "tp-resume border border-border bg-popover/95 text-popover-foreground shadow-md backdrop-blur-sm hover:bg-accent")}
        >
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          Resume
        </button>
      )}
    </>
  );
}
