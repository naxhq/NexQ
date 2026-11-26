import { useId, useState } from "react";
import { ChevronRight, Info } from "lucide-react";
import type { ChatCapabilities } from "../../lib/types";
import { cn } from "../../lib/utils";

/**
 * What the backend says this chat can and can't do: exactly which tools are off and why, kept to
 * one quiet line with the reasons a click away. Nothing here is guessed from the provider's name.
 */
export function CapabilityNotes({ caps }: { caps: ChatCapabilities }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const off = caps.tools_off ?? [];
  const notes = caps.notes ?? [];
  // `can_ask` only says whether the CLI can ask before a tool; it never decides whether the chat runs.
  if (off.length === 0 && notes.length === 0) return null;
  return (
    <div className="space-y-1">
      {off.length > 0 && (
        <div className="ui-meta text-muted-foreground">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls={id}
            className="inline-flex items-center gap-1.5 rounded text-left outline-none hover:text-foreground ui-focus ui-focus-sm"
          >
            <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform motion-reduce:transition-none", open && "rotate-90")} aria-hidden="true" />
            {off.length === 1 ? `${off[0].tool} is off` : `${off.length} tools are off`}
          </button>
          {open && (
            <ul id={id} aria-label="Tools that are off" className="mt-1 space-y-0.5 pl-[1.1rem]">
              {off.map((t) => (
                <li key={t.tool}>
                  <span className="font-medium text-foreground/90">{t.tool}</span>: {t.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {notes.map((n) => (
        <p key={n} className="ui-meta flex items-start gap-1.5 text-muted-foreground">
          <Info className="mt-[0.2em] h-3 w-3 shrink-0" aria-hidden="true" />
          <span>{n}</span>
        </p>
      ))}
    </div>
  );
}
