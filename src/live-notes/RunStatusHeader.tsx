import type { ReactNode } from "react";

export type RunKind = "notes" | "brief";
export type RunStatusName = "off" | "idle" | "running" | "paused" | "capped" | "error" | "finished";

/** One set of words for what a helper (notes or brief) is doing. */
export function runWords(kind: RunKind, status: RunStatusName | undefined, enabled: boolean, opts: { manual?: boolean } = {}): { word: string; note?: string } {
  if (!enabled) return { word: "Off" };
  switch (status) {
    case "running":
      return { word: kind === "notes" ? "Taking notes" : "Checking the workspace" };
    case "paused":
    case "capped":
      return { word: "Paused" };
    case "error":
    case "finished":
    case "off":
      return { word: "Stopped" };
    default:
      return opts.manual ? { word: "Waiting for you", note: "press Update now" } : { word: "Waiting for speech" };
  }
}

/**
 * Title, state in words, and the panel's controls. The state is spoken once
 * when it changes (a separate status region), never as the page updates.
 */
export function RunStatusHeader({ title, word, note, children }: { title: string; word: string; note?: string; children?: ReactNode }) {
  return (
    <header className="rs-head">
      <div className="rs-status">
        {/* The dock tab already names the panel: the title stays for assistive tech only. */}
        <h2 className="rs-title rs-sr">{title}</h2>
        <span className="rs-state" aria-hidden="true">
          {word}
          {note && <span className="rs-status-note">{`, ${note}`}</span>}
        </span>
        <span role="status" className="rs-sr">{`${title}: ${word}`}</span>
      </div>
      {children}
    </header>
  );
}
