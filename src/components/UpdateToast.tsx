import { useEffect, useRef, useState } from "react";
import { ArrowUpCircle, X } from "lucide-react";
import { useUpdaterStore } from "../stores/updaterStore";
import { openUpdateDialog } from "../hooks/useUpdater";

const AUTO_DISMISS_MS = 12_000;

/**
 * One-time notice when an update has finished downloading. The footer pill
 * stays as the persistent way in; this only announces it once per version.
 */
export function UpdateReadyToast() {
  const phase = useUpdaterStore((s) => s.phase);
  const version = useUpdaterStore((s) => s.version);
  const autoUpdate = useUpdaterStore((s) => s.autoUpdate);
  const announced = useRef(new Set<string>());
  const [visibleVersion, setVisibleVersion] = useState<string | null>(null);

  useEffect(() => {
    if (phase !== "ready" || !version || announced.current.has(version)) return;
    announced.current.add(version);
    setVisibleVersion(version);
  }, [phase, version]);

  useEffect(() => {
    if (!visibleVersion) return;
    const timer = setTimeout(() => setVisibleVersion(null), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [visibleVersion]);

  // Hide if the update was skipped or installed meanwhile.
  if (!visibleVersion || phase !== "ready" || version !== visibleVersion) return null;

  return (
    <div className="fixed bottom-14 right-4 z-50">
      <div
        role="status"
        aria-live="polite"
        className="flex w-[300px] items-start gap-3 rounded-xl border border-border/20 bg-card/90 px-4 py-3 shadow-lg backdrop-blur-md"
      >
        <ArrowUpCircle className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground/90">
            NexQ v{visibleVersion} is ready
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {autoUpdate
              ? "Install it from the footer, or it installs when you quit."
              : "Install it from the footer."}
          </p>
          <button
            onClick={() => {
              setVisibleVersion(null);
              openUpdateDialog();
            }}
            className="mt-1.5 text-xs font-medium text-primary hover:underline"
          >
            What's new
          </button>
        </div>
        <button
          onClick={() => setVisibleVersion(null)}
          aria-label="Dismiss"
          className="shrink-0 rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
