import { describe, expect, it } from "vitest";
import type { AgentSessionStatus } from "./types";
import { findSourcesSession, pillState } from "./sourcePills";

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

describe("pillState", () => {
  it("pillState table", () => {
    expect(pillState("notes", { provider: "openai", enabled: true, on: true })).toBe("hidden");
    expect(pillState("notes", { provider: "claude_cli", enabled: false, on: true })).toBe("hidden");
    expect(pillState("tools", { provider: "claude_cli", enabled: true, on: false })).toBe("off");
    expect(pillState("tools", { provider: "claude_cli", enabled: true, on: true })).toBe("on");
    expect(
      pillState("tools", { provider: "claude_cli", enabled: true, on: true, session: { state: "starting" } as AgentSessionStatus }),
    ).toBe("loading");
    expect(
      pillState("notes", { provider: "claude_cli", enabled: true, on: false, session: { state: "error" } as AgentSessionStatus }),
    ).toBe("error");
  });

  it("a pill that is off does not load while the session starts, and a ready session is just on or off", () => {
    const starting = { state: "starting" } as AgentSessionStatus;
    const ready = { state: "ready" } as AgentSessionStatus;
    expect(pillState("notes", { provider: "claude_cli", enabled: true, on: false, session: starting })).toBe("off");
    expect(pillState("notes", { provider: "claude_cli", enabled: true, on: true, session: ready })).toBe("on");
  });

  it("hidden wins over a failed session", () => {
    expect(
      pillState("notes", { provider: "openai", enabled: true, on: true, session: { state: "error" } as AgentSessionStatus }),
    ).toBe("hidden");
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
