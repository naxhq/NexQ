import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { anchorOf, placeBox } from "../ui/portal";
import { Clock3 } from "lucide-react";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";
import { CHIP_BASE, CHIP_OFF, CHIP_OPEN } from "./chipStyles";
import {
  DEFAULT_CONTEXT_SCOPE,
  MAX_MINUTES,
  MIN_MINUTES,
  MINUTE_PRESETS,
  SCOPE_KINDS,
  clampMinutes,
  scopeChipLabel,
} from "../lib/contextScope";
import type { ContextScopeKind, ContextScopeSetting } from "../lib/types";
import { cliAgentName, isCliAgent } from "../lib/cliAgents";

const OPTION_LABEL: Record<ContextScopeKind, string> = {
  default: "Action default",
  since_last_any: "Since last answer",
  since_last_same: "Since last same action",
  minutes: "Last",
  all: "Whole meeting",
};

const OPTION_HINT: Record<ContextScopeKind, string> = {
  default: "Each action's own transcript window",
  since_last_any: "New talk since any answer",
  since_last_same: "New talk since this action ran",
  minutes: "",
  all: "Everything said so far",
};

const POPOVER_WIDTH = 232;

/** Next/previous minute preset from `minutes` (custom values snap to the nearest step). */
function stepMinutes(minutes: number, dir: 1 | -1): number {
  const presets = [...MINUTE_PRESETS];
  if (dir === 1) return presets.find((p) => p > minutes) ?? presets[presets.length - 1];
  return [...presets].reverse().find((p) => p < minutes) ?? presets[0];
}

/**
 * Chip at the end of the overlay action row: which part of the meeting the
 * next actions focus on. Opens a small popover with the scopes, minute
 * presets (+ custom) and "Keep for next actions".
 */
