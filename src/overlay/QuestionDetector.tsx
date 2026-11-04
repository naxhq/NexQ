import { useEffect, useRef, useCallback } from "react";
import { HelpCircle, Sparkles, Check, Clock, X } from "lucide-react";
import { onQuestionDetected, onTranscriptFinal, onTranscriptUpdate } from "../lib/events";
import { runUserAction } from "../lib/userAction";
import {
  REFUSED, answerRunning, autoAnswerRunning, decideTurnStep, inTurn, logAutoAnswer, runYourAction, sameQuestion,
  stopAutoAnswer,
} from "../lib/autoAnswer";
import { useTranscriptStore } from "../stores/transcriptStore";
import { useAIActionsStore } from "../stores/aiActionsStore";
import { useQuestionStore } from "../stores/questionStore";
import { showToast } from "../stores/toastStore";
import type { DetectedQuestion, TranscriptSegment, TranscriptUpdateEvent } from "../lib/types";

/**
 * Quiet time after the other party's last words before Auto-Trigger answers
 * their question, so a question still being asked isn't answered half-way.
 */
export const AUTO_TRIGGER_DELAY_MS = 1500;

const isOtherParty = (speaker: string) => speaker === "Them" || speaker === "Interviewer";

// Chinese and Japanese question signals, kept in step with
// src-tauri/src/intelligence/question_detector.rs.
const CHINESE_QUESTION_WORDS = ["什么", "什麼", "怎么", "怎麼", "为什么", "為什麼", "哪", "谁", "誰", "多少", "如何"];
// A question word meaning "any" or "no matter" (没什么问题, 无论如何) doesn't ask anything.
const CHINESE_NON_QUESTION_PHRASES = [
  "没什么", "沒什麼", "什么都", "什麼都", "什么也", "什麼也", "不怎么", "不怎麼",
  "哪怕", "谁都", "誰都", "谁也", "誰也", "无论", "無論", "不管", "多多少少",
];
// A bare か also ends ordinary words (静か, 確か, とか).
const JAPANESE_QUESTION_ENDINGS = ["ですか", "ますか", "ませんか", "でしたか", "ましたか", "でしょうか", "ましょうか", "のか", "ないか"];

// A tag on its own ("Right?", "You know?") asks nothing the AI could answer.
const TAG_QUESTIONS = new Set([
  "right", "okay", "ok", "yeah", "yep", "yes", "no", "nope", "sure", "correct", "true", "really",
  "agreed", "alright", "all right", "huh", "hmm", "hm", "eh", "see", "you see", "you know",
  "isn't it", "sorry", "pardon", "hello", "cool", "good",
]);
const TAG_LEAD_INS = new Set(["and", "so", "but", "well", "oh", "um", "uh", "okay", "ok", "yeah", "yes", "no"]);

function isTagQuestion(sentence: string): boolean {
  const words = sentence.toLowerCase().split(/[\s,.?？!…]+/u).filter(Boolean);
  while (words.length > 1 && TAG_LEAD_INS.has(words[0])) words.shift();
  return TAG_QUESTIONS.has(words.join(" "));
}

function isCjkQuestion(sentence: string): boolean {
  const body = sentence.replace(/[.!。！…]+$/u, "");
  return /[吗嗎呢]$/u.test(body)
    || JAPANESE_QUESTION_ENDINGS.some((ending) => body.endsWith(ending))
    || (CHINESE_QUESTION_WORDS.some((word) => body.includes(word))
      && !CHINESE_NON_QUESTION_PHRASES.some((phrase) => body.includes(phrase)));
}

export function looksLikeQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (isTagQuestion(trimmed)) return false;
  if (/[?？]$/u.test(trimmed) || isCjkQuestion(trimmed)) return true;
  const lower = trimmed.toLowerCase();
  const qWords = [
    "what ", "how ", "why ", "when ", "where ", "who ", "which ",
    "can you", "could you", "would you", "do you", "are you",
    "is there", "have you", "tell me", "explain",
  ];
  return qWords.some((w) => lower.startsWith(w));
}

