import { useEffect } from "react";

/** Marks one row of a list that is a single tab stop (the rail's workspaces, the meetings, the Library). */
export const ROW = "[data-rove-row]";

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[role="button"],[role="switch"],[tabindex]';

function visible(el: HTMLElement): boolean {
  return !el.hasAttribute("hidden") && el.getAttribute("aria-hidden") !== "true";
}

/** The control a row is reached by: the row itself when it is one, else its first control. */
export function primaryOf(row: HTMLElement): HTMLElement | null {
  if (row.matches('[role="button"],button,a[href]') || row.hasAttribute("data-rove-self")) return row;
  return [...row.querySelectorAll<HTMLElement>(FOCUSABLE)].find(visible) ?? null;
}

/** The row's other controls (star, rename, menu, switch): reached with Right and Left, never by Tab. */
export function innerOf(row: HTMLElement): HTMLElement[] {
  const primary = primaryOf(row);
  return [...row.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => visible(el) && el !== primary && (primary === row || !primary?.contains(el)));
}

const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.matches("input,textarea,select") || el.isContentEditable);

/**
 * One tab stop for a whole list. Tab lands on the active row; Up, Down, Home and End move between rows; Right
 * and Left (or the Menu key, or Shift+F10) go into the row's own actions and back; Escape returns to the row.
 * Every control keeps its name and its mouse behaviour: only the tab order and the arrow keys change.
 */
export function useRovingRows(root: HTMLElement | null): void {
  useEffect(() => {
    if (!root) return;
    let active = 0;

    const rows = () => [...root.querySelectorAll<HTMLElement>(ROW)].filter(visible);
    const rowOf = (el: Element | null) => el?.closest<HTMLElement>(ROW) ?? null;

    const sync = () => {
      const list = rows();
      if (list.length === 0) return;
      if (active >= list.length) active = list.length - 1;
      list.forEach((row, i) => {
        const primary = primaryOf(row);
        if (primary) primary.tabIndex = i === active ? 0 : -1;
        for (const el of innerOf(row)) el.tabIndex = -1;
      });
    };

    const focusRow = (i: number) => {
      const list = rows();
      if (list.length === 0) return;
      active = Math.max(0, Math.min(i, list.length - 1));
      sync();
      primaryOf(list[active])?.focus();
    };

    const onFocusIn = (e: FocusEvent) => {
      const row = rowOf(e.target as Element);
      if (!row) return;
      const i = rows().indexOf(row);
      if (i >= 0 && i !== active) {
        active = i;
        sync();
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement;
      if (!root.contains(target) || isTyping(target)) return;
      const row = rowOf(target);
      if (!row) return;
      const list = rows();
      const at = list.indexOf(row);
      const primary = primaryOf(row);
      const inner = innerOf(row);
      const onPrimary = target === primary;
      const innerAt = inner.indexOf(target);
      const into = e.key === "ArrowRight" || e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey);

      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
        e.preventDefault();
        const to = e.key === "Home" ? 0 : e.key === "End" ? list.length - 1 : at + (e.key === "ArrowDown" ? 1 : -1);
        focusRow(to);
      } else if (into && inner.length > 0 && (onPrimary || innerAt >= 0)) {
        e.preventDefault();
        const next = onPrimary ? inner[0] : inner[Math.min(innerAt + 1, inner.length - 1)];
        next.focus();
      } else if (e.key === "ArrowLeft" && innerAt >= 0) {
        e.preventDefault();
        (innerAt === 0 ? primary : inner[innerAt - 1])?.focus();
      } else if (e.key === "Escape" && innerAt >= 0) {
        e.preventDefault();
        e.stopPropagation();
        primary?.focus();
      }
    };

    sync();
    // Rows come and go (a search, a delete, a new meeting): keep exactly one stop.
    const mo = new MutationObserver(sync);
    mo.observe(root, { childList: true, subtree: true });
    root.addEventListener("focusin", onFocusIn);
    root.addEventListener("keydown", onKeyDown);
    return () => {
      mo.disconnect();
      root.removeEventListener("focusin", onFocusIn);
      root.removeEventListener("keydown", onKeyDown);
    };
  }, [root]);
}
