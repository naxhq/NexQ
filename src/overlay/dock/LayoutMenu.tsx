import { useEffect, useRef, useState } from "react";
import { Check, LayoutDashboard, Lock, LockOpen, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { LayoutPreview } from "./LayoutPreview";
import {
  PRESET_IDS,
  PRESET_NAMES,
  allPanels,
  presetLayout,
  type DockAction,
  type DockState,
  type PanelId,
} from "./layoutModel";

export interface LayoutMenuPanel {
  title: string;
  /** Default true. */
  canHide?: boolean;
}

interface MenuProps {
  state: DockState;
  dispatch: (a: DockAction) => void;
  panels: Record<PanelId, LayoutMenuPanel>;
  onClose?: () => void;
}

const sectionCls = "px-2 pb-1 pt-2 text-[11px] font-semibold text-muted-foreground/70";
const rowCls =
  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground/90 transition-colors hover:bg-foreground/[0.07] focus-visible:bg-foreground/[0.07] focus-visible:outline-none disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent";

/** Layout menu content: presets with live schematics, saved layouts, panels, lock, reset. */
export function LayoutMenu({ state, dispatch, panels, onClose }: MenuProps) {
  const { layout, custom } = state;
  const known = allPanels(layout);
  const locked = layout.locked;
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const docked = new Set(known.filter((p) => !layout.hidden.includes(p)));

  const save = () => {
    if (!name.trim()) return;
    dispatch({ type: "saveLayout", name });
    setName("");
  };

  return (
    <div className="text-foreground" aria-label="Layout">
      <div className={sectionCls}>Layouts</div>
      <div className="grid grid-cols-3 gap-1 px-1">
        {PRESET_IDS.map((id) => (
          <button
            key={id}
            type="button"
            disabled={locked}
            className="flex flex-col items-center gap-1 rounded-md px-1 py-1.5 text-[11px] text-foreground/80 transition-colors hover:bg-foreground/[0.07] focus-visible:bg-foreground/[0.07] focus-visible:outline-none disabled:opacity-40"
            onClick={() => dispatch({ type: "preset", preset: id })}
          >
            <LayoutPreview layout={presetLayout(id, known)} />
            <span>{PRESET_NAMES[id]}</span>
          </button>
        ))}
      </div>

      {custom.length > 0 && <div className={sectionCls}>Your layouts</div>}
      {custom.map((c) => (
        <div key={c.id} className="flex items-center gap-1 px-1">
          {renaming === c.id ? (
            <input
              autoFocus
              value={draft}
              maxLength={40}
              aria-label="Layout name"
              className="min-w-0 flex-1 rounded-md border border-border/40 bg-transparent px-2 py-1 text-xs outline-none focus:border-primary/60"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  dispatch({ type: "renameLayout", id: c.id, name: draft });
                  setRenaming(null);
                } else if (e.key === "Escape") {
                  e.stopPropagation();
                  setRenaming(null);
                }
              }}
              onBlur={() => setRenaming(null)}
            />
          ) : (
            <button
              type="button"
              disabled={locked}
              className={`${rowCls} min-w-0 flex-1`}
              onClick={() => dispatch({ type: "applyLayout", id: c.id })}
            >
              <LayoutPreview layout={c.layout} w={40} h={26} />
              <span className="truncate">{c.name}</span>
            </button>
          )}
          <button
            type="button"
            aria-label={`Rename ${c.name}`}
            className="rounded-md p-1.5 text-muted-foreground/70 hover:bg-foreground/[0.07] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setDraft(c.name);
              setRenaming(c.id);
            }}
          >
            <Pencil className="h-3 w-3" aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={`Delete ${c.name}`}
            className="rounded-md p-1.5 text-muted-foreground/70 hover:bg-foreground/[0.07] hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
            onClick={() => dispatch({ type: "deleteLayout", id: c.id })}
          >
            <Trash2 className="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
      ))}

      <form
        className="flex items-center gap-1 px-1 pt-1"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <input
          value={name}
          maxLength={40}
          placeholder="Save this layout as…"
          aria-label="Name for the new layout"
          className="min-w-0 flex-1 rounded-md border border-border/30 bg-transparent px-2 py-1 text-xs outline-none placeholder:text-muted-foreground/50 focus:border-primary/60"
          onChange={(e) => setName(e.target.value)}
        />
        <button
          type="submit"
          disabled={!name.trim()}
          className="rounded-md px-2 py-1 text-xs font-medium text-foreground/90 hover:bg-foreground/[0.07] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 disabled:opacity-40"
        >
          Save
        </button>
      </form>

      <div className={sectionCls}>Panels</div>
      <ul className="px-1" role="group" aria-label="Panels">
        {known.map((p) => {
          const on = docked.has(p);
          const canHide = panels[p]?.canHide !== false;
          return (
            <li key={p}>
              <button
                type="button"
                role="checkbox"
                aria-checked={on}
                disabled={on && !canHide}
                className={rowCls}
                onClick={() => dispatch({ type: on ? "hide" : "show", panel: p })}
              >
                <span className="flex h-3.5 w-3.5 items-center justify-center" aria-hidden="true">
                  {on && <Check className="h-3 w-3" />}
                </span>
                <span>{panels[p]?.title ?? p}</span>
              </button>
            </li>
          );
        })}
      </ul>

      <div className="my-1.5 h-px bg-border/30" />
      <div className="px-1 pb-1">
        <button
          type="button"
          role="switch"
          aria-checked={locked}
          className={rowCls}
          onClick={() => dispatch({ type: "lock", locked: !locked })}
        >
          {locked ? <Lock className="h-3 w-3" aria-hidden="true" /> : <LockOpen className="h-3 w-3" aria-hidden="true" />}
          <span>{locked ? "Layout locked" : "Lock layout"}</span>
        </button>
        <button
          type="button"
          disabled={locked}
          className={rowCls}
          onClick={() => {
            dispatch({ type: "reset" });
            onClose?.();
          }}
        >
          <RotateCcw className="h-3 w-3" aria-hidden="true" />
          <span>Reset to Classic</span>
        </button>
      </div>
    </div>
  );
}

interface ButtonProps extends MenuProps {
  className?: string;
}

/** Header button + popover. Place it in the overlay header; it is not a drag region. */
export function LayoutMenuButton({ className, ...menu }: ButtonProps) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        wrap.current?.querySelector<HTMLElement>("button")?.focus();
      }
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [open]);

  return (
    <div ref={wrap} className={`relative ${className ?? ""}`}>
      <button
        type="button"
        aria-label="Layout"
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.07] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
        onClick={() => setOpen((o) => !o)}
      >
        <LayoutDashboard className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Layout"
          className="absolute right-0 top-full z-50 mt-1.5 w-[272px] max-h-[70vh] overflow-y-auto rounded-xl border border-border/40 bg-popover p-1.5 shadow-xl"
        >
          <LayoutMenu {...menu} onClose={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}
