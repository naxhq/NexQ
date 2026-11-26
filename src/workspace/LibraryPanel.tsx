import { Suspense, useEffect, useMemo, useState } from "react";
import { Library, Plus } from "lucide-react";
import { ConfirmDialog, IconButton, Menu, Tooltip, type MenuItemSpec } from "../ui";
import { FileUpload } from "../context/FileUpload";
import {
  rebuildFileIndex,
  removeWorkspaceItem,
  updateWorkspaceItem,
} from "../lib/ipc";
import { useConfigStore } from "../stores/configStore";
import { useContextStore } from "../stores/contextStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useRagStore } from "../stores/ragStore";
import { showToast } from "../stores/toastStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import type { SkippedFile, WorkspaceItem } from "../lib/types";
import { skippedByFolder, useWorkspaceIndex } from "./indexStatus";
import { addFolderToWorkspace } from "./addMaterial";
import { ContextMeter } from "./ContextMeter";
import { lazyNamed } from "../lib/lazyNamed";
import { LibraryFooter } from "./LibraryFooter";
import { LibraryRow } from "./LibraryRow";
import { READING, itemTitle, sortItems, type IndexProgress } from "./libraryStatus";
import { MemorySection, TalkingPointsSection } from "./slots";
import { InstructionsBlock } from "./InstructionsBlock";
import { messageOf } from "../lib/plainError";
import { PanelSection } from "./PanelSection";
import { PanelEmpty, PanelList, ShowAllDialog } from "./PanelRow";
import { KIND_LOOK, libraryKindOf } from "./libraryKinds";
import type { NoteTarget } from "./LibraryDialogs";

// Dialogs load when first asked for.
const AddMcpServerDialog = lazyNamed(() => import("../sources/AddMcpServerDialog"), "AddMcpServerDialog");
const SkippedFilesDialog = lazyNamed(() => import("./LibraryDialogs"), "SkippedFilesDialog");
const NoteDialog = lazyNamed(() => import("./LibraryDialogs"), "NoteDialog");
const FromLibraryDialog = lazyNamed(() => import("./LibraryDialogs"), "FromLibraryDialog");


/**
 * The right panel: what this workspace's AI can use. Documents, folders and
 * tools, each with the user's own name and its state in words; instructions;
 * the talking points and memory slots; what an answer would see; and the
 * knowledge base actions. Removing a row removes it from this workspace only.
 */
