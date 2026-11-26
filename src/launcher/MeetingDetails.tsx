import { useState, useEffect, useCallback } from "react";
import type { Meeting, AIInteraction, TranscriptSegment } from "../lib/types";
import { getMeeting } from "../lib/ipc";
import { onTranscriptFinal } from "../lib/events";
import { useMeetingStore } from "../stores/meetingStore";
import {
  formatTimestamp,
  formatDurationLong,
  formatRelativeTime,
  getSpeakerLabel,
  getSpeakerColor,
  getModeLabel,
} from "../lib/utils";
import {
  ArrowLeft,
  FileText,
  MessageSquare,
  Loader2,
  Sparkles,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

interface MeetingDetailsProps {
  meetingId: string;
  onBack: () => void;
}

export function MeetingDetails({ meetingId, onBack }: MeetingDetailsProps) {
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"transcript" | "ai" | "summary">(
    "transcript"
  );
  const [expandedInteraction, setExpandedInteraction] = useState<string | null>(
    null
  );

  const loadMeeting = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getMeeting(meetingId);
      setMeeting(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load meeting");
    } finally {
      setLoading(false);
    }
  }, [meetingId]);

  useEffect(() => {
    loadMeeting();
  }, [loadMeeting]);

  // Subscribe to live transcript if viewing the active meeting
  const activeMeetingId = useMeetingStore((s) => s.activeMeeting?.id);
  const isActiveMeeting = activeMeetingId === meetingId;

  useEffect(() => {
    if (!isActiveMeeting) return;
    const unlistenPromise = onTranscriptFinal((event) => {
      setMeeting((prev) => {
        if (!prev) return prev;
        return { ...prev, transcript: [...prev.transcript, event.segment] };
      });
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [isActiveMeeting]);

  if (loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">Loading meeting...</p>
      </div>
    );
  }

  if (error || !meeting) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-sm text-destructive">{error || "Meeting not found"}</p>
        <button
          onClick={onBack}
          className="text-sm text-primary hover:underline"
        >
          Go back
        </button>
      </div>
    );
  }

  const durationDisplay = meeting.duration_seconds
    ? formatDurationLong(meeting.duration_seconds * 1000)
    : "In progress";

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-4 border-b border-border/20 px-6 py-4">
        <button
          onClick={onBack}
          className="rounded-xl p-2 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          aria-label="Go back"
        >
          <ArrowLeft className="h-5 w-5" aria-hidden="true" />
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold text-foreground">
            {meeting.title}
          </h2>
          <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground/60">
            <span>{formatRelativeTime(meeting.start_time)}</span>
            <span className="text-muted-foreground/60">&middot;</span>
            <span>{durationDisplay}</span>
            <span className="text-muted-foreground/60">&middot;</span>
            <span>{meeting.transcript.length} segments</span>
          </div>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1.5 border-b border-border/20 px-6 py-2.5" role="tablist" aria-label="Meeting sections">
        <TabButton
          active={activeTab === "transcript"}
          onClick={() => setActiveTab("transcript")}
          icon={<FileText className="h-3.5 w-3.5" />}
          label="Transcript"
          count={meeting.transcript.length}
        />
        <TabButton
          active={activeTab === "ai"}
          onClick={() => setActiveTab("ai")}
          icon={<MessageSquare className="h-3.5 w-3.5" />}
          label="AI Log"
          count={meeting.ai_interactions.length}
        />
        <TabButton
          active={activeTab === "summary"}
          onClick={() => setActiveTab("summary")}
          icon={<Sparkles className="h-3.5 w-3.5" />}
          label="Summary"
        />
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto" role="tabpanel">
        {activeTab === "transcript" && (
          <TranscriptView segments={meeting.transcript} />
        )}
        {activeTab === "ai" && (
          <AIInteractionLog
            interactions={meeting.ai_interactions}
            expandedId={expandedInteraction}
            onToggle={(id) =>
              setExpandedInteraction(expandedInteraction === id ? null : id)
            }
          />
        )}
        {activeTab === "summary" && (
          <SummaryView summary={meeting.summary} />
        )}
      </div>
    </div>
  );
}

// -- Tab button --

