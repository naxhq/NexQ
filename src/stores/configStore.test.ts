import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// In-memory plugin-store and a recording `invoke`.
const saved = vi.hoisted(() => new Map<string, unknown>());
const invoke = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null));

vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({
    get: async (key: string) => saved.get(key),
    set: async (key: string, value: unknown) => void saved.set(key, value),
    onKeyChange: async () => () => {},
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));

async function freshStore() {
  vi.resetModules();
  return (await import("./configStore")).useConfigStore;
}

/** Arguments of every `set_claude_cli_config` call so far. */
function pushedConfigs() {
  return invoke.mock.calls
    .filter(([cmd]) => cmd === "set_claude_cli_config")
    .map(([, args]) => (args as { config: Record<string, unknown> }).config);
}

describe("configStore: Claude CLI config", () => {
  beforeEach(() => {
    saved.clear();
    invoke.mockClear();
    // loadConfig narrates its migrations.
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts with the defaults and the last active provider as fallback, and pushes it on load", async () => {
    saved.set("llmProvider", "openai");
    saved.set("llmModel", "gpt-4o");
    const store = await freshStore();
    await store.getState().loadConfig();

    expect(store.getState().claudeCliConfig).toEqual({
      fast_model: "haiku",
      fast_effort: "low",
      deep_model: "sonnet",
      deep_effort: "medium",
      fast_thinking: false,
      deep_thinking: true,
      fallback_provider: "openai",
      fallback_model: "gpt-4o",
    });
    await vi.waitFor(() => expect(pushedConfigs()).toContainEqual(store.getState().claudeCliConfig));
  });

  it("restores a saved config and pushes it on load", async () => {
    const config = {
      fast_model: "sonnet",
      fast_effort: "high",
      deep_model: "opus",
      deep_effort: "max",
      fallback_provider: null,
      fallback_model: null,
    };
    saved.set("llmProvider", "claude_cli");
    saved.set("claudeCliConfig", config);
    const store = await freshStore();
    await store.getState().loadConfig();

    // Saved before the thinking settings existed: they load with their defaults.
    const loaded = { ...config, fast_thinking: false, deep_thinking: true };
    expect(store.getState().claudeCliConfig).toEqual(loaded);
    await vi.waitFor(() => expect(pushedConfigs()).toContainEqual(loaded));
    // With Claude active, the backend's model slot gets the Fast model.
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("set_active_model", { provider: "claude_cli", modelId: "sonnet" }),
    );
  });

  it("seeds the backend with the saved Claude model catalog on load", async () => {
    const catalog = [
      { value: "haiku", resolved_model: "claude-haiku-4-5", display_name: "Haiku 4.5", description: "", supports_effort: false, effort_levels: [] },
    ];
    saved.set("claudeModels", catalog);
    const store = await freshStore();
    await store.getState().loadConfig();
    expect(store.getState().claudeModels).toEqual(catalog);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("seed_claude_cli_models", { models: catalog }));
  });

  it("persists and pushes every change", async () => {
    const store = await freshStore();
    store.getState().setClaudeCliConfig({ ...store.getState().claudeCliConfig, deep_model: "fable" });

    await vi.waitFor(() => expect(pushedConfigs().pop()).toMatchObject({ deep_model: "fable" }));
    await vi.waitFor(() => expect(saved.get("claudeCliConfig")).toMatchObject({ deep_model: "fable" }));
  });

  it("follows the active non-CLI provider and its model until the user picks a fallback", async () => {
    const store = await freshStore();
    const s = () => store.getState();

    s().setLLMProvider("groq");
    s().setLLMModel("llama-3.3-70b");
    expect(s().claudeCliConfig).toMatchObject({ fallback_provider: "groq", fallback_model: "llama-3.3-70b" });

    // Claude itself and "custom" never become the fallback.
    s().setLLMProvider("claude_cli");
    s().setLLMProvider("custom");
    expect(s().claudeCliConfig.fallback_provider).toBe("groq");

    s().setClaudeCliFallback("ollama", "llama3.2");
    s().setLLMProvider("openai");
    expect(s().claudeCliConfig).toMatchObject({ fallback_provider: "ollama", fallback_model: "llama3.2" });
    await vi.waitFor(() => expect(saved.get("claudeCliFallbackPinned")).toBe(true));
  });

  it("keeps the generic model slot on the Fast model while Claude is active", async () => {
    const store = await freshStore();
    store.setState({ llmProvider: "claude_cli", llmModel: "haiku" });
    store.getState().setClaudeCliConfig({ ...store.getState().claudeCliConfig, fast_model: "sonnet" });

    expect(store.getState().llmModel).toBe("sonnet");
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("set_active_model", { provider: "claude_cli", modelId: "sonnet" }),
    );
  });

  it("a model the backend refuses is reported and not recorded", async () => {
    const store = await freshStore();
    store.setState({ llmProvider: "ollama", llmModel: "llama3.2", lastModelByProvider: { openai: "gpt-4o" } });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "set_active_model") throw new Error("unknown model");
      return null;
    });
    await expect(store.getState().activateLLMProvider("openai")).rejects.toThrow(/unknown model/);
    expect(store.getState().llmModel).toBe("llama3.2");
    expect(saved.get("llmModel")).toBeUndefined();
    invoke.mockImplementation(async () => null);
  });

  it("remembers a model under its own provider even when set before the provider", async () => {
    const store = await freshStore();
    const s = () => store.getState();
    store.setState({ llmProvider: "ollama", lastModelByProvider: { ollama: "llama3.2" } });

    // First-run wizard order: model, then provider.
    s().setLLMModel("gpt-4o", "openai");
    s().setLLMProvider("openai");

    expect(s().lastModelByProvider).toEqual({ ollama: "llama3.2", openai: "gpt-4o" });
    expect(s().claudeCliConfig).toMatchObject({ fallback_provider: "openai", fallback_model: "gpt-4o" });
  });

  it("remembering a browsed model touches neither the active model nor other providers", async () => {
    const store = await freshStore();
    const s = () => store.getState();
    store.setState({
      llmProvider: "ollama",
      llmModel: "llama3.2",
      lastModelByProvider: { ollama: "llama3.2" },
      claudeCliConfig: { ...s().claudeCliConfig, fallback_provider: "ollama", fallback_model: "llama3.2" },
    });

    s().rememberModel("openrouter", "openai/gpt-4o-mini");

    expect(s().llmModel).toBe("llama3.2");
    expect(s().lastModelByProvider).toEqual({ ollama: "llama3.2", openrouter: "openai/gpt-4o-mini" });
    expect(s().claudeCliConfig).toMatchObject({ fallback_provider: "ollama", fallback_model: "llama3.2" });
    // Claude never gets a remembered model.
    s().rememberModel("claude_cli", "haiku");
    expect(s().lastModelByProvider.claude_cli).toBeUndefined();
  });
});

describe("configStore: capture shortcut", () => {
  beforeEach(() => {
    saved.clear();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("an old saved config without it loads with Ctrl+Shift+S, other shortcuts untouched", async () => {
    saved.set("stealthShortcut", "CmdOrCtrl+Alt+H");
    saved.set("assistShortcut", "CmdOrCtrl+Alt+A");
    const store = await freshStore();
    await store.getState().loadConfig();
    expect(store.getState().captureShortcut).toBe("CmdOrCtrl+Shift+S");
    expect(store.getState().stealthShortcut).toBe("CmdOrCtrl+Alt+H");
    expect(store.getState().assistShortcut).toBe("CmdOrCtrl+Alt+A");
  });

  it("restores a saved one and persists a change", async () => {
    saved.set("captureShortcut", "CmdOrCtrl+Alt+S");
    const store = await freshStore();
    await store.getState().loadConfig();
    expect(store.getState().captureShortcut).toBe("CmdOrCtrl+Alt+S");

    store.getState().setCaptureShortcut("CmdOrCtrl+Alt+X");
    await vi.waitFor(() => expect(saved.get("captureShortcut")).toBe("CmdOrCtrl+Alt+X"));
  });
});
