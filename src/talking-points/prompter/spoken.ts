/**
 * What has been spoken of the block you are on: one rule, shared by everything that marks it (the dimmed
 * range of the CSS highlight and the "Checked off" strike), so no mark can run ahead of or behind another.
 * Pure: the word index in, a character offset in the block's text out.
 */
import type { FollowState, NoteIndex } from "../follow";
import type { DocBlock } from "../doc/model";

export interface SpokenEnd {
  blockId: string;
  /** Characters of the block's text spoken so far (end of the last spoken word). */
  endChar: number;
}

export function spokenEnd(o: {
  blocks: readonly DocBlock[];
  index: NoteIndex;
  curBlock: number;
  /** The follower's word index. */
  followPosition: number;
  followState: FollowState | "off";
  wantVoice: boolean;
}): SpokenEnd | null {
  const { blocks, index, curBlock, followPosition, followState, wantVoice } = o;
  const block = blocks[curBlock];
  const span = index.blocks[curBlock];
  if (!block || !span || !wantVoice || followState !== "following") return null;
  const tok = Math.floor(followPosition);
  if (tok <= span.first || tok > span.end) return null;
  const endChar = index.tokens[Math.min(tok, span.end) - 1]?.end ?? 0;
  return endChar > 0 ? { blockId: block.id, endChar } : null;
}

/**
 * The words of `text` (as [start, end) character offsets) that count as spoken up to `endChar`:
 * every word that has begun, so a word is struck the moment its first sound is heard.
 */
export function spokenWordRanges(text: string, endChar: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of text.matchAll(/\S+/g)) {
    const start = m.index ?? 0;
    if (start >= endChar) break;
    out.push([start, start + m[0].length]);
  }
  return out;
}

/** Characters [start, end) of a block's text. */
export type CharRange = readonly [number, number];
export type SpokenRanges = ReadonlyMap<string, readonly CharRange[]>;

/** A step of this many words or more in one update is a jump (seek, back reference), not reading on. */
const JUMP_WORDS = 40;
/** After a jump only the words the follower aligned the new place on (its tail) count as spoken. */
const TAIL_WORDS = 12;

/**
 * The words actually spoken, per block, for the "Checked off" strike. The follower's word index only says
 * how far the speaker got, so each step marks the tokens it passed inside the block it lands in; a jump marks just
 * the tail it landed on, and a step into the next block leaves the end of the block behind alone, so words skipped
 * over stay unstruck. Marks are never taken back by moving back (the strike is a record), only by
 * `clear`. Block arrays are replaced, never edited, so an unchanged block keeps its array identity.
 */
export class SpokenTracker {
  private marked = new Map<string, Set<number>>();
  private ranges = new Map<string, readonly CharRange[]>();
  private last = -1;

  /** Moves to `position` (the follower's word index). Returns true when a block's spoken words changed. */
  advance(index: NoteIndex, position: number): boolean {
    const n = index.tokens.length;
    const to = Math.max(0, Math.min(n, Math.floor(position)));
    const jump = Math.ceil(JUMP_WORDS * index.scale);
    let from = this.last < 0 ? 0 : this.last;
    if (to - from >= jump) from = Math.max(0, to - Math.round(TAIL_WORDS * index.scale));
    this.last = to;
    if (to <= from) return false;
    // A step into another block marks only the words of the block it lands in: the end of the block it left was
    // passed over without being heard (otherwise a block whose last words were never said would be struck whole).
    const landed = index.tokens[to - 1].block;
    const touched = new Set<string>();
    for (let i = from; i < to; i++) {
      if (index.tokens[i].block !== landed) continue;
      const id = index.blocks[landed]?.id;
      if (id === undefined) continue;
      let set = this.marked.get(id);
      if (!set) this.marked.set(id, (set = new Set()));
      if (!set.has(i)) {
        set.add(i);
        touched.add(id);
      }
    }
    for (const id of touched) this.ranges.set(id, this.build(index, this.marked.get(id)!));
    return touched.size > 0;
  }

  /** Per block id the spoken character ranges, ascending; blocks with no spoken word are absent. */
  snapshot(): SpokenRanges {
    return new Map(this.ranges);
  }

  clear(): void {
    this.marked.clear();
    this.ranges.clear();
    this.last = -1;
  }

  /** Tokens next to each other form one range, so the gaps between them (punctuation) are spoken too. */
  private build(index: NoteIndex, set: Set<number>): CharRange[] {
    const out: Array<[number, number]> = [];
    let prev = -2;
    for (const i of [...set].sort((a, b) => a - b)) {
      const t = index.tokens[i];
      const cur = out[out.length - 1];
      if (cur && i === prev + 1) {
        cur[0] = Math.min(cur[0], t.start);
        cur[1] = Math.max(cur[1], t.end);
      } else out.push([t.start, t.end]);
      prev = i;
    }
    return out;
  }
}

/** Whether the word starting at character `start` is inside a spoken range. */
export function isSpokenAt(ranges: readonly CharRange[], start: number): boolean {
  for (const [a, b] of ranges) if (start >= a && start < b) return true;
  return false;
}