export function LibraryPanel({ workspaceId, inSheet = false }: { workspaceId: string; inSheet?: boolean }) {
  const detail = useWorkspaceStore((s) => s.details[workspaceId]);
  const revision = useWorkspaceStore((s) => s.revision);
  const loadDetail = useWorkspaceStore((s) => s.loadDetail);
  const unavailable = useWorkspaceStore((s) => s.unavailable);
  const resources = useContextStore((s) => s.resources);
  const loadResources = useContextStore((s) => s.loadResources);
  const refreshIndexStatus = useRagStore((s) => s.refreshIndexStatus);
  const contextStrategy = useConfigStore((s) => s.contextStrategy);
  const { progress, skipped } = useWorkspaceIndex(workspaceId);
  const [skippedOpen, setSkippedOpen] = useState<{ title: string; files: SkippedFile[] } | null>(null);
  const [dialog, setDialog] = useState<"paste" | "library" | "server" | null>(null);
  const [editingNote, setEditingNote] = useState<NoteTarget | null>(null);
  const [confirmLibraryRemove, setConfirmLibraryRemove] = useState<WorkspaceItem | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const focus = useWorkspaceStore((s) => s.focus);
  const nonce = focus?.nonce;
  // A requested row stays marked for a moment, then goes back to normal.
  useEffect(() => {
    if (!nonce) return;
    const t = setTimeout(() => {
      if (useWorkspaceStore.getState().focus?.nonce === nonce) useWorkspaceStore.setState({ focus: null });
    }, 3500);
    return () => clearTimeout(t);
  }, [nonce]);

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

  const { byFolder, other: otherSkipped } = useMemo(() => skippedByFolder(items.filter((i) => i.kind === "folder"), skipped), [items, skipped]);

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

  const openNote = (i: WorkspaceItem) => setEditingNote({ item: { kind: i.kind, ref_id: i.ref_id, label: i.label }, title: itemTitle(i) });

  const rowMenu = (i: WorkspaceItem): MenuItemSpec[] => {
    const menu: MenuItemSpec[] = [];
    if (libraryKindOf(i) === "note") menu.push({ id: "edit", label: "Edit note", onSelect: () => openNote(i) });
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

  /** From the "Show all" dialog a choice that opens another dialog first closes this one: one at a time keeps focus where it belongs. */
  const libraryRow = (i: WorkspaceItem, fromDialog: boolean) => {
    const go = (fn: () => void) => () => {
      if (fromDialog) setShowAll(false);
      fn();
    };
    return (
      <LibraryRow
        key={`${i.kind}:${i.ref_id}`}
        item={i}
        progress={progress}
        menuItems={rowMenu(i).map((m) => (["edit", "delete", "settings"].includes(m.id) ? { ...m, onSelect: go(m.onSelect) } : m))}
        onRename={(label) => void act("rename it", () => updateWorkspaceItem(workspaceId, i.kind, i.ref_id, { label }))}
        onTogglePin={() => void act("change the pin", () => updateWorkspaceItem(workspaceId, i.kind, i.ref_id, { pinned: !i.pinned }))}
        onOptIn={(on) => void act("change searching", () => updateWorkspaceItem(workspaceId, i.kind, i.ref_id, { index_opt_in: on }))}
        onRemove={() => void removeHere(i)}
        highlighted={focus?.kind === i.kind && focus.refId === i.ref_id}
        skipped={i.kind === "folder" ? byFolder.get(i.ref_id)?.length : undefined}
        onShowSkipped={go(() => setSkippedOpen({ title: itemTitle(i), files: byFolder.get(i.ref_id) ?? [] }))}
      />
    );
  };

  const addItems: MenuItemSpec[] = [
    { id: "files", label: "From the library: files, notes, folders, tools", onSelect: () => setDialog("library") },
    { id: "folder", label: "Folder", separatorBefore: true, onSelect: () => void addFolder() },
    { id: "server", label: "Tool (MCP server)", onSelect: () => setDialog("server") },
    { id: "paste", label: "Paste text as a note", onSelect: () => setDialog("paste") },
  ];

  const addMenu = (
    <Menu
      label="Add to this workspace"
      items={addItems}
      align="end"
      renderTrigger={(props) => (
        <Tooltip content="Add to this workspace">
          <IconButton {...props} aria-label="Add to this workspace">
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>
        </Tooltip>
      )}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {unavailable && (
          <p className="ui-meta m-3 rounded-lg bg-accent px-3 py-2 text-foreground" role="note">
            Workspaces aren't available right now, so everything is in General and works as before.
          </p>
        )}
        {problem && (
          <p role="alert" className="ui-meta px-4 pt-2 text-destructive">
            {problem}
          </p>
        )}

        <PanelSection
          id="library"
          icon={Library}
          title={inSheet ? "Files, folders and tools" : "Library"}
          label="Files, folders and tools"
          count={items.length}
          info="Files, folders and tools the AI can use in this workspace's meetings and chats. Removing one here removes it from this workspace only; the library keeps it."
          infoLabel="About the library"
          action={addMenu}
        >
          {items.length === 0 ? (
            <PanelEmpty>Nothing here yet.</PanelEmpty>
          ) : (
            <PanelList label="Library items" noun="library items" count={items.length} onShowAll={() => setShowAll(true)}>
              {items.map((i) => libraryRow(i, false))}
            </PanelList>
          )}
          {otherSkipped.length > 0 && (
            <button
              type="button"
              onClick={() => setSkippedOpen({ title: "your folders", files: otherSkipped })}
              aria-haspopup="dialog"
              className="ui-meta mt-1.5 rounded px-1 text-muted-foreground underline underline-offset-2 outline-none hover:text-foreground ui-focus ui-focus-sm"
            >
              {otherSkipped.length} {otherSkipped.length === 1 ? "file" : "files"} skipped
            </button>
          )}
          <FileUpload workspaceId={workspaceId} className="mt-2" compact />
        </PanelSection>

        <InstructionsBlock workspaceId={workspaceId} instructions={detail?.instructions ?? ""} />

        <Suspense fallback={null}>
          {/* Both draw their own PanelSection, so they look and fold like the others. */}
          <TalkingPointsSection workspaceId={workspaceId} />
          <MemorySection workspaceId={workspaceId} />
        </Suspense>

        <div className="border-t border-border/70 px-4 py-2.5 [&>section]:space-y-1.5">
          <ContextMeter workspaceId={workspaceId} />
        </div>
      </div>

      <LibraryFooter workspaceId={workspaceId} hasFolders={items.some((i) => i.kind === "folder")} progress={progress} />

      <ShowAllDialog
        open={showAll}
        onClose={() => setShowAll(false)}
        title="Library"
        noun="library items"
        items={items}
        keyOf={(i) => `${i.kind}:${i.ref_id}`}
        textOf={(i) => `${itemTitle(i)} ${i.name} ${KIND_LOOK[libraryKindOf(i)].word}`}
        renderRow={(i) => libraryRow(i, true)}
      />
      <Suspense fallback={null}>
        {skippedOpen && <SkippedFilesDialog folder={skippedOpen.title} files={skippedOpen.files} onClose={() => setSkippedOpen(null)} />}
        {dialog === "paste" && <NoteDialog workspaceId={workspaceId} open onClose={() => setDialog(null)} />}
        {editingNote && <NoteDialog workspaceId={workspaceId} open note={editingNote} onClose={() => setEditingNote(null)} />}
        {dialog === "library" && <FromLibraryDialog workspaceId={workspaceId} open onClose={() => setDialog(null)} />}
        {dialog === "server" && (
          // The server joins the library and this workspace together (the add carries the workspace).
          <AddMcpServerDialog onClose={() => setDialog(null)} onAdded={() => void useWorkspaceStore.getState().refresh()} />
        )}
      </Suspense>
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