/**
 * The newest sentence of a transcript line. Lines grow into paragraphs, so a
 * question is usually the last sentence, not the whole line. A tag after it
 * ("Is that what you meant? Right?") doesn't count as the newest sentence.
 */
export function lastSentence(text: string): string {
  const sentences = text.trim().match(/[^.?!。？！\n]+[.?!。？！]*/gu) ?? [];
  let last = sentences.length - 1;
  while (last > 0 && isTagQuestion(sentences[last])) last--;
  return (sentences[last] ?? "").trim();
}

/**
 * Starts an automatic answer to `question` (a line's question), unless another
 * answer is running: then the question stays a card to click.
 */
function startAutoAnswer(question: DetectedQuestion, segmentId: string | undefined, early: boolean, detail?: string) {
  const store = useQuestionStore.getState();
  if (answerRunning()) {
    store.holdBack(segmentId, question.text);
    logAutoAnswer("held");
    return;
  }
  if (segmentId !== undefined) store.answerLine(question, segmentId);
  const requestId = crypto.randomUUID();
  const done = runUserAction("Assist", question.text, { requestId }).catch((err) => {
    // Refused: an answer started elsewhere in the meantime.
    if (!String(err).includes(REFUSED)) return;
    const now = useQuestionStore.getState();
    now.holdBack(segmentId, question.text);
    if (now.autoAnswer?.requestId === requestId) now.setAutoAnswer(null);
    logAutoAnswer("held");
  });
  if (segmentId !== undefined) store.setAutoAnswer({ requestId, segmentId, question: question.text, early, done });
  logAutoAnswer(early ? "early" : "answered", detail);
}

/** Auto-Answer for a line that carries the provider's turn signal. */
async function onTurnSignal(seg: TranscriptSegment, signalAt: number) {
  if (!seg.turn || !useAIActionsStore.getState().configs.globalDefaults.autoTrigger) return;
  const store = useQuestionStore.getState();
  const sentence = lastSentence(seg.text);
  const question = sentence && looksLikeQuestion(sentence) ? sentence : null;
  const current = store.autoAnswer;
  const step = decideTurnStep(seg.turn, seg.id, question, current);
  if (step.kind === "none") return;
  if (step.kind === "confirm") {
    if (current) store.setAutoAnswer({ ...current, early: false });
    logAutoAnswer("kept");
    return;
  }
  // The early answer was premature: it gives way.
  if (current && (step.kind === "withdraw" || step.replaces)) {
    store.setAutoAnswer(null);
    if (step.kind === "withdraw") store.holdBack(seg.id, current.question);
    logAutoAnswer("withdrawn");
    await stopAutoAnswer(current);
  }
  if (step.kind === "answer") {
    const q = { text: step.question, confidence: 0.9, timestamp_ms: seg.timestamp_ms, source: seg.speaker };
    startAutoAnswer(q, seg.id, step.early, `${seg.turn}, ${Date.now() - signalAt} ms after the signal`);
  }
}

/** The overlay's question card, unless question detection is off. */
export function QuestionPanel() {
  const questionDetection = useAIActionsStore((s) => s.configs.globalDefaults.questionDetection);
  if (!questionDetection) return null;
  return (
    <div className="shrink-0 rounded-xl border border-info/10 bg-info/5 px-4 py-3">
      <QuestionDetector />
    </div>
  );
}

