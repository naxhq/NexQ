/**
 * VoiceFollower: tracks where the user is in the talking points from their own
 * transcript (interims and finals of the "You" side only).
 *
 * Each update re-aligns the newest ~12 spoken words against a window around the
 * current place with a semi-global alignment (free start and end in the note, cheap
 * note skips, cheap spoken skips), so interim corrections never double count. Big
 * moves (jump ahead, back reference) need strong distinctive-word evidence that
 * persists across further spoken words; small forward moves are immediate.
 */
import { NoteIndex, isMonth } from "./tokenize";
import { VocabMatcher, MATCH_MIN } from "./similarity";
import { SpokenStream } from "./stream";
import { SuggestionScorer, SuggestionOffer, SPOKEN_WORDS } from "./suggest";

export type FollowState = "following" | "unsure" | "lost" | "paused";

export interface FollowSnapshot {
  /** Token index the speaker has reached (fractional, end of the last matched word). */
  position: number;
  /** 0..1. */
  confidence: number;
  state: FollowState;
  /** A plausible but unconfirmed other place; never moves by itself ("Go to ...?"). */
  suggestion?: { blockId: string; confidence: number };
}

export interface FollowerOptions {
  clock?: () => number;
  /** Silence after which the state reads "paused". */
  pauseMs?: number;
  /** Test hook: sees every alignment. */
  debug?: (d: { words: string[]; p: number; near: unknown; pos: number }) => void;
}

// Scoring (weights are 0.05..1, distinctive words ~0.5..1).
const GS = 0.12; // skip a spoken word (filler, digression)
const GN = 0.08; // skip a note word (paraphrase, shorter delivery)
const SUB = 0.08; // aligned but different word
const MEANINGFUL = 0.25;
const BACK_WORDS = 45;
const FWD_WORDS = 90;
const JUMP_WORDS = 30;
const TAIL_WORDS = 12;
const KEEP_WORDS = 60;

interface Cand {
  /** Exclusive end token (next token to say). */
  e: number;
  /** Score with prior. */
  f: number;
  /** Sum of match gains. */
  g: number;
  /** Meaningful matches. */
  k: number;
  /** Spoken index (1-based) of the last meaningful match, 0 when none. */
  l: number;
  /** First meaningful match (note index). */
  s: number;
  /** Meaningful matches among the newest 8 spoken words. */
  q: number;
}

const CONTENT_CJK = /[\p{Script=Han}\p{Script=Katakana}\p{Script=Hangul}]/u;
function isContent(w: string): boolean {
  if (/^[0-9]/.test(w)) return w.length >= 2;
  if (w.charCodeAt(0) >= 0x3000) return CONTENT_CJK.test(w);
  return w.length >= 5;
}

export class VoiceFollower {
  private matcher: VocabMatcher;
  private stream = new SpokenStream();
  private clock: () => number;
  private pauseMs: number;
  private pos = 0;
  private conf = 0;
  private baseState: FollowState = "unsure";
  private since = 10;
  private lastAdded = 0;
  private lastFar = 0;
  private scorer: SuggestionScorer;
  private offer = new SuggestionOffer();
  private suggest: { blockId: string; conf: number; until: number } | null = null;
  /** 4-grams of the note: end index when unique in the note, -1 otherwise. */
  private grams = new Map<string, number>();
  /** A candidate rejected for a contradicting number stays rejected while its words are still in the tail. */
  private blocked: { e: number; until: number } | null = null;
  private lastInputAt = -Infinity;
  private pending: { e: number; added: number; miss: number } | null = null;
  private bufH = new Float32Array(0);
  private bufG = new Float32Array(0);
  private bufK = new Int16Array(0);
  private bufL = new Int16Array(0);
  private bufE = new Int32Array(0);
  private bufS = new Int32Array(0);
  private bufQ = new Int16Array(0);
  private tailLen: number;
  private debug?: FollowerOptions["debug"];

  constructor(private index: NoteIndex, opts: FollowerOptions = {}) {
    this.matcher = new VocabMatcher(index.vocab, index.vocabIdx);
    this.clock = opts.clock ?? (() => Date.now());
    this.pauseMs = opts.pauseMs ?? 3500;
    this.debug = opts.debug;
    this.tailLen = Math.round(TAIL_WORDS * index.scale);
    this.buildGrams();
    this.scorer = new SuggestionScorer(index, this.matcher);
  }

