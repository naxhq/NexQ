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