export function QuestionDetector() {
  const questions = useQuestionStore((s) => s.questions);
  const addQuestion = useQuestionStore((s) => s.addQuestion);
  const justMountedRef = useRef(true);
  const segments = useTranscriptStore((s) => s.segments);
  const autoTrigger = useAIActionsStore((s) => s.configs.globalDefaults.autoTrigger);
  // Changes whenever the other party says more (a new line, or a line growing).
  const otherPartyActivity = useTranscriptStore((s) => {
    for (let i = s.segments.length - 1; i >= 0; i--) {
      const seg = s.segments[i];
      if (isOtherParty(seg.speaker)) return `${seg.id}:${seg.text.length}`;
    }
    return "";
  });

  useEffect(() => {
    const p = onQuestionDetected((event) => {
      if (isOtherParty(event.source)) {
        addQuestion(event);
      }
    });
    return () => { p.then((u) => u()); };
  }, [addQuestion]);

  // Providers that detect turns (Cartesia, Deepgram Flux): answer on their
  // "done", or early on "probably done", instead of waiting for quiet.
  useEffect(() => {
    if (!autoTrigger) return;
    const onLine = ({ segment }: TranscriptUpdateEvent) => {
      if (!segment.turn || !isOtherParty(segment.speaker)) return;
      useQuestionStore.getState().markTurnLine(segment.id);
      const at = Date.now();
      void inTurn(() => onTurnSignal(segment, at));
    };
    const updates = onTranscriptUpdate(onLine);
    const finals = onTranscriptFinal(onLine);
    return () => {
      updates.then((u) => u());
      finals.then((u) => u());
    };
  }, [autoTrigger]);

  useEffect(() => {
    const store = useQuestionStore.getState();
    const { checkLine, panelSeen, setPanelSeen, holdBackUnanswered } = store;
    for (const seg of segments) {
      if (!seg.is_final || !checkLine(seg.id, seg.text)) continue;
      if (!isOtherParty(seg.speaker)) continue;
      const sentence = lastSentence(seg.text);
      if (sentence && looksLikeQuestion(sentence)) {
        addQuestion({ text: sentence, confidence: 0.8, timestamp_ms: seg.timestamp_ms, source: seg.speaker }, seg.id);
        // The line grew into another question after Auto-Answer answered it:
        // that answer was for an incomplete question and gives way. (Lines
        // with turn signals are handled on those signals.)
        const ref = store.autoAnswer;
        if (autoTrigger && ref && ref.segmentId === seg.id && !sameQuestion(ref.question, sentence) && !store.isTurnLine(seg.id)) {
          store.setAutoAnswer(null);
          store.reviseLine(seg.id, sentence);
          logAutoAnswer("withdrawn");
          void inTurn(() => stopAutoAnswer(ref));
        }
      }
    }
    // Back from a layout switch or Settings: what is unanswered now can be
    // minutes old, so it stays a card to click rather than getting answered.
    if (justMountedRef.current && panelSeen) holdBackUnanswered();
    justMountedRef.current = false;
    setPanelSeen();
  }, [segments, addQuestion, autoTrigger]);

  const handleAssist = useCallback((index: number) => {
    const question = questions[index];
    if (!question) return;
    // Its automatic answer is on the way: a click doesn't restart it.
    const store = useQuestionStore.getState();
    if (autoAnswerRunning() && sameQuestion(store.autoAnswer?.question, question.text)) return;
    store.markAssisted(index);
    runYourAction("Assist", question.text).catch((err) => {
      // No answer came, so it stays a card to click.
      useQuestionStore.getState().holdBack(question.segmentId, question.text);
      showToast(String(err).includes(REFUSED) ? "Another answer is still running" : "Couldn't generate AI response", "error");
    });
  }, [questions]);

  const handleDismiss = useCallback((index: number, e: React.MouseEvent) => {
    e.stopPropagation();
    useQuestionStore.getState().dismiss(index);
  }, []);

  const latest = questions.length > 0 ? questions[0] : null;
  const previousQuestions = questions.slice(1, 4);

  // Auto-Trigger: answer the newest question once the other party has been
  // quiet for a moment. More words from them restart the wait. Lines from a
  // provider that detects turns are answered on its signals instead.
  const waiting = autoTrigger && !!latest && !latest.assisted && !latest.heldBack
    && !useQuestionStore.getState().isTurnLine(latest.segmentId);
  const autoAssist = useCallback(() => {
    const q = useQuestionStore.getState().questions[0];
    if (!q || q.assisted || q.heldBack) return;
    useQuestionStore.getState().markAssisted(0);
    startAutoAnswer(q, q.segmentId, false, "after the quiet wait");
  }, []);
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => void inTurn(autoAssist), AUTO_TRIGGER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [waiting, latest?.text, otherPartyActivity, autoAssist]);

  return (
    <div className="flex flex-col gap-2.5" role="region" aria-label="Detected questions">
      {/* Latest question — prominent card */}
      <div
        className={`group flex items-start gap-3 rounded-lg transition-all duration-200 ${
          latest ? "cursor-pointer hover:bg-info/10 question-card-enter" : ""
        }`}
        onClick={() => latest && handleAssist(0)}
        onKeyDown={(e) => { if (latest && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); handleAssist(0); } }}
        role={latest ? "button" : undefined}
        tabIndex={latest ? 0 : undefined}
        aria-label={latest ? `Question: ${latest.text}. ${latest.assisted ? "Answered" : "Click to assist"}` : undefined}
      >
        <div className="relative mt-0.5 shrink-0" aria-hidden="true">
          <HelpCircle className={`h-5 w-5 transition-colors ${latest ? "text-info" : "text-muted-foreground/50"}`} />
          {latest && !latest.assisted && (
            <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-info animate-pulse" />
          )}
          {latest?.assisted && (
            <span className="absolute -top-0.5 -right-0.5 flex h-3 w-3 items-center justify-center rounded-full bg-success">
              <Check className="h-2 w-2 text-white" />
            </span>
          )}
        </div>

        <div className="flex-1 min-w-0">
          {latest ? (
            <p className="text-sm leading-relaxed font-medium text-foreground/90">
              &ldquo;{latest.text}&rdquo;
            </p>
          ) : (
            <p className="text-xs text-muted-foreground/50">
              Listening for questions from the other party
            </p>
          )}
        </div>

        {latest && (
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={(e) => { e.stopPropagation(); handleAssist(0); }}
              aria-label={latest.assisted ? "Already answered" : "Get AI assistance for this question"}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all duration-150 cursor-pointer ${
                latest.assisted
                  ? "bg-success/10 border border-success/20 text-success"
                  : "bg-info/10 border border-info/20 text-info hover:bg-info/20"
              }`}
            >
              {latest.assisted ? (
                <><Check className="h-3.5 w-3.5" aria-hidden="true" />Answered</>
              ) : (
                <><Sparkles className="h-3.5 w-3.5" aria-hidden="true" />Assist</>
              )}
            </button>
            <button
              onClick={(e) => handleDismiss(0, e)}
              aria-label="Dismiss question"
              className="rounded-lg p-1.5 text-muted-foreground/30 opacity-0 transition-all duration-150 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Previous questions — compact list */}
      {previousQuestions.length > 0 && (
        <div className="flex flex-col gap-1">
          {previousQuestions.map((q, idx) => {
            const realIdx = idx + 1;
            return (
              <div
                key={`q-${realIdx}-${q.timestamp_ms}`}
                className={`group/q flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-all duration-150 question-card-enter ${
                  q.assisted
                    ? "bg-success/5 border border-success/10"
                    : "bg-card/20 hover:bg-card/40 hover:border-border/20 cursor-pointer"
                }`}
                onClick={() => !q.assisted && handleAssist(realIdx)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleAssist(realIdx); } }}
                title={q.text}
              >
                <div className="shrink-0">
                  {q.assisted ? (
                    <div className="flex h-4 w-4 items-center justify-center rounded-full bg-success/20">
                      <Check className="h-2.5 w-2.5 text-success" />
                    </div>
                  ) : (
                    <div className="flex h-4 w-4 items-center justify-center rounded-full bg-muted/30">
                      <Clock className="h-2.5 w-2.5 text-muted-foreground/60" />
                    </div>
                  )}
                </div>

                <span className={`flex-1 truncate text-xs leading-snug transition-colors ${
                  q.assisted
                    ? "text-success/70 font-medium"
                    : "text-muted-foreground/60 group-hover/q:text-foreground/80"
                }`}>
                  {q.text}
                </span>

                {!q.assisted && (
                  <Sparkles className="h-3 w-3 shrink-0 text-info/0 group-hover/q:text-info/60 transition-colors" />
                )}
                <button
                  onClick={(e) => handleDismiss(realIdx, e)}
                  aria-label="Dismiss question"
                  className="rounded p-0.5 text-muted-foreground/0 opacity-0 transition-all duration-150 hover:bg-destructive/10 hover:text-destructive group-hover/q:opacity-100 group-hover/q:text-muted-foreground/30 cursor-pointer"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