  /** Replace the note (edited mid-meeting); keeps the place as a token index. */
  setIndex(index: NoteIndex): void {
    this.index = index;
    this.matcher = new VocabMatcher(index.vocab, index.vocabIdx);
    this.tailLen = Math.round(TAIL_WORDS * index.scale);
    this.buildGrams();
    this.scorer = new SuggestionScorer(index, this.matcher);
    this.pos = Math.min(this.pos, index.tokens.length);
    this.pending = null;
  }

  onInterim(text: string, segId: string): FollowSnapshot {
    return this.feed(text, segId, false);
  }

  onFinal(text: string, segId: string): FollowSnapshot {
    return this.feed(text, segId, true);
  }

  /** Manual scroll: the user says where they are. Evidence takes over again from here. */
  seek(tokenIndex: number): void {
    this.pos = Math.max(0, Math.min(this.index.tokens.length, tokenIndex));
    this.pending = null;
    this.suggest = null;
    this.offer.clear();
    this.since = 8;
    this.baseState = "unsure";
    this.conf = 0.3;
  }

  reset(): void {
    this.stream.clear();
    this.pos = 0;
    this.since = 10;
    this.baseState = "unsure";
    this.conf = 0;
    this.pending = null;
    this.lastInputAt = -Infinity;
    this.offer.reset();
    this.lastAdded = this.stream.added;
    this.lastFar = this.stream.added;
  }

  snapshot(): FollowSnapshot {
    const now = this.clock();
    const paused = this.lastInputAt > -Infinity && now - this.lastInputAt > this.pauseMs;
    const offer = this.offer.current(now, this.blockAt(Math.max(0, this.pos - 1)), this.blockAt(this.pos) + 1);
    let suggestion: FollowSnapshot["suggestion"];
    if (offer) suggestion = { blockId: this.index.blocks[offer.block].id, confidence: Math.min(1, offer.score) };
    // an offer never changes the state: scroll-follow depends on it, and an on-script speaker stays "following"
    const base = this.baseState;
    return {
      position: this.pos,
      confidence: this.conf,
      state: paused ? "paused" : base,
      ...(suggestion ? { suggestion } : {}),
    };
  }

  /** The user waved an offer away: it does not come back. */
  dismissSuggestion(blockId: string): void {
    const bi = this.index.blocks.findIndex((b) => b.id === blockId);
    if (bi >= 0) this.offer.dismiss(bi);
    if (this.suggest?.blockId === blockId) this.suggest = null;
  }

  private feed(text: string, segId: string, final: boolean): FollowSnapshot {
    const now = this.clock();
    const changed = this.stream.set(segId, text, final, now);
    this.lastInputAt = now;
    this.stream.prune(KEEP_WORDS * Math.ceil(this.index.scale), now);
    if (changed) this.update();
    return this.snapshot();
  }

  // -------------------------------------------------------------------------

