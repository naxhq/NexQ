import { useEffect, useId, useRef, useState } from "react";
import { cn } from "../lib/utils";

export interface InlineEditProps {
  value: string;
  /** Called with the trimmed new text; not called when nothing changed or `validate` fails. */
  onCommit: (value: string) => void;
  /** What is being renamed, for the accessible name ("Rename Acme"). */
  label: string;
  placeholder?: string;
  /** Return an error text to refuse the value. */
  validate?: (value: string) => string | null;
  allowEmpty?: boolean;
  maxLength?: number;
  /** Classes for the text in both modes (size, weight). */
  className?: string;
}

/**
 * Text that becomes a field when you click it (or press Enter or F2 on it).
 * Enter or leaving saves, Escape puts the old text back.
 */
export function InlineEdit({
  value,
  onCommit,
  label,
  placeholder = "Untitled",
  validate,
  allowEmpty = false,
  maxLength = 120,
  className,
}: InlineEditProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const cancelled = useRef(false);
  const errId = useId();

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editing]);

  const finish = (save: boolean, refocus: boolean) => {
    if (save) {
      const next = draft.trim();
      if (!next && !allowEmpty) {
        setError("A name is needed");
        return false;
      }
      const problem = validate?.(next) ?? null;
      if (problem) {
        setError(problem);
        return false;
      }
      if (next !== value) onCommit(next);
    }
    setError(null);
    setEditing(false);
    if (refocus) requestAnimationFrame(() => button.current?.focus());
    return true;
  };

  if (!editing) {
    return (
      <button
        ref={button}
        type="button"
        aria-label={`Rename ${label}`}
        onClick={() => {
          cancelled.current = false;
          setEditing(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "F2") {
            e.preventDefault();
            setEditing(true);
          }
        }}
        className={cn(
          "max-w-full truncate rounded-md px-1 py-0.5 text-left outline-none ui-focus transition-colors duration-150 hover:bg-accent",
          !value && "text-muted-foreground",
          className,
        )}
      >
        {value || placeholder}
      </button>
    );
  }

  return (
    <span className="inline-flex max-w-full flex-col">
      <input
        ref={input}
        value={draft}
        maxLength={maxLength}
        aria-label={`Rename ${label}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errId : undefined}
        placeholder={placeholder}
        onChange={(e) => {
          setDraft(e.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            finish(true, true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            cancelled.current = true;
            setDraft(value);
            finish(false, true);
          }
        }}
        onBlur={() => {
          if (cancelled.current) return;
          if (!finish(true, false)) finish(false, false);
        }}
        className={cn(
          "min-w-[6ch] rounded-md border border-border bg-background px-1 py-0.5 outline-none ui-focus",
          className,
        )}
      />
      {error && (
        <span id={errId} role="alert" className="ui-meta mt-0.5 text-destructive">
          {error}
        </span>
      )}
    </span>
  );
}
