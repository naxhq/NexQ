import { useEffect, useState } from "react";
import { FileWarning, X } from "lucide-react";
import { getDbIntegrity } from "../lib/ipc";
import { onDbIntegrityProblem } from "../lib/events";
import type { DbIntegrityFinding } from "../lib/types";

const isFinding = (f: unknown): f is DbIntegrityFinding => !!f && typeof f === "object" && Array.isArray((f as DbIntegrityFinding).copies);

/** The notice's words: what was found, that work goes on, and where the copies are. */
export function damageText(f: DbIntegrityFinding): { title: string; lines: string[] } {
  const lines = ["NexQ keeps working with it and has changed nothing."];
  lines.push(
    f.copies.length > 0
      ? `${f.copies.length === 1 ? "A copy of your meetings exists" : `${f.copies.length} copies of your meetings exist`} in the app data folder: ${f.folder}`
      : `No copy of your meetings was found yet. The file is in the app data folder: ${f.folder}`,
  );
  return { title: "Your meetings file has some damage", lines };
}

/**
 * A calm notice, not an alarm: the daily check of the open file found damage. It never acts
 * on its own; the folder and the copies are named so the person can decide. Closing hides it
 * for this run; it returns on the next start while the damage is still there.
 */
export function DatabaseDamageNotice() {
  const [finding, setFinding] = useState<DbIntegrityFinding | null>(null);
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    let gone = false;
    let unlisten: (() => void) | undefined;
    getDbIntegrity().then(
      (f) => !gone && isFinding(f) && setFinding(f),
      () => {},
    );
    onDbIntegrityProblem((f) => !gone && isFinding(f) && setFinding(f)).then(
      (fn) => {
        if (gone) fn();
        else unlisten = fn;
      },
      () => {},
    );
    return () => {
      gone = true;
      unlisten?.();
    };
  }, []);

  if (!finding || closed) return null;
  const text = damageText(finding);
  return (
    <div>
      <div role="status" aria-live="polite" className="flex w-full items-start gap-3 rounded-xl border border-border/20 bg-card px-4 py-3 shadow-lg">
        <FileWarning className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground/90">{text.title}</p>
          {text.lines.map((l) => (
            <p key={l} className="mt-1 break-words text-xs text-muted-foreground">
              {l}
            </p>
          ))}
        </div>
        <button
          onClick={() => setClosed(true)}
          aria-label="Close"
          className="rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-2"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
