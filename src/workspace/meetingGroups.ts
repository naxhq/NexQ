import type { MeetingSummary } from "../lib/types";
import { getDateGroup } from "../lib/utils";

export interface MeetingGroup {
  label: string;
  meetings: MeetingSummary[];
}

const LABELS: Record<string, string> = {
  Today: "Today",
  Yesterday: "Yesterday",
  "This Week": "This week",
  Earlier: "Earlier",
};

/** Date groups in reading order; empty groups are left out. Input order is kept inside a group. */
export function groupMeetingsByDate(meetings: MeetingSummary[]): MeetingGroup[] {
  const order = ["Today", "Yesterday", "This Week", "Earlier"];
  const buckets = new Map<string, MeetingSummary[]>(order.map((k) => [k, []]));
  for (const m of meetings) buckets.get(getDateGroup(m.start_time))?.push(m);
  return order
    .map((k) => ({ label: LABELS[k], meetings: buckets.get(k) ?? [] }))
    .filter((g) => g.meetings.length > 0);
}

export type MeetingFilter = "all" | "favorites" | "with_summary" | "online" | "in_person";

export const MEETING_FILTERS: ReadonlyArray<{ key: MeetingFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "favorites", label: "Starred" },
  { key: "with_summary", label: "Summary" },
  { key: "online", label: "Online" },
  { key: "in_person", label: "In person" },
];

export function filterMeetings(list: MeetingSummary[], filter: MeetingFilter, favorites: Set<string>): MeetingSummary[] {
  switch (filter) {
    case "favorites":
      return list.filter((m) => favorites.has(m.id));
    case "with_summary":
      return list.filter((m) => m.has_summary);
    case "online":
      return list.filter((m) => m.audio_mode === "online");
    case "in_person":
      return list.filter((m) => m.audio_mode === "in_person");
    default:
      return list;
  }
}
