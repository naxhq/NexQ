/**
 * Tokenizer and note index for talking-point following.
 * Pure TypeScript, no dependencies. Used for both the note and the spoken stream so
 * both sides normalise the same way (accents folded, numbers canonical, contractions
 * expanded, CJK as overlapping character bigrams).
 */

export interface NoteBlock {
  id: string;
  text: string;
}

export interface RawToken {
  /** Normalised token text. */
  t: string;
  /** Char offsets in the source text. */
  start: number;
  end: number;
  cjk: boolean;
}

export interface Token extends RawToken {
  /** Index into `NoteIndex.blocks`. */
  block: number;
}

export interface BlockSpan {
  id: string;
  /** First token index. */
  first: number;
  /** One past the last token index. */
  end: number;
  /** Unique vocab ids of the block's distinctive words (weight >= DISTINCT_W). */
  distinct: number[];
  /** Unique vocab ids of all words in the block. */
  all: number[];
}

export interface NoteIndex {
  tokens: Token[];
  /** Vocab id per token. */
  ids: Int32Array;
  /** Weight (0.05..1) per token, from the note's own idf and word length. */
  weights: Float32Array;
  vocab: string[];
  vocabIdx: Map<string, number>;
  /** Weight per vocab id. */
  vocabW: Float32Array;
  /** Token positions per vocab id. */
  postings: number[][];
  blocks: BlockSpan[];
  /** Note tokens per spoken word, roughly (1 for spaced scripts, ~2 for CJK bigrams). */
  scale: number;
  cjk: boolean;
}

export const DISTINCT_W = 0.3;

// ---------------------------------------------------------------------------
// Raw tokenisation
// ---------------------------------------------------------------------------

