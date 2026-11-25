import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { Portal, anchorOf, placeBox, useDismiss, useMeasured, type Anchor } from "../ui/portal";
import { cn } from "../lib/utils";
import { CAPABILITY_TEXT, GROUP_NAMES, TOOLS_OFF_TEXT, choiceKey, toolsOffInChat, useModelCatalog, type ModelChoice, type ProviderSection } from "./catalog";

export interface ModelPickerProps {
  /** What is chosen now (null = nothing yet). */
  value: { provider: string; model: string } | null;
  onPick: (choice: ModelChoice) => void;
  /** Accessible name of the button and the list. */
  label: string;
  /** The button's content; the composer shows the model, "retry" shows an action. */
  children: ReactNode;
  buttonClassName?: string;
  onOpenSettings?: () => void;
  disabled?: boolean;
  /** Say what each provider can use in chat (folders and tools, or found passages). Off for notes and brief. */
  showCapabilities?: boolean;
}

/**
 * Any configured provider: subscriptions (Claude, Codex, Antigravity), cloud keys and local
 * servers, grouped, filterable, each saying what it can use. Our own listbox (no native select).
 */
export function ModelPicker({ value, onPick, label, children, buttonClassName, onOpenSettings, disabled, showCapabilities = true }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const filter = useRef<HTMLInputElement | null>(null);
  const uid = useId();
  const sections = useModelCatalog(open, value);
  const { setEl, size } = useMeasured<HTMLDivElement>(open ? `${query}:${sections.length}` : null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sections;
    return sections
      .map((s) => {
        const whole = s.label.toLowerCase().includes(q);
        return { ...s, models: whole ? s.models : s.models.filter((m) => m.label.toLowerCase().includes(q) || m.model.toLowerCase().includes(q)) };
      })
      .filter((s) => s.models.length > 0 || s.label.toLowerCase().includes(q));
  }, [sections, query]);

  const rows = useMemo(() => visible.flatMap((s) => s.models), [visible]);
  const starts = useMemo(() => {
    let n = 0;
    return visible.map((s) => {
      const at = n;
      n += s.models.length;
      return at;
    });
  }, [visible]);
  const activeId = rows[active] ? `${uid}-o${active}` : undefined;

  const close = useCallback((restore: boolean) => {
    setOpen(false);
    setQuery("");
    if (restore) trigger.current?.focus();
  }, []);
  useDismiss(open, [box, trigger], () => close(false));

  const openList = () => {
    if (disabled) return;
    if (trigger.current) setAnchor(anchorOf(trigger.current));
    const at = rows.findIndex((m) => value && m.provider === value.provider && m.model === value.model);
    setActive(Math.max(at, 0));
    setOpen(true);
  };

  useEffect(() => {
    if (open) filter.current?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (active >= rows.length) setActive(Math.max(rows.length - 1, 0));
  }, [rows.length, active]);
  useEffect(() => {
    if (open && activeId) document.getElementById(activeId)?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeId]);

  const choose = (m: ModelChoice) => {
    onPick(m);
    close(true);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Home" && e.ctrlKey) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End" && e.ctrlKey) {
      e.preventDefault();
      setActive(Math.max(rows.length - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (rows[active]) choose(rows[active]);
    } else if (e.key === "Tab") {
      close(false);
    }
  };

  const pos = anchor ? placeBox(anchor, size, { align: "start", gap: 6, prefer: "above" }) : null;

  return (
    <>
      <button
        ref={trigger}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => (open ? close(false) : openList())}
        className={buttonClassName}
      >
        {children}
      </button>
      {open && pos && (
        <Portal>
          <div
            ref={(el) => {
              box.current = el;
              setEl(el);
            }}
            style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 60, width: "min(22rem, calc(100vw - 16px))" }}
            className="ui-pop-in flex max-h-[min(26rem,70vh)] flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-[0_12px_32px_-12px_rgba(0,0,0,0.55)]"
          >
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <input
                ref={filter}
                role="combobox"
                aria-expanded="true"
                aria-controls={`${uid}-list`}
                aria-activedescendant={activeId}
                aria-label={`Filter ${label.toLowerCase()}`}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={onKey}
                placeholder="Filter models"
                className="ui-body min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground/70"
              />
            </div>
            <div id={`${uid}-list`} role="listbox" aria-label={label} className="min-h-0 flex-1 overflow-y-auto py-1">
              {visible.length === 0 && <p className="ui-body px-3 py-3 text-muted-foreground">No provider is set up yet. Add a key or sign in under LLM providers in settings.</p>}
              {visible.map((s, i) => (
                <Section
                  key={s.provider}
                  section={s}
                  firstOfGroup={i === 0 || visible[i - 1].group !== s.group}
                  uid={uid}
                  value={value}
                  startIndex={starts[i]}
                  active={active}
                  onHover={setActive}
                  onChoose={choose}
                  onOpenSettings={onOpenSettings}
                  showCapabilities={showCapabilities}
                />
              ))}
            </div>
          </div>
        </Portal>
      )}
    </>
  );
}

function Section({
  section,
  firstOfGroup,
  uid,
  value,
  startIndex,
  active,
  onHover,
  onChoose,
  onOpenSettings,
  showCapabilities,
}: {
  showCapabilities: boolean;
  section: ProviderSection;
  firstOfGroup: boolean;
  uid: string;
  value: { provider: string; model: string } | null;
  startIndex: number;
  active: number;
  onHover: (i: number) => void;
  onChoose: (m: ModelChoice) => void;
  onOpenSettings?: () => void;
}) {
  const headId = `${uid}-h-${section.provider}`;
  return (
    <>
      {firstOfGroup && (
        <div role="presentation" className="ui-meta px-3 pb-0.5 pt-2 font-semibold text-muted-foreground">
          {GROUP_NAMES[section.group]}
        </div>
      )}
      <div role="group" aria-labelledby={headId}>
        <div id={headId} className="px-3 pb-0.5 pt-1.5">
          <span className="ui-body font-semibold text-foreground">{section.label}</span>
          {showCapabilities && (
            <span className="ui-meta ml-2 text-muted-foreground">{CAPABILITY_TEXT[section.capability]}{toolsOffInChat(section.provider) ? `. ${TOOLS_OFF_TEXT}` : ""}</span>
          )}
        </div>
        {section.loading && <p className="ui-meta px-3 py-1 text-muted-foreground">Loading models</p>}
        {section.error && (
          <p className="ui-meta px-3 py-1 text-muted-foreground">
            Couldn't list models.{" "}
            {onOpenSettings && (
              <button type="button" onClick={onOpenSettings} className="rounded text-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
                Open provider settings
              </button>
            )}
          </p>
        )}
        {section.models.map((m, k) => {
          const i = startIndex + k;
          const selected = !!value && value.provider === m.provider && value.model === m.model;
          return (
            <div
              key={choiceKey(m.provider, m.model)}
              id={`${uid}-o${i}`}
              role="option"
              aria-selected={selected}
              onMouseMove={() => onHover(i)}
              onClick={() => onChoose(m)}
              className={cn(
                "ui-body mx-1 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5",
                i === active ? "bg-accent text-foreground" : "text-foreground/85",
              )}
            >
              <span className="min-w-0 flex-1 truncate">{m.label}</span>
              {selected && <Check className="h-3.5 w-3.5 shrink-0 text-foreground" aria-hidden="true" />}
            </div>
          );
        })}
      </div>
    </>
  );
}

export function PickerCaret() {
  return <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />;
}
