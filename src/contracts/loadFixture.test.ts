import { describe, expect, it } from "vitest";
import { fixtureNames, loadFixture } from "./loadFixture";

describe("contract fixtures", () => {
  it("loads each one as an object or list", () => {
    const names = fixtureNames();
    expect(names.length).toBeGreaterThan(40);
    for (const n of names) expect(typeof loadFixture(n)).toBe("object");
  });
  it("refuses an unknown name", () => {
    expect(() => loadFixture("nope")).toThrow(/no contract fixture/);
  });
});
