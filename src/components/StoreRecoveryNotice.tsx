import { useEffect, useState } from "react";
import { FileWarning, X } from "lucide-react";
import { takeStoreRecovery } from "../lib/ipc";
import type { StoreRecovery } from "../lib/types";

// What each settings file holds, in the user's words.
const FILE_HOLDS: Record<string, string> = {
  "config.json": "your settings",
  "nexq-settings.json": "your update preferences",
  "translation-config.json": "your translation settings",
};

/** The notice's text for the files that could not be read at start. */
export function recoveryText(items: StoreRecovery[]): { title: string; lines: string[] } | null {
  if (items.length === 0) return null;
  const lines = items.map((i) => {
    const what = FILE_HOLDS[i.file] ?? i.file;
    return i.restored
      ? `The file with ${what} was damaged. NexQ put back the last good copy.`
      : `The file with ${what} was damaged and there was no good copy, so they start from the defaults.`;
  });
  const kept = items.flatMap((i) => (i.kept_as ? [i.kept_as] : []));
  if (kept.length) lines.push(`The damaged file is kept in the app data folder as ${kept.join(", ")}.`);
  return { title: items.every((i) => i.restored) ? "Settings restored" : "Some settings were reset", lines };
}

// The backend gives the list out once, so it is asked for once per window.
let found: Promise<StoreRecovery[]> | null = null;
const findings = () => (found ??= takeStoreRecovery().then((f) => (Array.isArray(f) ? f : []), () => []));

/** Stays until closed: it is about the user's own settings, and shown once. */
export function StoreRecoveryNotice() {
  const [items, setItems] = useState<StoreRecovery[]>([]);

  useEffect(() => {
    let gone = false;
    void findings().then((f) => !gone && setItems(f));
    return () => {
      gone = true;
    };
  }, []);

  const text = recoveryText(items);
  if (!text) return null;
  return (
    <div>
      <div
        role="status"
        aria-live="polite"
        className="flex w-full items-start gap-3 rounded-xl border border-border/20 bg-card px-4 py-3 shadow-lg"
      >
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
          onClick={() => {
            found = Promise.resolve([]);
            setItems([]);
          }}
          aria-label="Close"
          className="rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-2"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
