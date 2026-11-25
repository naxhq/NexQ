import { useState, useCallback, useRef, useEffect } from "react";
import type { Meeting } from "../../lib/types";
import type { MeetingStats } from "../../hooks/useMeetingStats";
import { renameMeeting } from "../../lib/ipc";
import { useMeetingStore } from "../../stores/meetingStore";
import { formatRelativeTime, formatDurationLong } from "../../lib/utils";
import { MoveMeetingMenu } from "../../workspace/MoveMeetingMenu";
import { SuggestFromMeeting } from "../../memory/SuggestFromMeeting";
import {
  ArrowLeft,
  Pencil,
  Check,
  X,
  Clock,
  AlignLeft,
  Zap,
  Mic,
  Volume2,
  Brain,
  Timer,
} from "lucide-react";

interface MeetingHeaderProps {
  meeting: Meeting;
  stats: MeetingStats;
  onBack: () => void;
  onTitleChanged: (title: string) => void;
}

export function MeetingHeader({
  meeting,
  stats,
  onBack,
  onTitleChanged,
}: MeetingHeaderProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(meeting.title);
  const [isSaving, setIsSaving] = useState(false);
  const [home, setHome] = useState(meeting.workspace_id ?? "general");
  useEffect(() => setHome(meeting.workspace_id ?? "general"), [meeting.workspace_id, meeting.id]);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeMeetingId = useMeetingStore((s) => s.activeMeeting?.id);
  const loadRecentMeetings = useMeetingStore((s) => s.loadRecentMeetings);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleStartEdit = useCallback(() => {
    setEditTitle(meeting.title);
    setIsEditing(true);
  }, [meeting.title]);

  const handleSaveEdit = useCallback(async () => {
    if (isSaving) return;
    setIsSaving(true);
    try {
      const trimmed = editTitle.trim();
      if (trimmed && trimmed !== meeting.title) {
        try {
          await renameMeeting(meeting.id, trimmed);
          onTitleChanged(trimmed);
          if (meeting.id === activeMeetingId) {
            const active = useMeetingStore.getState().activeMeeting;
            if (active) useMeetingStore.getState().setActiveMeeting({ ...active, title: trimmed });
          }
          await loadRecentMeetings();
        } catch (err) { console.error("[MeetingHeader] Rename failed:", err); }
      }
    } finally {
      setIsSaving(false);
      setIsEditing(false);
    }
  }, [editTitle, meeting.id, meeting.title, activeMeetingId, onTitleChanged, loadRecentMeetings, isSaving]);

  const handleCancelEdit = useCallback(() => {
    setEditTitle(meeting.title);
    setIsEditing(false);
  }, [meeting.title]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") handleSaveEdit();
      else if (e.key === "Escape") handleCancelEdit();
    },
    [handleSaveEdit, handleCancelEdit]
  );

  const durationDisplay = meeting.duration_seconds
    ? formatDurationLong(meeting.duration_seconds * 1000)
    : "In progress";

  return (
    <div className="border-b border-border/20">
      {/* Row 1: Back + Title + Layout toggle */}
      <div className="flex items-center gap-3 px-5 pt-3 pb-1.5">
        <button
          onClick={onBack}
          className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground cursor-pointer"
          aria-label="Go back"
        >
          <ArrowLeft className="h-4.5 w-4.5" aria-hidden="true" />
        </button>

        <div className="group min-w-0 flex-1">
          {isEditing ? (
            <div className="flex items-center gap-2">
              <input
                ref={inputRef}
                type="text"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={handleSaveEdit}
                disabled={isSaving}
                maxLength={200}
                className="flex-1 rounded-lg border border-primary/30 bg-background px-3 py-1 text-sm font-semibold text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
              />
              <button onClick={handleSaveEdit} disabled={isSaving} className="rounded-md p-1.5 text-success hover:bg-success/10 disabled:opacity-50 cursor-pointer" aria-label="Save title">
                <Check className="h-4 w-4" aria-hidden="true" />
              </button>
              <button onClick={handleCancelEdit} className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary cursor-pointer" aria-label="Cancel editing">
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2 cursor-pointer" onClick={handleStartEdit}>
              <h2 className="truncate text-sm font-semibold text-foreground">{meeting.title}</h2>
              <Pencil className="h-3.5 w-3.5 shrink-0 text-muted-foreground/30 opacity-0 transition-opacity group-hover:opacity-100" />
            </div>
          )}
          <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground/50">
            <span>{formatRelativeTime(meeting.start_time)}</span>
            <span>&middot;</span>
            <span>{durationDisplay}</span>
            <span>&middot;</span>
            <span>{meeting.transcript.length} segments</span>
          </div>
        </div>

        {/* Where it is filed, and what to remember from it */}
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
          <SuggestFromMeeting meetingId={meeting.id} workspaceId={home} />
          <MoveMeetingMenu meetingId={meeting.id} currentWorkspaceId={home} variant="button" onMoved={setHome} />
        </div>
      </div>

      {/* Row 2: Stats bar */}
      <div className="flex items-center gap-3 px-5 pb-2.5 overflow-x-auto">
        <Stat icon={<Clock className="h-3.5 w-3.5" />} label="Duration" value={stats.durationDisplay} />
        <Stat icon={<AlignLeft className="h-3.5 w-3.5" />} label="Words" value={stats.wordCount.toLocaleString()} />
        {stats.wordsPerMinute > 0 && (
          <Stat icon={<Zap className="h-3.5 w-3.5" />} label="Pace" value={`${stats.wordsPerMinute}/min`} />
        )}
        {stats.speakerBreakdown.map((s) => {
          const Icon = s.speaker === "User" || s.speaker === "Interviewer" ? Mic : Volume2;
          const label = s.speaker === "User" ? "You" : s.speaker;
          return <Stat key={s.speaker} icon={<Icon className={`h-3.5 w-3.5 ${s.color}`} />} label={label} value={`${s.percentage}%`} />;
        })}
        {stats.aiCount > 0 && (
          <Stat icon={<Brain className="h-3.5 w-3.5" />} label="AI" value={String(stats.aiCount)} />
        )}
        {stats.avgLatencyMs !== null && (
          <Stat icon={<Timer className="h-3.5 w-3.5" />} label="Latency" value={`${stats.avgLatencyMs}ms`} />
        )}
      </div>
    </div>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-1.5 rounded-lg bg-secondary/20 px-2.5 py-1">
      <span className="text-muted-foreground/50">{icon}</span>
      <div className="flex items-baseline gap-1">
        <span className="text-xs font-semibold tabular-nums text-foreground/80">{value}</span>
        <span className="text-meta text-muted-foreground/40">{label}</span>
      </div>
    </div>
  );
}
