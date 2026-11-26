import { useState } from "react";
import type { MovedOnline } from "../lib/types";
import { providerLabel } from "../models/labels";

/** One dismissible line: the notes or brief moved to an online provider. */
export function MovedOnlineLine({ moved, what, onDismiss }: { moved: MovedOnline | null | undefined; what: "Notes" | "The brief"; onDismiss?: () => void }) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (!moved) return null;
  const key = `${moved.from}>${moved.to}`;
  if (dismissed === key) return null;
  return (
    <div className="rs-notice" role="status">
      <p style={{ color: "hsl(var(--foreground))" }}>
        {what} now {what === "Notes" ? "use" : "uses"} {providerLabel(moved.to)} (online).
      </p>
      <div className="rs-notice-actions">
        <button type="button" className="rs-tool" onClick={() => {
            setDismissed(key);
            onDismiss?.();
          }}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
