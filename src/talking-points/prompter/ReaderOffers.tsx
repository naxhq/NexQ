import { RotateCcw } from "lucide-react";
import type { ScrollKind } from "../../stores/talkingPointsStore";
import { Button } from "../../ui";
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
        <Button variant="ghost"
          tabIndex={-1}
          onClick={p.goToSuggestion} className={cn("tp-suggest max-w-[calc(100%-1.5rem)] bg-popover/95 text-popover-foreground shadow-md backdrop-blur-sm", p.suggestion.edge === "top" ? "tp-suggest-top" : "tp-suggest-bottom")}>
          <span className="truncate">Go to: {p.suggestion.text}</span>
        </Button>
      )}
      {p.canGoBack && (
        <Button variant="ghost"
          tabIndex={-1}
          onClick={p.goBack} className="tp-back bg-popover/95 text-popover-foreground shadow-md backdrop-blur-sm">
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          Back to where I was
        </Button>
      )}
      {p.yielding && readingMode !== "manual" && (
        <Button variant="ghost"
          onClick={p.resume} className="tp-resume bg-popover/95 text-popover-foreground shadow-md backdrop-blur-sm">
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          Resume
        </Button>
      )}
    </>
  );
}