  private update(): void {
    const N = this.index.tokens.length;
    if (N === 0) return;
    const words = this.stream.tail(this.tailLen);
    const m = words.length;
    if (m === 0) return;
    const sc = this.index.scale;
    this.observeOffer();
    const rows = words.map((w) => this.matcher.row(w).dense);
    const p = Math.round(this.pos);

    const near = this.align(rows, Math.max(0, p - Math.round(BACK_WORDS * sc)), Math.min(N, p + Math.round(FWD_WORDS * sc)), p);
    let ev: Cand | null = near;
    let proposed = false;
    if (this.suggest && this.stream.added > this.suggest.until) this.suggest = null;

    this.debug?.({ words, p, near, pos: this.pos });
    let nearConflict = !!near && near.k > 0 && this.conflicts(words, near.e);
    if (near && near.k > 0) {
      if (nearConflict) this.blocked = { e: near.e, until: this.stream.added + this.tailLen };
      else if (this.blocked && this.stream.added < this.blocked.until && Math.abs(near.e - this.blocked.e) <= 10 * sc && near.e !== p) nearConflict = true;
    }
    const blocks = this.index.blocks;
    const cb = this.blockAt(p);
    const nbFirst = blocks[cb]?.first ?? 0;
    const nbEnd = blocks[Math.min(cb + 1, blocks.length - 1)]?.end ?? N;
    const inNear = (e: number) => e >= nbFirst && e <= nbEnd;
    let sawPlausible = false;
    const classify = (c: Cand) => {
      const dd = (c.e - p) / sc;
      if (dd >= -4 && dd <= 0.001) return; // same place (repeat): hold
      if (dd > 0 && inNear(c.e)) {
        // same or next block: moves as soon as the evidence is there
        if (dd <= 8) {
          if (c.g >= 0.55 && c.f >= 0.4) this.moveTo(c.e);
        } else if (c.g >= 0.9 && c.k >= 2 && c.f >= 0.5) this.moveTo(c.e);
        return;
      }
      if (dd < 0 && inNear(c.e)) {
        if (c.g >= 1.2 && c.k >= 2 && c.f >= 0.6) proposed = this.propose(c, words, 3) || proposed;
        return;
      }
      // anywhere else: an ordered, contiguous run of distinctive words, sustained, or it is only a suggestion
      if (this.strongRun(c, words)) proposed = this.propose(c, words, 8) || proposed;
      else if (c.k >= Math.round(3 * (sc > 1 ? 1.6 : 1)) && c.g >= 1.2 && !sawPlausible) {
        sawPlausible = true;
        const blk = this.index.tokens[Math.max(0, Math.min(N - 1, c.e - 1))].block;
        const dw = this.index.blocks[blk].distinct.reduce((s, id) => s + this.index.vocabW[id], 0) || 1;
        this.suggest = { blockId: this.index.blocks[blk].id, conf: Math.min(1, c.g / dw), until: this.stream.added + 8 };
      }
    };
    if (near && near.k > 0 && !nearConflict) classify(near);

    if ((!near || near.g < 1.5) && this.stream.added >= this.lastFar + 2) {
      this.lastFar = this.stream.added;
      const far = this.farCandidate(rows, words, p);
      if (far && far.k > 0 && !this.conflicts(words, far.e)) {
        classify(far);
        if (Math.abs(this.pos - far.e) < 1) ev = far;
      }
    }
    if (!proposed && this.pending && ++this.pending.miss > 3) this.pending = null;

    // evidence / state
    const added = this.stream.added;
    // evidence that points somewhere we have not moved to (pending, conflicting) is not evidence of where we are
    const pointsElsewhere = !!ev && ev === near && Math.abs(ev.e - this.pos) > 8 * sc;
    const strong = !!ev && !pointsElsewhere && !(ev === near && nearConflict) && ev.l > 0 && (ev.g >= 0.8 || (ev.k >= 2 && ev.g >= 0.5));
    if (strong && ev) this.since = m - ev.l;
    else this.since += Math.max(0, added - this.lastAdded);
    this.lastAdded = added;
    const g = ev ? ev.g : 0;
    // out-of-script content dominates the recent speech: never "following", even when the place is held
    const recent = words.slice(-8);
    const content = recent.filter(isContent).length;
    const explained = ev && !pointsElsewhere ? ev.q : 0;
    const offScript = content >= 3 && explained / content < 0.35;
    if (this.suggest && this.pos >= (blocks[this.index.blocks.findIndex((b) => b.id === this.suggest!.blockId)]?.first ?? 1e9)
      && this.pos <= (blocks[this.index.blocks.findIndex((b) => b.id === this.suggest!.blockId)]?.end ?? -1)) this.suggest = null;
    this.baseState = this.since <= 6 && strong && !offScript && !this.suggest ? "following" : this.since <= 16 ? "unsure" : "lost";
    this.conf = Math.max(0, Math.min(1, g / 2.5)) * Math.max(0, Math.min(1, 1 - this.since / 16));
  }

  /** A recently spoken number that the note region around `e` does not contain (e.g. "thirty" vs a bullet about 20). */
  private conflicts(words: string[], e: number): boolean {
    const { index } = this;
    const W = Math.round((2 * words.length + 8) * index.scale);
    const lo = Math.max(0, e - W);
    const hi = Math.min(index.tokens.length, e + 3);
    const set = new Set<number>();
    for (let i = lo; i < hi; i++) if (index.vocabNum[index.ids[i]]) set.add(index.ids[i]);
    if (set.size === 0) return false;
    for (let k = 0; k < words.length; k++) {
      const w = words[k];
      const value = isMonth(w) || (/^[0-9]/.test(w) && (w.length >= 2 || words[k - 1] === "quarter"));
      if (!value) continue;
      const id = index.vocabIdx.get(w);
      if (id === undefined || !set.has(id)) return true;
    }
    return false;
  }

