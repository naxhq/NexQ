import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Transcript event handlers the component subscribes, so a test can send lines.
const listeners = vi.hoisted(() => ({
  update: [] as Array<(e: { segment: unknown }) => void>,
  final: [] as Array<(e: { segment: unknown }) => void>,
}));
vi.mock("../lib/events", () => {
  const subscribe = (list: Array<(e: { segment: unknown }) => void>) => (h: (e: { segment: unknown }) => void) => {
    list.push(h);
    return Promise.resolve(() => { list.splice(list.indexOf(h), 1); });
  };
  return {
    onQuestionDetected: () => Promise.resolve(() => {}),
    onTranscriptUpdate: subscribe(listeners.update),
    onTranscriptFinal: subscribe(listeners.final),
  };
});
vi.mock("../lib/userAction", () => ({ runUserAction: vi.fn(() => Promise.resolve()) }));
vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  cancelGeneration: vi.fn(() => Promise.resolve()),
}));

import { AUTO_TRIGGER_DELAY_MS, QuestionDetector, QuestionPanel, lastSentence, looksLikeQuestion } from "./QuestionDetector";
import { runUserAction } from "../lib/userAction";
import { cancelGeneration } from "../lib/ipc";
import { useStreamStore } from "../stores/streamStore";
import { useAIActionsStore } from "../stores/aiActionsStore";
import { useQuestionStore } from "../stores/questionStore";
import { useToastStore } from "../stores/toastStore";
import { resetMeetingScopedStores } from "../stores/resetMeeting";
import { useTranscriptStore } from "../stores/transcriptStore";
import type { GlobalDefaults, TranscriptSegment, TurnSignal } from "../lib/types";

const seg = (text: string, is_final = true): TranscriptSegment =>
  ({ id: "them_1", text, speaker: "Them", timestamp_ms: 1, is_final, confidence: 1 }) as TranscriptSegment;

function setDefaults(defaults: Partial<GlobalDefaults>) {
  const { configs } = useAIActionsStore.getState();
  useAIActionsStore.setState({ configs: { ...configs, globalDefaults: { ...configs.globalDefaults, ...defaults } } });
}

const setAutoTrigger = (on: boolean) => setDefaults({ autoTrigger: on });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.mocked(runUserAction).mockReset().mockImplementation(() => Promise.resolve());
  vi.mocked(cancelGeneration).mockClear();
  useQuestionStore.getState().clear();
  useStreamStore.getState().resetForMeeting();
  listeners.update.length = 0;
  listeners.final.length = 0;
});

/** A line from the other party carrying a provider turn signal. */
const turnLine = (text: string, turn: TurnSignal, id = "them_t1"): TranscriptSegment =>
  ({ id, text, speaker: "Them", timestamp_ms: 1, is_final: turn === "end", confidence: 1, turn }) as TranscriptSegment;

/** Delivers a line as the transcript events do (store first, as useTranscript does). */
function send(line: TranscriptSegment) {
  act(() => {
    if (line.is_final) useTranscriptStore.setState({ segments: [line] });
    for (const h of [...(line.is_final ? listeners.final : listeners.update)]) h({ segment: line });
  });
}

