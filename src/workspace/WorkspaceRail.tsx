import { useMemo } from "react";
import { Archive, Inbox, LayoutList, MoreHorizontal, Pin, Plus, MessagesSquare } from "lucide-react";
import { Menu, Tooltip, IconButton } from "../ui";
import { VoiceprintMark } from "../voiceprint";
import { cn } from "../lib/utils";
import { railOrder, useWorkspaceStore } from "../stores/workspaceStore";
import type { WorkspaceSummary } from "../lib/types";
import { useWorkspaceActions } from "./WorkspaceActions";
import { MeetingList } from "./MeetingList";
import { useUnfiledCount } from "./unfiled";

function WorkspaceRow({ workspace, active, onOpen }: { workspace: WorkspaceSummary; active: boolean; onOpen: () => void }) {
  const actions = useWorkspaceActions();
  return (
    <li className={cn("group relative", workspace.archived && "opacity-70")}>
      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-lg py-1.5 pl-2.5 pr-9 text-left outline-none transition-colors ui-focus ui-r-lg",
          active ? "bg-accent text-foreground" : "text-foreground/80 hover:bg-accent/60 hover:text-foreground",
        )}
      >
        <VoiceprintMark id={workspace.id} hue={workspace.color} size={18} />
        <span className={cn("ui-body min-w-0 flex-1 truncate", active ? "font-semibold" : "font-medium")}>{workspace.name}</span>
        {workspace.pinned && <Pin className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Pinned" />}
      </button>
      <span
        className="ui-meta pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 tabular-nums text-muted-foreground transition-opacity group-focus-within:opacity-0 group-hover:opacity-0"
        aria-hidden="true"
      >
        {workspace.meeting_count || ""}
      </span>
      <div className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 transition-opacity focus-within:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100">
        <Menu
          label={`${workspace.name} actions`}
          items={actions.menuFor(workspace)}
          align="end"
          renderTrigger={(props) => (
            <IconButton {...props}  aria-label={`Actions for ${workspace.name}`}>
              <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
            </IconButton>
          )}
        />
      </div>
    </li>
  );
}

/**
 * The left rail. Wide: the workspaces, then the open workspace's meetings.
 * Narrow (under 820 px): only the voiceprints, with the names in tooltips.
 */
