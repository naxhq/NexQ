import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { Editor } from "@tiptap/core";
import { Bold, Heading1, Heading2, Heading3, Italic, List, ListOrdered, Palette, Redo2, Type, Underline, Undo2 } from "lucide-react";
import { Kbd, Tooltip } from "../../ui";
import { cn } from "../../lib/utils";
import { COLOR_LABELS, COLOR_NAMES, SIZE_LABELS, type TpColorName, type TpSizeStep } from "../doc/model";

type Pop = "color" | "size" | null;

interface Props {
  editor: Editor;
  container: RefObject<HTMLElement | null>;
  /** Narrow panel: the bar sits at the top of the editor instead of floating at the caret. */
  compact?: boolean;
}

const btn =
  "inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors duration-150 hover:bg-accent hover:text-foreground ui-focus ui-r-md aria-pressed:bg-accent aria-pressed:text-foreground";

function Tip({ label, keys, children }: { label: string; keys?: string; children: ReactNode }) {
  return (
    <Tooltip
      content={
        <span className="inline-flex items-center gap-2">
          {label}
          {keys && <Kbd>{keys}</Kbd>}
        </span>
      }
    >
      {children as never}
    </Tooltip>
  );
}

/** A tick that re-renders the bar when the selection or the document changes. */
function useEditorTick(editor: Editor): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    editor.on("transaction", bump);
    editor.on("focus", bump);
    editor.on("blur", bump);
    return () => {
      editor.off("transaction", bump);
      editor.off("focus", bump);
      editor.off("blur", bump);
    };
  }, [editor]);
  return tick;
}

