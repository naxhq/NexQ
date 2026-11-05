import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { open } from "@tauri-apps/plugin-shell";
import { useUpdaterStore } from "../stores/updaterStore";
import { releaseNotesUrl, restartToUpdate } from "../hooks/useUpdater";
import { NEXQ_VERSION } from "../lib/version";
import { fetchReleaseNotes, formatReleaseDate, type ChangelogRelease } from "../lib/changelog";
import { releaseWave } from "../lib/releaseWave.mjs";

type Notes =
  | { status: "loading" }
  | { status: "loaded"; releases: ChangelogRelease[] }
  | { status: "failed" };

/**
 * The release's own waveform. It doubles as the progress bar while a newer
 * version downloads, the same way it does in the installer.
 */
function ReleaseWave({ version, progress }: { version: string; progress: number }) {
  const wave = useMemo(() => releaseWave(version, 72), [version]);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    setRevealed(false);
    const frame = requestAnimationFrame(() => setRevealed(true));
    return () => cancelAnimationFrame(frame);
  }, [version]);

  const filledBars = revealed ? Math.round(progress * wave.length) : 0;

  return (
    <div aria-hidden="true" className="flex h-11 items-center gap-[3px]">
      {wave.map((height, i) => (
        <span
          key={i}
          className={`min-w-0 flex-1 rounded-full transition-colors duration-300 ${
            i < filledBars ? "bg-primary" : "bg-muted"
          }`}
          style={{
            height: `${Math.max(height * 100, 8)}%`,
            transitionDelay: `${i * 7}ms`,
          }}
        />
      ))}
    </div>
  );
}

function ReleaseNotes({ notes, version }: { notes: Notes; version: string }) {
  if (notes.status === "loading") {
    return (
      <div aria-label="Loading release notes" className="space-y-3 py-1">
        <div className="h-3 w-3/4 animate-pulse rounded bg-muted/70" />
        <div className="h-3 w-1/2 animate-pulse rounded bg-muted/70" />
        <div className="h-3 w-2/3 animate-pulse rounded bg-muted/70" />
      </div>
    );
  }

  if (notes.status === "failed") {
    return (
      <p className="text-sm text-muted-foreground">
        Couldn't load the notes for this update. You can still install it, or read them on GitHub.
      </p>
    );
  }

  if (notes.releases.length === 0) {
    return <p className="text-sm text-muted-foreground">No notes for v{version}.</p>;
  }

  const several = notes.releases.length > 1;

  return (
    <div className="space-y-6">
      {notes.releases.map((release) => (
        <section key={release.version} className="space-y-3">
          {several && (
            <div className="flex items-baseline gap-2 text-xs">
              <span className="font-semibold tabular-nums text-foreground/90">
                {release.version}
              </span>
              <span className="text-muted-foreground/70">{formatReleaseDate(release.date)}</span>
            </div>
          )}
          {release.sections.map((section) => (
            <div key={section.title} className="grid grid-cols-[52px_1fr] gap-x-3">
              <span className="pt-px text-xs font-medium text-primary">{section.title}</span>
              <ul className="space-y-1.5">
                {section.items.map((item) => (
                  <li key={item} className="text-sm leading-snug text-foreground/85">
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

/**
 * What's in the update, shown before it's installed. Opening it also looks for
 * a newer release (openUpdateDialog), so the person ends up on the latest
 * version in one step and sees the notes for what they actually get.
 */
export function UpdateDialog() {
  const dialogOpen = useUpdaterStore((s) => s.dialogOpen);
  const phase = useUpdaterStore((s) => s.phase);
  const version = useUpdaterStore((s) => s.version);
  const refresh = useUpdaterStore((s) => s.refresh);
  const refreshVersion = useUpdaterStore((s) => s.refreshVersion);
  const progress = useUpdaterStore((s) => s.progress);
  const autoUpdate = useUpdaterStore((s) => s.autoUpdate);
  const setDialogOpen = useUpdaterStore((s) => s.setDialogOpen);

  const visible = dialogOpen && phase === "ready" && !!version;

  const [notes, setNotes] = useState<Notes>({ status: "loading" });
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    if (!visible || !version) return;
    let stale = false;
    setNotes({ status: "loading" });
    fetchReleaseNotes(NEXQ_VERSION, version)
      .then((releases) => {
        if (!stale) setNotes({ status: "loaded", releases });
      })
      .catch((err) => {
        console.warn("[updater] Failed to load release notes:", err);
        if (!stale) setNotes({ status: "failed" });
      });
    return () => {
      stale = true;
    };
  }, [visible, version]);

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !installing) setDialogOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, installing, setDialogOpen]);

  if (!visible || !version) return null;

  const released =
    notes.status === "loaded"
      ? formatReleaseDate(notes.releases.find((r) => r.version === version)?.date)
      : null;

  const fetching = refresh === "downloading";
  const pct =
    fetching && progress.total && progress.total > 0
      ? Math.min(100, Math.round((progress.received / progress.total) * 100))
      : null;

  let installLabel = "Install and restart";
  if (installing) installLabel = "Restarting…";
  else if (refresh === "checking") installLabel = "Checking for newer…";
  else if (fetching) {
    installLabel = `Getting ${refreshVersion ?? "the latest"}${pct !== null ? ` · ${pct}%` : "…"}`;
  }

  const handleInstall = async () => {
    setInstalling(true);
    try {
      await restartToUpdate();
    } finally {
      // Only reached if the user cancelled or the install failed.
      setInstalling(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !installing) setDialogOpen(false);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-dialog-version"
        className="flex max-h-full w-full max-w-[520px] flex-col overflow-hidden rounded-2xl border border-border/40 bg-card shadow-2xl"
      >
        <header className="space-y-4 px-6 pt-6">
          <div>
            <p className="text-xs font-medium text-primary">Update ready</p>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-3">
              <h2
                id="update-dialog-version"
                className="text-[40px] font-semibold leading-none tracking-tight tabular-nums text-foreground"
              >
                {version}
              </h2>
              <p className="text-xs text-muted-foreground">
                You're on {NEXQ_VERSION}
                {released ? ` · Released ${released}` : ""}
              </p>
            </div>
          </div>
          <ReleaseWave
            version={fetching && refreshVersion ? refreshVersion : version}
            progress={fetching ? (pct ?? 0) / 100 : 1}
          />
        </header>

        <div className="min-h-[96px] flex-1 overflow-y-auto px-6 py-5">
          <ReleaseNotes notes={notes} version={version} />
        </div>

        <footer className="flex items-center gap-2 border-t border-border/30 px-6 py-4">
          <button
            onClick={() => open(releaseNotesUrl(version)).catch(() => {})}
            className="mr-auto flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Full release notes
            <ArrowUpRight className="h-3 w-3" />
          </button>
          <button
            onClick={() => setDialogOpen(false)}
            disabled={installing}
            title={autoUpdate ? "It installs by itself when you quit NexQ" : undefined}
            className="rounded-lg px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground disabled:opacity-50"
          >
            Later
          </button>
          <button
            autoFocus
            onClick={handleInstall}
            disabled={installing || refresh !== "idle"}
            className="rounded-lg bg-primary px-4 py-2 text-xs font-semibold tabular-nums text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
          >
            {installLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
