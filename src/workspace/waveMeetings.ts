import type { MeetingSummary } from "../lib/types";
import type { WaveMeeting } from "../voiceprint";

/** How many single meetings the wave draws before older ones are gathered by month. */
export const WAVE_SINGLES = 60;
export const AGG_PREFIX = "agg:";

const monthKey = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

/**
 * Every meeting of the workspace as bars: the newest `max` one each, older ones
 * gathered into one bar per month (its length is their total, its title says
 * how many). Nothing is dropped, so a long history is still all there.
 */
export function waveMeetings(meetings: MeetingSummary[], max = WAVE_SINGLES): WaveMeeting[] {
  const byNew = [...meetings].sort((a, b) => new Date(b.start_time).getTime() - new Date(a.start_time).getTime());
  const singles = byNew.slice(0, max);
  const older = byNew.slice(max);
  const out: WaveMeeting[] = singles.map((m) => ({ id: m.id, title: m.title, date: m.start_time, duration_seconds: m.duration_seconds }));
  const groups = new Map<string, MeetingSummary[]>();
  for (const m of older) groups.set(monthKey(m.start_time), [...(groups.get(monthKey(m.start_time)) ?? []), m]);
  for (const [key, list] of groups) {
    const oldest = list.reduce((a, b) => (new Date(a.start_time) < new Date(b.start_time) ? a : b));
    const total = list.reduce((n, m) => n + (m.duration_seconds ?? 0), 0);
    out.push({
      id: `${AGG_PREFIX}${key}`,
      title: `${list.length} earlier ${list.length === 1 ? "meeting" : "meetings"}`,
      date: oldest.start_time,
      duration_seconds: total || null,
    });
  }
  return out;
}
