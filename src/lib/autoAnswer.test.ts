import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ipc")>()),
  cancelGeneration: vi.fn(() => Promise.resolve()),
}));
vi.mock("./userAction", () => ({ runUserAction: vi.fn(() => Promise.resolve()) }));

import { decideTurnStep, makeWayForYou, runYourAction } from "./autoAnswer";
import { cancelGeneration } from "./ipc";
import { runUserAction } from "./userAction";
import { useQuestionStore, type AutoAnswerRef } from "../stores/questionStore";
import { useStreamStore } from "../stores/streamStore";
import { useConfigStore } from "../stores/configStore";
import { useSourcesStore } from "../stores/sourcesStore";
import { useAssistSourcesStore } from "../stores/assistSourcesStore";
import { useMeetingStore } from "../stores/meetingStore";
import type { AssistSources } from "./types";

const ref = (over: Partial<AutoAnswerRef> = {}): AutoAnswerRef => ({
  requestId: "r1",
  segmentId: "line",
  question: "What would you do?",
  early: true,
  done: Promise.resolve(),
  ...over,
});

describe("decideTurnStep", () => {
  it("answers a question on 'done' at once", () => {
    expect(decideTurnStep("end", "line", "What would you do?", null))
      .toEqual({ kind: "answer", question: "What would you do?", early: false, replaces: false });
  });

  it("answers early on 'probably done'", () => {
    expect(decideTurnStep("eager_end", "line", "What would you do?", null))
      .toEqual({ kind: "answer", question: "What would you do?", early: true, replaces: false });
  });

  it("does nothing for a line without a question", () => {
    expect(decideTurnStep("eager_end", "line", null, null)).toEqual({ kind: "none" });
    expect(decideTurnStep("end", "line", null, null)).toEqual({ kind: "none" });
    expect(decideTurnStep("resumed", "line", null, null)).toEqual({ kind: "none" });
  });

  it("withdraws the early answer when the speaker keeps talking", () => {
    expect(decideTurnStep("resumed", "line", "What would you do?", ref())).toEqual({ kind: "withdraw" });
  });

  it("keeps the early answer when the turn ends with the same question", () => {
    expect(decideTurnStep("end", "line", "What would you do?", ref())).toEqual({ kind: "confirm" });
  });

  it("treats the same words with other punctuation or case as the same question", () => {
    expect(decideTurnStep("end", "line", "What would you do?", ref({ question: "what would you do" })))
      .toEqual({ kind: "confirm" });
    expect(decideTurnStep("eager_end", "line", "What would you do?", ref({ question: "What would you do" })))
      .toEqual({ kind: "none" });
  });

  it("replaces the early answer when the turn ends with a different question", () => {
    expect(decideTurnStep("end", "line", "What would you do if the build broke?", ref()))
      .toEqual({ kind: "answer", question: "What would you do if the build broke?", early: false, replaces: true });
  });

  it("withdraws the early answer when the turn ends without a question", () => {
    expect(decideTurnStep("end", "line", null, ref())).toEqual({ kind: "withdraw" });
  });

  it("starts a new early answer when the question grows before the turn ends", () => {
    expect(decideTurnStep("eager_end", "line", "What would you do first?", ref()))
      .toEqual({ kind: "answer", question: "What would you do first?", early: true, replaces: true });
    expect(decideTurnStep("eager_end", "line", "What would you do?", ref())).toEqual({ kind: "none" });
  });

  it("never replaces an answer to a finished turn, nor one for another line", () => {
    const done = ref({ early: false });
    expect(decideTurnStep("end", "line", "And what next?", done))
      .toEqual({ kind: "answer", question: "And what next?", early: false, replaces: false });
    expect(decideTurnStep("resumed", "line", "And what", done)).toEqual({ kind: "none" });
    expect(decideTurnStep("end", "line", "What would you do?", done)).toEqual({ kind: "none" });
    expect(decideTurnStep("end", "other", "Who are you?", ref()))
      .toEqual({ kind: "answer", question: "Who are you?", early: false, replaces: false });
    expect(decideTurnStep("resumed", "other", "Who", ref())).toEqual({ kind: "none" });
  });
});