/** Lets queued Auto-Answer steps (and their stops) finish. */
async function settle() {
  for (let i = 0; i < 6; i++) await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

/** Answers keep running until cancelled, like real streams. */
function answersRunUntilStopped() {
  const running = new Map<string, () => void>();
  vi.mocked(runUserAction).mockImplementation((_mode, _q, opts) => {
    const id = opts?.requestId ?? "?";
    useStreamStore.setState({ isStreaming: true, streamRequestId: id });
    return new Promise<void>((resolve) => running.set(id, resolve));
  });
  vi.mocked(cancelGeneration).mockImplementation(async (id) => {
    useStreamStore.setState({ isStreaming: false, streamRequestId: null });
    if (id) running.get(id)?.();
  });
}

const askedFor = () => vi.mocked(runUserAction).mock.calls.map((c) => c[1]);
const requestOf = (n: number) => vi.mocked(runUserAction).mock.calls[n][2]?.requestId;

describe("Auto-Answer with the provider's turn signals (Cartesia, Deepgram Flux)", () => {
  it("answers as soon as the provider says the speaker finished, with no quiet wait", async () => {
    vi.useFakeTimers();
    setAutoTrigger(true);
    render(<QuestionDetector />);
    send(turnLine("Thanks. What would you do first?", "end"));
    await settle();
    expect(askedFor()).toEqual(["What would you do first?"]);
    // The quiet wait doesn't answer it a second time.
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_TRIGGER_DELAY_MS * 3); });
    expect(runUserAction).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Answered")).toBeTruthy();
  });

  it("starts early on 'probably done' and keeps that answer when the turn ends the same", async () => {
    vi.useFakeTimers();
    setAutoTrigger(true);
    render(<QuestionDetector />);
    send(turnLine("What would you do first?", "eager_end"));
    await settle();
    expect(askedFor()).toEqual(["What would you do first?"]);
    send(turnLine("What would you do first?", "end"));
    await settle();
    expect(runUserAction).toHaveBeenCalledTimes(1);
    expect(cancelGeneration).not.toHaveBeenCalled();
  });

  it("stops the early answer when they keep talking, and answers the whole question at the end", async () => {
    vi.useFakeTimers();
    setAutoTrigger(true);
    answersRunUntilStopped();
    render(<QuestionDetector />);
    send(turnLine("What would you do", "eager_end"));
    await settle();
    const early = requestOf(0);
    send(turnLine("What would you do", "resumed"));
    await settle();
    expect(cancelGeneration).toHaveBeenCalledWith(early);
    expect(screen.queryByText("Answered")).toBeNull();

    send(turnLine("What would you do if the build broke?", "end"));
    await settle();
    expect(askedFor()).toEqual(["What would you do", "What would you do if the build broke?"]);
  });

  it("replaces the early answer when the turn ends with a different question", async () => {
    vi.useFakeTimers();
    setAutoTrigger(true);
    answersRunUntilStopped();
    render(<QuestionDetector />);
    send(turnLine("What would you do?", "eager_end"));
    await settle();
    send(turnLine("What would you do if the build broke?", "end"));
    await settle();
    expect(cancelGeneration).toHaveBeenCalledWith(requestOf(0));
    expect(askedFor()).toEqual(["What would you do?", "What would you do if the build broke?"]);
  });

  it("never stops an answer you asked for: the question waits as a card to click", async () => {
    vi.useFakeTimers();
    setAutoTrigger(true);
    useStreamStore.setState({ isStreaming: true, streamRequestId: "yours" });
    render(<QuestionDetector />);
    send(turnLine("What would you do first?", "end"));
    await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_TRIGGER_DELAY_MS * 3); });
    expect(runUserAction).not.toHaveBeenCalled();
    expect(cancelGeneration).not.toHaveBeenCalled();
    expect(screen.getByText(/What would you do first\?/)).toBeTruthy();
    expect(screen.queryByText("Answered")).toBeNull();
  });

  it("clicking another question during an automatic answer stops it and answers yours", async () => {
    vi.useFakeTimers();
    setAutoTrigger(true);
    answersRunUntilStopped();
    useQuestionStore.getState().addQuestion(
      { text: "Which database did you pick?", confidence: 1, timestamp_ms: 1, source: "Them" }, "them_old");
    useQuestionStore.getState().markAssisted(0);
    useQuestionStore.getState().holdBack("them_old", "Which database did you pick?");
    render(<QuestionDetector />);
    send(turnLine("What would you do first?", "end"));
    await settle();
    const automatic = requestOf(0);

    fireEvent.click(screen.getByText(/Which database did you pick\?/));
    await settle();
    expect(cancelGeneration).toHaveBeenCalledWith(automatic);
    expect(askedFor()).toEqual(["What would you do first?", "Which database did you pick?"]);
    // The question it stopped goes back to a card to click.
    expect(useQuestionStore.getState().questions[0]).toMatchObject({ assisted: false, heldBack: true });
  });

  it("clicking the question being answered doesn't restart its answer", async () => {
    vi.useFakeTimers();
    setAutoTrigger(true);
    answersRunUntilStopped();
    render(<QuestionDetector />);
    send(turnLine("What would you do first?", "end"));
    await settle();

    fireEvent.click(screen.getByRole("button", { name: /Question: What would you do first\?/ }));
    await settle();
    expect(cancelGeneration).not.toHaveBeenCalled();
    expect(runUserAction).toHaveBeenCalledTimes(1);
  });

  it("a click that gets no answer stays a card to click, and says why", async () => {
    vi.useFakeTimers();
    setAutoTrigger(false);
    vi.mocked(runUserAction).mockRejectedValue("Generation already in progress");
    useQuestionStore.getState().addQuestion(
      { text: "What would you do first?", confidence: 1, timestamp_ms: 1, source: "Them" }, "them_1");
    render(<QuestionDetector />);

    fireEvent.click(screen.getByRole("button", { name: /Question: What would you do first\?/ }));
    await settle();
    expect(screen.queryByText("Answered")).toBeNull();
    expect(useToastStore.getState().toasts.map((t) => t.message)).toContain("Another answer is still running");
  });

  it("answers nothing on turn signals with Auto-Answer off", async () => {
    vi.useFakeTimers();
    setAutoTrigger(false);
    render(<QuestionDetector />);
    send(turnLine("What would you do first?", "eager_end"));
    send(turnLine("What would you do first?", "end"));
    await settle();
    expect(runUserAction).not.toHaveBeenCalled();
  });
});

