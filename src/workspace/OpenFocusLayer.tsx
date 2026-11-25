import { Suspense, useEffect, useState } from "react";
import { Dialog, SlideOver, Button } from "../ui";
import { getLibraryFilePath, revealLibraryFile } from "../lib/ipc";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { TalkingPointsEditor } from "./slots";
import { hintClass } from "./styles";
import { messageOf } from "../lib/plainError";


/** A file inside a Library folder: its path as the backend checked it, and a way to show it. */
function FolderFileDialog({ folderId, subPath, onClose }: { folderId: string; subPath: string; onClose: () => void }) {
  const [path, setPath] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getLibraryFilePath(folderId, subPath)
      .then((p) => live && setPath(p))
      .catch((e) => live && setRefused(messageOf(e)));
    return () => {
      live = false;
    };
  }, [folderId, subPath]);

  const reveal = async () => {
    setRevealError(null);
    try {
      await revealLibraryFile(folderId, subPath);
      onClose();
    } catch (e) {
      setRevealError(messageOf(e));
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="A file in your folder"
      size="sm"
      footer={
        <>
          <Button  onClick={onClose}>
            Close
          </Button>
          <Button variant="primary"  onClick={() => void reveal()} disabled={!path}>
            Open folder
          </Button>
        </>
      }
    >
      {refused ? (
        <p role="alert" className="ui-body text-foreground">
          This file can't be shown: {refused}
        </p>
      ) : (
        <>
          <p className="ui-body break-all text-foreground">{path ?? "Looking for the file"}</p>
          <p className={`${hintClass} mt-2`}>This file is read from the folder in your Library. Opening the folder shows it in your file manager.</p>
        </>
      )}
      {revealError && (
        <p role="alert" className="ui-body mt-2 text-destructive">
          Couldn't open the folder: {revealError}
        </p>
      )}
    </Dialog>
  );
}

/**
 * What a click on a source asks for beyond a meeting or a Library row: a file
 * inside a folder (the checked path, with "Open folder") and a talking point
 * (its editor). Documents and folders are marked in the Library itself.
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
    return <FolderFileDialog key={focus.nonce} folderId={focus.refId} subPath={focus.subRef} onClose={close} />;
  }
  return null;
}
