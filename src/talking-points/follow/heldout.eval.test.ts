import { describe, it, expect } from "vitest";
import * as fs from "fs";
import { buildNoteIndex, VoiceFollower, SaidTracker } from "./index";
import { scenarios, type Scenario, type Step } from "./heldout.fixtures";

const TOL = 8;
const isCjk = (s: string) => /[぀-ヿ㐀-鿿가-힯]/.test(s) && !/\s/.test(s.trim());
const units = (text: string): string[] => {
  if (isCjk(text)) { const o: string[] = []; for (let i = 0; i < text.length; i += 3) o.push(text.slice(i, i + 3)); return o; }
  return text.split(/\s+/).filter(Boolean);
};
const join = (u: string[], cjk: boolean) => u.join(cjk ? "" : " ");

// ---- seeded corrupter
function rng(seed: number) { let a = seed; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const NEAR: Record<string, string[]> = {
  to: ["two", "too"], for: ["four"], new: ["knew", "gnu"], three: ["tree", "free"], quarter: ["court", "quarto"], revenue: ["revenew", "avenue"],
  year: ["ear", "yeah"], the: ["a", "this"], and: ["an", "in"], team: ["teem", "theme"], hiring: ["hiding", "hurrying"], five: ["fine", "fife"],
  engineers: ["engineer", "in gears"], grew: ["grow", "crew"], twelve: ["twelfth", "twelve"], mobile: ["mobil", "noble"], app: ["up", "ap"],
  launches: ["lunches", "launch"], key: ["he", "quay"], risk: ["risks", "wrist"], supply: ["supplies", "apply"], chain: ["train", "chin"],
  delay: ["delayed", "delay"], vendor: ["vender", "window"], next: ["nest", "text"], steps: ["step", "stems"], pilot: ["pile it", "pilots"],
  budget: ["budge it", "buzzed"], review: ["revue", "reviews"], welcome: ["well come", "welcomed"], everyone: ["every one", "everybody"],
  thanks: ["thank", "tanks"], joining: ["joint", "joined"], today: ["to day", "tonight"], percent: ["per cent", "present"], going: ["goin", "gone"],
};
function corrupt(text: string, wer: number, r: () => number): string {
  const out: string[] = [];
  const ws = text.split(/\s+/).filter(Boolean);
  for (const w of ws) {
    const x = r();
    if (x >= wer) { out.push(w); continue; }
    const k = r();
    if (k < 0.55) { const near = NEAR[w.toLowerCase()]; out.push(near ? near[Math.floor(r() * near.length)] : w.length > 3 ? w.slice(0, -1) + "e" : w + "s"); }
    else if (k < 0.8) { /* deletion */ }
    else { out.push(w); out.push(["uh", "the", "so", "and", "um", "like"][Math.floor(r() * 6)]); }
  }
  return out.length ? out.join(" ") : ws[0];
}

// ---- run
interface Check { sc: string; lang: string; step: number; text: string; exp: number; pos: number; state: string; diff: number; ok: boolean; confWrong: boolean; off: boolean; neg: boolean }
interface Relock { sc: string; lang: string; words: number | null }
const checks: Check[] = [];
const relocks: Relock[] = [];
const saidRes: { sc: string; lang: string; tp: number; fp: number; fn: number; wrongIds: string[] }[] = [];

function run(sc: Scenario, seedBase: number) {
  const idx = buildNoteIndex(sc.blocks);
  let now = 1_000_000;
  const f = new VoiceFollower(idx, { clock: () => now });
  const t = new SaidTracker(idx, { clock: () => now });
  const pos = (b: number, fr: number) => idx.blocks[b].first + Math.round(fr * (idx.blocks[b].end - idx.blocks[b].first));
  const r = rng(seedBase);
  let prevExp = 0;
  let seg = 0;
  sc.steps.forEach((st: Step, si: number) => {
    if (st.t === "pause") { now += st.ms; return; }
    seg++;
    const segId = `${sc.name}#${seg}`;
    let text = st.text;
    if (sc.wer && st.t === "say") text = corrupt(text, sc.wer, r);
    const cjk = isCjk(text);
    const u = units(text);
    const isOff = st.t === "off";
    const start = st.t === "say" ? pos(st.b, st.f0) : prevExp;
    const end = st.t === "say" ? pos(st.b, st.f1) : prevExp;
    const feeds: string[] = [];
    if (st.t === "say" && st.interims) feeds.push(...st.interims);
    else if (!(st.t === "say" && st.mode === "final")) for (let k = 3; k < u.length; k += 3) feeds.push(join(u.slice(0, k), cjk));
    let spent = 0;
    const jump = st.t === "say" && !!st.jump;
    let relockDone = false;
    const total = u.length;
    const probe = (snap: { position: number; state: string }, wordsSoFar: number) => {
      if (jump && !relockDone) {
        const e = start + (end - start) * Math.min(1, wordsSoFar / total);
        if (Math.abs(snap.position - e) <= TOL && snap.state === "following") { relockDone = true; relocks.push({ sc: sc.name, lang: sc.lang, words: wordsSoFar }); }
      }
    };
    feeds.forEach((ft, k) => {
      const w = st.t === "say" && st.interims ? units(ft).length : Math.min(total, 3 * (k + 1));
      now += 400 * Math.max(1, w - spent); spent = w;
      const snap = f.onInterim(ft, segId); t.onInterim(ft, segId);
      probe(snap, w);
    });
    now += 400 * Math.max(0, total - spent);
    const snap = f.onFinal(text, segId); t.onFinal(text, segId);
    probe(snap, total);
    if (jump && !relockDone) relocks.push({ sc: sc.name, lang: sc.lang, words: null });
    const diff = Math.abs(snap.position - end);
    const ok = diff <= TOL || snap.state !== "following";
    checks.push({ sc: sc.name, lang: sc.lang, step: si, text, exp: end, pos: snap.position, state: snap.state, diff, ok, confWrong: snap.state === "following" && diff > TOL, off: isOff, neg: !!sc.neg });
    prevExp = end;
  });
  const said = new Set(t.saidBlockIds());
  const truth = new Set(sc.said);
  const ignore = sc.name === "en-headings" ? new Set(["h1", "h2", "h5"]) : new Set<string>();
  let tp = 0, fp = 0, fn = 0; const wrongIds: string[] = [];
  for (const b of sc.blocks) {
    if (ignore.has(b.id)) continue;
    const s = said.has(b.id), g = truth.has(b.id);
    if (s && g) tp++; else if (s && !g) { fp++; wrongIds.push("+" + b.id); } else if (!s && g) { fn++; wrongIds.push("-" + b.id); }
  }
  saidRes.push({ sc: sc.name, lang: sc.lang, tp, fp, fn, wrongIds });
}

const pct = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(1) + "%" : "n/a");
describe("heldout eval", () => {
  it("runs all scenarios and writes a report", () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(40);
    scenarios.forEach((sc, i) => run(sc, 1000 + i));
    const lines: string[] = [];
    const agg = (cs: Check[]) => ({ n: cs.length, ok: cs.filter((c) => c.ok).length, cw: cs.filter((c) => c.confWrong).length, strictOk: cs.filter((c) => c.diff <= TOL).length });
    const A = agg(checks);
    lines.push(`scenarios=${scenarios.length} checkpoints=${A.n}`);
    lines.push(`checkpoint ok (within +-${TOL} or not following)=${pct(A.ok, A.n)}  within +-${TOL} strictly=${pct(A.strictOk, A.n)}  confident-wrong=${pct(A.cw, A.n)}`);
    const nonNeg = agg(checks.filter((c) => !c.neg));
    const negC = agg(checks.filter((c) => c.neg));
    lines.push(`  on-script: ok=${pct(nonNeg.ok, nonNeg.n)} strict=${pct(nonNeg.strictOk, nonNeg.n)} cw=${pct(nonNeg.cw, nonNeg.n)} | negative controls: ok=${pct(negC.ok, negC.n)} cw=${pct(negC.cw, negC.n)}`);
    const offC = agg(checks.filter((c) => c.off && !c.neg));
    lines.push(`  off-script segments inside real talks: ok=${pct(offC.ok, offC.n)} cw=${pct(offC.cw, offC.n)} (n=${offC.n})`);
    const wers = [0.05, 0.15, 0.25];
    for (const w of wers) { const cs = checks.filter((c) => scenarios.find((s) => s.name === c.sc)?.wer === w); const a = agg(cs); lines.push(`  WER ${w * 100}%: ok=${pct(a.ok, a.n)} strict=${pct(a.strictOk, a.n)} cw=${pct(a.cw, a.n)}`); }
    const langs = [...new Set(scenarios.map((s) => s.lang))];
    lines.push("per language (checkpoint ok / strict / confident-wrong | said P / R):");
    for (const l of langs) {
      const a = agg(checks.filter((c) => c.lang === l));
      const s = saidRes.filter((x) => x.lang === l);
      const tp = s.reduce((x, y) => x + y.tp, 0), fp = s.reduce((x, y) => x + y.fp, 0), fn = s.reduce((x, y) => x + y.fn, 0);
      lines.push(`  ${l}: ${pct(a.ok, a.n)} / ${pct(a.strictOk, a.n)} / ${pct(a.cw, a.n)} (n=${a.n}) | P=${pct(tp, tp + fp)} R=${pct(tp, tp + fn)}`);
    }
    const tp = saidRes.reduce((x, y) => x + y.tp, 0), fp = saidRes.reduce((x, y) => x + y.fp, 0), fn = saidRes.reduce((x, y) => x + y.fn, 0);
    lines.push(`said overall: precision=${pct(tp, tp + fp)} recall=${pct(tp, tp + fn)} (tp=${tp} fp=${fp} fn=${fn})`);
    const got = relocks.filter((x) => x.words != null).map((x) => x.words as number).sort((a, b) => a - b);
    lines.push(`relock after jump: ${got.length}/${relocks.length} re-locked; median=${got.length ? got[Math.floor(got.length / 2)] : "n/a"} words, max=${got.length ? got[got.length - 1] : "n/a"}; per scenario: ` + relocks.map((x) => `${x.sc}:${x.words ?? "never"}`).join(", "));
    const worst = [...checks].filter((c) => !c.ok).sort((a, b) => b.diff - a.diff);
    lines.push(`worst confident-wrong checkpoints (${worst.length} total):`);
    const seen = new Set<string>();
    for (const c of worst) { if (seen.has(c.sc)) continue; seen.add(c.sc); if (seen.size > 8) break; lines.push(`  ${c.sc} step${c.step} [${c.state}] pos=${c.pos} exp=${c.exp} diff=${c.diff} :: "${c.text.slice(0, 70)}"`); }
    const badSaid = saidRes.filter((x) => x.fp + x.fn > 0);
    lines.push(`said errors (${badSaid.length} scenarios): ` + badSaid.map((x) => `${x.sc}[${x.wrongIds.join(",")}]`).join(" "));
    const nonFollowing = checks.filter((c) => !c.neg && !c.off && c.state !== "following" && c.diff > TOL);
    lines.push(`on-script misses that were safely unsure/lost: ${nonFollowing.length}`);
    fs.mkdirSync(".agent-logs", { recursive: true });
    fs.writeFileSync(".agent-logs/heldout-results.txt", lines.join("\n"));
    fs.writeFileSync(".agent-logs/heldout-checks.json", JSON.stringify(checks, null, 1));
    expect(lines.length).toBeGreaterThan(0);
  });
});
