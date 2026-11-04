import { create } from "zustand";
import type { DetectedQuestion } from "../lib/types";

export interface TrackedQuestion extends DetectedQuestion {
  assisted: boolean;
  /** Transcript line the question came from (lines grow while someone talks). */
  segmentId?: string;
  /** Unanswered when the panel came back, so it may be old: Auto-Answer skips it. */
  heldBack?: boolean;
}

/** Text of each final line when it was last checked for a question. */
const checkedText = new Map<string, string>();

interface QuestionState {
  questions: TrackedQuestion[];
  /** Whether the question panel has looked at this meeting's transcript yet. */
  panelSeen: boolean;

  addQuestion: (question: DetectedQuestion, segmentId?: string) => void;
  /** Records a final line's text. False when it was already checked as it is. */
  checkLine: (id: string, text: string) => boolean;
  setPanelSeen: () => void;
  holdBackUnanswered: () => void;
  markAssisted: (index: number) => void;
  dismiss: (index: number) => void;
  clear: () => void;
}

// The panel unmounts on a layout switch and while Settings is open, so what it
// has found and answered lives here, for the meeting.
export const useQuestionStore = create<QuestionState>((set) => ({
  questions: [],
  panelSeen: false,

  addQuestion: (q, segmentId) =>
    set((state) => {
      const prev = state.questions;
      // The same line grew: update its question in place (unless already answered).
      if (segmentId) {
        const i = prev.findIndex((p) => p.segmentId === segmentId);
        if (i >= 0) {
          if (prev[i].assisted || prev[i].text === q.text) return state;
          return { questions: prev.map((p, j) => (j === i ? { ...p, text: q.text, heldBack: false } : p)) };
        }
      }
      if (prev.length > 0 && prev[0].text === q.text) return state;
      return { questions: [{ ...q, assisted: false, segmentId }, ...prev].slice(0, 10) };
    }),

  checkLine: (id, text) => {
    if (checkedText.get(id) === text) return false;
    checkedText.set(id, text);
    return true;
  },

  setPanelSeen: () => set({ panelSeen: true }),

  holdBackUnanswered: () =>
    set((state) => ({
      questions: state.questions.map((q) => (q.assisted ? q : { ...q, heldBack: true })),
    })),

  markAssisted: (index) =>
    set((state) => ({
      questions: state.questions.map((q, i) => (i === index ? { ...q, assisted: true } : q)),
    })),

  dismiss: (index) =>
    set((state) => ({ questions: state.questions.filter((_, i) => i !== index) })),

  clear: () => {
    checkedText.clear();
    set({ questions: [], panelSeen: false });
  },
}));
