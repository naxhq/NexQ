import { memo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { MoreHorizontal, Pencil, Pin, Plus } from "lucide-react";
import { Menu, Segmented, type MenuItemSpec } from "../ui";
import { cn } from "../lib/utils";
import type { NoteBlock, NoteBlockType } from "../lib/types";
import { parseInline, plainText, retag } from "./entities";
import { TYPE_LABEL, blockToMarkdown, formatClock } from "./page";
import { copyText } from "./clipboard";

/** Text with its entities set apart. Always text nodes: nothing here can inject markup. */
export function NoteText({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((p, i) =>
        "entity" in p ? (
          <span key={i} className={`ln-ent-${p.entity}`} data-entity={p.entity}>
            {p.text}
          </span>
        ) : (
          p.text
        ),
      )}
    </>
  );
}

/** The row's own class. A topic row is not `ln-topic`: that is the section around it (its margin rule). */
export function rowClass(type: NoteBlockType): string {
  return type === "topic" ? "ln-topic-row" : `ln-${type}`;
}

export interface RowActions {
  setText: (id: string, text: string) => void;
  setType: (id: string, type: NoteBlockType) => void;
  togglePin: (id: string) => void;
  deleteLine: (id: string) => void;
  startAddAfter: (id: string) => void;
  jump?: (ms: number) => void;
}

const EDIT_TYPES: Array<{ value: NoteBlockType; label: string }> = [
  { value: "bullet", label: "Note" },
  { value: "decision", label: "Decision" },
  { value: "task", label: "Task" },
  { value: "question", label: "Question" },
];

interface RowProps {
  block: NoteBlock;
  fresh: boolean;
  editable: boolean;
  editing: boolean;
  /** This row is the one Tab lands on. */
  tabbable: boolean;
  actions: RowActions;
  onEditDone: () => void;
  onFocusRow: (id: string) => void;
  /** Show the block's own time in the margin. */
  showTime?: boolean;
}

