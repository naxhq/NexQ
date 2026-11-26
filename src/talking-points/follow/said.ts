/**
 * SaidTracker: ticks a note block when enough of its distinctive words were said by
 * the user in the last 90 s (idf-weighted coverage >= 0.6, at least 3 distinctive words
 * or all of them for short blocks, close together in the speech). A manual tick or
 * untick always wins and is never overridden by the automatic rule.
 */
import { NoteIndex, isMonth } from "./tokenize";
import { VocabMatcher } from "./similarity";
import { SpokenStream } from "./stream";

export type SaidMark = "auto" | "manual_on" | "manual_off";

export interface SaidOptions {
  clock?: () => number;
  /** Evidence window. Default 90 s. */
  windowMs?: number;
  /** Idf-weighted coverage needed. Default 0.6. */
  coverage?: number;
  /** Distinctive words needed (fewer if the block has fewer). Default 3. */
  minWords?: number;
}

const SOFT_SIM = 0.75;
const STRICT_SIM = 0.85;
const SETTLE_WORDS = 4;

export class SaidTracker {
  private matcher: VocabMatcher;
  private stream = new SpokenStream();
  private clock: () => number;
  private windowMs: number;
  private coverage: number;
  private minWords: number;
  private state = new Map<string, SaidMark>();

  /** Per block: first note position of each word, the words no sibling block shares, and its numbers. */
  private notePos: Array<Map<number, number>> = [];
  private discriminators: number[][] = [];
  private blockNums: Array<Set<number>> = [];
  private place = -1;

  constructor(private index: NoteIndex, opts: SaidOptions = {}) {
    this.matcher = new VocabMatcher(index.vocab, index.vocabIdx);
    this.prepare();
    this.clock = opts.clock ?? (() => Date.now());
    this.windowMs = opts.windowMs ?? 90_000;
    this.coverage = opts.coverage ?? 0.6;
    this.minWords = opts.minWords ?? 3;
  }

  /** Note edited: keeps marks of blocks that still exist (stable block ids). */
  setIndex(index: NoteIndex): void {
    this.index = index;
    this.matcher = new VocabMatcher(index.vocab, index.vocabIdx);
    this.prepare();
    const ids = new Set(index.blocks.map((b) => b.id));
    for (const id of [...this.state.keys()]) if (!ids.has(id)) this.state.delete(id);
  }

  /** Where the follower thinks the speaker is (token index): blocks far from it need stronger evidence. */
  setPlace(token: number): void {
    const t = this.index.tokens;
    this.place = t.length === 0 ? -1 : t[Math.max(0, Math.min(t.length - 1, Math.round(token)))].block;
  }

  private prepare(): void {
    const { index } = this;
    this.notePos = index.blocks.map((b) => {
      const m = new Map<number, number>();
      for (let i = b.first; i < b.end; i++) if (!m.has(index.ids[i])) m.set(index.ids[i], i - b.first);
      return m;
    });
    this.blockNums = index.blocks.map((b) => new Set(b.all.filter((id) => index.vocabNum[id] && (index.vocab[id].length >= 2 || (index.tokens[index.postings[id][0]] && index.tokens[index.postings[id][0] - 1]?.t === "quarter")))));
    // siblings: blocks that share at least half of their distinctive words
    this.discriminators = index.blocks.map((b, bi) => {
      const sibs = index.blocks.filter((o, oi) => {
        if (oi === bi || o.distinct.length === 0 || b.distinct.length === 0) return false;
        const set = new Set(o.distinct);
        const common = b.distinct.filter((id) => set.has(id)).length;
        return common >= 2 && common / Math.min(b.distinct.length, o.distinct.length) >= 0.5;
      });
      if (sibs.length === 0) return [];
      const shared = new Set<number>();
      for (const o of sibs) for (const id of o.all) shared.add(id);
      return b.distinct.filter((id) => !shared.has(id));
    });
  }

  onInterim(text: string, segId: string): void {
    this.feed(text, segId, false);
  }

  onFinal(text: string, segId: string): void {
    this.feed(text, segId, true);
  }

  /** Click on a block: ticks it if open, unticks it if said. The choice wins over the automatic rule. */
  toggle(blockId: string): SaidMark {
    const mark: SaidMark = this.isSaid(blockId) ? "manual_off" : "manual_on";
    this.state.set(blockId, mark);
    return mark;
  }

