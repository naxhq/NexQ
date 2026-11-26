import { describe, it, expect } from "vitest";
import { scenarios2 } from "./heldout-set2.fixtures";
import { evaluate } from "./heldout.harness";

describe("heldout eval (set 2)", () => {
  it("runs all scenarios", () => {
    expect(scenarios2.length).toBeGreaterThanOrEqual(50);
    expect(evaluate(scenarios2, "set2").length).toBeGreaterThan(0);
  });
});
