/**
 * The talking points of a workspace in a dialog of their own. One title row says where you are (the
 * workspace, then "Talking points"), carries the save state and a Close button; Escape closes too,
 * focus stays inside and goes back to what opened it. Found by file name by `src/workspace/slots.ts`
 * (OpenFocusLayer opens it for a cited note); the Library's talking points section uses it directly.
 */
import { useId, useRef, useState } from "react";
import { ChevronRight, ListChecks, X } from "lucide-react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { IconButton, Kbd, Portal, Tooltip, useFocusTrap } from "../ui";
import { TalkingPointsEditor } from "./TalkingPointsEditor";
import { SaveBadge } from "./NoteEditorPane";

export interface TalkingPointsDialogProps {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
  /** Open on this note instead of the first. */
  initialId?: string | null;
}

export function TalkingPointsDialog({ workspaceId, open, onClose, initialId = null }: TalkingPointsDialogProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const titleId = `dialog-title-${useId().replace(/:/g, "")}`;
  const workspaceName = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.name ?? "");
  const [activeId, setActiveId] = useState<string | null>(null);
  // the box itself takes focus first: the dialog is announced by its title, and Tab walks in from the top
  useFocusTrap(boxRef, open, boxRef);
  if (!open) return null;

  return (
    <Portal>
      <div
        className="ui-fade-in fixed inset-0 z-50 flex items-center justify-center bg-background/70 sm:p-6"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div
          ref={boxRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              onClose();
            }
          }}
          className="ui-pop-in flex h-full w-full max-w-[64rem] flex-col border border-border bg-card text-card-foreground shadow-[0_24px_64px_-24px_rgba(0,0,0,0.65)] outline-none focus-visible:outline-none sm:h-[min(46rem,100%)] sm:rounded-2xl"
        >
          <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4 sm:px-5">
            <span aria-hidden className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary-text">
              <ListChecks className="h-4 w-4" />
            </span>
            <div className="flex min-w-0 items-center gap-1.5">
              {workspaceName && (
                <>
                  <span className="ui-body max-w-[9rem] truncate text-muted-foreground sm:max-w-[18rem]">{workspaceName}</span>
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                </>
              )}
              <h2 id={titleId} className="ui-dialog-title shrink-0">
                Talking points
              </h2>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-3">
              <SaveBadge noteId={activeId} />
              <Tooltip
                content={
                  <span className="inline-flex items-center gap-2">
                    Close <Kbd>Esc</Kbd>
                  </span>
                }
              >
                <IconButton size="md" aria-label="Close" onClick={onClose}>
                  <X className="h-4 w-4" aria-hidden />
                </IconButton>
              </Tooltip>
            </div>
          </header>
          <div className="flex min-h-0 flex-1 flex-col p-3 sm:p-4">
            <TalkingPointsEditor workspaceId={workspaceId} initialId={initialId} onSelect={setActiveId} />
          </div>
        </div>
      </div>
    </Portal>
  );
}
