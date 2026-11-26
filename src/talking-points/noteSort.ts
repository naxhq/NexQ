/** The orders the notes list can take. "Manual" is the order the owner dragged them into. */
import type { TalkingPoint } from "../lib/types";
import type { NoteSort } from "../stores/talkingPointsStore";

export const SORT_OPTIONS: ReadonlyArray<{ id: NoteSort; label: string }> = [
  { id: "manual", label: "Manual order (drag)" },
  { id: "newest", label: "Newest first" },
  { id: "oldest", label: "Oldest first" },
  { id: "edited", label: "Recently edited" },
  { id: "az", label: "A to Z" },
];

/** The short name shown on the sort button. */
export const SORT_SHORT: Record<NoteSort, string> = {
  manual: "Manual order",
  newest: "Newest first",
  oldest: "Oldest first",
  edited: "Recently edited",
  az: "A to Z",
};

/** A copy of `notes` in the chosen order. Ties keep the manual order (the sort is stable). */
export function sortNotes(notes: readonly TalkingPoint[], sort: NoteSort): TalkingPoint[] {
  const out = [...notes];
  switch (sort) {
    case "newest":
      return out.sort((a, b) => b.created_at - a.created_at);
    case "oldest":
      return out.sort((a, b) => a.created_at - b.created_at);
    case "edited":
      return out.sort((a, b) => b.updated_at - a.updated_at);
    case "az":
      return out.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true }));
    default:
      return out;
  }
}
