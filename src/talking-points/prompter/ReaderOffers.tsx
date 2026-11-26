import { RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import type { ScrollKind } from "../../stores/talkingPointsStore";
import { Button } from "../../ui";
import { cn } from "../../lib/utils";
import type { PrompterState } from "./prompterTypes";

const CHIP = "bg-popover/95 text-popover-foreground shadow-md backdrop-blur-sm";

/**
 * The quiet chips over the reading area: Go to, Back to where I was, Resume. Never take focus.
 * One action area: a "Go to" aimed at the top edge floats there; everything else shares a single
 * column at the bottom, so no two chips can sit on the same spot. The slot nearest the bottom
 * edge ("primary") belongs to Resume while auto-scroll is paused, then Back, then Go to.
 */
export function ReaderOffers({ p, readingMode }: { p: PrompterState; readingMode: ScrollKind }) {
  const showResume = p.yielding && readingMode !== "manual";
  const sg = p.suggestion;
  const goTop = !!sg && sg.edge === "top";
  const goBottom = !!sg && sg.edge !== "top";

  const goTo = sg && (
    <Button key="goto" variant="ghost" tabIndex={-1} onClick={p.goToSuggestion} data-offer="goto" className={cn("tp-offer max-w-full", CHIP)}>
      <span className="truncate">Go to: {sg.text}</span>
    </Button>
  );
  const back = p.canGoBack && (
    <Button key="back" variant="ghost" tabIndex={-1} onClick={p.goBack} data-offer="back" className={cn("tp-offer", CHIP)}>
      <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
      Back to where I was
    </Button>
  );
  const resume = showResume && (
    <Button key="resume" variant="ghost" onClick={p.resume} data-offer="resume" className={cn("tp-offer", CHIP)}>
      <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
      Resume
    </Button>
  );

  // Priority for the primary (bottom-most) slot; the rest stack above it.
  const bottom = [resume, back, goBottom ? goTo : null].filter(Boolean) as ReactNode[];
  const [primary, ...secondary] = bottom;

  return (
    <>
      <div aria-live="polite" className="sr-only">
        {sg ? `Go to: ${sg.text}` : ""}
      </div>
      {goTop && (
        <div className="tp-offers-top">{goTo}</div>
      )}
      {bottom.length > 0 && (
        <div className="tp-offers" data-count={bottom.length}>
          <div className="tp-offer-slot" data-offer-slot="primary">{primary}</div>
          {secondary.map((c, i) => (
            <div key={i} className="tp-offer-slot" data-offer-slot="secondary">{c}</div>
          ))}
        </div>
      )}
    </>
  );
}
