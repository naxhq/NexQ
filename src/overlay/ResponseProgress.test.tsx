import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionStatus } from "../lib/types";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));

import { ResponseProgress } from "./ResponseProgress";
import { useStreamStore } from "../stores/streamStore";
import { agentSessionKey, useAgentStore } from "../stores/agentStore";
import { EMPTY_USAGE } from "../lib/agentUsage";

const sourcesSession = (state: AgentSessionStatus["state"]): AgentSessionStatus => ({
  scope: "live",
  meeting_id: "m1",
  tier: "fast",
  state,
  model: "haiku",
  detail: null,
  error_kind: null,
  with_sources: true,
  sources_notice: null,
  usage: EMPTY_USAGE,
});

function setSession(s: AgentSessionStatus) {
  useAgentStore.setState({ sessions: { [agentSessionKey(s)]: s } });
}

afterEach(() => {
  cleanup();
  useStreamStore.getState().resetForMeeting();
  useAgentStore.setState({ sessions: {} });
});

describe("ResponseProgress and your sources", () => {
  it("says Loading your sources while a pill-on answer waits for a starting session", () => {
    setSession(sourcesSession("starting"));
    useStreamStore.getState().setPending("Assist", "r1", { notes: true, tools: false });
    render(<ResponseProgress />);
    expect(screen.getByText("Loading your sources")).toBeInTheDocument();
  });

  it("says it for a Deep answer (Recap) waiting on its sources session too", () => {
    setSession({ ...sourcesSession("starting"), tier: "deep" });
    useStreamStore.getState().setPending("Recap", "r2", { notes: false, tools: true });
    render(<ResponseProgress />);
    expect(screen.getByText("Loading your sources")).toBeInTheDocument();
  });

  it("says Sending when the answer asked for no sources", () => {
    setSession(sourcesSession("starting"));
    useStreamStore.getState().setPending("Assist", "r1", { notes: false, tools: false });
    render(<ResponseProgress />);
    expect(screen.queryByText("Loading your sources")).toBeNull();
    expect(screen.getByText("Sending…")).toBeInTheDocument();
  });

  it("goes back to the normal wording once the session is ready", () => {
    setSession(sourcesSession("ready"));
    useStreamStore.getState().setPending("Assist", "r1", { notes: true, tools: true });
    render(<ResponseProgress />);
    expect(screen.queryByText("Loading your sources")).toBeNull();
  });
});
