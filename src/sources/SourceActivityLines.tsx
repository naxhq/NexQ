import { Info } from "lucide-react";

/** The last few things an answer did with your sources, as quiet lines that fade in. */
export function SourceActivityLines({ lines, max = 3 }: { lines: string[]; max?: number }) {
  if (lines.length === 0) return null;
  const shown = lines.slice(-max);
  return (
    <ul className="space-y-0.5 pl-3.5" aria-live="polite" aria-label="What the answer is doing with your sources">
      {shown.map((line, i) => (
        <li
          key={`${lines.length - shown.length + i}-${line}`}
          className="progress-phase-enter truncate text-meta text-muted-foreground"
          title={line}
        >
          {line}
        </li>
      ))}
    </ul>
  );
}

/** Why sources were not used, or only partly. Quiet, and it stays with the answer. */
export function SourceNotices({ notices }: { notices: string[] }) {
  if (notices.length === 0) return null;
  return (
    <div className="space-y-0.5">
      {notices.map((n) => (
        <p key={n} className="flex items-start gap-1.5 text-meta leading-snug text-muted-foreground/80">
          <Info className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
          <span>{n}</span>
        </p>
      ))}
    </div>
  );
}
