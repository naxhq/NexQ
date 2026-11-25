import type { WorkspaceItem } from "../lib/types";
import { formatTokens } from "../voiceprint";
import { useContextStore } from "../stores/contextStore";
import { useSourcesStore } from "../stores/sourcesStore";

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A name a person can read. When the backend could only say the id (a folder or
 * tool whose record is gone from the saved sources), the label or path from the
 * sources, or the document's own name, is used instead, and failing that a plain word.
 */
export function readableName(kind: WorkspaceItem["kind"], refId: string, name: string): string {
  if (name && name !== refId && !UUID.test(name)) return name;
  if (kind === "document") {
    const doc = useContextStore.getState().resources.find((r) => r.id === refId);
    if (doc?.name) return doc.name;
  } else {
    const cfg = useSourcesStore.getState().config;
    if (kind === "folder") {
      const f = cfg.notes_folders.find((x) => x.id === refId);
      if (f) return f.label || f.path;
    } else {
      const sv = cfg.mcp_servers.find((x) => x.id === refId);
      if (sv) return sv.label;
    }
  }
  return kind === "folder" ? "A folder that was removed" : kind === "server" ? "A tool that was removed" : "A document that was removed";
}

/** What the user calls it: their label, else the name (never an id). */
export function itemTitle(item: Pick<WorkspaceItem, "label" | "name"> & Partial<Pick<WorkspaceItem, "kind" | "ref_id">>): string {
  return item.label?.trim() || (item.kind && item.ref_id ? readableName(item.kind, item.ref_id, item.name) : item.name);
}

/** The one sentence shown next to the folder switch: where its text can go. */
export const FOLDER_OPT_IN_SENTENCE =
  "Searching reads the files in this folder and sends the passages that match a question to the AI provider you use.";
