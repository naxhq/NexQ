import { describe, it, expect } from "vitest";
import { scenarios3 } from "./heldout-set3.fixtures";
import { evaluate } from "./heldout.harness";

describe("heldout eval (set 3)", () => {
  it("runs all scenarios", () => {
    expect(scenarios3.length).toBeGreaterThanOrEqual(40);
    expect(evaluate(scenarios3, "set3").length).toBeGreaterThan(0);
  });
});
