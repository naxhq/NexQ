import { memo, useCallback, useEffect, useRef, useState } from "react";
import { readableOn, readingTextColor, useIsLight } from "../../lib/themeText";
import { createPortal } from "react-dom";
import { Bookmark as BookmarkIcon, Globe, RefreshCw } from "lucide-react";
import type { TranslationResult, TranslationDisplayMode } from "../../lib/types";
import type { MergedSegment } from "../../lib/mergeSegments";

export interface TranscriptRowProps {
  segment: MergedSegment;
  /** Merged-segment index; written to `data-index` for the virtualizer. */
  index: number;
  /** Virtualizer `measureElement` (stable callback ref). */
  measureRef?: (el: HTMLElement | null) => void;
  isActive: boolean;
  isSelected: boolean;
  isBookmarked: boolean;
  bookmarkNote?: string;
  /** Translation for this segment; undefined when none or translations are hidden. */
  translation?: TranslationResult;
  isTranslating?: boolean;
  translationDisplayMode?: TranslationDisplayMode;
  currentTargetLang?: string;
  /** Search highlight offsets for this row (undefined when the row has no matches). */
  matchOffsets?: number[];
  searchQuery: string;
  isSearchMatch: boolean;
  timestampLabel: string;
  speakerLabel: string;
  speakerColorClass: string;
  speakerColorHex?: string;
  /** Remote speaker key (`them:S1`) when the speaker label can be renamed. */
  renameKey?: string;
  onRenameSpeaker?: (speakerKey: string, name: string) => void;
  transcriptFontSize: number;
  transcriptTextColor: string;
  translationFontSize: number;
  translationTextColor: string;
  /** Show the hover bookmark button and enable the context menu. */
  canBookmark: boolean;
  /** Row clicked: toggles selection and seeks the audio when it is playing. */
  onSeek: (id: string) => void;
  onToggleBookmark: (id: string) => void;
  onContextMenu?: (e: React.MouseEvent, index: number) => void;
  onTranslate?: (id: string, text: string) => void;
  onRetranslate?: (id: string, text: string) => void;
}

