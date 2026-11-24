import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));

import { CallLogPanel } from "./CallLogPanel";
import { useCallLogStore } from "../stores/callLogStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useAgentStore } from "../stores/agentStore";
import { useConfigStore } from "../stores/configStore";
import { EMPTY_USAGE } from "../lib/agentUsage";
import type { AgentSessionStatus, CliAgentStatus } from "../lib/types";

const SESSION: AgentSessionStatus = {
  scope: "live",
  meeting_id: "m1",
  tier: "fast",
  state: "ready",
  model: "gpt-6-sol",
  detail: null,
  error_kind: null,
  with_sources: false,
  sources_notice: null,
  usage: { ...EMPTY_USAGE, requests: 2, input_tokens: 10, output_tokens: 5, cost_usd: 0.5 },
};

const API_BILLED_CLAUDE: CliAgentStatus = {
  kind: "claude_cli",
  installed: true,
  binary_path: "claude.exe",
  version: "2.1.0",
  auth: { logged_in: true, auth_method: "api_key", subscription_type: null, email: null, login: "api_billed" },
  npm_only: false, required_version: null,
};

describe("CallLogPanel agent usage line", () => {
  beforeEach(() => {
    useCallLogStore.setState({ isOpen: true });
    useMeetingStore.setState({ activeMeeting: { id: "m1" } as never });
    useAgentStore.setState({ sessions: { k: SESSION }, statuses: { claude_cli: API_BILLED_CLAUDE } });
  });
  afterEach(() => cleanup());

  it("names the active CLI agent", () => {
    useConfigStore.setState({ llmProvider: "codex_cli" });
    render(<CallLogPanel />);
    const line = screen.getByTestId("claude-usage");
    expect(line).toHaveTextContent("Codex");
    expect(line).toHaveTextContent("included in your subscription");
  });

  it("stays neutral and makes no billing claim once an API provider is active", () => {
    useConfigStore.setState({ llmProvider: "openai" });
    render(<CallLogPanel />);
    const line = screen.getByTestId("claude-usage");
    expect(line).toHaveTextContent("Subscription AI");
    expect(line).not.toHaveTextContent("Claude");
    expect(line).not.toHaveTextContent("billed to your API account");
    expect(line).not.toHaveTextContent("included in your subscription");
    expect(line).toHaveTextContent("≈ $0.50 estimate");
  });
});
