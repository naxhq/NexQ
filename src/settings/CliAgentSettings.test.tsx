import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionStatus, ClaudeCliStatus, ClaudeModelInfo, CliAgentKind } from "../lib/types";

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
  cliAgentStatus: vi.fn(),
  cliAgentModels: vi.fn(),
  setCliAgentConfig: vi.fn(),
  getAgentSessions: vi.fn(),
  openCliLoginTerminal: vi.fn(),
  listModels: vi.fn(),
  getApiKey: vi.fn(),
  setActiveModel: vi.fn(),
}));

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  cliAgentStatus: (kind: string) => ipc.cliAgentStatus(kind),
  cliAgentModels: (...args: unknown[]) => ipc.cliAgentModels(...args),
  setCliAgentConfig: (...args: unknown[]) => ipc.setCliAgentConfig(...args),
  getAgentSessions: () => ipc.getAgentSessions(),
  openCliLoginTerminal: (...args: unknown[]) => ipc.openCliLoginTerminal(...args),
  listModels: (...args: unknown[]) => ipc.listModels(...args),
  getApiKey: (...args: unknown[]) => ipc.getApiKey(...args),
  setActiveModel: (...args: unknown[]) => ipc.setActiveModel(...args),
}));

import { CliAgentSettings } from "./CliAgentSettings";
import { cliTierLabel } from "../lib/cliAgents";
import { resetAgentStoreForTests } from "../stores/agentStore";
import { DEFAULT_CLI_AGENT_CONFIGS, useConfigStore } from "../stores/configStore";
import { EMPTY_USAGE } from "../lib/agentUsage";

