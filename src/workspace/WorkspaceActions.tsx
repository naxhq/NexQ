import { Suspense, createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { MenuItemSpec } from "../ui";
import { showToast } from "../stores/toastStore";
import { GENERAL_ID, useWorkspaceStore, workspaceById } from "../stores/workspaceStore";
import type { WorkspaceDetail, WorkspaceSummary } from "../lib/types";
import { lazyNamed } from "../lib/lazyNamed";

// Dialogs are separate chunks, loaded when first asked for (and mounted only while open).
const WorkspaceDialog = lazyNamed(() => import("./WorkspaceDialog"), "WorkspaceDialog");
const DeleteWorkspaceDialog = lazyNamed(() => import("./DeleteWorkspaceDialog"), "DeleteWorkspaceDialog");
const CloneDialog = lazyNamed(() => import("./CloneDialog"), "CloneDialog");
import { moveInOrder } from "./order";

export interface WorkspaceActions {
  create: () => void;
  edit: (id: string) => void;
  clone: (id: string) => void;
  remove: (id: string) => void;
  togglePin: (id: string) => void;
  archive: (id: string, archived: boolean) => void;
  makeDefault: (id: string) => void;
  move: (id: string, dir: -1 | 1) => void;
  /** The menu every workspace row offers. */
  menuFor: (w: WorkspaceSummary, opts?: { canMove?: boolean }) => MenuItemSpec[];
}

const Ctx = createContext<WorkspaceActions | null>(null);

export function useWorkspaceActions(): WorkspaceActions {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWorkspaceActions needs WorkspaceActionsProvider");
  return v;
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fail = (what: string, e: unknown) => showToast(`Couldn't ${what}: ${messageOf(e)}`, "error");

/** Owns the create/settings, clone and delete dialogs once, for the rail, the switcher and the All workspaces page. */
export function WorkspaceActionsProvider({ children }: { children: ReactNode }) {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  const [detail, setDetail] = useState<WorkspaceDetail | null>(null);
  const [cloning, setCloning] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  // The workspace the dialog is about right now: a late answer for another one never fills it.
  const editingId = useRef<string | null>(null);

  const edit = useCallback((id: string) => {
    const store = useWorkspaceStore.getState();
    editingId.current = id;
    const cached = store.details[id];
    setDetail(cached && cached.id === id ? cached : null);
    setEditing({ id });
    // The instructions come with the detail: the form fills in when it arrives.
    void store.loadDetail(id).then((d) => {
      if (d && d.id === id && editingId.current === id) setDetail(d);
    });
  }, []);

  const actions = useMemo<WorkspaceActions>(() => {
    const act: WorkspaceActions = {
      create: () => {
        editingId.current = null;
        setDetail(null);
        setEditing({ id: null });
      },
      edit,
      clone: (id) => setCloning(id),
      remove: (id) => setDeleting(id),
      togglePin: (id) => {
        const w = workspaceById(useWorkspaceStore.getState().workspaces, id);
        if (w) useWorkspaceStore.getState().update(id, { pinned: !w.pinned }).catch((e) => fail("change the pin", e));
      },
      archive: (id, archived) => {
        useWorkspaceStore.getState().archive(id, archived).catch((e) => fail(archived ? "archive it" : "bring it back", e));
      },
      makeDefault: (id) => {
        useWorkspaceStore.getState().makeDefault(id).catch((e) => fail("change the default", e));
      },
      move: (id, dir) => {
        const live = useWorkspaceStore.getState().workspaces.filter((w) => !w.archived);
        const ordered = [...live].sort((a, b) => a.sort - b.sort).map((w) => w.id);
        useWorkspaceStore.getState().reorder(moveInOrder(ordered, id, dir)).catch((e) => fail("reorder", e));
      },
      menuFor: (w, opts) => {
        const items: MenuItemSpec[] = [
          { id: "edit", label: "Settings", onSelect: () => act.edit(w.id) },
          { id: "pin", label: w.pinned ? "Unpin" : "Pin to the top", onSelect: () => act.togglePin(w.id) },
          { id: "default", label: "Make default", checked: w.is_default, disabled: w.is_default || w.archived, onSelect: () => act.makeDefault(w.id) },
          { id: "clone", label: "Clone", onSelect: () => act.clone(w.id) },
        ];
        if (opts?.canMove) {
          items.push(
            { id: "up", label: "Move up", separatorBefore: true, onSelect: () => act.move(w.id, -1) },
            { id: "down", label: "Move down", onSelect: () => act.move(w.id, 1) },
          );
        }
        if (w.id !== GENERAL_ID) {
          items.push(
            { id: "archive", label: w.archived ? "Bring back" : "Archive", separatorBefore: true, disabled: w.is_default && !w.archived, onSelect: () => act.archive(w.id, !w.archived) },
            { id: "delete", label: "Delete", danger: true, disabled: w.is_default, onSelect: () => act.remove(w.id) },
          );
        }
        return items;
      },
    };
    return act;
  }, [edit]);

  const editingWorkspace = editing?.id ? workspaces.find((w) => w.id === editing.id) ?? null : null;

  return (
    <Ctx.Provider value={actions}>
      {children}
      <Suspense fallback={null}>
      {editing !== null && (
      <WorkspaceDialog
        open
        workspace={editingWorkspace}
        detail={detail}
        onClose={(saved) => {
          const wasNew = editing?.id == null;
          editingId.current = null;
          setEditing(null);
          // A new workspace opens right away: that is where the person wants to be.
          if (saved && wasNew) useWorkspaceStore.getState().openWorkspace(saved.id);
        }}
      />
      )}
      {cloning && (
        <CloneDialog
          workspace={workspaces.find((w) => w.id === cloning) ?? null}
          onClose={(created) => {
            setCloning(null);
            if (created) useWorkspaceStore.getState().openWorkspace(created.id);
          }}
        />
      )}
      {deleting && <DeleteWorkspaceDialog workspace={workspaces.find((w) => w.id === deleting) ?? null} onClose={() => setDeleting(null)} />}
      </Suspense>
    </Ctx.Provider>
  );
}
