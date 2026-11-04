import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStreamStore, RESPONSE_HISTORY_CAP } from "./streamStore";

const T0 = 1_700_000_000_000;
const s = () => useStreamStore.getState();

/** One full answer: pending → start → token → end. */
function answer(mode: string, text: string, requestId = crypto.randomUUID()) {
  s().setPending(mode, requestId);
  s().startStream(mode as never, "haiku", "Claude CLI", { requestId });
  s().appendToken(text);
  s().endStream(10);
}

describe("streamStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    s().resetForMeeting();
  });
  afterEach(() => vi.useRealTimers());

  it("walks the phases: sending → waiting → writing → idle, with timer fields", () => {
    s().setPending("FollowUp", "r1");
    expect(s()).toMatchObject({ phase: "sending", requestStartedAt: T0, currentMode: "FollowUp", firstTokenAt: null });

    vi.setSystemTime(T0 + 400);
    s().startStream("FollowUp", "haiku", "Claude CLI", {
      requestId: "r1",
      scopeLabel: "Last 5 min",
      newLines: 3,
      sessionKey: "live:m:fast",
    });
    expect(s().phase).toBe("waiting");
    expect(s().requestStartedAt).toBe(T0); // the click, not the start event
    expect(s().streamMeta).toEqual({
      model: "haiku",
      provider: "Claude CLI",
      scopeLabel: "Last 5 min",
      newLines: 3,
      sessionKey: "live:m:fast",
    });

    s().setPhase("thinking");
    expect(s().phase).toBe("thinking");

    vi.setSystemTime(T0 + 600);
    s().appendToken("Hi");
    expect(s()).toMatchObject({ phase: "writing", firstTokenAt: T0 + 600 });
    vi.setSystemTime(T0 + 700);
    s().appendToken(" there");
    expect(s().firstTokenAt).toBe(T0 + 600);

    vi.setSystemTime(T0 + 1200);
    s().endStream(1100);
    expect(s().phase).toBe("idle");
    expect(s().responseHistory[0]).toMatchObject({
      content: "Hi there",
      total_ms: 1200,
      first_token_ms: 600,
      scope_label: "Last 5 min",
    });
    expect(s().currentId).toBe(s().responseHistory[0].id);
  });

  it("think-tag tokens read as thinking, not as first words", () => {
    s().startStream("Assist", "m", "p");
    s().appendToken("<think>hmm");
    expect(s()).toMatchObject({ phase: "thinking", firstTokenAt: null });
    vi.setSystemTime(T0 + 50);
    s().appendToken("</think>Answer");
    expect(s()).toMatchObject({ phase: "writing", firstTokenAt: T0 + 50 });
  });

  it("a start without a pending click times from the start event", () => {
    vi.setSystemTime(T0 + 5);
    s().startStream("Assist", "m", "p");
    expect(s().requestStartedAt).toBe(T0 + 5);
  });

  it("clearPending only clears its own request, and an error goes idle", () => {
    s().setPending("Assist", "r1");
    s().clearPending("other");
    expect(s().phase).toBe("sending");
    s().clearPending("r1");
    expect(s()).toMatchObject({ phase: "idle", requestStartedAt: null });

    s().setPending("Assist", "r2");
    s().setError("boom");
    expect(s()).toMatchObject({ phase: "idle", error: "boom" });
  });

  it("a click while streaming does not disturb the running stream", () => {
    s().startStream("Assist", "m", "p", { requestId: "r1" });
    s().setPending("Recap", "r2");
    expect(s()).toMatchObject({ phase: "waiting", currentMode: "Assist" });
  });

  it("keeps every answer (newest first) up to the cap", () => {
    for (let i = 0; i < RESPONSE_HISTORY_CAP + 5; i++) answer("Assist", `a${i}`);
    expect(RESPONSE_HISTORY_CAP).toBe(100);
    expect(s().responseHistory).toHaveLength(100);
    expect(s().responseHistory[0].content).toBe(`a${RESPONSE_HISTORY_CAP + 4}`);
  });

  it("a stream stopped before any words is not kept", () => {
    s().startStream("Assist", "m", "p");
    s().endStream(0);
    expect(s().responseHistory).toHaveLength(0);
    expect(s().currentId).toBeNull();
  });

  it("knows which request is running, from sending until it ends", () => {
    s().setPending("Assist", "req-1");
    expect(s().isRunning("req-1")).toBe(true);
    s().startStream("Assist", "m", "p", { requestId: "req-1" });
    expect([s().isRunning("req-1"), s().isRunning("req-2")]).toEqual([true, false]);
    s().endStream(10);
    expect(s().isRunning("req-1")).toBe(false);
  });

  it("an answer marked to discard is neither kept nor left on screen when it ends", () => {
    answer("Assist", "kept");
    s().startStream("Assist", "m", "p", { requestId: "early" });
    s().appendToken("Half an ans");
    s().discardRequest("early");
    s().endStream(0);
    expect(s().responseHistory.map((r) => r.content)).toEqual(["kept"]);
    expect([s().currentContent, s().currentId]).toEqual(["", null]);
    // Only that request: the next answer is kept as usual.
    answer("Assist", "next");
    expect(s().responseHistory[0].content).toBe("next");
  });

  it("pins any history item", () => {
    answer("Assist", "first");
    answer("Recap", "second");
    const older = s().responseHistory[1];
    s().pinResponse(older.id);
    expect(s().pinnedResponses.map((r) => r.id)).toEqual([older.id]);
    s().unpinResponse(older.id);
    expect(s().pinnedResponses).toHaveLength(0);
  });

  it("records user request times per mode and overall; meeting start resets everything", () => {
    s().recordUserRequest("FollowUp", T0 + 10);
    s().recordUserRequest("Recap", T0 + 20);
    expect(s().lastUserRequest).toEqual({ anyAt: T0 + 20, byMode: { FollowUp: T0 + 10, Recap: T0 + 20 } });

    answer("Assist", "x");
    s().pinResponse(s().responseHistory[0].id);
    s().resetForMeeting();
    expect(s()).toMatchObject({
      responseHistory: [],
      pinnedResponses: [],
      lastUserRequest: { anyAt: null, byMode: {} },
      phase: "idle",
      currentContent: "",
      currentId: null,
    });
  });
});
