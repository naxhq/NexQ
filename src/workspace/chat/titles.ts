/** What an item with no usable name is called. A raw id is never shown to a person. */
export const REMOVED_ITEM = "Removed item";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_HEX = /^[0-9a-f]{16,}$/i;
const KIND_REF = /^[a-z_]+:[\w-]{6,}(:[\w.-]*)?$/i;

/** A title worth showing, else "Removed item" (empty, equal to its id, or shaped like an id). */
export function displayTitle(title: string | null | undefined, id?: string | null): string {
  const t = (title ?? "").trim();
  if (!t) return REMOVED_ITEM;
  if (id && t === id) return REMOVED_ITEM;
  if (UUID.test(t) || LONG_HEX.test(t) || KIND_REF.test(t)) return REMOVED_ITEM;
  return t;
}
