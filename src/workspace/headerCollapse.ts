/**
 * The workspace header as one continuous thing: full on a new chat, a one-line bar
 * inside a chat, and everything in between driven by how far the chat is scrolled.
 * These are the pure rules; the DOM side is `useHeaderCollapse`.
 */

export type HeaderMode = "full" | "compact";

/** The bar that stays: breadcrumb, mini wave, Start. */
export const HEADER_ROW = 44;
/** What the full block is taller than the bar, when nothing has measured it yet (a window with no layout). */
export const DEFAULT_EXTRA = 148;
/** Never fewer scroll pixels than this to condense, so a small block does not snap. */
export const MIN_EXTRA = 96;

/** Compact once this far through, full again once this far back: a thumb resting on the threshold cannot flicker it. */
export const COMPACT_AT = 0.6;
export const FULL_AT = 0.4;

/** A step of this size or less follows the scroll exactly (one to one, no lag); a bigger jump glides. */
export const FOLLOW_STEP = 0.35;
/** The glide: an exponential approach (critically damped, never past the target) with this time constant. */
export const GLIDE_MS = 70;

export const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** The scroll distance over which the header condenses is exactly the space it gives back, so content moves at scroll speed. */
export function condenseRange(measuredExtra: number): number {
  return Math.max(MIN_EXTRA, Math.round(measuredExtra > 0 ? measuredExtra : DEFAULT_EXTRA));
}

/** 0 at the top of the chat, 1 once scrolled `range` px. */
export function progressFromScroll(scrollTop: number, range: number): number {
  if (!Number.isFinite(scrollTop)) return 1;
  return clamp01(scrollTop / Math.max(1, range));
}

/** The discrete state with hysteresis: between the two thresholds it keeps what it was. */
export function modeFor(prev: HeaderMode, progress: number): HeaderMode {
  if (progress >= COMPACT_AT) return "compact";
  if (progress <= FULL_AT) return "full";
  return prev;
}

/** Reduced motion: no in-between, the header is one or the other. */
export function snappedProgress(prev: HeaderMode, rawProgress: number): { mode: HeaderMode; progress: 0 | 1 } {
  const mode = modeFor(prev, rawProgress);
  return { mode, progress: mode === "compact" ? 1 : 0 };
}

/**
 * One frame toward the target. A small move (the user scrolling) lands exactly, so the header and the
 * content never drift apart; a big one (a chat opening at its end, Home, the first answer arriving) glides.
 */
export function stepProgress(current: number, target: number, dtMs: number): number {
  const diff = target - current;
  if (Math.abs(diff) <= FOLLOW_STEP) return target;
  const next = current + diff * (1 - Math.exp(-Math.max(0, dtMs) / GLIDE_MS));
  return Math.abs(target - next) < 0.003 ? target : next;
}

/** The full block fades out a little ahead of leaving, so half-cut text is never on screen. */
export function blockOpacity(p: number): number {
  return clamp01(1 - p * 1.6);
}

/** The bar's extras (mini wave, count, Start) arrive in the second half. */
export function extrasOpacity(p: number): number {
  return clamp01((p - 0.35) / 0.55);
}
