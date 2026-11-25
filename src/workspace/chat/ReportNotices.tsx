import { Info } from "lucide-react";

/**
 * The notes a context report carries ("Still indexing 312 of 540", "Earlier messages condensed",
 * a small window). They sit with the answer and before asking, and never go away behind an action.
 */
export function ReportNotices({ notices, className }: { notices: string[] | null | undefined; className?: string }) {
  const list = Array.isArray(notices) ? notices.filter((n) => typeof n === "string" && n.trim()) : [];
  if (list.length === 0) return null;
  return (
    <ul aria-label="Notes about this answer" className={className ?? "mt-2 space-y-0.5"}>
      {list.map((n) => (
        <li key={n} className="ui-meta flex items-start gap-1.5 text-muted-foreground">
          <Info className="mt-[0.2em] h-3 w-3 shrink-0" aria-hidden="true" />
          <span>{n}</span>
        </li>
      ))}
    </ul>
  );
}