  /** Explicit manual choice, or null to hand the block back to the automatic rule. */
  setManual(blockId: string, choice: "on" | "off" | null): void {
    if (!this.index.blocks.some((b) => b.id === blockId)) return;
    if (choice === null) this.state.delete(blockId);
    else this.state.set(blockId, choice === "on" ? "manual_on" : "manual_off");
  }

  isSaid(blockId: string): boolean {
    const m = this.state.get(blockId);
    return m === "auto" || m === "manual_on";
  }

  /** `{block_id: 'auto'|'manual_on'|'manual_off'}`; blocks with no mark are absent. */
  marks(): Record<string, SaidMark> {
    return Object.fromEntries(this.state);
  }

  load(saved: Record<string, string> | null | undefined): void {
    this.state.clear();
    if (!saved) return;
    const ids = new Set(this.index.blocks.map((b) => b.id));
    for (const [id, m] of Object.entries(saved)) {
      if (ids.has(id) && (m === "auto" || m === "manual_on" || m === "manual_off")) this.state.set(id, m);
    }
  }

  /** Blocks (with any words) not yet said. */
  leftToSay(): number {
    let n = 0;
    for (const b of this.index.blocks) if (b.end > b.first && !this.isSaid(b.id)) n++;
    return n;
  }

  saidBlockIds(): string[] {
    return this.index.blocks.filter((b) => this.isSaid(b.id)).map((b) => b.id);
  }

  reset(): void {
    this.state.clear();
    this.stream.clear();
  }

  // -----------------------------------------------------------------------

  private feed(text: string, segId: string, final: boolean): void {
    const now = this.clock();
    if (!this.stream.set(segId, text, final, now)) return;
    this.stream.prune(1e9, now, this.windowMs);
    this.evaluate();
  }

  private evaluate(): void {
    const { index } = this;
    const flat: string[] = [];
    for (const s of this.stream.segs) for (const w of s.words) flat.push(w);
    if (flat.length === 0) return;
    // Words still being spoken have not been contradicted yet: the newest few of an unfinished
    // segment do not count as evidence until the speaker has moved on.
    const lastSeg = this.stream.segs[this.stream.segs.length - 1];
    const cutoff = lastSeg && !lastSeg.final ? Math.max(0, flat.length - SETTLE_WORDS) : flat.length;
    // vocab id -> hits in the spoken stream
    const hits = new Map<number, Array<[number, number]>>();
    for (let pos = 0; pos < cutoff; pos++) {
      const row = this.matcher.row(flat[pos]);
      for (const id of row.hits) {
        const sim = row.dense[id];
        if (sim < SOFT_SIM) continue;
        let arr = hits.get(id);
        if (!arr) hits.set(id, (arr = []));
        arr.push([pos, sim]);
      }
    }
    index.blocks.forEach((b, bi) => {
      if (this.state.has(b.id)) return;
      if (b.distinct.length === 0) return;
      if (!b.distinct.some((id) => hits.has(id))) return;
      if (this.blockDone(bi, b, hits, flat)) this.state.set(b.id, "auto");
    });
  }

  /** One or two words (a "Questions?" block): only when said as a short utterance of their own. */
  private tinyDone(b: NoteIndex["blocks"][number]): boolean {
    const len = b.end - b.first;
    for (const seg of this.stream.segs) {
      if (seg.words.length > 2 * len + 2) continue;
      let all = true;
      for (const id of b.all) {
        if (!seg.words.some((w) => this.matcher.row(w).dense[id] >= STRICT_SIM)) {
          all = false;
          break;
        }
      }
      if (all) return true;
    }
    return false;
  }