export function ContextScopePicker() {
  const scope = useConfigStore((s) => s.contextScope ?? DEFAULT_CONTEXT_SCOPE);
  const sticky = useConfigStore((s) => s.contextScopeSticky ?? true);
  const setScope = useConfigStore((s) => s.setContextScope);
  const setSticky = useConfigStore((s) => s.setContextScopeSticky);
  const agentName = useConfigStore((s) => (isCliAgent(s.llmProvider) ? cliAgentName(s.llmProvider) : null));
  // A CLI agent ignores per-action windows: its session holds the whole meeting.
  const defaultHint = agentName ? `${agentName} decides from the whole meeting` : OPTION_HINT.default;
  const openActionSettings = () => {
    setOpen(false);
    useMeetingStore.getState().openSettings("ai_actions");
  };

  const [open, setOpen] = useState(false);
  const [focusIdx, setFocusIdx] = useState(0);
  const [customText, setCustomText] = useState("");
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight?: number }>({ top: 0, left: 0 });
  const chipRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const isCustomMinutes = !(MINUTE_PRESETS as readonly number[]).includes(scope.minutes);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) chipRef.current?.focus();
  }, []);

  const openPicker = useCallback(() => {
    setFocusIdx(Math.max(0, SCOPE_KINDS.indexOf(scope.kind)));
    setCustomText(isCustomMinutes ? String(scope.minutes) : "");
    setOpen(true);
  }, [scope, isCustomMinutes]);

  // Anchor to the chip with the shared placement (flip, shift, max-height), inside the window.
  useLayoutEffect(() => {
    if (!open || !chipRef.current) return;
    const p = placeBox(anchorOf(chipRef.current), { width: POPOVER_WIDTH, height: popRef.current?.offsetHeight ?? 0 }, { align: "end" });
    setPos({ top: p.top, left: p.left, maxHeight: p.maxHeight });
  }, [open]);

  // Focus the selected option on open (and follow arrow-key focus).
  useEffect(() => {
    if (open) optionRefs.current[focusIdx]?.focus();
  }, [open, focusIdx]);

  // Click outside closes (without stealing focus back).
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

  const choose = useCallback(
    (next: ContextScopeSetting, keepOpen = false) => {
      setScope(next);
      if (!keepOpen) close();
    },
    [setScope, close],
  );

  const commitCustom = useCallback(() => {
    const n = Number(customText);
    if (!customText.trim() || !Number.isFinite(n)) return;
    choose({ kind: "minutes", minutes: clampMinutes(n) });
  }, [customText, choose]);

  // Keys inside the popover never reach the window-level action shortcuts.
  const onPopoverKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  const onOptionKeyDown = (e: React.KeyboardEvent, idx: number) => {
    const kind = SCOPE_KINDS[idx];
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setFocusIdx((idx + 1) % SCOPE_KINDS.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        setFocusIdx((idx - 1 + SCOPE_KINDS.length) % SCOPE_KINDS.length);
        break;
      case "Home":
        e.preventDefault();
        setFocusIdx(0);
        break;
      case "End":
        e.preventDefault();
        setFocusIdx(SCOPE_KINDS.length - 1);
        break;
      case "ArrowRight":
      case "ArrowLeft":
        if (kind === "minutes") {
          e.preventDefault();
          choose({ kind: "minutes", minutes: stepMinutes(scope.minutes, e.key === "ArrowRight" ? 1 : -1) }, true);
        }
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        choose({ kind, minutes: scope.minutes });
        break;
    }
  };

  const active = scope.kind !== "default";
  const chipLabel = scopeChipLabel(scope);
  const oneOff = active && !sticky;

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        onClick={() => (open ? close() : openPicker())}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
            e.preventDefault();
            e.stopPropagation();
            if (!open) openPicker();
          }
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Transcript scope: ${chipLabel}${oneOff ? ", next action only" : ""}`}
        
        data-chip=""
        className={`ml-auto shrink-0 ${CHIP_BASE} ${
          active
            ? "bg-primary/10 text-primary/90 ring-1 ring-inset ring-primary/20 hover:bg-primary/15"
            : open
              ? CHIP_OPEN
              : CHIP_OFF
        }`}
      >
        <Clock3 className="h-3 w-3" aria-hidden="true" />
        <span className="max-w-[7.5rem] truncate">{chipLabel}</span>
        {oneOff && <span className="text-primary/50" aria-hidden="true">· once</span>}
      </button>

      {open &&
        createPortal(
          <div
            ref={popRef}
            role="dialog"
            aria-label="Transcript scope"
            onKeyDown={onPopoverKeyDown}
            style={{ top: pos.top, left: pos.left, width: POPOVER_WIDTH, maxHeight: pos.maxHeight, overflowY: "auto" }}
            className="scope-pop-enter fixed z-50 rounded-xl border border-border/30 bg-popover p-1.5 shadow-2xl"
          >
            <p className="px-2 pb-1 pt-0.5 text-[0.6rem] font-medium uppercase tracking-widest text-muted-foreground/45">
              Focus the next answers on
            </p>
            <div role="radiogroup" aria-label="Transcript scope" className="flex flex-col">
              {SCOPE_KINDS.map((kind, idx) => {
                const checked = scope.kind === kind;
                return (
                  <div key={kind}>
                    <button
                      ref={(el) => {
                        optionRefs.current[idx] = el;
                      }}
                      type="button"
                      role="radio"
                      aria-checked={checked}
                      tabIndex={idx === focusIdx ? 0 : -1}
                      onClick={() => choose({ kind, minutes: scope.minutes })}
                      onKeyDown={(e) => onOptionKeyDown(e, idx)}
                      onFocus={() => setFocusIdx(idx)}
                      className={`group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-150 ${
                        checked ? "bg-primary/10" : "hover:bg-accent/40"
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className={`flex h-3 w-3 shrink-0 items-center justify-center rounded-full border transition-colors duration-150 ${
                          checked ? "border-primary/70" : "border-muted-foreground/30"
                        }`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full bg-primary transition-transform duration-200 ${
                            checked ? "scale-100" : "scale-0"
                          }`}
                        />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={`block text-xs ${checked ? "text-foreground" : "text-foreground/80"}`}>
                          {kind === "minutes" ? `Last ${clampMinutes(scope.minutes)} min` : OPTION_LABEL[kind]}
                        </span>
                        {(kind === "default" ? defaultHint : OPTION_HINT[kind]) && (
                          <span className="block truncate text-meta text-muted-foreground/50">
                            {kind === "default" ? defaultHint : OPTION_HINT[kind]}
                          </span>
                        )}
                      </span>
                    </button>

                    {kind === "minutes" && (
                      <div className="flex items-center gap-1 pb-1 pl-7 pr-2" role="group" aria-label="Minutes">
                        {MINUTE_PRESETS.map((m) => {
                          const on = scope.kind === "minutes" && scope.minutes === m;
                          return (
                            <button
                              key={m}
                              type="button"
                              tabIndex={-1}
                              onClick={() => choose({ kind: "minutes", minutes: m })}
                              aria-label={`Last ${m} minutes`}
                              aria-pressed={on}
                              className={`h-5 min-w-[1.5rem] rounded-md px-1 text-meta tabular-nums transition-colors duration-150 ${
                                on
                                  ? "bg-primary/15 text-primary"
                                  : "text-muted-foreground/60 hover:bg-accent/50 hover:text-foreground"
                              }`}
                            >
                              {m}
                            </button>
                          );
                        })}
                        <input
                          type="number"
                          inputMode="numeric"
                          min={MIN_MINUTES}
                          max={MAX_MINUTES}
                          value={customText}
                          placeholder="…"
                          onChange={(e) => setCustomText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              commitCustom();
                            }
                          }}
                          aria-label={`Custom minutes (${MIN_MINUTES} to ${MAX_MINUTES})`}
                          className={`h-5 w-9 rounded-md border bg-transparent px-1 text-center text-meta tabular-nums text-foreground/80 outline-none transition-colors duration-150 placeholder:text-muted-foreground/40 ui-focus [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none ${
                            scope.kind === "minutes" && isCustomMinutes ? "border-primary" : "border-input"
                          }`}
                        />
                        <span className="text-meta text-muted-foreground/40">min</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <p className="px-2 pb-1 pt-1.5 text-meta leading-snug text-muted-foreground/55">
              {agentName ? (
                `${agentName}'s live session already holds the whole meeting; each request sends only new lines. This only tells it where to focus.`
              ) : (
                <>
                  Each action's window is set in{" "}
                  <button
                    type="button"
                    onClick={openActionSettings}
                    className="cursor-pointer text-primary/80 underline-offset-2 hover:text-primary hover:underline"
                  >
                    Settings → AI Actions
                  </button>
                  .
                </>
              )}
            </p>

            <div className="mt-1 flex items-center justify-between gap-2 border-t border-border/15 px-2 pb-0.5 pt-2">
              <span className="text-xs text-foreground/75">Keep for next actions</span>
              <button
                type="button"
                role="switch"
                aria-checked={sticky}
                aria-label="Keep for next actions"
                onClick={() => setSticky(!sticky)}
                className={`relative h-4 w-7 shrink-0 cursor-pointer rounded-full transition-colors duration-200 ${
                  sticky ? "bg-primary/80" : "bg-muted"
                }`}
              >
                <span
                  className={`absolute left-0.5 top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-transform duration-200 ${
                    sticky ? "translate-x-3" : "translate-x-0"
                  }`}
                />
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
