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

/** Arguments of every `set_cli_agent_config` call so far, for one agent. */
function pushedConfigs(kind = "claude_cli") {
  return invoke.mock.calls
    .filter(([cmd, args]) => cmd === "set_cli_agent_config" && (args as { kind: string }).kind === kind)
    .map(([, args]) => (args as { config: Record<string, unknown> }).config);
}

const HAIKU_MODEL = {
  value: "haiku",
  resolved_model: "claude-haiku-4-5",
  display_name: "Haiku 4.5",
  description: "",
  supports_effort: false,
  effort_levels: [],
};
const CODEX_MODEL = {
  value: "gpt-6-sol",
  resolved_model: "gpt-6-sol",
  display_name: "GPT-6 Sol",
  description: "",
  supports_effort: true,
  effort_levels: ["low", "medium", "high"],
  default_effort: "medium",
};
const KINDS = ["claude_cli", "antigravity_cli", "codex_cli"] as const;

describe("configStore: CLI agent config", () => {
  beforeEach(() => {
    saved.clear();
    invoke.mockClear();
    // loadConfig narrates its migrations.
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts with the defaults and the last active provider as fallback, and pushes every agent on load", async () => {
    saved.set("llmProvider", "openai");
    saved.set("llmModel", "gpt-4o");
    const store = await freshStore();
    await store.getState().loadConfig();

    expect(store.getState().cliAgentConfigs.claude_cli).toEqual({
      fast_model: "haiku",
      fast_effort: "low",
      deep_model: "sonnet",
      deep_effort: "medium",
      fast_thinking: false,
      deep_thinking: true,
      fallback_provider: "openai",
      fallback_model: "gpt-4o",
    });
    // Antigravity names its own models; Codex's empty model means "first listed".
    expect(store.getState().cliAgentConfigs.antigravity_cli).toMatchObject({
      fast_model: "gemini-3.8-flash-low",
      deep_model: "gemini-4-neon-medium",
      fallback_provider: "openai",
    });
    expect(store.getState().cliAgentConfigs.codex_cli).toMatchObject({
      fast_model: "",
      deep_model: "",
      fast_effort: "low",
      deep_effort: "medium",
    });
    for (const kind of KINDS) {
      await vi.waitFor(() => expect(pushedConfigs(kind)).toContainEqual(store.getState().cliAgentConfigs[kind]));
    }
  });

  it("restores a saved per-agent config and pushes it on load", async () => {
    const config = {
      fast_model: "gpt-6-sol",
      fast_effort: "high",
      deep_model: "gpt-6-sol",
      deep_effort: "ultra",
      fallback_provider: null,
      fallback_model: null,
    };
    saved.set("llmProvider", "codex_cli");
    saved.set("cliAgentConfigs", { codex_cli: config });
    const store = await freshStore();
    await store.getState().loadConfig();

    // Saved before the thinking settings existed: they load with their defaults.
    const loaded = { ...config, fast_thinking: false, deep_thinking: false };
    expect(store.getState().cliAgentConfigs.codex_cli).toEqual(loaded);
    // An agent missing from the saved map keeps its defaults.
    expect(store.getState().cliAgentConfigs.claude_cli).toMatchObject({ fast_model: "haiku" });
    await vi.waitFor(() => expect(pushedConfigs("codex_cli")).toContainEqual(loaded));
    // With Codex active, the backend's model slot gets its Fast model.
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("set_active_model", { provider: "codex_cli", modelId: "gpt-6-sol" }),
    );
  });

  it("migrates a config saved before the per-agent keys (Claude's old keys)", async () => {
    const oldConfig = {
      fast_model: "sonnet",
      fast_effort: "high",
      deep_model: "opus",
      deep_effort: "max",
      fast_thinking: true,
      deep_thinking: false,
      fallback_provider: "groq",
      fallback_model: "llama-3.3-70b",
    };
    saved.set("llmProvider", "claude_cli");
    saved.set("claudeCliConfig", oldConfig);
    saved.set("claudeCliFallbackPinned", true);
    saved.set("claudeModels", [HAIKU_MODEL]);
    const store = await freshStore();
    await store.getState().loadConfig();

    const s = () => store.getState();
    expect(s().cliAgentConfigs.claude_cli).toEqual(oldConfig);
    expect(s().cliFallbackPinned).toEqual({ claude_cli: true });
    expect(s().cliAgentModels).toEqual({ claude_cli: [HAIKU_MODEL] });
    // The new agents start from their defaults, not from Claude's saved values.
    expect(s().cliAgentConfigs.codex_cli).toMatchObject({ fast_model: "", fast_effort: "low" });
    await vi.waitFor(() => expect(pushedConfigs("claude_cli")).toContainEqual(oldConfig));
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("set_active_model", { provider: "claude_cli", modelId: "sonnet" }),
    );
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("seed_cli_agent_models", { kind: "claude_cli", models: [HAIKU_MODEL] }),
    );

    // The next change writes the per-agent keys, so the old ones are no longer needed.
    s().setCliAgentConfig("claude_cli", { ...oldConfig, deep_model: "fable" });
    await vi.waitFor(() =>
      expect(saved.get("cliAgentConfigs")).toMatchObject({
        claude_cli: { deep_model: "fable", fast_model: "sonnet" },
        codex_cli: { fast_model: "" },
      }),
    );
  });

  it("prefers the per-agent keys over Claude's old ones", async () => {
    saved.set("claudeCliConfig", { fast_model: "sonnet" });
    saved.set("claudeModels", [HAIKU_MODEL]);
    saved.set("cliAgentConfigs", { claude_cli: { fast_model: "opus" } });
    saved.set("cliAgentModels", { codex_cli: [CODEX_MODEL] });
    const store = await freshStore();
    await store.getState().loadConfig();
    expect(store.getState().cliAgentConfigs.claude_cli.fast_model).toBe("opus");
    expect(store.getState().cliAgentModels).toEqual({ claude_cli: [HAIKU_MODEL], codex_cli: [CODEX_MODEL] });
  });

  it("seeds the backend with every saved model catalog on load", async () => {
    saved.set("cliAgentModels", { claude_cli: [HAIKU_MODEL], codex_cli: [CODEX_MODEL] });
    const store = await freshStore();
    await store.getState().loadConfig();
    expect(store.getState().cliAgentModels.codex_cli).toEqual([CODEX_MODEL]);
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("seed_cli_agent_models", { kind: "claude_cli", models: [HAIKU_MODEL] }),
    );
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("seed_cli_agent_models", { kind: "codex_cli", models: [CODEX_MODEL] }),
    );
    // Nothing saved for Antigravity: nothing to seed.
    expect(invoke).not.toHaveBeenCalledWith(
      "seed_cli_agent_models",
      expect.objectContaining({ kind: "antigravity_cli" }),
    );
  });

  it("keeps each agent's catalog apart and persists it", async () => {
    const store = await freshStore();
    store.getState().setCliAgentModels("codex_cli", [CODEX_MODEL]);
    store.getState().setCliAgentModels("claude_cli", [HAIKU_MODEL]);
    const both = { codex_cli: [CODEX_MODEL], claude_cli: [HAIKU_MODEL] };
    expect(store.getState().cliAgentModels).toEqual(both);
    await vi.waitFor(() => expect(saved.get("cliAgentModels")).toEqual(both));
  });

  it("persists and pushes every change", async () => {
    const store = await freshStore();
    store.getState().setCliAgentConfig("claude_cli", { ...store.getState().cliAgentConfigs.claude_cli, deep_model: "fable" });

    await vi.waitFor(() => expect(pushedConfigs().pop()).toMatchObject({ deep_model: "fable" }));
    await vi.waitFor(() => expect(saved.get("cliAgentConfigs")).toMatchObject({ claude_cli: { deep_model: "fable" } }));
  });

  it("follows the active non-CLI provider and its model until the user picks a fallback", async () => {
    const store = await freshStore();
    const s = () => store.getState();

    s().setLLMProvider("groq");
    s().setLLMModel("llama-3.3-70b");
    for (const kind of KINDS) {
      expect(s().cliAgentConfigs[kind]).toMatchObject({ fallback_provider: "groq", fallback_model: "llama-3.3-70b" });
    }

    // A CLI agent itself and "custom" never become the fallback.
    s().setLLMProvider("claude_cli");
    s().setLLMProvider("codex_cli");
    s().setLLMProvider("custom");
    expect(s().cliAgentConfigs.claude_cli.fallback_provider).toBe("groq");

    // Pinning one agent's fallback leaves the others following.
    s().setCliAgentFallback("codex_cli", "ollama", "llama3.2");
    s().setLLMProvider("openai");
    expect(s().cliAgentConfigs.codex_cli).toMatchObject({ fallback_provider: "ollama", fallback_model: "llama3.2" });
    expect(s().cliAgentConfigs.claude_cli.fallback_provider).toBe("openai");
    await vi.waitFor(() => expect(saved.get("cliFallbackPinned")).toEqual({ codex_cli: true }));
  });

  it("keeps the generic model slot on the Fast model while a CLI agent is active", async () => {
    const store = await freshStore();
    store.setState({ llmProvider: "claude_cli", llmModel: "haiku" });
    store.getState().setCliAgentConfig("claude_cli", { ...store.getState().cliAgentConfigs.claude_cli, fast_model: "sonnet" });

    expect(store.getState().llmModel).toBe("sonnet");
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("set_active_model", { provider: "claude_cli", modelId: "sonnet" }),
    );

    // Another agent's change leaves the slot alone.
    invoke.mockClear();
    store.getState().setCliAgentConfig("codex_cli", { ...store.getState().cliAgentConfigs.codex_cli, fast_model: "gpt-6-sol" });
    expect(store.getState().llmModel).toBe("sonnet");
    expect(invoke).not.toHaveBeenCalledWith("set_active_model", expect.anything());
  });

  it("activating Codex fills the backend's model slot with its Fast model, empty included", async () => {
    const store = await freshStore();
    store.setState({ llmProvider: "claude_cli", llmModel: "haiku" });
    await store.getState().activateLLMProvider("codex_cli");
    expect(invoke).toHaveBeenCalledWith("set_llm_provider", { provider: JSON.stringify({ provider_type: "codex_cli" }) });
    expect(invoke).toHaveBeenCalledWith("set_active_model", { provider: "codex_cli", modelId: "" });
    expect(store.getState().llmProvider).toBe("codex_cli");
    expect(store.getState().llmModel).toBe("");
  });

  it("activating Codex with a catalog and an empty Fast model fills the slot with the first listed model", async () => {
    const store = await freshStore();
    store.setState({ llmProvider: "claude_cli", llmModel: "haiku" });
    store.getState().setCliAgentModels("codex_cli", [CODEX_MODEL]);
    await store.getState().activateLLMProvider("codex_cli");
    expect(invoke).toHaveBeenCalledWith("set_active_model", { provider: "codex_cli", modelId: "gpt-6-sol" });
    expect(store.getState().llmModel).toBe("gpt-6-sol");
    // The saved Fast model stays "" (first listed).
    expect(store.getState().cliAgentConfigs.codex_cli.fast_model).toBe("");
  });

  it("activating Codex from an API provider clears the previous provider's model in the backend", async () => {
    const store = await freshStore();
    store.setState({ llmProvider: "openai", llmModel: "gpt-4o" });
    await store.getState().activateLLMProvider("codex_cli");
    expect(invoke).toHaveBeenCalledWith("set_active_model", { provider: "codex_cli", modelId: "" });
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
    expect(s().cliAgentConfigs.claude_cli).toMatchObject({ fallback_provider: "openai", fallback_model: "gpt-4o" });
  });

  it("remembering a browsed model touches neither the active model nor other providers", async () => {
    const store = await freshStore();
    const s = () => store.getState();
    store.setState({
      llmProvider: "ollama",
      llmModel: "llama3.2",
      lastModelByProvider: { ollama: "llama3.2" },
      cliAgentConfigs: {
        ...s().cliAgentConfigs,
        claude_cli: { ...s().cliAgentConfigs.claude_cli, fallback_provider: "ollama", fallback_model: "llama3.2" },
      },
    });

    s().rememberModel("openrouter", "openai/gpt-4o-mini");

    expect(s().llmModel).toBe("llama3.2");
    expect(s().lastModelByProvider).toEqual({ ollama: "llama3.2", openrouter: "openai/gpt-4o-mini" });
    expect(s().cliAgentConfigs.claude_cli).toMatchObject({ fallback_provider: "ollama", fallback_model: "llama3.2" });
    // A CLI agent never gets a remembered model.
    s().rememberModel("claude_cli", "haiku");
    s().rememberModel("codex_cli", "gpt-6-sol");
    expect(s().lastModelByProvider.claude_cli).toBeUndefined();
    expect(s().lastModelByProvider.codex_cli).toBeUndefined();
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

describe("configStore: hotkeys", () => {
  beforeEach(() => {
    saved.clear();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts with the keys the app really uses", async () => {
    const store = await freshStore();
    expect(store.getState().hotkeys).toEqual({
      mode_assist: "Space",
      mode_say: "1",
      mode_shorten: "2",
      mode_followup: "3",
      mode_recap: "4",
      mode_ask: "5",
    });
  });

  it("an old config with no hotkeys loads the defaults", async () => {
    saved.set("theme", "dark");
    const store = await freshStore();
    await store.getState().loadConfig();
    expect(store.getState().hotkeys.mode_say).toBe("1");
    expect(store.getState().hotkeys.mode_ask).toBe("5");
  });

  it("an old config with the unused Ctrl+1..5 values loads the defaults and is cleaned up", async () => {
    saved.set("hotkeys", {
      toggle_assist: "Space", start_end_meeting: "Ctrl+M", show_hide: "Ctrl+B", open_settings: "Ctrl+,", escape: "Escape",
      mode_assist: "Space", mode_say: "Ctrl+1", mode_shorten: "Ctrl+2", mode_followup: "Ctrl+3", mode_recap: "Ctrl+4", mode_ask: "Ctrl+5",
    });
    const store = await freshStore();
    await store.getState().loadConfig();
    expect(store.getState().hotkeys).toMatchObject({ mode_say: "1", mode_shorten: "2", mode_followup: "3", mode_recap: "4", mode_ask: "5" });
    expect(Object.keys(store.getState().hotkeys)).toHaveLength(6);
    await vi.waitFor(() => expect(saved.get("hotkeys")).toEqual(store.getState().hotkeys));
  });

  it("a deliberate Ctrl+1 survives setHotkeys and the next load", async () => {
    const store = await freshStore();
    await store.getState().loadConfig();
    store.getState().setHotkeys({ ...store.getState().hotkeys, mode_say: "Ctrl+1" });
    expect(store.getState().hotkeys.mode_say).toBe("Ctrl+1");
    await vi.waitFor(() => expect(saved.get("hotkeys")).toMatchObject({ mode_say: "Ctrl+1" }));

    const reloaded = await freshStore();
    await reloaded.getState().loadConfig();
    expect(reloaded.getState().hotkeys.mode_say).toBe("Ctrl+1");
    expect(saved.get("hotkeys")).toMatchObject({ mode_say: "Ctrl+1" });
  });

  it("restores a saved choice and persists a change", async () => {
    saved.set("hotkeys", { mode_say: "Q" });
    const store = await freshStore();
    await store.getState().loadConfig();
    expect(store.getState().hotkeys.mode_say).toBe("Q");
    expect(store.getState().hotkeys.mode_shorten).toBe("2");

    store.getState().setHotkeys({ ...store.getState().hotkeys, mode_recap: "R" });
    await vi.waitFor(() => expect(saved.get("hotkeys")).toMatchObject({ mode_say: "Q", mode_recap: "R" }));
  });
});

describe("configStore: STT migration and the preset chip", () => {
  beforeEach(() => {
    saved.clear();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const inPerson = (themProvider: string, preset: string | null) => ({
    you: { role: "You", device_id: "default", is_input_device: true, stt_provider: "web_speech" },
    them: { role: "Them", device_id: "mic_2", is_input_device: true, stt_provider: themProvider },
    recording_enabled: false,
    preset_name: preset,
  });

  it("clears the preset name when the migration swaps an engine (old In-Person config using whisper_cpp)", async () => {
    saved.set("meetingAudioConfig", inPerson("whisper_cpp", "In-Person"));
    const store = await freshStore();
    await store.getState().loadConfig();

    const config = store.getState().meetingAudioConfig;
    expect(config?.them.stt_provider).toBe("deepgram");
    expect(config?.preset_name).toBeNull();
    expect((saved.get("meetingAudioConfig") as { preset_name: unknown }).preset_name).toBeNull();
  });

  it("keeps the preset name when nothing was migrated", async () => {
    saved.set("meetingAudioConfig", inPerson("parakeet_tdt", "In-Person"));
    const store = await freshStore();
    await store.getState().loadConfig();

    expect(store.getState().meetingAudioConfig?.preset_name).toBe("In-Person");
  });
});
