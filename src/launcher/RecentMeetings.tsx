import type { MeetingSummary, WorkspaceSummary } from "../lib/types";
import { groupMeetingsByDate } from "../workspace/meetingGroups";
import { MeetingCard } from "./MeetingCard";
import { NOT_FILED, isUnfiledHome } from "../workspace/unfiled";

interface RecentMeetingsProps {
  meetings: MeetingSummary[];
  onSelect: (meetingId: string) => void;
  onDelete: (meetingId: string) => void;
  onRename: (meetingId: string, newTitle: string) => void;
  favorites?: Set<string>;
  onToggleFavorite?: (meetingId: string) => void;
  activeMeetingId?: string | null;
  /** Shown when the list is empty. */
  empty?: React.ReactNode;
  /** Search everywhere: name the workspace each meeting is filed in. */
  workspaces?: WorkspaceSummary[];
}

/** Meetings grouped by when they happened: Today, Yesterday, This week, Earlier. */
export function RecentMeetings({
  meetings,
  onSelect,
  onDelete,
  onRename,
  favorites,
  onToggleFavorite,
  activeMeetingId,
  empty,
  workspaces,
}: RecentMeetingsProps) {
  if (meetings.length === 0) {
    return (
      <div className="px-3 py-8 text-center">
        {empty ?? (
          <>
            <p className="ui-section text-foreground">No meetings yet</p>
            <p className="ui-meta mt-1 text-muted-foreground">Start a meeting and it will be kept here.</p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {groupMeetingsByDate(meetings).map((group) => (
        <section key={group.label} aria-label={group.label}>
          <h3 className="ui-meta mb-1 px-2 font-medium text-muted-foreground">{group.label}</h3>
          <div className="space-y-0.5">
            {group.meetings.map((meeting) => (
              <MeetingCard
                key={meeting.id}
                meeting={meeting}
                onSelect={onSelect}
                onDelete={onDelete}
                onRename={onRename}
                isFavorite={favorites?.has(meeting.id) ?? false}
                onToggleFavorite={onToggleFavorite}
                isLive={meeting.id === activeMeetingId}
                canMove={!!workspaces && workspaces.length > 1}
                workspace={workspaces ? (isUnfiledHome(meeting.workspace_id) ? NOT_FILED : workspaces.find((w) => w.id === (meeting.workspace_id ?? "general"))) : undefined}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
