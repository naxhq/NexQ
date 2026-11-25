import { Suspense, useEffect, useMemo, useState } from "react";
import { ClipboardPaste, FolderPlus, Library as LibraryIcon, Plus, Plug2 } from "lucide-react";
import { ConfirmDialog, Menu, buttonClass, type MenuItemSpec } from "../ui";
import { AddMcpServerDialog } from "../sources/AddMcpServerDialog";
import { FileUpload } from "../context/FileUpload";
import {
  getIndexStatus,
  rebuildFileIndex,
  removeWorkspaceItem,
  updateWorkspaceItem,
} from "../lib/ipc";
import { onWorkspaceIndexProgress } from "../lib/events";
import { useConfigStore } from "../stores/configStore";
import { useContextStore } from "../stores/contextStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useRagStore } from "../stores/ragStore";
import { showToast } from "../stores/toastStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import type { WorkspaceItem } from "../lib/types";
import { addFolderToWorkspace } from "./addMaterial";
import { ContextMeter } from "./ContextMeter";
import { FromLibraryDialog, PasteTextDialog } from "./LibraryDialogs";
import { LibraryFooter } from "./LibraryFooter";
import { LibraryRow } from "./LibraryRow";
import { READING, itemTitle, sortItems, type IndexProgress } from "./libraryStatus";
import { MemorySection, TalkingPointsSection } from "./slots";
import { InstructionsBlock } from "./InstructionsBlock";

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Index progress of one workspace, from `workspace_index_progress`. */
function useIndexProgress(workspaceId: string): IndexProgress | null {
  const [progress, setProgress] = useState<IndexProgress | null>(null);
  useEffect(() => {
    setProgress(null);
    let stop: (() => void) | undefined;
    let gone = false;
    getIndexStatus(workspaceId)
      .then((s) => !gone && s.state === "indexing" && setProgress({ done: s.done, total: s.total }))
      .catch(() => {});
    onWorkspaceIndexProgress((e) => {
      if (e.workspace_id !== workspaceId) return;
      setProgress(e.done >= e.total ? null : { done: e.done, total: e.total });
    })
      .then((fn) => (gone ? fn() : (stop = fn)))
      .catch(() => {});
    return () => {
      gone = true;
      stop?.();
    };
  }, [workspaceId]);
  return progress;
}

/**
 * The right panel: what this workspace's AI can use. Documents, folders and
 * tools, each with the user's own name and its state in words; instructions;
 * the talking points and memory slots; what an answer would see; and the
 * knowledge base actions. Removing a row removes it from this workspace only.
 */
