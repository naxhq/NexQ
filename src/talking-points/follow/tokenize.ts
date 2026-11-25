/**
 * Tokenizer and note index for talking-point following.
 * Pure TypeScript, no dependencies. Used for both the note and the spoken stream so
 * both sides normalise the same way: accents folded, numbers canonical (English, Spanish,
 * German, French, Portuguese number words, kanji numerals, "4.2M", ordinals, "Q3"),
 * contractions expanded, spelled letters joined, CJK and Hangul as overlapping bigrams.
 */

export interface NoteBlock {
  id: string;
  text: string;
}

export interface RawToken {
  /** Normalised token text. */
  t: string;
  /** Char offsets in the source text (approximate for converted kanji numerals). */
  start: number;
  end: number;
  cjk: boolean;
  /** CJK/Hangul bigram weight class (1 = distinctive unit, low for particles/inflection). */
  cw?: number;
  /** Written as an ALLCAPS acronym. */
  acr?: boolean;
}

export interface Token extends RawToken {
  /** Index into `NoteIndex.blocks`. */
  block: number;
}

export interface BlockSpan {
  id: string;
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
  ids: Int32Array;
  weights: Float32Array;
  vocab: string[];
  vocabIdx: Map<string, number>;
  vocabW: Float32Array;
  /** 1 for vocab entries that are values that can contradict (numbers, months). */
  vocabNum: Uint8Array;
  postings: number[][];
  blocks: BlockSpan[];
  /** Note tokens per spoken word, roughly (1 for spaced scripts, ~2 for bigram scripts). */
  scale: number;
  cjk: boolean;
}

export const DISTINCT_W = 0.3;

// ---------------------------------------------------------------------------
// Raw tokenisation
// ---------------------------------------------------------------------------

