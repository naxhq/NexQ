import { spokenWords } from "./tokenize";

export interface StreamSeg {
  id: string;
  words: string[];
  final: boolean;
  firstAt: number;
  lastAt: number;
}

/**
 * The user's spoken stream: ordered segments. An interim is replaced by the next
 * interim or final of the same segment id, so corrections never double count.
 */
export class SpokenStream {
  segs: StreamSeg[] = [];
  private byId = new Map<string, StreamSeg>();
  /** Words ever added (monotonic, for "words since evidence"). */
  added = 0;

  set(id: string, text: string, final: boolean, now: number): boolean {
    const words = spokenWords(text);
    let seg = this.byId.get(id);
    if (!seg) {
      seg = { id, words, final, firstAt: now, lastAt: now };
      this.byId.set(id, seg);
      this.segs.push(seg);
      this.added += words.length;
      return true;
    }
    if (seg.final && !final) return false; // a late interim never overrides a final
    const same = seg.final === final && seg.words.length === words.length && seg.words.every((w, i) => w === words[i]);
    if (words.length > seg.words.length) this.added += words.length - seg.words.length;
    seg.words = words;
    seg.final = final;
    seg.lastAt = now;
    return !same;
  }

  /** Drops segments beyond `keepWords` words (newest kept) or older than `maxAgeMs`. */
  prune(keepWords: number, now: number, maxAgeMs = Infinity): void {
    let total = 0;
    let cut = 0;
    for (let i = this.segs.length - 1; i >= 0; i--) {
      const s = this.segs[i];
      total += s.words.length;
      if (total > keepWords || now - s.lastAt > maxAgeMs) {
        cut = i + 1;
        break;
      }
    }
    if (cut > 0) {
      for (const s of this.segs.slice(0, cut)) this.byId.delete(s.id);
      this.segs = this.segs.slice(cut);
    }
  }

  /** The newest `n` words in order. */
  tail(n: number): string[] {
    const out: string[] = [];
    for (let i = this.segs.length - 1; i >= 0 && out.length < n; i--) {
      const w = this.segs[i].words;
      for (let k = w.length - 1; k >= 0 && out.length < n; k--) out.push(w[k]);
    }
    return out.reverse();
  }

  /** Whole newest segments (the current line), extended backwards only until `min` words, capped at `max`. */
  recentSegments(min: number, max: number): string[] {
    const out: string[][] = [];
    let n = 0;
    for (let i = this.segs.length - 1; i >= 0 && n < min; i--) {
      out.push(this.segs[i].words);
      n += this.segs[i].words.length;
    }
    const all = out.reverse().flat();
    return all.length > max ? all.slice(all.length - max) : all;
  }

  clear(): void {
    this.segs = [];
    this.byId.clear();
  }
}
