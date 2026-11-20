import { Fragment, useId } from "react";
import { BookOpen, Wrench } from "lucide-react";
import type { SourceChip } from "../lib/types";
import { openSourceFile } from "../lib/ipc";
import { showToast } from "../stores/toastStore";

export { dedupeChips } from "../lib/sourceChips";

const CHIP =
  "inline-flex max-w-[14rem] items-center gap-1 rounded-full px-2 py-0.5 text-meta font-medium transition-colors";

function open(chip: SourceChip) {
  if (!chip.path) return;
  openSourceFile(chip.path).catch((e) => {
    const reason = typeof e === "string" ? e : e instanceof Error ? e.message : "it could not be opened";
    showToast(`Couldn't open ${chip.label}: ${reason}`, "error");
  });
}

/**
 * The notes and tools an answer used, at its end. A note opens in its own app
 * when clicked; a tool is plain text.
 */
export function SourceChips({ chips }: { chips: SourceChip[] }) {
  const baseId = useId();
  const shown = chips.filter((c) => c.kind !== "notice");
  if (shown.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-border/10 pt-2" aria-label="Sources used">
      {shown.map((chip, i) =>
        chip.kind === "notes" && chip.path ? (
          <Fragment key={`${chip.kind}-${chip.label}-${chip.path}-${i}`}>
          <button
            type="button"
            onClick={() => open(chip)}
            title={chip.path}
            aria-describedby={`${baseId}-${i}`}
            className={`${CHIP} cursor-pointer bg-highlight/15 text-highlight hover:bg-highlight/25`}
          >
            <BookOpen className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="truncate">{chip.label}</span>
          </button>
          <span id={`${baseId}-${i}`} className="sr-only">
            Opens {chip.path}
          </span>
          </Fragment>
        ) : (
          <span
            key={`${chip.kind}-${chip.label}-${i}`}
            className={`${CHIP} ${chip.kind === "notes" ? "bg-highlight/15 text-highlight" : "bg-primary/15 text-primary"}`}
          >
            {chip.kind === "notes" ? (
              <BookOpen className="h-3 w-3 shrink-0" aria-hidden="true" />
            ) : (
              <Wrench className="h-3 w-3 shrink-0" aria-hidden="true" />
            )}
            <span className="truncate">{chip.label}</span>
          </span>
        ),
      )}
    </div>
  );
}
