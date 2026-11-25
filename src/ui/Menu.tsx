import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { Check } from "lucide-react";
import { cn } from "../lib/utils";
import { Portal, anchorOf, placeBox, useDismiss, useMeasured, type Anchor } from "./portal";

export interface MenuItemSpec {
  id: string;
  label: string;
  /** Right-aligned hint, e.g. a shortcut. */
  hint?: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  /** Set for a toggle item (role menuitemcheckbox). */
  checked?: boolean;
  /** A thin rule above this item. */
  separatorBefore?: boolean;
  onSelect: () => void;
}

export interface MenuTriggerProps {
  ref: Ref<HTMLButtonElement>;
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
  "aria-controls": string | undefined;
  onClick: () => void;
  onKeyDown: (e: ReactKeyboardEvent) => void;
}

export interface MenuProps {
  items: MenuItemSpec[];
  /** Accessible name of the menu. */
  label: string;
  /** Render the button; spread `props` on it. */
  renderTrigger: (props: MenuTriggerProps, state: { open: boolean }) => ReactNode;
  align?: "start" | "end";
  className?: string;
}

/**
 * A menu button: roving focus (Up, Down, Home, End), typeahead, Enter or Space
 * to choose, Escape to close and give focus back. Opens in the window's root.
 */
export function Menu({ items, label, renderTrigger, align = "start", className }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [active, setActive] = useState(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLDivElement | null>>([]);
  const typed = useRef({ text: "", at: 0 });
  const menuId = useId();
  const { setEl, size } = useMeasured<HTMLDivElement>(open);

  const enabled = useCallback(() => items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0), [items]);

  const close = useCallback((restore: boolean) => {
    setOpen(false);
    if (restore) triggerRef.current?.focus();
  }, []);

  const openAt = useCallback(
    (which: "first" | "last") => {
      const ok = enabled();
      if (ok.length === 0) return;
      if (triggerRef.current) setAnchor(anchorOf(triggerRef.current));
      setActive(which === "first" ? ok[0] : ok[ok.length - 1]);
      setOpen(true);
    },
    [enabled],
  );

  useDismiss(open, [listRef, triggerRef], () => close(false));

  useEffect(() => {
    if (open) itemRefs.current[active]?.focus({ preventScroll: true });
  }, [open, active]);

  const move = (delta: number) => {
    const ok = enabled();
    if (ok.length === 0) return;
    const at = ok.indexOf(active);
    setActive(ok[(at + delta + ok.length) % ok.length]);
  };

  const choose = (i: number) => {
    const it = items[i];
    if (!it || it.disabled) return;
    close(true);
    it.onSelect();
  };

  const onListKey = (e: ReactKeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(1);
        return;
      case "ArrowUp":
        e.preventDefault();
        move(-1);
        return;
      case "Home":
        e.preventDefault();
        setActive(enabled()[0] ?? 0);
        return;
      case "End":
        e.preventDefault();
        setActive(enabled().slice(-1)[0] ?? 0);
        return;
      case "Enter":
      case " ":
        e.preventDefault();
        choose(active);
        return;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        close(true);
        return;
      case "Tab":
        close(false);
        return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const now = Date.now();
      const t = typed.current;
      t.text = now - t.at > 600 ? e.key.toLowerCase() : t.text + e.key.toLowerCase();
      t.at = now;
      const ok = enabled();
      const from = t.text.length === 1 ? ok.indexOf(active) + 1 : ok.indexOf(active);
      const order = [...ok.slice(Math.max(from, 0)), ...ok.slice(0, Math.max(from, 0))];
      const hit = order.find((i) => items[i].label.toLowerCase().startsWith(t.text));
      if (hit !== undefined) setActive(hit);
    }
  };

  const pos = anchor ? placeBox(anchor, size, { align }) : { left: 0, top: 0 };

  const triggerProps: MenuTriggerProps = {
    ref: triggerRef,
    "aria-haspopup": "menu",
    "aria-expanded": open,
    "aria-controls": open ? menuId : undefined,
    onClick: () => (open ? close(false) : openAt("first")),
    onKeyDown: (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        openAt("first");
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        openAt("last");
      }
    },
  };

  return (
    <>
      {renderTrigger(triggerProps, { open })}
      {open && (
        <Portal>
          <div
            ref={(el) => {
              listRef.current = el;
              setEl(el);
            }}
            id={menuId}
            role="menu"
            aria-label={label}
            onKeyDown={onListKey}
            style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 60, ...("maxHeight" in pos ? { maxHeight: pos.maxHeight, maxWidth: pos.maxWidth, overflowY: "auto" as const } : {}) }}
            className={cn(
              "ui-pop-in min-w-[11rem] max-w-[20rem] rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-[0_12px_32px_-12px_rgba(0,0,0,0.55)]",
              className,
            )}
          >
            {items.map((it, i) => (
              <div key={it.id} role="none">
                {it.separatorBefore && <div role="separator" className="my-1 h-px bg-border" />}
                <div
                  ref={(el) => {
                    itemRefs.current[i] = el;
                  }}
                  role={it.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                  aria-checked={it.checked}
                  aria-disabled={it.disabled || undefined}
                  tabIndex={i === active ? 0 : -1}
                  onMouseMove={() => !it.disabled && setActive(i)}
                  onClick={() => choose(i)}
                  className={cn(
                    "ui-body flex cursor-default select-none items-center gap-2 rounded-lg px-2.5 py-1.5 outline-none ui-focus",
                    i === active && "bg-accent",
                    it.danger && "text-destructive",
                    it.disabled && "opacity-45",
                  )}
                >
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                    {it.checked && <Check className="h-3.5 w-3.5" aria-hidden />}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{it.label}</span>
                  {it.hint && <span className="ui-meta shrink-0 text-muted-foreground">{it.hint}</span>}
                </div>
              </div>
            ))}
          </div>
        </Portal>
      )}
    </>
  );
}
