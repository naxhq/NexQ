import { describe, expect, it } from "vitest";
import { agentSessionKey } from "./agentStore";

describe("agentSessionKey", () => {
  const base = { scope: "live", meeting_id: "m", tier: "fast" } as const;

  it("keys a with-sources session apart from the plain one", () => {
    expect(agentSessionKey({ ...base, with_sources: true })).toBe("live:m:fast:sources");
    expect(agentSessionKey({ ...base, with_sources: false })).toBe("live:m:fast");
  });

  it("keeps the plain key for a status without the flag", () => {
    expect(agentSessionKey(base)).toBe("live:m:fast");
    expect(agentSessionKey({ scope: "utility", meeting_id: null, tier: "fast" })).toBe("utility::fast");
  });
});
