import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({ load: async () => ({ get: async () => undefined, set: async () => {} }) }));

import { ContextMeter } from "./ContextMeter";
import { resetWorkspaceChatForTests, useWorkspaceChatStore } from "../stores/workspaceChatStore";
import type { ContextReport } from "../lib/types";
import { mockBackend, seedWorkspaces, ws } from "./testUtils";

const report = (used: number): ContextReport => ({
  strategy: "ladder",
  depth: "balanced",
  budget: 60000,
  window: 200000,
  used,
  bars: [{ id: "meeting:m1", layer: "meetings", title: "Kickoff", tokens: used - 100, relevance: 0.5, pinned: false, included: true }],
  omitted: 0,
  notices: [],
  estimate: true,
  layers: [{ layer: "folders", available: 1_200_000, sources: 638, searched: true }],
  depth_budgets: { lean: 16000, balanced: 60000, deep: 120000 },
});
const chat = { id: "c1", workspace_id: "acme", title: "t", provider: null, model: null, effort: null, depth: "balanced", include_meetings: true, condensed_upto: null, created_at: 1, updated_at: 1 };

beforeEach(() => {
  localStorage.clear();
  resetWorkspaceChatForTests();
  seedWorkspaces([ws({ id: "acme", name: "Acme", is_default: false })], "acme");
});
afterEach(() => cleanup());

describe("one number for the context", () => {
  it("the rail draws the same report as the box over the composer, with the question being typed", async () => {
    mockBackend({ list_workspace_chats: [chat], preview_chat_context: report(1800) });
    render(<ContextMeter workspaceId="acme" />);
    expect(await screen.findByText(/Using 1.8k of 60k tokens/)).toBeInTheDocument();
    // the person types a question: the open chat's estimate (what the composer shows) now holds the found passages
    act(() => {
      useWorkspaceChatStore.setState({ activeChat: { acme: "c1" }, sessions: { c1: { ...useWorkspaceChatStore.getState().sessions.c1, preview: report(5400) } as never } });
    });
    expect(await screen.findByText(/Using 5.4k of 60k tokens/)).toBeInTheDocument();
    expect(screen.getByText(/searched when you ask · 1.2M indexed/)).toBeInTheDocument();
  });
});
