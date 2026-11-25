// Sub-PRD 4 / Task 13: Individual transcript line component
// Displays timestamp, speaker label, and text for a single transcript segment.
// Speaker color is dynamic via speakerStore; confidence underline when enabled.
// SP2 Task 7: Hover bookmark icon, right-click context menu, bookmarked line indicator.

import { readingTextColor } from "../lib/themeText";
import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { Bookmark as BookmarkIcon } from "lucide-react";
import type { TranscriptSegment } from "../lib/types";
import { useMeetingStore } from "../stores/meetingStore";
import { useSpeakerStore } from "../stores/speakerStore";
import { useConfigStore } from "../stores/configStore";
import { useBookmarkStore } from "../stores/bookmarkStore";
import { useTranslationStore } from "../stores/translationStore";
import { TranscriptContextMenu } from "./TranscriptContextMenu";
import { showBookmarkToast } from "./BookmarkToast";
import { defaultRemoteSpeakerName, remoteKeyOf, remoteSpeakerColor } from "../lib/speakerLabels";

// Module-level singleton: ensures only one hover tooltip is visible at a time.
// When a new line is hovered, it dismisses the previous tooltip first.
let dismissActiveTooltip: (() => void) | null = null;

interface TranscriptLineProps {
  segment: TranscriptSegment;
  /** Optional search query to highlight matches */
  searchQuery?: string;
}

/**
 * Renders a single transcript segment with:
 * - Formatted timestamp (MM:SS)
 * - Speaker label with dynamic color from speakerStore
 * - Text content (italic/lighter for interim, normal for final)
 * - Confidence underline when confidenceHighlightEnabled and below threshold
 * - Hover state showing full timestamp with milliseconds
 */
