// Text that becomes standing instructions is plain text: no HTML, no link or image targets or titles,
// no reference definitions, no hidden, control or bidi characters. The same rules live in Rust
// (`sanitize_instruction_text` in workspace_chat/ops.rs); both are checked against
// `src/contracts/vectors/instruction_text.json`. What the person reviews is what is stored: the
// backend refuses text that sanitising would change.

/** Most characters (code points) of instruction text added at once. */
export const INSTRUCTION_CAP = 4000;

// Hidden characters: the same rules as `strip_hidden` in Rust (prompt_data.rs). What the model reads
// must be what the person can see: control, zero-width, bidi, tag and other format characters and
// stray variation selectors go; joiners inside the scripts that use them, emoji sequences and the
// glyph-choice selectors after Han characters and symbols stay.

/**
 * Everything invisible that this pass removes: control characters, the Unicode default-ignorable and
 * format (Cf) characters, the tag block, noncharacters and unpaired surrogates. A zero-width space stays only
 * between two letters of Thai, Lao, Khmer or Myanmar; joiners stay after a letter of the scripts that spell with them. Kept on purpose: the
 * Arabic number signs (U+0600-0605, 06DD, 070F, 0890-0891, 08E2, 110BD, 110CD), which print a visible
 * mark, and private-use characters (they print in some fonts). U+2028 and U+2029 become a newline.
 * The same table is `hidden_always` in prompt_data.rs; the test `every code point agrees` checks both
 * against `strip_hidden_table.json`.
 */
function hiddenAlways(cp: number): boolean {
  return (
    cp <= 0x08 ||
    cp === 0x0b ||
    cp === 0x0c ||
    (cp >= 0x0e && cp <= 0x1f) ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0xad ||
    cp === 0x034f ||
    cp === 0x061c ||
    cp === 0x115f ||
    cp === 0x1160 ||
    cp === 0x17b4 ||
    cp === 0x17b5 ||
    cp === 0x180e ||
    cp === 0x200e ||
    cp === 0x200f ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x206f) ||
    cp === 0x3164 ||
    (cp >= 0xfdd0 && cp <= 0xfdef) ||
    cp === 0xfeff ||
    cp === 0xffa0 ||
    (cp >= 0xfff0 && cp <= 0xfffb) ||
    (cp >= 0x13430 && cp <= 0x1345f) ||
    (cp >= 0x1bca0 && cp <= 0x1bca3) ||
    (cp >= 0x1d173 && cp <= 0x1d17a) ||
    (cp >= 0xe0000 && cp <= 0xe00ff) ||
    (cp >= 0xe01f0 && cp <= 0xe0fff) ||
    (cp & 0xfffe) === 0xfffe ||
    (cp >= 0xd800 && cp <= 0xdfff)
  );
}

const inRange = (cp: number, lo: number, hi: number) => cp >= lo && cp <= hi;

const isSelector = (cp: number) => inRange(cp, 0xfe00, 0xfe0f) || inRange(cp, 0xe0100, 0xe01ef) || inRange(cp, 0x180b, 0x180d) || cp === 0x180f;

const isHan = (cp: number) => inRange(cp, 0x3400, 0x4dbf) || inRange(cp, 0x4e00, 0x9fff) || inRange(cp, 0xf900, 0xfaff) || inRange(cp, 0x20000, 0x323af);

/** Symbols, arrows, math, dingbats, shapes and the emoji blocks, and a few single signs. */
const isSymbolBase = (cp: number) =>
  [0xa9, 0xae, 0x203c, 0x2049, 0x3030, 0x303d, 0x3297, 0x3299].includes(cp) || inRange(cp, 0x2100, 0x2bff) || inRange(cp, 0x1f000, 0x1faff);

const isMongolian = (cp: number) => inRange(cp, 0x1820, 0x18af);

/** A letter or vowel sign of a script whose spelling uses joiners (digits and punctuation excluded). */
function joinerLetter(cp: number): boolean {
  const inScript =
    inRange(cp, 0x0600, 0x06ff) ||
    inRange(cp, 0x0700, 0x074f) ||
    inRange(cp, 0x0750, 0x077f) ||
    inRange(cp, 0x08a0, 0x08ff) ||
    inRange(cp, 0xfb50, 0xfdff) ||
    inRange(cp, 0xfe70, 0xfefe) ||
    inRange(cp, 0x0900, 0x0dff) ||
    inRange(cp, 0x1000, 0x109f) ||
    inRange(cp, 0x1780, 0x17ff) ||
    inRange(cp, 0x1800, 0x18af);
  const notLetter =
    inRange(cp, 0x0660, 0x0669) ||
    inRange(cp, 0x06f0, 0x06f9) ||
    inRange(cp, 0x066a, 0x066d) ||
    [0x060c, 0x061b, 0x061f, 0x06d4, 0x0964, 0x0965, 0x0970].includes(cp) ||
    inRange(cp, 0x104a, 0x104f) ||
    inRange(cp, 0x17d4, 0x17dc) ||
    inRange(cp, 0x1800, 0x180f);
  return inScript && !notLetter;
}

function joinerOk(cp: number, base: number, next: number): boolean {
  // after a letter or vowel sign of a script that spells with joiners: inside a word (Persian half-space,
  // Indic conjuncts) and at its end (Malayalam chillu forms, Arabic heh with a joiner)
  if (joinerLetter(base)) return true;
  // an emoji sequence: only the zero-width joiner, between two symbols
  return cp === 0x200d && isSymbolBase(base) && isSymbolBase(next);
}