  private observeOffer(): void {
    const sc = this.index.scale;
    const sw = this.stream.recentSegments(Math.round(3 * sc), Math.round(SPOKEN_WORDS * sc));
    if (sw.length < 3) return;
    const lo = this.blockAt(Math.max(0, this.pos - 1));
    const hi = Math.min(this.blockAt(this.pos) + 1, this.index.blocks.length - 1);
    this.offer.observe(this.scorer.candidate(sw, lo, hi), this.clock());
  }

  private moveTo(e: number): void {
    this.pos = e;
  }

  /** Large moves must persist while at least two more words arrive. */
  private propose(c: Cand, words: string[], need: number): boolean {
    const added = this.stream.added;
    if (c.g >= 3.5 && need <= 3) {
      this.pos = c.e;
      this.pending = null;
      this.offer.clear();
      return true;
    }
    const pend = this.pending;
    const sc = this.index.scale;
    if (pend && Math.abs(pend.e - c.e) <= 25 * sc) {
      pend.miss = 0;
      const recent = c.l >= words.length - 4 && c.q >= 3;
      if (added >= pend.added + need && recent && !this.conflicts(words, c.e)) {
        this.pos = c.e;
        this.pending = null;
        this.suggest = null;
        this.offer.clear();
      } else {
        pend.e = c.e;
      }
    } else {
      this.pending = { e: c.e, added, miss: 0 };
    }
    return true;
  }

  private blockAt(token: number): number {
    const { tokens } = this.index;
    if (tokens.length === 0) return 0;
    return tokens[Math.max(0, Math.min(tokens.length - 1, Math.round(token) >= tokens.length ? tokens.length - 1 : Math.round(token)))].block;
  }

  /** Ordered, contiguous run of >= 5 distinctive units covering >= 35% of the target block, or a unique verbatim 4-gram. */
  private strongRun(c: Cand, words: string[]): boolean {
    const { index } = this;
    const sc = index.scale;
    const blk = index.blocks[this.blockAt(c.e - 1)];
    const dw = blk.distinct.reduce((s, id) => s + index.vocabW[id], 0) || 1;
    const spanWords = Math.max(1, (c.e - c.s) / sc);
    const k = Math.round(5 * (sc > 1 ? 1.6 : 1));
    if (c.k >= k && c.g >= 0.35 * dw && c.k / spanWords >= 0.25) return true;
    for (let i = 0; i + 3 < words.length; i++) {
      const end = this.grams.get(words.slice(i, i + 4).join(" "));
      if (end !== undefined && end >= 0 && Math.abs(end - c.e) <= 12 * sc) return true;
    }
    return false;
  }

  private buildGrams(): void {
    this.grams.clear();
    const t = this.index.tokens;
    for (let i = 0; i + 3 < t.length; i++) {
      const g = `${t[i].t} ${t[i + 1].t} ${t[i + 2].t} ${t[i + 3].t}`;
      this.grams.set(g, this.grams.has(g) ? -1 : i + 4);
    }
  }

  /** Whole-note vote on distinctive words, then align around the best cluster outside the near window. */
  private farCandidate(rows: Float32Array[], words: string[], p: number): Cand | null {
    const { index } = this;
    const sc = index.scale;
    const bucket = Math.round(24 * sc);
    const nb = Math.ceil(index.tokens.length / bucket) + 1;
    const votes = new Float32Array(nb);
    const stamp = new Int32Array(nb).fill(-1);
    for (let k = 0; k < words.length; k++) {
      const hits = this.matcher.row(words[k]).hits;
      for (const h of hits) {
        const w = index.vocabW[h];
        if (w < 0.3) continue;
        const sim = rows[k][h];
        const post = index.postings[h];
        const lim = Math.min(post.length, 40);
        for (let q = 0; q < lim; q++) {
          const b = Math.floor(post[q] / bucket);
          if (stamp[b] !== k) {
            stamp[b] = k;
            votes[b] += w * sim;
          }
        }
      }
    }
    const nearLo = p - Math.round(BACK_WORDS * sc);
    const nearHi = p + Math.round(FWD_WORDS * sc);
    let best = -1;
    let bestV = 0;
    for (let b = 0; b < nb - 1; b++) {
      const centre = (b + 1) * bucket;
      if (centre >= nearLo && centre <= nearHi) continue;
      const v = votes[b] + votes[b + 1];
      if (v > bestV) {
        bestV = v;
        best = b;
      }
    }
    if (best < 0 || bestV < 1.0) return null;
    const centre = (best + 1) * bucket;
    const lo = Math.max(0, centre - Math.round(50 * sc));
    const hi = Math.min(index.tokens.length, centre + Math.round(50 * sc));
    return this.align(rows, lo, hi, centre);
  }

