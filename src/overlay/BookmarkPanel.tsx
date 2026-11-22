import { useBookmarkStore } from "../stores/bookmarkStore";
import { useMeetingStore } from "../stores/meetingStore";
import { formatDurationLong } from "../lib/utils";
import { Bookmark, Trash2 } from "lucide-react";
import { useState } from "react";
import type { MeetingBookmark } from "../lib/types";

/** Scroll to a transcript line by segment ID and briefly highlight it */
function scrollToSegment(segmentId?: string) {
  if (!segmentId) return;
  const el = document.querySelector(`[data-segment-id="${segmentId}"]`);
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("ring-1", "ring-primary/40");
    setTimeout(() => el.classList.remove("ring-1", "ring-primary/40"), 1500);
  }
}

export function BookmarkPanel() {
  const bookmarks = useBookmarkStore((s) => s.bookmarks);
  const removeBookmark = useBookmarkStore((s) => s.removeBookmark);
  const updateBookmarkNote = useBookmarkStore((s) => s.updateBookmarkNote);
  const meetingStartTime = useMeetingStore((s) => s.meetingStartTime);
  const sorted = [...bookmarks].sort((a, b) => a.timestamp_ms - b.timestamp_ms);

  if (sorted.length === 0) {
    return (
      <div className="flex items-center justify-center py-6 text-muted-foreground/40">
        <p className="text-xs">No bookmarks yet. Right-click a line or press B to bookmark.</p>
      </div>
    );
  }

  return (
    <div className="max-h-40 overflow-y-auto px-2 py-1.5">
      <div className="mb-1 flex items-center gap-1.5 px-1">
        <Bookmark className="h-3 w-3 text-primary/60" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/40">
          Bookmarks ({sorted.length})
        </span>
      </div>
      <div className="space-y-0.5">
        {sorted.map((b) => (
          <BookmarkRow
            key={b.id}
            bookmark={b}
            meetingStartTime={meetingStartTime}
            onUpdateNote={(note) => updateBookmarkNote(b.id, note)}
            onRemove={() => removeBookmark(b.id)}
          />
        ))}
      </div>
    </div>
  );
}

function BookmarkRow({
  bookmark,
  meetingStartTime,
  onUpdateNote,
  onRemove,
}: {
  bookmark: MeetingBookmark;
  meetingStartTime: number | null;
  onUpdateNote: (note: string) => void;
  onRemove: () => void;
}) {
  const [editNote, setEditNote] = useState(bookmark.note ?? "");
  const [editing, setEditing] = useState(false);

  // Convert epoch timestamp to elapsed time since meeting start
  const elapsedMs = meetingStartTime
    ? Math.max(0, bookmark.timestamp_ms - meetingStartTime)
    : bookmark.timestamp_ms;

  return (
    <div className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-secondary/20">
      <button
        onClick={() => scrollToSegment(bookmark.segment_id)}
        className="shrink-0 rounded-md bg-primary/10 px-1.5 py-0.5 hover:bg-primary/20 transition-colors cursor-pointer"
        title="Jump to line"
      >
        <span className="tabular-nums text-[10px] font-semibold text-primary">
          {formatDurationLong(elapsedMs)}
        </span>
      </button>
      <div className="flex-1 min-w-0">
        {editing ? (
          <input
            autoFocus
            value={editNote}
            onChange={(e) => setEditNote(e.target.value)}
            onBlur={() => { onUpdateNote(editNote); setEditing(false); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { onUpdateNote(editNote); setEditing(false); }
              if (e.key === "Escape") setEditing(false);
            }}
            maxLength={500}
            placeholder="Add note..."
            className="w-full bg-transparent text-xs text-foreground/80 placeholder:text-muted-foreground/30 outline-none"
          />
        ) : (
          <span
            onClick={() => setEditing(true)}
            className="block truncate text-xs text-foreground/60 hover:text-foreground/80 cursor-text"
          >
            {bookmark.note || <span className="italic text-muted-foreground/30">Add note...</span>}
          </span>
        )}
      </div>
      <button onClick={onRemove} className="shrink-0 text-muted-foreground/30 hover:text-destructive cursor-pointer">
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}
