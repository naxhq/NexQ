import { useEffect, type RefObject } from "react";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute("hidden") && el.getAttribute("aria-hidden") !== "true",
  );
}

/**
 * While `active`: focus moves into `ref` (to `initial` when given, else the
 * first control, else the box itself), Tab and Shift+Tab stay inside, and on
 * close focus returns to what had it before.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  initial?: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!active) return;
    const box = ref.current;
    if (!box) return;
    const previous = document.activeElement as HTMLElement | null;
    const first = initial?.current ?? focusables(box)[0] ?? box;
    first.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusables(box);
      if (items.length === 0) {
        e.preventDefault();
        box.focus();
        return;
      }
      const head = items[0];
      const tail = items[items.length - 1];
      const current = document.activeElement;
      if (e.shiftKey && (current === head || !box.contains(current))) {
        e.preventDefault();
        tail.focus();
      } else if (!e.shiftKey && (current === tail || !box.contains(current))) {
        e.preventDefault();
        head.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}
