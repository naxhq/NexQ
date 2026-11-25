import { describe, it, expect } from "vitest";
import { scenarios } from "./heldout.fixtures";
import { evaluate } from "./heldout.harness";

describe("heldout eval (set 1)", () => {
  it("runs all scenarios", () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(40);
    expect(evaluate(scenarios, "set1").length).toBeGreaterThan(0);
  });
});
