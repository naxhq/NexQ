import { CircleDashed, Gavel, Lightbulb, SlidersHorizontal, User } from "lucide-react";
import type { MemoryItem, MemoryKind } from "../lib/types";
import type { KindLook } from "../workspace/libraryKinds";

/*
 * What a remembered item is, as a small tag: an icon and its word in the kind's colour. Like the Library's kinds, one
 * neutral (a fact: the common case) and a few restrained accents that each mean one thing: rose for a person, blue for
 * a decision, violet for a preference, amber for something still open. Text tokens only, so they hold 4.5:1 in both
 * themes (see `lib/contrast.test.ts`); the tile is the same colour at 12%; the word always sits beside the icon.
 */
export const MEMORY_LOOK: Record<MemoryKind, KindLook> = {
  person: { word: "Person", Icon: User, text: "text-rose-500", tile: "bg-[hsl(var(--rose-text)/0.12)]" },
  decision: { word: "Decision", Icon: Gavel, text: "text-primary", tile: "bg-[hsl(var(--primary-text)/0.12)]" },
  open_item: { word: "Open item", Icon: CircleDashed, text: "text-warning", tile: "bg-[hsl(var(--warning-text)/0.12)]" },
  fact: { word: "Fact", Icon: Lightbulb, text: "text-muted-foreground", tile: "bg-muted" },
  preference: { word: "Preference", Icon: SlidersHorizontal, text: "text-violet-500", tile: "bg-[hsl(var(--violet-text)/0.12)]" },
};

export function memoryLook(kind: MemoryKind): KindLook {
  return MEMORY_LOOK[kind] ?? MEMORY_LOOK.fact;
}

/**
 * A suggestion made from a transcript line can begin with that line's own label ("0:54 You  We agreed...").
 * The chip beside it already says where and when, so the label is dropped for display. The stored text is never changed.
 */
const LEAKED_LABEL = /^\s*\[?(?:\d{1,2}:)?\d{1,2}:\d{2}\]?\s+(?:You|Them|Me|Speaker\s*\d+|Interviewer|Interviewee|Host|Guest)\b\s*[:\-–—]?\s*/i;

export function displayText(text: string): string {
  const cleaned = text.replace(LEAKED_LABEL, "");
  return cleaned.trim() ? cleaned : text;
}

/** One line of a memory's text for its row: label removed, whitespace flattened. */
export function oneLine(text: string): string {
  return displayText(text).replace(/\s+/g, " ").trim();
}

export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Newest first, as the panel lists them; kinds are told apart by their tags, not by headings. */
export function savedItems(items: MemoryItem[]): MemoryItem[] {
  return items.filter((m) => m.status === "saved").sort((a, b) => b.updated_at - a.updated_at);
}
