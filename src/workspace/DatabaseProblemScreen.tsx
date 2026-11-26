import { useEffect, useRef, useState } from "react";
import { Button, ConfirmDialog } from "../ui";
import { formatFileSize } from "../lib/utils";
import { openUpdateDialog } from "../hooks/useUpdater";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { showToast } from "../stores/toastStore";
import { messageOf } from "../lib/plainError";
import {
  PROBLEM_COPY,
  copyDate,
  fileNameOf,
  openDataFolder,
  isMissingCommand,
  restartApp,
  restoreDatabaseCopy,
  retryOpenDatabase,
  startWithNewDatabase,
  type DatabaseBackup,
  type DatabaseProblem,
} from "./databaseProblem";


type Phase = { kind: "idle" } | { kind: "working"; what: string } | { kind: "restart"; what: string } | { kind: "error"; text: string } | { kind: "still" };

/** "12 Nov 2026, 09:40": the date of a copy, with the time, so two copies of one day differ. */
export function formatCopyDate(created_at: number): string {
  const d = copyDate(created_at);
  return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}, ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

function BackupRow({ backup, busy, onRestore }: { backup: DatabaseBackup; busy: boolean; onRestore: () => void }) {
  const when = formatCopyDate(backup.created_at);
  const count = backup.meetings == null ? "Meetings not counted" : `${backup.meetings} ${backup.meetings === 1 ? "meeting" : "meetings"}`;
  return (
    <li className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="ui-body font-medium text-foreground">Copy from {when}</p>
        <p className="ui-meta text-muted-foreground">
          {count}, {formatFileSize(backup.bytes)}
        </p>
      </div>
      <Button variant="quiet" onClick={onRestore} disabled={busy} aria-label={`Restore the copy from ${when}, ${count}`}>
        Restore
      </Button>
    </li>
  );
}

/**
 * Shown in place of the home when the meetings file can't be used. It says what
 * happened in one sentence, that nothing was deleted and where the file is, and
 * offers only the choices that fit that kind. Nothing here is a red alarm: the
 * data is safe, the question is what to do next.
 */
