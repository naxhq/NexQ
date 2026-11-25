import { useRef, useEffect, useLayoutEffect, useMemo, useState, useCallback } from "react";
import { formatShortcut } from "../../lib/shortcutLabel";
import { useVirtualizer } from "@tanstack/react-virtual";
import { focusAndMarkRow } from "./momentIndex";
import type { TranscriptSegment, SpeakerIdentity, MeetingBookmark, TranslationResult, TranslationDisplayMode } from "../../lib/types";
import type { TranscriptSearchState } from "../../hooks/useTranscriptSearch";
import { useAudioPlayerStore } from "../../stores/audioPlayerStore";
import { useAudioTranscriptSync } from "../../hooks/useAudioTranscriptSync";
import {
  formatTimestamp,
  getSpeakerLabel,
  getSpeakerColor,
} from "../../lib/utils";
import type { MergedSegment } from "../../lib/mergeSegments";
import { FileText, Search, ChevronUp, ChevronDown, X, Globe, RefreshCw, Eye, EyeOff } from "lucide-react";
import { TranscriptContextMenu } from "../../overlay/TranscriptContextMenu";
import { addMeetingBookmark, deleteMeetingBookmark, updateMeetingBookmark } from "../../lib/ipc";
import { showToast } from "../../stores/toastStore";
import { useConfigStore } from "../../stores/configStore";
import { ColorPickerButton } from "../../components/ColorPickerButton";
import { TranscriptRow } from "./TranscriptRow";
import { defaultRemoteSpeakerName, remoteKeyOf, remoteSpeakerColor } from "../../lib/speakerLabels";

interface TranscriptViewProps {
  segments: TranscriptSegment[];
  /** `segments` merged by `mergeConsecutiveSegments` (memoized by the caller) */
  mergedSegments: MergedSegment[];
  /** False while the transcript tab is hidden (kept mounted); pauses auto-scroll */
  isVisible?: boolean;
  search: TranscriptSearchState;
  meetingStartTime?: number;
  /** Recording offset in ms — used for audio-transcript sync */
  recordingOffsetMs?: number;
  /** Saved speakers from meeting — used for post-meeting label/color resolution */
  speakers?: SpeakerIdentity[];
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
  /** Bookmarks for this meeting — read from meeting data */
  bookmarks?: MeetingBookmark[];
  /** Meeting ID for IPC bookmark mutations */
  meetingId?: string;
  /** Callback to update parent state after bookmark mutations */
  onBookmarksChanged?: (bookmarks: MeetingBookmark[]) => void;
  /** Raw segment index to scroll to (from speaker timeline / bookmark navigation) */
  initialScrollToIndex?: number | null;
  /** Called after the initial scroll is handled */
  onScrollHandled?: () => void;
  /** Translations map: segmentId → TranslationResult */
  translations?: Map<string, TranslationResult>;
  /** Set of segment IDs currently being translated */
  translatingSegments?: Set<string>;
  /** Current translation display mode */
  translationDisplayMode?: TranslationDisplayMode;
  /** Current target language from translation settings */
  currentTargetLang?: string;
  /** Whether translations are visible (eye toggle) */
  showTranslations?: boolean;
  /** Callback for on-demand per-segment translation */
  onTranslateSegment?: (segmentId: string, text: string) => void;
  /** Callback for retranslating a mismatched segment */
  onRetranslateSegment?: (segmentId: string, text: string) => void;
  /** Translation toolbar props (merged into bottom bar) */
  showToolbar?: boolean;
  translatedCount?: number;
  totalSegments?: number;
  mismatchedCount?: number;
  onDisplayModeChange?: (mode: TranslationDisplayMode) => void;
  onRetranslateAll?: () => void;
  onToggleTranslationVisibility?: () => void;
  retranslating?: boolean;
  /** Rename a remote speaker (`them:<tag>`); every line with that tag follows. */
  onRenameSpeaker?: (speakerKey: string, name: string) => void;
}

// Speaker colors for timeline blocks
const TIMELINE_COLORS: Record<string, string> = {
  User: "hsl(var(--info))",
  Interviewer: "hsl(var(--primary))",
  Them: "hsl(var(--success))",
  Unknown: "hsl(var(--muted-foreground))",
};

