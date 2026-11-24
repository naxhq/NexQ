// Settings > LLM providers: which provider is in use, which one is being
// viewed, and which are ready are three different things on screen.

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeCliStatus, ClaudeModelInfo } from "../lib/types";

vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));

const ipc = vi.hoisted(() => ({
  cliAgentStatus: vi.fn(),
  testLLMConnection: vi.fn(),
  hasApiKey: vi.fn(),
}));

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  cliAgentStatus: (kind: string) => ipc.cliAgentStatus(kind),
  cliAgentModels: async () => [],
  getAgentSessions: async () => [],
  testLLMConnection: (...a: unknown[]) => ipc.testLLMConnection(...a),
  hasApiKey: (...a: unknown[]) => ipc.hasApiKey(...a),
  getApiKey: async () => null,
  listModels: async () => [],
  listLocalSTTEngines: async () => [],
  getLLMProviders: async () => [],
}));

import { LLMSettings } from "./LLMSettings";
import { resetAgentStoreForTests } from "../stores/agentStore";
import { DEFAULT_CLI_AGENT_CONFIGS, useConfigStore } from "../stores/configStore";

const LOGGED_IN: ClaudeCliStatus = {
  installed: true,
  binary_path: "C:\\Users\\me\\.local\\bin\\claude.exe",
  version: "2.1.288",
  auth: { logged_in: true, auth_method: "claude.ai", subscription_type: "max", email: "me@example.com", login: "subscription" },
  npm_only: false, required_version: null,
};
const NOT_INSTALLED: ClaudeCliStatus = { installed: false, binary_path: null, version: null, auth: null, npm_only: false, required_version: null };
const CODEX_MODEL: ClaudeModelInfo = {
  value: "gpt-6-sol",
  resolved_model: "gpt-6-sol",
  display_name: "GPT-6 Sol",
  description: "",
  supports_effort: true,
  effort_levels: ["low", "medium", "high"],
  default_effort: "medium",
};
const LOGGED_OUT: ClaudeCliStatus = {
  ...LOGGED_IN,
  auth: { logged_in: false, auth_method: "none", subscription_type: null, email: null, login: "logged_out" },
};

/** Which local servers answer, by provider_type. */
let localUp: Record<string, boolean>;

function card(name: RegExp): HTMLElement {
  return screen.getByRole("button", { name });
}