  private align(rows: Float32Array[], lo: number, hi: number, p: number): Cand | null {
    const n = hi - lo;
    const m = rows.length;
    if (n <= 0 || m === 0) return null;
    const W = n + 1;
    const size = (m + 1) * W;
    if (this.bufH.length < size) {
      this.bufH = new Float32Array(size);
      this.bufG = new Float32Array(size);
      this.bufK = new Int16Array(size);
      this.bufL = new Int16Array(size);
      this.bufE = new Int32Array(size);
      this.bufS = new Int32Array(size);
      this.bufQ = new Int16Array(size);
    }
    const H = this.bufH;
    const G = this.bufG;
    const K = this.bufK;
    const L = this.bufL;
    const E = this.bufE;
    const S = this.bufS;
    const Q = this.bufQ;
    const ids = this.index.ids;
    const weights = this.index.weights;
    for (let j = 0; j <= n; j++) {
      H[j] = 0;
      G[j] = 0;
      K[j] = 0;
      L[j] = 0;
      E[j] = 0;
      S[j] = 0;
      Q[j] = 0;
    }
    for (let i = 1; i <= m; i++) {
      const base = i * W;
      const pb = base - W;
      H[base] = H[pb] - GS;
      G[base] = G[pb];
      K[base] = K[pb];
      L[base] = L[pb];
      E[base] = E[pb];
      S[base] = S[pb];
      Q[base] = Q[pb];
      const dense = rows[i - 1];
      for (let j = 1; j <= n; j++) {
        const d = pb + j - 1;
        const s = dense[ids[lo + j - 1]];
        let h: number;
        let g: number;
        let k: number;
        let l: number;
        let en: number;
        let sn: number;
        let qn: number;
        if (s >= MATCH_MIN) {
          const gain = s * weights[lo + j - 1];
          h = H[d] + gain;
          if (gain >= MEANINGFUL) {
            // only distinctive matches count as evidence; generic words never add up to it
            g = G[d] + gain;
            k = K[d] + 1;
            l = i;
            en = lo + j;
            sn = K[d] === 0 ? lo + j - 1 : S[d];
            qn = Q[d] + (i > m - 8 ? 1 : 0);
          } else {
            g = G[d];
            k = K[d];
            l = L[d];
            en = E[d];
            sn = S[d];
            qn = Q[d];
          }
        } else {
          h = H[d] - SUB;
          g = G[d];
          k = K[d];
          l = L[d];
          en = E[d];
          sn = S[d];
          qn = Q[d];
        }
        const u = pb + j;
        const hu = H[u] - GS;
        if (hu > h) {
          h = hu;
          g = G[u];
          k = K[u];
          l = L[u];
          en = E[u];
          sn = S[u];
          qn = Q[u];
        }
        const lf = base + j - 1;
        const hl = H[lf] - GN;
        if (hl > h) {
          h = hl;
          g = G[lf];
          k = K[lf];
          l = L[lf];
          en = E[lf];
          sn = S[lf];
          qn = Q[lf];
        }
        const c = base + j;
        H[c] = h;
        G[c] = g;
        K[c] = k;
        L[c] = l;
        E[c] = en;
        S[c] = sn;
        Q[c] = qn;
      }
    }
    const sc = this.index.scale;
    const last = m * W;
    let best: Cand | null = null;
    for (let j = 1; j <= n; j++) {
      const c = last + j;
      if (K[c] === 0) continue;
      const e = E[c];
      const dd = (e - p) / sc;
      const prior = dd > 6 ? 0.04 * (dd - 6) : dd < -4 ? Math.min(0.9, 0.02 * (-4 - dd)) : 0;
      const f = H[c] - prior;
      if (!best || f > best.f) best = { e, f, g: G[c], k: K[c], l: L[c], s: S[c], q: Q[c] };
    }
    return best;
  }
}
