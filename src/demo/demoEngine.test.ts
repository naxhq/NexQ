import { afterEach, describe, expect, it } from "vitest";
import { launchDemo, exitDemo } from "./demoEngine";
import { liveInterviewScenario } from "./scenarios/liveInterview";
import { liveLectureScenario } from "./scenarios/liveLecture";
import { settingsScenario } from "./scenarios/settings";
import { useQuestionStore } from "../stores/questionStore";
import { useDemoStore } from "./demoStore";
import type { DetectedQuestion } from "../lib/types";

const question: DetectedQuestion = { text: "And how do you monitor the health of such a pipeline in production?", confidence: 0.8, timestamp_ms: 184000, source: "Interviewer" };

/** What the overlay's question panel does when the demo transcript has a question. */
function detectQuestionInDemo() {
  const store = useQuestionStore.getState();
  store.checkLine("demo-seg-107", question.text);
  store.addQuestion(question, "demo-seg-107");
}

afterEach(() => {
  if (useDemoStore.getState().isDemoActive) exitDemo();
  useQuestionStore.getState().clear();
});

describe("demo mode and the question panel", () => {
  it("a question detected in one demo does not show in the next demos", () => {
    launchDemo(liveInterviewScenario, "screenshot");
    detectQuestionInDemo();
    expect(useQuestionStore.getState().questions).toHaveLength(1);
    exitDemo();
    expect(useQuestionStore.getState().questions).toEqual([]);

    for (const next of [settingsScenario, liveLectureScenario]) {
      launchDemo(next, "screenshot");
      expect(useQuestionStore.getState().questions).toEqual([]);
      exitDemo();
    }
  });

  it("the question panel checks the same transcript line again in the next demo", () => {
    launchDemo(liveInterviewScenario, "screenshot");
    detectQuestionInDemo();
    exitDemo();
    launchDemo(liveInterviewScenario, "screenshot");
    // checkLine is false for a line it has already seen as it is
    expect(useQuestionStore.getState().checkLine("demo-seg-107", question.text)).toBe(true);
  });

  it("a demo starts clean and exit brings back the questions that were there before", () => {
    useQuestionStore.getState().addQuestion({ ...question, text: "What is your rate?" }, "real-1");
    launchDemo(liveInterviewScenario, "screenshot");
    expect(useQuestionStore.getState().questions).toEqual([]);
    detectQuestionInDemo();
    exitDemo();
    expect(useQuestionStore.getState().questions.map((q) => q.text)).toEqual(["What is your rate?"]);
  });
});
