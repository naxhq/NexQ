import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (payload: unknown) => void;
const { handlers, register } = vi.hoisted(() => {
  const handlers: Record<string, Handler> = {};
  const register = (name: string) => (handler: Handler) => {
    handlers[name] = handler;
    return Promise.resolve(() => {
      delete handlers[name];
    });
  };
  return { handlers, register };
});

vi.mock("../lib/events", () => ({
  onStreamStart: register("start"),
  onStreamToken: register("token"),
  onStreamEnd: register("end"),
  onStreamSources: register("sources"),
  onStreamActivity: register("activity"),
  onStreamError: register("error"),
  onStreamThinking: register("thinking"),
}));

import { useStreamBuffer } from "./useStreamBuffer";
import { useStreamStore } from "../stores/streamStore";

const start = (mode: string, request_id: string) =>
  handlers.start({ mode, model: "m", provider: "p", request_id });

describe("useStreamBuffer", () => {
  beforeEach(() => {
    useStreamStore.setState({
      isStreaming: false,
      currentContent: "",
      _rawContent: "",
      currentMode: null,
      error: null,
      responseHistory: [],
    });
  });

  it("shows only the stream whose start it accepted", async () => {
    renderHook(() => useStreamBuffer());
    await waitFor(() => expect(handlers.end).toBeDefined());

    act(() => {
      start("Assist", "live");
      handlers.token({ token: "Hello", request_id: "live" });
      handlers.token({ token: " leaked", request_id: "someone-else" });
      handlers.end({ total_tokens: 1, latency_ms: 5, request_id: "live" });
    });

    const state = useStreamStore.getState();
    expect(state.isStreaming).toBe(false);
    expect(state.responseHistory[0]?.content).toBe("Hello");
  });

  it("shows thinking until the first words of its own stream", async () => {
    useStreamStore.getState().resetForMeeting();
    renderHook(() => useStreamBuffer());
    await waitFor(() => expect(handlers.thinking).toBeDefined());

    act(() => {
      start("Assist", "live");
      handlers.thinking({ request_id: "someone-else" });
    });
    expect(useStreamStore.getState().phase).toBe("waiting");

    act(() => handlers.thinking({ request_id: "live" }));
    expect(useStreamStore.getState().phase).toBe("thinking");
  });

  it("carries the start details into the store and records the click time per mode", async () => {
    useStreamStore.getState().resetForMeeting();
    renderHook(() => useStreamBuffer());
    await waitFor(() => expect(handlers.end).toBeDefined());

    act(() => {
      useStreamStore.getState().setPending("FollowUp", "r1");
    });
    const clickedAt = useStreamStore.getState().requestStartedAt;
    act(() => {
      handlers.start({
        mode: "FollowUp",
        model: "haiku",
        provider: "Claude CLI",
        request_id: "r1",
        scope_label: "Last 5 min",
        transcript_segments_count: 0,
        session_key: "live:m:fast",
      });
    });

    const state = useStreamStore.getState();
    expect(state.phase).toBe("waiting");
    expect(state.streamMeta).toMatchObject({ scopeLabel: "Last 5 min", newLines: 0, sessionKey: "live:m:fast" });
    expect(state.lastUserRequest.byMode.FollowUp).toBe(clickedAt);
    expect(state.lastUserRequest.anyAt).toBe(clickedAt);
  });

  it("ignores past-meeting generations and their errors", async () => {
    renderHook(() => useStreamBuffer());
    await waitFor(() => expect(handlers.end).toBeDefined());

    act(() => {
      start("MeetingSummary", "past");
      handlers.token({ token: "summary", request_id: "past" });
      handlers.error({ message: "boom", request_id: "past" });
    });

    const state = useStreamStore.getState();
    expect(state.isStreaming).toBe(false);
    expect(state.currentContent).toBe("");
    expect(state.error).toBeNull();
    expect(state.lastUserRequest.byMode.MeetingSummary).toBeUndefined();
  });
});
