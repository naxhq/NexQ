import { useEffect, useRef, useState } from "react";
import { countUnfiledMeetings, listWorkspaceMeetings } from "../lib/ipc";
import { useMeetingStore } from "../stores/meetingStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import type { MeetingSummary } from "../lib/types";

/** A meeting that started without a usable workspace is kept at "unfiled:<id>" until someone files it. */
export const UNFILED_PREFIX = "unfiled:";
/** The id the backend lists them under (`list_workspace_meetings`): every home that is not a workspace. */
export const UNFILED_ID = "unfiled";
export const isUnfiledHome = (workspaceId: string | null | undefined): boolean => !!workspaceId && workspaceId.startsWith(UNFILED_PREFIX);

/** What a meeting row shows as its workspace: the real one, or "Not filed". */
export const NOT_FILED = { id: "unfiled", name: "Not filed", color: null } as const;

/** The unfiled ones of a list of meetings, newest first. */
export function unfiledOf(meetings: MeetingSummary[]): MeetingSummary[] {
  return meetings
    .filter((m) => isUnfiledHome(m.workspace_id))
    .sort((a, b) => new Date(b.start_time).getTime() - new Date(a.start_time).getTime());
}

const PAGE = 50;

/** How many meetings are in no workspace (cheap: for the rail and See all). Read again when workspaces change. */
export function useUnfiledCount(): number {
  const revision = useWorkspaceStore((s) => s.revision);
  const recent = useMeetingStore((s) => s.recentMeetings);
  const [count, setCount] = useState(() => unfiledOf(recent).length);
  useEffect(() => {
    let live = true;
    countUnfiledMeetings()
      .then((n) => live && setCount(typeof n === "number" ? n : unfiledOf(recent).length))
      .catch(() => live && setCount(unfiledOf(recent).length));
    return () => {
      live = false;
    };
  }, [revision, recent]);
  return count;
}

/**
 * The meetings that are not in any workspace (any `unfiled:<id>` home), searchable and paged: the backend lists
 * them as the workspace "unfiled". Without this they would only be found by searching "Everywhere".
 */
export function useUnfiledMeetings(query = "", pageSize = PAGE): { meetings: MeetingSummary[]; total: number; loading: boolean; hasMore: boolean; loadMore: () => void } {
  const revision = useWorkspaceStore((s) => s.revision);
  const recent = useMeetingStore((s) => s.recentMeetings);
  const [limit, setLimit] = useState(pageSize);
  const [state, setState] = useState<{ meetings: MeetingSummary[]; total: number; loading: boolean }>({ meetings: [], total: 0, loading: true });
  const seq = useRef(0);
  const q = query.trim();

  useEffect(() => setLimit(pageSize), [q, pageSize]);

  useEffect(() => {
    const mine = ++seq.current;
    const timer = setTimeout(
      () => {
        listWorkspaceMeetings(UNFILED_ID, q || null, limit, 0)
          .then((page) => {
            if (mine !== seq.current) return;
            const meetings = Array.isArray(page?.meetings) ? page.meetings : [];
            setState({ meetings, total: page?.total ?? meetings.length, loading: false });
          })
          .catch(() => {
            if (mine !== seq.current) return;
            const local = unfiledOf(recent).filter((m) => !q || m.title.toLowerCase().includes(q.toLowerCase()));
            setState({ meetings: local, total: local.length, loading: false });
          });
      },
      q ? 200 : 0,
    );
    return () => clearTimeout(timer);
    // `recent` changes when a meeting ends, is moved or deleted.
  }, [revision, recent, q, limit]);

  return { ...state, hasMore: state.meetings.length < state.total, loadMore: () => setLimit((l) => l + pageSize) };
}
