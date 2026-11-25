import { Suspense } from "react";
import { Dialog, SlideOver, buttonClass } from "../ui";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { showToast } from "../stores/toastStore";
import { TalkingPointsEditor } from "./slots";
import { hintClass } from "./styles";

/** The folder a path is in (either kind of separator). */
export function folderOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut > 0 ? path.slice(0, cut) : path;
}

/**
 * What a click on a source asks for beyond a meeting or a Library row: a file
 * inside a folder (its path, with "Open folder") and a talking point (its
 * editor). Documents and folders are marked in the Library itself.
 */
export function OpenFocusLayer() {
  const focus = useWorkspaceStore((s) => s.focus);
  const close = () => useWorkspaceStore.setState({ focus: null });

  if (!focus) return null;

  if (focus.kind === "talking_point") {
    return (
      <SlideOver open onClose={close} title="Talking points" description="Write, reorder and import the notes of this workspace.">
        <Suspense fallback={null}>
          {/* The slot resolves to the editor when it exists; `initialId` opens on the note that was cited. */}
          <TalkingPointsEditor workspaceId={focus.workspaceId} {...({ initialId: focus.refId } as object)} />
        </Suspense>
      </SlideOver>
    );
  }

  if (focus.kind === "folder" && focus.subRef) {
    const dir = folderOf(focus.subRef);
    const openFolder = async () => {
      try {
        const { open } = await import("@tauri-apps/plugin-shell");
        await open(dir);
        close();
      } catch (e) {
        showToast(`Couldn't open the folder: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    };
    return (
      <Dialog
        open
        onClose={close}
        title="A file in your folder"
        size="sm"
        footer={
          <>
            <button type="button" className={`${buttonClass.base} ${buttonClass.quiet}`} onClick={close}>
              Close
            </button>
            <button type="button" className={`${buttonClass.base} ${buttonClass.primary}`} onClick={() => void openFolder()}>
              Open folder
            </button>
          </>
        }
      >
        <p className="ui-body break-all text-foreground">{focus.subRef}</p>
        <p className={`${hintClass} mt-2`}>This file is read from the folder in your Library. Opening the folder shows it in your file manager.</p>
      </Dialog>
    );
  }
  return null;
}
