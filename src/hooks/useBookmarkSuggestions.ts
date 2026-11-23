import { useState, useCallback, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  onStreamToken,
  onStreamEnd,
  onStreamError,
} from "../lib/events";
import { addMeetingBookmark, generateAssist } from "../lib/ipc";
import type { Meeting, MeetingBookmark } from "../lib/types";
import { pastMeetingIdFor } from "../stores/meetingStore";
import { useConfigStore } from "../stores/configStore";
import { assistSegments } from "../lib/assistSegments";
import { isCliAgent } from "../lib/cliAgents";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BookmarkSuggestion {
  timestamp_ms: number;
  segment_id?: string;
  note: string;
}

export interface BookmarkSuggestionsState {
  isSuggesting: boolean;
  suggestions: BookmarkSuggestion[];
  suggest: () => Promise<void>;
  cancel: () => void;
  acceptSuggestion: (index: number) => void;
  dismissSuggestion: (index: number) => void;
  acceptAll: () => void;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Fallback: parse markdown bullet list when LLM ignores JSON instruction.
// Handles formats like:
//   - **[seg_id]** – Note text here
//   - [seg_id] - Note text here
//   - **[seg_id]**: Note text here
// ---------------------------------------------------------------------------
function parseMarkdownBullets(
  text: string,
  segments?: { id: string; timestamp_ms: number }[],
): BookmarkSuggestion[] {
  const segMap = new Map<string, number>();
  if (segments) {
    for (const s of segments) segMap.set(s.id, s.timestamp_ms);
  }

  const results: BookmarkSuggestion[] = [];
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    // Match: "- **[seg_id]** – Note" or "- [seg_id] - Note" etc.
    const match = trimmed.match(
      /^[-*]\s+\*{0,2}\[([^\]]+)\]\*{0,2}\s*[:\u2013\u2014-]+\s*(.+)/,
    );
    if (!match) continue;
    const segId = match[1].trim();
    const note = match[2].replace(/\*{2}/g, "").trim();
    if (!note) continue;
    const tsMs = segMap.get(segId) ?? 0;
    results.push({ timestamp_ms: tsMs, segment_id: segId, note });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Defensive JSON parsing — strips markdown fences, finds the array, and
// normalises each item into a proper BookmarkSuggestion.
// ---------------------------------------------------------------------------
function parseSuggestionsJSON(
  raw: string,
  segments?: { id: string; timestamp_ms: number }[],
): BookmarkSuggestion[] {
  console.log("[bookmarkSuggestions] Raw LLM response:", raw.slice(0, 500));

  // Strip thinking tags (Qwen3, DeepSeek, etc.) — handle both closed and unclosed
  let cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*/gi, "")       // Unclosed thinking tag — strip to end
    .replace(/```(?:json)?\s*/g, "")
    .replace(/```/g, "")
    .trim();

  // Find JSON array start: [ followed by optional whitespace then {
  const arrayMatch = cleaned.match(/\[\s*\{/);
  if (!arrayMatch || arrayMatch.index === undefined) {
    // Fallback: parse markdown bullet list format
    // e.g. "- **[them_8bea_152]** – Question about F1 score"
    //   or "- [them_8bea_152] - Question about F1 score"
    const bulletItems = parseMarkdownBullets(cleaned, segments);
    if (bulletItems.length > 0) {
      console.log("[bookmarkSuggestions] Parsed via markdown fallback:", bulletItems.length, "items");
      return bulletItems;
    }
    console.error("[bookmarkSuggestions] No JSON array found. Cleaned:", cleaned.slice(0, 300));
    throw new Error("No JSON array found in response");
  }

  const start = arrayMatch.index;
  let end = cleaned.lastIndexOf("}]");
  let jsonStr: string;

  if (end > start) {
    jsonStr = cleaned.slice(start, end + 2);
  } else {
    // Truncated response — salvage complete objects
    const lastBrace = cleaned.lastIndexOf("}");
    if (lastBrace > start) {
      jsonStr = cleaned.slice(start, lastBrace + 1) + "]";
      jsonStr = jsonStr.replace(/,\s*\]$/, "]");
    } else {
      throw new Error("No JSON array found in response");
    }
  }

  let parsed: Record<string, unknown>[];
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    const lastComplete = jsonStr.lastIndexOf("},");
    if (lastComplete > 0) {
      parsed = JSON.parse(jsonStr.slice(0, lastComplete + 1) + "]");
    } else {
      throw new Error("Could not parse JSON array from response");
    }
  }

