import { getMeetingScope, moveMeeting, setMeetingScope } from "../lib/ipc";
import { useMeetingStore } from "../stores/meetingStore";
import { announceMeetingScope, useWorkspaceStore } from "../stores/workspaceStore";
import type { MeetingScope, WorkspaceSummary } from "../lib/types";

/**
 * Borrowing is refused when either side is kept separate, and a workspace
 * can't borrow itself. Returns the reason, or null when allowed (the backend
 * enforces the same rule; this only explains it before the click).
 */
export function borrowBlocker(home: WorkspaceSummary | undefined, other: WorkspaceSummary): string | null {
  if (!home) return null;
  if (other.id === home.id) return "This is its home";
  if (other.archived) return "Archived";
  if (home.keep_separate) return `${home.name} is kept separate`;
  if (other.keep_separate) return "Kept separate";
  return null;
}

/** After a change to a running meeting: tell this window's store and the other window. */
export async function syncActiveScope(scope: MeetingScope): Promise<void> {
  const meetings = useMeetingStore.getState();
  if (meetings.activeMeeting?.id === scope.meeting_id) {
    useMeetingStore.setState({
      activeMeeting: { ...meetings.activeMeeting, workspace_id: scope.home },
      activeBorrowed: scope.borrowed,
    });
  }
  await announceMeetingScope({ meetingId: scope.meeting_id, home: scope.home, borrowed: scope.borrowed });
}

/** Files a meeting (past or running) in another workspace. */
export async function moveMeetingTo(meetingId: string, workspaceId: string): Promise<MeetingScope> {
  await moveMeeting(meetingId, workspaceId);
  const scope = await getMeetingScope(meetingId);
  await syncActiveScope(scope);
  await useMeetingStore.getState().loadRecentMeetings();
  await useWorkspaceStore.getState().refresh();
  return scope;
}

/** Replaces the borrowed workspaces of a meeting; rejects with the backend's message when refused. */
export async function setBorrowed(meetingId: string, borrowed: string[]): Promise<MeetingScope> {
  const scope = await setMeetingScope(meetingId, borrowed);
  await syncActiveScope(scope);
  return scope;
}
