import { useEffect, useState } from "react";
import { Folder, X } from "lucide-react";
import type { NotesFolder, NotesFolderInfo } from "../lib/types";
import { SourceSwitch } from "./SourceSwitch";

interface NotesFolderCardProps {
  folder: NotesFolder;
  /** `undefined` until the folder has been looked at. */
  info: NotesFolderInfo | undefined;
  onToggle: (enabled: boolean) => void;
  onRename: (label: string) => void;
  onRemove: () => void;
}

/** What a folder card says about what is inside: a count, or why it can't be used. */
function folderLine(info: NotesFolderInfo | undefined): { text: string; bad: boolean } {
  if (!info) return { text: "Looking…", bad: false };
  if (!info.exists) return { text: "Folder not found", bad: true };
  if (info.problem) return { text: info.problem, bad: true };
  const n = info.md_count;
  const count = `${n}${info.truncated ? "+" : ""}`;
  return { text: `${count} ${n === 1 && !info.truncated ? "note" : "notes"}`, bad: false };
}

export function NotesFolderCard({ folder, info, onToggle, onRename, onRemove }: NotesFolderCardProps) {
  const [label, setLabel] = useState(folder.label);
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => setLabel(folder.label), [folder.label]);

  const line = folderLine(info);
  // A folder that can't be used can be switched off but not on.
  const cantEnable = !!info && (!info.exists || !!info.problem);
  const commitLabel = () => {
    const next = label.trim();
    if (!next) setLabel(folder.label);
    else if (next !== folder.label) onRename(next);
  };

  return (
    <div
      className={`group flex items-start gap-3 rounded-xl border bg-secondary/20 p-3 transition-colors hover:bg-secondary/40 ${
        line.bad ? "border-destructive/30" : "border-border/40"
      }`}
    >
      <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-highlight/10">
        <Folder className="h-4 w-4 text-highlight" />
      </div>
      <div className="min-w-0 flex-1">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={commitLabel}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") setLabel(folder.label);
          }}
          aria-label={`Name of ${folder.path}`}
          className="w-full truncate rounded bg-transparent text-sm font-medium text-foreground outline-none focus-visible:ring-1 focus-visible:ring-primary/40"
        />
        <div className="truncate text-xs text-muted-foreground" title={folder.path}>
          {folder.path}
        </div>
        <div className={`mt-1 text-xs ${line.bad ? "text-destructive" : "text-muted-foreground/80"}`}>{line.text}</div>
      </div>
      <div className="flex items-center gap-2.5 pt-0.5">
        <SourceSwitch
          tone="highlight"
          checked={folder.enabled}
          disabled={!folder.enabled && cantEnable}
          onChange={onToggle}
          label={`Use ${folder.label}`}
        />
        <button
          type="button"
          onClick={() => {
            if (confirmRemove) onRemove();
            else {
              setConfirmRemove(true);
              setTimeout(() => setConfirmRemove(false), 3000);
            }
          }}
          aria-label={confirmRemove ? `Confirm removing ${folder.label}` : `Remove ${folder.label}`}
          className={`flex h-6 cursor-pointer items-center justify-center rounded-md px-1 text-xs transition-colors ${
            confirmRemove
              ? "bg-destructive/15 text-destructive"
              : "text-muted-foreground/60 hover:bg-accent/40 hover:text-foreground"
          }`}
        >
          {confirmRemove ? "Remove?" : <X className="h-3.5 w-3.5" />}
        </button>
      </div>
    </div>
  );
}
