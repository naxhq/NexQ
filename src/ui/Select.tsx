import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "../lib/utils";
import { Portal, anchorOf, placeBox, useDismiss, useMeasured, type Anchor } from "./portal";

export interface SelectOption {
  value: string;
  label: string;
  /** A second, quieter line. */
  description?: string;
  disabled?: boolean;
}

export interface SelectProps {
  value: string | null;
  onChange: (value: string) => void;
  options: SelectOption[];
  /** Accessible name. */
  label: string;
  placeholder?: string;
  /** Show a filter box in the list. */
  filterable?: boolean;
  disabled?: boolean;
  className?: string;
  /** Shown when the filter matches nothing. */
  emptyText?: string;
}

/**
 * Our select: never the native one (its popup can escape hide-from-screen-share).
 * Trigger is a combobox; the list is a listbox with aria-activedescendant, so
 * focus stays on one element (the filter box, or the list itself).
 */
export function Select({
  value,
  onChange,
  options,
  label,
  placeholder = "Choose",
  filterable = false,
  disabled,
  className,
  emptyText = "Nothing matches",
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const focusRef = useRef<HTMLElement | null>(null);
  const typed = useRef({ text: "", at: 0 });
  const uid = useId();
  const listId = `${uid}-list`;
  const { setEl, size } = useMeasured<HTMLDivElement>(open ? query : null);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  }, [options, query]);

  const selected = options.find((o) => o.value === value) ?? null;

  const close = useCallback((restore: boolean) => {
    setOpen(false);
    setQuery("");
    if (restore) triggerRef.current?.focus();
  }, []);

  const openList = () => {
    if (disabled) return;
    if (triggerRef.current) setAnchor(anchorOf(triggerRef.current));
    const at = options.findIndex((o) => o.value === value && !o.disabled);
    setActive(Math.max(at, 0));
    setOpen(true);
  };

  useDismiss(open, [boxRef, triggerRef], () => close(false));

  useEffect(() => {
    if (open) focusRef.current?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (open) document.getElementById(`${uid}-o${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, active, uid]);

  const step = (delta: number) => {
    if (shown.length === 0) return;
    let i = active;
    for (let n = 0; n < shown.length; n++) {
      i = (i + delta + shown.length) % shown.length;
      if (!shown[i].disabled) break;
    }
    setActive(i);
  };

  const choose = (i: number) => {
    const o = shown[i];
    if (!o || o.disabled) return;
    onChange(o.value);
    close(true);
  };

  const onKey = (e: ReactKeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        step(1);
        return;
      case "ArrowUp":
        e.preventDefault();
        step(-1);
        return;
      case "Home":
        if (filterable) return;
        e.preventDefault();
        setActive(0);
        return;
      case "End":
        if (filterable) return;
        e.preventDefault();
        setActive(Math.max(shown.length - 1, 0));
        return;
      case "Enter":
        e.preventDefault();
        choose(active);
        return;
      case " ":
        if (filterable) return;
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
    if (!filterable && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const now = Date.now();
      const t = typed.current;
      t.text = now - t.at > 600 ? e.key.toLowerCase() : t.text + e.key.toLowerCase();
      t.at = now;
      const hit = shown.findIndex((o) => !o.disabled && o.label.toLowerCase().startsWith(t.text));
      if (hit >= 0) setActive(hit);
    }
  };

  const pos = anchor ? placeBox(anchor, size, { align: "start" }) : { left: 0, top: 0 };
  const optionId = (i: number) => `${uid}-o${i}`;
  const activeId = shown.length > 0 ? optionId(Math.min(active, shown.length - 1)) : undefined;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={disabled}
        onClick={() => (open ? close(false) : openList())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            openList();
          }
        }}
        className={cn(
          "ui-body inline-flex h-8 min-w-[9rem] items-center justify-between gap-2 rounded-lg ui-field px-2.5 text-left outline-none ui-focus disabled:opacity-50",
          className,
        )}
      >
        <span className={cn("truncate", !selected && "text-muted-foreground")}>{selected?.label ?? placeholder}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
      </button>
      {open && (
        <Portal>
          <div
            ref={(el) => {
              boxRef.current = el;
              setEl(el);
            }}
            style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 60, minWidth: anchor?.width, ...("maxHeight" in pos ? { maxHeight: pos.maxHeight, maxWidth: pos.maxWidth } : {}) }}
            className="ui-pop-in w-max max-w-[22rem] rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-[0_12px_32px_-12px_rgba(0,0,0,0.55)]"
          >
            {filterable && (
              <input
                ref={(el) => {
                  focusRef.current = el;
                }}
                role="searchbox"
                aria-label={`Filter ${label}`}
                aria-controls={listId}
                aria-activedescendant={activeId}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={onKey}
                placeholder="Filter"
                className="ui-body mb-1 h-8 w-full rounded-lg border border-border bg-transparent px-2.5 outline-none ui-focus placeholder:text-muted-foreground"
              />
            )}
            <div
              ref={(el) => {
                if (!filterable) focusRef.current = el;
              }}
              id={listId}
              role="listbox"
              aria-label={label}
              tabIndex={filterable ? -1 : 0}
              aria-activedescendant={filterable ? undefined : activeId}
              onKeyDown={filterable ? undefined : onKey}
              className="max-h-64 overflow-y-auto outline-none ui-focus"
            >
              {shown.length === 0 && <div className="ui-meta px-2.5 py-2 text-muted-foreground">{emptyText}</div>}
              {shown.map((o, i) => (
                <div
                  key={o.value}
                  id={optionId(i)}
                  role="option"
                  aria-selected={o.value === value}
                  aria-disabled={o.disabled || undefined}
                  onMouseMove={() => !o.disabled && setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(i)}
                  className={cn(
                    "ui-body flex cursor-default select-none items-start gap-2 rounded-lg px-2.5 py-1.5",
                    i === active && "bg-accent",
                    o.disabled && "opacity-45",
                  )}
                >
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                    {o.value === value && <Check className="h-3.5 w-3.5" aria-hidden />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{o.label}</span>
                    {o.description && <span className="ui-meta block text-muted-foreground">{o.description}</span>}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </Portal>
      )}
    </>
  );
}

/** A Select with the filter box on. */
export function Combobox(props: Omit<SelectProps, "filterable">) {
  return <Select {...props} filterable />;
}
