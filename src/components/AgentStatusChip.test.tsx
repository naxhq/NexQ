import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionStatus, Meeting } from "../lib/types";

vi.mock("@tauri-apps/api/event", () => ({
  listen: async () => () => {},
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));

const ipc = vi.hoisted(() => ({
  cliAgentStatus: vi.fn(),
  getAgentSessions: vi.fn(),
}));
vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  cliAgentStatus: (kind: string) => ipc.cliAgentStatus(kind),
  getAgentSessions: () => ipc.getAgentSessions(),
}));

import { AgentStatusChip } from "./AgentStatusChip";
import { EMPTY_USAGE, isRateLimited, scopeUsage } from "../lib/agentUsage";
import { agentSessionKey, resetAgentStoreForTests, useAgentStore } from "../stores/agentStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useConfigStore } from "../stores/configStore";

function session(over: Partial<AgentSessionStatus> = {}): AgentSessionStatus {
  return {
    scope: "live",
    meeting_id: "m1",
    tier: "fast",
    state: "ready",
    model: "haiku",
    detail: null,
    error_kind: null,
    with_sources: false,
    sources_notice: null,
    usage: { ...EMPTY_USAGE, input_tokens: 12345, output_tokens: 678, cost_usd: 0.1234 },
    ...over,
  };
}

function setSessions(...list: AgentSessionStatus[]) {
  useAgentStore.setState({ sessions: Object.fromEntries(list.map((s) => [agentSessionKey(s), s])) });
}

/** Focus the chip (as a keyboard user would) and return its hover card's text. */
function cardText(): string {
  const chip = screen.getByTestId("agent-status-chip");
  if (!screen.queryByTestId("agent-hover-card")) fireEvent.focus(chip);
  return screen.getByTestId("agent-hover-card").textContent ?? "";
}

beforeEach(() => {
  resetAgentStoreForTests();
  ipc.getAgentSessions.mockResolvedValue([]);
  ipc.cliAgentStatus.mockResolvedValue({
    installed: true,
    binary_path: "claude",
    version: "2.1.0",
    auth: { logged_in: true, auth_method: "claude.ai", subscription_type: "max", email: "a@b.c", login: "subscription" },
    npm_only: false, required_version: null,
  });
  useMeetingStore.setState({ activeMeeting: { id: "m1" } as Meeting });
});

afterEach(() => {
  cleanup();
  useMeetingStore.setState({ activeMeeting: null });
});

