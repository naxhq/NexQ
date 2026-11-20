import { beforeEach, describe, expect, it, vi } from "vitest";

const generateAssist = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}));
vi.mock("./ipc", () => ({ generateAssist: (...args: unknown[]) => generateAssist(...args) }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ get: async () => undefined, set: async () => {}, onKeyChange: async () => () => {} }),
}));

import { runUserAction } from "./userAction";
import { useConfigStore } from "../stores/configStore";
import { useStreamStore } from "../stores/streamStore";

const T0 = 1_700_000_000_000;

describe("runUserAction", () => {
  beforeEach(() => {
    generateAssist.mockReset();
    generateAssist.mockResolvedValue(undefined);
    useStreamStore.getState().resetForMeeting();
    useConfigStore.setState({ contextScope: { kind: "default", minutes: 5 }, contextScopeSticky: true });
    vi.spyOn(Date, "now").mockReturnValue(T0);
  });

  it("default scope sends no scope and shows Sending… at once", async () => {
    const p = runUserAction("FollowUp");
    expect(useStreamStore.getState().phase).toBe("sending");
    await p;
    const [mode, question, opts] = generateAssist.mock.calls[0] as [string, unknown, { scope: unknown; requestId: string }];
    expect([mode, question, opts.scope]).toEqual(["FollowUp", undefined, null]);
    expect(useStreamStore.getState().pendingRequestId).toBe(opts.requestId);
  });

  it("resolves since-last-same from this meeting's previous request of that action", async () => {
    useConfigStore.setState({ contextScope: { kind: "since_last_same", minutes: 5 } });
    await runUserAction("FollowUp");
    expect((generateAssist.mock.calls[0][2] as { scope: unknown }).scope).toEqual({
      kind: "all",
      since_ms: null,
      label: "Whole meeting (first F/U)",
    });

    useStreamStore.getState().recordUserRequest("FollowUp", T0 - 90_000);
    await runUserAction("FollowUp", "custom?");
    expect(generateAssist.mock.calls[1][1]).toBe("custom?");
    expect((generateAssist.mock.calls[1][2] as { scope: unknown }).scope).toEqual({
      kind: "since_last_same",
      since_ms: T0 - 90_000,
      label: "Since last F/U",
    });
  });

  it("a sticky scope stays; a non-sticky one reverts to the default after one action", async () => {
    // generate_assist resolves once its stream ended (no events in this test).
    const finished = () => useStreamStore.setState({ phase: "idle", pendingRequestId: null });
    useConfigStore.setState({ contextScope: { kind: "minutes", minutes: 10 }, contextScopeSticky: true });
    await runUserAction("Recap");
    finished();
    expect(useConfigStore.getState().contextScope).toEqual({ kind: "minutes", minutes: 10 });

    useConfigStore.setState({ contextScopeSticky: false });
    await runUserAction("Recap");
    finished();
    expect((generateAssist.mock.calls[1][2] as { scope: { label: string } }).scope.label).toBe("Last 10 min");
    expect(useConfigStore.getState().contextScope).toEqual({ kind: "default", minutes: 10 });
    await runUserAction("Recap");
    expect((generateAssist.mock.calls[2][2] as { scope: unknown }).scope).toBeNull();
  });

  it("a second press while the first is still sending keeps the first's progress and scope", async () => {
    useConfigStore.setState({ contextScope: { kind: "minutes", minutes: 5 }, contextScopeSticky: false });
    useStreamStore.setState({ phase: "sending", pendingRequestId: "first", isStreaming: false });
    generateAssist.mockRejectedValueOnce(new Error("Generation already in progress"));
    await expect(runUserAction("Assist")).rejects.toThrow("already in progress");
    expect(useStreamStore.getState().pendingRequestId).toBe("first");
    expect(useStreamStore.getState().phase).toBe("sending");
    expect(useConfigStore.getState().contextScope).toEqual({ kind: "minutes", minutes: 5 });
    useStreamStore.setState({ phase: "idle", pendingRequestId: null });
  });

  it("a request that fails after its stream started ends that stream with the error", async () => {
    generateAssist.mockImplementationOnce(async (...args: unknown[]) => {
      const { requestId } = args[2] as { requestId: string };
      useStreamStore.getState().startStream("AskQuestion", "m", "p", { requestId });
      throw "Images work only with Claude (subscription).";
    });
    await expect(runUserAction("AskQuestion", "q")).rejects.toBe("Images work only with Claude (subscription).");
    expect(useStreamStore.getState().isStreaming).toBe(false);
    expect(useStreamStore.getState().error).toBe("Images work only with Claude (subscription).");
  });

  it("a failure doesn't touch another request's running stream", async () => {
    useStreamStore.getState().startStream("Assist", "m", "p", { requestId: "other" });
    generateAssist.mockRejectedValueOnce(new Error("Generation already in progress"));
    await expect(runUserAction("Recap")).rejects.toThrow("already in progress");
    expect(useStreamStore.getState().isStreaming).toBe(true);
    expect(useStreamStore.getState().error).toBeNull();
  });

  it("a failed request clears its Sending… state", async () => {
    generateAssist.mockRejectedValueOnce(new Error("Generation already in progress"));
    await expect(runUserAction("Assist")).rejects.toThrow("already in progress");
    expect(useStreamStore.getState().phase).toBe("idle");
  });
  it("sends the pills that were on and keeps them for the progress line", async () => {
    await runUserAction("Assist", "q", { sources: { notes: true, tools: false } });
    expect((generateAssist.mock.calls[0][2] as { sources: unknown }).sources).toEqual({ notes: true, tools: false });
    expect(useStreamStore.getState().requestSources).toEqual({ notes: true, tools: false });
  });

  it("sends no sources key for an automatic answer", async () => {
    await runUserAction("Assist", "q", { requestId: "auto" });
    expect(generateAssist.mock.calls[0][2]).not.toHaveProperty("sources");
    expect(useStreamStore.getState().requestSources).toBeNull();
  });
});
