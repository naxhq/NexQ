import { useCallback, useRef, useState } from "react";
import { Popover } from "../../ui/Popover";
import { Check, LayoutDashboard, Lock, LockOpen, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { LayoutPreview } from "./LayoutPreview";
import {
  PRESET_IDS,
  PRESET_NAMES,
  allPanels,
  presetLayout,
  type DockAction,
  type DockState,
  type SavedLayout,
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

const sectionCls = "px-2 pb-1 pt-2 ui-meta font-semibold text-muted-foreground/70";
const rowCls =
  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ui-body text-foreground/90 transition-colors hover:bg-foreground/[0.07] ui-focus focus-visible:bg-foreground/[0.12] disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent";

/** Layout menu content: presets with live schematics, saved layouts, panels, lock, reset. */
export function LayoutMenu({ state, dispatch, panels, onClose }: MenuProps) {
  const { layout, custom } = state;
  const known = allPanels(layout);
  const locked = layout.locked;
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // A deleted layout can be brought back until the menu closes or another one is deleted.
  const [undo, setUndo] = useState<{ saved: SavedLayout; index: number } | null>(null);
  const docked = new Set(known.filter((p) => !layout.hidden.includes(p)));

  const save = () => {
    if (!name.trim()) return;
    dispatch({ type: "saveLayout", name });
    setName("");
  };

  // Roving focus over the menu's buttons (Up, Down, Home, End) and typeahead, like src/ui Menu.
  const typed = useRef({ text: "", at: 0 });
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t.tagName === "INPUT" || e.ctrlKey || e.metaKey || e.altKey) return;
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled)")];
    const at = items.indexOf(t);
    if (at < 0) return;
    let to = -1;
    if (e.key === "ArrowDown") to = (at + 1) % items.length;
    else if (e.key === "ArrowUp") to = (at - 1 + items.length) % items.length;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = items.length - 1;
    else if (e.key.length === 1 && e.key !== " ") {
      const now = Date.now();
      const text = (now - typed.current.at > 700 ? "" : typed.current.text) + e.key.toLowerCase();
      typed.current = { text, at: now };
      const ordered = [...items.slice(at + 1), ...items.slice(0, at + 1)];
      const hit = ordered.find((b) => (b.textContent ?? "").trim().toLowerCase().startsWith(text));
      if (hit) to = items.indexOf(hit);
    }
    if (to >= 0) {
      e.preventDefault();
      items[to].focus();
    }
  };

  return (
    <div className="text-foreground" aria-label="Layout" onKeyDown={onKeyDown}>
      <div className={sectionCls}>Layouts</div>
      <div className="grid grid-cols-3 gap-1 px-1">
        {PRESET_IDS.map((id) => (
          <button
            key={id}
            type="button"
            disabled={locked}
            className="flex flex-col items-center gap-1 rounded-md px-1 py-1.5 ui-meta text-foreground/80 transition-colors hover:bg-foreground/[0.07] ui-focus focus-visible:bg-foreground/[0.12] disabled:opacity-40"
            onClick={() => dispatch({ type: "preset", preset: id })}
          >
            <LayoutPreview layout={presetLayout(id, known)} />
            <span>{PRESET_NAMES[id]}</span>
          </button>
        ))}
      </div>

      {undo && (
        <div role="status" className="mx-1 mt-1 flex items-center gap-2 rounded-md bg-foreground/[0.06] px-2 py-1.5 ui-body">
          <span className="min-w-0 flex-1 truncate">Deleted "{undo.saved.name}"</span>
          <button
            type="button"
            className="rounded-md px-2 py-0.5 font-medium text-primary hover:bg-foreground/[0.07] ui-focus"
            onClick={() => {
              dispatch({ type: "restoreLayout", saved: undo.saved, index: undo.index });
              setUndo(null);
            }}
          >
            Undo
          </button>
        </div>
      )}
      {custom.length > 0 && <div className={sectionCls}>Your layouts</div>}
      {custom.map((c) => (
        <div key={c.id} className="flex items-center gap-1 px-1">
          {renaming === c.id ? (
            <input
              autoFocus
              value={draft}
              maxLength={40}
              aria-label="Layout name"
              className="min-w-0 flex-1 rounded-md border border-border/40 bg-transparent px-2 py-1 ui-body ui-focus focus:border-primary/60"
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
            className="rounded-md p-1.5 text-muted-foreground/70 hover:bg-foreground/[0.07] hover:text-foreground ui-focus"
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
            className="rounded-md p-1.5 text-muted-foreground/70 hover:bg-foreground/[0.07] hover:text-destructive ui-focus"
            onClick={() => {
              setUndo({ saved: c, index: custom.findIndex((x) => x.id === c.id) });
              dispatch({ type: "deleteLayout", id: c.id });
            }}
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
          className="min-w-0 flex-1 rounded-md border border-border/30 bg-transparent px-2 py-1 ui-body ui-focus placeholder:text-muted-foreground/50 focus:border-primary/60"
          onChange={(e) => setName(e.target.value)}
        />
        <button
          type="submit"
          disabled={!name.trim()}
          className="rounded-md px-2 py-1 ui-body font-medium text-foreground/90 hover:bg-foreground/[0.07] ui-focus disabled:opacity-40"
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
  const btn = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  // Opening the menu moves focus into it (the first layout), so arrows work at once.
  const popRef = useCallback((el: HTMLElement | null) => el?.querySelector<HTMLElement>("button:not(:disabled)")?.focus(), []);

  return (
    <div className={`relative ${className ?? ""}`}>
      <button
        ref={btn}
        type="button"
        aria-label="Layout"
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.07] hover:text-foreground ui-focus"
        onClick={() => setOpen((o) => !o)}
      >
        <LayoutDashboard className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <Popover open={open} onClose={close} anchorRef={btn} label="Layout" align="end" className="w-[272px] p-1.5">
        <div ref={popRef}>
          <LayoutMenu {...menu} onClose={close} />
        </div>
      </Popover>
    </div>
  );
}