describe("LLM provider cards: in use, viewing, status", () => {
  beforeEach(() => {
    resetAgentStoreForTests();
    localUp = { ollama: true, lm_studio: false };
    useConfigStore.setState({
      llmProvider: "groq",
      llmModel: "llama-3.3-70b",
      lastModelByProvider: { groq: "llama-3.3-70b" },
      cliAgentConfigs: DEFAULT_CLI_AGENT_CONFIGS,
      verifiedCloudProviders: [],
      customLlmBaseUrl: "",
    });
    ipc.cliAgentStatus.mockReset().mockResolvedValue(LOGGED_IN);
    ipc.testLLMConnection
      .mockReset()
      .mockImplementation(async (json: string) => localUp[JSON.parse(json).provider_type] ?? false);
    ipc.hasApiKey.mockReset().mockImplementation(async (p: string) => p === "groq");
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("marks exactly the provider in use with an In use pill (API provider)", async () => {
    render(<LLMSettings />);
    await screen.findByText("Not running");
    expect(screen.getAllByText("In use")).toHaveLength(1);
    expect(within(card(/^Groq\b/)).getByText("In use")).toBeInTheDocument();
    expect(card(/^Groq\b/)).toHaveAttribute("aria-label", "Groq, ready, in use");
    expect(screen.getByText(/In use: Groq · llama-3\.3-70b/)).toBeInTheDocument();
  });

  it("marks exactly the provider in use with an In use pill (Claude subscription)", async () => {
    useConfigStore.setState({ llmProvider: "claude_cli", llmModel: "haiku" });
    render(<LLMSettings />);
    await screen.findByText("Not running");
    expect(screen.getAllByText("In use")).toHaveLength(1);
    expect(within(card(/^Claude\b/)).getByText("In use")).toBeInTheDocument();
    expect(card(/^Groq\b/)).toHaveAttribute("aria-label", "Groq, ready, not in use");
    expect(screen.getByText(/In use: Claude \(subscription\) · Fast:/)).toBeInTheDocument();
  });

  it("never uses the word Active", async () => {
    render(<LLMSettings />);
    await screen.findByText("Not running");
    fireEvent.click(card(/^Ollama\b/));
    expect(screen.queryByText(/\bActive\b/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /\bactive\b/i })).not.toBeInTheDocument();
  });

  it("viewing a provider that isn't in use says what NexQ is using, with the switch right there", async () => {
    useConfigStore.setState({ llmProvider: "claude_cli", llmModel: "haiku" });
    render(<LLMSettings />);
    fireEvent.click(card(/^Ollama\b/));
    expect(screen.getByText("Viewing Ollama. NexQ is using Claude (subscription).")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use Ollama" })).toBeEnabled();
    // Viewing is a quiet ring, not the In use pill.
    expect(card(/^Ollama\b/)).toHaveAttribute("aria-pressed", "true");
    expect(within(card(/^Ollama\b/)).queryByText("In use")).not.toBeInTheDocument();
    expect(screen.getAllByText("In use")).toHaveLength(1);
  });

  it("viewing the provider in use shows no Viewing line", async () => {
    render(<LLMSettings />);
    expect(screen.queryByText(/^Viewing /)).not.toBeInTheDocument();
  });

  it("viewing Claude while another provider is in use says so", async () => {
    render(<LLMSettings />);
    fireEvent.click(card(/^Claude\b/));
    expect(await screen.findByText("Viewing Claude. NexQ is using Groq.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use Claude" })).toBeInTheDocument();
  });

  it("shows No key, Ready, Not running and Not set up from the provider itself", async () => {
    render(<LLMSettings />);
    await waitFor(() => expect(within(card(/^LM Studio\b/)).getByText("Not running")).toBeInTheDocument());
    expect(within(card(/^OpenAI\b/)).getByText("No key")).toBeInTheDocument();
    expect(within(card(/^Groq\b/)).getByText("Ready")).toBeInTheDocument();
    expect(within(card(/^Ollama\b/)).getByText("Ready")).toBeInTheDocument();
    expect(within(card(/^Custom\b/)).getByText("Not set up")).toBeInTheDocument();
    expect(card(/^OpenAI\b/)).toHaveAttribute("aria-label", "OpenAI, no key, not in use");
    expect(card(/^LM Studio\b/)).toHaveAttribute("aria-label", "LM Studio, not running, not in use");
    // "Local" is not a status.
    expect(within(card(/^Ollama\b/)).queryByText(/^Local$/)).not.toBeInTheDocument();
  });

  it("probes each local server once when the panel opens, and doesn't repeat", async () => {
    const { rerender } = render(<LLMSettings />);
    await screen.findByText("Not running");
    fireEvent.click(card(/^OpenAI\b/));
    rerender(<LLMSettings />);
    expect(ipc.testLLMConnection).toHaveBeenCalledTimes(2);
  });

  it("a local server that doesn't answer in time is Not running", async () => {
    vi.useFakeTimers();
    try {
      ipc.testLLMConnection.mockImplementation(() => new Promise(() => {}));
      render(<LLMSettings />);
      expect(within(card(/^Ollama\b/)).getByText("Checking…")).toBeInTheDocument();
      await vi.advanceTimersByTimeAsync(3500);
      expect(within(card(/^Ollama\b/)).getByText("Not running")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a manual Test Connection result isn't overwritten by the opening check timing out", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      // The two opening probes never answer; the manual test (third call) succeeds.
      ipc.testLLMConnection.mockImplementation(() => (++calls <= 2 ? new Promise(() => {}) : Promise.resolve(true)));
      render(<LLMSettings />);
      fireEvent.click(card(/^Ollama\b/));
      fireEvent.click(screen.getByRole("button", { name: /Test Connection/ }));
      await vi.advanceTimersByTimeAsync(100);
      expect(within(card(/^Ollama\b/)).getByText("Ready")).toBeInTheDocument();
      await vi.advanceTimersByTimeAsync(3500);
      expect(within(card(/^Ollama\b/)).getByText("Ready")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Claude connected but not in use is Connected, not In use", async () => {
    render(<LLMSettings />);
    await waitFor(() => expect(within(card(/^Claude\b/)).getByText("Connected")).toBeInTheDocument());
    expect(card(/^Claude\b/)).toHaveAttribute("aria-label", "Claude, connected, not in use");
    expect(within(card(/^Claude\b/)).queryByText("In use")).not.toBeInTheDocument();
  });

  it("Claude logged out reads Logged out, whether or not it is in use", async () => {
    ipc.cliAgentStatus.mockResolvedValue(LOGGED_OUT);
    render(<LLMSettings />);
    await waitFor(() => expect(within(card(/^Claude\b/)).getByText("Logged out")).toBeInTheDocument());
    expect(card(/^Claude\b/)).toHaveAttribute("aria-label", "Claude, logged out, not in use");
  });

  it("Antigravity and Codex are real tiles that read their own status, not Coming soon", async () => {
    ipc.cliAgentStatus.mockImplementation(async (kind: string) =>
      kind === "claude_cli" ? LOGGED_IN : NOT_INSTALLED,
    );
    render(<LLMSettings />);
    await waitFor(() => expect(within(card(/^Antigravity\b/)).getByText("Not installed")).toBeInTheDocument());
    expect(within(card(/^Codex\b/)).getByText("Not installed")).toBeInTheDocument();
    expect(screen.queryByText("Coming soon")).not.toBeInTheDocument();
    expect(card(/^Codex\b/)).not.toBeDisabled();
  });

  it("the In use banner names the active agent with its Fast and Deep models", async () => {
    useConfigStore.setState({
      llmProvider: "codex_cli",
      llmModel: "",
      cliAgentModels: { codex_cli: [CODEX_MODEL] },
    });
    render(<LLMSettings />);
    expect(screen.getByText(/In use: Codex \(subscription\) · Fast: GPT-6 Sol · Low · Deep: GPT-6 Sol · Medium/)).toBeInTheDocument();
    expect(within(card(/^Codex\b/)).getByText("In use")).toBeInTheDocument();
  });
});

describe("Custom Test Connection errors", () => {
  beforeEach(() => {
    resetAgentStoreForTests();
    useConfigStore.setState({
      llmProvider: "groq",
      llmModel: "llama-3.3-70b",
      lastModelByProvider: {},
      cliAgentConfigs: DEFAULT_CLI_AGENT_CONFIGS,
      verifiedCloudProviders: [],
      customLlmBaseUrl: "https://api.example.com",
      customLlmAuthType: "none",
    });
    ipc.cliAgentStatus.mockReset().mockResolvedValue(LOGGED_IN);
    ipc.hasApiKey.mockReset().mockResolvedValue(false);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  async function testCustom() {
    render(<LLMSettings />);
    fireEvent.click(card(/^Custom\b/));
    ipc.testLLMConnection.mockReset().mockRejectedValue(
      "Connection test failed: Authentication failed: the server refused the request (HTTP 401). Cloud APIs usually need Auth Type Bearer Token.",
    );
    fireEvent.click(await screen.findByRole("button", { name: /Test Connection/ }));
  }

  it("shows why the server refused it, from the backend's plain-string error", async () => {
    await testCustom();
    expect(await screen.findByText(/the server refused the request \(HTTP 401\)/)).toBeInTheDocument();
    expect(screen.getByText(/Auth Type Bearer Token/)).toBeInTheDocument();
    expect(screen.queryByText("Connection failed")).not.toBeInTheDocument();
    expect(screen.queryByText(/Connection test failed/)).not.toBeInTheDocument();
  });
});
