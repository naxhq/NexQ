/**
 * The user's own voice, from the live transcript: finals and interims of the You
 * side only ("User"), never the other side. Pure; the panel connects it to the
 * transcript store and to the follower and the said-it tracker.
 */
import type { AudioMode, PointSaid, TranscriptSegment } from "../../lib/types";
import type { SaidMark } from "../follow";

export interface SpeechSink {
  onInterim(text: string, segId: string): unknown;
  onFinal(text: string, segId: string): unknown;
}

/** Feeds new and changed You-side lines to its sinks, once per change. */
export class VoiceBridge {
  private seen = new Map<string, string>();

  constructor(private sinks: SpeechSink[]) {}

  setSinks(sinks: SpeechSink[]): void {
    this.sinks = sinks;
  }

  /** Marks what is already in the transcript as seen, so old speech is not replayed. */
  prime(segments: readonly TranscriptSegment[]): void {
    this.seen.clear();
    for (const s of segments.slice(-200)) {
      if (s.speaker !== "User") continue;
      this.seen.set(s.id, this.key(s));
    }
  }

  private key(s: TranscriptSegment): string {
    const text = s.pending_text ?? s.text;
    return `${s.is_final ? "f" : "i"}:${text}`;
  }

  /** Returns how many lines were passed on. */
  push(segments: readonly TranscriptSegment[]): number {
    let n = 0;
    // Only the tail can have changed: a line grows while it is spoken.
    for (let i = Math.max(0, segments.length - 40); i < segments.length; i++) {
      const s = segments[i];
      if (s.speaker !== "User") continue;
      const text = (s.pending_text ?? s.text ?? "").trim();
      if (!text) continue;
      const k = this.key(s);
      if (this.seen.get(s.id) === k) continue;
      this.seen.set(s.id, k);
      // A final line the speaker keeps extending (pending_text) stays a final with the longer text.
      const final = s.is_final;
      for (const sink of this.sinks) {
        if (final) sink.onFinal(text, s.id);
        else sink.onInterim(text, s.id);
      }
      n++;
    }
    if (this.seen.size > 400) {
      const keep = new Set(segments.slice(-200).map((s) => s.id));
      for (const id of this.seen.keys()) if (!keep.has(id)) this.seen.delete(id);
    }
    return n;
  }

  reset(): void {
    this.seen.clear();
  }
}

export type FollowUnavailable = "in_person" | "muted" | "no_engine";

export type FollowAvailability = { ok: true } | { ok: false; reason: FollowUnavailable; message: string };

export interface FollowInputs {
  audioMode: AudioMode;
  mutedYou: boolean;
  /** The speech engine chosen for the You side; empty or "none" when there is none. */
  youEngine: string | null | undefined;
}

/** Whether your own voice can be heard right now, and if not, why (shown to the user). */
export function followAvailability({ audioMode, mutedYou, youEngine }: FollowInputs): FollowAvailability {
  if (audioMode === "in_person") {
    return {
      ok: false,
      reason: "in_person",
      message: "In an in-person meeting only the room is transcribed, so your own voice is not separate.",
    };
  }
  if (mutedYou) return { ok: false, reason: "muted", message: "Your microphone is muted. Unmute it to follow your voice." };
  const e = (youEngine ?? "").trim().toLowerCase();
  if (e === "none" || e === "off" || e === "disabled") {
    return { ok: false, reason: "no_engine", message: "Your side has no speech engine. Choose one in Settings, under Speech." };
  }
  return { ok: true };
}

// -- "said it" persistence ---------------------------------------------------------------------

export function marksToSaid(marks: Record<string, SaidMark>): PointSaid[] {
  return Object.entries(marks).map(([block_id, m]) => ({
    block_id,
    by: m === "auto" ? "voice" : "manual",
    ticked: m !== "manual_off",
  }));
}

export function saidToMarks(said: readonly PointSaid[] | null | undefined): Record<string, SaidMark> {
  const out: Record<string, SaidMark> = {};
  for (const s of said ?? []) {
    out[s.block_id] = s.by === "voice" ? (s.ticked ? "auto" : "manual_off") : s.ticked ? "manual_on" : "manual_off";
  }
  return out;
}
