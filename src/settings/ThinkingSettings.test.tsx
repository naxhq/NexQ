// The per-provider Thinking select and the advanced extra request JSON.

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saved = vi.hoisted(() => new Map<string, unknown>());

vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({
    set: async (key: string, value: unknown) => {
      saved.set(key, value);
    },
    get: async (key: string) => saved.get(key),
    onKeyChange: async () => () => {},
  }),
}));

const ipc = vi.hoisted(() => ({ setLLMProvider: vi.fn() }));
vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  setLLMProvider: (...a: unknown[]) => ipc.setLLMProvider(...a),
  getApiKey: async () => null,
}));

import { ThinkingSettings } from "./ThinkingSettings";
import { useConfigStore } from "../stores/configStore";

describe("ThinkingSettings", () => {
  beforeEach(() => {
    saved.clear();
    ipc.setLLMProvider.mockReset().mockResolvedValue(undefined);
    useConfigStore.setState({ llmProvider: "ollama", llmThinking: {}, llmExtraRequestJson: {} });
  });
  afterEach(() => cleanup());

  it("offers Auto, Off, Low and High, starting on Auto, with the hint", () => {
    render(<ThinkingSettings provider="ollama" />);
    const select = screen.getByLabelText("Thinking") as HTMLSelectElement;
    expect(select.value).toBe("auto");
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(["Auto", "Off", "Low", "High"]);
    expect(
      screen.getByText("Off answers faster. Not every model supports it; NexQ falls back automatically."),
    ).toBeInTheDocument();
  });

  it("a choice persists with its provider and is applied to the active provider", async () => {
    render(<ThinkingSettings provider="ollama" />);
    fireEvent.change(screen.getByLabelText("Thinking"), { target: { value: "off" } });

    expect(useConfigStore.getState().llmThinking).toEqual({ ollama: "off" });
    await waitFor(() => expect(saved.get("llmThinking")).toEqual({ ollama: "off" }));
    // The backend gets the provider again, now with the setting.
    await waitFor(() =>
      expect(ipc.setLLMProvider).toHaveBeenCalledWith(JSON.stringify({ provider_type: "ollama", thinking: "off" })),
    );

    // Back to Auto leaves nothing behind: the config is what it was before the setting.
    fireEvent.change(screen.getByLabelText("Thinking"), { target: { value: "auto" } });
    expect(useConfigStore.getState().llmThinking).toEqual({});
    await waitFor(() =>
      expect(ipc.setLLMProvider).toHaveBeenLastCalledWith(JSON.stringify({ provider_type: "ollama" })),
    );
  });

  it("a provider that is not active is not re-applied (it is used when activated)", async () => {
    render(<ThinkingSettings provider="groq" />);
    fireEvent.change(screen.getByLabelText("Thinking"), { target: { value: "low" } });
    await waitFor(() => expect(saved.get("llmThinking")).toEqual({ groq: "low" }));
    expect(ipc.setLLMProvider).not.toHaveBeenCalled();
  });

  it("shows the saved choice of the provider it is for", () => {
    useConfigStore.setState({ llmThinking: { openai: "high", ollama: "off" } });
    render(<ThinkingSettings provider="openai" />);
    expect((screen.getByLabelText("Thinking") as HTMLSelectElement).value).toBe("high");
  });

  it("offers the extra JSON only to providers that take it, collapsed by default", () => {
    const { container, unmount } = render(<ThinkingSettings provider="ollama" />);
    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    expect(details!.hasAttribute("open")).toBe(false);
    unmount();

    for (const provider of ["lm_studio", "openrouter", "custom"] as const) {
      const r = render(<ThinkingSettings provider={provider} />);
      expect(r.container.querySelector("details")).not.toBeNull();
      r.unmount();
    }
    for (const provider of ["openai", "anthropic", "groq", "gemini"] as const) {
      const r = render(<ThinkingSettings provider={provider} />);
      expect(r.container.querySelector("details")).toBeNull();
      r.unmount();
    }
  });

  it("shows nothing for the Claude subscription, which has its own settings", () => {
    const { container } = render(<ThinkingSettings provider="claude_cli" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("invalid JSON shows an inline error and is never saved or sent", async () => {
    render(<ThinkingSettings provider="ollama" />);
    const box = screen.getByLabelText("Extra request JSON");

    fireEvent.change(box, { target: { value: '{"options": {"num_ctx": ' } });
    expect(screen.getByRole("alert")).toHaveTextContent(/Not valid JSON/);
    expect(box).toHaveAttribute("aria-invalid", "true");
    expect(useConfigStore.getState().llmExtraRequestJson).toEqual({});
    expect(saved.has("llmExtraRequestJson")).toBe(false);
    expect(ipc.setLLMProvider).not.toHaveBeenCalled();

    // A JSON value that is not an object is refused too.
    fireEvent.change(box, { target: { value: "[1, 2]" } });
    expect(screen.getByRole("alert")).toHaveTextContent(/must be a JSON object/i);
    expect(useConfigStore.getState().llmExtraRequestJson).toEqual({});
  });

  it("valid JSON is saved and applied; fixing the error clears it", async () => {
    render(<ThinkingSettings provider="ollama" />);
    const box = screen.getByLabelText("Extra request JSON");

    fireEvent.change(box, { target: { value: '{"options": {' } });
    expect(screen.getByRole("alert")).toBeInTheDocument();

    const text = '{"options": {"num_ctx": 8192}}';
    fireEvent.change(box, { target: { value: text } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(useConfigStore.getState().llmExtraRequestJson).toEqual({ ollama: text });
    await waitFor(() => expect(saved.get("llmExtraRequestJson")).toEqual({ ollama: text }));
    await waitFor(() =>
      expect(ipc.setLLMProvider).toHaveBeenCalledWith(
        JSON.stringify({ provider_type: "ollama", extra_request_json: text }),
      ),
    );

    // Emptying the box removes it.
    fireEvent.change(box, { target: { value: "" } });
    expect(useConfigStore.getState().llmExtraRequestJson).toEqual({});
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
