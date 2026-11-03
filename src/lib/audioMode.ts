import type { AudioMode } from "./types";

/**
 * Whether a meeting starts no "You" transcriber. In-person meetings transcribe
 * everyone through the room mic ("Them"); "You" is muted and its lines are
 * discarded, so its provider would only cost credits or CPU.
 */
export function skipYouStt(mode: AudioMode): boolean {
  return mode === "in_person";
}
