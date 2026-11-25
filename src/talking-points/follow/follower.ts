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
import { NoteIndex } from "./tokenize";
import { VocabMatcher, MATCH_MIN } from "./similarity";
import { SpokenStream } from "./stream";

export type FollowState = "following" | "unsure" | "lost" | "paused";

export interface FollowSnapshot {
  /** Token index the speaker has reached (fractional, end of the last matched word). */
  position: number;
  /** 0..1. */
  confidence: number;
  state: FollowState;
}

export interface FollowerOptions {
  clock?: () => number;
  /** Silence after which the state reads "paused". */
  pauseMs?: number;
}

// Scoring (weights are 0.05..1, distinctive words ~0.5..1).
const GS = 0.12; // skip a spoken word (filler, digression)
const GN = 0.05; // skip a note word (paraphrase, shorter delivery)
const SUB = 0.08; // aligned but different word
const MEANINGFUL = 0.25;
const BACK_WORDS = 30;
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
  private lastInputAt = -Infinity;
  private pending: { e: number; added: number; miss: number } | null = null;
  private bufH = new Float32Array(0);
  private bufG = new Float32Array(0);
  private bufK = new Int16Array(0);
  private bufL = new Int16Array(0);
  private tailLen: number;

  constructor(private index: NoteIndex, opts: FollowerOptions = {}) {
    this.matcher = new VocabMatcher(index.vocab, index.vocabIdx);
    this.clock = opts.clock ?? (() => Date.now());
    this.pauseMs = opts.pauseMs ?? 3500;
    this.tailLen = Math.round(TAIL_WORDS * index.scale);
  }

  /** Replace the note (edited mid-meeting); keeps the place as a token index. */
  setIndex(index: NoteIndex): void {
    this.index = index;
    this.matcher = new VocabMatcher(index.vocab, index.vocabIdx);
    this.tailLen = Math.round(TAIL_WORDS * index.scale);
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
    this.lastAdded = 0;
  }

  snapshot(): FollowSnapshot {
    const paused = this.lastInputAt > -Infinity && this.clock() - this.lastInputAt > this.pauseMs;
    return {
      position: this.pos,
      confidence: this.conf,
      state: paused ? "paused" : this.baseState,
    };
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
    const rows = words.map((w) => this.matcher.row(w).dense);
    const p = Math.round(this.pos);

    const near = this.align(rows, Math.max(0, p - Math.round(BACK_WORDS * sc)), Math.min(N, p + Math.round(FWD_WORDS * sc)), p);
    let ev: Cand | null = near;
    let proposed = false;

    if (near && near.k > 0) {
      const dd = (near.e - p) / sc;
      if (dd >= -4 && dd <= 0.001) {
        // consistent with where we are (repeat, same place): hold
      } else if (dd > 0 && dd <= JUMP_WORDS) {
        if (near.g >= 0.55 && near.f >= 0.4) this.moveTo(near.e);
      } else if (dd > JUMP_WORDS) {
        if (near.g >= 1.2 && near.k >= 2 && near.f >= 0.8) proposed = this.propose(near);
      } else if (near.g >= 1.5 && near.k >= 3 && near.f >= 0.8) {
        proposed = this.propose(near);
      }
    }

    if (!near || near.g < 1.5) {
      const far = this.farCandidate(rows, words, p);
      if (far && far.g >= 2.0 && far.k >= 3 && far.g > (near ? near.g : 0) + 0.8) {
        if (this.propose(far)) proposed = true;
        if (Math.abs(this.pos - far.e) < 1) ev = far;
      }
    }
    if (!proposed && this.pending && ++this.pending.miss > 3) this.pending = null;

    // evidence / state
    const added = this.stream.added;
    const strong = !!ev && ev.l > 0 && (ev.g >= 0.8 || (ev.k >= 2 && ev.g >= 0.5));
    if (strong && ev) this.since = m - ev.l;
    else this.since += Math.max(0, added - this.lastAdded);
    this.lastAdded = added;
    const g = ev ? ev.g : 0;
    this.baseState = this.since <= 6 && strong ? "following" : this.since <= 16 ? "unsure" : "lost";
    this.conf = Math.max(0, Math.min(1, g / 2.5)) * Math.max(0, Math.min(1, 1 - this.since / 16));
  }

  private moveTo(e: number): void {
    this.pos = e;
  }

  /** Large moves must persist while at least two more words arrive. */
  private propose(c: Cand): boolean {
    const sc = this.index.scale;
    const added = this.stream.added;
    if (c.g >= 3.5) {
      this.pos = c.e;
      this.pending = null;
      return true;
    }
    const pend = this.pending;
    if (pend && Math.abs(pend.e - c.e) <= 25 * sc) {
      pend.miss = 0;
      if (added >= pend.added + 2) {
        this.pos = c.e;
        this.pending = null;
      } else {
        pend.e = c.e;
      }
    } else {
      this.pending = { e: c.e, added, miss: 0 };
    }
    return true;
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
    if (best < 0 || bestV < 1.5) return null;
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
    }
    const H = this.bufH;
    const G = this.bufG;
    const K = this.bufK;
    const L = this.bufL;
    const ids = this.index.ids;
    const weights = this.index.weights;
    for (let j = 0; j <= n; j++) {
      H[j] = 0;
      G[j] = 0;
      K[j] = 0;
      L[j] = 0;
    }
    for (let i = 1; i <= m; i++) {
      const base = i * W;
      const pb = base - W;
      H[base] = H[pb] - GS;
      G[base] = G[pb];
      K[base] = K[pb];
      L[base] = L[pb];
      const dense = rows[i - 1];
      for (let j = 1; j <= n; j++) {
        const d = pb + j - 1;
        const s = dense[ids[lo + j - 1]];
        let h: number;
        let g: number;
        let k: number;
        let l: number;
        if (s >= MATCH_MIN) {
          const gain = s * weights[lo + j - 1];
          h = H[d] + gain;
          g = G[d] + gain;
          if (gain >= MEANINGFUL) {
            k = K[d] + 1;
            l = i;
          } else {
            k = K[d];
            l = L[d];
          }
        } else {
          h = H[d] - SUB;
          g = G[d];
          k = K[d];
          l = L[d];
        }
        const u = pb + j;
        const hu = H[u] - GS;
        if (hu > h) {
          h = hu;
          g = G[u];
          k = K[u];
          l = L[u];
        }
        const lf = base + j - 1;
        const hl = H[lf] - GN;
        if (hl > h) {
          h = hl;
          g = G[lf];
          k = K[lf];
          l = L[lf];
        }
        const c = base + j;
        H[c] = h;
        G[c] = g;
        K[c] = k;
        L[c] = l;
      }
    }
    const sc = this.index.scale;
    const last = m * W;
    let best: Cand | null = null;
    for (let j = 1; j <= n; j++) {
      const c = last + j;
      if (K[c] === 0) continue;
      const e = lo + j;
      const dd = (e - p) / sc;
      const prior = dd > 6 ? 0.04 * (dd - 6) : dd < -4 ? 0.05 * (-4 - dd) : 0;
      const f = H[c] - prior;
      if (!best || f > best.f) best = { e, f, g: G[c], k: K[c], l: L[c] };
    }
    return best;
  }
}