function TranscriptRowImpl({
  segment,
  index,
  measureRef,
  isActive,
  isSelected,
  isBookmarked,
  bookmarkNote,
  translation,
  isTranslating = false,
  translationDisplayMode,
  currentTargetLang,
  matchOffsets,
  searchQuery,
  isSearchMatch,
  timestampLabel,
  speakerLabel,
  speakerColorClass,
  speakerColorHex,
  renameKey,
  onRenameSpeaker,
  transcriptFontSize,
  transcriptTextColor,
  translationFontSize,
  translationTextColor,
  canBookmark,
  onSeek,
  onToggleBookmark,
  onContextMenu,
  onTranslate,
  onRetranslate,
}: TranscriptRowProps) {
  const mode = useIsLight() ? "light" : "dark";
  const rowRef = useRef<HTMLDivElement | null>(null);
  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      rowRef.current = el;
      measureRef?.(el);
    },
    [measureRef],
  );

  const isMismatched = !!(translation && currentTargetLang && translation.target_lang !== currentTargetLang);

  return (
    <div
      ref={setRef}
      data-index={index}
      data-testid="transcript-row"
      data-segment-id={segment.id}
      tabIndex={-1}
      data-active={isActive || undefined}
      onClick={() => onSeek(segment.id)}
      onContextMenu={onContextMenu ? (e) => onContextMenu(e, index) : undefined}
      className={`group relative flex items-start gap-3 rounded-lg px-3 py-2 cursor-pointer transition-all duration-100 border-l-2 ${
        isActive
          ? "border-l-indigo-400 bg-indigo-500/[0.08]"
          : segment.speaker === "User" ? "border-l-speaker-user/20" : "border-l-speaker-interviewer/20"
      } ${
        isSelected
          ? "bg-primary/10 ring-1 ring-primary/20"
          : isSearchMatch
            ? "bg-highlight/10 ring-1 ring-highlight/20"
            : isActive
              ? ""
              : "hover:bg-secondary/20"
      }`}
    >
      {/* Timestamp */}
      <span className={`shrink-0 pt-0.5 text-xs tabular-nums font-medium ${
        isSelected ? "text-primary/70" : "text-muted-foreground/50"
      }`}>
        {timestampLabel}
      </span>

      {/* Bookmarked indicator — subtle filled icon near speaker label */}
      {isBookmarked && (
        <BookmarkIcon className="mt-1 h-2.5 w-2.5 shrink-0 fill-primary text-primary opacity-60" />
      )}

      {/* Speaker — a remote person's name can be set (click) */}
      {renameKey && onRenameSpeaker ? (
        <SpeakerNameEditor
          speakerKey={renameKey}
          label={speakerLabel}
          colorClass={speakerColorClass}
          colorHex={speakerColorHex}
          onRename={onRenameSpeaker}
        />
      ) : (
        <span
          className={`shrink-0 pt-0.5 text-xs font-bold ${speakerColorClass}`}
          style={speakerColorHex ? { color: readableOn(speakerColorHex, mode) } : undefined}
        >
          {speakerLabel}
        </span>
      )}

      {/* Text content + bookmark note */}
      <div className="flex-1 min-w-0">
        <span
          className="leading-relaxed"
          style={{
            fontSize: `${transcriptFontSize}px`,
            color: isSelected ? undefined : readingTextColor(transcriptTextColor),
          }}
        >
          {matchOffsets
            ? highlightText(segment.text, searchQuery, matchOffsets, isSearchMatch)
            : segment.text}
        </span>

        {/* Translation — inline, translating, or translate-on-demand button */}
        {isTranslating ? (
          <div className="mt-1 leading-[1.5]" style={{ fontSize: `${translationFontSize}px` }}>
            <span className="text-muted-foreground/40 animate-pulse">Translating...</span>
          </div>
        ) : translation && translationDisplayMode === "inline" ? (
          <div className="mt-1 flex items-baseline gap-1.5 leading-[1.5]">
            <span style={{ fontSize: `${translationFontSize}px`, color: readableOn(translationTextColor, mode) }}>
              {translation.translated_text}
            </span>
            <span className={`shrink-0 rounded px-1 py-px text-[9px] font-bold tracking-wide ${
              isMismatched
                ? "text-orange-400 bg-orange-500/[0.08] border border-orange-500/15"
                : "text-muted-foreground/50 bg-foreground/[0.04]"
            }`}>
              {translation.source_lang.toUpperCase()} → {translation.target_lang.toUpperCase()}
            </span>
            {isMismatched && onRetranslate && segment.id && (
              <button
                onClick={(e) => { e.stopPropagation(); onRetranslate(segment.id, segment.text); }}
                className="shrink-0 flex items-center gap-0.5 rounded px-1 py-px text-[9px] font-semibold text-orange-400 hover:bg-orange-500/[0.08] transition-colors cursor-pointer"
                title={`Retranslate to ${currentTargetLang?.toUpperCase()}`}
              >
                <RefreshCw className="h-2.5 w-2.5" />
                {currentTargetLang?.toUpperCase()}
              </button>
            )}
          </div>
        ) : !translation && onTranslate && segment.id && currentTargetLang ? (
          <button
            onClick={(e) => { e.stopPropagation(); onTranslate(segment.id, segment.text); }}
            className="mt-1 flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-semibold text-muted-foreground/50 border border-dashed border-border/20 hover:text-primary/70 hover:border-primary/20 hover:bg-primary/[0.03] opacity-0 group-hover:opacity-100 transition-all cursor-pointer"
          >
            <Globe className="h-2.5 w-2.5" />
            Translate to {currentTargetLang.toUpperCase()}
          </button>
        ) : null}

        {/* Bookmark note — quote-style, proportional to transcript text */}
        {isBookmarked && bookmarkNote && (
          <div className="mt-1.5 flex items-start gap-2 rounded-md border-l-2 border-primary/30 bg-primary/5 px-2.5 py-1.5">
            <p
              className="leading-[1.5] text-primary/70 italic"
              style={{ fontSize: `${Math.max(11, transcriptFontSize - 2)}px` }}
            >
              {bookmarkNote}
            </p>
          </div>
        )}
      </div>

      {/* Hover bookmark icon — appears at right edge on hover */}
      {canBookmark && (
        <div className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={(e) => { e.stopPropagation(); onToggleBookmark(segment.id); }}
            className="rounded p-0.5 hover:bg-accent/50 transition-colors cursor-pointer"
            title={isBookmarked ? "Remove bookmark" : "Bookmark this line"}
          >
            <BookmarkIcon className={`h-3 w-3 ${isBookmarked ? "fill-primary text-primary" : "text-muted-foreground/40"}`} />
          </button>
        </div>
      )}

      {/* Hover-mode translation tooltip (own state: mouse moves re-render only the tooltip) */}
      {translation && translationDisplayMode === "hover" && (
        <HoverTranslationTooltip
          anchorRef={rowRef}
          translation={translation}
          fontSize={translationFontSize}
          color={translationTextColor}
        />
      )}
    </div>
  );
}

