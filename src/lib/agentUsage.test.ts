import { describe, expect, it } from "vitest";
import {
  EMPTY_USAGE,
  avgFirstTokenMs,
  avgLatencyMs,
  formatAgo,
  formatDuration,
  formatTokenUsage,
  formatUsageSummary,
  lastAnswerTooltip,
  promptTokens,
  formatCostEstimate,
  usageAttribution,
  NEUTRAL_AGENT_LABEL,
  isApiKeyLogin,
  isOutdated,
  outdatedLine,
  outdatedNote,
  updateCommand,
  updateShell,
  versionNumber,
} from "./agentUsage";

describe("formatDuration", () => {
  it.each([
    [0, "0 ms"],
    [850, "850 ms"],
    [999, "999 ms"],
    [1000, "1.0 s"],
    [1234, "1.2 s"],
    [9_960, "10.0 s"],
    [30_189, "30 s"],
    [125_000, "2 min 5 s"],
    [120_000, "2 min"],
  ])("%d ms → %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });

  it("guards against nonsense", () => {
    expect(formatDuration(-1)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
  });
});

describe("formatAgo", () => {
  it("is relative and coarse", () => {
    const now = 1_000_000;
    expect(formatAgo(now - 3_000, now)).toBe("just now");
    expect(formatAgo(now - 40_000, now)).toBe("40 s ago");
    expect(formatAgo(now - 125_000, now)).toBe("2 min ago");
    expect(formatAgo(now - 3 * 3_600_000, now)).toBe("3 h ago");
  });
});

describe("usage formatting", () => {
  const usage = {
    ...EMPTY_USAGE,
    input_tokens: 210,
    cache_read_tokens: 38_000,
    cache_write_tokens: 7_000,
    output_tokens: 1_240,
    thinking_tokens: 300,
    cost_usd: 0.31,
    requests: 3,
    total_latency_ms: 4_200,
    total_first_token_ms: 1_800,
  };

  it("counts cache reads and writes as prompt tokens", () => {
    expect(promptTokens(usage)).toBe(45_210);
    expect(formatTokenUsage(usage)).toBe("in 45,210 (38,000 cached) · out 1,240 (thinking 300)");
    expect(formatTokenUsage({ ...EMPTY_USAGE, input_tokens: 5, output_tokens: 2 })).toBe("in 5 · out 2");
  });

  it("summarises requests, tokens and the average response time", () => {
    expect(formatUsageSummary(usage)).toBe("3 requests · 45,210 in (38,000 cached) / 1,240 out · avg 1.4 s");
    expect(formatUsageSummary({ ...EMPTY_USAGE, requests: 1, input_tokens: 9, output_tokens: 1, total_latency_ms: 800 })).toBe(
      "1 request · 9 in / 1 out · avg 800 ms",
    );
    expect(formatUsageSummary(EMPTY_USAGE)).toBe("0 requests · 0 in / 0 out");
  });

  it("averages per answered request", () => {
    expect(avgLatencyMs(usage)).toBe(1_400);
    expect(avgFirstTokenMs(usage)).toBe(600);
    expect(avgLatencyMs(EMPTY_USAGE)).toBeNull();
  });

  it("describes the last answer for the footer tooltip", () => {
    expect(lastAnswerTooltip(1_200, 600)).toBe("Last answer: 1.2 s total, first words after 600 ms");
    expect(lastAnswerTooltip(31_000, null)).toBe("Last answer: 31 s total");
  });
});

describe("usageAttribution", () => {
  const apiBilledStatus = {
    installed: true,
    binary_path: null,
    version: null,
    npm_only: false, required_version: null,
    auth: { logged_in: true, auth_method: "api_key", subscription_type: null, email: null, login: "api_billed" as const },
  };
  const name = (p: string) => (p === "codex_cli" ? "Codex" : p);
  const isAgent = (p: string) => p === "codex_cli" || p === "claude_cli";

  it("names the active CLI agent and its billing", () => {
    expect(usageAttribution("codex_cli", {}, name, isAgent)).toEqual({ label: "Codex", apiBilled: false });
    expect(usageAttribution("claude_cli", { claude_cli: apiBilledStatus }, name, isAgent).apiBilled).toBe(true);
  });

  it("is neutral, with no billing claim, while an API provider is active", () => {
    const r = usageAttribution("openai", { claude_cli: apiBilledStatus }, name, isAgent);
    expect(r).toEqual({ label: NEUTRAL_AGENT_LABEL, apiBilled: null });
    expect(formatCostEstimate({ ...EMPTY_USAGE, cost_usd: 0.5 }, r.apiBilled)).toBe("≈ $0.50 estimate");
    expect(formatCostEstimate({ ...EMPTY_USAGE, cost_usd: 0.5 })).toContain("included in your subscription");
  });

  it("an API-key login is not logged in", () => {
    expect(isApiKeyLogin({ ...apiBilledStatus, auth: { ...apiBilledStatus.auth, logged_in: false, login: "logged_out" } })).toBe(true);
    expect(isApiKeyLogin(apiBilledStatus)).toBe(false);
  });
});

describe("outdated Claude Code", () => {
  const base = {
    installed: true,
    binary_path: "C:\\Users\\me\\.local\\bin\\claude.exe",
    version: "2.1.206 (Claude Code)",
    auth: null,
    npm_only: false,
    required_version: "2.1.259",
  };

  it("is outdated only when installed and the backend names a required version", () => {
    expect(isOutdated(base)).toBe(true);
    expect(isOutdated({ ...base, required_version: null })).toBe(false);
    expect(isOutdated({ ...base, installed: false })).toBe(false);
    expect(isOutdated(undefined)).toBe(false);
    expect(isOutdated(null)).toBe(false);
  });

  it("shows just the version number", () => {
    expect(versionNumber("2.1.206 (Claude Code)")).toBe("2.1.206");
    expect(versionNumber("2.1.206")).toBe("2.1.206");
    expect(versionNumber("nope")).toBeNull();
    expect(versionNumber(null)).toBeNull();
    expect(outdatedLine(base)).toBe("Claude Code 2.1.206 is too old");
    expect(outdatedLine({ ...base, version: null })).toBe("Claude Code is too old");
  });

  it("says what to do, with the required version", () => {
    expect(outdatedNote(base)).toBe("NexQ needs Claude Code 2.1.259 or newer. Update it, then check the connection.");
  });

  it("builds the update command for the platform of the path", () => {
    expect(updateCommand("C:\\Users\\me\\.local\\bin\\claude.exe")).toBe("& 'C:\\Users\\me\\.local\\bin\\claude.exe' update");
    expect(updateCommand("D:/tools/claude.exe")).toBe("& 'D:/tools/claude.exe' update");
    expect(updateCommand("\\\\server\\tools\\claude.exe")).toBe("& '\\\\server\\tools\\claude.exe' update");
    expect(updateCommand("/Users/me/.local/bin/claude")).toBe("'/Users/me/.local/bin/claude' update");
    // A quote in the path is escaped the way each shell does it.
    expect(updateCommand("C:\\Users\\O'Brien\\claude.exe")).toBe("& 'C:\\Users\\O''Brien\\claude.exe' update");
    expect(updateCommand("/Users/O'Brien/claude")).toBe("'/Users/O'\\''Brien/claude' update");
    expect(updateShell("\\\\server\\tools\\claude.exe")).toBe("PowerShell");
    expect(updateShell("/usr/local/bin/claude")).toBe("a terminal");
  });
});