const CJK_CLASS = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\u30FC\\u3005";
const WORD_RE = /[\p{L}\p{M}\p{N}]+(?:['’][\p{L}]+)*(?:[.,]\p{N}+)*|%/gu;
const RUN_RE = new RegExp(`[${CJK_CLASS}]+|[^${CJK_CLASS}]+`, "gu");
const CJK_TEST = new RegExp(`[${CJK_CLASS}]`, "u");
const MARKS_RE = /\p{M}/gu;
const NUMERIC_RE = /^[0-9][0-9.,]*$/;

const FILLERS = new Set([
  "um", "uh", "uhm", "er", "erm", "hmm", "mm", "mhm", "ah", "eh", "ahm", "ehm", "aah", "eeh", "umm", "uhh",
]);

const SPECIAL_FOLD: Record<string, string> = {
  "ß": "ss", "æ": "ae", "œ": "oe", "ø": "o", "ł": "l", "đ": "d", "ı": "i", "þ": "th",
};

function fold(s: string): string {
  let out = s.normalize("NFKC").toLowerCase().normalize("NFD").replace(MARKS_RE, "");
  out = out.replace(/[ßæœøłđıþ]/g, (c) => SPECIAL_FOLD[c] ?? c);
  return out;
}

function canonNumber(s: string): string {
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return s.replace(/,/g, "");
  return s.replace(",", ".");
}

const CONTRACTION_SUFFIX: Record<string, string> = {
  m: "am", re: "are", ve: "have", ll: "will", d: "would", s: "",
};
const IRREGULAR_NT: Record<string, string> = { can: "can", won: "will", shan: "shall", ain: "is" };

/** Splits a folded latin word with an apostrophe into tokens. */
function splitApostrophe(word: string): string[] {
  const parts = word.split(/['’]/).filter((x) => x.length > 0);
  if (parts.length < 2) return parts;
  const [stem, suffix] = [parts[0], parts[parts.length - 1]];
  if (parts.length === 2 && suffix === "t" && stem.endsWith("n")) {
    const base = IRREGULAR_NT[stem] ?? stem.slice(0, -1);
    return [base, "not"].filter(Boolean);
  }
  if (parts.length === 2 && suffix in CONTRACTION_SUFFIX) {
    const rep = CONTRACTION_SUFFIX[suffix];
    return rep ? [stem, rep] : [stem];
  }
  return parts;
}

function kataToHira(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    out += c >= 0x30a1 && c <= 0x30f6 ? String.fromCodePoint(c - 0x60) : ch;
  }
  return out;
}

/** Splits text into normalised raw tokens (before number merging). */
function rawTokens(text: string): RawToken[] {
  const out: RawToken[] = [];
  WORD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WORD_RE.exec(text))) {
    const raw = m[0];
    const base = m.index;
    if (raw === "%") {
      out.push({ t: "pct", start: base, end: base + 1, cjk: false });
      continue;
    }
    let r: RegExpExecArray | null;
    const runRe = new RegExp(RUN_RE.source, "gu");
    while ((r = runRe.exec(raw))) {
      const run = r[0];
      const rs = base + r.index;
      if (CJK_TEST.test(run[0])) {
        const chars = Array.from(kataToHira(run.normalize("NFKC")));
        if (chars.length === 1) {
          out.push({ t: chars[0], start: rs, end: rs + run.length, cjk: true });
        } else {
          let off = rs;
          for (let i = 0; i + 1 < chars.length; i++) {
            out.push({ t: chars[i] + chars[i + 1], start: off, end: off + chars[i].length + chars[i + 1].length, cjk: true });
            off += chars[i].length;
          }
        }
        continue;
      }
      const norm = run.normalize("NFKC");
      if (NUMERIC_RE.test(norm)) {
        out.push({ t: canonNumber(norm), start: rs, end: rs + run.length, cjk: false });
        continue;
      }
      const folded = fold(norm);
      for (const piece of splitApostrophe(folded)) {
        out.push({ t: piece, start: rs, end: rs + run.length, cjk: false });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Number words -> digits
// ---------------------------------------------------------------------------

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const SCALES: Record<string, number> = { thousand: 1000, million: 1e6, billion: 1e9 };

function isNumWord(w: string): boolean {
  return w in UNITS || w in TENS || w === "hundred" || w in SCALES;
}

/** A two-digit group (0..99) starting at i: tens [+ unit] | teen | unit. */
function twoDigitGroup(w: string[], i: number): { v: number; n: number } | null {
  const a = w[i];
  if (a === undefined) return null;
  if (a in TENS) {
    const b = w[i + 1];
    if (b !== undefined && b in UNITS && UNITS[b] >= 1 && UNITS[b] <= 9) return { v: TENS[a] + UNITS[b], n: 2 };
    return { v: TENS[a], n: 1 };
  }
  if (a in UNITS && UNITS[a] >= 10) return { v: UNITS[a], n: 1 };
  return null;
}

/** "nineteen ninety nine" / "twenty twenty four" / "twenty oh five". */
function parseYear(w: string[], i: number): { v: number; n: number } | null {
  const a = w[i];
  const first = a === "twenty" ? 20 : a in UNITS && UNITS[a] >= 13 && UNITS[a] <= 19 ? UNITS[a] : -1;
  if (first < 0) return null;
  if (w[i + 1] === "oh" && w[i + 2] in UNITS && UNITS[w[i + 2]] >= 1 && UNITS[w[i + 2]] <= 9) {
    return { v: first * 100 + UNITS[w[i + 2]], n: 3 };
  }
  const g = twoDigitGroup(w, i + 1);
  if (!g) return null;
  const nxt = w[i + 1];
  if (!(nxt in TENS || (nxt in UNITS && UNITS[nxt] >= 10))) return null;
  if (g.v < 10) return null;
  return { v: first * 100 + g.v, n: 1 + g.n };
}

function parseStandard(w: string[], i: number): { v: number; n: number } | null {
  if (!isNumWord(w[i])) return null;
  if (w[i] === "hundred" || w[i] in SCALES) return null;
  let total = 0;
  let cur = 0;
  let k = i;
  let used = 0;
  for (; k < w.length; k++) {
    const a = w[k];
    if (a in UNITS && UNITS[a] <= 9) {
      if (a === "zero" && (cur !== 0 || total !== 0 || k !== i)) break;
      if (cur % 100 !== 0 && cur % 10 !== 0) break;
      if (cur % 100 !== 0 && cur % 100 < 20) break;
      cur += UNITS[a];
    } else if (a in UNITS) {
      if (cur % 100 !== 0) break;
      cur += UNITS[a];
    } else if (a in TENS) {
      if (cur % 100 !== 0) break;
      cur += TENS[a];
    } else if (a === "hundred") {
      if (!(cur > 0 && cur < 100)) break;
      cur *= 100;
    } else if (a in SCALES) {
      if (cur <= 0) break;
      total += cur * SCALES[a];
      cur = 0;
    } else if (a === "and" && k + 1 < w.length && isNumWord(w[k + 1]) && (cur >= 100 || total > 0)) {
      used++;
      continue;
    } else break;
    used = k - i + 1;
  }
  if (used === 0) return null;
  return { v: total + cur, n: used };
}

function mergeNumbers(toks: RawToken[]): RawToken[] {
  const words = toks.map((t) => (t.cjk ? "" : t.t));
  const out: RawToken[] = [];
  for (let i = 0; i < toks.length; ) {
    const t = toks[i];
    if (t.cjk) {
      out.push(t);
      i++;
      continue;
    }
    const res = parseYear(words, i) ?? parseStandard(words, i);
    let value: string | null = null;
    let n = 0;
    if (res) {
      value = String(res.v);
      n = res.n;
    } else if (NUMERIC_RE.test(t.t)) {
      value = t.t;
      n = 1;
    }
    if (value !== null) {
      // "point" + digit words -> decimal ("two point four" -> 2.4)
      if (words[i + n] === "point") {
        let k = i + n + 1;
        let frac = "";
        while (k < toks.length && words[k] in UNITS && UNITS[words[k]] <= 9) {
          frac += UNITS[words[k]];
          k++;
        }
        if (frac) {
          value += "." + frac;
          n = k - i;
        }
      }
      out.push({ t: value, start: t.start, end: toks[i + n - 1].end, cjk: false });
      i += n;
      continue;
    }
    out.push(t);
    i++;
  }
  return out;
}

/** Tokenise any text (note block or speech) into normalised tokens with offsets. */
export function tokenizeText(text: string): RawToken[] {
  const raw = rawTokens(text)
    .map((t) => (t.t === "percent" || t.t === "prozent" || t.t === "porciento" ? { ...t, t: "pct" } : t))
    .filter((t) => !FILLERS.has(t.t));
  return mergeNumbers(raw);
}

/** Spoken text to word strings. */
export function spokenWords(text: string): string[] {
  return tokenizeText(text).map((t) => t.t);
}

// ---------------------------------------------------------------------------
// Note index
// ---------------------------------------------------------------------------

function lenFactor(t: string, cjk: boolean): number {
  if (cjk) return Array.from(t).length >= 2 ? 1 : 0.25;
  if (t === "pct") return 0.4;
  if (/^[0-9]/.test(t)) return t.length >= 2 ? 1 : 0.3;
  const n = t.length;
  if (n <= 1) return 0.1;
  if (n === 2) return 0.18;
  if (n === 3) return 0.3;
  if (n === 4) return 0.65;
  if (n === 5) return 0.9;
  return 1;
}

/** Builds the token index and idf weights from the note blocks. */
export function buildNoteIndex(blocks: NoteBlock[]): NoteIndex {
  const tokens: Token[] = [];
  const spans: BlockSpan[] = [];
  blocks.forEach((b, bi) => {
    const first = tokens.length;
    for (const t of tokenizeText(b.text)) tokens.push({ ...t, block: bi });
    spans.push({ id: b.id, first, end: tokens.length, distinct: [], all: [] });
  });

  const cjkCount = tokens.reduce((n, t) => n + (t.cjk ? 1 : 0), 0);
  const cjk = tokens.length > 0 && cjkCount / tokens.length > 0.5;
  const scale = cjk ? 2.2 : 1;

  const vocabIdx = new Map<string, number>();
  const vocab: string[] = [];
  const ids = new Int32Array(tokens.length);
  const postings: number[][] = [];
  tokens.forEach((t, i) => {
    let id = vocabIdx.get(t.t);
    if (id === undefined) {
      id = vocab.length;
      vocab.push(t.t);
      vocabIdx.set(t.t, id);
      postings.push([]);
    }
    ids[i] = id;
    postings[id].push(i);
  });

  // idf over units: blocks cut into chunks of <= 24 (scaled) tokens
  const unitLen = Math.round(24 * scale);
  const df = new Int32Array(vocab.length);
  let units = 0;
  for (const s of spans) {
    for (let a = s.first; a < s.end; a += unitLen) {
      units++;
      const seen = new Set<number>();
      for (let i = a; i < Math.min(s.end, a + unitLen); i++) seen.add(ids[i]);
      for (const id of seen) df[id]++;
    }
  }
  const denom = Math.log(1 + (units + 1) / 1.5);
  const vocabW = new Float32Array(vocab.length);
  const isCjkWord = (w: string) => CJK_TEST.test(w[0]);
  for (let id = 0; id < vocab.length; id++) {
    const idf = Math.log(1 + (units + 1) / (df[id] + 0.5)) / denom;
    vocabW[id] = Math.max(0.05, idf * lenFactor(vocab[id], isCjkWord(vocab[id])));
  }
  const weights = new Float32Array(tokens.length);
  for (let i = 0; i < tokens.length; i++) weights[i] = vocabW[ids[i]];

  for (const s of spans) {
    const all = new Set<number>();
    for (let i = s.first; i < s.end; i++) all.add(ids[i]);
    s.all = [...all];
    s.distinct = s.all.filter((id) => vocabW[id] >= DISTINCT_W);
  }

  return { tokens, ids, weights, vocab, vocabIdx, vocabW, postings, blocks: spans, scale, cjk };
}
