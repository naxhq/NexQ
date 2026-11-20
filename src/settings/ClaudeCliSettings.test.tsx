import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionStatus, ClaudeCliStatus, ClaudeModelInfo } from "../lib/types";

// ── Tauri stubs ─────────────────────────────────────────────────────────────
type Handler = (e: { payload: unknown }) => void;
const listeners = vi.hoisted(() => new Map<string, Set<(e: { payload: unknown }) => void>>());

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: Handler) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name)!.add(cb);
    return () => listeners.get(name)!.delete(cb);
  },
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));

vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));

function emit(name: string, payload: unknown) {
  listeners.get(name)?.forEach((cb) => cb({ payload }));
}

const ipc = vi.hoisted(() => ({
  claudeCliStatus: vi.fn(),
  claudeCliModels: vi.fn(),
  setClaudeCliConfig: vi.fn(),
  getAgentSessions: vi.fn(),
  openClaudeLoginTerminal: vi.fn(),
  listModels: vi.fn(),
  getApiKey: vi.fn(),
  setActiveModel: vi.fn(),
}));

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  claudeCliStatus: () => ipc.claudeCliStatus(),
  claudeCliModels: (...args: unknown[]) => ipc.claudeCliModels(...args),
  setClaudeCliConfig: (...args: unknown[]) => ipc.setClaudeCliConfig(...args),
  getAgentSessions: () => ipc.getAgentSessions(),
  openClaudeLoginTerminal: () => ipc.openClaudeLoginTerminal(),
  listModels: (...args: unknown[]) => ipc.listModels(...args),
  getApiKey: (...args: unknown[]) => ipc.getApiKey(...args),
  setActiveModel: (...args: unknown[]) => ipc.setActiveModel(...args),
}));

import { ClaudeCliSettings, claudeTierLabel } from "./ClaudeCliSettings";
import { resetAgentStoreForTests } from "../stores/agentStore";
import { DEFAULT_CLAUDE_CLI_CONFIG, useConfigStore } from "../stores/configStore";
import { EMPTY_USAGE } from "../lib/agentUsage";

const NOT_INSTALLED: ClaudeCliStatus = { installed: false, binary_path: null, version: null, auth: null, npm_only: false };
const NPM_ONLY: ClaudeCliStatus = { ...NOT_INSTALLED, npm_only: true };
const LOGGED_OUT: ClaudeCliStatus = {
  installed: true,
  binary_path: "C:\\Users\\me\\.local\\bin\\claude.exe",
  version: "2.1.288",
  auth: { logged_in: false, auth_method: "none", subscription_type: null, email: null, login: "logged_out" },
  npm_only: false,
};
const LOGGED_IN: ClaudeCliStatus = {
  ...LOGGED_OUT,
  auth: {
    logged_in: true,
    auth_method: "claude.ai",
    subscription_type: "max",
    email: "me@example.com",
    login: "subscription",
  },
};
const API_BILLED: ClaudeCliStatus = {
  ...LOGGED_OUT,
  auth: { logged_in: true, auth_method: "api_key", subscription_type: null, email: "me@example.com", login: "api_billed" },
};

const ALL_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
function model(value: string, resolved: string, display: string, levels: string[] = ALL_EFFORTS): ClaudeModelInfo {
  return { value, resolved_model: resolved, display_name: display, description: "", supports_effort: levels.length > 0, effort_levels: levels };
}
/** Trimmed from a real `initialize` answer. */
const CATALOG: ClaudeModelInfo[] = [
  model("default", "claude-opus-5-5", "Default (recommended)"),
  model("opus", "claude-opus-5-5", "Opus 5.5"),
  model("fable", "claude-fable-5-1", "Fable 5.1"),
  model("sonnet", "claude-sonnet-5-5", "Sonnet 5.5"),
  model("haiku", "claude-haiku-4-5-20251001", "Haiku 4.5", []),
  model("claude-opus-4-8", "claude-opus-4-8", "Opus 4.8"),
  model("claude-opus-4-6", "claude-opus-4-6", "Opus 4.6", ["low", "medium", "high", "max"]),
];

