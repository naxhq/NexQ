import { describe, it, expect } from "vitest";
import { buildNoteIndex } from "../tokenize";
import { VoiceFollower } from "../follower";
import { ScrollController } from "../scroll";
import { runSuggestCase, summarise, type SuggestOutcome } from "./suggestion-runner";
import { splitUnits, joinUnits } from "./notes-and-runner";
import { groups } from "./suggestion-heldout.fixtures";
import { evaluate } from "./heldout.harness";
import { scenarios } from "./heldout-set1.fixtures";
import { scenarios2 } from "./heldout-set2.fixtures";
import { scenarios3 } from "./heldout-set3.fixtures";

const pct = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(0) + "%" : "n/a");
const report: string[] = [];
const emit = () => {
};

describe("suggestion held-out", () => {
  it("precision / recall / offered-or-moved per language", () => {
    const results: SuggestOutcome[] = [];
    for (const g of groups) for (const c of g.cases) results.push(runSuggestCase(c, g.notes));
    const by = summarise(results);
    const tot = { tp: 0, fp: 0, pos: 0, neg: 0, negFp: 0, either: 0 };
    report.push(`cases=${results.length} negatives=${results.filter((r) => r.expect === null).length}`);
    for (const [lang, g] of Object.entries(by)) {
      (Object.keys(tot) as (keyof typeof tot)[]).forEach((k) => (tot[k] += g[k]));
      report.push(`${lang}: n=${g.pos + g.neg} P=${pct(g.tp, g.tp + g.fp)} R=${pct(g.tp, g.pos)} offeredOrMoved=${pct(g.either, g.pos)} negFalseOffer=${pct(g.negFp, g.neg)} wrongOffers=${g.fp}`);
    }
    report.push(`ALL: P=${pct(tot.tp, tot.tp + tot.fp)} R=${pct(tot.tp, tot.pos)} offeredOrMoved=${pct(tot.either, tot.pos)} negFalseOffer=${pct(tot.negFp, tot.neg)} (fp=${tot.fp})`);
    const bad = results.filter((r) => (r.expect === null && r.offered !== null) || (r.expect !== null && r.offered !== null && r.offered !== r.expect));
    report.push("wrong offers: " + bad.map((r) => `${r.name}->${r.offered}`).join(" | "));
    const missed = results.filter((r) => r.expect !== null && r.offered !== r.expect && !r.moved);
    report.push("missed (no offer, no move): " + missed.map((r) => `${r.name}${r.offered ? "(offered " + r.offered + ")" : ""}`).join(" | "));
    const seenWrong = results.filter((r) => r.wrongSeen).length;
    report.push(`wrong block ever shown while speaking: ${seenWrong}/${results.length}`);
    emit();
    // generous floors only
    expect(results.length).toBeGreaterThanOrEqual(140);
    expect(tot.negFp / tot.neg).toBeLessThan(0.5);
    expect(tot.tp / Math.max(1, tot.tp + tot.fp)).toBeGreaterThan(0.3);
    expect(tot.either / tot.pos).toBeGreaterThan(0.2);
  });

  it("automatic behaviour is unchanged on the earlier held-out sets (sets 1 to 3 replay)", () => {
    const sets: [string, Parameters<typeof evaluate>[0], number][] = [["set1", scenarios, 97], ["set2", scenarios2, 97], ["set3", scenarios3, 90]];
    for (const [label, sc, floor] of sets) {
      const lines = evaluate(sc, label);
      const m = /checkpoints ok=([\d.]+)% .*confident-wrong=([\d.]+)% \((\d+)\)/.exec(lines[1]);
      report.push(`replay ${label}: ${lines[1]} | ${lines.find((l) => l.startsWith("jumps"))}`);
      expect(Number(m![1])).toBeGreaterThanOrEqual(floor);
    }
    emit();
  });

  it("a suggestion on screen must not freeze the scroll of a speaker who is on script", () => {
    const cjk = (s: string) => /[぀-ヿ㐀-鿿가-힯]/.test(s) && !/\s/.test(s.trim());
    let updates = 0, shown = 0, frozen = 0, maxRun = 0, scenariosHit = 0;
    const hitNames: string[] = [];
    let missedByScroll = 0; // scroll target held while the follower was within the right place
    for (const sc of [...scenarios, ...scenarios2, ...scenarios3]) {
      if (sc.neg) continue;
      const idx = buildNoteIndex(sc.blocks);
      let t = 1_000_000;
      const f = new VoiceFollower(idx, { clock: () => t });
      const scroll = new ScrollController({ clock: () => t });
      let run = 0, hit = false, seg = 0;
      const pos = (b: number, fr: number) => idx.blocks[b].first + fr * (idx.blocks[b].end - idx.blocks[b].first);
      for (const st of sc.steps) {
        if (st.t === "pause") { t += st.ms; run = 0; continue; }
        const mode = cjk(st.text) ? "ja" : "en";
        const u = splitUnits(st.text, mode);
        const id = `s${seg++}`;
        const onScript = st.t === "say" && !st.jump;
        const target = st.t === "say" ? pos(st.b, st.f1) : 0;
        const feed = (snap: ReturnType<VoiceFollower["snapshot"]>) => {
          scroll.setVoice(snap.position, snap.state);
          if (!onScript) { run = 0; return; }
          updates++;
          if (snap.suggestion) {
            shown++;
            if (snap.state !== "following") { frozen++; run++; hit = true; maxRun = Math.max(maxRun, run); if (Math.abs(snap.position - target) <= 8) missedByScroll++; }
            else run = 0;
          } else run = 0;
        };
        for (let i = 3; i < u.length; i += 3) { t += 1200; feed(f.onInterim(joinUnits(u.slice(0, i), mode), id)); }
        t += 400; feed(f.onFinal(st.text, id));
      }
      if (hit) { scenariosHit++; hitNames.push(sc.name); }
    }
    report.push(`freeze check (on-script updates=${updates}): suggestion shown=${pct(shown, updates)} (${shown}), shown AND state!=following (scroll held)=${pct(frozen, updates)} (${frozen}), longest consecutive held run=${maxRun} updates, scenarios affected=${scenariosHit}, of which follower was at the right place=${missedByScroll}: ${hitNames.join(",")}`);
    emit();
    expect(shown / updates).toBeLessThan(0.3);
  });
});
