// Sub-PRD 4: Rolling live transcript with auto-scroll and search
// Displays transcript segments with auto-scroll behavior and search/filter.

import { useEffect, useRef, useCallback, useMemo } from "react";
import { useTranscriptStore } from "../stores/transcriptStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useAudioLevel } from "../hooks/useAudioLevel";
import { useConfigStore } from "../stores/configStore";
import { TranscriptLine } from "./TranscriptLine";
import { SpeakerNamingBanner } from "./SpeakerNamingBanner";
import { NoTranscriptBanner } from "./NoTranscriptBanner";
import { mergeConsecutiveSegments } from "../lib/mergeSegments";
import { Mic, MicOff, Volume2, VolumeX, Search, X, Radio } from "lucide-react";
import { ColorPickerButton } from "../components/ColorPickerButton";

export function TranscriptPanel({ onOpenDevLog, short = false }: { onOpenDevLog?: () => void; short?: boolean } = {}) {
  const segments = useTranscriptStore((s) => s.segments);
  const searchQuery = useTranscriptStore((s) => s.searchQuery);
  const autoScroll = useTranscriptStore((s) => s.autoScroll);
  const setSearchQuery = useTranscriptStore((s) => s.setSearchQuery);
  const setAutoScroll = useTranscriptStore((s) => s.setAutoScroll);
  const isRecording = useMeetingStore((s) => s.isRecording);
  const audioMode = useMeetingStore((s) => s.audioMode);
  const { micLevel, systemLevel } = useAudioLevel();
  const mutedYou = useConfigStore((s) => s.mutedYou);
  const mutedThem = useConfigStore((s) => s.mutedThem);
  const toggleMuteYou = useConfigStore((s) => s.toggleMuteYou);
  const toggleMuteThem = useConfigStore((s) => s.toggleMuteThem);
  const transcriptFontSize = useConfigStore((s) => s.transcriptFontSize ?? 13);
  const translationFontSize = useConfigStore((s) => s.translationFontSize ?? 12);
  const setTranscriptFontSize = useConfigStore((s) => s.setTranscriptFontSize);
  const setTranslationFontSize = useConfigStore((s) => s.setTranslationFontSize);
  const transcriptTextColor = useConfigStore((s) => s.transcriptTextColor ?? "#e4e4e7");
  const translationTextColor = useConfigStore((s) => s.translationTextColor ?? "#fbbf24");
  const setTranscriptTextColor = useConfigStore((s) => s.setTranscriptTextColor);
  const setTranslationTextColor = useConfigStore((s) => s.setTranslationTextColor);
  const isInPerson = audioMode === "in_person";
  // In in-person mode, room audio comes via the "them" config (system audio / AudienceMix),
  // so use systemLevel for the Room bar. micLevel is for the user's mic (online mode).
  const roomLevel = isInPerson ? Math.max(micLevel, systemLevel) : 0;

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollAnimRef = useRef<number>(0);
  const isAnimatingRef = useRef(false);

  // Momentum-based smooth scroll — exponential deceleration for a buttery feel
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    cancelAnimationFrame(scrollAnimRef.current);

    const target = el.scrollHeight - el.clientHeight;
    const start = el.scrollTop;
    const distance = target - start;
    if (Math.abs(distance) < 2) {
      isAnimatingRef.current = false;
      return;
    }

    isAnimatingRef.current = true;
    const duration = Math.min(400, Math.max(150, Math.abs(distance) * 0.8));
    const startTime = performance.now();

    const step = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // Exponential ease-out: fast start, gentle deceleration
      const eased = 1 - Math.pow(1 - progress, 3);
      el.scrollTop = start + distance * eased;
      if (progress < 1) {
        scrollAnimRef.current = requestAnimationFrame(step);
      } else {
        isAnimatingRef.current = false;
      }
    };
    scrollAnimRef.current = requestAnimationFrame(step);
  }, []);

  // Cancel scroll animation on unmount
  useEffect(() => {
    return () => {
      cancelAnimationFrame(scrollAnimRef.current);
      isAnimatingRef.current = false;
    };
  }, []);

  // Auto-scroll to bottom when new segments arrive (if autoScroll is on)
  useEffect(() => {
    if (autoScroll && segments.length > 0) {
      scrollToBottom();
    }
  }, [segments, autoScroll, scrollToBottom]);

  // Cancel programmatic animation when user manually scrolls (wheel/touch)
  const cancelScrollAnimation = useCallback(() => {
    if (isAnimatingRef.current) {
      cancelAnimationFrame(scrollAnimRef.current);
      isAnimatingRef.current = false;
    }
  }, []);

  // Detect manual scroll: if user scrolls up, pause auto-scroll.
  // If they scroll back to the bottom, resume it.
  // Ignores scroll events during programmatic animation to prevent false triggers.
  const handleScroll = useCallback(() => {
    if (isAnimatingRef.current) return;
    const el = scrollRef.current;
    if (!el) return;

    const isAtBottom =
      Math.abs(el.scrollHeight - el.scrollTop - el.clientHeight) < 30;

    if (isAtBottom && !autoScroll) {
      setAutoScroll(true);
    } else if (!isAtBottom && autoScroll) {
      setAutoScroll(false);
    }
  }, [autoScroll, setAutoScroll]);

  // Merge consecutive same-speaker finals, keep interims separate at the end
  const mergedSegments = useMemo(() => {
    const finals = segments.filter((s) => s.is_final);
    const interims = segments.filter((s) => !s.is_final);
    return [...mergeConsecutiveSegments(finals), ...interims];
  }, [segments]);

  // Filter merged segments by search query
  const filteredSegments = searchQuery.trim()
    ? mergedSegments.filter((s) =>
        s.text.toLowerCase().includes(searchQuery.trim().toLowerCase())
      )
    : mergedSegments;

  // Count search matches
  const matchCount = searchQuery.trim()
    ? filteredSegments.length
    : 0;

  // Empty state
  if (segments.length === 0) {
    return (
      <div className="flex flex-1 min-h-0 flex-col">
        <NoTranscriptBanner onOpenDevLog={onOpenDevLog} />
        <div className="flex flex-1 flex-col items-center justify-center gap-2">
          {isRecording ? (
            <>
              <div className="flex items-center gap-2">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-primary opacity-40" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary" />
                </span>
                <span className="text-xs font-medium text-primary">Capturing audio</span>
              </div>
              <p className="text-meta text-muted-foreground/50">Speech will appear as it&apos;s detected</p>
            </>
          ) : (
            <>
              <Mic className="h-5 w-5 text-muted-foreground/30" />
              <p className="text-xs text-muted-foreground/50">Start a meeting to see the transcript</p>
            </>
          )}
        </div>
        {isRecording && (
          <div className={`mx-1 mb-1.5 space-y-1 ${short ? "hidden" : ""}`}>
            {isInPerson ? (
              <AudioActivityBar
                icon={<Radio className="h-3.5 w-3.5" />}
                mutedIcon={<MicOff className="h-3.5 w-3.5" />}
                label="Room"
                level={roomLevel}
                colorClass="bg-purple-500"
                trackClass="bg-purple-500/10"
                textClass="text-purple-400"
                muted={mutedThem}
                onToggleMute={toggleMuteThem}
              />
            ) : (
              <>
                <AudioActivityBar
                  icon={<Mic className="h-3.5 w-3.5" />}
                  mutedIcon={<MicOff className="h-3.5 w-3.5" />}
                  label="You"
                  level={micLevel}
                  colorClass="bg-speaker-user"
                  trackClass="bg-speaker-user/10"
                  textClass="text-speaker-user"
                  muted={mutedYou}
                  onToggleMute={toggleMuteYou}
                />
                <AudioActivityBar
                  icon={<Volume2 className="h-3.5 w-3.5" />}
                  mutedIcon={<VolumeX className="h-3.5 w-3.5" />}
                  label="Them"
                  level={systemLevel}
                  colorClass="bg-speaker-interviewer"
                  trackClass="bg-speaker-interviewer/10"
                  textClass="text-speaker-interviewer"
                  muted={mutedThem}
                  onToggleMute={toggleMuteThem}
                />
              </>
            )}
          </div>
        )}
        <SpeakerNamingBanner />
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <NoTranscriptBanner onOpenDevLog={onOpenDevLog} />
      {/* Search bar (shown when there's a search query or toggled) */}
      <div className={`flex shrink-0 items-center gap-2 rounded-lg border border-input bg-muted/20 mx-1 mt-1 mb-1.5 px-2.5 py-1.5 ${short && !searchQuery ? "hidden" : ""}`}>
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search transcript..."
          aria-label="Search transcript"
          maxLength={200}
          className="flex-1 bg-transparent text-xs text-foreground/90 placeholder:text-muted-foreground/50 outline-none"
        />
        {searchQuery && (
          <>
            <span className="text-meta text-muted-foreground/60">
              {matchCount} match{matchCount !== 1 ? "es" : ""}
            </span>
            <button
              onClick={() => setSearchQuery("")}
              className="rounded-full p-0.5 text-muted-foreground/60 hover:text-foreground/70 hover:bg-accent/50"
              aria-label="Clear search"
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </>
        )}
      </div>

      {/* Transcript lines — relative+absolute breaks out of flex min-height */}
      <div className="relative flex-1 min-h-0">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        onWheel={cancelScrollAnimation}
        onTouchMove={cancelScrollAnimation}
        data-scroll-container
        className="absolute inset-0 overflow-y-auto overflow-x-hidden px-1 pt-1 pb-8"
      >
        {filteredSegments.map((seg) => (
          <TranscriptLine
            key={seg.id}
            segment={seg}
            searchQuery={searchQuery}
          />
        ))}
        <div ref={bottomRef} />
      </div>
      </div>

      {/* Typeset controls */}
      <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 mx-1 mb-1 px-2.5 py-1 border-t border-border/10 ${short ? "hidden" : ""}`}>
        <span className="text-[0.6rem] uppercase tracking-widest text-muted-foreground/40 font-medium">Text</span>
        <div className="flex items-center gap-0.5">
          <button aria-label="Smaller transcript text" onClick={() => setTranscriptFontSize(Math.max(10, transcriptFontSize - 1))} className="h-5 w-5 flex items-center justify-center rounded text-[0.6rem] text-muted-foreground/50 hover:bg-accent/40 transition-colors">A</button>
          <span className="text-[0.6rem] tabular-nums text-muted-foreground/50 w-5 text-center">{transcriptFontSize}</span>
          <button aria-label="Larger transcript text" onClick={() => setTranscriptFontSize(Math.min(20, transcriptFontSize + 1))} className="h-5 w-5 flex items-center justify-center rounded text-[0.75rem] font-medium text-muted-foreground/50 hover:bg-accent/40 transition-colors">A</button>
        </div>
        <ColorPickerButton value={transcriptTextColor} onChange={setTranscriptTextColor} label="Text color" />
        <div className="h-3 w-px bg-border/10" />
        <span className="text-[0.6rem] uppercase tracking-widest text-muted-foreground/40 font-medium">Translation</span>
        <div className="flex items-center gap-0.5">
          <button aria-label="Smaller translation text" onClick={() => setTranslationFontSize(Math.max(9, translationFontSize - 1))} className="h-5 w-5 flex items-center justify-center rounded text-[0.6rem] text-muted-foreground/50 hover:bg-accent/40 transition-colors">A</button>
          <span className="text-[0.6rem] tabular-nums text-muted-foreground/50 w-5 text-center">{translationFontSize}</span>
          <button aria-label="Larger translation text" onClick={() => setTranslationFontSize(Math.min(18, translationFontSize + 1))} className="h-5 w-5 flex items-center justify-center rounded text-[0.75rem] font-medium text-muted-foreground/50 hover:bg-accent/40 transition-colors">A</button>
        </div>
        <ColorPickerButton value={translationTextColor} onChange={setTranslationTextColor} label="Translation color" />
      </div>

      {/* Live audio activity indicators — mode-aware */}
      {isRecording && (
        <div className={`mx-1 mb-1.5 space-y-1 ${short ? "hidden" : ""}`}>
          {isInPerson ? (
            <AudioActivityBar
              icon={<Radio className="h-3.5 w-3.5" />}
              mutedIcon={<MicOff className="h-3.5 w-3.5" />}
              label="Room"
              level={roomLevel}
              colorClass="bg-purple-500"
              trackClass="bg-purple-500/10"
              textClass="text-purple-400"
              muted={mutedThem}
              onToggleMute={toggleMuteThem}
            />
          ) : (
            <>
              <AudioActivityBar
                icon={<Mic className="h-3.5 w-3.5" />}
                mutedIcon={<MicOff className="h-3.5 w-3.5" />}
                label="You"
                level={micLevel}
                colorClass="bg-speaker-user"
                trackClass="bg-speaker-user/10"
                textClass="text-speaker-user"
                muted={mutedYou}
                onToggleMute={toggleMuteYou}
              />
              <AudioActivityBar
                icon={<Volume2 className="h-3.5 w-3.5" />}
                mutedIcon={<VolumeX className="h-3.5 w-3.5" />}
                label="Them"
                level={systemLevel}
                colorClass="bg-speaker-interviewer"
                trackClass="bg-speaker-interviewer/10"
                textClass="text-speaker-interviewer"
                muted={mutedThem}
                onToggleMute={toggleMuteThem}
              />
            </>
          )}
        </div>
      )}

      {/* Speaker naming prompt (in-person mode diarization) */}
      <SpeakerNamingBanner />

      {/* Auto-scroll paused indicator */}
      {!autoScroll && segments.length > 0 && (
        <button
          onClick={() => {
            setAutoScroll(true);
            scrollToBottom();
          }}
          className="mx-auto mb-1.5 rounded-full bg-primary/10 px-4 py-1 text-meta font-medium text-primary shadow-sm transition-colors hover:bg-primary/20 fade-in-up"
        >
          Scroll to latest
        </button>
      )}
    </div>
  );
}

// -- Live audio level bar per party (with mute toggle) ------------------------

function AudioActivityBar({
  icon,
  mutedIcon,
  label,
  level,
  colorClass,
  trackClass,
  textClass,
  muted,
  onToggleMute,
}: {
  icon: React.ReactNode;
  mutedIcon: React.ReactNode;
  label: string;
  level: number;
  colorClass: string;
  trackClass: string;
  textClass: string;
  muted: boolean;
  onToggleMute: () => void;
}) {
  const isActive = !muted && level > 0.02;
  // Logarithmic scaling: quiet → 15-50%, normal → 50-80%, loud → 80-100%
  const normalized = Math.min(1, level);
  const barWidth = isActive
    ? Math.min(100, Math.round(Math.log1p(normalized * 10) / Math.log1p(10) * 100))
    : 0;

  return (
    <div className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 transition-colors duration-200 ${
      muted ? "bg-destructive/5" : "bg-muted/20"
    }`}>
      {/* Mute toggle */}
      <button
        onClick={onToggleMute}
        className={`shrink-0 rounded-md p-1 transition-all duration-150 cursor-pointer ${
          muted
            ? "bg-destructive/10 text-destructive hover:bg-destructive/20"
            : `hover:bg-accent/50 ${isActive ? textClass : "text-muted-foreground/60"}`
        }`}
        aria-label={muted ? `Unmute ${label}` : `Mute ${label}`}
        aria-pressed={muted}
      >
        {muted ? mutedIcon : icon}
      </button>

      <span className={`shrink-0 text-xs font-semibold transition-colors duration-150 w-8 ${
        muted ? "text-destructive/60" : isActive ? textClass : "text-muted-foreground/60"
      }`}>
        {label}
      </span>

      <div
        className={`flex-1 h-2.5 rounded-full overflow-hidden ${muted ? "bg-muted/30" : trackClass}`}
        role="meter"
        aria-label={`${label} audio level`}
        aria-valuenow={muted ? 0 : barWidth}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={`h-full rounded-full audio-bar-spring ${
            muted ? "bg-muted-foreground/10" : colorClass
          }`}
          style={{
            width: muted ? "100%" : `${barWidth}%`,
            opacity: muted ? 0.3 : isActive ? 0.85 : 0.25,
          }}
        />
      </div>

      <span className={`shrink-0 w-10 text-right text-meta font-medium tabular-nums transition-colors duration-150 ${
        muted ? "text-destructive/40" : isActive ? textClass : "text-muted-foreground/60"
      }`}>
        {muted ? "Muted" : `${barWidth}%`}
      </span>

      {isActive && (
        <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
          <span className={`absolute inline-flex h-full w-full animate-pulse rounded-full ${colorClass} opacity-40`} />
          <span className={`relative inline-flex h-2 w-2 rounded-full ${colorClass}`} />
        </span>
      )}
      {muted && (
        <span className="flex h-2 w-2 shrink-0 rounded-full bg-destructive/30" aria-hidden="true" />
      )}
    </div>
  );
}