export function LibraryPanel({ workspaceId }: { workspaceId: string }) {
  const detail = useWorkspaceStore((s) => s.details[workspaceId]);
  const revision = useWorkspaceStore((s) => s.revision);
  const loadDetail = useWorkspaceStore((s) => s.loadDetail);
  const unavailable = useWorkspaceStore((s) => s.unavailable);
  const resources = useContextStore((s) => s.resources);
  const loadResources = useContextStore((s) => s.loadResources);
  const refreshIndexStatus = useRagStore((s) => s.refreshIndexStatus);
  const contextStrategy = useConfigStore((s) => s.contextStrategy);
  const progress = useIndexProgress(workspaceId);
  const [dialog, setDialog] = useState<"paste" | "library" | "server" | null>(null);
  const [confirmLibraryRemove, setConfirmLibraryRemove] = useState<WorkspaceItem | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    void loadDetail(workspaceId);
  }, [workspaceId, revision, loadDetail]);
  useEffect(() => {
    void loadResources();
    void refreshIndexStatus();
  }, [loadResources, refreshIndexStatus, revision]);

  // A document the context list says is gone or still being read overrides what the workspace row says.
  const items = useMemo(() => {
    const byId = new Map(resources.map((r) => [r.id, r]));
    return sortItems(
      (detail?.items ?? []).map((i): WorkspaceItem => {
        const r = i.kind === "document" ? byId.get(i.ref_id) : undefined;
        if (r?.status === "missing") return { ...i, status: "missing" };
        if (r?.status === "loading" && i.status === "ready") return { ...i, status: "indexing", detail: READING };
        return i;
      }),
    );
  }, [detail, resources]);

  const act = (what: string, run: () => Promise<unknown>) =>
    run()
      .then(() => useWorkspaceStore.getState().refresh())
      .catch((e) => showToast(`Couldn't ${what}: ${messageOf(e)}`, "error"));

  const addFolder = async () => {
    setProblem(null);
    const r = await addFolderToWorkspace(workspaceId);
    if (r.error) setProblem(r.error);
  };

  const removeHere = (i: WorkspaceItem) => act("remove it", () => removeWorkspaceItem(workspaceId, i.kind, i.ref_id));

  const rowMenu = (i: WorkspaceItem): MenuItemSpec[] => {
    const menu: MenuItemSpec[] = [];
    if (i.kind === "document" && contextStrategy === "local_rag") {
      menu.push({
        id: "reindex",
        label: "Index again",
        onSelect: () => {
          rebuildFileIndex(i.ref_id)
            .then(() => {
              showToast(`Indexed ${itemTitle(i)} again`, "success");
              return useRagStore.getState().refreshIndexStatus();
            })
            .catch(() => showToast("Couldn't index the file again. Try removing and adding it.", "error"));
        },
      });
    }
    menu.push({ id: "remove", label: "Remove from this workspace", onSelect: () => void removeHere(i) });
    if (i.kind === "document") {
      menu.push({ id: "delete", label: "Remove from library", danger: true, separatorBefore: true, onSelect: () => setConfirmLibraryRemove(i) });
    } else {
      menu.push({
        id: "settings",
        label: "Manage in Settings",
        separatorBefore: true,
        onSelect: () => useMeetingStore.getState().openSettings("personal_sources"),
      });
    }
    return menu;
  };

  const addItems: MenuItemSpec[] = [
    { id: "files", label: "Files, folders and tools in the library", onSelect: () => setDialog("library") },
    { id: "folder", label: "Folder", separatorBefore: true, onSelect: () => void addFolder() },
    { id: "server", label: "Tool (MCP server)", onSelect: () => setDialog("server") },
    { id: "paste", label: "Paste text", onSelect: () => setDialog("paste") },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between px-4 pb-1 pt-3">
        <h2 className="ui-section flex items-center gap-1.5 text-foreground">
          <LibraryIcon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          Library
          <span className="ui-meta font-normal tabular-nums text-muted-foreground">{items.length || ""}</span>
        </h2>
        <Menu
          label="Add to this workspace"
          items={addItems}
          align="end"
          renderTrigger={(props) => (
            <button type="button" {...props} className={`${buttonClass.base} ${buttonClass.quiet} gap-1 px-2`}>
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              Add
            </button>
          )}
        />
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 pb-4 pt-2">
        {unavailable && (
          <p className="ui-meta rounded-lg bg-accent px-3 py-2 text-foreground" role="note">
            Workspaces aren't available right now, so everything is in General and works as before.
          </p>
        )}
        {problem && (
          <p role="alert" className="ui-meta px-2 text-destructive">
            {problem}
          </p>
        )}

        <section aria-label="Files, folders and tools">
          {items.length === 0 ? (
            <div className="px-2 py-3">
              <p className="ui-section text-foreground">Nothing here yet</p>
              <p className="ui-body mt-1 text-muted-foreground">Add files, a folder or a tool. The AI uses them in this workspace's meetings and chats.</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" onClick={() => void addFolder()} className={`${buttonClass.base} ${buttonClass.quiet} gap-1.5 border border-border`}>
                  <FolderPlus className="h-3.5 w-3.5" aria-hidden="true" />
                  Add a folder
                </button>
                <button type="button" onClick={() => setDialog("server")} className={`${buttonClass.base} ${buttonClass.quiet} gap-1.5 border border-border`}>
                  <Plug2 className="h-3.5 w-3.5" aria-hidden="true" />
                  Add a tool
                </button>
                <button type="button" onClick={() => setDialog("paste")} className={`${buttonClass.base} ${buttonClass.quiet} gap-1.5 border border-border`}>
                  <ClipboardPaste className="h-3.5 w-3.5" aria-hidden="true" />
                  Paste text
                </button>
              </div>
            </div>
          ) : (
            <ul aria-label="Library items" className="space-y-0.5">
              {items.map((i) => (
                <LibraryRow
                  key={`${i.kind}:${i.ref_id}`}
                  item={i}
                  progress={progress}
                  menuItems={rowMenu(i)}
                  onRename={(label) => void act("rename it", () => updateWorkspaceItem(workspaceId, i.kind, i.ref_id, { label }))}
                  onTogglePin={() => void act("change the pin", () => updateWorkspaceItem(workspaceId, i.kind, i.ref_id, { pinned: !i.pinned }))}
                  onOptIn={(on) => void act("change searching", () => updateWorkspaceItem(workspaceId, i.kind, i.ref_id, { index_opt_in: on }))}
                  onRemove={() => void removeHere(i)}
                />
              ))}
            </ul>
          )}
          <FileUpload workspaceId={workspaceId} className="mt-2" />
        </section>

        <InstructionsBlock workspaceId={workspaceId} instructions={detail?.instructions ?? ""} />

        <Suspense fallback={null}>
          <TalkingPointsSection workspaceId={workspaceId} />
          <MemorySection workspaceId={workspaceId} />
        </Suspense>

        <ContextMeter workspaceId={workspaceId} />
      </div>

      <LibraryFooter workspaceId={workspaceId} hasFolders={items.some((i) => i.kind === "folder")} />

      <PasteTextDialog workspaceId={workspaceId} open={dialog === "paste"} onClose={() => setDialog(null)} />
      <FromLibraryDialog workspaceId={workspaceId} open={dialog === "library"} onClose={() => setDialog(null)} />
      {dialog === "server" && (
        // The server joins the library and this workspace together (the add carries the workspace).
        <AddMcpServerDialog onClose={() => setDialog(null)} onAdded={() => void useWorkspaceStore.getState().refresh()} />
      )}
      <ConfirmDialog
        open={confirmLibraryRemove !== null}
        tone="danger"
        title={`Remove ${confirmLibraryRemove ? itemTitle(confirmLibraryRemove) : ""} from the library?`}
        body="It leaves every workspace that uses it, and its index is removed. The file on your disk is not touched."
        confirmLabel="Remove from library"
        onConfirm={() => {
          const i = confirmLibraryRemove;
          setConfirmLibraryRemove(null);
          if (!i) return;
          void act("remove it", async () => {
            await useContextStore.getState().removeFile(i.ref_id);
            if (contextStrategy === "local_rag") await useRagStore.getState().autoRemoveFileIndex(i.ref_id);
          });
        }}
        onCancel={() => setConfirmLibraryRemove(null)}
      />
    </div>
  );
}

