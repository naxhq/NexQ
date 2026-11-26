import { useState, useRef, useEffect, useCallback } from "react";
import type { Meeting, MeetingBookmark } from "../../lib/types";
import type { BookmarkSuggestionsState } from "../../hooks/useBookmarkSuggestions";
import { updateMeetingBookmark, deleteMeetingBookmark } from "../../lib/ipc";
import { showToast } from "../../stores/toastStore";
import { useAudioPlayerStore } from "../../stores/audioPlayerStore";
import { Bookmark, Trash2, Pencil, Sparkles, Check, X, Loader2 } from "lucide-react";
import { formatTimestamp, formatRelativeTime } from "../../lib/utils";
import { relMs } from "../../lib/time";

interface BookmarksTabProps {
  meeting: Meeting;
  onBookmarkUpdated: (bookmarks: MeetingBookmark[]) => void;
  onNavigateToBookmark?: (bookmark: MeetingBookmark) => void;
  suggestions?: BookmarkSuggestionsState;
}

export function BookmarksTab({ meeting, onBookmarkUpdated, onNavigateToBookmark, suggestions }: BookmarksTabProps) {
  const bookmarks = meeting.bookmarks ?? [];
  const meetingStartMs = new Date(meeting.start_time).getTime();
  const hasSuggestions = suggestions && suggestions.suggestions.length > 0;
  const canSuggest = suggestions && !suggestions.isSuggesting && meeting.transcript.length > 0;

  if (bookmarks.length === 0 && !hasSuggestions) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground/50">
        <Bookmark className="mb-3 h-6 w-6" />
        <p className="text-xs font-medium">No bookmarks yet</p>
        <p className="mt-1 text-[11px] text-muted-foreground/40">
          You can add bookmarks from the Transcript tab
        </p>
        {suggestions && (
          <button
            type="button"
            onClick={suggestions.isSuggesting ? suggestions.cancel : suggestions.suggest}
            disabled={!canSuggest && !suggestions.isSuggesting}
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-dashed border-primary/30 bg-primary/5 px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/10 hover:border-primary/50 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            {suggestions.isSuggesting ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                Analyzing...
              </>
            ) : (
              <>
                <Sparkles className="h-3 w-3" />
                Suggest Bookmarks
              </>
            )}
          </button>
        )}
        {suggestions?.error && (
          suggestions.error.startsWith("info:") ? (
            <p className="mt-3 max-w-[260px] text-center text-[11px] leading-relaxed text-muted-foreground/50">
              {suggestions.error.slice(5)}
            </p>
          ) : (
            <p className="mt-2 text-[11px] text-red-400">{suggestions.error}</p>
          )
        )}
      </div>
    );
  }

  const sorted = [...bookmarks].sort((a, b) => a.timestamp_ms - b.timestamp_ms);

  return (
    <div className="p-3">
      {/* Top bar with count + suggest button */}
      <div className="mb-2 flex items-center justify-between px-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/40">
          {bookmarks.length} bookmark{bookmarks.length !== 1 ? "s" : ""}
        </span>
        {suggestions && (
          <button
            type="button"
            onClick={suggestions.isSuggesting ? suggestions.cancel : suggestions.suggest}
            disabled={!canSuggest && !suggestions.isSuggesting}
            className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-medium text-primary transition-colors hover:bg-primary/10 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            {suggestions.isSuggesting ? (
              <>
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
                Analyzing...
              </>
            ) : (
              <>
                <Sparkles className="h-2.5 w-2.5" />
                Suggest
              </>
            )}
          </button>
        )}
      </div>

      {suggestions?.error && (
        suggestions.error.startsWith("info:") ? (
          <p className="mb-2 px-1 text-[11px] leading-relaxed text-muted-foreground/50">
            {suggestions.error.slice(5)}
          </p>
        ) : (
          <p className="mb-2 px-1 text-[11px] text-red-400">{suggestions.error}</p>
        )
      )}

      {/* AI Suggestions section */}
      {hasSuggestions && (
        <SuggestionsSection
          suggestions={suggestions}
          meetingStartMs={meetingStartMs}
        />
      )}

      {/* Existing bookmarks */}
      <div className="space-y-1">
        {sorted.map((bookmark) => {
          const relativeMs = relMs(bookmark.timestamp_ms, meetingStartMs);
          return (
            <BookmarkRow
              key={bookmark.id}
              bookmark={bookmark}
              relativeMs={relativeMs}
              allBookmarks={bookmarks}
              onBookmarkUpdated={onBookmarkUpdated}
              onNavigateToBookmark={onNavigateToBookmark}
            />
          );
        })}
      </div>
    </div>
  );
}

