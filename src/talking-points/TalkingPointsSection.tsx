/**
 * The Library's talking points block: a compact list with each note's AI-context
 * state, "New note", and the full editor in a wide sheet. Found by file name by
 * `src/workspace/slots.ts`; the full editor is the same component the slot also finds.
 */
import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { useTalkingPointsStore } from "../stores/talkingPointsStore";
import { SlideOver } from "../ui";
import { cn } from "../lib/utils";
import { TalkingPointsEditor } from "./TalkingPointsEditor";
import "./talkingPoints.css";

export function TalkingPointsSection({ workspaceId }: { workspaceId: string }) {
  const notes = useTalkingPointsStore((s) => s.byWorkspace[workspaceId]);
  const loadError = useTalkingPointsStore((s) => s.loadError[workspaceId]);
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    void useTalkingPointsStore.getState().load(workspaceId);
  }, [workspaceId]);

  const openEditor = (e?: React.MouseEvent<HTMLElement>) => {
    opener.current = e?.currentTarget ?? null;
    setOpen(true);
  };
  const create = async (e: React.MouseEvent<HTMLElement>) => {
    opener.current = e.currentTarget;
    const p = await useTalkingPointsStore.getState().create(workspaceId, { title: "Untitled note" });
    if (p) setOpen(true);
  };
  const list = notes ?? [];

  return (
    <section aria-label="Talking points" className="mt-5">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <h2 className="ui-section text-foreground">Talking points</h2>
        <button
          type="button"
          onClick={(e) => void create(e)}
          className="ui-meta inline-flex h-7 items-center gap-1 rounded-lg px-2 font-medium text-foreground outline-none transition-colors hover:bg-accent ui-focus ui-r-lg"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          New note
        </button>
      </div>
      {loadError && !notes && (
        <p role="alert" className="ui-meta text-destructive">
          Talking points did not load: {loadError}
        </p>
      )}
      {notes && list.length === 0 && (
        <p className="ui-meta text-muted-foreground">Notes you want in front of you during a call, and for answers to draw on.</p>
      )}
      {list.length > 0 && (
        <ul role="list" className="space-y-0.5">
          {list.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                onClick={openEditor}
                className="flex w-full items-baseline justify-between gap-3 rounded-lg px-2 py-1.5 text-left outline-none transition-colors hover:bg-accent ui-focus ui-r-lg"
              >
                <span className="ui-body min-w-0 truncate">{n.title}</span>
                <span className={cn("ui-meta shrink-0", n.in_context ? "text-foreground" : "text-muted-foreground")}>
                  {n.in_context ? "AI context" : "Not AI context"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <SlideOver open={open} onClose={() => setOpen(false)} title="Talking points" description="Write, reorder and import the notes of this workspace.">
        <TalkingPointsEditor workspaceId={workspaceId} className="min-h-[60vh]" />
      </SlideOver>
    </section>
  );
}

export default TalkingPointsSection;