export function WorkspaceRail({
  narrow,
  onOpenMeeting,
  onShowMeetings,
  meetingQuery,
  onMeetingQuery,
}: {
  narrow: boolean;
  onOpenMeeting: (id: string) => void;
  onShowMeetings: () => void;
  meetingQuery: string;
  onMeetingQuery: (q: string) => void;
}) {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const openId = useWorkspaceStore((s) => s.openId);
  const view = useWorkspaceStore((s) => s.view);
  const showArchived = useWorkspaceStore((s) => s.showArchived);
  const setShowArchived = useWorkspaceStore((s) => s.setShowArchived);
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);
  const setView = useWorkspaceStore((s) => s.setView);
  const actions = useWorkspaceActions();

  const rows = useMemo(() => railOrder(workspaces, showArchived), [workspaces, showArchived]);
  const unfiled = useUnfiledCount();
  const archivedCount = workspaces.filter((w) => w.archived).length;
  const open = workspaces.find((w) => w.id === openId) ?? workspaces[0];

  if (narrow) {
    return (
      <nav aria-label="Workspaces" className="flex h-full flex-col items-center gap-1 overflow-y-auto py-3">
        {rows
          .filter((w) => !w.archived)
          .map((w) => {
            const active = view === "home" && w.id === openId;
            return (
              <Tooltip key={w.id} content={w.name}>
                <button
                  type="button"
                  onClick={() => openWorkspace(w.id)}
                  aria-label={w.name}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex h-9 w-10 items-center justify-center rounded-lg outline-none transition-colors ui-focus ui-r-lg",
                    active ? "bg-accent" : "hover:bg-accent/60",
                  )}
                >
                  <VoiceprintMark id={w.id} hue={w.color} size={18} />
                </button>
              </Tooltip>
            );
          })}
        <div className="mt-1 flex flex-col items-center gap-1 border-t border-border pt-2">
          <Tooltip content="New workspace">
            <IconButton onClick={actions.create}  aria-label="New workspace">
              <Plus className="h-4 w-4" aria-hidden="true" />
            </IconButton>
          </Tooltip>
          {unfiled > 0 && (
            <Tooltip content={`Not filed, ${unfiled}`}>
              <IconButton onClick={() => setView("unfiled")} aria-label={`Not filed, ${unfiled}`} aria-current={view === "unfiled" ? "page" : undefined}>
                <Inbox className="h-4 w-4" aria-hidden="true" />
              </IconButton>
            </Tooltip>
          )}
          <Tooltip content="All workspaces">
            <IconButton onClick={() => setView("all")}  aria-label="All workspaces" aria-current={view === "all" ? "page" : undefined}>
              <LayoutList className="h-4 w-4" aria-hidden="true" />
            </IconButton>
          </Tooltip>
          <Tooltip content={`Meetings in ${open?.name ?? "General"}`}>
            <IconButton onClick={onShowMeetings}  aria-label={`Meetings in ${open?.name ?? "General"}`}>
              <MessagesSquare className="h-4 w-4" aria-hidden="true" />
            </IconButton>
          </Tooltip>
        </div>
      </nav>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <nav aria-label="Workspaces" className="flex max-h-[34%] shrink-0 flex-col border-b border-border">
        <div className="flex items-center justify-between px-4 pb-1 pt-3">
          <h2 className="ui-section text-foreground">Workspaces</h2>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => setView("all")}
              className="ui-meta rounded-md px-1.5 py-1 font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground ui-focus ui-r-md"
              aria-current={view === "all" ? "page" : undefined}
            >
              See all
            </button>
            <Tooltip content="New workspace">
              <IconButton onClick={actions.create}  aria-label="New workspace">
                <Plus className="h-4 w-4" aria-hidden="true" />
              </IconButton>
            </Tooltip>
          </div>
        </div>
        <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
          {rows.map((w) => (
            <WorkspaceRow key={w.id} workspace={w} active={view === "home" && w.id === openId} onOpen={() => openWorkspace(w.id)} />
          ))}
        </ul>
        {unfiled > 0 && (
          // Always in view, not at the end of the scrolling list.
          <div className="shrink-0 px-2 pb-1">
            <button
              type="button"
              onClick={() => setView("unfiled")}
              aria-current={view === "unfiled" ? "page" : undefined}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-lg py-1.5 pl-2.5 pr-2.5 text-left outline-none transition-colors ui-focus",
                view === "unfiled" ? "bg-accent text-foreground" : "text-foreground/80 hover:bg-accent/60 hover:text-foreground",
              )}
            >
              <Inbox className="h-[18px] w-[18px] shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="ui-body min-w-0 flex-1 truncate font-medium">Not filed</span>
              <span className="ui-meta tabular-nums text-muted-foreground">{unfiled}</span>
            </button>
          </div>
        )}
        {archivedCount > 0 && (
          <button
            type="button"
            onClick={() => setShowArchived(!showArchived)}
            aria-expanded={showArchived}
            className="ui-meta mx-2 mb-2 flex items-center gap-1.5 rounded-md px-2 py-1 text-left text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground ui-focus ui-r-md"
          >
            <Archive className="h-3 w-3" aria-hidden="true" />
            {showArchived ? "Hide archived" : `Show archived (${archivedCount})`}
          </button>
        )}
      </nav>
      {open && <MeetingList workspace={open} onOpenMeeting={onOpenMeeting} query={meetingQuery} onQueryChange={onMeetingQuery} />}
    </div>
  );
}
