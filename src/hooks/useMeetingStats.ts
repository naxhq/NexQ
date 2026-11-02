import { useMemo } from "react";
import type { Meeting } from "../lib/types";
import { useMeetingStore } from "../stores/meetingStore";

export interface MeetingStats {
  durationDisplay: string;
  wordCount: number;
  wordsPerMinute: number;
  speakerBreakdown: { speaker: string; percentage: number; color: string }[];
  aiCount: number;
  avgLatencyMs: number | null;
}

const SPEAKER_COLORS: Record<string, string> = {
  User: "text-blue-400",
  Interviewer: "text-purple-400",
  Them: "text-emerald-400",
  Unknown: "text-muted-foreground",
};

function countWords(text: string): number {
  let cjkCount = 0;
  // Chinese and Japanese don't put spaces between words, so count each
  // character, including the Japanese long vowel mark ー. Korean does, so its
  // words are counted by whitespace like other scripts.
  const remaining = text.normalize("NFC").replace(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]/gu,
    () => { cjkCount += 1; return " "; }
  );
  // Keep whitespace-delimited words for other scripts, ignoring punctuation
  // alone. Replacing CJK characters with spaces separates adjacent Latin words.
  return cjkCount + remaining.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

function formatStatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export function useMeetingStats(meeting: Meeting | null): MeetingStats {
  const activeMeetingId = useMeetingStore((s) => s.activeMeeting?.id);
  const elapsedMs = useMeetingStore((s) => s.elapsedMs);
  const isActiveMeeting = meeting?.id === activeMeetingId;

  return useMemo(() => {
    if (!meeting) {
      return {
        durationDisplay: "—",
        wordCount: 0,
        wordsPerMinute: 0,
        speakerBreakdown: [],
        aiCount: 0,
        avgLatencyMs: null,
      };
    }

    const durationSec = isActiveMeeting
      ? elapsedMs / 1000
      : meeting.duration_seconds ?? 0;
    const durationDisplay = durationSec > 0 ? formatStatDuration(durationSec) : "—";

    // Word counts per speaker
    const speakerWords: Record<string, number> = {};
    let totalWords = 0;
    for (const seg of meeting.transcript) {
      const words = countWords(seg.text);
      totalWords += words;
      speakerWords[seg.speaker] = (speakerWords[seg.speaker] || 0) + words;
    }

    const durationMin = durationSec / 60;
    const wordsPerMinute = durationMin > 0 ? Math.round(totalWords / durationMin) : 0;

    const speakerBreakdown = Object.entries(speakerWords)
      .map(([speaker, words]) => ({
        speaker,
        percentage: totalWords > 0 ? Math.round((words / totalWords) * 100) : 0,
        color: SPEAKER_COLORS[speaker] || SPEAKER_COLORS.Unknown,
      }))
      .sort((a, b) => b.percentage - a.percentage);

    const aiCount = meeting.ai_interactions.length;
    const avgLatencyMs =
      aiCount > 0
        ? Math.round(
            meeting.ai_interactions.reduce((sum, ai) => sum + ai.latency_ms, 0) / aiCount
          )
        : null;

    return {
      durationDisplay,
      wordCount: totalWords,
      wordsPerMinute,
      speakerBreakdown,
      aiCount,
      avgLatencyMs,
    };
  }, [meeting, isActiveMeeting, elapsedMs]);
}
