import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Languages } from "lucide-react";
import { STT_LANGUAGES, SAME_AS_SHARED_LANGUAGE } from "../lib/sttLanguages";
import { languageLabel, languageShortLabel } from "../lib/sideLanguage";
import { useSideLanguages, type LanguageSide } from "../hooks/useSideLanguages";

const POPOVER_WIDTH = 248;
const MAX_LIST_HEIGHT = 224;

/**
 * Chip beside a side's mute button: the language that side is transcribed in.
 * Opens a small list to change it without leaving the meeting; transcription
 * restarts by itself, for that side only. The same setting as Settings > Audio & Devices.
 * Renders nothing for "You" in an in-person meeting (the room is transcribed as "Room").
 */
export function SideLanguagePicker({ side }: { side: LanguageSide }) {
  const languages = useSideLanguages();
  const info = languages[side];
  const setLanguage = languages.setLanguage;

  const [open, setOpen] = useState(false);
  const [focusIdx, setFocusIdx] = useState(0);
  const [pos, setPos] = useState<{ bottom: number; left: number }>({ bottom: 0, left: 0 });
  const chipRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const options = [
    { value: SAME_AS_SHARED_LANGUAGE, label: `Default: ${info?.sharedLabel ?? ""}` },
    ...STT_LANGUAGES,
  ];

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) chipRef.current?.focus();
  }, []);

  const openPicker = () => {
    const idx = options.findIndex((o) => o.value === (info?.value ?? SAME_AS_SHARED_LANGUAGE));
    setFocusIdx(Math.max(0, idx));
    setOpen(true);
  };

  // Open upward from the footer chip, kept inside the window.
  useLayoutEffect(() => {
    if (!open || !chipRef.current) return;
    const r = chipRef.current.getBoundingClientRect();
    const left = Math.min(r.left, window.innerWidth - POPOVER_WIDTH - 8);
    setPos({ bottom: window.innerHeight - r.top + 6, left: Math.max(8, left) });
  }, [open]);

  useEffect(() => {
    if (open) optionRefs.current[focusIdx]?.focus();
  }, [open, focusIdx]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || chipRef.current?.contains(t)) return;
      close(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, close]);

  if (!info) return null;

  const choose = (value: string) => {
    setLanguage(side, value);
    close();
  };

  // Keys inside the popover never reach the window-level shortcuts.
  const onPopoverKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  const onOptionKeyDown = (e: React.KeyboardEvent, idx: number) => {
    const last = options.length - 1;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setFocusIdx(idx === last ? 0 : idx + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        setFocusIdx(idx === 0 ? last : idx - 1);
        break;
      case "Home":
        e.preventDefault();
        setFocusIdx(0);
        break;
      case "End":
        e.preventDefault();
        setFocusIdx(last);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        choose(options[idx].value);
        break;
    }
  };

  const shown = languageShortLabel(info.effective);
  const full = languageLabel(info.effective);
  const warning = info.notice?.tone === "warning";
  const name = `${info.label} language`;
  const summary = `${name}: ${full}${warning ? `. ${info.notice?.text}` : ""}${info.restarting ? ". Restarting" : ""}`;

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        onClick={() => (open ? close() : openPicker())}
        onKeyDown={(e) => {
          // Keys on the chip never reach the window-level shortcuts (Space runs Assist).
          if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            e.stopPropagation();
            if (!open) openPicker();
          }
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={summary}
        title={summary}
        className={`flex shrink-0 cursor-pointer items-center gap-1 rounded-full px-1.5 py-0.5 text-meta font-medium tabular-nums transition-colors duration-150 ${
          open
            ? "bg-accent/50 text-foreground"
            : "text-muted-foreground/60 hover:bg-accent/40 hover:text-foreground/70"
        }`}
      >
        {warning ? (
          <AlertTriangle className="h-3 w-3 text-amber-500" aria-hidden="true" />
        ) : (
          <Languages className="h-3 w-3" aria-hidden="true" />
        )}
        <span className={info.restarting ? "animate-pulse" : undefined}>
          {info.restarting ? "Restarting…" : shown}
        </span>
      </button>

      {open &&
        createPortal(
          <div
            ref={popRef}
            role="dialog"
            aria-label={name}
            onKeyDown={onPopoverKeyDown}
            style={{ bottom: pos.bottom, left: pos.left, width: POPOVER_WIDTH }}
            className="scope-pop-enter fixed z-50 rounded-xl border border-border/30 bg-popover/95 p-1.5 shadow-2xl backdrop-blur-md"
          >
            <p className="px-2 pb-1 pt-0.5 text-[0.6rem] font-medium uppercase tracking-widest text-muted-foreground/45">
              {info.label} speaks
            </p>
            <div
              role="radiogroup"
              aria-label={name}
              style={{ maxHeight: MAX_LIST_HEIGHT }}
              className="flex flex-col overflow-y-auto"
            >
              {options.map((opt, idx) => {
                const checked = opt.value === info.value;
                return (
                  <button
                    key={opt.value || "default"}
                    ref={(el) => {
                      optionRefs.current[idx] = el;
                    }}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    tabIndex={idx === focusIdx ? 0 : -1}
                    onClick={() => choose(opt.value)}
                    onKeyDown={(e) => onOptionKeyDown(e, idx)}
                    className={`flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-1 text-left text-xs transition-colors duration-150 ${
                      checked
                        ? "bg-accent/60 text-foreground"
                        : "text-muted-foreground/70 hover:bg-accent/50 hover:text-foreground"
                    }`}
                  >
                    <span className="truncate">{opt.label}</span>
                    {checked && <span className="text-meta text-muted-foreground/60" aria-hidden="true">✓</span>}
                  </button>
                );
              })}
            </div>
            {info.restarting && (
              <p role="status" className="px-2 pt-1.5 text-meta text-muted-foreground/70">
                Restarting {info.label}…
              </p>
            )}
            {info.notice && (
              <div
                role={warning ? "alert" : "note"}
                className={
                  warning
                    ? "mt-1.5 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2 py-1.5"
                    : "mt-1.5 px-2 py-1"
                }
              >
                {warning && <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-500" aria-hidden="true" />}
                <p
                  className={`text-meta leading-snug ${warning ? "text-amber-200/80" : "text-muted-foreground/70"}`}
                >
                  {info.notice.text}
                </p>
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
