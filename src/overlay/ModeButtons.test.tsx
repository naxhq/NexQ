import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/userAction", () => ({
  runUserAction: vi.fn(() => Promise.resolve()),
  actionLabel: (mode: string) => mode,
}));
vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  cancelGeneration: vi.fn(() => Promise.resolve()),
}));

import { ModeButtons } from "./ModeButtons";
import { cancelGeneration } from "../lib/ipc";
import { runUserAction } from "../lib/userAction";
import { useQuestionStore } from "../stores/questionStore";
import { useStreamStore } from "../stores/streamStore";

const button = (name: RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;

function automaticAnswerRunning() {
  useStreamStore.getState().startStream("Assist", "m", "p", { requestId: "auto-1" });
  useQuestionStore.getState().setAutoAnswer({
    requestId: "auto-1", segmentId: "line", question: "Why?", early: false, done: Promise.resolve(),
  });
  vi.mocked(cancelGeneration).mockImplementation(async () => useStreamStore.getState().endStream(0));
}

beforeEach(() => {
  vi.mocked(runUserAction).mockClear();
  vi.mocked(cancelGeneration).mockReset().mockImplementation(() => Promise.resolve());
});

afterEach(() => {
  cleanup();
  useStreamStore.getState().resetForMeeting();
  useQuestionStore.getState().clear();
});

describe("ModeButtons while an answer runs", () => {
  it("another action stops an automatic answer and runs", async () => {
    automaticAnswerRunning();
    render(<ModeButtons />);
    const recap = button(/^Recap/);
    expect(recap.disabled).toBe(false);

    fireEvent.click(recap);
    await waitFor(() => expect(runUserAction).toHaveBeenCalledWith("Recap", undefined));
    expect(cancelGeneration).toHaveBeenCalledWith("auto-1");
  });

  it("the running action's own button still just stops it", async () => {
    automaticAnswerRunning();
    render(<ModeButtons />);
    fireEvent.click(button(/^Assist/));
    await waitFor(() => expect(cancelGeneration).toHaveBeenCalled());
    expect(runUserAction).not.toHaveBeenCalled();
  });

  it("an answer you asked for keeps the other actions locked", () => {
    useStreamStore.getState().startStream("Assist", "m", "p", { requestId: "yours" });
    render(<ModeButtons />);
    expect(button(/^Recap/).disabled).toBe(true);
    fireEvent.click(button(/^Recap/));
    expect(runUserAction).not.toHaveBeenCalled();
    expect(cancelGeneration).not.toHaveBeenCalled();
  });
});
