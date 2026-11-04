import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/events", () => ({ onQuestionDetected: () => Promise.resolve(() => {}) }));
vi.mock("../lib/userAction", () => ({ runUserAction: vi.fn(() => Promise.resolve()) }));

import { AUTO_TRIGGER_DELAY_MS, QuestionDetector, QuestionPanel, lastSentence, looksLikeQuestion } from "./QuestionDetector";
import { runUserAction } from "../lib/userAction";
import { useAIActionsStore } from "../stores/aiActionsStore";
import { useQuestionStore } from "../stores/questionStore";
import { resetMeetingScopedStores } from "../stores/resetMeeting";
import { useTranscriptStore } from "../stores/transcriptStore";
import type { GlobalDefaults, TranscriptSegment } from "../lib/types";

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
  vi.mocked(runUserAction).mockClear();
  useQuestionStore.getState().clear();
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
    expect(runUserAction).toHaveBeenCalledWith("Assist", "What would you do first?");
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
    expect(runUserAction).toHaveBeenCalledWith("Assist", "What would you do if the build broke?");
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
    expect(runUserAction).toHaveBeenCalledWith("Assist", "And how long would it take?");
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
    expect(runUserAction).toHaveBeenCalledWith("Assist", question);
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
