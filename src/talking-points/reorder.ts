/** Pure helpers for reordering the note list (pointer drag and keyboard share them). */

export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= items.length) return [...items];
  const next = [...items];
  const [it] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, it);
  return next;
}

/**
 * Where a dragged row would land. `mids` are the vertical midpoints of every row in
 * order (the dragged one included, as it sits in the list); `y` the pointer's y.
 * Returns the target index in the final order.
 */
export function dropIndex(mids: readonly number[], dragged: number, y: number): number {
  let before = 0;
  mids.forEach((m, i) => {
    if (i !== dragged && m < y) before++;
  });
  return before;
}