export function FloatingToolbar({ editor, container, compact }: Props) {
  const tick = useEditorTick(editor);
  const barRef = useRef<HTMLDivElement | null>(null);
  const [within, setWithin] = useState(false);
  const [pop, setPop] = useState<Pop>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [roving, setRoving] = useState(0);

  const visible = compact || editor.isFocused || within || pop !== null;

  useLayoutEffect(() => {
    if (compact || !visible || !container.current || !barRef.current) return;
    try {
      const c = container.current.getBoundingClientRect();
      const caret = editor.view.coordsAtPos(editor.state.selection.from);
      const barW = barRef.current.offsetWidth;
      const barH = barRef.current.offsetHeight;
      let top = caret.top - c.top - barH - 8;
      if (top < -barH) top = caret.bottom - c.top + 8;
      const left = Math.max(0, Math.min(caret.left - c.left - 8, c.width - barW));
      setPos({ top, left });
    } catch {
      setPos({ top: 0, left: 0 });
    }
  }, [tick, visible, compact, editor, container]);

  const run = useCallback(
    (fn: (chain: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>) => {
      fn(editor.chain().focus()).run();
    },
    [editor],
  );

  const curColor = (editor.getAttributes("tpColor").name as TpColorName | undefined) ?? null;
  const curSize = (editor.getAttributes("tpSize").step as TpSizeStep | undefined) ?? null;

  // Roving focus: Left/Right move through the bar, Escape returns to the text.
  const items = useRef<Array<HTMLButtonElement | null>>([]);
  const onKey = (e: React.KeyboardEvent) => {
    const list = items.current.filter(Boolean) as HTMLButtonElement[];
    const at = list.findIndex((b) => b === document.activeElement);
    const go = (i: number) => {
      const t = list[(i + list.length) % list.length];
      setRoving(items.current.indexOf(t));
      t.focus();
    };
    if (e.key === "ArrowRight") {
      e.preventDefault();
      go(at + 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      go(at - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      go(0);
    } else if (e.key === "End") {
      e.preventDefault();
      go(list.length - 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (pop) setPop(null);
      editor.commands.focus();
    }
  };

  let idx = 0;
  const reg = (el: HTMLButtonElement | null, i: number) => {
    items.current[i] = el;
  };
  const make = (
    label: string,
    keys: string | undefined,
    icon: ReactNode,
    pressed: boolean | undefined,
    onClick: () => void,
    disabled = false,
    extra: { expanded?: boolean } = {},
  ) => {
    const i = idx++;
    return (
      <Tip label={label} keys={keys} key={label}>
        <button
          ref={(el) => reg(el, i)}
          type="button"
          aria-label={label}
          aria-pressed={pressed}
          aria-haspopup={extra.expanded !== undefined ? "true" : undefined}
          aria-expanded={extra.expanded}
          disabled={disabled}
          tabIndex={roving === i ? 0 : -1}
          onClick={onClick}
          className={cn(btn, disabled && "opacity-40")}
        >
          {icon}
        </button>
      </Tip>
    );
  };
  const sep = (k: string) => <span key={k} aria-hidden className="mx-0.5 h-4 w-px bg-border" />;
  const ic = "h-4 w-4";

  if (!visible) return null;
  return (
    <div
      ref={barRef}
      role="toolbar"
      aria-label="Text formatting"
      aria-orientation="horizontal"
      // Keep the caret in the text when a button is pressed; keyboard focus still reaches the bar.
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest("button")) e.preventDefault();
      }}
      onFocus={() => setWithin(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setWithin(false);
      }}
      onKeyDown={onKey}
      style={compact ? undefined : { position: "absolute", top: pos?.top ?? 0, left: pos?.left ?? 0, opacity: pos ? 1 : 0 }}
      className={cn(
        "tp-toolbar z-20 flex max-w-full flex-wrap items-center gap-0.5 rounded-lg border border-border bg-popover/95 p-0.5 shadow-sm backdrop-blur-sm",
        compact && "mb-2 w-full",
      )}
    >
      {make("Bold", "Ctrl B", <Bold className={ic} />, editor.isActive("bold"), () => run((c) => c.toggleBold()))}
      {make("Italic", "Ctrl I", <Italic className={ic} />, editor.isActive("italic"), () => run((c) => c.toggleItalic()))}
      {make("Underline", "Ctrl U", <Underline className={ic} />, editor.isActive("underline"), () => run((c) => c.toggleUnderline()))}
      {sep("s1")}
      {make("Heading 1", "Ctrl Alt 1", <Heading1 className={ic} />, editor.isActive("heading", { level: 1 }), () => run((c) => c.toggleHeading({ level: 1 })))}
      {make("Heading 2", "Ctrl Alt 2", <Heading2 className={ic} />, editor.isActive("heading", { level: 2 }), () => run((c) => c.toggleHeading({ level: 2 })))}
      {make("Heading 3", "Ctrl Alt 3", <Heading3 className={ic} />, editor.isActive("heading", { level: 3 }), () => run((c) => c.toggleHeading({ level: 3 })))}
      {sep("s2")}
      {make("Bullet list", "Ctrl Shift 8", <List className={ic} />, editor.isActive("bulletList"), () => run((c) => c.toggleBulletList()))}
      {make("Numbered list", "Ctrl Shift 7", <ListOrdered className={ic} />, editor.isActive("orderedList"), () => run((c) => c.toggleOrderedList()))}
      {sep("s3")}
      <span className="relative inline-flex">
        {make("Colour", undefined, <Palette className={ic} />, curColor !== null, () => setPop(pop === "color" ? null : "color"), false, { expanded: pop === "color" })}
        {pop === "color" && (
          <div
            role="group"
            aria-label="Text colour"
            className="absolute left-0 top-full z-30 mt-1 flex items-center gap-1 rounded-lg border border-border bg-popover p-1.5 shadow-md"
          >
            {COLOR_NAMES.map((n) => (
              <button
                key={n}
                type="button"
                aria-label={COLOR_LABELS[n]}
                aria-pressed={curColor === n}
                onClick={() => {
                  run((c) => (curColor === n ? c.unsetMark("tpColor") : c.setMark("tpColor", { name: n })));
                  setPop(null);
                }}
                className={cn(
                  "tp-swatch h-6 w-6 rounded-full outline-none transition-shadow ui-focus ui-focus-pill",
                  curColor === n && "ring-2 ring-foreground/70 ring-offset-2",
                )}
                style={{ background: `hsl(var(--tp-${n}))` }}
              />
            ))}
            <button
              type="button"
              onClick={() => {
                run((c) => c.unsetMark("tpColor"));
                setPop(null);
              }}
              className="ui-meta ml-1 rounded-md px-1.5 py-1 text-muted-foreground outline-none hover:bg-accent ui-focus ui-r-md"
            >
              Clear
            </button>
          </div>
        )}
      </span>
      <span className="relative inline-flex">
        {make("Size", undefined, <Type className={ic} />, curSize !== null, () => setPop(pop === "size" ? null : "size"), false, { expanded: pop === "size" })}
        {pop === "size" && (
          <div
            role="group"
            aria-label="Text size"
            className="absolute left-0 top-full z-30 mt-1 flex flex-col rounded-lg border border-border bg-popover p-1 shadow-md"
          >
            {(["small", "normal", "large", "xlarge"] as const).map((s) => {
              const on = (s === "normal" && curSize === null) || s === curSize;
              return (
                <button
                  key={s}
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    run((c) => (s === "normal" ? c.unsetMark("tpSize") : c.setMark("tpSize", { step: s as TpSizeStep })));
                    setPop(null);
                  }}
                  className={cn(
                    "ui-body whitespace-nowrap rounded-md px-3 py-1 text-left outline-none hover:bg-accent ui-focus ui-r-md",
                    on && "font-semibold",
                  )}
                >
                  {SIZE_LABELS[s]}
                </button>
              );
            })}
          </div>
        )}
      </span>
      {sep("s4")}
      {make("Undo", "Ctrl Z", <Undo2 className={ic} />, undefined, () => run((c) => c.undo()), !editor.can().undo())}
      {make("Redo", "Ctrl Shift Z", <Redo2 className={ic} />, undefined, () => run((c) => c.redo()), !editor.can().redo())}
    </div>
  );
}
