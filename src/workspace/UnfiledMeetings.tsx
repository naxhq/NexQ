import { useState } from "react";
import { Button, Menu } from "../ui";
import { showToast } from "../stores/toastStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { formatMeetingWhen } from "./meetingGroups";
import { formatDurationLong } from "../lib/utils";
import { moveMeetingTo } from "./meetingScope";
import { MoveMeetingMenu } from "./MoveMeetingMenu";
import { useUnfiledMeetings } from "./unfiled";

/**
 * "Not filed": meetings that started without a usable workspace. They used none of anyone's files. Each can be
 * filed in a workspace by the normal move, or all of them at once.
 */
export function UnfiledMeetings({ onOpenMeeting }: { onOpenMeeting: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const { meetings, total, loading, hasMore, loadMore } = useUnfiledMeetings(query);
  const workspaces = useWorkspaceStore((s) => s.workspaces).filter((w) => !w.archived);
  const [busy, setBusy] = useState(false);

  const fileAll = async (workspaceId: string, name: string) => {
    setBusy(true);
    let done = 0;
    let failed = 0;
    for (const m of meetings) {
      try {
        await moveMeetingTo(m.id, workspaceId);
        done += 1;
      } catch {
        failed += 1;
      }
    }
    setBusy(false);
    showToast(failed ? `Filed ${done} in ${name}. ${failed} could not be moved.` : `Filed ${done} ${done === 1 ? "meeting" : "meetings"} in ${name}`, failed ? "warning" : "success");
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 pb-12 pt-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="ui-title text-foreground">Not filed</h1>
            <p className="ui-body ui-measure mt-1 text-muted-foreground">
              These meetings aren't in a workspace, so they used none of your files. File each one, or all of them, in a workspace.
            </p>
          </div>
          {total > 1 && (
            <Menu
              label="File all in a workspace"
              align="end"
              items={workspaces.map((w) => ({ id: w.id, label: w.name, onSelect: () => void fileAll(w.id, w.name) }))}
              renderTrigger={(props) => (
                <Button variant="quiet" {...props} disabled={busy}>
                  File all in…
                </Button>
              )}
            />
          )}
        </div>

        {(total > 5 || query) && (
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search meetings that are not filed"
            aria-label="Search meetings that are not filed"
            className="ui-body mt-5 h-9 w-full rounded-lg border border-input bg-background px-3 text-foreground outline-none ui-focus placeholder:text-muted-foreground/70"
          />
        )}

        <ul className="mt-6 divide-y divide-border border-y border-border" aria-label="Meetings that are not filed">
          {meetings.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-4 py-3">
              <button
                type="button"
                onClick={() => onOpenMeeting(m.id)}
                className="min-w-0 rounded text-left outline-none ui-focus ui-focus-sm"
              >
                <span className="ui-body block truncate font-medium text-foreground">{m.title}</span>
                <span className="ui-meta block text-muted-foreground">
                  {formatMeetingWhen(m.start_time)}
                  {m.duration_seconds ? `, ${formatDurationLong(m.duration_seconds * 1000)}` : ""}
                </span>
              </button>
              <MoveMeetingMenu meetingId={m.id} currentWorkspaceId={m.workspace_id} variant="button" buttonLabel="File in…" />
            </li>
          ))}
          {meetings.length === 0 && (
            <li className="py-10 text-center">
              <p className="ui-section text-foreground">{loading ? "Looking" : query ? "Nothing found" : "Everything is filed"}</p>
              {!loading && <p className="ui-body mt-1 text-muted-foreground">{query ? "No meeting that is not filed matches that." : "Every meeting is in a workspace."}</p>}
            </li>
          )}
        </ul>
        {hasMore && (
          <Button variant="ghost" className="mt-3" onClick={loadMore} aria-label="Show more meetings that are not filed">
            Show more
          </Button>
        )}
      </div>
    </div>
  );
}