function NoteBlockRowImpl({ block, fresh, editable, editing, tabbable, actions, onEditDone, onFocusRow, showTime = true }: RowProps) {
  const [startEdit, setStartEdit] = useState(false);
  const isTopic = block.type === "topic";
  const isLead = block.type === "summary" || isTopic;
  const t = block.t;
  const clock = formatClock(t);
  const jump = actions.jump;
  const ti = tabbable ? 0 : -1;
  const Tag = (isLead ? "div" : "li") as "li";

  useEffect(() => {
    if (editing) setStartEdit(true);
  }, [editing]);

  if (editing || startEdit) {
    return (
      <Tag className={cn("ln-item", isLead && "ln-lead-row", rowClass(block.type))} data-block-id={block.id}>
        <BlockEditor
          block={block}
          onSave={(text, type) => {
            const next = retag(text, block.text);
            if (next && next !== block.text) actions.setText(block.id, next);
            if (type && type !== block.type) actions.setType(block.id, type);
            setStartEdit(false);
            onEditDone();
          }}
          onCancel={() => {
            setStartEdit(false);
            onEditDone();
          }}
        />
      </Tag>
    );
  }

  const items: MenuItemSpec[] = [];
  if (editable) {
    items.push(
      { id: "edit", label: "Edit", hint: "Enter", onSelect: () => setStartEdit(true) },
      { id: "pin", label: block.pinned ? "Unpin" : "Pin", hint: "P", onSelect: () => actions.togglePin(block.id) },
      { id: "add", label: "Add a line below", onSelect: () => actions.startAddAfter(block.id) },
    );
  }
  items.push({ id: "copy", label: "Copy as Markdown", onSelect: () => void copyText(blockToMarkdown(block)) });
  if (jump && t != null) items.push({ id: "jump", label: `Jump to ${clock} in the transcript`, onSelect: () => jump(t) });
  if (editable) {
    items.push({
      id: "delete",
      label: isTopic ? "Delete topic and its lines" : "Delete",
      hint: "Del",
      danger: true,
      separatorBefore: true,
      onSelect: () => actions.deleteLine(block.id),
    });
  }

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget || e.altKey || e.ctrlKey || e.metaKey) return;
    if (editable && (e.key === "Enter" || e.key === "F2")) {
      e.preventDefault();
      setStartEdit(true);
    } else if (editable && (e.key === "p" || e.key === "P")) {
      e.preventDefault();
      actions.togglePin(block.id);
    } else if (editable && (e.key === "Delete" || e.key === "Backspace")) {
      e.preventDefault();
      actions.deleteLine(block.id);
    }
  };

  const body = (
    <>
      <NoteText text={block.text} />
      {block.pinned && (
        <>
          <Pin className="ln-pin h-3 w-3" aria-hidden />
          <span className="rs-sr"> (pinned)</span>
        </>
      )}
      {block.edited && (
        <>
          <span className="ln-edited" aria-hidden>
            Edited by you
          </span>
          <span className="rs-sr"> (edited by you)</span>
        </>
      )}
    </>
  );

  return (
    <Tag
      className={cn("ln-item", isLead && "ln-lead-row", rowClass(block.type), fresh && "ln-fresh")}
      data-block-id={block.id}
      data-fresh={fresh ? "true" : undefined}
      tabIndex={ti}
      onKeyDown={onKeyDown}
      onFocus={(e) => {
        if (e.target === e.currentTarget) onFocusRow(block.id);
      }}
      onDoubleClick={() => editable && setStartEdit(true)}
    >
      {!isLead && <span className="ln-mark" aria-hidden />}
      {!isLead && showTime && jump && t != null && (
        <button type="button" className="ln-itime" tabIndex={ti} onClick={() => jump(t)} aria-label={`Jump to ${clock} in the transcript`}>
          {clock}
        </button>
      )}
      {isTopic ? (
        <h3 className="ln-body ln-topic-head">{body}</h3>
      ) : (
        <div className={cn("ln-body", isLead && "ln-lead")} style={isLead ? { marginTop: 0 } : undefined}>
          {block.type !== "bullet" && block.type !== "summary" && <span className="rs-sr">{TYPE_LABEL[block.type]}: </span>}
          {body}
        </div>
      )}
      <Menu
        items={items}
        label="Line options"
        align="end"
        renderTrigger={(props) => (
          <button
            {...props}
            type="button"
            tabIndex={ti}
            className="ln-more rs-tool h-6 w-6 justify-center px-0"
            aria-label={`Options for this ${TYPE_LABEL[block.type].toLowerCase()}`}
          >
            <MoreHorizontal className="h-3.5 w-3.5" aria-hidden />
          </button>
        )}
      />
    </Tag>
  );
}

export const NoteBlockRow = memo(NoteBlockRowImpl);

/** In-place editor for one line (also used to write a new one). */
export function BlockEditor({
  block,
  initialType,
  onSave,
  onCancel,
}: {
  block?: NoteBlock;
  initialType?: NoteBlockType;
  onSave: (text: string, type: NoteBlockType | null) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(block ? plainText(block.text) : "");
  const [type, setType] = useState<NoteBlockType>(block?.type ?? initialType ?? "bullet");
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const canType = !block || !["topic", "summary"].includes(block.type);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  const save = () => {
    const text = value.replace(/\s*\n\s*/g, " ").trim();
    if (!text) return onCancel();
    onSave(text, canType ? type : null);
  };

  return (
    <div className="ln-edit ln-topic-edit">
      <textarea
        ref={ref}
        className="ln-textarea ui-field"
        rows={1}
        value={value}
        aria-label={block ? "Edit line" : "New line"}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          } else if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            save();
          }
        }}
      />
      {canType && (
        <Segmented
          label="Kind of line"
          value={type}
          onChange={setType}
          options={EDIT_TYPES.map((o) => ({ value: o.value, label: o.label }))}
        />
      )}
      <div className="flex items-center gap-1.5">
        <button type="button" className="rs-tool rs-tool-solid" onClick={save}>
          {block ? <Pencil className="h-3 w-3" aria-hidden /> : <Plus className="h-3 w-3" aria-hidden />}
          {block ? "Save" : "Add"}
        </button>
        <button type="button" className="rs-tool" onClick={onCancel}>
          Cancel
        </button>
        <span className="ui-meta ml-auto text-muted-foreground">Enter to save</span>
      </div>
    </div>
  );
}
