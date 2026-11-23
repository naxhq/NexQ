import { useState, useCallback, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  onStreamToken,
  onStreamEnd,
  onStreamError,
} from "../lib/events";
import { generateAssist, saveMeetingActionItems } from "../lib/ipc";
import { useMeetingStore, pastMeetingIdFor } from "../stores/meetingStore";
import { useConfigStore } from "../stores/configStore";
import { assistSegments } from "../lib/assistSegments";
import { showToast } from "../stores/toastStore";
import type { Meeting, ActionItem } from "../lib/types";
import { isCliAgent } from "../lib/cliAgents";

// ---------------------------------------------------------------------------
// Defensive JSON parsing — strips markdown fences, finds the array, and
// normalises each item into a proper ActionItem with generated id.
// ---------------------------------------------------------------------------
function parseActionItemsJSON(raw: string): ActionItem[] {
  console.log("[actionItems] Raw LLM response:", raw.slice(0, 500));

  // Strip thinking tags (Qwen3, DeepSeek) + markdown fences
  let cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*/gi, "")
    .replace(/```(?:json)?\s*/g, "")
    .replace(/```/g, "")
    .trim();

  // Handle empty array response: []
  if (/^\[\s*\]/.test(cleaned)) return [];

  // Find JSON array start: [ followed by optional whitespace then {
  const arrayMatch = cleaned.match(/\[\s*\{/);
  if (!arrayMatch || arrayMatch.index === undefined) {
    // If no JSON array and content is mostly non-JSON, return empty
    if (cleaned.length < 20 || !cleaned.includes('"')) return [];
    console.error("[actionItems] No JSON array found. Cleaned:", cleaned.slice(0, 300));
    throw new Error("No JSON array found in response");
  }

  const start = arrayMatch.index;
  let end = cleaned.lastIndexOf("}]");
  let jsonStr: string;

  if (end > start) {
    jsonStr = cleaned.slice(start, end + 2);
  } else {
    // Truncated response — try to salvage by finding the last complete object
    const lastBrace = cleaned.lastIndexOf("}");
    if (lastBrace > start) {
      jsonStr = cleaned.slice(start, lastBrace + 1) + "]";
      // Remove trailing comma before ]
      jsonStr = jsonStr.replace(/,\s*\]$/, "]");
    } else {
      throw new Error("No JSON array found in response");
    }
  }

  let parsed: Record<string, unknown>[];
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // Try removing the last incomplete object
    const lastComplete = jsonStr.lastIndexOf("},");
    if (lastComplete > 0) {
      const salvaged = jsonStr.slice(0, lastComplete + 1) + "]";
      parsed = JSON.parse(salvaged);
    } else {
      throw new Error("Could not parse JSON array from response");
    }
  }

  if (!Array.isArray(parsed)) throw new Error("Response is not an array");

  return parsed
    .map((item: Record<string, unknown>) => ({
      id: crypto.randomUUID(),
      text: ((item.text ?? item.action ?? item.description ?? "") as string).trim(),
      assignee_speaker_id: (item.assignee_speaker_id as string) ?? undefined,
      timestamp_ms: (item.timestamp_ms as number) ?? 0,
      completed: false,
    }))
    .filter((item) => item.text.length > 0);
}

// ---------------------------------------------------------------------------
// Hook interface
// ---------------------------------------------------------------------------
export interface ActionItemsExtractionState {
  isExtracting: boolean;
  error: string | null;
  extract: () => Promise<void>;
  cancel: () => void;
}

export function useActionItemsExtraction(
  meeting: Meeting | null,
  onItemsExtracted: (items: ActionItem[]) => void
): ActionItemsExtractionState {
  const [isExtracting, setIsExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const contentRef = useRef("");
  // request_id of the generation this hook started (null when idle/cancelled)
  const requestIdRef = useRef<string | null>(null);
  const unlistenersRef = useRef<(() => void)[]>([]);

  // Cleanup listeners on unmount
  useEffect(() => {
    return () => {
      unlistenersRef.current.forEach((fn) => fn());
      unlistenersRef.current = [];
    };
  }, []);

  const extract = useCallback(async () => {
    if (!meeting || isExtracting) return;

    setIsExtracting(true);
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

      const unEnd = await onStreamEnd(async (event) => {
        if (!isOurs(event.request_id)) return;
        requestIdRef.current = null;

        // Parse accumulated response into ActionItem[]
        // A stopped stream is a normal stop: its partial output is not parsed or saved.
        if (!event.cancelled && meeting && contentRef.current) {
          try {
            const items = parseActionItemsJSON(contentRef.current);

            if (items.length === 0) {
              showToast("No action items found in this meeting", "info");
            } else {
              // Persist to DB — Rust struct requires meeting_id on each item
              const itemsWithMeetingId = items.map((item) => ({
                ...item,
                meeting_id: meeting.id,
              }));
              await saveMeetingActionItems(
                meeting.id,
                JSON.stringify(itemsWithMeetingId)
              );

              onItemsExtracted(items);
              showToast(`Found ${items.length} action item${items.length !== 1 ? "s" : ""}`, "success");

              // Refresh sidebar so counts update
              useMeetingStore.getState().loadRecentMeetings();
            }
          } catch (err) {
            console.error(
              "[actionItemsExtraction] Parse/save failed:",
              err
            );
            setError(
              "Couldn't parse action items from AI response. Try again."
            );
          }
        }

        setIsExtracting(false);
        // Cleanup listeners
        cleanups.forEach((fn) => fn());
        unlistenersRef.current = unlistenersRef.current.filter(
          (fn) => !cleanups.includes(fn)
        );
      });
      cleanups.push(unEnd);

      const unError = await onStreamError((event) => {
        if (!isOurs(event.request_id)) return;
        requestIdRef.current = null;
        setError(event.message);
        setIsExtracting(false);
        cleanups.forEach((fn) => fn());
        unlistenersRef.current = unlistenersRef.current.filter(
          (fn) => !cleanups.includes(fn)
        );
      });
      cleanups.push(unError);

      unlistenersRef.current.push(...cleanups);

      // ----- Build speaker context for the custom question ----- //
      const speakers = meeting.speakers ?? [];
      const speakerList = speakers
        .map((s) => `${s.id}: ${s.display_name}`)
        .join("\n");

      // Pass speaker list + extraction instruction as custom_question so it
      // appears in the user message alongside the transcript the backend builds.
      const customQuestion = speakerList
        ? `Speaker list:\n${speakerList}\n\nExtract all action items. Return ONLY a JSON array.`
        : "Extract all action items. Return ONLY a JSON array.";

      // Merge consecutive same-speaker segments to reduce prompt size, except
      // for a Claude session, which needs every segment under its own id.
      const finals = meeting.transcript.filter((s) => s.is_final);
      const segments = assistSegments(finals, !isCliAgent(useConfigStore.getState().llmProvider), meeting.speakers);

      await generateAssist("ActionItemsExtraction", customQuestion, {
        requestId,
        transcriptSegments: segments,
        pastMeetingId: pastMeetingIdFor(meeting),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setIsExtracting(false);
      cleanups.forEach((fn) => fn());
    }
  }, [meeting, isExtracting, onItemsExtracted]);

  const cancel = useCallback(async () => {
    try {
      await invoke("cancel_generation");
    } catch {
      // Non-critical
    }
    requestIdRef.current = null;
    setIsExtracting(false);
  }, []);

  return {
    isExtracting,
    error,
    extract,
    cancel,
  };
}
