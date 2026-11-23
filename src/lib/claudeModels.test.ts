import { describe, expect, it } from "vitest";
import type { ClaudeModelInfo } from "./types";
import {
  STATIC_CLAUDE_MODELS,
  CLI_EFFORT_RANKS,
  effectiveEffort,
  findClaudeModel,
  formatCheckedAgo,
  groupClaudeModels,
} from "./claudeModels";

const ALL = ["low", "medium", "high", "xhigh", "max"];

function m(value: string, resolved: string, display: string, levels: string[] = ALL): ClaudeModelInfo {
  return {
    value,
    resolved_model: resolved,
    display_name: display,
    description: "",
    supports_effort: levels.length > 0,
    effort_levels: levels,
  };
}

// What the CLI reported (trimmed).
const CATALOG: ClaudeModelInfo[] = [
  m("default", "claude-opus-5-5", "Default (recommended)"),
  m("opus", "claude-opus-5-5", "Opus 5.5"),
  m("fable", "claude-fable-5-1", "Fable 5.1"),
  m("sonnet", "claude-sonnet-5-5", "Sonnet 5.5"),
  m("haiku", "claude-haiku-4-5-20251001", "Haiku 4.5", []),
  m("claude-sonnet-5", "claude-sonnet-5", "Sonnet 5"),
  m("claude-opus-4-6", "claude-opus-4-6", "Opus 4.6", ["low", "medium", "high", "max"]),
];

describe("groupClaudeModels", () => {
  it("puts the aliases under Latest, labelled with what they resolve to, and the rest under Pinned", () => {
    const { latest, pinned } = groupClaudeModels(CATALOG);
    expect(latest.map((o) => [o.value, o.label])).toEqual([
      ["opus", "Opus — Opus 5.5"],
      ["fable", "Fable — Fable 5.1"],
      ["sonnet", "Sonnet — Sonnet 5.5"],
      ["haiku", "Haiku — Haiku 4.5"],
    ]);
    expect(pinned.map((o) => [o.value, o.label])).toEqual([
      ["claude-sonnet-5", "Sonnet 5"],
      ["claude-opus-4-6", "Opus 4.6"],
    ]);
  });

  it("labels the static fallback aliases by name only", () => {
    const { latest, pinned } = groupClaudeModels(STATIC_CLAUDE_MODELS);
    expect(latest.map((o) => o.label)).toEqual(["Haiku", "Sonnet", "Opus", "Fable"]);
    expect(pinned).toEqual([]);
  });
});

describe("findClaudeModel", () => {
  it("matches by value, then by resolved id", () => {
    expect(findClaudeModel(CATALOG, "sonnet")?.display_name).toBe("Sonnet 5.5");
    expect(findClaudeModel(CATALOG, "claude-haiku-4-5-20251001")?.value).toBe("haiku");
    expect(findClaudeModel(CATALOG, "claude-opus-4-1")).toBeUndefined();
  });
});

describe("effectiveEffort", () => {
  const haiku = findClaudeModel(CATALOG, "haiku");
  const opus46 = findClaudeModel(CATALOG, "claude-opus-4-6");

  it("is null for a model without effort support", () => {
    expect(effectiveEffort(haiku, "low")).toBeNull();
  });

  it("keeps a supported effort, and any effort of an unknown model", () => {
    expect(effectiveEffort(opus46, "max")).toBe("max");
    expect(effectiveEffort(undefined, "xhigh")).toBe("xhigh");
  });

  it("clamps an unsupported effort to the closest level (ties go lower)", () => {
    expect(effectiveEffort(opus46, "xhigh")).toBe("high");
    expect(effectiveEffort(m("x", "x", "x", ["medium", "high"]), "max")).toBe("high");
    expect(effectiveEffort(m("x", "x", "x", ["medium", "high"]), "low")).toBe("medium");
    expect(effectiveEffort(m("x", "x", "x", ["medium", "high"]), "ultra")).toBe("medium");
  });

  it("measures closeness on the given ranks (Codex has ultra on top)", () => {
    expect(effectiveEffort(m("x", "x", "x", ["medium", "high"]), "ultra", CLI_EFFORT_RANKS)).toBe("high");
    expect(effectiveEffort(m("x", "x", "x", ["low", "medium"]), "ultra", CLI_EFFORT_RANKS)).toBe("medium");
  });
});

describe("formatCheckedAgo", () => {
  const now = 1_000_000_000;
  it("stays honest as time passes", () => {
    expect(formatCheckedAgo(now, now)).toBe("just now");
    expect(formatCheckedAgo(now - 44_000, now)).toBe("just now");
    expect(formatCheckedAgo(now - 60_000, now)).toBe("1 min ago");
    expect(formatCheckedAgo(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(formatCheckedAgo(now - 2 * 3_600_000, now)).toBe("2 h ago");
    expect(formatCheckedAgo(now - 3 * 86_400_000, now)).toBe("3 d ago");
  });
});
