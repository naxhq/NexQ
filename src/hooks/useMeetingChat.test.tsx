import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));

const ipc = vi.hoisted(() => ({
  askMeeting: vi.fn(),
  cancelGeneration: vi.fn(),
  getAgentSessions: vi.fn(),
  listMeetingChat: vi.fn(),
}));
vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  ...ipc,
}));

const noListener = vi.hoisted(() => () => Promise.resolve(() => {}));
vi.mock("../lib/events", () => ({
  onAgentSessionStatus: noListener,
  onStreamStart: noListener,
  onStreamToken: noListener,
  onStreamEnd: noListener,
  onStreamError: noListener,
  onStreamActivity: noListener,
}));

import { useMeetingChat } from "./useMeetingChat";
import { useConfigStore } from "../stores/configStore";
import { DEFAULT_SOURCES_CONFIG, useSourcesStore } from "../stores/sourcesStore";
import { useAssistSourcesStore } from "../stores/assistSourcesStore";

const providerBefore = useConfigStore.getState().llmProvider;

beforeEach(() => {
  vi.clearAllMocks();
  ipc.listMeetingChat.mockResolvedValue([]);
  ipc.getAgentSessions.mockResolvedValue([]);
  ipc.askMeeting.mockResolvedValue(undefined);
  useConfigStore.setState({ llmProvider: "claude_cli" });
  useSourcesStore.setState({
    config: {
      ...DEFAULT_SOURCES_CONFIG,
      notes_folders: [{ id: "f1", label: "Vault", path: "D:\\Vault", enabled: true }],
    },
    toggles: { library: true, tools: true },
  });
  // What this past meeting's workspace holds: a folder, and no tool server.
  useAssistSourcesStore.setState({
    pills: {},
    info: { m1: { workspace_id: "w1", documents: 0, notes: 0, folders: [{ label: "Vault", used: true }], servers: [] } },
  });
});

afterEach(() => {
  useConfigStore.setState({ llmProvider: providerBefore });
  useSourcesStore.setState({ config: DEFAULT_SOURCES_CONFIG, toggles: { library: false, tools: false } });
});

describe("useMeetingChat and personal sources", () => {
  it("past-meeting chat sends the pills with ask_meeting", async () => {
    const { result } = renderHook(() => useMeetingChat("m1"));
    await act(async () => {
      await result.current.ask("Who is Dana?");
    });
    expect(ipc.askMeeting).toHaveBeenCalledTimes(1);
    const [meetingId, question, , sources] = ipc.askMeeting.mock.calls[0];
    expect([meetingId, question]).toEqual(["m1", "Who is Dana?"]);
    // Tools has no usable server behind it, so it goes as off.
    expect(sources).toEqual({ library: true, tools: false });
  });

  it("sends Knowledge to every provider, and Tools to none but a subscription agent", async () => {
    useConfigStore.setState({ llmProvider: "openai" });
    const { result } = renderHook(() => useMeetingChat("m1"));
    await act(async () => {
      await result.current.ask("Who is Dana?");
    });
    expect(ipc.askMeeting.mock.calls[0][3]).toEqual({ library: true, tools: false });
  });
});