describe("Auto-Answer without turn signals (Deepgram Nova and the others)", () => {
  it("a refused automatic answer leaves the question to click, not marked answered", async () => {
    vi.useFakeTimers();
    setAutoTrigger(true);
    useStreamStore.setState({ isStreaming: true, streamRequestId: "yours" });
    useTranscriptStore.setState({ segments: [seg("What would you do first?")] });
    render(<QuestionDetector />);
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_TRIGGER_DELAY_MS * 3); });
    await settle();
    expect(runUserAction).not.toHaveBeenCalled();
    expect(screen.queryByText("Answered")).toBeNull();
  });

  it("a line that grows into another question replaces the running automatic answer", async () => {
    vi.useFakeTimers();
    setAutoTrigger(true);
    answersRunUntilStopped();
    useTranscriptStore.setState({ segments: [seg("What would you do")] });
    render(<QuestionDetector />);
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_TRIGGER_DELAY_MS); });
    await settle();
    expect(askedFor()).toEqual(["What would you do"]);

    act(() => useTranscriptStore.setState({ segments: [seg("What would you do if the build broke?")] }));
    await settle();
    expect(cancelGeneration).toHaveBeenCalledWith(requestOf(0));
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_TRIGGER_DELAY_MS - 1); });
    expect(runUserAction).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await settle();
    expect(askedFor()).toEqual(["What would you do", "What would you do if the build broke?"]);
  });
});

describe("Auto-Trigger", () => {
  it("answers a question once the other party has been quiet for a moment", () => {
    vi.useFakeTimers();
    setAutoTrigger(true);
    useTranscriptStore.setState({ segments: [seg("Thanks for joining. What would you do first?")] });
    render(<QuestionDetector />);
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS - 100));
    expect(runUserAction).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(100));
    expect(runUserAction).toHaveBeenCalledWith("Assist", "What would you do first?", expect.anything());
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS * 3));
    expect(runUserAction).toHaveBeenCalledTimes(1);
  });

  it("waits while they keep talking, and answers the finished question", () => {
    vi.useFakeTimers();
    setAutoTrigger(true);
    useTranscriptStore.setState({ segments: [seg("What would you do")] });
    render(<QuestionDetector />);
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS - 500));
    act(() => useTranscriptStore.setState({ segments: [seg("What would you do if the build broke?", false)] }));
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS - 500));
    act(() => useTranscriptStore.setState({ segments: [seg("What would you do if the build broke?")] }));
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS - 1));
    expect(runUserAction).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(runUserAction).toHaveBeenCalledWith("Assist", "What would you do if the build broke?", expect.anything());
  });

  it("only shows the question when turned off", () => {
    vi.useFakeTimers();
    setAutoTrigger(false);
    useTranscriptStore.setState({ segments: [seg("What would you do first?")] });
    render(<QuestionDetector />);
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS * 3));
    expect(runUserAction).not.toHaveBeenCalled();
    expect(screen.getByText(/What would you do first\?/)).toBeTruthy();
  });
});

describe("QuestionPanel", () => {
  it("keeps detecting with Auto-Answer off, so the user picks what to answer", () => {
    vi.useFakeTimers();
    setDefaults({ questionDetection: true, autoTrigger: false });
    useTranscriptStore.setState({ segments: [seg("What would you do first?")] });
    render(<QuestionPanel />);
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS * 3));
    expect(runUserAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Get AI assistance for this question" }));
    expect(runUserAction).toHaveBeenCalledWith("Assist", "What would you do first?");
  });

  it("shows nothing and answers nothing with detection off", () => {
    vi.useFakeTimers();
    setDefaults({ questionDetection: false, autoTrigger: true });
    useTranscriptStore.setState({ segments: [seg("What would you do first?")] });
    render(<QuestionPanel />);
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS * 3));
    expect(screen.queryByText(/What would you do first\?/)).toBeNull();
    expect(runUserAction).not.toHaveBeenCalled();
    setDefaults({ questionDetection: true });
  });
});

