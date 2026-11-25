/**
 * "Go to ..." suggestions. An offer never moves anything, so its bar is far lower than
 * an automatic jump: a content-word overlap score of the last ~20 spoken words against
 * every block (rarity weighted inside the note, fuzzy/stem tolerant, CJK bigrams, heading
 * words boosted, adjacent word pairs rewarded, contradicting numbers penalised), a margin
 * over the runner-up and over the current place, and hysteresis (stable for a moment,
 * rate limited, dismissed offers don't return).
 */
import type { NoteIndex } from "./tokenize";
import { isMonth } from "./tokenize";
import type { VocabMatcher } from "./similarity";

export const SPOKEN_WORDS = 20;
/** Words below this weight (generic function words) never count. */
const MIN_W = 0.15;
const SCORE_MIN = 0.5;
const STABLE_MS = 300; // the panel adds its own second before it shows a chip
const GAP_MS = 4000;
const DROP_MISSES = 3;
const EXPIRE_MS = 8000;
/** A dismissed point can be offered again after this (a long way on, it may be wanted). */
const DISMISS_MS = 20000;

const CJK_CONTENT = /[\p{Script=Han}\p{Script=Katakana}\p{Script=Hangul}]/u;
function isContent(w: string): boolean {
  if (/^[0-9]/.test(w)) return w.length >= 2;
  if (w.charCodeAt(0) >= 0x3000) return CJK_CONTENT.test(w);
  return w.length >= 5;
}

export interface BlockScore {
  block: number;
  score: number;
}

export class SuggestionScorer {
  private blocksOf: number[][];
  private heads: Array<Set<number>>;
  private cap: Float32Array;
  private pairBlocks = new Map<number, number[]>();
  private blockNums: Array<Set<number>>;
  private cov: Float32Array;
  private cnt: Int16Array;

  constructor(private index: NoteIndex, private matcher: VocabMatcher) {
    const nb = index.blocks.length;
    const sc = index.scale;
    this.blocksOf = index.vocab.map(() => []);
    this.heads = [];
    this.cap = new Float32Array(nb);
    this.blockNums = [];
    this.cov = new Float32Array(nb);
    this.cnt = new Int16Array(nb);
    index.blocks.forEach((b, bi) => {
      const ws: number[] = [];
      for (const id of b.all) {
        this.blocksOf[id].push(bi);
        if (index.vocabW[id] >= MIN_W) ws.push(index.vocabW[id]);
      }
      ws.sort((a, c) => c - a);
      this.cap[bi] = Math.max(0.5, ws.slice(0, Math.round(8 * sc)).reduce((s, x) => s + x, 0));
      // block-initial words are its topic ("Pricing: ...")
      const head = new Set<number>();
      for (let i = b.first; i < Math.min(b.end, b.first + Math.round(3 * sc)); i++) head.add(index.ids[i]);
      this.heads.push(head);
      this.blockNums.push(new Set(b.all.filter((id) => index.vocabNum[id])));
      // adjacent (and one-apart) word pairs
      for (let i = b.first; i + 1 < b.end; i++) {
        for (let d = 1; d <= 2 && i + d < b.end; d++) {
          const key = index.ids[i] * 65536 + index.ids[i + d];
          const arr = this.pairBlocks.get(key);
          if (!arr) this.pairBlocks.set(key, [bi]);
          else if (arr[arr.length - 1] !== bi) arr.push(bi);
        }
      }
    });
  }

  /** Scores every block that has evidence, best first. */
  score(words: string[]): BlockScore[] {
    const { index, cov, cnt } = this;
    cov.fill(0);
    cnt.fill(0);
    const best = new Map<number, number>();
    let spokenW = 0;
    const bestIds: number[] = [];
    for (const w of words) {
      const row = this.matcher.row(w);
      let id = -1;
      let sim = 0;
      for (const h of row.hits) {
        const s = row.dense[h];
        if (index.vocabW[h] >= MIN_W && s * index.vocabW[h] > sim * (id >= 0 ? index.vocabW[id] : 0)) {
          id = h;
          sim = s;
        }
        if (index.vocabW[h] >= MIN_W && (best.get(h) ?? 0) < s) best.set(h, s);
      }
      bestIds.push(id);
      if (id >= 0) spokenW += index.vocabW[id];
      else if (isContent(w)) spokenW += 0.5; // content that is nowhere in the note
    }
    for (const [id, sim] of best) {
      const w = index.vocabW[id] * sim;
      for (const bi of this.blocksOf[id]) {
        cov[bi] += this.heads[bi].has(id) ? w * 1.4 : w;
        if (index.vocabW[id] >= 0.3) cnt[bi]++;
      }
    }
    for (let k = 0; k + 1 < bestIds.length; k++) {
      const a = bestIds[k];
      const b = bestIds[k + 1];
      if (a < 0 || b < 0) continue;
      const blocks = this.pairBlocks.get(a * 65536 + b);
      if (blocks) for (const bi of blocks) cov[bi] += 0.5 * (index.vocabW[a] + index.vocabW[b]);
    }
    // numbers (and months) said that a block does not contain count against it
    const spokenNums: number[] = [];
    words.forEach((w, k) => {
      if (isMonth(w) || (/^[0-9]/.test(w) && (w.length >= 2 || words[k - 1] === "quarter"))) spokenNums.push(index.vocabIdx.get(w) ?? -1);
    });
    const out: BlockScore[] = [];
    const purityDen = Math.max(spokenW, 1);
    for (let bi = 0; bi < index.blocks.length; bi++) {
      if (cov[bi] <= 0) continue;
      const b = index.blocks[bi];
      let heading = b.distinct.length <= 2;
      if (!heading && cnt[bi] < 2) for (const id of best.keys()) if (this.heads[bi].has(id) && index.vocabW[id] >= 0.6 && this.blocksOf[id].length <= 2) heading = true;
      if (cnt[bi] < 2 && !(cnt[bi] >= 1 && heading)) continue;
      let s = cov[bi] / this.cap[bi];
      const purity = Math.min(1, cov[bi] / purityDen / 0.5);
      s *= 0.5 + 0.5 * purity;
      const nums = this.blockNums[bi];
      if (nums.size > 0 && spokenNums.some((id) => id < 0 || !nums.has(id))) s *= 0.5;
      if (s > 0) out.push({ block: bi, score: s });
    }
    out.sort((a, c) => c.score - a.score);
    return out;
  }

