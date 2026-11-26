import { Suspense, useEffect, useState } from "react";
import { CheckCircle2, FlaskConical, FolderSync, Loader2, TriangleAlert, Zap } from "lucide-react";
import { lazyNamed } from "../lib/lazyNamed";
import { Button } from "../ui";

const TestSearchDialog = lazyNamed(() => import("../context/TestSearchDialog"), "TestSearchDialog");
import { getIndexStatus, rescanWorkspace } from "../lib/ipc";
import { RecapRetry, type RecapFailed } from "./RecapRetry";
import { useConfigStore } from "../stores/configStore";
import { useContextStore } from "../stores/contextStore";
import { useRagStore } from "../stores/ragStore";
import { cn } from "../lib/utils";
import { IndexingNote } from "./IndexingNote";
import type { IndexProgress } from "./libraryStatus";

/**
 * Knowledge base actions, as the old dashboard had them: build or update,
 * rebuild when settings changed, test a search, and the "indexing a file"
 * line. Only with the local knowledge base on. Plus a rescan of folders.
 */
export function LibraryFooter({ workspaceId, hasFolders, progress }: { workspaceId: string; hasFolders: boolean; progress?: IndexProgress | null }) {
  const contextStrategy = useConfigStore((s) => s.contextStrategy);
  const resources = useContextStore((s) => s.resources);
  const indexStatus = useRagStore((s) => s.indexStatus);
  const indexStale = useRagStore((s) => s.indexStale);
  const isAutoIndexing = useRagStore((s) => s.isAutoIndexing);
  const rebuildIndex = useRagStore((s) => s.rebuildIndex);
  const [rag, setRag] = useState<"idle" | "updating" | "done">("idle");
  const [testing, setTesting] = useState(false);
  const [rescanning, setRescanning] = useState(false);
  const [recapFailed, setRecapFailed] = useState<RecapFailed>(null);
  // Where recaps are expected, say when some failed (read again when an index run ends).
  const running = !!progress;
  const [retried, setRetried] = useState(false);
  useEffect(() => {
    let live = true;
    getIndexStatus(workspaceId)
      .then((s) => {
        if (!live) return;
        setRecapFailed(s?.ai_recaps_failed ?? null);
        if (s?.ai_recaps_failed) setRetried(true);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [workspaceId, running]);

  const update = async () => {
    setRag("updating");
    try {
      await rebuildIndex();
      setRag("done");
      setTimeout(() => setRag("idle"), 3000);
    } catch {
      setRag("idle");
    }
  };

  const rescan = async () => {
    setRescanning(true);
    try {
      await rescanWorkspace(workspaceId);
    } catch {
      /* progress and skipped files report themselves */
    } finally {
      setRescanning(false);
    }
  };

  const ragOn = resources.length > 0 && contextStrategy === "local_rag";
  if (!ragOn && !hasFolders && !progress && !recapFailed && !retried) return null;

  const hasIndex = (indexStatus?.total_chunks ?? 0) > 0;
  const label = indexStale ? "Settings changed, rebuild the knowledge base" : !hasIndex ? "Build the knowledge base" : "Update the knowledge base";
  const Icon = indexStale ? TriangleAlert : !hasIndex ? Zap : CheckCircle2;

  return (
    <div className="space-y-0.5 border-t border-border px-3 py-1.5" role="group" aria-label="Knowledge base">
      <div className="px-2.5">
        <IndexingNote workspaceId={workspaceId} progress={progress ?? null} compact />
      </div>
      <RecapRetry workspaceId={workspaceId} failed={recapFailed} onChange={(f) => setRecapFailed(f)} compact />
      {ragOn && rag === "idle" && (
        <Button variant="ghost" size="sm" onClick={update} className={cn("w-full justify-start", indexStale && "text-warning hover:text-warning")}>
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
          {label}
        </Button>
      )}
      {rag === "updating" && (
        <p role="status" className="ui-body flex items-center gap-2 px-2.5 py-1.5 text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          Building the knowledge base
        </p>
      )}
      {rag === "done" && (
        <p role="status" className="ui-body flex items-center gap-2 px-2.5 py-1.5 text-success">
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
          Knowledge base updated
        </p>
      )}
      {ragOn && isAutoIndexing && rag === "idle" && (
        <p role="status" className="ui-meta flex items-center gap-2 px-2.5 text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          Indexing a file
        </p>
      )}
      {ragOn && hasIndex && rag !== "updating" && (
        <Button variant="ghost" size="sm" onClick={() => setTesting(true)} className="w-full justify-start">
          <FlaskConical className="h-3.5 w-3.5" aria-hidden="true" />
          Test a search
        </Button>
      )}
      {hasFolders && (
        <Button variant="ghost" size="sm" onClick={rescan} disabled={rescanning} className="w-full justify-start">
          <FolderSync className="h-3.5 w-3.5" aria-hidden="true" />
          {rescanning ? "Scanning folders" : "Rescan folders"}
        </Button>
      )}
      {testing && (
        <Suspense fallback={null}>
          <TestSearchDialog isOpen onClose={() => setTesting(false)} />
        </Suspense>
      )}
    </div>
  );
}
