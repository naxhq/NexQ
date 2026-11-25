import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "../ui";
import { getIndexStatus, retryRecaps } from "../lib/ipc";
import { recapFailureLine } from "./WorkspaceDialog";

export type RecapFailed = { count: number; reason: string | null } | null;

/** What the retry achieved, said plainly. */
export function retryOutcome(before: number, after: RecapFailed): string {
  const left = after?.count ?? 0;
  if (left === 0) return "All recaps are written.";
  if (left < before) return `${before - left} written, ${left} still failed.`;
  return "They failed again.";
}

/**
 * "3 recaps failed: no key" with Try again beside it, for any workspace. While it runs the button says so,
 * then the line shows what is left. Renders nothing when nothing failed and nothing was just retried.
 */
export function RecapRetry({
  workspaceId,
  failed,
  onChange,
  compact = false,
}: {
  workspaceId: string;
  failed: RecapFailed;
  onChange?: (failed: RecapFailed, recaps: number | null) => void;
  compact?: boolean;
}) {
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  useEffect(() => setOutcome(null), [workspaceId]);

  const line = recapFailureLine(failed);
  if (!line && !outcome && !running) return null;

  const run = async () => {
    const before = failed?.count ?? 0;
    setRunning(true);
    setOutcome(null);
    try {
      await retryRecaps(workspaceId);
      const s = await getIndexStatus(workspaceId);
      const after = s?.ai_recaps_failed ?? null;
      onChange?.(after, typeof s?.ai_recaps === "number" ? s.ai_recaps : null);
      setOutcome(retryOutcome(before, after));
    } catch (e) {
      setOutcome(`Couldn't try again: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className={compact ? "ui-meta px-2.5 text-warning" : "ui-body flex flex-wrap items-center gap-x-3 gap-y-1 text-warning"} data-testid="recap-retry">
      {line && <span role="status">{line}</span>}
      {line && (
        <Button variant="ghost" size={compact ? "sm" : undefined} onClick={run} disabled={running} className="px-2">
          {running && <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
          {running ? "Trying again" : "Try again"}
        </Button>
      )}
      {outcome && !running && <span role="status" className="text-foreground">{outcome}</span>}
    </div>
  );
}
