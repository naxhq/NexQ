import { describe, expect, it } from "vitest";
import type { AgentSessionStatus, AssistSources } from "./types";
import { findSourcesSession, holdsKnowledge, holdsTools, knowledgeIncludes, pillCard, pillState, toolsIncludes } from "./sourcePills";

const session = (over: Partial<AgentSessionStatus>): AgentSessionStatus =>
  ({
    scope: "live",
    meeting_id: "m1",
    tier: "fast",
    state: "ready",
    model: "haiku",
    detail: null,
    error_kind: null,
    with_sources: true,
    sources_notice: null,
    ...over,
  }) as AgentSessionStatus;

const info = (over: Partial<AssistSources> = {}): AssistSources => ({
  workspace_id: "w1",
  documents: 3,
  notes: 1,
  folders: [{ label: "DePaul", used: true }],
  servers: [{ label: "mira", allowed_tools: 9, total_tools: 19, usable: true }],
  ...over,
});

describe("pillState", () => {
  it("pillState table", () => {
    // Nothing of its kind in the meeting's workspace: hidden, on any provider.
    expect(pillState("knowledge", { provider: "claude_cli", held: false, on: true })).toBe("hidden");
    expect(pillState("tools", { provider: "claude_cli", held: false, on: true })).toBe("hidden");
    // Knowledge works with every provider, API ones included.
    for (const provider of ["claude_cli", "antigravity_cli", "codex_cli", "openai", "gemini"]) {
      expect(pillState("knowledge", { provider, held: true, on: true })).toBe("on");
      expect(pillState("knowledge", { provider, held: true, on: false })).toBe("off");
    }
    // Tools need a subscription CLI agent; on an API provider the pill is shown but cannot be used.
    for (const provider of ["claude_cli", "antigravity_cli", "codex_cli"]) {
      expect(pillState("tools", { provider, held: true, on: true })).toBe("on");
      expect(pillState("tools", { provider, held: true, on: false })).toBe("off");
    }
    expect(pillState("tools", { provider: "openai", held: true, on: true })).toBe("unavailable");
    expect(pillState("tools", { provider: "openai", held: true, on: false })).toBe("unavailable");
    expect(
      pillState("tools", { provider: "claude_cli", held: true, on: true, session: { state: "starting" } as AgentSessionStatus }),
    ).toBe("loading");
    expect(
      pillState("knowledge", { provider: "claude_cli", held: true, on: false, session: { state: "error" } as AgentSessionStatus }),
    ).toBe("error");
  });

  it("a pill that is off does not load while the session starts, and a ready session is just on or off", () => {
    const starting = { state: "starting" } as AgentSessionStatus;
    const ready = { state: "ready" } as AgentSessionStatus;
    expect(pillState("knowledge", { provider: "claude_cli", held: true, on: false, session: starting })).toBe("off");
    expect(pillState("knowledge", { provider: "claude_cli", held: true, on: true, session: ready })).toBe("on");
  });

  it("hidden wins over a failed session, and an API provider never shows a session's error", () => {
    const failed = { state: "error" } as AgentSessionStatus;
    expect(pillState("knowledge", { provider: "claude_cli", held: false, on: true, session: failed })).toBe("hidden");
    expect(pillState("knowledge", { provider: "openai", held: true, on: true, session: failed })).toBe("on");
  });
});

describe("what the pills cover", () => {
  it("names the Knowledge of the workspace: documents, notes and the folders that are used", () => {
    expect(knowledgeIncludes(info())).toBe("3 documents, 1 note, 1 folder (DePaul)");
    expect(knowledgeIncludes(info({ documents: 1, notes: 0, folders: [] }))).toBe("1 document");
    expect(knowledgeIncludes(info({ documents: 0, notes: 0, folders: [{ label: "A", used: true }, { label: "B", used: false }] }))).toBe("1 folder (A)");
    expect(knowledgeIncludes(info({ documents: 0, notes: 0, folders: [] }))).toBe("");
  });

  it("names the Tools of the workspace with their allowed tools", () => {
    expect(toolsIncludes(info())).toBe("mira (9 of 19 tools)");
    expect(
      toolsIncludes(info({ servers: [{ label: "a", allowed_tools: 1, total_tools: 1, usable: true }, { label: "b", allowed_tools: 0, total_tools: 4, usable: false }] })),
    ).toBe("a (1 of 1 tools)");
  });

  it("a pill shows only when the workspace holds something of its kind", () => {
    expect(holdsKnowledge(info())).toBe(true);
    expect(holdsKnowledge(info({ documents: 0, notes: 0, folders: [{ label: "x", used: false }] }))).toBe(false);
    expect(holdsKnowledge(undefined)).toBe(false);
    expect(holdsTools(info())).toBe(true);
    expect(holdsTools(info({ servers: [{ label: "x", allowed_tools: 0, total_tools: 2, usable: false }] }))).toBe(false);
  });

  it("the hover card says what is covered, what on and off do, and where the provider limits it", () => {
    const k = pillCard("knowledge", info(), "claude_cli");
    expect(k.title).toBe("Knowledge");
    expect(k.includes).toBe("3 documents, 1 note, 1 folder (DePaul)");
    expect(k.on).toMatch(/can use/);
    expect(k.off).toMatch(/Nothing .* is sent/);
    expect(k.limit).toMatch(/Claude/);
    // an API provider: the folders are searched and passages are sent
    expect(pillCard("knowledge", info(), "openai").limit).toMatch(/searches the folders/);
    // no folders: nothing to say about them
    expect(pillCard("knowledge", info({ folders: [] }), "openai").limit).toBeNull();
    // a folder switched off in Settings is named as such
    expect(pillCard("knowledge", info({ folders: [{ label: "Wiki", used: false }] }), "openai").includes).toMatch(/Off in Settings: Wiki/);
    const t = pillCard("tools", info(), "claude_cli");
    expect(t.includes).toBe("mira (9 of 19 tools)");
    expect(t.limit).toBeNull();
    expect(pillCard("tools", info(), "openai").limit).toMatch(/Claude, Codex or Antigravity subscription/);
  });
});

describe("findSourcesSession", () => {
  const live = session({});
  const plain = session({ with_sources: false });
  const past = session({ scope: "past", meeting_id: "p1", tier: "deep" });
  const sessions = {
    "live:m1:fast": plain,
    "live:m1:fast:sources": live,
    "past:p1:deep:sources": past,
  };

  it("finds the Fast with-sources session of the live meeting, never the plain one", () => {
    expect(findSourcesSession(sessions, "live")).toBe(live);
    expect(findSourcesSession({ "live:m1:fast": plain }, "live")).toBeUndefined();
  });

  it("finds the Deep with-sources session of that past meeting only", () => {
    expect(findSourcesSession(sessions, "past", "p1")).toBe(past);
    expect(findSourcesSession(sessions, "past", "other")).toBeUndefined();
  });

  it("takes the Fast session of a past meeting when Fast and Deep share their settings, and prefers Deep", () => {
    const pastFast = session({ scope: "past", meeting_id: "p1", tier: "fast" });
    expect(findSourcesSession({ "past:p1:fast:sources": pastFast }, "past", "p1")).toBe(pastFast);
    expect(findSourcesSession({ a: pastFast, b: past }, "past", "p1")).toBe(past);
    expect(findSourcesSession({ b: past, a: pastFast }, "past", "p1")).toBe(past);
    // Another meeting's session is never taken.
    expect(findSourcesSession({ a: session({ scope: "past", meeting_id: "x", tier: "fast" }) }, "past", "p1")).toBeUndefined();
  });
});
