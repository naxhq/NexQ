import { describe, it, expect } from "vitest";
// @ts-ignore node types are not part of the app tsconfig; only the eval tests write their report
import { mkdirSync, writeFileSync } from "node:fs";
import { runScenario, ScenarioResult } from "./fixtures";
import { SCENARIOS } from "./scenarios";

const results: ScenarioResult[] = [];

describe("follow evals", () => {
  for (const sc of SCENARIOS) {
    it(sc.name, () => {
      const r = runScenario(sc);
      results.push(r);
      const bad = r.checkpoints
        .map((c, i) => ({ ...c, i }))
        .filter((c) => !c.acceptable)
        .map((c) => `step ${c.i}: pos ${c.pos.toFixed(1)} truth ${c.truth} ${c.state}`);
      // Per scenario floor; aggregate targets are asserted below.
      const ok = r.checkpoints.filter((c) => c.acceptable).length / Math.max(1, r.checkpoints.length);
      expect(ok, bad.join(" | ")).toBeGreaterThanOrEqual(0.75);
    });
  }

  it("aggregate: following accuracy and said-it precision/recall", () => {
    let n = 0;
    let strict = 0;
    let acceptable = 0;
    let confWrong = 0;
    let tp = 0;
    let fp = 0;
    let fn = 0;
    const lines: string[] = ["scenario | cps | strict | ok | confWrong | said TP/FP/FN"];
    for (const r of results) {
      const cp = r.checkpoints;
      const s = cp.filter((c) => c.strict).length;
      const a = cp.filter((c) => c.acceptable).length;
      const w = cp.filter((c) => c.confidentWrong).length;
      let t = 0;
      let f = 0;
      let m = 0;
      for (const id of r.ticked) (r.expectedSaid.has(id) ? t++ : f++);
      for (const id of r.expectedSaid) if (!r.ticked.has(id)) m++;
      n += cp.length;
      strict += s;
      acceptable += a;
      confWrong += w;
      tp += t;
      fp += f;
      fn += m;
      lines.push(`${r.name} | ${cp.length} | ${s} | ${a} | ${w} | ${t}/${f}/${m}`);
    }
    const precision = tp / Math.max(1, tp + fp);
    const recall = tp / Math.max(1, tp + fn);
    lines.push(
      `TOTAL checkpoints=${n} strict=${(strict / n).toFixed(3)} correctOrHolding=${(acceptable / n).toFixed(3)} confidentWrong=${(confWrong / n).toFixed(3)} said precision=${precision.toFixed(3)} recall=${recall.toFixed(3)} (TP ${tp} FP ${fp} FN ${fn})`,
    );
    mkdirSync(".agent-logs", { recursive: true });
    writeFileSync(".agent-logs/follow-eval-table.txt", lines.join("\n"));
    expect(results.length).toBe(SCENARIOS.length);
    expect(acceptable / n).toBeGreaterThanOrEqual(0.95);
    expect(precision).toBeGreaterThanOrEqual(0.95);
    expect(recall).toBeGreaterThanOrEqual(0.8);
  });

  it("never rewinds during a verbatim read", () => {
    for (const r of results.filter((x) => x.name.includes("verbatim"))) expect(r.backJumps, r.name).toBe(0);
  });
});
