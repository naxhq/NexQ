import { useEffect, useState } from "react";
import { getIndexStatus } from "../lib/ipc";
import { onWorkspaceIndexProgress } from "../lib/events";
import type { FolderIndexInfo, SkippedFile, WorkspaceItem } from "../lib/types";
import { JUST_NOW_MS, type IndexProgress } from "./libraryStatus";

export interface WorkspaceIndexView {
  /** Set while the index is still being built ("n of m"); null when it is done or idle. */
  progress: IndexProgress | null;
  /** Files the index left out, with a reason each. */
  skipped: SkippedFile[];
  /** Each folder's indexed files and when it was last updated, by folder id. */
  folders: Map<string, FolderIndexInfo>;
}


/**
 * The index of one workspace: how far it is (live, from `workspace_index_progress`) and which files it
 * skipped. The skipped list is read again whenever a run finishes.
 */
export function useWorkspaceIndex(workspaceId: string): WorkspaceIndexView {
  const [view, setView] = useState<WorkspaceIndexView>({ progress: null, skipped: [], folders: new Map() });
  useEffect(() => {
    setView({ progress: null, skipped: [], folders: new Map() });
    let stop: (() => void) | undefined;
    let gone = false;
    let late: ReturnType<typeof setTimeout> | undefined;
    const read = () =>
      getIndexStatus(workspaceId)
        .then((s) => {
          if (gone || !s) return;
          const running = s.state === "indexing" && s.total > 0;
          const folders = new Map((Array.isArray(s.folders) ? s.folders : []).map((f) => [f.folder_id, f] as const));
          setView({ progress: running ? { done: s.done, total: s.total } : null, skipped: Array.isArray(s.skipped) ? s.skipped : [], folders });
          // "Updated just now" ends by itself: draw the row again once it is no longer true.
          if ([...folders.values()].some((f) => f.indexed_at && Date.now() - f.indexed_at < JUST_NOW_MS)) {
            clearTimeout(late);
            late = setTimeout(() => !gone && setView((v) => ({ ...v })), JUST_NOW_MS + 1_000);
          }
        })
        .catch(() => {});
    void read();
    onWorkspaceIndexProgress((e) => {
      if (e.workspace_id !== workspaceId) return;
      const finished = e.done >= e.total;
      setView((v) => ({ ...v, progress: finished ? null : { done: e.done, total: e.total } }));
      if (finished) void read();
    })
      .then((fn) => (gone ? fn() : (stop = fn)))
      .catch(() => {});
    return () => {
      gone = true;
      clearTimeout(late);
      stop?.();
    };
  }, [workspaceId]);
  return view;
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** The skipped files that sit inside a folder of the Library, by path; the rest go under `other`. */
export function skippedByFolder(folders: Array<Pick<WorkspaceItem, "ref_id" | "name">>, skipped: SkippedFile[]): { byFolder: Map<string, SkippedFile[]>; other: SkippedFile[] } {
  const byFolder = new Map<string, SkippedFile[]>();
  const other: SkippedFile[] = [];
  const roots = folders.map((f) => ({ id: f.ref_id, root: norm(f.name) }));
  for (const file of skipped) {
    // The backend's own folder id is the truth; the path is only a fallback for an older answer.
    if (file.folder_id && roots.some((r) => r.id === file.folder_id)) {
      byFolder.set(file.folder_id, [...(byFolder.get(file.folder_id) ?? []), file]);
      continue;
    }
    if (file.folder_id) {
      other.push(file);
      continue;
    }
    const p = norm(file.path);
    const hit = roots.filter((r) => r.root && p.startsWith(r.root + "/")).sort((a, b) => b.root.length - a.root.length)[0];
    if (hit) byFolder.set(hit.id, [...(byFolder.get(hit.id) ?? []), file]);
    else other.push(file);
  }
  return { byFolder, other };
}

/** "Still indexing 312 of 540": the words shown next to anything that searches while the index is being built. */
export function indexingWords(progress: IndexProgress | null): string | null {
  if (!progress || progress.total <= 0) return null;
  return `Still indexing ${progress.done} of ${progress.total}`;
}
