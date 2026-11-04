import { useState, useCallback, useRef, useEffect } from "react";
import type { MeetingSummary } from "../lib/types";
import { formatRelativeTime, formatDurationLong } from "../lib/utils";
import { scenarioLabel, useScenarioStore } from "../stores/scenarioStore";
import {
  Trash2,
  Pencil,
  Check,
  X,
  ChevronRight,
  Star,
  MessageSquare,
  Clock,
  FileText,
  Users,
} from "lucide-react";

interface MeetingCardProps {
  meeting: MeetingSummary;
  onSelect: (meetingId: string) => void;
  onDelete: (meetingId: string) => void;
  onRename: (meetingId: string, newTitle: string) => void | Promise<void>;
  isFavorite?: boolean;
  onToggleFavorite?: (meetingId: string) => void;
  /** True only for the singleton active meeting, not stale meetings missing duration */
  isLive?: boolean;
  /** Index for staggered entrance animation (0-based) */
  staggerIndex?: number;
}

export function MeetingCard({
  meeting,
  onSelect,
  onDelete,
  onRename,
  isFavorite = false,
  onToggleFavorite,
  isLive = false,
  staggerIndex = 0,
}: MeetingCardProps) {
  const scenario = useScenarioStore((s) =>
    meeting.ai_scenario ? scenarioLabel(meeting.ai_scenario, s.customScenarios) : null
  );
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(meeting.title);
  const [isSaving, setIsSaving] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const saveBtnRef = useRef<HTMLButtonElement>(null);
  const cancelBtnRef = useRef<HTMLButtonElement>(null);
  // True only while an edit can still be committed. Cancel and commit both clear it,
  // so a late blur (focusout on unmount, Tab to a button) can never save a cancelled edit.
  const editSessionRef = useRef(false);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      const input = inputRef.current;
      input.focus();
      // select() leaves the caret at the end and scrolls long titles to their tail
      input.setSelectionRange(0, input.value.length);
      input.scrollLeft = 0;
    }
  }, [isEditing]);

  const handleStartEdit = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setEditTitle(meeting.title);
      editSessionRef.current = true;
      setIsEditing(true);
    },
    [meeting.title]
  );

  const handleSaveEdit = useCallback(async () => {
    if (!editSessionRef.current || isSaving) return;
    editSessionRef.current = false;
    setIsSaving(true);
    try {
      const trimmed = editTitle.trim();
      if (trimmed && trimmed !== meeting.title) {
        await onRename(meeting.id, trimmed);
      }
    } finally {
      setIsSaving(false);
      setIsEditing(false);
    }
  }, [editTitle, meeting.id, meeting.title, onRename, isSaving]);

  const handleCancelEdit = useCallback(() => {
    editSessionRef.current = false;
    setEditTitle(meeting.title);
    setIsEditing(false);
  }, [meeting.title]);

  const handleEditKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") handleSaveEdit();
      else if (e.key === "Escape") handleCancelEdit();
    },
    [handleSaveEdit, handleCancelEdit]
  );

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowDeleteConfirm(true);
  }, []);

  const handleConfirmDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onDelete(meeting.id);
      setShowDeleteConfirm(false);
    },
    [meeting.id, onDelete]
  );

  const handleCancelDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowDeleteConfirm(false);
  }, []);

  const handleFavoriteClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onToggleFavorite?.(meeting.id);
    },
    [meeting.id, onToggleFavorite]
  );

  const durationDisplay = meeting.duration_seconds
    ? formatDurationLong(meeting.duration_seconds * 1000)
    : isLive
      ? "In progress"
      : "—";

  const handleCardKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.key === "Enter" || e.key === " ") && !isEditing) {
        e.preventDefault();
        onSelect(meeting.id);
      }
    },
    [isEditing, onSelect, meeting.id]
  );

  return (
    <div
      onClick={() => !isEditing && onSelect(meeting.id)}
      onKeyDown={handleCardKeyDown}
      role="button"
      tabIndex={0}
      aria-label={`Meeting: ${meeting.title}, ${formatRelativeTime(meeting.start_time)}`}
      className={`group meeting-card-enter meeting-card-interactive relative cursor-pointer rounded-xl bg-card/40 px-4 py-3 border-l-[3px] ${
        isLive
          ? "border-l-success/50"
          : meeting.has_summary
            ? "border-l-info/30"
            : "border-l-border/20"
      }`}
      style={{ animationDelay: `${300 + staggerIndex * 50}ms` }}
    >
      <div className="flex items-center gap-3">
        {/* Favorite star */}
        <button
          onClick={handleFavoriteClick}
          className={`shrink-0 rounded-md p-0.5 transition-all duration-150 active:scale-125 ${
            isFavorite
              ? "text-warning"
              : "text-muted-foreground/40 opacity-0 group-hover:opacity-100 hover:text-warning/70"
          }`}
          aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
          aria-pressed={isFavorite}
        >
          <Star
            className="h-3.5 w-3.5"
            fill={isFavorite ? "currentColor" : "none"}
            aria-hidden="true"
          />
        </button>

        {/* Content */}
        <div className="min-w-0 flex-1">
          {isEditing ? (
            <div
              className="flex items-center gap-2"
              onClick={(e) => e.stopPropagation()}
            >
              <input
                ref={inputRef}
                type="text"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                onKeyDown={handleEditKeyDown}
                onBlur={(e) => {
                  // Tabbing onto the save/cancel buttons: let the button decide.
                  const next = e.relatedTarget;
                  if (next && (next === saveBtnRef.current || next === cancelBtnRef.current)) return;
                  handleSaveEdit();
                }}
                disabled={isSaving}
                maxLength={200}
                className="w-full rounded-lg border border-primary/30 bg-background px-2.5 py-1 text-xs text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
              />
              {/* onMouseDown preventDefault keeps focus in the input so the blur-save never races these buttons */}
              <button
                ref={saveBtnRef}
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  e.stopPropagation();
                  handleSaveEdit();
                }}
                disabled={isSaving}
                className="rounded-md p-1 text-success hover:bg-success/10 disabled:opacity-50"
                aria-label="Save title"
              >
                <Check className="h-3 w-3" aria-hidden="true" />
              </button>
              <button
                ref={cancelBtnRef}
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  e.stopPropagation();
                  handleCancelEdit();
                }}
                className="rounded-md p-1 text-muted-foreground hover:bg-secondary"
                aria-label="Cancel rename"
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </div>
          ) : (
            <h3 className="truncate text-xs font-medium text-foreground">
              {meeting.title}
            </h3>
          )}

          {/* Badges row */}
          <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
            <span className="text-meta tabular-nums text-muted-foreground/70">
              {formatRelativeTime(meeting.start_time)}
            </span>

            {isLive ? (
              <span className="live-ring-pulse rounded-full bg-success/10 px-2 py-0.5 text-meta font-semibold text-success">
                LIVE
              </span>
            ) : (
              <span className="flex items-center gap-0.5 text-meta tabular-nums text-muted-foreground/60">
                <Clock className="h-2.5 w-2.5" />
                {durationDisplay}
              </span>
            )}

            {meeting.segment_count > 0 && (
              <span className="flex items-center gap-0.5 text-meta tabular-nums text-muted-foreground/60">
                <MessageSquare className="h-2.5 w-2.5" />
                {meeting.segment_count}
              </span>
            )}

            {meeting.has_summary && (
              <span className="flex items-center gap-0.5 text-meta text-info">
                <FileText className="h-2.5 w-2.5" />
              </span>
            )}

            {meeting.audio_mode && (
              <span
                className="text-[9px] font-bold tracking-wider px-1 py-0.5 rounded"
                style={{
                  color: meeting.audio_mode === "online" ? "#4a6cf7" : "#a855f7",
                  backgroundColor: meeting.audio_mode === "online" ? "rgba(74,108,247,0.12)" : "rgba(168,85,247,0.12)",
                }}
              >
                {meeting.audio_mode === "online" ? "ONLINE" : "IN-PERSON"}
              </span>
            )}

            {scenario && (
              <span className="text-[9px] font-medium text-muted-foreground/50 truncate max-w-[80px]" title={scenario}>
                {scenario}
              </span>
            )}

            {meeting.speaker_count !== undefined && meeting.speaker_count > 0 && (
              <span className="flex items-center gap-0.5 text-meta tabular-nums text-muted-foreground/50">
                <Users className="h-2.5 w-2.5" />
                {meeting.speaker_count}
              </span>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
          {showDeleteConfirm ? (
            <div className="flex items-center gap-1 rounded-lg bg-destructive/10 px-2 py-1">
              <span className="text-meta text-destructive">Delete?</span>
              <button
                onClick={handleConfirmDelete}
                className="rounded p-0.5 text-destructive hover:bg-destructive/20"
                aria-label="Confirm delete"
              >
                <Check className="h-3 w-3" aria-hidden="true" />
              </button>
              <button
                onClick={handleCancelDelete}
                className="rounded p-0.5 text-muted-foreground hover:bg-secondary"
                aria-label="Cancel delete"
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </div>
          ) : (
            <>
              <button
                onClick={handleStartEdit}
                className="rounded-md p-1 text-muted-foreground/60 hover:bg-secondary hover:text-foreground"
                aria-label="Rename"
              >
                <Pencil className="h-3 w-3" aria-hidden="true" />
              </button>
              <button
                onClick={handleDeleteClick}
                className="rounded-md p-1 text-muted-foreground/60 hover:bg-destructive/10 hover:text-destructive"
                aria-label="Delete meeting"
              >
                <Trash2 className="h-3 w-3" aria-hidden="true" />
              </button>
            </>
          )}
          <ChevronRight className="ml-0.5 h-3.5 w-3.5 text-muted-foreground/50" />
        </div>
      </div>
    </div>
  );
}