export const TranscriptRow = memo(TranscriptRowImpl);

// ── Remote speaker name (click to rename) ──

function SpeakerNameEditor({
  speakerKey,
  label,
  colorClass,
  colorHex,
  onRename,
}: {
  speakerKey: string;
  label: string;
  colorClass: string;
  colorHex?: string;
  onRename: (speakerKey: string, name: string) => void;
}) {
  const mode = useIsLight() ? "light" : "dark";
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(label);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    const trimmed = value.trim();
    if (!cancelledRef.current && trimmed && trimmed !== label) onRename(speakerKey, trimmed);
    cancelledRef.current = false;
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={value}
        aria-label="Speaker name"
        maxLength={40}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            cancelledRef.current = true;
            setEditing(false);
          }
        }}
        className="shrink-0 w-24 rounded bg-foreground/5 border border-input px-1 py-0 text-xs font-bold outline-none focus:border-ring"
        style={colorHex ? { color: readableOn(colorHex, mode) } : undefined}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        cancelledRef.current = false;
        setValue(label);
        setEditing(true);
      }}
      className={`shrink-0 pt-0.5 text-xs font-bold cursor-text decoration-dotted underline-offset-2 hover:underline ${colorClass}`}
      style={colorHex ? { color: readableOn(colorHex, mode) } : undefined}
      title="Rename this speaker"
    >
      {label}
    </button>
  );
}

// ── Hover translation tooltip ──

function HoverTranslationTooltip({
  anchorRef,
  translation,
  fontSize,
  color,
}: {
  /** The row element; attached before this component's effects run. */
  anchorRef: React.RefObject<HTMLElement | null>;
  translation: TranslationResult;
  fontSize: number;
  color: string;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    let latest = { x: 0, y: 0 };
    const onMove = (e: MouseEvent) => {
      latest = { x: e.clientX, y: e.clientY };
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        setPos(latest);
      });
    };
    const onLeave = () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      setPos(null);
    };
    anchor.addEventListener("mousemove", onMove);
    anchor.addEventListener("mouseleave", onLeave);
    return () => {
      anchor.removeEventListener("mousemove", onMove);
      anchor.removeEventListener("mouseleave", onLeave);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [anchorRef]);

  if (!pos) return null;

  return createPortal(
    <div
      className="dark fixed z-[9999] max-w-[420px] rounded-lg border border-white/15 px-3.5 py-2.5 text-foreground shadow-2xl pointer-events-none"
      style={{
        backgroundColor: "#1a1a2e",
        left: `${Math.min(pos.x + 16, window.innerWidth - 440)}px`,
        top: `${Math.max(8, pos.y - 90)}px`,
      }}
    >
      <p style={{ fontSize: `${fontSize + 1}px`, color }} className="leading-[1.6]">
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
    document.body,
  );
}

// ── Text highlighting ──

function highlightText(text: string, query: string, offsets: number[], isActive: boolean): React.ReactNode {
  if (!query || offsets.length === 0) return text;
  const needle = query.toLowerCase();
  const parts: React.ReactNode[] = [];
  let lastEnd = 0;
  const sorted = [...offsets].sort((a, b) => a - b);
  for (const offset of sorted) {
    if (offset > lastEnd) parts.push(text.slice(lastEnd, offset));
    parts.push(
      <mark key={offset} className={`rounded px-0.5 ${isActive ? "bg-highlight/40 text-highlight" : "bg-highlight/20 text-highlight/70"}`}>
        {text.slice(offset, offset + needle.length)}
      </mark>
    );
    lastEnd = offset + needle.length;
  }
  if (lastEnd < text.length) parts.push(text.slice(lastEnd));
  return <>{parts}</>;
}