  // Build segment lookup for timestamp resolution
  const segMap = new Map<string, number>();
  if (segments) {
    for (const s of segments) segMap.set(s.id, s.timestamp_ms);
  }

  return parsed
    .map((item: Record<string, unknown>) => {
      const segId = (item.segment_id as string) || undefined;
      let tsMs = typeof item.timestamp_ms === "number" ? item.timestamp_ms : 0;
      // Resolve timestamp from segment_id when missing or zero
      if ((!tsMs || tsMs === 0) && segId && segMap.has(segId)) {
        tsMs = segMap.get(segId)!;
      }
      const note = ((item.note ?? item.description ?? item.reason ?? "") as string).trim();
      return { timestamp_ms: tsMs, segment_id: segId, note };
    })
    .filter((s) => s.note.length > 0);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
export function useBookmarkSuggestions(
  meeting: Meeting | null,
  onBookmarkAccepted: (newBookmark: MeetingBookmark) => void,
): BookmarkSuggestionsState {
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [suggestions, setSuggestions] = useState<BookmarkSuggestion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const contentRef = useRef("");
  // request_id of the generation this hook started (null when idle/cancelled)
  const requestIdRef = useRef<string | null>(null);
  const unlistenersRef = useRef<(() => void)[]>([]);

  // Reset state when meeting changes
  useEffect(() => {
    setError(null);
    setSuggestions([]);
    setIsSuggesting(false);
    contentRef.current = "";
  }, [meeting?.id]);

  // Cleanup listeners on unmount
  useEffect(() => {
    return () => {
      unlistenersRef.current.forEach((fn) => fn());
      unlistenersRef.current = [];
    };
  }, []);

  const acceptSuggestion = useCallback(
    async (index: number) => {
      if (!meeting) return;

      const suggestion = suggestions[index];
      if (!suggestion) return;

      const bookmark: MeetingBookmark = {
        id: crypto.randomUUID(),
        timestamp_ms: suggestion.timestamp_ms,
        segment_id: suggestion.segment_id,
        note: suggestion.note,
        created_at: new Date().toISOString(),
      };

      try {
        await addMeetingBookmark(
          JSON.stringify({
            id: bookmark.id,
            meeting_id: meeting.id,
            timestamp_ms: bookmark.timestamp_ms,
            segment_id: bookmark.segment_id ?? null,
            note: bookmark.note ?? null,
            created_at: bookmark.created_at,
          }),
        );

        // Remove accepted suggestion from the list
        setSuggestions((prev) => prev.filter((_, i) => i !== index));
        onBookmarkAccepted(bookmark);
      } catch (err) {
        console.error("[bookmarkSuggestions] Failed to save bookmark:", err);
      }
    },
    [meeting, suggestions, onBookmarkAccepted],
  );

  const dismissSuggestion = useCallback((index: number) => {
    setSuggestions((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const acceptAll = useCallback(async () => {
    if (!meeting) return;

    // Process all remaining suggestions
    for (let i = suggestions.length - 1; i >= 0; i--) {
      const suggestion = suggestions[i];
      if (!suggestion) continue;

      const bookmark: MeetingBookmark = {
        id: crypto.randomUUID(),
        timestamp_ms: suggestion.timestamp_ms,
        segment_id: suggestion.segment_id,
        note: suggestion.note,
        created_at: new Date().toISOString(),
      };

      try {
        await addMeetingBookmark(
          JSON.stringify({
            id: bookmark.id,
            meeting_id: meeting.id,
            timestamp_ms: bookmark.timestamp_ms,
            segment_id: bookmark.segment_id ?? null,
            note: bookmark.note ?? null,
            created_at: bookmark.created_at,
          }),
        );
        onBookmarkAccepted(bookmark);
      } catch (err) {
        console.error("[bookmarkSuggestions] Failed to save bookmark:", err);
      }
    }

    setSuggestions([]);
  }, [meeting, suggestions, onBookmarkAccepted]);

  const suggest = useCallback(async () => {
    if (!meeting || isSuggesting) return;

    setIsSuggesting(true);
    setError(null);
    contentRef.current = "";
    const requestId = crypto.randomUUID();
    requestIdRef.current = requestId;
    const isOurs = (id: string | null) =>
      id === requestId && requestIdRef.current === requestId;

    // Subscribe to stream events before triggering generation
    const cleanups: (() => void)[] = [];

    try {
      const unToken = await onStreamToken((event) => {
        if (!isOurs(event.request_id)) return;
        contentRef.current += event.token;
      });
      cleanups.push(unToken);

      // Merge consecutive same-speaker segments to reduce prompt size
      // (463 raw segments → ~100 merged blocks for a typical 1hr meeting),
      // except for a Claude session, which needs every segment under its own id.
      // All finals are kept for timestamp lookup either way.
      const finals = meeting.transcript.filter((s) => s.is_final);
      const segments = assistSegments(finals, !isCliAgent(useConfigStore.getState().llmProvider), meeting.speakers);
      const allSegments = finals.map((s) => ({ id: s.id, timestamp_ms: s.timestamp_ms }));

      const unEnd = await onStreamEnd(async (event) => {
        if (!isOurs(event.request_id)) return;
        requestIdRef.current = null;

        // Parse accumulated response into BookmarkSuggestion[]
        // A stopped stream is a normal stop: its partial output is not parsed or saved.
        if (!event.cancelled && meeting && contentRef.current) {
          try {
            const items = parseSuggestionsJSON(contentRef.current, allSegments);
            if (items.length === 0) {
              setError("info:No notable moments found in this meeting. You can add bookmarks manually from the Transcript tab.");
            } else {
              setSuggestions(items);
            }
          } catch (err) {
            console.error("[bookmarkSuggestions] Parse failed:", err);
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("No JSON array found")) {
              // LLM returned prose instead of JSON — meeting too short or nothing to bookmark
              setError("info:This meeting doesn't have enough content to suggest bookmarks. You can add bookmarks manually from the Transcript tab.");
            } else {
              setError("Couldn't parse bookmark suggestions. Try again.");
            }
          }
        }

        setIsSuggesting(false);
        // Cleanup listeners
        cleanups.forEach((fn) => fn());
        unlistenersRef.current = unlistenersRef.current.filter(
          (fn) => !cleanups.includes(fn),
        );
      });
      cleanups.push(unEnd);

      const unError = await onStreamError((event) => {
        if (!isOurs(event.request_id)) return;
        requestIdRef.current = null;
        setError(event.message);
        setIsSuggesting(false);
        cleanups.forEach((fn) => fn());
        unlistenersRef.current = unlistenersRef.current.filter(
          (fn) => !cleanups.includes(fn),
        );
      });
      cleanups.push(unError);

      unlistenersRef.current.push(...cleanups);

      const customQuestion =
        "Identify the most important moments in this meeting transcript. " +
        "Return the segment_id from each transcript line.";

      await generateAssist("BookmarkSuggestions", customQuestion, {
        requestId,
        transcriptSegments: segments,
        pastMeetingId: pastMeetingIdFor(meeting),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setIsSuggesting(false);
      cleanups.forEach((fn) => fn());
    }
  }, [meeting, isSuggesting]);

  const cancel = useCallback(async () => {
    try {
      await invoke("cancel_generation");
    } catch {
      // Non-critical
    }
    requestIdRef.current = null;
    setIsSuggesting(false);
  }, []);

  return {
    isSuggesting,
    suggestions,
    suggest,
    cancel,
    acceptSuggestion,
    dismissSuggestion,
    acceptAll,
    error,
  };
}