export function TranscriptLine({ segment, searchQuery }: TranscriptLineProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const editRef = useRef<HTMLInputElement>(null);
  const meetingStartTime = useMeetingStore((s) => s.meetingStartTime);
  const confidenceThreshold = useConfigStore((s) => s.confidenceThreshold);
  const confidenceHighlightEnabled = useConfigStore((s) => s.confidenceHighlightEnabled);
  const transcriptFontSize = useConfigStore((s) => s.transcriptFontSize ?? 13);
  const translationFontSize = useConfigStore((s) => s.translationFontSize ?? 12);
  const transcriptTextColor = useConfigStore((s) => s.transcriptTextColor ?? "#e4e4e7");
  const translationTextColor = useConfigStore((s) => s.translationTextColor ?? "#fbbf24");

  // Translation store subscriptions
  const translations = useTranslationStore((s) => s.translations);
  const translating = useTranslationStore((s) => s.translating);
  const displayMode = useTranslationStore((s) => s.displayMode);
  const autoTranslateActive = useTranslationStore((s) => s.autoTranslateActive);

  // SP2 Task 7: Bookmark state + context menu position
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const bookmark = useBookmarkStore((s) => s.getBookmarkForSegment(segment.id));
  const isBookmarked = !!bookmark;
  const toggleBookmark = useBookmarkStore((s) => s.toggleBookmark);

  // Translation for this segment
  const translation = translations.get(segment.id);
  const isTranslating = translating.has(segment.id);

  // Resolve speaker ID — prefer explicit speaker_id, fall back to speaker field
  const baseSpeakerId = segment.speaker_id ?? (segment.speaker === "User" ? "you" : "them");
  const isPending = baseSpeakerId === "__pending";
  // A tagged line from the other side of an online call shows its person
  // ("Speaker 2", or the name given), not the shared "Them".
  const remoteKey = remoteKeyOf({ ...segment, speaker_id: baseSpeakerId });
  const speakerId = remoteKey ?? baseSpeakerId;

  // Reactive: select the actual speaker object — triggers re-render on rename/merge
  const speaker = useSpeakerStore((s) => isPending ? undefined : s.speakers[speakerId]);
  const renameSpeaker = useSpeakerStore((s) => s.renameSpeaker);
  const ensureRemoteSpeaker = useSpeakerStore((s) => s.ensureRemoteSpeaker);

  const speakerLabel = isPending
    ? "..."
    : (speaker?.display_name ?? (remoteKey && segment.speaker_tag ? defaultRemoteSpeakerName(segment.speaker_tag) : speakerId));
  const speakerHex = isPending
    ? "#6b7280"
    : (speaker?.color ?? (remoteKey && segment.speaker_tag ? remoteSpeakerColor(segment.speaker_tag) : "#6b7280"));

  // Convert epoch timestamp to elapsed time since meeting start
  const elapsedMs = meetingStartTime
    ? Math.max(0, segment.timestamp_ms - meetingStartTime)
    : segment.timestamp_ms;

  const totalSeconds = Math.floor(elapsedMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const millis = elapsedMs % 1000;

  const shortTimestamp = hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
  const fullTimestamp = `${shortTimestamp}.${String(millis).padStart(3, "0")}`;

  // Inline rename: don't allow for pending or fixed speakers (you, them, room)
  const canRename = !isPending && speakerId !== "you" && speakerId !== "them" && speakerId !== "room";

  const startEditing = () => {
    if (!canRename) return;
    setEditName(speakerLabel);
    setIsEditing(true);
    setTimeout(() => editRef.current?.select(), 0);
  };

  const commitRename = () => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== speakerLabel) {
      if (remoteKey && segment.speaker_tag) ensureRemoteSpeaker(segment.speaker_tag);
      renameSpeaker(speakerId, trimmed);
    }
    setIsEditing(false);
  };

  const cancelRename = () => {
    setIsEditing(false);
  };

  // SP2 Task 7: Bookmark handlers
  const handleToggleBookmark = () => {
    const result = toggleBookmark(segment.id, segment.timestamp_ms);
    if (result) {
      const offsetMs = meetingStartTime ? segment.timestamp_ms - meetingStartTime : segment.timestamp_ms;
      showBookmarkToast(result.id, offsetMs);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(segment.text);
  };

  const handleAddNote = () => {
    let bm = bookmark;
    if (!bm) {
      bm = useBookmarkStore.getState().addBookmark(segment.timestamp_ms, undefined, segment.id);
    }
    const offsetMs = meetingStartTime ? segment.timestamp_ms - meetingStartTime : segment.timestamp_ms;
    showBookmarkToast(bm.id, offsetMs);
  };

  // Confidence underline: low confidence text gets a dotted underline + reduced opacity
  const isLowConfidence =
    segment.is_final &&
    confidenceHighlightEnabled &&
    segment.confidence > 0 &&
    segment.confidence < confidenceThreshold;

  // Words still being recognized at the end of a final line (interim),
  // shown dimmed after its final text.
  const pendingTail =
    segment.pending_text && segment.pending_text.startsWith(segment.text)
      ? segment.pending_text.slice(segment.text.length)
      : null;

  // Highlight search matches in text
  const renderText = () => {
    const text = segment.text;

    if (!searchQuery || searchQuery.trim().length === 0) {
      return <span>{text}</span>;
    }

    const query = searchQuery.trim().toLowerCase();
    const lowerText = text.toLowerCase();
    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    let matchIndex = lowerText.indexOf(query, lastIndex);

    while (matchIndex !== -1) {
      // Text before match
      if (matchIndex > lastIndex) {
        parts.push(
          <span key={`t-${lastIndex}`}>{text.slice(lastIndex, matchIndex)}</span>
        );
      }
      // Highlighted match
      parts.push(
        <span
          key={`m-${matchIndex}`}
          className="rounded-sm bg-highlight/30 px-0.5 text-highlight"
        >
          {text.slice(matchIndex, matchIndex + query.length)}
        </span>
      );
      lastIndex = matchIndex + query.length;
      matchIndex = lowerText.indexOf(query, lastIndex);
    }

    // Remaining text after last match
    if (lastIndex < text.length) {
      parts.push(<span key={`t-${lastIndex}`}>{text.slice(lastIndex)}</span>);
    }

    return <>{parts}</>;
  };

  // Hover translation tooltip state
  const [showTranslationTooltip, setShowTranslationTooltip] = useState(false);
  const hasHoverTranslation = displayMode === "hover" && !!translation;
  const lineRef = useRef<HTMLDivElement>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

  // Dismiss this tooltip (used by module-level singleton + scroll handler)
  const dismissTooltip = () => {
    setShowTranslationTooltip(false);
    setIsHovered(false);
    if (dismissActiveTooltip === dismissTooltip) dismissActiveTooltip = null;
  };

  // Sync tooltip visibility when displayMode changes while already hovering
  useEffect(() => {
    if (isHovered && hasHoverTranslation) {
      setShowTranslationTooltip(true);
      dismissActiveTooltip = dismissTooltip;
    } else if (!hasHoverTranslation) {
      setShowTranslationTooltip(false);
    }
  }, [isHovered, hasHoverTranslation]);

  // Dismiss tooltip when scroll container scrolls (auto-scroll moves line from under cursor)
  useEffect(() => {
    if (!showTranslationTooltip || !lineRef.current) return;
    const scrollParent = lineRef.current.closest("[data-scroll-container]") as HTMLElement | null;
    if (!scrollParent) return;
    const handleScroll = () => dismissTooltip();
    scrollParent.addEventListener("scroll", handleScroll, { passive: true });
    return () => scrollParent.removeEventListener("scroll", handleScroll);
  }, [showTranslationTooltip]);

  return (
    <div
      ref={lineRef}
      data-segment-id={segment.id}
      className={`group relative flex items-start gap-2.5 rounded-lg px-2 py-[7px] transition-colors duration-100 hover:bg-accent/25 border-l-[3px] transcript-line-enter`}
      style={{ borderLeftColor: isBookmarked ? 'hsl(var(--primary))' : isPending ? "transparent" : `${speakerHex}66` }}
      onMouseEnter={(e) => {
        // Dismiss any other line's tooltip first (singleton)
        dismissActiveTooltip?.();
        setIsHovered(true);
        setMousePos({ x: e.clientX, y: e.clientY });
        if (hasHoverTranslation) {
          setShowTranslationTooltip(true);
          dismissActiveTooltip = dismissTooltip;
        }
      }}
      onMouseLeave={dismissTooltip}
      onContextMenu={handleContextMenu}
    >
      {/* Timestamp */}
      <span
        className="mt-[3px] shrink-0 text-[0.6875rem] tabular-nums text-muted-foreground/45 font-medium tracking-tight"
        title={fullTimestamp}
      >
        {isHovered ? fullTimestamp : shortTimestamp}
      </span>

      {/* Speaker label — click to rename */}
      {isEditing ? (
        <input
          ref={editRef}
          type="text"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") cancelRename();
          }}
          maxLength={40}
          className="mt-[2px] shrink-0 w-20 rounded bg-white/5 border border-purple-400/30 px-1 py-0 text-[0.6875rem] font-semibold outline-none"
          style={{ color: speakerHex }}
        />
      ) : (
        <span
          className={`mt-[3px] shrink-0 text-[0.6875rem] font-semibold tracking-tight ${canRename ? "cursor-pointer hover:underline" : ""} ${isPending ? "animate-pulse" : ""}`}
          style={{ color: speakerHex }}
          onClick={startEditing}
          title={canRename ? "Click to rename" : undefined}
        >
          {speakerLabel}
        </span>
      )}

      {/* Text content + translation + bookmark note */}
      <div className="flex-1 min-w-0 relative">
        <span
          className={`leading-[1.65] ${
            segment.is_final
              ? "text-foreground"
              : "text-foreground/45 italic"
          } ${
            isLowConfidence
              ? "border-b border-dotted border-white/30 opacity-70"
              : ""
          }`}
          style={{ fontSize: `${transcriptFontSize}px`, color: segment.is_final ? readingTextColor(transcriptTextColor) : undefined }}
          title={
            isLowConfidence
              ? `Confidence: ${Math.round(segment.confidence * 100)}%`
              : undefined
          }
        >
          {renderText()}
          {pendingTail && (
            <span className="italic" style={{ opacity: 0.45 }}>
              {pendingTail}
            </span>
          )}
        </span>

        {/* Inline translation — visible below the original text */}
        {displayMode === "inline" && (
          <div className="mt-1 leading-[1.5]" style={{ fontSize: `${translationFontSize}px`, color: translationTextColor }}>
            {isTranslating ? (
              <span className="text-muted-foreground/40 animate-pulse">Translating...</span>
            ) : translation ? (
              translation.translated_text
            ) : null}
          </div>
        )}

        {/* Hover translation tooltip — rendered via portal to bypass transform containing block */}
        {showTranslationTooltip && hasHoverTranslation && createPortal(
          <div
            className="fixed z-[9999] max-w-[420px] rounded-lg border border-white/15 px-3.5 py-2.5 shadow-2xl pointer-events-none"
            style={{
              backgroundColor: '#1a1a2e',
              left: `${Math.min(mousePos.x + 16, window.innerWidth - 440)}px`,
              top: `${Math.max(8, mousePos.y - 90)}px`,
            }}
          >
            <p style={{ fontSize: `${translationFontSize + 1}px`, color: translationTextColor }} className="leading-[1.6]">
              {translation.translated_text}
            </p>
            <div className="mt-1.5 flex items-center gap-1.5 text-[0.6rem] text-muted-foreground/50">
              <span className="rounded bg-white/8 px-1.5 py-0.5 font-medium tracking-wider">
                {translation.source_lang.toUpperCase()} → {translation.target_lang.toUpperCase()}
              </span>
              <span>·</span>
              <span>{translation.provider}</span>
            </div>
          </div>,
          document.body
        )}

        {/* Bookmark note — quote-style, sized proportional to transcript text */}
        {isBookmarked && bookmark?.note && (
          <div
            className="mt-1.5 flex items-start gap-2 rounded-md border-l-2 border-primary/30 bg-primary/5 px-2.5 py-1.5"
          >
            <p
              className="leading-[1.5] text-primary/70 italic"
              style={{ fontSize: `${Math.max(11, transcriptFontSize - 2)}px` }}
            >
              {bookmark.note}
            </p>
          </div>
        )}
      </div>

      {/* Hover bookmark icon */}
      <div className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={handleToggleBookmark}
          className="rounded p-0.5 hover:bg-accent/50 transition-colors"
          title={isBookmarked ? "Remove bookmark" : "Bookmark this line"}
        >
          <BookmarkIcon className={`h-3 w-3 ${isBookmarked ? "fill-primary text-primary" : "text-muted-foreground/40"}`} />
        </button>
      </div>

      {/* Right-click context menu — rendered via portal to bypass transform containing block */}
      {contextMenu && createPortal(
        <TranscriptContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          isBookmarked={isBookmarked}
          onBookmark={handleToggleBookmark}
          onAddNote={handleAddNote}
          onCopy={handleCopy}
          onClose={() => setContextMenu(null)}
        />,
        document.body
      )}
    </div>
  );
}
