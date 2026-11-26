import { useState, useCallback, useRef, useEffect } from "react";
import type { MeetingSummary, WorkspaceSummary } from "../lib/types";
import { formatRelativeTime, formatDurationLong, cn } from "../lib/utils";
import { formatMeetingWhen } from "../workspace/meetingGroups";
import { scenarioLabel, useScenarioStore } from "../stores/scenarioStore";
import { MoveMeetingMenu } from "../workspace/MoveMeetingMenu";
import { VoiceprintMark } from "../voiceprint";
import { Trash2, Pencil, Check, X, Star } from "lucide-react";

interface MeetingCardProps {
  meeting: MeetingSummary;
  onSelect: (meetingId: string) => void;
  onDelete: (meetingId: string) => void;
  onRename: (meetingId: string, newTitle: string) => void | Promise<void>;
  isFavorite?: boolean;
  onToggleFavorite?: (meetingId: string) => void;
  /** True only for the singleton active meeting, not stale meetings missing duration */
  isLive?: boolean;
  /** Search everywhere: show which workspace the meeting is filed in. */
  workspace?: Pick<WorkspaceSummary, "id" | "name" | "color">;
  /** Offer "Move to workspace" (needs the workspaces list; off in tests that render one card alone). */
  canMove?: boolean;
}

const iconAction =
  "inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60";

/**
 * One meeting in the rail: a title and a quiet line of facts. Rename, move and
 * delete appear on hover and on focus. The live meeting says so and returns to it.
 */
export function MeetingCard({
  meeting,
  onSelect,
  onDelete,
  onRename,
  isFavorite = false,
  onToggleFavorite,
  isLive = false,
  workspace,
  canMove = false,
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

  const handleConfirmDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onDelete(meeting.id);
      setShowDeleteConfirm(false);
    },
    [meeting.id, onDelete]
  );

  const durationDisplay = meeting.duration_seconds
    ? formatDurationLong(meeting.duration_seconds * 1000)
    : isLive
      ? "In progress"
      : null;
  const defaultScenario = !meeting.ai_scenario || meeting.ai_scenario === "team_meeting";

  const handleCardKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Only the card's own Enter/Space: a key pressed on one of its buttons belongs to that button.
      if (e.target !== e.currentTarget) return;
      if ((e.key === "Enter" || e.key === " ") && !isEditing) {
        e.preventDefault();
        onSelect(meeting.id);
      }
    },
    [isEditing, onSelect, meeting.id]
  );

  // One quiet line: when, how long, and only what is not the usual (online, team meeting).
  const facts = [
    formatMeetingWhen(meeting.start_time),
    durationDisplay,
    meeting.audio_mode === "in_person" ? "In person" : null,
    !defaultScenario ? scenario : null,
  ].filter((f): f is string => !!f);

  return (
    <div
      onClick={() => !isEditing && onSelect(meeting.id)}
      onKeyDown={handleCardKeyDown}
      role="button"
      data-rove-row
      tabIndex={0}
      aria-label={`Meeting: ${meeting.title}, ${formatRelativeTime(meeting.start_time)}`}
      className={cn(
        "group relative cursor-pointer rounded-lg px-2 py-1.5 outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/60",
        isLive && "bg-success/10 hover:bg-success/15",
      )}
    >
      {isEditing ? (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
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
            aria-label="Meeting title"
            className="ui-body min-w-0 flex-1 rounded-md border border-ring bg-background px-2 py-1 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
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
            className={cn(iconAction, "text-success hover:text-success")}
            aria-label="Save title"
          >
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            ref={cancelBtnRef}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              handleCancelEdit();
            }}
            className={iconAction}
            aria-label="Cancel rename"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      ) : (
        <h3 className={cn("ui-body truncate font-medium text-foreground", isFavorite && "pr-6")}>{meeting.title}</h3>
      )}

      <p className="ui-meta mt-0.5 flex flex-wrap items-center gap-x-2 text-muted-foreground">
        {isLive && <span className="font-semibold text-success">Live</span>}
        {meeting.has_summary && <span className="font-medium text-foreground/80">Summary</span>}
        {!meeting.has_summary && meeting.has_recap && <span className="font-medium text-foreground/80">Recap</span>}
        {facts.map((f, i) => (
          <span key={i} className="tabular-nums">
            {f}
          </span>
        ))}
      </p>
      {workspace && (
        <p className="ui-meta mt-0.5 flex items-center gap-1.5 text-muted-foreground">
          <VoiceprintMark id={workspace.id} hue={workspace.color} size={11} />
          <span className="truncate">{workspace.name}</span>
        </p>
      )}

      {!isEditing && (
        <div className={cn("absolute right-1 top-1 flex items-center gap-0.5 rounded-md", "group-hover:bg-accent group-focus-within:bg-accent")}>
          {showDeleteConfirm ? (
            <div className="flex items-center gap-1 rounded-md bg-destructive/10 px-1.5 py-0.5">
              <span className="ui-meta text-destructive">Delete?</span>
              <button onClick={handleConfirmDelete} className={cn(iconAction, "text-destructive hover:text-destructive")} aria-label="Confirm delete">
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowDeleteConfirm(false);
                }}
                className={iconAction}
                aria-label="Cancel delete"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          ) : (
            <>
              <span className="flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                <button onClick={handleStartEdit} className={iconAction} aria-label="Rename">
                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                {canMove && <MoveMeetingMenu meetingId={meeting.id} currentWorkspaceId={meeting.workspace_id} />}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowDeleteConfirm(true);
                  }}
                  className={cn(iconAction, "hover:bg-destructive/10 hover:text-destructive")}
                  aria-label="Delete meeting"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleFavorite?.(meeting.id);
                }}
                className={cn(iconAction, isFavorite ? "text-warning hover:text-warning" : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100")}
                aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
                aria-pressed={isFavorite}
              >
                <Star className="h-3.5 w-3.5" fill={isFavorite ? "currentColor" : "none"} aria-hidden="true" />
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
