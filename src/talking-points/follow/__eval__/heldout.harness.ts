// Shared runner for the held-out evals (blind: uses only the public API).
import { buildNoteIndex, VoiceFollower, SaidTracker } from "../index";
import type { Scenario, Step } from "./heldout-set1.fixtures";

export const TOL = 8;
const isCjk = (s: string) => /[぀-ヿ㐀-鿿가-힯]/.test(s) && !/\s/.test(s.trim());
const units = (text: string): string[] => {
  if (isCjk(text)) { const o: string[] = []; for (let i = 0; i < text.length; i += 3) o.push(text.slice(i, i + 3)); return o; }
  return text.split(/\s+/).filter(Boolean);
};
const join = (u: string[], cjk: boolean) => u.join(cjk ? "" : " ");

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
    if (r() >= wer) { out.push(w); continue; }
    const k = r();
    if (k < 0.55) { const near = NEAR[w.toLowerCase()]; out.push(near ? near[Math.floor(r() * near.length)] : w.length > 3 ? w.slice(0, -1) + "e" : w + "s"); }
    else if (k < 0.8) { /* deletion */ }
    else { out.push(w); out.push(["uh", "the", "so", "and", "um", "like"][Math.floor(r() * 6)]); }
  }
  return out.length ? out.join(" ") : ws[0];
}

interface Check { sc: string; lang: string; step: number; text: string; exp: number; pos: number; state: string; diff: number; ok: boolean; confWrong: boolean; off: boolean; neg: boolean }
interface Relock { sc: string; lang: string; words: number | null; safe: boolean; suggested: boolean }
interface SaidRes { sc: string; lang: string; tp: number; fp: number; fn: number; wrongIds: string[] }

