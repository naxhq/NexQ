// @vitest-environment node
//
// Guard: the app's AI provider (and its model) change only when the user says
// so (footer picker, Settings, the first-run wizard, the CLI agents' "Use"
// button) and when a window loads its saved settings. No workspace, chat,
// notes, brief, meeting or model-refresh code may call these. A new caller
// has to be added here on purpose.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

function callers(pattern: RegExp): string[] {
  return files(SRC)
    .filter((f) => pattern.test(readFileSync(f, "utf8")))
    .map((f) => relative(SRC, f).replace(/\\/g, "/"))
    .sort();
}

describe("who may change the global AI provider or model", () => {
  it("only the footer picker, Settings, the wizard, the agent settings and the config store switch the provider", () => {
    const found = callers(/\bactivateLLMProvider\s*\(|\bsetLLMProvider\s*\(|["']set_llm_provider["']/);
    expect(found).toEqual([
      "components/ServiceStatusBar.tsx",
      "components/wizard/LLMSetupStep.tsx",
      "lib/ipc.ts",
      "settings/CliAgentSettings.tsx",
      "settings/LLMSettings.tsx",
      "stores/configStore.ts",
    ]);
  });

  it("only the config store and the provider settings set the backend's active model", () => {
    const found = callers(/\b(?:ipc)?[sS]etActiveModel\s*\(|["']set_active_model["']/);
    expect(found).toEqual([
      "lib/ipc.ts",
      "settings/LLMSettings.tsx",
      "settings/openrouter/OpenRouterModelCatalog.tsx",
      "stores/configStore.ts",
    ]);
  });

  it("nothing in the workspace, chat, notes, brief or meeting code touches either", () => {
    const touch = callers(/activateLLMProvider|setLLMProvider|set_llm_provider|[sS]etActiveModel|set_active_model|setLLMModel\s*\(/);
    const forbidden = touch.filter((f) => /workspace|chat|notes|brief|meeting|talking|memory|launcher|overlay/i.test(f));
    expect(forbidden).toEqual([]);
  });
});
