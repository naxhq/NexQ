// Task 16: Bookmark hook
// Returns addBookmarkAtNow(), which adds a bookmark at the current meeting offset
// (the B key and the toolbar button call it).

import { useCallback } from "react";
import { useMeetingStore } from "../stores/meetingStore";
import { useBookmarkStore } from "../stores/bookmarkStore";
import { showBookmarkToast } from "../overlay/BookmarkToast";

export function useBookmarkHotkey(): () => void {
  const isRecording = useMeetingStore((s) => s.isRecording);
  const meetingStartTime = useMeetingStore((s) => s.meetingStartTime);
  const addBookmark = useBookmarkStore((s) => s.addBookmark);

  const addBookmarkAtNow = useCallback(() => {
    if (!isRecording || !meetingStartTime) return;
    const offsetMs = Date.now() - meetingStartTime;
    const bookmark = addBookmark(offsetMs);
    showBookmarkToast(bookmark.id, offsetMs);
  }, [isRecording, meetingStartTime, addBookmark]);

  // No key handler here: Ctrl+B is the global "switch overlay / dashboard"
  // shortcut (the OS takes the key before the window sees it), and the B key
  // is handled by useMeetingShortcuts.
  return addBookmarkAtNow;
}
