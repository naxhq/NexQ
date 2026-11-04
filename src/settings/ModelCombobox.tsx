import { useEffect, useId, useState } from "react";
import { CheckCircle, ChevronDown } from "lucide-react";
import type { ModelInfo } from "../lib/types";

interface ModelComboboxProps {
  /** The model in use, or the one picked for a provider not yet active. */
  value: string;
  /** Models the provider listed ("Load Models"); empty until then. */
  models: ModelInfo[];
  /** A model was picked from the list, or typed and confirmed (Enter, or leaving the field). */
  onCommit: (model: string) => void;
}

/**
 * The model field: type any model name, or pick one the provider listed.
 * Providers accept models their list leaves out (Ollama Cloud's "-cloud"
 * names, for one), so the list is a suggestion, not a limit.
 */
export function ModelCombobox({ value, models, onCommit }: ModelComboboxProps) {
  const [draft, setDraft] = useState(value);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = useId();

  // A model chosen elsewhere (the footer, another window) shows here.
  useEffect(() => setDraft(value), [value]);

  // The whole list while the field shows the current model; otherwise the
  // models matching what is typed.
  const query = draft.trim().toLowerCase();
  const shown = query && draft !== value
    ? models.filter((m) => m.id.toLowerCase().includes(query) || m.name.toLowerCase().includes(query))
    : models;
  const expanded = open && shown.length > 0;

  const close = () => {
    setOpen(false);
    setActive(-1);
  };

  const commit = (model: string) => {
    const name = model.trim();
    setDraft(name || value);
    close();
    if (name && name !== value) onCommit(name);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setOpen(true);
        setActive((i) => Math.min(i + 1, shown.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive((i) => Math.max(i - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        commit(expanded && active >= 0 ? shown[active].id : draft);
        break;
      case "Escape":
        if (expanded) {
          e.preventDefault();
          close();
        } else {
          setDraft(value);
        }
        break;
    }
  };

  return (
    <div className="relative">
      <input
        type="text"
        role="combobox"
        aria-label="Model"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-activedescendant={expanded && active >= 0 ? `${listId}-${active}` : undefined}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => commit(draft)}
        placeholder={models.length > 0 ? "Type a model name or pick one" : "Type a model name"}
        spellCheck={false}
        autoComplete="off"
        className={`w-full rounded-lg border border-border/50 bg-background px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20 ${
          models.length > 0 ? "pr-10" : ""
        }`}
      />
      {models.length > 0 && (
        <button
          type="button"
          tabIndex={-1}
          aria-label={expanded ? "Hide models" : "Show models"}
          // Keep the focus in the field, so opening the list doesn't commit it.
          onMouseDown={(e) => {
            e.preventDefault();
            if (expanded) {
              close();
            } else {
              setDraft(value);
              setOpen(true);
            }
          }}
          className="absolute right-1 top-1/2 flex h-8 w-8 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`} />
        </button>
      )}
      {expanded && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Models"
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-64 overflow-y-auto rounded-xl border border-border/50 bg-popover py-1 shadow-xl"
        >
          {shown.map((m, i) => {
            const selected = m.id === value;
            return (
              <li
                key={m.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={selected}
                // mousedown, not click: the field keeps the focus and doesn't commit what was typed first.
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(m.id);
                }}
                onMouseEnter={() => setActive(i)}
                className={`flex cursor-pointer items-center gap-2 px-3.5 py-2 text-sm transition-colors ${
                  i === active ? "bg-accent" : ""
                } ${selected ? "text-primary" : "text-foreground"}`}
              >
                <span className="flex-1 truncate">
                  {m.name}
                  {m.context_window ? (
                    <span className="text-muted-foreground"> ({Math.round(m.context_window / 1000)}K ctx)</span>
                  ) : null}
                </span>
                {selected && <CheckCircle className="h-3.5 w-3.5 shrink-0 text-primary" />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