// Virtualized list tuning. Rows are measured once mounted; the estimate only
// sizes rows that have not been rendered yet (a one-line row is ~44 px).
const ESTIMATED_ROW_HEIGHT = 48;
const LIST_PADDING_Y = 8; // matches the former `py-2` wrapper
const OVERSCAN_ROWS = 8;

export function TranscriptView({ segments, mergedSegments, isVisible = true, search, meetingStartTime, recordingOffsetMs = 0, speakers, searchInputRef, bookmarks, meetingId, onBookmarksChanged, initialScrollToIndex, onScrollHandled, translations, translatingSegments, translationDisplayMode, currentTargetLang, showTranslations = true, onTranslateSegment, onRetranslateSegment, showToolbar, translatedCount = 0, totalSegments = 0, mismatchedCount = 0, onDisplayModeChange, onRetranslateAll, onToggleTranslationVisibility, retranslating, onRenameSpeaker }: TranscriptViewProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const localSearchInputRef = useRef<HTMLInputElement | null>(null);
  const setInputRef = useCallback((el: HTMLInputElement | null) => {
    localSearchInputRef.current = el;
    if (searchInputRef) (searchInputRef as React.MutableRefObject<HTMLInputElement | null>).current = el;
  }, [searchInputRef]);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; segmentIndex: number } | null>(null);
  const [noteEdit, setNoteEdit] = useState<{ bookmarkId: string; note: string } | null>(null);
  const noteInputRef = useRef<HTMLTextAreaElement>(null);

  // Audio player store — for active segment highlighting. Play state and
  // seeking are read via getState() in the row click handler, so play/pause
  // does not re-render the transcript.
  const activeSegmentId = useAudioPlayerStore((s) => s.activeSegmentId);

  // Typeset settings — shared with meeting overlay
  const transcriptFontSize = useConfigStore((s) => s.transcriptFontSize);
  const transcriptTextColor = useConfigStore((s) => s.transcriptTextColor);
  const translationFontSize = useConfigStore((s) => s.translationFontSize);
  const translationTextColor = useConfigStore((s) => s.translationTextColor);
  const setTranscriptFontSize = useConfigStore((s) => s.setTranscriptFontSize);
  const setTranscriptTextColor = useConfigStore((s) => s.setTranscriptTextColor);
  const setTranslationFontSize = useConfigStore((s) => s.setTranslationFontSize);
  const setTranslationTextColor = useConfigStore((s) => s.setTranslationTextColor);

  // ── Virtualized rows ──
  const virtualizer = useVirtualizer({
    count: mergedSegments.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    getItemKey: (i) => mergedSegments[i]?.id || i,
    overscan: OVERSCAN_ROWS,
    paddingStart: LIST_PADDING_Y,
    paddingEnd: LIST_PADDING_Y,
  });

  // Every "scroll to segment" goes through here: rows outside the window are
  // not mounted, so there is no element to scrollIntoView.
  const scrollToMergedIndex = useCallback((index: number) => {
    if (index < 0 || index >= virtualizer.options.count) return;
    virtualizer.scrollToIndex(index, { align: "center", behavior: "smooth" });
  }, [virtualizer]);

  // Raw segment id → merged index (every original id of a merged row maps to it)
  const mergedIndexById = useMemo(() => {
    const map = new Map<string, number>();
    mergedSegments.forEach((seg, i) => {
      for (const id of seg.originalIds) map.set(id, i);
    });
    return map;
  }, [mergedSegments]);

  // The view stays mounted while its tab is hidden, and browsers may reset
  // scrollTop on `display: none` without a scroll event. Remember the position
  // while visible and restore it when shown, so the virtualizer stays in sync.
  const isVisibleRef = useRef(isVisible);
  isVisibleRef.current = isVisible;
  const lastScrollTopRef = useRef(0);
  const handleScroll = useCallback(() => {
    if (isVisibleRef.current && scrollRef.current) {
      lastScrollTopRef.current = scrollRef.current.scrollTop;
    }
  }, []);
  useLayoutEffect(() => {
    if (!isVisible) return;
    const el = scrollRef.current;
    if (el && el.scrollTop !== lastScrollTopRef.current) {
      el.scrollTop = lastScrollTopRef.current;
    }
  }, [isVisible]);

  // Bidirectional sync: audio position → active transcript segment + auto-scroll
  const scrollToSegment = useCallback((segmentId: string) => {
    if (!isVisibleRef.current) return;
    const idx = mergedIndexById.get(segmentId);
    if (idx !== undefined) scrollToMergedIndex(idx);
  }, [mergedIndexById, scrollToMergedIndex]);

  useAudioTranscriptSync(
    segments,
    meetingStartTime ?? 0,
    recordingOffsetMs,
    scrollToSegment,
  );

  const toElapsed = (ms: number) =>
    meetingStartTime ? Math.max(0, ms - meetingStartTime) : ms;

  // Build bookmark lookup by segment_id
  const bookmarkBySegment = useMemo(() => {
    const map = new Map<string, MeetingBookmark>();
    if (bookmarks) {
      for (const b of bookmarks) {
        if (b.segment_id) map.set(b.segment_id, b);
      }
    }
    return map;
  }, [bookmarks]);

  // Build speaker lookup from saved speakers for label/color resolution
  const speakerMap = useMemo(() => {
    if (!speakers || speakers.length === 0) return null;
    const map = new Map<string, SpeakerIdentity>();
    for (const s of speakers) map.set(s.id, s);
    return map;
  }, [speakers]);

  // Map raw segment indices → merged segment indices (for search compatibility)
  const rawToMergedIndex = useMemo(() => {
    const map = new Map<number, number>();
    let rawIdx = 0;
    for (let mi = 0; mi < mergedSegments.length; mi++) {
      const ms = mergedSegments[mi];
      for (let k = 0; k < ms.mergedCount; k++) {
        map.set(rawIdx, mi);
        rawIdx++;
      }
    }
    return map;
  }, [mergedSegments]);

  // A tagged line from the other side of an online call goes by its person
  // (named via the `them:<tag>` speaker, else "Speaker N").
  const resolveSpeakerLabel = (seg: TranscriptSegment): string => {
    const remoteKey = remoteKeyOf(seg);
    if (remoteKey && seg.speaker_tag) {
      return speakerMap?.get(remoteKey)?.display_name ?? defaultRemoteSpeakerName(seg.speaker_tag);
    }
    if (speakerMap && seg.speaker_id) {
      const s = speakerMap.get(seg.speaker_id);
      if (s) return s.display_name;
    }
    return getSpeakerLabel(seg.speaker);
  };

  const resolveSpeakerColorClass = (seg: TranscriptSegment): string => {
    if (remoteKeyOf(seg)) return ""; // per-person inline color
    if (speakerMap && seg.speaker_id) {
      const s = speakerMap.get(seg.speaker_id);
      if (s?.color) return ""; // use inline style instead
    }
    return getSpeakerColor(seg.speaker);
  };

  const resolveSpeakerColorHex = (seg: TranscriptSegment): string | undefined => {
    const remoteKey = remoteKeyOf(seg);
    if (remoteKey && seg.speaker_tag) {
      return speakerMap?.get(remoteKey)?.color ?? remoteSpeakerColor(seg.speaker_tag);
    }
    if (speakerMap && seg.speaker_id) {
      const s = speakerMap.get(seg.speaker_id);
      if (s?.color) return s.color;
    }
    return undefined;
  };

  // Scroll to a specific segment (from speaker timeline / bookmark navigation)
  useEffect(() => {
    if (initialScrollToIndex == null) return;
    const mergedIdx = rawToMergedIndex.get(initialScrollToIndex) ?? initialScrollToIndex;
    // Defer to next frame so a just-shown tab has laid out
    const frame = requestAnimationFrame(() => {
      if (mergedIdx >= 0 && mergedIdx < mergedSegments.length) {
        scrollToMergedIndex(mergedIdx);
        setSelectedIndex(mergedIdx);
        // Keyboard and screen reader users land on the line too, and it is marked for a moment.
        if (scrollRef.current) stopFocus = focusAndMarkRow(scrollRef.current, mergedIdx);
      }
      onScrollHandled?.();
    });
    let stopFocus: (() => void) | undefined;
    return () => {
      cancelAnimationFrame(frame);
      stopFocus?.();
    };
  }, [initialScrollToIndex, rawToMergedIndex, mergedSegments.length, scrollToMergedIndex, onScrollHandled]);

  // Search: scroll to match (remap raw index → merged index)
  useEffect(() => {
    if (search.totalMatches === 0) return;
    const match = search.matches[search.currentMatchIndex];
    if (!match) return;
    const mergedIdx = rawToMergedIndex.get(match.segmentIndex) ?? match.segmentIndex;
    scrollToMergedIndex(mergedIdx);
  }, [search.currentMatchIndex, search.matches, search.totalMatches, rawToMergedIndex, scrollToMergedIndex]);

  const activeMatchSegment = search.totalMatches > 0
    ? rawToMergedIndex.get(search.matches[search.currentMatchIndex]?.segmentIndex ?? -1) ?? -1
    : -1;

  const activeMergedIndex = activeSegmentId !== null
    ? mergedIndexById.get(activeSegmentId) ?? -1
    : -1;

  const segmentMatches = useMemo(() => {
    const map = new Map<number, number[]>();
    for (const m of search.matches) {
      // Remap raw segment index to merged segment index
      const mergedIdx = rawToMergedIndex.get(m.segmentIndex) ?? m.segmentIndex;
      if (!map.has(mergedIdx)) map.set(mergedIdx, []);
      map.get(mergedIdx)!.push(m.startOffset);
    }
    return map;
  }, [search.matches, rawToMergedIndex]);

  // Bookmark handlers (IPC-based for past meetings)
  const handleToggleBookmark = useCallback(async (seg: TranscriptSegment) => {
    if (!meetingId || !onBookmarksChanged) return;
    const existing = seg.id ? bookmarkBySegment.get(seg.id) : undefined;
    if (existing) {
      try {
        await deleteMeetingBookmark(existing.id);
        onBookmarksChanged((bookmarks ?? []).filter(b => b.id !== existing.id));
      } catch (err) {
        console.error("[TranscriptView] Delete bookmark failed:", err);
        showToast("Failed to remove bookmark", "error");
      }
    } else {
      const newBookmark: MeetingBookmark = {
        id: crypto.randomUUID(),
        timestamp_ms: seg.timestamp_ms,
        segment_id: seg.id,
        created_at: new Date().toISOString(),
      };
      try {
        await addMeetingBookmark(JSON.stringify({ ...newBookmark, meeting_id: meetingId }));
        onBookmarksChanged([...(bookmarks ?? []), newBookmark]);
      } catch (err) {
        console.error("[TranscriptView] Add bookmark failed:", err);
        showToast("Failed to add bookmark", "error");
      }
    }
  }, [meetingId, bookmarks, bookmarkBySegment, onBookmarksChanged]);

  const handleAddNote = useCallback(async (seg: TranscriptSegment) => {
    if (!meetingId || !onBookmarksChanged) return;
    let bm = seg.id ? bookmarkBySegment.get(seg.id) : undefined;
    if (!bm) {
      bm = {
        id: crypto.randomUUID(),
        timestamp_ms: seg.timestamp_ms,
        segment_id: seg.id,
        created_at: new Date().toISOString(),
      };
      try {
        await addMeetingBookmark(JSON.stringify({ ...bm, meeting_id: meetingId }));
        onBookmarksChanged([...(bookmarks ?? []), bm]);
      } catch (err) {
        console.error("[TranscriptView] Add bookmark for note failed:", err);
        showToast("Failed to create bookmark", "error");
        return;
      }
    }
    setNoteEdit({ bookmarkId: bm.id, note: bm.note ?? "" });
  }, [meetingId, bookmarks, bookmarkBySegment, onBookmarksChanged]);

  const handleSaveNote = useCallback(async () => {
    if (!noteEdit || !onBookmarksChanged) return;
    const trimmedNote = noteEdit.note.trim() || undefined;
    try {
      await updateMeetingBookmark(noteEdit.bookmarkId, trimmedNote ?? null);
      onBookmarksChanged(
        (bookmarks ?? []).map(b => b.id === noteEdit.bookmarkId ? { ...b, note: trimmedNote } : b)
      );
    } catch (err) {
      console.error("[TranscriptView] Update bookmark note failed:", err);
      showToast("Failed to save note", "error");
    }
    setNoteEdit(null);
  }, [noteEdit, bookmarks, onBookmarksChanged]);

  const handleCopyText = useCallback((text: string) => {
    navigator.clipboard.writeText(text);
    showToast("Copied to clipboard", "success");
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent, segmentIndex: number) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, segmentIndex });
  }, []);

  const handleTimelineJump = (index: number) => {
    setSelectedIndex(index);
    scrollToMergedIndex(index);
  };

  // Stable row callbacks: they read the latest values from a ref, so memoised
  // rows are not re-rendered when bookmarks or segments change elsewhere.
  const latestRef = useRef({ mergedSegments, mergedIndexById, handleToggleBookmark });
  latestRef.current = { mergedSegments, mergedIndexById, handleToggleBookmark };

  const handleRowSeek = useCallback((id: string) => {
    const { mergedSegments: merged, mergedIndexById: indexById } = latestRef.current;
    const index = indexById.get(id);
    if (index === undefined) return;
    setSelectedIndex((prev) => (prev === index ? null : index));
    // Click-to-seek: only seeks when audio is already playing
    const { isPlaying, seekToTimestamp } = useAudioPlayerStore.getState();
    if (isPlaying) seekToTimestamp(merged[index].timestamp_ms);
  }, []);

  const handleRowToggleBookmark = useCallback((id: string) => {
    const { mergedSegments: merged, mergedIndexById: indexById, handleToggleBookmark: toggle } = latestRef.current;
    const index = indexById.get(id);
    if (index !== undefined) toggle(merged[index]);
  }, []);

  if (segments.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground/50">
        <FileText className="mb-3 h-8 w-8" />
        <p className="text-sm font-medium">No transcript segments</p>
      </div>
    );
  }

  const translationsEnabled = showTranslations && !!translations;
  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div className="relative flex flex-1 min-h-0 flex-col">
      {/* Always-visible search bar */}
      <div className="flex items-center gap-2 rounded-lg bg-muted/20 mx-1 mt-1 mb-1.5 px-2.5 py-1.5">
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
        <input
          ref={setInputRef}
          type="text"
          value={search.query}
          onChange={(e) => search.setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              if (e.shiftKey) search.prevMatch();
              else search.nextMatch();
            }
          }}
          placeholder="Search transcript..."
          maxLength={200}
          aria-label="Search transcript"
          className="flex-1 bg-transparent text-xs text-foreground/90 placeholder:text-muted-foreground/50 outline-none"
        />
        {search.query && search.totalMatches > 0 && (
          <span className="shrink-0 text-xs tabular-nums font-medium text-muted-foreground/60">
            {search.currentMatchIndex + 1} of {search.totalMatches}
          </span>
        )}
        {search.query && search.totalMatches === 0 && (
          <span className="shrink-0 text-xs text-red-400/60">No matches</span>
        )}
        {search.query && (
          <div className="flex items-center gap-0.5 border-l border-border/20 pl-2">
            <button
              onClick={search.prevMatch}
              disabled={search.totalMatches === 0}
              className="rounded-md p-1 text-muted-foreground/50 hover:bg-secondary hover:text-foreground disabled:opacity-25 cursor-pointer"
            >
              <ChevronUp className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={search.nextMatch}
              disabled={search.totalMatches === 0}
              className="rounded-md p-1 text-muted-foreground/50 hover:bg-secondary hover:text-foreground disabled:opacity-25 cursor-pointer"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => search.setQuery("")}
              className="rounded-md p-1 text-muted-foreground/50 hover:bg-secondary hover:text-foreground cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Timeline */}
      <TimelineScrubber
        segments={segments}
        selectedIndex={selectedIndex}
        onJump={handleTimelineJump}
        meetingStartTime={meetingStartTime}
      />

      {/* Transcript rows (virtualized: only the visible window is mounted) */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-border/20"
      >
        <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
          <div
            className="absolute inset-x-4 top-0"
            style={{ transform: `translateY(${virtualItems[0]?.start ?? 0}px)` }}
          >
            {virtualItems.map((item) => {
              const i = item.index;
              const segment = mergedSegments[i];
              const segBookmark = bookmarkBySegment.get(segment.id);
              const matchOffsets = segmentMatches.get(i);
              return (
                <TranscriptRow
                  key={item.key}
                  segment={segment}
                  index={i}
                  measureRef={virtualizer.measureElement}
                  isActive={i === activeMergedIndex}
                  isSelected={i === selectedIndex}
                  isBookmarked={!!segBookmark}
                  bookmarkNote={segBookmark?.note}
                  translation={translationsEnabled ? translations.get(segment.id) : undefined}
                  isTranslating={translationsEnabled && !!translatingSegments?.has(segment.id)}
                  translationDisplayMode={translationDisplayMode}
                  currentTargetLang={currentTargetLang}
                  matchOffsets={matchOffsets}
                  searchQuery={matchOffsets ? search.query : ""}
                  isSearchMatch={i === activeMatchSegment}
                  timestampLabel={formatTimestamp(toElapsed(segment.timestamp_ms))}
                  speakerLabel={resolveSpeakerLabel(segment)}
                  speakerColorClass={resolveSpeakerColorClass(segment)}
                  speakerColorHex={resolveSpeakerColorHex(segment)}
                  renameKey={onRenameSpeaker ? remoteKeyOf(segment) ?? undefined : undefined}
                  onRenameSpeaker={onRenameSpeaker}
                  transcriptFontSize={transcriptFontSize}
                  transcriptTextColor={transcriptTextColor}
                  translationFontSize={translationFontSize}
                  translationTextColor={translationTextColor}
                  canBookmark={!!meetingId}
                  onSeek={handleRowSeek}
                  onToggleBookmark={handleRowToggleBookmark}
                  onContextMenu={meetingId ? handleContextMenu : undefined}
                  onTranslate={translationsEnabled ? onTranslateSegment : undefined}
                  onRetranslate={translationsEnabled ? onRetranslateSegment : undefined}
                />
              );
            })}
          </div>
        </div>
      </div>

      {/* Right-click context menu for bookmarks */}
      {contextMenu && mergedSegments[contextMenu.segmentIndex] && (
        <TranscriptContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          isBookmarked={!!(mergedSegments[contextMenu.segmentIndex].id && bookmarkBySegment.get(mergedSegments[contextMenu.segmentIndex].id!))}
          onBookmark={() => handleToggleBookmark(mergedSegments[contextMenu.segmentIndex])}
          onAddNote={() => handleAddNote(mergedSegments[contextMenu.segmentIndex])}
          onCopy={() => handleCopyText(mergedSegments[contextMenu.segmentIndex].text)}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Bottom bar — typeset controls (left) + translation toolbar (right) */}
      <div className="flex items-center gap-3 mx-2 px-3 py-1.5 border-t border-border/10 text-[10px]">
        {/* Left: Typeset controls */}
        <div className="flex items-center gap-1">
          <span className="font-semibold text-muted-foreground/60">Text</span>
          <button
            onClick={() => setTranscriptFontSize(Math.max(10, transcriptFontSize - 1))}
            className="flex h-5 w-5 items-center justify-center rounded text-[9px] font-bold text-muted-foreground/60 hover:bg-secondary/30 cursor-pointer"
          >A</button>
          <span className="min-w-[18px] text-center tabular-nums font-semibold text-muted-foreground/50">{transcriptFontSize}</span>
          <button
            onClick={() => setTranscriptFontSize(Math.min(20, transcriptFontSize + 1))}
            className="flex h-5 w-5 items-center justify-center rounded text-[13px] font-bold text-muted-foreground/60 hover:bg-secondary/30 cursor-pointer"
          >A</button>
          <ColorPickerButton value={transcriptTextColor} onChange={setTranscriptTextColor} label="Text color" />
        </div>
        <div className="h-4 w-px bg-border/10" />
        <div className="flex items-center gap-1">
          <span className="font-semibold text-muted-foreground/60">Translation</span>
          <button
            onClick={() => setTranslationFontSize(Math.max(9, translationFontSize - 1))}
            className="flex h-5 w-5 items-center justify-center rounded text-[9px] font-bold text-muted-foreground/60 hover:bg-secondary/30 cursor-pointer"
          >A</button>
          <span className="min-w-[18px] text-center tabular-nums font-semibold text-muted-foreground/50">{translationFontSize}</span>
          <button
            onClick={() => setTranslationFontSize(Math.min(18, translationFontSize + 1))}
            className="flex h-5 w-5 items-center justify-center rounded text-[13px] font-bold text-muted-foreground/60 hover:bg-secondary/30 cursor-pointer"
          >A</button>
          <ColorPickerButton value={translationTextColor} onChange={setTranslationTextColor} label="Translation color" />
        </div>

        {/* Right: Translation toolbar (coverage, display mode, retranslate, visibility) */}
        {showToolbar && (
          <div className="ml-auto flex items-center gap-2">
            {/* Coverage badge */}
            <div className="flex items-center gap-1.5 rounded-full bg-primary/10 px-2 py-0.5">
              <Globe className="h-3 w-3 text-primary/60" />
              <span className="font-semibold tabular-nums text-primary/70">{translatedCount}/{totalSegments}</span>
              <div className="h-[3px] w-8 rounded-full bg-primary/15 overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary/70 transition-all duration-300"
                  style={{ width: `${totalSegments > 0 ? (translatedCount / totalSegments) * 100 : 0}%` }}
                />
              </div>
            </div>

            <div className="h-4 w-px bg-border/10" />

            {/* Inline / Hover toggle */}
            {onDisplayModeChange && (
              <div className="flex rounded-md border border-border/30 overflow-hidden">
                <button
                  onClick={() => onDisplayModeChange("inline")}
                  className={`px-2 py-0.5 font-semibold transition-colors cursor-pointer ${
                    translationDisplayMode === "inline"
                      ? "bg-primary/15 text-primary"
                      : "text-muted-foreground hover:bg-secondary/30"
                  }`}
                >Inline</button>
                <button
                  onClick={() => onDisplayModeChange("hover")}
                  className={`px-2 py-0.5 font-semibold transition-colors cursor-pointer ${
                    translationDisplayMode === "hover"
                      ? "bg-primary/15 text-primary"
                      : "text-muted-foreground hover:bg-secondary/30"
                  }`}
                >Hover</button>
              </div>
            )}

            {/* Retranslate mismatched */}
            {mismatchedCount > 0 && onRetranslateAll && (
              <button
                onClick={onRetranslateAll}
                disabled={retranslating}
                className="flex items-center gap-1 rounded-md px-2 py-0.5 font-semibold bg-amber-500/[0.08] border border-amber-500/20 text-amber-400 hover:bg-amber-500/15 transition-colors disabled:opacity-50 cursor-pointer"
              >
                <RefreshCw className={`h-2.5 w-2.5 ${retranslating ? "animate-spin" : ""}`} />
                {mismatchedCount}
              </button>
            )}

            {/* Visibility toggle */}
            {onToggleTranslationVisibility && (
              <button
                onClick={onToggleTranslationVisibility}
                className="rounded-md p-1 text-primary/50 hover:bg-primary/10 transition-colors cursor-pointer"
                title={showTranslations ? "Hide translations" : "Show translations"}
              >
                {showTranslations ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Note editor modal */}
      {noteEdit && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => setNoteEdit(null)}
        >
          <div
            className="w-full max-w-sm rounded-xl border border-border/30 bg-card p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-foreground mb-3">Bookmark Note</h3>
            <textarea
              ref={noteInputRef}
              value={noteEdit.note}
              onChange={(e) => setNoteEdit({ ...noteEdit, note: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handleSaveNote();
                if (e.key === "Escape") setNoteEdit(null);
              }}
              placeholder="Add a note..."
              rows={3}
              autoFocus
              className="w-full resize-none rounded-lg border border-border/30 bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20"
            />
            <div className="mt-3 flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground/40">{formatShortcut("CmdOrCtrl+Enter")} to save</span>
              <div className="flex gap-2">
                <button
                  onClick={() => setNoteEdit(null)}
                  className="rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-secondary transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveNote}
                  className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer"
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Timeline Scrubber ──

function TimelineScrubber({
  segments,
  selectedIndex,
  onJump,
  meetingStartTime,
}: {
  segments: TranscriptSegment[];
  selectedIndex: number | null;
  onJump: (index: number) => void;
  meetingStartTime?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{
    x: number;
    segmentIndex: number;
    timestamp: string;
    speaker: string;
    text: string;
  } | null>(null);

  if (segments.length < 2) return null;

  const firstTs = segments[0].timestamp_ms;
  const lastTs = segments[segments.length - 1].timestamp_ms;
  const totalDuration = lastTs - firstTs;
  if (totalDuration <= 0) return null;

  // Build merged speaker blocks
  const blocks: { speaker: string; startPct: number; widthPct: number }[] = [];
  let bStart = 0;
  let bSpeaker = segments[0].speaker;
  for (let i = 1; i <= segments.length; i++) {
    if (i === segments.length || segments[i].speaker !== bSpeaker) {
      const endTs = i < segments.length ? segments[i].timestamp_ms : lastTs;
      const startPct = ((segments[bStart].timestamp_ms - firstTs) / totalDuration) * 100;
      const widthPct = ((endTs - segments[bStart].timestamp_ms) / totalDuration) * 100;
      if (widthPct > 0.1) blocks.push({ speaker: bSpeaker, startPct, widthPct });
      if (i < segments.length) { bStart = i; bSpeaker = segments[i].speaker; }
    }
  }

  const findClosest = (clientX: number) => {
    const el = containerRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, x / rect.width));
    const hoverTs = firstTs + ratio * totalDuration;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < segments.length; i++) {
      const d = Math.abs(segments[i].timestamp_ms - hoverTs);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    return { x, idx: best };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const r = findClosest(e.clientX);
    if (!r) return;
    const seg = segments[r.idx];
    const elapsedMs = meetingStartTime ? Math.max(0, seg.timestamp_ms - meetingStartTime) : seg.timestamp_ms;
    setHover({
      x: r.x,
      segmentIndex: r.idx,
      timestamp: formatTimestamp(elapsedMs),
      speaker: getSpeakerLabel(seg.speaker),
      text: seg.text.length > 50 ? seg.text.slice(0, 50) + "..." : seg.text,
    });
  };

  const handleClick = () => { if (hover) onJump(hover.segmentIndex); };

  // Selected position
  const selPct = selectedIndex !== null
    ? ((segments[selectedIndex].timestamp_ms - firstTs) / totalDuration) * 100
    : null;

  // Format as m:ss
  const fmtTime = (ms: number) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  // Duration label for the track
  const durationSec = Math.floor(totalDuration / 1000);
  const durationLabel = durationSec >= 3600
    ? `${Math.floor(durationSec / 3600)}h ${Math.floor((durationSec % 3600) / 60)}m`
    : `${Math.floor(durationSec / 60)}m ${durationSec % 60}s`;

  return (
    <div className="mx-4 mt-2 mb-1">
      {/* Tooltip */}
      {hover && (
        <div
          className="pointer-events-none absolute z-20 -translate-x-1/2"
          style={{ left: `calc(1rem + ${hover.x}px)`, marginTop: -36 }}
        >
          <div className="rounded-lg border border-border/30 bg-card px-3 py-1.5 shadow-xl backdrop-blur-md">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold tabular-nums text-foreground">{hover.timestamp}</span>
              <span className="text-xs text-muted-foreground/60">{hover.speaker}</span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground/50 max-w-[250px] truncate">{hover.text}</p>
          </div>
        </div>
      )}

      {/* Time labels + track */}
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-xs tabular-nums font-medium text-muted-foreground/40 w-8">
          {fmtTime(firstTs - (meetingStartTime || firstTs))}
        </span>

        {/* Track */}
        <div
          ref={containerRef}
          className="relative flex-1 h-4 cursor-pointer rounded-lg bg-secondary/20 overflow-hidden"
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHover(null)}
          onClick={handleClick}
        >
          {blocks.map((b, i) => (
            <div
              key={i}
              className="absolute top-0 h-full rounded-sm"
              style={{
                left: `${b.startPct}%`,
                width: `${b.widthPct}%`,
                backgroundColor: TIMELINE_COLORS[b.speaker] || TIMELINE_COLORS.Unknown,
                opacity: 0.55,
              }}
            />
          ))}

          {/* Selected marker */}
          {selPct !== null && (
            <div
              className="absolute top-0 h-full w-0.5 bg-white shadow-[0_0_8px_rgba(255,255,255,0.6)]"
              style={{ left: `${selPct}%` }}
            />
          )}

          {/* Hover line */}
          {hover && (
            <div
              className="pointer-events-none absolute top-0 h-full w-px bg-white/40"
              style={{ left: hover.x }}
            />
          )}
        </div>

        <span className="shrink-0 text-xs tabular-nums font-medium text-muted-foreground/40 w-8 text-right">
          {fmtTime(lastTs - (meetingStartTime || firstTs))}
        </span>
      </div>

      {/* Duration badge */}
      <div className="flex justify-center mt-0.5">
        <span className="text-meta text-muted-foreground/30">{durationLabel}</span>
      </div>
    </div>
  );
}