// -- AI Suggestions section ---------------------------------------------------

function SuggestionsSection({
  suggestions,
  meetingStartMs,
}: {
  suggestions: BookmarkSuggestionsState;
  meetingStartMs: number;
}) {
  return (
    <div className="mb-3 rounded-xl border border-dashed border-primary/25 bg-primary/[0.03] p-2.5">
      {/* Header */}
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Sparkles className="h-3 w-3 text-primary/60" />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-primary/60">
            AI Suggestions
          </span>
          <span className="rounded-full bg-primary/10 px-1.5 py-px text-[9px] font-bold text-primary/70">
            {suggestions.suggestions.length}
          </span>
        </div>
        <button
          type="button"
          onClick={suggestions.acceptAll}
          className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-medium text-success transition-colors hover:bg-success/10 cursor-pointer"
        >
          <Check className="h-2.5 w-2.5" />
          Accept All
        </button>
      </div>

      {/* Suggestion rows */}
      <div className="space-y-1">
        {suggestions.suggestions.map((suggestion, index) => {
          const relativeMs = relMs(suggestion.timestamp_ms, meetingStartMs);
          return (
            <div
              key={`suggestion-${index}`}
              className="group flex items-start gap-2 rounded-lg px-2 py-2 transition-colors hover:bg-primary/5"
            >
              {/* Timestamp chip */}
              <span className="mt-0.5 shrink-0 rounded-md bg-primary/10 px-1.5 py-0.5">
                <span className="tabular-nums text-[10px] font-semibold text-primary">
                  {formatTimestamp(relativeMs)}
                </span>
              </span>

              {/* Note text */}
              <span className="min-w-0 flex-1 text-xs leading-relaxed text-foreground/70">
                {suggestion.note}
              </span>

              {/* Accept / Dismiss buttons */}
              <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  type="button"
                  onClick={() => suggestions.acceptSuggestion(index)}
                  className="rounded-md p-1 text-success/60 hover:text-success hover:bg-success/10 transition-colors cursor-pointer"
                  title="Accept suggestion"
                >
                  <Check className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={() => suggestions.dismissSuggestion(index)}
                  className="rounded-md p-1 text-muted-foreground/40 hover:text-foreground/60 hover:bg-secondary/30 transition-colors cursor-pointer"
                  title="Dismiss suggestion"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// -- Individual bookmark row with inline editing ------------------------------

interface BookmarkRowProps {
  bookmark: MeetingBookmark;
  relativeMs: number;
  allBookmarks: MeetingBookmark[];
  onBookmarkUpdated: (bookmarks: MeetingBookmark[]) => void;
  onNavigateToBookmark?: (bookmark: MeetingBookmark) => void;
}

function BookmarkRow({
  bookmark,
  relativeMs,
  allBookmarks,
  onBookmarkUpdated,
  onNavigateToBookmark,
}: BookmarkRowProps) {
  const isPlaying = useAudioPlayerStore((s) => s.isPlaying);
  const seekToTimestamp = useAudioPlayerStore((s) => s.seekToTimestamp);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(bookmark.note ?? "");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input when entering edit mode
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const startEditing = useCallback(() => {
    setEditValue(bookmark.note ?? "");
    setEditing(true);
  }, [bookmark.note]);

  const cancelEditing = useCallback(() => {
    setEditing(false);
    setEditValue(bookmark.note ?? "");
  }, [bookmark.note]);

  const saveNote = useCallback(async () => {
    const trimmed = editValue.trim();
    const newNote = trimmed || null;

    // No change — just close
    if (newNote === (bookmark.note ?? null)) {
      setEditing(false);
      return;
    }

    setSaving(true);
    try {
      await updateMeetingBookmark(bookmark.id, newNote);
      const updated = allBookmarks.map((b) =>
        b.id === bookmark.id ? { ...b, note: newNote ?? undefined } : b,
      );
      onBookmarkUpdated(updated);
      setEditing(false);
    } catch (err) {
      console.error("[BookmarksTab] Failed to update bookmark:", err);
      showToast("Failed to update bookmark note", "error");
    } finally {
      setSaving(false);
    }
  }, [editValue, bookmark.id, bookmark.note, allBookmarks, onBookmarkUpdated]);

  const handleDelete = useCallback(async () => {
    try {
      await deleteMeetingBookmark(bookmark.id);
      const updated = allBookmarks.filter((b) => b.id !== bookmark.id);
      onBookmarkUpdated(updated);
    } catch (err) {
      console.error("[BookmarksTab] Failed to delete bookmark:", err);
      showToast("Failed to delete bookmark", "error");
    }
  }, [bookmark.id, allBookmarks, onBookmarkUpdated]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        saveNote();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelEditing();
      }
    },
    [saveNote, cancelEditing],
  );

  return (
    <div className="group flex items-start gap-2.5 rounded-xl px-3 py-2.5 hover:bg-secondary/20 transition-colors">
      {/* Timestamp chip — clickable */}
      <button
        type="button"
        onClick={() => {
          onNavigateToBookmark?.(bookmark);
          if (isPlaying) seekToTimestamp(bookmark.timestamp_ms);
        }}
        className="mt-0.5 shrink-0 rounded-md bg-primary/10 px-1.5 py-0.5 transition-colors hover:bg-primary/20 cursor-pointer"
        title="Go to this moment in transcript"
      >
        <span className="tabular-nums text-[10px] font-semibold text-primary">
          {formatTimestamp(relativeMs)}
        </span>
      </button>

      {/* Content — inline editable note */}
      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            ref={inputRef}
            type="text"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={saveNote}
            onKeyDown={handleKeyDown}
            disabled={saving}
            className="w-full rounded-md border border-border/50 bg-background/50 px-2 py-1 text-xs leading-relaxed text-foreground/80 outline-none focus:border-ring focus:ring-1 focus:ring-primary/20 disabled:opacity-50"
            placeholder="Add a note..."
          />
        ) : (
          <button
            type="button"
            onClick={startEditing}
            className="w-full text-left cursor-pointer rounded-md px-1 py-0.5 -mx-1 transition-colors hover:bg-secondary/30"
            title="Click to edit note"
          >
            {bookmark.note ? (
              <span className="text-xs leading-relaxed text-foreground/80">{bookmark.note}</span>
            ) : (
              <span className="text-xs italic text-muted-foreground/40">No note — click to add</span>
            )}
          </button>
        )}
        <p className="mt-0.5 text-[10px] text-muted-foreground/35">
          {formatRelativeTime(bookmark.created_at)}
        </p>
      </div>

      {/* Actions — visible on hover */}
      {!editing && (
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            type="button"
            onClick={startEditing}
            className="rounded-md p-1 text-muted-foreground/40 hover:text-foreground/60 hover:bg-secondary/30 transition-colors cursor-pointer"
            title="Edit note"
          >
            <Pencil className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={handleDelete}
            className="rounded-md p-1 text-muted-foreground/40 hover:text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
            title="Delete bookmark"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
}
