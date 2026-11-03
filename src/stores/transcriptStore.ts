import { create } from "zustand";
import type { TranscriptSegment } from "../lib/types";

/**
 * How long interim text stays without an update. Not every interim gets a
 * final: a provider can take its guess back, a connection can drop, and a
 * restarted pipeline can't finish a line under its old id. A final that does
 * arrive later still adds the line.
 */
export const INTERIM_LIFETIME_MS = 10_000;

/** When each open interim last changed, by segment id. */
const interimUpdatedAt = new Map<string, number>();

interface TranscriptState {
  segments: TranscriptSegment[];
  searchQuery: string;
  autoScroll: boolean;

  // Actions
  appendSegment: (segment: TranscriptSegment) => void;
  updateInterimSegment: (segment: TranscriptSegment) => void;
  finalizeAllInterim: () => void;
  dropStaleInterim: () => void;
  clearSegments: () => void;
  setSearchQuery: (query: string) => void;
  setAutoScroll: (auto: boolean) => void;
  reassignSpeaker: (fromId: string, toId: string) => void;
}

export const useTranscriptStore = create<TranscriptState>((set) => ({
  segments: [],
  searchQuery: "",
  autoScroll: true,

  appendSegment: (segment) =>
    set((state) => ({
      segments: [...state.segments, segment],
    })),

  // Upsert by id: a final with an existing id (a line that grew) replaces it.
  // An interim extending a line that is already final only adds the interim
  // words as `pending_text`: the line keeps its final text for persistence
  // while the speaker keeps talking.
  updateInterimSegment: (segment) => {
    if (segment.is_final) interimUpdatedAt.delete(segment.id);
    else interimUpdatedAt.set(segment.id, Date.now());
    set((state) => {
      const existing = state.segments.findIndex(
        (s) => s.id === segment.id
      );
      if (existing >= 0) {
        const current = state.segments[existing];
        const updated = [...state.segments];
        updated[existing] =
          current.is_final && !segment.is_final
            ? { ...current, pending_text: segment.text }
            : segment;
        return { segments: updated };
      }
      return { segments: [...state.segments, segment] };
    });
  },

  finalizeAllInterim: () =>
    set((state) => ({
      segments: state.segments.map((s) =>
        s.is_final
          ? s.pending_text === undefined
            ? s
            : { ...s, text: s.pending_text, pending_text: undefined }
          : { ...s, is_final: true }
      ),
    })),

  dropStaleInterim: () =>
    set((state) => {
      const now = Date.now();
      const stale = new Set<string>();
      for (const [id, updatedAt] of interimUpdatedAt) {
        if (now - updatedAt >= INTERIM_LIFETIME_MS) stale.add(id);
      }
      if (stale.size === 0) return state;
      for (const id of stale) interimUpdatedAt.delete(id);
      return {
        segments: state.segments.flatMap((s) => {
          if (!stale.has(s.id)) return [s];
          if (!s.is_final) return [];
          const { pending_text: _pending, ...line } = s;
          return [line];
        }),
      };
    }),

  clearSegments: () => {
    interimUpdatedAt.clear();
    set({ segments: [] });
  },
  setSearchQuery: (query) => set({ searchQuery: query }),
  setAutoScroll: (auto) => set({ autoScroll: auto }),
  reassignSpeaker: (fromId, toId) =>
    set((state) => ({
      segments: state.segments.map((s) =>
        s.speaker_id === fromId ? { ...s, speaker_id: toId } : s
      ),
    })),
}));