const NOT_INSTALLED: ClaudeCliStatus = { installed: false, binary_path: null, version: null, auth: null, npm_only: false, required_version: null };
const NPM_ONLY: ClaudeCliStatus = { ...NOT_INSTALLED, npm_only: true, required_version: null };
const LOGGED_OUT: ClaudeCliStatus = {
  installed: true,
  binary_path: "C:\\Users\\me\\.local\\bin\\claude.exe",
  version: "2.1.288",
  auth: { logged_in: false, auth_method: "none", subscription_type: null, email: null, login: "logged_out" },
  npm_only: false, required_version: null,
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

/** A Claude Code older than NexQ can launch, signed in. */
const OUTDATED: ClaudeCliStatus = { ...LOGGED_IN, version: "2.1.206 (Claude Code)", required_version: "2.1.259" };

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

/** The status the other agents report; Claude's comes from `claudeStatus`. */
const statusOf: Partial<Record<CliAgentKind, ClaudeCliStatus>> = {};

function renderSettings(
  props: { selectedProvider?: string; activeProvider?: string; onSelect?: (kind: CliAgentKind) => void } = {},
) {
  return render(
    <CliAgentSettings
      selectedProvider={props.selectedProvider ?? "claude_cli"}
      activeProvider={props.activeProvider ?? "ollama"}
      onSelect={props.onSelect ?? (() => {})}
    />,
  );
}

/** What the status probe answers from now on: Claude as given, the others from `statusOf` (not installed by default). */
function claudeStatus(status: ClaudeCliStatus | Promise<ClaudeCliStatus>) {
  ipc.cliAgentStatus.mockImplementation((kind: CliAgentKind) =>
    Promise.resolve(kind === "claude_cli" ? status : (statusOf[kind] ?? NOT_INSTALLED)),
  );
}

function claudeCalls() {
  return ipc.cliAgentStatus.mock.calls.filter(([kind]) => kind === "claude_cli");
}

describe("CliAgentSettings", () => {
  beforeEach(() => {
    listeners.clear();
    resetAgentStoreForTests();
    useConfigStore.setState({
      llmProvider: "ollama",
      cliAgentConfigs: DEFAULT_CLI_AGENT_CONFIGS,
      cliFallbackPinned: {},
      lastModelByProvider: {},
      cliAgentModels: {},
    });
    for (const k of Object.keys(statusOf)) delete statusOf[k as CliAgentKind];
    ipc.cliAgentStatus.mockReset();
    claudeStatus(LOGGED_IN);
    ipc.cliAgentModels.mockReset().mockResolvedValue(CATALOG);
    ipc.setCliAgentConfig.mockReset().mockResolvedValue(undefined);
    ipc.getAgentSessions.mockReset().mockResolvedValue([]);
    ipc.openCliLoginTerminal.mockReset().mockResolvedValue(undefined);
    ipc.listModels.mockReset().mockResolvedValue([]);
    ipc.getApiKey.mockReset().mockResolvedValue(null);
    ipc.setActiveModel.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("links to the Claude Code install guide when the CLI is missing", async () => {
    claudeStatus(NOT_INSTALLED);
    renderSettings();
    const link = await screen.findByRole("link", { name: /install claude code/i });
    expect(link).toHaveAttribute("href", "https://code.claude.com/docs/en/setup");
  });

  it("names an npm-only install and links to the native installer", async () => {
    claudeStatus(NPM_ONLY);
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

  it("says plainly that Claude Code is too old, never connected, with the update command", async () => {
    claudeStatus(OUTDATED);
    renderSettings({ activeProvider: "claude_cli" });
    expect(await screen.findByText("Claude Code 2.1.206 is too old")).toBeInTheDocument();
    expect(screen.getByTestId("claude-status-dot")).toHaveAttribute("data-state", "outdated");
    expect(screen.getByText("Needs update")).toBeInTheDocument();
    expect(
      screen.getByText("NexQ needs Claude Code 2.1.259 or newer. Update it, then check the connection."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("update-command")).toHaveTextContent(
      "& 'C:\\Users\\me\\.local\\bin\\claude.exe' update",
    );
    expect(screen.getByText("In PowerShell:")).toBeInTheDocument();
    // The check result is "Update needed", never a green connected line.
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Update needed"));
    expect(screen.queryByText(/Connected/)).not.toBeInTheDocument();
    expect(screen.queryByText(/✓/)).not.toBeInTheDocument();
    // No login prompt: the login is not the problem.
    expect(screen.queryByRole("button", { name: /open terminal to log in/i })).not.toBeInTheDocument();
  });

  it("can't make an outdated Claude the active provider", async () => {
    claudeStatus(OUTDATED);
    renderSettings();
    await screen.findByText("Claude Code 2.1.206 is too old");
    expect(screen.getByRole("button", { name: /use claude/i })).toBeDisabled();
  });

  it("doesn't ask an outdated Claude for its models", async () => {
    claudeStatus(OUTDATED);
    renderSettings();
    await screen.findByText("Claude Code 2.1.206 is too old");
    ipc.cliAgentModels.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /check connection/i }));
    await waitFor(() => expect(claudeCalls().length).toBeGreaterThan(1));
    await waitFor(() => expect(screen.getByRole("button", { name: /check connection/i })).toBeEnabled());
    expect(ipc.cliAgentModels.mock.calls.filter(([kind]) => kind === "claude_cli")).toHaveLength(0);
  });

  it("loads the models on the check that finds Claude updated", async () => {
    claudeStatus(OUTDATED);
    renderSettings();
    await screen.findByText("Claude Code 2.1.206 is too old");
    ipc.cliAgentModels.mockClear();
    claudeStatus(LOGGED_IN);
    fireEvent.click(screen.getByRole("button", { name: /check connection/i }));
    await waitFor(() =>
      expect(ipc.cliAgentModels.mock.calls.filter(([kind]) => kind === "claude_cli")).toHaveLength(1),
    );
    expect(screen.queryByText("Claude Code 2.1.206 is too old")).not.toBeInTheDocument();
  });

  it("shows a plain quoted command off Windows", async () => {
    claudeStatus({ ...OUTDATED, binary_path: "/home/me/.local/bin/claude" });
    renderSettings();
    await screen.findByText("Claude Code 2.1.206 is too old");
    expect(screen.getByTestId("update-command")).toHaveTextContent("'/home/me/.local/bin/claude' update");
    expect(screen.getByTestId("update-command").textContent).not.toContain("&");
    expect(screen.getByText("In a terminal:")).toBeInTheDocument();
  });

  it("never shows an API-billed login as connected", async () => {
    claudeStatus(API_BILLED);
    renderSettings();
    expect(
      await screen.findByText("This Claude login bills an API account, not your subscription."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("claude-status-dot")).toHaveAttribute("data-state", "api_billed");
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
    expect(screen.getByText("me@example.com · Not on a subscription")).toBeInTheDocument();
    // Still offers switching to the subscription login.
    expect(screen.getByRole("button", { name: /open terminal to log in/i })).toBeInTheDocument();
  });

  it("offers the login terminal when installed but logged out", async () => {
    claudeStatus(LOGGED_OUT);
    renderSettings();
    const button = await screen.findByRole("button", { name: /open terminal to log in/i });
    fireEvent.click(button);
    await waitFor(() => expect(ipc.openCliLoginTerminal).toHaveBeenCalledTimes(1));
  });

  it("shows a green dot, the email and the plan when logged in", async () => {
    renderSettings();
    expect(await screen.findByText("me@example.com · Max")).toBeInTheDocument();
    expect(screen.getByTestId("claude-status-dot")).toHaveAttribute("data-state", "connected");
    expect(screen.getByText(/2\.1\.288/)).toBeInTheDocument();
  });

  it("shows a quiet checking state while the status probe runs", async () => {
    let resolve: (s: ClaudeCliStatus) => void = () => {};
    claudeStatus(new Promise((r) => (resolve = r)));
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
    ipc.cliAgentStatus.mockRejectedValueOnce(new Error("spawn failed"));
    renderSettings();
    expect(await screen.findByText("Couldn't check")).toBeInTheDocument();
    expect(screen.getByTestId("claude-status-dot")).toHaveAttribute("data-state", "failed");
    fireEvent.click(screen.getByRole("button", { name: /check connection/i }));
    expect(await screen.findByText("me@example.com · Max")).toBeInTheDocument();
    expect(claudeCalls()).toHaveLength(2);
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
    expect(useConfigStore.getState().cliAgentConfigs.claude_cli.deep_model).toBe("opus");
    await waitFor(() =>
      expect(ipc.setCliAgentConfig).toHaveBeenCalledWith(
        "claude_cli",
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
    expect(useConfigStore.getState().cliAgentConfigs.claude_cli.fast_thinking).toBe(true);
    await waitFor(() =>
      expect(ipc.setCliAgentConfig).toHaveBeenCalledWith(
        "claude_cli",
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
      sources_notice: null,
      usage: { ...EMPTY_USAGE },
    };
    renderSettings({ activeProvider: "claude_cli" });
    await screen.findByText(/me@example\.com/);
    await act(async () => emit("agent_session_status", running));
    expect(screen.queryByText(/applies to the next session/i)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Fast effort"), { target: { value: "high" } });
    expect(screen.getByText(/applies to the next session/i)).toBeInTheDocument();
    // Once the session ends the hint goes away.
    await act(async () => emit("agent_session_status", { ...running, state: "closed" }));
    expect(screen.queryByText(/applies to the next session/i)).not.toBeInTheDocument();
  });

  it("renders the Beta badge and the credentials note", async () => {
    renderSettings();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(
      screen.getByText("Uses your own Claude, Antigravity or Codex login on this PC. NexQ never sees your credentials."),
    ).toBeInTheDocument();
    await screen.findByText(/me@example\.com/);
  });

  it("groups the CLI's models into Latest (with what they resolve to) and Pinned versions", async () => {
    useConfigStore.setState({ cliAgentModels: { claude_cli: CATALOG } });
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
    useConfigStore.setState({ cliAgentModels: { claude_cli: CATALOG } });
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
      cliAgentModels: { claude_cli: CATALOG },
      cliAgentConfigs: {
        ...DEFAULT_CLI_AGENT_CONFIGS,
        claude_cli: { ...DEFAULT_CLI_AGENT_CONFIGS.claude_cli, deep_model: "claude-opus-4-6", deep_effort: "xhigh" },
      },
    });
    renderSettings();
    await screen.findByText(/me@example\.com/);
    expect(optionTexts("Deep effort")).toEqual(["Low", "Medium", "High", "Max"]);
    expect(screen.getByLabelText("Deep effort")).toHaveValue("high");
    expect(useConfigStore.getState().cliAgentConfigs.claude_cli.deep_effort).toBe("xhigh");
  });

  it("keeps a saved model that is no longer offered selected, with a warning", async () => {
    useConfigStore.setState({
      cliAgentModels: { claude_cli: CATALOG },
      cliAgentConfigs: {
        ...DEFAULT_CLI_AGENT_CONFIGS,
        claude_cli: { ...DEFAULT_CLI_AGENT_CONFIGS.claude_cli, deep_model: "claude-opus-4-1" },
      },
    });
    renderSettings();
    await screen.findByText(/me@example\.com/);
    expect(screen.getByLabelText("Deep model")).toHaveValue("claude-opus-4-1");
    expect(screen.getByText("No longer available")).toBeInTheDocument();
    // Only the Deep row warns.
    expect(screen.getAllByText("No longer available")).toHaveLength(1);
  });

  it("falls back to the static aliases when no catalog was ever fetched", async () => {
    ipc.cliAgentModels.mockReturnValue(new Promise(() => {}));
    renderSettings();
    await screen.findByText(/me@example\.com/);
    expect(optionTexts("Deep model")).toEqual(["Haiku", "Sonnet", "Opus", "Fable"]);
    expect(screen.queryByText("No longer available")).not.toBeInTheDocument();
  });

  it("Check connection shows progress, then the result with an honest time, and refreshes the models", async () => {
    renderSettings();
    await screen.findByText(/me@example\.com/);
    let resolve: (s: ClaudeCliStatus) => void = () => {};
    claudeStatus(new Promise((r) => (resolve = r)));
    fireEvent.click(screen.getByRole("button", { name: /check connection/i }));
    const busy = screen.getByRole("button", { name: "Checking…" });
    expect(busy).toBeDisabled();
    await act(async () => resolve(LOGGED_IN));
    expect(screen.getByRole("status")).toHaveTextContent("Connected · checked just now");
    expect(ipc.cliAgentModels).toHaveBeenCalledWith("claude_cli", true);
    await waitFor(() => expect(useConfigStore.getState().cliAgentModels.claude_cli).toEqual(CATALOG));
  });

  it("Check connection stays busy until the model list refresh is done too", async () => {
    renderSettings();
    await screen.findByText(/me@example\.com/);
    let resolveModels: (m: ClaudeModelInfo[]) => void = () => {};
    ipc.cliAgentModels.mockReturnValue(new Promise((r) => (resolveModels = r)));
    fireEvent.click(screen.getByRole("button", { name: /check connection/i }));
    // The status probe is done...
    await waitFor(() => expect(claudeCalls()).toHaveLength(2));
    await act(async () => {});
    // ...but the catalog is still loading.
    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
    await act(async () => resolveModels(CATALOG));
    expect(screen.getByRole("button", { name: /check connection/i })).toBeEnabled();
  });

  it("says when the model list couldn't be refreshed, even with an older list", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    useConfigStore.setState({ cliAgentModels: { claude_cli: CATALOG } });
    renderSettings();
    await screen.findByText(/me@example\.com/);
    ipc.cliAgentModels.mockRejectedValueOnce(new Error("timed out"));
    fireEvent.click(screen.getByRole("button", { name: /check connection/i }));
    expect(await screen.findByText("Couldn't refresh model list — showing last known")).toBeInTheDocument();
    // The older list stays usable.
    expect(screen.getByLabelText("Deep model")).toHaveValue("sonnet");
  });

  it("Check connection names the specific problem", async () => {
    renderSettings();
    await screen.findByText(/me@example\.com/);
    claudeStatus(LOGGED_OUT);
    fireEvent.click(screen.getByRole("button", { name: /check connection/i }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Not logged in · checked just now"));
    claudeStatus(NPM_ONLY);
    fireEvent.click(screen.getByRole("button", { name: /check connection/i }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/npm install/i));
  });

  it("says a failed re-check failed instead of repeating the earlier result", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    renderSettings();
    await screen.findByText(/me@example\.com/);
    expect(screen.getByRole("status")).toHaveTextContent("Connected");
    ipc.cliAgentStatus.mockRejectedValueOnce(new Error("spawn failed"));
    fireEvent.click(screen.getByRole("button", { name: /check connection/i }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Couldn't check: spawn failed"));
  });

  it("labels a tier with the effort the session actually gets", () => {
    expect(cliTierLabel("claude_cli", "haiku", "low", CATALOG)).toBe("Haiku");
    expect(cliTierLabel("claude_cli", "claude-opus-4-6", "xhigh", CATALOG)).toBe("Opus 4.6 · High");
    expect(cliTierLabel("claude_cli", "sonnet", "medium", CATALOG)).toBe("Sonnet · Medium");
    // No catalog yet: the saved effort as it is.
    expect(cliTierLabel("claude_cli", "haiku", "low")).toBe("Haiku · Low");
  });

  it("pins the fallback provider with the model last used there", async () => {
    useConfigStore.setState({ lastModelByProvider: { openai: "gpt-4o" } });
    renderSettings();
    await screen.findByText(/me@example\.com/);
    fireEvent.change(screen.getByLabelText("Fallback provider"), { target: { value: "openai" } });
    const state = useConfigStore.getState();
    expect(state.cliFallbackPinned).toEqual({ claude_cli: true });
    expect(state.cliAgentConfigs.claude_cli.fallback_provider).toBe("openai");
    expect(state.cliAgentConfigs.claude_cli.fallback_model).toBe("gpt-4o");
    // The provider's model list loads for the model picker.
    await screen.findByRole("option", { name: "Provider's first model" });
    expect(ipc.listModels).toHaveBeenCalledWith(JSON.stringify({ provider_type: "openai" }));
  });
});

// ── Antigravity and Codex ───────────────────────────────────────────────────

const CODEX_LOGGED_IN: ClaudeCliStatus = {
  installed: true,
  binary_path: "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd",
  version: "0.171.0",
  auth: { logged_in: true, auth_method: "chatgpt", subscription_type: "plus", email: "me@openai.example", login: "subscription" },
  npm_only: false, required_version: null,
};
const AG_LOGGED_IN: ClaudeCliStatus = {
  installed: true,
  binary_path: "C:\\Users\\me\\AppData\\Local\\agy\\agy.exe",
  version: "1.5.14",
  auth: { logged_in: true, auth_method: "google", subscription_type: null, email: null, login: "subscription" },
  npm_only: false, required_version: null,
};

function codexModel(value: string, display: string, levels: string[], def?: string): ClaudeModelInfo {
  return {
    value,
    resolved_model: value,
    display_name: display,
    description: "",
    supports_effort: levels.length > 0,
    effort_levels: levels,
    ...(def && { default_effort: def }),
  };
}
const CODEX_CATALOG: ClaudeModelInfo[] = [
  codexModel("gpt-6-sol", "GPT-6 Sol", ["low", "medium", "high"], "medium"),
  codexModel("gpt-6-mini", "GPT-6 Mini", ["low", "medium"], "low"),
  codexModel("gpt-6-max", "GPT-6 Max", ["medium", "high", "xhigh", "max", "ultra"], "high"),
];
const AG_CATALOG: ClaudeModelInfo[] = [
  codexModel("gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)", []),
  codexModel("gemini-4-neon-medium", "Gemini 4 Neon (Medium)", []),
  codexModel("gemini-4-neon-high", "Gemini 4 Neon (High)", []),
];

describe("CliAgentSettings: Antigravity and Codex", () => {
  beforeEach(() => {
    listeners.clear();
    resetAgentStoreForTests();
    useConfigStore.setState({
      llmProvider: "ollama",
      cliAgentConfigs: DEFAULT_CLI_AGENT_CONFIGS,
      cliFallbackPinned: {},
      lastModelByProvider: {},
      cliAgentModels: {},
    });
    for (const k of Object.keys(statusOf)) delete statusOf[k as CliAgentKind];
    ipc.cliAgentStatus.mockReset();
    claudeStatus(LOGGED_IN);
    ipc.cliAgentModels.mockReset().mockResolvedValue([]);
    ipc.setCliAgentConfig.mockReset().mockResolvedValue(undefined);
    ipc.getAgentSessions.mockReset().mockResolvedValue([]);
    ipc.openCliLoginTerminal.mockReset().mockResolvedValue(undefined);
    ipc.listModels.mockReset().mockResolvedValue([]);
    ipc.getApiKey.mockReset().mockResolvedValue(null);
    ipc.setActiveModel.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows three real tiles with a logo and a status each, and none is Coming soon", async () => {
    statusOf.codex_cli = CODEX_LOGGED_IN;
    renderSettings();
    await screen.findByText(/me@example\.com/);
    for (const name of ["Claude", "Antigravity", "Codex"]) {
      const tile = screen.getByRole("button", { name: new RegExp(`^${name}\\b`) });
      expect(tile).toBeEnabled();
      expect(tile.querySelector("svg")).not.toBeNull();
    }
    await waitFor(() => expect(screen.getByTestId("codex-status-dot")).toHaveAttribute("data-state", "connected"));
    expect(screen.getByTestId("antigravity-status-dot")).toHaveAttribute("data-state", "not_installed");
    expect(screen.getByTestId("claude-status-dot")).toHaveAttribute("data-state", "connected");
    expect(screen.queryByText("Coming soon")).not.toBeInTheDocument();
  });

  it("selecting a tile asks to view that agent, and only the viewed agent shows details", async () => {
    statusOf.codex_cli = CODEX_LOGGED_IN;
    const onSelect = vi.fn();
    const view = renderSettings({ onSelect });
    await screen.findByText(/me@example\.com/);
    fireEvent.click(screen.getByRole("button", { name: /^Codex\b/ }));
    expect(onSelect).toHaveBeenCalledWith("codex_cli");
    expect(screen.queryByText(/me@openai\.example/)).not.toBeInTheDocument();

    view.rerender(<CliAgentSettings selectedProvider="codex_cli" activeProvider="ollama" onSelect={onSelect} />);
    expect(await screen.findByText("me@openai.example · Plus")).toBeInTheDocument();
    expect(screen.getByText(/0\.171\.0/)).toBeInTheDocument();
    expect(screen.queryByText(/me@example\.com/)).not.toBeInTheDocument();
    expect(screen.getByText("Viewing Codex. NexQ is using another provider.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use Codex" })).toBeEnabled();
    expect(screen.getByText("Answers while Codex is unavailable (not logged in, usage limit, crash).")).toBeInTheDocument();
  });

  it("Use Codex activates it through the shared store action", async () => {
    statusOf.codex_cli = CODEX_LOGGED_IN;
    const activate = vi.fn(async () => {});
    useConfigStore.setState({ activateLLMProvider: activate });
    renderSettings({ selectedProvider: "codex_cli" });
    fireEvent.click(await screen.findByRole("button", { name: "Use Codex" }));
    await waitFor(() => expect(activate).toHaveBeenCalledWith("codex_cli"));
  });

  it("shows the In use pill on the active agent only, and no Use button for it", async () => {
    statusOf.codex_cli = CODEX_LOGGED_IN;
    renderSettings({ selectedProvider: "codex_cli", activeProvider: "codex_cli" });
    await screen.findByText("me@openai.example · Plus");
    expect(within(screen.getByRole("button", { name: /^Codex\b/ })).getByText("In use")).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: /^Claude\b/ })).queryByText("In use")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use Codex" })).not.toBeInTheDocument();
  });

  it("Codex: first listed model is shown selected while the saved model is empty", async () => {
    statusOf.codex_cli = CODEX_LOGGED_IN;
    useConfigStore.setState({ cliAgentModels: { codex_cli: CODEX_CATALOG } });
    renderSettings({ selectedProvider: "codex_cli" });
    await screen.findByText("me@openai.example · Plus");
    expect(useConfigStore.getState().cliAgentConfigs.codex_cli.fast_model).toBe("");
    expect(screen.getByLabelText("Fast model")).toHaveValue("gpt-6-sol");
    expect(screen.getByLabelText("Deep model")).toHaveValue("gpt-6-sol");
    expect(optionTexts("Fast model")).toEqual(["GPT-6 Sol", "GPT-6 Mini", "GPT-6 Max"]);
    // Showing it writes nothing: "first listed" stays the saved choice.
    expect(ipc.setCliAgentConfig).not.toHaveBeenCalled();
    // No thinking switch: Codex has none.
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("Codex: the effort list is the model's own levels, shown clamped while the saved one is kept", async () => {
    statusOf.codex_cli = CODEX_LOGGED_IN;
    useConfigStore.setState({
      cliAgentModels: { codex_cli: CODEX_CATALOG },
      cliAgentConfigs: {
        ...DEFAULT_CLI_AGENT_CONFIGS,
        codex_cli: { ...DEFAULT_CLI_AGENT_CONFIGS.codex_cli, deep_model: "gpt-6-mini", deep_effort: "ultra" },
      },
    });
    renderSettings({ selectedProvider: "codex_cli" });
    await screen.findByText("me@openai.example · Plus");
    expect(optionTexts("Fast effort")).toEqual(["Low", "Medium", "High"]);
    expect(optionTexts("Deep effort")).toEqual(["Low", "Medium"]);
    expect(screen.getByLabelText("Fast effort")).toHaveValue("low");
    // Saved "ultra" runs as the closest level the model takes.
    expect(screen.getByLabelText("Deep effort")).toHaveValue("medium");
    expect(useConfigStore.getState().cliAgentConfigs.codex_cli.deep_effort).toBe("ultra");
  });

  it("Codex: picking a model that doesn't take the saved effort saves that model's default effort", async () => {
    statusOf.codex_cli = CODEX_LOGGED_IN;
    useConfigStore.setState({
      cliAgentModels: { codex_cli: CODEX_CATALOG },
      cliAgentConfigs: {
        ...DEFAULT_CLI_AGENT_CONFIGS,
        codex_cli: { ...DEFAULT_CLI_AGENT_CONFIGS.codex_cli, fast_model: "gpt-6-sol", fast_effort: "low" },
      },
    });
    renderSettings({ selectedProvider: "codex_cli" });
    await screen.findByText("me@openai.example · Plus");
    // GPT-6 Max has no "low": its default (high) is saved with the model.
    fireEvent.change(screen.getByLabelText("Fast model"), { target: { value: "gpt-6-max" } });
    expect(useConfigStore.getState().cliAgentConfigs.codex_cli).toMatchObject({
      fast_model: "gpt-6-max",
      fast_effort: "high",
    });
    expect(optionTexts("Fast effort")).toEqual(["Medium", "High", "Extra high", "Max", "Ultra"]);
    await waitFor(() =>
      expect(ipc.setCliAgentConfig).toHaveBeenCalledWith(
        "codex_cli",
        expect.objectContaining({ fast_model: "gpt-6-max", fast_effort: "high" }),
      ),
    );
    // A model that takes the saved effort keeps it.
    fireEvent.change(screen.getByLabelText("Fast model"), { target: { value: "gpt-6-sol" } });
    expect(useConfigStore.getState().cliAgentConfigs.codex_cli.fast_effort).toBe("high");
  });

  it("Codex: a saved model the CLI no longer lists runs as the first listed one, and says so", async () => {
    statusOf.codex_cli = CODEX_LOGGED_IN;
    useConfigStore.setState({
      cliAgentModels: { codex_cli: CODEX_CATALOG },
      cliAgentConfigs: {
        ...DEFAULT_CLI_AGENT_CONFIGS,
        codex_cli: { ...DEFAULT_CLI_AGENT_CONFIGS.codex_cli, deep_model: "gpt-5-retired" },
      },
    });
    renderSettings({ selectedProvider: "codex_cli" });
    await screen.findByText("me@openai.example · Plus");
    expect(screen.getByLabelText("Deep model")).toHaveValue("gpt-6-sol");
    expect(screen.getByText("No longer offered — using GPT-6 Sol")).toBeInTheDocument();
    expect(screen.getAllByText(/No longer offered/)).toHaveLength(1);
  });

  it("Antigravity: no effort select and no thinking switch, models listed flat", async () => {
    statusOf.antigravity_cli = AG_LOGGED_IN;
    useConfigStore.setState({ cliAgentModels: { antigravity_cli: AG_CATALOG } });
    renderSettings({ selectedProvider: "antigravity_cli" });
    await screen.findByText("Signed in with Google");
    expect(screen.queryByLabelText("Fast effort")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Deep effort")).not.toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(optionTexts("Fast model")).toEqual([
      "Gemini 3.8 Flash (Low)",
      "Gemini 4 Neon (Medium)",
      "Gemini 4 Neon (High)",
    ]);
    expect(screen.getByLabelText("Fast model")).toHaveValue("gemini-3.8-flash-low");
    expect(screen.getByLabelText("Deep model")).toHaveValue("gemini-4-neon-medium");
    expect(screen.getByText(/puts the effort level in the model name/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Deep model"), { target: { value: "gemini-4-neon-high" } });
    await waitFor(() =>
      expect(ipc.setCliAgentConfig).toHaveBeenCalledWith(
        "antigravity_cli",
        expect.objectContaining({ deep_model: "gemini-4-neon-high" }),
      ),
    );
  });

  it("Antigravity: not installed points at antigravity.google", async () => {
    renderSettings({ selectedProvider: "antigravity_cli" });
    const link = await screen.findByRole("link", { name: /get antigravity/i });
    expect(link).toHaveAttribute("href", "https://antigravity.google");
    expect(screen.getByText(/Install it from antigravity\.google/)).toBeInTheDocument();
  });

  it("Codex: not installed shows the npm command", async () => {
    renderSettings({ selectedProvider: "codex_cli" });
    expect(await screen.findByText(/npm i -g @openai\/codex/)).toBeInTheDocument();
    expect(screen.getByTestId("codex-status-dot")).toHaveAttribute("data-state", "not_installed");
    expect(screen.getByRole("button", { name: "Use Codex" })).toBeDisabled();
  });

  it("Codex: logged out offers its own login terminal", async () => {
    statusOf.codex_cli = {
      ...CODEX_LOGGED_IN,
      auth: { logged_in: false, auth_method: "none", subscription_type: null, email: null, login: "logged_out" },
    };
    renderSettings({ selectedProvider: "codex_cli" });
    fireEvent.click(await screen.findByRole("button", { name: /open terminal to log in/i }));
    await waitFor(() => expect(ipc.openCliLoginTerminal).toHaveBeenCalledWith("codex_cli"));
    expect(screen.getByText(/Sign in with ChatGPT/)).toBeInTheDocument();
  });

  it("Codex: an API-key login is not usable and sends the user to Sign in with ChatGPT", async () => {
    statusOf.codex_cli = {
      ...CODEX_LOGGED_IN,
      auth: { logged_in: false, auth_method: "api_key", subscription_type: null, email: null, login: "logged_out" },
    };
    renderSettings({ selectedProvider: "codex_cli" });
    expect(await screen.findByText(/uses an API key/)).toBeInTheDocument();
    expect(screen.getByText(/choose Sign in with ChatGPT/)).toBeInTheDocument();
    expect(screen.getByTestId("codex-status-dot")).toHaveAttribute("data-state", "logged_out");
    expect(screen.getByRole("button", { name: /open terminal to log in/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Codex, logged out, not in use" })).toBeInTheDocument();
  });

  it("the agent in use shows a usage limit with its message and reset time", async () => {
    statusOf.codex_cli = CODEX_LOGGED_IN;
    const limited: AgentSessionStatus = {
      scope: "live",
      meeting_id: "m1",
      tier: "fast",
      state: "error",
      model: "gpt-6-sol",
      detail: "Usage limit reached. Resets at 3:40 PM",
      error_kind: "rate_limited",
      with_sources: false,
      sources_notice: null,
      usage: { ...EMPTY_USAGE },
    };
    renderSettings({ selectedProvider: "codex_cli", activeProvider: "codex_cli" });
    await screen.findByText("me@openai.example · Plus");
    await act(async () => emit("agent_session_status", limited));
    expect(screen.getByText("Usage limit reached. Resets at 3:40 PM")).toBeInTheDocument();
    expect(screen.getByTestId("codex-status-dot")).toHaveAttribute("data-state", "limited");
    expect(within(screen.getByRole("button", { name: /^Codex\b/ })).getByText("Usage limit")).toBeInTheDocument();
  });

  it("a Check connection on Codex refreshes only Codex", async () => {
    statusOf.codex_cli = CODEX_LOGGED_IN;
    ipc.cliAgentModels.mockResolvedValue(CODEX_CATALOG);
    renderSettings({ selectedProvider: "codex_cli" });
    await screen.findByText("me@openai.example · Plus");
    ipc.cliAgentModels.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /check connection/i }));
    await waitFor(() => expect(ipc.cliAgentModels).toHaveBeenCalledWith("codex_cli", true));
    expect(ipc.cliAgentModels).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(useConfigStore.getState().cliAgentModels.codex_cli).toEqual(CODEX_CATALOG));
  });

  it("labels tiers per agent: effort for Codex, none for Antigravity, first listed when empty", () => {
    expect(cliTierLabel("codex_cli", "", "low", CODEX_CATALOG)).toBe("GPT-6 Sol · Low");
    expect(cliTierLabel("codex_cli", "gpt-6-mini", "ultra", CODEX_CATALOG)).toBe("GPT-6 Mini · Medium");
    expect(cliTierLabel("antigravity_cli", "gemini-4-neon-medium", "low", AG_CATALOG)).toBe("Gemini 4 Neon (Medium)");
    // Nothing fetched yet: what the config names, or "Default".
    expect(cliTierLabel("antigravity_cli", "gemini-3.8-flash-low", "low")).toBe("gemini-3.8-flash-low");
    expect(cliTierLabel("codex_cli", "", "medium")).toBe("Default · Medium");
  });
});