  /** The block worth offering, or null. `skip` are the blocks automatic moves already cover. */
  candidate(words: string[], skipLo: number, skipHi: number): { block: number; score: number } | null {
    const top = this.score(words);
    if (top.length === 0) return null;
    // where the speaker is: how well do the words fit the current and next block?
    const here = this.hereScore(skipLo, skipHi, top);
    const first = top.find((t) => t.block < skipLo || t.block > skipHi);
    if (!first) return null;
    if (first.score < SCORE_MIN) return null;
    // a bare heading and the block under it are one place, not rivals
    const bare = (bi: number) => bi >= 0 && bi < this.index.blocks.length && this.index.blocks[bi].end - this.index.blocks[bi].first <= 2;
    const partner = bare(first.block) ? first.block + 1 : bare(first.block - 1) ? first.block - 1 : -1;
    const others = top.filter((t) => t.block !== first.block && t.block !== partner);
    const runner = others.length ? others[0].score : 0;
    if (first.score < runner * 1.25 || first.score < runner + 0.12) return null;
    if (first.score < here * 1.2 + 0.1) return null;
    // a bare heading ("Roadmap") introduces the block under it: when that block fits the words too, offer it
    const b = this.index.blocks[first.block];
    if (b.end - b.first <= 2) {
      const next = top.find((t) => t.block === first.block + 1);
      if (next && next.score >= 0.5 * first.score && (next.block < skipLo || next.block > skipHi)) return next;
    }
    return first;
  }

  private hereScore(skipLo: number, skipHi: number, top: BlockScore[]): number {
    let h = 0;
    for (const t of top) if (t.block >= skipLo && t.block <= skipHi) h = Math.max(h, t.score);
    return h;
  }
}

/** Hysteresis: a candidate must hold for a moment, offers are rate limited, dismissed ones never return. */
export class SuggestionOffer {
  private cand: { block: number; since: number; score: number } | null = null;
  private misses = 0;
  private lastAt = -Infinity;
  private shown: { block: number; score: number } | null = null;
  private lastShownAt = -Infinity;
  private lastShownScore = 0;
  private dismissed = new Map<number, number>();
  private clockNow = 0;

  observe(c: { block: number; score: number } | null, now: number): void {
    this.lastAt = now;
    this.clockNow = now;
    const at = c ? this.dismissed.get(c.block) : undefined;
    if (c && at !== undefined) {
      if (now - at < DISMISS_MS) c = null;
      else this.dismissed.delete(c.block);
    }
    if (!c) {
      if (++this.misses >= DROP_MISSES) {
        this.cand = null;
        this.shown = null;
      }
      return;
    }
    this.misses = 0;
    if (!this.cand || this.cand.block !== c.block) {
      // the offer moving to the neighbouring block (a heading and its text) is the same offer
      const sameOffer = this.shown !== null && Math.abs(this.shown.block - c.block) <= 1;
      this.cand = { block: c.block, since: sameOffer && this.cand ? this.cand.since : now, score: c.score };
      if (sameOffer) this.shown = { block: c.block, score: c.score };
      else if (this.shown && this.shown.block !== c.block) this.shown = null;
    } else this.cand.score = c.score;
  }

  /** Current offer (time based: also promotes a stable candidate between inputs). */
  current(now: number, lo: number, hi: number): { block: number; score: number } | null {
    // nothing heard for a while (or the follower was reset around it): an old offer does not linger
    if (this.cand && now - this.lastAt > EXPIRE_MS) this.clear();
    const c = this.cand;
    if (!c) return null;
    if (c.block >= lo && c.block <= hi) {
      this.cand = null;
      this.shown = null;
      return null;
    }
    // rate limited, unless this one is clearly better than what was shown a moment ago
    if (!this.shown && now - c.since >= STABLE_MS && (now - this.lastShownAt >= GAP_MS || c.score >= this.lastShownScore * 1.3)) {
      this.shown = { block: c.block, score: c.score };
      this.lastShownAt = now;
      this.lastShownScore = c.score;
    }
    return this.shown ? { block: this.shown.block, score: c.score } : null;
  }

  dismiss(block: number): void {
    this.dismissed.set(block, this.clockNow);
    if (this.cand?.block === block) this.cand = null;
    if (this.shown?.block === block) this.shown = null;
  }

  clear(): void {
    this.cand = null;
    this.shown = null;
    this.misses = 0;
  }

  reset(): void {
    this.clear();
    this.dismissed.clear();
    this.lastShownAt = -Infinity;
    this.lastShownScore = 0;
  }
}
