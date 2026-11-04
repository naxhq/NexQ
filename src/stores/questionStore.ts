import { create } from "zustand";
import type { DetectedQuestion } from "../lib/types";

export interface TrackedQuestion extends DetectedQuestion {
  assisted: boolean;
  /** Transcript line the question came from (lines grow while someone talks). */
  segmentId?: string;
  /** Unanswered when the panel came back, so it may be old: Auto-Answer skips it. */
  heldBack?: boolean;
}

/** An automatic answer NexQ started, so it knows what it may stop. */
export interface AutoAnswerRef {
  requestId: string;
  /** Transcript line the question came from. */
  segmentId: string;
  question: string;
  /** Started on "probably done" and not yet confirmed by the turn's end. */
  early: boolean;
  /** Settles once the answer has finished, was stopped, or was refused. */
  done: Promise<void>;
}

/** Text of each final line when it was last checked for a question. */
const checkedText = new Map<string, string>();

/**
 * Lines from a provider that detects turns (Cartesia, Deepgram Flux): Auto-Answer
 * follows the provider's signals there, not the quiet wait.
 */
const turnLines = new Set<string>();

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

  /** The newest automatic answer NexQ started (it may have finished since). */
  autoAnswer: AutoAnswerRef | null;
  setAutoAnswer: (ref: AutoAnswerRef | null) => void;
  /** Shows `question` as the line's question, answered (a new card if the line has none). */
  answerLine: (question: DetectedQuestion, segmentId: string) => void;
  /** The question stays a card to click; Auto-Answer leaves it alone. */
  holdBack: (segmentId: string | undefined, text: string) => void;
  /** The line's question became `text`: a new question, not answered yet. */
  reviseLine: (segmentId: string, text: string) => void;
  markTurnLine: (segmentId: string) => void;
  isTurnLine: (segmentId: string | undefined) => boolean;
}

// The panel unmounts on a layout switch and while Settings is open, so what it
// has found and answered lives here, for the meeting.
export const useQuestionStore = create<QuestionState>((set) => ({
  questions: [],
  panelSeen: false,
  autoAnswer: null,

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
    turnLines.clear();
    set({ questions: [], panelSeen: false, autoAnswer: null });
  },

  setAutoAnswer: (ref) => set({ autoAnswer: ref }),

  answerLine: (q, segmentId) =>
    set((state) => {
      const i = state.questions.findIndex((p) => p.segmentId === segmentId);
      if (i < 0) {
        return { questions: [{ ...q, assisted: true, segmentId }, ...state.questions].slice(0, 10) };
      }
      return {
        questions: state.questions.map((p, j) =>
          j === i ? { ...p, text: q.text, assisted: true, heldBack: false } : p),
      };
    }),

  holdBack: (segmentId, text) =>
    set((state) => ({
      questions: state.questions.map((q) =>
        (segmentId !== undefined ? q.segmentId === segmentId : q.text === text)
          ? { ...q, assisted: false, heldBack: true }
          : q),
    })),

  reviseLine: (segmentId, text) =>
    set((state) => ({
      questions: state.questions.map((q) =>
        q.segmentId === segmentId ? { ...q, text, assisted: false, heldBack: false } : q),
    })),

  markTurnLine: (segmentId) => {
    turnLines.add(segmentId);
  },

  isTurnLine: (segmentId) => segmentId !== undefined && turnLines.has(segmentId),
}));
