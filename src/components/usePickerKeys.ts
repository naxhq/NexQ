import { useEffect, type RefObject } from "react";

/**
 * Keyboard behaviour of a footer picker: focus moves into it when it opens, Up/Down/Home/End move between
 * its buttons, and when it closes focus goes back to the chip that opened it (Escape closes it; the picker's
 * own handler does that). Only when focus is still inside the picker or lost: a click elsewhere keeps its target.
 */
export function usePickerKeys(box: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const el = box.current;
    const items = () => [...(box.current?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? [])];
    // After the content has rendered.
    const t = window.setTimeout(() => items()[0]?.focus({ preventScroll: true }), 0);
    const onKey = (e: KeyboardEvent) => {
      const list = items();
      const at = list.indexOf(document.activeElement as HTMLElement);
      if (at < 0 && e.key !== "ArrowDown") return;
      let to = -1;
      if (e.key === "ArrowDown") to = at < 0 ? 0 : (at + 1) % list.length;
      else if (e.key === "ArrowUp") to = (at - 1 + list.length) % list.length;
      else if (e.key === "Home") to = 0;
      else if (e.key === "End") to = list.length - 1;
      if (to >= 0) {
        e.preventDefault();
        e.stopPropagation();
        list[to]?.focus({ preventScroll: true });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKey, true);
      const a = document.activeElement;
      if ((!a || a === document.body || el?.contains(a)) && opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [box]);
}