describe("AgentStatusChip", () => {
  it("shows a ready dot and 'Session ready' for the live session", async () => {
    render(<AgentStatusChip />);
    await act(async () => setSessions(session()));
    expect(screen.getByTestId("agent-status-dot")).toHaveAttribute("data-state", "ready");
    expect(screen.getByText("Session ready")).toBeInTheDocument();
  });

  it("shows amber 'Thinking…' while a turn is running", async () => {
    render(<AgentStatusChip />);
    await act(async () => setSessions(session({ state: "busy" })));
    expect(screen.getByTestId("agent-status-dot")).toHaveAttribute("data-state", "busy");
    expect(screen.getByText("Thinking…")).toBeInTheDocument();
  });

  it("marks the error state", async () => {
    render(<AgentStatusChip />);
    await act(async () => setSessions(session({ state: "error", detail: "process crashed" })));
    expect(screen.getByTestId("agent-status-dot")).toHaveAttribute("data-state", "error");
    expect(cardText()).toContain("process crashed");
  });

  it("turns amber, not red, when the backend classifies a rate limit", async () => {
    render(<AgentStatusChip />);
    await act(async () =>
      setSessions(session({ state: "error", detail: "5-hour limit reached ∙ resets 3pm", error_kind: "rate_limited" })),
    );
    expect(screen.getByTestId("agent-status-dot")).toHaveAttribute("data-state", "limited");
  });

  it("trusts error_kind over the text", async () => {
    render(<AgentStatusChip />);
    await act(async () =>
      setSessions(session({ state: "error", detail: "rate limit in the logs, but the process died", error_kind: "crashed" })),
    );
    expect(screen.getByTestId("agent-status-dot")).toHaveAttribute("data-state", "error");
  });

  it("lists model, effort and thousands-separated tokens in the hover card", async () => {
    render(<AgentStatusChip />);
    await act(async () => setSessions(session()));
    const tip = cardText();
    expect(tip).toContain("in 12,345 · out 678");
    expect(tip).toContain("≈ $0.12 estimate — included in your subscription");
    expect(tip).toContain("Haiku · Low · thinking off");
  });

  it("hover card shows login, thinking per tier, requests, last request and averages", async () => {
    const now = Date.now();
    useConfigStore.setState({
      cliAgentConfigs: {
        ...useConfigStore.getState().cliAgentConfigs,
        claude_cli: { ...useConfigStore.getState().cliAgentConfigs.claude_cli, fast_thinking: false, deep_thinking: true },
      },
    });
    render(<AgentStatusChip onClick={() => {}} />);
    await act(async () => {});
    await act(async () =>
      setSessions(
        session({
          state: "busy",
          usage: {
            input_tokens: 210,
            cache_read_tokens: 38000,
            cache_write_tokens: 7000,
            output_tokens: 1240,
            thinking_tokens: 300,
            cost_usd: 0.31,
            requests: 4,
            total_latency_ms: 5600,
            total_first_token_ms: 2400,
            last_latency_ms: 1200,
            last_request_at_ms: now - 2 * 60_000 - 5_000,
          },
        }),
      ),
    );
    const chip = screen.getByTestId("agent-status-chip");
    expect(chip).toHaveAttribute("tabindex", "0");
    expect(chip).not.toHaveAttribute("title");
    fireEvent.mouseEnter(chip.parentElement!);
    const card = screen.getByRole("tooltip");
    expect(chip).toHaveAttribute("aria-describedby", card.id);
    const text = card.textContent ?? "";
    expect(text).toContain("Claude (subscription)");
    expect(text).toContain("Signed in · Max plan");
    expect(text).toContain("Haiku · Low · thinking off · answering");
    expect(text).toContain("thinking on");
    expect(text).toMatch(/Requests this meeting\s*4/);
    expect(text).toContain("2 min ago · 1.2 s");
    expect(text).toContain("1.4 s · first words 600 ms");
    expect(text).toContain("in 45,210 (38,000 cached) · out 1,240 (thinking 300)");
    expect(text).toContain("≈ $0.31 estimate — included in your subscription");

    // Escape hides it; leaving and coming back shows it again.
    fireEvent.keyDown(chip, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.mouseLeave(chip.parentElement!);
    fireEvent.mouseEnter(chip.parentElement!);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
  });

  it("hides the hover card while the picker is open and opens the picker from the keyboard", async () => {
    const onClick = vi.fn();
    const { rerender } = render(<AgentStatusChip onClick={onClick} />);
    const chip = screen.getByTestId("agent-status-chip");
    fireEvent.keyDown(chip, { key: "Enter" });
    expect(onClick).toHaveBeenCalledTimes(1);
    fireEvent.focus(chip);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    rerender(<AgentStatusChip onClick={onClick} pickerOpen />);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("outside a meeting shows the provider status", async () => {
    useMeetingStore.setState({ activeMeeting: null });
    render(<AgentStatusChip />);
    await act(async () => {});
    expect(screen.getByTestId("agent-status-dot")).toHaveAttribute("data-state", "ready");
    expect(screen.getByText("Ready")).toBeInTheDocument();
  });

  it("is amber with the API note outside a meeting when the login bills an API account", async () => {
    useMeetingStore.setState({ activeMeeting: null });
    ipc.cliAgentStatus.mockResolvedValue({
      installed: true,
      binary_path: "claude",
      version: "2.1.0",
      auth: { logged_in: true, auth_method: "api_key", subscription_type: null, email: null, login: "api_billed" },
      npm_only: false, required_version: null,
    });
    render(<AgentStatusChip />);
    await act(async () => {});
    expect(screen.getByTestId("agent-status-dot")).toHaveAttribute("data-state", "attention");
    expect(screen.getByText("API account")).toBeInTheDocument();
    expect(cardText()).toContain(
      "This Claude login bills an API account, not your subscription.",
    );
  });

  it("never shows a ready session green on an API-billed login", async () => {
    ipc.cliAgentStatus.mockResolvedValue({
      installed: true,
      binary_path: "claude",
      version: "2.1.0",
      auth: { logged_in: true, auth_method: "claude.ai", subscription_type: null, email: null, login: "api_billed" },
      npm_only: false, required_version: null,
    });
    render(<AgentStatusChip />);
    await act(async () => {});
    await act(async () => setSessions(session()));
    expect(screen.getByTestId("agent-status-dot")).toHaveAttribute("data-state", "attention");
    const tip = cardText();
    expect(tip).toContain("This Claude login bills an API account, not your subscription.");
    expect(tip).toContain("billed to your API account");
    expect(tip).not.toContain("included in your subscription");
  });

  it("says 'Needs update' for a Claude Code that is too old, even with a failed session", async () => {
    ipc.cliAgentStatus.mockResolvedValue({
      installed: true,
      binary_path: "C:\\claude.exe",
      version: "2.1.206 (Claude Code)",
      auth: { logged_in: true, auth_method: "claude.ai", subscription_type: "max", email: "a@b.c", login: "subscription" },
      npm_only: false,
      required_version: "2.1.259",
    });
    render(<AgentStatusChip />);
    await act(async () => {});
    await act(async () =>
      setSessions(
        session({
          state: "error",
          detail: "could not start the CLI agent: Claude Code 2.1.206 is too old for NexQ. Update it to 2.1.259 or newer.",
          error_kind: "outdated",
        }),
      ),
    );
    expect(screen.getByTestId("agent-status-dot")).toHaveAttribute("data-state", "attention");
    expect(screen.getByText("Needs update")).toBeInTheDocument();
    const tip = cardText();
    expect(tip).toContain("Claude Code 2.1.206 is too old.");
    expect(tip).toContain("NexQ needs Claude Code 2.1.259 or newer. Update it, then check the connection.");
  });

  it("names an npm-only install outside a meeting", async () => {
    useMeetingStore.setState({ activeMeeting: null });
    ipc.cliAgentStatus.mockResolvedValue({ installed: false, binary_path: null, version: null, auth: null, npm_only: true, required_version: null });
    render(<AgentStatusChip />);
    await act(async () => {});
    expect(screen.getByTestId("agent-status-dot")).toHaveAttribute("data-state", "attention");
    expect(cardText()).toContain("NexQ needs the native installer");
  });

  it("ignores sessions of other meetings and scopes", async () => {
    render(<AgentStatusChip />);
    await act(async () =>
      setSessions(
        session({ meeting_id: "other", state: "busy" }),
        session({ scope: "past", state: "error", detail: "boom", error_kind: "crashed" }),
        session({ scope: "utility", meeting_id: null, state: "busy" }),
        session({ tier: "deep" }),
      ),
    );
    expect(screen.getByTestId("agent-status-dot")).toHaveAttribute("data-state", "ready");
    expect(screen.getByText("Session ready")).toBeInTheDocument();
  });

  it("lets an error outrank busy across tiers, and a fault outrank a limit", async () => {
    render(<AgentStatusChip />);
    await act(async () =>
      setSessions(
        session({ tier: "fast", state: "busy" }),
        session({ tier: "deep", state: "error", detail: "x", error_kind: "other" }),
      ),
    );
    expect(screen.getByTestId("agent-status-dot")).toHaveAttribute("data-state", "error");

    await act(async () =>
      setSessions(
        session({ tier: "fast", state: "error", detail: "limit", error_kind: "rate_limited" }),
        session({ tier: "deep", state: "error", detail: "x", error_kind: "crashed" }),
      ),
    );
    expect(screen.getByTestId("agent-status-dot")).toHaveAttribute("data-state", "error");

    await act(async () =>
      setSessions(session({ tier: "fast", state: "busy" }), session({ tier: "deep", state: "starting" })),
    );
    expect(screen.getByTestId("agent-status-dot")).toHaveAttribute("data-state", "busy");
  });
});

describe("isRateLimited", () => {
  it("uses error_kind when present", () => {
    expect(isRateLimited({ error_kind: "rate_limited", detail: "anything" })).toBe(true);
    expect(isRateLimited({ error_kind: "other", detail: "usage limit reached" })).toBe(false);
  });

  it.each([
    "You hit the Rate Limit",
    "5-hour usage limit reached",
    "5-hour limit reached ∙ resets 3pm",
    "429 Too Many Requests",
    "too many tokens per minute",
  ])("falls back to the text matcher without error_kind: %s", (detail) => {
    expect(isRateLimited({ error_kind: null, detail })).toBe(true);
  });

  it("does not mistake a context-window limit for a rate limit", () => {
    expect(isRateLimited({ error_kind: null, detail: "context limit reached" })).toBe(false);
    expect(isRateLimited({ error_kind: null, detail: "process crashed" })).toBe(false);
  });
});

describe("scopeUsage", () => {
  it("does not double count the scope-wide usage carried by each tier", () => {
    const u = { ...EMPTY_USAGE, input_tokens: 100, output_tokens: 10, cost_usd: 0.5, requests: 3 };
    const total = scopeUsage([session({ usage: u }), session({ tier: "deep", usage: { ...u, input_tokens: 90 } })]);
    expect(total).toEqual(u);
  });

  it("takes the last request from the newest snapshot", () => {
    const older = { ...EMPTY_USAGE, requests: 2, total_latency_ms: 4000, last_latency_ms: 3000, last_request_at_ms: 1000 };
    const newer = { ...EMPTY_USAGE, requests: 3, total_latency_ms: 4800, last_latency_ms: 800, last_request_at_ms: 2000 };
    const total = scopeUsage([session({ tier: "deep", usage: older }), session({ usage: newer })]);
    expect(total.requests).toBe(3);
    expect(total.total_latency_ms).toBe(4800);
    expect(total.last_latency_ms).toBe(800);
    expect(total.last_request_at_ms).toBe(2000);
  });

  it("fills fields an older backend did not send", () => {
    const legacy = { input_tokens: 5, output_tokens: 1, cost_usd: 0.1 } as unknown as AgentSessionStatus["usage"];
    expect(scopeUsage([session({ usage: legacy })])).toEqual({ ...EMPTY_USAGE, input_tokens: 5, output_tokens: 1, cost_usd: 0.1 });
  });
});

describe("AgentStatusChip for other CLI agents", () => {
  const CODEX_MODELS = [
    {
      value: "gpt-6-sol",
      resolved_model: "gpt-6-sol",
      display_name: "GPT-6 Sol",
      description: "",
      supports_effort: true,
      effort_levels: ["low", "medium", "high"],
      default_effort: "medium",
    },
  ];

  beforeEach(() => {
    ipc.cliAgentStatus.mockImplementation(async (kind: string) => ({
      installed: true,
      binary_path: kind,
      version: "1.0.0",
      auth: { logged_in: true, auth_method: "chatgpt", subscription_type: "plus", email: null, login: "subscription" },
      npm_only: false, required_version: null,
    }));
    useConfigStore.setState({ cliAgentModels: { codex_cli: CODEX_MODELS } });
  });

  it("names the agent, reads its own status and shows its Fast and Deep models without thinking", async () => {
    render(<AgentStatusChip kind="codex_cli" onClick={() => {}} />);
    await act(async () => {});
    expect(screen.getByLabelText("AI provider: Codex, Ready")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(ipc.cliAgentStatus).toHaveBeenCalledWith("codex_cli");
    const tip = cardText();
    expect(tip).toContain("Codex (subscription)");
    expect(tip).toContain("Signed in · Plus plan");
    // The empty saved model means the first listed one.
    expect(tip).toContain("GPT-6 Sol · Low");
    expect(tip).toContain("GPT-6 Sol · Medium");
    expect(tip).not.toContain("thinking");
  });

  it("Antigravity shows no effort either", async () => {
    useConfigStore.setState({
      cliAgentModels: {
        antigravity_cli: [
          {
            value: "gemini-3.8-flash-low",
            resolved_model: "x",
            display_name: "Gemini 3.8 Flash (Low)",
            description: "",
            supports_effort: false,
            effort_levels: [],
          },
        ],
      },
    });
    render(<AgentStatusChip kind="antigravity_cli" />);
    await act(async () => {});
    const tip = cardText();
    expect(tip).toContain("Antigravity (subscription)");
    expect(tip).toContain("Gemini 3.8 Flash (Low)");
    expect(tip).not.toContain("thinking");
  });
});