/** A letter of a script written without spaces (Thai, Lao, Khmer, Myanmar): a zero-width space between two is a word break. */
function breakLetter(cp: number): boolean {
  const inScript = inRange(cp, 0x0e01, 0x0e7f) || inRange(cp, 0x0e81, 0x0eff) || inRange(cp, 0x1780, 0x17ff) || inRange(cp, 0x1000, 0x109f);
  const notLetter =
    inRange(cp, 0x0e50, 0x0e5b) || cp === 0x0e4f || inRange(cp, 0x0ed0, 0x0ed9) || inRange(cp, 0x17d4, 0x17dc) || inRange(cp, 0x17e0, 0x17e9) || inRange(cp, 0x1040, 0x104f);
  return inScript && !notLetter;
}

function selectorOk(cp: number, base: number, next: number): boolean {
  if (cp === 0xfe0f && ((base >= 0x30 && base <= 0x39) || base === 0x23 || base === 0x2a)) return next === 0x20e3;
  if (inRange(cp, 0xfe00, 0xfe0f)) return isHan(base) || isSymbolBase(base);
  if (inRange(cp, 0xe0100, 0xe01ef)) return isHan(base);
  return isMongolian(base);
}

/** Hidden characters out, real writing kept. Linear; never changes a visible character. */
export function stripHidden(text: string): string {
  const chars = Array.from(text);
  const out: string[] = [];
  let base = 0;
  let last: "other" | "joiner" | "selector" = "other";
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const cp = c.codePointAt(0)!;
    if (hiddenAlways(cp)) continue;
    if (cp === 0x2028 || cp === 0x2029) {
      out.push("\n");
      base = 0x0a;
      last = "other";
      continue;
    }
    const next = i + 1 < chars.length ? chars[i + 1].codePointAt(0)! : 0;
    if (cp === 0x200b) {
      if (last === "joiner" || !(breakLetter(base) && breakLetter(next))) continue;
      out.push(c);
      last = "joiner";
      continue;
    }
    if (cp === 0x200c || cp === 0x200d) {
      if (last === "joiner" || !joinerOk(cp, base, next)) continue;
      out.push(c);
      last = "joiner";
      continue;
    }
    if (isSelector(cp)) {
      if (last !== "other" || !selectorOk(cp, base, next)) continue;
      out.push(c);
      last = "selector";
      continue;
    }
    out.push(c);
    base = cp;
    last = "other";
  }
  return out.join("");
}

function onePass(raw: string, cap: number): string {
  let t = stripHidden(raw.replace(/\r\n?/g, "\n"));
  t = t
    .replace(/\s?\[S\d+(?:\s*,\s*S\d+)*\]/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(/^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*\S.*$/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return Array.from(t).slice(0, cap).join("").trimEnd();
}

/** Most characters (code points) of a document saved from an answer. */
export const DOCUMENT_CAP = 100_000;

/**
 * Plain text up to `cap` characters. Applied until nothing changes, so that what comes out is a
 * fixed point (cleaning it again returns it as it is): that is what lets the backend refuse any
 * text that cleaning would change.
 */
export function sanitizePlainText(raw: string, cap: number): string {
  let cur = raw;
  for (let i = 0; i < 8; i++) {
    const next = onePass(cur, cap);
    if (next === cur) return cur;
    cur = next;
  }
  return cur;
}

/** Plain instruction text (see `sanitizePlainText`). */
export function sanitizeInstructionText(raw: string): string {
  return sanitizePlainText(raw, INSTRUCTION_CAP);
}

/** A document keeps everything it says (code, `<T>`, links, HTML samples): only hidden characters go, and it is cut at `DOCUMENT_CAP`. */
export function sanitizeDocumentText(raw: string): string {
  return Array.from(stripHidden(raw)).slice(0, DOCUMENT_CAP).join("");
}

/** How many hidden characters `sanitizeDocumentText` would take out. */
export function hiddenCount(raw: string): number {
  return Array.from(raw).length - Array.from(stripHidden(raw)).length;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const shorten = (s: string) => (s.length > 60 ? `${s.slice(0, 59)}…` : s);

/** Exactly what `sanitizeInstructionText` would take out of `raw`, in words ("2 HTML tags", "the link address https://..."). */
export function describeRemoved(raw: string): string[] {
  const out: string[] = [];
  const hidden = hiddenCount(raw);
  if (hidden > 0) out.push(plural(hidden, "hidden character", "hidden characters"));
  let t = stripHidden(raw.replace(/\r\n?/g, "\n"));
  const count = (re: RegExp, one: string, many: string) => {
    const n = (t.match(re) ?? []).length;
    if (n > 0) out.push(plural(n, one, many));
    t = t.replace(re, "");
  };
  count(/\s?\[S\d+(?:\s*,\s*S\d+)*\]/g, "source tag", "source tags");
  count(/<!--[\s\S]*?-->/g, "HTML comment", "HTML comments");
  count(/<\/?[a-zA-Z][^>]*>/g, "HTML tag", "HTML tags");
  count(/^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*\S.*$/gm, "link reference line", "link reference lines");
  const addresses: string[] = [];
  t = t.replace(/!\[([^\]]*)\]\(([^)]*)\)/g, (_m, alt: string, url: string) => {
    if (url.trim()) addresses.push(`the image address ${shorten(url.trim())}`);
    return alt;
  });
  t = t.replace(/\[([^\]]+)\]\(([^)]*)\)/g, (_m, text: string, url: string) => {
    if (url.trim()) addresses.push(`the link address ${shorten(url.trim())}`);
    return text;
  });
  out.push(...addresses.slice(0, 3));
  if (addresses.length > 3) out.push(`${addresses.length - 3} more addresses`);
  count(/\[([^\]]+)\]\[[^\]]*\]/g, "link reference", "link references");
  if (Array.from(t.trim()).length > INSTRUCTION_CAP) out.push(`everything after ${INSTRUCTION_CAP.toLocaleString()} characters`);
  return out;
}
