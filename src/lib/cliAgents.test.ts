import { describe, expect, it } from "vitest";
import {
  CLI_AGENTS,
  cliAgentInfo,
  cliAgentName,
  cliEffectiveEffort,
  cliModelLabel,
  cliTierLabel,
  isCliAgent,
  resolveListedModel,
} from "./cliAgents";
import { supportsThinking } from "./llmRequestOptions";
import { isClaudeEntry } from "../calllog/stats";
import type { ClaudeModelInfo } from "./types";

function model(value: string, display: string, levels: string[], def?: string): ClaudeModelInfo {
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

describe("CLI_AGENTS", () => {
  it("lists Claude, Antigravity and Codex with their capabilities", () => {
    expect(CLI_AGENTS.map((a) => [a.id, a.name, a.supportsEffort, a.supportsThinking])).toEqual([
      ["claude_cli", "Claude", true, true],
      ["antigravity_cli", "Antigravity", false, false],
      ["codex_cli", "Codex", true, false],
    ]);
    for (const a of CLI_AGENTS) {
      expect(a.loginHint).not.toBe("");
      expect(a.installHint).not.toBe("");
    }
    expect(cliAgentInfo("codex_cli").installHint).toContain("npm i -g @openai/codex");
    expect(cliAgentInfo("antigravity_cli").installHint).toContain("antigravity.google");
  });

  it("isCliAgent is true for the three agents only (Gemini CLI is gone)", () => {
    expect(isCliAgent("claude_cli")).toBe(true);
    expect(isCliAgent("antigravity_cli")).toBe(true);
    expect(isCliAgent("codex_cli")).toBe(true);
    expect(isCliAgent("gemini_cli")).toBe(false);
    expect(isCliAgent("gemini")).toBe(false);
    expect(isCliAgent("ollama")).toBe(false);
    expect(isCliAgent(null)).toBe(false);
    expect(isCliAgent(undefined)).toBe(false);
    expect(cliAgentName("codex_cli")).toBe("Codex");
  });

  it("matches the backend defaults of each agent", () => {
    expect(cliAgentInfo("claude_cli").defaultConfig).toMatchObject({ fast_model: "haiku", deep_model: "sonnet", deep_thinking: true });
    expect(cliAgentInfo("antigravity_cli").defaultConfig).toMatchObject({
      fast_model: "gemini-3.8-flash-low",
      deep_model: "gemini-4-neon-medium",
    });
    expect(cliAgentInfo("codex_cli").defaultConfig).toMatchObject({ fast_model: "", deep_model: "", fast_effort: "low", deep_effort: "medium" });
  });

  it("no CLI agent gets the API providers' thinking setting; the API providers keep it", () => {
    expect(supportsThinking("claude_cli")).toBe(false);
    expect(supportsThinking("antigravity_cli")).toBe(false);
    expect(supportsThinking("codex_cli")).toBe(false);
    expect(supportsThinking("openai")).toBe(true);
  });

  it("the call log treats every CLI agent's answers as session answers", () => {
    expect(isClaudeEntry({ provider: "Codex (subscription)", sessionKey: undefined })).toBe(true);
    expect(isClaudeEntry({ provider: "Antigravity (subscription)", sessionKey: undefined })).toBe(true);
    expect(isClaudeEntry({ provider: "OpenAI", sessionKey: undefined })).toBe(false);
  });
});

describe("model and effort wording", () => {
  const codex = [
    model("gpt-6-sol", "GPT-6 Sol", ["low", "medium", "high"], "medium"),
    model("gpt-6-max", "GPT-6 Max", ["medium", "high", "ultra"], "high"),
  ];

  it("an empty or retired model is the first listed one", () => {
    expect(resolveListedModel(codex, "")?.value).toBe("gpt-6-sol");
    expect(resolveListedModel(codex, "gone")?.value).toBe("gpt-6-sol");
    expect(resolveListedModel(codex, "gpt-6-max")?.value).toBe("gpt-6-max");
    expect(resolveListedModel([], "")).toBeUndefined();
    expect(resolveListedModel(undefined, "x")).toBeUndefined();
  });

  it("Codex clamps on a scale that has ultra", () => {
    expect(cliEffectiveEffort("codex_cli", codex[1], "low")).toBe("medium");
    expect(cliEffectiveEffort("codex_cli", codex[0], "ultra")).toBe("high");
    expect(cliEffectiveEffort("codex_cli", codex[1], "ultra")).toBe("ultra");
  });

  it("labels", () => {
    expect(cliModelLabel("claude_cli", "haiku")).toBe("Haiku");
    expect(cliModelLabel("codex_cli", "", codex)).toBe("GPT-6 Sol");
    expect(cliTierLabel("codex_cli", "gpt-6-max", "low", codex)).toBe("GPT-6 Max · Medium");
    expect(cliTierLabel("antigravity_cli", "x", "high", [model("x", "Gemini X", [])])).toBe("Gemini X");
  });
});
