import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({ configs: [] as string[] }));
vi.mock("../lib/ipc", () => ({
  getAutomaticModel: async () => null,
  cliAgentStatus: async () => null,
  getApiKey: async () => "sk-test",
  listModels: async (config: string) => {
    h.configs.push(config);
    return [
      { id: "gpt-mini", name: "GPT Mini", provider: "openai", context_window: 128000 },
      { id: "text-embedding-3", name: "Embedding", provider: "openai", context_window: null },
    ];
  },
}));

import { ModelField, describeModel } from "./ModelField";
import { providerLabel } from "./labels";
import { resetModelCacheForTests } from "./catalog";
import { useConfigStore } from "../stores/configStore";

beforeEach(() => {
  h.configs.length = 0;
  resetModelCacheForTests();
  useConfigStore.setState({ verifiedCloudProviders: ["openai"] } as never);
});

describe("one vocabulary", () => {
  it("names providers the same everywhere and never shows a raw id", () => {
    expect(providerLabel("claude_cli")).toBe("Claude");
    expect(providerLabel("codex_cli")).toBe("Codex");
    expect(providerLabel("antigravity_cli")).toBe("Antigravity");
    expect(providerLabel("lm_studio")).toBe("LM Studio");
    expect(providerLabel("custom")).toBe("Custom server");
    expect(providerLabel("some_new_cli")).toBe("Some new");
    expect(providerLabel("")).toBe("Provider");
  });

  it("describes the automatic choice and a chosen one in words", () => {
    expect(describeModel({ provider: null, model: null, effort: null })).toMatch(/Automatic/);
    expect(describeModel({ provider: "openai", model: null, effort: null })).toBe("OpenAI, cheapest model");
    expect(describeModel({ provider: "ollama", model: "llama3", effort: null })).toBe("Ollama llama3");
  });
});

describe("ModelField", () => {
  it("lists a provider's own models with its key (not the active provider's) and skips embeddings", async () => {
    const onChange = vi.fn();
    render(<ModelField value={{ provider: null, model: null, effort: null }} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Model" }));
    expect(await screen.findByRole("option", { name: "GPT Mini" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Embedding" })).toBeNull();
    expect(JSON.parse(h.configs[0])).toEqual({ provider_type: "openai", api_key: "sk-test" });
    await userEvent.click(screen.getByRole("option", { name: "GPT Mini" }));
    expect(onChange).toHaveBeenCalledWith({ provider: "openai", model: "gpt-mini", effort: null });
  });

  it("does not talk about chat capabilities and offers going back to automatic", async () => {
    const onChange = vi.fn();
    render(<ModelField value={{ provider: "openai", model: "gpt-mini", effort: null }} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Model" }));
    await screen.findByRole("option", { name: "GPT Mini" });
    expect(screen.queryByText(/Uses found passages/)).toBeNull();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Use the cheapest model automatically" }));
    expect(onChange).toHaveBeenCalledWith({ provider: null, model: null, effort: null });
  });
});
