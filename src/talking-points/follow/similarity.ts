/** Word similarity (edit distance, stems, light phonetics) and a cached matcher against a note vocabulary. */

export const MATCH_MIN = 0.7;

function lev(a: string, b: string, cap: number): number {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > cap) return cap + 1;
  let prev = new Array<number>(lb + 1);
  let cur = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      let v = prev[j - 1] + cost;
      if (prev[j] + 1 < v) v = prev[j] + 1;
      if (cur[j - 1] + 1 < v) v = cur[j - 1] + 1;
      if (i > 1 && j > 1 && ca === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === b.charCodeAt(j - 1) && prev[j - 1] - cost + 1 < v) {
        v = prev[j - 1] - cost + 1; // transposition (approx.)
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > cap) return cap + 1;
    [prev, cur] = [cur, prev];
  }
  return prev[lb];
}

/** Consonant skeleton with a few sound-alike merges. */
function phoneticKey(w: string): string {
  let s = w
    .replace(/ph/g, "f")
    .replace(/ck/g, "k")
    .replace(/th/g, "t")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/[cq]/g, "k")
    .replace(/z/g, "s")
    .replace(/x/g, "ks")
    .replace(/y/g, "i")
    .replace(/(.)\1+/g, "$1");
  const head = s[0];
  s = head + s.slice(1).replace(/[aeiouh]/g, "");
  return s;
}

const isNumeric = (w: string) => w.charCodeAt(0) >= 48 && w.charCodeAt(0) <= 57;
const isCjk = (w: string) => w.charCodeAt(0) >= 0x3000;

/** Similarity of two normalised words, 0 when not a plausible match, 1 when equal. */
export function wordSim(a: string, b: string): number {
  if (a === b) return 1;
  if (isNumeric(a) || isNumeric(b) || isCjk(a) || isCjk(b)) return 0;
  const la = a.length;
  const lb = b.length;
  const mn = Math.min(la, lb);
  const mx = Math.max(la, lb);
  if (mn < 4) return 0;
  // stem / plural / inflection: one is a prefix of the other
  if (a.startsWith(b) || b.startsWith(a)) {
    const diff = mx - mn;
    if (diff <= 3) return 0.88;
    if (diff <= 5 && mn >= 5) return 0.78;
  }
  const cap = Math.max(1, Math.floor(mx * 0.25));
  const d = lev(a, b, cap);
  if (d <= cap) {
    const ratio = 1 - d / mx;
    if (ratio >= 0.74) return Math.min(0.95, ratio + 0.05);
  }
  if (mn >= 5 && d <= 2 && phoneticKey(a) === phoneticKey(b) && phoneticKey(a).length >= 3) return 0.78;
  return 0;
}

/** Similarity of one spoken word against every note vocabulary word, cached per spoken string. */
export class VocabMatcher {
  private cache = new Map<string, { dense: Float32Array; hits: Int32Array }>();
  private byLen = new Map<number, number[]>();
  private maxLen = 0;

  constructor(private vocab: string[], private vocabIdx: Map<string, number>) {
    vocab.forEach((w, i) => {
      const l = w.length;
      let arr = this.byLen.get(l);
      if (!arr) this.byLen.set(l, (arr = []));
      arr.push(i);
      if (l > this.maxLen) this.maxLen = l;
    });
  }

  row(word: string): { dense: Float32Array; hits: Int32Array } {
    const hit = this.cache.get(word);
    if (hit) return hit;
    if (this.cache.size > 500) this.cache.clear();
    const dense = new Float32Array(this.vocab.length);
    const hitIds: number[] = [];
    const exact = this.vocabIdx.get(word) ?? -1;
    if (exact >= 0) {
      dense[exact] = 1;
      hitIds.push(exact);
    }
    if (word.length >= 4 && !isNumeric(word) && !isCjk(word)) {
      const lo = Math.max(4, Math.ceil(word.length * 0.75) - 1);
      const hi = Math.floor(word.length / 0.75) + 1;
      for (let l = lo; l <= Math.min(hi, this.maxLen); l++) {
        const ids = this.byLen.get(l);
        if (!ids) continue;
        for (const id of ids) {
          if (id === exact) continue;
          const s = wordSim(word, this.vocab[id]);
          if (s >= MATCH_MIN) {
            dense[id] = s;
            hitIds.push(id);
          }
        }
      }
    }
    const entry = { dense, hits: Int32Array.from(hitIds) };
    this.cache.set(word, entry);
    return entry;
  }
}
