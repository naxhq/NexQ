import { describe, expect, it } from "vitest";
import { releaseWave } from "./releaseWave.mjs";

describe("releaseWave", () => {
  it("draws the same wave for the same version", () => {
    expect(releaseWave("2.34.0")).toEqual(releaseWave("2.34.0"));
  });

  it("draws a different wave for each version", () => {
    expect(releaseWave("2.34.0")).not.toEqual(releaseWave("2.34.1"));
  });

  it("gives exactly the bars asked for, all drawable", () => {
    for (const version of ["2.34.0", "0.0.1", "10.20.30"]) {
      const wave = releaseWave(version, 72);
      expect(wave).toHaveLength(72);
      for (const bar of wave) {
        expect(bar).toBeGreaterThan(0);
        expect(bar).toBeLessThanOrEqual(1);
      }
    }
  });

  it("has real height to it, not a flat line", () => {
    const wave = releaseWave("2.34.0");
    expect(Math.max(...wave)).toBeGreaterThan(0.5);
    expect(Math.min(...wave)).toBeLessThan(0.2);
  });
});