const CJK_CLASS = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}\\u30FC\\u3005";
const WORD_RE = /[\p{L}\p{M}\p{N}]+(?:['’][\p{L}]+)*(?:[.,]\p{N}+)*|%/gu;
const RUN_SRC = `[${CJK_CLASS}]+|[^${CJK_CLASS}]+`;
const CJK_TEST = new RegExp(`[${CJK_CLASS}]`, "u");
const MARKS_RE = /\p{M}/gu;
const NUMERIC_RE = /^[0-9][0-9.,]*$/;
const HAN = /\p{Script=Han}/u;
const HANGUL = /\p{Script=Hangul}/u;
const KATA = /[\p{Script=Katakana}ー]/u;

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

const CONTRACTION_SUFFIX: Record<string, string> = { m: "am", re: "are", ve: "have", ll: "will", d: "would", s: "" };
const IRREGULAR_NT: Record<string, string> = { can: "can", won: "will", shan: "shall", ain: "is" };

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

// -- CJK numerals ------------------------------------------------------------

const KDIGIT: Record<string, number> = { "〇": 0, "零": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };
const KPLACE: Record<string, number> = { "十": 10, "百": 100, "千": 1000 };
const KBIG: Record<string, number> = { "万": 1e4, "億": 1e8, "亿": 1e8 };
const KUNIT_AFTER = "年月日名人円倍個件割社位台回%％パ个元块号岁";
const KRUN_RE = /[〇零一二三四五六七八九十百千万億亿]+/gu;

function parseKanji(run: string): number | null {
  const chars = Array.from(run);
  if (chars.every((c) => c in KDIGIT)) {
    if (chars.length < 2) return chars.length === 1 ? KDIGIT[chars[0]] : null;
    if (!chars.some((c) => c === "〇" || c === "零")) return null; // "一四": not a number
    return Number(chars.map((c) => KDIGIT[c]).join(""));
  }
  let total = 0;
  let sec = 0;
  let cur = -1;
  for (const c of chars) {
    if (c in KDIGIT) {
      if (cur >= 0) return null;
      cur = KDIGIT[c];
    } else if (c in KPLACE) {
      sec += (cur >= 0 ? cur : 1) * KPLACE[c];
      cur = -1;
    } else {
      total += ((sec + (cur >= 0 ? cur : 0)) || 1) * KBIG[c];
      sec = 0;
      cur = -1;
    }
  }
  return total + sec + (cur >= 0 ? cur : 0);
}

/** Replaces kanji numeral runs with digits where context says it is a number. Keeps an offset map. */
function convertKanji(raw: string): { s: string; map: number[] | null } {
  if (!/[〇零一二三四五六七八九十百千万億亿]/u.test(raw)) return { s: raw, map: null };
  let s = "";
  const map: number[] = [];
  let last = 0;
  let changed = false;
  KRUN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  const push = (txt: string, from: number, keepIdx: boolean) => {
    for (let i = 0; i < txt.length; i++) {
      s += txt[i];
      map.push(keepIdx ? from + i : from);
    }
  };
  while ((m = KRUN_RE.exec(raw))) {
    const run = m[0];
    const after = raw[m.index + run.length] ?? "";
    const before = raw[m.index - 1] ?? "";
    const ordinal = before === "第";
    const ok = !ordinal && (run.length >= 2 || KUNIT_AFTER.includes(after));
    const v = ok ? parseKanji(run) : null;
    push(raw.slice(last, m.index), last, true);
    if (v === null) push(run, m.index, true);
    else {
      push(String(v), m.index, false);
      changed = true;
    }
    last = m.index + run.length;
  }
  push(raw.slice(last), last, true);
  return changed ? { s, map } : { s: raw, map: null };
}

// -- CJK weights -------------------------------------------------------------

const ZH_FUNC = new Set(Array.from("的了是在和与及也都就而对为把被有不我你他她它这那个们很会能还要"));
const KO_PARTICLE = new Set(Array.from("은는이가을를의에도와과로"));

function bigramWeight(a: string, b: string, last: boolean, runLen: number): number {
  if (HANGUL.test(a) || HANGUL.test(b)) return last && runLen >= 3 && KO_PARTICLE.has(b) ? 0.55 : 1;
  const ha = !HAN.test(a) && !KATA.test(a);
  const hb = !HAN.test(b) && !KATA.test(b);
  if (ha && hb) return 0.12;
  if (ha || hb) return KATA.test(a) || KATA.test(b) ? 0.6 : 0.45;
  if (ZH_FUNC.has(a) || ZH_FUNC.has(b)) return 0.35;
  return 1;
}

// -- raw tokens --------------------------------------------------------------

const ORD_SUFFIX_RE = /^(\d+)(?:st|nd|rd|th)$/i;
const AMOUNT_RE = /^(\d+(?:\.\d+)?)([kmb])$/i;
const AMOUNT_WORD: Record<string, string> = { k: "thousand", m: "million", b: "billion", bn: "billion" };
const Q_RE = /^q([1-4])$/i;
const COMPOUND_DE_RE = /^([a-z]+?)und([a-z]+)$/;

function rawTokens(text: string): RawToken[] {
  const out: RawToken[] = [];
  WORD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WORD_RE.exec(text))) {
    const base = m.index;
    if (m[0] === "%") {
      out.push({ t: "pct", start: base, end: base + 1, cjk: false });
      continue;
    }
    const { s: raw, map } = convertKanji(m[0]);
    const off = (i: number) => base + (map ? map[Math.min(i, map.length - 1)] : i);
    const runRe = new RegExp(RUN_SRC, "gu");
    let r: RegExpExecArray | null;
    while ((r = runRe.exec(raw))) {
      const run = r[0];
      const start = off(r.index);
      const end = map ? off(r.index + run.length - 1) + 1 : start + run.length;
      if (CJK_TEST.test(run[0])) {
        const orig = Array.from(run.normalize("NFKC"));
        const chars = orig.map((c) => kataToHira(c));
        if (chars.length === 1) {
          out.push({ t: chars[0], start, end, cjk: true, cw: 0.25 });
        } else {
          let o = start;
          for (let i = 0; i + 1 < chars.length; i++) {
            out.push({
              t: chars[i] + chars[i + 1],
              start: o,
              end: o + 2,
              cjk: true,
              cw: bigramWeight(orig[i], orig[i + 1], i === chars.length - 2, chars.length),
            });
            o += 1;
          }
        }
        continue;
      }
      const norm = run.normalize("NFKC");
      if (NUMERIC_RE.test(norm)) {
        out.push({ t: canonNumber(norm), start, end, cjk: false });
        continue;
      }
      let mm: RegExpExecArray | null;
      if ((mm = ORD_SUFFIX_RE.exec(norm))) {
        out.push({ t: mm[1], start, end, cjk: false });
        continue;
      }
      if ((mm = AMOUNT_RE.exec(norm))) {
        out.push({ t: mm[1], start, end: start + mm[1].length, cjk: false });
        out.push({ t: AMOUNT_WORD[mm[2].toLowerCase()], start: end - 1, end, cjk: false });
        continue;
      }
      if ((mm = Q_RE.exec(norm))) {
        out.push({ t: "quarter", start, end, cjk: false });
        out.push({ t: mm[1], start, end, cjk: false });
        continue;
      }
      const acr = /^[A-Z]{2,6}$/.test(norm);
      const folded = fold(norm);
      for (const piece of splitApostrophe(folded)) {
        const de = COMPOUND_DE_RE.exec(piece);
        if (de && de[1] in UNITS && de[2] in TENS && UNITS[de[1]] >= 1 && UNITS[de[1]] <= 9) {
          out.push({ t: de[2], start, end, cjk: false }, { t: "und", start, end, cjk: false }, { t: de[1], start, end, cjk: false });
        } else {
          out.push(acr ? { t: piece, start, end, cjk: false, acr } : { t: piece, start, end, cjk: false });
        }
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
  // es
  cero: 0, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19,
  // de
  eins: 1, zwei: 2, drei: 3, vier: 4, funf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10, elf: 11, zwolf: 12,
  dreizehn: 13, vierzehn: 14, funfzehn: 15, sechzehn: 16, siebzehn: 17, achtzehn: 18, neunzehn: 19,
  // fr
  deux: 2, trois: 3, quatre: 4, sept: 7, huit: 8, neuf: 9, dix: 10, onze: 11, douze: 12, treize: 13, quatorze: 14,
  quinze: 15, seize: 16,
  // pt
  dois: 2, duas: 2, sete: 7, oito: 8, dez: 10, dezesseis: 16, dezasseis: 16, dezessete: 17, dezassete: 17,
  dezoito: 18, dezenove: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90,
  zwanzig: 20, dreissig: 30, vierzig: 40, funfzig: 50, sechzig: 60, siebzig: 70, achtzig: 80, neunzig: 90,
  vingt: 20, trente: 30, quarante: 40, cinquante: 50, soixante: 60,
  vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50, sessenta: 60, oitenta: 80,
};
const FULL: Record<string, number> = {
  veintiuno: 21, veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25, veintiseis: 26,
  veintisiete: 27, veintiocho: 28, veintinueve: 29,
};
const HUND: Record<string, number> = { cien: 100, ciento: 100, cem: 100, cento: 100, hundert: 100 };
const SCALES: Record<string, number> = { thousand: 1000, million: 1e6, billion: 1e9 };
const CONN = new Set(["y", "e", "et", "und"]);
const ORD: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12, twentieth: 20, thirtieth: 30,
};
const MONTHS = new Set([
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
]);

export const isMonth = (w: string) => MONTHS.has(w);

const isUnitDigit = (w: string | undefined) => w !== undefined && w in UNITS && UNITS[w] >= 1 && UNITS[w] <= 9;
const isNumWord = (w: string) => w in UNITS || w in TENS || w in FULL || w in HUND || w === "hundred" || w in SCALES;

function twoDigitGroup(w: string[], i: number): { v: number; n: number } | null {
  const a = w[i];
  if (a === undefined) return null;
  if (a in TENS) {
    if (isUnitDigit(w[i + 1])) return { v: TENS[a] + UNITS[w[i + 1]], n: 2 };
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
  if (w[i + 1] === "oh" && isUnitDigit(w[i + 2])) return { v: first * 100 + UNITS[w[i + 2]], n: 3 };
  const nxt = w[i + 1];
  if (!(nxt in TENS || (nxt in UNITS && UNITS[nxt] >= 10))) return null;
  const g = twoDigitGroup(w, i + 1);
  if (!g || g.v < 10) return null;
  return { v: first * 100 + g.v, n: 1 + g.n };
}

function parseStandard(w: string[], i: number): { v: number; n: number } | null {
  if (!isNumWord(w[i])) return null;
  if (w[i] in FULL) return { v: FULL[w[i]], n: 1 };
  if (w[i] === "hundred" || w[i] in SCALES) return null;
  let total = 0;
  let cur = 0;
  let used = 0;
  for (let k = i; k < w.length; k++) {
    const a = w[k];
    if (a === "quatre" && (w[k + 1] === "vingt" || w[k + 1] === "vingts") && cur % 100 === 0) {
      cur += 80;
      k++;
    } else if (a in UNITS && UNITS[a] <= 9) {
      if (a === "zero" && (cur !== 0 || total !== 0 || k !== i)) break;
      if (cur !== 10 || UNITS[a] < 7) {
        if (cur % 100 !== 0 && cur % 10 !== 0) break;
        if (cur % 100 !== 0 && cur % 100 < 20) break;
      }
      cur += UNITS[a]; // fr "dix sept" = 17
    } else if (a in UNITS) {
      const tens = cur % 100;
      if (tens !== 0 && !(tens === 60 || tens === 80)) break; // fr "soixante dix"
      cur += UNITS[a];
    } else if (a in TENS) {
      if (cur % 100 !== 0) break;
      cur += TENS[a];
    } else if (a in HUND) {
      if (cur !== 0) break;
      cur = 100;
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
    } else if (CONN.has(a) && cur % 100 >= 20 && cur % 10 === 0 && isUnitDigit(w[k + 1])) {
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
      // "twenty first" -> 21
      const nx = words[i + n];
      if (res.v >= 20 && res.v < 100 && res.v % 10 === 0 && nx in ORD && ORD[nx] <= 9) {
        value = String(res.v + ORD[nx]);
        n++;
      }
    } else if (NUMERIC_RE.test(t.t)) {
      value = t.t;
      n = 1;
    } else if (t.t in ORD) {
      value = String(ORD[t.t]);
      n = 1;
    }
    if (value !== null) {
      if (words[i + n] === "point" && /^\d+$/.test(value)) {
        let k = i + n + 1;
        let frac = "";
        while (k < toks.length && (isUnitDigit(words[k]) || words[k] === "zero")) {
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

/** "a r r" -> "arr". */
function joinLetters(toks: RawToken[]): RawToken[] {
  const out: RawToken[] = [];
  for (let i = 0; i < toks.length; ) {
    const isL = (t: RawToken) => !t.cjk && t.t.length === 1 && /[a-z]/.test(t.t);
    if (isL(toks[i]) && i + 1 < toks.length && isL(toks[i + 1])) {
      let k = i;
      let s = "";
      while (k < toks.length && isL(toks[k])) s += toks[k++].t;
      out.push({ t: s, start: toks[i].start, end: toks[k - 1].end, cjk: false, acr: true });
      i = k;
    } else {
      out.push(toks[i]);
      i++;
    }
  }
  return out;
}

/** "$4.2M" -> 4.2 million; "first quarter" -> quarter 1; "5th of March" -> march 5. */
function normalisePhrases(toks: RawToken[]): RawToken[] {
  const a: RawToken[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const nx = toks[i + 1];
    if (nx && /^\d+(\.\d+)?$/.test(t.t) && nx.start === t.end && AMOUNT_WORD[nx.t] && nx.t.length <= 2) {
      a.push(t, { ...nx, t: AMOUNT_WORD[nx.t] });
      i++;
    } else a.push(t);
  }
  const out: RawToken[] = [];
  for (let i = 0; i < a.length; i++) {
    const t = a[i];
    const nx = a[i + 1];
    if (t.t === "q" && nx && /^[1-4]$/.test(nx.t)) {
      out.push({ ...t, t: "quarter" }, nx);
      i++;
      continue;
    }
    if (nx && nx.t === "quarter" && /^[1-4]$/.test(t.t) && !t.cjk) {
      out.push(nx, t);
      i++;
      continue;
    }
    const nn = a[i + 2];
    if (/^([1-9]|[12]\d|3[01])$/.test(t.t) && nx && nx.t === "of" && nn && MONTHS.has(nn.t)) {
      out.push(nn, t);
      i += 2;
      continue;
    }
    if (/^([1-9]|[12]\d|3[01])$/.test(t.t) && nx && MONTHS.has(nx.t)) {
      out.push(nx, t);
      i++;
      continue;
    }
    out.push(t);
  }
  return out;
}

/** Tokenise any text (note block or speech) into normalised tokens with offsets. */
export function tokenizeText(text: string): RawToken[] {
  const raw = rawTokens(text)
    .map((t) => (t.t === "percent" || t.t === "prozent" || t.t === "porciento" || t.t === "procent" ? { ...t, t: "pct" } : t))
    .filter((t) => !FILLERS.has(t.t));
  return normalisePhrases(mergeNumbers(joinLetters(raw)));
}

/** Spoken text to word strings. */
export function spokenWords(text: string): string[] {
  return tokenizeText(text).map((t) => t.t);
}

// ---------------------------------------------------------------------------
// Note index
// ---------------------------------------------------------------------------

function lenFactor(t: string, cjk: boolean, cw: number, acr: boolean): number {
  if (cjk) return cw;
  if (t === "pct") return 0.4;
  if (/^[0-9]/.test(t)) return t.length >= 2 ? 1 : 0.3;
  if (acr && t.length >= 2) return 0.9;
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
  const vcw: number[] = [];
  const vacr: boolean[] = [];
  tokens.forEach((t, i) => {
    let id = vocabIdx.get(t.t);
    if (id === undefined) {
      id = vocab.length;
      vocab.push(t.t);
      vocabIdx.set(t.t, id);
      postings.push([]);
      vcw.push(0);
      vacr.push(false);
    }
    ids[i] = id;
    postings[id].push(i);
    vcw[id] = Math.max(vcw[id], t.cw ?? 1);
    if (t.acr) vacr[id] = true;
  });

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
  const vocabNum = new Uint8Array(vocab.length);
  for (let id = 0; id < vocab.length; id++) {
    const idf = Math.log(1 + (units + 1) / (df[id] + 0.5)) / denom;
    const isC = CJK_TEST.test(vocab[id][0]);
    vocabW[id] = Math.max(0.05, idf * lenFactor(vocab[id], isC, vcw[id], vacr[id]));
    vocabNum[id] = /^[0-9]/.test(vocab[id]) || MONTHS.has(vocab[id]) ? 1 : 0;
  }
  const weights = new Float32Array(tokens.length);
  for (let i = 0; i < tokens.length; i++) weights[i] = vocabW[ids[i]];

  for (const s of spans) {
    const all = new Set<number>();
    for (let i = s.first; i < s.end; i++) all.add(ids[i]);
    s.all = [...all];
    s.distinct = s.all.filter((id) => vocabW[id] >= DISTINCT_W);
  }

  return { tokens, ids, weights, vocab, vocabIdx, vocabW, vocabNum, postings, blocks: spans, scale, cjk };
}
