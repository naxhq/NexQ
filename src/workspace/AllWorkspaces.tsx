import { useEffect, useMemo, useState } from "react";
import { MoreHorizontal, Pin, Plus, Search } from "lucide-react";
import { Menu, Select, Switch, buttonClass } from "../ui";
import { MeetingWave, VoiceprintMark } from "../voiceprint";
import { listWorkspaceMeetings } from "../lib/ipc";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { formatRelativeTime, cn } from "../lib/utils";
import type { MeetingSummary, WorkspaceSummary } from "../lib/types";
import { useWorkspaceActions } from "./WorkspaceActions";
import { fieldClass, hintClass, iconButtonClass } from "./styles";

export type WorkspaceSort = "manual" | "name" | "activity" | "meetings";

/** Pinned ones stay first in every order; archived ones come last. */
export function sortWorkspaces(list: WorkspaceSummary[], sort: WorkspaceSort): WorkspaceSummary[] {
  const key = (a: WorkspaceSummary, b: WorkspaceSummary) => {
    switch (sort) {
      case "name":
        return a.name.localeCompare(b.name);
      case "activity":
        return (b.last_activity ?? 0) - (a.last_activity ?? 0);
      case "meetings":
        return b.meeting_count - a.meeting_count;
      default:
        return a.sort - b.sort || a.name.localeCompare(b.name);
    }
  };
  return [...list].sort(
    (a, b) => Number(a.archived) - Number(b.archived) || Number(b.pinned) - Number(a.pinned) || key(a, b) || a.name.localeCompare(b.name),
  );
}

export function describeActivity(w: Pick<WorkspaceSummary, "last_activity">): string {
  return w.last_activity ? `Active ${formatRelativeTime(new Date(w.last_activity).toISOString())}` : "No activity yet";
}

export function describeCounts(w: Pick<WorkspaceSummary, "meeting_count" | "item_count" | "chat_count">): string {
  const p = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return [p(w.meeting_count, "meeting", "meetings"), p(w.item_count, "file or tool", "files and tools"), p(w.chat_count, "chat", "chats")].join(", ");
}

/** Each workspace's recent meetings, for its wave. Reloads when workspaces change. */
function useWaves(ids: string[]): Record<string, MeetingSummary[]> {
  const revision = useWorkspaceStore((s) => s.revision);
  const [waves, setWaves] = useState<Record<string, MeetingSummary[]>>({});
  const key = ids.join("|");
  useEffect(() => {
    let live = true;
    for (const id of key ? key.split("|") : []) {
      listWorkspaceMeetings(id, null, 40, 0)
        .then((page) => live && setWaves((cur) => ({ ...cur, [id]: page.meetings })))
        .catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [key, revision]);
  return waves;
}

const SORTS: Array<{ value: WorkspaceSort; label: string }> = [
  { value: "manual", label: "My order" },
  { value: "name", label: "Name" },
  { value: "activity", label: "Last activity" },
  { value: "meetings", label: "Most meetings" },
];

/**
 * Every workspace as a typographic index: name and what it is for, its mark,
 * its meetings as a wave, when it was last used. A list, not a grid of cards.
 */
export function AllWorkspaces({ onOpenMeeting }: { onOpenMeeting: (workspaceId: string, meetingId: string) => void }) {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);
  const actions = useWorkspaceActions();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<WorkspaceSort>("manual");
  const [showArchived, setShowArchived] = useState(false);

  const archivedCount = workspaces.filter((w) => w.archived).length;
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = workspaces.filter(
      (w) => (showArchived || !w.archived) && (!q || w.name.toLowerCase().includes(q) || w.description.toLowerCase().includes(q)),
    );
    return sortWorkspaces(list, sort);
  }, [workspaces, query, sort, showArchived]);
  const waves = useWaves(shown.map((w) => w.id));

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 pb-12 pt-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="ui-title text-foreground">Workspaces</h1>
            <p className="ui-body mt-1 text-muted-foreground">
              {workspaces.filter((w) => !w.archived).length} {workspaces.filter((w) => !w.archived).length === 1 ? "workspace" : "workspaces"}. Each keeps its meetings, chats and files apart.
            </p>
          </div>
          <button type="button" onClick={actions.create} className={`${buttonClass.base} ${buttonClass.primary} h-9 gap-1.5 px-4`}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            New workspace
          </button>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <div className="relative min-w-[12rem] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search workspaces"
              aria-label="Search workspaces"
              className={cn(fieldClass, "h-9 pl-8")}
            />
          </div>
          <div className="w-44">
            <Select label="Sort by" value={sort} onChange={(v) => setSort(v as WorkspaceSort)} options={SORTS} />
          </div>
          {archivedCount > 0 && <Switch checked={showArchived} onChange={setShowArchived} label={`Show archived (${archivedCount})`} />}
        </div>

        <ul className="mt-4 divide-y divide-border border-y border-border" aria-label="All workspaces">
          {shown.map((w) => {
            const meetings = waves[w.id] ?? [];
            return (
              <li key={w.id} className={cn("group py-5", w.archived && "opacity-70")}>
                <div className="flex items-start gap-4">
                  <VoiceprintMark id={w.id} hue={w.color} size={30} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => openWorkspace(w.id)}
                        className="truncate rounded text-left text-[1.0625rem] font-semibold leading-snug text-foreground outline-none hover:underline hover:underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring/60"
                      >
                        {w.name}
                      </button>
                      {w.pinned && <Pin className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Pinned" />}
                      {w.is_default && <span className={hintClass}>Default</span>}
                      {w.keep_separate && <span className={hintClass}>Kept separate</span>}
                      {w.archived && <span className={hintClass}>Archived</span>}
                    </div>
                    {w.description && <p className="ui-body ui-measure mt-0.5 text-muted-foreground">{w.description}</p>}
                    <p className={`${hintClass} mt-1`}>
                      {describeCounts(w)}. {describeActivity(w)}.
                    </p>
                    {meetings.length > 0 && (
                      <div className="mt-3 max-w-md">
                        <MeetingWave
                          meetings={meetings.map((m) => ({ id: m.id, title: m.title, date: m.start_time, duration_seconds: m.duration_seconds }))}
                          hue={w.color}
                          height={20}
                          onOpen={(id) => onOpenMeeting(w.id, id)}
                        />
                      </div>
                    )}
                  </div>
                  <Menu
                    label={`${w.name} actions`}
                    items={actions.menuFor(w, { canMove: sort === "manual" && !w.archived })}
                    align="end"
                    renderTrigger={(props) => (
                      <button type="button" {...props} className={iconButtonClass} aria-label={`Actions for ${w.name}`}>
                        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                      </button>
                    )}
                  />
                </div>
              </li>
            );
          })}
          {shown.length === 0 && (
            <li className="py-10 text-center">
              <p className="ui-section text-foreground">{query ? "No workspace matches that" : "No workspaces yet"}</p>
              <p className="ui-body mt-1 text-muted-foreground">{query ? "Try another word." : "Make one for a job, a client or a course."}</p>
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