describe("an answer you ask for", () => {
  afterEach(() => {
    vi.mocked(cancelGeneration).mockReset().mockImplementation(() => Promise.resolve());
    vi.mocked(runUserAction).mockReset().mockImplementation(() => Promise.resolve());
    useStreamStore.getState().resetForMeeting();
    useQuestionStore.getState().clear();
  });

  it("stops a running automatic answer first, which isn't kept", async () => {
    const stream = useStreamStore.getState();
    stream.startStream("Assist", "m", "p", { requestId: "auto-1" });
    stream.appendToken("Half an ans");
    useQuestionStore.getState().setAutoAnswer(ref({ requestId: "auto-1", early: false }));
    // The backend's cancelled end event, as cancel_generation sends it.
    vi.mocked(cancelGeneration).mockImplementation(async () => useStreamStore.getState().endStream(0));

    await makeWayForYou();
    expect(cancelGeneration).toHaveBeenCalledWith("auto-1");
    expect(useStreamStore.getState().responseHistory).toHaveLength(0);
    expect(useStreamStore.getState().isStreaming).toBe(false);
    expect(useQuestionStore.getState().autoAnswer).toBeNull();
  });

  it("leaves the question it stopped as a card to click, not marked answered", async () => {
    const question = { text: "What would you do?", confidence: 1, timestamp_ms: 1, source: "Them" as const };
    useQuestionStore.getState().answerLine(question, "line");
    useStreamStore.getState().startStream("Assist", "m", "p", { requestId: "auto-1" });
    useQuestionStore.getState().setAutoAnswer(ref({ requestId: "auto-1" }));
    vi.mocked(cancelGeneration).mockImplementation(async () => useStreamStore.getState().endStream(0));

    await makeWayForYou();
    expect(useQuestionStore.getState().questions[0]).toMatchObject({ assisted: false, heldBack: true });
  });

  it("runs at once when nothing has to stop first", () => {
    void runYourAction("Recap");
    expect(runUserAction).toHaveBeenCalledWith("Recap", undefined, { sources: { library: true, tools: false } });
  });

  it("stops a running automatic answer, then runs yours", async () => {
    useStreamStore.getState().startStream("Assist", "m", "p", { requestId: "auto-1" });
    useQuestionStore.getState().setAutoAnswer(ref({ requestId: "auto-1" }));
    vi.mocked(cancelGeneration).mockImplementation(async () => useStreamStore.getState().endStream(0));

    await runYourAction("WhatToSay");
    expect(cancelGeneration).toHaveBeenCalledWith("auto-1");
    expect(runUserAction).toHaveBeenCalledWith("WhatToSay", undefined, { sources: { library: true, tools: false } });
    expect(vi.mocked(cancelGeneration).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(runUserAction).mock.invocationCallOrder[0]);
  });

  it("settles with your answer, and passes on its refusal", async () => {
    vi.mocked(runUserAction).mockRejectedValue("Generation already in progress");
    await expect(runYourAction("Recap")).rejects.toBe("Generation already in progress");
  });

  it("leaves any other answer running", async () => {
    useStreamStore.getState().startStream("Assist", "m", "p", { requestId: "yours" });
    useQuestionStore.getState().setAutoAnswer(ref({ requestId: "auto-1" })); // already finished
    await makeWayForYou();
    expect(cancelGeneration).not.toHaveBeenCalled();
    expect(useStreamStore.getState().isRunning("yours")).toBe(true);
  });
});

describe("runYourAction and the Knowledge / Tools pills", () => {
  const providerBefore = useConfigStore.getState().llmProvider;
  const meeting = (id: string) => useMeetingStore.setState({ activeMeeting: { id } as never });

  function setUp(provider: string, toggles = { library: true, tools: false }, info: Partial<AssistSources> = {}) {
    useConfigStore.setState({ llmProvider: provider as never });
    useSourcesStore.setState({ toggles });
    useAssistSourcesStore.setState({
      pills: {},
      info: {
        m1: {
          workspace_id: "w1",
          documents: 1,
          notes: 0,
          folders: [{ label: "Vault", used: true }],
          servers: [{ label: "Mira", allowed_tools: 1, total_tools: 1, usable: true }],
          ...info,
        },
      },
    });
    meeting("m1");
  }

  afterEach(() => {
    useConfigStore.setState({ llmProvider: providerBefore });
    useSourcesStore.setState({ toggles: { library: true, tools: true } });
    useAssistSourcesStore.setState({ pills: {}, info: {} });
    useMeetingStore.setState({ activeMeeting: null });
    vi.mocked(runUserAction).mockClear();
  });

  it("an action button sends the pills as the meeting has them", async () => {
    setUp("claude_cli");
    await runYourAction("Assist");
    expect(runUserAction).toHaveBeenCalledWith("Assist", undefined, { sources: { library: true, tools: false } });
  });

  it("Tools on with no server behind it in this workspace is sent as off", async () => {
    setUp("claude_cli", { library: true, tools: true }, { servers: [] });
    await runYourAction("WhatToSay");
    expect(runUserAction).toHaveBeenCalledWith("WhatToSay", undefined, { sources: { library: true, tools: false } });
  });

  it("an API provider still sends Knowledge (it works everywhere) and never Tools", async () => {
    setUp("openai", { library: true, tools: true });
    await runYourAction("Assist", "q");
    expect(runUserAction).toHaveBeenCalledWith("Assist", "q", { sources: { library: true, tools: false } });
  });

  it("each meeting has its own pills", async () => {
    setUp("claude_cli", { library: true, tools: true });
    useAssistSourcesStore.getState().setPill("m1", "library", false);
    await runYourAction("Assist");
    expect(runUserAction).toHaveBeenLastCalledWith("Assist", undefined, { sources: { library: false, tools: true } });
    meeting("m2");
    await runYourAction("Assist");
    expect(runUserAction).toHaveBeenLastCalledWith("Assist", undefined, { sources: { library: true, tools: true } });
  });

  it("a pill flipped after the click applies to the next answer only", async () => {
    setUp("claude_cli");
    useStreamStore.getState().startStream("Assist", "m", "p", { requestId: "auto-1" });
    useQuestionStore.getState().setAutoAnswer(ref({ requestId: "auto-1" }));
    vi.mocked(cancelGeneration).mockImplementation(async () => {
      // The pill is flipped while your request waits for the automatic answer to stop.
      useAssistSourcesStore.getState().setPill("m1", "library", false);
      useStreamStore.getState().endStream(0);
    });
    await runYourAction("Assist");
    expect(runUserAction).toHaveBeenCalledWith("Assist", undefined, { sources: { library: true, tools: false } });
  });

});
