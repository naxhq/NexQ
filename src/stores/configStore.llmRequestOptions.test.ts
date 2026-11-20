// The per-provider thinking setting and extra request JSON: an old saved config
// loads as before, and a change in one window reaches the other.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saved = vi.hoisted(() => new Map<string, unknown>());
const keyListeners = vi.hoisted(() => [] as Array<{ key: string; cb: (v: unknown) => void }>);
const invoke = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null));

vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({
    get: async (key: string) => saved.get(key),
    set: async (key: string, value: unknown) => {
      saved.set(key, value);
      for (const l of keyListeners) if (l.key === key) l.cb(structuredClone(value));
    },
    onKeyChange: async (key: string, cb: (v: unknown) => void) => {
      keyListeners.push({ key, cb });
      return () => {};
    },
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));

async function openWindow() {
  vi.resetModules();
  const { useConfigStore } = await import("./configStore");
  await useConfigStore.getState().loadConfig();
  return useConfigStore;
}

/** The provider configs the window pushed to the backend, as parsed JSON. */
function pushedConfigs(): Array<Record<string, unknown>> {
  return invoke.mock.calls
    .filter(([cmd]) => cmd === "set_llm_provider")
    .map(([, args]) => JSON.parse((args as { provider: string }).provider));
}

describe("configStore: LLM thinking and extra request JSON", () => {
  beforeEach(() => {
    saved.clear();
    keyListeners.length = 0;
    invoke.mockReset().mockImplementation(async () => null);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("a config saved before these settings loads as Auto and sends exactly what it did before", async () => {
    saved.set("llmProvider", "ollama");
    saved.set("llmModel", "llama3.2");
    // No llmThinking / llmExtraRequestJson keys at all: an old nexq-settings.
    const win = await openWindow();
    expect(win.getState().llmThinking).toEqual({});
    expect(win.getState().llmExtraRequestJson).toEqual({});
    await vi.waitFor(() => expect(pushedConfigs().length).toBeGreaterThan(0));
    expect(pushedConfigs()[0]).toEqual({ provider_type: "ollama" });
  });

  it("saved settings are pushed with the provider on start, Auto and invalid JSON left out", async () => {
    saved.set("llmProvider", "ollama");
    saved.set("llmModel", "qwen3:8b");
    saved.set("llmThinking", { ollama: "off", openai: "high", groq: "bogus" });
    saved.set("llmExtraRequestJson", { ollama: '{"options":{"num_ctx":8192}}', openai: '{"a":1}' });
    const win = await openWindow();
    expect(win.getState().llmThinking).toEqual({ ollama: "off", openai: "high" });
    await vi.waitFor(() => expect(pushedConfigs().length).toBeGreaterThan(0));
    expect(pushedConfigs()[0]).toEqual({
      provider_type: "ollama",
      thinking: "off",
      extra_request_json: '{"options":{"num_ctx":8192}}',
    });
  });

  it("an invalid saved extra JSON is never pushed", async () => {
    saved.set("llmProvider", "ollama");
    saved.set("llmModel", "m");
    saved.set("llmExtraRequestJson", { ollama: "{not json" });
    await openWindow();
    await vi.waitFor(() => expect(pushedConfigs().length).toBeGreaterThan(0));
    expect(pushedConfigs()[0]).toEqual({ provider_type: "ollama" });
  });

  it("a change in one window reaches the other", async () => {
    saved.set("llmProvider", "ollama");
    saved.set("llmModel", "m");
    const launcher = await openWindow();
    const overlay = await openWindow();

    launcher.getState().setLlmThinking("ollama", "low");
    launcher.getState().setLlmExtraRequestJson("custom", '{"top_p":0.5}');

    await vi.waitFor(() => expect(overlay.getState().llmThinking).toEqual({ ollama: "low" }));
    await vi.waitFor(() => expect(overlay.getState().llmExtraRequestJson).toEqual({ custom: '{"top_p":0.5}' }));
    // The next start has them too.
    const nextStart = await openWindow();
    expect(nextStart.getState().llmThinking).toEqual({ ollama: "low" });
  });

  it("an option update still loading when another provider is activated does not reinstall the old one", async () => {
    saved.set("llmProvider", "groq");
    saved.set("llmModel", "llama-3.3-70b");
    const win = await openWindow();
    await vi.waitFor(() => expect(pushedConfigs().length).toBeGreaterThan(0));
    invoke.mockClear();

    // Groq's credentials take a while to load: the option update is in flight.
    let releaseKey!: (key: string) => void;
    const keyLoaded = new Promise<string>((resolve) => (releaseKey = resolve));
    invoke.mockImplementation(async (cmd: string) => (cmd === "get_api_key" ? keyLoaded : null));

    win.getState().setLlmThinking("groq", "off");
    // Meanwhile the user switches to Ollama.
    const switched = win.getState().activateLLMProvider("ollama", { model: "llama3.2" });
    releaseKey("gsk-test");
    await switched;
    await vi.waitFor(() => expect(win.getState().llmProvider).toBe("ollama"));
    await new Promise((r) => setTimeout(r, 20));

    const providers = pushedConfigs().map((c) => c.provider_type);
    // Whatever was sent for Groq went first; the last word is Ollama's.
    expect(providers[providers.length - 1]).toBe("ollama");
    expect(win.getState().llmProvider).toBe("ollama");
  });

  it("an option update for a provider that is no longer active is dropped", async () => {
    saved.set("llmProvider", "ollama");
    saved.set("llmModel", "m");
    const win = await openWindow();
    await vi.waitFor(() => expect(pushedConfigs().length).toBeGreaterThan(0));
    await win.getState().activateLLMProvider("lm_studio", { model: "q" });
    invoke.mockClear();

    win.getState().setLlmThinking("ollama", "off");
    await new Promise((r) => setTimeout(r, 20));
    expect(pushedConfigs()).toEqual([]);
    // It is saved and used when Ollama is activated again.
    await win.getState().activateLLMProvider("ollama", { model: "m" });
    expect(pushedConfigs().pop()).toEqual({ provider_type: "ollama", thinking: "off" });
  });
});
