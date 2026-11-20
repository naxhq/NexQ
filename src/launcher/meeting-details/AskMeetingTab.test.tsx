import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MeetingChatMessage } from "../../lib/types";

// ── Tauri event bus stub ────────────────────────────────────────────────────
type Handler = (e: { payload: unknown }) => void;
const listeners = vi.hoisted(() => new Map<string, Set<(e: { payload: unknown }) => void>>());

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: Handler) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name)!.add(cb);
    return () => listeners.get(name)!.delete(cb);
  },
}));

function emit(name: string, payload: unknown) {
  listeners.get(name)?.forEach((cb) => cb({ payload }));
}

// ── IPC stub ────────────────────────────────────────────────────────────────
const ipc = vi.hoisted(() => ({
  listMeetingChat: vi.fn(),
  askMeeting: vi.fn(),
  cancelGeneration: vi.fn(),
  getAgentSessions: vi.fn(),
}));

vi.mock("../../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/ipc")>()),
  listMeetingChat: (...args: unknown[]) => ipc.listMeetingChat(...args),
  askMeeting: (...args: unknown[]) => ipc.askMeeting(...args),
  cancelGeneration: () => ipc.cancelGeneration(),
  getAgentSessions: () => ipc.getAgentSessions(),
}));

import { AskMeetingTab } from "./AskMeetingTab";
import { useMeetingChat } from "../../hooks/useMeetingChat";

function Harness({ trackSession = false }: { trackSession?: boolean }) {
  const chat = useMeetingChat("m1", { trackSession });
  return <AskMeetingTab chat={chat} />;
}

const saved: MeetingChatMessage[] = [
  {
    id: "q1",
    meeting_id: "m1",
    role: "user",
    content: "When do we ship?",
    model: null,
    input_tokens: null,
    output_tokens: null,
    created_at: 1_000,
  },
  {
    id: "a1",
    meeting_id: "m1",
    role: "assistant",
    content: "On Friday, as Dana said.",
    model: "sonnet",
    input_tokens: 900,
    output_tokens: 12,
    created_at: 2_000,
  },
];

describe("AskMeetingTab", () => {
  beforeEach(() => {
    listeners.clear();
    ipc.listMeetingChat.mockReset().mockResolvedValue(saved);
    ipc.askMeeting.mockReset();
    ipc.cancelGeneration.mockReset().mockResolvedValue(undefined);
    ipc.getAgentSessions.mockReset().mockResolvedValue([]);
  });

  it("renders the saved history of the meeting", async () => {
    render(<Harness />);
    expect(await screen.findByText("When do we ship?")).toBeInTheDocument();
    expect(screen.getByText("On Friday, as Dana said.")).toBeInTheDocument();
    expect(ipc.listMeetingChat).toHaveBeenCalledWith("m1");
  });

  it("appends a pending question, then streams only its own tokens", async () => {
    let requestId = "";
    let tokenListenersAtAsk = 0;
    let resolveAsk: () => void = () => {};
    ipc.askMeeting.mockImplementation((_meetingId: string, _question: string, id: string) => {
      requestId = id;
      tokenListenersAtAsk = listeners.get("llm_stream_token")?.size ?? 0;
      return new Promise<void>((resolve) => {
        resolveAsk = resolve;
      });
    });

    render(<Harness />);
    await screen.findByText("When do we ship?");

    const input = screen.getByRole("textbox", { name: /ask about this meeting/i });
    fireEvent.change(input, { target: { value: "Who owns the launch?" } });
    fireEvent.click(screen.getByRole("button", { name: /send question/i }));

    const question = await screen.findByText("Who owns the launch?");
    expect(question.closest("[data-status]")).toHaveAttribute("data-status", "pending");
    await waitFor(() => expect(ipc.askMeeting).toHaveBeenCalledTimes(1));
    expect(ipc.askMeeting).toHaveBeenCalledWith("m1", "Who owns the launch?", requestId);
    expect(tokenListenersAtAsk).toBeGreaterThan(0); // subscribed before invoking
    expect(input).toHaveValue("");

    act(() => {
      emit("llm_stream_token", { token: "LEAKED", request_id: "someone-else" });
      emit("llm_stream_token", { token: "Dana ", request_id: requestId });
      emit("llm_stream_token", { token: "owns it.", request_id: requestId });
    });
    expect(await screen.findByText("Dana owns it.")).toBeInTheDocument();
    expect(screen.queryByText(/LEAKED/)).not.toBeInTheDocument();
    // While answering, Stop replaces Send.
    expect(screen.getByRole("button", { name: /stop/i })).toBeInTheDocument();

    act(() => {
      emit("llm_stream_end", { total_tokens: 20, latency_ms: 5, request_id: requestId, cancelled: false });
    });
    await act(async () => resolveAsk());
    expect(question.closest("[data-status]")).toHaveAttribute("data-status", "done");
    expect(screen.getByRole("button", { name: /send question/i })).toBeInTheDocument();
  });

  it("Stop cancels the running answer", async () => {
    ipc.askMeeting.mockImplementation(() => new Promise<void>(() => {}));
    render(<Harness />);
    await screen.findByText("When do we ship?");
    fireEvent.change(screen.getByRole("textbox", { name: /ask about this meeting/i }), {
      target: { value: "Anything else?" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send question/i }));
    fireEvent.click(await screen.findByRole("button", { name: /stop/i }));
    expect(ipc.cancelGeneration).toHaveBeenCalledTimes(1);
  });

  it("shows this meeting's Claude session status", async () => {
    render(<Harness trackSession />);
    await screen.findByText("When do we ship?");
    const status = (state: string, meetingId = "m1") => ({
      scope: "past",
      meeting_id: meetingId,
      tier: "deep",
      state,
      model: "sonnet",
      detail: null,
      error_kind: null,
      with_sources: false,
      sources_notice: null,
      usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0 },
    });
    act(() => emit("agent_session_status", status("starting")));
    expect(await screen.findByText("Session starting…")).toBeInTheDocument();
    act(() => emit("agent_session_status", status("ready", "another-meeting")));
    expect(screen.getByText("Session starting…")).toBeInTheDocument();
    act(() => emit("agent_session_status", status("ready")));
    expect(await screen.findByText("Ready")).toBeInTheDocument();
  });
});
