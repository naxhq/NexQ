import { addWorkspaceItem, addWorkspaceText, rebuildFileIndex, updateWorkspaceItem, updateWorkspaceNote } from "../lib/ipc";
import type { WorkspaceItem } from "../lib/types";
import { useConfigStore } from "../stores/configStore";
import { useContextStore } from "../stores/contextStore";
import { useRagStore } from "../stores/ragStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { messageOf } from "../lib/plainError";

export const SUPPORTED_EXTENSIONS = ["pdf", "txt", "md", "docx"] as const;

export function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Splits dropped or picked paths into the ones the app can read and the rest. */
export function supportedPaths(paths: string[]): { ok: string[]; skipped: string[] } {
  const ok: string[] = [];
  const skipped: string[] = [];
  for (const p of paths) {
    ((SUPPORTED_EXTENSIONS as readonly string[]).includes(extensionOf(p)) ? ok : skipped).push(p);
  }
  return { ok, skipped };
}

export interface AddResult {
  added: number;
  failed: Array<{ path: string; error: string }>;
}


/**
 * Adds documents to the library and to a workspace together (a workspace never
 * gets a file without the library having it, and a new file belongs to the
 * workspace it was added in). Indexes it when the knowledge base is on.
 */
export async function addFilesToWorkspace(paths: string[], workspaceId: string): Promise<AddResult> {
  const result: AddResult = { added: 0, failed: [] };
  for (const path of paths) {
    try {
      // The backend files it in the workspace together with the library entry.
      const resource = await useContextStore.getState().loadFile(path, workspaceId);
      result.added += 1;
      // Fire and forget: indexing never blocks the screen.
      if (useConfigStore.getState().contextStrategy === "local_rag") {
        void useRagStore.getState().autoIndexFile(resource.id);
      }
    } catch (e) {
      result.failed.push({ path, error: messageOf(e) });
    }
  }
  if (result.added > 0) await useWorkspaceStore.getState().refresh();
  return result;
}

/** The most characters a note's title keeps (the backend cuts at the same length). */
export const NOTE_TITLE_MAX = 80;

/**
 * A title for text that has none: its first line that says something, without the Markdown
 * markers in front of it, on one line. The same rule the backend applies (`note_title`).
 */
export function deriveNoteTitle(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const first = line.trim().replace(/^[#>\-*+\s]+/, "").replace(/\s+/g, " ").trim();
    if (first) return [...first].slice(0, NOTE_TITLE_MAX).join("").trim();
  }
  return "";
}

/** Pasted text becomes a note in the workspace, named by its title (its first line when none is given). */
export async function addPastedText(workspaceId: string, title: string, text: string): Promise<string> {
  const id = await addWorkspaceText(workspaceId, title.trim() || deriveNoteTitle(text) || "Note", text);
  await useWorkspaceStore.getState().refresh();
  return id;
}

/**
 * Saves an edited note. The library's own name changes with it, and a label the person had put
 * on it in this workspace would hide the new title, so it goes (the title is what they just chose).
 * The text is indexed again when the knowledge base is on.
 */
export async function saveNoteEdit(workspaceId: string, item: Pick<WorkspaceItem, "kind" | "ref_id" | "label">, title: string, text: string): Promise<void> {
  const name = title.trim() || deriveNoteTitle(text) || "Note";
  await updateWorkspaceNote(item.ref_id, name, text);
  if (item.label) await updateWorkspaceItem(workspaceId, item.kind, item.ref_id, { label: null });
  await useContextStore.getState().loadResources();
  if (useConfigStore.getState().contextStrategy === "local_rag") {
    void rebuildFileIndex(item.ref_id)
      .then(() => useRagStore.getState().refreshIndexStatus())
      .catch(() => {});
  }
  await useWorkspaceStore.getState().refresh();
}

export interface FolderAddResult {
  /** The library folder now in the workspace (new, or already in the library). */
  id?: string;
  cancelled?: boolean;
  error?: string;
}

/**
 * Pick a folder and add it to the library (when it is new) and the workspace.
 * Its text is not searched until the person allows it per folder.
 */
export async function addFolderToWorkspace(workspaceId: string): Promise<FolderAddResult> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const { inspectNotesFolder } = await import("../lib/ipc");
  const { useSourcesStore } = await import("../stores/sourcesStore");
  const { addNotesFolder, errorText, folderNameOf } = await import("../sources/sourcesActions");
  let picked: string | string[] | null;
  try {
    picked = await open({ directory: true, title: "Choose a folder" });
  } catch (e) {
    return { error: errorText(e) };
  }
  if (!picked || typeof picked !== "string") return { cancelled: true };
  try {
    const known = useSourcesStore.getState().config.notes_folders.find((f) => f.path.toLowerCase() === picked.toLowerCase());
    if (known) {
      await addWorkspaceItem(workspaceId, "folder", known.id, known.label);
      await useWorkspaceStore.getState().refresh();
      return { id: known.id };
    }
    const info = await inspectNotesFolder(picked);
    if (!info.exists) return { error: "Folder not found" };
    if (info.problem) return { error: info.problem };
    const id = crypto.randomUUID();
    const label = folderNameOf(picked);
    await addNotesFolder({ id, label, path: picked, enabled: true }, workspaceId);
    await useWorkspaceStore.getState().refresh();
    return { id };
  } catch (e) {
    return { error: errorText(e) };
  }
}
