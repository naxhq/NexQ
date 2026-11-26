/**
 * The Library's talking points block: the panel's shared section and rows (a note's name, its size and whether
 * the AI draws on it), "New note", and the full editor in a wide sheet. Found by file name by
 * `src/workspace/slots.ts`; the full editor is the same component the slot also finds.
 */
import { useEffect, useState } from "react";
import { ListChecks, Plus, StickyNote } from "lucide-react";
import { useTalkingPointsStore } from "../stores/talkingPointsStore";
import { ConfirmDialog, ModalLayer, type MenuItemSpec } from "../ui";
import { PanelAction, PanelSection } from "../workspace/PanelSection";
import { PanelEmpty, PanelList, PanelRow, ShowAllDialog } from "../workspace/PanelRow";
import type { KindLook } from "../workspace/libraryKinds";
import type { TalkingPoint } from "../lib/types";
import { countWords } from "./doc/model";
import { TalkingPointsEditor } from "./TalkingPointsEditor";
import "./talkingPoints.css";

const NOTE_LOOK: KindLook = { word: "Note", Icon: StickyNote, text: "text-muted-foreground", tile: "bg-muted" };

export function TalkingPointsSection({ workspaceId }: { workspaceId: string }) {
  const notes = useTalkingPointsStore((s) => s.byWorkspace[workspaceId]);
  const loadError = useTalkingPointsStore((s) => s.loadError[workspaceId]);
  // `id` is the note the editor opens on (null: the first).
  const [editor, setEditor] = useState<{ id: string | null } | null>(null);
  const [deleting, setDeleting] = useState<TalkingPoint | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    void useTalkingPointsStore.getState().load(workspaceId);
    setEditor(null);
    setDeleting(null);
    setShowAll(false);
  }, [workspaceId]);

  const create = async () => {
    const p = await useTalkingPointsStore.getState().create(workspaceId, { title: "Untitled note" });
    if (p) setEditor({ id: p.id });
  };
  const list = notes ?? [];

  /** From the "Show all" dialog a choice first closes it: one dialog at a time keeps focus where it belongs. */
  const row = (n: TalkingPoint, fromDialog: boolean) => {
    const go = (next: () => void) => () => {
      if (fromDialog) setShowAll(false);
      next();
    };
    const words = countWords(n.plain_text);
    const items: MenuItemSpec[] = [
      { id: "open", label: "Open", onSelect: go(() => setEditor({ id: n.id })) },
      { id: "context", label: "Use as AI context", checked: n.in_context, onSelect: () => void useTalkingPointsStore.getState().setInContext(n.id, !n.in_context) },
      { id: "dup", label: "Duplicate", onSelect: () => void useTalkingPointsStore.getState().duplicate(n.id) },
      { id: "del", label: "Delete", danger: true, separatorBefore: true, onSelect: go(() => setDeleting(n)) },
    ];
    return (
      <PanelRow
        key={n.id}
        look={NOTE_LOOK}
        title={n.title}
        openLabel={n.title}
        onOpen={go(() => setEditor({ id: n.id }))}
        menuLabel={`Actions for ${n.title}`}
        menuItems={items}
        meta={
          <>
            <span className="shrink-0 font-medium">Note</span>
            <span className="sr-only">. </span>
            <span className="shrink-0">
              {words} {words === 1 ? "word" : "words"}
            </span>
            {n.in_context && <span className="min-w-0 truncate font-medium text-foreground">AI context</span>}
          </>
        }
      />
    );
  };

  return (
    <PanelSection
      id="talking-points"
      icon={ListChecks}
      title="Talking points"
      count={list.length}
      info="Notes you want in front of you during a call, and for answers to draw on when you turn on Use as AI context."
      infoLabel="About talking points"
      action={<PanelAction label="New note" icon={Plus} onClick={() => void create()} />}
    >
      {loadError && !notes && (
        <p role="alert" className="ui-meta text-destructive">
          Talking points did not load: {loadError}
        </p>
      )}
      {notes && list.length === 0 && <PanelEmpty>No notes yet.</PanelEmpty>}
      {list.length > 0 && (
        <PanelList label="Notes" noun="notes" count={list.length} onShowAll={() => setShowAll(true)}>
          {list.map((n) => row(n, false))}
        </PanelList>
      )}
      <ShowAllDialog
        open={showAll}
        onClose={() => setShowAll(false)}
        title="Talking points"
        noun="notes"
        items={list}
        keyOf={(n) => n.id}
        textOf={(n) => `${n.title} ${n.plain_text}`}
        renderRow={(n) => row(n, true)}
      />
      {/* the editor needs room: a list beside a full editor column, not the 26 rem of a plain sheet */}
      <ModalLayer
        open={editor !== null}
        onClose={() => setEditor(null)}
        title="Talking points"
        description="Write, reorder and import the notes of this workspace."
        placement="right"
        className="w-[min(62rem,100%)]"
      >
        <TalkingPointsEditor key={editor?.id ?? "first"} workspaceId={workspaceId} initialId={editor?.id ?? null} className="min-h-[60vh]" />
      </ModalLayer>
      <ConfirmDialog
        open={deleting !== null}
        title={deleting ? `Delete "${deleting.title}"?` : "Delete note"}
        body="This removes the note from the workspace. Meetings that used it keep what they saved."
        confirmLabel="Delete note"
        tone="danger"
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          const n = deleting;
          setDeleting(null);
          if (n) void useTalkingPointsStore.getState().remove(n.id);
        }}
      />
    </PanelSection>
  );
}

export default TalkingPointsSection;
