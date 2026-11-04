// Speaker Stats Panel — scrollable, with inline rename
// Shows per-speaker talk time %, word count, last spoke.

import { useState, useRef, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useSpeakerStore } from "../stores/speakerStore";
import { BarChart3, Pencil, Check, X } from "lucide-react";

interface SpeakerStatsPanelProps {
  isOpen: boolean;
}

function formatRelativeTime(lastSpokeMs: number): string {
  if (!lastSpokeMs) return "—";
  const diffMs = Date.now() - lastSpokeMs;
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ago`;
}

function InlineRename({ speakerId, displayName, color }: { speakerId: string; displayName: string; color: string }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(displayName);
  const inputRef = useRef<HTMLInputElement>(null);
  const renameSpeaker = useSpeakerStore((s) => s.renameSpeaker);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const handleSave = () => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== displayName) {
      renameSpeaker(speakerId, trimmed);
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="flex items-center gap-1 w-24">
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSave();
            if (e.key === "Escape") { setValue(displayName); setEditing(false); }
          }}
          onBlur={handleSave}
          className="w-full bg-transparent border-b border-primary/40 text-xs font-semibold outline-none px-0 py-0"
          style={{ color }}
          maxLength={30}
        />
      </div>
    );
  }

  return (
    <button
      onClick={() => { setValue(displayName); setEditing(true); }}
      className="group/rename flex items-center gap-1 shrink-0 w-24 truncate cursor-pointer"
      title={`${displayName} — click to rename`}
    >
      <span className="text-xs font-semibold truncate" style={{ color }}>{displayName}</span>
      <Pencil className="h-2.5 w-2.5 text-muted-foreground/30 opacity-0 group-hover/rename:opacity-100 transition-opacity shrink-0" />
    </button>
  );
}

export function SpeakerStatsPanel({ isOpen }: SpeakerStatsPanelProps) {
  const speakers = useSpeakerStore(useShallow((s) => s.getAllSpeakers()));

  if (!isOpen) return null;

  const totalWords = speakers.reduce((sum, s) => sum + s.stats.word_count, 0);

  return (
    <div className="flex flex-col min-h-0">
      <div className="flex items-center gap-1.5 mb-1.5 px-1">
        <BarChart3 className="h-3.5 w-3.5 text-muted-foreground/60" />
        <span className="text-meta font-semibold uppercase tracking-wider text-muted-foreground/60">
          Speaker Stats
        </span>
        <span className="ml-auto text-meta text-muted-foreground/40">
          {speakers.length} speaker{speakers.length !== 1 ? "s" : ""}
        </span>
      </div>

      {speakers.length === 0 ? (
        <p className="text-xs text-muted-foreground/50 py-1 px-1">No speakers tracked yet.</p>
      ) : (
        <div className="overflow-y-auto max-h-[200px] space-y-1 pr-1">
          {speakers.map((speaker) => {
            const wordPct = totalWords > 0
              ? Math.round((speaker.stats.word_count / totalWords) * 100)
              : 0;
            const color = speaker.color ?? "#6366f1";

            return (
              <div key={speaker.id} className="flex items-center gap-2">
                <InlineRename speakerId={speaker.id} displayName={speaker.display_name} color={color} />

                <div className="flex-1 h-2 rounded-full bg-white/5 overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{ width: `${wordPct}%`, backgroundColor: color, opacity: 0.7 }}
                  />
                </div>

                <span className="shrink-0 text-meta tabular-nums text-muted-foreground/60 w-8 text-right">
                  {wordPct}%
                </span>

                <span className="shrink-0 text-meta tabular-nums text-muted-foreground/50 w-14 text-right">
                  {speaker.stats.word_count}w
                </span>

                <span className="shrink-0 text-meta text-muted-foreground/40 w-16 text-right">
                  {formatRelativeTime(speaker.stats.last_spoke_ms)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