/** The You / Them meters as one slim line, for the tab bar of a transcript too short for the full bars. */
export function TranscriptTabMeters() {
  const isRecording = useMeetingStore((s) => s.isRecording);
  const audioMode = useMeetingStore((s) => s.audioMode);
  const { micLevel, systemLevel } = useAudioLevel();
  const mutedYou = useConfigStore((s) => s.mutedYou);
  const mutedThem = useConfigStore((s) => s.mutedThem);
  const toggleMuteYou = useConfigStore((s) => s.toggleMuteYou);
  const toggleMuteThem = useConfigStore((s) => s.toggleMuteThem);
  if (!isRecording) return null;
  const inPerson = audioMode === "in_person";
  const items = inPerson
    ? [{ label: "Room", level: Math.max(micLevel, systemLevel), muted: mutedThem, toggle: toggleMuteThem, color: "bg-purple-500" }]
    : [
        { label: "You", level: micLevel, muted: mutedYou, toggle: toggleMuteYou, color: "bg-speaker-user" },
        { label: "Them", level: systemLevel, muted: mutedThem, toggle: toggleMuteThem, color: "bg-speaker-interviewer" },
      ];
  return (
    <div className="flex items-center gap-2 px-1" role="group" aria-label="Audio levels">
      {items.map((m) => (
        <button
          key={m.label}
          type="button"
          onClick={m.toggle}
          aria-pressed={m.muted}
          aria-label={m.muted ? `Unmute ${m.label}` : `Mute ${m.label}`}
          className="flex items-center gap-1 rounded px-1 text-[10px] font-medium text-muted-foreground/70 hover:text-foreground"
        >
          <span>{m.label}</span>
          <span className="h-1 w-8 overflow-hidden rounded-full bg-muted/30" role="meter" aria-label={`${m.label} audio level`} aria-valuenow={m.muted ? 0 : Math.round(m.level)} aria-valuemin={0} aria-valuemax={100}>
            <span className={`block h-full rounded-full ${m.muted ? "bg-destructive/40" : m.color}`} style={{ width: m.muted ? "100%" : `${Math.min(100, Math.round(m.level))}%` }} />
          </span>
        </button>
      ))}
    </div>
  );
}
