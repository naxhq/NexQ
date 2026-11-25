import { Loader2 } from "lucide-react";
import { indexingWords, useWorkspaceIndex } from "./indexStatus";
import type { IndexProgress } from "./libraryStatus";
import { hintClass } from "./styles";

/**
 * Shown beside search results and answers while the index is still being built:
 * what is found may not be everything yet. Give it the progress you already
 * have, or just the workspace id and it reads the index itself.
 */
export function IndexingNote({ workspaceId, progress, compact = false }: { workspaceId: string; progress?: IndexProgress | null; compact?: boolean }) {
  const own = useWorkspaceIndex(workspaceId);
  const words = indexingWords(progress === undefined ? own.progress : progress);
  if (!words) return null;
  return (
    <p role="status" className={`${hintClass} flex min-w-0 items-center gap-1.5`}>
      <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      {compact ? <span className="truncate">{words}</span> : <span>{words}. Results may leave out files that aren't indexed yet.</span>}
    </p>
  );
}
