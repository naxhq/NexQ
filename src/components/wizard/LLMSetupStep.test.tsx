import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeCliStatus } from "../../lib/types";

vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));

const ipc = vi.hoisted(() => ({ cliAgentStatus: vi.fn(), openCliLoginTerminal: vi.fn() }));
vi.mock("../../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/ipc")>()),
  cliAgentStatus: (kind: string) => ipc.cliAgentStatus(kind),
  openCliLoginTerminal: (...a: unknown[]) => ipc.openCliLoginTerminal(...a),
  listModels: async () => [],
}));

import { LLMSetupStep } from "./LLMSetupStep";
import { resetAgentStoreForTests } from "../../stores/agentStore";
import { useConfigStore } from "../../stores/configStore";

const LOGGED_IN: ClaudeCliStatus = {
  installed: true,
  binary_path: "claude.exe",
  version: "2.1.0",
  auth: { logged_in: true, auth_method: "claude.ai", subscription_type: "max", email: "me@example.com", login: "subscription" },
  npm_only: false, required_version: null,
};

describe("LLMSetupStep (first-run wizard)", () => {
  const activate = vi.fn(async () => {});

  beforeEach(() => {
    resetAgentStoreForTests();
    ipc.cliAgentStatus.mockReset().mockResolvedValue(LOGGED_IN);
    activate.mockClear();
    ipc.openCliLoginTerminal.mockReset().mockResolvedValue(undefined);
    useConfigStore.setState({ llmProvider: "ollama", llmModel: "", activateLLMProvider: activate });
  });

  afterEach(() => cleanup());

  it("activates Claude through the shared activation action", async () => {
    render(<LLMSetupStep ollamaRunning={false} ollamaModels={[]} lmStudioRunning={false} lmStudioModels={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Claude/ }));
    fireEvent.click(screen.getByRole("button", { name: "Use Claude" }));
    await waitFor(() => expect(activate).toHaveBeenCalledWith("claude_cli"));
  });

  it("offers only the agents found on this PC, and activates the chosen one", async () => {
    ipc.cliAgentStatus.mockImplementation(async (kind: string) =>
      kind === "claude_cli"
        ? { installed: false, binary_path: null, version: null, auth: null, npm_only: false, required_version: null }
        : kind === "codex_cli"
          ? { ...LOGGED_IN, auth: { ...LOGGED_IN.auth!, email: "me@openai.example" } }
          : { installed: false, binary_path: null, version: null, auth: null, npm_only: false, required_version: null },
    );
    render(<LLMSetupStep ollamaRunning={false} ollamaModels={[]} lmStudioRunning={false} lmStudioModels={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Codex/ }));
    expect(screen.queryByRole("button", { name: /^Claude/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Antigravity/ })).not.toBeInTheDocument();
    expect(screen.getByText("Your Codex login (me@openai.example)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use Codex" }));
    await waitFor(() => expect(activate).toHaveBeenCalledWith("codex_cli"));
  });

  it("a Claude Code that is too old is not offered as ready, even when logged in", async () => {
    ipc.cliAgentStatus.mockImplementation(async (kind: string) =>
      kind === "claude_cli"
        ? { ...LOGGED_IN, version: "2.1.206 (Claude Code)", required_version: "2.1.259" }
        : { installed: false, binary_path: null, version: null, auth: null, npm_only: false, required_version: null },
    );
    render(<LLMSetupStep ollamaRunning={false} ollamaModels={[]} lmStudioRunning={false} lmStudioModels={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Claude/ }));
    expect(screen.getByText("Claude Code 2.1.206 is too old: update it to use it")).toBeInTheDocument();
    expect(
      screen.getByText(/Claude Code 2\.1\.206 is too old\. NexQ needs Claude Code 2\.1\.259 or newer/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use Claude" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /open terminal to log in/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /check again/i })).toBeInTheDocument();
  });

  it("a found agent that is logged out offers its own login terminal", async () => {
    const loggedOut = { ...LOGGED_IN, auth: { ...LOGGED_IN.auth!, logged_in: false, login: "logged_out" as const } };
    ipc.cliAgentStatus.mockImplementation(async (kind: string) =>
      kind === "antigravity_cli"
        ? loggedOut
        : { installed: false, binary_path: null, version: null, auth: null, npm_only: false, required_version: null },
    );
    render(<LLMSetupStep ollamaRunning={false} ollamaModels={[]} lmStudioRunning={false} lmStudioModels={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Antigravity/ }));
    expect(screen.getByText("Antigravity found — log in to use it")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /open terminal to log in/i }));
    await waitFor(() => expect(ipc.openCliLoginTerminal).toHaveBeenCalledWith("antigravity_cli"));
  });
  it("a Codex API-key login is not usable: login terminal and Check again, not Use Codex", async () => {
    const apiKey = {
      ...LOGGED_IN,
      auth: { logged_in: false, auth_method: "api_key", subscription_type: null, email: null, login: "logged_out" as const },
    };
    ipc.cliAgentStatus.mockImplementation(async (kind: string) =>
      kind === "codex_cli" ? apiKey : { installed: false, binary_path: null, version: null, auth: null, npm_only: false, required_version: null },
    );
    render(<LLMSetupStep ollamaRunning={false} ollamaModels={[]} lmStudioRunning={false} lmStudioModels={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Codex/ }));
    expect(screen.getByText(/Sign in with ChatGPT/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use Codex" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open terminal to log in/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /check again/i })).toBeInTheDocument();
  });
});