function TabButton({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count?: number;
}) {
  return (
    <button
      onClick={onClick}
      role="tab"
      aria-selected={active}
      className={`flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-medium transition-colors duration-150 ${
        active
          ? "bg-primary/10 text-primary"
          : "text-muted-foreground/50 hover:bg-secondary hover:text-muted-foreground"
      }`}
    >
      {icon}
      {label}
      {count !== undefined && count > 0 && (
        <span className={`rounded-full px-1.5 text-meta ${active ? "bg-primary/10" : "bg-secondary"}`}>
          {count}
        </span>
      )}
    </button>
  );
}

// -- Transcript View --

function TranscriptView({ segments }: { segments: TranscriptSegment[] }) {
  if (segments.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground/60">
        <FileText className="mb-4 h-7 w-7" />
        <p className="text-sm font-medium">No transcript segments</p>
      </div>
    );
  }

  return (
    <div className="space-y-0.5 p-5">
      {segments.map((segment, i) => (
        <div key={segment.id || i} className="flex gap-3 rounded-lg px-3 py-2 hover:bg-secondary/20">
          <span className="shrink-0 pt-0.5 text-meta tabular-nums text-muted-foreground/60">
            {formatTimestamp(segment.timestamp_ms)}
          </span>
          <span
            className={`shrink-0 pt-0.5 text-meta font-medium ${getSpeakerColor(segment.speaker)}`}
          >
            {getSpeakerLabel(segment.speaker)}
          </span>
          <span className="text-xs leading-relaxed text-foreground/80">{segment.text}</span>
        </div>
      ))}
    </div>
  );
}

// -- AI Interaction Log --

function AIInteractionLog({
  interactions,
  expandedId,
  onToggle,
}: {
  interactions: AIInteraction[];
  expandedId: string | null;
  onToggle: (id: string) => void;
}) {
  if (interactions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground/60">
        <MessageSquare className="mb-4 h-7 w-7" />
        <p className="text-sm font-medium">No AI interactions recorded</p>
      </div>
    );
  }

  return (
    <div className="space-y-2 p-5">
      {interactions.map((interaction) => {
        const isExpanded = expandedId === interaction.id;
        return (
          <div
            key={interaction.id}
            className="rounded-xl border border-border/20 bg-card/40"
          >
            <button
              onClick={() => onToggle(interaction.id)}
              className="flex w-full items-center justify-between px-4 py-3 text-left"
              aria-expanded={isExpanded}
            >
              <div className="flex items-center gap-2.5">
                <span className="rounded-lg bg-primary/10 px-2 py-0.5 text-meta font-medium text-primary">
                  {getModeLabel(interaction.mode)}
                </span>
                <span className="text-xs text-foreground/70 truncate max-w-[220px]">
                  {interaction.question_context}
                </span>
              </div>
              <div className="flex items-center gap-2.5">
                <span className="text-meta tabular-nums text-muted-foreground/60">
                  {interaction.latency_ms}ms
                </span>
                {isExpanded ? (
                  <ChevronUp className="h-3.5 w-3.5 text-muted-foreground/60" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground/60" />
                )}
              </div>
            </button>
            {isExpanded && (
              <div className="border-t border-border/20 px-4 py-3.5">
                <div className="mb-2.5 flex items-center gap-1.5 text-meta text-muted-foreground/50">
                  <span>{interaction.provider}/{interaction.model}</span>
                  <span className="text-muted-foreground/60">&middot;</span>
                  <span>{formatRelativeTime(interaction.timestamp)}</span>
                </div>
                <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground/80">
                  {interaction.response}
                </p>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// -- Summary View --

function SummaryView({ summary }: { summary: string | null }) {
  if (!summary) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground/60">
        <Sparkles className="mb-4 h-7 w-7" />
        <p className="text-sm font-medium">No summary available</p>
        <p className="mt-1.5 text-xs text-muted-foreground/60">
          Summaries are generated when meetings end
        </p>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="rounded-xl border border-border/20 bg-card/30 p-6">
        <p className="whitespace-pre-wrap text-sm leading-7 text-foreground/80">
          {summary}
        </p>
      </div>
    </div>
  );
}
