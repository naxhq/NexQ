import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistSources } from "../lib/types";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ get: async () => undefined, set: async () => {}, onKeyChange: async () => () => {} }),
}));
const ipc = vi.hoisted(() => ({ getAssistSources: vi.fn() }));
vi.mock("../lib/ipc", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/ipc")>()), ...ipc }));

import { asksForSession, meetingKeyOf, pillsOf, requestToggles, useAssistSourcesStore } from "./assistSourcesStore";
import { useConfigStore } from "./configStore";
import { useMeetingStore } from "./meetingStore";
import { useSourcesStore } from "./sourcesStore";

const info = (over: Partial<AssistSources> = {}): AssistSources => ({
  workspace_id: "w1",
  documents: 2,
  notes: 0,
  folders: [{ label: "Vault", used: true }],
  servers: [{ label: "Mira", allowed_tools: 2, total_tools: 3, usable: true }],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  useAssistSourcesStore.setState({ info: {}, pills: {} });
  useSourcesStore.setState({ toggles: { library: true, tools: true } });
  useConfigStore.setState({ llmProvider: "claude_cli" });
  useMeetingStore.setState({ activeMeeting: { id: "m1" } as never });
});
afterEach(() => useMeetingStore.setState({ activeMeeting: null }));

describe("assistSourcesStore", () => {
  it("a meeting starts with both pills on, and each meeting keeps its own", () => {
    expect(pillsOf("m1")).toEqual({ library: true, tools: true });
    useAssistSourcesStore.getState().setPill("m1", "library", false);
    expect(pillsOf("m1")).toEqual({ library: false, tools: true });
    expect(pillsOf("m2")).toEqual({ library: true, tools: true });
    // two quick flips each see the other's result
    useAssistSourcesStore.getState().setPill("m1", "tools", false);
    expect(pillsOf("m1")).toEqual({ library: false, tools: false });
  });

  it("the default of a new meeting is what an older saved config said (notes is Knowledge)", () => {
    useSourcesStore.setState({ toggles: { library: false, tools: true } });
    expect(pillsOf("fresh")).toEqual({ library: false, tools: true });
  });

  it("the running meeting is the active one, else 'live'", () => {
    expect(meetingKeyOf()).toBe("m1");
    expect(meetingKeyOf("past-1")).toBe("past-1");
    useMeetingStore.setState({ activeMeeting: null });
    expect(meetingKeyOf()).toBe("live");
  });

  it("reads what the meeting's workspace holds, by meeting, and keeps what it had when a read fails", async () => {
    ipc.getAssistSources.mockResolvedValueOnce(info());
    await useAssistSourcesStore.getState().refresh("m1");
    expect(ipc.getAssistSources).toHaveBeenCalledWith("m1");
    expect(useAssistSourcesStore.getState().info.m1.documents).toBe(2);
    ipc.getAssistSources.mockRejectedValueOnce(new Error("busy"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await useAssistSourcesStore.getState().refresh("m1");
    expect(useAssistSourcesStore.getState().info.m1.documents).toBe(2);
    // no meeting at all: the running one is asked for by no id
    useMeetingStore.setState({ activeMeeting: null });
    ipc.getAssistSources.mockResolvedValueOnce(info({ documents: 7 }));
    await useAssistSourcesStore.getState().refresh();
    expect(ipc.getAssistSources).toHaveBeenLastCalledWith(null);
    expect(useAssistSourcesStore.getState().info.live.documents).toBe(7);
  });

  it("a request sends the meeting's pills; Tools only with a usable server on a subscription agent", () => {
    useAssistSourcesStore.setState({ info: { m1: info() } });
    expect(requestToggles()).toEqual({ library: true, tools: true });
    useAssistSourcesStore.setState({ info: { m1: info({ servers: [] }) } });
    expect(requestToggles()).toEqual({ library: true, tools: false });
    useAssistSourcesStore.setState({ info: { m1: info() } });
    useConfigStore.setState({ llmProvider: "openai" });
    expect(requestToggles()).toEqual({ library: true, tools: false });
    // Knowledge off is sent as off: it is a lock, whatever the workspace holds
    useAssistSourcesStore.getState().setPill("m1", "library", false);
    expect(requestToggles()).toEqual({ library: false, tools: false });
    // and the pills of another meeting are not these
    expect(requestToggles("m2").library).toBe(true);
  });

  it("answers wait for a with-sources session only when a folder or a server is behind a pill that is on", () => {
    useAssistSourcesStore.setState({ info: { m1: info() } });
    expect(asksForSession({ library: true, tools: false })).toBe(true);
    expect(asksForSession({ library: false, tools: false })).toBe(false);
    useAssistSourcesStore.setState({ info: { m1: info({ folders: [], servers: [] }) } });
    expect(asksForSession({ library: true, tools: true })).toBe(false);
    useAssistSourcesStore.setState({ info: { m1: info() } });
    useConfigStore.setState({ llmProvider: "openai" });
    expect(asksForSession({ library: true, tools: true })).toBe(false);
    expect(asksForSession(undefined)).toBe(false);
  });
});
