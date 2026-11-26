import { useEffect, useRef, type CSSProperties } from "react";

export interface DockMenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  /** Draw a divider above this item. */
  divider?: boolean;
  onSelect: () => void;
}

interface Props {
  label: string;
  items: DockMenuItem[];
  style?: CSSProperties;
  onClose: () => void;
}

/** Our own menu (no native select/contextmenu). Arrow keys, Home/End, Enter, Escape. */
export function DockMenu({ label, items, style, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
    const away = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current && !ref.current.contains(t) && !t.closest?.(".nq-dock-more")) closeRef.current();
    };
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  }, []);

  const move = (dir: 1 | -1 | "first" | "last") => {
    const els = Array.from(
      ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [],
    );
    if (!els.length) return;
    const i = els.indexOf(document.activeElement as HTMLElement);
    const next =
      dir === "first" ? 0 : dir === "last" ? els.length - 1 : (i + dir + els.length) % els.length;
    els[next].focus();
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className="nq-dock-menu"
      style={style}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") move(1);
        else if (e.key === "ArrowUp") move(-1);
        else if (e.key === "Home") move("first");
        else if (e.key === "End") move("last");
        else if (e.key === "Escape" || e.key === "Tab") onClose();
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {items.map((it) => (
        <div key={it.id}>
          {it.divider && <div className="nq-dock-menusep" role="separator" />}
          <button
            type="button"
            role="menuitem"
            className="nq-dock-menuitem"
            aria-disabled={it.disabled || undefined}
            tabIndex={-1}
            onClick={() => {
              if (it.disabled) return;
              it.onSelect();
            }}
          >
            {it.label}
          </button>
        </div>
      ))}
    </div>
  );
}
