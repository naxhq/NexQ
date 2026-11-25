/**
 * SaidTracker: ticks a note block when enough of its distinctive words were said by
 * the user in the last 90 s (idf-weighted coverage >= 0.6, at least 3 distinctive words
 * or all of them for short blocks, close together in the speech). A manual tick or
 * untick always wins and is never overridden by the automatic rule.
 */
import { NoteIndex } from "./tokenize";
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

export class SaidTracker {
  private matcher: VocabMatcher;
  private stream = new SpokenStream();
  private clock: () => number;
  private windowMs: number;
  private coverage: number;
  private minWords: number;
  private state = new Map<string, SaidMark>();

  constructor(private index: NoteIndex, opts: SaidOptions = {}) {
    this.matcher = new VocabMatcher(index.vocab, index.vocabIdx);
    this.clock = opts.clock ?? (() => Date.now());
    this.windowMs = opts.windowMs ?? 90_000;
    this.coverage = opts.coverage ?? 0.6;
    this.minWords = opts.minWords ?? 3;
  }

  /** Note edited: keeps marks of blocks that still exist (stable block ids). */
  setIndex(index: NoteIndex): void {
    this.index = index;
    this.matcher = new VocabMatcher(index.vocab, index.vocabIdx);
    const ids = new Set(index.blocks.map((b) => b.id));
    for (const id of [...this.state.keys()]) if (!ids.has(id)) this.state.delete(id);
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
    // vocab id -> hits in the spoken stream
    const hits = new Map<number, Array<[number, number]>>();
    for (let pos = 0; pos < flat.length; pos++) {
      const row = this.matcher.row(flat[pos]);
      for (const id of row.hits) {
        const sim = row.dense[id];
        if (sim < SOFT_SIM) continue;
        let arr = hits.get(id);
        if (!arr) hits.set(id, (arr = []));
        arr.push([pos, sim]);
      }
    }
    for (const b of index.blocks) {
      if (this.state.has(b.id)) continue;
      if (b.distinct.length === 0) continue;
      if (!b.distinct.some((id) => hits.has(id))) continue;
      if (this.blockDone(b, hits)) this.state.set(b.id, "auto");
    }
  }

  private blockDone(b: NoteIndex["blocks"][number], hits: Map<number, Array<[number, number]>>): boolean {
    const { index } = this;
    const len = b.end - b.first;
    const span = Math.max(14, Math.ceil(2.2 * len / index.scale));
    const events: Array<[number, number, number]> = []; // pos, vocab id, sim
    for (const id of b.all) {
      const arr = hits.get(id);
      if (arr) for (const [pos, sim] of arr) events.push([pos, id, sim]);
    }
    if (events.length === 0) return false;
    events.sort((a, c) => a[0] - c[0]);
    let totalW = 0;
    for (const id of b.all) totalW += index.vocabW[id];
    const short = b.distinct.length < this.minWords;
    const distinctSet = new Set(b.distinct);
    const needSim = short ? STRICT_SIM : SOFT_SIM;
    const winLen = short ? Math.min(span, 12) : span;
    for (let s = 0; s < events.length; s++) {
      const start = events[s][0];
      if (s > 0 && events[s - 1][0] === start) continue;
      const best = new Map<number, number>();
      for (let e = s; e < events.length && events[e][0] < start + winLen; e++) {
        const [, id, sim] = events[e];
        if (sim >= needSim && (best.get(id) ?? 0) < sim) best.set(id, sim);
      }
      let covW = 0;
      let covDistinct = 0;
      for (const [id, sim] of best) {
        covW += index.vocabW[id] * sim;
        if (distinctSet.has(id)) covDistinct++;
      }
      if (short) {
        if (covDistinct === b.distinct.length && best.size >= 2 && covW / totalW >= 0.75) return true;
      } else if (covW / totalW >= this.coverage && covDistinct >= this.minWords) {
        return true;
      }
    }
    return false;
  }
}
