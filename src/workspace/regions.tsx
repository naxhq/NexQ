import { useEffect } from "react";

/** The launcher's regions, in reading order: set `data-region` (and `id`, `tabIndex={-1}`, a name) on each. */
export const REGION = "[data-region]";

const modalOpen = () => !!document.querySelector('[aria-modal="true"]');

/** All regions on screen, in document order. */
export function regionsOnScreen(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(REGION)].filter((el) => !el.closest('[hidden],[aria-hidden="true"]'));
}

/** Moves focus to the next (or previous) region from wherever focus is. Wraps around. */
export function moveToRegion(direction: 1 | -1): boolean {
  const list = regionsOnScreen();
  if (list.length === 0) return false;
  const current = list.findIndex((r) => r.contains(document.activeElement));
  const next = current < 0 ? (direction === 1 ? 0 : list.length - 1) : (current + direction + list.length) % list.length;
  list[next].focus({ preventScroll: false });
  return true;
}

/** F6 and Shift+F6 go between the rail, the chat, the Library and the footer, like the panes of any desktop app. */
export function useRegionKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "F6" || e.ctrlKey || e.altKey || e.metaKey || e.defaultPrevented || modalOpen()) return;
      if (moveToRegion(e.shiftKey ? -1 : 1)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

const LINKS = [
  { id: "region-rail", label: "Skip to workspaces and meetings" },
  { id: "region-main", label: "Skip to chat" },
  { id: "region-library", label: "Skip to Library" },
];

/**
 * The first stops on the page: they appear when focused and jump to a region, so the Library or the chat is
 * a few keys away instead of every meeting in between.
 */
export function SkipLinks() {
  return (
    <nav aria-label="Skip links" className="contents">
      {LINKS.map((l) => (
        <a
          key={l.id}
          href={`#${l.id}`}
          onClick={(e) => {
            const target = document.getElementById(l.id);
            if (!target) return;
            e.preventDefault();
            target.focus();
          }}
          className="ui-body ui-focus fixed left-3 top-3 z-[60] -translate-y-24 rounded-lg ui-solid px-3 py-2 font-medium shadow-lg focus:translate-y-0"
        >
          {l.label}
        </a>
      ))}
    </nav>
  );
}