describe("QuestionPanel coming back (layout switch, Settings)", () => {
  const question = "What would you do first?";

  it("doesn't answer an answered question again, and still shows it as answered", () => {
    vi.useFakeTimers();
    setDefaults({ questionDetection: true, autoTrigger: true });
    useTranscriptStore.setState({ segments: [seg(question)] });
    const { unmount } = render(<QuestionPanel />);
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS));
    expect(runUserAction).toHaveBeenCalledTimes(1);

    unmount();
    render(<QuestionPanel />);
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS * 3));
    expect(runUserAction).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Already answered" })).toBeTruthy();
  });

  it("shows a question asked while away without answering it, then answers the next one", () => {
    vi.useFakeTimers();
    setDefaults({ questionDetection: true, autoTrigger: true });
    useTranscriptStore.setState({ segments: [] });
    const { unmount } = render(<QuestionPanel />);
    unmount();

    useTranscriptStore.setState({ segments: [seg(question)] });
    render(<QuestionPanel />);
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS * 3));
    expect(screen.getByText(/What would you do first\?/)).toBeTruthy();
    expect(runUserAction).not.toHaveBeenCalled();

    act(() => useTranscriptStore.setState({
      segments: [seg(question), { ...seg("And how long would it take?"), id: "them_2" }],
    }));
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS));
    expect(runUserAction).toHaveBeenCalledWith("Assist", "And how long would it take?", expect.anything());
  });

  it("doesn't answer a question still waiting when the panel went away", () => {
    vi.useFakeTimers();
    setDefaults({ questionDetection: true, autoTrigger: true });
    useTranscriptStore.setState({ segments: [seg(question)] });
    const { unmount } = render(<QuestionPanel />);
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS - 1));
    unmount();

    render(<QuestionPanel />);
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS * 3));
    expect(runUserAction).not.toHaveBeenCalled();
    expect(screen.getByText(/What would you do first\?/)).toBeTruthy();
  });

  it("keeps a dismissed question dismissed", () => {
    setDefaults({ questionDetection: true, autoTrigger: false });
    useTranscriptStore.setState({ segments: [seg(question)] });
    const { unmount } = render(<QuestionPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss question" }));
    unmount();

    render(<QuestionPanel />);
    expect(screen.queryByText(/What would you do first\?/)).toBeNull();
  });

  it("starts empty in a new meeting, and answers its first question", async () => {
    setDefaults({ questionDetection: true, autoTrigger: true });
    useTranscriptStore.setState({ segments: [seg(question)] });
    const { unmount } = render(<QuestionPanel />);
    expect(screen.getByText(/What would you do first\?/)).toBeTruthy();
    unmount();

    await resetMeetingScopedStores();
    vi.useFakeTimers();
    render(<QuestionPanel />);
    expect(screen.queryByText(/What would you do first\?/)).toBeNull();

    // Same line id as the last meeting's: the new meeting's line is still checked.
    act(() => useTranscriptStore.setState({ segments: [seg(question)] }));
    act(() => vi.advanceTimersByTime(AUTO_TRIGGER_DELAY_MS));
    expect(runUserAction).toHaveBeenCalledWith("Assist", question, expect.anything());
  });
});

describe("QuestionDetector", () => {
  it("checks the newest sentence of a line", () => {
    expect(lastSentence("So here's the situation. What would you do?")).toBe("What would you do?");
    expect(looksLikeQuestion(lastSentence("We run preview days. How many do you run"))).toBe(true);
  });

  it("finds Chinese and Japanese questions", () => {
    expect(lastSentence("今天讨论进度。计划完成了吗？")).toBe("计划完成了吗？");
    expect(lastSentence("ありがとうございます。\n準備できましたか")).toBe("準備できましたか");
    for (const q of ["计划完成了？", "准备好了吗", "你的计划呢", "這個問題怎麼解決", "准备什么时候发布", "いつ始めますか。", "一緒に行きませんか"]) {
      expect(looksLikeQuestion(q), q).toBe(true);
    }
    for (const s of ["会议结束了。", "我们开始吧", "没什么问题", "无论如何都要按时完成", "会議は終了しました。", "とても静か", "コーヒーとか"]) {
      expect(looksLikeQuestion(s), s).toBe(false);
    }
  });

  it("ignores a bare tag, which leaves nothing to answer", () => {
    for (const tag of ["Right?", "right", "Okay?", "Yeah, right?", "So, right?", "You know?", "Isn't it?", "Really?"]) {
      expect(looksLikeQuestion(tag), tag).toBe(false);
    }
    for (const q of ["Why?", "Is that right?", "Right now?", "And you?", "Can you start?"]) {
      expect(looksLikeQuestion(q), q).toBe(true);
    }
  });

  it("looks past a trailing tag for the question before it", () => {
    expect(lastSentence("Is that what you were thinking about? Right?")).toBe("Is that what you were thinking about?");
    expect(lastSentence("Can something change? Okay? Yeah, right?")).toBe("Can something change?");
    expect(lastSentence("Right?")).toBe("Right?");
  });

  it("finds a question a line gains after its first final", () => {
    useTranscriptStore.setState({ segments: [seg("So here's the situation.")] });
    render(<QuestionDetector />);
    expect(screen.queryByText(/What would you do/)).toBeNull();

    act(() => useTranscriptStore.setState({ segments: [seg("So here's the situation. What would you do?")] }));
    expect(screen.getByText(/What would you do\?/)).toBeTruthy();
  });
});
