import { useCallback, useMemo, useState } from "react";
import { ListFilter, Search, X } from "lucide-react";
import { ConfirmDialog, Menu, Segmented } from "../ui";
import { RecentMeetings } from "../launcher/RecentMeetings";
import { deleteMeeting, renameMeeting } from "../lib/ipc";
import { deleteAllInWorkspace, deleteMeetingsById, describeDeleteAll } from "./deleteAll";
import { useMeetingStore } from "../stores/meetingStore";
import { showToast } from "../stores/toastStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import type { WorkspaceSummary } from "../lib/types";
import { cn } from "../lib/utils";
import { useFavorites } from "./favorites";
import { MEETING_FILTERS, filterMeetings, type MeetingFilter } from "./meetingGroups";
import { useWorkspaceMeetings, type MeetingScopeChoice } from "./useWorkspaceMeetings";
import { fieldClass, iconButtonClass } from "./styles";

/**
 * The open workspace's meetings: search (here or everywhere), the filters,
 * stars, rename, delete, delete all, date groups. Everything the old
 * dashboard's list did, per workspace.
 */
export function MeetingList({
  workspace,
  onOpenMeeting,
  query,
  onQueryChange,
}: {
  workspace: WorkspaceSummary;
  onOpenMeeting: (id: string) => void;
  query: string;
  onQueryChange: (q: string) => void;
}) {
  const [scope, setScope] = useState<MeetingScopeChoice>("here");
  const [filter, setFilter] = useState<MeetingFilter>("all");
  const [confirmAll, setConfirmAll] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);
  const activeMeeting = useMeetingStore((s) => s.activeMeeting);
  const loadRecent = useMeetingStore((s) => s.loadRecentMeetings);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const refresh = useWorkspaceStore((s) => s.refresh);
  const { favorites, toggleFavorite } = useFavorites();
  const { meetings, total, loading, error, hasMore, loadMore } = useWorkspaceMeetings(workspace.id, query, scope);

  const shown = useMemo(() => filterMeetings(meetings, filter, favorites), [meetings, filter, favorites]);

  const after = useCallback(async () => {
    await loadRecent();
    await refresh();
  }, [loadRecent, refresh]);

  const onDelete = useCallback(
    async (id: string) => {
      try {
        await deleteMeeting(id);
        await after();
        showToast("Meeting deleted", "info");
      } catch {
        showToast("Couldn't delete meeting", "error");
      }
    },
    [after],
  );

  const onRename = useCallback(
    async (id: string, title: string) => {
      try {
        await renameMeeting(id, title);
      } catch {
        showToast("Couldn't rename meeting", "error");
        return;
      }
      try {
        await after();
      } catch {
        /* the rename is saved; the list refreshes next time */
      }
    },
    [after],
  );

  const deleteAll = async () => {
    setDeletingAll(true);
    try {
      const result =
        scope === "here"
          ? await deleteAllInWorkspace(workspace.id, workspace.meeting_count || total)
          : await deleteMeetingsById(meetings.map((m) => m.id));
      await after();
      showToast(describeDeleteAll(result), result.failed > 0 ? "warning" : "info");
    } catch (e) {
      showToast(`Couldn't delete the meetings: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setDeletingAll(false);
      setConfirmAll(false);
    }
  };

  const everywhere = scope === "everywhere";
  const deleteTargetCount = everywhere ? meetings.length : workspace.meeting_count || total;
  const countText = `${shown.length} ${shown.length === 1 ? "meeting" : "meetings"}${hasMore ? " so far" : ""}`;
  const emptyForFilter = filter !== "all" && meetings.length > 0;

  return (
    <section aria-label="Meetings" className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-2 px-3 pt-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder={everywhere ? "Search all meetings" : `Search in ${workspace.name}`}
            aria-label="Search meetings"
            className={cn(fieldClass, "h-8 pl-8 pr-8 [&::-webkit-search-cancel-button]:hidden")}
          />
          {query && (
            <button type="button" onClick={() => onQueryChange("")} className={cn(iconButtonClass, "absolute right-1 top-1/2 h-6 w-6 -translate-y-1/2")} aria-label="Clear search">
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          )}
        </div>
        <Segmented<MeetingScopeChoice>
          label="Search in"
          value={scope}
          onChange={setScope}
          options={[
            { value: "here", label: "Here" },
            { value: "everywhere", label: "Everywhere" },
          ]}
        />
        <div className="flex items-center justify-between gap-2">
          <p className="ui-meta min-w-0 truncate text-muted-foreground" aria-live="polite">
            {loading && meetings.length === 0 ? "Loading" : countText}
          </p>
          <Menu
            label="Filter meetings"
            align="end"
            items={[
              ...MEETING_FILTERS.map(({ key, label }) => ({
                id: key,
                label: key === "all" ? "All meetings" : label,
                checked: filter === key,
                onSelect: () => setFilter(key),
              })),
              {
                id: "delete-all",
                label: "Delete all meetings",
                danger: true,
                separatorBefore: true,
                disabled: meetings.length === 0,
                onSelect: () => setConfirmAll(true),
              },
            ]}
            renderTrigger={(props, state) => (
              <button
                type="button"
                {...props}
                aria-label="Filter meetings"
                className={cn(
                  "ui-meta inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 font-medium outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60",
                  filter !== "all" ? "text-foreground" : "text-muted-foreground",
                  state.open && "bg-accent",
                )}
              >
                <ListFilter className="h-3 w-3" aria-hidden="true" />
                {MEETING_FILTERS.find((f) => f.key === filter)?.label ?? "Filter"}
              </button>
            )}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-1">
        {error && !loading && (
          <p role="alert" className="ui-meta px-2 py-2 text-destructive">
            Couldn't load meetings: {error}
          </p>
        )}
        <RecentMeetings
          meetings={shown}
          onSelect={onOpenMeeting}
          onDelete={onDelete}
          onRename={onRename}
          favorites={favorites}
          onToggleFavorite={toggleFavorite}
          activeMeetingId={activeMeeting?.id ?? null}
          workspaces={everywhere ? workspaces : undefined}
          empty={
            query ? (
              <p className="ui-body text-muted-foreground">{everywhere ? "No meeting matches that." : `Nothing in ${workspace.name} matches that. Try Everywhere.`}</p>
            ) : emptyForFilter ? (
              <p className="ui-body text-muted-foreground">No meetings match this filter.</p>
            ) : (
              <>
                <p className="ui-section text-foreground">No meetings in {workspace.name} yet</p>
                <p className="ui-meta mt-1 text-muted-foreground">Start one and it is kept here.</p>
              </>
            )
          }
        />
        {hasMore && (
          <button type="button" onClick={loadMore} className="ui-meta mx-2 mt-2 rounded-md px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground">
            Show more
          </button>
        )}
      </div>

      <ConfirmDialog
        open={confirmAll}
        tone="danger"
        title={everywhere ? "Delete these meetings?" : `Delete all meetings in ${workspace.name}?`}
        body={`This permanently deletes ${deleteTargetCount} ${deleteTargetCount === 1 ? "meeting" : "meetings"} and their transcripts. This can't be undone.`}
        confirmLabel={deletingAll ? "Deleting" : `Delete ${deleteTargetCount} ${deleteTargetCount === 1 ? "meeting" : "meetings"}`}
        onConfirm={deleteAll}
        onCancel={() => !deletingAll && setConfirmAll(false)}
      />
    </section>
  );
}
