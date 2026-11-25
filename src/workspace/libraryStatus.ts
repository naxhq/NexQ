import type { WorkspaceItem } from "../lib/types";
import { formatTokens } from "../voiceprint";

/** `detail` of a document whose text is still being read (the context list says `loading`). */
export const READING = "reading";

export type StatusTone = "ok" | "busy" | "warn" | "error" | "quiet";

export interface ItemStatus {
  text: string;
  tone: StatusTone;
}

export interface IndexProgress {
  done: number;
  total: number;
}

/**
 * One line of words for a library row's state. Colour is never the only cue:
 * every state has its own text (indexed, indexing n of m, missing, off, needs
 * your OK).
 */
export function itemStatus(item: WorkspaceItem, progress?: IndexProgress | null): ItemStatus {
  switch (item.status) {
    case "missing":
      return { text: item.detail ? `Missing. ${item.detail}` : "Missing. The file moved or was deleted.", tone: "error" };
    case "off":
      return { text: "Off in Settings", tone: "warn" };
    case "error":
      return { text: item.detail ?? "Couldn't be read", tone: "error" };
    case "indexing":
      if (item.detail === READING) return { text: "Reading its text", tone: "busy" };
      return {
        text: progress && progress.total > 0 ? `Indexing ${progress.done} of ${progress.total}` : "Indexing",
        tone: "busy",
      };
    default:
      break;
  }
  if (item.kind === "folder") {
    if (!item.index_opt_in) return { text: "Needs your OK to search its text", tone: "warn" };
    return { text: "Indexed", tone: "ok" };
  }
  if (item.kind === "server") return { text: "Ready", tone: "ok" };
  return { text: item.tokens ? `Ready, ${formatTokens(item.tokens)} tokens` : "Ready", tone: "ok" };
}

/** Pinned first, then documents, folders, servers; by name inside a group. */
export function sortItems(items: WorkspaceItem[]): WorkspaceItem[] {
  const order = { document: 0, folder: 1, server: 2 } as const;
  const label = (i: WorkspaceItem) => (i.label ?? i.name).toLowerCase();
  return [...items].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || order[a.kind] - order[b.kind] || label(a).localeCompare(label(b)),
  );
}

/** What the user calls it: their label, else the name. */
export function itemTitle(item: Pick<WorkspaceItem, "label" | "name">): string {
  return item.label?.trim() || item.name;
}

/** The one sentence shown next to the folder switch: where its text can go. */
export const FOLDER_OPT_IN_SENTENCE =
  "Searching reads the files in this folder and sends the passages that match a question to the AI provider you use.";