export function evaluate(scenarios: Scenario[], label: string): string[] {
  const checks: Check[] = []; const relocks: Relock[] = []; const saidRes: SaidRes[] = [];
  scenarios.forEach((sc, scI) => {
    const idx = buildNoteIndex(sc.blocks);
    let now = 1_000_000;
    const f = new VoiceFollower(idx, { clock: () => now });
    const t = new SaidTracker(idx, { clock: () => now });
    const pos = (b: number, fr: number) => idx.blocks[b].first + Math.round(fr * (idx.blocks[b].end - idx.blocks[b].first));
    const r = rng(1000 + scI);
    let prevExp = 0, seg = 0;
    sc.steps.forEach((st: Step, si: number) => {
      if (st.t === "pause") { now += st.ms; return; }
      seg++;
      const segId = `${sc.name}#${seg}`;
      let text = st.text;
      if (sc.wer && st.t === "say") text = corrupt(text, sc.wer, r);
      const cjk = isCjk(text);
      const u = units(text);
      const start = st.t === "say" ? pos(st.b, st.f0) : prevExp;
      const end = st.t === "say" ? pos(st.b, st.f1) : prevExp;
      const feeds: string[] = [];
      if (st.t === "say" && st.interims) feeds.push(...st.interims);
      else if (!(st.t === "say" && st.mode === "final")) for (let k = 3; k < u.length; k += 3) feeds.push(join(u.slice(0, k), cjk));
      let spent = 0;
      const jump = st.t === "say" && !!st.jump;
      let relockDone = false;
      const total = u.length;
      let suggested = false;
      const targetId = st.t === "say" ? sc.blocks[st.b].id : "";
      const probe = (snap: { position: number; state: string; suggestion?: { blockId: string } }, wordsSoFar: number) => {
        t.setPlace(snap.position);
        if (jump && snap.suggestion?.blockId === targetId) suggested = true;
        if (jump && !relockDone) {
          const e = start + (end - start) * Math.min(1, wordsSoFar / total);
          if (Math.abs(snap.position - e) <= TOL && snap.state === "following") { relockDone = true; relocks.push({ sc: sc.name, lang: sc.lang, words: wordsSoFar, safe: true, suggested }); }
        }
      };
      feeds.forEach((ft, k) => {
        const w = st.t === "say" && st.interims ? units(ft).length : Math.min(total, 3 * (k + 1));
        now += 400 * Math.max(1, w - spent); spent = w;
        const snap = f.onInterim(ft, segId); probe(snap, w); t.onInterim(ft, segId);
      });
      now += 400 * Math.max(0, total - spent);
      const snap = f.onFinal(text, segId); probe(snap, total); t.onFinal(text, segId);
      if (jump && !relockDone) relocks.push({ sc: sc.name, lang: sc.lang, words: null, safe: snap.state !== "following", suggested });
      const diff = Math.abs(snap.position - end);
      checks.push({ sc: sc.name, lang: sc.lang, step: si, text, exp: end, pos: snap.position, state: snap.state, diff, ok: diff <= TOL || snap.state !== "following", confWrong: snap.state === "following" && diff > TOL, off: st.t === "off", neg: !!sc.neg });
      prevExp = end;
    });
    const said = new Set(t.saidBlockIds());
    const truth = new Set(sc.said);
    const ignore = new Set(sc.ignore ?? []);
    let tp = 0, fp = 0, fn = 0; const wrongIds: string[] = [];
    for (const b of sc.blocks) {
      if (ignore.has(b.id)) continue;
      const s = said.has(b.id), g = truth.has(b.id);
      if (s && g) tp++; else if (s && !g) { fp++; wrongIds.push("+" + b.id); } else if (!s && g) { fn++; wrongIds.push("-" + b.id); }
    }
    saidRes.push({ sc: sc.name, lang: sc.lang, tp, fp, fn, wrongIds });
  });

  const pct = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(1) + "%" : "n/a");
  const agg = (cs: Check[]) => ({ n: cs.length, ok: cs.filter((c) => c.ok).length, cw: cs.filter((c) => c.confWrong).length, strict: cs.filter((c) => c.diff <= TOL).length });
  const L: string[] = [];
  const A = agg(checks);
  L.push(`[${label}] scenarios=${scenarios.length} checkpoints=${A.n}`);
  L.push(`checkpoints ok=${pct(A.ok, A.n)} strict=${pct(A.strict, A.n)} confident-wrong=${pct(A.cw, A.n)} (${A.cw})`);
  const on = agg(checks.filter((c) => !c.neg && !c.off)), ng = agg(checks.filter((c) => c.neg)), of = agg(checks.filter((c) => c.off && !c.neg));
  L.push(`on-script ok=${pct(on.ok, on.n)} cw=${pct(on.cw, on.n)} | negatives safe=${pct(ng.ok, ng.n)} (n=${ng.n}) | off-script-in-talk safe=${pct(of.ok, of.n)} (n=${of.n}, cw=${of.cw})`);
  const got = relocks.filter((x) => x.words != null).map((x) => x.words as number).sort((a, b) => a - b);
  const sug = relocks.filter((x) => x.words == null && x.suggested).length;
  const safe = relocks.filter((x) => x.words == null && !x.suggested && x.safe).length;
  const bad = relocks.filter((x) => x.words == null && !x.suggested && !x.safe);
  L.push(`jumps n=${relocks.length}: re-locked=${got.length} (median ${got.length ? got[Math.floor(got.length / 2)] : "n/a"} words, max ${got.length ? got[got.length - 1] : "n/a"}), suggested-correct=${sug}, not-following=${safe}, stuck-wrong=${bad.length}${bad.length ? " [" + bad.map((x) => x.sc).join(",") + "]" : ""}`);
  const tp = saidRes.reduce((x, y) => x + y.tp, 0), fp = saidRes.reduce((x, y) => x + y.fp, 0), fn = saidRes.reduce((x, y) => x + y.fn, 0);
  L.push(`said overall P=${pct(tp, tp + fp)} R=${pct(tp, tp + fn)} (tp=${tp} fp=${fp} fn=${fn})`);
  for (const l of [...new Set(scenarios.map((s) => s.lang))]) {
    const a = agg(checks.filter((c) => c.lang === l)); const s = saidRes.filter((x) => x.lang === l);
    const a1 = s.reduce((x, y) => x + y.tp, 0), a2 = s.reduce((x, y) => x + y.fp, 0), a3 = s.reduce((x, y) => x + y.fn, 0);
    L.push(`  ${l}: ok=${pct(a.ok, a.n)} cw=${pct(a.cw, a.n)} (n=${a.n}) | said P=${pct(a1, a1 + a2)} R=${pct(a1, a1 + a3)}`);
  }
  const worst = checks.filter((c) => c.confWrong).sort((a, b) => b.diff - a.diff).slice(0, 8);
  L.push("worst:");
  worst.forEach((c) => L.push(`  CW ${c.sc} step${c.step}${c.off ? " (off)" : ""} pos=${c.pos} exp=${c.exp} d=${c.diff} "${c.text.slice(0, 50)}"`));
  const sErr = saidRes.filter((x) => x.fp + x.fn > 0).sort((a, b) => b.fp * 2 + b.fn - (a.fp * 2 + a.fn)).slice(0, Math.max(0, 8 - worst.length));
  sErr.forEach((x) => L.push(`  SAID ${x.sc} ${x.wrongIds.join(",")}`));
  L.push("said errors all: " + saidRes.filter((x) => x.fp + x.fn > 0).map((x) => `${x.sc}[${x.wrongIds.join(",")}]`).join(" "));
  return L;
}