function optionTexts(label: string): string[] {
  return Array.from((screen.getByLabelText(label) as HTMLSelectElement).options).map((o) => o.textContent ?? "");
}

function renderSettings() {
  return render(<ClaudeCliSettings selected active={false} onSelect={() => {}} />);
}

describe("ClaudeCliSettings", () => {
  beforeEach(() => {
    listeners.clear();
    resetAgentStoreForTests();
    useConfigStore.setState({
      llmProvider: "ollama",
      claudeCliConfig: DEFAULT_CLAUDE_CLI_CONFIG,
      claudeCliFallbackPinned: false,
      lastModelByProvider: {},
      claudeModels: null,
    });
    ipc.claudeCliStatus.mockReset().mockResolvedValue(LOGGED_IN);
    ipc.claudeCliModels.mockReset().mockResolvedValue(CATALOG);
    ipc.setClaudeCliConfig.mockReset().mockResolvedValue(undefined);
    ipc.getAgentSessions.mockReset().mockResolvedValue([]);
    ipc.openClaudeLoginTerminal.mockReset().mockResolvedValue(undefined);
    ipc.listModels.mockReset().mockResolvedValue([]);
    ipc.getApiKey.mockReset().mockResolvedValue(null);
    ipc.setActiveModel.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("links to the Claude Code install guide when the CLI is missing", async () => {
    ipc.claudeCliStatus.mockResolvedValue(NOT_INSTALLED);
    renderSettings();
    const link = await screen.findByRole("link", { name: /install claude code/i });
    expect(link).toHaveAttribute("href", "https://code.claude.com/docs/en/setup");
  });

  it("names an npm-only install and links to the native installer", async () => {
    ipc.claudeCliStatus.mockResolvedValue(NPM_ONLY);
    renderSettings();
    expect(
      await screen.findByText("Found an npm install of Claude Code — NexQ needs the native installer"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("claude-status-dot")).toHaveAttribute("data-state", "npm_only");
    expect(screen.getByRole("link", { name: /install claude code/i })).toHaveAttribute(
      "href",
      "https://code.claude.com/docs/en/setup",
    );
  });

  it("never shows an API-billed login as connected", async () => {
    ipc.claudeCliStatus.mockResolvedValue(API_BILLED);
    renderSettings();
    expect(
      await screen.findByText("This Claude login bills an API account, not your subscription."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("claude-status-dot")).toHaveAttribute("data-state", "api_billed");
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
    expect(screen.getByText("me@example.com · API account")).toBeInTheDocument();
    // Still offers switching to the subscription login.
    expect(screen.getByRole("button", { name: /open terminal to log in/i })).toBeInTheDocument();
  });

  it("offers the login terminal when installed but logged out", async () => {
    ipc.claudeCliStatus.mockResolvedValue(LOGGED_OUT);
    renderSettings();
    const button = await screen.findByRole("button", { name: /open terminal to log in/i });
    fireEvent.click(button);
    await waitFor(() => expect(ipc.openClaudeLoginTerminal).toHaveBeenCalledTimes(1));
  });

  it("shows a green dot, the email and the plan when logged in", async () => {
    renderSettings();
    expect(await screen.findByText("me@example.com · Max")).toBeInTheDocument();
    expect(screen.getByTestId("claude-status-dot")).toHaveAttribute("data-state", "connected");
    expect(screen.getByText(/2\.1\.288/)).toBeInTheDocument();
  });

  it("shows a quiet checking state while the status probe runs", async () => {
    let resolve: (s: ClaudeCliStatus) => void = () => {};
    ipc.claudeCliStatus.mockReturnValue(new Promise((r) => (resolve = r)));
    renderSettings();
    expect(screen.getByTestId("claude-status-dot")).toHaveAttribute("data-state", "checking");
    // On the provider row, and on the Check connection button.
    expect(within(screen.getByRole("button", { name: /^Claude\b/ })).getByText(/checking/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
    await act(async () => resolve(LOGGED_IN));
    expect(screen.getByTestId("claude-status-dot")).toHaveAttribute("data-state", "connected");
  });

  it("says so when the status check itself fails, and retries on Check connection", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    ipc.claudeCliStatus.mockRejectedValueOnce(new Error("spawn failed"));
    renderSettings();
    expect(await screen.findByText("Couldn't check")).toBeInTheDocument();
    expect(screen.getByTestId("claude-status-dot")).toHaveAttribute("data-state", "failed");
    fireEvent.click(screen.getByRole("button", { name: /check connection/i }));
    expect(await screen.findByText("me@example.com · Max")).toBeInTheDocument();
    expect(ipc.claudeCliStatus).toHaveBeenCalledTimes(2);
  });

  it("defaults Fast to Haiku · Low and Deep to Sonnet · Medium", async () => {
    renderSettings();
    await screen.findByText(/me@example\.com/);
    expect(screen.getByLabelText("Fast model")).toHaveValue("haiku");
    expect(screen.getByLabelText("Fast effort")).toHaveValue("low");
    expect(screen.getByLabelText("Deep model")).toHaveValue("sonnet");
    expect(screen.getByLabelText("Deep effort")).toHaveValue("medium");
    const effortOptions = Array.from(
      (screen.getByLabelText("Fast effort") as HTMLSelectElement).options,
    ).map((o) => o.value);
    expect(effortOptions).toEqual(["low", "medium", "high", "xhigh", "max"]);
    const modelOptions = Array.from(
      (screen.getByLabelText("Deep model") as HTMLSelectElement).options,
    ).map((o) => o.textContent);
    expect(modelOptions).toEqual(["Haiku", "Sonnet", "Opus", "Fable"]);
  });

  it("saves a model change and pushes it to the backend", async () => {
    renderSettings();
    await screen.findByText(/me@example\.com/);
    fireEvent.change(screen.getByLabelText("Deep model"), { target: { value: "opus" } });
    expect(useConfigStore.getState().claudeCliConfig.deep_model).toBe("opus");
    await waitFor(() =>
      expect(ipc.setClaudeCliConfig).toHaveBeenCalledWith(
        expect.objectContaining({ deep_model: "opus", fast_model: "haiku" }),
      ),
    );
  });

  it("toggles extended thinking per tier (Fast off, Deep on by default)", async () => {
    renderSettings();
    await screen.findByText(/me@example\.com/);
    const fast = screen.getByRole("switch", { name: "Fast extended thinking" });
    const deep = screen.getByRole("switch", { name: "Deep extended thinking" });
    expect(fast).toHaveAttribute("aria-checked", "false");
    expect(deep).toHaveAttribute("aria-checked", "true");
    fireEvent.click(fast);
    expect(useConfigStore.getState().claudeCliConfig.fast_thinking).toBe(true);
    await waitFor(() =>
      expect(ipc.setClaudeCliConfig).toHaveBeenCalledWith(
        expect.objectContaining({ fast_thinking: true, deep_thinking: true }),
      ),
    );
    expect(screen.getByRole("switch", { name: "Fast extended thinking" })).toHaveAttribute("aria-checked", "true");
  });

  it("says a change applies to the next session while a session runs", async () => {
    const running: AgentSessionStatus = {
      scope: "live",
      meeting_id: "m1",
      tier: "fast",
      state: "ready",
      model: "haiku",
      detail: null,
      error_kind: null,
      with_sources: false,
      usage: { ...EMPTY_USAGE },
    };
    renderSettings();
    await screen.findByText(/me@example\.com/);
    await act(async () => emit("agent_session_status", running));
    expect(screen.queryByText(/applies to the next session/i)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Fast effort"), { target: { value: "high" } });
    expect(screen.getByText(/applies to the next session/i)).toBeInTheDocument();
    // Once the session ends the hint goes away.
    await act(async () => emit("agent_session_status", { ...running, state: "closed" }));
    expect(screen.queryByText(/applies to the next session/i)).not.toBeInTheDocument();
  });

  it("lists Gemini CLI and Codex CLI as disabled, coming soon", async () => {
    renderSettings();
    await screen.findByText(/me@example\.com/);
    expect(screen.getByRole("button", { name: /gemini cli/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /codex cli/i })).toBeDisabled();
    expect(screen.getAllByText("Coming soon")).toHaveLength(2);
  });

  it("renders the Beta badge and the credentials note", async () => {
    renderSettings();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(
      screen.getByText("Uses your own Claude login on this PC. NexQ never sees your credentials."),
    ).toBeInTheDocument();
    await screen.findByText(/me@example\.com/);
  });

  it("groups the CLI's models into Latest (with what they resolve to) and Pinned versions", async () => {
    useConfigStore.setState({ claudeModels: CATALOG });
    renderSettings();
    await screen.findByText(/me@example\.com/);
    const groups = Array.from(screen.getByLabelText("Deep model").querySelectorAll("optgroup")).map((g) => g.label);
    expect(groups).toEqual(["Latest", "Pinned versions"]);
    expect(optionTexts("Deep model")).toEqual([
      "Opus — Opus 5.5",
      "Fable — Fable 5.1",
      "Sonnet — Sonnet 5.5",
      "Haiku — Haiku 4.5",
      "Opus 4.8",
      "Opus 4.6",
    ]);
    // Defaults stay Haiku (Fast) and Sonnet (Deep).
    expect(screen.getByLabelText("Fast model")).toHaveValue("haiku");
    expect(screen.getByLabelText("Deep model")).toHaveValue("sonnet");
  });

  it("disables the effort picker for a model without effort support", async () => {
    useConfigStore.setState({ claudeModels: CATALOG });
    renderSettings();
    await screen.findByText(/me@example\.com/);
    const fastEffort = screen.getByLabelText("Fast effort");
    expect(fastEffort).toBeDisabled();
    expect(optionTexts("Fast effort")).toEqual(["Not supported"]);
    // Sonnet takes every level.
    expect(screen.getByLabelText("Deep effort")).toBeEnabled();
    expect(optionTexts("Deep effort")).toEqual(["Low", "Medium", "High", "Extra high", "Max"]);
  });

  it("offers only the model's effort levels and shows the clamped effort, keeping the saved one", async () => {
    useConfigStore.setState({
      claudeModels: CATALOG,
      claudeCliConfig: { ...DEFAULT_CLAUDE_CLI_CONFIG, deep_model: "claude-opus-4-6", deep_effort: "xhigh" },
    });
    renderSettings();
    await screen.findByText(/me@example\.com/);
    expect(optionTexts("Deep effort")).toEqual(["Low", "Medium", "High", "Max"]);
    expect(screen.getByLabelText("Deep effort")).toHaveValue("high");
    expect(useConfigStore.getState().claudeCliConfig.deep_effort).toBe("xhigh");
  });

  it("keeps a saved model that is no longer offered selected, with a warning", async () => {
    useConfigStore.setState({
      claudeModels: CATALOG,
      claudeCliConfig: { ...DEFAULT_CLAUDE_CLI_CONFIG, deep_model: "claude-opus-4-1" },
    });
    renderSettings();
    await screen.findByText(/me@example\.com/);
    expect(screen.getByLabelText("Deep model")).toHaveValue("claude-opus-4-1");
    expect(screen.getByText("No longer available")).toBeInTheDocument();
    // Only the Deep row warns.
    expect(screen.getAllByText("No longer available")).toHaveLength(1);
  });

  it("falls back to the static aliases when no catalog was ever fetched", async () => {
    ipc.claudeCliModels.mockReturnValue(new Promise(() => {}));
    renderSettings();
    await screen.findByText(/me@example\.com/);
    expect(optionTexts("Deep model")).toEqual(["Haiku", "Sonnet", "Opus", "Fable"]);
    expect(screen.queryByText("No longer available")).not.toBeInTheDocument();
  });

  it("Check connection shows progress, then the result with an honest time, and refreshes the models", async () => {
    renderSettings();
    await screen.findByText(/me@example\.com/);
    let resolve: (s: ClaudeCliStatus) => void = () => {};
    ipc.claudeCliStatus.mockReturnValue(new Promise((r) => (resolve = r)));
    fireEvent.click(screen.getByRole("button", { name: /check connection/i }));
    const busy = screen.getByRole("button", { name: "Checking…" });
    expect(busy).toBeDisabled();
    await act(async () => resolve(LOGGED_IN));
    expect(screen.getByRole("status")).toHaveTextContent("Connected · checked just now");
    expect(ipc.claudeCliModels).toHaveBeenCalledWith(true);
    await waitFor(() => expect(useConfigStore.getState().claudeModels).toEqual(CATALOG));
  });

  it("Check connection stays busy until the model list refresh is done too", async () => {
    renderSettings();
    await screen.findByText(/me@example\.com/);
    let resolveModels: (m: ClaudeModelInfo[]) => void = () => {};
    ipc.claudeCliModels.mockReturnValue(new Promise((r) => (resolveModels = r)));
    fireEvent.click(screen.getByRole("button", { name: /check connection/i }));
    // The status probe is done...
    await waitFor(() => expect(ipc.claudeCliStatus).toHaveBeenCalledTimes(2));
    await act(async () => {});
    // ...but the catalog is still loading.
    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
    await act(async () => resolveModels(CATALOG));
    expect(screen.getByRole("button", { name: /check connection/i })).toBeEnabled();
  });

  it("says when the model list couldn't be refreshed, even with an older list", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    useConfigStore.setState({ claudeModels: CATALOG });
    renderSettings();
    await screen.findByText(/me@example\.com/);
    ipc.claudeCliModels.mockRejectedValueOnce(new Error("timed out"));
    fireEvent.click(screen.getByRole("button", { name: /check connection/i }));
    expect(await screen.findByText("Couldn't refresh model list — showing last known")).toBeInTheDocument();
    // The older list stays usable.
    expect(screen.getByLabelText("Deep model")).toHaveValue("sonnet");
  });

  it("Check connection names the specific problem", async () => {
    renderSettings();
    await screen.findByText(/me@example\.com/);
    ipc.claudeCliStatus.mockResolvedValue(LOGGED_OUT);
    fireEvent.click(screen.getByRole("button", { name: /check connection/i }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Not logged in · checked just now"));
    ipc.claudeCliStatus.mockResolvedValue(NPM_ONLY);
    fireEvent.click(screen.getByRole("button", { name: /check connection/i }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/npm install/i));
  });

  it("says a failed re-check failed instead of repeating the earlier result", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    renderSettings();
    await screen.findByText(/me@example\.com/);
    expect(screen.getByRole("status")).toHaveTextContent("Connected");
    ipc.claudeCliStatus.mockRejectedValueOnce(new Error("spawn failed"));
    fireEvent.click(screen.getByRole("button", { name: /check connection/i }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Couldn't check: spawn failed"));
  });

  it("labels a tier with the effort the session actually gets", () => {
    expect(claudeTierLabel("haiku", "low", CATALOG)).toBe("Haiku");
    expect(claudeTierLabel("claude-opus-4-6", "xhigh", CATALOG)).toBe("Opus 4.6 · High");
    expect(claudeTierLabel("sonnet", "medium", CATALOG)).toBe("Sonnet · Medium");
    // No catalog yet: the saved effort as it is.
    expect(claudeTierLabel("haiku", "low")).toBe("Haiku · Low");
  });

  it("pins the fallback provider with the model last used there", async () => {
    useConfigStore.setState({ lastModelByProvider: { openai: "gpt-4o" } });
    renderSettings();
    await screen.findByText(/me@example\.com/);
    fireEvent.change(screen.getByLabelText("Fallback provider"), { target: { value: "openai" } });
    const state = useConfigStore.getState();
    expect(state.claudeCliFallbackPinned).toBe(true);
    expect(state.claudeCliConfig.fallback_provider).toBe("openai");
    expect(state.claudeCliConfig.fallback_model).toBe("gpt-4o");
    // The provider's model list loads for the model picker.
    await screen.findByRole("option", { name: "Provider's first model" });
    expect(ipc.listModels).toHaveBeenCalledWith(JSON.stringify({ provider_type: "openai" }));
  });
});