  private blockDone(
    bi: number,
    b: NoteIndex["blocks"][number],
    hits: Map<number, Array<[number, number]>>,
    flat: string[],
  ): boolean {
    const { index } = this;
    const len = b.end - b.first;
    if (len <= 3) return this.tinyDone(b);
    // the current block and its neighbours are likely; blocks far from the place need stronger, ordered evidence
    const far = this.place >= 0 && Math.abs(bi - this.place) > 1;
    const nearCjk = index.cjk && this.place >= 0 && bi >= this.place && bi <= this.place + 1;
    const ids = index.cjk ? b.all.filter((id) => index.vocabContent[id]) : b.all;
    if (ids.length === 0) return false;
    const coverage = far ? Math.max(this.coverage, 0.7) : nearCjk ? 0.5 : this.coverage;
    const minWords = far ? Math.max(this.minWords, 4) : nearCjk ? 2 : this.minWords;
    const span = far ? Math.max(12, Math.ceil((1.6 * len) / index.scale)) : Math.max(14, Math.ceil((2.2 * len) / index.scale));
    const events: Array<[number, number, number]> = []; // pos, vocab id, sim
    for (const id of ids) {
      const arr = hits.get(id);
      if (arr) for (const [pos, sim] of arr) events.push([pos, id, sim]);
    }
    if (events.length === 0) return false;
    events.sort((a, c) => a[0] - c[0]);
    let totalW = 0;
    for (const id of ids) totalW += index.vocabW[id];
    const distinctIds = index.cjk ? b.distinct.filter((id) => index.vocabContent[id]) : b.distinct;
    const short = distinctIds.length < minWords;
    const distinctSet = new Set(distinctIds);
    const needSim = short ? STRICT_SIM : SOFT_SIM;
    const winLen = short ? Math.min(span, 12) : span;
    for (let s = 0; s < events.length; s++) {
      const start = events[s][0];
      if (s > 0 && events[s - 1][0] === start) continue;
      const best = new Map<number, number>();
      const first = new Map<number, number>(); // id -> spoken pos
      for (let e = s; e < events.length && events[e][0] < start + winLen; e++) {
        const [pos, id, sim] = events[e];
        if (sim >= needSim && (best.get(id) ?? 0) < sim) {
          best.set(id, sim);
          first.set(id, pos);
        }
      }
      let covW = 0;
      let covDistinct = 0;
      for (const [id, sim] of best) {
        covW += index.vocabW[id] * sim;
        if (distinctSet.has(id)) covDistinct++;
      }
      const basic = short
        ? covDistinct === distinctIds.length && best.size >= 2 && covW / totalW >= 0.75
        : covW / totalW >= coverage && covDistinct >= minWords;
      if (!basic) continue;
      if (this.extraChecks(bi, b, best, first, start, winLen, flat, totalW, short, far ? 0.6 : 0.45)) return true;
    }
    return false;
  }

  /** Discriminating word, contradicting number and order checks. */
  private extraChecks(
    bi: number,
    b: NoteIndex["blocks"][number],
    best: Map<number, number>,
    first: Map<number, number>,
    start: number,
    winLen: number,
    flat: string[],
    totalW: number,
    short: boolean,
    lisMin: number,
  ): boolean {
    const { index } = this;
    // 1. a sibling bullet shares most words: the words only this bullet has must be said
    const disc = this.discriminators[bi];
    if (disc.length > 0) {
      let dw = 0;
      let dc = 0;
      for (const id of disc) {
        dw += index.vocabW[id];
        dc += (best.get(id) ?? 0) * index.vocabW[id];
      }
      if (dc / dw < 0.5) return false;
    }
    // 2. numbers: a different number said in the same breath counts against the block
    const nums = this.blockNums[bi];
    if (nums.size > 0) {
      let uncovered = false;
      for (const id of nums) if (!best.has(id)) uncovered = true;
      if (uncovered) {
        for (let k = start; k < Math.min(flat.length, start + winLen); k++) {
          const w = flat[k];
          if (isMonth(w) || (/^[0-9]/.test(w) && (w.length >= 2 || flat[k - 1] === "quarter"))) {
            const id = index.vocabIdx.get(w);
            if (id === undefined || !nums.has(id)) return false;
          }
        }
      }
    }
    // 3. order: the covered words must mostly appear in the block's own order
    if (!short) {
      const items = [...first.entries()]
        .map(([id, pos]) => ({ pos, np: this.notePos[bi].get(id) ?? 0, w: index.vocabW[id] * (best.get(id) ?? 0) }))
        .sort((x, y) => x.pos - y.pos);
      const dp: number[] = [];
      let lis = 0;
      for (let i = 0; i < items.length; i++) {
        let m = 0;
        for (let j = 0; j < i; j++) if (items[j].np <= items[i].np && dp[j] > m) m = dp[j];
        dp[i] = m + items[i].w;
        if (dp[i] > lis) lis = dp[i];
      }
      if (lis / totalW < lisMin) return false;
    }
    return true;
  }
}