export function DatabaseProblemScreen({ problem }: { problem: DatabaseProblem }) {
  const copy = PROBLEM_COPY[problem.kind];
  const refresh = useWorkspaceStore((s) => s.refresh);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const restart = useRef<HTMLButtonElement | null>(null);
  const busy = phase.kind === "working";
  const fileName = fileNameOf(problem.path);

  // A screen reader lands on what happened; after a fix, on the one thing left to do.
  useEffect(() => heading.current?.focus(), []);
  useEffect(() => {
    if (phase.kind === "restart") restart.current?.focus();
  }, [phase.kind]);

  const run = async (what: string, action: () => Promise<void>, then: Phase) => {
    setPhase({ kind: "working", what });
    try {
      await action();
      setPhase(then);
    } catch (e) {
      setPhase({ kind: "error", text: messageOf(e) });
    }
  };

  // Locked: ask the backend to open the file again, then look. Without that command, a restart does the same.
  const recheck = async () => {
    setPhase({ kind: "working", what: "Opening your meetings again" });
    let found: Awaited<ReturnType<typeof retryOpenDatabase>>;
    try {
      found = await retryOpenDatabase();
    } catch (e) {
      if (isMissingCommand(e)) {
        await run("Restarting", restartApp, { kind: "idle" });
        return;
      }
      setPhase({ kind: "error", text: messageOf(e) });
      return;
    }
    // It opens now, but the running app cannot take it in: say so and offer the restart.
    if (found?.ok && found.needs_restart) {
      setPhase({ kind: "restart", what: "Your meetings can be opened now." });
      return;
    }
    if (found && !found.ok) {
      setPhase({ kind: "still" });
      return;
    }
    await refresh();
    // Cleared: the home takes this screen's place. Still there: say so.
    const now = useWorkspaceStore.getState().database;
    if (now) setPhase({ kind: "still" });
    else showToast("Your meetings are open again", "success");
  };

  const openFolder = () => void run("Opening", openDataFolder, { kind: "idle" });

  if (phase.kind === "restart") {
    return (
      <Shell>
        <h1 ref={heading} tabIndex={-1} style={{ outline: "none" }} className="ui-title text-foreground">
          NexQ needs to restart
        </h1>
        <p role="status" className="ui-body ui-measure mt-2 text-muted-foreground">
          {phase.what} Restart to open your meetings.
        </p>
        <div className="mt-5">
          <Button ref={restart} variant="primary" size="lg" onClick={() => void run("Restarting", restartApp, { kind: "idle" })} disabled={busy}>
            Restart NexQ
          </Button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 ref={heading} tabIndex={-1} style={{ outline: "none" }} className="ui-title text-foreground">
        {copy.title}
      </h1>
      <p className="ui-body ui-measure mt-2 text-foreground">{copy.what}</p>
      <p className="ui-body ui-measure mt-3 text-muted-foreground">
        Nothing was deleted. Your meetings are still in this file:
      </p>
      <p className="ui-body mt-1 break-all rounded-lg bg-accent px-3 py-2 text-foreground" data-testid="db-path">
        {problem.path}
      </p>
      {problem.message && (
        <p className="ui-meta mt-2 text-muted-foreground">
          <span className="sr-only">Details: </span>
          {problem.message}
        </p>
      )}

      <div className="mt-6 space-y-6">
        {problem.kind === "unreadable" && (
          <section aria-labelledby="db-copies">
            <h2 id="db-copies" className="ui-section text-foreground">
              Restore a copy
            </h2>
            {problem.backups.length > 0 ? (
              <ul className="mt-1 divide-y divide-border border-y border-border" aria-label="Copies of your meetings">
                {[...problem.backups].sort((x, y) => copyDate(y.created_at).getTime() - copyDate(x.created_at).getTime()).map((b) => (
                  <BackupRow
                    key={b.name}
                    backup={b}
                    busy={busy}
                    onRestore={() => void run("Restoring", () => restoreDatabaseCopy(b.name), { kind: "restart", what: "The copy is back in place." })}
                  />
                ))}
              </ul>
            ) : (
              <p className="ui-body mt-1 text-muted-foreground">No copies were found. Your own file is untouched, and you can still open its folder.</p>
            )}
          </section>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {problem.kind === "newer" && (
            <Button variant="primary" onClick={() => openUpdateDialog()}>
              Install the newer NexQ
            </Button>
          )}
          {problem.kind === "upgrade_failed" && (
            <Button variant="primary" onClick={() => void run("Restarting", restartApp, { kind: "idle" })} disabled={busy}>
              Try again
            </Button>
          )}
          {problem.kind === "locked" && (
            <Button variant="primary" onClick={() => void recheck()} disabled={busy}>
              Try again
            </Button>
          )}
          <Button variant="quiet" onClick={openFolder} disabled={busy}>
            Open data folder
          </Button>
          {problem.kind === "unreadable" && (
            <Button variant="ghost" onClick={() => setConfirmEmpty(true)} disabled={busy}>
              Start with an empty database
            </Button>
          )}
        </div>

        <div aria-live="polite" className="min-h-[1.25rem]">
          {phase.kind === "working" && <p className="ui-meta text-muted-foreground">{phase.what}</p>}
          {phase.kind === "still" && (
            <p role="status" className="ui-body text-foreground">
              It is still in use. Close the other program, then try again.
            </p>
          )}
          {phase.kind === "error" && (
            <p role="alert" className="ui-body text-foreground">
              That didn't work: {phase.text}
            </p>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmEmpty}
        title="Start with an empty database?"
        body={`NexQ will make a new, empty one. The damaged file, ${fileName}, is not deleted: it is kept aside under its name, in the same folder, so it can still be recovered.`}
        confirmLabel="Start empty"
        onCancel={() => setConfirmEmpty(false)}
        onConfirm={() => {
          setConfirmEmpty(false);
          void run("Starting fresh", startWithNewDatabase, { kind: "restart", what: "A new, empty database is ready. Your damaged file was kept aside." });
        }}
      />
    </Shell>
  );
}

/** One calm column, left aligned, with room: not a card, not a banner. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="h-full overflow-y-auto" aria-label="Your meetings could not be opened">
      <div className="mx-auto max-w-[34rem] px-6 py-12">{children}</div>
    </main>
  );
}
