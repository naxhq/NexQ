import { useCallback, useEffect, useRef, useState } from "react";
import { listWorkspaceMeetings, searchMeetings } from "../lib/ipc";
import { useMeetingStore } from "../stores/meetingStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import type { MeetingSummary } from "../lib/types";

export type MeetingScopeChoice = "here" | "everywhere";

const PAGE = 50;

export interface WorkspaceMeetings {
  meetings: MeetingSummary[];
  total: number;
  loading: boolean;
  error: string | null;
  loadMore: () => void;
  hasMore: boolean;
}

/**
 * The meetings the rail shows: this workspace's (search runs in it), or all of
 * them. Reloads when workspaces change, a meeting ends, or one is moved or
 * renamed. Late answers of an older request are dropped.
 */
export function useWorkspaceMeetings(workspaceId: string, query: string, scope: MeetingScopeChoice): WorkspaceMeetings {
  const revision = useWorkspaceStore((s) => s.revision);
  const unavailable = useWorkspaceStore((s) => s.unavailable);
  const recent = useMeetingStore((s) => s.recentMeetings);
  const [state, setState] = useState<{ meetings: MeetingSummary[]; total: number; loading: boolean; error: string | null }>({
    meetings: [],
    total: 0,
    loading: true,
    error: null,
  });
  const [limit, setLimit] = useState(PAGE);
  const seq = useRef(0);
  const q = query.trim();

  // A new place or a new search starts at the first page.
  useEffect(() => setLimit(PAGE), [workspaceId, q, scope]);

  useEffect(() => {
    const mine = ++seq.current;
    const done = (meetings: MeetingSummary[], total: number) => {
      if (mine === seq.current) setState({ meetings, total, loading: false, error: null });
    };
    const failed = (e: unknown) => {
      if (mine === seq.current) setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : String(e) }));
    };
    setState((s) => ({ ...s, loading: true }));
    // Debounced typing; the first load is immediate.
    const timer = setTimeout(
      () => {
        if (scope === "everywhere") {
          if (!q) return done(recent, recent.length);
          searchMeetings(q).then((r) => done(r, r.length), failed);
          return;
        }
        if (unavailable) {
          // Workspaces can't be read: everything is in General.
          const list = q ? recent.filter((m) => m.title.toLowerCase().includes(q.toLowerCase())) : recent;
          return done(list, list.length);
        }
        listWorkspaceMeetings(workspaceId, q || null, limit, 0).then((page) => done(page.meetings ?? [], page.total ?? 0), failed);
      },
      q ? 200 : 0,
    );
    return () => clearTimeout(timer);
  }, [workspaceId, q, scope, limit, revision, recent, unavailable]);

  const loadMore = useCallback(() => setLimit((l) => l + PAGE), []);
  return {
    ...state,
    loadMore,
    hasMore: scope === "here" && state.meetings.length < state.total,
  };
}
