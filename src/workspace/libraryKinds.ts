import { File as FileIcon, Folder, NotebookPen, Plug2, type LucideIcon } from "lucide-react";
import type { WorkspaceItem } from "../lib/types";

/** Something the library holds, as a person tells them apart: a file they added, text they wrote, a folder, a tool. */
export type LibraryKind = "document" | "note" | "folder" | "tool";

/** `detail` of a document written in the app (pasted text); the backend's `file_type`. */
export const NOTE_DETAIL = "note";

/** The kind a person sees. A note is a document the backend knows by its file type. */
export function libraryKindOf(item: Pick<WorkspaceItem, "kind" | "detail">): LibraryKind {
  if (item.kind === "folder") return "folder";
  if (item.kind === "server") return "tool";
  return item.detail === NOTE_DETAIL ? "note" : "document";
}

export interface KindLook {
  word: string;
  Icon: LucideIcon;
  /** The word and the icon. Text tokens, so they hold 4.5:1 in both themes (see `lib/contrast.test.ts`). */
  text: string;
  /** The tile behind the icon: the same colour at a low tint over the panel. */
  tile: string;
}

/*
 * One neutral (a file you added: the common case), then three quiet accents that each mean one thing:
 * violet is text you wrote, the info blue is a place on your disk, green is a live connection.
 * Never a fill stronger than a 12% tint, never the only cue: the word is always beside the icon.
 */
export const KIND_LOOK: Record<LibraryKind, KindLook> = {
  document: { word: "Document", Icon: FileIcon, text: "text-muted-foreground", tile: "bg-muted" },
  note: { word: "Note", Icon: NotebookPen, text: "text-violet-500", tile: "bg-[hsl(var(--violet-text)/0.12)]" },
  folder: { word: "Folder", Icon: Folder, text: "text-info", tile: "bg-[hsl(var(--info-text)/0.12)]" },
  tool: { word: "Tool", Icon: Plug2, text: "text-success", tile: "bg-[hsl(var(--success-text)/0.12)]" },
};
